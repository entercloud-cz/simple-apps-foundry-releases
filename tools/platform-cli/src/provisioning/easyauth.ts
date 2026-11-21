import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { setTimeout as timer } from "node:timers/promises";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { readBody } from "../pipeline/ado.js";
import { CheckFailed, SLUG_RE, UsageError, isObject, own, writeJson } from "../pipeline/common.js";
import { parseEpoch } from "./rotation.js";

/**
 * `platform provisioning easyauth-secret` (ADR-0035): the Entra stage creates an app's Easy Auth
 * client secret and hands it to the `kvset` job of the app's CAE, which writes it to the
 * environment vault of that network variant. One process; the value lives only in memory:
 *
 *   1. GET the job: manual trigger, one container running saf-jobs (pinned by digest) with the
 *      argument `kvset`, its SAF_VAULT_URI the expected vault. Otherwise stop before any write.
 *   2. Graph: the app's object ID, then addPassword (180 days).
 *   3. ARM PATCH the job: configuration.secrets = [saf-kvset-<slug>] (and wait for the operation).
 *   4. POST <job>/start with the job's container, plus SAF_SECRET_NAME, SAF_SECRET_VALUE (secretRef)
 *      and SAF_SECRET_EXPIRES.
 *   5. Poll the execution until it succeeds or fails (every 5 s, at most 10 min).
 *   6. Always: PATCH configuration.secrets = [] and check that the secret is gone. If the job was
 *      never started (a failure before the start, or the start refused with a 4xx): Graph
 *      removePassword (best effort), so no unused credential stays. Once a start may have reached
 *      the job, the password stays (the vault may hold it) and the failure says so.
 *   7. --output: {secretName, vault, execution, keyId, endDateTime, mode, written: true}, written
 *      whenever the job wrote the vault, also when a later step failed (exit 1 then), so the
 *      pipeline knows the vault holds a new version.
 *
 * --mode rotate (ADR-0041) replaces the app's current secret: the vault keeps the versionless name,
 * the kvset job writes a new version. Between steps 1 and 2 it reads the app's password credentials
 * and removes the predecessors, before it adds the new one (normally two platform passwords remain):
 *   - platform-named credentials only (easyauth-{env} or easyauth-{env}-run-{id}, {env} from
 *     --display-name); any other credential is kept with a warning;
 *   - the current one (the password the vault held when azure_<env> looked) stays: the
 *     platform-named credential whose endDateTime equals that version's expiry (--current-expires)
 *     AND which is the newest created before that version (--current-created). When the two
 *     signals don't name the same single credential, or the vault records neither, nothing is
 *     removed (a warning says why);
 *   - nothing is removed unless the app is known to run with that version: --loaded-created (the
 *     version the app's active revisions run with, from the Container App's tag saf-easyauth or
 *     their creation times, read in azure_<env>) must equal --current-created. Otherwise a
 *     revision may still hold an older password (a restart that never happened);
 *   - only platform-named credentials strictly older than the current one are removed (the
 *     previous rotation's, or ones a failed run left before it). Newer ones stay: the signals come
 *     from azure_<env>, before the approval, so a re-run of a failed entra stage or an overlapping
 *     run may already have written a newer version (then three passwords remain until the next
 *     rotation). A failed removal doesn't stop the rotation; it fails the command at the end. The
 *     output adds currentKeyId and removedKeyIds.
 * The pipeline restarts the app's active revisions whenever they predate the vault's current
 * version (azure_post, from state), so Easy Auth reads the new version; the old password stays
 * valid until a later rotation removes it.
 *
 * --mode remove-old (ADR-0060 decision 8) runs in the run after a move between the managed network
 * and a VNet-based mode (case A), which re-issued the secret in the target vault (mode new through
 * the target CAE's job). It adds no password and hands no value to a job:
 *   1. GET the OLD variant's kvset job (--job, named caj-{prefix}-kvset-{mode}) with the checks of
 *      step 1; its SAF_VAULT_URI must be --vault, the old vault. Graph: the app's credentials.
 *      Nothing is written before both reads.
 *   2. Only when the app no longer runs in that variant: --app-vault (the environment vault of the
 *      CAE the app runs in now, from the plan; none = not known) must name another vault than
 *      --vault. Otherwise nothing is deleted or removed (a warning says why; exit 0, the next run
 *      tries again).
 *   3. (a) POST <job>/start with the job's container plus SAF_SECRET_NAME and SAF_SECRET_ACTION
 *      delete (no job secret, no value, no expiry): saf-jobs soft-deletes easyauth-{slug} in the old
 *      vault, never purges, and counts an absent secret as done. Wait as in step 5.
 *      (b) The predecessors of the current password, with every guard of rotate: platform-named
 *      credentials only, the current one (told by --current-created/--current-expires, the version
 *      in the vault the app runs with now) never, and nothing unless the app runs with that version
 *      (--loaded-created equals --current-created); only strictly older ones go.
 *      A failure of one part doesn't stop the other; either fails the command at the end.
 *   4. --output: {secretName, vault, appVault, mode, oldSecret: deleted | kept, execution,
 *      currentKeyId, removedKeyIds}, written whenever step 3 ran, also when a part failed (exit 1).
 *
 * SIGINT/SIGTERM (the pipeline run cancelled or timed out): the first signal stops the running
 * request or wait, then step 6 runs as usual within a hard bound (60 s), then exit 1. Further
 * signals don't cut the cleanup short; only the bound does.
 *
 * Tokens come from SAF_ARM_TOKEN and SAF_GRAPH_TOKEN only (never arguments) and go only to the ARM
 * and Graph endpoints (SAF_ARM_ENDPOINT, SAF_GRAPH_ENDPOINT; public cloud by default) as an
 * Authorization header: https only (plain http only on a loopback host, for tests), no
 * redirects, capped responses. Nothing printed, written or thrown contains the value, a token or
 * a request body; every line also passes a redaction of the value and both tokens.
 */

export const JOBS_API_VERSION = "2024-03-01";
export const CREDENTIAL_LIFETIME_DAYS = 180;
export const DEFAULT_ARM = "https://management.azure.com/";
const DEFAULT_GRAPH = "https://graph.microsoft.com/";
/** Key Vault DNS suffixes (public, China, US Government). */
const KEY_VAULT_SUFFIXES = ["vault.azure.net", "vault.azure.cn", "vault.usgovcloudapi.net"];
const LOOPBACK = ["127.0.0.1", "localhost", "[::1]"];
export const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RFC3339_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;
export const JOB_ID_RE = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.App\/jobs\/([^/]+)$/i;
export const RG_RE = /^[-\w.()]{0,89}[-\w()]$/;
export const JOB_NAME_RE = /^[a-z](-?[a-z0-9])+$/;
export const VAULT_RE = /^[a-z](-?[a-z0-9])+$/;
export const SECRET_NAME_RE = /^easyauth-([a-z](-?[a-z0-9])+)$/;
export const EXECUTION_RE = /^[a-z0-9]([a-z0-9-]{0,98}[a-z0-9])?$/;
export const JOBS_IMAGE_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?\/saf-jobs@sha256:[0-9a-f]{64}$/;
/** What Graph returns as secretText, and what the kvset job accepts. */
const SECRET_TEXT_RE = /^[\x21-\x7e]{16,1024}$/;
const MAX_RESPONSE = 4 * 1024 * 1024;
const TIMEOUT_MS = 30_000;
/** Hard bound of the cleanup after the first SIGINT/SIGTERM. */
export const CLEANUP_BOUND_MS = 60_000;
/** Variables the command sets on start; a job template must not carry its own. */
const START_ENV = ["SAF_SECRET_NAME", "SAF_SECRET_VALUE", "SAF_SECRET_EXPIRES", "SAF_SECRET_ACTION"];
/** A kvset job by naming (naming.bicep platformJob): caj-{prefix}-kvset-{mode abbreviation}. */
export const KVSET_JOB_NAME_RE = /^caj-[a-z][a-z0-9]{1,7}-kvset-(ext|hyb|int)$/;

