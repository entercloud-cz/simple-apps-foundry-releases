import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { PKG_ROOT, REPO_ROOT } from "./helpers.js";
import { PORTAL_ONLY_KEYS } from "../src/provisioning/generate.js";

/*
 * The guard of ADR-0074 section 2: pipelines/inputs/provisioning.json leaves out the instance.yaml keys only the
 * portal reads (PORTAL_ONLY_KEYS), so a merge that changes only them doesn't start \platform\provisioning. This test
 * fails when the provisioning code starts reading one of them; then the key comes off the list.
 *
 * What it reads (the code a provisioning run executes):
 *   - the TypeScript modules behind every CLI command the provisioning scripts call, with everything they import
 *     (COMMAND_MODULES; a script calling a command not in the table fails here, so the table can't fall behind);
 *   - pipelines/azure-devops/app-provisioning.yml, templates/provisioning/**, scripts/provisioning/*.sh and
 *     scripts/lib.sh, which they source;
 *   - infra/app/**, infra/entra/** and infra/modules/** (the templates and parameter files of the units).
 * What it looks for: a read of a key's last segment as a property (`.lifecycle`, `?.setup`, `["logoUrl"]`, `own(x,
 * "setup")`) or as a schema pointer (`properties/lifecycle`), outside comments.
 * Its limits (ADR-0074): it sees names, not data flow. A read through destructuring (`const { setup } = inst`), a
 * computed key, or a copy of instance.yaml as a whole (units.ts filesHash hashes all of it, ADR-0049 section 3: it
 * only tells a rebase from a run of a unit whose inputs changed, and a portal-only key changes no unit's inputs)
 * passes unseen; and the same last segment under another parent (an app theme's logoUrl) needs an exception below.
 */

/** CLI command (and subcommand, where only some of a group run in provisioning) -> the modules it runs. */
const COMMAND_MODULES: Record<string, string[]> = {
  provisioning: ["src/provisioning/index.ts"],
  generate: ["src/provisioning/index.ts"],
  ado: ["src/ado/index.ts"],
  validate: ["src/validate.ts", "src/validate-app.ts", "src/validate-archive.ts"],
  "pipeline instance-env": ["src/pipeline/instance.ts"],
  "pipeline classify-deploy-error": ["src/pipeline/deploy-error.ts"],
};

/** Reads that are not of the deny-listed key, or that provisioning's behaviour doesn't depend on. Each has its reason. */
const EXCEPTIONS: { file: string; key: string; reason: string }[] = [
  {
    file: "tools/platform-cli/src/validate-instance-change.ts",
    key: "lifecycle",
    reason:
      "instanceWarnings: a warning when observability.logRetentionDays is below lifecycle.unusedAfterDaysWithoutRequests (ADR-0054). `platform validate instance` prints it; the pull request validation runs the same check on every change, and nothing provisioning deploys depends on it.",
  },
  {
    file: "tools/platform-cli/src/themes.ts",
    key: "logoUrl",
    reason: "an app theme's logo (branding.appThemes[].logoUrl, written into a seeded repository's theme.json), not branding.logoUrl.",
  },
  {
    file: "tools/platform-cli/src/ado/bootstrap.ts",
    key: "productName",
    reason:
      "AdoBootstrap.projects(): the description of the platform and apps projects when `platform ado bootstrap` (instance.sh, a person) creates them. Provisioning imports the module for its names and outputs only, and never creates a project.",
  },
];

const AZDO = join(REPO_ROOT, "pipelines", "azure-devops");
const LIST_FILE = "tools/platform-cli/src/provisioning/generate.ts";

function walk(dir: string, keep: (f: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .sort()
    .flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p, keep) : keep(p) ? [p] : [];
    });
}

/** The relative imports of a TypeScript module, resolved to source files. */
function importsOf(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const specs = [...text.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/g), ...text.matchAll(/import\("(\.[^"]+)"\)/g)].map((m) => m[1]!);
  return specs.map((s) => join(dirname(file), s.replace(/\.js$/, ".ts"))).filter((f) => existsSync(f));
}

function closure(roots: string[]): string[] {
  const seen = new Set<string>();
  const stack = roots.map((r) => join(PKG_ROOT, r));
  while (stack.length) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    stack.push(...importsOf(f));
  }
  return [...seen].sort();
}

