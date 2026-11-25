import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { CLI, tmp } from "./helpers.js";
import { ARM_TOKEN, APP_OID, CLIENT_ID, FakeAzure, GRAPH_TOKEN, HINT, IMAGE, JOB, JOB_ID, KEY_ID, KVSET_CLIENT_ID, RG, SUB, VALUE, VAULT } from "./azure-fake.js";
import { cmdEasyAuthSecret } from "../src/provisioning/easyauth.js";
import type { EasyAuthOptions, StopSignal } from "../src/provisioning/easyauth.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform provisioning easyauth-secret` (ADR-0035) against a fake ARM + Graph on 127.0.0.1.
// Every run, passing or failing, is checked for the value and both tokens in stdout, stderr and
// the output file; the transcript of all runs is checked once more at the end.

const fake = new FakeAzure();
const transcript: string[] = [];
const NOW = new Date("2026-10-30T12:00:00.000Z");
const END = "2027-04-28T12:00:00Z"; // NOW + 180 days

before(() => fake.start());
after(() => fake.stop());
beforeEach(() => fake.reset());

const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  SAF_ARM_TOKEN: ARM_TOKEN,
  SAF_GRAPH_TOKEN: GRAPH_TOKEN,
  SAF_ARM_ENDPOINT: `${fake.base}/`,
  SAF_GRAPH_ENDPOINT: fake.base,
  ...extra,
});

function args(over: Record<string, string> = {}, output = join(tmp("pc-easyauth-"), "secret.json")): string[] {
  const v = { "client-id": CLIENT_ID, job: JOB_ID, "secret-name": "easyauth-demo", vault: VAULT, "display-name": "saf easyauth dev run 4242", output, ...over };
  return Object.entries(v).flatMap(([k, x]) => [`--${k}`, x]);
}

// In-process runs don't subscribe to the test process's own signals; signal tests inject them.
const FAST: EasyAuthOptions = { now: () => NOW, executionPollMs: 1, executionTimeoutMs: 2_000, operationPollMs: 1, operationMaxDelayMs: 2, operationTimeoutMs: 2_000, graphRetryDelaysMs: [1, 1, 1], onSignal: () => () => undefined };

/** Stands in for SIGINT/SIGTERM: captures the command's handler; `send` calls it like the process would. */
function signals(): { onSignal: NonNullable<EasyAuthOptions["onSignal"]>; send: (s: StopSignal) => void; subscribed: () => number } {
  let handler: ((s: StopSignal) => void) | undefined;
  let subscribed = 0;
  return {
    onSignal: (h) => {
      handler = h;
      subscribed++;
      return () => {
        handler = undefined;
        subscribed--;
      };
    },
    send: (s) => {
      assert.ok(handler, "the command listens for signals while it runs");
      handler(s);
    },
    subscribed: () => subscribed,
  };
}

function assertClean(label: string, ...texts: string[]): void {
  for (const t of texts) {
    transcript.push(t);
    assert.ok(!t.includes(VALUE), `${label}: the secret value was printed or written`);
    assert.ok(!t.includes(ARM_TOKEN) && !t.includes(GRAPH_TOKEN), `${label}: a token was printed or written`);
    assert.ok(!t.includes(HINT), `${label}: a password hint (its first characters) was printed or written`);
  }
}

async function run(a: string[] = args(), e = env(), o: EasyAuthOptions = {}): Promise<{ code: number; stdout: string; stderr: string; output: J | undefined }> {
  let stdout = "";
  let stderr = "";
  const code = await cmdEasyAuthSecret(a, e, { ...FAST, ...o, out: (s) => (stdout += s), err: (s) => (stderr += s) });
  const file = a[a.indexOf("--output") + 1]!;
  const text = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  assertClean(`run ${code}`, stdout, stderr, text ?? "");
  return { code, stdout, stderr, output: text === undefined ? undefined : (JSON.parse(text) as J) };
}

function cli(a: string[], e: Record<string, string | undefined>, spawned?: (p: ChildProcess) => void): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const merged: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("SAF_"))) as Record<string, string>;
  for (const [k, v] of Object.entries({ NO_COLOR: "1", ...e })) if (v !== undefined) merged[k] = v;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "provisioning", "easyauth-secret", ...a], { env: merged });
    spawned?.(p);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const reqs = (method: string, sub: string): J[] => fake.requests.filter((r) => r.method === method && r.path.includes(sub));
const removed = (): number => reqs("POST", "/removePassword").length;

