import { lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Agent-file layout (ADR-0013 / agent tooling spike). The built-in default is the ADR layout and
 * equals what templates/app/manifest.json describes (a test keeps them in sync). The template
 * manifest is the single source of truth for the app repo layout; loadLayout() derives the
 * CLI's view of it.
 */

export type StubMode = "create" | "startsWith" | "json-subset" | "contains-lines" | "exact";

export interface StubSpec {
  /** Path relative to the repository root. */
  path: string;
  mode: StubMode;
  /**
   * What must be true of the file. string: required prefix / lines / exact text.
   * object: required JSON subset (json-subset mode).
   */
  content: string | Record<string, unknown>;
  /** Full text written when the file does not exist. Defaults to `content`. */
  create?: string;
  severity: "error" | "warning";
  ruleId: "PC052" | "PC055";
}

export interface AgentLayout {
  skillsSource: string;
  skillMirrors: string[];
  stubs: StubSpec[];
  /** AGENTS.md must be smaller than this many bytes. */
  agentsMdMaxBytes: number;
  source: "built-in" | string;
}

export const AGENTS_MD_MAX_BYTES = 32 * 1024;

// Texts written when a stub file is missing. They equal the template sources under
// templates/app/agent-files/ (a test compares them), so a sync with and without --manifest
// produces the same files.
const CLAUDE_MD_CREATE = "@AGENTS.md\n";
const CLAUDE_SETTINGS_CREATE = `{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(platform check)",
      "Bash(platform check *)",
      "Bash(platform deploy status)",
      "Bash(platform deploy status *)",
      "Bash(platform app roles)",
      "Bash(platform app roles *)",
      "Bash(platform preview)",
      "Bash(platform preview *)"
    ],
    "deny": [
      "Read(./.env)",
      "Read(./.env.*)"
    ]
  }
}
`;
const GEMINI_SETTINGS_CREATE = `{
  "context": {
    "fileName": ["AGENTS.md"]
  }
}
`;
const GITATTRIBUTES_CREATE = `# Normalise line endings to LF everywhere (agent skill mirrors must stay byte-identical on Windows).
* text=auto eol=lf

# Binary files: never touch.
*.png binary
*.jpg binary
*.jpeg binary
*.gif binary
*.webp binary
*.ico binary
*.pdf binary
*.zip binary
*.woff binary
*.woff2 binary
`;
const COPILOT_CREATE =
  "Follow the instructions in [AGENTS.md](../AGENTS.md) at the repository root. Task-specific skills are in `.agents/skills/`.\n";

export function defaultLayout(): AgentLayout {
  return {
    skillsSource: ".agents/skills",
    skillMirrors: [".claude/skills"],
    agentsMdMaxBytes: AGENTS_MD_MAX_BYTES,
    source: "built-in",
    stubs: [
      { path: "CLAUDE.md", mode: "startsWith", content: "@AGENTS.md\n", create: CLAUDE_MD_CREATE, severity: "error", ruleId: "PC052" },
      { path: ".gemini/settings.json", mode: "json-subset", content: { context: { fileName: ["AGENTS.md"] } }, create: GEMINI_SETTINGS_CREATE, severity: "warning", ruleId: "PC055" },
      {
        path: ".claude/settings.json",
        mode: "create",
        content: { permissions: { allow: ["Bash(platform check *)"], deny: ["Read(./.env)", "Read(./.env.*)"] } },
        create: CLAUDE_SETTINGS_CREATE,
        severity: "warning",
        ruleId: "PC055",
      },
      { path: ".gitattributes", mode: "contains-lines", content: "* text=auto eol=lf\n", create: GITATTRIBUTES_CREATE, severity: "warning", ruleId: "PC055" },
      { path: ".github/copilot-instructions.md", mode: "create", content: COPILOT_CREATE, create: COPILOT_CREATE, severity: "warning", ruleId: "PC055" },
    ],
  };
}

interface ManifestFileEntry {
  source?: string;
  target?: string;
  from?: string;
  mode?: string;
  type?: string;
  /** Content made by `platform repo render` (the app's theme), no source file. */
  generate?: string;
  /** Written only for some apps (`theme`): never a stub, never synced. */
  when?: string;
}

/**
 * Reads the app template manifest (templates/app/manifest.json, `formatVersion` 1, documented in
 * templates/README.md) and derives the agent-file layout from it:
 *
 * - `files` entries of `type: "mirror"` give the skill mirrors; the `from` of the first one is the
 *   skills source (`.agents/skills`). Without a mirror entry no mirror is checked.
 * - A built-in stub (CLAUDE.md, .gemini/settings.json, .claude/settings.json, .gitattributes,
 *   .github/copilot-instructions.md) is checked only when its path is both a `files` target and in
 *   `syncAgentFiles`. HOW it is checked (mode, severity, rule) is the CLI's own rule; WHAT is
 *   written when it is missing is the template source file, when that file exists next to the
 *   manifest and has no `{{placeholder}}`.
 * - Any other single-file target in `syncAgentFiles` (not AGENTS.md, not a skills folder) becomes a
 *   "create" stub: written when missing (if its template source has no placeholder), never judged.
 * - Conditional entries (`when`, e.g. the theme files, some of them `generate`d without a source)
 *   depend on the app definition, which this layout doesn't know: they are never stubs and may not
 *   be listed in `syncAgentFiles`.
 * - The AGENTS.md size limit is not in the manifest: it stays 32 KiB.
 *
 * Source paths in the manifest are relative to `templates/`, which is the parent of the folder
 * that holds the manifest (templates/app/manifest.json -> templates/).
 */
export function loadLayout(manifestPath?: string): AgentLayout {
  const layout = defaultLayout();
  if (!manifestPath) return layout;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (e) {
    throw new Error(`Cannot read template manifest ${manifestPath}: ${(e as Error).message}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Template manifest ${manifestPath} must be a JSON object.`);
  const m = raw as Record<string, unknown>;
  if (m.formatVersion !== 1) {
    throw new Error(`Template manifest ${manifestPath}: unsupported formatVersion ${JSON.stringify(m.formatVersion)} (this CLI reads 1).`);
  }
  if (!Array.isArray(m.files)) throw new Error(`Template manifest ${manifestPath}: "files" must be an array.`);
  const files = (m.files as unknown[]).map((f, i) => {
    if (!f || typeof f !== "object") throw new Error(`Template manifest ${manifestPath}: files[${i}] must be an object.`);
    const e = f as ManifestFileEntry;
    if (e.type === "mirror") {
      if (typeof e.from !== "string" || typeof e.target !== "string") throw new Error(`Template manifest ${manifestPath}: files[${i}] (mirror) needs "from" and "target".`);
    } else if (typeof e.target !== "string" || (typeof e.source !== "string" && (typeof e.generate !== "string" || e.when === undefined))) {
      throw new Error(`Template manifest ${manifestPath}: files[${i}] needs "source" (or "generate" with "when") and "target".`);
    }
    return e;
  });
  const syncList = Array.isArray(m.syncAgentFiles) ? (m.syncAgentFiles as unknown[]).filter((x): x is string => typeof x === "string") : undefined;
  for (const e of files) {
    if (e.when !== undefined && syncList?.includes(e.target as string)) {
      throw new Error(`Template manifest ${manifestPath}: ${e.target} is conditional ("when") and can't be in "syncAgentFiles".`);
    }
  }

  // Skill mirrors.
  const mirrors = files.filter((e) => e.type === "mirror");
  layout.skillMirrors = [];
  if (mirrors.length) {
    layout.skillsSource = mirrors[0]?.from as string;
    layout.skillMirrors = mirrors.filter((e) => e.from === layout.skillsSource).map((e) => e.target as string);
  }

  // Stubs.
  const templatesRoot = resolve(dirname(manifestPath), "..");
  const readSource = (e: ManifestFileEntry | undefined): string | undefined => {
    if (!e?.source || e.type === "dir") return undefined;
    try {
      const text = readFileSync(join(templatesRoot, e.source), "utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");
      return /\{\{[A-Z_]+\}\}/.test(text) ? undefined : text;
    } catch {
      return undefined;
    }
  };
  const isSkillTarget = (t: string): boolean => t === layout.skillsSource || layout.skillMirrors.includes(t) || t === "AGENTS.md";
  const wanted = (t: string): boolean => syncList === undefined || syncList.includes(t);
  const byTarget = new Map(files.filter((e) => e.type !== "mirror" && e.when === undefined).map((e) => [e.target as string, e]));

  const builtIn = new Map(layout.stubs.map((st) => [st.path, st]));
  const stubs: StubSpec[] = [];
  for (const [target, entry] of byTarget) {
    if (!wanted(target) || isSkillTarget(target) || entry.type === "dir") continue;
    const create = readSource(entry);
    const known = builtIn.get(target);
    if (known) {
      stubs.push({ ...known, ...(create !== undefined ? { create } : {}) });
    } else if (create !== undefined) {
      stubs.push({ path: target, mode: "create", content: create, create, severity: "warning", ruleId: "PC055" });
    }
  }
  layout.stubs = stubs;
  layout.source = manifestPath;
  return layout;
}

// ---------------------------------------------------------------------------------------------
// Planning: the same plan drives `sync-agent-files` (apply) and `--check` / `platform check` (report).

export type ActionKind = "write" | "delete";

export interface SyncAction {
  kind: ActionKind;
  /** Relative path from the repository root, POSIX. */
  path: string;
  content?: Buffer;
  /** Machine-readable cause. */
  cause: "mirror-missing" | "mirror-differs" | "mirror-extra" | "stub-missing" | "stub-fix";
  /** Human text, e.g. "differs from .agents/skills/x/SKILL.md". */
  detail: string;
  stub?: StubSpec;
}

export interface SyncProblem {
  path: string;
  message: string;
  stub?: StubSpec;
}

export interface SyncPlan {
  actions: SyncAction[];
  /** Things sync cannot fix by itself (symlinks in the source, invalid JSON in a stub). */
  problems: SyncProblem[];
}

const toLf = (b: Buffer): string => b.toString("utf8").replace(/^﻿/, "").replace(/\r\n/g, "\n");

function sameContent(a: Buffer, b: Buffer): boolean {
  if (a.equals(b)) return true;
  if (looksBinaryBuf(a) || looksBinaryBuf(b)) return false;
  return toLf(a) === toLf(b);
}

function looksBinaryBuf(b: Buffer): boolean {
  return b.subarray(0, 8192).includes(0);
}

function listTree(root: string, problems: SyncProblem[], relBase: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    const abs = rel ? join(root, rel) : root;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        problems.push({ path: `${relBase}/${childRel}`, message: "is a symbolic link (not allowed, breaks on Windows checkouts)" });
      } else if (e.isDirectory()) walk(childRel);
      else if (e.isFile()) out.push(childRel);
    }
  };
  if (existsSync(root) && lstatSync(root).isDirectory()) walk("");
  return out.sort();
}

