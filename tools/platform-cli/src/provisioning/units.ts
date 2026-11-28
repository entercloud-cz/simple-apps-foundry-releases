import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { adoOfflineView } from "../ado/plan.js";
import { CELL_ID_RE, cellOf, DEFAULT_CELL_ID } from "../capacity.js";
import { decommissionSettings, isDate } from "../decommission.js";
import type { DecommissionInstanceView } from "../decommission.js";
import { maintenanceOf, nextWindowStart, windowAt } from "../maintenance.js";
import { formatRegistryPlan, planRegistryPurge } from "./registry-purge.js";
import type { MaintenanceWindow } from "../maintenance.js";
import { CORE_VERSION_RE, CheckFailed, ENV_NAME_RE, KiB, MiB, SLUG_RE, isObject, own, readJson, writeJson } from "../pipeline/common.js";
import type { AppData } from "../validate-app.js";
import { provisioningHostEnvironment } from "./generate.js";
import { entraInputs, frontDoorInputs, lzInputs, portalEndpointInputs, releaseInputs } from "./inputs.js";
import type { State } from "./inputs.js";
import { environmentVaultInputs, environmentVaultVariant, instanceEnv, loadAppFile, loadInstanceFile, orderedEnvironments } from "./model.js";
import * as names from "./names.js";
import type { Instance, InstanceEnv } from "./model.js";
import { rotationDue } from "./rotation.js";
import { readUpgradeNotes, requiredWith } from "./upgrades.js";
import type { UpgradeNotes } from "./upgrades.js";

/**
 * Provisioning by unit (ADR-0048). What provisioning does for an app is split into units: `lz`,
 * `entra`, `release`, `frontdoor` and `pep` per app and environment, `ado` per app. A run decides
 * for each unit whether it runs; a stage runs only when one of its units runs.
 *
 *   units       (stage validate) `i` of every unit: sha256 of its inputs in the offline view, what
 *               `platform provisioning inputs` renders from app.yaml and instance.yaml alone (the
 *               values only Azure knows are left out or fixed placeholders), and for `ado` the
 *               desired objects of `platform ado plan` offline (adoOfflineView)
 *   plan-units  (stage plan, job decide) the decision per unit (rules 1-6 of ADR-0048 section 4,
 *               rule 2 amended by ADR-0049: outdated units wait for their upgrade) from those, the
 *               tags saf-u-<unit> and saf-u-files and the facts the jobs plan_<env> read from Azure,
 *               the unit manifest infra/app/units.json, the upgrade notes infra/app/upgrades.yaml,
 *               the run's scope and `upgrade` parameter and the run's time (--now): the time-based
 *               work (drift checks, Easy Auth rotations and the restarts after them, Front Door
 *               backend-range re-applies) runs only inside instance.yaml maintenance.window (ADR-0048
 *               section 7, amended 2026-11-11), an urgent rotation (at most 14 days left) at any time
 *
 * Tag saf-u-<unit> on the app resource group of each environment:
 *   "<core version that applied it> <first 12 hex of i> <UTC date of its last check, YYYYMMDD>"
 * (`ado` on the group of every environment of the app, `pep` on the group of the environment whose
 * vault it connects). Written by record_<env> only for a unit that finished there, or rebased.
 *
 * Tag saf-u-files on the same group (ADR-0049 section 3): the first 12 hex of the app's files hash
 * (filesHash: app.yaml's bytes and instance.yaml without coreVersion and coreReleases), written by
 * record_<env> with every unit tag it writes. It tells a core that renders the same settings differently (rebase)
 * from a changed setting.
 */

export const ENV_UNITS = ["lz", "entra", "release", "frontdoor", "pep"] as const;
export type EnvUnit = (typeof ENV_UNITS)[number];
export const UNIT_NAMES = [...ENV_UNITS, "ado"] as const;
export type UnitName = (typeof UNIT_NAMES)[number];

/**
 * Why a unit runs, or why it doesn't (held).
 *   new            no tag: a new app or environment, or a unit that did not finish last time (rule 1)
 *   template       the unit is outdated (its tag's version is older than its `since` in units.json)
 *                  and runs with this core's template: always together with the reason that lets
 *                  an outdated unit run (ADR-0049 section 2); `ado` is never held, so for it alone
 *                  (rule 2 of ADR-0048)
 *   inputs         its inputs (i) differ from the tag's (rule 3)
 *   dependency     another fact requires it (rule 4; details name it)
 *   drift          its last check is at least maintenance.driftCheckDays old (rule 5)
 *   all            the run checks every app (scope all, rule 6)
 *   upgrade        outdated, and the app is in the run's parameter `upgrade` (ADR-0049 item 2.1)
 *   minAppVersion  outdated, applied by a version older than upgrades.yaml minAppVersion (item 2.2)
 *   requires       another unit that runs outdated requires it in its upgrade notes (item 2.3)
 *   held           (run false) outdated, and nothing above lets it run: it waits for its upgrade,
 *                  "behind (upgrade available)"; drift checks and scope all skip it
 *   decommission   the app is being decommissioned (ADR-0056): release retires it (action retire),
 *                  or a unit is deleted (action delete)
 */
export const REASONS = ["new", "template", "inputs", "dependency", "drift", "all", "upgrade", "minAppVersion", "requires", "held", "decommission"] as const;
export type Reason = (typeof REASONS)[number];

export const TAG_PREFIX = "saf-u-";
/** The files hash of the app at its last record (ADR-0049 section 3). */
export const FILES_TAG = "saf-u-files";
/** The app fingerprint tag of ADR-0046, retired: record_<env> deletes it. */
export const LEGACY_TAG = "saf-provisioned";
/** ADR-0056: the UTC date (YYYYMMDD) the run that stopped a decommissioned app recorded; the grace period counts from it. */
export const RETIRED_TAG = "saf-u-retired";
/** ADR-0056: the value of saf-u-<unit> once the unit's delete finished ("removed YYYYMMDD"); never a unit tag. */
export const REMOVED_RE = /^removed (\d{8})$/;

// ------------------------------------------------------------------------------------------
// Versions (vMAJOR.MINOR.PATCH[-prerelease], semver 2.0 precedence; no build metadata)
// ------------------------------------------------------------------------------------------

export function isCoreVersion(v: unknown): v is string {
  return typeof v === "string" && v.length <= 64 && CORE_VERSION_RE.test(v);
}

function parts(v: string): { core: number[]; pre: string[] } {
  const m = /^v(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v);
  if (!m) throw new CheckFailed([`"${v.slice(0, 40)}" is not a core version (vMAJOR.MINOR.PATCH[-prerelease]).`]);
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] };
}

/** <0 when a precedes b, 0 when equal, >0 when a follows b (v0.1.0-rc.9 < v0.1.0-rc.10 < v0.1.0). */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i]! - y.core[i]!;
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) {
      if (Number(p) !== Number(q)) return Number(p) - Number(q);
    } else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

// ------------------------------------------------------------------------------------------
// The unit manifest infra/app/units.json (generated in core, ADR-0048 section 2)
// ------------------------------------------------------------------------------------------

export interface UnitManifestEntry {
  revision: number;
  fingerprint: string;
  /** The core version since which the fingerprint is unchanged. */
  since: string;
}

export interface UnitManifest {
  schemaVersion: 1;
  units: Record<UnitName, UnitManifestEntry>;
}

/**
 * infra/app/units.json of the core checkout. A run never sees `since: unreleased` (core is always
 * refs/tags/<coreVersion>), and a `since` after the run's core version would be a broken release:
 * both fail, as does a missing or malformed file. Keys other than the ones named here are ignored.
 */
export function parseUnitManifest(v: unknown, label: string, coreVersion?: string): UnitManifest {
  const problems: string[] = [];
  if (!isObject(v)) throw new CheckFailed([`${label} must be a JSON object { schemaVersion: 1, units }.`]);
  if (own(v, "schemaVersion") !== 1) problems.push(`${label} schemaVersion must be 1.`);
  const units = own(v, "units");
  if (!isObject(units)) throw new CheckFailed([...problems, `${label} has no units object.`]);
  const out = {} as Record<UnitName, UnitManifestEntry>;
  for (const name of UNIT_NAMES) {
    const u = own(units, name);
    if (!isObject(u)) {
      problems.push(`${label} has no unit ${name}.`);
      continue;
    }
    const revision = own(u, "revision");
    const fingerprint = own(u, "fingerprint");
    const since = own(u, "since");
    if (!Number.isSafeInteger(revision) || (revision as number) < 1) problems.push(`${label} units.${name}.revision must be an integer of at least 1.`);
    if (typeof fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(fingerprint)) problems.push(`${label} units.${name}.fingerprint must be 64 lower-case hex digits.`);
    if (since === "unreleased") problems.push(`${label} units.${name}.since is "unreleased": this core is not a release (the release script replaces it with the tagged version).`);
    else if (!isCoreVersion(since)) problems.push(`${label} units.${name}.since must be a core version (vMAJOR.MINOR.PATCH[-prerelease]).`);
    else if (coreVersion !== undefined && isCoreVersion(coreVersion) && compareVersions(since, coreVersion) > 0) {
      problems.push(`${label} units.${name}.since is ${since}, after this run's core version ${coreVersion}.`);
    }
    out[name] = { revision: revision as number, fingerprint: fingerprint as string, since: since as string };
  }
  for (const k of Object.keys(units)) if (!(UNIT_NAMES as readonly string[]).includes(k)) problems.push(`${label} names an unknown unit "${k.slice(0, 40)}".`);
  if (problems.length) throw new CheckFailed(problems);
  return { schemaVersion: 1, units: out };
}

export function readUnitManifest(path: string, coreVersion?: string): UnitManifest {
  const label = "infra/app/units.json";
  if (!existsSync(path)) throw new CheckFailed([`${label} is missing in the core checkout (${path}): this core can't decide which units to run.`]);
  return parseUnitManifest(readJson(path, 64 * KiB, label, { noFollow: true }), label, coreVersion);
}

// ------------------------------------------------------------------------------------------
// Offline views and their hashes (`i`)
// ------------------------------------------------------------------------------------------

