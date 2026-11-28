import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, SLUG_RE, UsageError, own, writeJson } from "../pipeline/common.js";
import {
  CLEANUP_BOUND_MS,
  Client,
  DEFAULT_ARM,
  GUID_RE,
  JOBS_API_VERSION,
  JOB_ID_RE,
  JOB_NAME_RE,
  KVSET_JOB_NAME_RE,
  RG_RE,
  SECRET_NAME_RE,
  VAULT_RE,
  checkJob,
  deleteTemplate,
  endpoint,
  executionOf,
  messages,
  oneLine,
  processSignals,
  sleepMs,
  token,
  waitExecution,
} from "./easyauth.js";
import type { Ctx, StopSignal } from "./easyauth.js";

/**
 * `platform provisioning easyauth-delete --job <kvset job ARM ID> --vault <vault> --secret-name
 * easyauth-<slug> --output <result.json>` (ADR-0061 section 4: the delete phase of a decommissioned
 * app, unit `lz` with action delete, stage azure_<env>, the Azure provisioning identity's ARM token in
 * SAF_ARM_TOKEN): the kvset job of the app's CAE deletes the app's Easy Auth secret in its own vault,
 * the environment vault of the app's network mode. Without it a new app with the same slug would find
 * the old secret and write none of its own (easyAuthSecretExists).
 *
 *   1. GET the job with the checks of `easyauth-secret` step 1 (manual trigger, one container running
 *      saf-jobs pinned by digest with the argument kvset, no start variable of its own, its
 *      SAF_VAULT_URI --vault); its name is a kvset job's by naming (caj-{prefix}-kvset-{mode}).
 *      Nothing starts otherwise.
 *   2. POST <job>/start with the job's container plus SAF_SECRET_NAME and SAF_SECRET_ACTION delete
 *      (the job's delete action, ADR-0060: no job secret, no value, no expiry). saf-jobs soft-deletes
 *      the secret, never purges it, and counts an absent secret (404) or one being deleted (409) as
 *      done. Poll the execution every 5 s, at most 10 min, until it ends; only Succeeded is success.
 *   3. --output {secretName, vault, job, execution, secret: "deleted"}.
 *
 * No Microsoft Graph call and no password: the registration was deleted in step 1 of the delete phase.
 * The identity needs to read and start the job: the environment's Azure provisioning identity has
 * Contributor on the subscription (ADR-0031), as for the dbinit job; the kvset identity's Key Vault
 * Secrets Officer on the environment vaults covers the delete (ADR-0060 decision 12). Verify in
 * sandbox: DECOM-23 (a slug used again writes a new Easy Auth secret: the old one was deleted here).
 *
 * SIGINT/SIGTERM: the request or wait in flight stops, exit 1 (the job holds no secret of this
 * command, so there is nothing to clean up). The token comes from SAF_ARM_TOKEN only and goes only to
 * SAF_ARM_ENDPOINT (public cloud by default; https only, plain http only on a loopback host for tests).
 */

export interface EasyAuthDeleteArgs {
  job: string;
  vault: string;
  secretName: string;
  output: string;
}

export interface EasyAuthDeleteResult {
  secretName: string;
  vault: string;
  job: string;
  execution: string;
  /** The execution succeeded: the secret is soft-deleted, or was absent. */
  secret: "deleted";
}

