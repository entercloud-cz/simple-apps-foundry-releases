import { CheckFailed, ENV_NAME_RE, KiB, envVar, exactKeys, isObject, loadInstance, own, parseEnvironmentsParam, parseJsonText, slugProblem } from "./common.js";
import type { EnvParam } from "./common.js";

// ------------------------------------------------------------------------------------------
// validate-run
// ------------------------------------------------------------------------------------------

export interface RunSummary {
  slug: string;
  defaultBranch: string;
  environments: EnvParam[];
  action: "deliver" | "redeploy";
  targetEnvironment: string;
  sourceRunId: number;
  coreRef: string;
}

const MAX_RUN_ID = 2_147_483_647;

/**
 * The queue-time parameters: deliver => targetEnvironment none and sourceRunId 0; redeploy =>
 * targetEnvironment one of the run's environments and sourceRunId > 0. sourceRunId is a `number`
 * template parameter; a string of digits is accepted too.
 * TODO(verify): convertToJson(parameters) renders a number parameter as a JSON number.
 */
export function actionProblems(params: Record<string, unknown>, envs: EnvParam[]): { problems: string[]; action: RunSummary["action"]; target: string; sourceRunId: number } {
  const problems: string[] = [];
  const action = own(params, "action");
  const target = own(params, "targetEnvironment");
  const rawRun = own(params, "sourceRunId");
  if (action !== "deliver" && action !== "redeploy") problems.push('parameters.action must be "deliver" or "redeploy".');
  if (typeof target !== "string" || !(target === "none" || ENV_NAME_RE.test(target))) problems.push('parameters.targetEnvironment must be "none" or an environment name.');
  const sourceRunId = typeof rawRun === "number" ? rawRun : typeof rawRun === "string" && /^[0-9]{1,10}$/.test(rawRun) ? Number(rawRun) : NaN;
  if (!Number.isSafeInteger(sourceRunId) || sourceRunId < 0 || sourceRunId > MAX_RUN_ID) problems.push("parameters.sourceRunId must be a run id (a whole number, 0 for none).");
  if (!problems.length) {
    if (action === "deliver") {
      if (target !== "none") problems.push(`parameters: action deliver takes no targetEnvironment (got "${String(target)}"); use action redeploy to deploy an earlier run.`);
      if (sourceRunId !== 0) problems.push("parameters: action deliver takes no sourceRunId (must be 0).");
    } else {
      if (target === "none") problems.push("parameters: action redeploy needs a targetEnvironment.");
      else if (!envs.some((e) => e.name === target)) problems.push(`parameters: targetEnvironment "${String(target)}" is not one of this pipeline's environments (${envs.map((e) => e.name).join(", ")}).`);
      if (sourceRunId === 0) problems.push("parameters: action redeploy needs a sourceRunId (the run whose build is deployed).");
    }
  }
  return { problems, action: action === "redeploy" ? "redeploy" : "deliver", target: typeof target === "string" ? target : "none", sourceRunId: Number.isSafeInteger(sourceRunId) ? sourceRunId : 0 };
}

/**
 * Checks the template parameters (env SAF_PARAMS_JSON) against instance.yaml and the core ref the
 * run resolved (env RESOURCES_REPOSITORIES_CORE_REF).
 */
export function validateRun(args: { instance: string }, env: NodeJS.ProcessEnv): RunSummary {
  const instance = loadInstance(args.instance);
  const raw = envVar("SAF_PARAMS_JSON", env);
  if (raw.length > 64 * KiB) throw new CheckFailed(["SAF_PARAMS_JSON is larger than 64 KiB."]);
  const params = parseJsonText(raw, "SAF_PARAMS_JSON");
  if (!isObject(params)) throw new CheckFailed(["SAF_PARAMS_JSON must be a JSON object { app, environments }."]);
  const problems: string[] = exactKeys(params, ["app", "environments", "action", "targetEnvironment", "sourceRunId"], "parameters");

  const app = own(params, "app");
  let slug = "";
  let defaultBranch = "";
  if (!isObject(app)) problems.push("parameters.app must be an object { slug, defaultBranch }.");
  else {
    problems.push(...exactKeys(app, ["slug", "defaultBranch"], "parameters.app"));
    const s = own(app, "slug");
    const sp = slugProblem(s, "parameters.app.slug");
    if (sp) problems.push(sp);
    else slug = s as string;
    const b = own(app, "defaultBranch");
    if (typeof b !== "string" || !/^refs\/heads\/[^\s\x00-\x1f\x7f]+$/u.test(b)) {
      problems.push('parameters.app.defaultBranch must be a branch ref starting with "refs/heads/".');
    } else defaultBranch = b;
  }

  let envs: EnvParam[] = [];
  try {
    envs = parseEnvironmentsParam(own(params, "environments"), "parameters.environments", { capacity: true });
  } catch (e) {
    if (e instanceof CheckFailed) problems.push(...e.problems);
    else throw e;
  }
  for (const e of envs) {
    const match = instance.environments.find((i) => i.name === e.name);
    if (!match) {
      problems.push(`parameters.environments: "${e.name}" is not an environment of this instance (${instance.environments.map((i) => i.name).join(", ")}).`);
      continue;
    }
    if (match.kind !== e.kind) problems.push(`parameters.environments: "${e.name}" has kind "${e.kind}", instance.yaml says "${match.kind}".`);
    const pf = match.promoteFrom ?? "";
    if (pf !== e.promoteFrom) problems.push(`parameters.environments: "${e.name}" has promoteFrom "${e.promoteFrom}", instance.yaml says "${pf}".`);
  }
  problems.push(...promotionProblems(envs));

  const coreRef = env.RESOURCES_REPOSITORIES_CORE_REF ?? "";
  const expected = `refs/tags/${instance.coreVersion}`;
  if (!coreRef) problems.push("environment variable RESOURCES_REPOSITORIES_CORE_REF is not set.");
  else if (coreRef !== expected) problems.push(`the core repository resolved to "${coreRef}", but instance.yaml pins coreVersion ${instance.coreVersion} (expected ${expected}).`);

  const act = actionProblems(params, envs);
  problems.push(...act.problems);

  if (problems.length) throw new CheckFailed(problems);
  return { slug, defaultBranch, environments: envs, action: act.action, targetEnvironment: act.target, sourceRunId: act.sourceRunId, coreRef };
}