export type EasyAuthMode = "new" | "rotate" | "remove-old";
const MODES: EasyAuthMode[] = ["new", "rotate", "remove-old"];

export interface EasyAuthArgs {
  clientId: string;
  job: string;
  secretName: string;
  vault: string;
  displayName: string;
  output: string;
  /** new (absent secret, default), rotate (ADR-0041) or remove-old (ADR-0060). */
  mode?: EasyAuthMode;
  /** rotate, remove-old: the vault version's created and exp (epoch seconds; undefined = not recorded). */
  currentCreated?: number | undefined;
  currentExpires?: number | undefined;
  /** rotate, remove-old: the created time of the version the app's active revisions run with (undefined = unknown). */
  loadedCreated?: number | undefined;
  /** remove-old: the environment vault of the CAE the app runs in now (undefined = none, not known). */
  appVault?: string | undefined;
}

export type StopSignal = "SIGINT" | "SIGTERM";

/** Internal knobs (tests); not CLI flags. */
export interface EasyAuthOptions {
  now?: () => Date;
  /** Waits ms; may stop early (reject) when the signal aborts. Every wait also ends on the signal. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Execution polling interval and overall timeout (default 5 s, 10 min). */
  executionPollMs?: number;
  executionTimeoutMs?: number;
  /** ARM operation polling: interval (also the floor for Retry-After), Retry-After ceiling, timeout. */
  operationPollMs?: number;
  operationMaxDelayMs?: number;
  operationTimeoutMs?: number;
  /** Graph retries on 404 while a registration created moments ago replicates. */
  graphRetryDelaysMs?: number[];
  /** Hard bound of the cleanup after the first SIGINT/SIGTERM (default 60 s). */
  cleanupBoundMs?: number;
  /** Subscribes the handler to SIGINT/SIGTERM and returns the unsubscribe (default: the process's). */
  onSignal?: (handler: (signal: StopSignal) => void) => () => void;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export interface EasyAuthResult {
  secretName: string;
  vault: string;
  execution: string;
  keyId: string;
  endDateTime: string;
  mode: "new" | "rotate";
  /** The job wrote the new password to the vault. */
  written: true;
  /** rotate: the password the vault held before (kept), or null when it couldn't be told. */
  currentKeyId?: string | null;
  /** rotate: the predecessors removed from the app registration. */
  removedKeyIds?: string[];
}

/** --mode remove-old (ADR-0060): what happened to the old variant's secret and the predecessors. */
export interface RemoveOldResult {
  secretName: string;
  /** The old variant's vault (the job's). */
  vault: string;
  /** The vault the app runs with now, as given (null = not known). */
  appVault: string | null;
  mode: "remove-old";
  /** deleted: the job's delete succeeded (the secret is gone, or was absent); kept: not attempted or failed. */
  oldSecret: "deleted" | "kept";
  /** The delete's execution ("" when none was started). */
  execution: string;
  /** The password the app runs with (kept), or null when it couldn't be told or nothing was looked at. */
  currentKeyId: string | null;
  removedKeyIds: string[];
}

/** The vault got the new password (or remove-old ran), but a later step failed: the output is written, exit 1. */
export class WrittenWithProblems extends CheckFailed {
  constructor(
    readonly result: EasyAuthResult | RemoveOldResult,
    problems: string[],
  ) {
    super(problems);
  }
}

export interface Res {
  status: number;
  json: unknown;
  headers: Headers;
}

export const sleepMs = (ms: number, signal: AbortSignal): Promise<void> => timer(ms, undefined, { signal });

/** The process's SIGINT and SIGTERM. While subscribed, neither ends the process by itself. */
export function processSignals(handler: (signal: StopSignal) => void): () => void {
  const int = (): void => handler("SIGINT");
  const term = (): void => handler("SIGTERM");
  process.on("SIGINT", int);
  process.on("SIGTERM", term);
  return () => {
    process.off("SIGINT", int);
    process.off("SIGTERM", term);
  };
}

/** A failure with the HTTP status (a 4xx on start means the job was not started). */
class HttpError extends CheckFailed {
  constructor(
    readonly status: number,
    problems: string[],
  ) {
    super(problems);
  }
}

/** The request or wait `label` ended because the signal aborted (SIGINT/SIGTERM, or the cleanup bound). */
function stopped(signal: AbortSignal, label: string): CheckFailed {
  return new CheckFailed([`${label}: stopped (${typeof signal.reason === "string" ? signal.reason : "cancelled"}).`]);
}
export const oneLine = (s: string): string => s.replace(/\s*[\r\n]+\s*/g, " ");

export function endpoint(env: NodeJS.ProcessEnv, name: string, def: string): URL {
  const raw = env[name] || def;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CheckFailed([`${name} is not a URL.`]);
  }
  const loopback = u.protocol === "http:" && LOOPBACK.includes(u.hostname);
  if ((u.protocol !== "https:" && !loopback) || u.username || u.password || u.search || u.hash || u.pathname !== "/") {
    throw new CheckFailed([`${name} must be an https origin such as ${def}.`]);
  }
  return new URL(`${u.origin}/`);
}

export function token(env: NodeJS.ProcessEnv, name: string): string {
  const t = env[name] ?? "";
  if (!t) throw new CheckFailed([`${name} is not set (an access token, passed in the environment only).`]);
  if (t.length > 16 * 1024 || /[\s\x00-\x1f\x7f]/.test(t)) throw new CheckFailed([`${name} is not a valid access token.`]);
  return t;
}

/** The platform's credential names of one environment (entra.sh): easyauth-{env}[-run-{id}]. */
const PLATFORM_CREDENTIAL_RE = /^easyauth-([a-z][a-z0-9]{1,7})(-run-[0-9]{1,12})?$/;

/** The platform-named credentials of the environment --display-name names; undefined if it names none. */
export function platformCredentialRe(displayName: string): RegExp | undefined {
  const m = PLATFORM_CREDENTIAL_RE.exec(displayName);
  return m ? new RegExp(`^easyauth-${m[1]}(-run-[0-9]{1,12})?$`) : undefined;
}

