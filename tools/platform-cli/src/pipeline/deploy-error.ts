import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { CheckFailed, MiB } from "./common.js";

/**
 * `classify-deploy-error --log <file>`: decides whether a failed `az deployment … create` (release.bicep
 * in delivery; every deployment of provisioning) is worth retrying. Only RBAC propagation symptoms
 * and a concurrent operation on the same resource are retried; everything else fails at once, so a
 * real misconfiguration is not hidden behind four retries.
 *
 * Retried (every non-wrapper error in the log must be one of these):
 *
 * 1. Code `PrincipalNotFound`: "Principal {id} does not exist in the directory {tenant}. ... this
 *    error might be related to a replication delay." Source: Microsoft Learn, "Troubleshoot Azure
 *    RBAC", symptom "Assigning a role to a new principal sometimes fails"
 *    (https://learn.microsoft.com/azure/role-based-access-control/troubleshooting).
 *    Code `AnotherOperationInProgress`: another operation on the same (often shared) resource was
 *    running, e.g. two landing zones adding private endpoints to one subnet; provisioning runs
 *    apps in parallel (ADR-0046). Source: Microsoft Learn, "Troubleshoot common Azure deployment
 *    errors", error code list: "Wait for concurrent operation to complete"
 *    (https://learn.microsoft.com/azure/azure-resource-manager/troubleshooting/common-deployment-errors).
 *    TODO(verify) PROV-PAR-2: the code as ARM reports it inside a nested deployment.
 *
 * 2. An image pull refused by the registry while Container Apps provisions the revision, i.e.
 *    code `InvalidParameterValueInContainerTemplate` or `ContainerAppOperationError` whose message
 *    mentions the image and one of:
 *    - "unable to pull image using Managed identity <id> for registry <server>": the AcrPull
 *      assignment of the runtime identity has not propagated yet. Source (code + message, from
 *      ARM output): Microsoft Q&A 1330222 "Azure Container App fails to pull image from Azure
 *      Container Registry using managed identity"
 *      (https://learn.microsoft.com/answers/questions/1330222/).
 *    - registry error code `UNAUTHORIZED` ("UNAUTHORIZED: authentication required") or
 *      `MANIFEST_UNKNOWN`. Source: Microsoft Learn, "Troubleshoot common deployment failures in
 *      Azure Container Apps", table "Fix common image and registry issues"
 *      (https://learn.microsoft.com/azure/container-apps/troubleshoot-deployment-errors), and the
 *      OCI distribution spec error codes (UNAUTHORIZED, DENIED, MANIFEST_UNKNOWN).
 *    - registry error code `DENIED` ("requested access to the resource is denied").
 *      Source: Microsoft Q&A reports of ACA pulls with a user-assigned identity.
 *    TODO(verify): the exact wrapper code for a digest reference (`InvalidParameterValueInContainerTemplate`
 *    is documented for tags; `ContainerAppOperationError` "Failed to provision revision ..." is
 *    assumed for failures after validation) and whether MANIFEST_UNKNOWN right after `oras cp` is
 *    really transient. Verify in sandbox with a fresh identity and a just-pushed digest.
 *
 * Wrapper codes that only carry details (`DeploymentFailed`, `ResourceDeploymentFailure`,
 * `InvalidTemplateDeployment`) are ignored when deciding. A log without any recognisable error code
 * is `fail`.
 *
 * Formats read: ARM/az JSON error objects anywhere in the log ({"code", "message", "details"},
 * nested in "error", "details", "statusMessage", ...) and, when the log has no JSON error, the az
 * CLI text form "(Code) message" / "Code: X" + "Message: Y".
 */

export const RETRYABLE_CODES = ["PrincipalNotFound", "AnotherOperationInProgress"] as const;
export const IMAGE_PULL_CODES = ["InvalidParameterValueInContainerTemplate", "ContainerAppOperationError"] as const;
export const WRAPPER_CODES = ["DeploymentFailed", "ResourceDeploymentFailure", "InvalidTemplateDeployment"] as const;