describe("platform provisioning easyauth-secret", () => {
  it("happy path: password, job secret, start with a secretRef, wait, remove the job secret", async () => {
    const out = join(tmp("pc-easyauth-"), "secret.json");
    const r = await run(args({}, out));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const execution = String(r.output?.execution);
    assert.match(execution, new RegExp(`^${JOB}-x\\d+$`));
    assert.deepEqual(r.output, { secretName: "easyauth-demo", vault: VAULT, execution, keyId: KEY_ID, endDateTime: END, mode: "new", written: true });
    assert.match(r.stdout, new RegExp(`^OK  easyauth-demo written to ${VAULT} by execution ${execution} \\(keyId ${KEY_ID}, expires ${END}\\)$`, "m"));
    assert.match(r.stdout, /^execution {2}\S+: Running$/m);

    // The order of calls and who got which token.
    const seq = fake.requests.map((q) => `${q.method} ${q.path.replace(JOB_ID, "<job>").replace(/op-\d+/, "op")}`);
    assert.deepEqual(seq, [
      "GET <job>",
      `GET /v1.0/applications(appId='${CLIENT_ID}')`,
      `POST /v1.0/applications/${APP_OID}/addPassword`,
      "PATCH <job>",
      `GET /subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/op`,
      `GET /subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/op`,
      "POST <job>/start",
      `GET <job>/executions/${execution}`,
      `GET <job>/executions/${execution}`,
      "PATCH <job>",
      `GET /subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/op`,
      `GET /subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/op`,
      "GET <job>",
    ]);
    for (const q of fake.requests) {
      if (q.path.startsWith("/v1.0/")) assert.equal(q.auth, `Bearer ${GRAPH_TOKEN}`);
      else {
        assert.equal(q.auth, `Bearer ${ARM_TOKEN}`);
        assert.equal(q.query.get("api-version"), "2024-03-01");
      }
    }
    assert.equal(fake.requests[1]!.query.get("$select"), "id");

    // The credential: 180 days, the given display name.
    assert.deepEqual(reqs("POST", "/addPassword")[0]!.body, { passwordCredential: { displayName: "saf easyauth dev run 4242", endDateTime: END } });
    // The value travels only in the first PATCH; the second one empties the list.
    const [set, clear] = reqs("PATCH", JOB_ID);
    assert.deepEqual(set!.body, { properties: { configuration: { secrets: [{ name: "saf-kvset-demo", value: VALUE }] } } });
    assert.deepEqual(clear!.body, { properties: { configuration: { secrets: [] } } });
    // The start carries the job's container with a secretRef, never the value.
    const start = reqs("POST", "/start")[0]!;
    assert.ok(!start.raw.includes(VALUE));
    assert.deepEqual(start.body, {
      containers: [
        {
          name: "kvset",
          image: IMAGE,
          args: ["kvset"],
          resources: { cpu: 0.25, memory: "0.5Gi" },
          env: [
            { name: "SAF_VAULT_URI", value: `https://${VAULT}.vault.azure.net/` },
            { name: "SAF_VAULT_AUDIENCE", value: "https://vault.azure.net" },
            { name: "AZURE_CLIENT_ID", value: KVSET_CLIENT_ID },
            { name: "SAF_SECRET_NAME", value: "easyauth-demo" },
            { name: "SAF_SECRET_VALUE", secretRef: "saf-kvset-demo" },
            { name: "SAF_SECRET_EXPIRES", value: END },
          ],
        },
      ],
    });
    // The job resolved the reference while the secret was there; afterwards it is gone.
    assert.deepEqual(fake.vaultWrites, [{ name: "easyauth-demo", value: VALUE }]);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 0);
    assert.ok(fake.passwords.has(KEY_ID));
  });

  it("the real CLI process: same result, nothing secret on stdout, stderr or in the output file", async () => {
    // No sleeps: every first poll already sees the final state.
    fake.operationStatuses = ["Succeeded"];
    fake.executionStatuses = ["Succeeded"];
    const out = join(tmp("pc-easyauth-"), "secret.json");
    const r = await cli(args({}, out), env());
    assert.equal(r.code, 0, r.stderr);
    const text = readFileSync(out, "utf8");
    assertClean("cli happy", r.stdout, r.stderr, text);
    assert.equal((JSON.parse(text) as J).keyId, KEY_ID);
    assert.match(r.stdout, /^OK {2}easyauth-demo written to /m);
    assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    assert.deepEqual(fake.jobSecrets, []);
  });

  it("the real CLI process, failing execution: exit 1, job secret removed, password kept, nothing secret printed", async () => {
    fake.operationStatuses = ["Succeeded"];
    fake.executionStatuses = ["Failed"];
    const out = join(tmp("pc-easyauth-"), "secret.json");
    const r = await cli(args({}, out), env());
    assert.equal(r.code, 1);
    assertClean("cli failed", r.stdout, r.stderr);
    assert.ok(!existsSync(out));
    assert.match(r.stderr, /^platform provisioning easyauth-secret: execution \S+ ended Failed\. See the job's console logs/m);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(fake.passwords.size, 1, "the started job may have written it: the password stays");
  });

  it("the real CLI process stopped by SIGTERM while the execution runs: cleanup, exit 1, nothing secret printed", async () => {
    fake.operationStatuses = ["Succeeded"];
    fake.executionStatuses = ["Running"];
    let child: ChildProcess | undefined;
    let killed = false;
    fake.onRequest = (q) => {
      if (q.path.includes("/executions/") && child && !killed) {
        killed = true;
        child.kill("SIGTERM");
      }
    };
    const out = join(tmp("pc-easyauth-"), "secret.json");
    const r = await cli(args({}, out), env(), (p) => (child = p));
    assert.ok(killed);
    assert.equal(r.code, 1, "the handler ran: a process killed by the signal has no exit code");
    assertClean("cli stopped", r.stdout, r.stderr);
    assert.ok(!existsSync(out));
    assert.match(r.stdout, /^warn {7}SIGTERM: stopping, then removing the job secret \(at most 60 s\)$/m);
    assert.match(r.stdout, /^job secret saf-kvset-demo removed from caj-contoso-kvset-ext$/m);
    assert.match(r.stderr, /^platform provisioning easyauth-secret: stopped by SIGTERM \(the run was cancelled or timed out\)/m);
    assert.deepEqual(reqs("PATCH", JOB_ID).map((q) => q.body.properties.configuration.secrets.length), [1, 0]);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(fake.passwords.size, 1);
  });

  it("a job that writes another vault: exit 1 before any write (one GET only)", async () => {
    const r = await run(args({ vault: "kvcontosodevn9z8y7" }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /the job does not write vault kvcontosodevn9z8y7: its SAF_VAULT_URI must be https:\/\/kvcontosodevn9z8y7\.<Key Vault DNS suffix>\/\./);
    assert.deepEqual(fake.requests.map((q) => q.method), ["GET"]);
    assert.equal(r.output, undefined);
  });

  const shapes: [string, (j: J) => void, RegExp][] = [
    ["a schedule trigger", (j) => (j.properties.configuration.triggerType = "Schedule"), /must have a manual trigger/],
    ["two containers", (j) => j.properties.template.containers.push({ ...j.properties.template.containers[0], name: "x" }), /exactly one container/],
    ["an init container", (j) => (j.properties.template.initContainers = [{ name: "i", image: IMAGE }]), /no init containers/],
    ["an image by tag", (j) => (j.properties.template.containers[0].image = "crcontosodev.azurecr.io/saf-jobs:latest"), /saf-jobs image pinned by digest/],
    ["another image", (j) => (j.properties.template.containers[0].image = `crcontosodev.azurecr.io/other@sha256:${"cd".repeat(32)}`), /saf-jobs image pinned by digest/],
    ["a command", (j) => (j.properties.template.containers[0].command = ["/bin/sh"]), /must not override the image's command/],
    ["other args", (j) => (j.properties.template.containers[0].args = ["dbinit"]), /exactly the argument kvset/],
    ["a vault over http", (j) => (j.properties.template.containers[0].env[0].value = `http://${VAULT}.vault.azure.net/`), /does not write vault/],
    ["a vault on another domain", (j) => (j.properties.template.containers[0].env[0].value = `https://${VAULT}.vault.example.com/`), /does not write vault/],
    ["no vault", (j) => j.properties.template.containers[0].env.shift(), /has no SAF_VAULT_URI value/],
    ["its own SAF_SECRET_VALUE", (j) => j.properties.template.containers[0].env.push({ name: "SAF_SECRET_VALUE", value: "x" }), /must not set SAF_SECRET_VALUE itself/],
  ];
  for (const [label, change, re] of shapes) {
    it(`a job with ${label}: exit 1 before any write`, async () => {
      change(fake.job);
      const r = await run();
      assert.equal(r.code, 1);
      assert.match(r.stderr, re);
      assert.deepEqual(fake.writes(), []);
      assert.equal(reqs("GET", "/v1.0/").length, 0);
    });
  }

  it("job secrets left by an earlier run: a warning, then replaced and removed", async () => {
    fake.jobSecrets = [{ name: "saf-kvset-other", value: "old" }];
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^warn {7}caj-contoso-kvset-ext holds secret\(s\) saf-kvset-other from an earlier run/m);
    assert.deepEqual(fake.jobSecrets, []);
  });

  it("execution fails: exit 1, job secret removed, the password stays (the job may have written it), no output", async () => {
    fake.executionStatuses = ["Running", "Failed"];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /execution caj-contoso-kvset-ext-x\d+ ended Failed\. See the job's console logs \(ContainerAppConsoleLogs_CL, job caj-contoso-kvset-ext\)\./);
    assert.match(
      r.stderr,
      new RegExp(
        `execution caj-contoso-kvset-ext-x\\d+ was started, so easyauth-demo in vault ${VAULT} may hold the new password: it stays on app ${CLIENT_ID} \\(keyId ${KEY_ID}, expires ${END}\\)\\. If the job's console logs \\(ContainerAppConsoleLogs_CL, job caj-contoso-kvset-ext\\) show no write, remove it by hand: az ad app credential delete --id ${CLIENT_ID} --key-id ${KEY_ID}\\.$`,
        "m",
      ),
    );
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 0);
    assert.ok(fake.passwords.has(KEY_ID));
    assert.deepEqual(fake.vaultWrites, []);
    assert.equal(r.output, undefined);
  });

  for (const status of ["Stopped", "Degraded"]) {
    it(`execution ${status}: a failure too, the password stays`, async () => {
      fake.executionStatuses = [status];
      const r = await run();
      assert.equal(r.code, 1);
      assert.match(r.stderr, new RegExp(`ended ${status}`));
      assert.equal(removed(), 0);
    });
  }

  it("execution timeout (the replica may still run): exit 1, cleanup, the password stays", async () => {
    fake.executionStatuses = ["Running"];
    const r = await run(args(), env(), { executionTimeoutMs: 30, executionPollMs: 5 });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /did not finish within 0 s \(last status Running\)/);
    assert.match(r.stderr, /was started, so easyauth-demo in vault \S+ may hold the new password: it stays on app/);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 0);
  });

  it("a start answered without an execution name: the job may run, the password stays", async () => {
    fake.failures = [{ method: "POST", path: "/start", status: 202, body: {} }];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST job caj-contoso-kvset-ext\/start returned no execution name\./);
    assert.match(r.stderr, /execution \(no name\) was started, so easyauth-demo in vault \S+ may hold the new password: it stays on app/);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 0);
  });

  it("a start answered 5xx: the job may have started, the password stays", async () => {
    fake.failures = [{ method: "POST", path: "/start", status: 503 }];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST job caj-contoso-kvset-ext\/start returned HTTP 503\./);
    assert.match(r.stderr, /the start of the job may have been accepted, so easyauth-demo in vault \S+ may hold the new password: it stays on app/);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 0);
  });

  it("an execution that is not visible at once is waited for", async () => {
    fake.executionVisibleAfter = 2;
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(reqs("GET", "/executions/").length, 4);
  });

  it("setting the job secret fails: no ARM message quoted (the request carried the value), cleanup and removal", async () => {
    fake.failures = [{ method: "PATCH", path: JOB_ID, status: 400, times: 1 }];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\) returned HTTP 400\. InjectedFailure$/m);
    assert.ok(!r.stderr.includes("injected failure"), "the error message of a PATCH with the value is not quoted");
    assert.equal(reqs("PATCH", JOB_ID).length, 2, "the cleanup PATCH runs anyway");
    assert.equal(reqs("POST", "/start").length, 0);
    assert.equal(removed(), 1);
  });

  it("start refused: hint, cleanup, password removed; a quoted ARM message is redacted", async () => {
    fake.failures = [{ method: "POST", path: "/start", status: 403 }];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST job caj-contoso-kvset-ext\/start returned HTTP 403 \(the identity needs the role Platform Job Secret Writer on this job, ADR-0035\)\. InjectedFailure: "injected failure, echoing \[redacted\] and Bearer \[redacted\]"/);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 1);
  });

  it("the async operation fails: cleanup, removal", async () => {
    fake.operationStatuses = ["InProgress", "Failed"];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\): the operation ended Failed \(JobUpdateFailed\)\./);
    assert.equal(removed(), 1);
  });

  it("an operation URL on another host is not followed (the token stays with ARM)", async () => {
    fake.operationUrlOverride = `http://127.0.0.2:9/subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/x?api-version=2024-03-01`;
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /operation URL outside the job's subscription or the ARM endpoint; not followed/);
    assert.equal(reqs("POST", "/start").length, 0);
    assert.deepEqual(fake.jobSecrets, [], "the cleanup PATCH still ran");
    assert.equal(removed(), 1);
  });

  it("an operation URL in another subscription is not followed", async () => {
    fake.operationUrlOverride = `${fake.base}/subscriptions/00000000-0000-0000-0000-0000000000ff/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/x?api-version=2024-03-01`;
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not followed/);
    assert.equal(fake.requests.filter((q) => q.path.includes("0000000000ff")).length, 0);
  });

  it("PATCH completing through 202 + Location, or at once", async () => {
    fake.patchMode = "location";
    assert.equal((await run()).code, 0);
    assert.ok(reqs("GET", "/containerappsjobOperationResults/").length >= 2);
    fake.reset();
    fake.patchMode = "sync";
    assert.equal((await run()).code, 0);
    assert.equal(reqs("GET", "/containerappsjobOperation").length, 0);
  });

  it("operation status not readable (403): the job's provisioningState is followed instead", async () => {
    fake.operationDenied = 403;
    fake.jobStatesAfterPatch = ["InProgress", "Succeeded"];
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^wait {7}PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\): operation status not readable \(HTTP 403\); following the job's provisioningState$/m);
    assert.match(r.stdout, /^wait {7}PATCH job caj-contoso-kvset-ext \(remove secret saf-kvset-demo\): operation status not readable \(HTTP 403\)/m);
    const execution = String(r.output?.execution);
    const op = `GET /subscriptions/${SUB}/providers/Microsoft.App/locations/westeurope/containerappsjobOperationStatuses/op`;
    assert.deepEqual(
      fake.requests.map((q) => `${q.method} ${q.path.replace(JOB_ID, "<job>").replace(/op-\d+/, "op")}`),
      [
        "GET <job>",
        `GET /v1.0/applications(appId='${CLIENT_ID}')`,
        `POST /v1.0/applications/${APP_OID}/addPassword`,
        "PATCH <job>",
        op,
        "GET <job>",
        "GET <job>",
        "POST <job>/start",
        `GET <job>/executions/${execution}`,
        `GET <job>/executions/${execution}`,
        "PATCH <job>",
        op,
        "GET <job>",
        "GET <job>",
        "GET <job>",
      ],
    );
    assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    assert.deepEqual(fake.jobSecrets, []);
  });

  it("operation status not readable (401), the job's provisioningState ends Failed: failure, cleanup, removal", async () => {
    fake.operationDenied = 401;
    fake.jobStatesAfterPatch = ["InProgress", "Failed"];
    fake.onRequest = (q) => {
      if (q.method === "PATCH" && q.body?.properties?.configuration?.secrets?.length === 0) fake.jobStatesAfterPatch = ["Succeeded"];
    };
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\): the operation ended Failed\.$/m);
    assert.equal(reqs("POST", "/start").length, 0);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 1, "the job never started: the password goes");
  });

  it("the fallback keeps the operation's timeout; a Location URL answering 403 falls back too", async () => {
    fake.operationDenied = 403;
    fake.jobStatesAfterPatch = ["InProgress"];
    const stuck = await run(args(), env(), { operationTimeoutMs: 30, operationPollMs: 5, operationMaxDelayMs: 5 });
    assert.equal(stuck.code, 1);
    assert.match(stuck.stderr, /PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\): the operation did not finish within 0 s\./);
    assert.equal(reqs("POST", "/start").length, 0);
    fake.reset();
    fake.patchMode = "location";
    fake.operationDenied = 403;
    fake.jobStatesAfterPatch = ["InProgress", "Succeeded"];
    const ok = await run();
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /operation status not readable \(HTTP 403\); following the job's provisioningState/);
    assert.ok(reqs("GET", "/containerappsjobOperationResults/").length >= 2);
  });

  it("SIGTERM while the execution runs: the wait stops, the job secret is removed, the password stays, exit 1", async () => {
    const sig = signals();
    fake.executionStatuses = ["Running"];
    let sent = false;
    fake.onRequest = (q) => {
      if (q.path.includes("/executions/") && !sent) {
        sent = true;
        sig.send("SIGTERM");
      }
    };
    const r = await run(args(), env(), { onSignal: sig.onSignal, executionTimeoutMs: 60_000 });
    assert.ok(sent);
    assert.equal(r.code, 1);
    assert.equal(sig.subscribed(), 0, "unsubscribed after the run");
    assert.match(r.stdout, /^warn {7}SIGTERM: stopping, then removing the job secret \(at most 60 s\)$/m);
    assert.match(r.stderr, /^platform provisioning easyauth-secret: stopped by SIGTERM \(the run was cancelled or timed out\); the cleanup's outcome follows\.$/m);
    assert.match(r.stderr, /GET execution caj-contoso-kvset-ext-x\d+: stopped \(SIGTERM received\)\./);
    assert.match(r.stderr, /was started, so easyauth-demo in vault \S+ may hold the new password: it stays on app/);
    const [set, clear] = reqs("PATCH", JOB_ID);
    assert.equal(set!.body.properties.configuration.secrets.length, 1);
    assert.deepEqual(clear!.body, { properties: { configuration: { secrets: [] } } });
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(reqs("GET", "/executions/").length, 1, "no polling after the signal");
    assert.equal(removed(), 0);
    assert.equal(r.output, undefined);
  });

  it("SIGINT before the start, SIGTERM during the cleanup: the cleanup still completes, the password goes", async () => {
    const sig = signals();
    let first = true;
    fake.onRequest = (q) => {
      if (q.path.includes("/containerappsjobOperationStatuses/") && first) {
        first = false;
        sig.send("SIGINT");
      } else if (q.method === "PATCH" && q.body?.properties?.configuration?.secrets?.length === 0) {
        sig.send("SIGTERM");
      }
    };
    const r = await run(args(), env(), { onSignal: sig.onSignal });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^warn {7}SIGINT: stopping/m);
    assert.match(r.stdout, /^warn {7}SIGTERM again: the cleanup goes on, at most 60 s after SIGINT$/m);
    assert.match(r.stderr, /stopped by SIGINT/);
    assert.match(r.stderr, /PATCH job caj-contoso-kvset-ext \(set secret saf-kvset-demo\) \(operation status\): stopped \(SIGINT received\)\./);
    assert.match(r.stdout, /^job secret saf-kvset-demo removed from caj-contoso-kvset-ext$/m);
    assert.equal(reqs("POST", "/start").length, 0);
    assert.deepEqual(fake.jobSecrets, []);
    assert.equal(removed(), 1, "the job never started: the password goes");
    assert.equal(fake.passwords.size, 0);
  });

  it("a signal and a cleanup that hangs: the bound ends it, exit 1 with the manual fix", async () => {
    const sig = signals();
    fake.executionStatuses = ["Running"];
    let sent = false;
    fake.onRequest = (q) => {
      if (q.path.includes("/executions/") && !sent) {
        sent = true;
        fake.operationStatuses = ["InProgress"]; // the removal's operation never ends
        sig.send("SIGTERM");
      }
    };
    const t0 = Date.now();
    const r = await run(args(), env(), { onSignal: sig.onSignal, cleanupBoundMs: 100, operationPollMs: 5, operationMaxDelayMs: 5, operationTimeoutMs: 60_000, executionTimeoutMs: 60_000 });
    assert.equal(r.code, 1);
    assert.ok(Date.now() - t0 < 5_000, "bounded");
    assert.match(
      r.stderr,
      /could not remove the job secret saf-kvset-demo from caj-contoso-kvset-ext: PATCH job caj-contoso-kvset-ext \(remove secret saf-kvset-demo\)( \(operation status\))?: stopped \(the cleanup did not finish within 1 s of SIGTERM\)\. Remove it by hand: az containerapp job secret remove/,
    );
    assert.equal(removed(), 0);
  });

  it("job secret removal fails after the vault write: exit 1, the password stays, the fix is named, the output says written", async () => {
    fake.removalPatchStatus = 409;
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not remove the job secret saf-kvset-demo from caj-contoso-kvset-ext: PATCH job caj-contoso-kvset-ext \(remove secret saf-kvset-demo\) returned HTTP 409\. InjectedFailure Remove it by hand: az containerapp job secret remove --name caj-contoso-kvset-ext --resource-group rg-contoso-platform-dev --secret-names saf-kvset-demo\./);
    assert.equal(removed(), 0, "the vault holds the value: the password must stay");
    assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    // The vault holds a new version: the pipeline must know (a rotation restarts the app on it).
    assert.equal(r.output?.written, true);
    assert.equal(r.output?.keyId, KEY_ID);
    assert.doesNotMatch(r.stdout, /^OK /m);
  });

  it("a removal PATCH that leaves the secret on the job is caught", async () => {
    fake.ignoreSecretRemoval = true;
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /could not remove the job secret saf-kvset-demo .*the job still lists saf-kvset-demo after the removal/);
    assert.equal(removed(), 0);
  });

  it("Graph: a registration not visible yet is retried; one that never appears fails before any write", async () => {
    fake.appNotFoundTimes = 2;
    const ok = await run();
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /^wait {7}GET application \S+: not found yet, retrying in 0 s$/m);
    fake.reset();
    fake.appNotFoundTimes = 99;
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /GET application 00000000-0000-0000-0000-0000000000c1 returned HTTP 404 \(no such app registration, or not replicated yet\)\./);
    assert.equal(reqs("GET", "/v1.0/applications(").length, 4);
    assert.deepEqual(fake.writes(), []);
  });

  it("Graph refuses addPassword: exit 1, nothing written on ARM, nothing to remove", async () => {
    fake.failures = [{ method: "POST", path: "/addPassword", status: 403, body: { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } } }];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST addPassword returned HTTP 403 \(the Entra provisioning identity must own the app registration, ADR-0023\)\. Authorization_RequestDenied: "Insufficient privileges to complete the operation\."/);
    assert.deepEqual(fake.writes(), [`POST /v1.0/applications/${APP_OID}/addPassword`]);
  });

  it("removePassword fails after a refused start: both problems, with the manual fix", async () => {
    fake.failures = [
      { method: "POST", path: "/start", status: 409 },
      { method: "POST", path: "/removePassword", status: 500 },
    ];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST job caj-contoso-kvset-ext\/start returned HTTP 409\./);
    assert.match(r.stderr, /could not remove the new password 00000000-0000-0000-0000-0000000000c3 from app 00000000-0000-0000-0000-0000000000c1: POST removePassword returned HTTP 500\. InjectedFailure: "injected failure, echoing \[redacted\] and Bearer \[redacted\]" Remove it by hand: az ad app credential delete --id 00000000-0000-0000-0000-0000000000c1 --key-id 00000000-0000-0000-0000-0000000000c3\./);
  });

  it("invalid flags: exit 1, one line per problem, no request", async () => {
    const r = await run(args({ "client-id": "demo", job: `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Web/sites/x`, "secret-name": "demo", vault: "KV_bad", "display-name": " padded " }));
    assert.equal(r.code, 1);
    for (const re of [/--client-id must be/, /--job must be the ARM ID of a Container Apps job/, /--secret-name must be easyauth-<slug>/, /--vault must be a Key Vault name/, /--display-name must be/]) assert.match(r.stderr, re);
    assert.equal(fake.requests.length, 0);
    const noDir = await run(args({}, join(tmp(), "missing", "secret.json")));
    assert.equal(noDir.code, 1);
    assert.match(noDir.stderr, /--output must be a file in an existing directory/);
  });

  it("tokens and endpoints: required, environment only; https or loopback http only", async () => {
    const none = await run(args(), env({ SAF_ARM_TOKEN: undefined, SAF_GRAPH_TOKEN: "" }));
    assert.equal(none.code, 1);
    assert.match(none.stderr, /SAF_ARM_TOKEN is not set \(an access token, passed in the environment only\)\./);
    assert.match(none.stderr, /SAF_GRAPH_TOKEN is not set/);
    const spaced = await run(args(), env({ SAF_ARM_TOKEN: "Bearer abc" }));
    assert.match(spaced.stderr, /SAF_ARM_TOKEN is not a valid access token/);
    const http = await run(args(), env({ SAF_ARM_ENDPOINT: "http://management.example.com/" }));
    assert.match(http.stderr, /SAF_ARM_ENDPOINT must be an https origin such as https:\/\/management\.azure\.com\//);
    const path = await run(args(), env({ SAF_GRAPH_ENDPOINT: "https://graph.microsoft.com/v1.0/" }));
    assert.match(path.stderr, /SAF_GRAPH_ENDPOINT must be an https origin such as https:\/\/graph\.microsoft\.com\//);
    assert.equal(fake.requests.length, 0);
  });

  it("usage errors: exit 2", async () => {
    const missing = await run(["--job", JOB_ID, "--output", join(tmp(), "x.json")]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing --client-id, --secret-name, --vault, --display-name\. Run "platform provisioning help" for usage\./);
    assert.equal((await run([...args(), "extra"])).code, 2);
    assert.equal((await run([...args(), "--secret-value", "x"])).code, 2);
    const viaCli = await cli([], env());
    assert.equal(viaCli.code, 2);
  });

  // --mode rotate (ADR-0041). The vault holds CURRENT's value (its version created a minute after
  // CURRENT, exp = CURRENT's end) and the app runs with it (--loaded-created = that version's
  // created); OLD is the previous rotation, STRAY a newer password (a failed run left it, or an
  // overlapping run already wrote it: the signals are read before the approval), MANUAL somebody else's.
  const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);
  const CURRENT = { keyId: "00000000-0000-0000-0000-0000000000d1", name: "easyauth-dev-run-100", start: "2026-08-01T10:00:00Z", end: "2027-01-28T10:00:00Z" };
  const OLD = { keyId: "00000000-0000-0000-0000-0000000000d2", name: "easyauth-dev-run-50", start: "2026-05-30T09:00:00Z", end: "2026-11-26T09:00:00Z" };
  const STRAY = { keyId: "00000000-0000-0000-0000-0000000000d3", name: "easyauth-dev", start: "2026-09-15T08:00:00Z", end: "2027-03-14T08:00:00Z" };
  const MANUAL = { keyId: "00000000-0000-0000-0000-0000000000d4", name: "created by hand for testing", start: "2026-01-01T00:00:00Z", end: "2027-01-01T00:00:00Z" };
  const seed = (...creds: { keyId: string; name: string; start: string; end: string }[]): void => {
    for (const c of creds) fake.seedPassword(c.keyId, c.name, c.start, c.end);
  };
  const CURRENT_CREATED = String(epoch("2026-08-01T10:01:30Z"));
  /** --loaded-created follows --current-created unless given: the app runs with the vault's version. */
  const rotateArgs = (over: Record<string, string> = {}): string[] =>
    args({
      mode: "rotate",
      "display-name": "easyauth-dev-run-4242",
      "current-created": CURRENT_CREATED,
      "current-expires": String(epoch(CURRENT.end)),
      "loaded-created": over["current-created"] ?? CURRENT_CREATED,
      ...over,
    });

  it("rotate: keeps the current password, newer ones and other names, removes the older platform passwords first, then writes a new version", async () => {
    seed(OLD, CURRENT, STRAY, MANUAL);
    const r = await run(rotateArgs());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    assert.deepEqual(r.output, {
      secretName: "easyauth-demo",
      vault: VAULT,
      execution: r.output?.execution,
      keyId: KEY_ID,
      endDateTime: END,
      mode: "rotate",
      written: true,
      currentKeyId: CURRENT.keyId,
      removedKeyIds: [OLD.keyId],
    });
    assert.equal(reqs("GET", "/v1.0/applications(")[0]!.query.get("$select"), "id,passwordCredentials");
    // The older passwords go before the new one is added.
    assert.deepEqual(fake.writes().map((w) => w.replace(JOB_ID, "<job>")), [
      `POST /v1.0/applications/${APP_OID}/removePassword`,
      `POST /v1.0/applications/${APP_OID}/addPassword`,
      "PATCH <job>",
      "POST <job>/start",
      "PATCH <job>",
    ]);
    assert.deepEqual(reqs("POST", "/removePassword").map((q) => q.body), [{ keyId: OLD.keyId }]);
    // STRAY is newer than the current password: it may be the vault's version already, so it stays.
    assert.deepEqual([...fake.passwords.keys()].sort(), [CURRENT.keyId, STRAY.keyId, KEY_ID, MANUAL.keyId].sort());
    assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    assert.match(r.stdout, new RegExp(`^password   current ${CURRENT.keyId} \\(easyauth-dev-run-100\\) stays until a later rotation$`, "m"));
    assert.match(r.stdout, new RegExp(`^password   ${STRAY.keyId} \\(easyauth-dev\\) is not older than the current one; kept until a later rotation$`, "m"));
    assert.match(r.stdout, new RegExp(`^warn       password ${MANUAL.keyId} on app ${CLIENT_ID} is not named by the platform; kept`, "m"));
    assert.doesNotMatch(r.stdout, /created by hand/, "another name is never printed");
    assert.match(r.stdout, /^OK {2}easyauth-demo rotated in \S+ by execution \S+ \(keyId \S+, expires \S+; 1 predecessor\(s\) removed\)$/m);
  });

  it("rotate: a re-run with a stale plan never removes the password the vault holds now", async () => {
    // The first attempt of this entra stage wrote P1 (vault version created right after it) and
    // then failed; the re-run reuses entra_plan's artifact, whose signals still name P0.
    const P0 = CURRENT;
    const P1 = { keyId: "00000000-0000-0000-0000-0000000000d5", name: "easyauth-dev-run-4241", start: "2026-10-30T11:00:00Z", end: "2027-04-28T11:00:00Z" };
    seed(OLD, P0, P1);
    const r = await run(rotateArgs());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.output?.currentKeyId, P0.keyId, "the stale signals still name P0");
    assert.deepEqual(r.output?.removedKeyIds, [OLD.keyId], "only what is older than P0 goes");
    assert.ok(fake.passwords.has(P1.keyId), "P1, which the vault (and the restarted app) hold, stays");
    assert.ok(fake.passwords.has(P0.keyId));
    // Three platform passwords remain until the next rotation: P0, P1 and the new one.
    assert.deepEqual([...fake.passwords.keys()].sort(), [P0.keyId, P1.keyId, KEY_ID].sort());
  });

  it("rotate: nothing is removed unless the app is known to run with the vault's current version", async () => {
    for (const loaded of ["none", String(epoch("2026-05-30T09:01:00Z"))]) {
      fake.reset();
      seed(OLD, CURRENT);
      const r = await run(rotateArgs({ "loaded-created": loaded }));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^warn {7}the app is not known to run with the vault's current version of easyauth-demo \(it runs with: (unknown|created \d+); current: created \d+\); no password removed until a run has restarted it$/m);
      assert.equal(removed(), 0);
      assert.deepEqual({ current: r.output?.currentKeyId, removed: r.output?.removedKeyIds }, { current: CURRENT.keyId, removed: [] });
      assert.equal(reqs("POST", "/addPassword").length, 1, "the rotation still writes a new version");
      assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    }
  });

  it("rotate: an expired current password is still the one the vault holds; it stays", async () => {
    const expired = { ...CURRENT, start: "2026-04-01T10:00:00Z", end: "2026-09-28T10:00:00Z" };
    const older = { ...OLD, start: "2026-01-01T09:00:00Z", end: "2026-06-30T09:00:00Z" };
    seed(older, expired);
    const r = await run(rotateArgs({ "current-created": String(epoch("2026-04-01T10:02:00Z")), "current-expires": String(epoch(expired.end)) }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.output?.currentKeyId, expired.keyId);
    assert.deepEqual(r.output?.removedKeyIds, [older.keyId]);
  });

  it("rotate: when the vault's version doesn't name exactly one current password, nothing is removed", async () => {
    // No expiry recorded (a secret written by hand).
    seed(OLD, CURRENT);
    const hand = await run(rotateArgs({ "current-expires": "none" }));
    assert.equal(hand.code, 0, hand.stderr);
    assert.match(hand.stdout, /^warn {7}cannot tell which password easyauth-demo holds: the vault's version records no creation or expiry time \(written by hand\?\); no password removed/m);
    assert.deepEqual({ current: hand.output?.currentKeyId, removed: hand.output?.removedKeyIds }, { current: null, removed: [] });
    assert.equal(removed(), 0);
    assert.equal(reqs("POST", "/addPassword").length, 1, "the rotation still writes a new version");

    // Two platform passwords with the vault version's expiry.
    fake.reset();
    seed(OLD, CURRENT, { ...STRAY, end: CURRENT.end });
    const twins = await run(rotateArgs());
    assert.equal(twins.code, 0, twins.stderr);
    assert.match(twins.stdout, /2 platform-named passwords expire when the vault's version does; no password removed/);
    assert.equal(removed(), 0);

    // The signals disagree: the vault version is older than the password with its expiry.
    fake.reset();
    seed(OLD, CURRENT);
    const disagree = await run(rotateArgs({ "current-created": String(epoch("2026-07-01T00:00:00Z")) }));
    assert.equal(disagree.code, 0, disagree.stderr);
    assert.match(disagree.stdout, /is not the newest one created before it; no password removed/);
    assert.equal(removed(), 0);
  });

  it("rotate: a predecessor that can't be removed doesn't stop the rotation; exit 1 at the end, the output says written", async () => {
    const OLDER = { ...OLD, keyId: "00000000-0000-0000-0000-0000000000d6", name: "easyauth-dev-run-20", start: "2026-03-01T09:00:00Z", end: "2026-08-28T09:00:00Z" };
    seed(OLDER, OLD, CURRENT, STRAY);
    fake.failures = [{ method: "POST", path: "/removePassword", status: 500, times: 1 }];
    const r = await run(rotateArgs());
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`could not remove the predecessor password ${OLDER.keyId} from app ${CLIENT_ID}: POST removePassword returned HTTP 500\\. InjectedFailure: "injected failure, echoing \\[redacted\\] and Bearer \\[redacted\\]" Remove it by hand: az ad app credential delete --id ${CLIENT_ID} --key-id ${OLDER.keyId}\\.`));
    assert.equal(r.output?.written, true);
    assert.deepEqual(r.output?.removedKeyIds, [OLD.keyId]);
    assert.ok(fake.passwords.has(STRAY.keyId));
    assert.deepEqual(fake.vaultWrites.map((w) => w.name), ["easyauth-demo"]);
    assert.ok(fake.passwords.has(CURRENT.keyId) && fake.passwords.has(KEY_ID));
  });

  it("rotate: a write that never started removes only the new password; the current one stays", async () => {
    seed(OLD, CURRENT);
    fake.failures = [{ method: "POST", path: "/start", status: 409 }];
    const r = await run(rotateArgs());
    assert.equal(r.code, 1);
    assert.equal(r.output, undefined);
    assert.deepEqual(reqs("POST", "/removePassword").map((q) => q.body), [{ keyId: OLD.keyId }, { keyId: KEY_ID }]);
    assert.deepEqual([...fake.passwords.keys()], [CURRENT.keyId]);
  });

  it("rotate and new: flags are checked before any request", async () => {
    const badName = await run(rotateArgs({ "display-name": "saf easyauth dev run 4242" }));
    assert.equal(badName.code, 1);
    assert.match(badName.stderr, /--mode rotate needs --display-name easyauth-<environment>\[-run-<id>\]/);
    for (const flag of ["current-created", "loaded-created"]) {
      const newWithCurrent = await run(args({ [flag]: "1790000000" }));
      assert.equal(newWithCurrent.code, 1);
      assert.match(newWithCurrent.stderr, /--current-created, --current-expires and --loaded-created must be none for --mode new/);
    }
    const badEpoch = await run(rotateArgs({ "current-created": "12x", "current-expires": "99", "loaded-created": "soon" }));
    assert.equal(badEpoch.code, 1);
    assert.match(badEpoch.stderr, /--current-created must be epoch seconds or none\./);
    assert.match(badEpoch.stderr, /--current-expires must be epoch seconds or none\./);
    assert.match(badEpoch.stderr, /--loaded-created must be epoch seconds or none\./);
    const badMode = await run(args({ mode: "replace" }));
    assert.equal(badMode.code, 1);
    assert.match(badMode.stderr, /--mode must be new, rotate or remove-old\./);
    assert.equal(fake.requests.length, 0);
  });

  // --mode remove-old (ADR-0060 decision 8): after a case-A move the target vault holds CURRENT (re-issued
  // there through the target CAE's job) and the app runs with it; the old variant's vault (VAULT, the
  // fake job's) still holds easyauth-demo with OLD's value. APP_VAULT is the vault the app runs with now.
  const APP_VAULT = "kvcontosodevn9z8y7";
  const removeOldArgs = (over: Record<string, string> = {}): string[] => rotateArgs({ mode: "remove-old", "app-vault": APP_VAULT, ...over });
  const startEnv = (): J[] => (reqs("POST", "/start")[0]?.body?.containers?.[0]?.env ?? []) as J[];

  it("remove-old: the old variant's job deletes easyauth-<slug> (no job secret, no value), then the predecessors go; nothing is added", async () => {
    seed(OLD, CURRENT, MANUAL);
    const r = await run(removeOldArgs());
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const execution = String(r.output?.execution);
    assert.match(execution, new RegExp(`^${JOB}-x\\d+$`));
    assert.deepEqual(r.output, {
      secretName: "easyauth-demo",
      vault: VAULT,
      appVault: APP_VAULT,
      mode: "remove-old",
      oldSecret: "deleted",
      execution,
      currentKeyId: CURRENT.keyId,
      removedKeyIds: [OLD.keyId],
    });
    // Reads first; then the delete's start and the removal. No PATCH (no job secret), no addPassword.
    assert.deepEqual(fake.requests.map((q) => `${q.method} ${q.path.replace(JOB_ID, "<job>")}`), [
      "GET <job>",
      `GET /v1.0/applications(appId='${CLIENT_ID}')`,
      "POST <job>/start",
      `GET <job>/executions/${execution}`,
      `GET <job>/executions/${execution}`,
      `POST /v1.0/applications/${APP_OID}/removePassword`,
    ]);
    // The start: the job's container and env, plus exactly the name and the action.
    const started = reqs("POST", "/start")[0]!.body as J;
    assert.deepEqual(started.containers[0].args, ["kvset"]);
    assert.equal(started.containers[0].image, IMAGE);
    assert.deepEqual(startEnv(), [
      { name: "SAF_VAULT_URI", value: `https://${VAULT}.vault.azure.net/` },
      { name: "SAF_VAULT_AUDIENCE", value: "https://vault.azure.net" },
      { name: "AZURE_CLIENT_ID", value: KVSET_CLIENT_ID },
      { name: "SAF_SECRET_NAME", value: "easyauth-demo" },
      { name: "SAF_SECRET_ACTION", value: "delete" },
    ]);
    assert.deepEqual(fake.vaultDeletes, ["easyauth-demo"]);
    assert.deepEqual(fake.vaultWrites, []);
    assert.deepEqual([...fake.passwords.keys()].sort(), [CURRENT.keyId, MANUAL.keyId].sort(), "the current password and another name stay");
    assert.match(r.stdout, new RegExp(`^OK {2}remove-old easyauth-demo: deleted from ${VAULT} by execution ${execution}; 1 predecessor\\(s\\) removed$`, "m"));
  });

  it("remove-old: while the app may still run in the old variant, nothing is deleted or removed", async () => {
    for (const appVault of [VAULT, "none"]) {
      fake.reset();
      seed(OLD, CURRENT);
      const r = await run(removeOldArgs({ "app-vault": appVault }));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, appVault === "none" ? /the vault the app runs with now is not known \(--app-vault none\)/ : new RegExp(`the app still runs with vault ${VAULT} \\(--app-vault\\)`));
      assert.deepEqual(fake.writes(), [], "reads only");
      assert.deepEqual(r.output, { secretName: "easyauth-demo", vault: VAULT, appVault: appVault === "none" ? null : VAULT, mode: "remove-old", oldSecret: "kept", execution: "", currentKeyId: null, removedKeyIds: [] });
      assert.match(r.stdout, new RegExp(`^OK {2}remove-old easyauth-demo: kept in ${VAULT}; 0 predecessor\\(s\\) removed$`, "m"));
    }
  });

  it("remove-old: rotate's guards hold for the passwords; the delete of the old vault's secret still runs", async () => {
    // The app is not known to run with the target vault's version: no password goes.
    seed(OLD, CURRENT);
    const r = await run(removeOldArgs({ "loaded-created": "none" }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(removed(), 0);
    assert.deepEqual(fake.vaultDeletes, ["easyauth-demo"]);
    assert.equal(r.output?.currentKeyId, CURRENT.keyId);
    assert.deepEqual(r.output?.removedKeyIds, []);
    // The vault's version names no single current password: none goes, newer ones never.
    fake.reset();
    seed(OLD, CURRENT, STRAY);
    const hand = await run(removeOldArgs({ "current-expires": "none" }));
    assert.equal(hand.code, 0, hand.stderr);
    assert.equal(removed(), 0);
    fake.reset();
    seed(OLD, CURRENT, STRAY);
    const newer = await run(removeOldArgs());
    assert.equal(newer.code, 0, newer.stderr);
    assert.deepEqual(newer.output?.removedKeyIds, [OLD.keyId]);
    assert.ok(fake.passwords.has(STRAY.keyId) && fake.passwords.has(CURRENT.keyId));
  });

  it("remove-old: a failed delete keeps the output (oldSecret kept) and still removes the predecessors; exit 1", async () => {
    seed(OLD, CURRENT);
    fake.executionStatuses = ["Running", "Failed"];
    const r = await run(removeOldArgs());
    assert.equal(r.code, 1);
    assert.match(r.stderr, /execution \S+ ended Failed; easyauth-demo may still be in \S+\. See the job's console logs/);
    assert.equal(r.output?.oldSecret, "kept");
    assert.deepEqual(r.output?.removedKeyIds, [OLD.keyId]);
    assert.deepEqual(fake.vaultDeletes, []);
  });

  it("remove-old: the job is checked before anything is written (another vault, a template that sets the action, not a kvset job by name)", async () => {
    seed(OLD, CURRENT);
    const other = await run(removeOldArgs({ vault: "kvcontosodevp0000000" }));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /the job does not write vault kvcontosodevp0000000/);
    assert.deepEqual(fake.writes(), []);

    fake.reset();
    seed(OLD, CURRENT);
    fake.job.properties.template.containers[0].env.push({ name: "SAF_SECRET_ACTION", value: "delete" });
    for (const a of [removeOldArgs(), args()]) {
      const preset = await run(a);
      assert.equal(preset.code, 1);
      assert.match(preset.stderr, /the job must not set SAF_SECRET_ACTION itself \(it is set on start\)/);
    }
    assert.deepEqual(fake.writes(), []);

    fake.reset();
    const dbinitName = await run(removeOldArgs({ job: JOB_ID.replace(JOB, "caj-contoso-dbinit-ext") }));
    assert.equal(dbinitName.code, 1);
    assert.match(dbinitName.stderr, /--mode remove-old needs --job naming a kvset job caj-<prefix>-kvset-<ext\|hyb\|int>/);
    assert.equal(fake.requests.length, 0);
  });

  it("remove-old: SIGTERM while the delete runs stops the wait; no password is removed, the output says kept, exit 1", async () => {
    seed(OLD, CURRENT);
    const sig = signals();
    fake.executionStatuses = ["Running"];
    let sent = false;
    fake.onRequest = (q) => {
      if (q.path.includes("/executions/") && !sent) {
        sent = true;
        sig.send("SIGTERM");
      }
    };
    const r = await run(removeOldArgs(), env(), { onSignal: sig.onSignal, executionTimeoutMs: 60_000 });
    assert.ok(sent);
    assert.equal(r.code, 1);
    assert.equal(sig.subscribed(), 0);
    assert.match(r.stdout, /^warn {7}SIGTERM: stopping \(remove-old sets no job secret\)$/m);
    assert.match(r.stderr, /stopped by SIGTERM: GET execution \S+: stopped \(SIGTERM received\)\./);
    assert.equal(removed(), 0);
    assert.equal(r.output?.oldSecret, "kept");
    assert.deepEqual(reqs("PATCH", JOB_ID), []);
  });

  it("remove-old: flags are checked before any request", async () => {
    const noAppVault = await run(rotateArgs({ mode: "remove-old" }));
    assert.equal(noAppVault.code, 2);
    assert.match(noAppVault.stderr, /missing --app-vault\./);
    const badName = await run(removeOldArgs({ "display-name": "saf easyauth dev run 4242" }));
    assert.equal(badName.code, 1);
    assert.match(badName.stderr, /--mode remove-old needs --display-name easyauth-<environment>\[-run-<id>\]/);
    const badVault = await run(removeOldArgs({ "app-vault": "Not_A_Vault" }));
    assert.equal(badVault.code, 1);
    assert.match(badVault.stderr, /--app-vault must be a Key Vault name or none\./);
    for (const a of [args({ "app-vault": APP_VAULT }), rotateArgs({ "app-vault": APP_VAULT })]) {
      const elsewhere = await run(a);
      assert.equal(elsewhere.code, 1);
      assert.match(elsewhere.stderr, /--app-vault is for --mode remove-old only\./);
    }
    assert.equal(fake.requests.length, 0);
  });

  it("the transcript of every run above holds neither the value nor a token", () => {
    assert.ok(transcript.length > 40);
    const all = transcript.join("\n");
    assert.ok(!all.includes(VALUE));
    assert.ok(!all.includes(ARM_TOKEN) && !all.includes(GRAPH_TOKEN));
    // The fake did hand the value out (addPassword) and receive it (PATCH): the check is meaningful.
    assert.ok(VALUE.length > 30);
  });
});