/** The CLI commands the provisioning scripts call: `saf_cli <cmd> [<sub>]` and `args=(<cmd> <sub> ...)`. */
function commandsCalled(): Set<string> {
  const out = new Set<string>();
  for (const f of walk(join(AZDO, "scripts", "provisioning"), (p) => p.endsWith(".sh"))) {
    const code = stripShellComments(readFileSync(f, "utf8"));
    for (const m of code.matchAll(/\b(?:saf_cli|args=\()\s*([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/g)) {
      const [cmd, sub] = [m[1]!, m[2]];
      out.add(COMMAND_MODULES[cmd] ? cmd : `${cmd} ${sub ?? ""}`.trim());
    }
  }
  return out;
}

/** Block comments blanked, their line breaks kept (so line numbers stay right). */
const blankBlocks = (t: string): string => t.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, ""));
const stripTsComments = (t: string): string => blankBlocks(t).replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const stripShellComments = (t: string): string =>
  t
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/\s+#\s.*$/, ""))
    .join("\n");
const stripBicepComments = (t: string): string => blankBlocks(t).replace(/(^|[^:'])\/\/.*$/gm, "$1");

/** A read of the key's last segment: a property, a quoted key, or a schema pointer. */
function readPattern(leaf: string): RegExp {
  return new RegExp(String.raw`(?:\?\.|\.)${leaf}\b|\[\s*["'\`]${leaf}["'\`]\s*\]|,\s*["'\`]${leaf}["'\`]\s*\)|properties/${leaf}\b`);
}

function sources(): { rel: string; code: string }[] {
  const ts = closure([...new Set(Object.values(COMMAND_MODULES).flat())]).map((f) => ({ f, code: stripTsComments(readFileSync(f, "utf8")) }));
  const shell = [join(AZDO, "scripts", "lib.sh"), ...walk(join(AZDO, "scripts", "provisioning"), (p) => p.endsWith(".sh"))].map((f) => ({ f, code: stripShellComments(readFileSync(f, "utf8")) }));
  const yml = [join(AZDO, "app-provisioning.yml"), ...walk(join(AZDO, "templates", "provisioning"), (p) => p.endsWith(".yml"))].map((f) => ({ f, code: stripShellComments(readFileSync(f, "utf8")) }));
  const bicep = ["app", "entra", "modules"].flatMap((d) => walk(join(REPO_ROOT, "infra", d), (p) => /\.(bicep|bicepparam)$/.test(p))).map((f) => ({ f, code: stripBicepComments(readFileSync(f, "utf8")) }));
  return [...ts, ...shell, ...yml, ...bicep].map(({ f, code }) => ({ rel: relative(REPO_ROOT, f), code }));
}

describe("the provisioning inputs' deny-list (ADR-0074 section 2)", () => {
  it("knows every CLI command the provisioning scripts call", () => {
    const called = commandsCalled();
    const unknown = [...called].filter((c) => !COMMAND_MODULES[c]);
    assert.deepEqual(unknown, [], `add the modules of these commands to COMMAND_MODULES: ${unknown.join(", ")}`);
    assert.deepEqual([...called].sort(), Object.keys(COMMAND_MODULES).sort(), "every entry of COMMAND_MODULES is still called");
  });

  it("reads the code it should (a sanity check of the file set)", () => {
    const files = sources().map((s) => s.rel);
    for (const f of [
      "tools/platform-cli/src/provisioning/inputs.ts",
      "tools/platform-cli/src/provisioning/units.ts",
      "tools/platform-cli/src/ado/plan.ts",
      "tools/platform-cli/src/themes.ts",
      "tools/platform-cli/src/validate-instance.ts",
      "pipelines/azure-devops/scripts/provisioning/prov-lib.sh",
      "pipelines/azure-devops/scripts/lib.sh",
      "pipelines/azure-devops/templates/provisioning/stages/plan.yml",
      "infra/app/landing-zone.bicep",
      "infra/app/provisioning/release.bicepparam",
    ]) {
      assert.ok(files.includes(f), f);
    }
    assert.ok(!files.some((f) => f.startsWith("tools/platform-cli/src/onboarding/") && f !== "tools/platform-cli/src/onboarding/agent-files.ts"), "onboarding is not provisioning");
  });

  it("no provisioning code reads a key on the list", () => {
    const found: string[] = [];
    for (const key of PORTAL_ONLY_KEYS) {
      const leaf = key.split(".").at(-1)!;
      const re = readPattern(leaf);
      for (const { rel, code } of sources()) {
        if (EXCEPTIONS.some((e) => e.file === rel && e.key === leaf)) continue;
        code.split("\n").forEach((line, i) => {
          // The list itself names them.
          if (rel === LIST_FILE && line.startsWith("export const PORTAL_ONLY_KEYS: ")) return;
          if (re.test(line)) found.push(`${rel}:${i + 1}: ${key}: ${line.trim().slice(0, 160)}`);
        });
      }
    }
    assert.deepEqual(found, [], "provisioning reads these keys: take them off PORTAL_ONLY_KEYS (src/provisioning/generate.ts, ADR-0074), or add an exception with its reason");
  });

  it("each exception still matches a read (a stale one fails)", () => {
    const all = sources();
    for (const e of EXCEPTIONS) {
      const src = all.find((s) => s.rel === e.file);
      assert.ok(src, `${e.file} is no longer read`);
      assert.match(src.code, readPattern(e.key), `${e.file} no longer reads ${e.key}: remove the exception`);
      assert.ok(PORTAL_ONLY_KEYS.some((k) => k.split(".").at(-1) === e.key), `${e.key} is not on the list`);
    }
  });

  it("would catch a new read (the guard works)", () => {
    for (const [line, leaf] of [
      ["const s = inst.setup?.confirmed;", "setup"],
      ["const l = inst?.lifecycle;", "lifecycle"],
      ['const d = own(o, "auditRetentionDays");', "auditRetentionDays"],
      ['x = cfg["primaryColor"]', "primaryColor"],
      ["jq -r '.lifecycle.maxBuildAgeDays' instance.json", "lifecycle"],
      ['instanceDefault("properties/lifecycle/properties/maxBuildAgeDays")', "lifecycle"],
    ] as const) {
      assert.match(line, readPattern(leaf), line);
    }
    for (const [line, leaf] of [
      ["- template: ../steps/setup.yml", "setup"],
      ["resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {", "lifecycle"],
      ["lifecycle: 'All'", "lifecycle"],
    ] as const) {
      assert.doesNotMatch(line, readPattern(leaf), line);
    }
  });
});
