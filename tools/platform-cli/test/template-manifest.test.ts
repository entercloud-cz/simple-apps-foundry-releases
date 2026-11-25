import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultLayout, loadLayout, planSync } from "../src/agentfiles.js";
import { check, cli, copyFixture, ids, REPO_ROOT, tmp, write } from "./helpers.js";

const MANIFEST = join(REPO_ROOT, "templates", "app", "manifest.json");

describe("the real app template manifest (templates/app/manifest.json)", () => {
  it("is readable and describes the same layout as the built-in default", () => {
    assert.ok(existsSync(MANIFEST), "templates/app/manifest.json must exist");
    const fromManifest = loadLayout(MANIFEST);
    const builtIn = defaultLayout();
    assert.equal(fromManifest.source, MANIFEST);
    assert.equal(fromManifest.skillsSource, builtIn.skillsSource);
    assert.deepEqual(fromManifest.skillMirrors, builtIn.skillMirrors);
    assert.equal(fromManifest.agentsMdMaxBytes, builtIn.agentsMdMaxBytes);
    const strip = (l: ReturnType<typeof defaultLayout>) => [...l.stubs].sort((a, b) => a.path.localeCompare(b.path));
    assert.deepEqual(strip(fromManifest), strip(builtIn));
  });

  it("uses the template files as the text of missing stubs (no drift between template and CLI)", () => {
    const layout = loadLayout(MANIFEST);
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { files: { source?: string; target: string }[] };
    for (const stub of layout.stubs) {
      const entry = manifest.files.find((f) => f.target === stub.path);
      assert.ok(entry?.source, `${stub.path} must be a target in the manifest`);
      assert.equal(stub.create, readFileSync(join(REPO_ROOT, "templates", entry.source), "utf8"), stub.path);
    }
  });

  it("lists every file it points at", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { files: { source?: string }[] };
    for (const f of manifest.files) if (f.source) assert.ok(existsSync(join(REPO_ROOT, "templates", f.source)), f.source);
  });

  it("plans the same sync with and without the manifest", () => {
    const dir = tmp();
    write(dir, ".agents/skills/hello/SKILL.md", "---\nname: hello\ndescription: Says hello.\n---\n");
    write(dir, "AGENTS.md", "# Agents\n");
    const norm = (p: ReturnType<typeof planSync>) => p.actions.map((a) => `${a.kind} ${a.path} ${a.content?.toString("utf8") ?? ""}`).sort();
    assert.deepEqual(norm(planSync(dir, loadLayout(MANIFEST))), norm(planSync(dir, defaultLayout())));
  });

  it("drives check and sync-agent-files through --manifest / --agent-manifest", async () => {
    const dir = copyFixture("good-app");
    const r = await check(dir, { only: ["agent-files"], agentManifestPath: MANIFEST });
    assert.deepEqual(ids(r.findings), []);
    const empty = tmp();
    write(empty, ".agents/skills/hello/SKILL.md", "---\nname: hello\ndescription: Says hello.\n---\n");
    write(empty, "AGENTS.md", "# Agents\n");
    const s = cli(["sync-agent-files", empty, "--manifest", MANIFEST]);
    assert.equal(s.code, 0, s.stderr + s.stdout);
    assert.ok(existsSync(join(empty, ".claude/skills/hello/SKILL.md")));
    assert.ok(existsSync(join(empty, ".github/copilot-instructions.md")));
    assert.match(readFileSync(join(empty, ".claude/settings.json"), "utf8"), /Read\(\.\/\.env\.\*\)/);
    assert.equal(cli(["sync-agent-files", empty, "--manifest", MANIFEST, "--check"]).code, 0);
  });

  it("knows the conditional theme files (ADR-0044): never stubs, never synced", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as { files: { target: string; when?: string; generate?: string }[]; syncAgentFiles: string[] };
    const theme = m.files.filter((f) => f.when === "theme").map((f) => f.target);
    assert.deepEqual(theme.sort(), ["theme/README.md", "theme/theme.css", "theme/theme.json"]);
    assert.ok(!loadLayout(MANIFEST).stubs.some((s) => theme.includes(s.path)));
    const dir = tmp();
    write(dir, "app/manifest.json", JSON.stringify({ ...m, syncAgentFiles: [...m.syncAgentFiles, "theme/theme.css"] }));
    assert.throws(() => loadLayout(join(dir, "app/manifest.json")), /theme\/theme\.css is conditional \("when"\) and can't be in "syncAgentFiles"/);
    write(dir, "app/manifest.json", JSON.stringify({ ...m, files: [...m.files, { generate: "themeCss", target: "x.css", mode: "create" }] }));
    assert.throws(() => loadLayout(join(dir, "app/manifest.json")), /files\[\d+\] needs "source" \(or "generate" with "when"\)/);
  });

  it("declares the CLI version file as managed and synced", () => {
    const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
      files: { target: string; mode?: string }[];
      syncAgentFiles: string[];
      placeholders: Record<string, unknown>;
    };
    assert.equal(m.files.find((f) => f.target === ".platform/cli-version")?.mode, "managed");
    assert.ok(m.syncAgentFiles.includes(".platform/cli-version"));
    assert.ok("PLATFORM_CLI_VERSION" in m.placeholders);
  });
});
