import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { tmp } from "./helpers.js";
import { ARM_TOKEN, DBINIT_JOB, DBINIT_JOB_ID, FakeAzure, IMAGE, JOB_ID, SUB, dbinitJob } from "./azure-fake.js";
import { cmdDbinit } from "../src/provisioning/dbinit.js";
import type { DbinitOptions } from "../src/provisioning/dbinit.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform provisioning dbinit` (ADR-0028) against the fake ARM on 127.0.0.1, its job set to the
// dbinit job. Every run is checked for the token in stdout, stderr and the output file.

const fake = new FakeAzure();
before(() => fake.start());
after(() => fake.stop());
beforeEach(() => {
  fake.reset();
  fake.job = dbinitJob();
  fake.jobId = DBINIT_JOB_ID;
});

const HOST = "pgsql-contoso-hotel-inventory-dev-a1b2c3.postgres.database.azure.com";
const ROLE = "id-contoso-hotel-inventory-run-dev";
const OID = "00000000-0000-0000-0000-0000000000d1";
const CLIENT = "00000000-0000-0000-0000-0000000000d2";
const FAST: DbinitOptions = { executionPollMs: 1, executionTimeoutMs: 2_000 };

const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({ SAF_ARM_TOKEN: ARM_TOKEN, SAF_ARM_ENDPOINT: `${fake.base}/`, ...extra });

function args(over: Record<string, string> = {}, output = join(tmp("pc-dbinit-"), "dbinit.json")): string[] {
  const v = { job: DBINIT_JOB_ID, engine: "postgres", host: HOST, database: "hotel_inventory", "principal-name": ROLE, "principal-id": OID, "principal-client-id": CLIENT, output, ...over };
  return Object.entries(v).flatMap(([k, x]) => [`--${k}`, x]);
}

async function run(a: string[] = args(), e = env(), o: DbinitOptions = {}): Promise<{ code: number; stdout: string; stderr: string; output: J | undefined }> {
  let stdout = "";
  let stderr = "";
  const code = await cmdDbinit(a, e, { ...FAST, ...o, out: (s) => (stdout += s), err: (s) => (stderr += s) });
  const file = a[a.indexOf("--output") + 1]!;
  const text = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  for (const t of [stdout, stderr, text ?? ""]) assert.ok(!t.includes(ARM_TOKEN), "the token was printed or written");
  return { code, stdout, stderr, output: text === undefined ? undefined : (JSON.parse(text) as J) };
}

