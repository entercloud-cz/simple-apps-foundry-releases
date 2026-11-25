import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, MiB, readText, UsageError, writeJson } from "../pipeline/common.js";
import { THEME_CUSTOM, THEME_NONE } from "../themes.js";
import { REPOSITORY_TEMPLATES } from "../validate-app.js";
import type { RepositoryTemplate } from "../validate-app.js";
import { renderAppRepo, repoRenderScope } from "./render.js";
import type { RepoRender } from "./render.js";

export const REPO_HELP = `platform repo render: the starter of an app repository (ADR-0039)

  render --instance <instance.yaml> --app <apps/<slug>/app.yaml> --out <dir>
         [--templates <core>/templates] [--date YYYY-MM-DD] [--template <id>]
         [--theme <id|none|custom>] [--output <files.json>]
      renders templates/app/manifest.json and the stack of repository.template into <dir>: a stack
      = its files and every manifest entry; byo = only the "onboarding" entries (agent files,
      platform.yaml). Without repository.template the repository is unmanaged: exit 1, unless
      --template is given. Modes apply against what <dir> already holds (create never
      overwrites, mergeLines appends missing lines, managed rewrites, mirrors are made equal).
      The app must pass "platform validate app --instance". --templates defaults to templates/ of
      the core checkout the CLI runs from; --date (CREATED_DATE) to today (UTC); --template
      overrides repository.template (${REPOSITORY_TEMPLATES.join(", ")}).
      The app's theme (ADR-0044) is ui.theme, or --theme: a theme the instance offers writes
      theme/theme.css and theme/theme.json with its tokens (and theme/README.md), custom the same
      with placeholder tokens to replace, none (or no ui) no theme files. byo gets no theme files.
      --output writes { slug, template, theme, files: [ { path, change: add|edit|delete } ] }.

Exit codes: 0 ok, 1 invalid app definition or templates, 2 usage or internal error.
`;

/** app.yaml ui.theme's pattern (app.schema.json): --theme takes the same values. */
const THEME_RE = /^(none|custom|[a-z][a-z0-9-]{1,30})$/;