const PULL_AUTH_PATTERNS: RegExp[] = [
  /unable to pull image using managed identity/i,
  /\bUNAUTHORIZED\b/,
  /\bDENIED\b/,
  /\bMANIFEST_UNKNOWN\b/,
];

export interface ErrorRecord {
  code: string;
  message: string;
}

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

function walk(v: unknown, out: ErrorRecord[], depth = 0): void {
  if (depth > 32 || v === null || typeof v !== "object") return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, out, depth + 1);
    return;
  }
  const o = v as Record<string, unknown>;
  const code = Object.hasOwn(o, "code") ? o.code : undefined;
  if (typeof code === "string" && code) {
    const message = Object.hasOwn(o, "message") && typeof o.message === "string" ? o.message : "";
    // Resource providers' errors sometimes arrive as a JSON string inside an outer error
    // ({"code":"BadRequest","message":"{\"code\":\"InvalidParameterValueInContainerTemplate\",...}"}):
    // then the outer error is only a wrapper and the inner one decides.
    let inner: unknown;
    if (message.trimStart().startsWith("{")) {
      try {
        inner = JSON.parse(message) as unknown;
      } catch {
        inner = undefined;
      }
    }
    const before = out.length;
    if (inner !== undefined) walk(inner, out, depth + 1);
    if (out.length === before) out.push({ code, message });
  }
  for (const k of Object.keys(o)) walk(o[k], out, depth + 1);
}

/** Balanced-brace JSON objects starting at the first `{` of each line, with a global work budget. */
function jsonObjects(text: string): unknown[] {
  const found: unknown[] = [];
  let budget = 20_000_000;
  let i = 0;
  while (i < text.length && budget > 0) {
    const lineEnd = text.indexOf("\n", i);
    const end = lineEnd === -1 ? text.length : lineEnd;
    const start = text.indexOf("{", i);
    if (start === -1) break;
    if (start >= end) {
      i = end + 1;
      continue;
    }
    // Scan to the matching brace, honouring JSON strings.
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = start;
    for (; j < text.length && budget > 0; j++, budget--) {
      const c = text[j];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
    }
    if (depth === 0 && j < text.length) {
      try {
        found.push(JSON.parse(text.slice(start, j + 1)));
        i = j + 1;
        continue;
      } catch {
        // not JSON: try the next line
      }
    }
    i = end + 1;
  }
  return found;
}

/** az CLI text form: "(Code) message" and "Code: X" followed by "Message: Y". */
function textRecords(text: string): ErrorRecord[] {
  const out: ErrorRecord[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((line, n) => {
    const paren = /^\s*(?:ERROR:\s*)?(?:Exception Details:\s*)?\(([A-Z][A-Za-z0-9]+)\)\s*(.*)$/.exec(line);
    if (paren) out.push({ code: paren[1] as string, message: paren[2] ?? "" });
    const code = /^\s*Code:\s*([A-Z][A-Za-z0-9]+)\s*$/.exec(line);
    if (code) {
      const next = lines[n + 1] ?? "";
      const msg = /^\s*Message:\s*(.*)$/.exec(next);
      out.push({ code: code[1] as string, message: msg?.[1] ?? "" });
    }
  });
  return out;
}

export function errorRecords(text: string): ErrorRecord[] {
  const fromJson: ErrorRecord[] = [];
  for (const o of jsonObjects(text)) walk(o, fromJson);
  return fromJson.length ? fromJson : textRecords(text);
}

export function isRetryable(r: ErrorRecord): boolean {
  if ((RETRYABLE_CODES as readonly string[]).includes(r.code)) return true;
  if ((IMAGE_PULL_CODES as readonly string[]).includes(r.code)) {
    return /\bimage\b/i.test(r.message) && PULL_AUTH_PATTERNS.some((p) => p.test(r.message));
  }
  return false;
}

export function classify(text: string): "retry" | "fail" {
  const records = errorRecords(text).filter((r) => !(WRAPPER_CODES as readonly string[]).includes(r.code));
  if (records.length === 0) return "fail";
  return records.every(isRetryable) ? "retry" : "fail";
}

export function classifyDeployError(args: { log: string }): "retry" | "fail" {
  return classify(readTail(args.log, 1 * MiB));
}
