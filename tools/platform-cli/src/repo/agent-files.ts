/**
 * The agent files of an app repository, kept current by the repository itself (ADR-0076): the platform never pushes
 * them. `platform agent-files update` renders them again from the templates this CLI carries (or a core checkout's), and
 * `platform check` warns with PC057 while they are older than those templates.
 *
 * The values AGENTS.md is rendered with come from the repository: its own "This app" table (the platform rendered it),
 * `platform.yaml` (`app`) and `.platform/cli-version`. When the CLI is signed in to the app's portal (`platform login`),
 * the app's current title, purpose, data and stack come from there, so the Data row follows the app's Data tab.
 *
 * The check compares with the repository's own version stamps (template version, CLI version, creation date), so a new
 * core whose agent files say the same doesn't warn; only a real change of the text or the skills does.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import { UsageError } from "../allowlist.js";
import { neutralize } from "../neutralize.js";
import { CheckFailed } from "../pipeline/common.js";
import { REPOSITORY_TEMPLATES, UNSAFE_TEXT } from "../validate-app.js";
import type { RepositoryTemplate } from "../validate-app.js";
import { toolVersion } from "../version.js";
import { DOCS_FALLBACK, NOT_CONFIGURED, agentFileTargets, agentTemplatesDir, appDataText, renderAgentFiles, stackValues } from "./render.js";
import type { RenderedFile } from "./render.js";

const SLUG_RE = /^[a-z](-?[a-z0-9])+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** What AGENTS.md's "This app" table says (old and current template layouts). */
export interface AgentsMdFacts {
  name?: string;
  slug?: string;
  purpose?: string;
  stack?: string;
  data?: string;
  appPortalUrl?: string;
  docs?: string;
  templateVersion?: string;
  created?: string;
  cliVersion?: string;
}

/** The app as the portal shows it (GET /api/apps/{slug}), the parts AGENTS.md uses. */
export interface PortalAppFacts {
  title?: string;
  description?: string;
  data?: { database?: { engine: "postgres" | "azureSql" }; storage?: object };
  template?: string;
}

export function parseAgentsMd(text: string): AgentsMdFacts {
  const f: AgentsMdFacts = {};
  const row = (re: RegExp): RegExpMatchArray | null => {
    for (const line of text.split("\n")) {
      const m = re.exec(line.replace(/\r$/, ""));
      if (m) return m;
    }
    return null;
  };
  const name = row(/^\| Name \| (.+) \(`([a-z0-9-]+)`\) \|$/);
  if (name) [f.name, f.slug] = [name[1], name[2]];
  const purpose = row(/^\| Purpose \| (.*) \|$/);
  if (purpose) f.purpose = purpose[1];
  const stack = row(/^\| Stack \| .+ \(`([a-z-]+)`\) \|$/);
  if (stack) f.stack = stack[1];
  const data = row(/^\| Data \| (.+?)(?:, as the repository was created; .*| \(as of the last agent-files update; .*\)) \|$/);
  if (data) f.data = data[1];
  const portal = row(/^\| Portal page \| (\S+) \|$/);
  if (portal) f.appPortalUrl = portal[1];
  const docs = row(/^\| Platform docs \| (.+) \|$/);
  if (docs) f.docs = docs[1];
  const created = row(/^\| Created from template \| (\S+) on (\d{4}-\d{2}-\d{2}) \|$/) ?? row(/^\| Agent files \| template (\S+); repository created (\d{4}-\d{2}-\d{2}) \|$/);
  if (created) [f.templateVersion, f.created] = [created[1], created[2]];
  const cli = /This repo is pinned to version \*\*([0-9][0-9A-Za-z.+-]*)\*\*/.exec(text);
  if (cli) f.cliVersion = cli[1];
  return f;
}

/** The portal's base address from the app's portal page (…/apps/<slug>), or undefined. */
function portalOf(appPortalUrl: string | undefined, slug: string): string | undefined {
  if (!appPortalUrl || appPortalUrl === NOT_CONFIGURED) return undefined;
  const suffix = `/apps/${slug}`;
  return appPortalUrl.endsWith(suffix) ? appPortalUrl.slice(0, -suffix.length) : undefined;
}

