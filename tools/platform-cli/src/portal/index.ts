/**
 * `platform login`, `platform logout` and `platform deploy status` (ADR-0075): the CLI reads how a
 * push went from the portal API, as the signed-in user, read-only.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../allowlist.js";
import { neutralize } from "../neutralize.js";
import type { ExplanationLanguage } from "../explanations.js";
import { accessToken, NotSignedIn, signIn } from "./auth.js";
import { clearSession, cliSignInOf, configDir, loadSession, portalBase, saveSession } from "./session.js";
import type { PortalSession } from "./session.js";
import { deployStatus, exitCodeOf, formatStatus, PortalRefused } from "./status.js";
import type { PortalGet, StatusReport } from "./status.js";

const out = (s: string): void => void process.stdout.write(neutralize(s));
const SLUG_RE = /^[a-z](-?[a-z0-9])+$/;
const SHA_RE = /^[0-9a-f]{7,40}$/i;
/** The portal caches a run in progress for 15 seconds (ADR-0042): asking more often shows nothing new. */
export const POLL_SECONDS = 15;

export const PORTAL_HELP = `platform login [--portal <url>] [--device-code]
                                            sign in to the portal once (opens the sign-in page in your
                                            browser; --device-code where no browser runs). Needed by
                                            platform deploy status (ADR-0075)
  platform logout                           remove the sign-in from this computer
  platform deploy status [--wait] [--timeout <minutes>] [--commit <sha>] [--dir <app repo>]
                         [--lang en|cs] [--json]
                                            how the delivery run of a commit (default: HEAD) went:
                                            exit 0 deployed, 1 failed (with the failed checks and a
                                            prompt for your AI agent), 2 usage or not signed in,
                                            3 still running or no run yet`;

/** A GET against the portal API with the session's token. */
export function portalGet(session: PortalSession, token: string, fetchFn: typeof fetch = fetch): PortalGet {
  return async (path: string) => {
    const res = await fetchFn(`${session.portal}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = undefined;
    }
    return { status: res.status, body };
  };
}

async function discover(portal: string, fetchFn: typeof fetch): Promise<ReturnType<typeof cliSignInOf>> {
  let res: Response;
  try {
    res = await fetchFn(`${portal}/config.json`, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
  } catch (e) {
    return `the portal ${portal} didn't answer (${e instanceof Error ? e.message : String(e)})`;
  }
  if (!res.ok) return `the portal ${portal} answered HTTP ${res.status} for /config.json`;
  try {
    return cliSignInOf(await res.json());
  } catch {
    return "the portal's configuration is not JSON";
  }
}

export async function cmdLogin(args: string[], fetchFn: typeof fetch = fetch): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { portal: { type: "string" }, "device-code": { type: "boolean", default: false } } });
  if (positionals.length > 0) throw new UsageError("Usage: platform login [--portal <url>] [--device-code]");
  const dir = configDir();
  const previous = loadSession(dir);
  const given = values.portal ?? process.env.SAF_PORTAL_URL ?? previous?.portal;
  if (!given) throw new UsageError("Which portal? platform login --portal https://<the portal's address> (AGENTS.md names it under Portal page).");
  const portal = portalBase(given);
  const signInInfo = await discover(portal, fetchFn);
  if (typeof signInInfo === "string") {
    process.stderr.write(neutralize(`platform login: ${signInInfo}.\n`));
    return 1;
  }
  const account = await signIn(signInInfo, dir, { deviceCode: values["device-code"] === true, say: (s) => process.stderr.write(neutralize(s)) });
  saveSession(dir, { portal, ...signInInfo, ...account });
  out(`OK  signed in to ${portal}${account.username ? ` as ${account.username}` : ""}. The sign-in is kept in ${dir} (only you can read it); platform logout removes it.\n`);
  return 0;
}

/**
 * The app as its portal shows it, for `platform agent-files update` (ADR-0076): GET /api/apps/{slug} with the CLI's
 * token, when the CLI is signed in to the portal AGENTS.md names. Never fails: without it the update takes AGENTS.md's
 * values and says why.
 */
export async function portalAppFacts(slug: string, portalUrl: string | undefined, fetchFn: typeof fetch = fetch): Promise<{ facts?: { title?: string; description?: string; data?: { database?: { engine: "postgres" | "azureSql" }; storage?: object }; template?: string }; note?: string }> {
  const session = loadSession(configDir());
  const offline = "the values come from AGENTS.md";
  if (!session) return { note: `not signed in to the portal (platform login): ${offline}.` };
  if (portalUrl && session.portal !== portalUrl) return { note: `signed in to ${session.portal}, but AGENTS.md names ${portalUrl}: ${offline}.` };
  let token: string;
  try {
    token = await accessToken(session, configDir());
  } catch {
    return { note: `the portal sign-in has expired (platform login): ${offline}.` };
  }
  try {
    const { status, body } = await portalGet(session, token, fetchFn)(`/api/apps/${encodeURIComponent(slug)}`);
    if (status !== 200 || typeof body !== "object" || body === null) return { note: `the portal answered HTTP ${status} for the app: ${offline}.` };
    const b = body as { title?: unknown; description?: unknown; data?: unknown; repository?: { template?: unknown } };
    return {
      facts: {
        ...(typeof b.title === "string" ? { title: b.title } : {}),
        ...(typeof b.description === "string" ? { description: b.description } : {}),
        ...(typeof b.data === "object" && b.data !== null ? { data: b.data as { database?: { engine: "postgres" | "azureSql" }; storage?: object } } : {}),
        ...(typeof b.repository?.template === "string" ? { template: b.repository.template } : {}),
      },
    };
  } catch (e) {
    return { note: `the portal didn't answer (${e instanceof Error ? e.message : String(e)}): ${offline}.` };
  }
}

