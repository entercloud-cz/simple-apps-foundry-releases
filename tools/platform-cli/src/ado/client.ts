import { CheckFailed, isObject, own } from "../pipeline/common.js";
import { secureRequest } from "../pipeline/ado.js";

/**
 * Organization-level Azure DevOps client for `platform ado`. On top of the hardened request in
 * src/pipeline/ado.ts (token only in the Authorization header, no redirects, no echoed bodies,
 * capped responses; a failed call adds Azure DevOps' own error message), every URL is built here from a validated organization and must stay on the
 * allow-list: https://dev.azure.com/{org}/, https://vssps.dev.azure.com/{org}/ and (member
 * entitlements, `platform ado bootstrap --phase grants` only) https://vsaex.dev.azure.com/{org}/.
 * A loopback http URL is accepted only for tests (the fake server serves vssps under
 * /vssps/{org}/ and vsaex under /vsaex/{org}/).
 *
 * Token: SYSTEM_ACCESSTOKEN (pipeline, automation identity) or AZURE_DEVOPS_TOKEN (a human:
 * `az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798`).
 */

const ORG_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,48}[A-Za-z0-9]?$/;

export interface Org {
  name: string;
  /** https://dev.azure.com/{org}/ */
  base: string;
  /** https://vssps.dev.azure.com/{org}/ */
  vssps: string;
  /** https://vsaex.dev.azure.com/{org}/ (member entitlements) */
  vsaex: string;
  /** The URL as instance.yaml spells it, without a trailing slash. */
  url: string;
}

export function parseOrgUrl(raw: string): Org {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new CheckFailed(["--org-url is not a URL."]);
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const name = parts[0] ?? "";
  const loopback = u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.username || u.password || u.search || u.hash || parts.length !== 1 || !ORG_RE.test(name)) {
    throw new CheckFailed(["--org-url must be https://dev.azure.com/{organization}."]);
  }
  if (loopback) {
    const origin = u.origin;
    return { name, base: `${origin}/${name}/`, vssps: `${origin}/vssps/${name}/`, vsaex: `${origin}/vsaex/${name}/`, url: `${origin}/${name}` };
  }
  if (u.protocol !== "https:" || u.hostname !== "dev.azure.com" || u.port) throw new CheckFailed(["--org-url must be https://dev.azure.com/{organization}."]);
  return { name, base: `https://dev.azure.com/${name}/`, vssps: `https://vssps.dev.azure.com/${name}/`, vsaex: `https://vsaex.dev.azure.com/${name}/`, url: `https://dev.azure.com/${name}` };
}

export function adoToken(env: NodeJS.ProcessEnv): string {
  const t = env.SYSTEM_ACCESSTOKEN || env.AZURE_DEVOPS_TOKEN || "";
  if (!t) throw new CheckFailed(["no token: set AZURE_DEVOPS_TOKEN (az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798) or map SYSTEM_ACCESSTOKEN."]);
  if (/\s/.test(t)) throw new CheckFailed(["the token contains whitespace."]);
  return t;
}

/** A path segment from a validated or API-returned value; encodes everything else. */
export const seg = (s: string): string => encodeURIComponent(s);

export type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export type Host = "org" | "vssps" | "vsaex";

export interface CallLog {
  method: Method;
  label: string;
}

export class AdoClient {
  /** Every write this client made (for the apply summary and tests). */
  readonly writes: CallLog[] = [];

  constructor(
    readonly org: Org,
    private readonly token: string,
    private readonly readOnly: boolean,
  ) {}

  private url(host: Host, path: string, apiVersion: string, query: Record<string, string>): URL {
    const base = host === "org" ? this.org.base : host === "vssps" ? this.org.vssps : this.org.vsaex;
    const url = new URL(base + path);
    // The path is built from fixed strings and encoded segments; it must not leave the base.
    if (!url.href.startsWith(base)) throw new CheckFailed([`internal: ${path} leaves the organization.`]);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    url.searchParams.set("api-version", apiVersion);
    return url;
  }

  async get(path: string, apiVersion: string, query: Record<string, string> = {}, host: Host = "org"): Promise<unknown> {
    const r = await secureRequest(this.url(host, path, apiVersion, query), this.token, "GET", `GET ${shortPath(path)}`, undefined, { hint403: HINT, errorMessage: true });
    return r.json;
  }

  /** GET that returns undefined on 404 (the object doesn't exist). */
  async find(path: string, apiVersion: string, query: Record<string, string> = {}, host: Host = "org"): Promise<unknown> {
    const r = await secureRequest(this.url(host, path, apiVersion, query), this.token, "GET", `GET ${shortPath(path)}`, undefined, { allowStatus: [404], hint403: HINT, errorMessage: true });
    return r.status === 404 ? undefined : r.json;
  }

  /** GET of a list that may be paged with x-ms-continuationtoken. */
  async list(path: string, apiVersion: string, query: Record<string, string> = {}, host: Host = "org"): Promise<unknown[]> {
    const all: unknown[] = [];
    let token: string | null = null;
    for (let page = 0; page < 50; page++) {
      const q: Record<string, string> = token ? { ...query, continuationToken: token } : query;
      const r = await secureRequest(this.url(host, path, apiVersion, q), this.token, "GET", `GET ${shortPath(path)}`, undefined, { hint403: HINT, errorMessage: true });
      all.push(...valueList(r.json, path));
      token = r.headers.get("x-ms-continuationtoken");
      if (!token) return all;
    }
    throw new CheckFailed([`GET ${shortPath(path)}: more than 50 pages.`]);
  }

  async write(method: "POST" | "PATCH" | "PUT" | "DELETE", path: string, apiVersion: string, body: unknown, query: Record<string, string> = {}, host: Host = "org"): Promise<unknown> {
    if (this.readOnly) throw new CheckFailed([`internal: ${method} ${shortPath(path)} in plan mode.`]);
    const label = `${method} ${shortPath(path)}`;
    this.writes.push({ method, label });
    const r = await secureRequest(this.url(host, path, apiVersion, query), this.token, method, label, body, { hint403: HINT, errorMessage: true });
    return r.json;
  }
}

const HINT = " (the identity lacks a permission in Azure DevOps; see ADR-0022)";

function shortPath(path: string): string {
  // Labels never carry query strings; IDs in the path are API values or validated names.
  return path.length > 120 ? path.slice(0, 117) + "..." : path;
}

export function valueList(v: unknown, label: string): unknown[] {
  if (Array.isArray(v)) return v;
  const value = isObject(v) ? own(v, "value") : undefined;
  if (Array.isArray(value)) return value as unknown[];
  throw new CheckFailed([`GET ${shortPath(label)}: unexpected response shape.`]);
}
