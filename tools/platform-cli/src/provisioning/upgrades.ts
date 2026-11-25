import { existsSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, KiB, isObject, own, readJson, readText } from "../pipeline/common.js";
import { parseYaml, validateData } from "../schema.js";
import { UNIT_NAMES, compareVersions, isCoreVersion } from "./units.js";
import type { UnitName } from "./units.js";

/**
 * Upgrade notes of the provisioning units (ADR-0049 section 5): infra/app/upgrades.yaml of core.
 *
 *   minAppVersion  the oldest app version (a unit's recorded core version, tag saf-u-<unit>) this
 *                  core can still manage: a unit applied by an older version is upgraded by any run
 *                  that processes its app (ADR-0049 item 2.2)
 *   versions       per core version (or `unreleased` until the release is tagged), per unit that
 *                  changed in it: level, restart, entraApproval, requires, deadlineDays, notes
 *
 * Read by `provisioning plan-units` (minAppVersion, requires) and checked in core CI by `platform
 * upgrades check` (the schema, and a note in versions.unreleased for every unit of
 * infra/app/units.json whose `since` is `unreleased`). The portal bundles the same file.
 */

export const UPGRADES_LABEL = "infra/app/upgrades.yaml";
export const UNRELEASED = "unreleased";

export interface UpgradeNote {
  level: "optional" | "recommended" | "required";
  restart: boolean;
  entraApproval: boolean;
  requires: UnitName[];
  deadlineDays?: number;
  notes: { en: string; cs: string };
}

export interface UpgradeNotes {
  minAppVersion: string;
  /** Version (or `unreleased`) -> unit -> note, in the file's order. */
  versions: Record<string, Partial<Record<UnitName, UpgradeNote>>>;
}

/**
 * upgrades.yaml text against config/schema/upgrades.schema.json and the rules the schema can't say:
 * a unit never requires itself, deadlineDays only with level required, minAppVersion not after a
 * listed version's successor of coreVersion. With `release` (a provisioning run: core is always
 * refs/tags/<coreVersion>) no `unreleased` version and none after coreVersion, as for units.json.
 */
export function parseUpgradeNotes(text: string, label = UPGRADES_LABEL, opts: { release?: boolean; coreVersion?: string } = {}): UpgradeNotes {
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) throw new CheckFailed(parsed.parseErrors.map((e) => `${label} line ${e.line}: YAML syntax error: ${e.message}`));
  const schema = validateData("upgrades", parsed.data, parsed);
  if (schema.length) throw new CheckFailed(schema.map((p) => `${label} ${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}.`));
  const data = parsed.data as { minAppVersion: string; versions: Record<string, Record<string, Record<string, unknown>>> };
  const problems: string[] = [];
  const versions: UpgradeNotes["versions"] = {};
  for (const [version, units] of Object.entries(data.versions)) {
    if (version === UNRELEASED) {
      if (opts.release) problems.push(`${label} has versions.unreleased: this core is not a release (tools/scripts/release-units.mjs renames it to the tagged version).`);
    } else if (opts.coreVersion !== undefined && isCoreVersion(opts.coreVersion) && compareVersions(version, opts.coreVersion) > 0) {
      problems.push(`${label} has notes for ${version}, after this run's core version ${opts.coreVersion}.`);
    }
    const out: Partial<Record<UnitName, UpgradeNote>> = {};
    for (const [unit, n] of Object.entries(units)) {
      const requires = (Array.isArray(n.requires) ? n.requires : []) as UnitName[];
      if (requires.includes(unit as UnitName)) problems.push(`${label} versions.${version}.${unit}.requires names the unit itself.`);
      if (n.deadlineDays !== undefined && n.level !== "required") problems.push(`${label} versions.${version}.${unit}.deadlineDays applies to level required only.`);
      out[unit as UnitName] = {
        level: n.level as UpgradeNote["level"],
        restart: n.restart as boolean,
        entraApproval: n.entraApproval as boolean,
        requires,
        ...(typeof n.deadlineDays === "number" ? { deadlineDays: n.deadlineDays } : {}),
        notes: n.notes as UpgradeNote["notes"],
      };
    }
    versions[version] = out;
  }
  if (opts.coreVersion !== undefined && isCoreVersion(opts.coreVersion) && compareVersions(data.minAppVersion, opts.coreVersion) > 0) {
    problems.push(`${label} minAppVersion ${data.minAppVersion} is after this run's core version ${opts.coreVersion}.`);
  }
  if (problems.length) throw new CheckFailed(problems);
  return { minAppVersion: data.minAppVersion, versions };
}

