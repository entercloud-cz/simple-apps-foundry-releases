import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CheckFailed, UsageError } from "../pipeline/common.js";
import { appResultLines, instanceEnvironmentsOrdered, parseInstanceText } from "../provisioning/model.js";
import type { Instance } from "../provisioning/model.js";
import { parseYaml, schemaDir } from "../schema.js";
import { THEME_CUSTOM, THEME_NONE, appThemeById, appThemeChoices, customThemePlaceholder, themeJson, themeSeedCss } from "../themes.js";
import type { AppTheme } from "../themes.js";
import { REPOSITORY_TEMPLATES, UNSAFE_TEXT, instanceProblems, repositoryTemplate, validateAppText } from "../validate-app.js";
import type { AppData, RepositoryTemplate } from "../validate-app.js";
import { toolVersion } from "../version.js";

/**
 * `platform repo render` (ADR-0039): the starter of an app repository, rendered from the template
 * manifest (templates/app/manifest.json, format in templates/README.md) and the app's stack.
 *
 * - A stack (node-ts, python-fastapi, dotnet): every file of templates/stacks/<stack>/ (mode
 *   create), then every `files` entry of the manifest. Provisioning pushes the result as the one
 *   commit that creates `main` of an empty repository.
 * - byo: only the manifest entries whose target is listed in `onboarding` (agent files and
 *   platform.yaml), applied to the repository's current files. Provisioning proposes the result in
 *   a pull request; it never pushes to the default branch.
 * - No repository.template: unmanaged (definitions from before ADR-0039). There is nothing to
 *   render; it is an error unless `template` is given explicitly.
 *
 * Modes are applied against `existing` (the target repository's current files): `create` never
 * overwrites, `managed` always writes (`preserveBlock` keeps the block of the existing file),
 * `mergeLines` appends the missing lines, `mirror` makes the target a copy of its source in the
 * result. The result lists only the files that change. The output is deterministic: the same
 * inputs, date and templates give the same bytes, sorted by path.
 *
 * The app's theme (ADR-0044, app.yaml `ui.theme`, or `theme` in the options): entries with
 * `"when": "theme"` are written only for an offered theme or `custom`, never for `none` (or no
 * `ui`). Their `generate` content comes from themes.ts: theme/theme.css and theme/theme.json with
 * the theme's tokens, or for `custom` the first built-in theme's tokens marked as placeholders.
 */

export interface RepoRenderOptions {
  /** templates/ of the core release (holds app/manifest.json and stacks/). Default: defaultTemplatesDir(). */
  templatesDir?: string;
  /** CREATED_DATE, YYYY-MM-DD. Default: today (UTC). */
  date?: string;
  /** Override of the app's repository.template, e.g. "byo" to onboard a repository that already has content. */
  template?: RepositoryTemplate;
  /**
   * The repository's current files below repoRenderScope() (POSIX paths relative to the repository
   * root). Absent paths count as missing. Default: an empty repository.
   */
  existing?: ReadonlyMap<string, Buffer>;
  /** Path of the app definition, for messages and the slug == directory check. Default apps/<slug>/app.yaml. */
  appPath?: string;
  /** Override of the app's ui.theme: a theme id the instance offers, `none` or `custom`. */
  theme?: string;
}

export interface RenderedFile {
  /** POSIX path relative to the repository root. */
  path: string;
  /** add = new file, edit = changes an existing file, delete = removed (only in a mirror target). */
  change: "add" | "edit" | "delete";
  /** The new content (empty for delete). */
  content: Buffer;
}

export interface RepoRender {
  slug: string;
  template: RepositoryTemplate;
  /** The theme written (a theme id or `custom`), or `none`: no theme, or a template without theme files (byo). */
  theme: string;
  /** The files that change, sorted by path. */
  files: RenderedFile[];
}

export interface RepoRenderScope {
  /** Single files the render writes or reads. */
  files: string[];
  /** Folders whose whole content the render reads (skills and their mirrors). */
  dirs: string[];
}

