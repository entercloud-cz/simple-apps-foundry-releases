import { closeSync, fstatSync, openSync, readFileSync, readSync } from "node:fs";
import { explainProvisioningFailure, isProvisioningFailureCode, UNKNOWN_PROVISIONING_FAILURE } from "../explanations.js";
import type { ProvisioningFailureId } from "../explanations.js";
import { neutralize } from "../neutralize.js";
import { classify, errorRecords, WRAPPER_CODES } from "../pipeline/deploy-error.js";
import { CheckFailed, MiB, UsageError } from "../pipeline/common.js";

/**
 * Provisioning failure codes (ADR-0064, backlog US04.10): which code a failed deployment of
 * provisioning gets, from its error log, and the report's section of the failed apps.
 *
 * `failure-code --log <file> --kind <kind>` reads the error records of a failed
 * `az deployment … validate|create` (the same parser as classify-deploy-error) and prints one code.
 * Only cloud error codes that were seen in a sandbox run or that Microsoft documents are mapped
 * (hard rule 8); anything else is PE001 (the run's log says more). The first rule that matches wins:
 *
 *   PE007  RequestDisallowedByPolicy: an Azure Policy assignment refused a resource. Documented:
 *          Microsoft Learn, "Troubleshoot common Azure deployment errors" (error code list) and
 *          "Resolve errors for request disallowed by policy"
 *          (https://learn.microsoft.com/azure/azure-resource-manager/troubleshooting/error-policy-requestdisallowedbypolicy).
 *          Not seen in the sandbox yet: Verify in sandbox: PROV-6.
 *   PE006  AuthorizationFailed, LinkedAuthorizationFailed: the deploying identity lacks an action
 *          (or a resource provider isn't registered, which the same page names for AuthorizationFailed).
 *          Seen: NMC-4 (2026-11-15, AuthorizationFailed on managedEnvironments/read), and documented in
 *          the same error code list.
 *   PE010  RoleAssignmentUpdateNotPermitted: a role assignment of a deleted identity holds the name of the
 *          re-created identity's assignment (the names are fixed per identity resource ID, the principal ID is
 *          new). Seen: sandbox run 3727 (2026-11-16, the app's resource group deleted by hand; the Joiner
 *          assignment on the CAE). Runbook app-resource-group-deleted.
 *   PE005  SkuNotAvailable: the region has no capacity for the SKU, or doesn't offer it to the
 *          subscription. Seen: sandbox run 3396 (PostgreSQL Standard_B1ms), documented in the list.
 *   PE008  (kind entra only) Authorization_RequestDenied anywhere in the log, after prov_arm's Graph
 *          retries: the Entra provisioning identity doesn't own the registration, or lacks a Graph
 *          permission. Seen: ENT-2 (sandbox run 2901, a hand-made registration).
 *   PE004  every other error is one classify-deploy-error retries (PrincipalNotFound,
 *          AnotherOperationInProgress, an image pull refused while a role propagates): prov_arm
 *          tried again and gave up. Documented: see pipeline/deploy-error.ts.
 *   PE001  anything else, and a log without an error code.
 *
 * The codes the scripts set themselves (PE002 invalid definition, PE003 plan, PE009 vault name held
 * by a soft-deleted vault) don't come from a log: validate.sh, plan-facts and prov_vault_clash.
 *
 * `failures --input <failures.json>` prints the Markdown section "Failures" of the run summary
 * (report.sh): one row per failed app, stage and environment with its code and title, then what to
 * do per code, in English (the run summary's language). Only codes and fixed texts: never a message.
 */

export const FAILURE_CODE_HELP = `  failure-code --log <file> --kind lz|release|entra|frontdoor|portal-endpoint
      the provisioning failure code (ADR-0064) of a failed deployment from its error log (az's
      stderr): PE007 RequestDisallowedByPolicy, PE006 AuthorizationFailed or LinkedAuthorizationFailed,
      PE010 RoleAssignmentUpdateNotPermitted, PE005 SkuNotAvailable, PE008 Authorization_RequestDenied (entra), PE004 only errors that are
      retried (the retries ran out), PE001 anything else; prints the code
  failures --input <failures.json>
      the run summary's section "Failures" (report.sh) in Markdown: { failures: [{ slug, environment,
      stage, code }] }, at most 200 rows, then what to do per code
`;

const KINDS = ["lz", "release", "entra", "frontdoor", "portal-endpoint"] as const;
const POLICY_CODES = ["RequestDisallowedByPolicy"];
const PERMISSION_CODES = ["AuthorizationFailed", "LinkedAuthorizationFailed"];
const CAPACITY_CODES = ["SkuNotAvailable"];
const STALE_ASSIGNMENT_CODES = ["RoleAssignmentUpdateNotPermitted"];
const GRAPH_DENIED = /\bAuthorization_RequestDenied\b/;