/** JSON with object keys sorted at every level: the same value always gives the same text. */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  if (isObject(v)) {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(v[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

export function unitHash(unit: UnitName, view: unknown): string {
  return createHash("sha256").update(`saf-unit-inputs v1\n${unit}\n${canonicalJson(view)}`).digest("hex");
}

/** Placeholders for values only Azure knows: fixed, so the view depends on the files alone. */
const ZERO_GUID = "00000000-0000-0000-0000-000000000000";
const OFFLINE_FQDN = "ca-offline.offline.invalid";
const OFFLINE_RANGES = ["192.0.2.0/24"];
const OFFLINE_DIGEST = `sha256:${"0".repeat(64)}`;

function managedFrontDoor(inst: Instance): boolean {
  return (inst.frontDoor?.mode ?? "managed") === "managed";
}

/** The custom host app.yaml requests through the managed Front Door in env, lower case, or undefined. */
function requestedHost(app: AppData, inst: Instance, env: string): string | undefined {
  const h = app.environments[env]?.frontDoor?.hostName;
  return h && managedFrontDoor(inst) ? h.toLowerCase() : undefined;
}

/**
 * The state the offline views assume: the end state of a finished run (the custom domain deployed
 * and served, the ingress locked), with placeholders for every runtime value.
 */
function offlineState(app: AppData, inst: Instance, env: string): State {
  const host = requestedHost(app, inst, env);
  return {
    ado: null,
    easyAuthSecretExists: false,
    budgetStartDate: "2000-01-01",
    containerAppFqdn: OFFLINE_FQDN,
    landingZone: { runtimeIdentityClientId: ZERO_GUID, database: null, storageBlobEndpoint: null },
    entra: app.authentication.mode === "required" ? { clientId: ZERO_GUID } : null,
    releaseRecord: {
      prefix: { value: inst.naming.prefix },
      environmentName: { value: env },
      slug: { value: app.slug },
      image: { value: { digest: OFFLINE_DIGEST } },
      runtime: { value: { port: 8080, size: "xs", minReplicas: 0, maxReplicas: 1, livenessPath: "/", readinessPath: "/" } },
      env: { value: [] },
      secrets: { value: [] },
      run: { value: null },
    },
    ...(host ? { frontDoor: { hostName: host, frontDoorId: ZERO_GUID, serving: true }, frontDoorBackendIpRanges: [...OFFLINE_RANGES] } : {}),
  };
}

function omit(v: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out = { ...v };
  for (const k of keys) delete out[k];
  return out;
}

/**
 * ADR-0053: the inputs name the app's capacity cell, but cell 01 (every app before the cell reached the
 * templates) stays out of the view, so no existing app's i changes; another cell is in it.
 */
function withoutDefaultCell(v: Record<string, unknown>): Record<string, unknown> {
  return v.cell === DEFAULT_CELL_ID ? omit(v, ["cell"]) : v;
}

/**
 * The offline view of one unit of an app in env, or undefined when the unit doesn't apply there
 * (`entra` without sign-in; `frontdoor` in external Front Door mode, where provisioning deploys
 * nothing in Front Door). Throws CheckFailed when the inputs can't be rendered.
 *   lz        the landing-zone inputs without deliveryFederation, easyAuthSecretExists and the
 *             budget's startDate (runtime state, carried by the run)
 *   entra     the registration's inputs with the end-state redirect hosts (incarnation only above 0,
 *             ADR-0061), plus what decides the Container App's default host (network mode, cell,
 *             network, generation)
 *   release   the release inputs without what delivery owns (image, runtime, env, secrets, run), the
 *             landing-zone outputs and client ID, and coreVersion (the tag saf-core: a core version
 *             alone changes no unit's i); with the data services app.yaml asks for
 *   frontdoor the custom domain's inputs, or { hostName: null } without one (a removal changes it)
 * lz, release and frontdoor name the app's capacity cell only when it isn't 01 (withoutDefaultCell).
 *   pep       the portal-side endpoint's inputs
 */
export function unitView(unit: EnvUnit, app: AppData, inst: Instance, env: InstanceEnv): Record<string, unknown> | undefined {
  const state = offlineState(app, inst, env.name);
  switch (unit) {
    case "lz": {
      const v = withoutDefaultCell(omit(lzInputs(app, inst, env.name, state), ["deliveryFederation", "easyAuthSecretExists"]));
      if (isObject(v.budget)) v.budget = omit(v.budget, ["startDate"]);
      return v;
    }
    case "entra": {
      if (app.authentication.mode !== "required") return undefined;
      const appEnv = app.environments[env.name];
      // ADR-0061: incarnation 0 (every app before a slug was used again) stays out of the view, so no
      // existing app's i changes; a later incarnation is a new app anyway.
      const inputs = entraInputs(app, inst, env.name, state);
      return {
        ...(inputs.incarnation === 0 ? omit(inputs, ["incarnation"]) : inputs),
        defaultHost: {
          networkMode: appEnv?.networkMode ?? null,
          ...(cellOf(appEnv) === DEFAULT_CELL_ID ? {} : { cell: cellOf(appEnv) }),
          externalOnlyNetwork: env.networkModes.externalOnly?.network ?? null,
          hybridVnet: env.networkModes.externalHybrid?.vnet?.existingVnetId ?? null,
          generation: app.generation ?? 0,
        },
      };
    }
    case "release": {
      const v = withoutDefaultCell(omit(releaseInputs(app, inst, env.name, state, "reapply"), ["image", "runtime", "env", "secrets", "run", "landingZone", "coreVersion"]));
      if (isObject(v.authentication)) v.authentication = omit(v.authentication, ["clientId"]);
      v.data = { database: app.data?.database?.engine ?? null, storage: !!app.data?.storage };
      // ADR-0056: only a decommissioned app has the key, so no other app's i changes.
      if (app.decommission) v.retired = true;
      return v;
    }
    case "frontdoor": {
      if (!managedFrontDoor(inst)) return undefined;
      if (!requestedHost(app, inst, env.name)) return { prefix: inst.naming.prefix, environmentName: env.name, slug: app.slug, hostName: null };
      return withoutDefaultCell(frontDoorInputs(app, inst, env.name));
    }
    case "pep":
      return portalEndpointInputs(app, inst, env.name);
  }
}

/** `i` per unit; null when the inputs can't be rendered (the unit then always runs and never finishes). */
export interface DesiredApp {
  ado: string | null;
  /** filesHash of the app (sha256, 64 hex); saf-u-files holds its first 12. */
  files: string;
  environments: Record<string, Partial<Record<EnvUnit, string | null>>>;
  problems: string[];
}

export interface DesiredUnits {
  schemaVersion: 1;
  coreVersion: string;
  apps: Record<string, DesiredApp>;
}

interface AppsEntry {
  slug: string;
  file: string;
  ok: boolean;
  environments?: string[];
  authMode?: string;
  frontDoorHosts?: Record<string, string>;
  /** app.yaml environments.<env>.networkMode (ADR-0060: a move when the app runs in another). */
  networkModes?: Record<string, string>;
  /** app.yaml environments.<env>.cell (ADR-0053; absent in an older apps.json, and for an environment: 01). */
  cells?: Record<string, string>;
  /** app.yaml decommission (ADR-0056; immediate: the amendment of 2026-11-12). */
  decommission?: { requestedOn: string; deleteAfter: string; immediate?: true };
  /** ADR-0061: the slug has a deleted app's archive (apps-deleted/{slug}/), with the app's generation. */
  reusesSlug?: true;
  generation?: number;
}

/** The run's parameter `upgrade` (ADR-0049 section 4): none, all, or a list of slugs. */
export interface UpgradeParam {
  all: boolean;
  apps: string[];
}

export const NO_UPGRADE: UpgradeParam = { all: false, apps: [] };
/** At most this many slugs in one `upgrade` (a bulk upgrade beyond it is queued in waves). */
export const UPGRADE_MAX_APPS = 50;

/**
 * The queue-time parameter `upgrade` (ADR-0049 section 4): `none`, `all`, or slugs separated by
 * commas (spaces around them ignored), at most UPGRADE_MAX_APPS, each once. Throws CheckFailed on
 * any other shape. Whether each slug has an app definition is checked by validate-run.
 */
export function parseUpgradeParam(value: string): UpgradeParam {
  const label = "parameter upgrade";
  if (value.length > 4096) throw new CheckFailed([`${label} is longer than 4096 characters.`]);
  const v = value.trim();
  if (v === "none") return { all: false, apps: [] };
  if (v === "all") return { all: true, apps: [] };
  const slugs = v.split(",").map((s) => s.trim());
  const problems: string[] = [];
  const bad = slugs.filter((s) => !SLUG_RE.test(s) || s.length > 20);
  if (!v || bad.length) problems.push(`${label} must be none, all, or app slugs separated by commas (got "${v.slice(0, 80)}"${bad.length ? `; not a slug: "${(bad[0] ?? "").slice(0, 40)}"` : ""}).`);
  if (slugs.length > UPGRADE_MAX_APPS) problems.push(`${label} names ${slugs.length} apps; at most ${UPGRADE_MAX_APPS} in one run (queue the rest in another run, or use all).`);
  const twice = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  if (twice.length) problems.push(`${label} names ${twice[0]} more than once.`);
  if (problems.length) throw new CheckFailed(problems);
  return { all: false, apps: slugs };
}

interface AppsDoc {
  checkAllApps: boolean;
  upgrade: UpgradeParam;
  apps: AppsEntry[];
}

/** plan/apps.json (`platform provisioning apps`): the valid apps of this run. */
export function readAppsDoc(path: string): AppsDoc {
  const label = "--apps";
  const doc = readJson(path, 16 * MiB, label);
  if (!isObject(doc) || !Array.isArray(own(doc, "apps")) || typeof own(doc, "checkAllApps") !== "boolean") {
    throw new CheckFailed([`${label} must be the output of platform provisioning apps ({ checkAllApps, apps }).`]);
  }
  const apps: AppsEntry[] = [];
  for (const a of own(doc, "apps") as unknown[]) {
    if (!isObject(a) || typeof own(a, "slug") !== "string" || !SLUG_RE.test(own(a, "slug") as string)) throw new CheckFailed([`${label} lists an app without a valid slug.`]);
    if (own(a, "ok") !== true) {
      apps.push({ slug: own(a, "slug") as string, file: String(own(a, "file") ?? ""), ok: false });
      continue;
    }
    const envs = own(a, "environments");
    if (!Array.isArray(envs) || envs.some((e) => typeof e !== "string" || !ENV_NAME_RE.test(e))) throw new CheckFailed([`${label}: ${String(own(a, "slug"))} has no valid environments.`]);
    const hosts = own(a, "frontDoorHosts");
    const modes = own(a, "networkModes");
    const cells = own(a, "cells");
    if (cells !== undefined && (!isObject(cells) || Object.entries(cells).some(([e, c]) => !ENV_NAME_RE.test(e) || typeof c !== "string" || !CELL_ID_RE.test(c)))) {
      throw new CheckFailed([`${label}: ${String(own(a, "slug"))} has an invalid cells entry (01 to 99 per environment, ADR-0053).`]);
    }
    const dc = own(a, "decommission");
    if (dc !== undefined && (!isObject(dc) || !isDate(own(dc, "requestedOn")) || !isDate(own(dc, "deleteAfter")))) throw new CheckFailed([`${label}: ${String(own(a, "slug"))} has an invalid decommission entry.`]);
    // ADR-0061: a reused slug carries the app's generation (the guard against the old app's landing zone).
    const reused = own(a, "reusesSlug");
    const generation = own(a, "generation");
    if ((reused !== undefined && reused !== true) || (reused === true && !(Number.isSafeInteger(generation) && (generation as number) >= 0))) {
      throw new CheckFailed([`${label}: ${String(own(a, "slug"))} has an invalid reusesSlug or generation.`]);
    }
    apps.push({
      slug: own(a, "slug") as string,
      file: typeof own(a, "file") === "string" ? (own(a, "file") as string) : "",
      ok: true,
      environments: envs as string[],
      authMode: own(a, "authMode") === "required" ? "required" : "anonymous",
      frontDoorHosts: isObject(hosts) ? (Object.fromEntries(Object.entries(hosts).filter(([, h]) => typeof h === "string")) as Record<string, string>) : {},
      networkModes: isObject(modes) ? (Object.fromEntries(Object.entries(modes).filter(([e, m]) => ENV_NAME_RE.test(e) && (m === "externalOnly" || m === "externalHybrid"))) as Record<string, string>) : {},
      cells: isObject(cells) ? ({ ...cells } as Record<string, string>) : {},
      ...(isObject(dc) ? { decommission: { requestedOn: own(dc, "requestedOn") as string, deleteAfter: own(dc, "deleteAfter") as string, ...(own(dc, "immediate") === true ? { immediate: true as const } : {}) } } : {}),
      ...(reused === true ? { reusesSlug: true as const, generation: generation as number } : {}),
    });
  }
  // `upgrade` only widens a run: absent (an older apps.json) is none.
  let upgrade: UpgradeParam = NO_UPGRADE;
  const up = own(doc, "upgrade");
  if (up !== undefined) {
    if (!isObject(up) || typeof own(up, "all") !== "boolean" || !Array.isArray(own(up, "apps")) || (own(up, "apps") as unknown[]).some((s) => typeof s !== "string" || !SLUG_RE.test(s))) {
      throw new CheckFailed([`${label} upgrade must be { all, apps: [<slug>...] }.`]);
    }
    upgrade = { all: own(up, "all") as boolean, apps: [...(own(up, "apps") as string[])] };
  }
  return { checkAllApps: own(doc, "checkAllApps") as boolean, upgrade, apps };
}

/**
 * The files hash of an app (ADR-0049 section 3): sha256 over app.yaml's bytes and instance.yaml as
 * canonical JSON without coreVersion and coreReleases, each part length-prefixed ("<bytes>\n<part>").
 * Equal hashes mean the same settings: a unit whose `i` changed anyway changed only because the core
 * renders them differently. coreReleases (ADR-0067) names where core comes from, like coreVersion, and
 * no unit reads it: an instance adds it with its first coreVersion bump onto a core that knows it,
 * which must stay a bump alone.
 */
export function filesHash(appYaml: Buffer | string, inst: Record<string, unknown>): string {
  const app = Buffer.isBuffer(appYaml) ? appYaml : Buffer.from(appYaml, "utf8");
  const rest = { ...inst };
  delete rest.coreVersion;
  delete rest.coreReleases;
  const instJson = Buffer.from(canonicalJson(rest), "utf8");
  return createHash("sha256")
    .update("saf-unit-files v1\n")
    .update(`${app.length}\n`)
    .update(app)
    .update(`${instJson.length}\n`)
    .update(instJson)
    .digest("hex");
}

/** `platform provisioning units`: `i` of every unit of every valid app of plan/apps.json. */
export function desiredUnits(args: { instance: string; apps: string }): DesiredUnits {
  const inst = loadInstanceFile(args.instance);
  const doc = readAppsDoc(args.apps);
  const out: DesiredUnits = { schemaVersion: 1, coreVersion: inst.coreVersion, apps: {} };
  for (const entry of doc.apps) {
    if (!entry.ok) continue;
    const app = loadAppFile(entry.file, args.instance);
    if (app.slug !== entry.slug) throw new CheckFailed([`${entry.file} is the definition of ${app.slug}, not ${entry.slug}.`]);
    const envs = orderedEnvironments(app, inst);
    const problems: string[] = [];
    const render = (what: string, f: () => Record<string, unknown> | undefined): Record<string, unknown> | undefined | null => {
      try {
        return f();
      } catch (e) {
        if (!(e instanceof CheckFailed)) throw e;
        problems.push(...e.problems.map((p) => `${what}: ${p}`));
        return null;
      }
    };
    const desired: DesiredApp = { ado: null, files: filesHash(readFileSync(entry.file), inst as unknown as Record<string, unknown>), environments: {}, problems };
    // ADR-0056: a decommissioned app's delivery pipeline is disabled (only it gets the key).
    const ado = render("ado", () => {
      const view = adoOfflineView(inst as never, app, envs);
      return app.decommission && isObject(view) ? { ...view, delivery: "disabled" } : view;
    });
    desired.ado = ado ? unitHash("ado", ado) : null;
    for (const env of envs) {
      const units: Partial<Record<EnvUnit, string | null>> = {};
      for (const unit of ENV_UNITS) {
        const view = render(`${unit} in ${env.name}`, () => unitView(unit, app, inst, env));
        if (view === undefined) continue;
        units[unit] = view === null ? null : unitHash(unit, view);
      }
      desired.environments[env.name] = units;
    }
    out.apps[app.slug] = desired;
  }
  return out;
}

export function formatDesiredUnits(d: DesiredUnits): string {
  const lines = Object.entries(d.apps).map(([slug, a]) => {
    const envs = Object.entries(a.environments).map(([e, u]) => `${e}: ${Object.keys(u).join(" ")}`);
    return `ok  ${slug}: ado; ${envs.join("; ")}${a.problems.length ? ` (${a.problems.length} unit input problem(s): ${a.problems[0]})` : ""}`;
  });
  lines.push(`${Object.keys(d.apps).length} app(s), core ${d.coreVersion}.`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------------
// Tags
// ------------------------------------------------------------------------------------------

export interface UnitTag {
  version: string;
  i12: string;
  /** YYYY-MM-DD */
  date: string;
}

const TAG_RE = /^(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?) ([0-9a-f]{12}) (\d{4})(\d{2})(\d{2})$/;

/** A saf-u-<unit> value, or undefined when it has another shape (counts as no tag). */
export function parseUnitTag(v: unknown): UnitTag | undefined {
  if (typeof v !== "string" || v.length > 256) return undefined;
  const m = TAG_RE.exec(v);
  if (!m || !isCoreVersion(m[1]) || !validDate(`${m[3]}-${m[4]}-${m[5]}`)) return undefined;
  return { version: m[1]!, i12: m[2]!, date: `${m[3]}-${m[4]}-${m[5]}` };
}

export function formatUnitTag(version: string, i: string, date: string): string {
  return `${version} ${i.slice(0, 12)} ${date.replace(/-/g, "")}`;
}

function validDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

function dayNumber(d: string): number {
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
}

function addDays(d: string, n: number): string {
  return new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The stable offset of a unit's first recorded date (ADR-0048 section 7): sha256 of
 * "<slug>|<env>|<unit>" modulo driftCheckDays, in days. A unit recorded for the first time gets
 * today minus this, so the drift checks after the rollout spread over one cycle.
 */
export function driftOffset(slug: string, env: string, unit: UnitName, driftCheckDays: number): number {
  const h = createHash("sha256").update(`${slug}|${env}|${unit}`).digest();
  return h.readUInt32BE(0) % Math.max(1, driftCheckDays);
}

// ------------------------------------------------------------------------------------------
// Facts read by the jobs plan_<env> (plan.sh)
// ------------------------------------------------------------------------------------------

export interface SecretFacts {
  state: "present" | "absent";
  created: number | null;
  expires: number | null;
  /** The version the app's active revisions are known to run with (epoch seconds), or null. */
  loaded: number | null;
}

/** facts/<slug>.json of plan_<env>: what plan.sh read from Azure for the app there. */
export interface AppFacts {
  resourceGroup: string;
  /** The saf-* tags of the app resource group (lower-case keys). */
  tags: Record<string, string>;
  /** The landing-zone record lz-{slug}-{env}: ok (Succeeded, with outputs), absent, or unusable. */
  lzRecord: "ok" | "absent" | "unusable";
  /** The record's deliveryFederation is set (the app's service connection exists). */
  federation: boolean;
  /** The record's easyAuthSecretExists (the Easy Auth identity's role on its secret is deployed). */
  easyAuthInLandingZone: boolean;
  /** Sign-in apps with a landing zone: the Easy Auth secret entry; null otherwise or unknown. */
  secret: SecretFacts | null;
  /** The record fd-{slug}-{env} exists (a custom domain deployed, or a removal not finished). */
  frontDoorRecord: boolean;
  /** The release record's Front Door backend ranges differ from the ones read in this run. */
  rangesChanged: boolean;
  /** Sign-in apps: the name of the registration's deployment entra-{slug}-{env} (names.bicep). */
  entraDeployment: string | null;
  /** ADR-0056: the app resource group is in the group list (absent in an older facts file: assumed to exist). */
  resourceGroupExists?: boolean;
  /** ADR-0056: the Container App's runningStatus is Stopped (true), something else (false), or unknown/absent (null). */
  containerAppStopped?: boolean | null;
  /**
   * ADR-0059: the images the app's Container App runs (containers and init containers, as listed); [] when
   * there is no Container App, null (or absent, an older facts file) when the Container Apps weren't read.
   */
  images?: string[] | null;
  /** ADR-0059: the registry the landing-zone record names (output registryName), or null. */
  registryName?: string | null;
  /** ADR-0059: the landing-zone record says the provisioning identity holds the purge role (output registryPurgeRole). */
  registryPurgeRole?: boolean;
  /**
   * ADR-0060: the network mode the app's Container App runs in now (its environmentId by naming): none
   * without a Container App, unknown for a CAE named for no mode, null (or absent) when not read.
   */
  containerAppMode?: "externalOnly" | "externalHybrid" | "none" | "unknown" | null;
  /** ADR-0053: the capacity cell of the CAE the app runs in now (with a containerAppMode that is a mode), or null. */
  containerAppCell?: string | null;
  /** ADR-0060: the live app's ingress FQDN (its host in the source CAE during a move), or null. */
  liveFqdn?: string | null;
  /** ADR-0060: the landing-zone record's networkMode, and the source mode of its prepare pass (modeChange), or null. */
  lzNetworkMode?: string | null;
  lzPrepareFrom?: string | null;
  /** ADR-0060: easyauth-{slug} is left in the other variant's vault while the app runs in app.yaml's (the follow-up). */
  secretElsewhere?: boolean;
}

/** plan.json of plan_<env>. */
export interface EnvFacts {
  environment: string;
  /** The one `az group list` of the environment worked (else every unit counts as untagged). */
  tagsRead: boolean;
  /**
   * Only in plan_<hostEnvironment>: the deployments of every environment's Entra records group
   * rg-{prefix}-entra-{env} and of the instance's rg-{prefix}-entra (the records deployed before
   * ADR-0063), the most recent of each name with the group it is in; null when a list was unreadable.
   */
  entraRecords?: { name: string; state: string; group?: string }[] | null;
  /** Per valid app of the environment whose plan unit is ok. */
  apps: Record<string, AppFacts>;
  /** Apps whose plan unit is not ok there (their units don't run; report fails the run). */
  failed: string[];
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function epochOrNull(v: unknown, label: string, problems: string[]): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 946_684_800 && v < 4_102_444_800) return v;
  problems.push(`${label} must be epoch seconds or null.`);
  return null;
}

export function parseAppFacts(v: unknown, label: string): AppFacts {
  if (!isObject(v)) throw new CheckFailed([`${label} must be a JSON object.`]);
  const problems: string[] = [];
  const rg = str(own(v, "resourceGroup"));
  if (!rg || !/^[-a-z0-9._()]{1,90}$/i.test(rg)) problems.push(`${label} resourceGroup must be a resource group name.`);
  const tagsIn = own(v, "tags");
  const tags: Record<string, string> = {};
  if (!isObject(tagsIn)) problems.push(`${label} tags must be an object.`);
  else for (const [k, t] of Object.entries(tagsIn)) if (typeof t === "string" && k.toLowerCase().startsWith("saf-")) tags[k.toLowerCase()] = t;
  const lz = own(v, "lzRecord");
  if (lz !== "ok" && lz !== "absent" && lz !== "unusable") problems.push(`${label} lzRecord must be ok, absent or unusable.`);
  for (const k of ["federation", "easyAuthInLandingZone", "frontDoorRecord", "rangesChanged"]) if (typeof own(v, k) !== "boolean") problems.push(`${label} ${k} must be true or false.`);
  let secret: SecretFacts | null = null;
  const s = own(v, "secret");
  if (s !== null && s !== undefined) {
    if (!isObject(s) || (own(s, "state") !== "present" && own(s, "state") !== "absent")) problems.push(`${label} secret must be null or { state: present|absent, created, expires, loaded }.`);
    else secret = { state: own(s, "state") as "present" | "absent", created: epochOrNull(own(s, "created"), `${label} secret.created`, problems), expires: epochOrNull(own(s, "expires"), `${label} secret.expires`, problems), loaded: epochOrNull(own(s, "loaded"), `${label} secret.loaded`, problems) };
  }
  for (const k of ["resourceGroupExists"]) if (own(v, k) !== undefined && typeof own(v, k) !== "boolean") problems.push(`${label} ${k} must be true or false.`);
  const stopped = own(v, "containerAppStopped");
  if (stopped !== undefined && stopped !== null && typeof stopped !== "boolean") problems.push(`${label} containerAppStopped must be true, false or null.`);
  const entra = own(v, "entraDeployment");
  if (entra !== null && entra !== undefined && (typeof entra !== "string" || !/^[-a-z0-9]{1,64}$/.test(entra))) problems.push(`${label} entraDeployment must be null or a deployment name.`);
  // ADR-0059: the registry purge's facts (absent in an older facts file: nothing is purged).
  const images = own(v, "images");
  if (images !== undefined && images !== null && (!Array.isArray(images) || images.length > 50 || images.some((i) => typeof i !== "string" || i.length > 600))) problems.push(`${label} images must be null or at most 50 image references.`);
  const registry = own(v, "registryName");
  if (registry !== undefined && registry !== null && (typeof registry !== "string" || !/^[a-z0-9]{5,50}$/.test(registry))) problems.push(`${label} registryName must be null or a registry name.`);
  if (own(v, "registryPurgeRole") !== undefined && typeof own(v, "registryPurgeRole") !== "boolean") problems.push(`${label} registryPurgeRole must be true or false.`);
  // ADR-0060: the network mode change's facts (absent in an older facts file: no move is detected).
  const liveMode = own(v, "containerAppMode");
  if (liveMode !== undefined && liveMode !== null && !["externalOnly", "externalHybrid", "none", "unknown"].includes(liveMode as string)) problems.push(`${label} containerAppMode must be externalOnly, externalHybrid, none, unknown or null.`);
  const liveCell = own(v, "containerAppCell");
  if (liveCell !== undefined && liveCell !== null && (typeof liveCell !== "string" || !CELL_ID_RE.test(liveCell))) problems.push(`${label} containerAppCell must be a cell (01 to 99) or null.`);
  const fqdn = own(v, "liveFqdn");
  if (fqdn !== undefined && fqdn !== null && (typeof fqdn !== "string" || fqdn.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(fqdn))) problems.push(`${label} liveFqdn must be null or a host name.`);
  for (const k of ["lzNetworkMode", "lzPrepareFrom"]) {
    const m = own(v, k);
    if (m !== undefined && m !== null && m !== "externalOnly" && m !== "externalHybrid") problems.push(`${label} ${k} must be externalOnly, externalHybrid or null.`);
  }
  if (own(v, "secretElsewhere") !== undefined && typeof own(v, "secretElsewhere") !== "boolean") problems.push(`${label} secretElsewhere must be true or false.`);
  if (problems.length) throw new CheckFailed(problems);
  return {
    resourceGroup: rg!,
    tags,
    lzRecord: lz as AppFacts["lzRecord"],
    federation: own(v, "federation") as boolean,
    easyAuthInLandingZone: own(v, "easyAuthInLandingZone") as boolean,
    secret,
    frontDoorRecord: own(v, "frontDoorRecord") as boolean,
    rangesChanged: own(v, "rangesChanged") as boolean,
    entraDeployment: typeof entra === "string" ? entra : null,
    ...(typeof own(v, "resourceGroupExists") === "boolean" ? { resourceGroupExists: own(v, "resourceGroupExists") as boolean } : {}),
    ...(stopped === null || typeof stopped === "boolean" ? { containerAppStopped: stopped } : {}),
    ...(images === null || Array.isArray(images) ? { images: images === null ? null : [...(images as string[])] } : {}),
    ...(typeof registry === "string" || registry === null ? { registryName: registry as string | null } : {}),
    ...(typeof own(v, "registryPurgeRole") === "boolean" ? { registryPurgeRole: own(v, "registryPurgeRole") as boolean } : {}),
    ...(liveMode === null || typeof liveMode === "string" ? { containerAppMode: liveMode as AppFacts["containerAppMode"] } : {}),
    ...(liveCell === null || typeof liveCell === "string" ? { containerAppCell: liveCell as string | null } : {}),
    ...(fqdn === null || typeof fqdn === "string" ? { liveFqdn: fqdn as string | null } : {}),
    ...(own(v, "lzNetworkMode") === null || typeof own(v, "lzNetworkMode") === "string" ? { lzNetworkMode: own(v, "lzNetworkMode") as string | null } : {}),
    ...(own(v, "lzPrepareFrom") === null || typeof own(v, "lzPrepareFrom") === "string" ? { lzPrepareFrom: own(v, "lzPrepareFrom") as string | null } : {}),
    ...(typeof own(v, "secretElsewhere") === "boolean" ? { secretElsewhere: own(v, "secretElsewhere") as boolean } : {}),
  };
}

/**
 * The artifact of a job plan_<env>: plan.json, status/<slug>.<env>.json and facts/<slug>.json per
 * app. An app counts only with status ok and its facts file; any other is failed there.
 */
export function readEnvPlan(dir: string, env: string, slugs: string[]): EnvFacts | undefined {
  const label = `plan_${env}`;
  const planFile = join(dir, "plan.json");
  if (!existsSync(planFile)) return undefined;
  const doc = readJson(planFile, 4 * MiB, `${label}/plan.json`);
  if (!isObject(doc) || own(doc, "environment") !== env || typeof own(doc, "tagsRead") !== "boolean") {
    throw new CheckFailed([`${label}/plan.json must be { environment: "${env}", tagsRead, entraRecords? }.`]);
  }
  let entraRecords: EnvFacts["entraRecords"];
  if (Object.hasOwn(doc, "entraRecords")) {
    const r = own(doc, "entraRecords");
    if (r === null) entraRecords = null;
    else if (Array.isArray(r) && r.every((x) => isObject(x) && typeof own(x, "name") === "string" && (own(x, "group") === undefined || typeof own(x, "group") === "string"))) {
      entraRecords = (r as Record<string, unknown>[]).map((x) => ({ name: own(x, "name") as string, state: str(own(x, "state")) ?? "", ...(typeof own(x, "group") === "string" ? { group: own(x, "group") as string } : {}) }));
    } else throw new CheckFailed([`${label}/plan.json entraRecords must be null or a list of { name, state, group? }.`]);
  }
  const out: EnvFacts = { environment: env, tagsRead: own(doc, "tagsRead") as boolean, ...(entraRecords !== undefined ? { entraRecords } : {}), apps: {}, failed: [] };
  for (const slug of slugs) {
    const status = join(dir, "status", `${slug}.${env}.json`);
    const facts = join(dir, "facts", `${slug}.json`);
    const st = existsSync(status) ? readJson(status, 1 * MiB, `${label}/status/${slug}.${env}.json`) : undefined;
    if (!isObject(st) || own(st, "status") !== "ok" || !existsSync(facts)) {
      out.failed.push(slug);
      continue;
    }
    out.apps[slug] = parseAppFacts(readJson(facts, 1 * MiB, `${label}/facts/${slug}.json`), `${label}/facts/${slug}.json`);
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// The decision (ADR-0048 section 4)
// ------------------------------------------------------------------------------------------

export interface UnitDecision {
  run: boolean;
  reasons: Reason[];
  /** What rule 4 (dependency) and rule 3 (inputs) found, in plain words. */
  details: string[];
  /** The tag as the plan read it (record_<env> deletes exactly this value when the unit doesn't finish). */
  tag: string | null;
  /** What record_<env> writes when the unit finishes in this run; null when it can't be recorded. */
  record: string | null;
  /** The tag's version is older than the unit's `since` (ADR-0049: the unit is behind). */
  outdated: boolean;
  /** Outdated and not run in this run: it waits for its upgrade (reason held). */
  held: boolean;
  /**
   * Time-based work that would have run this unit but waits for the maintenance window (ADR-0048
   * section 7, amended 2026-11-11): a drift check, an Easy Auth rotation or restart, the Front Door
   * backend ranges. Only on a unit that doesn't run in the end; empty otherwise.
   */
  waits: string[];
  /**
   * Rebase (ADR-0049 section 3): the unit is outdated, its `i` differs only because this core
   * renders the same files differently (saf-u-files unchanged). record_<env> writes this value
   * (the tag's version and date, the new `i`) although the unit doesn't run; null otherwise.
   */
  rebase: string | null;
  /**
   * ADR-0056: what the unit does when it runs; absent = apply (as always). `retire` (release: stop the
   * Container App), `delete` (remove the unit's objects; record writes "removed YYYYMMDD"). ADR-0060:
   * `move` (release: the network mode change's move step, EnvDecision.modeChange).
   */
  action?: "retire" | "delete" | "move";
}

/**
 * ADR-0060: a network mode change of the app in an environment, runtime state of this run (never part of
 * a unit's view, so no fingerprint or `i` changes with it). case A: the vault variant changes (the managed
 * network <-> a VNet-based mode: the Easy Auth secret is re-issued in the target vault); case B: both
 * modes are VNet-based (the private endpoints move to the other spoke). fromHost: the live app's host in
 * the source CAE, kept as a second Entra redirect host until the move (null when the app is gone).
 * resume: the app is gone already (an earlier run deleted it, or it never ran): the move resumes after
 * its delete. waitsForWindow (product owner, 2026-11-14): in an environment of kind prod the move's
 * disruptive part (the Joiner's removal, the delete, the re-create) runs only inside the maintenance
 * window; outside it, the start of the next window (ISO 8601, UTC), and the move step waits after the
 * prepare pass and the Entra step, which run at once. null in kind nonprod, inside the window, and for a
 * resumed move (the app is down already, or never ran there: waiting would only prolong it).
 * fromCell, toCell (ADR-0053, ADR-0060 amendment 2026-11-16): the capacity cell of the source CAE (the live
 * app's; null for a resumed move) and of the target CAE (app.yaml's); the move places the app in a cell of
 * the target mode, which needn't have the source's number.
 */
export interface ModeChange {
  from: "externalOnly" | "externalHybrid";
  to: "externalOnly" | "externalHybrid";
  case: "A" | "B";
  fromHost: string | null;
  resume: boolean;
  waitsForWindow: string | null;
  fromCell: string | null;
  toCell: string;
}

export interface EnvDecision {
  /** The plan unit of the app in this environment: failed = nothing runs there in this run. */
  plan: "ok" | "failed";
  resourceGroup: string | null;
  /** saf-u-files as the plan read it (12 hex), or null; written back after a landing-zone deployment. */
  filesTag: string | null;
  /** saf-u-files that record_<env> writes with the unit tags (12 hex of this run's filesHash). */
  files: string | null;
  /** The tag saf-provisioned (ADR-0046) to delete, as read. */
  legacyTag: string | null;
  /** Managed Front Door: the registration finishes only with one redirect host (the end state). */
  entraSingleHost: boolean;
  units: Partial<Record<UnitName, UnitDecision>>;
  /**
   * ADR-0056, the tag saf-u-retired: as read (YYYYMMDD) or null; `record` the value record_<env>
   * writes when the release's retire finishes and there is none yet; `remove` true when the app is
   * active again (Cancel) and record_<env> deletes the tag as read.
   */
  retired?: { tag: string | null; record: string | null; remove: boolean };
  /** ADR-0056: decommissioned, and nothing is left of the app in this environment (leftInEnvironment). */
  gone?: boolean;
  /** ADR-0060: the app moves to app.yaml's network mode in this run (release action move). */
  modeChange?: ModeChange;
  /**
   * ADR-0060 decision 8, the follow-up of a case A move: the Easy Auth secret is left in the other
   * variant's vault while the app runs in the new one; the entra unit runs `easyauth-secret --mode
   * remove-old` (any run: cleanup of an approved change, not time-based work).
   */
  followUp?: "remove-old";
}

export interface AppDecision {
  ado: { run: boolean; reasons: Reason[]; details: string[] };
  environments: Record<string, EnvDecision>;
  /**
   * ADR-0056, a decommissioned app: its phase in this run (retired: stopped, the rest frozen;
   * deleting: the delete actions; deleted: due and nothing left anywhere, read in this run, the
   * amendment of 2026-11-12), the dates, the first day the delete phase may start (null while an
   * environment with its group hasn't recorded its stop), and what waits.
   */
  decommission?: { phase: "retired" | "deleting" | "deleted"; requestedOn: string; deleteAfter: string; dueOn: string | null; waits: string[]; immediate?: true; withProduction?: string[] };
}

/** The run's time against the maintenance window (ADR-0048 section 7, amended 2026-11-11). */
export interface PlanMaintenance {
  /** The run's time, epoch seconds (UTC): the one time every decision of the run uses. */
  now: number;
  /** now is inside instance.yaml maintenance.window. */
  inWindow: boolean;
  window: MaintenanceWindow;
  /** Inside: the end of this window; outside: the start of the next one (ISO 8601, UTC). */
  until: string;
}

export interface RunPlan {
  schemaVersion: 1;
  coreVersion: string;
  today: string;
  driftCheckDays: number;
  /** Time-based work runs only inside the window, an urgent rotation at any time (ADR-0048 section 7, amended). */
  maintenance: PlanMaintenance;
  checkAllApps: boolean;
  /** The run's parameter `upgrade` (ADR-0049 section 4). */
  upgrade: UpgradeParam;
  /** upgrades.yaml minAppVersion of this core. */
  minAppVersion: string;
  hostEnvironment: string;
  environments: string[];
  /**
   * The outputs of the step decide: lz_<env>, post_<env>, record_<env>, ado, entraPlan (the stage
   * entra_plan: an entra unit runs together with its landing zone; ADR-0050).
   */
  stages: Record<string, boolean>;
  apps: Record<string, AppDecision>;
}

export interface PlanInput {
  inst: Instance;
  apps: AppsDoc;
  desired: DesiredUnits;
  manifest: UnitManifest;
  /** infra/app/upgrades.yaml of this core (ADR-0049): minAppVersion and requires. */
  upgrades: UpgradeNotes;
  /** Per environment of the instance: its plan, or undefined when its job left none. */
  plans: Record<string, EnvFacts | undefined>;
  today: string;
  /**
   * The run's time, epoch seconds: the maintenance window (time-based work only inside it) and the
   * Easy Auth rotation check (rotation-due); default the current time. Injected, so it is testable.
   */
  now?: number;
}

/** A rotation with at most this many days left can't wait for the window (prov-lib.sh prov_secret_urgent). */
export const URGENT_ROTATION_DAYS = 14;

/** The secret expires within URGENT_ROTATION_DAYS or has expired. */
export function rotationUrgent(expires: number | null, now: number): boolean {
  return expires !== null && expires - now < URGENT_ROTATION_DAYS * 86_400;
}

function addReason(d: UnitDecision, r: Reason, detail?: string): void {
  if (!d.reasons.includes(r)) d.reasons.push(r);
  if (detail && !d.details.includes(detail)) d.details.push(detail);
  d.run = true;
}

/** What makes an outdated unit run with this core's template (ADR-0049 section 2). */
const UPGRADING: readonly Reason[] = ["new", "inputs", "dependency", "upgrade", "minAppVersion", "requires"];
/** Reasons a held unit's partner must not upgrade it for (drift checks and scope all only check). */
const CHECK_ONLY: readonly Reason[] = ["drift", "all"];

/** "lz changed in v0.1.0-rc.33; applied by v0.1.0-rc.31" */
function behind(unit: UnitName, since: string, applied: string): string {
  return `${unit} changed in ${since}; applied by ${applied}`;
}

/** The facts of one unit before the decision: its tag, against its i, units.json and the date. */
interface UnitFacts {
  unit: UnitName;
  tag: UnitTag | undefined;
  since: string;
}

/**
 * Rules 1, 3, 5 and 6 for one unit, and whether it is outdated (rule 2, which ADR-0049 amends: an
 * outdated unit is decided later, in hold()). `ado` is never held, so its rule 2 applies here. A
 * rebase (ADR-0049 section 3) replaces rule 3 for an outdated unit whose app files are unchanged.
 */
function baseDecision(unit: UnitName, i: string | null | undefined, rawTag: string | undefined, input: PlanInput, driftCheckDays: number, slug: string, env: string, filesUnchanged: boolean, inWindow: boolean): { d: UnitDecision; f: UnitFacts } {
  const tag = parseUnitTag(rawTag);
  const since = input.manifest.units[unit].since;
  const d: UnitDecision = { run: false, reasons: [], details: [], tag: rawTag ?? null, record: null, outdated: false, held: false, rebase: null, waits: [] };
  if (!tag) addReason(d, "new", rawTag === undefined ? undefined : `the tag ${TAG_PREFIX}${unit} has an unexpected value`);
  else {
    d.outdated = compareVersions(tag.version, since) < 0;
    if (d.outdated && unit === "ado") addReason(d, "template", behind(unit, since, tag.version));
    if (!i) addReason(d, "inputs", `the inputs of ${unit} could not be rendered`);
    else if (tag.i12 !== i.slice(0, 12)) {
      if (d.outdated && unit !== "ado" && filesUnchanged) {
        d.rebase = formatUnitTag(tag.version, i, tag.date);
        d.details.push("rebased");
      } else addReason(d, "inputs", `the inputs of ${unit} changed`);
    }
    // Rule 5, only inside the maintenance window (ADR-0048 section 7, amended 2026-11-11).
    if (dayNumber(input.today) - dayNumber(tag.date) >= driftCheckDays) {
      if (inWindow) addReason(d, "drift", `${unit} last checked ${tag.date}`);
      else d.waits.push(`drift check (last checked ${tag.date})`);
    }
  }
  if (input.apps.checkAllApps) addReason(d, "all");
  if (i) d.record = formatUnitTag(input.inst.coreVersion, i, tag ? input.today : addDays(input.today, -driftOffset(slug, env, unit, driftCheckDays)));
  return { d, f: { unit, tag, since } };
}

/** An outdated unit that runs applies this core's template: reason template, no rebase. */
function upgrading(d: UnitDecision, f: UnitFacts): void {
  if (!d.outdated || !f.tag) return;
  addReason(d, "template", behind(f.unit, f.since, f.tag.version));
  d.held = false;
  d.rebase = null;
  d.details = d.details.filter((x) => x !== "rebased");
}

/** A unit that doesn't run now runs for `reason` (a dependency or `requires`). */
function wake(d: UnitDecision, f: UnitFacts, reason: Reason, detail: string): void {
  if (d.held) {
    d.held = false;
    d.reasons = [];
  }
  addReason(d, reason, detail);
  upgrading(d, f);
}

/**
 * ADR-0049 section 2 for one outdated unit (not ado): it runs when the app is in the run's
 * `upgrade` (1), when it was applied by a version older than minAppVersion (2), or when it runs
 * anyway for a reason of ADR-0048 rules 1, 3 or 4 (3); otherwise it is held. A held unit doesn't
 * run, also not for a drift check or scope all, and keeps its tag (or gets its rebase).
 */
function hold(d: UnitDecision, f: UnitFacts, upgradeApp: boolean, minAppVersion: string): void {
  if (!d.outdated || !f.tag || f.unit === "ado") return;
  if (upgradeApp) addReason(d, "upgrade");
  else if (compareVersions(f.tag.version, minAppVersion) < 0) addReason(d, "minAppVersion", `${f.unit} was applied by ${f.tag.version}, older than minAppVersion ${minAppVersion}`);
  if (d.reasons.some((r) => UPGRADING.includes(r))) {
    upgrading(d, f);
    return;
  }
  d.run = false;
  d.held = true;
  d.reasons = ["held"];
  d.details = [behind(f.unit, f.since, f.tag.version), ...(d.rebase ? ["rebased"] : [])];
}

/** The cells of a move for the plan's lines (ADR-0053): nothing while both are 01 (every move before cells). */
function cellsOfMove(m: ModeChange): string {
  if ((m.fromCell ?? DEFAULT_CELL_ID) === DEFAULT_CELL_ID && m.toCell === DEFAULT_CELL_ID) return "";
  return m.fromCell === null ? `, into cell ${m.toCell}` : `, cell ${m.fromCell} to cell ${m.toCell}`;
}

const toDate = (yyyymmdd: string): string => `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;

/**
 * ADR-0060 decision 3: a network mode change of an active app in an environment, from the plan's facts.
 *   - the live app runs in another mode's CAE than app.yaml names: a move from that mode;
 *   - no Container App, and its landing-zone record names another mode (a prepare pass's source, or the
 *     record's own mode before any prepare pass): a resumed move (an earlier run deleted the app, or it
 *     never ran there), from that mode; the move step starts after the delete.
 * Nothing when the Container Apps weren't read (null), the CAE is named for no mode (unknown), or app.yaml
 * names no mode of iteration 1. case A when the environment vault variant changes, B otherwise. The cells
 * (ADR-0053): from the live app's (null when resumed), to app.yaml's `toCell`.
 */
export function detectModeChange(to: string | undefined, f: AppFacts, externalOnlyNetwork: string, toCell: string = DEFAULT_CELL_ID): ModeChange | undefined {
  if (to !== "externalOnly" && to !== "externalHybrid") return undefined;
  const isMode = (m: unknown): m is ModeChange["from"] => m === "externalOnly" || m === "externalHybrid";
  const live = f.containerAppMode;
  let from: ModeChange["from"] | undefined;
  let resume = false;
  if (isMode(live) && live !== to) from = live;
  else if (live === "none" && f.lzRecord !== "absent") {
    if (isMode(f.lzPrepareFrom) && f.lzPrepareFrom !== to) from = f.lzPrepareFrom;
    else if (isMode(f.lzNetworkMode) && f.lzNetworkMode !== to) from = f.lzNetworkMode;
    resume = from !== undefined;
  }
  if (!from) return undefined;
  const changed = environmentVaultVariant(from, externalOnlyNetwork) !== environmentVaultVariant(to, externalOnlyNetwork);
  const fromCell = resume ? null : (f.containerAppCell ?? DEFAULT_CELL_ID);
  return { from, to, case: changed ? "A" : "B", fromHost: resume ? null : (f.liveFqdn ?? null), resume, waitsForWindow: null, fromCell, toCell };
}

/**
 * What is left of a decommissioned app in an environment (ADR-0056 amendment 2026-11-12, deleted
 * detected), from the lists the plan reads anyway (ADR-0050: no call per app): its resource group
 * (`az group list`), its landing-zone record lz-{slug}-{env} (the deployments at subscription scope),
 * its custom domain's record fd-{slug}-{env} (the deployments of the platform resource group) and,
 * from the lists of the Entra groups in the plan of portal.hostEnvironment (rg-{prefix}-entra-{env} and
 * the instance's rg-{prefix}-entra, ADR-0063), its Entra registration's record entra-{slug}-{env} in
 * any state. Empty: the environment is gone. `entra`
 * undefined or null (that list wasn't read): the Entra record counts as unknown, never as gone.
 */
export function leftInEnvironment(slug: string, env: string, f: AppFacts, entra: ReadonlySet<string> | null | undefined): string[] {
  const out: string[] = [];
  if (f.resourceGroupExists !== false) out.push(`the resource group ${f.resourceGroup}`);
  if (f.lzRecord !== "absent") out.push(`the landing-zone record ${names.provisioningDeployment(slug, env)}`);
  if (f.frontDoorRecord) out.push(`the custom domain's record ${names.frontDoorDeployment(slug, env)}`);
  if (entra && entra.has(names.entraDeployment(slug, env))) out.push(`the Entra registration's record ${names.entraDeployment(slug, env)}`);
  return out;
}

/**
 * A decommissioned app (ADR-0056). No rule of ADR-0048 or ADR-0049 runs a unit of it; instead:
 *
 * Phase (the same for every environment):
 *   deleted   the delete phase is due by the dates (today is deleteAfter or later; immediate: from
 *             the merge), every environment of the app was planned, the Entra records were read and
 *             nothing is left in any environment (leftInEnvironment). Nothing runs, at any time: the
 *             maintenance window gates work, and there is none (ADR-0056 amendment 2026-11-12, deleted
 *             detected; nobody marks the app). The report and decommission.json say so, the portal
 *             reads it from there;
 *   deleting  due, every environment with its resource group has recorded its stop (saf-u-retired)
 *             at least decommission.graceDays ago, every environment was planned, the run is inside
 *             the maintenance window (immediate: at any time), and something is left;
 *   retired   otherwise (a due delete outside the window waits).
 *
 * retired, per environment whose resource group exists:
 *   release  action retire: runs when the stop isn't recorded (no saf-u-retired), its tag doesn't
 *            match (the retired view's i: the block was just added), the Container App is found
 *            running (containerAppStopped false), or the run checks every app; record writes the
 *            unit tag and, the first time, saf-u-retired = today;
 *   ado      new, inputs (the pipeline disabled: its view changed), drift (in the window), all;
 *   lz, entra, frontdoor, pep: frozen (no drift check, rotation, upgrade or dependency).
 * deleting, per environment whose resource group exists:
 *   step 1   ado, entra, frontdoor, pep with action delete, unless their tag says removed;
 *   step 2   lz with action delete, only once every step-1 unit of that environment is removed
 *            (recorded by an earlier run), so data goes last and at least one run after the rest.
 * deleting, per environment whose resource group is gone but something is left (step 2 deleted the
 * group and not yet its record, or a person deleted the group): nothing can be tagged there any more.
 *   lz       action delete while its record is left (step 2 resumed: the group is gone already, its
 *            nested records and the record go; lz_delete);
 *   entra    action delete when its record is left and lz doesn't run (by uniqueName alone, ADR-0056
 *            section 5; record writes nothing, the next plan reads the record gone);
 *   a custom domain's record left without the group: reported (waits); its removal reads the landing
 *            zone's record, a person removes it (runbook decommission-app.md).
 * An environment with nothing left runs nothing (gone). An environment that wasn't planned (its plan
 * failed) runs nothing and keeps the phase retired.
 *
 * Immediate (amendment 2026-11-12; app.yaml decommission.immediate, only without production): the
 * phase is deleting as soon as every environment was planned, without deleteAfter, graceDays or the
 * maintenance window. The order and the guards stay: in the first run the release retires (stops) the
 * app where its stop isn't recorded or it runs, beside step 1 (ado and entra in their stages before
 * azure_post_<env>, frontdoor after the stop in the same job, pep in the host's stage); step 2 (lz)
 * waits until step 1 is removed AND the stop is recorded (saf-u-retired), so it is always a later run.
 * An immediate block on an app with an environment of kind prod (the build validation refuses the request; a block merged while the setting below was on stays valid) is planned
 * like an ordinary decommissioning and the report says so, unless instance.yaml
 * decommission.allowImmediateWithProduction is true (amendment 2026-11-21, platform development only):
 * then the app is deleted immediately like one without production, with the same order and guards,
 * and its plan entry names the production environments (withProduction). Switched off while such a
 * deletion is under way, the app goes on as an ordinary decommissioning: the grace period from its
 * stop, then the window.
 *
 * Once the delete phase has started nothing comes back (section 4, "nothing is recreated"): in the
 * retired phase (a due delete outside the window, or an immediate deletion the plan no longer allows)
 * ado never runs while any environment's ado tag says removed, because its apply would create the
 * pipeline, service connections and environments that step 1 deleted.
 */
function decommissionDecision(entry: AppsEntry, input: PlanInput, driftCheckDays: number, inWindow: boolean, managed: boolean, entra: ReadonlySet<string> | null | undefined): AppDecision {
  const { apps, desired, plans, today } = input;
  const dc = entry.decommission!;
  const slug = entry.slug;
  const { graceDays, allowImmediateWithProduction } = decommissionSettings(input.inst as DecommissionInstanceView);
  const want = desired.apps[slug];
  const app: AppDecision = { ado: { run: false, reasons: [], details: [] }, environments: {} };
  const envs = entry.environments ?? [];
  // Immediate only without production (as app.yaml is now), or with the instance's setting for
  // platform development (amendment 2026-11-21): checked again here, fail closed.
  const production = (input.inst.environments ?? []).filter((e) => e.kind === "prod" && envs.includes(e.name)).map((e) => e.name);
  const immediate = dc.immediate === true && (production.length === 0 || allowImmediateWithProduction);
  const factsOf = (env: string): AppFacts | undefined => plans[env]?.apps[slug];
  const tagsOf = (env: string): Record<string, string> => (plans[env]?.tagsRead ? (factsOf(env)?.tags ?? {}) : {});
  const groupExists = (f: AppFacts): boolean => f.resourceGroupExists !== false;

  // When the delete phase may start: deleteAfter, and graceDays after the stop of every environment
  // whose resource group exists (a group that is gone has nothing left to stop).
  let dueOn: string | null = dc.deleteAfter;
  let allPlanned = true;
  const left: Record<string, string[]> = {};
  for (const env of envs) {
    const f = factsOf(env);
    if (!f || !want?.environments[env]) {
      allPlanned = false;
      continue;
    }
    left[env] = leftInEnvironment(slug, env, f, entra);
    if (!groupExists(f)) continue;
    const r = tagsOf(env)[RETIRED_TAG];
    if (r === undefined || !/^\d{8}$/.test(r) || !validDate(toDate(r))) {
      dueOn = null;
      continue;
    }
    const after = addDays(toDate(r), graceDays);
    if (dueOn !== null && dayNumber(after) > dayNumber(dueOn)) dueOn = after;
  }
  if (immediate) dueOn = dc.requestedOn;
  const due = allPlanned && (immediate || (dueOn !== null && dayNumber(today) >= dayNumber(dueOn)));
  const entraKnown = entra !== undefined && entra !== null;
  // Deleted: nothing left anywhere, read in this run (never assumed: an environment not planned or the
  // Entra records not read keep the app in the phase it is in).
  const deleted = due && entraKnown && envs.every((env) => left[env]?.length === 0);
  const waits: string[] = [];
  if (dc.immediate === true && !immediate) {
    waits.push(`decommission: immediate refused, the app has production (${production.join(", ")}) and instance.yaml decommission.allowImmediateWithProduction is off; deleted after the grace period instead`);
  }
  if (due && !deleted && !entraKnown) waits.push(`decommission: the Entra records of ${provisioningHostEnvironment(input.inst)} were not read in this run; whether anything is left is told in a later run`);
  if (due && !deleted && !inWindow && !immediate) waits.push("decommission: the delete phase waits for the maintenance window");
  const deleting = !deleted && due && (inWindow || immediate);
  const removed = (tags: Record<string, string>, unit: UnitName): boolean => REMOVED_RE.test(tags[TAG_PREFIX + unit] ?? "");
  const removedRecord = `removed ${today.replace(/-/g, "")}`;
  const adoRuns: boolean[] = [];
  // The delete phase has started somewhere (step 1 removed the Azure DevOps objects): the retired phase
  // must not create them again (ado is per app, so one environment's removed tag holds it everywhere).
  const adoRemoved = envs.some((env) => removed(tagsOf(env), "ado"));

  for (const env of envs) {
    const f = factsOf(env);
    const ed: EnvDecision = { plan: "failed", resourceGroup: null, filesTag: null, files: null, legacyTag: null, entraSingleHost: managed, units: {} };
    app.environments[env] = ed;
    const is = want?.environments[env];
    if (!f || !want || !is) continue;
    ed.plan = "ok";
    ed.resourceGroup = f.resourceGroup;
    const tags = tagsOf(env);
    ed.legacyTag = f.tags[LEGACY_TAG] ?? null;
    const filesTag = tags[FILES_TAG];
    ed.filesTag = filesTag !== undefined && /^[0-9a-f]{12}$/.test(filesTag) ? filesTag : null;
    ed.files = /^[0-9a-f]{64}$/.test(want.files) ? want.files.slice(0, 12) : null;
    const retiredTag = tags[RETIRED_TAG];
    ed.retired = { tag: retiredTag !== undefined && /^\d{8}$/.test(retiredTag) ? retiredTag : null, record: null, remove: false };
    const u = ed.units;
    const idle = (unit: UnitName, detail: string): UnitDecision => ({ run: false, reasons: [], details: [detail], tag: tags[TAG_PREFIX + unit] ?? null, record: null, outdated: false, held: false, waits: [], rebase: null });
    // frontdoor as for an active app: a domain requested, its record, or its tag (ADR-0048).
    const present = (unit: EnvUnit): boolean =>
      unit === "entra" ? Object.hasOwn(is, unit) : unit === "frontdoor" ? Object.hasOwn(is, unit) && (!!entry.frontDoorHosts?.[env] || f.frontDoorRecord || tags[`${TAG_PREFIX}frontdoor`] !== undefined) : true;
    if (left[env]!.length === 0) {
      // Nothing left here: the app never got this far, or its delete finished.
      ed.gone = true;
      for (const unit of [...ENV_UNITS, "ado" as const]) if (unit === "ado" || present(unit)) u[unit] = idle(unit, "decommissioned: nothing left in this environment");
      continue;
    }
    if (!groupExists(f)) {
      // The group is gone, a record of the app is left: no tag can be written here any more.
      ed.retired = { tag: null, record: null, remove: false };
      for (const unit of [...ENV_UNITS, "ado" as const]) if (unit === "ado" || present(unit)) u[unit] = idle(unit, deleting ? "decommission: the resource group is gone" : "decommission: the resource group is gone; the rest waits for the delete phase");
      if (!deleting) continue;
      const lzLeft = f.lzRecord !== "absent";
      const entraLeft = !!entra?.has(names.entraDeployment(slug, env));
      if (lzLeft) {
        // Step 2 resumed: the group is gone; the service connection (ado, after the group) and then
        // the record (record_<env>, once the connection is gone) are what is left to delete.
        u.lz = { ...idle("lz", "decommission: the resource group is gone; its service connection, then its landing-zone record (step 2, resumed)"), run: true, reasons: ["decommission"], action: "delete" };
        adoRuns.push(true);
      }
      if (entraLeft && present("entra") && !lzLeft) u.entra = { ...idle("entra", "decommission: the resource group is gone; delete the Entra registration left (step 1)"), run: true, reasons: ["decommission"], action: "delete" };
      if (entraLeft && !present("entra")) waits.push(`decommission: in ${env} the Entra registration's record ${names.entraDeployment(slug, env)} is left although the app has no sign-in; a person removes it (runbook decommission-app.md)`);
      if (f.frontDoorRecord) waits.push(`decommission: in ${env} the custom domain's record ${names.frontDoorDeployment(slug, env)} is left without the resource group; a person removes it (runbook decommission-app.md)`);
      continue;
    }
    if (deleting) {
      const step1: UnitName[] = ["ado", ...(["entra", "frontdoor", "pep"] as const).filter((x) => present(x))];
      for (const unit of step1) {
        if (removed(tags, unit)) {
          u[unit] = idle(unit, `decommission: ${unit} removed`);
          continue;
        }
        u[unit] = { ...idle(unit, `decommission: delete ${unit} (step 1)`), run: true, reasons: ["decommission"], record: removedRecord, action: "delete" };
        if (unit === "ado") adoRuns.push(true);
      }
      u.release = idle("release", "decommission: the Container App goes with the resource group");
      if (immediate) {
        // No grace period has stopped the app yet: retire it in this run where the stop isn't
        // recorded or it runs (beside step 1; the stop never waits for Azure DevOps).
        const why: string[] = [];
        if (!ed.retired.tag) why.push("the stop is not recorded yet");
        if (f.containerAppStopped === false) why.push("the Container App is running");
        if (why.length) {
          u.release = { ...idle("release", "decommission: stop the app"), run: true, reasons: ["decommission"], details: why.map((w) => `decommission (immediate): ${w}`), action: "retire" };
          if (is.release) u.release.record = formatUnitTag(input.inst.coreVersion, is.release, today);
          if (!ed.retired.tag) ed.retired.record = today.replace(/-/g, "");
        }
      }
      const pending = step1.filter((x) => !removed(tags, x));
      const stopPending = immediate && !ed.retired.tag;
      u.lz = pending.length
        ? { ...idle("lz", `decommission: waits until ${pending.join(", ")} ${pending.length === 1 ? "is" : "are"} removed (a later run)`), waits: [] }
        : stopPending
          ? { ...idle("lz", "decommission: waits until the stop is recorded (a later run)"), waits: [] }
          : { ...idle("lz", "decommission: delete the resource group (step 2), then its service connection and its record"), run: true, reasons: ["decommission"], action: "delete" };
      // Step 2 deletes the group, which takes the delivery identity's federated credential with it; only
      // then Azure DevOps lets the service connection go (ado, after azure_<env> in the same run).
      if (u.lz.run) adoRuns.push(true);
      continue;
    }
    // Retired: stop the app (release), disable the pipeline (ado); everything else frozen.
    const relTag = parseUnitTag(tags[`${TAG_PREFIX}release`]);
    const relI = is.release;
    const rel: UnitDecision = { ...idle("release", "decommission: stop the app"), action: "retire" };
    if (relI) rel.record = formatUnitTag(input.inst.coreVersion, relI, today);
    const why: string[] = [];
    if (!ed.retired.tag) why.push("the stop is not recorded yet");
    if (!relTag || !relI || relTag.i12 !== relI.slice(0, 12)) why.push("the app was just decommissioned");
    if (f.containerAppStopped === false) why.push("the Container App is running");
    if (apps.checkAllApps) why.push("the run checks every app");
    if (why.length) {
      rel.run = true;
      rel.reasons = ["decommission"];
      rel.details = why.map((w) => `decommission: ${w}`);
    }
    u.release = rel;
    if (!ed.retired.tag) ed.retired.record = today.replace(/-/g, "");
    for (const unit of ["lz", "entra", "frontdoor", "pep"] as const) if (present(unit)) u[unit] = idle(unit, "frozen: the app is being decommissioned");
    if (adoRemoved) {
      // Step 1 deleted the pipeline, connections and environments: nothing is created again, the tag stays.
      u.ado = idle("ado", "decommission: the Azure DevOps objects are removed (the delete phase started); nothing is created again");
      adoRuns.push(false);
      continue;
    }
    // ado: its own rules (new, inputs, drift in the window, all); no dependency.
    const adoTag = parseUnitTag(tags[`${TAG_PREFIX}ado`]);
    const ado: UnitDecision = idle("ado", "decommission: the delivery pipeline disabled");
    if (want.ado) ado.record = formatUnitTag(input.inst.coreVersion, want.ado, adoTag ? today : addDays(today, -driftOffset(slug, env, "ado", driftCheckDays)));
    const adoWhy: Reason[] = [];
    if (!adoTag) adoWhy.push("new");
    else if (!want.ado || adoTag.i12 !== want.ado.slice(0, 12)) adoWhy.push("inputs");
    else if (dayNumber(today) - dayNumber(adoTag.date) >= driftCheckDays && inWindow) adoWhy.push("drift");
    if (apps.checkAllApps) adoWhy.push("all");
    if (adoWhy.length) {
      ado.run = true;
      ado.reasons = adoWhy;
    }
    u.ado = ado;
    adoRuns.push(ado.run);
  }
  // ado is per app: it runs everywhere when it runs anywhere, and only when every environment was planned.
  const adoRun = allPlanned && adoRuns.some(Boolean);
  app.ado = { run: adoRun, reasons: adoRun ? ["decommission"] : [], details: adoRun ? [deleting ? "decommission: delete the Azure DevOps objects" : "decommission: the delivery pipeline disabled"] : allPlanned ? [] : ["not planned in every environment of the app"] };
  for (const [env, ed] of Object.entries(app.environments)) {
    const a = ed.units.ado;
    if (!a || ed.plan !== "ok") continue;
    if (deleting) {
      // The same ado (run, action delete) in every planned environment, as the stages read it from any
      // of them; a removed tag is written back as it is, a group that is gone gets nothing.
      if (!adoRun) continue;
      const kept = REMOVED_RE.test(a.tag ?? "") ? a.tag : null;
      const record = kept ?? (factsOf(env)?.resourceGroupExists === false || ed.gone ? null : removedRecord);
      ed.units.ado = { ...a, run: true, reasons: ["decommission"], record, action: "delete" };
      continue;
    }
    if (ed.gone || factsOf(env)?.resourceGroupExists === false) continue;
    ed.units.ado = { ...a, run: adoRun, ...(adoRun ? {} : { action: undefined }) };
    if (!adoRun) delete ed.units.ado.action;
  }
  app.decommission = {
    phase: deleted ? "deleted" : deleting ? "deleting" : "retired",
    requestedOn: dc.requestedOn,
    deleteAfter: dc.deleteAfter,
    dueOn,
    waits,
    ...(immediate ? { immediate: true as const } : {}),
    // Allowed by decommission.allowImmediateWithProduction (amendment 2026-11-21): the report names production.
    ...(immediate && production.length ? { withProduction: production } : {}),
  };
  return app;
}

/**
 * Every unit of every valid app: run or not, and why (rules 1-6 of ADR-0048 section 4, rule 2 as
 * ADR-0049 section 2 amends it), plus the outputs of the step decide. Pure: files are read by the
 * caller.
 *
 * Rule 4 (dependency), from the facts of plan_<env>:
 *   - no landing-zone record (a new landing zone) -> lz, entra, release, pep, ado; an unusable
 *     record -> lz;
 *   - no service connection in the landing zone (deliveryFederation unset) -> lz (its second pass)
 *     and ado;
 *   - sign-in: the Easy Auth secret absent or unknown -> entra (writes it), release (waits for it)
 *     and lz (the Easy Auth identity's role on it); present but not in the landing zone -> lz; due
 *     for rotation -> entra and release (the restart); a pending restart (the app runs with an older
 *     version) -> release;
 *   - sign-in: no Entra record (rg-{prefix}-entra read by plan_<hostEnvironment>) -> entra and
 *     release (a new client ID); the records unreadable -> entra;
 *   - the Front Door backend ranges changed for an app on a custom domain -> release;
 *   - time-based (ADR-0048 section 7, amended 2026-11-11): a rotation due, a pending restart, the
 *     ranges changed and rule 5 (drift) run only while `now` is inside maintenance.window; outside,
 *     the unit lists them in `waits` instead. A rotation or pending restart of a secret with at most
 *     URGENT_ROTATION_DAYS left, and an absent secret, run at any time;
 *   - frontdoor and release run together (the release reads the custom domain's deployment, and a
 *     domain's removal follows the release that opens the ingress). When one of them is held and
 *     the other would run only for a drift check or scope all, neither runs (the check waits for the
 *     upgrade instead of upgrading the held one).
 *
 * ADR-0049: an outdated unit is held unless the app is in `upgrade`, it is below minAppVersion, or
 * it runs anyway (new, inputs, dependency); a unit that runs outdated brings the units its upgrade
 * notes `requires` (every version after the one that applied it, up to this core). `ado` is never
 * held. An outdated unit whose `i` changed while saf-u-files did not is rebased, not run.
 */
export function planUnits(input: PlanInput): RunPlan {
  const { inst, apps, desired, plans, today, upgrades } = input;
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (!validDate(today)) throw new CheckFailed(["--today must be a date YYYY-MM-DD."]);
  if (desired.coreVersion !== inst.coreVersion) throw new CheckFailed([`the unit inputs were rendered for core ${desired.coreVersion}, but instance.yaml pins ${inst.coreVersion}.`]);
  const maint = maintenanceOf(inst as { maintenance?: unknown });
  const driftCheckDays = maint.driftCheckDays;
  if (!Number.isSafeInteger(now) || now < 946_684_800 || now > 4_102_444_800) throw new CheckFailed(["--now must be epoch seconds."]);
  if (new Date(now * 1000).toISOString().slice(0, 10) !== today) throw new CheckFailed([`--today ${today} is not the UTC date of --now.`]);
  const win = windowAt(maint.window, new Date(now * 1000));
  const inWindow = win.inside;
  const host = provisioningHostEnvironment(inst);
  const envNames = inst.environments.map((e) => e.name);
  const hostFacts = plans[host];
  const entraNames = hostFacts?.entraRecords === undefined ? undefined : hostFacts.entraRecords === null ? null : new Set(hostFacts.entraRecords.filter((r) => r.state === "Succeeded").map((r) => r.name));
  // ADR-0056: every Entra record, whatever its state, counts as left for a decommissioned app.
  const entraAll = hostFacts?.entraRecords === undefined ? undefined : hostFacts.entraRecords === null ? null : new Set(hostFacts.entraRecords.map((r) => r.name));
  const managed = managedFrontDoor(inst);
  const out: RunPlan = {
    schemaVersion: 1,
    coreVersion: inst.coreVersion,
    today,
    driftCheckDays,
    maintenance: {
      now,
      inWindow,
      window: { days: [...maint.window.days], start: maint.window.start, hours: maint.window.hours },
      until: (win.end ?? nextWindowStart(maint.window, new Date(now * 1000))).toISOString(),
    },
    checkAllApps: apps.checkAllApps,
    upgrade: { all: apps.upgrade.all, apps: [...apps.upgrade.apps] },
    minAppVersion: upgrades.minAppVersion,
    hostEnvironment: host,
    environments: envNames,
    stages: {},
    apps: {},
  };

  for (const entry of apps.apps) {
    if (!entry.ok) continue;
    if (entry.decommission) {
      out.apps[entry.slug] = decommissionDecision(entry, input, driftCheckDays, inWindow, managed, entraAll);
      continue;
    }
    const want = desired.apps[entry.slug];
    const app: AppDecision = { ado: { run: false, reasons: [], details: [] }, environments: {} };
    out.apps[entry.slug] = app;
    const upgradeApp = apps.upgrade.all || apps.upgrade.apps.includes(entry.slug);
    const adoCandidates: UnitDecision[] = [];
    let adoBlocked = false;
    for (const env of entry.environments ?? []) {
      const facts = plans[env]?.apps[entry.slug];
      const ed: EnvDecision = { plan: "failed", resourceGroup: null, filesTag: null, files: null, legacyTag: null, entraSingleHost: managed, units: {} };
      app.environments[env] = ed;
      if (!facts || !want || !want.environments[env]) {
        adoBlocked = true;
        continue;
      }
      ed.plan = "ok";
      ed.resourceGroup = facts.resourceGroup;
      const tags = plans[env]!.tagsRead ? facts.tags : {};
      ed.legacyTag = facts.tags[LEGACY_TAG] ?? null;
      const filesTag = tags[FILES_TAG];
      ed.filesTag = filesTag !== undefined && /^[0-9a-f]{12}$/.test(filesTag) ? filesTag : null;
      ed.files = /^[0-9a-f]{64}$/.test(want.files) ? want.files.slice(0, 12) : null;
      // ADR-0056: an app active again (Cancel) loses the stop's record.
      const retiredTag = tags[RETIRED_TAG];
      if (retiredTag !== undefined && /^\d{8}$/.test(retiredTag)) ed.retired = { tag: retiredTag, record: null, remove: true };
      const filesUnchanged = ed.files !== null && ed.filesTag === ed.files;
      const is = want.environments[env]!;
      const unitFacts: Partial<Record<UnitName, UnitFacts>> = {};
      const decide = (unit: UnitName, i: string | null | undefined): UnitDecision => {
        const { d, f } = baseDecision(unit, i, tags[TAG_PREFIX + unit], input, driftCheckDays, entry.slug, env, filesUnchanged, inWindow);
        unitFacts[unit] = f;
        return d;
      };
      const u = ed.units;
      u.lz = decide("lz", is.lz);
      if (Object.hasOwn(is, "entra")) u.entra = decide("entra", is.entra);
      u.release = decide("release", is.release);
      // frontdoor: when a domain is requested, a record exists (a removal to finish) or a tag does.
      if (Object.hasOwn(is, "frontdoor") && (entry.frontDoorHosts?.[env] || facts.frontDoorRecord || tags[`${TAG_PREFIX}frontdoor`] !== undefined)) u.frontdoor = decide("frontdoor", is.frontdoor);
      u.pep = decide("pep", is.pep);
      const ado = decide("ado", want.ado);
      adoCandidates.push(ado);
      u.ado = ado;

      const dep = (units: (UnitName | undefined)[], why: string): void => {
        for (const n of units) {
          const d = n ? u[n] : undefined;
          if (d) addReason(d, "dependency", why);
        }
      };
      if (facts.lzRecord === "absent") dep(["lz", "entra", "release", "pep", "ado"], "a new landing zone");
      else if (facts.lzRecord === "unusable") dep(["lz"], "the landing-zone record is not usable");
      else if (!facts.federation) dep(["lz", "ado"], "no service connection in the landing zone yet");
      // Time-based work waits for the maintenance window (ADR-0048 section 7, amended 2026-11-11).
      const timed = (units: UnitName[], why: string, what: string, urgent = false): void => {
        if (inWindow || urgent) {
          dep(units, urgent && !inWindow ? `${why} (urgent: at most ${URGENT_ROTATION_DAYS} days left)` : why);
          return;
        }
        for (const n of units) {
          const d = u[n];
          if (d && !d.waits.includes(what)) d.waits.push(what);
        }
      };
      if (u.entra) {
        const s = facts.secret;
        if (!s || s.state === "absent") dep(["entra", "release", "lz"], "the Easy Auth secret is absent");
        else {
          if (!facts.easyAuthInLandingZone) dep(["lz"], "the Easy Auth secret is not in the landing zone yet");
          const urgent = rotationUrgent(s.expires, now);
          if (rotationDue(s.expires ?? undefined, now, s.created ?? undefined).due) timed(["entra", "release"], "the Easy Auth secret is due for rotation", "Easy Auth rotation", urgent);
          if (s.created === null || s.loaded !== s.created) timed(["release"], "an Easy Auth restart is pending", "Easy Auth restart", urgent);
        }
        if (entraNames === null) dep(["entra"], "the Entra records could not be read");
        else if (entraNames !== undefined && (!facts.entraDeployment || !entraNames.has(facts.entraDeployment))) dep(["entra", "release"], "no Entra registration record");
        else if (entraNames === undefined) dep(["entra"], `the plan of ${host} read no Entra records`);
      }
      if (facts.rangesChanged) timed(["release"], "the Front Door backend ranges changed", "Front Door backend ranges");
      // ADR-0060: a network mode change moves the app (an approved change), its units run with this
      // core's template (never held). Its prepare pass and Entra step run at once; the disruptive part in
      // an environment of kind prod only inside the maintenance window (product owner, 2026-11-14: outside
      // it the move step waits), in kind nonprod in the merge's run; a resumed move at any time. Else the
      // follow-up of a case A move removes the secret left in the previous variant's vault (any run).
      const envDef = instanceEnv(inst, env);
      const mc = detectModeChange(entry.networkModes?.[env], facts, environmentVaultInputs(envDef).externalOnlyNetwork, entry.cells?.[env] ?? DEFAULT_CELL_ID);
      if (mc) {
        if (envDef.kind === "prod" && !inWindow && !mc.resume) mc.waitsForWindow = (win.end ?? nextWindowStart(maint.window, new Date(now * 1000))).toISOString();
        ed.modeChange = mc;
        dep(["lz", "entra", "release"], `network mode change ${mc.from} to ${mc.to}${cellsOfMove(mc)} (case ${mc.case}${mc.resume ? ", resumed: the app is gone" : ""}${mc.waitsForWindow ? `; the move waits for the maintenance window (${mc.waitsForWindow})` : ""})`);
        u.release.action = "move";
      } else if (facts.secretElsewhere === true && u.entra) {
        ed.followUp = "remove-old";
        dep(["entra"], "the Easy Auth secret is left in the vault of the previous network variant (follow-up of a network mode change)");
      }

      // ADR-0049 section 2: outdated units wait for their upgrade.
      for (const n of ENV_UNITS) {
        const d = u[n];
        if (d) hold(d, unitFacts[n]!, upgradeApp, upgrades.minAppVersion);
      }
      // What runs outdated brings what its upgrade notes require; frontdoor and release run together.
      for (let changed = true, rounds = 0; changed && rounds < 20; rounds++) {
        changed = false;
        for (const n of UNIT_NAMES) {
          const d = u[n];
          const f = unitFacts[n];
          if (!d?.run || !d.outdated || !f?.tag) continue;
          for (const r of requiredWith(upgrades, n, f.tag.version, inst.coreVersion)) {
            const rd = u[r];
            const rf = unitFacts[r];
            if (rd && rf && !rd.run && rd.outdated) {
              wake(rd, rf, "requires", `${n} requires ${r} (upgrade notes)`);
              changed = true;
            }
          }
        }
        const fd = u.frontdoor;
        const rel = u.release;
        if (fd && rel && fd.run !== rel.run) {
          const [runner, other, otherName, why] = fd.run ? [fd, rel, "release" as const, "the custom domain runs"] : [rel, fd, "frontdoor" as const, "the release runs"];
          if (other.held && runner.reasons.every((r) => CHECK_ONLY.includes(r))) {
            runner.run = false;
            runner.reasons = [];
            runner.details = [`deferred: ${otherName} waits for its upgrade`];
          } else wake(other, unitFacts[otherName]!, "dependency", why);
          changed = true;
        }
      }
    }
    // ado: per app; runs when any environment's tag needs it, and only when every environment was planned.
    if (adoBlocked) {
      app.ado = { run: false, reasons: [], details: ["not planned in every environment of the app"] };
    } else {
      for (const c of adoCandidates) {
        for (const r of c.reasons) if (!app.ado.reasons.includes(r)) app.ado.reasons.push(r);
        for (const x of c.details) if (!app.ado.details.includes(x)) app.ado.details.push(x);
      }
      app.ado.run = app.ado.reasons.length > 0;
    }
    for (const ed of Object.values(app.environments)) {
      if (ed.units.ado) ed.units.ado = { ...ed.units.ado, run: app.ado.run, reasons: [...app.ado.reasons], details: [...app.ado.details] };
      // What waits for the window is only news for a unit that doesn't run anyway.
      for (const d of Object.values(ed.units)) if (d?.run) d.waits = [];
    }
  }
  // The outputs of the step decide.
  const runs = (slug: string, env: string, unit: UnitName): boolean => out.apps[slug]?.environments[env]?.units[unit]?.run === true;
  const sub = (name: string): string => instanceEnv(inst, name).subscriptionId.toLowerCase();
  const slugs = Object.keys(out.apps);
  const anyPep = slugs.some((s) => envNames.some((e) => runs(s, e, "pep")));
  // ADR-0056: a landing zone's delete is azure_<env>'s alone (no second pass), and a portal-side
  // endpoint's delete needs no approval in its own environment.
  const deletes = (slug: string, env: string, unit: UnitName): boolean => out.apps[slug]?.environments[env]?.units[unit]?.action === "delete";
  for (const e of envNames) {
    out.stages[`lz_${e}`] = slugs.some((s) => runs(s, e, "lz"));
    out.stages[`post_${e}`] =
      slugs.some((s) => (runs(s, e, "lz") && !deletes(s, e, "lz")) || runs(s, e, "frontdoor") || runs(s, e, "release")) ||
      (e === host ? anyPep : sub(e) !== sub(host) && slugs.some((s) => runs(s, e, "pep") && !deletes(s, e, "pep")));
    // record_<env>: a unit ran there, or a rebase is to be written (ADR-0049 section 3).
    out.stages[`record_${e}`] = slugs.some(
      (s) => UNIT_NAMES.some((u) => runs(s, e, u) || !!out.apps[s]?.environments[e]?.units[u]?.rebase) || out.apps[s]?.environments[e]?.retired?.remove === true,
    );
  }
  out.stages.ado = slugs.some((s) => out.apps[s]!.ado.run);
  // entraPlan: the stage entra_plan, after the landing zones, for the entra units whose landing zone
  // runs too (its outputs may change). Every other entra unit is compared in the job decide (ADR-0050).
  out.stages.entraPlan = slugs.some((s) => envNames.some((e) => runs(s, e, "entra") && runs(s, e, "lz")));
  return out;
}

export function formatPlan(p: RunPlan): string {
  const lines: string[] = [];
  for (const [slug, a] of Object.entries(p.apps)) {
    for (const [env, e] of Object.entries(a.environments)) {
      if (e.plan !== "ok") {
        lines.push(`FAILED   ${slug} in ${env}: not planned (see the job plan_${env}); nothing runs for it there`);
        continue;
      }
      const ran = Object.entries(e.units).filter(([, d]) => d?.run).map(([n, d]) => `${n} (${d!.reasons.join(", ")})`);
      const held = Object.entries(e.units).filter(([, d]) => d?.held).map(([n, d]) => `${n}${d!.rebase ? " (rebased)" : ""}`);
      const rebased = Object.entries(e.units).filter(([, d]) => !d?.held && !d?.run && d?.rebase).map(([n]) => n);
      lines.push(
        `${ran.length ? "run     " : "unchanged"} ${slug} in ${env}${ran.length ? `: ${ran.join(", ")}` : ""}` +
          `${held.length ? `; behind (upgrade available): ${held.join(", ")}` : ""}${rebased.length ? `; rebased: ${rebased.join(", ")}` : ""}`,
      );
    }
  }
  // ADR-0060: the moves of this run and the follow-ups of earlier ones.
  for (const [slug, a] of Object.entries(p.apps)) {
    for (const [env, e] of Object.entries(a.environments)) {
      const m = e.modeChange;
      if (m) {
        lines.push(
          `move     ${slug} in ${env}: ${m.from} to ${m.to}${cellsOfMove(m)} (case ${m.case}: ${m.case === "A" ? "Easy Auth secret re-issued in the other vault" : "private endpoints move to the other spoke"}); ` +
            (m.resume
              ? "the app is gone, the move resumes after its delete"
              : m.waitsForWindow
                ? `waits for the maintenance window (${m.waitsForWindow}): a production environment; the prepare pass and the Entra step run now, the app is untouched`
                : "short outage: the app is deleted and created again in the target environment"),
        );
      }
      if (e.followUp === "remove-old") lines.push(`followup ${slug} in ${env}: remove the Easy Auth secret and passwords left from the previous network variant`);
    }
  }
  for (const [slug, a] of Object.entries(p.apps)) {
    const d = a.decommission;
    if (!d) continue;
    const next =
      d.phase === "deleted"
        ? "deleted: nothing is left in Azure (read in this run); nothing runs for it, the portal shows it as deleted"
        : d.phase === "deleting"
          ? `delete phase${d.immediate ? " (immediate: no grace period, no maintenance window)" : ""}: step 1 (Azure DevOps, Entra, Front Door, portal endpoint), then the resource groups${d.immediate ? " in a later run" : ""}`
          : `stopped; the delete phase starts ${d.immediate ? "once every environment is planned" : d.dueOn ? `on or after ${d.dueOn}` : "once every environment recorded its stop"}${d.waits.length ? ` (${d.waits.map((w) => w.replace(/^decommission: /, "")).join("; ")})` : ""}`;
    const kind = d.immediate ? (d.withProduction?.length ? `immediate, production included (${d.withProduction.join(", ")}; decommission.allowImmediateWithProduction)` : "immediate") : `deleteAfter ${d.deleteAfter}`;
    lines.push(`decommissioned ${slug} (requested ${d.requestedOn}, ${kind}): ${next}`);
  }
  if (p.upgrade.all || p.upgrade.apps.length) lines.push(`Upgrade requested: ${p.upgrade.all ? "all apps" : p.upgrade.apps.join(", ")}.`);
  const waiting = Object.entries(p.apps).flatMap(([slug, a]) =>
    Object.entries(a.environments).flatMap(([env, e]) => Object.entries(e.units).filter(([, d]) => d?.waits?.length).map(([n, d]) => `${slug} in ${env}: ${n} (${d!.waits.join(", ")})`)),
  );
  const m = p.maintenance;
  lines.push(
    m.inWindow
      ? `Inside the maintenance window (until ${m.until}): drift checks, Easy Auth rotations and restarts and the Front Door backend ranges run.`
      : `Outside the maintenance window (next ${m.until}): drift checks, Easy Auth rotations and restarts and the Front Door backend ranges wait for it (an urgent rotation runs now)${waiting.length ? `; ${waiting.length} unit(s) wait` : ""}.`,
  );
  for (const w of waiting.slice(0, 50)) lines.push(`waits    ${w}`);
  if (waiting.length > 50) lines.push(`waits    ... and ${waiting.length - 50} more`);
  const on = Object.entries(p.stages).filter(([, v]) => v).map(([k]) => k);
  lines.push(on.length ? `Stages with work: ${on.join(", ")}.` : "Nothing to do: every unit of every app is recorded and up to date.");
  return lines.join("\n") + "\n";
}

/** `platform provisioning plan-units`: reads the files, decides, writes units.json. */
export function planUnitsFiles(args: PlanUnitsFileArgs): RunPlan {
  return planUnits(planUnitsInput(args));
}

interface PlanUnitsFileArgs {
  instance: string;
  apps: string;
  inputs: string;
  manifest: string;
  upgrades: string;
  plans: string[];
  today: string;
  now: number;
}

/** The decision's input from the files (plan-units; also the registry purge's, ADR-0059). */
export function planUnitsInput(args: PlanUnitsFileArgs): PlanInput {
  const inst = loadInstanceFile(args.instance);
  const apps = readAppsDoc(args.apps);
  const desiredDoc = readJson(args.inputs, 16 * MiB, "--inputs");
  if (!isObject(desiredDoc) || own(desiredDoc, "schemaVersion") !== 1 || !isObject(own(desiredDoc, "apps")) || typeof own(desiredDoc, "coreVersion") !== "string") {
    throw new CheckFailed(["--inputs must be the output of platform provisioning units."]);
  }
  const desired = desiredDoc as unknown as DesiredUnits;
  for (const [slug, a] of Object.entries(desired.apps)) {
    const hex = (v: unknown): boolean => v === null || (typeof v === "string" && /^[0-9a-f]{64}$/.test(v));
    if (!SLUG_RE.test(slug) || !isObject(a) || !hex(own(a, "ado")) || typeof own(a, "files") !== "string" || !hex(own(a, "files")) || !isObject(own(a, "environments"))) throw new CheckFailed([`--inputs has an invalid entry for ${slug.slice(0, 40)}.`]);
    for (const [e, units] of Object.entries(own(a, "environments") as Record<string, unknown>)) {
      if (!ENV_NAME_RE.test(e) || !isObject(units) || Object.entries(units).some(([k, v]) => !(ENV_UNITS as readonly string[]).includes(k) || !hex(v))) throw new CheckFailed([`--inputs has an invalid environment ${e.slice(0, 20)} for ${slug}.`]);
    }
  }
  const manifest = readUnitManifest(args.manifest, inst.coreVersion);
  const upgrades = readUpgradeNotes(args.upgrades, { release: true, coreVersion: inst.coreVersion });
  const plans: Record<string, EnvFacts | undefined> = {};
  const slugsIn = (env: string): string[] => apps.apps.filter((a) => a.ok && a.environments?.includes(env)).map((a) => a.slug);
  for (const spec of args.plans) {
    const m = /^([a-z][a-z0-9]{1,7})=(.+)$/.exec(spec);
    if (!m) throw new CheckFailed([`--plan must be <env>=<dir of the artifact plan_<env>> (got "${spec.slice(0, 60)}").`]);
    if (!inst.environments.some((e) => e.name === m[1])) throw new CheckFailed([`--plan names ${m[1]}, which is not an environment of instance.yaml.`]);
    plans[m[1]!] = existsSync(m[2]!) && readdirSync(m[2]!).length ? readEnvPlan(m[2]!, m[1]!, slugsIn(m[1]!)) : undefined;
  }
  return { inst, apps, desired, manifest, upgrades, plans, today: args.today, now: args.now };
}

export const UNITS_HELP = `  units --instance <instance.yaml> --apps <plan/apps.json> --output <unit-inputs.json>
      i of every unit of every valid app (ADR-0048): sha256 of the unit's inputs in the offline view
      (lz, entra, release, frontdoor, pep per environment as "inputs" renders them from app.yaml and
      instance.yaml alone, runtime values left out or fixed; ado: the desired objects of "ado plan"
      offline, with the Required template ref), and the app's files hash (app.yaml and instance.yaml
      without coreVersion, ADR-0049). Writes { schemaVersion, coreVersion, apps: { <slug>: { ado,
      files, environments: { <env>: { <unit>: <hex>|null } }, problems } } }
  plan-units --instance <instance.yaml> --apps <plan/apps.json> --inputs <unit-inputs.json>
             --manifest <core>/infra/app/units.json --upgrades <core>/infra/app/upgrades.yaml
             --plan <env>=<dir>... [--now <epoch seconds>] [--today YYYY-MM-DD] --output <units.json>
             [--decommission <decommission.json>] [--registry <registry.json>]
      decides every unit (ADR-0048 section 4: no tag, inputs changed, a dependency, the drift check
      after maintenance.driftCheckDays, scope all; the time-based work, drift checks, Easy Auth
      rotations and the restarts after them and the Front Door backend ranges, only while --now
      (default the current time; --today defaults to its UTC date) is inside maintenance.window,
      a rotation with at most 14 days left or an absent secret at any time, and "maintenance" and
      each unit's "waits" say what waited; ADR-0049: a unit whose template changed since it
      was applied (outdated) runs only when the app is in the run's "upgrade", is below
      minAppVersion, or the unit runs anyway, with the units its upgrade notes require; otherwise
      it is held, and rebased when only its rendering changed) from the artifacts of the jobs
      plan_<env> (plan.json, status/, facts/); writes the run's plan with each unit's run, reasons,
      held, tag, the value record_<env> writes and its rebase, and "stages": the outputs lz_<env>,
      post_<env>, record_<env>, ado and entraPlan of the step decide. --decommission: also the
      phase of every decommissioned app (retired, deleting or deleted: due and nothing left in
      Azure, read in this run; ADR-0056 amendment 2026-11-12), the small file the portal reads from
      the artifact units to show an app as deleted. --registry: also the plan of the registry purge
      (ADR-0059): per build environment (no promoteFrom) the apps whose old images are purged in this
      run (inside maintenance.window, maintenance.registryRetention.mode not off, the landing zone's
      purge role there and not running now, every environment of the app planned, the last purge at
      least 7 days old; at most 100 apps per environment, the most overdue first), what each one runs
      anywhere (protected) and the outputs registry_<env> of the step decide
`;

export function cmdUnits(v: { instance: string; apps: string; output: string }): string {
  const d = desiredUnits({ instance: v.instance, apps: v.apps });
  writeJson(v.output, d);
  return formatDesiredUnits(d);
}

/**
 * decommission.json (ADR-0056 amendment 2026-11-12, deleted detected): the phase of every
 * decommissioned app in this run's plan, with the dates of its block. The portal's decommission
 * watcher reads it from the artifact `units` of the newest completed provisioning runs (a few hundred
 * bytes per app, so units.json, which grows with every app, needn't be downloaded); deleted is
 * recorded there once, for that block (requestedOn).
 */
export interface DecommissionPhases {
  schemaVersion: 1;
  /** The run's date and time (UTC) the plan used. */
  today: string;
  now: number;
  apps: Record<string, { phase: "retired" | "deleting" | "deleted"; requestedOn: string; deleteAfter: string; immediate?: true }>;
}

export function decommissionPhases(p: RunPlan): DecommissionPhases {
  const apps: DecommissionPhases["apps"] = {};
  for (const [slug, a] of Object.entries(p.apps)) {
    const d = a.decommission;
    if (d) apps[slug] = { phase: d.phase, requestedOn: d.requestedOn, deleteAfter: d.deleteAfter, ...(d.immediate ? { immediate: true as const } : {}) };
  }
  return { schemaVersion: 1, today: p.today, now: p.maintenance.now, apps };
}

export function cmdPlanUnits(v: { instance: string; apps: string; inputs: string; manifest: string; upgrades: string; plan: string[]; today?: string; now?: string; output: string; decommission?: string; registry?: string }): string {
  let now = Math.floor(Date.now() / 1000);
  if (v.now !== undefined) {
    if (!/^[0-9]{9,10}$/.test(v.now)) throw new CheckFailed(["--now must be epoch seconds."]);
    now = Number(v.now);
  }
  const today = v.today ?? new Date(now * 1000).toISOString().slice(0, 10);
  const input = planUnitsInput({ instance: v.instance, apps: v.apps, inputs: v.inputs, manifest: v.manifest, upgrades: v.upgrades, plans: v.plan, today, now });
  const p = planUnits(input);
  writeJson(v.output, p);
  if (v.decommission !== undefined) writeJson(v.decommission, decommissionPhases(p));
  // ADR-0059: the registry purge of the build environments, with the same input and the same time.
  if (v.registry === undefined) return formatPlan(p);
  const r = planRegistryPurge(input, p);
  writeJson(v.registry, r);
  return formatPlan(p) + formatRegistryPlan(r);
}