function deepSubset(required: unknown, actual: unknown): boolean {
  if (Array.isArray(required)) {
    return Array.isArray(actual) && required.every((r) => actual.some((x) => deepSubset(r, x)));
  }
  if (required && typeof required === "object") {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(required as Record<string, unknown>).every(([k, v]) => deepSubset(v, (actual as Record<string, unknown>)[k]));
  }
  return required === actual;
}

function deepMerge(base: unknown, add: unknown): unknown {
  if (Array.isArray(add)) {
    const out = Array.isArray(base) ? [...base] : [];
    for (const item of add) if (!out.some((x) => JSON.stringify(x) === JSON.stringify(item))) out.push(item);
    return out;
  }
  if (add && typeof add === "object") {
    const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as Record<string, unknown>) } : {};
    for (const [k, v] of Object.entries(add as Record<string, unknown>)) out[k] = deepMerge(out[k], v);
    return out;
  }
  return add;
}

export function stubCreateText(stub: StubSpec): string {
  if (stub.create !== undefined) return stub.create;
  return typeof stub.content === "string" ? stub.content : JSON.stringify(stub.content, null, 2) + "\n";
}

export function planSync(dir: string, layout: AgentLayout): SyncPlan {
  const actions: SyncAction[] = [];
  const problems: SyncProblem[] = [];

  // 1. Skill mirrors.
  const srcRoot = join(dir, layout.skillsSource);
  const srcFiles = listTree(srcRoot, problems, layout.skillsSource);
  for (const mirror of layout.skillMirrors) {
    const dstRoot = join(dir, mirror);
    const dstFiles = listTree(dstRoot, problems, mirror);
    for (const f of srcFiles) {
      const src = readFileSync(join(srcRoot, f));
      const dstPath = join(dstRoot, f);
      if (!dstFiles.includes(f)) {
        actions.push({ kind: "write", path: `${mirror}/${f}`, content: src, cause: "mirror-missing", detail: `missing (copy of ${layout.skillsSource}/${f})` });
      } else if (!sameContent(src, readFileSync(dstPath))) {
        actions.push({ kind: "write", path: `${mirror}/${f}`, content: src, cause: "mirror-differs", detail: `differs from ${layout.skillsSource}/${f}` });
      }
    }
    for (const f of dstFiles) {
      if (!srcFiles.includes(f)) {
        actions.push({ kind: "delete", path: `${mirror}/${f}`, cause: "mirror-extra", detail: `does not exist in ${layout.skillsSource}/` });
      }
    }
  }

  // 2. Stub files.
  for (const stub of layout.stubs) {
    const abs = join(dir, stub.path);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      actions.push({ kind: "write", path: stub.path, content: Buffer.from(stubCreateText(stub)), cause: "stub-missing", detail: "missing", stub });
      continue;
    }
    if (st.isSymbolicLink()) continue; // reported by the symlink check
    if (!st.isFile()) continue;
    const current = readFileSync(abs);
    const text = toLf(current);
    const fix = (newText: string, detail: string): void => {
      actions.push({ kind: "write", path: stub.path, content: Buffer.from(newText), cause: "stub-fix", detail, stub });
    };
    switch (stub.mode) {
      case "create":
        break;
      case "startsWith": {
        const want = String(stub.content);
        if (!text.startsWith(want.replace(/\n$/, "") + "\n") && text.trimEnd() !== want.trimEnd()) {
          fix(want + (text.length ? "\n" : "") + text, `must start with ${JSON.stringify(want.trim())}`);
        }
        break;
      }
      case "contains-lines": {
        const lines = text.split("\n").map((l) => l.trim());
        const missing = String(stub.content)
          .split("\n")
          .map((l) => l.trim())
          .filter((l) => l && !lines.includes(l));
        if (missing.length) fix(text + (text === "" || text.endsWith("\n") ? "" : "\n") + missing.join("\n") + "\n", `must contain: ${missing.join(" | ")}`);
        break;
      }
      case "exact": {
        const want = typeof stub.content === "string" ? stub.content : JSON.stringify(stub.content, null, 2) + "\n";
        if (text !== want.replace(/\r\n/g, "\n")) fix(want, "differs from the expected content");
        break;
      }
      case "json-subset": {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          problems.push({ path: stub.path, message: "is not valid JSON, fix it by hand or delete it and re-run sync", stub });
          break;
        }
        if (!deepSubset(stub.content, parsed)) {
          fix(JSON.stringify(deepMerge(parsed, stub.content), null, 2) + "\n", `must contain ${JSON.stringify(stub.content)}`);
        }
        break;
      }
    }
  }
  return { actions, problems };
}

export function applyPlan(dir: string, plan: SyncPlan): void {
  for (const a of plan.actions) {
    const abs = join(dir, a.path);
    if (a.kind === "write") {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, a.content ?? Buffer.alloc(0));
    } else {
      rmSync(abs, { force: true });
      // prune empty parent folders up to (not including) the mirror root's parent
      let d = dirname(abs);
      while (d.startsWith(dir) && d !== dir) {
        try {
          if (readdirSync(d).length) break;
          rmdirSync(d);
        } catch {
          break;
        }
        d = dirname(d);
      }
    }
  }
}