describe("platform provisioning dbinit", () => {
  it("checks the job, starts it with the five start variables, waits for success", async () => {
    const r = await run();
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, "");
    const execution = String(r.output?.execution);
    assert.match(execution, new RegExp(`^${DBINIT_JOB}-x\\d+$`));
    assert.deepEqual(r.output, { job: DBINIT_JOB_ID, execution, status: "Succeeded" });
    assert.match(r.stdout, new RegExp(`^OK  ${ROLE} on ${HOST}/hotel_inventory by execution ${execution}$`, "m"));
    const seq = fake.requests.map((q) => `${q.method} ${q.path.replace(DBINIT_JOB_ID, "<job>").replace(/x\d+$/, "x")}`);
    assert.deepEqual(seq.slice(0, 2), ["GET <job>", "POST <job>/start"]);
    assert.ok(seq.slice(2).every((s) => s === `GET <job>/executions/${DBINIT_JOB}-x`));
    assert.ok(fake.requests.every((q) => q.auth === `Bearer ${ARM_TOKEN}`));
    const start = fake.requests[1]!.body as J;
    assert.deepEqual(start, {
      containers: [
        {
          name: "dbinit",
          image: IMAGE,
          args: ["dbinit"],
          resources: { cpu: 0.25, memory: "0.5Gi" },
          env: [
            { name: "SAF_PG_AUDIENCE", value: "https://ossrdbms-aad.database.windows.net" },
            { name: "SAF_PG_HOST_SUFFIX", value: "postgres.database.azure.com" },
            { name: "SAF_SQL_HOST_SUFFIX", value: "database.windows.net" },
            { name: "SAF_DB_ADMIN", value: "id-contoso-dbinit-dev" },
            { name: "AZURE_CLIENT_ID", value: "00000000-0000-0000-0000-0000000000c6" },
            { name: "SAF_DB_ENGINE", value: "postgres" },
            { name: "SAF_DB_HOST", value: HOST },
            { name: "SAF_DB_NAME", value: "hotel_inventory" },
            { name: "SAF_PRINCIPAL_NAME", value: ROLE },
            { name: "SAF_PRINCIPAL_ID", value: OID },
            { name: "SAF_PRINCIPAL_CLIENT_ID", value: CLIENT },
          ],
        },
      ],
    });
  });

  it("a failed execution fails and points to the job's logs", async () => {
    fake.executionStatuses = ["Running", "Failed"];
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, new RegExp(`^platform provisioning dbinit: execution ${DBINIT_JOB}-x\\d+ ended Failed\\. See the job's console logs`, "m"));
  });

  it("refuses a job that isn't a dbinit job, before any start", async () => {
    const cases: [string, (j: J) => void, RegExp][] = [
      ["kvset argument", (j) => (j.properties.template.containers[0].args = ["kvset"]), /must pass exactly the argument dbinit/],
      ["image by tag", (j) => (j.properties.template.containers[0].image = "crcontosodev.azurecr.io/saf-jobs:latest"), /saf-jobs image pinned by digest/],
      ["command override", (j) => (j.properties.template.containers[0].command = ["/bin/sh"]), /must not override the image's command/],
      ["start variable in the template", (j) => j.properties.template.containers[0].env.push({ name: "SAF_DB_HOST", value: "elsewhere" }), /must not set SAF_DB_HOST itself/],
      ["a secret reference", (j) => j.properties.template.containers[0].env.push({ name: "X", secretRef: "s" }), /not a plain value/],
      ["no SAF_DB_ADMIN", (j) => (j.properties.template.containers[0].env = j.properties.template.containers[0].env.filter((e: J) => e.name !== "SAF_DB_ADMIN")), /has no SAF_DB_ADMIN value/],
      ["scheduled", (j) => (j.properties.configuration.triggerType = "Schedule"), /must have a manual trigger/],
      ["two containers", (j) => j.properties.template.containers.push({ ...j.properties.template.containers[0], name: "other" }), /exactly one container/],
    ];
    for (const [label, mutate, re] of cases) {
      fake.reset();
      fake.job = dbinitJob();
      fake.jobId = DBINIT_JOB_ID;
      mutate(fake.job);
      const r = await run();
      assert.equal(r.code, 1, label);
      assert.match(r.stderr, re, label);
      assert.equal(fake.requests.filter((q) => q.method === "POST").length, 0, `${label}: started anyway`);
    }
  });

  it("invalid flags: exit 1, one line each, no request", async () => {
    const r = await run(args({ job: JOB_ID, engine: "mysql", host: "not a host", database: "Bad-Name", "principal-name": "id-contoso-dbinit-dev", "principal-id": "x", "principal-client-id": "y" }));
    assert.equal(r.code, 1);
    const lines = r.stderr.trim().split("\n");
    assert.equal(lines.length, 7, r.stderr);
    for (const re of [/--job must be the ARM ID of a dbinit job/, /--engine must be postgres or azureSql/, /--host must be/, /--database must be/, /--principal-name must be/, /--principal-id must be/, /--principal-client-id must be/]) assert.match(r.stderr, re);
    assert.equal(fake.requests.length, 0);
  });

  it("usage errors and a missing token", async () => {
    let r = await run(["--job", DBINIT_JOB_ID, "--output", join(tmp("pc-dbinit-"), "x.json")]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /missing --engine, --host, --database, --principal-name, --principal-id, --principal-client-id\./);
    r = await run(args(), env({ SAF_ARM_TOKEN: undefined }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /SAF_ARM_TOKEN is not set/);
    assert.equal(fake.requests.length, 0);
  });

  it("ARM refuses the start: the hint names the provisioning identity's role, the token is not echoed", async () => {
    fake.failures.push({ method: "POST", path: "/start", status: 403, body: { error: { code: "AuthorizationFailed", message: `no start for Bearer ${ARM_TOKEN}` } } });
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /POST job caj-contoso-dbinit-ext\/start returned HTTP 403 \(the Azure provisioning identity needs Contributor on the environment subscription, ADR-0028\)\. AuthorizationFailed/);
    assert.match(r.stderr, /\[redacted\]/);
  });

  it("an execution of another job is refused", async () => {
    fake.failures.push({ method: "POST", path: "/start", status: 202, body: { name: "caj-x-1", id: `/subscriptions/${SUB}/resourceGroups/other/providers/Microsoft.App/jobs/caj-x/executions/caj-x-1` } });
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.stderr, /returned an execution of another job/);
  });
});