/** Internal knobs (tests); not CLI flags. */
export interface EasyAuthDeleteOptions {
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  executionPollMs?: number;
  executionTimeoutMs?: number;
  onSignal?: (handler: (signal: StopSignal) => void) => () => void;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

/** Validates the flags; returns the parts of the job ID. */
export function checkDeleteArgs(a: EasyAuthDeleteArgs): { subscription: string; jobName: string } {
  const problems: string[] = [];
  const m = JOB_ID_RE.exec(a.job);
  const [, subscription = "", resourceGroup = "", jobName = ""] = m ?? [];
  if (!m || !GUID_RE.test(subscription) || !RG_RE.test(resourceGroup) || jobName.length > 32 || !JOB_NAME_RE.test(jobName)) {
    problems.push("--job must be the ARM ID of a Container Apps job (/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.App/jobs/{name}).");
  } else if (!KVSET_JOB_NAME_RE.test(jobName)) {
    // The delete goes only through a kvset job by naming (ADR-0060 decision 13, ADR-0061).
    problems.push("--job must name a kvset job caj-<prefix>-kvset-<ext|hyb|int>.");
  }
  const s = SECRET_NAME_RE.exec(a.secretName);
  const slug = s?.[1] ?? "";
  if (!s || slug.length < 3 || slug.length > 20 || !SLUG_RE.test(slug)) problems.push("--secret-name must be easyauth-<slug> (an app slug: 3-20 lowercase letters, digits and single hyphens).");
  if (a.vault.length < 3 || a.vault.length > 24 || !VAULT_RE.test(a.vault)) problems.push("--vault must be a Key Vault name (3-24 lowercase letters, digits and single hyphens).");
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

/** The whole step; throws CheckFailed. Exported for tests (internal options). */
export async function easyAuthDelete(a: EasyAuthDeleteArgs, env: NodeJS.ProcessEnv, opts: EasyAuthDeleteOptions, log: (s: string) => void, onClient: (c: Client) => void): Promise<EasyAuthDeleteResult> {
  const { subscription, jobName } = checkDeleteArgs(a);
  const arm = endpoint(env, "SAF_ARM_ENDPOINT", DEFAULT_ARM);
  const client = new Client(arm, arm, token(env, "SAF_ARM_TOKEN"), "", subscription);
  client.armForbiddenHint = " (the environment's Azure provisioning identity reads and starts platform jobs with its Contributor role, ADR-0031)";
  onClient(client);
  const ctx: Ctx = {
    client,
    log,
    opts: {
      now: () => new Date(),
      sleep: opts.sleep ?? sleepMs,
      executionPollMs: opts.executionPollMs ?? 5_000,
      executionTimeoutMs: opts.executionTimeoutMs ?? 10 * 60_000,
      operationPollMs: 5_000,
      operationMaxDelayMs: 30_000,
      operationTimeoutMs: 5 * 60_000,
      graphRetryDelaysMs: [],
      cleanupBoundMs: CLEANUP_BOUND_MS,
    },
  };
  const run = new AbortController();
  client.signal = run.signal;
  let stoppedBy: StopSignal | undefined;
  const unsubscribe = (opts.onSignal ?? processSignals)((sig) => {
    if (stoppedBy) return;
    stoppedBy = sig;
    log(`warn       ${sig}: stopping (the delete sets no job secret)`);
    run.abort(`${sig} received`);
  });
  try {
    const q = { "api-version": JOBS_API_VERSION };
    // 1. The job: ours, and it deletes in the expected vault.
    const got = await client.call("arm", client.armUrl(a.job, q), "GET", `GET job ${jobName}`, undefined, { quote: true });
    const job = checkJob(got.json, a.job, a.vault);
    log(`job        ${jobName}: manual, ${String(own(job.container, "image")).replace(/^.*\//, "")}, deletes in ${job.vaultHost}`);
    if (job.staleSecrets.length) log(`warn       ${jobName} holds secret(s) ${job.staleSecrets.join(", ")} from an earlier run; the delete passes none, the next secret write removes them`);
    // 2. The delete action: the name and the action only.
    const start = await client.call("arm", client.armUrl(`${a.job}/start`, q), "POST", `POST job ${jobName}/start`, deleteTemplate(job.container, job.env, a.secretName), { quote: true });
    const name = executionOf(start, a.job, jobName);
    log(`execution  ${name} started: delete ${a.secretName} in ${a.vault}`);
    const status = await waitExecution(ctx, client.armUrl(`${a.job}/executions/${name}`, q), name);
    if (status !== "Succeeded") {
      throw new CheckFailed([`execution ${name} ended ${status}; ${a.secretName} may still be in ${a.vault}. See the job's console logs (ContainerAppConsoleLogs_CL, job ${jobName}); the next run deletes it again.`]);
    }
    log(`secret     ${a.secretName} deleted from ${a.vault} (soft delete, or it was absent)`);
    return { secretName: a.secretName, vault: a.vault, job: jobName, execution: name, secret: "deleted" };
  } catch (e) {
    if (run.signal.aborted) throw new CheckFailed([`stopped by ${stoppedBy ?? "a signal"} (the run was cancelled or timed out): ${messages(e).join(" ")}`]);
    throw e;
  } finally {
    unsubscribe();
  }
}

export const EASYAUTH_DELETE_HELP = `  easyauth-delete --job <ARM ID of the kvset job> --vault <vault name> --secret-name easyauth-<slug>
                  --output <result.json>
      ADR-0061, the delete phase of a decommissioned app (unit lz): the kvset job of the app's CAE
      (caj-<prefix>-kvset-<mode>, checked as for easyauth-secret, its SAF_VAULT_URI <vault>)
      soft-deletes easyauth-<slug> in <vault> with its delete action (SAF_SECRET_ACTION delete, no
      value, never a purge; an absent secret is done), so a new app with the slug writes its own.
      Token in the environment only: SAF_ARM_TOKEN; endpoint SAF_ARM_ENDPOINT (default public cloud).
      Writes {secretName, vault, job, execution, secret}. Exit 0 ok, 1 failed, 2 usage. Calls Azure.
`;

/** `platform provisioning easyauth-delete ...` Exit 0 ok, 1 failed, 2 usage. */
export async function cmdEasyAuthDelete(args: string[], env: NodeJS.ProcessEnv = process.env, opts: EasyAuthDeleteOptions = {}): Promise<number> {
  const out = opts.out ?? ((s: string) => void process.stdout.write(s));
  const err = opts.err ?? ((s: string) => void process.stderr.write(s));
  let client: Client | undefined;
  const early = [env.SAF_ARM_TOKEN].filter((t): t is string => typeof t === "string" && t.length >= 8);
  const clean = (s: string): string => neutralize(client ? client.redact(s) : early.reduce((acc, t) => acc.split(t).join("[redacted]"), s));
  const log = (s: string): void => out(clean(oneLine(s)) + "\n");
  const fail = (lines: string[], code: number): number => {
    for (const l of lines) err(clean(`platform provisioning easyauth-delete: ${oneLine(l)}`) + "\n");
    return code;
  };
  let a: EasyAuthDeleteArgs;
  try {
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { job: { type: "string" }, vault: { type: "string" }, "secret-name": { type: "string" }, output: { type: "string" } },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = ["job", "vault", "secret-name", "output"].filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    a = { job: v.job!, vault: v.vault!, secretName: v["secret-name"]!, output: v.output! };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail([`${msg.slice(0, 300)} Run "platform provisioning help" for usage.`], 2);
  }
  try {
    const r = await easyAuthDelete(a, env, opts, log, (c) => (client = c));
    try {
      writeJson(a.output, r);
    } catch (e) {
      throw new CheckFailed([`the secret was deleted, but --output could not be written (${(e as NodeJS.ErrnoException).code ?? "error"}).`]);
    }
    log(`OK  ${r.secretName} deleted from ${r.vault} by execution ${r.execution}`);
    return 0;
  } catch (e) {
    return fail(messages(e), 1);
  }
}
