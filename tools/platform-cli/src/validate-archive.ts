import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join, resolve } from "node:path";
import { UsageError } from "./allowlist.js";
import { ARCHIVE_DIR, MAX_DEFINITION_BYTES, sameDefinitionText } from "./archive.js";
import { decommissionOf, deletePhaseDue, isDate, utcDate } from "./decommission.js";
import { slugProblem } from "./pipeline/common.js";
import { parseYaml, validateData } from "./schema.js";
import type { ParsedYaml } from "./schema.js";
import { baseCommit, lineAt, pathOf, showAtCommit } from "./validate-app.js";

/**
 * `platform validate archive <platform-config dir> [--base <git-ref>]`: the archive of deleted apps,
 * apps-deleted/{slug}/{requestedOn}/app.yaml (ADR-0061 section 3, archive.ts).
 *
 * Always:
 *   - every archived definition the change adds against app.schema.json (YAML syntax first): with
 *     --base those the base's archive doesn't have, without it all of them. One already merged is
 *     never checked against the schema again, so a stricter schema of a later core can't fail an
 *     archive that may not change;
 *   - its place (check deleted-archive): apps-deleted/ holds only folders {slug}/{requestedOn}/, each
 *     with exactly one app.yaml (a regular file, no symbolic link, at most 1 MiB); the definition's
 *     slug equals its {slug} folder, it carries its decommission block, and decommission.requestedOn
 *     equals its {requestedOn} folder.
 * With --base (the pull request's target branch; offline, a date rule as decommission-tombstone):
 *   - every file the base has under apps-deleted/ is still there, unchanged, with one exception: the
 *     move back. An archived definition may go when the same change restores it unchanged to
 *     apps/{slug}/app.yaml and the base has no apps/{slug}/app.yaml (no new app has the slug yet):
 *     it was archived before provisioning read the app deleted, and provisioning must go on deleting
 *     it. `platform validate app` compares the restored file with the archived one;
 *   - an archived definition the base doesn't have is a move: the base's apps/{slug}/app.yaml with
 *     this text, whose decommission block's deleteAfter is today (UTC) or earlier (the delete phase is
 *     due; an immediate deletion from its request day), and apps/{slug}/app.yaml no longer holds it (a
 *     new app there is a new definition).
 * "Unchanged" and "this text" compare after CRLF -> LF and with one trailing newline
 * (archive.ts sameDefinitionText), so line endings of a checkout don't matter.
 *
 * Whether the app is really deleted can't be checked offline: the portal offers the slug only once
 * the plan read it deleted, and provisioning guards the rest (ADR-0061 section 4).
 */

export interface ArchiveProblem {
  /** The file or folder, relative to the platform-config root. */
  file: string;
  /** Field path inside an archived definition (`(root)` for the document), or `(file)` for the file or folder itself. */
  path: string;
  message: string;
  line?: number;
  /** The schema's description of the field (schema problems only). */
  help?: string;
  /** deleted-archive for the archive's own rules (explanations.ts DEFINITION_CHECK_IDS). */
  checkId?: string;
}

export interface ArchiveValidateResult {
  kind: "archive";
  dir: string;
  ok: boolean;
  /** The archived definitions found, relative to `dir`. */
  files: string[];
  problems: ArchiveProblem[];
  /** With --base: the ref compared against, and how many files it has under apps-deleted/. */
  base?: { ref: string; files: number };
}

const CHECK = "deleted-archive";
const DEF_RE = new RegExp(`^${ARCHIVE_DIR}/([^/]+)/([^/]+)/app\\.yaml$`);

