/**
 * `platform app roles`: the app's roles and what each may do, live from the portal (GET /api/apps/{slug}, the CLI's
 * read-only token, ADR-0075 and ADR-0076), so the app team's AI agent builds each role as the owner described it.
 * AGENTS.md's Roles row holds them as of the last agent-files update; this command prints the current ones. It signs
 * in by itself like `platform deploy status` (`--no-login` turns that off).
 */
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "../allowlist.js";
import { neutralize } from "../neutralize.js";
import { accessToken, NotSignedIn } from "./auth.js";
import { appSlugOf, portalGet, repoPortal, rolesOf, signInTo } from "./index.js";
import { configDir, loadSession } from "./session.js";
import type { PortalSession } from "./session.js";

export const APP_ROLES_HELP = `platform app roles [--dir <app repo>] [--json] [--no-login]
    the app's roles, their level in the app's access policy (read, write, admin; none = no access) and what each may
    do, from the portal (the default roles with their default descriptions and levels).
    Signs in to the portal AGENTS.md names by itself, once (--no-login: don't). Exit 0 ok, 1 the portal refused,
    2 not signed in.
`;

export interface AppRolesDeps {
  fetchFn?: typeof fetch;
  session?: PortalSession;
  token?: () => Promise<string>;
  autoSignIn?: (portal: string) => Promise<PortalSession | string>;
  out?: (s: string) => void;
  err?: (s: string) => void;
}

export async function cmdApp(args: string[], deps: AppRolesDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(s));
  const err = deps.err ?? ((s: string) => void process.stderr.write(neutralize(s)));
  const [sub, ...rest] = args;
  if (sub !== "roles") throw new UsageError(`Usage: ${APP_ROLES_HELP.split("\n")[0]}`);
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { dir: { type: "string", default: "." }, json: { type: "boolean", default: false }, "no-login": { type: "boolean", default: false } },
  });
  if (positionals.length > 0) throw new UsageError("platform app roles takes no positional arguments.");
  const repoDir = resolve(values.dir);
  const slug = appSlugOf(repoDir);
  let session = deps.session ?? loadSession(configDir());
  const portal = session?.portal ?? repoPortal(repoDir);
  const notSignedIn = (why?: string): number => {
    err(`platform app roles: not signed in to the portal${portal ? ` ${portal}` : ""}${why ? ` (${why})` : ""}. AGENTS.md's Roles row has the roles as of the last agent-files update; the app's Access tab in the portal shows the current ones.\n`);
    return 2;
  };
  let token: string | undefined;
  for (let attempt = 0; attempt < 2 && token === undefined; attempt += 1) {
    if (!session) {
      if (values["no-login"] || !portal) return notSignedIn();
      err(`platform app roles: not signed in to ${portal} yet; signing in once.\n`);
      const r = deps.autoSignIn ? await deps.autoSignIn(portal) : await signInTo(portal, { deviceCode: false, ...(deps.fetchFn ? { fetchFn: deps.fetchFn } : {}) });
      if (typeof r === "string") return notSignedIn(`the sign-in didn't complete: ${r}`);
      session = r;
    }
    try {
      token = deps.token ? await deps.token() : await accessToken(session, configDir());
    } catch (e) {
      if (!(e instanceof NotSignedIn)) throw e;
      session = undefined;
      if (attempt === 1) return notSignedIn("the sign-in expired");
    }
  }
  if (!session || token === undefined) return notSignedIn();
  const { status, body } = await portalGet(session, token, deps.fetchFn)(`/api/apps/${encodeURIComponent(slug)}`);
  if (status !== 200 || typeof body !== "object" || body === null) {
    err(`platform app roles: the portal answered HTTP ${status} for the app ${slug}.\n`);
    return 1;
  }
  const b = body as { authentication?: { mode?: unknown; roles?: unknown } };
  const signIn = b.authentication?.mode !== "anonymous";
  const roles = signIn ? (rolesOf(b.authentication?.roles) ?? []) : [];
  if (values.json) {
    out(JSON.stringify({ app: slug, signIn, roles }, null, 2) + "\n");
    return 0;
  }
  if (!signIn) {
    out(`${slug} is public: no sign-in, no roles.\n`);
    return 0;
  }
  if (roles.length === 0) {
    out(`${slug} has no roles yet.\n`);
    return 0;
  }
  const width = Math.max(...roles.map((r) => r.value.length)) + 2;
  // ADR-0078: the level the app's default access policy gives the role (read, write, admin; none = no access).
  for (const r of roles) out(neutralize(`${r.value.padEnd(width)}${(r.level ?? "none").padEnd(7)}${r.description ?? "no description yet: ask the owner to describe it in the portal"}`) + "\n");
  return 0;
}
