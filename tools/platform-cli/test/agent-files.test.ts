import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { CheckFailed } from "../src/pipeline/common.js";
import { agentFilesBehind, cmdAgentFiles, parseAgentsMd } from "../src/repo/agent-files.js";
import { renderAppRepo } from "../src/repo/render.js";
import { toolVersion } from "../src/version.js";

const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const APP = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A node-ts repository rendered by this core, as provisioning would seed it (coreVersion = this CLI's version). */
function renderedRepo(mutateApp?: (d: Doc) => void): string {
  const inst = parse(readFileSync(INSTANCE, "utf8")) as Doc;
  inst.coreVersion = `v${toolVersion()}`;
  const app = parse(readFileSync(APP, "utf8")) as Doc;
  mutateApp?.(app);
  const r = renderAppRepo(stringify(inst), stringify(app), { date: "2026-11-24", templatesDir: join(REPO_ROOT, "templates") });
  const dir = tmp("pc-agent-files-");
  for (const f of r.files) {
    mkdirSync(dirname(join(dir, f.path)), { recursive: true });
    writeFileSync(join(dir, f.path), f.content);
  }
  return dir;
}

/** What an older core left behind: the old This app rows, no Data row, an older skill, a settings file without the new allows. */
function ageRepo(dir: string): void {
  const md = join(dir, "AGENTS.md");
  let text = readFileSync(md, "utf8");
  text = text.replace(/^\| Data \| .*\n/m, "").replace(/^\| Agent files \| template \S+; repository created (\S+) \|$/m, "| Created from template | v0.2.0-rc.7 on $1 |");
  text = text.replace("<!-- app-notes:end -->", "Our own note: invoices are in EUR.\n<!-- app-notes:end -->");
  writeFileSync(md, text);
  for (const root of [".agents/skills", ".claude/skills"]) {
    const skill = join(dir, root, "deploy-and-rollback", "SKILL.md");
    writeFileSync(skill, readFileSync(skill, "utf8").replace(/## After you push[\s\S]*?(?=## )/, ""));
  }
  writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(platform check)", "Bash(platform check *)", "Bash(npm test)"], deny: ["Read(./.env)", "Read(./.env.*)"] } }, null, 2) + "\n");
}

const lines: string[] = [];
const out = (s: string) => void lines.push(s);

describe("platform agent-files update (ADR-0076)", () => {
  it("reads the This app table of the old and the current layout", () => {
    const old = parseAgentsMd(
      [
        "| Name | Test-02 (`test-02`) |",
        "| Purpose | A planner. |",
        "| Stack | Node.js + TypeScript (`node-ts`) |",
        "| Portal page | https://portal.contoso.com/apps/test-02 |",
        "| Platform docs | ask the platform team |",
        "| Created from template | v0.2.0-rc.7 on 2026-11-24 |",
        "This repo is pinned to version **0.2.0-rc.7**",
      ].join("\n"),
    );
    assert.deepEqual(old, { name: "Test-02", slug: "test-02", purpose: "A planner.", stack: "node-ts", appPortalUrl: "https://portal.contoso.com/apps/test-02", docs: "ask the platform team", templateVersion: "v0.2.0-rc.7", created: "2026-11-24", cliVersion: "0.2.0-rc.7" });
    const current = parseAgentsMd(readFileSync(join(renderedRepo(), "AGENTS.md"), "utf8"));
    assert.equal(current.data, "PostgreSQL database (skill database-postgres), Blob Storage for files (skill blob-storage)");
    assert.equal(current.templateVersion, `v${toolVersion()}`);
    assert.equal(current.created, "2026-11-24");
  });

  it("a repository the current core rendered is current: no PC057, nothing to update", async () => {
    const dir = renderedRepo();
    assert.deepEqual(agentFilesBehind(dir), []);
    lines.length = 0;
    assert.equal(await cmdAgentFiles(["update", dir, "--check"], { out }), 0);
    assert.match(lines.join(""), /OK {2}the agent files are current/);
  });

  it("an older repository: PC057 names the files, the update takes the portal's values and keeps the team's", async () => {
    const dir = renderedRepo();
    ageRepo(dir);
    const behind = agentFilesBehind(dir) ?? [];
    for (const p of ["AGENTS.md", ".agents/skills/deploy-and-rollback/SKILL.md", ".claude/skills/deploy-and-rollback/SKILL.md", ".claude/settings.json"]) assert.ok(behind.includes(p), `${p} behind: ${behind.join(", ")}`);
    lines.length = 0;
    assert.equal(await cmdAgentFiles(["update", dir, "--check"], { out }), 1, "--check changes nothing and says what would");
    assert.match(lines.join(""), /would update {2}AGENTS\.md/);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /Created from template \| v0\.2\.0-rc\.7/);

    lines.length = 0;
    const asked: [string, string | undefined][] = [];
    const code = await cmdAgentFiles(["update", dir], {
      out,
      portalApp: async (slug, portal) => {
        asked.push([slug, portal]);
        return { facts: { title: "Hotel Inventory", description: "Rooms and what is in them.", data: { database: { engine: "azureSql" } }, template: "node-ts" } };
      },
    });
    assert.equal(code, 0);
    assert.equal(asked[0]?.[0], "hotel-inventory");
    assert.match(lines.join(""), /file\(s\) written from template v.*values from the portal/);
    const md = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(md, /^\| Data \| Azure SQL database \(skill database-sql\) \(as of the last agent-files update; /m, "the Data row follows the portal");
    assert.match(md, new RegExp(`^\\| Agent files \\| template v${toolVersion().replace(/\./g, "\\.")}; repository created 2026-11-24 \\|$`, "m"), "the creation date stays");
    assert.match(md, /Our own note: invoices are in EUR\./, "the app-specific notes stay");
    assert.match(md, /^\| Purpose \| Rooms and what is in them\. \|$/m);
    assert.match(readFileSync(join(dir, ".agents/skills/deploy-and-rollback/SKILL.md"), "utf8"), /## After you push/);
    assert.equal(readFileSync(join(dir, ".agents/skills/deploy-and-rollback/SKILL.md"), "utf8"), readFileSync(join(dir, ".claude/skills/deploy-and-rollback/SKILL.md"), "utf8"));
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8")) as { permissions: { allow: string[] } };
    assert.ok(settings.permissions.allow.includes("Bash(npm test)"), "the team's own allow stays");
    assert.ok(settings.permissions.allow.includes("Bash(platform deploy status *)"), "the template's new allow is added");
    assert.equal(readFileSync(join(dir, ".platform/cli-version"), "utf8").trim(), toolVersion());
    assert.deepEqual(agentFilesBehind(dir), [], "current after the update");
  });

  it("offline (no sign-in): the values come from AGENTS.md; without a Data row it says none yet", async () => {
    const dir = renderedRepo();
    ageRepo(dir);
    lines.length = 0;
    assert.equal(await cmdAgentFiles(["update", dir], { out, portalApp: async () => ({ note: "not signed in to the portal (platform login): the values come from AGENTS.md." }) }), 0);
    assert.match(lines.join(""), /^note: not signed in/m);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /^\| Data \| none yet \(as of the last agent-files update; /m);
    assert.match(readFileSync(join(dir, "AGENTS.md"), "utf8"), /^\| Name \| Hotel Inventory \(`hotel-inventory`\) \|$/m);
  });

  it("the check through the CLI: a PC057 warning for the older repository, none once it is updated", async () => {
    const dir = renderedRepo();
    ageRepo(dir);
    const before = cli(["check", dir, "--only", "agent-files"]);
    assert.match(before.stdout, /WARNING\s+PC057\s+AGENTS\.md/);
    assert.match(before.stdout, /platform agent-files update/);
    assert.equal(before.code, 0, "a warning doesn't fail the check");
    await cmdAgentFiles(["update", dir, "--offline"], { out });
    assert.doesNotMatch(cli(["check", dir, "--only", "agent-files"]).stdout, /PC057/);
  });

  it("not the platform's AGENTS.md (a fixture, a hand-written one) or no platform.yaml: nothing to tell", () => {
    assert.equal(agentFilesBehind(join(FIXTURES, "good-app")), undefined);
    const bare = tmp("pc-agent-bare-");
    writeFileSync(join(bare, "AGENTS.md"), "# Our rules\n");
    assert.equal(agentFilesBehind(bare), undefined);
  });

  it("refuses without platform.yaml, and without a stack it can't learn", async () => {
    await assert.rejects(cmdAgentFiles(["update", tmp("pc-agent-empty-")], { out }), /No platform\.yaml/);
    const dir = tmp("pc-agent-nostack-");
    writeFileSync(join(dir, "platform.yaml"), "app: hotel-inventory\n");
    writeFileSync(join(dir, "AGENTS.md"), "# Our rules\n");
    await assert.rejects(cmdAgentFiles(["update", dir, "--offline"], { out }), (e: unknown) => e instanceof CheckFailed && /the stack is unknown/.test(e.message));
    await assert.rejects(cmdAgentFiles(["upgrade"], { out }), /Usage: platform agent-files update/);
    assert.equal(existsSync(join(dir, ".agents")), false, "nothing written after a refusal");
  });
});