interface ManifestEntry {
  source?: string;
  target: string;
  from?: string;
  mode?: "create" | "managed" | "mergeLines";
  type?: "dir" | "mirror";
  preserveBlock?: string;
  /** Written only when the condition holds: `theme` = the app has a theme (an offered one or custom). */
  when?: "theme";
  /** Content made by the CLI instead of a source file (needs `when: theme`). */
  generate?: (typeof GENERATORS)[number];
}

/** The `generate` values: the theme of the app (themes.ts). */
const GENERATORS = ["themeCss", "themeJson"] as const;

interface Manifest {
  placeholders: Record<string, { from: "app" | "stack" | "instance" | "core" }>;
  files: ManifestEntry[];
  onboarding: string[];
  stacks: Record<string, { source: string | null; values: Record<string, string> }>;
}

const MANIFEST = "app/manifest.json";
const PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._/-]+$/;
/** A path of the target repository: relative, no `.`/`..` segment, no backslash or NUL. */
const REPO_PATH_RE = /^(?!\/)(?!.*(^|\/)\.\.?(\/|$))[^\\\0]+$/;
const PLACEHOLDER_RE = /\{\{([A-Za-z0-9_]+)\}\}/g;
const MERGE_HEADER = "# Added by the platform template";
/** Shown where the instance has no value yet (portal.apiBaseUrl). */
export const NOT_CONFIGURED = "not configured yet";
/** PLATFORM_DOCS_URL: the instance schema has no documentation link (yet). */
export const DOCS_FALLBACK = "ask the platform team";

/** templates/ next to the CLI in a core checkout (tools/platform-cli/dist/src/repo -> repo root). */
export function defaultTemplatesDir(): string | undefined {
  const dir = resolve(import.meta.dirname, "..", "..", "..", "..", "..", "templates");
  return existsSync(join(dir, MANIFEST)) ? dir : undefined;
}

function templatesDirOf(opts: { templatesDir?: string }): string {
  const dir = opts.templatesDir ?? defaultTemplatesDir();
  if (!dir) throw new UsageError("the app templates were not found next to the CLI; pass --templates <core checkout>/templates.");
  if (!existsSync(join(dir, MANIFEST))) throw new UsageError(`${dir} has no ${MANIFEST}: --templates must be the templates/ folder of a core checkout.`);
  return dir;
}

function bad(msg: string): never {
  throw new CheckFailed([`templates/${MANIFEST}: ${msg}`]);
}

