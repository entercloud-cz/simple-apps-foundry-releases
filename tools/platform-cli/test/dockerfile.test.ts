import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { check, copyFixture, ids, REPO_ROOT, tmp, write } from "./helpers.js";
import { parseImageRef, pinVerdict, tokenizeDockerfile } from "../src/checks/dockerfile.js";

const PIN = "node:22.11.0-alpine3.20";

async function run(dockerfile: string, manifestExtra = ""): Promise<{ ids: string[]; messages: string[] }> {
  const dir = copyFixture("good-app");
  write(dir, "Dockerfile", dockerfile);
  if (manifestExtra) write(dir, "platform.yaml", `schemaVersion: "1.0-draft"\napp: demo-app\n${manifestExtra}`);
  const r = await check(dir, { only: ["dockerfile"] });
  return { ids: ids(r.findings), messages: r.findings.map((f) => f.message) };
}

describe("pinVerdict", () => {
  const ok = [
    "node:22.11.0-alpine3.20",
    "python:3.13.1-slim-bookworm",
    "mcr.microsoft.com/dotnet/aspnet:9.0.1",
    "localhost:5000/team/app:v1.2.3",
    "nginx:1.27.3",
    "node:22@sha256:" + "a".repeat(64),
    "node:latest@sha256:" + "b".repeat(64),
  ];
  const bad: [string, RegExp][] = [
    ["node", /no tag/],
    ["node:latest", /latest/],
    ["node:22", /major version/],
    ["node:22-alpine", /major version/],
    ["node:22.11", /exact version/],
    ["python:3.13-slim", /exact version/],
    ["node:lts", /floating/],
    ["debian:bookworm-slim", /floating/],
    ["node@sha256:abc", /not a valid sha256/],
  ];
  for (const ref of ok) it(`accepts ${ref}`, () => assert.equal(pinVerdict(parseImageRef(ref)).ok, true));
  for (const [ref, re] of bad) {
    it(`rejects ${ref}`, () => {
      const v = pinVerdict(parseImageRef(ref));
      assert.equal(v.ok, false);
      assert.match(v.ok ? "" : v.reason, re);
    });
  }
  it("does not mistake a registry port for a tag", () => {
    assert.deepEqual(parseImageRef("localhost:5000/app"), { name: "localhost:5000/app" });
  });
});

describe("Dockerfile tokenizer", () => {
  it("joins continuations, skips comments", () => {
    const ins = tokenizeDockerfile("# c\nRUN a \\\n  # inner\n  && b\nUSER x\n");
    assert.equal(ins.length, 2);
    assert.equal(ins[0]?.keyword, "RUN");
    assert.match(ins[0]?.args ?? "", /a\s+&& b/);
    assert.equal(ins[1]?.line, 5);
  });
});

