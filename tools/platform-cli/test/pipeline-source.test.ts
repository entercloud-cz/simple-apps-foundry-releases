import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CLI, tmp } from "./helpers.js";
import { PIPE, VSO, readJsonFile } from "./pipeline-helpers.js";
import { jobRecords, parseTimeline, stageRecord } from "../src/pipeline/source.js";

// A fake Azure DevOps REST API on 127.0.0.1. Shapes follow the 7.1 reference (Build, Run,
// Timeline, RetentionLease). Each test sets `runs` and `leases`; every request is recorded.

const PROJECT = "00000000-0000-0000-0000-000000000a01";
const DEF = 42;
const TOKEN = "fake-job-token-" + "x".repeat(20);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";

type StageResult = "succeeded" | "succeededWithIssues" | "failed" | "skipped" | "canceled";

interface FakeRun {
  definitionId?: number;
  status?: string;
  deleted?: boolean;
  appRef?: string;
  commit?: string;
  scan?: StageResult | "missing";
  stages?: Record<string, StageResult>;
  /** Timeline variant: "phase-only" leaves the Job records without identifier (Phase decides). */
  variant?: "default" | "phase-only";
}

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  body: unknown;
}

let server: Server;
let base = "";
let runs: Record<number, FakeRun> = {};
let leases: { leaseId: number; ownerId: string; runId: number; definitionId: number; validUntil: string }[] = [];
let requests: Recorded[] = [];
let forced: { status: number; body?: string; location?: string } | undefined;
let bareArrays = false;

function timeline(run: FakeRun): unknown {
  const records: Record<string, unknown>[] = [];
  let n = 0;
  const id = (): string => `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
  // Shaped like sandbox run 2874: Phase "<stage>.<job>", Job "<stage>.<job>.__default" for a
  // regular job and "<stage>.<job>.<hook>" for a deployment job.
  const addJob = (stageId: string, stage: string, job: string, display: string, result: StageResult, hook = "__default"): void => {
    const phaseId = id();
    records.push({ id: phaseId, parentId: stageId, type: "Phase", identifier: `${stage}.${job}`, name: display, state: "completed", result });
    records.push({ id: id(), parentId: phaseId, type: "Job", identifier: run.variant === "phase-only" ? null : `${stage}.${job}.${hook}`, name: display, state: "completed", result });
  };
  const verifyId = id();
  records.push({ id: verifyId, parentId: null, type: "Stage", identifier: "verify", name: "Verify", state: "completed", result: "succeeded" });
  addJob(verifyId, "verify", "prepare", "Prepare", "succeeded");
  addJob(verifyId, "verify", "build", "Build image", "succeeded");
  if (run.scan !== "missing") addJob(verifyId, "verify", "scan", "Scan and release manifest", run.scan ?? "succeeded");
  for (const [stage, result] of Object.entries(run.stages ?? {})) {
    const sid = id();
    records.push({ id: sid, parentId: null, type: "Stage", identifier: stage, name: `Deploy to ${stage.slice(7)}`, state: "completed", result });
    addJob(sid, stage, "release", "Release", result, "release");
  }
  return { id: id(), changeId: 1, records };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
}

function handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const prefix = `/contoso/${PROJECT}/_apis/`;
  const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
  requests.push({ method: req.method ?? "", path, query: url.searchParams, auth: req.headers.authorization, body: raw ? (JSON.parse(raw) as unknown) : undefined });
  if (forced) {
    res.writeHead(forced.status, { "Content-Type": "application/json", ...(forced.location ? { Location: forced.location } : {}) }).end(forced.body ?? "");
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}` || url.searchParams.get("api-version") !== "7.1") return send(res, 401, { message: "no" });
  let m: RegExpExecArray | null;
  if ((m = /^build\/builds\/(\d+)$/.exec(path))) {
    const r = runs[Number(m[1])];
    if (!r) return send(res, 404, { message: "not found" });
    return send(res, 200, { id: Number(m[1]), definition: { id: r.definitionId ?? DEF, name: "demo" }, status: r.status ?? "completed", result: "succeeded", deleted: r.deleted ?? false, sourceBranch: "refs/heads/main" });
  }
  if ((m = /^pipelines\/(\d+)\/runs\/(\d+)$/.exec(path))) {
    const r = runs[Number(m[2])];
    if (!r || Number(m[1]) !== (r.definitionId ?? DEF)) return send(res, 404, { message: "not found" });
    return send(res, 200, {
      id: Number(m[2]),
      state: "completed",
      result: "succeeded",
      pipeline: { id: DEF },
      resources: {
        repositories: {
          self: { refName: "refs/heads/main", version: "f".repeat(40) },
          app: { refName: r.appRef ?? "refs/heads/main", version: r.commit ?? COMMIT },
          core: { refName: "refs/tags/v0.3.0", version: "e".repeat(40) },
        },
      },
    });
  }
  if ((m = /^build\/builds\/(\d+)\/timeline$/.exec(path))) {
    const r = runs[Number(m[1])];
    return r ? send(res, 200, timeline(r)) : send(res, 404, {});
  }
  if (path === "build/retention/leases" && req.method === "GET") {
    const found = leases.filter((l) => l.ownerId === url.searchParams.get("ownerId") && String(l.runId) === url.searchParams.get("runId") && String(l.definitionId) === url.searchParams.get("definitionId"));
    return send(res, 200, bareArrays ? found : { count: found.length, value: found });
  }
  if (path === "build/retention/leases" && req.method === "POST") {
    const body = JSON.parse(raw) as { ownerId: string; runId: number; definitionId: number; daysValid: number }[];
    const created = body.map((b, i) => ({ leaseId: 900 + leases.length + i, ownerId: b.ownerId, runId: b.runId, definitionId: b.definitionId, validUntil: "2027-10-29T00:00:00Z", protectPipeline: false }));
    leases.push(...created);
    return send(res, 200, bareArrays ? created : { count: created.length, value: created });
  }
  if ((m = /^build\/retention\/leases\/(\d+)$/.exec(path)) && req.method === "PATCH") {
    const l = leases.find((x) => x.leaseId === Number(m![1]));
    return l ? send(res, 200, { ...l, validUntil: "2028-01-01T00:00:00Z" }) : send(res, 404, {});
  }
  send(res, 404, {});
}