/** Validates the flags; returns the parts of the job ID and the slug. */
export function checkArgs(a: EasyAuthArgs): { subscription: string; resourceGroup: string; jobName: string; slug: string } {
  const problems: string[] = [];
  const mode = a.mode ?? "new";
  if (!MODES.includes(mode)) problems.push(`--mode must be ${MODES.slice(0, -1).join(", ")} or ${MODES.at(-1)!}.`);
  if (mode === "new" && (a.currentCreated !== undefined || a.currentExpires !== undefined || a.loadedCreated !== undefined)) {
    problems.push("--current-created, --current-expires and --loaded-created must be none for --mode new (there is no current secret).");
  }
  if ((mode === "rotate" || mode === "remove-old") && !platformCredentialRe(a.displayName)) {
    problems.push(`--mode ${mode} needs --display-name easyauth-<environment>[-run-<id>] (the platform's credential names).`);
  }
  if (mode !== "remove-old" && a.appVault !== undefined) problems.push("--app-vault is for --mode remove-old only.");
  const isVault = (v: string): boolean => v.length >= 3 && v.length <= 24 && VAULT_RE.test(v);
  if (a.appVault !== undefined && !isVault(a.appVault)) problems.push("--app-vault must be a Key Vault name or none.");
  if (!GUID_RE.test(a.clientId)) problems.push("--client-id must be the app registration's client ID (a GUID).");
  const m = JOB_ID_RE.exec(a.job);
  const [, subscription = "", resourceGroup = "", jobName = ""] = m ?? [];
  if (!m || !GUID_RE.test(subscription) || !RG_RE.test(resourceGroup) || jobName.length > 32 || !JOB_NAME_RE.test(jobName)) {
    problems.push("--job must be the ARM ID of a Container Apps job (/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{name}).");
  } else if (mode === "remove-old" && !KVSET_JOB_NAME_RE.test(jobName)) {
    // The delete goes only through a kvset job by naming (ADR-0060 decision 13).
    problems.push("--mode remove-old needs --job naming a kvset job caj-<prefix>-kvset-<ext|hyb|int>.");
  }
  const s = SECRET_NAME_RE.exec(a.secretName);
  const slug = s?.[1] ?? "";
  if (!s || slug.length < 3 || slug.length > 20 || !SLUG_RE.test(slug)) problems.push("--secret-name must be easyauth-<slug> (an app slug: 3-20 lowercase letters, digits and single hyphens).");
  if (!isVault(a.vault)) problems.push("--vault must be a Key Vault name (3-24 lowercase letters, digits and single hyphens).");
  if (!/^[\x21-\x7e]([\x20-\x7e]{0,118}[\x21-\x7e])?$/.test(a.displayName)) problems.push("--display-name must be 1-120 printable ASCII characters without leading or trailing spaces.");
  const dir = dirname(resolve(a.output));
  let dirOk = false;
  try {
    dirOk = statSync(dir).isDirectory();
  } catch {
    dirOk = false;
  }
  if (!dirOk) problems.push("--output must be a file in an existing directory.");
  if (problems.length) throw new CheckFailed(problems);
  return { subscription, resourceGroup, jobName, slug };
}

export interface JobCheck {
  container: Record<string, unknown>;
  env: Record<string, unknown>[];
  vaultHost: string;
  staleSecrets: string[];
}

/** Step 1: the job must be ours and write the expected vault (no write happens otherwise). */
export function checkJob(doc: unknown, jobId: string, vault: string): JobCheck {
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
  if (!Array.isArray(args) || args.length !== 1 || args[0] !== "kvset") problems.push(`${at} must pass exactly the argument kvset.`);
  // The delete action (ADR-0060) is SAF_SECRET_ACTION on start: the template's argument stays kvset.
  if (typeof own(c, "name") !== "string") problems.push(`${at}: its container has no name.`);
  const rawEnv = own(c, "env");
  const env: Record<string, unknown>[] = [];
  if (rawEnv !== undefined && rawEnv !== null && !Array.isArray(rawEnv)) problems.push(`${at}: its container env is not a list.`);
  for (const e of Array.isArray(rawEnv) ? (rawEnv as unknown[]) : []) {
    const name = isObject(e) ? own(e, "name") : undefined;
    const value = isObject(e) ? own(e, "value") : undefined;
    const ref = isObject(e) ? own(e, "secretRef") : undefined;
    if (typeof name !== "string" || (typeof value === "string") === (typeof ref === "string" && ref !== "")) {
      problems.push(`${at}: its container has an env entry that is neither a value nor a secret reference.`);
      continue;
    }
    if (START_ENV.includes(name)) {
      problems.push(`${at} must not set ${name} itself (it is set on start).`);
      continue;
    }
    env.push(typeof value === "string" ? { name, value } : { name, secretRef: ref });
  }
  const uri = env.find((e) => e.name === "SAF_VAULT_URI")?.value;
  let vaultHost = "";
  if (typeof uri !== "string") problems.push(`${at} has no SAF_VAULT_URI value.`);
  else {
    let u: URL | undefined;
    try {
      u = new URL(uri);
    } catch {
      u = undefined;
    }
    const expected = KEY_VAULT_SUFFIXES.map((s) => `${vault}.${s}`);
    if (!u || u.protocol !== "https:" || u.port || u.username || u.password || u.pathname !== "/" || u.search || u.hash || !uri.endsWith("/") || !expected.includes(u.hostname)) {
      problems.push(`${at} does not write vault ${vault}: its SAF_VAULT_URI must be https://${vault}.<Key Vault DNS suffix>/.`);
    } else vaultHost = u.hostname;
  }
  const secrets = own(config as Record<string, unknown>, "secrets");
  const staleSecrets = Array.isArray(secrets) ? secrets.map((s) => (isObject(s) && typeof own(s, "name") === "string" ? (own(s, "name") as string) : "?")) : [];
  if (problems.length) throw new CheckFailed(problems);
  return { container: c, env, vaultHost, staleSecrets };
}

/** The job's one container for a start: its name, image, argument kvset, resources and `startEnv` after its env. */
function startContainer(container: Record<string, unknown>, env: Record<string, unknown>[], startEnv: Record<string, unknown>[]): unknown {
  const res = own(container, "resources");
  const resources = isObject(res) ? Object.fromEntries(["cpu", "memory"].filter((k) => own(res, k) !== undefined).map((k) => [k, own(res, k)])) : undefined;
  return {
    containers: [
      {
        name: own(container, "name"),
        image: own(container, "image"),
        args: ["kvset"],
        ...(resources && Object.keys(resources).length ? { resources } : {}),
        env: [...env, ...startEnv],
      },
    ],
  };
}

/** The start template: the job's one container, its env plus the three start variables. */
export function startTemplate(container: Record<string, unknown>, env: Record<string, unknown>[], secretName: string, jobSecret: string, endDateTime: string): unknown {
  return startContainer(container, env, [
    { name: "SAF_SECRET_NAME", value: secretName },
    { name: "SAF_SECRET_VALUE", secretRef: jobSecret },
    { name: "SAF_SECRET_EXPIRES", value: endDateTime },
  ]);
}

/** The delete's start template (ADR-0060): the job's container, its env plus the name and the action; no value, no expiry. */
export function deleteTemplate(container: Record<string, unknown>, env: Record<string, unknown>[], secretName: string): unknown {
  return startContainer(container, env, [
    { name: "SAF_SECRET_NAME", value: secretName },
    { name: "SAF_SECRET_ACTION", value: "delete" },
  ]);
}

export class Client {
  /** Strings that must never be printed: both tokens and, once known, the value. */
  readonly secrets: string[];
  /** Ends every request of the current phase: first the run, then the cleanup (own bound). */
  signal: AbortSignal = new AbortController().signal;
  /** Added to an ARM 401/403: which role the caller needs. */
  armForbiddenHint = " (the identity needs the role Platform Job Secret Writer on this job, ADR-0035)";
  /** Added to a Graph 401/403. */
  graphForbiddenHint = " (the Entra provisioning identity must own the app registration, ADR-0023)";

  constructor(
    readonly arm: URL,
    readonly graph: URL,
    private readonly armToken: string,
    private readonly graphToken: string,
    readonly subscription: string,
  ) {
    this.secrets = [armToken, graphToken];
  }

  redact(s: string): string {
    let out = s;
    for (const x of this.secrets) if (x.length >= 8) out = out.split(x).join("[redacted]");
    return out;
  }

  /** An ARM URL: the ARM origin, below this subscription. */
  armUrl(pathOrUrl: string, query?: Record<string, string>): URL {
    const u = new URL(pathOrUrl, this.arm);
    if (u.origin !== this.arm.origin || !u.pathname.toLowerCase().startsWith(`/subscriptions/${this.subscription.toLowerCase()}/`) || u.username || u.password || u.hash) {
      throw new CheckFailed(["ARM returned an operation URL outside the job's subscription or the ARM endpoint; not followed."]);
    }
    for (const [k, v] of Object.entries(query ?? {})) u.searchParams.set(k, v);
    return u;
  }

  graphUrl(path: string, search = ""): URL {
    const u = new URL(path, this.graph);
    if (u.origin !== this.graph.origin) throw new CheckFailed(["internal: Graph URL leaves the endpoint."]);
    u.search = search;
    return u;
  }