/** True when `abs` or any folder between `root` and it is a symbolic link. */
function throughLink(root: string, rel: string): boolean {
  let p = root;
  for (const part of rel.split("/")) {
    p = join(p, part);
    try {
      if (lstatSync(p).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** The current content of <dir> below the render scope, as `existing` for the renderer. */
function readExisting(out: string, template: RepositoryTemplate, templatesDir: string | undefined): Map<string, Buffer> {
  const existing = new Map<string, Buffer>();
  if (!existsSync(out)) return existing;
  const scope = repoRenderScope(template, templatesDir ? { templatesDir } : {});
  const add = (rel: string): void => {
    if (throughLink(out, rel)) throw new CheckFailed([`${rel} in --out is or lies under a symbolic link, which is not allowed.`]);
    const abs = join(out, rel);
    if (existsSync(abs) && lstatSync(abs).isFile()) existing.set(rel, readFileSync(abs));
  };
  for (const f of scope.files) add(f);
  for (const d of scope.dirs) {
    if (throughLink(out, d)) throw new CheckFailed([`${d} in --out is or lies under a symbolic link, which is not allowed.`]);
    const walk = (rel: string): void => {
      const abs = join(out, rel);
      if (!existsSync(abs) || !lstatSync(abs).isDirectory()) return;
      for (const e of readdirSync(abs, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
        const child = `${rel}/${e.name}`;
        if (e.isSymbolicLink()) throw new CheckFailed([`${child} in --out is a symbolic link, which is not allowed.`]);
        if (e.isDirectory()) walk(child);
        else if (e.isFile()) existing.set(child, readFileSync(join(out, child)));
      }
    };
    walk(d);
  }
  return existing;
}

function writeOut(out: string, r: RepoRender): void {
  if (existsSync(out) && !lstatSync(out).isDirectory()) throw new CheckFailed([`--out ${out} is not a directory.`]);
  for (const f of r.files) {
    if (throughLink(out, f.path)) throw new CheckFailed([`${f.path} in --out is or lies under a symbolic link, which is not allowed.`]);
  }
  for (const f of r.files) {
    const abs = join(out, f.path);
    if (f.change === "delete") {
      rmSync(abs, { force: true });
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, f.content);
  }
}

export function formatRender(r: RepoRender, out: string): string {
  const verb = { add: "created", edit: "updated", delete: "deleted" } as const;
  const lines = r.files.map((f) => `${verb[f.change].padEnd(8)} ${f.path}`);
  const count = (c: string): number => r.files.filter((f) => f.change === c).length;
  const theme = r.theme === THEME_NONE ? "" : r.theme === THEME_CUSTOM ? " with placeholder theme files (custom)" : ` with the ${r.theme} theme`;
  lines.push(
    r.files.length
      ? `OK  ${r.template} starter of ${r.slug}${theme} rendered into ${out}: ${count("add")} created, ${count("edit")} updated, ${count("delete")} deleted.`
      : `OK  nothing to do: ${out} already holds the ${r.template} starter of ${r.slug}.`,
  );
  return lines.join("\n") + "\n";
}

/** `platform repo <command>` */
export function cmdRepo(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(REPO_HELP);
    return command ? 0 : 2;
  }
  const err = (msg: string): void => void process.stderr.write(neutralize(`platform repo ${command.slice(0, 40)}: ${msg.replace(/\s*[\r\n]+\s*/g, " ")}`) + "\n");
  try {
    if (command !== "render") throw new UsageError(`unknown command "${command.slice(0, 40)}"; commands: render.`);
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        instance: { type: "string" },
        app: { type: "string" },
        out: { type: "string" },
        templates: { type: "string" },
        date: { type: "string" },
        template: { type: "string" },
        theme: { type: "string" },
        output: { type: "string" },
      },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const missing = (["instance", "app", "out"] as const).filter((k) => !values[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    const template = values.template as RepositoryTemplate | undefined;
    if (template !== undefined && !REPOSITORY_TEMPLATES.includes(template)) throw new UsageError(`--template must be one of ${REPOSITORY_TEMPLATES.join(", ")}.`);
    const theme = values.theme;
    if (theme !== undefined && !THEME_RE.test(theme)) throw new UsageError(`--theme must be a theme id of the instance, ${THEME_NONE} or ${THEME_CUSTOM}.`);
    const templatesDir = values.templates ? resolve(values.templates) : undefined;
    const instanceText = readText(values.instance as string, 4 * MiB, "--instance");
    const appText = readText(values.app as string, MiB, "--app");
    const out = resolve(values.out as string);

    // The template decides the scope of the existing files: render once to learn it (cheap, pure).
    const opts = {
      appPath: values.app as string,
      ...(templatesDir ? { templatesDir } : {}),
      ...(values.date ? { date: values.date } : {}),
      ...(template ? { template } : {}),
      ...(theme !== undefined ? { theme } : {}),
    };
    const probe = renderAppRepo(instanceText, appText, opts);
    const existing = readExisting(out, probe.template, templatesDir);
    const r = existing.size ? renderAppRepo(instanceText, appText, { ...opts, existing }) : probe;
    writeOut(out, r);
    if (values.output) writeJson(values.output, { slug: r.slug, template: r.template, theme: r.theme, files: r.files.map((f) => ({ path: f.path, change: f.change })) });
    process.stdout.write(neutralize(formatRender(r, values.out as string)));
    return 0;
  } catch (e) {
    if (e instanceof CheckFailed) {
      for (const p of e.problems) err(p);
      return 1;
    }
    if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      err(`${(e as Error).message} Run "platform repo help" for usage.`);
      return 2;
    }
    err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
