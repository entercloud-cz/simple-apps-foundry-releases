import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, isObject, own, writeJson } from "../pipeline/common.js";
import {
  Client,
  DEFAULT_ARM,
  EXECUTION_RE,
  GUID_RE,
  JOBS_API_VERSION,
  JOBS_IMAGE_RE,
  JOB_ID_RE,
  JOB_NAME_RE,
  RG_RE,
  endpoint,
  messages,
  oneLine,
  sleepMs,
  token,
  waitExecution,
} from "./easyauth.js";
import type { Ctx } from "./easyauth.js";

/**
 * `platform provisioning dbinit` (ADR-0028): the Azure stage has the `dbinit` job of the app's CAE
 * create the database role of the app's runtime identity and its grants (images/saf-jobs dbinit).
 *
 *   1. GET the job: manual trigger, one container running saf-jobs (pinned by digest) with the
 *      argument `dbinit`, no start variable of its own. Otherwise stop before the start.
 *   2. POST <job>/start with the job's container, plus SAF_DB_ENGINE, SAF_DB_HOST, SAF_DB_NAME,
 *      SAF_PRINCIPAL_NAME, SAF_PRINCIPAL_ID and SAF_PRINCIPAL_CLIENT_ID (names and IDs: nothing
 *      secret).
 *   3. Poll the execution until it succeeds or fails (every 5 s, at most 10 min).
 *   4. --output: {job, execution, status}.
 *
 * The job checks every input against the naming patterns of its own instance prefix and
 * environment; this command checks their shape so a typo fails before the start. The ARM token
 * comes from SAF_ARM_TOKEN only (never an argument) and goes only to SAF_ARM_ENDPOINT (public cloud
 * by default); every printed line passes a redaction of it. Who may start the job: the Azure
 * provisioning identity (Contributor on its subscription, ADR-0028 amended 2026-10-31).
 */

/** Variables the command sets on start; the job template must not carry its own. */
const START_ENV = ["SAF_DB_ENGINE", "SAF_DB_HOST", "SAF_DB_NAME", "SAF_PRINCIPAL_NAME", "SAF_PRINCIPAL_ID", "SAF_PRINCIPAL_CLIENT_ID"];
const ENGINES = ["postgres", "azureSql"];
const HOST_RE = /^[a-z0-9](-?[a-z0-9])*(\.[a-z0-9](-?[a-z0-9])*)+$/;
const DATABASE_RE = /^([a-z][a-z0-9_]{2,62}|sqldb-[a-z](-?[a-z0-9])+)$/;
const PRINCIPAL_RE = /^id-[a-z0-9]+(-[a-z0-9]+)*-run-[a-z][a-z0-9]{1,7}$/;

export interface DbinitArgs {
  job: string;
  engine: string;
  host: string;
  database: string;
  principalName: string;
  principalId: string;
  principalClientId: string;
  output: string;
}

/** Internal knobs (tests); not CLI flags. */
export interface DbinitOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Execution polling interval and overall timeout (default 5 s, 10 min). */
  executionPollMs?: number;
  executionTimeoutMs?: number;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface DbinitResult {
  job: string;
  execution: string;
  status: string;
}

/** Validates the flags; returns the parts of the job ID. */
export function checkDbinitArgs(a: DbinitArgs): { subscription: string; jobName: string } {
  const problems: string[] = [];
  const m = JOB_ID_RE.exec(a.job);
  const [, subscription = "", resourceGroup = "", jobName = ""] = m ?? [];
  if (!m || !GUID_RE.test(subscription) || !RG_RE.test(resourceGroup) || jobName.length > 32 || !JOB_NAME_RE.test(jobName) || !jobName.includes("-dbinit-")) {
    problems.push("--job must be the ARM ID of a dbinit job (/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.App/jobs/caj-{prefix}-dbinit-{mode}).");
  }
  if (!ENGINES.includes(a.engine)) problems.push(`--engine must be ${ENGINES.join(" or ")}.`);
  if (a.host.length > 253 || !HOST_RE.test(a.host)) problems.push("--host must be the database server's host name (FQDN).");
  if (!DATABASE_RE.test(a.database)) problems.push("--database must be a database name (lowercase letters, digits and _, or sqldb-<slug>).");
  if (a.principalName.length > 63 || !PRINCIPAL_RE.test(a.principalName)) problems.push("--principal-name must be the runtime identity's name id-{prefix}-{slug}-run-{env}.");
  if (!GUID_RE.test(a.principalId)) problems.push("--principal-id must be the runtime identity's object (principal) ID, a GUID.");
  if (!GUID_RE.test(a.principalClientId)) problems.push("--principal-client-id must be the runtime identity's client ID, a GUID.");
  let dirOk = false;
  try {
    dirOk = statSync(dirname(resolve(a.output))).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) problems.push("--output must be a file in an existing directory.");
  if (problems.length) throw new CheckFailed(problems);
  return { subscription, jobName };
}