/** Runs the CLI asynchronously (the fake server lives in this process). */
function pipeAsync(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SYSTEM_|SAF_|RESOURCES_REPOSITORIES_|BUILD_BUILDID$)/.test(k)));
  const merged: Record<string, string> = { ...(clean as Record<string, string>), NO_COLOR: "1" };
  const defaults: Record<string, string> = { SYSTEM_ACCESSTOKEN: TOKEN, SYSTEM_COLLECTIONURI: `${base}/contoso/`, SYSTEM_TEAMPROJECTID: PROJECT, SYSTEM_DEFINITIONID: String(DEF) };
  for (const [k, v] of Object.entries({ ...defaults, ...env })) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "pipeline", ...args], { env: merged });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function verify(runId: number | string, target: string, promoteFrom: string, kind: string, env: Record<string, string | undefined> = {}) {
  const out = join(tmp(), "source.json");
  return pipeAsync(
    ["verify-source-run", "--run-id", String(runId), "--target", target, "--promote-from", promoteFrom, "--default-branch", "refs/heads/main", "--target-kind", kind, "--output", out],
    env,
  ).then((r) => ({ ...r, out }));
}

before(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d: Buffer) => (raw += d.toString()));
    req.on("end", () => handle(req, res, raw));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(() => server.close());
beforeEach(() => {
  runs = {};
  leases = [];
  requests = [];
  forced = undefined;
  bareArrays = false;
});