  /**
   * One call. `quote` adds Azure's error message (cut, printable only, redacted) to a failure;
   * calls that carry the value never quote. `poll` returns status 0 for a transient failure
   * (network, 429, 5xx) instead of failing, so a polling loop can try again.
   */
  async call(
    api: "arm" | "graph",
    url: URL,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    label: string,
    body?: unknown,
    o: { allow?: number[]; quote?: boolean; poll?: boolean } = {},
  ): Promise<Res> {
    const base = api === "arm" ? this.arm : this.graph;
    if (url.origin !== base.origin) throw new CheckFailed([`internal: ${label} leaves the ${api} endpoint.`]);
    const signal = this.signal;
    if (signal.aborted) throw stopped(signal, label);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        redirect: "error",
        signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
        headers: {
          Authorization: `Bearer ${api === "arm" ? this.armToken : this.graphToken}`,
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (e) {
      if (signal.aborted) throw stopped(signal, label);
      if (o.poll) return { status: 0, json: undefined, headers: new Headers() };
      const cause = (e as Error).name === "TimeoutError" ? "timed out" : "failed (network error or redirect)";
      throw new CheckFailed([`${label} ${cause}.`]);
    }
    if (!res.ok) {
      if (o.allow?.includes(res.status) || (o.poll && (res.status === 429 || res.status >= 500))) {
        await res.body?.cancel().catch(() => undefined);
        return { status: res.status, json: undefined, headers: res.headers };
      }
      let text = "";
      try {
        text = await readBody(res, label);
      } catch {
        if (signal.aborted) throw stopped(signal, label);
        text = "";
      }
      throw new HttpError(res.status, [`${label} returned HTTP ${res.status}${hint(api, res.status, this.armForbiddenHint, this.graphForbiddenHint)}.${this.errorDetail(text, o.quote === true)}`]);
    }
    let text: string;
    try {
      text = await readBody(res, label);
    } catch {
      if (signal.aborted) throw stopped(signal, label);
      throw new CheckFailed([`${label}: response is larger than ${MAX_RESPONSE} bytes.`]);
    }
    if (text.length > MAX_RESPONSE) throw new CheckFailed([`${label}: response is larger than ${MAX_RESPONSE} bytes.`]);
    if (text.trim() === "") return { status: res.status, json: undefined, headers: res.headers };
    try {
      return { status: res.status, json: JSON.parse(text) as unknown, headers: res.headers };
    } catch {
      // JSON.parse's message quotes the input: never pass it on.
      throw new CheckFailed([`${label} did not return JSON.`]);
    }
  }

  /** ` <code>: "<message>"` of an ARM or Graph error body ({error: {code, message}}). */
  private errorDetail(text: string, quote: boolean): string {
    let err: unknown;
    try {
      err = own(JSON.parse(text) as Record<string, unknown>, "error");
    } catch {
      return "";
    }
    if (!isObject(err)) return "";
    const code = own(err, "code");
    const c = typeof code === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? ` ${code}` : "";
    const msg = own(err, "message");
    if (!quote || typeof msg !== "string") return c;
    const clean = this.redact(msg).replace(/[^\x20-\x7E -ɏ]/g, " ").replace(/\s+/g, " ").trim();
    return clean ? `${c}: "${clean.length > 300 ? clean.slice(0, 297) + "..." : clean}"` : c;
  }
}

function hint(api: "arm" | "graph", status: number, armForbidden: string, graphForbidden: string): string {
  if (status === 401 || status === 403) {
    return api === "arm" ? armForbidden : graphForbidden;
  }
  return status === 404 ? " (not found)" : "";
}

export interface Ctx {
  client: Client;
  opts: Required<Omit<EasyAuthOptions, "out" | "err" | "onSignal">>;
  log: (s: string) => void;
}

/** Sleeps; ends early with a failure when the client's current signal aborts. */
function pause(ctx: Ctx, ms: number, label: string): Promise<void> {
  const signal = ctx.client.signal;
  if (signal.aborted) return Promise.reject(stopped(signal, label));
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => reject(stopped(signal, label));
    signal.addEventListener("abort", onAbort, { once: true });
    ctx.opts
      .sleep(ms, signal)
      .then(resolve, (e: unknown) => reject(signal.aborted ? stopped(signal, label) : e))
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Waits for an ARM write: Azure-AsyncOperation, else Location (on 202), else the resource's
 * provisioningState. An operation URL answering 401/403 falls back to the resource's
 * provisioningState, within the same timeout.
 */
async function waitArm(ctx: Ctx, r: Res, resource: URL, label: string): Promise<void> {
  const { client, opts } = ctx;
  const asyncOp = r.headers.get("azure-asyncoperation");
  const location = r.headers.get("location");
  const deadline = Date.now() + opts.operationTimeoutMs;
  const delay = (h: Headers): number => {
    const ra = Number(h.get("retry-after"));
    return Math.min(Math.max(Number.isFinite(ra) && ra > 0 ? ra * 1000 : opts.operationPollMs, opts.operationPollMs), opts.operationMaxDelayMs);
  };
  const stateOf = (j: unknown): unknown => (isObject(j) ? (own(j, "status") ?? (isObject(own(j, "properties")) ? own(own(j, "properties") as Record<string, unknown>, "provisioningState") : undefined)) : undefined);

  let mode: "async" | "location" | "resource";
  let url = resource;
  if (asyncOp) {
    mode = "async";
    url = client.armUrl(asyncOp);
  } else if (r.status === 202 && location) {
    mode = "location";
    url = client.armUrl(location);
  } else {
    const st = r.status === 202 ? "Accepted" : stateOf(r.json);
    if (st === undefined || st === "Succeeded") return;
    if (st === "Failed" || st === "Canceled") throw new CheckFailed([`${label}: the operation ended ${st}.`]);
    mode = "resource";
  }
  let wait = delay(r.headers);
  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() + wait > deadline) throw new CheckFailed([`${label}: the operation did not finish within ${Math.round(opts.operationTimeoutMs / 1000)} s.`]);
      await pause(ctx, wait, label);
    }
    const operation = mode !== "resource";
    const q = await client.call("arm", url, "GET", `${label} (${operation ? "operation status" : "provisioningState"})`, undefined, { poll: true, quote: true, ...(operation ? { allow: [401, 403] } : {}) });
    wait = delay(q.headers);
    if (operation && (q.status === 401 || q.status === 403)) {
      // TODO(verify): JOB-3, whether Platform Job Secret Writer, assigned at the job's scope, can
      // read the operation status: its URL lies outside that scope
      // (/subscriptions/{sub}/providers/Microsoft.App/locations/...). If not, the job's own
      // provisioningState (jobs/read) is followed, assuming ARM shows it non-terminal from the
      // PATCH response on until the operation ends.
      ctx.log(`wait       ${label}: operation status not readable (HTTP ${q.status}); following the job's provisioningState`);
      mode = "resource";
      url = resource;
      continue;
    }
    if (q.status === 0 || q.status === 429 || q.status >= 500) continue;
    if (mode === "location") {
      if (q.status === 202) continue;
      return;
    }
    const st = stateOf(q.json);
    if (st === "Succeeded") return;
    if (st === "Failed" || st === "Canceled") {
      const e = isObject(q.json) ? own(q.json, "error") : undefined;
      const code = isObject(e) && typeof own(e, "code") === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(own(e, "code") as string) ? ` (${own(e, "code") as string})` : "";
      throw new CheckFailed([`${label}: the operation ended ${st}${code}.`]);
    }
  }
}