export function cmdLogout(args: string[]): number {
  if (args.length > 0) throw new UsageError("Usage: platform logout");
  const dir = configDir();
  out(clearSession(dir) ? `OK  signed out: removed the sign-in from ${dir}.\n` : "Nothing to do: not signed in.\n");
  return 0;
}

/** The app's slug from platform.yaml `app`. */
export function appSlugOf(repoDir: string): string {
  const file = join(repoDir, "platform.yaml");
  if (!existsSync(file)) throw new UsageError(`No platform.yaml in ${repoDir}: run this in the app's repository (or pass --dir).`);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError("platform.yaml is not valid YAML: run platform check.");
  }
  const app = (doc as { app?: unknown } | null)?.app;
  if (typeof app !== "string" || !SLUG_RE.test(app)) throw new UsageError("platform.yaml has no valid `app` (the app's slug): run platform check.");
  return app;
}

/** HEAD of the repository, and whether a remote branch has it. */
export function headCommit(repoDir: string): { sha: string; pushed: boolean | undefined } {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: repoDir, encoding: "utf8" });
  const sha = head.status === 0 ? head.stdout.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new UsageError(`${repoDir} is not a Git repository with a commit (git rev-parse HEAD failed).`);
  const remote = spawnSync("git", ["branch", "-r", "--contains", sha], { cwd: repoDir, encoding: "utf8" });
  return { sha, pushed: remote.status === 0 ? remote.stdout.trim().length > 0 : undefined };
}

export interface DeployStatusDeps {
  fetchFn?: typeof fetch;
  /** Tests: the session and the token instead of the user's configuration and MSAL. */
  session?: PortalSession;
  token?: () => Promise<string>;
  now?: () => number;
  wait?: (seconds: number) => Promise<void>;
}

export async function cmdDeploy(args: string[], deps: DeployStatusDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  if (sub !== "status") throw new UsageError("Usage: platform deploy status [--wait] [--timeout <minutes>] [--commit <sha>] [--dir <app repo>] [--lang en|cs] [--json]");
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      wait: { type: "boolean", default: false },
      timeout: { type: "string", default: "30" },
      commit: { type: "string" },
      dir: { type: "string", default: "." },
      lang: { type: "string", default: "en" },
      json: { type: "boolean", default: false },
    },
  });
  if (positionals.length > 0) throw new UsageError("platform deploy status takes no positional arguments.");
  const timeout = Number(values.timeout);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 120) throw new UsageError("--timeout is whole minutes, 1 to 120.");
  const lang = values.lang;
  if (lang !== "en" && lang !== "cs") throw new UsageError("--lang must be en or cs.");
  const repoDir = resolve(values.dir);
  const app = appSlugOf(repoDir);
  let commit: string;
  let pushed: boolean | undefined;
  if (values.commit !== undefined) {
    if (!SHA_RE.test(values.commit)) throw new UsageError("--commit is a Git commit SHA (7 to 40 hex characters).");
    commit = values.commit.toLowerCase();
  } else {
    ({ sha: commit, pushed } = headCommit(repoDir));
  }

  const session = deps.session ?? loadSession(configDir());
  const notSignedIn = (): number => {
    process.stderr.write(
      neutralize(
        `platform deploy status: not signed in to the portal${session ? ` ${session.portal}` : ""}. Ask the user to run \`platform login${session ? "" : " --portal <the portal's address>"}\` once in a terminal (it opens the sign-in page in their browser).\n`,
      ),
    );
    return 2;
  };
  if (!session) return notSignedIn();
  let token: string;
  try {
    token = deps.token ? await deps.token() : await accessToken(session, configDir());
  } catch (e) {
    if (e instanceof NotSignedIn) return notSignedIn();
    throw e;
  }
  const get = portalGet(session, token, deps.fetchFn);
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? ((s: number) => sleep(s * 1000).then(() => undefined));
  const deadline = now() + timeout * 60_000;
  let report: StatusReport;
  let last = "";
  for (;;) {
    try {
      report = await deployStatus(get, app, commit, lang as ExplanationLanguage);
    } catch (e) {
      if (e instanceof PortalRefused) {
        process.stderr.write(neutralize(`platform deploy status: ${e.message}.\n`));
        return e.status === 401 ? 2 : e.status === 404 || e.status === 403 ? 2 : 3;
      }
      if (e instanceof Error && (e.name === "TimeoutError" || e.name === "TypeError")) {
        process.stderr.write(neutralize(`platform deploy status: the portal ${session.portal} didn't answer (${e.message}).\n`));
        if (!values.wait || now() >= deadline) return 3;
        await wait(POLL_SECONDS);
        continue;
      }
      throw e;
    }
    if (pushed === false && report.outcome === "notFound") report.notes.unshift("This commit is on no remote branch yet: push it first.");
    const done = report.outcome === "deployed" || report.outcome === "failed";
    if (!values.wait || done || now() >= deadline) break;
    // While waiting: one line whenever the state changes, on stderr, so --json stays one document.
    const line = report.run ? `run ${report.run.runId} ${report.run.status}: ${report.run.environments.map((e) => `${e.environment} ${e.state}`).join(", ") || "starting"}` : "no run for this commit yet";
    if (line !== last) process.stderr.write(neutralize(`${new Date(now()).toISOString().slice(11, 19)}  ${line}\n`));
    last = line;
    await wait(POLL_SECONDS);
  }
  if (values.wait && (report.outcome === "running" || report.outcome === "notFound")) report.notes.push(`Still not finished after ${timeout} minutes: run platform deploy status --wait again, or ask the user to look at the app's Deployments tab in the portal.`);
  out(values.json ? JSON.stringify(report, null, 2) + "\n" : formatStatus(report));
  return exitCodeOf(report);
}
