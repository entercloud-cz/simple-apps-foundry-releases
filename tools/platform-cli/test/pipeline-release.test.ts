import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PKG_ROOT, tmp } from "./helpers.js";
import { PIPE, pipe, readJsonFile } from "./pipeline-helpers.js";

const DIGEST = "sha256:" + "ab".repeat(32);
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const RUN_ENV = { RESOURCES_REPOSITORIES_APP_VERSION: COMMIT, RESOURCES_REPOSITORIES_APP_REF: "refs/heads/main", BUILD_BUILDID: "4711" };
const CLI_VERSION = (JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as { version: string }).version;

const runtime = { port: 8080, size: "s", minReplicas: 0, maxReplicas: 2, livenessPath: "/healthz", readinessPath: "/readyz" };
const releaseInputs = {
  slug: "demo",
  build: { dockerfile: "/agent/s/app/Dockerfile", context: "/agent/s/app" },
  deployBranches: ["*"],
  environments: {
    nonprod: {
      runtime,
      env: [
        { name: "LOG_LEVEL", value: "info", secret: null },
        { name: "API_KEY", value: null, secret: "api-key" },
      ],
      secrets: ["api-key"],
    },
  },
};
const verdict = {
  provider: "trivy",
  gate: { blockOn: "critical", onlyWithAvailableFix: true },
  counts: { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 },
  blocking: [],
  pass: true,
};
const UPDATED = "2026-10-28T06:10:48.385469315Z";

