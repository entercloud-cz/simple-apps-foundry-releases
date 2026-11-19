import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { tmp } from "./helpers.js";
import { ARM_TOKEN, FakeAzure, IMAGE, JOB, JOB_ID, KVSET_CLIENT_ID, VAULT } from "./azure-fake.js";
import { cmdEasyAuthDelete } from "../src/provisioning/easyauth-delete.js";
import type { EasyAuthDeleteOptions } from "../src/provisioning/easyauth-delete.js";
import type { StopSignal } from "../src/provisioning/easyauth.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform provisioning easyauth-delete` (ADR-0061 section 4): the kvset job of the app's CAE deletes
// easyauth-<slug> in its vault with the delete action (ADR-0060), started with the Azure provisioning
// identity's ARM token; no Graph call, no job secret, no value. The token is never printed.

const fake = new FakeAzure();
before(() => fake.start());
after(() => fake.stop());
beforeEach(() => fake.reset());

const FAST: EasyAuthDeleteOptions = { executionPollMs: 1, executionTimeoutMs: 2_000, onSignal: () => () => undefined };
const env = (): Record<string, string> => ({ SAF_ARM_TOKEN: ARM_TOKEN, SAF_ARM_ENDPOINT: `${fake.base}/` });

function args(over: Record<string, string> = {}, output = join(tmp("pc-easyauth-delete-"), "result.json")): string[] {
  const v = { job: JOB_ID, vault: VAULT, "secret-name": "easyauth-demo", output, ...over };
  return Object.entries(v).flatMap(([k, x]) => [`--${k}`, x]);
}

async function run(a: string[] = args(), o: EasyAuthDeleteOptions = {}, e: Record<string, string> = env()): Promise<{ code: number; stdout: string; stderr: string; output: J | undefined }> {
  let stdout = "";
  let stderr = "";
  const code = await cmdEasyAuthDelete(a, e, { ...FAST, ...o, out: (s) => (stdout += s), err: (s) => (stderr += s) });
  assert.ok(!stdout.includes(ARM_TOKEN) && !stderr.includes(ARM_TOKEN), "the token is never printed");
  const file = a[a.indexOf("--output") + 1]!;
  return { code, stdout, stderr, output: existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as J) : undefined };
}

describe("platform provisioning easyauth-delete (ADR-0061)", () => {
  it("starts the kvset job's delete action for exactly the app's secret, waits, writes the result", async () => {
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    const execution = String(r.output?.execution);
    assert.match(execution, new RegExp(`^${JOB}-x\\d+$`));
    assert.deepEqual(r.output, { secretName: "easyauth-demo", vault: VAULT, job: JOB, execution, secret: "deleted" });
    assert.match(r.stdout, new RegExp(`^OK {2}easyauth-demo deleted from ${VAULT} by execution ${execution}$`, "m"));
    assert.deepEqual(fake.vaultDeletes, ["easyauth-demo"]);
    assert.deepEqual(fake.vaultWrites, []);
    // Only the job: a GET, the start, the execution's polls; no PATCH (no job secret), no Graph.
    assert.deepEqual(fake.writes(), [`POST ${JOB_ID}/start`]);
    assert.ok(!fake.requests.some((q) => q.path.startsWith("/v1.0/")));
    for (const q of fake.requests) assert.equal(q.auth, `Bearer ${ARM_TOKEN}`);
    const start = fake.requests.find((q) => q.method === "POST")!;
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
            { name: "SAF_SECRET_ACTION", value: "delete" },
          ],
        },
      ],
    });
  });

  it("a failed execution fails (exit 1, no output): the landing-zone record stays and the next run tries again", async () => {
    fake.executionStatuses = ["Running", "Failed"];
    const r = await run();
    assert.equal(r.code, 1);
    assert.equal(r.output, undefined);
    assert.match(r.stderr, /execution \S+ ended Failed; easyauth-demo may still be in .*the next run deletes it again/);
  });

  it("the job is checked before anything starts: another vault, a template that sets the action, not a kvset job by name", async () => {
    const other = await run(args({ vault: "kvcontosodevn9z8y7" }));
    assert.equal(other.code, 1);
    assert.match(other.stderr, /the job does not write vault kvcontosodevn9z8y7/);
    assert.deepEqual(fake.writes(), []);
    fake.job.properties.template.containers[0].env.push({ name: "SAF_SECRET_ACTION", value: "delete" });
    const preset = await run();
    assert.equal(preset.code, 1);
    assert.match(preset.stderr, /the job must not set SAF_SECRET_ACTION itself/);
    assert.deepEqual(fake.writes(), []);
    const dbinit = await run(args({ job: JOB_ID.replace(JOB, "caj-contoso-dbinit-ext") }));
    assert.equal(dbinit.code, 1);
    assert.match(dbinit.stderr, /--job must name a kvset job caj-<prefix>-kvset-<ext\|hyb\|int>/);
  });

  it("flags and the token are checked before any request", async () => {
    const before = fake.requests.length;
    const name = await run(args({ "secret-name": "other-demo" }));
    assert.equal(name.code, 1);
    assert.match(name.stderr, /--secret-name must be easyauth-<slug>/);
    const missing = await run(["--job", JOB_ID, "--vault", VAULT, "--output", join(tmp("pc-easyauth-delete-"), "r.json")]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /missing --secret-name/);
    const noToken = await run(args(), {}, { SAF_ARM_ENDPOINT: `${fake.base}/` });
    assert.equal(noToken.code, 1);
    assert.match(noToken.stderr, /SAF_ARM_TOKEN is not set/);
    assert.equal(fake.requests.length, before);
  });

  it("SIGTERM while the execution runs stops the wait, exit 1", async () => {
    fake.executionStatuses = ["Running"];
    let handler: ((s: StopSignal) => void) | undefined;
    fake.onRequest = (q) => {
      if (q.path.includes("/executions/")) handler?.("SIGTERM");
    };
    const r = await run(args(), { onSignal: (h) => ((handler = h), () => (handler = undefined)) });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^warn {7}SIGTERM: stopping \(the delete sets no job secret\)$/m);
    assert.match(r.stderr, /stopped by SIGTERM/);
  });
});
