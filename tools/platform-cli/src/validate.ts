import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./allowlist.js";
import { environmentsInUseOf } from "./network-change.js";
import type { AppEnvironmentsView } from "./network-change.js";
import { parseYaml, validateData } from "./schema.js";
import type { SchemaKind, SchemaProblem } from "./schema.js";
import { readAtRef } from "./validate-app.js";
import type { Finding } from "./validate-app.js";
import { instanceChangeChecks, instanceWarnings } from "./validate-instance-change.js";
import type { EnvironmentNetworkView, InstanceWarningView } from "./validate-instance-change.js";
import { instanceSelfChecks } from "./validate-instance.js";
import type { InstanceSelfView } from "./validate-instance.js";

export interface ValidateResult {
  kind: SchemaKind;
  file: string;
  ok: boolean;
  parseErrors: { message: string; line: number; column: number }[];
  problems: SchemaProblem[];
  /** Instance only: rules the schema cannot express (errors), run on a schema-valid file. */
  checks?: Finding[];
  /** Instance only: findings that don't fail the run (validate-instance-change.ts instanceWarnings). */
  warnings?: Finding[];
  /** Instance with --base: the git ref compared against, and whether instance.yaml existed there. */
  base?: { ref: string; found: boolean };
}

/**
 * The parsed app definitions (apps/<slug>/app.yaml) beside an instance.yaml: their environments only.
 * Never the archive of deleted apps (apps-deleted/, ADR-0061): it is never provisioned.
 */
function appsBeside(instanceFile: string): AppEnvironmentsView[] {
  const appsDir = join(dirname(resolve(instanceFile)), "apps");
  const out: AppEnvironmentsView[] = [];
  let entries: string[] = [];
  try {
    entries = readdirSync(appsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return out;
  }
  for (const name of entries) {
    const f = join(appsDir, name, "app.yaml");
    try {
      const st = lstatSync(f);
      if (!st.isFile() || st.size > 1024 * 1024) continue;
    } catch {
      continue;
    }
    const p = parseYaml(readFileSync(f, "utf8"));
    if (!p.parseErrors.length && p.data && typeof p.data === "object") out.push(p.data as AppEnvironmentsView);
  }
  return out;
}

/** The app definitions at a git ref (apps/<slug>/app.yaml beside the instance.yaml in that tree; never apps-deleted/). */
function appsAtRef(instanceFile: string, ref: string): AppEnvironmentsView[] {
  const abs = realpathSync(resolve(instanceFile));
  const top = spawnSync("git", ["-C", dirname(abs), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new UsageError(`--base needs ${instanceFile} to be inside a git work tree.`);
  const root = realpathSync(top.stdout.trim());
  const dir = relative(root, dirname(abs)).split(sep).join("/");
  const apps = dir ? `${dir}/apps/` : "apps/";
  const list = spawnSync("git", ["-C", root, "ls-tree", "-r", "--name-only", ref, "--", apps], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (list.status !== 0) return [];
  const out: AppEnvironmentsView[] = [];
  for (const path of list.stdout.split("\n")) {
    if (!/^(.*\/)?apps\/[a-z0-9-]{1,40}\/app\.yaml$/.test(path) || !path.startsWith(apps)) continue;
    const show = spawnSync("git", ["-C", root, "show", `${ref}:${path}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    if (show.status !== 0) continue;
    const p = parseYaml(show.stdout);
    if (!p.parseErrors.length && p.data && typeof p.data === "object") out.push(p.data as AppEnvironmentsView);
  }
  return out;
}

/**
 * `platform validate manifest|app|instance <file>`. For an instance, `base` (a git ref, the pull
 * request's target branch) adds the checks against that version: the network of an environment that
 * an app uses (apps/*\/app.yaml beside the file, now or at the ref) doesn't change.
 */
export function validateFile(kind: SchemaKind, file: string, opts: { base?: string } = {}): ValidateResult {
  const text = readFileSync(file, "utf8"); // throws ENOENT -> exit 2 in the CLI
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) {
    return { kind, file, ok: false, parseErrors: parsed.parseErrors, problems: [] };
  }
  const problems = validateData(kind, parsed.data, parsed);
  if (kind !== "instance") return { kind, file, ok: problems.length === 0, parseErrors: [], problems };
  // Semantic checks need a schema-valid document.
  if (problems.length > 0) return { kind, file, ok: false, parseErrors: [], problems, checks: [], warnings: [] };
  const checks = instanceSelfChecks(parsed.data as InstanceSelfView, parsed);
  const warnings = instanceWarnings(parsed.data as InstanceWarningView, parsed);
  let base: ValidateResult["base"];
  if (opts.base !== undefined) {
    const baseText = readAtRef(file, opts.base);
    base = { ref: opts.base, found: baseText !== undefined };
    const old = baseText !== undefined ? parseYaml(baseText) : undefined;
    if (old && !old.parseErrors.length && validateData("instance", old.data, old).length === 0) {
      const inUse = environmentsInUseOf([...appsBeside(file), ...appsAtRef(file, opts.base)]);
      checks.push(...instanceChangeChecks(old.data as EnvironmentNetworkView, parsed.data as EnvironmentNetworkView, inUse, parsed));
    }
  }
  return { kind, file, ok: checks.length === 0, parseErrors: [], problems, checks, warnings, ...(base ? { base } : {}) };
}

export function formatValidateText(r: ValidateResult): string {
  const label = r.kind === "manifest" ? "app runtime settings file (platform.yaml)" : r.kind === "app" ? "app definition (app.yaml)" : "instance configuration";
  const lines: string[] = [];
  if (r.ok) lines.push(`OK  ${r.file} is a valid ${label}.`);
  else {
    lines.push(`FAILED  ${r.file} is not a valid ${label}:`);
    for (const e of r.parseErrors) lines.push(`  line ${e.line}: YAML syntax error: ${e.message}`);
    for (const p of r.problems) {
      lines.push(`  ${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}`);
      if (p.help) lines.push(`      ${p.help}`);
    }
    for (const c of r.checks ?? []) lines.push(`  ${c.line ? `line ${c.line}: ` : ""}${c.path}: ${c.message}`);
  }
  if (r.warnings?.length) {
    lines.push("Warnings:");
    for (const w of r.warnings) lines.push(`  ${w.line ? `line ${w.line}: ` : ""}${w.path}: ${w.message}${w.checkId ? ` (platform rules --explain ${w.checkId})` : ""}`);
  }
  if (r.base && !r.base.found) lines.push(`Note: ${r.file} did not exist at ${r.base.ref}; nothing was compared.`);
  return lines.join("\n") + "\n";
}