export interface DbinitJobCheck {
  container: Record<string, unknown>;
  env: Record<string, unknown>[];
}

/** Step 1: the job must be a dbinit job (nothing is started otherwise). */
export function checkDbinitJob(doc: unknown, jobId: string): DbinitJobCheck {
  const problems: string[] = [];
  const at = "the job";
  if (!isObject(doc)) throw new CheckFailed([`${at}: GET returned no object.`]);
  const id = own(doc, "id");
  if (typeof id !== "string" || id.toLowerCase() !== jobId.toLowerCase()) problems.push(`${at}: GET returned another resource.`);
  const props = own(doc, "properties");
  const config = isObject(props) ? own(props, "configuration") : undefined;
  const template = isObject(props) ? own(props, "template") : undefined;
  if (!isObject(config) || own(config, "triggerType") !== "Manual") problems.push(`${at} must have a manual trigger.`);
  const containers = isObject(template) ? own(template, "containers") : undefined;
  const init = isObject(template) ? own(template, "initContainers") : undefined;
  if (!Array.isArray(containers) || containers.length !== 1 || !isObject(containers[0])) problems.push(`${at} must have exactly one container.`);
  if (init !== undefined && init !== null && !(Array.isArray(init) && init.length === 0)) problems.push(`${at} must have no init containers.`);
  if (problems.length) throw new CheckFailed(problems);

  const c = (containers as Record<string, unknown>[])[0]!;
  const image = own(c, "image");
  if (typeof image !== "string" || !JOBS_IMAGE_RE.test(image)) problems.push(`${at} must run the saf-jobs image pinned by digest (<registry>/saf-jobs@sha256:...).`);
  const command = own(c, "command");
  if (command !== undefined && command !== null && !(Array.isArray(command) && command.length === 0)) problems.push(`${at} must not override the image's command.`);
  const args = own(c, "args");
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "dbinit") problems.push(`${at} must pass exactly the argument dbinit.`);
  if (typeof own(c, "name") !== "string") problems.push(`${at}: its container has no name.`);
  const rawEnv = own(c, "env");
  const env: Record<string, unknown>[] = [];
  if (rawEnv !== undefined && rawEnv !== null && !Array.isArray(rawEnv)) problems.push(`${at}: its container env is not a list.`);
  for (const e of Array.isArray(rawEnv) ? (rawEnv as unknown[]) : []) {
    const name = isObject(e) ? own(e, "name") : undefined;
    const value = isObject(e) ? own(e, "value") : undefined;
    if (typeof name !== "string" || typeof value !== "string") {
      problems.push(`${at}: its container has an env entry that is not a plain value (dbinit takes no secrets).`);
      continue;
    }
    if (START_ENV.includes(name)) {
      problems.push(`${at} must not set ${name} itself (it is set on start).`);
      continue;
    }
    env.push({ name, value });
  }
  if (!env.some((e) => e.name === "SAF_DB_ADMIN")) problems.push(`${at} has no SAF_DB_ADMIN value.`);
  const secrets = isObject(config) ? own(config, "secrets") : undefined;
  if (Array.isArray(secrets) && secrets.length) problems.push(`${at} must hold no secrets.`);
  if (problems.length) throw new CheckFailed(problems);
  return { container: c, env };
}

/** The start template: the job's one container, its env plus the six start variables. */
export function dbinitStartTemplate(container: Record<string, unknown>, env: Record<string, unknown>[], a: DbinitArgs): unknown {
  const res = own(container, "resources");
  const resources = isObject(res) ? Object.fromEntries(["cpu", "memory"].filter((k) => own(res, k) !== undefined).map((k) => [k, own(res, k)])) : undefined;
  return {
    containers: [
      {
        name: own(container, "name"),
        image: own(container, "image"),
        args: ["dbinit"],
        ...(resources && Object.keys(resources).length ? { resources } : {}),
        env: [
          ...env,
          { name: "SAF_DB_ENGINE", value: a.engine },
          { name: "SAF_DB_HOST", value: a.host },
          { name: "SAF_DB_NAME", value: a.database },
          { name: "SAF_PRINCIPAL_NAME", value: a.principalName },
          { name: "SAF_PRINCIPAL_ID", value: a.principalId },
          { name: "SAF_PRINCIPAL_CLIENT_ID", value: a.principalClientId },
        ],
      },
    ],
  };
}

