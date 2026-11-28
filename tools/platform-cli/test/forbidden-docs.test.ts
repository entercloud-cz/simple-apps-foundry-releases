import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { check, copyFixture, git, ids, withEnv, write } from "./helpers.js";

describe("forbidden files", () => {
  const only = ["forbidden-files" as const];

  it("passes for the good fixture", async () => {
    assert.deepEqual((await check(copyFixture("good-app"), { only })).findings, []);
  });

  it("allows example.env and .env.example, flags other *.env files", async () => {
    const dir = copyFixture("good-app");
    write(dir, "example.env", "A=\n");
    write(dir, ".env.example", "A=\n");
    write(dir, "prod.env", "A=1\n");
    write(dir, "config/local.env", "A=1\n");
    const r = await check(dir, { only: ["forbidden-files"] });
    assert.deepEqual(r.findings.map((f) => f.file).sort(), ["config/local.env", "prod.env"]);
    assert.ok(r.findings.every((f) => f.ruleId === "PC030" && /example\.env/.test(f.message)));
  });

  it("flags .env files but allows .env.example", async () => {
    const dir = copyFixture("good-app");
    write(dir, ".env", "A=1\n");
    write(dir, ".env.production", "A=1\n");
    write(dir, ".env.example", "A=\n");
    write(dir, "config/.env.local", "A=1\n");
    const r = await check(dir, { only });
    assert.deepEqual(r.findings.map((f) => f.file).sort(), [".env", ".env.production", "config/.env.local"]);
    assert.ok(r.findings.every((f) => f.ruleId === "PC030"));
  });

  it("flags bin/, obj/ and node_modules/ once per directory", async () => {
    const dir = copyFixture("good-app");
    write(dir, "node_modules/left-pad/index.js", "x");
    write(dir, "node_modules/left-pad/package.json", "{}");
    write(dir, "bin/app.dll", "x");
    write(dir, "src/obj/a.o", "x");
    const r = await check(dir, { only });
    assert.deepEqual(r.findings.map((f) => f.file).sort(), ["bin", "node_modules", "src/obj"]);
    assert.ok(r.findings.every((f) => f.ruleId === "PC031"));
  });

  it("flags large files and key stores", async () => {
    const dir = copyFixture("good-app");
    write(dir, "data/big.bin", Buffer.alloc(2 * 1024 * 1024, 1));
    write(dir, "small.bin", Buffer.alloc(100));
    write(dir, "certs/site.pfx", "x");
    const r = await check(dir, { only, maxFileMb: 1 });
    assert.deepEqual(ids(r.findings).sort(), ["PC032", "PC033"]);
    assert.match(r.findings.find((f) => f.ruleId === "PC032")?.message ?? "", /2\.0 MB \(limit 1 MB\)/);
  });

  it("in a git work tree only considers tracked and non-ignored files", async () => {
    const dir = copyFixture("good-app");
    git(dir, "init", "-q", "-b", "main");
    write(dir, ".gitignore", ".env\nnode_modules/\n");
    write(dir, ".env", "A=1\n");
    write(dir, "node_modules/x/index.js", "x");
    const r = await check(dir, { only });
    assert.deepEqual(r.findings, []);
    git(dir, "add", "-f", ".env");
    assert.deepEqual(ids((await check(dir, { only })).findings), ["PC030"]);
  });
});

describe("docs freshness", () => {
  const only = ["docs" as const];

  function repo(): string {
    const dir = copyFixture("good-app");
    git(dir, "init", "-q", "-b", "main");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "init");
    git(dir, "checkout", "-q", "-b", "feature");
    return dir;
  }

  it("warns when code changed but CHANGELOG.md did not (PC040)", async () => {
    const dir = repo();
    write(dir, "src/server.js", "// changed\n");
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "code");
    const r = await check(dir, { only, baseRef: "main" });
    assert.deepEqual(ids(r.findings), ["PC040"]);
    assert.equal(r.findings[0]?.severity, "warning");
    assert.equal(r.exitCode, 0, "warnings do not fail the run");
  });

  it("is quiet when CHANGELOG.md changed too, or only docs changed", async () => {
    const dir = repo();
    write(dir, "src/server.js", "// changed\n");
    write(dir, "CHANGELOG.md", "# Changelog\n\n## [Unreleased]\n\n- changed\n");
    assert.deepEqual((await check(dir, { only, baseRef: "main" })).findings, []);
    const dir2 = repo();
    write(dir2, "README.md", "# more docs\n");
    write(dir2, "docs/a.md", "x");
    assert.deepEqual((await check(dir2, { only, baseRef: "main" })).findings, []);
  });

  it("counts uncommitted working-tree changes", async () => {
    const dir = repo();
    write(dir, "src/new.js", "x");
    assert.deepEqual(ids((await check(dir, { only, baseRef: "main" })).findings), ["PC040"]);
  });

  it("honours PLATFORM_CHECK_BASE_REF", async () => {
    const dir = repo();
    write(dir, "src/server.js", "// changed\n");
    const r = await withEnv({ PLATFORM_CHECK_BASE_REF: "main" }, () => check(dir, { only }));
    assert.deepEqual(ids(r.findings), ["PC040"]);
  });

  it("is skipped (not failed, even with --strict) without a git base ref", async () => {
    const dir = copyFixture("good-app"); // not a git repo
    const r = await check(dir, { only, strict: true, skipRuntime: false });
    assert.equal(r.results[0]?.skipped?.strictExempt, true);
    assert.deepEqual(r.findings, []);
    assert.equal(r.exitCode, 0);
  });

  it("PC041 when README.md or CHANGELOG.md is missing", async () => {
    const dir = copyFixture("good-app");
    rmSync(join(dir, "CHANGELOG.md"));
    mkdirSync(join(dir, "x"), { recursive: true });
    const r = await check(dir, { only });
    assert.deepEqual(ids(r.findings), ["PC041"]);
  });
});