describe("pipeline verify-source-run", () => {
  it("rollback: the run deployed to the target before (nonprod, any branch)", async () => {
    runs[100] = { appRef: "refs/heads/feature/x", stages: { deploy_nonprod: "succeeded" } };
    const r = await verify(100, "nonprod", "", "nonprod");
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJsonFile(r.out), { runId: 100, commit: COMMIT, appRef: "refs/heads/feature/x", path: "rollback" });
    assert.match(r.stdout, /^OK {2}run 100 .* may be deployed to nonprod: rollback\n$/);
    assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["GET build/builds/100", `GET pipelines/${DEF}/runs/100`, "GET build/builds/100/timeline"]);
    assert.ok(requests.every((q) => q.auth === `Bearer ${TOKEN}` && q.query.get("api-version") === "7.1"));
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
  });

  it("promotion: an earlier default-branch build that reached the source environment goes to prod", async () => {
    runs[200] = { stages: { deploy_nonprod: "succeeded", deploy_prod: "skipped" } };
    const r = await verify(200, "prod", "nonprod", "prod");
    assert.equal(r.code, 0, r.stderr);
    assert.equal((readJsonFile(r.out) as { path: string }).path, "promotion");
  });

  it("rollback wins when the run reached the target itself", async () => {
    runs[201] = { stages: { deploy_nonprod: "succeeded", deploy_prod: "succeeded" } };
    const r = await verify(201, "prod", "nonprod", "prod");
    assert.equal((readJsonFile(r.out) as { path: string }).path, "rollback");
  });

  it("finds the scan job through its Phase when the Job record has no identifier", async () => {
    runs[202] = { variant: "phase-only", stages: { deploy_nonprod: "succeeded" } };
    assert.equal((await verify(202, "nonprod", "", "nonprod")).code, 0);
  });

  it("prod only receives default-branch builds, on both paths", async () => {
    runs[300] = { appRef: "refs/heads/feature/x", stages: { deploy_nonprod: "succeeded" } };
    const promo = await verify(300, "prod", "nonprod", "prod");
    assert.equal(promo.code, 1);
    assert.match(promo.stderr, /neither its stage deploy_prod nor deploy_nonprod succeeded on the default branch/);
    runs[301] = { appRef: "refs/heads/feature/x", stages: { deploy_nonprod: "succeeded", deploy_prod: "succeeded" } };
    const rb = await verify(301, "prod", "nonprod", "prod");
    assert.equal(rb.code, 1);
    assert.match(rb.stderr, /built from refs\/heads\/feature\/x, not from the default branch refs\/heads\/main; prod only receives default-branch builds/);
  });

  it("rejects runs that never deployed, or deployed with issues (nothing-to-do warnings)", async () => {
    runs[400] = { stages: { deploy_nonprod: "failed" } };
    assert.match((await verify(400, "nonprod", "", "nonprod")).stderr, /its stage deploy_nonprod did not succeed/);
    runs[401] = { stages: { deploy_nonprod: "succeededWithIssues" } };
    assert.equal((await verify(401, "nonprod", "", "nonprod")).code, 1);
    runs[402] = { stages: {} };
    assert.equal((await verify(402, "prod", "nonprod", "prod")).code, 1);
  });

  it("requires a succeeded scan job (a redeploy run has none)", async () => {
    runs[500] = { scan: "failed", stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(500, "nonprod", "", "nonprod")).stderr, /its scan job did not succeed/);
    runs[501] = { scan: "missing", stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(501, "nonprod", "", "nonprod")).stderr, /has no verify\.scan job/);
  });

  it("requires the same pipeline, a completed and not deleted run", async () => {
    runs[600] = { definitionId: 7, stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(600, "nonprod", "", "nonprod")).stderr, /belongs to another pipeline/);
    runs[601] = { status: "inProgress", stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(601, "nonprod", "", "nonprod")).stderr, /has not completed \(status inProgress\)/);
    runs[602] = { deleted: true, stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(602, "nonprod", "", "nonprod")).stderr, /has been deleted/);
    runs[603] = { commit: "abc", stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(603, "nonprod", "", "nonprod")).stderr, /no app commit/);
  });

  it("reports HTTP errors without echoing the response body or the token", async () => {
    forced = { status: 404, body: `${VSO}task.setvariable variable=x]1 ${TOKEN}` };
    const r = await verify(700, "nonprod", "", "nonprod");
    assert.equal(r.code, 1);
    assert.equal(r.stderr, "platform pipeline verify-source-run: GET _apis/build/builds/700 returned HTTP 404 (not found).\n");
    forced = { status: 401 };
    assert.match((await verify(700, "nonprod", "", "nonprod")).stderr, /HTTP 401 \(the job token lacks access/);
  });

  it("never follows a redirect with the token", async () => {
    forced = { status: 302, location: "http://127.0.0.1:1/steal" };
    const r = await verify(700, "nonprod", "", "nonprod");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /failed \(network error or redirect\)/);
    assert.equal(requests.length, 1);
  });

  it("checks its environment and arguments", async () => {
    runs[100] = { stages: { deploy_nonprod: "succeeded" } };
    assert.match((await verify(100, "nonprod", "", "nonprod", { SYSTEM_ACCESSTOKEN: undefined })).stderr, /SYSTEM_ACCESSTOKEN is not set/);
    assert.match((await verify(100, "nonprod", "", "nonprod", { SYSTEM_COLLECTIONURI: "http://dev.azure.com/contoso/" })).stderr, /must be an https URL/);
    assert.match((await verify(100, "nonprod", "", "nonprod", { SYSTEM_TEAMPROJECTID: "Platform" })).stderr, /project GUID/);
    assert.match((await verify(100, "nonprod", "", "nonprod", { SYSTEM_DEFINITIONID: "x" })).stderr, /definition id/);
    for (const [run, target, from, kind] of [["0", "nonprod", "", "nonprod"], ["abc", "nonprod", "", "nonprod"], ["100", "Prod", "", "prod"], ["100", "prod", "prod", "prod"], ["100", "prod", "nonprod", "staging"]]) {
      assert.equal((await verify(run as string, target as string, from as string, kind as string)).code, 1, `${run} ${target} ${from} ${kind}`);
    }
    assert.equal(requests.length, 0, "no request before the input is valid");
    const usage = await pipeAsync(["verify-source-run", "--run-id", "100", "--target", "nonprod", "--default-branch", "refs/heads/main", "--target-kind", "nonprod", "--output", join(tmp(), "s.json")]);
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /missing --promote-from/);
  });

  it("timeline of sandbox run 2874 (fixture): exact stage and job identifiers", () => {
    const t = parseTimeline(JSON.parse(readFileSync(join(PIPE, "timeline-2874.json"), "utf8")));
    for (const s of ["verify", "deploy_nonprod", "preview_prod", "deploy_prod"]) assert.equal(stageRecord(t, s)?.result, "succeeded", s);
    assert.equal(stageRecord(t, "Deploy to prod"), undefined, "a displayName is not a stage name");
    assert.deepEqual(jobRecords(t, "verify", "scan").map((r) => `${r.type} ${r.identifier}`), ["Phase verify.scan", "Job verify.scan.__default"]);
    assert.equal(jobRecords(t, "verify", "sca").length, 0);
    assert.equal(jobRecords(t, "deploy_prod", "scan").length, 0);
    // Only the exact identifiers count: the display name "Scan and release manifest" does not.
    assert.equal(jobRecords(t.map((r) => ({ ...r, identifier: r.type === "Stage" ? r.identifier : null })), "verify", "scan").length, 0);
  });

  it("a stage record without identifier falls back to its name", () => {
    const t = parseTimeline({ records: [{ id: "a", parentId: null, type: "Stage", name: "deploy_nonprod", result: "succeeded" }] });
    assert.equal(stageRecord(t, "deploy_nonprod")?.result, "succeeded");
  });

  it("verifies against the 2874-shaped timeline end to end", async () => {
    runs[2874] = { stages: { deploy_nonprod: "succeeded", preview_prod: "succeeded", deploy_prod: "succeeded" } };
    const r = await verify(2874, "prod", "nonprod", "prod");
    assert.equal(r.code, 0, r.stderr);
    assert.equal((readJsonFile(r.out) as { path: string }).path, "rollback");
  });
});

