import { CheckFailed, ENV_NAME_RE, MiB, REF_RE, isObject, own, readJson } from "../pipeline/common.js";
import { provisioningHostEnvironment } from "../provisioning/generate.js";
import { loadInstanceFile } from "../provisioning/model.js";

/**
 * The platform pipeline's checks (ADR-0043), pure: files in, verdicts out, no Azure calls.
 *
 *   validate-run  the run's `environment` and `hostEnvironment` parameters and core ref against
 *                 instance.yaml
 *   roles-check   the custom role definitions of roles.bicep exist as core defines them and are
 *                 assignable in this environment's subscription: the gate before the approval,
 *                 since no pipeline writes role definitions (a person runs roles.bicep)
 */

export interface EnvironmentRun {
  environment: string;
  hostEnvironment: string;
  coreRef: string;
}

export function validateEnvironmentRun(args: { instance: string; environment: string; hostEnvironment: string; coreRef: string }): EnvironmentRun {
  const inst = loadInstanceFile(args.instance);
  const problems: string[] = [];
  if (!ENV_NAME_RE.test(args.environment)) problems.push("parameters.environment is not an environment name.");
  else if (!inst.environments.some((e) => e.name === args.environment)) {
    problems.push(`parameters.environment "${args.environment}" is not an environment of instance.yaml: delete pipelines/platform-${args.environment}.yml and its pipeline, or add the environment.`);
  }
  try {
    const host = provisioningHostEnvironment(inst);
    if (args.hostEnvironment !== host) {
      problems.push(`parameters.hostEnvironment is "${args.hostEnvironment.slice(0, 40)}", but instance.yaml portal.hostEnvironment is "${host}": run "platform generate" and commit pipelines/platform-*.yml.`);
    }
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    problems.push(...e.problems);
  }
  const expected = `refs/tags/${inst.coreVersion}`;
  if (!REF_RE.test(args.coreRef)) problems.push("--core-ref must be a git ref (refs/...).");
  else if (args.coreRef !== expected) problems.push(`the core repository resolved to "${args.coreRef}", but instance.yaml pins coreVersion ${inst.coreVersion} (expected ${expected}).`);
  if (problems.length) throw new CheckFailed(problems);
  return { environment: args.environment, hostEnvironment: args.hostEnvironment, coreRef: args.coreRef };
}

export function formatEnvironmentRun(r: EnvironmentRun): string {
  return `OK  platform environment ${r.environment}${r.environment === r.hostEnvironment ? " (portal host)" : ""}, host ${r.hostEnvironment}, core ${r.coreRef}\n`;
}

/** The variable of compiled roles.bicep that holds each custom role's actions. */
const ROLE_ACTIONS: Record<string, string> = {
  appDeployer: "appDeployerActions",
  appEnvironmentJoiner: "appEnvironmentJoinerActions",
  platformJobSecretWriter: "platformJobSecretWriterActions",
};

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const sortedSet = (list: unknown): string[] | undefined =>
  Array.isArray(list) && list.every((a) => typeof a === "string") ? [...new Set(list as string[])].sort() : undefined;

/**
 * roles-check: every custom role platform-names.bicep lists (key, id = the definition's GUID, roleName)
 * exists among the definitions (`az role definition list --custom-role-only true --scope
 * /subscriptions/<sub>`), with that name, exactly the actions of compiled roles.bicep, no
 * notActions or data actions, and this subscription among its assignable scopes.
 */