export function readUpgradeNotes(path: string, opts: { release?: boolean; coreVersion?: string } = {}): UpgradeNotes {
  if (!existsSync(path)) throw new CheckFailed([`${UPGRADES_LABEL} is missing in the core checkout (${path}): this core can't tell which units an upgrade needs.`]);
  return parseUpgradeNotes(readText(path, 256 * KiB, UPGRADES_LABEL, { noFollow: true }), UPGRADES_LABEL, opts);
}

/**
 * The units a unit's upgrade brings along (ADR-0049 item 8): `requires` of its notes in every
 * version after `applied` (the version that last applied it) up to and including `coreVersion`.
 * `unreleased` counts as after every version (a run never sees it).
 */
export function requiredWith(notes: UpgradeNotes, unit: UnitName, applied: string, coreVersion: string): UnitName[] {
  const out = new Set<UnitName>();
  for (const [version, units] of Object.entries(notes.versions)) {
    const note = units[unit];
    if (!note) continue;
    const after = version === UNRELEASED || compareVersions(version, applied) > 0;
    const upTo = version === UNRELEASED || compareVersions(version, coreVersion) <= 0;
    if (after && upTo) for (const r of note.requires) out.add(r);
  }
  return [...out].filter((r) => r !== unit);
}

// ------------------------------------------------------------------------------------------
// `platform upgrades check` (core CI)
// ------------------------------------------------------------------------------------------

export interface UpgradesCheck {
  minAppVersion: string;
  versions: string[];
  unreleasedUnits: string[];
}

/**
 * Core CI: infra/app/upgrades.yaml is valid, and every unit of infra/app/units.json whose `since`
 * is `unreleased` has a note in versions.unreleased (and only those: a note for a unit that did
 * not change since the last release would announce an upgrade that never comes).
 */
export function checkUpgrades(coreDir: string): UpgradesCheck {
  const notes = readUpgradeNotes(join(coreDir, "infra", "app", "upgrades.yaml"));
  const unitsPath = join(coreDir, "infra", "app", "units.json");
  if (!existsSync(unitsPath)) throw new CheckFailed([`infra/app/units.json is missing in ${coreDir}.`]);
  const manifest = readJson(unitsPath, 64 * KiB, "infra/app/units.json", { noFollow: true });
  const units = isObject(manifest) ? own(manifest, "units") : undefined;
  if (!isObject(units)) throw new CheckFailed(["infra/app/units.json has no units object."]);
  const problems: string[] = [];
  const unreleased = UNIT_NAMES.filter((u) => isObject(own(units, u)) && own(own(units, u) as Record<string, unknown>, "since") === UNRELEASED);
  const noted = notes.versions[UNRELEASED] ?? {};
  for (const u of unreleased) {
    if (!noted[u]) {
      problems.push(`${UPGRADES_LABEL} has no note for ${u} in versions.unreleased, but infra/app/units.json says ${u} changed since the last release (since: unreleased). Write what changes for an app (level, restart, entraApproval, notes en and cs).`);
    }
  }
  for (const u of Object.keys(noted)) {
    if (!unreleased.includes(u as UnitName)) problems.push(`${UPGRADES_LABEL} versions.unreleased has a note for ${u}, which did not change since the last release (its since in infra/app/units.json is not unreleased).`);
  }
  for (const [version, us] of Object.entries(notes.versions)) {
    if (version === UNRELEASED) continue;
    for (const u of Object.keys(us)) {
      const since = isObject(own(units, u)) ? own(own(units, u) as Record<string, unknown>, "since") : undefined;
      if (typeof since === "string" && isCoreVersion(since) && compareVersions(version, since) > 0) {
        problems.push(`${UPGRADES_LABEL} versions.${version} has a note for ${u}, but infra/app/units.json says ${u} last changed in ${since}.`);
      }
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  return { minAppVersion: notes.minAppVersion, versions: Object.keys(notes.versions), unreleasedUnits: unreleased };
}

export const UPGRADES_HELP = `platform upgrades check [--core-dir <core checkout>]
    infra/app/upgrades.yaml (ADR-0049) against config/schema/upgrades.schema.json, and a note in
    versions.unreleased for exactly the units of infra/app/units.json whose since is unreleased.
    --core-dir defaults to the current directory. Exit codes: 0 ok, 1 check failed, 2 usage.
`;

export function formatUpgradesCheck(r: UpgradesCheck): string {
  return `OK  upgrade notes: minAppVersion ${r.minAppVersion}, versions ${r.versions.length ? r.versions.join(", ") : "none"}; unreleased units ${r.unreleasedUnits.length ? r.unreleasedUnits.join(", ") : "none"}, each with a note\n`;
}