/**
 * Promotion chains inside the run's environment list: promoteFrom names an environment of the
 * list, not the environment itself, and following promoteFrom never loops.
 */
export function promotionProblems(envs: EnvParam[]): string[] {
  const problems: string[] = [];
  const byName = new Map(envs.map((e) => [e.name, e]));
  for (const e of envs) {
    if (e.promoteFrom === "") continue;
    if (e.promoteFrom === e.name) problems.push(`parameters.environments: "${e.name}" cannot promote from itself.`);
    else if (!byName.has(e.promoteFrom)) {
      problems.push(`parameters.environments: "${e.name}" promotes from "${e.promoteFrom}", which is not in this pipeline's environment list.`);
    }
  }
  if (problems.length) return problems;
  const reported = new Set<string>();
  for (const start of envs) {
    const seen: string[] = [];
    let cur: EnvParam | undefined = start;
    while (cur && cur.promoteFrom !== "") {
      if (seen.includes(cur.name)) {
        const loop = seen.slice(seen.indexOf(cur.name));
        const key = [...loop].sort().join(",");
        if (!reported.has(key)) {
          reported.add(key);
          problems.push(`parameters.environments: promoteFrom forms a cycle (${[...loop, cur.name].join(" -> ")}).`);
        }
        break;
      }
      seen.push(cur.name);
      cur = byName.get(cur.promoteFrom);
    }
  }
  return problems;
}

export function formatRunSummary(r: RunSummary): string {
  const what = r.action === "redeploy" ? `redeploy of run ${r.sourceRunId} to ${r.targetEnvironment}` : "deliver";
  return `OK  ${what}: app ${r.slug} (default branch ${r.defaultBranch}), environments ${r.environments.map((e) => `${e.name}/${e.kind}${e.promoteFrom ? ` (from ${e.promoteFrom})` : ""}`).join(", ")}, core ${r.coreRef}\n`;
}

// ------------------------------------------------------------------------------------------
// instance-env
// ------------------------------------------------------------------------------------------

export interface InstanceEnvOutput {
  prefix: string;
  name: string;
  kind: "prod" | "nonprod";
  subscriptionId: string;
  region: string;
  promoteFrom: string;
  vaultGeneration: number;
  /** instance.yaml coreVersion: the core this run runs (the pipelines check the core ref against it). */
  coreVersion: string;
}

export function instanceEnv(args: { instance: string; env: string }): InstanceEnvOutput {
  const instance = loadInstance(args.instance);
  const e = instance.environments.find((i) => i.name === args.env);
  if (!e) throw new CheckFailed([`instance.yaml has no environment "${args.env}" (${instance.environments.map((i) => i.name).join(", ")}).`]);
  return {
    prefix: instance.naming.prefix,
    name: e.name,
    kind: e.kind,
    subscriptionId: e.subscriptionId,
    region: e.region ?? instance.defaultRegion,
    promoteFrom: e.promoteFrom ?? "",
    vaultGeneration: e.vaultGeneration ?? 0,
    coreVersion: instance.coreVersion,
  };
}

// ------------------------------------------------------------------------------------------
// portal-target
// ------------------------------------------------------------------------------------------

/** Where the deploy report step posts (ADR-0037); '' = not set in instance.yaml. */
export interface PortalTarget {
  clientId: string;
  apiBaseUrl: string;
}

/**
 * portal.clientId and portal.apiBaseUrl from the schema-validated instance.yaml (GUID; https
 * origin without path, query, fragment or trailing slash). The report step skips when either is ''.
 */
export function portalTarget(args: { instance: string }): PortalTarget {
  const instance = loadInstance(args.instance);
  return { clientId: instance.portal?.clientId ?? "", apiBaseUrl: instance.portal?.apiBaseUrl ?? "" };
}

export function formatPortalTarget(t: PortalTarget): string {
  if (t.clientId && t.apiBaseUrl) return `OK  portal API ${t.apiBaseUrl} (audience api://${t.clientId})\n`;
  const missing = [t.clientId ? "" : "portal.clientId", t.apiBaseUrl ? "" : "portal.apiBaseUrl"].filter(Boolean).join(" and ");
  return `SKIP  instance.yaml has no ${missing}: no deploy events for the portal (ADR-0037)\n`;
}