/** Reads and checks the parts of manifest.json (formatVersion 1) the renderer uses. */
export function loadManifest(templatesDir: string): Manifest {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(templatesDir, MANIFEST), "utf8"));
  } catch (e) {
    bad(`cannot be read (${(e as Error).message}).`);
  }
  const m = raw as Record<string, unknown>;
  if (!m || typeof m !== "object" || m.formatVersion !== 1) bad("formatVersion must be 1.");
  if (!m.placeholders || typeof m.placeholders !== "object") bad('"placeholders" must be an object.');
  if (!Array.isArray(m.files)) bad('"files" must be an array.');
  if (!Array.isArray(m.onboarding) || !m.onboarding.every((t) => typeof t === "string")) bad('"onboarding" must be a list of targets.');
  if (!m.stacks || typeof m.stacks !== "object") bad('"stacks" must be an object.');
  const files = (m.files as ManifestEntry[]).map((e, i) => {
    if (!e || typeof e !== "object" || typeof e.target !== "string" || !PATH_RE.test(e.target)) bad(`files[${i}] needs a relative "target".`);
    if (e.when !== undefined && e.when !== "theme") bad(`files[${i}] has an unknown "when" ${JSON.stringify(e.when)} (theme).`);
    if (e.type === "mirror") {
      if (typeof e.from !== "string" || !PATH_RE.test(e.from)) bad(`files[${i}] (mirror) needs a relative "from".`);
      if (e.when !== undefined) bad(`files[${i}]: a mirror can't have "when".`);
    } else if (e.generate !== undefined) {
      if (!GENERATORS.includes(e.generate)) bad(`files[${i}] has an unknown "generate" ${JSON.stringify(e.generate)} (${GENERATORS.join(", ")}).`);
      if (e.source !== undefined || e.type !== undefined || e.preserveBlock !== undefined) bad(`files[${i}]: a generated file has no "source", "type" or "preserveBlock".`);
      if (e.when !== "theme") bad(`files[${i}]: a generated theme file needs "when": "theme".`);
      if (!["create", "managed"].includes(String(e.mode))) bad(`files[${i}]: a generated file needs mode create or managed.`);
    } else {
      if (typeof e.source !== "string" || !PATH_RE.test(e.source)) bad(`files[${i}] needs a relative "source".`);
      if (!["create", "managed", "mergeLines"].includes(String(e.mode))) bad(`files[${i}] has an unknown mode ${JSON.stringify(e.mode)}.`);
      if (e.type === "dir" && e.mode === "mergeLines") bad(`files[${i}]: a dir entry can't use mergeLines.`);
      if (e.preserveBlock !== undefined && (e.mode !== "managed" || !/^[a-z][a-z0-9-]*$/.test(e.preserveBlock))) bad(`files[${i}]: preserveBlock needs mode managed and an id.`);
    }
    return e;
  });
  const targets = new Set(files.map((e) => e.target));
  for (const t of m.onboarding as string[]) if (!targets.has(t)) bad(`onboarding target ${t} is not a target of "files".`);
  const stacks = m.stacks as Manifest["stacks"];
  for (const id of REPOSITORY_TEMPLATES) {
    const st = stacks[id];
    if (!st || typeof st.values !== "object") bad(`stacks.${id} is missing.`);
    if ((id === "byo") !== (st.source === null)) bad(`stacks.${id}.source must be ${id === "byo" ? "null" : "a folder"}.`);
    if (st.source !== null && !PATH_RE.test(st.source)) bad(`stacks.${id}.source must be a relative folder.`);
  }
  return { placeholders: m.placeholders as Manifest["placeholders"], files, onboarding: m.onboarding as string[], stacks };
}

/** Files of a template folder, sorted, POSIX paths relative to it. Symbolic links are refused. */
function listTemplateDir(root: string, label: string): string[] {
  const out: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(rel ? join(root, rel) : root, { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) throw new CheckFailed([`${label}/${child} is a symbolic link, which is not allowed in templates.`]);
      if (e.isDirectory()) walk(child);
      else if (e.isFile()) out.push(child);
    }
  };
  if (!existsSync(root) || !lstatSync(root).isDirectory()) throw new CheckFailed([`${label} is not a folder.`]);
  walk("");
  return out.sort();
}

const stripTmpl = (p: string): string => (p.endsWith(".tmpl") ? p.slice(0, -".tmpl".length) : p);

function entriesFor(m: Manifest, template: RepositoryTemplate): ManifestEntry[] {
  return template === "byo" ? m.files.filter((e) => m.onboarding.includes(e.target)) : m.files;
}

/**
 * The paths a render of `template` writes or reads: what provisioning has to fetch from a
 * repository with content (byo) to pass it as `existing`.
 */
export function repoRenderScope(template: RepositoryTemplate, opts: { templatesDir?: string } = {}): RepoRenderScope {
  const dir = templatesDirOf(opts);
  const m = loadManifest(dir);
  const files = new Set<string>();
  const dirs = new Set<string>();
  const stack = m.stacks[template]?.source;
  if (template !== "byo" && stack) for (const f of listTemplateDir(join(dir, stack), `templates/${stack}`)) files.add(stripTmpl(f));
  for (const e of entriesFor(m, template)) {
    if (e.type === "dir" || e.type === "mirror") {
      dirs.add(e.target);
      if (e.from) dirs.add(e.from);
    } else files.add(e.target);
  }
  return { files: [...files].sort(), dirs: [...dirs].sort() };
}