function readRegular(abs: string): string | undefined {
  try {
    const st = lstatSync(abs);
    return st.isFile() && st.size <= MAX_DEFINITION_BYTES ? readFileSync(abs, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

const byName = (a: Dirent, b: Dirent): number => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

export function validateArchive(dir: string, opts: { base?: string; today?: string } = {}): ArchiveValidateResult {
  const root = resolve(dir);
  if (!existsSync(join(root, "instance.yaml"))) throw new UsageError(`${dir} has no instance.yaml: give the root of the platform-config checkout.`);
  const today = opts.today ?? utcDate();
  const problems: ArchiveProblem[] = [];
  const place = (file: string, message: string): void => void problems.push({ file, path: "(file)", message: `${message} (check ${CHECK}).`, checkId: CHECK });

  // 1. The archive's layout: apps-deleted/<slug>/<requestedOn>/app.yaml and nothing else.
  const found = new Map<string, string>();
  const top = join(root, ARCHIVE_DIR);
  let topStat: ReturnType<typeof lstatSync> | undefined;
  try {
    topStat = lstatSync(top);
  } catch {
    topStat = undefined;
  }
  if (topStat && !topStat.isDirectory()) place(ARCHIVE_DIR, `${ARCHIVE_DIR} must be a folder; a symbolic link or a file is not allowed`);
  else if (topStat) {
    for (const s of readdirSync(top, { withFileTypes: true }).sort(byName)) {
      const slugRel = `${ARCHIVE_DIR}/${s.name}`;
      if (s.isSymbolicLink()) {
        place(slugRel, `${slugRel} is a symbolic link, which is not allowed`);
        continue;
      }
      if (!s.isDirectory()) {
        place(slugRel, `${ARCHIVE_DIR}/ holds only the folders ${ARCHIVE_DIR}/<slug>/<requestedOn>/ of deleted apps, not ${slugRel}`);
        continue;
      }
      const sp = slugProblem(s.name, `the folder ${slugRel}`);
      if (sp) {
        place(slugRel, `${sp.replace(/\.$/, "")}; the folder is the deleted app's slug`);
        continue;
      }
      for (const d of readdirSync(join(top, s.name), { withFileTypes: true }).sort(byName)) {
        const dayRel = `${slugRel}/${d.name}`;
        if (d.isSymbolicLink()) {
          place(dayRel, `${dayRel} is a symbolic link, which is not allowed`);
          continue;
        }
        if (!d.isDirectory() || !isDate(d.name)) {
          place(dayRel, `${slugRel}/ holds only folders named for the day the app's decommissioning was requested (decommission.requestedOn, YYYY-MM-DD), not ${dayRel}`);
          continue;
        }
        const dayAbs = join(top, s.name, d.name);
        let hasApp = false;
        for (const f of readdirSync(dayAbs, { withFileTypes: true }).sort(byName)) {
          if (f.name === "app.yaml") {
            hasApp = true;
            continue;
          }
          place(`${dayRel}/${f.name}`, `an archived app's folder holds only its app.yaml, not ${dayRel}/${f.name}${f.name === "delivery.yml" ? " (the move removes apps/<slug>/delivery.yml)" : ""}`);
        }
        const fileRel = `${dayRel}/app.yaml`;
        if (!hasApp) {
          place(dayRel, `${dayRel} holds no app.yaml`);
          continue;
        }
        const text = readRegular(join(dayAbs, "app.yaml"));
        if (text === undefined) {
          place(fileRel, `${fileRel} must be a regular file of at most 1 MiB; a symbolic link is not allowed`);
          continue;
        }
        found.set(fileRel, text);
      }
    }
  }

  // The base's archive first: a definition already merged gets no schema check (a stricter schema of
  // a later core must never fail an archive that can't change), only its place and immutability.
  let git: ReturnType<typeof baseCommit> | undefined;
  let prefix = "";
  let basePaths: string[] = [];
  if (opts.base !== undefined) {
    git = baseCommit(root, opts.base);
    prefix = git.rel ? `${git.rel}/` : "";
    const list = spawnSync("git", ["-C", git.root, "ls-tree", "-r", "-z", "--name-only", git.commit, "--", `${prefix}${ARCHIVE_DIR}/`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (list.status !== 0) throw new UsageError(`--base: could not list ${ARCHIVE_DIR}/ at ${opts.base}: ${list.stderr.trim()}`);
    basePaths = list.stdout
      .split("\0")
      .filter((p) => p && p.startsWith(prefix))
      .map((p) => p.slice(prefix.length));
  }
  const inBase = new Set(basePaths);
  const atBase = (rel: string): string | undefined => (git ? showAtCommit(git.root, git.commit, `${prefix}${rel}`) : undefined);

  // 2. Each archived definition: syntax and schema (only those this change adds), and the place it is filed under.
  for (const [file, text] of found) {
    const m = DEF_RE.exec(file)!;
    const [slug, day] = [m[1]!, m[2]!];
    const added = !inBase.has(file);
    const parsed = parseYaml(text);
    if (parsed.parseErrors.length) {
      if (added) for (const e of parsed.parseErrors) problems.push({ file, path: "(root)", message: `YAML syntax error: ${e.message}`, line: e.line });
      continue;
    }
    if (added) {
      const schema = validateData("app", parsed.data, parsed);
      for (const p of schema) problems.push({ file, path: p.path, message: p.message, ...(p.line !== undefined ? { line: p.line } : {}), ...(p.help !== undefined ? { help: p.help } : {}) });
      if (schema.length) continue;
    }
    const data = (parsed.data && typeof parsed.data === "object" ? parsed.data : {}) as { slug?: unknown; decommission?: { requestedOn?: unknown } | null };
    const at = (segs: (string | number)[], message: string): void => {
      const line = lineAt(parsed, segs);
      problems.push({ file, path: pathOf(segs), message: `${message} (check ${CHECK}).`, checkId: CHECK, ...(line !== undefined ? { line } : {}) });
    };
    if (data.slug !== slug) at(["slug"], `slug "${String(data.slug)}" must equal the folder ${ARCHIVE_DIR}/${slug}/ it is archived under`);
    if (!data.decommission || typeof data.decommission !== "object") at(["decommission"], "an archived definition is a deleted app's and carries its decommission block");
    else if (data.decommission.requestedOn !== day) at(["decommission", "requestedOn"], `decommission.requestedOn ${String(data.decommission.requestedOn)} must equal the folder ${ARCHIVE_DIR}/${slug}/${day}/ it is archived under`);
  }

  // 3. Against the base: added only by a move once the delete phase is due, never changed, and
  //    removed only by the move back to apps/<slug>/app.yaml while no new app has the slug.
  let base: ArchiveValidateResult["base"];
  if (opts.base !== undefined && git) {
    const ref = opts.base;
    base = { ref, files: basePaths.length };
    for (const p of basePaths) {
      const was = atBase(p);
      const is = readRegular(join(root, p));
      if (is === undefined) {
        const m = DEF_RE.exec(p);
        const appRel = m ? `apps/${m[1]!}/app.yaml` : undefined;
        // The one exception (ADR-0061): the definition was archived too early and goes back unchanged.
        if (appRel && atBase(appRel) === undefined && sameDefinitionText(readRegular(join(root, appRel)), was)) continue;
        place(
          p,
          appRel && atBase(appRel) !== undefined
            ? `${p} is in the archive at ${ref} and was removed or replaced; an archived definition is never removed, and it can't move back while ${appRel} holds a new app`
            : `${p} is in the archive at ${ref} and was removed or replaced; an archived definition is never removed, except by moving it back unchanged to ${appRel ?? "apps/<slug>/app.yaml"} while no app has the slug`,
        );
      } else if (!sameDefinitionText(is, was)) place(p, `${p} changed against ${ref}; an archived definition never changes`);
    }
    for (const [file, text] of found) {
      if (inBase.has(file)) continue;
      const slug = DEF_RE.exec(file)![1]!;
      const appRel = `apps/${slug}/app.yaml`;
      const was = atBase(appRel);
      if (was === undefined) {
        place(file, `${file} is new, but ${ref} has no ${appRel}: an archived definition is only added by moving the deleted app's ${appRel} here unchanged`);
        continue;
      }
      if (!sameDefinitionText(was, text)) {
        place(file, `${file} is new and differs from ${appRel} at ${ref}: the deleted app's definition moves here unchanged`);
        continue;
      }
      const parsed: ParsedYaml = parseYaml(text);
      const data = parsed.parseErrors.length ? undefined : (parsed.data as { decommission?: unknown } | undefined);
      const d = data ? decommissionOf(data) : undefined;
      const line = lineAt(parsed, ["decommission", "deleteAfter"]);
      if (!data || !d) {
        place(file, `${appRel} at ${ref} has no decommission block: only a deleted app's definition moves to the archive`);
      } else if (!deletePhaseDue(data, today)) {
        problems.push({
          file,
          path: "decommission.deleteAfter",
          message: `${appRel} at ${ref} isn't due for deletion: its delete phase starts on ${d.deleteAfter} and today is ${today} (UTC). Only a deleted app's definition moves to the archive, when a new app asks for its slug (check ${CHECK}).`,
          checkId: CHECK,
          ...(line !== undefined ? { line } : {}),
        });
      }
      if (sameDefinitionText(readRegular(join(root, appRel)), text)) {
        place(file, `${appRel} still holds the same definition: the move takes it out of apps/${slug}/, and a new app there is a new definition`);
      }
    }
  }

  return { kind: "archive", dir, ok: problems.length === 0, files: [...found.keys()], problems, ...(base ? { base } : {}) };
}

export function formatArchiveText(r: ArchiveValidateResult): string {
  const lines: string[] = [];
  const compared = r.base ? ` (compared with ${r.base.ref})` : "";
  if (r.ok) {
    lines.push(
      r.files.length
        ? `OK  ${ARCHIVE_DIR}/ holds ${r.files.length} valid archived definition${r.files.length === 1 ? "" : "s"} of deleted apps${compared}.`
        : `OK  no archived definitions of deleted apps (${ARCHIVE_DIR}/ is empty or absent)${compared}.`,
    );
  } else {
    lines.push(`FAILED  ${ARCHIVE_DIR}/ (the archive of deleted apps) is not valid:`);
    for (const p of r.problems) {
      lines.push(`  ${p.file}: ${p.line ? `line ${p.line}: ` : ""}${p.path === "(file)" ? "" : `${p.path}: `}${p.message}`);
      if (p.help) lines.push(`      ${p.help}`);
    }
  }
  return lines.join("\n") + "\n";
}
