import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { join } from "node:path";
import { symlinkSync } from "node:fs";
import { check, copyFixture, fakeBin, ids, tmp, withPath, write } from "./helpers.js";
import { fingerprintOf, scanText, shannonEntropy } from "../src/checks/secrets.js";
import { loadAllowlist, UsageError } from "../src/allowlist.js";
import { globMatch } from "../src/glob.js";

// Fake credentials are assembled at runtime so that this file contains no scannable secret.
const AWS = "AKIA" + "ABCDEFGHIJKLMNOP";
const GH = "gh" + "p_" + "Ab3dE6gH9jK2mN5pQ8sT1vW4yZ7aC0eF3hJ6";
const PEM = "-----BEGIN RSA PRIV" + "ATE KEY-----";
const CONN = "Server=db.contoso.local;Database=app;User Id=app;Pass" + "word=Zq8vLm3Rt9Wx;";
const URL_CRED = "postgres://app:" + "Zq8vLm3Rt9Wx@db.contoso.local/app";
const AAD = "abc" + "8Q~" + "aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567";

function secretsOnly(dir: string, extra: Parameters<typeof check>[1] = {}) {
  return check(dir, { only: ["secrets"], ...extra });
}

describe("secret rules", () => {
  it("detects the built-in high-signal patterns", () => {
    const cases: [string, string][] = [
      [`key = "${AWS}"`, "aws-access-key-id"],
      [`token: ${GH}`, "github-token"],
      [PEM, "private-key"],
      [CONN, "connection-string-password"],
      [`DATABASE_URL=${URL_CRED}`, "url-embedded-credentials"],
      [`secret ${AAD}`, "azure-ad-client-secret"],
      [`AccountKey=${"A1b2C3d4E5".repeat(5)}==`, "azure-storage-account-key"],
      [`const apiKey = "${"Xk29sLq0Pm4Vb7Nc1Zr8"}";`, "generic-secret-assignment"],
    ];
    for (const [text, rule] of cases) {
      assert.ok(scanText(text).some((h) => h.rule.id === rule), `${rule} not detected in: ${text.slice(0, 30)}`);
    }
  });

  it("ignores placeholders and references", () => {
    const clean = [
      "Server=db;Password=${DB_PASSWORD};",
      "Server=db;Password=<your password>;",
      "postgres://user:password@localhost/db",
      "postgres://user:${PASSWORD}@localhost/db",
      'const apiKey = process.env.API_KEY ?? "change-me-please-123";',
      'password: "example-password-123"',
      'secret = "aaaaaaaaaaaaaaaaaaaaaaaa"',
      "api_key: your-api-key-here-1234",
      "see https://learn.microsoft.com/azure/key-vault and the docs",
    ];
    for (const text of clean) assert.deepEqual(scanText(text), [], text);
  });

  it("entropy helper", () => {
    assert.ok(shannonEntropy("aaaaaaaa") < 0.1);
    assert.ok(shannonEntropy("Xk29sLq0Pm4Vb7Nc1Zr8") > 3.5);
  });
});