/** Graph call that retries 404 (a registration created moments ago may not have replicated). */
async function graphWithRetry(ctx: Ctx, url: URL, method: "GET" | "POST", label: string, body?: unknown): Promise<Res> {
  const delays = ctx.opts.graphRetryDelaysMs;
  for (let attempt = 0; ; attempt++) {
    const r = await ctx.client.call("graph", url, method, label, body, { allow: [404], quote: true });
    if (r.status !== 404) return r;
    if (attempt >= delays.length) throw new CheckFailed([`${label} returned HTTP 404 (no such app registration, or not replicated yet).`]);
    ctx.log(`wait       ${label}: not found yet, retrying in ${Math.round(delays[attempt]! / 1000)} s`);
    await pause(ctx, delays[attempt]!, label);
  }
}

/** A password credential of the app registration as Graph lists it (never its hint or text). */
export interface Credential {
  keyId: string;
  displayName: string;
  /** startDateTime and endDateTime in epoch seconds (floored, as the kvset job sets exp). */
  start: number | undefined;
  end: number | undefined;
}

const epochOf = (v: unknown): number | undefined => (typeof v === "string" && RFC3339_RE.test(v) && Number.isFinite(Date.parse(v)) ? Math.floor(Date.parse(v) / 1000) : undefined);

/** The passwordCredentials of GET applications(appId=...)?$select=id,passwordCredentials. */
export function credentialsOf(doc: unknown): Credential[] {
  const list = isObject(doc) ? own(doc, "passwordCredentials") : undefined;
  if (!Array.isArray(list)) throw new CheckFailed(["GET application returned no passwordCredentials list."]);
  return (list as unknown[]).flatMap((c) => {
    const keyId = isObject(c) ? own(c, "keyId") : undefined;
    // A credential without a usable keyId can't be named for a removal: it is left alone.
    if (!isObject(c) || typeof keyId !== "string" || !GUID_RE.test(keyId)) return [];
    const name = own(c, "displayName");
    return [{ keyId, displayName: typeof name === "string" ? name : "", start: epochOf(own(c, "startDateTime")), end: epochOf(own(c, "endDateTime")) }];
  });
}

/**
 * The platform-named credential the vault holds now (rotate): the one whose endDateTime is the vault
 * version's exp, which must also be the newest created before that version. Otherwise `why`.
 */
export function currentCredential(platform: Credential[], created: number | undefined, expires: number | undefined): { current?: Credential; why?: string } {
  if (created === undefined || expires === undefined) return { why: "the vault's version records no creation or expiry time (written by hand?)" };
  const byExpiry = platform.filter((c) => c.end === expires);
  if (byExpiry.length !== 1) return { why: `${byExpiry.length} platform-named passwords expire when the vault's version does` };
  const newest = platform.filter((c) => c.start !== undefined && c.start <= created).sort((x, y) => y.start! - x.start!)[0];
  if (!newest || newest.keyId !== byExpiry[0]!.keyId) return { why: "the password that expires with the vault's version is not the newest one created before it" };
  return { current: byExpiry[0]! };
}

interface Rotation {
  currentKeyId: string | null;
  removed: string[];
  failures: string[];
}

/**
 * The platform credentials a rotation removes: strictly older than the current one. A newer one may
 * be in the vault already (a re-run of a failed entra stage, an overlapping run: the signals are read
 * before the approval), and one without a start time can't be ordered; both stay.
 */
export function predecessorsOf(platform: Credential[], current: Credential): Credential[] {
  return platform.filter((c) => c.keyId !== current.keyId && c.start !== undefined && current.start !== undefined && c.start < current.start);
}

/** rotate, before addPassword: keep the current password, newer ones and other names; remove the platform's older ones. */
async function removePredecessors(ctx: Ctx, a: EasyAuthArgs, objectId: string, doc: unknown): Promise<Rotation> {
  const { client, log } = ctx;
  const named = platformCredentialRe(a.displayName)!;
  const all = credentialsOf(doc);
  const platform = all.filter((c) => named.test(c.displayName));
  // Other names may be anyone's (an adopted app): never removed, and only the keyId is printed.
  for (const c of all) if (!named.test(c.displayName)) log(`warn       password ${c.keyId} on app ${a.clientId} is not named by the platform; kept (remove it by hand if nothing uses it)`);
  const { current, why } = currentCredential(platform, a.currentCreated, a.currentExpires);
  if (!current) {
    log(`warn       cannot tell which password ${a.secretName} holds: ${why}; no password removed (check: az ad app credential list --id ${a.clientId})`);
    return { currentKeyId: null, removed: [], failures: [] };
  }
  log(`password   current ${current.keyId} (${current.displayName}) stays until a later rotation`);
  // Only when the app's revisions are known to run with that version: otherwise one may still use
  // an older password (its restart never happened). The rotation itself goes on.
  if (a.loadedCreated === undefined || a.loadedCreated !== a.currentCreated) {
    const loaded = a.loadedCreated === undefined ? "unknown" : `created ${a.loadedCreated}`;
    log(`warn       the app is not known to run with the vault's current version of ${a.secretName} (it runs with: ${loaded}; current: created ${a.currentCreated}); no password removed until a run has restarted it`);
    return { currentKeyId: current.keyId, removed: [], failures: [] };
  }
  const older = predecessorsOf(platform, current);
  for (const c of platform) {
    if (c.keyId !== current.keyId && !older.includes(c)) log(`password   ${c.keyId} (${c.displayName}) is not older than the current one; kept until a later rotation`);
  }
  const removed: string[] = [];
  const failures: string[] = [];
  for (const c of older) {
    try {
      await client.call("graph", client.graphUrl(`v1.0/applications/${objectId}/removePassword`), "POST", "POST removePassword", { keyId: c.keyId }, { quote: true });
      removed.push(c.keyId);
      log(`password   predecessor ${c.keyId} (${c.displayName}) removed from app ${a.clientId}`);
    } catch (e) {
      if (client.signal.aborted) throw e;
      failures.push(`could not remove the predecessor password ${c.keyId} from app ${a.clientId}: ${messages(e).join(" ")} Remove it by hand: az ad app credential delete --id ${a.clientId} --key-id ${c.keyId}.`);
    }
  }
  return { currentKeyId: current.keyId, removed, failures };
}

async function patchSecrets(ctx: Ctx, jobUrl: URL, secrets: { name: string; value: string }[], label: string): Promise<void> {
  // TODO(verify): JOB-3, that a PATCH of the job is a JSON merge patch (other configuration kept,
  // the secrets array replaced as a whole, [] removes every secret) and that jobs/write suffices
  // with a user-assigned identity on the job. The removal is checked with a GET afterwards.
  // Never quote ARM's error message here: the request carries the value.
  const r = await ctx.client.call("arm", jobUrl, "PATCH", label, { properties: { configuration: { secrets } } }, { quote: false });
  await waitArm(ctx, r, jobUrl, label);
}

/** Polls the execution until a final status. Returns it; throws on timeout. */
export async function waitExecution(ctx: Ctx, url: URL, name: string): Promise<string> {
  const { client, opts } = ctx;
  const deadline = Date.now() + opts.executionTimeoutMs;
  let last = "";
  for (let first = true; ; first = false) {
    if (!first) {
      if (Date.now() + opts.executionPollMs > deadline) {
        throw new CheckFailed([`execution ${name} did not finish within ${Math.round(opts.executionTimeoutMs / 1000)} s (last status ${last || "unknown"}).`]);
      }
      await pause(ctx, opts.executionPollMs, `wait for execution ${name}`);
    }
    // 404: the execution may not be visible right after the start.
    const r = await client.call("arm", url, "GET", `GET execution ${name}`, undefined, { poll: true, allow: [404], quote: true });
    if (r.status !== 200) continue;
    const props = isObject(r.json) ? own(r.json, "properties") : undefined;
    const status = isObject(props) ? own(props, "status") : undefined;
    if (typeof status !== "string" || !/^[A-Za-z]{1,40}$/.test(status)) continue;
    if (status !== last) ctx.log(`execution  ${name}: ${status}`);
    last = status;
    // TODO(verify): JOB-4, the final statuses of a job execution (API 2024-03-01: Running,
    // Processing, Stopped, Degraded, Failed, Unknown, Succeeded).
    if (status === "Succeeded" || status === "Failed" || status === "Stopped" || status === "Degraded") return status;
  }
}