function manifestSchemaVersion(): string {
  const schema = JSON.parse(readFileSync(join(schemaDir(), "app-manifest.schema.json"), "utf8")) as { properties?: { schemaVersion?: { const?: unknown } } };
  const v = schema.properties?.schemaVersion?.const;
  if (typeof v !== "string") throw new Error("app-manifest.schema.json has no schemaVersion const");
  return v;
}

function checkDate(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const d = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : undefined;
  if (!m || !d || d.toISOString().slice(0, 10) !== date) throw new UsageError(`--date "${date.slice(0, 40)}" is not a date (YYYY-MM-DD).`);
  return date;
}

/** Every placeholder value (templates/README.md: manifest.json `placeholders`). */
export function placeholderValues(app: AppData, inst: Instance, template: RepositoryTemplate, m: Manifest, date: string): Record<string, string> {
  const base = inst.portal?.apiBaseUrl;
  const values: Record<string, string> = {
    APP_NAME: app.title,
    APP_SLUG: app.slug,
    APP_DESCRIPTION: app.description?.trim() || "No description yet.",
    CREATED_DATE: date,
    STACK: template,
    ...m.stacks[template]?.values,
    PORTAL_URL: base ?? NOT_CONFIGURED,
    APP_PORTAL_URL: base ? `${base}/apps/${app.slug}` : NOT_CONFIGURED,
    PLATFORM_DOCS_URL: DOCS_FALLBACK,
    ENVIRONMENT_NAMES: instanceEnvironmentsOrdered(inst)
      .map((e) => e.name)
      .join(", "),
    TEMPLATE_VERSION: inst.coreVersion,
    PLATFORM_CLI_VERSION: toolVersion(),
    MANIFEST_SCHEMA_VERSION: manifestSchemaVersion(),
  };
  const problems: string[] = [];
  for (const [name, spec] of Object.entries(m.placeholders)) {
    const v = values[name];
    if (v === undefined || v === "") problems.push(`placeholder ${name} has no value.`);
    else if (/[\r\n]|\{\{/.test(v)) problems.push(`the value of ${name} contains a line break or "{{".`);
    else if (spec.from === "app" && UNSAFE_TEXT.test(v)) problems.push(`the value of ${name} contains a backtick, |, < or >.`);
  }
  if (problems.length) throw new CheckFailed(problems);
  return values;
}

function render(text: string, values: Record<string, string>, m: Manifest, label: string): string {
  return text.replace(PLACEHOLDER_RE, (_all, name: string) => {
    if (!Object.hasOwn(m.placeholders, name)) throw new CheckFailed([`${label} uses {{${name}}}, which manifest.json does not list.`]);
    return values[name] as string;
  });
}

/** A template file as written to the repository: .tmpl rendered (UTF-8 without BOM, LF), anything else byte for byte. */
function produce(abs: string, rel: string, values: Record<string, string>, m: Manifest): Buffer {
  const raw = readFileSync(abs);
  if (!rel.endsWith(".tmpl")) return raw;
  const text = new TextDecoder("utf-8", { fatal: true }).decode(raw).replace(/^﻿/, "").replace(/\r\n/g, "\n");
  return Buffer.from(render(text, values, m, `templates/${rel}`), "utf8");
}

function mergeLines(current: Buffer, source: Buffer): Buffer {
  const text = current.toString("utf8");
  const have = new Set(text.split("\n").map((l) => l.replace(/\r$/, "")));
  const missing: string[] = [];
  for (const line of source.toString("utf8").split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#") || have.has(line) || missing.includes(line)) continue;
    missing.push(line);
  }
  if (!missing.length) return current;
  const sep = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return Buffer.from(`${text}${sep}${MERGE_HEADER}\n${missing.join("\n")}\n`, "utf8");
}

/**
 * Managed file with a preserved block: the new text, with the text between `<!-- <id>:start…`
 * (rest of that line included in the marker) and `<!-- <id>:end -->` taken from the existing file.
 * An existing file without the block (a bring-your-own AGENTS.md) moves into the block whole, so
 * nothing the owner wrote is lost.
 */
function preserve(next: Buffer, current: Buffer, id: string, label: string): Buffer {
  const start = `<!-- ${id}:start`;
  const end = `<!-- ${id}:end -->`;
  const region = (t: string): [number, number] | undefined => {
    const s = t.indexOf(start);
    if (s < 0) return undefined;
    const lineEnd = t.indexOf("\n", s);
    const e = lineEnd < 0 ? -1 : t.indexOf(end, lineEnd + 1);
    return e < 0 ? undefined : [lineEnd + 1, e];
  };
  const n = next.toString("utf8");
  const nr = region(n);
  if (!nr) throw new CheckFailed([`${label} has no ${start} ... ${end} block (preserveBlock).`]);
  const c = current.toString("utf8");
  const cr = region(c);
  let kept = cr ? c.slice(cr[0], cr[1]) : c;
  if (kept && !kept.endsWith("\n")) kept += "\n";
  return Buffer.from(n.slice(0, nr[0]) + kept + n.slice(nr[1]), "utf8");
}

/** The theme a render writes (ADR-0044); undefined for `none`. */
interface SeedTheme {
  theme: AppTheme;
  /** custom: the tokens are placeholders for the team's own brand. */
  placeholder: boolean;
}

/**
 * The app's theme for the seed: `opts.theme`, else app.yaml ui.theme, else none. An id the
 * instance doesn't offer is a usage error for the override and a CheckFailed for the definition
 * (`platform validate app --instance` refuses it too).
 */
function seedTheme(app: AppData, inst: Instance, override: string | undefined): { choice: string; seed?: SeedTheme } {
  const choice = override ?? app.ui?.theme ?? THEME_NONE;
  if (choice === THEME_NONE) return { choice };
  if (choice === THEME_CUSTOM) return { choice, seed: { theme: customThemePlaceholder(), placeholder: true } };
  const theme = appThemeById(inst, choice);
  if (theme) return { choice, seed: { theme, placeholder: false } };
  const msg = `theme "${choice.slice(0, 40)}" is not offered in this instance (${appThemeChoices(inst).join(", ")}).`;
  if (override !== undefined) throw new UsageError(msg);
  throw new CheckFailed([`app ${app.slug}: ui.theme: ${msg}`]);
}

function generated(kind: NonNullable<ManifestEntry["generate"]>, seed: SeedTheme): Buffer {
  return Buffer.from(kind === "themeCss" ? themeSeedCss(seed.theme, seed.placeholder) : themeJson(seed.theme, seed.placeholder), "utf8");
}

/** The core: the files of the starter for a valid app definition and instance. */
export function renderRepoFiles(app: AppData, inst: Instance, opts: RepoRenderOptions = {}): RepoRender {
  const dir = templatesDirOf(opts);
  const m = loadManifest(dir);
  const template = opts.template ?? repositoryTemplate(app);
  if (template === undefined) {
    throw new CheckFailed([
      `app ${app.slug} has no repository.template, so the platform doesn't manage its repository and there is nothing to render (set ${REPOSITORY_TEMPLATES.join(", ")}, or pass a template explicitly).`,
    ]);
  }
  if (!REPOSITORY_TEMPLATES.includes(template)) throw new UsageError(`unknown template "${String(template).slice(0, 40)}" (${REPOSITORY_TEMPLATES.join(", ")}).`);
  const date = checkDate(opts.date ?? new Date().toISOString().slice(0, 10));
  const values = placeholderValues(app, inst, template, m, date);
  const { choice, seed } = seedTheme(app, inst, opts.theme);

  const existing = new Map<string, Buffer>();
  for (const [p, b] of opts.existing ?? []) {
    if (!REPO_PATH_RE.test(p)) throw new CheckFailed([`existing file path "${p.slice(0, 80)}" is not a relative POSIX path.`]);
    existing.set(p, b);
  }
  const tree = new Map(existing);
  const has = (p: string): boolean => tree.has(p);

  // 1. The stack (mode create).
  const stack = m.stacks[template]?.source;
  if (template !== "byo" && stack) {
    for (const rel of listTemplateDir(join(dir, stack), `templates/${stack}`)) {
      const target = stripTmpl(rel);
      if (!has(target)) tree.set(target, produce(join(dir, stack, rel), `${stack}/${rel}`, values, m));
    }
  }

  // 2. The manifest entries, in order; mirrors after all others. Theme entries only with a theme.
  const all = entriesFor(m, template);
  const themed = all.some((e) => e.when === "theme");
  const entries = all.filter((e) => e.when !== "theme" || seed);
  for (const e of entries) {
    if (e.type === "mirror") continue;
    const source = e.source as string;
    if (e.type === "dir") {
      for (const rel of listTemplateDir(join(dir, source), `templates/${source}`)) {
        const target = `${e.target}/${stripTmpl(rel)}`;
        if (e.mode === "managed" || !has(target)) tree.set(target, produce(join(dir, source, rel), `${source}/${rel}`, values, m));
      }
      continue;
    }
    const next = e.generate ? generated(e.generate, seed as SeedTheme) : produce(join(dir, source), source, values, m);
    const current = tree.get(e.target);
    if (e.mode === "create") {
      if (!current) tree.set(e.target, next);
    } else if (e.mode === "mergeLines") {
      tree.set(e.target, current ? mergeLines(current, next) : next);
    } else {
      tree.set(e.target, current && e.preserveBlock ? preserve(next, current, e.preserveBlock, `templates/${source}`) : next);
    }
  }
  const deleted = new Set<string>();
  for (const e of entries) {
    if (e.type !== "mirror") continue;
    const from = `${e.from as string}/`;
    const to = `${e.target}/`;
    const sources = [...tree.keys()].filter((p) => p.startsWith(from));
    for (const p of [...tree.keys()]) {
      if (p.startsWith(to) && !tree.has(from + p.slice(to.length))) {
        tree.delete(p);
        deleted.add(p);
      }
    }
    for (const p of sources) tree.set(to + p.slice(from.length), tree.get(p) as Buffer);
  }

  const files: RenderedFile[] = [];
  for (const [path, content] of tree) {
    const before = existing.get(path);
    if (before === undefined) files.push({ path, change: "add", content });
    else if (!before.equals(content)) files.push({ path, change: "edit", content });
  }
  for (const path of deleted) if (existing.has(path) && !tree.has(path)) files.push({ path, change: "delete", content: Buffer.alloc(0) });
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { slug: app.slug, template, theme: themed && seed ? choice : THEME_NONE, files };
}

/**
 * renderRepoFiles for definitions given as text. The app must pass `platform validate app
 * --instance` (same code); otherwise CheckFailed with one line per problem.
 */
export function renderAppRepo(instanceYamlText: string, appYamlText: string, opts: RepoRenderOptions = {}): RepoRender {
  const iv = instanceProblems(instanceYamlText);
  if (!iv.data) parseInstanceText(instanceYamlText); // throws CheckFailed with the instance problems
  const slug = (parseYaml(appYamlText).data as { slug?: unknown } | undefined)?.slug;
  const appPath = opts.appPath ?? `apps/${typeof slug === "string" && /^[a-z0-9-]{1,64}$/.test(slug) ? slug : "_"}/app.yaml`;
  const r = validateAppText(appYamlText, { file: appPath, instance: { file: "instance.yaml", data: iv.data as NonNullable<typeof iv.data> } });
  if (!r.ok) throw new CheckFailed(appResultLines(r).map((l) => `${appPath}: ${l}`));
  return renderRepoFiles(parseYaml(appYamlText).data as AppData, parseInstanceText(instanceYamlText), opts);
}
