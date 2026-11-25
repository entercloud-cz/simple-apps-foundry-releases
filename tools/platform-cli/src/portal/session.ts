/**
 * Where the platform CLI keeps its sign-in to the portal (ADR-0075): the user's configuration folder,
 * never a repository. Two files, readable by the user only:
 *
 *   portal.json      the portal's address, the tenant, the CLI's client ID and scope (from the portal's
 *                    public /config.json), and the signed-in account
 *   msal-cache.json  MSAL's token cache (access and refresh token for apps.read only)
 *
 * Folder: $SAF_CONFIG_DIR, else $XDG_CONFIG_HOME/simple-apps-foundry, else %APPDATA% on Windows,
 * else ~/.config/simple-apps-foundry.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { UsageError } from "../allowlist.js";

export const SESSION_FILE = "portal.json";
export const CACHE_FILE = "msal-cache.json";

const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCOPE_RE = /^api:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/apps\.read$/i;

/** The portal's sign-in for the CLI, as its public configuration names it. */
export interface CliSignIn {
  tenantId: string;
  clientId: string;
  scope: string;
}

export interface PortalSession extends CliSignIn {
  /** https://host[:port], no path. */
  portal: string;
  /** MSAL's homeAccountId of the signed-in account. */
  homeAccountId?: string;
  username?: string;
}

export function configDir(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string {
  if (env.SAF_CONFIG_DIR) return env.SAF_CONFIG_DIR;
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "simple-apps-foundry");
  if (platform === "win32") return join(env.APPDATA || join(homedir(), "AppData", "Roaming"), "simple-apps-foundry");
  return join(homedir(), ".config", "simple-apps-foundry");
}

/**
 * The portal's base address, https://host[:port], from the portal's address or any page of it (the
 * app's page that AGENTS.md links works too). http only for localhost and 127.0.0.1 (a local demo
 * or a test).
 */
export function portalBase(value: string): string {
  let u: URL;
  try {
    u = new URL(value.trim());
  } catch {
    throw new UsageError(`"${value.slice(0, 80)}" is not the portal's address (https://portal.example.com).`);
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (!(u.protocol === "https:" || (u.protocol === "http:" && local)) || u.username || u.password) {
    throw new UsageError(`"${value.slice(0, 80)}" is not the portal's address: https://<host>.`);
  }
  return u.origin;
}

/** The CLI's sign-in from the portal's /config.json (PortalPublicConfig), or why there is none. */
export function cliSignInOf(body: unknown): CliSignIn | string {
  if (typeof body !== "object" || body === null) return "the portal's configuration is not JSON";
  const b = body as { tenantId?: unknown; cli?: { clientId?: unknown; scope?: unknown } };
  if (typeof b.tenantId !== "string" || !GUID_RE.test(b.tenantId)) return "the portal's configuration names no tenant";
  if (b.cli === undefined) return "this platform doesn't offer the CLI sign-in yet (instance.yaml portal.cliClientId); ask the platform team";
  const { clientId, scope } = b.cli;
  if (typeof clientId !== "string" || !GUID_RE.test(clientId) || typeof scope !== "string" || !SCOPE_RE.test(scope)) return "the portal's configuration has an invalid CLI sign-in";
  return { tenantId: b.tenantId.toLowerCase(), clientId: clientId.toLowerCase(), scope };
}

/** Writes a file only its owner can read, in a folder only its owner can enter. */
export function writePrivate(dir: string, name: string, text: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, name);
  writeFileSync(path, text, { encoding: "utf8", mode: 0o600 });
  chmodSync(path, 0o600);
}

export function readPrivate(dir: string, name: string): string | undefined {
  const path = join(dir, name);
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}

export function saveSession(dir: string, session: PortalSession): void {
  writePrivate(dir, SESSION_FILE, JSON.stringify(session, null, 2) + "\n");
}

/** The stored session, or undefined when there is none or it can't be used. */
export function loadSession(dir: string): PortalSession | undefined {
  const text = readPrivate(dir, SESSION_FILE);
  if (text === undefined) return undefined;
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof v !== "object" || v === null) return undefined;
  const s = v as Record<string, unknown>;
  if (typeof s.portal !== "string") return undefined;
  const signIn = cliSignInOf({ tenantId: s.tenantId, cli: { clientId: s.clientId, scope: s.scope } });
  if (typeof signIn === "string") return undefined;
  let portal: string;
  try {
    portal = portalBase(s.portal);
  } catch {
    return undefined;
  }
  return {
    portal,
    ...signIn,
    ...(typeof s.homeAccountId === "string" ? { homeAccountId: s.homeAccountId } : {}),
    ...(typeof s.username === "string" ? { username: s.username } : {}),
  };
}

/** Removes the session and the token cache. True when there was something to remove. */
export function clearSession(dir: string): boolean {
  let removed = false;
  for (const name of [SESSION_FILE, CACHE_FILE]) {
    const path = join(dir, name);
    if (existsSync(path)) {
      rmSync(path, { force: true });
      removed = true;
    }
  }
  return removed;
}