describe("pipeline retention-lease", () => {
  function lease(extra: string[] = [], env: Record<string, string | undefined> = {}) {
    return pipeAsync(["retention-lease", "--run-id", "4711", "--env", "prod", "--days", "365", "--slug", "demo", ...extra], env);
  }

  it("creates a lease for the deployed run", async () => {
    const r = await lease();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}retention lease 900 created for run 4711 \(saf-deployed:demo:prod\), valid until 2027-10-29T00:00:00Z\n$/);
    assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["GET build/retention/leases", "POST build/retention/leases"]);
    assert.equal(requests[0]?.query.get("ownerId"), "saf-deployed:demo:prod");
    assert.equal(requests[0]?.query.get("definitionId"), String(DEF));
    assert.equal(requests[0]?.query.get("runId"), "4711");
    assert.deepEqual(requests[1]?.body, [{ daysValid: 365, definitionId: DEF, ownerId: "saf-deployed:demo:prod", protectPipeline: false, runId: 4711 }]);
  });

  it("renews an existing lease of the same owner and run", async () => {
    leases.push({ leaseId: 77, ownerId: "saf-deployed:demo:prod", runId: 4711, definitionId: DEF, validUntil: "2026-11-01T00:00:00Z" });
    bareArrays = true;
    const r = await lease();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /lease 77 renewed .* valid until 2028-01-01T00:00:00Z/);
    assert.deepEqual(requests.map((q) => `${q.method} ${q.path}`), ["GET build/retention/leases", "PATCH build/retention/leases/77"]);
    assert.deepEqual(requests[1]?.body, { daysValid: 365, protectPipeline: false });
  });

  it("accepts a custom owner prefix and validates its input", async () => {
    assert.match((await lease(["--owner-prefix", "saf-test"])).stdout, /\(saf-test:demo:prod\)/);
    for (const extra of [["--owner-prefix", "Bad Prefix"], ["--owner-prefix", "a:b"]]) assert.equal((await lease(extra)).code, 1);
    const bad = await pipeAsync(["retention-lease", "--run-id", "4711", "--env", "prod", "--days", "0", "--slug", "demo"]);
    assert.match(bad.stderr, /--days must be a whole number from 1 to 36500/);
    assert.equal((await pipeAsync(["retention-lease", "--run-id", "4711", "--env", "prod", "--days", "40000", "--slug", "demo"])).code, 1);
    assert.equal((await pipeAsync(["retention-lease", "--run-id", "x", "--env", "prod", "--days", "90", "--slug", "demo"])).code, 1);
    assert.equal((await pipeAsync(["retention-lease", "--run-id", "4711", "--env", "prod", "--days", "90"])).code, 2);
  });

  it("fails with exit 1 when the token may not create leases", async () => {
    forced = { status: 403, body: "denied" };
    const r = await lease();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GET _apis\/build\/retention\/leases returned HTTP 403/);
  });
});
