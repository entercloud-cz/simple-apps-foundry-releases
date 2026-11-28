import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { check, cli, copyFixture, FIXTURES, tmp } from "./helpers.js";
import { formatSarif, validateSarif } from "../src/report/sarif.js";
import { formatJson } from "../src/report/json.js";
import { formatText } from "../src/report/text.js";
import { RULES } from "../src/rules.js";

// Fixtures are stored under neutral names; materialize them once per file.
const BAD = copyFixture("bad-app");
const GOOD = copyFixture("good-app");

describe("fixtures through the CLI", () => {
  it("good-app: exit 0", () => {
    const r = cli(["check", copyFixture("good-app"), "--skip-runtime"]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /Result: PASSED/);
  });

  it("bad-app: exit 1 with findings from several groups, fix hints and AI prompts", () => {
    const r = cli(["check", BAD, "--skip-runtime"]);
    assert.equal(r.code, 1);
    for (const id of ["PC002", "PC011", "PC012", "PC013", "PC041", "PC050", "PC051", "PC052"]) assert.match(r.stdout, new RegExp(id));
    assert.match(r.stdout, /Fix: /);
    assert.match(r.stdout, /AI prompt: /);
    assert.match(r.stdout, /Result: FAILED/);
  });

  it("--no-ai-prompts hides the AI prompt lines", () => {
    const r = cli(["check", BAD, "--skip-runtime", "--no-ai-prompts"]);
    assert.doesNotMatch(r.stdout, /AI prompt:/);
  });

  it("exit code 2 for usage errors", () => {
    assert.equal(cli(["check", join(FIXTURES, "does-not-exist")]).code, 2);
    assert.equal(cli(["check", GOOD, "--format", "xml"]).code, 2);
    assert.equal(cli(["check", GOOD, "--only", "nonsense"]).code, 2);
    assert.equal(cli(["check", GOOD, "--bogus-flag"]).code, 2);
    assert.equal(cli(["frobnicate"]).code, 2);
    assert.equal(cli([]).code, 2);
    assert.equal(cli(["check", GOOD, "--skip-runtime", "--allowlist", join(GOOD, "platform.yaml")]).code, 2);
  });

  it("--version, help and rules work", () => {
    assert.match(cli(["--version"]).stdout, /^\d+\.\d+\.\d+/);
    assert.equal(cli(["help"]).code, 0);
    const rules = cli(["rules"]).stdout;
    for (const r of RULES) assert.match(rules, new RegExp(r.id));
  });
});

describe("output formats", () => {
  it("JSON has summary, per-check status and findings without internal fields", async () => {
    const report = await check(BAD);
    const j = JSON.parse(formatJson(report));
    assert.equal(j.result, "failed");
    assert.equal(j.summary.errors, report.summary.errors);
    assert.ok(j.checks.some((c: { group: string; status: string }) => c.group === "runtime" && c.status === "skipped"));
    assert.ok(j.findings.every((f: Record<string, unknown>) => f.ruleId && f.hint && f.aiPrompt && !("fingerprintSeed" in f)));
  });

  it("SARIF 2.1.0 is structurally valid, has all rules and locations", async () => {
    const report = await check(BAD);
    const sarif = formatSarif(report);
    assert.deepEqual(validateSarif(sarif), []);
    const run = sarif.runs[0] as { tool: { driver: { rules: { id: string }[] } }; results: { ruleId: string; level: string; locations: { physicalLocation: { region: { startLine: number } } }[]; partialFingerprints: Record<string, string> }[] };
    assert.equal(run.tool.driver.rules.length, RULES.length);
    assert.equal(run.results.length, report.findings.length);
    assert.ok(run.results.every((r) => (r.locations[0]?.physicalLocation.region.startLine ?? 0) >= 1));
    assert.ok(run.results.every((r) => /^[0-9a-f]{32}$/.test(r.partialFingerprints["platformCheck/v1"] ?? "")));
    assert.ok(run.results.some((r) => r.level === "warning"));
    // fingerprints are stable across runs
    const again = formatSarif(await check(BAD));
    assert.deepEqual(
      (again.runs[0] as typeof run).results.map((r) => r.partialFingerprints["platformCheck/v1"]),
      run.results.map((r) => r.partialFingerprints["platformCheck/v1"]),
    );
  });

  it("validateSarif catches broken logs", () => {
    assert.ok(validateSarif({ version: "2.0.0", runs: [] }).length >= 2);
    const broken = { $schema: "x", version: "2.1.0", runs: [{ tool: { driver: { name: "t", rules: [{ id: "A" }] } }, results: [{ ruleId: "B", ruleIndex: 0, level: "fatal", message: {}, locations: [{ physicalLocation: { region: { startLine: 0 } } }] }] }] };
    const p = validateSarif(broken).join("\n");
    assert.match(p, /ruleIndex/);
    assert.match(p, /level is invalid/);
    assert.match(p, /message\.text/);
    assert.match(p, /uri is required/);
    assert.match(p, /startLine/);
  });

  it("CLI --format sarif writes parseable SARIF to stdout; --output writes a file and prints the summary", () => {
    const out = cli(["check", BAD, "--skip-runtime", "--format", "sarif"]);
    assert.equal(out.code, 1);
    assert.deepEqual(validateSarif(JSON.parse(out.stdout)), []);

    const file = join(tmp(), "out.sarif");
    const r = cli(["check", BAD, "--skip-runtime", "--format", "sarif", "--output", file]);
    assert.equal(r.code, 1);
    assert.ok(existsSync(file));
    assert.deepEqual(validateSarif(JSON.parse(readFileSync(file, "utf8"))), []);
    assert.match(r.stdout, /Result: FAILED/);

    const j = cli(["check", BAD, "--skip-runtime", "--format", "json"]);
    assert.equal(JSON.parse(j.stdout).result, "failed");
  });

  it("text output groups findings and shows skipped checks", async () => {
    const text = formatText(await check(copyFixture("good-app")), { color: false, aiPrompts: true });
    assert.match(text, /Runtime smoke test {2}\[SKIPPED\]/);
    assert.match(text, /Result: PASSED/);
  });
});
