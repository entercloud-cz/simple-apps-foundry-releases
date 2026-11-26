import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { statSync } from "node:fs";
import { join } from "node:path";
import { cli, tmp, write } from "./helpers.js";
import { UsageError } from "../src/allowlist.js";
import { cmdDeploy, repoPortal } from "../src/portal/index.js";
import { loopbackCode, SignInAborted } from "../src/portal/auth.js";
import { CACHE_FILE, clearSession, cliSignInOf, configDir, loadSession, portalBase, saveSession, SESSION_FILE, writePrivate } from "../src/portal/session.js";
import type { PortalSession } from "../src/portal/session.js";
import { agentFilesBehindOf, cliDownloadUrl, deployStatus, exitCodeOf, failedChecks, formatStatus, PortalRefused } from "../src/portal/status.js";
import type { PortalGet } from "../src/portal/status.js";

const TENANT = "00000000-0000-0000-0000-000000000001";
const PORTAL_CLIENT = "00000000-0000-0000-0000-0000000000a1";
const CLI_CLIENT = "00000000-0000-0000-0000-0000000000c1";
const SCOPE = `api://${PORTAL_CLIENT}/apps.read`;
const SHA = "1a2b3c4d".repeat(5);
const OTHER = "9".repeat(40);
const session: PortalSession = { portal: "https://portal.contoso.com", tenantId: TENANT, clientId: CLI_CLIENT, scope: SCOPE, homeAccountId: "a.b", username: "jane.owner@contoso.com" };

/** A portal answering from a table of paths; records what was asked. */
function fakePortal(routes: Record<string, unknown | ((n: number) => unknown)>, status: Record<string, number> = {}): PortalGet & { asked: string[] } {
  const asked: string[] = [];
  const count = new Map<string, number>();
  const get = (async (path: string) => {
    asked.push(path);
    const n = (count.get(path) ?? 0) + 1;
    count.set(path, n);
    if (status[path] !== undefined) return { status: status[path]!, body: { error: "x" } };
    const r = routes[path];
    if (r === undefined) return { status: 404, body: { error: "not_found" } };
    return { status: 200, body: typeof r === "function" ? (r as (n: number) => unknown)(n) : r };
  }) as PortalGet & { asked: string[] };
  get.asked = asked;
  return get;
}

const run = (over: Record<string, unknown> = {}) => ({
  runId: 4406,
  runUrl: "https://dev.azure.com/contoso/Apps/_build/results?buildId=4406",
  action: "deliver",
  status: "running",
  commit: SHA,
  branch: "refs/heads/feature/export",
  environments: [{ environment: "nonprod", state: "running" }],
  ...over,
});

describe("platform login: the session", () => {
  it("takes the portal's origin from its address or any page of it; https only, http for localhost", () => {
    assert.equal(portalBase("https://portal.contoso.com"), "https://portal.contoso.com");
    assert.equal(portalBase("https://portal.contoso.com/apps/hotel-inventory"), "https://portal.contoso.com");
    assert.equal(portalBase("http://127.0.0.1:8090/"), "http://127.0.0.1:8090");
    for (const bad of ["http://portal.contoso.com", "https://user:pw@portal.contoso.com", "portal.contoso.com", "ftp://portal.contoso.com"]) {
      assert.throws(() => portalBase(bad), UsageError, bad);
    }
  });

  it("reads the CLI's sign-in from the portal's public configuration, or says why there is none", () => {
    assert.deepEqual(cliSignInOf({ tenantId: TENANT, clientId: PORTAL_CLIENT, cli: { clientId: CLI_CLIENT.toUpperCase(), scope: SCOPE } }), { tenantId: TENANT, clientId: CLI_CLIENT, scope: SCOPE });
    assert.match(String(cliSignInOf({ tenantId: TENANT, clientId: PORTAL_CLIENT })), /doesn't offer the CLI sign-in yet/);
    // Only apps.read: a configuration that asks for the SPA's scope is refused.
    assert.match(String(cliSignInOf({ tenantId: TENANT, cli: { clientId: CLI_CLIENT, scope: `api://${PORTAL_CLIENT}/access_as_user` } })), /invalid CLI sign-in/);
    assert.match(String(cliSignInOf("<html>")), /not JSON/);
  });

  it("keeps the session in the user's configuration folder, readable by the user only, and removes it", () => {
    const dir = join(tmp("pc-portal-"), "cfg");
    saveSession(dir, session);
    writePrivate(dir, CACHE_FILE, "{}");
    assert.deepEqual(loadSession(dir), session);
    if (process.platform !== "win32") {
      assert.equal(statSync(join(dir, SESSION_FILE)).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, CACHE_FILE)).mode & 0o777, 0o600);
      assert.equal(statSync(dir).mode & 0o777, 0o700);
    }
    assert.equal(clearSession(dir), true);
    assert.equal(loadSession(dir), undefined);
    assert.equal(clearSession(dir), false);
  });

  it("finds the configuration folder: SAF_CONFIG_DIR, XDG_CONFIG_HOME, APPDATA, ~/.config", () => {
    assert.equal(configDir({ SAF_CONFIG_DIR: "/x" }, "linux"), "/x");
    assert.equal(configDir({ XDG_CONFIG_HOME: "/xdg" }, "linux"), join("/xdg", "simple-apps-foundry"));
    assert.equal(configDir({ APPDATA: "C:\\Users\\jane\\AppData\\Roaming" }, "win32"), join("C:\\Users\\jane\\AppData\\Roaming", "simple-apps-foundry"));
    assert.match(configDir({}, "linux"), /\.config[\\/]simple-apps-foundry$/);
  });
});