function file(name: string, content: unknown): string {
  const f = join(tmp(), name);
  writeFileSync(f, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  return f;
}

function manifestRun(over: { inputs?: unknown; verdict?: unknown; meta?: unknown; digest?: string; core?: string; env?: Record<string, string> } = {}) {
  const out = join(tmp(), "release-manifest.json");
  const r = pipe(
    [
      "release-manifest",
      "--digest", over.digest ?? DIGEST,
      "--release-inputs", file("ri.json", over.inputs ?? releaseInputs),
      "--verdict", file("verdict.json", over.verdict ?? verdict),
      "--trivy-db-metadata", file("metadata.json", over.meta ?? { Version: 2, UpdatedAt: UPDATED }),
      "--core-version", over.core ?? "v0.1.0",
      "--output", out,
    ],
    { ...RUN_ENV, ...over.env },
  );
  return { ...r, out };
}

describe("pipeline release-manifest", () => {
  it("records the build with tag = commit", () => {
    const r = manifestRun();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(readJsonFile(r.out), {
      schemaVersion: 1,
      slug: "demo",
      runId: 4711,
      commit: COMMIT,
      appRef: "refs/heads/main",
      digest: DIGEST,
      tag: COMMIT,
      verdict,
      dbUpdatedAt: UPDATED,
      coreVersion: "v0.1.0",
      cliVersion: CLI_VERSION,
      releaseInputs,
    });
    assert.ok(readFileSync(r.out, "utf8").endsWith("}\n"));
  });

  it("validates the agent variables and its options", () => {
    assert.match(manifestRun({ env: { RESOURCES_REPOSITORIES_APP_VERSION: "0123abc" } }).stderr, /40-character lowercase commit SHA/);
    assert.equal(manifestRun({ env: { RESOURCES_REPOSITORIES_APP_VERSION: COMMIT.toUpperCase() } }).code, 1);
    assert.equal(manifestRun({ env: { BUILD_BUILDID: "12a" } }).code, 1);
    assert.equal(manifestRun({ env: { RESOURCES_REPOSITORIES_APP_REF: "main" } }).code, 1);
    assert.equal(manifestRun({ digest: "sha256:abc" }).code, 1);
    assert.equal(manifestRun({ digest: "sha512:" + "a".repeat(128) }).code, 1);
    assert.equal(manifestRun({ core: "main" }).code, 1);
  });

  it("validates its input files", () => {
    assert.match(manifestRun({ inputs: { ...releaseInputs, extra: 1 } }).stderr, /unknown key "extra"/);
    assert.match(manifestRun({ inputs: { ...releaseInputs, slug: "Bad" } }).stderr, /not a valid app slug/);
    // The warnings release-inputs writes since ADR-0053: optional (earlier runs have none), strings only.
    assert.equal(manifestRun({ inputs: { ...releaseInputs, warnings: ["environment nonprod: above the reservation"] } }).code, 0);
    assert.match(manifestRun({ inputs: { ...releaseInputs, warnings: [1] } }).stderr, /warnings must be a list of strings/);
    assert.match(manifestRun({ verdict: { pass: "yes" } }).stderr, /not a scan-gate verdict/);
    assert.match(manifestRun({ meta: { Version: 2 } }).stderr, /no valid UpdatedAt/);
    assert.equal(manifestRun({ inputs: "not json" }).code, 1);
  });
});

describe("pipeline release-params", () => {
  // coreVersion: the core this run runs (instance-env), not the build's (the manifest says v0.1.0).
  const envJson = { prefix: "contoso", name: "nonprod", kind: "nonprod", subscriptionId: "00000000-0000-0000-0000-00000000a001", region: "westeurope", promoteFrom: "", vaultGeneration: 0, coreVersion: "v0.1.0-rc.9" };
  const record = JSON.parse(readFileSync(join(PIPE, "release-record.json"), "utf8")) as Record<string, { value: unknown; type?: string }>;
  const releaseManifest = {
    schemaVersion: 1,
    slug: "demo",
    runId: 4711,
    commit: COMMIT,
    appRef: "refs/heads/main",
    digest: DIGEST,
    tag: COMMIT,
    verdict,
    dbUpdatedAt: UPDATED,
    coreVersion: "v0.1.0",
    cliVersion: CLI_VERSION,
    releaseInputs,
  };

  function params(over: { record?: unknown; manifest?: unknown; env?: unknown } = {}) {
    const out = join(tmp(), "release.json");
    const r = pipe([
      "release-params",
      "--record", file("record.json", over.record ?? record),
      "--manifest", file("release-manifest.json", over.manifest ?? releaseManifest),
      "--env", file("env.json", over.env ?? envJson),
      "--output", out,
    ]);
    return { ...r, out };
  }

  it("combines platform-owned keys from the record with the app-owned keys of the build", () => {
    const r = params();
    assert.equal(r.code, 0, r.stderr);
    const o = readJsonFile(r.out) as Record<string, unknown>;
    assert.deepEqual(Object.keys(o), [
      "prefix", "environmentName", "slug", "generation", "vaultGeneration", "location", "networkMode", "cell",
      "externalOnlyNetwork", "image", "runtime", "env", "secrets", "landingZone", "frontDoor", "customDomains", "authentication", "run",
      "coreVersion",
    ]);
    assert.deepEqual(o, {
      prefix: "contoso",
      environmentName: "nonprod",
      slug: "demo",
      generation: 0,
      vaultGeneration: 0,
      location: "westeurope",
      networkMode: "externalOnly",
      cell: "01",
      externalOnlyNetwork: "managed",
      image: { digest: DIGEST },
      runtime,
      env: releaseInputs.environments.nonprod.env,
      secrets: ["api-key"],
      landingZone: record.landingZone?.value,
      frontDoor: record.frontDoor?.value,
      customDomains: [],
      authentication: record.authentication?.value,
      run: { id: "4711", commit: COMMIT },
      coreVersion: "v0.1.0-rc.9",
    });
    assert.ok(!("deployedBy" in o) && !("alertsEnabled" in o));
  });

  it("copies the record's capacity cell, and takes 01 for a record written before release.bicep had one (ADR-0053)", () => {
    assert.ok(!("cell" in record), "the fixture is a record from before the parameter");
    const r = params({ record: { ...record, cell: { value: "02", type: "String" } } });
    assert.equal(r.code, 0, r.stderr);
    assert.equal((readJsonFile(r.out) as Record<string, unknown>).cell, "02");
    assert.match(params({ record: { ...record, cell: { value: "2" } } }).stderr, /record cell must be two digits/);
    assert.match(params({ record: { ...record, cell: { value: "00" } } }).stderr, /record cell must be two digits/);
    assert.match(params({ record: { ...record, cell: "01" } }).stderr, /no parameter "cell"/);
  });

  it("checks prefix, environment and slug against the record", () => {
    assert.match(params({ env: { ...envJson, prefix: "fabrikam" } }).stderr, /record prefix "contoso" does not match the environment's prefix "fabrikam"/);
    assert.match(params({ record: { ...record, environmentName: { value: "test" } } }).stderr, /environmentName "test" does not match the environment "nonprod"/);
    assert.match(params({ record: { ...record, slug: { value: "other" } } }).stderr, /slug "other" does not match the release manifest slug "demo"/);
  });

  it("rejects a bad digest, a missing environment and malformed records", () => {
    assert.match(params({ manifest: { ...releaseManifest, digest: "sha256:xyz" } }).stderr, /digest must be sha256/);
    assert.match(params({ env: { ...envJson, name: "test" } }).stderr, /no release inputs for environment "test"/);
    const missing: Record<string, unknown> = { ...record };
    delete missing.frontDoor;
    assert.match(params({ record: missing }).stderr, /no parameter "frontDoor"/);
    assert.match(params({ record: { ...record, generation: { value: 0, reference: "x" } } }).stderr, /unexpected keys: reference/);
    assert.match(params({ record: { ...record, generation: { value: -1 } } }).stderr, /generation must be a non-negative integer/);
    assert.match(params({ env: { ...envJson, extra: true } }).stderr, /unknown key "extra"/);
    const noCore: Record<string, unknown> = { ...envJson };
    delete noCore.coreVersion;
    assert.match(params({ env: noCore }).stderr, /coreVersion must look like v1\.2\.3/);
    assert.match(params({ manifest: { ...releaseManifest, schemaVersion: 2 } }).stderr, /schemaVersion 1/);
    const badEnv = { ...releaseManifest, releaseInputs: { ...releaseInputs, environments: { nonprod: { ...releaseInputs.environments.nonprod, env: [{ name: "A", value: "x", secret: "y" }] } } } };
    assert.match(params({ manifest: badEnv }).stderr, /exactly one of value and secret/);
    assert.equal(params({ record: [] }).code, 1);
    assert.match(params({ manifest: { ...releaseManifest, runId: "4711" } }).stderr, /runId must be a non-negative integer/);
    assert.match(params({ manifest: { ...releaseManifest, commit: "abc" } }).stderr, /commit must be a 40-character/);
  });
});
