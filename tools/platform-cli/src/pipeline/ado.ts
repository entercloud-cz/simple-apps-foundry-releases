import { CheckFailed, MiB, envVar, isObject, own } from "./common.js";

/**
 * Minimal Azure DevOps REST client for the jobs that map System.AccessToken (source.resolve and
 * retain). The token is sent only as an Authorization header to SYSTEM_COLLECTIONURI, never
 * printed, never sent on a redirect. Error messages name the call and the HTTP status only; a
 * response body is never echoed. Responses are capped at 32 MiB.
 *
 * SYSTEM_COLLECTIONURI must be https; plain http is accepted only for a loopback host (the
 * tests' local server), so a changed variable cannot send the token anywhere else in clear text.
 */
export const API_VERSION = "7.1";
const MAX_RESPONSE = 32 * MiB;
const TIMEOUT_MS = 30_000;

export interface AdoContext {
  /** Collection URI with a trailing slash, e.g. https://dev.azure.com/contoso/ */
  base: string;
  projectId: string;
  definitionId: number;
  token: string;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function adoContext(env: NodeJS.ProcessEnv): AdoContext {
  const problems: string[] = [];
  const token = env.SYSTEM_ACCESSTOKEN ?? "";
  if (!token) problems.push("SYSTEM_ACCESSTOKEN is not set (map System.AccessToken into this step's env).");
  let base = "";
  try {
    const u = new URL(envVar("SYSTEM_COLLECTIONURI", env));
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
    if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) problems.push("SYSTEM_COLLECTIONURI must be an https URL.");
    if (u.username || u.password || u.search || u.hash) problems.push("SYSTEM_COLLECTIONURI must not carry credentials, a query or a fragment.");
    base = u.origin + (u.pathname.endsWith("/") ? u.pathname : u.pathname + "/");
  } catch (e) {
    problems.push(e instanceof CheckFailed ? (e.problems[0] ?? "SYSTEM_COLLECTIONURI is invalid.") : "SYSTEM_COLLECTIONURI is not a valid URL.");
  }
  const projectId = env.SYSTEM_TEAMPROJECTID ?? "";
  if (!GUID_RE.test(projectId)) problems.push("SYSTEM_TEAMPROJECTID must be the project GUID.");
  const def = env.SYSTEM_DEFINITIONID ?? "";
  if (!/^[1-9][0-9]{0,9}$/.test(def) || Number(def) > 2_147_483_647) problems.push("SYSTEM_DEFINITIONID must be a pipeline definition id.");
  if (problems.length) throw new CheckFailed(problems);
  return { base, projectId, definitionId: Number(def), token };
}

export async function readBody(res: Response, label: string): Promise<string> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > MAX_RESPONSE) throw new CheckFailed([`${label}: response is larger than ${MAX_RESPONSE} bytes.`]);
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE) {
      await reader.cancel().catch(() => undefined);
      throw new CheckFailed([`${label}: response is larger than ${MAX_RESPONSE} bytes.`]);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** ` Azure DevOps: "<message>"` from an error response, or "" when there is none. */
async function errorMessage(res: Response, label: string): Promise<string> {
  let text: string;
  try {
    text = await readBody(res, label);
  } catch {
    return "";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  const msg = isObject(parsed) ? own(parsed, "message") : undefined;
  if (typeof msg !== "string") return "";
  const clean = msg.replace(/[^\x20-\x7E\u00A0-\u024F]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? ` Azure DevOps: "${clean.length > 300 ? clean.slice(0, 297) + "..." : clean}"` : "";
}

export interface SecureResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

/**
 * The one place that sends an Azure DevOps token: Authorization header only, no redirects, a
 * timeout, capped responses, and errors that name the call and the status but never echo a body.
 * `allowStatus` lists non-2xx statuses returned to the caller instead of failing (e.g. 404 on a GET
 * that looks for an object). `errorMessage` (platform ado only, never the job-token clients) adds
 * Azure DevOps' own `message` of a failed call, printable characters only and cut to 300: it names
 * the missing permission, which the status alone doesn't.
 */
export async function secureRequest(
  url: URL,
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  label: string,
  body?: unknown,
  opts: { allowStatus?: number[]; hint403?: string; errorMessage?: boolean } = {},
): Promise<SecureResponse> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    const cause = (e as Error).name === "TimeoutError" ? "timed out" : "failed (network error or redirect)";
    throw new CheckFailed([`${label} ${cause}.`]);
  }
  if (!res.ok) {
    if (opts.allowStatus?.includes(res.status)) {
      await res.body?.cancel().catch(() => undefined);
      return { status: res.status, json: undefined, headers: res.headers };
    }
    const message = opts.errorMessage ? await errorMessage(res, label) : (await res.body?.cancel().catch(() => undefined), "");
    const hint = res.status === 401 || res.status === 403 ? (opts.hint403 ?? " (the job token lacks access; check the build service permissions)") : res.status === 404 ? " (not found)" : "";
    throw new CheckFailed([`${label} returned HTTP ${res.status}${hint}.${message}`]);
  }
  const text = await readBody(res, label);
  if (text === "") return { status: res.status, json: undefined, headers: res.headers };
  try {
    return { status: res.status, json: JSON.parse(text) as unknown, headers: res.headers };
  } catch {
    throw new CheckFailed([`${label} did not return JSON.`]);
  }
}

/**
 * Calls `{collection}/{projectId}/_apis/{path}` (api-version 7.1) and returns the parsed JSON.
 * `path` is built by the caller from validated numbers and fixed strings only.
 */
export async function adoRequest(ctx: AdoContext, method: "GET" | "POST" | "PATCH", path: string, query: Record<string, string> = {}, body?: unknown): Promise<unknown> {
  const url = new URL(`${ctx.base}${ctx.projectId}/_apis/${path}`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("api-version", API_VERSION);
  const r = await secureRequest(url, ctx.token, method, `${method} _apis/${path}`, body);
  if (r.json === undefined) throw new CheckFailed([`${method} _apis/${path} did not return JSON.`]);
  return r.json;
}

/** List responses come as `{ count, value: [...] }`; the reference docs show a bare array. Accept both. */
export function listValue(v: unknown, label: string): unknown[] {
  if (Array.isArray(v)) return v;
  const value = isObject(v) ? own(v, "value") : undefined;
  if (Array.isArray(value)) return value as unknown[];
  throw new CheckFailed([`${label}: unexpected response shape.`]);
}