describe("platform deploy status: one look", () => {
  it("a run of the commit in progress: running (exit 3); other commits' runs are ignored", async () => {
    const get = fakePortal({ "/api/apps/hotel-inventory/runs": { state: "ok", runs: [run({ runId: 4407, commit: OTHER }), run()] } });
    const r = await deployStatus(get, "hotel-inventory", SHA);
    assert.equal(r.outcome, "running");
    assert.equal(r.run?.runId, 4406);
    assert.equal(exitCodeOf(r), 3);
    assert.match(formatStatus(r), /^hotel-inventory, commit 1a2b3c4 \(feature\/export\): run 4406 running\.\n {2}nonprod {4}running\n/);
  });

  it("a short --commit matches; succeeded: deployed (exit 0); production waiting for approval is done too", async () => {
    const done = await deployStatus(fakePortal({ "/api/apps/hotel-inventory/runs": { state: "ok", runs: [run({ status: "succeeded", environments: [{ environment: "nonprod", state: "succeeded" }] })] } }), "hotel-inventory", SHA.slice(0, 7));
    assert.equal(done.outcome, "deployed");
    assert.equal(exitCodeOf(done), 0);
    const merged = run({ status: "waitingForApproval", environments: [{ environment: "nonprod", state: "succeeded" }, { environment: "prod", state: "waitingForApproval", approvers: "Platform team" }] });
    const r = await deployStatus(fakePortal({ "/api/apps/hotel-inventory/runs": { state: "ok", runs: [merged] } }), "hotel-inventory", SHA);
    assert.equal(r.outcome, "deployed");
    assert.match(formatStatus(r), /prod waits for its approval by Platform team: nothing for you to do\./);
  });

  it("failed: the failed checks with the catalogue's prompt for the agent (exit 1)", async () => {
    const get = fakePortal({
      "/api/apps/hotel-inventory/runs": { state: "ok", runs: [run({ status: "failed", environments: [{ environment: "nonprod", state: "notStarted" }] })] },
      "/api/apps/hotel-inventory/runs/4406/checks": {
        state: "ok",
        build: {
          outcome: "failed",
          groups: [
            { group: "dockerfile", outcome: "failed", findings: [{ ruleId: "PC011", level: "error", file: "Dockerfile", line: 1 }, { ruleId: "PC011", level: "error", file: "Dockerfile", line: 9 }] },
            { group: "docs", outcome: "warning", findings: [{ ruleId: "PC040", level: "warning", file: "README.md" }] },
          ],
        },
        environments: [{ environment: "nonprod", release: "notRun", smoke: "notRun" }],
      },
    });
    const r = await deployStatus(get, "hotel-inventory", SHA);
    assert.equal(r.outcome, "failed");
    assert.equal(exitCodeOf(r), 1);
    assert.deepEqual(r.failed?.map((f) => f.id), ["PC011"]);
    assert.deepEqual(r.failed?.[0]?.places, [{ file: "Dockerfile", line: 1 }, { file: "Dockerfile", line: 9 }]);
    const text = formatStatus(r);
    assert.match(text, /Failed: PC011 at Dockerfile:1, Dockerfile:9/);
    assert.match(text, /The platform's check ".+" \(PC011\) failed for hotel-inventory \(Dockerfile:1, Dockerfile:9\)\./);
    assert.match(text, /When you're done, run `platform check`/);
    assert.ok(get.asked.includes("/api/apps/hotel-inventory/runs/4406/checks"));
  });

  it("a failed deployment, a blocking scan, and checks the portal can't read", () => {
    const deployment = failedChecks({ state: "ok", build: { outcome: "passed", groups: [] }, environments: [{ environment: "nonprod", release: "failed", smoke: "notRun" }] }, "hotel-inventory", undefined, "en");
    assert.deepEqual(deployment.failed.map((f) => [f.id, f.environment]), [["deployment", "nonprod"]]);
    const scan = failedChecks(
      { state: "ok", scan: { pass: false, blocking: 1, top: [{ id: "CVE-2026-0001", pkg: "openssl", installed: "3.0.1", fixed: "3.0.2", severity: "CRITICAL" }] }, environments: [] },
      "hotel-inventory",
      undefined,
      "cs",
    );
    assert.equal(scan.failed[0]?.id, "scan-gate");
    assert.deepEqual(scan.failed[0]?.details, ["CRITICAL CVE-2026-0001 in openssl 3.0.1, fixed in 3.0.2"]);
    assert.match(scan.failed[0]!.prompt, /Podrobnosti:/);
    const unreadable = failedChecks({ state: "unavailable", environments: [] }, "hotel-inventory", undefined, "en");
    assert.deepEqual(unreadable.failed, []);
    assert.match(unreadable.notes[0]!, /Deployments tab/);
  });

  it("no run in the last half hour: the deploy history; nothing at all: not found (exit 3)", async () => {
    const history = fakePortal({
      "/api/apps/hotel-inventory/runs": { state: "ok", runs: [] },
      "/api/apps/hotel-inventory/deployments?limit=50": { items: [{ environment: "nonprod", runId: 4400, attempt: 1, result: "succeeded", action: "deliver", commit: SHA }] },
    });
    const old = await deployStatus(history, "hotel-inventory", SHA);
    assert.equal(old.outcome, "deployed");
    assert.equal(old.run?.runId, 4400);
    const none = await deployStatus(fakePortal({ "/api/apps/hotel-inventory/runs": { state: "ok", runs: [] }, "/api/apps/hotel-inventory/deployments?limit=50": { items: [] } }), "hotel-inventory", SHA);
    assert.equal(none.outcome, "notFound");
    assert.equal(exitCodeOf(none), 3);
    assert.match(formatStatus(none), /no delivery run for this commit yet/);
  });

  it("an app the user has no role in, a refused or expired sign-in: the portal's answer, said plainly", async () => {
    await assert.rejects(deployStatus(fakePortal({}), "hotel-inventory", SHA), (e: unknown) => e instanceof PortalRefused && e.status === 404 && /no role in it/.test(e.message));
    await assert.rejects(deployStatus(fakePortal({}, { "/api/apps/hotel-inventory/runs": 401 }), "hotel-inventory", SHA), (e: unknown) => e instanceof PortalRefused && /platform login/.test(e.message));
  });
});

describe("the browser sign-in's loopback listener", () => {
  it("takes the code of this sign-in only (its state), answers the browser and closes", async () => {
    let redirect = "";
    const opened: string[] = [];
    const p = loopbackCode(
      async (r) => {
        redirect = r;
        return `https://login.example/authorize?redirect_uri=${encodeURIComponent(r)}`;
      },
      "state-1",
      { timeoutMs: 10_000, open: (u) => void opened.push(u), say: () => undefined },
    );
    while (!opened.length) await new Promise((r) => setTimeout(r, 10));
    assert.match(redirect, /^http:\/\/localhost:\d+$/);
    const port = new URL(redirect).port;
    const stray = await fetch(`http://127.0.0.1:${port}/?code=x&state=other`);
    assert.equal(stray.status, 404, "another sign-in's redirect is ignored");
    const ok = await fetch(`http://127.0.0.1:${port}/?code=the-code&state=state-1`);
    assert.match(await ok.text(), /signed in/);
    assert.deepEqual(await p, { code: "the-code", redirectUri: redirect });
    await assert.rejects(fetch(`http://127.0.0.1:${port}/`), "the listener is closed");
  });

  it("an error from Entra or nobody signing in: SignInAborted, no hang", async () => {
    const opened: string[] = [];
    const p = loopbackCode(async (r) => r, "s", { timeoutMs: 10_000, open: (u) => void opened.push(u), say: () => undefined });
    const failed = p.then(() => undefined, (e: unknown) => e);
    while (!opened.length) await new Promise((r) => setTimeout(r, 10));
    await fetch(`http://127.0.0.1:${new URL(opened[0]!).port}/?error=access_denied&state=s`);
    const e = await failed;
    assert.ok(e instanceof SignInAborted && /access_denied/.test(e.message), String(e));
    await assert.rejects(loopbackCode(async (r) => r, "s", { timeoutMs: 50, open: () => undefined, say: () => undefined }), SignInAborted);
  });
});

describe("platform deploy status: the agent files (PC057)", () => {
  it("a deployed run whose check warned PC057: the update to offer, with the core's CLI download", async () => {
    const get = fakePortal({
      "/api/apps/hotel-inventory/runs": { state: "ok", runs: [run({ status: "succeeded", environments: [{ environment: "nonprod", state: "succeeded" }] })] },
      "/api/apps/hotel-inventory/runs/4406/checks": {
        state: "ok",
        build: { outcome: "passed", groups: [{ group: "agent-files", outcome: "warning", findings: [{ ruleId: "PC057", level: "warning", file: "AGENTS.md" }] }] },
        image: { coreVersion: "v0.2.0-rc.12" },
        environments: [],
      },
      "/config.json": { tenantId: TENANT, cli: { clientId: CLI_CLIENT, scope: SCOPE, releases: "https://github.com/contoso/simple-apps-foundry-releases" } },
    });
    const r = await deployStatus(get, "hotel-inventory", SHA);
    assert.equal(r.outcome, "deployed");
    assert.equal(r.agentFiles?.coreVersion, "v0.2.0-rc.12");
    assert.equal(r.agentFiles?.cliUrl, "https://github.com/contoso/simple-apps-foundry-releases/releases/download/v0.2.0-rc.12/simple-apps-foundry-platform-cli-0.2.0-rc.12.tgz");
    const text = formatStatus(r);
    assert.match(text, /The agent files are out of date \(PC057: the platform's check with core v0\.2\.0-rc\.12\)\. Offer the user to update them now:/);
    assert.match(text, /platform agent-files update/);
    assert.equal(exitCodeOf(r), 0, "a warning doesn't change the outcome");
  });

  it("no PC057, unreadable checks: nothing about the agent files; a bad releases address gives no link", async () => {
    assert.equal(agentFilesBehindOf({ state: "ok", build: { groups: [{ findings: [{ ruleId: "PC040", level: "warning" }] }] } }), undefined);
    assert.deepEqual(agentFilesBehindOf({ build: { groups: [{ findings: [{ ruleId: "PC057" }] }] }, image: { coreVersion: "not a version" } }), {});
    assert.equal(cliDownloadUrl("javascript:alert(1)", "v1.0.0"), undefined);
    const quiet = await deployStatus(fakePortal({ "/api/apps/hotel-inventory/runs": { state: "ok", runs: [run({ status: "succeeded", environments: [] })] } }, { "/api/apps/hotel-inventory/runs/4406/checks": 503 }), "hotel-inventory", SHA);
    assert.equal(quiet.outcome, "deployed");
    assert.equal(quiet.agentFiles, undefined);
  });
});

describe("platform deploy status: the command", () => {
  function appRepo(): string {
    const dir = tmp("pc-deploy-");
    write(dir, "platform.yaml", 'schemaVersion: "1.0-draft"\napp: hotel-inventory\n');
    return dir;
  }

  it("--wait asks every 15 seconds until the run ends, then exits by the outcome", async () => {
    let calls = 0;
    const waits: number[] = [];
    let clock = 0;
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://portal.contoso.com/api/apps/hotel-inventory/runs");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer token-1");
      calls += 1;
      const body = { state: "ok", runs: [calls < 3 ? run() : run({ status: "succeeded", environments: [{ environment: "nonprod", state: "succeeded" }] })] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as typeof fetch;
    const code = await cmdDeploy(["status", "--wait", "--commit", SHA, "--dir", appRepo()], {
      fetchFn,
      session,
      token: async () => "token-1",
      now: () => clock,
      wait: async (s) => {
        waits.push(s);
        clock += s * 1000;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 3);
    assert.deepEqual(waits, [15, 15]);
  });

  it("stops at --timeout with exit 3", async () => {
    let clock = 0;
    const fetchFn = (async () => new Response(JSON.stringify({ state: "ok", runs: [run()] }), { status: 200 })) as typeof fetch;
    const code = await cmdDeploy(["status", "--wait", "--timeout", "1", "--commit", SHA, "--dir", appRepo()], {
      fetchFn,
      session,
      token: async () => "t",
      now: () => clock,
      wait: async (s) => {
        clock += s * 1000;
      },
    });
    assert.equal(code, 3);
  });

  it("refuses a bad commit, a repository without platform.yaml and a wrong timeout", async () => {
    await assert.rejects(cmdDeploy(["status", "--commit", "main", "--dir", appRepo()], { session, token: async () => "t" }), UsageError);
    await assert.rejects(cmdDeploy(["status", "--commit", SHA, "--dir", tmp("pc-empty-")], { session, token: async () => "t" }), /No platform\.yaml/);
    await assert.rejects(cmdDeploy(["status", "--timeout", "0", "--commit", SHA, "--dir", appRepo()], { session, token: async () => "t" }), /--timeout/);
    await assert.rejects(cmdDeploy(["logs"], {}), UsageError);
  });

  it("without a sign-in and without a portal in AGENTS.md: exit 2, the Deployments tab (the real CLI)", () => {
    const dir = appRepo();
    const r = cli(["deploy", "status", "--commit", SHA, "--dir", dir], { SAF_CONFIG_DIR: tmp("pc-nocfg-"), SAF_PORTAL_URL: "" });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /not signed in to the portal\. Tell the user that the app's Deployments tab in the portal shows the run; AGENTS\.md names no portal/);
  });

  it("not signed in: it signs in by itself with the portal AGENTS.md names, then follows the run; --no-login doesn't", async () => {
    const dir = appRepo();
    write(dir, "AGENTS.md", "| Portal page | https://portal.contoso.com/apps/hotel-inventory |\n");
    assert.equal(repoPortal(dir), "https://portal.contoso.com");
    const asked: string[] = [];
    const fetchFn = (async () => new Response(JSON.stringify({ state: "ok", runs: [run({ status: "succeeded", environments: [{ environment: "nonprod", state: "succeeded" }] })] }), { status: 200 })) as typeof fetch;
    const cfg = tmp("pc-autologin-");
    const saved = process.env.SAF_CONFIG_DIR;
    process.env.SAF_CONFIG_DIR = cfg;
    try {
      const code = await cmdDeploy(["status", "--commit", SHA, "--dir", dir], {
        fetchFn,
        token: async () => "t",
        autoSignIn: async (portal) => {
          asked.push(portal);
          return session;
        },
      });
      assert.equal(code, 0);
      assert.deepEqual(asked, ["https://portal.contoso.com"]);
      asked.length = 0;
      assert.equal(await cmdDeploy(["status", "--commit", SHA, "--dir", dir, "--no-login"], { fetchFn, autoSignIn: async (p) => (asked.push(p), session) }), 2);
      assert.deepEqual(asked, [], "--no-login never opens the sign-in");
      assert.equal(await cmdDeploy(["status", "--commit", SHA, "--dir", dir], { fetchFn, autoSignIn: async () => "nobody signed in within 5 minutes" }), 2);
    } finally {
      if (saved === undefined) delete process.env.SAF_CONFIG_DIR;
      else process.env.SAF_CONFIG_DIR = saved;
    }
  });

  it("logout without a sign-in has nothing to do; login needs a portal", () => {
    const cfg = tmp("pc-nocfg-");
    const out = cli(["logout"], { SAF_CONFIG_DIR: cfg });
    assert.equal(out.code, 0);
    assert.match(out.stdout, /Nothing to do: not signed in\./);
    const login = cli(["login"], { SAF_CONFIG_DIR: cfg, SAF_PORTAL_URL: "" });
    assert.equal(login.code, 2);
    assert.match(login.stderr, /Which portal\? platform login --portal/);
  });
});