const safe = (v: string | undefined): string | undefined => (v !== undefined && v.trim() !== "" && !UNSAFE_TEXT.test(v) && !/[\r\n]|\{\{/.test(v) ? v.trim() : undefined);

export interface AgentFileValues {
  template: RepositoryTemplate;
  values: Record<string, string>;
  /** Where the values came from, for the report. */
  sources: string[];
}

/**
 * The placeholder values of the repository's agent files. `stamps` "keep": the repository's own template and CLI
 * version and creation date (the check); "current": this CLI's version and the core it comes from (the update).
 */
export function agentFileValues(repoDir: string, templatesDir: string, opts: { stamps: "keep" | "current"; portal?: PortalAppFacts; today?: string }): AgentFileValues {
  const problems: string[] = [];
  const slug = appSlug(repoDir);
  const agentsMd = join(repoDir, "AGENTS.md");
  const facts = existsSync(agentsMd) ? parseAgentsMd(readFileSync(agentsMd, "utf8")) : {};
  if (facts.slug && facts.slug !== slug) problems.push(`AGENTS.md names the app ${facts.slug}, platform.yaml ${slug}.`);
  const p = opts.portal ?? {};
  const template = (safe(p.template) ?? facts.stack) as RepositoryTemplate | undefined;
  if (!template || !REPOSITORY_TEMPLATES.includes(template)) problems.push("the stack is unknown: AGENTS.md has no Stack row (`platform login` lets the portal say it).");
  const name = safe(p.title) ?? facts.name;
  if (!name) problems.push("the app's name is unknown: AGENTS.md has no Name row (`platform login` lets the portal say it).");
  if (problems.length) throw new CheckFailed(problems);
  const cliFile = join(repoDir, ".platform", "cli-version");
  const repoCli = existsSync(cliFile) ? readFileSync(cliFile, "utf8").trim() : facts.cliVersion;
  const keep = opts.stamps === "keep";
  const cliVersion = keep ? (repoCli ?? toolVersion()) : toolVersion();
  const created = facts.created && DATE_RE.test(facts.created) ? facts.created : (opts.today ?? new Date().toISOString().slice(0, 10));
  const appPortalUrl = facts.appPortalUrl ?? NOT_CONFIGURED;
  const data = p.data ? appDataText({ data: p.data as never }) : (facts.data ?? "none yet");
  const values: Record<string, string> = {
    APP_NAME: name as string,
    APP_SLUG: slug,
    APP_DESCRIPTION: safe(p.description) ?? facts.purpose ?? "No description yet.",
    APP_DATA: data,
    CREATED_DATE: created,
    STACK: template as string,
    ...stackValues(templatesDir, template as RepositoryTemplate),
    PORTAL_URL: portalOf(appPortalUrl, slug) ?? NOT_CONFIGURED,
    APP_PORTAL_URL: appPortalUrl,
    PLATFORM_DOCS_URL: facts.docs ?? DOCS_FALLBACK,
    TEMPLATE_VERSION: keep ? (facts.templateVersion ?? `v${cliVersion}`) : `v${toolVersion()}`,
    PLATFORM_CLI_VERSION: cliVersion,
  };
  const sources = [opts.portal ? "the portal (name, purpose, data, stack)" : "AGENTS.md's This app table", "platform.yaml"];
  return { template: template as RepositoryTemplate, values, sources };
}

/** The app's slug from platform.yaml `app`. */
export function appSlug(repoDir: string): string {
  const file = join(repoDir, "platform.yaml");
  if (!existsSync(file)) throw new UsageError(`No platform.yaml in ${repoDir}: run this in the app's repository.`);
  let doc: unknown;
  try {
    doc = parseYaml(readFileSync(file, "utf8"));
  } catch {
    throw new UsageError("platform.yaml is not valid YAML: run platform check.");
  }
  const app = (doc as { app?: unknown } | null)?.app;
  if (typeof app !== "string" || !SLUG_RE.test(app)) throw new UsageError("platform.yaml has no valid `app` (the app's slug): run platform check.");
  return app;
}

/** The repository's current agent files (the targets, and every file below a folder target). */
export function readAgentFiles(repoDir: string, targets: string[]): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const walk = (rel: string): void => {
    const abs = join(repoDir, rel);
    let st;
    try {
      st = lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return; // PC054 reports it; never follow one
    if (st.isDirectory()) {
      for (const name of readdirSync(abs).sort()) walk(`${rel}/${name}`);
    } else if (st.isFile()) out.set(rel, readFileSync(abs));
  };
  for (const t of targets) walk(t);
  return out;
}

/**
 * The agent files that are behind the templates (PC057), or undefined when it can't be told (no platform.yaml, an
 * AGENTS.md the platform didn't render, no templates). `.platform/cli-version` alone doesn't count.
 */
export function agentFilesBehind(repoDir: string, opts: { templatesDir?: string } = {}): string[] | undefined {
  const templatesDir = agentTemplatesDir(opts);
  if (!templatesDir || !existsSync(join(repoDir, "platform.yaml")) || !existsSync(join(repoDir, "AGENTS.md"))) return undefined;
  const facts = parseAgentsMd(readFileSync(join(repoDir, "AGENTS.md"), "utf8"));
  if (!facts.slug || !facts.stack || !facts.templateVersion) return undefined; // not the platform's AGENTS.md
  let v: AgentFileValues;
  try {
    v = agentFileValues(repoDir, templatesDir, { stamps: "keep" });
  } catch {
    return undefined;
  }
  const targets = agentFileTargets(templatesDir);
  const files = renderAgentFiles(templatesDir, v.template, v.values, readAgentFiles(repoDir, targets));
  return files.map((f) => f.path).filter((p) => p !== ".platform/cli-version");
}

/** Writes the rendered files into the repository (and removes deleted mirror files). */
function writeFiles(repoDir: string, files: RenderedFile[]): void {
  const root = resolve(repoDir);
  for (const f of files) {
    const abs = resolve(root, f.path);
    const rel = relative(root, abs);
    if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new CheckFailed([`refusing to write outside the repository: ${f.path}`]);
    if (f.change === "delete") rmSync(abs, { force: true });
    else {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content);
    }
  }
}

export interface AgentFilesDeps {
  /** The app as the portal shows it, when the CLI is signed in to the app's portal; undefined otherwise. */
  portalApp?: (slug: string, portalUrl: string | undefined) => Promise<{ facts?: PortalAppFacts; note?: string }>;
  out?: (s: string) => void;
  today?: string;
}

export const AGENT_FILES_HELP = `platform agent-files update [dir] [--check] [--offline]
                                            render the repository's agent files again from this CLI's
                                            templates (AGENTS.md keeps its app-specific notes; skills, tool
                                            settings, .platform/cli-version); values from AGENTS.md, or from
                                            the portal when signed in (platform login). --check: list what
                                            would change, exit 1 if anything would (ADR-0076)`;

export async function cmdAgentFiles(args: string[], deps: AgentFilesDeps = {}): Promise<number> {
  const out = deps.out ?? ((s: string) => void process.stdout.write(neutralize(s)));
  const [sub, ...rest] = args;
  if (sub !== "update") throw new UsageError(`Usage: ${AGENT_FILES_HELP.split("\n")[0]}`);
  const { values: opts, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { check: { type: "boolean", default: false }, offline: { type: "boolean", default: false } } });
  if (positionals.length > 1) throw new UsageError("platform agent-files update takes one directory.");
  const repoDir = resolve(positionals[0] ?? ".");
  const templatesDir = agentTemplatesDir();
  if (!templatesDir) throw new UsageError("this platform CLI carries no app templates: install it from a core release (its tarball has them).");
  const slug = appSlug(repoDir);
  const facts = existsSync(join(repoDir, "AGENTS.md")) ? parseAgentsMd(readFileSync(join(repoDir, "AGENTS.md"), "utf8")) : {};
  let portal: PortalAppFacts | undefined;
  const notes: string[] = [];
  if (!opts.offline && deps.portalApp) {
    const r = await deps.portalApp(slug, portalOf(facts.appPortalUrl, slug));
    portal = r.facts;
    if (r.note) notes.push(r.note);
  }
  const v = agentFileValues(repoDir, templatesDir, { stamps: "current", ...(portal ? { portal } : {}), ...(deps.today ? { today: deps.today } : {}) });
  const files = renderAgentFiles(templatesDir, v.template, v.values, readAgentFiles(repoDir, agentFileTargets(templatesDir)));
  for (const n of notes) out(`note: ${n}\n`);
  if (files.length === 0) {
    out(`OK  the agent files are current (template v${toolVersion()}).\n`);
    return 0;
  }
  for (const f of files) out(`${opts.check ? "would " : ""}${f.change === "add" ? "add" : f.change === "edit" ? "update" : "delete"}  ${f.path}\n`);
  if (opts.check) {
    out(`${files.length} file(s) would change: run "platform agent-files update" (template v${toolVersion()}; values from ${v.sources.join(" and ")}).\n`);
    return 1;
  }
  writeFiles(repoDir, files);
  out(`${files.length} file(s) written from template v${toolVersion()} (values from ${v.sources.join(" and ")}). Show the user "git diff", run "platform check", then commit with their OK.\n`);
  return 0;
}