/** The whole step; throws CheckFailed. Exported for tests (internal options). */
export async function dbinit(a: DbinitArgs, env: NodeJS.ProcessEnv, opts: DbinitOptions, log: (s: string) => void, onClient: (c: Client) => void): Promise<DbinitResult> {
  const { subscription, jobName } = checkDbinitArgs(a);
  const problems: string[] = [];
  let arm: URL | undefined;
  let armToken = "";
  for (const f of [() => (arm = endpoint(env, "SAF_ARM_ENDPOINT", DEFAULT_ARM)), () => (armToken = token(env, "SAF_ARM_TOKEN"))]) {
    try {
      f();
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems);
      else throw e;
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  // No Graph call: the Graph endpoint is the ARM one and its token empty, so nothing can go there.
  const client = new Client(arm!, arm!, armToken, "", subscription);
  client.armForbiddenHint = " (the Azure provisioning identity needs Contributor on the environment subscription, ADR-0028)";
  onClient(client);
  const ctx: Ctx = {
    client,
    log,
    opts: {
      now: () => new Date(),
      sleep: opts.sleep ?? sleepMs,
      executionPollMs: opts.executionPollMs ?? 5_000,
      executionTimeoutMs: opts.executionTimeoutMs ?? 10 * 60_000,
      // Not used here (no ARM write to wait for, no Graph call, no cleanup).
      operationPollMs: 5_000,
      operationMaxDelayMs: 30_000,
      operationTimeoutMs: 5 * 60_000,
      graphRetryDelaysMs: [],
      cleanupBoundMs: 0,
    },
  };
  const q = { "api-version": JOBS_API_VERSION };

  const got = await client.call("arm", client.armUrl(a.job, q), "GET", `GET job ${jobName}`, undefined, { quote: true });
  const job = checkDbinitJob(got.json, a.job);
  log(`job        ${jobName}: manual, ${String(own(job.container, "image")).replace(/^.*\//, "")}`);

  const start = await client.call("arm", client.armUrl(`${a.job}/start`, q), "POST", `POST job ${jobName}/start`, dbinitStartTemplate(job.container, job.env, a), { quote: true });
  // TODO(verify): JOB-4, the start response is 202 with {name, id} of the execution (API 2024-03-01).
  const name = isObject(start.json) ? own(start.json, "name") : undefined;
  const id = isObject(start.json) ? own(start.json, "id") : undefined;
  if (typeof name !== "string" || !EXECUTION_RE.test(name)) throw new CheckFailed([`POST job ${jobName}/start returned no execution name.`]);
  if (id !== undefined && (typeof id !== "string" || id.toLowerCase() !== `${a.job}/executions/${name}`.toLowerCase())) {
    throw new CheckFailed([`POST job ${jobName}/start returned an execution of another job.`]);
  }
  log(`execution  ${name} started: role ${a.principalName} on ${a.host}/${a.database}`);
  const status = await waitExecution(ctx, client.armUrl(`${a.job}/executions/${name}`, q), name);
  if (status !== "Succeeded") {
    throw new CheckFailed([`execution ${name} ended ${status}. See the job's console logs (ContainerAppConsoleLogs, job ${jobName}): the job names the step and the database error.`]);
  }
  return { job: a.job, execution: name, status };
}

export const DBINIT_HELP = `  dbinit --job <ARM ID of the dbinit job> --engine postgres|azureSql --host <server FQDN> --database <name>
         --principal-name <runtime identity name> --principal-id <its object ID>
         --principal-client-id <its client ID> --output <file>
      has the dbinit job of the app's CAE create the runtime identity's database role and its grants
      (ADR-0028). Token in the environment only: SAF_ARM_TOKEN; endpoint SAF_ARM_ENDPOINT (default
      public cloud). Writes {job, execution, status}. Calls Azure.
`;

/** `platform provisioning dbinit ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdDbinit(args: string[], env: NodeJS.ProcessEnv = process.env, opts: DbinitOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  const early = typeof env.SAF_ARM_TOKEN === "string" && env.SAF_ARM_TOKEN.length >= 8 ? env.SAF_ARM_TOKEN : "";
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early ? s.split(early).join("[redacted]") : s);
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning dbinit: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: DbinitArgs;
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        job: { type: "string" },
        engine: { type: "string" },
        host: { type: "string" },
        database: { type: "string" },
        "principal-name": { type: "string" },
        "principal-id": { type: "string" },
        "principal-client-id": { type: "string" },
        output: { type: "string" },
      },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = ["job", "engine", "host", "database", "principal-name", "principal-id", "principal-client-id", "output"].filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    a = { job: v.job!, engine: v.engine!, host: v.host!, database: v.database!, principalName: v["principal-name"]!, principalId: v["principal-id"]!, principalClientId: v["principal-client-id"]!, output: v.output! };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  try {
    const r = await dbinit(a, env, opts, log, (c) => (client = c));
    try {
      writeJson(a.output, r);
    } catch (e) {
      throw new CheckFailed([`the role was set up, but --output could not be written (${(e as NodeJS.ErrnoException).code ?? "error"}).`]);
    }
    log(`OK  ${a.principalName} on ${a.host}/${a.database} by execution ${r.execution}`);
    return 0;
  } catch (e) {
    return fail(messages(e), 1);
  }
}