describe("secrets check", () => {
  it("passes for the good fixture", async () => {
    assert.deepEqual((await secretsOnly(copyFixture("good-app"))).findings, []);
  });

  it("PC020 with file, line and fingerprint, and never prints the full value", async () => {
    const dir = copyFixture("good-app");
    write(dir, "src/config.js", `// config\nexport const token = "${GH}";\n`);
    write(dir, "src/key.txt", `${PEM}\nMIIB...\n`);
    const r = await secretsOnly(dir);
    assert.deepEqual(ids(r.findings), ["PC020", "PC020"]);
    const gh = r.findings.find((f) => f.file === "src/config.js");
    assert.equal(gh?.line, 2);
    assert.match(gh?.message ?? "", new RegExp(fingerprintOf(GH)));
    for (const f of r.findings) {
      assert.ok(!f.message.includes(GH) && !f.aiPrompt.includes(GH) && !f.hint.includes(GH));
      assert.match(f.aiPrompt, /rotate/);
    }
    assert.match(r.findings.find((f) => f.file === "src/key.txt")?.message ?? "", /value hidden/);
  });

  it("skips binary files, lock files and oversized files", async () => {
    const dir = copyFixture("good-app");
    write(dir, "blob.dat", Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(AWS)]));
    write(dir, "package-lock.json", `"x": "${AWS}"`);
    write(dir, "huge.txt", `${AWS}\n` + "x".repeat(1024 * 1024 + 10));
    assert.deepEqual((await secretsOnly(dir)).findings, []);
  });

  it("allowlist by rule + path glob (platform-owned, outside the repo)", async () => {
    const dir = copyFixture("good-app");
    write(dir, "docs/example.md", `key ${AWS}\n`);
    write(dir, "src/real.js", `key = "${AWS}"\n`);
    const list = join(tmp(), "allow.json");
    write(join(list, ".."), "allow.json", JSON.stringify({ version: 1, entries: [{ ruleId: "aws-access-key-id", path: "docs/**", reason: "documentation example key" }] }));
    const r = await secretsOnly(dir, { allowlistPath: list });
    assert.deepEqual(r.findings.map((f) => f.file), ["src/real.js"]);
    assert.ok(r.results[0]?.notes?.some((n) => /1 finding\(s\) suppressed/.test(n)));
  });

  it("allowlist by fingerprint pins one exact value", async () => {
    const dir = copyFixture("good-app");
    write(dir, "a.txt", `${AWS}\n`);
    const other = "AKIA" + "ZZZZZZZZZZZZZZZZ";
    write(dir, "b.txt", `${other}\n`);
    const list = join(tmp(), "allow.yaml");
    write(join(list, ".."), "allow.yaml", `entries:\n  - fingerprint: ${fingerprintOf(AWS)}\n    reason: known test credential\n`);
    const r = await secretsOnly(dir, { allowlistPath: list });
    assert.deepEqual(r.findings.map((f) => f.file), ["b.txt"]);
  });

  it("rejects an allowlist inside the checked repository (app cannot allow itself)", () => {
    const dir = copyFixture("good-app");
    write(dir, ".platform-allowlist.json", JSON.stringify({ entries: [{ fingerprint: "0123456789abcdef", reason: "sneaky" }] }));
    assert.throws(() => loadAllowlist(join(dir, ".platform-allowlist.json"), dir), UsageError);
    // also through a symlink that points into the repo
    const link = join(tmp(), "link.json");
    symlinkSync(join(dir, ".platform-allowlist.json"), link);
    assert.throws(() => loadAllowlist(link, dir), /outside the repository/);
  });

  it("rejects blanket, reasonless and malformed allowlist entries; ignores expired ones", () => {
    const dir = tmp();
    const repo = tmp();
    const f = (entries: unknown[]) => {
      write(dir, "a.json", JSON.stringify({ entries }));
      return () => loadAllowlist(join(dir, "a.json"), repo);
    };
    assert.throws(f([{ ruleId: "aws-access-key-id", reason: "no path at all" }]), /no blanket/);
    assert.throws(f([{ fingerprint: "0123456789abcdef" }]), /reason/);
    assert.throws(f([{ path: "**", reason: "everything please" }]), /no blanket/);
    const expired = f([{ fingerprint: "0123456789abcdef", reason: "was temporary", expires: "2020-01-01" }])();
    assert.equal(expired.entries.length, 0);
    assert.equal(expired.expired.length, 1);
  });

  it("does not honour inline allow comments or a .gitleaks.toml from the repo", async () => {
    const dir = copyFixture("good-app");
    write(dir, "x.js", `const k = "${AWS}"; // gitleaks:allow\n`);
    write(dir, ".gitleaks.toml", '[allowlist]\npaths = ["x.js"]\n');
    assert.deepEqual(ids((await secretsOnly(dir)).findings), ["PC020"]);
  });

  it("runs gitleaks when it is on PATH and merges its findings (fake binary)", async () => {
    const dir = copyFixture("good-app");
    write(dir, "src/extra.txt", "nothing the built-in rules know\n");
    const bin = fakeBin(
      "gitleaks",
      `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "version") { console.log("8.0.0"); process.exit(0); }
const i = a.indexOf("--report-path");
const src = a[a.indexOf("--source") + 1];
const cfg = a[a.indexOf("--config") + 1];
if (!cfg || a.indexOf("--no-git") < 0) process.exit(9);
require("fs").writeFileSync(a[i + 1], JSON.stringify([{ RuleID: "generic-api-key", Description: "Generic API Key", File: src + "/src/extra.txt", StartLine: 1, Fingerprint: "src/extra.txt:generic-api-key:1" }]));
`.replace('require("fs")', 'require("node:fs")'),
    );
    const r = await withPath(bin, () => secretsOnly(dir, { gitleaks: "auto" }));
    assert.deepEqual(ids(r.findings), ["PC021"]);
    assert.equal(r.findings[0]?.file, "src/extra.txt");
    // allowlisted via the platform allowlist
    const list = join(tmp(), "al.json");
    write(join(list, ".."), "al.json", JSON.stringify({ entries: [{ ruleId: "gitleaks:generic-api-key", path: "src/**", reason: "reviewed false positive" }] }));
    const r2 = await withPath(bin, () => secretsOnly(dir, { gitleaks: "auto", allowlistPath: list }));
    assert.deepEqual(r2.findings, []);
  });

  it("--gitleaks require without gitleaks: skipped, and a failure under --strict", async () => {
    const dir = copyFixture("good-app");
    const empty = tmp();
    const old = process.env.PATH;
    process.env.PATH = empty;
    try {
      const r = await secretsOnly(dir, { gitleaks: "require" });
      assert.ok(r.results[0]?.skipped);
      const strict = await check(dir, { only: ["secrets"], gitleaks: "require", strict: true, skipRuntime: false });
      assert.deepEqual(ids(strict.findings), ["PC021"]);
    } finally {
      process.env.PATH = old;
    }
  });
});

describe("glob", () => {
  it("matches", () => {
    assert.ok(globMatch("docs/**", "docs/a/b.md"));
    assert.ok(globMatch("**/*.md", "a/b/c.md"));
    assert.ok(globMatch("**/*.md", "c.md"));
    assert.ok(!globMatch("*.md", "a/c.md"));
    assert.ok(globMatch("src/?.js", "src/a.js"));
    assert.ok(!globMatch("src/a.js", "src/ab.js"));
  });
});
