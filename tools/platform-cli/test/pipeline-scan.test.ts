import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmp } from "./helpers.js";
import { PIPE, VSO, instanceFile, pipe, readJsonFile } from "./pipeline-helpers.js";
import { parseTimestamp } from "../src/pipeline/scan.js";

/** Trivy writes Go timestamps with nanoseconds. */
function goTime(msFromNow: number): string {
  return new Date(Date.now() + msFromNow).toISOString().replace(/\.(\d{3})Z$/, ".$1456789Z");
}

function metadata(content: unknown): string {
  const file = join(tmp(), "metadata.json");
  writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
  return file;
}

const H = 3_600_000;

describe("pipeline trivy-db-age", () => {
  it("prints UpdatedAt of a fresh DB", () => {
    const updated = goTime(-2 * H);
    const r = pipe(["trivy-db-age", "--metadata", metadata({ Version: 2, NextUpdate: goTime(4 * H), UpdatedAt: updated, DownloadedAt: goTime(0) }), "--max-age-hours", "72"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, `${updated}\n`);
  });

  it("fails on an old, future, missing or unparsable UpdatedAt", () => {
    const old = pipe(["trivy-db-age", "--metadata", metadata({ UpdatedAt: goTime(-100 * H) }), "--max-age-hours", "72"]);
    assert.equal(old.code, 1);
    assert.match(old.stderr, /^platform pipeline trivy-db-age: Trivy DB is 100\.0 hours old/);
    assert.equal(pipe(["trivy-db-age", "--metadata", metadata({ UpdatedAt: goTime(5 * H) }), "--max-age-hours", "72"]).code, 1);
    assert.equal(pipe(["trivy-db-age", "--metadata", metadata({ Version: 2 }), "--max-age-hours", "72"]).code, 1);
    assert.equal(pipe(["trivy-db-age", "--metadata", metadata({ UpdatedAt: "yesterday" }), "--max-age-hours", "72"]).code, 1);
    assert.equal(pipe(["trivy-db-age", "--metadata", metadata("not json"), "--max-age-hours", "72"]).code, 1);
    assert.equal(pipe(["trivy-db-age", "--metadata", join(tmp(), "missing.json"), "--max-age-hours", "72"]).code, 1);
  });

  it("validates --max-age-hours", () => {
    const m = metadata({ UpdatedAt: goTime(-1 * H) });
    for (const v of ["0", "-1", "abc", "1e3"]) assert.equal(pipe(["trivy-db-age", "--metadata", m, "--max-age-hours", v]).code, 2, v);
  });

  it("parses RFC 3339 with and without fractions and offsets", () => {
    assert.equal(parseTimestamp("2026-10-28T06:10:48.385469315Z"), Date.parse("2026-10-28T06:10:48.385Z"));
    assert.equal(parseTimestamp("2026-10-28T08:10:48+02:00"), Date.parse("2026-10-28T06:10:48Z"));
    assert.equal(parseTimestamp("2026-10-28 06:10:48"), undefined);
    assert.equal(parseTimestamp(12345), undefined);
  });
});

describe("pipeline scan-gate", () => {
  const trivy = join(PIPE, "trivy-report.json");

  function gate(scanning?: Record<string, unknown>, report = trivy) {
    const inst = instanceFile((d) => {
      if (scanning === undefined) delete d.scanning;
      else d.scanning = scanning;
    });
    const out = join(tmp(), "verdict.json");
    const r = pipe(["scan-gate", "--trivy", report, "--instance", inst, "--output", out]);
    return { ...r, verdict: r.code === 0 ? (readJsonFile(out) as Record<string, unknown>) : undefined };
  }

  it("normalises and de-duplicates findings; default gate: critical with a fix", () => {
    const r = gate();
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.verdict, {
      provider: "trivy",
      gate: { blockOn: "critical", onlyWithAvailableFix: true },
      counts: { CRITICAL: 2, HIGH: 2, MEDIUM: 1, LOW: 1, UNKNOWN: 1 },
      blocking: [{ id: "CVE-2026-0001", pkg: "libssl3", installed: "3.0.14-1", fixed: "3.0.15-1", severity: "CRITICAL" }],
      pass: false,
    });
    assert.match(r.stdout, /^WOULD BLOCK {2}trivy: block prod on critical \(only with a fix available\); CRITICAL 2, HIGH 2/);
  });

  it("applies blockProdPromotionOn and onlyWithAvailableFix", () => {
    const all = gate({ provider: "trivy", blockProdPromotionOn: "critical", onlyWithAvailableFix: false });
    assert.deepEqual((all.verdict?.blocking as { id: string }[]).map((b) => b.id), ["CVE-2026-0001", "CVE-2026-0002"]);
    const high = gate({ blockProdPromotionOn: "high" });
    assert.deepEqual((high.verdict?.blocking as { id: string }[]).map((b) => b.id), ["CVE-2026-0001", "CVE-2026-0003", "GHSA-xxxx-yyyy-zzzz"]);
    const none = gate({ blockProdPromotionOn: "none" });
    assert.deepEqual(none.verdict?.blocking, []);
    assert.equal(none.verdict?.pass, true);
  });

  it("returns pass: null with a reason for provider defender (exit 0)", () => {
    const r = gate({ provider: "defender" });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.verdict?.pass, null);
    assert.equal(r.verdict?.provider, "defender");
    assert.match(String(r.verdict?.reason), /Defender/);
  });

  it("passes an image without findings", () => {
    const file = join(tmp(), "clean.json");
    writeFileSync(file, JSON.stringify({ SchemaVersion: 2, Results: [{ Target: "x", Class: "os-pkgs" }] }));
    const r = gate(undefined, file);
    assert.equal(r.verdict?.pass, true);
    assert.deepEqual(r.verdict?.counts, { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, UNKNOWN: 0 });
  });

  it("rejects reports that are not Trivy JSON v2", () => {
    const cases = [
      { SchemaVersion: 1, Results: [] },
      { SchemaVersion: 2, Results: {} },
      { SchemaVersion: 2, Results: [{ Vulnerabilities: [{ PkgName: "x" }] }] },
      { SchemaVersion: 2, Results: [{ Vulnerabilities: "many" }] },
      [],
    ];
    for (const c of cases) {
      const file = join(tmp(), "t.json");
      writeFileSync(file, JSON.stringify(c));
      assert.equal(gate(undefined, file).code, 1, JSON.stringify(c));
    }
  });

  it("neutralises image data in its summary", () => {
    const report = JSON.parse(readFileSync(trivy, "utf8")) as { Results: { Vulnerabilities?: { PkgName: string }[] }[] };
    (report.Results[0]?.Vulnerabilities ?? [])[0]!.PkgName = `${VSO}task.setvariable variable=x]1`;
    const file = join(tmp(), "t.json");
    writeFileSync(file, JSON.stringify(report));
    const r = gate(undefined, file);
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(VSO), r.stdout);
  });

  describe("--enforce", () => {
    function enforce(scanning?: Record<string, unknown>) {
      const inst = instanceFile((d) => {
        if (scanning === undefined) delete d.scanning;
        else d.scanning = scanning;
      });
      const out = join(tmp(), "verdict.json");
      const r = pipe(["scan-gate", "--trivy", trivy, "--instance", inst, "--output", out, "--enforce"]);
      return { ...r, verdict: readJsonFile(out) as Record<string, unknown> };
    }

    it("exits 1 with one line per blocking finding, after writing the verdict", () => {
      const r = enforce({ blockProdPromotionOn: "high" });
      assert.equal(r.code, 1);
      assert.equal(r.verdict.pass, false);
      assert.deepEqual(r.stderr.trim().split("\n"), [
        "platform pipeline scan-gate: blocked: CRITICAL CVE-2026-0001 in libssl3 3.0.14-1 (fixed in 3.0.15-1).",
        "platform pipeline scan-gate: blocked: HIGH CVE-2026-0003 in libc6 2.36-9 (fixed in 2.36-10).",
        "platform pipeline scan-gate: blocked: HIGH GHSA-xxxx-yyyy-zzzz in left-pad 1.0.0 (fixed in 1.0.1).",
      ]);
      assert.match(r.stdout, /^WOULD BLOCK/);
    });

    it("exits 0 when the gate passes", () => {
      const r = enforce({ blockProdPromotionOn: "none" });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stderr, "");
    });

    it("fails closed for provider defender", () => {
      const r = enforce({ provider: "defender" });
      assert.equal(r.code, 1);
      assert.equal(r.verdict.pass, null);
      assert.match(r.stderr, /^platform pipeline scan-gate: scanning\.provider is defender: the Defender gate is not supported by this core release\.\n$/);
    });

    it("neutralises blocking findings from image data", () => {
      const report = JSON.parse(readFileSync(trivy, "utf8")) as { Results: { Vulnerabilities?: { PkgName: string }[] }[] };
      (report.Results[0]?.Vulnerabilities ?? [])[0]!.PkgName = `${VSO}task.setvariable variable=x]1`;
      const file = join(tmp(), "t.json");
      writeFileSync(file, JSON.stringify(report));
      const r = pipe(["scan-gate", "--trivy", file, "--instance", instanceFile(), "--output", join(tmp(), "v.json"), "--enforce"]);
      assert.equal(r.code, 1);
      assert.ok(!(r.stdout + r.stderr).includes(VSO), r.stderr);
    });
  });

  it("requires all options", () => {
    assert.equal(pipe(["scan-gate", "--trivy", trivy, "--instance", instanceFile()]).code, 2);
  });
});
