import assert from "node:assert/strict";
import { describe, it, before, after } from "node:test";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { check, cli, copyFixture, fakeBin, ids, tmp, withEnv, withPath } from "./helpers.js";
import { UsageError } from "../src/allowlist.js";
import { runChecks } from "../src/run.js";
import { defaultOptions } from "../src/run.js";

// A fake `docker` CLI so the runtime check can be tested without a docker daemon. It records every
// invocation and behaves according to FAKE_DOCKER_MODE. The "container" is a real HTTP server
// started by the test and reachable on FAKE_DOCKER_PORT.
const FAKE_DOCKER = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_DOCKER_LOG, JSON.stringify(a) + "\\n");
const mode = process.env.FAKE_DOCKER_MODE || "ok";
const fmt = a.includes("--format") ? a[a.indexOf("--format") + 1] : "";
switch (a[0]) {
  case "version": console.log("27.0.0"); break;
  case "build": if (mode === "build-fail") { console.error("ERROR: failed to solve: npm ERR! missing script: build"); process.exit(1); } break;
  case "run": console.log("abc123def456"); break;
  case "port": console.log("127.0.0.1:" + process.env.FAKE_DOCKER_PORT); break;
  case "inspect":
    if (fmt.includes("State.Running")) console.log(mode === "exited" ? "false 1" : "true 0");
    else if (fmt.includes("Config.User")) console.log(mode === "root" ? "" : "node");
    break;
  case "exec": if (mode === "no-id") { console.error("exec: id: not found"); process.exit(126); } console.log(mode === "root" ? "0" : "1000"); break;
  case "logs": console.log("Error: Cannot find module '/app/server.js'"); break;
  default: break; // rm, rmi
}
`;

describe("runtime smoke test (fake docker)", () => {
  let server: Server;
  let port = 0;
  let readyzStatus = 200;
  let healthzStatus = 200;

  before(async () => {
    server = createServer((req, res) => {
      const status = req.url === "/healthz" ? healthzStatus : req.url === "/readyz" ? readyzStatus : 404;
      res.writeHead(status).end("x");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as { port: number }).port;
  });
  after(() => server.close());

  async function run(mode: string, extra: Parameters<typeof check>[1] = {}, dir = copyFixture("good-app")) {
    const bin = fakeBin("docker", FAKE_DOCKER);
    const log = join(tmp(), "docker.log");
    const report = await withPath(bin, () =>
      withEnv({ FAKE_DOCKER_LOG: log, FAKE_DOCKER_MODE: mode, FAKE_DOCKER_PORT: String(port) }, () =>
        check(dir, { only: ["runtime"], skipRuntime: false, smokeTimeoutSec: 3, ...extra }),
      ),
    );
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
    return { report, calls };
  }

  it("passes: builds, runs with PORT, polls /healthz and /readyz, asserts non-root, cleans up", async () => {
    readyzStatus = 200;
    healthzStatus = 200;
    const { report, calls } = await run("ok");
    assert.deepEqual(report.findings, []);
    assert.equal(report.exitCode, 0);
    const verbs = calls.map((c) => c[0]);
    assert.deepEqual(verbs.filter((v) => ["build", "run", "rm", "rmi"].includes(v as string)), ["build", "run", "rm", "rmi"]);
    const runCall = calls.find((c) => c[0] === "run") as string[];
    assert.ok(runCall.includes("PORT=8080"));
    assert.ok(runCall.includes("LOG_LEVEL=info"), "non-secret env values from platform.yaml are passed");
    assert.ok(!runCall.some((x) => x.startsWith("API_KEY")), "secrets are never passed");
    assert.ok(runCall.includes("--cap-drop"));
    assert.ok(report.results[0]?.notes?.some((n) => /uid 1000/.test(n)));
  });

  it("PC061 when the build fails (and shows the build output tail)", async () => {
    const { report, calls } = await run("build-fail");
    assert.deepEqual(ids(report.findings), ["PC061"]);
    assert.match(report.findings[0]?.message ?? "", /missing script: build/);
    assert.ok(!calls.some((c) => c[0] === "run"));
  });

  it("PC064 when the container runs as root (exec id -u = 0)", async () => {
    const { report } = await run("root");
    assert.deepEqual(ids(report.findings), ["PC064"]);
  });

  it("falls back to the configured USER when the image has no `id`", async () => {
    const { report } = await run("no-id");
    assert.deepEqual(report.findings, []);
    assert.ok(report.results[0]?.notes?.some((n) => /No "id" in the image/.test(n)));
  });

  it("PC065 when the container exits before it is healthy (with log tail)", async () => {
    const { report } = await run("exited");
    assert.deepEqual(ids(report.findings), ["PC065"]);
    assert.match(report.findings[0]?.message ?? "", /Cannot find module/);
  });

  it("PC062 when /healthz never returns 2xx", async () => {
    healthzStatus = 500;
    try {
      const { report } = await run("ok", { smokeTimeoutSec: 2 });
      assert.deepEqual(ids(report.findings), ["PC062"]);
      assert.match(report.findings[0]?.message ?? "", /last status 500/);
    } finally {
      healthzStatus = 200;
    }
  });

  it("PC063: any non-2xx on an unconfigured /readyz is a warning, never an error", async () => {
    readyzStatus = 500;
    try {
      const dir = copyFixture("good-app");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "platform.yaml"), 'schemaVersion: "1.0-draft"\napp: demo-app\n');
      const r = await run("ok", {}, dir);
      assert.deepEqual(ids(r.report.findings), ["PC063"]);
      assert.equal(r.report.findings[0]?.severity, "warning");
      assert.equal(r.report.exitCode, 0);
      const configured = await run("ok", {}, copyFixture("good-app"));
      assert.equal(configured.report.findings[0]?.severity, "error");
    } finally {
      readyzStatus = 200;
    }
  });

  it("PC063: readiness 503 (waiting for a dependency) is a warning, also when configured", async () => {
    readyzStatus = 503;
    try {
      const r = await run("ok", { smokeTimeoutSec: 2 }, copyFixture("good-app")); // good-app configures readiness
      assert.deepEqual(ids(r.report.findings), ["PC063"]);
      assert.equal(r.report.findings[0]?.severity, "warning");
      assert.match(r.report.findings[0]?.message ?? "", /only PORT set/);
      assert.equal(r.report.exitCode, 0);
    } finally {
      readyzStatus = 200;
    }
  });

  it("PC063: readiness 404 is a warning when not configured, an error when configured", async () => {
    readyzStatus = 404;
    try {
      const dir = copyFixture("good-app");
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "platform.yaml"), 'schemaVersion: "1.0-draft"\napp: demo-app\n');
      const warn = await run("ok", {}, dir);
      assert.deepEqual(ids(warn.report.findings), ["PC063"]);
      assert.equal(warn.report.findings[0]?.severity, "warning");
      assert.equal(warn.report.exitCode, 0);
      const strictCfg = await run("ok", {}, copyFixture("good-app")); // good-app configures readiness
      assert.equal(strictCfg.report.findings[0]?.severity, "error");
    } finally {
      readyzStatus = 200;
    }
  });

  it("--image skips the build and does not remove the image", async () => {
    const { report, calls } = await run("ok", { image: "registry.example/demo:1.2.3" });
    assert.deepEqual(report.findings, []);
    assert.ok(!calls.some((c) => c[0] === "build" || c[0] === "rmi"));
    assert.ok((calls.find((c) => c[0] === "run") as string[]).includes("registry.example/demo:1.2.3"));
  });
});

describe("runtime skip semantics", () => {
  const noDocker = (): string => tmp("pc-nodocker-");

  it("skips with a clear message when docker is not available", async () => {
    const old = process.env.PATH;
    process.env.PATH = noDocker();
    try {
      const r = await check(copyFixture("good-app"), { only: ["runtime"], skipRuntime: false });
      assert.match(r.results[0]?.skipped?.reason ?? "", /docker is not available/);
      assert.deepEqual(r.findings, []);
      assert.equal(r.exitCode, 0);
    } finally {
      process.env.PATH = old;
    }
  });

  it("--strict turns the skip into a failure (PC060)", async () => {
    const old = process.env.PATH;
    process.env.PATH = noDocker();
    try {
      const r = await check(copyFixture("good-app"), { only: ["runtime"], skipRuntime: false, strict: true });
      assert.deepEqual(ids(r.findings), ["PC060"]);
      assert.equal(r.exitCode, 1);
    } finally {
      process.env.PATH = old;
    }
  });

  it("--skip-runtime together with --strict is a usage error", async () => {
    await assert.rejects(() => runChecks({ ...defaultOptions(copyFixture("good-app")), strict: true, skipRuntime: true }), UsageError);
    const r = cli(["check", copyFixture("good-app"), "--strict", "--skip-runtime"]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /cannot be combined/);
  });
});