export function rolesCheck(args: { names: unknown; roles: unknown; definitions: unknown; subscription: string }): string[] {
  const problems: string[] = [];
  const sub = args.subscription.toLowerCase();
  if (!GUID_RE.test(sub)) throw new CheckFailed(["--subscription must be the environment's subscription ID (a GUID)."]);
  const outputs = isObject(args.names) ? own(args.names, "outputs") : undefined;
  const roles = isObject(outputs) ? own(outputs, "customRoles") : undefined;
  if (!Array.isArray(roles) || roles.length !== Object.keys(ROLE_ACTIONS).length) throw new CheckFailed(["--names has no outputs.customRoles with the three custom roles (the snapshot of infra/platform/pipeline/platform-names.bicepparam)."]);
  const variables = isObject(args.roles) ? own(args.roles, "variables") : undefined;
  if (!isObject(variables)) throw new CheckFailed(["--roles has no variables (the compiled infra/platform/roles.bicep)."]);
  if (!Array.isArray(args.definitions)) throw new CheckFailed(["--definitions must be the JSON list of az role definition list."]);
  const found: string[] = [];
  for (const r of roles) {
    const key = isObject(r) ? own(r, "key") : undefined;
    const id = isObject(r) ? String(own(r, "id") ?? "").toLowerCase() : "";
    const roleName = isObject(r) ? own(r, "roleName") : undefined;
    if (typeof key !== "string" || !Object.hasOwn(ROLE_ACTIONS, key) || !GUID_RE.test(id) || typeof roleName !== "string") {
      throw new CheckFailed(["--names lists a custom role without key, GUID or role name."]);
    }
    const want = sortedSet(own(variables, ROLE_ACTIONS[key]!));
    if (!want?.length) throw new CheckFailed([`--roles has no variable ${ROLE_ACTIONS[key]!}.`]);
    const def = (args.definitions as unknown[]).find((d) => isObject(d) && String(own(d, "name") ?? "").toLowerCase() === id);
    if (!isObject(def)) {
      problems.push(`${roleName} (${id}) is not defined or not assignable in subscription ${sub}.`);
      continue;
    }
    const name = own(def, "roleName");
    if (name !== roleName) problems.push(`${id} is named "${String(name).slice(0, 80)}", expected "${roleName}".`);
    const perms = own(def, "permissions");
    const p = Array.isArray(perms) && perms.length === 1 && isObject(perms[0]) ? perms[0] : undefined;
    const actions = p ? sortedSet(own(p, "actions")) : undefined;
    if (!actions || JSON.stringify(actions) !== JSON.stringify(want)) {
      const missing = want.filter((a) => !actions?.includes(a));
      const extra = (actions ?? []).filter((a) => !want.includes(a));
      problems.push(`${roleName}: its actions differ from this core's roles.bicep (missing ${missing.join(", ") || "none"}; extra ${extra.join(", ") || "none"}).`);
    }
    for (const k of ["notActions", "dataActions", "notDataActions"]) {
      const v = p ? own(p, k) : undefined;
      if (Array.isArray(v) && v.length) problems.push(`${roleName}: ${k} must be empty.`);
    }
    const scopes = own(def, "assignableScopes");
    if (!Array.isArray(scopes) || !scopes.some((s) => typeof s === "string" && s.toLowerCase() === `/subscriptions/${sub}`)) {
      problems.push(`${roleName}: subscription ${sub} is not among its assignable scopes.`);
    }
    if (!problems.some((x) => x.includes(roleName) || x.includes(id))) found.push(roleName);
  }
  if (problems.length) {
    throw new CheckFailed([
      ...problems,
      "A person with Owner or User Access Administrator on every environment subscription deploys infra/platform/roles.bicep of this core version (infra/README.md, ADR-0043); no pipeline writes role definitions. Run this pipeline again afterwards.",
    ]);
  }
  return found;
}

export function rolesCheckFiles(args: { names: string; roles: string; definitions: string; subscription: string }): string {
  const found = rolesCheck({
    names: readJson(args.names, MiB, "--names"),
    roles: readJson(args.roles, 4 * MiB, "--roles"),
    definitions: readJson(args.definitions, 16 * MiB, "--definitions"),
    subscription: args.subscription,
  });
  return `OK  custom roles defined as this core's roles.bicep and assignable here: ${found.join(", ")}\n`;
}