/** The whole step; throws CheckFailed. Exported for tests (internal options). */
export async function easyAuthSecret(a: EasyAuthArgs, env: NodeJS.ProcessEnv, opts: EasyAuthOptions, log: (s: string) => void, onClient: (c: Client) => void): Promise<EasyAuthResult | RemoveOldResult> {
  const { subscription, jobName, slug, resourceGroup } = checkArgs(a);
  const problems: string[] = [];
  let arm: URL | undefined;
  let graph: URL | undefined;
  let armToken = "";
  let graphToken = "";
  for (const f of [
    () => (arm = endpoint(env, "SAF_ARM_ENDPOINT", DEFAULT_ARM)),
    () => (graph = endpoint(env, "SAF_GRAPH_ENDPOINT", DEFAULT_GRAPH)),
    () => (armToken = token(env, "SAF_ARM_TOKEN")),
    () => (graphToken = token(env, "SAF_GRAPH_TOKEN")),
  ]) {
    try {
      f();
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems);
      else throw e;
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  const client = new Client(arm!, graph!, armToken, graphToken, subscription);
  onClient(client);
  const ctx: Ctx = {
    client,
    log,
    opts: {
      now: opts.now ?? (() => new Date()),
      sleep: opts.sleep ?? sleepMs,
      executionPollMs: opts.executionPollMs ?? 5_000,
      executionTimeoutMs: opts.executionTimeoutMs ?? 10 * 60_000,
      operationPollMs: opts.operationPollMs ?? 5_000,
      operationMaxDelayMs: opts.operationMaxDelayMs ?? 30_000,
      operationTimeoutMs: opts.operationTimeoutMs ?? 5 * 60_000,
      graphRetryDelaysMs: opts.graphRetryDelaysMs ?? [10_000, 20_000, 40_000],
      cleanupBoundMs: opts.cleanupBoundMs ?? CLEANUP_BOUND_MS,
    },
  };

  // SIGINT/SIGTERM: Azure DevOps cancels a step (run cancelled, job timeout) with SIGINT, then
  // SIGTERM, and kills it once the job's cancel timeout is over.
  // TODO(verify): JOB-4, the signals the agent sends to this process (directly, or only to the
  // step's shell, which must then pass them on) and the time between the first one and the kill
  // (cancelTimeoutInMinutes, default 5 min; the agent may escalate sooner).
  // The first signal ends the request or wait in flight (`run`); the cleanup then runs with its
  // own signal, which only the bound ends. Later signals are logged, not obeyed.
  const run = new AbortController();
  const cleanup = new AbortController();
  client.signal = run.signal;
  const stop: { signal?: StopSignal; timer?: NodeJS.Timeout } = {};
  const boundS = Math.ceil(ctx.opts.cleanupBoundMs / 1000);
  const unsubscribe = (opts.onSignal ?? processSignals)((sig) => {
    if (stop.signal) {
      log(`warn       ${sig} again: the cleanup goes on, at most ${boundS} s after ${stop.signal}`);
      return;
    }
    stop.signal = sig;
    log(a.mode === "remove-old" ? `warn       ${sig}: stopping (remove-old sets no job secret)` : `warn       ${sig}: stopping, then removing the job secret (at most ${boundS} s)`);
    stop.timer = setTimeout(() => cleanup.abort(`the cleanup did not finish within ${boundS} s of ${sig}`), ctx.opts.cleanupBoundMs);
    stop.timer.unref();
    run.abort(`${sig} received`);
  });
  try {
    if (a.mode === "remove-old") return await removeOld(a, ctx, jobName, () => stop.signal);
    return await steps(a, ctx, { jobName, slug, resourceGroup }, cleanup.signal, () => stop.signal);
  } finally {
    unsubscribe();
    clearTimeout(stop.timer);
  }
}

/** The kvset job's execution `name` from a start response, checked to belong to `jobId`. */
export function executionOf(start: Res, jobId: string, jobName: string): string {
  // TODO(verify): JOB-4, the start response is 202 with {name, id} of the execution (API 2024-03-01).
  const name = isObject(start.json) ? own(start.json, "name") : undefined;
  const id = isObject(start.json) ? own(start.json, "id") : undefined;
  if (typeof name !== "string" || !EXECUTION_RE.test(name)) throw new CheckFailed([`POST job ${jobName}/start returned no execution name.`]);
  if (id !== undefined && (typeof id !== "string" || id.toLowerCase() !== `${jobId}/executions/${name}`.toLowerCase())) {
    throw new CheckFailed([`POST job ${jobName}/start returned an execution of another job.`]);
  }
  return name;
}

/** --mode remove-old (ADR-0060 decision 8), steps 1-4 at the top of the file. */
async function removeOld(a: EasyAuthArgs, ctx: Ctx, jobName: string, interrupted: () => StopSignal | undefined): Promise<RemoveOldResult> {
  const { client, log } = ctx;
  const q = { "api-version": JOBS_API_VERSION };

  // 1. Both reads, before anything changes: the old variant's job and the app's credentials.
  const got = await client.call("arm", client.armUrl(a.job, q), "GET", `GET job ${jobName}`, undefined, { quote: true });
  const job = checkJob(got.json, a.job, a.vault);
  log(`job        ${jobName}: manual, ${String(own(job.container, "image")).replace(/^.*\//, "")}, writes ${job.vaultHost} (the old variant's vault)`);
  if (job.staleSecrets.length) log(`warn       ${jobName} holds secret(s) ${job.staleSecrets.join(", ")} from an earlier run; the delete passes none, the next secret write removes them`);
  const app = await graphWithRetry(ctx, client.graphUrl(`v1.0/applications(appId='${a.clientId}')`, "?$select=id,passwordCredentials"), "GET", `GET application ${a.clientId}`);
  const objectId = isObject(app.json) ? own(app.json, "id") : undefined;
  if (typeof objectId !== "string" || !GUID_RE.test(objectId)) throw new CheckFailed([`GET application ${a.clientId} returned no object ID.`]);
  credentialsOf(app.json);

  const result: RemoveOldResult = {
    secretName: a.secretName,
    vault: a.vault,
    appVault: a.appVault ?? null,
    mode: "remove-old",
    oldSecret: "kept",
    execution: "",
    currentKeyId: null,
    removedKeyIds: [],
  };
  // 2. Only once the app runs in the other variant: its vault, from the plan, is another one.
  if (a.appVault === undefined || a.appVault === a.vault) {
    const why = a.appVault === undefined ? "the vault the app runs with now is not known (--app-vault none)" : `the app still runs with vault ${a.vault} (--app-vault)`;
    log(`warn       ${why}: ${a.secretName} stays in ${a.vault} and no password is removed; a later run tries again`);
    return result;
  }

  // 3a. The old variant's job soft-deletes easyauth-{slug} in its vault (no job secret, no value).
  const failures: string[] = [];
  try {
    const start = await client.call("arm", client.armUrl(`${a.job}/start`, q), "POST", `POST job ${jobName}/start`, deleteTemplate(job.container, job.env, a.secretName), { quote: true });
    const name = executionOf(start, a.job, jobName);
    result.execution = name;
    log(`execution  ${name} started: delete ${a.secretName} in ${a.vault} (the app runs with ${a.appVault})`);
    const status = await waitExecution(ctx, client.armUrl(`${a.job}/executions/${name}`, q), name);
    if (status !== "Succeeded") throw new CheckFailed([`execution ${name} ended ${status}; ${a.secretName} may still be in ${a.vault}. See the job's console logs (ContainerAppConsoleLogs_CL, job ${jobName}); the next run deletes it again.`]);
    result.oldSecret = "deleted";
    log(`secret     ${a.secretName} deleted from ${a.vault} (soft delete, or it was absent)`);
  } catch (e) {
    if (client.signal.aborted) throw new WrittenWithProblems(result, [`stopped by ${interrupted() ?? "a signal"}: ${messages(e).join(" ")}`]);
    failures.push(...messages(e));
  }

  // 3b. The predecessors of the password the app runs with, guarded as in rotate.
  try {
    const rotation = await removePredecessors(ctx, a, objectId, app.json);
    result.currentKeyId = rotation.currentKeyId;
    result.removedKeyIds = rotation.removed;
    failures.push(...rotation.failures);
  } catch (e) {
    if (client.signal.aborted) failures.unshift(`stopped by ${interrupted() ?? "a signal"}.`);
    failures.push(...messages(e));
  }
  if (failures.length) throw new WrittenWithProblems(result, failures);
  return result;
}

/** Steps 1-6 (see the top of the file); `cleanupSignal` replaces the run's signal for step 6. */
async function steps(
  a: EasyAuthArgs,
  ctx: Ctx,
  { jobName, slug, resourceGroup }: { jobName: string; slug: string; resourceGroup: string },
  cleanupSignal: AbortSignal,
  interrupted: () => StopSignal | undefined,
): Promise<EasyAuthResult> {
  const { client, log } = ctx;
  const q = { "api-version": JOBS_API_VERSION };
  const jobUrl = client.armUrl(a.job, q);
  const jobSecret = `saf-kvset-${slug}`;

  // 1. The job, before anything is written.
  const got = await client.call("arm", jobUrl, "GET", `GET job ${jobName}`, undefined, { quote: true });
  const job = checkJob(got.json, a.job, a.vault);
  log(`job        ${jobName}: manual, ${String(own(job.container, "image")).replace(/^.*\//, "")}, writes ${job.vaultHost}`);
  if (job.staleSecrets.length) {
    log(`warn       ${jobName} holds secret(s) ${job.staleSecrets.join(", ")} from an earlier run; they are replaced and then removed`);
  }

  // 2. The password (rotate: its predecessors go first, ADR-0041).
  const rotate = a.mode === "rotate";
  const appUrl = client.graphUrl(`v1.0/applications(appId='${a.clientId}')`, rotate ? "?$select=id,passwordCredentials" : "?$select=id");
  const app = await graphWithRetry(ctx, appUrl, "GET", `GET application ${a.clientId}`);
  const objectId = isObject(app.json) ? own(app.json, "id") : undefined;
  if (typeof objectId !== "string" || !GUID_RE.test(objectId)) throw new CheckFailed([`GET application ${a.clientId} returned no object ID.`]);
  const rotation = rotate ? await removePredecessors(ctx, a, objectId, app.json) : undefined;
  const requestedEnd = new Date(ctx.opts.now().getTime() + CREDENTIAL_LIFETIME_DAYS * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const addUrl = client.graphUrl(`v1.0/applications/${objectId}/addPassword`);
  let added: Res;
  try {
    added = await graphWithRetry(ctx, addUrl, "POST", "POST addPassword", { passwordCredential: { displayName: a.displayName, endDateTime: requestedEnd } });
  } catch (e) {
    if (e instanceof CheckFailed && /timed out|network error|stopped/.test(e.problems.join(" "))) {
      throw new CheckFailed([...e.problems, `a password named "${a.displayName}" may have been added to app ${a.clientId}; remove it if it exists (az ad app credential list --id ${a.clientId}).`]);
    }
    throw e;
  }
  const cred = isObject(added.json) ? added.json : {};
  const secretText = own(cred, "secretText");
  if (typeof secretText === "string" && secretText.length >= 8) client.secrets.push(secretText);
  const keyId = own(cred, "keyId");
  if (typeof keyId !== "string" || !GUID_RE.test(keyId)) {
    throw new CheckFailed([`POST addPassword returned no keyId; a password named "${a.displayName}" may remain on app ${a.clientId}: remove it (az ad app credential list --id ${a.clientId}).`]);
  }
  const returnedEnd = own(cred, "endDateTime");
  const endDateTime = typeof returnedEnd === "string" && RFC3339_RE.test(returnedEnd) && Number.isFinite(Date.parse(returnedEnd)) ? returnedEnd : requestedEnd;
  log(`password   added to app ${a.clientId}: keyId ${keyId}, expires ${endDateTime}`);

  // 3-5 with cleanup (6). A predecessor that couldn't be removed fails the command at the end.
  const failures: string[] = [...(rotation?.failures ?? [])];
  let written = false;
  let patched = false;
  /** Whether a start may have reached the job; only "no" lets the password be removed. */
  let started: "no" | "maybe" | "yes" = "no";
  let execution = "";
  try {
    if (typeof secretText !== "string" || !SECRET_TEXT_RE.test(secretText)) throw new CheckFailed(["POST addPassword returned no usable secret text."]);
    patched = true;
    await patchSecrets(ctx, jobUrl, [{ name: jobSecret, value: secretText }], `PATCH job ${jobName} (set secret ${jobSecret})`);
    log(`job secret ${jobSecret} set on ${jobName}`);

    started = "maybe";
    let start: Res;
    try {
      start = await client.call("arm", client.armUrl(`${a.job}/start`, q), "POST", `POST job ${jobName}/start`, startTemplate(job.container, job.env, a.secretName, jobSecret, endDateTime), { quote: true });
    } catch (e) {
      // Only a 4xx is a refusal; after a 5xx, a timeout or a stop the job may have started.
      if (e instanceof HttpError && e.status >= 400 && e.status < 500) started = "no";
      throw e;
    }
    started = "yes";
    const name = executionOf(start, a.job, jobName);
    execution = name;
    log(`execution  ${name} started`);
    const status = await waitExecution(ctx, client.armUrl(`${a.job}/executions/${name}`, q), name);
    if (status !== "Succeeded") {
      throw new CheckFailed([`execution ${name} ended ${status}. See the job's console logs (ContainerAppConsoleLogs_CL, job ${jobName}).`]);
    }
    written = true;
  } catch (e) {
    failures.push(...messages(e));
  } finally {
    // The run's signal may have ended it (SIGINT/SIGTERM); the cleanup has its own, bounded one.
    client.signal = cleanupSignal;
    if (patched) {
      try {
        await patchSecrets(ctx, jobUrl, [], `PATCH job ${jobName} (remove secret ${jobSecret})`);
        const after = await client.call("arm", jobUrl, "GET", `GET job ${jobName}`, undefined, { quote: true });
        const cfg = isObject(after.json) && isObject(own(after.json, "properties")) ? own(own(after.json, "properties") as Record<string, unknown>, "configuration") : undefined;
        const left = isObject(cfg) && Array.isArray(own(cfg, "secrets")) ? (own(cfg, "secrets") as unknown[]).filter((s) => isObject(s) && own(s, "name") === jobSecret) : [];
        if (left.length) throw new CheckFailed([`the job still lists ${jobSecret} after the removal.`]);
        log(`job secret ${jobSecret} removed from ${jobName}`);
      } catch (e) {
        failures.push(
          `could not remove the job secret ${jobSecret} from ${jobName}: ${messages(e).join(" ")} Remove it by hand: az containerapp job secret remove --name ${jobName} --resource-group ${resourceGroup} --secret-names ${jobSecret}.`,
        );
      }
    }
  }

  if (!written && started === "no") {
    // The job never ran, so the value is in no vault: remove the password, no unused credential stays.
    try {
      await client.call("graph", client.graphUrl(`v1.0/applications/${objectId}/removePassword`), "POST", "POST removePassword", { keyId }, { quote: true });
      log(`password   ${keyId} removed from app ${a.clientId}`);
    } catch (e) {
      failures.push(`could not remove the new password ${keyId} from app ${a.clientId}: ${messages(e).join(" ")} Remove it by hand: az ad app credential delete --id ${a.clientId} --key-id ${keyId}.`);
    }
  } else if (!written) {
    // The job may have written the value before it failed, timed out or was stopped: revoking the
    // password could leave a dead credential in the vault, which the plan would take as present.
    const how = started === "yes" ? `execution ${execution || "(no name)"} was started` : "the start of the job may have been accepted";
    failures.push(
      `${how}, so ${a.secretName} in vault ${a.vault} may hold the new password: it stays on app ${a.clientId} (keyId ${keyId}, expires ${endDateTime}). If the job's console logs (ContainerAppConsoleLogs_CL, job ${jobName}) show no write, remove it by hand: az ad app credential delete --id ${a.clientId} --key-id ${keyId}.`,
    );
  }
  const sig = interrupted();
  if (sig) failures.unshift(`stopped by ${sig} (the run was cancelled or timed out); the cleanup's outcome follows.`);
  if (!written) throw new CheckFailed(failures);
  const result: EasyAuthResult = {
    secretName: a.secretName,
    vault: a.vault,
    execution,
    keyId,
    endDateTime,
    mode: rotate ? "rotate" : "new",
    written: true,
    ...(rotation ? { currentKeyId: rotation.currentKeyId, removedKeyIds: rotation.removed } : {}),
  };
  if (failures.length) throw new WrittenWithProblems(result, failures);
  return result;
}

export function messages(e: unknown): string[] {
  if (e instanceof CheckFailed) return e.problems;
  // Unexpected: printed through the redaction like everything else, and cut.
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : typeof e;
  return [`internal error (${msg.length > 200 ? msg.slice(0, 197) + "..." : msg}).`];
}

export const EASYAUTH_HELP = `  easyauth-secret [--mode new|rotate|remove-old] --client-id <appId> --job <ARM ID of the kvset job>
                  --secret-name easyauth-<slug> --vault <vault name> --display-name <credential name>
                  [--current-created <epoch seconds|none>] [--current-expires <epoch seconds|none>]
                  [--loaded-created <epoch seconds|none>] [--app-vault <vault name|none>] --output <file>
      creates the app registration's Easy Auth client secret (180 days) and has the kvset job write
      it to <vault> (ADR-0035); the value stays in memory. --mode rotate (ADR-0041) first removes
      the platform-named passwords older than the one the vault holds (told by the vault version's
      created and exp, --current-*; display name easyauth-<env>[-run-<id>]), only when the app runs
      with that version (--loaded-created equals --current-created), then does the same; --mode
      new (default) takes --current-* and --loaded-created none. --mode remove-old (ADR-0060, after
      a move between the managed network and a VNet-based mode) adds no password: once --app-vault
      (the vault of the CAE the app runs in now) is another vault than <vault>, the old variant's
      kvset job (--job, caj-<prefix>-kvset-<mode>) soft-deletes easyauth-<slug> in <vault>
      (SAF_SECRET_ACTION delete, never a purge) and the predecessors of the current password go,
      with rotate's guards (--current-* name the version in the vault the app runs with now).
      Tokens in the environment only: SAF_ARM_TOKEN,
      SAF_GRAPH_TOKEN; endpoints SAF_ARM_ENDPOINT, SAF_GRAPH_ENDPOINT (default public cloud).
      Writes {secretName, vault, execution, keyId, endDateTime, mode, written} (rotate: also
      currentKeyId, removedKeyIds) once the vault holds the new password, also if a later step
      fails (exit 1); remove-old: {secretName, vault, appVault, mode, oldSecret, execution,
      currentKeyId, removedKeyIds}. Calls Azure.
`;

/** `platform provisioning easyauth-secret ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdEasyAuthSecret(args: string[], env: NodeJS.ProcessEnv = process.env, opts: EasyAuthOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  // Redaction from the first line on: the tokens as given, then the client's list (with the value).
  const early = [env.SAF_ARM_TOKEN, env.SAF_GRAPH_TOKEN].filter((t): t is string => typeof t === "string" && t.length >= 8);
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early.reduce((acc, t) => acc.split(t).join("[redacted]"), s));
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning easyauth-secret: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: EasyAuthArgs;
  let raw: { created: string; expires: string; loaded: string };
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        mode: { type: "string" },
        "client-id": { type: "string" },
        job: { type: "string" },
        "secret-name": { type: "string" },
        vault: { type: "string" },
        "display-name": { type: "string" },
        "current-created": { type: "string" },
        "current-expires": { type: "string" },
        "loaded-created": { type: "string" },
        "app-vault": { type: "string" },
        output: { type: "string" },
      },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    // remove-old needs to know where the app runs now (none: not known, then nothing is removed).
    const required = ["client-id", "job", "secret-name", "vault", "display-name", ...(v.mode === "remove-old" ? ["app-vault"] : []), "output"];
    const missing = required.filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    const appVault = v["app-vault"] === undefined || v["app-vault"] === "none" ? undefined : v["app-vault"];
    a = {
      clientId: v["client-id"]!,
      job: v.job!,
      secretName: v["secret-name"]!,
      vault: v.vault!,
      displayName: v["display-name"]!,
      output: v.output!,
      mode: (v.mode ?? "new") as EasyAuthMode,
      ...(appVault !== undefined ? { appVault } : {}),
    };
    raw = { created: v["current-created"] ?? "none", expires: v["current-expires"] ?? "none", loaded: v["loaded-created"] ?? "none" };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  const problems: string[] = [];
  for (const [flag, value, set] of [
    ["--current-created", raw.created, (n: number | undefined) => (a.currentCreated = n)],
    ["--current-expires", raw.expires, (n: number | undefined) => (a.currentExpires = n)],
    ["--loaded-created", raw.loaded, (n: number | undefined) => (a.loadedCreated = n)],
  ] as const) {
    try {
      set(parseEpoch(value, flag));
    } catch (e) {
      problems.push(...messages(e));
    }
  }
  if (problems.length) return fail(problems, 1);
  const save = (r: EasyAuthResult | RemoveOldResult): void => {
    try {
      writeJson(a.output, r);
    } catch (e) {
      const done = r.mode === "remove-old" ? "remove-old ran" : "the secret was written";
      throw new CheckFailed([`${done}, but --output could not be written (${(e as NodeJS.ErrnoException).code ?? "error"}).`]);
    }
  };
  try {
    const r = await easyAuthSecret(a, env, opts, log, (c) => (client = c));
    save(r);
    if (r.mode === "remove-old") {
      const old = r.oldSecret === "deleted" ? `deleted from ${r.vault} by execution ${r.execution}` : `kept in ${r.vault}`;
      log(`OK  remove-old ${r.secretName}: ${old}; ${r.removedKeyIds.length} predecessor(s) removed`);
      return 0;
    }
    const removed = r.removedKeyIds ? `; ${r.removedKeyIds.length} predecessor(s) removed` : "";
    log(`OK  ${r.secretName} ${r.mode === "rotate" ? "rotated in" : "written to"} ${r.vault} by execution ${r.execution} (keyId ${r.keyId}, expires ${r.endDateTime}${removed})`);
    return 0;
  } catch (e) {
    if (e instanceof WrittenWithProblems) {
      try {
        save(e.result);
      } catch (w) {
        return fail([...messages(w), ...e.problems], 1);
      }
    }
    return fail(messages(e), 1);
  }
}
