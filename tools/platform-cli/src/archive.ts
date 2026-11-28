/**
 * The archive of deleted apps in platform-config (ADR-0061 section 3):
 *
 *   apps-deleted/{slug}/{requestedOn}/app.yaml
 *
 * A deleted app's definition stays in apps/{slug}/ until a new app asks for its slug. The new app's
 * pull request then moves apps/{slug}/app.yaml here unchanged ({requestedOn} is its
 * decommission.requestedOn), removes apps/{slug}/delivery.yml and writes the new apps/{slug}/app.yaml
 * with a generation and an incarnation above every archived one (checks slug-reuse-generation and
 * slug-reuse-incarnation).
 *
 * The archive is never provisioned: everything that enumerates apps (`platform generate`,
 * `platform provisioning apps` and the provisioning helpers, the checks between apps, the network
 * rule of `validate instance --base`, `platform ado bootstrap`) reads apps/ only. `platform validate
 * archive` checks each archived definition the change adds against app.schema.json, every one's
 * place, and with --base that it was added only by a move and never changes; the one exception is the
 * move back to apps/{slug}/app.yaml, unchanged, while no new app has the slug (check deleted-archive,
 * validate-archive.ts).
 */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { parseYaml } from "./schema.js";

/** The archive's folder at the root of platform-config, beside apps/. */
export const ARCHIVE_DIR = "apps-deleted";

/** A file larger than this is never read (as for apps/{slug}/app.yaml). */
export const MAX_DEFINITION_BYTES = 1024 * 1024;

/** Path of an archived definition in platform-config. */
export function archivedAppYamlPath(slug: string, requestedOn: string): string {
  return `${ARCHIVE_DIR}/${slug}/${requestedOn}/app.yaml`;
}

/**
 * The text of a definition as the archive rules compare it: CRLF as LF, and one trailing newline
 * (a checkout with other line endings, or an editor that drops the last newline, is still "unchanged").
 */
export function normalisedDefinitionText(text: string): string {
  const lf = text.replace(/\r\n/g, "\n");
  return lf.endsWith("\n") ? lf : `${lf}\n`;
}

/** Whether two definition texts are the same for the archive rules (normalisedDefinitionText). */
export function sameDefinitionText(a: string | undefined, b: string | undefined): boolean {
  return a !== undefined && b !== undefined && normalisedDefinitionText(a) === normalisedDefinitionText(b);
}

/** An archived definition: its path relative to the platform-config root, and its text. */
export interface ArchivedDefinition {
  path: string;
  text: string;
}

/**
 * The generation (ADR-0020, default 0) an archived definition was created with: a non-negative
 * integer, else 0 (an unreadable definition fails `platform validate archive` on its own).
 */
export function archivedGeneration(text: string): number {
  return archivedNumber(text, "generation");
}

/**
 * The incarnation (ADR-0061, default 0) of an archived definition: a non-negative integer, else 0. A
 * definition written before the field existed was the first app with its slug, so 0 is right for it.
 */
export function archivedIncarnation(text: string): number {
  return archivedNumber(text, "incarnation");
}

function archivedNumber(text: string, key: "generation" | "incarnation"): number {
  const p = parseYaml(text);
  const g = p.parseErrors.length ? undefined : (p.data as Record<string, unknown> | undefined)?.[key];
  return Number.isSafeInteger(g) && (g as number) >= 0 ? (g as number) : 0;
}

/** The day an archived definition was requested for decommissioning: its folder name, else its block's requestedOn. */
export function archivedRequestedOn(a: { path?: string; text: string }): string | undefined {
  const m = a.path ? /\/(\d{4}-\d{2}-\d{2})\/app\.yaml$/.exec(a.path) : null;
  if (m) return m[1];
  const p = parseYaml(a.text);
  const r = p.parseErrors.length ? undefined : (p.data as { decommission?: { requestedOn?: unknown } } | undefined)?.decommission?.requestedOn;
  return typeof r === "string" ? r : undefined;
}

function isRegularFile(path: string): boolean {
  try {
    const st = lstatSync(path);
    return st.isFile() && st.size <= MAX_DEFINITION_BYTES;
  } catch {
    return false;
  }
}

function isRealDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The archived definitions of one slug in the work tree: apps-deleted/{slug}/{folder}/app.yaml beside
 * the apps/ folder that holds `appFile` (apps/{slug}/app.yaml). undefined when `appFile` isn't inside
 * an apps/ folder; [] when the slug has no archive. Symbolic links and files over 1 MiB are skipped
 * (`platform validate archive` refuses them).
 */
export function archivedOfSlug(appFile: string): (ArchivedDefinition & { abs: string })[] | undefined {
  const appDir = dirname(resolve(appFile));
  const appsDir = dirname(appDir);
  if (basename(appsDir) !== "apps") return undefined;
  const slug = basename(appDir);
  const slugDir = join(dirname(appsDir), ARCHIVE_DIR, slug);
  if (!isRealDirectory(join(dirname(appsDir), ARCHIVE_DIR)) || !isRealDirectory(slugDir)) return [];
  const out: (ArchivedDefinition & { abs: string })[] = [];
  for (const e of readdirSync(slugDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (!e.isDirectory()) continue;
    const abs = join(slugDir, e.name, "app.yaml");
    if (!isRegularFile(abs)) continue;
    out.push({ path: `${ARCHIVE_DIR}/${slug}/${e.name}/app.yaml`, abs, text: readFileSync(abs, "utf8") });
  }
  return out;
}
