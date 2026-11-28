import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { check, cli, copyFixture, ids, tmp, write } from "./helpers.js";

const SKILL = ".agents/skills/app-contract-and-docker/SKILL.md";
const MIRROR = ".claude/skills/app-contract-and-docker/SKILL.md";

async function agent(dir: string) {
  return check(dir, { only: ["agent-files"] });
}

function skill(dir: string, folder: string, frontmatter: string, mirror = true): void {
  const body = `${frontmatter}\n\n# Body\n`;
  write(dir, `.agents/skills/${folder}/SKILL.md`, body);
  if (mirror) write(dir, `.claude/skills/${folder}/SKILL.md`, body);
}

describe("agent files check", () => {
  it("passes for the good fixture", async () => {
    assert.deepEqual((await agent(copyFixture("good-app"))).findings, []);
  });

  it("tolerates CRLF differences in the mirror", async () => {
    const dir = copyFixture("good-app");
    write(dir, MIRROR, readFileSync(join(dir, SKILL), "utf8").replace(/\n/g, "\r\n"));
    assert.deepEqual((await agent(dir)).findings, []);
  });

  it("PC051 on drift: changed, missing and extra files, with the fix command", async () => {
    const dir = copyFixture("good-app");
    write(dir, SKILL, readFileSync(join(dir, SKILL), "utf8") + "\nNew line.\n");
    write(dir, ".claude/skills/stale/SKILL.md", "---\nname: stale\ndescription: x\n---\n");
    skill(dir, "only-source", "---\nname: only-source\ndescription: Exists only in the canonical folder.\n---", false);
    const r = await agent(dir);
    assert.deepEqual(ids(r.findings), ["PC051", "PC051", "PC051"]);
    const msgs = r.findings.map((f) => f.message).join("\n");
    assert.match(msgs, /differs from/);
    assert.match(msgs, /does not exist in .agents\/skills/);
    assert.match(msgs, /missing/);
    assert.ok(r.findings.every((f) => /platform sync-agent-files/.test(f.hint)));
  });

  it("PC051 when the mirror is absent entirely", async () => {
    const dir = copyFixture("good-app");
    rmSync(join(dir, ".claude/skills"), { recursive: true });
    assert.deepEqual(ids((await agent(dir)).findings), ["PC051"]);
  });

  it("PC052 when CLAUDE.md does not import AGENTS.md or is missing", async () => {
    const dir = copyFixture("good-app");
    write(dir, "CLAUDE.md", "# Some other instructions\n");
    const r = await agent(dir);
    assert.deepEqual(ids(r.findings), ["PC052"]);
    rmSync(join(dir, "CLAUDE.md"));
    assert.deepEqual(ids((await agent(dir)).findings), ["PC052"]);
    write(dir, "CLAUDE.md", "@AGENTS.md\n\nMore text for Claude only.\n");
    assert.deepEqual((await agent(dir)).findings, []);
  });

  it("PC053 when AGENTS.md is missing or 32 KiB or larger", async () => {
    const dir = copyFixture("good-app");
    write(dir, "AGENTS.md", "x".repeat(32 * 1024));
    assert.deepEqual(ids((await agent(dir)).findings), ["PC053"]);
    write(dir, "AGENTS.md", "x".repeat(32 * 1024 - 1));
    assert.deepEqual((await agent(dir)).findings, []);
    rmSync(join(dir, "AGENTS.md"));
    assert.deepEqual(ids((await agent(dir)).findings), ["PC053"]);
  });

  it("PC054 for symlinks in agent folders and files", async () => {
    const dir = copyFixture("good-app");
    const target = tmp();
    mkdirSync(join(target, "s"), { recursive: true });
    write(target, "s/SKILL.md", "---\nname: s\ndescription: d\n---\n");
    symlinkSync(join(target, "s"), join(dir, ".agents/skills/linked"));
    rmSync(join(dir, "CLAUDE.md"));
    symlinkSync("AGENTS.md", join(dir, "CLAUDE.md"));
    const r = await agent(dir);
    const links = r.findings.filter((f) => f.ruleId === "PC054").map((f) => f.file).sort();
    assert.deepEqual(links, [".agents/skills/linked", "CLAUDE.md"]);
    assert.ok(r.exitCode === 1);
  });

  describe("SKILL.md frontmatter (PC050)", () => {
    const cases: [string, string, RegExp, "error" | "warning"][] = [
      ["no frontmatter", "# Just text", /must start with a '---'/, "error"],
      ["unclosed", "---\nname: a\ndescription: d", /not closed/, "error"],
      ["name mismatch", "---\nname: other\ndescription: d\n---", /must equal the folder name/, "error"],
      ["invalid name", "---\nname: Bad_Name\ndescription: d\n---", /1-64 characters/, "error"],
      ["double hyphen", "---\nname: a--b\ndescription: d\n---", /1-64 characters/, "error"],
      ["missing name", "---\ndescription: d\n---", /needs a "name"/, "error"],
      ["missing description", "---\nname: case-skill\n---", /non-empty "description"/, "error"],
      ["empty description", '---\nname: case-skill\ndescription: ""\n---', /non-empty "description"/, "error"],
      ["long description", `---\nname: case-skill\ndescription: ${"x".repeat(1025)}\n---`, /1024/, "error"],
      ["bad yaml", "---\nname: [oops\n---", /not valid YAML/, "error"],
      ["non-portable key", "---\nname: case-skill\ndescription: d\nallowed-tools: Bash\n---", /not portable/, "warning"],
      ["metadata not strings", "---\nname: case-skill\ndescription: d\nmetadata:\n  n: 1\n---", /map of strings/, "error"],
    ];
    for (const [label, fm, re, sev] of cases) {
      it(label, async () => {
        const dir = copyFixture("good-app");
        skill(dir, "case-skill", fm);
        const r = await agent(dir);
        const f = r.findings.find((x) => x.ruleId === "PC050" && re.test(x.message));
        assert.ok(f, `expected PC050 matching ${re} for ${label}, got ${r.findings.map((x) => x.message)}`);
        assert.equal(f.severity, sev);
        assert.ok(f.hint && f.aiPrompt);
      });
    }

    it("PC050 when a skill folder has no SKILL.md", async () => {
      const dir = copyFixture("good-app");
      mkdirSync(join(dir, ".agents/skills/empty-skill"), { recursive: true });
      const r = await agent(dir);
      assert.ok(r.findings.some((f) => f.ruleId === "PC050" && /SKILL.md is missing/.test(f.message)));
    });

    it("accepts optional portable keys", async () => {
      const dir = copyFixture("good-app");
      skill(dir, "extras", "---\nname: extras\ndescription: With extras.\nlicense: MIT\ncompatibility: Needs nothing\nmetadata:\n  author: me\n---");
      assert.deepEqual((await agent(dir)).findings, []);
    });
  });

  it("PC055 warnings for missing stubs; PC056 for a long copilot pointer", async () => {
    const dir = copyFixture("good-app");
    rmSync(join(dir, ".gemini"), { recursive: true });
    write(dir, ".gitattributes", "*.png binary\n");
    write(dir, ".github/copilot-instructions.md", Array.from({ length: 20 }, (_, i) => `Rule ${i}`).join("\n"));
    const r = await agent(dir);
    assert.deepEqual(ids(r.findings).sort(), ["PC055", "PC055", "PC056"]);
    assert.ok(r.findings.every((f) => f.severity === "warning"));
    assert.equal(r.exitCode, 0);
  });

  it("reads the layout from a template manifest when given", async () => {
    const dir = copyFixture("good-app");
    rmSync(join(dir, ".claude/skills"), { recursive: true });
    const manifest = join(tmp(), "manifest.json");
    write(
      join(manifest, ".."),
      "manifest.json",
      JSON.stringify({
        formatVersion: 1,
        files: [
          { source: "app/agent-files/skills", target: ".agents/skills", type: "dir", mode: "managed" },
          { type: "mirror", from: ".agents/skills", target: ".other/skills" },
        ],
        syncAgentFiles: [".agents/skills", ".other/skills"],
      }),
    );
    const r = await check(dir, { only: ["agent-files"], agentManifestPath: manifest });
    assert.deepEqual(ids(r.findings), ["PC051"]);
    assert.match(r.findings[0]?.file ?? "", /^\.other\/skills\//);
  });
});

describe("sync-agent-files", () => {
  it("creates the mirror and every stub in an empty repo", () => {
    const dir = tmp();
    write(dir, ".agents/skills/hello/SKILL.md", "---\nname: hello\ndescription: Says hello.\n---\n");
    write(dir, "AGENTS.md", "# Agents\n");
    const r = cli(["sync-agent-files", dir]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readFileSync(join(dir, ".claude/skills/hello/SKILL.md"), "utf8"), readFileSync(join(dir, ".agents/skills/hello/SKILL.md"), "utf8"));
    assert.match(readFileSync(join(dir, "CLAUDE.md"), "utf8"), /^@AGENTS\.md\n/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".gemini/settings.json"), "utf8")), { context: { fileName: ["AGENTS.md"] } });
    assert.ok(existsSync(join(dir, ".claude/settings.json")));
    assert.match(readFileSync(join(dir, ".gitattributes"), "utf8"), /text=auto eol=lf/);
    assert.ok(existsSync(join(dir, ".github/copilot-instructions.md")));
  });

  it("is idempotent and --check reports in sync afterwards", () => {
    const dir = copyFixture("good-app");
    assert.equal(cli(["sync-agent-files", dir, "--check"]).code, 0);
    write(dir, SKILL, readFileSync(join(dir, SKILL), "utf8") + "\nEdited.\n");
    const drift = cli(["sync-agent-files", dir, "--check"]);
    assert.equal(drift.code, 1);
    assert.match(drift.stdout, /DRIFT\s+\.claude\/skills\/app-contract-and-docker\/SKILL\.md/);
    assert.match(drift.stdout, /platform sync-agent-files/);
    // --check must not write
    assert.ok(!readFileSync(join(dir, MIRROR), "utf8").includes("Edited."));
    assert.equal(cli(["sync-agent-files", dir]).code, 0);
    assert.ok(readFileSync(join(dir, MIRROR), "utf8").includes("Edited."));
    assert.equal(cli(["sync-agent-files", dir, "--check"]).code, 0);
    const again = cli(["sync-agent-files", dir]);
    assert.match(again.stdout, /Nothing to do/);
  });

  it("deletes extra mirror files and empty folders, and mirrors scripts and nested files", () => {
    const dir = copyFixture("good-app");
    write(dir, ".claude/skills/old/SKILL.md", "x");
    write(dir, ".agents/skills/app-contract-and-docker/scripts/run.sh", "#!/bin/sh\necho hi\n");
    const r = cli(["sync-agent-files", dir]);
    assert.equal(r.code, 0);
    assert.ok(!existsSync(join(dir, ".claude/skills/old")));
    assert.ok(existsSync(join(dir, ".claude/skills/app-contract-and-docker/scripts/run.sh")));
  });

  it("repairs CLAUDE.md without losing its content, and merges .gemini/settings.json", () => {
    const dir = copyFixture("good-app");
    write(dir, "CLAUDE.md", "# My own notes\n");
    write(dir, ".gemini/settings.json", JSON.stringify({ theme: "dark", context: { fileName: ["GEMINI.md"], other: 1 } }));
    write(dir, ".gitattributes", "*.png binary\n");
    assert.equal(cli(["sync-agent-files", dir]).code, 0);
    assert.equal(readFileSync(join(dir, "CLAUDE.md"), "utf8"), "@AGENTS.md\n\n# My own notes\n");
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".gemini/settings.json"), "utf8")), {
      theme: "dark",
      context: { fileName: ["GEMINI.md", "AGENTS.md"], other: 1 },
    });
    assert.equal(readFileSync(join(dir, ".gitattributes"), "utf8"), "*.png binary\n* text=auto eol=lf\n");
    assert.equal(cli(["sync-agent-files", dir, "--check"]).code, 0);
  });

  it("never overwrites an existing create-only stub", () => {
    const dir = copyFixture("good-app");
    write(dir, ".claude/settings.json", '{ "custom": true }\n');
    cli(["sync-agent-files", dir]);
    assert.equal(readFileSync(join(dir, ".claude/settings.json"), "utf8"), '{ "custom": true }\n');
  });

  it("refuses symlinks in the source and reports invalid JSON stubs (exit 1)", () => {
    const dir = copyFixture("good-app");
    symlinkSync(tmp(), join(dir, ".agents/skills/link"));
    const r = cli(["sync-agent-files", dir]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /symbolic link/);
    const dir2 = copyFixture("good-app");
    write(dir2, ".gemini/settings.json", "{ not json");
    assert.equal(cli(["sync-agent-files", dir2]).code, 1);
  });

  it("follows a template manifest: custom mirror target, extra stub from a template source, dropped stub", () => {
    const dir = copyFixture("good-app");
    const mdir = tmp();
    write(mdir, "app/manifest.json", JSON.stringify({
      formatVersion: 1,
      files: [
        { source: "app/skills", target: ".agents/skills", type: "dir", mode: "managed" },
        { type: "mirror", from: ".agents/skills", target: ".claude/skills" },
        { type: "mirror", from: ".agents/skills", target: ".cursor/skills" },
        { source: "app/CLAUDE.md.tmpl", target: "CLAUDE.md", mode: "create" },
        { source: "app/GEMINI.md.tmpl", target: "GEMINI.md", mode: "create" },
        { source: "app/with-placeholder.tmpl", target: "NOTES.md", mode: "create" },
        { source: "app/copilot.tmpl", target: ".github/copilot-instructions.md", mode: "managed" },
      ],
      syncAgentFiles: ["CLAUDE.md", "GEMINI.md", "NOTES.md", ".agents/skills", ".claude/skills", ".cursor/skills"],
    }));
    write(mdir, "app/CLAUDE.md.tmpl", "@AGENTS.md\n");
    write(mdir, "app/GEMINI.md.tmpl", "@AGENTS.md\n");
    write(mdir, "app/with-placeholder.tmpl", "# {{APP_NAME}}\n");
    rmSync(join(dir, ".github"), { recursive: true });
    const r = cli(["sync-agent-files", dir, "--manifest", join(mdir, "app/manifest.json")]);
    assert.equal(r.code, 0, r.stderr + r.stdout);
    assert.ok(existsSync(join(dir, ".cursor/skills/app-contract-and-docker/SKILL.md")));
    assert.equal(readFileSync(join(dir, "GEMINI.md"), "utf8"), "@AGENTS.md\n");
    assert.ok(!existsSync(join(dir, "NOTES.md")), "a placeholder source cannot be written by the CLI");
    assert.ok(!existsSync(join(dir, ".github/copilot-instructions.md")), "not in syncAgentFiles, so not a stub of this layout");
  });

  it("rejects a manifest in another format with exit 2 (old agentFiles shape, wrong formatVersion)", () => {
    const dir = copyFixture("good-app");
    const mdir = tmp();
    write(mdir, "old.json", JSON.stringify({ agentFiles: { skillMirrors: [".other/skills"] } }));
    const old = cli(["sync-agent-files", dir, "--manifest", join(mdir, "old.json")]);
    assert.equal(old.code, 2);
    assert.match(old.stderr, /formatVersion/);
    write(mdir, "v2.json", JSON.stringify({ formatVersion: 2, files: [] }));
    assert.equal(cli(["sync-agent-files", dir, "--manifest", join(mdir, "v2.json")]).code, 2);
    write(mdir, "nofiles.json", JSON.stringify({ formatVersion: 1 }));
    assert.equal(cli(["sync-agent-files", dir, "--manifest", join(mdir, "nofiles.json")]).code, 2);
  });

  it("rejects an invalid manifest with exit 2", () => {
    const dir = copyFixture("good-app");
    const mdir = tmp();
    write(mdir, "manifest.json", "{ nope");
    assert.equal(cli(["sync-agent-files", dir, "--manifest", join(mdir, "manifest.json")]).code, 2);
  });

  it("works on a repo with no skills at all (this core repo today)", async () => {
    const dir = tmp();
    write(dir, "AGENTS.md", "# core\n");
    write(dir, "CLAUDE.md", "@AGENTS.md\n\n<!-- note -->\n");
    const r = await agent(dir);
    assert.deepEqual(r.findings.filter((f) => f.severity === "error"), []);
  });
});