/** The tail of the log (at most `max` bytes): az prints the final error last. */
function readTail(path: string, max: number): string {
  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch (e) {
    throw new CheckFailed([`log file cannot be read (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}).`]);
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) throw new CheckFailed(["log file is not a regular file."]);
    const len = Math.min(st.size, max);
    const buf = Buffer.alloc(len);
    let off = 0;
    while (off < len) {
      const n = readSync(fd, buf, off, len - off, st.size - len + off);
      if (n === 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** The failure code of a failed deployment's log (rules above). */
export function failureCodeOf(text: string, kind: string): ProvisioningFailureId {
  const codes = errorRecords(text)
    .map((r) => r.code)
    .filter((c) => !(WRAPPER_CODES as readonly string[]).includes(c));
  const any = (list: string[]): boolean => codes.some((c) => list.includes(c));
  if (any(POLICY_CODES)) return "PE007";
  if (any(PERMISSION_CODES)) return "PE006";
  if (any(STALE_ASSIGNMENT_CODES)) return "PE010";
  if (any(CAPACITY_CODES)) return "PE005";
  // Graph's codes can sit inside a message string the parser doesn't open: read the text, as prov_arm does.
  if (kind === "entra" && (codes.includes("Authorization_RequestDenied") || GRAPH_DENIED.test(text))) return "PE008";
  if (codes.length > 0 && classify(text) === "retry") return "PE004";
  return UNKNOWN_PROVISIONING_FAILURE;
}

export function cmdFailureCode(v: { log: string; kind: string }): string {
  if (!(KINDS as readonly string[]).includes(v.kind)) throw new UsageError(`--kind must be one of ${KINDS.join(", ")}.`);
  return `${failureCodeOf(readTail(v.log, 1 * MiB), v.kind)}\n`;
}

export interface FailureRow {
  slug: string;
  environment: string | null;
  stage: string;
  code: string;
}

const SLUG = /^[a-z](-?[a-z0-9])+$/;
const ENV = /^[a-z][a-z0-9]{1,7}$/;
const STAGE = /^[a-z][a-z0-9_/]{1,60}$/;
export const MAX_FAILURE_ROWS = 200;

/** The rows of failures.json (report.sh), each checked: a row that isn't well formed is left out. */
export function failureRows(file: string): FailureRow[] {
  let v: unknown;
  try {
    v = JSON.parse(readFileSync(file, "utf8")) as unknown;
  } catch {
    throw new CheckFailed(["failures file is missing or isn't JSON."]);
  }
  const list = typeof v === "object" && v !== null && Array.isArray((v as { failures?: unknown }).failures) ? ((v as { failures: unknown[] }).failures) : undefined;
  if (!list) throw new CheckFailed(["failures file has no failures list."]);
  const rows: FailureRow[] = [];
  for (const x of list) {
    if (typeof x !== "object" || x === null) continue;
    const r = x as Record<string, unknown>;
    const env = r.environment ?? null;
    if (typeof r.slug !== "string" || !SLUG.test(r.slug) || typeof r.stage !== "string" || !STAGE.test(r.stage)) continue;
    if (env !== null && (typeof env !== "string" || !ENV.test(env))) continue;
    rows.push({ slug: r.slug, environment: env, stage: r.stage, code: isProvisioningFailureCode(r.code) ? r.code : UNKNOWN_PROVISIONING_FAILURE });
  }
  return rows;
}

/** The section "Failures" of the run summary, in English: the rows, then what to do per code. */
export function formatFailures(rows: FailureRow[]): string {
  if (rows.length === 0) return "";
  const title = (code: string): string => (explainProvisioningFailure(code) ?? explainProvisioningFailure(UNKNOWN_PROVISIONING_FAILURE)!).title.en;
  const out = ["", "### Failures", "", `${rows.length} app step(s) failed. Each has a failure code (ADR-0064); the portal shows the same code and text on the app's request and page.`, "", "| App | Environment | Stage | Code | What happened |", "|---|---|---|---|---|"];
  for (const r of rows.slice(0, MAX_FAILURE_ROWS)) out.push(`| ${r.slug} | ${r.environment ?? "-"} | ${r.stage} | ${r.code} | ${title(r.code)} |`);
  if (rows.length > MAX_FAILURE_ROWS) out.push("", `... and ${rows.length - MAX_FAILURE_ROWS} more row(s) (artifact report, failures.json).`);
  out.push("");
  for (const code of [...new Set(rows.map((r) => r.code))].sort()) {
    const e = explainProvisioningFailure(code);
    const known = e ?? explainProvisioningFailure(UNKNOWN_PROVISIONING_FAILURE)!;
    const runbook = known.runbook ? ` Runbook: docs/runbooks/${known.runbook}.md.` : "";
    out.push(`- **${code}** ${e ? "" : "(a code this core version doesn't know) "}${known.title.en}: ${known.fix.en}${runbook}`);
  }
  return `${neutralize(out.join("\n"))}\n`;
}

export function cmdFailures(v: { input: string }): string {
  return formatFailures(failureRows(v.input));
}