describe("Dockerfile check", () => {
  it("passes the good fixture", async () => {
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 8080\nUSER node\n`)).ids, []);
  });

  it("PC010 when the Dockerfile is missing or outside the repo", async () => {
    const dir = copyFixture("good-app");
    const { rmSync } = await import("node:fs");
    rmSync(`${dir}/Dockerfile`);
    assert.deepEqual(ids((await check(dir, { only: ["dockerfile"] })).findings), ["PC010"]);
    write(dir, "platform.yaml", 'schemaVersion: "1.0-draft"\napp: demo-app\nbuild:\n  dockerfile: ../Dockerfile\n');
    assert.deepEqual(ids((await check(dir, { only: ["dockerfile"] })).findings), ["PC010"]);
  });

  it("PC011 for latest, untagged, major-only and major.minor tags", async () => {
    for (const img of ["node:latest", "node", "node:22-alpine", "node:22.11-alpine"]) {
      const r = await run(`FROM ${img}\nEXPOSE 8080\nUSER node\n`);
      assert.deepEqual(r.ids, ["PC011"], img);
    }
  });

  it("accepts a digest even with a floating tag; rejects a bad digest", async () => {
    assert.deepEqual((await run(`FROM node:22@sha256:${"c".repeat(64)}\nEXPOSE 8080\nUSER node\n`)).ids, []);
    assert.deepEqual((await run(`FROM node@sha256:short\nEXPOSE 8080\nUSER node\n`)).ids, ["PC011"]);
  });

  it("resolves ARG defaults in FROM; fails on ARG without default", async () => {
    assert.deepEqual((await run(`ARG V=22.11.0-alpine3.20\nFROM node:\${V}\nEXPOSE 8080\nUSER node\n`)).ids, []);
    const r = await run(`ARG V\nFROM node:\${V}\nEXPOSE 8080\nUSER node\n`);
    assert.deepEqual(r.ids, ["PC011"]);
    assert.match(r.messages[0] ?? "", /cannot be resolved/);
    assert.deepEqual((await run(`ARG V=latest\nFROM node:\${V}\nEXPOSE 8080\nUSER node\n`)).ids, ["PC011"]);
  });

  it("ignores stage references and scratch, checks every external FROM", async () => {
    const good = `FROM ${PIN} AS build\nRUN true\nFROM build AS final\nEXPOSE 8080\nUSER node\n`;
    assert.deepEqual((await run(good)).ids, []);
    const scratch = `FROM ${PIN} AS build\nFROM scratch\nCOPY --from=build /x /x\nEXPOSE 8080\nUSER 10001\n`;
    assert.deepEqual((await run(scratch)).ids, []);
    const badBuild = `FROM node:22 AS build\nFROM ${PIN}\nEXPOSE 8080\nUSER node\n`;
    assert.deepEqual((await run(badBuild)).ids, ["PC011"]);
  });

  it("PC012: no USER, USER root, USER 0:0", async () => {
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 8080\n`)).ids, ["PC012"]);
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 8080\nUSER root\n`)).ids, ["PC012"]);
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 8080\nUSER 0:0\n`)).ids, ["PC012"]);
  });

  it("PC012: the LAST user wins; USER is inherited from a previous stage", async () => {
    assert.deepEqual((await run(`FROM ${PIN}\nUSER node\nUSER root\nEXPOSE 8080\n`)).ids, ["PC012"]);
    assert.deepEqual((await run(`FROM ${PIN} AS base\nUSER node\nFROM base\nEXPOSE 8080\n`)).ids, []);
    assert.deepEqual((await run(`FROM ${PIN} AS base\nFROM base\nEXPOSE 8080\n`)).ids, ["PC012"]);
    // a root user in a builder stage does not matter when the final stage switches
    assert.deepEqual((await run(`FROM ${PIN} AS b\nUSER root\nFROM ${PIN}\nUSER node\nEXPOSE 8080\n`)).ids, []);
  });

  it("PC013: EXPOSE and ENV PORT must agree with runtime.port", async () => {
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 3000\nUSER node\n`)).ids, ["PC013"]);
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 3000\nUSER node\n`, "runtime:\n  port: 3000\n")).ids, []);
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 3000\nUSER node\n`, "runtime:\n  port: 9000\n")).ids, ["PC013"]);
    assert.deepEqual((await run(`FROM ${PIN}\nENV PORT=3000\nEXPOSE 8080\nUSER node\n`)).ids, ["PC013"]);
    assert.deepEqual((await run(`FROM ${PIN}\nENV PORT 3000\nEXPOSE 8080\nUSER node\n`)).ids, ["PC013"]);
    assert.deepEqual((await run(`FROM ${PIN}\nENV PORT 3000\nEXPOSE 3000\nUSER node\n`)).ids, ["PC013", "PC013"]);
    assert.deepEqual((await run(`FROM ${PIN}\nENV PORT=8080\nEXPOSE \${PORT}\nUSER node\n`)).ids, []);
    assert.deepEqual((await run(`FROM ${PIN}\nEXPOSE 8080/tcp 9999\nUSER node\n`)).ids, []);
  });

  it("PC014 warning when nothing is exposed", async () => {
    const r = await run(`FROM ${PIN}\nUSER node\n`);
    assert.deepEqual(r.ids, ["PC014"]);
  });

  it("keeps the line number of the offending FROM", async () => {
    const dir = copyFixture("good-app");
    write(dir, "Dockerfile", `# comment\n\nFROM node:latest\nEXPOSE 8080\nUSER node\n`);
    const r = await check(dir, { only: ["dockerfile"] });
    assert.equal(r.findings[0]?.line, 3);
  });
});

describe("repository stack templates", () => {
  // Cross-check: the Dockerfiles shipped in templates/stacks must satisfy the rules the CLI
  // enforces on app repos. Skipped when the folder does not exist (yet).
  const stacks = join(REPO_ROOT, "templates", "stacks");
  const names = existsSync(stacks) ? readdirSync(stacks).filter((n) => existsSync(join(stacks, n, "Dockerfile"))) : [];
  if (names.length === 0) it("no stack templates found, nothing to cross-check", { skip: true }, () => undefined);
  for (const name of names) {
    it(`templates/stacks/${name}/Dockerfile passes the Dockerfile rules`, async () => {
      const dir = tmp();
      cpSync(join(stacks, name, "Dockerfile"), join(dir, "Dockerfile"));
      write(dir, "platform.yaml", 'schemaVersion: "1.0-draft"\napp: demo-app\n');
      const r = await check(dir, { only: ["dockerfile"] });
      assert.deepEqual(r.findings.map((f) => `${f.ruleId} ${f.message}`), []);
    });
  }
});
