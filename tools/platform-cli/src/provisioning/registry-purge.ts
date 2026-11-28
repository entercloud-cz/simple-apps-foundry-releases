import { createHash } from "node:crypto";
import { maintenanceOf, type RegistryRetention } from "../maintenance.js";
import { CheckFailed, DIGEST_RE, ENV_NAME_RE, MiB, SLUG_RE, isObject, own, readJson, writeJson } from "../pipeline/common.js";
import type { PlanInput, RunPlan } from "./units.js";

/**
 * The registry image purge (ADR-0059): old build images in the app registries of build environments
 * (no promoteFrom) are deleted in the maintenance window, never a digest that runs in any environment
 * of the app, never one of the app's newest builds, never one young enough to be awaiting a promotion.
 *
 * Two pure steps, both here:
 *   1. the plan (`plan-units --registry`, job decide of stage plan): which apps of which build
 *      environment are purged in this run, and the digests each one runs anywhere (from the Container
 *      Apps lists the jobs plan_<env> read, ADR-0050), so the stage registry_<env> needs no other
 *      environment's connection;
 *   2. the decision (`registry-purge`, per app in registry_<env>): given the registry's manifests (az
 *      acr manifest list-metadata), the protected digests and the retention, which manifests to delete.
 * The script (scripts/provisioning/registry.sh) only lists, deletes what step 2 returned (mode purge)
 * and writes the tag saf-registry-purge.
 */

/** The tag on the app resource group of a build environment: "<YYYYMMDD> <purge|dryRun>" of the last purge. */
export const PURGE_TAG = "saf-registry-purge";
/** An app is purged again this many days after its last purge (core constant, ADR-0059). */
export const PURGE_EVERY_DAYS = 7;
/** At most this many apps per environment and run; the most overdue first, the rest in the next window. */
export const PURGE_MAX_APPS = 100;
/** At most this many manifests deleted per app and run, the oldest first. */
export const PURGE_MAX_DELETES = 200;
/** The tags the delivery pipeline writes (scripts/deploy.sh choose_tag): the commit, or {commit}-{runId}. */
export const DELIVERY_TAG_RE = /^[0-9a-f]{40}(-[0-9]{1,18})?$/;

const PURGE_TAG_RE = /^(\d{4})(\d{2})(\d{2}) (purge|dryRun)$/;
const REGISTRY_RE = /^[a-z0-9]{5,50}$/;
const DAY_S = 86_400;
const EPOCH_MIN = 946_684_800;
const EPOCH_MAX = 4_102_444_800;

function validDate(d: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

const dayNumber = (d: string): number => Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
const addDays = (d: string, n: number): string => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);

export interface PurgeTag {
  /** YYYY-MM-DD */
  date: string;
  mode: "purge" | "dryRun";
}

/** The tag saf-registry-purge, or undefined when it is absent or malformed (a malformed tag is due). */
export function parsePurgeTag(v: unknown): PurgeTag | undefined {
  if (typeof v !== "string") return undefined;
  const m = PURGE_TAG_RE.exec(v);
  if (!m) return undefined;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return validDate(date) ? { date, mode: m[4] as PurgeTag["mode"] } : undefined;
}

export function formatPurgeTag(today: string, mode: "purge" | "dryRun"): string {
  return `${today.replace(/-/g, "")} ${mode}`;
}

/**
 * The digests and tags of the images a Container App runs (its containers and init containers, as the
 * ARM list returns them). An image by digest protects that digest; one by tag protects every manifest
 * with that tag (delivery always deploys by digest; a tag would come from a change by hand).
 */
export function imageReferences(images: readonly string[]): { digests: Set<string>; tags: Set<string> } {
  const digests = new Set<string>();
  const tags = new Set<string>();
  for (const ref of images) {
    if (typeof ref !== "string") continue;
    if (/^sha256:[0-9a-fA-F]{64}$/.test(ref)) {
      digests.add(ref.toLowerCase());
      continue;
    }
    const at = /@(sha256:[0-9a-fA-F]{64})$/.exec(ref);
    if (at) {
      digests.add(at[1]!.toLowerCase());
      continue;
    }
    const tag = /:([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/.exec(ref.slice(ref.lastIndexOf("/") + 1));
    if (tag) tags.add(tag[1]!);
  }
  return { digests, tags };
}

// ------------------------------------------------------------------------------------------
// 1. The plan (job decide of stage plan)
// ------------------------------------------------------------------------------------------

export interface PurgeAppPlan {
  run: boolean;
  /** Why the app is purged in this run or not, in plain words. */
  reason: string;
  /** The tag saf-registry-purge as the plan read it, or null. */
  tag: string | null;
  /** What registry.sh writes after a purge that finished (today and the mode); null when it doesn't run. */
  record: string | null;
  /** The app resource group of the environment by naming (as the plan read it); registry.sh checks it again. */
  resourceGroup: string | null;
  /** The registry the landing-zone record names; registry.sh checks it is in the app resource group. */
  registry: string | null;
  /** Every image the app runs in any of its environments (digests or tags; protected). */
  protect: string[];
}

export interface PurgeEnvPlan {
  apps: Record<string, PurgeAppPlan>;
  /** Apps purged in this run. */
  due: number;
  /** Apps due, but over PURGE_MAX_APPS: the next window takes them. */
  deferred: number;
  /** Apps due, but the run is outside the maintenance window. */
  waiting: number;
}

/** units/registry.json: the plan of the registry purge, beside units/units.json. */
export interface RegistryPlan {
  schemaVersion: 1;
  today: string;
  now: number;
  inWindow: boolean;
  /** The start of the next window (outside) or the end of this one (inside), ISO 8601 UTC. */
  until: string;
  retention: RegistryRetention;
  everyDays: number;
  maxApps: number;
  maxDeletes: number;
  /** The outputs registry_<env> of the step decide: one per build environment (no promoteFrom). */
  stages: Record<string, boolean>;
  /** Build environments only: promotion environments hold promoted images and are never purged. */
  environments: Record<string, PurgeEnvPlan>;
}

const order = (slug: string, env: string): string => createHash("sha256").update(`${slug}|${env}|registry`).digest("hex");

/**
 * The plan of the registry purge (ADR-0059), from the same input and the same time as the unit plan.
 * An app of a build environment is purged in this run when the run is inside the maintenance window,
 * maintenance.registryRetention.mode isn't off, the app isn't being decommissioned, it was planned in
 * every environment it has (what it runs there is protected), every one of those plans read the
 * Container Apps, its landing zone is there with the purge role (output registryPurgeRole, written
 * by a landing zone of this core or later) and doesn't run in this run, and its last purge (tag
 * saf-registry-purge) is absent, at least PURGE_EVERY_DAYS old or of another mode; at most
 * PURGE_MAX_APPS per environment, the most overdue first.
 */
export function planRegistryPurge(input: PlanInput, plan: RunPlan): RegistryPlan {
  const retention = maintenanceOf(input.inst as { maintenance?: unknown }).registryRetention;
  const out: RegistryPlan = {
    schemaVersion: 1,
    today: plan.today,
    now: plan.maintenance.now,
    inWindow: plan.maintenance.inWindow,
    until: plan.maintenance.until,
    retention: { ...retention },
    everyDays: PURGE_EVERY_DAYS,
    maxApps: PURGE_MAX_APPS,
    maxDeletes: PURGE_MAX_DELETES,
    stages: {},
    environments: {},
  };
  const today = plan.today;
  for (const env of input.inst.environments) {
    if (env.promoteFrom) continue;
    const ep: PurgeEnvPlan = { apps: {}, due: 0, deferred: 0, waiting: 0 };
    out.environments[env.name] = ep;
    const candidates: { slug: string; overdue: number; key: string }[] = [];
    for (const entry of input.apps.apps) {
      if (!entry.ok || !entry.environments?.includes(env.name)) continue;
      const slug = entry.slug;
      const p: PurgeAppPlan = { run: false, reason: "", tag: null, record: null, resourceGroup: null, registry: null, protect: [] };
      ep.apps[slug] = p;
      const facts = input.plans[env.name]?.apps[slug];
      if (facts) {
        p.resourceGroup = facts.resourceGroup;
        p.tag = facts.tags[PURGE_TAG] ?? null;
      }
      if (retention.mode === "off") {
        p.reason = "the registry retention is off (maintenance.registryRetention.mode)";
        continue;
      }
      if (entry.decommission) {
        p.reason = "the app is being decommissioned";
        continue;
      }
      if (!facts) {
        p.reason = `not planned in ${env.name}`;
        continue;
      }
      if (facts.lzRecord !== "ok") {
        p.reason = "no landing zone yet";
        continue;
      }
      if (facts.registryPurgeRole !== true) {
        p.reason = "its landing zone has no purge role yet (it comes with the landing zone's upgrade, ADR-0059)";
        continue;
      }
      if (typeof facts.registryName !== "string" || !REGISTRY_RE.test(facts.registryName)) {
        p.reason = "its landing-zone record names no valid registry";
        continue;
      }
      p.registry = facts.registryName;
      if (plan.apps[slug]?.environments[env.name]?.units.lz?.run) {
        p.reason = "its landing zone runs in this run; the purge waits for the next window";
        continue;
      }
      // What the app runs anywhere is protected: every environment of the app must have been read.
      const protect = new Set<string>();
      let missing = "";
      for (const e of entry.environments) {
        const f = input.plans[e]?.apps[slug];
        if (!f) {
          missing = `not planned in ${e}: what it runs there is unknown`;
          break;
        }
        if (!Array.isArray(f.images)) {
          missing = `the Container Apps of ${e} could not be read: what it runs there is unknown`;
          break;
        }
        for (const i of f.images) protect.add(i);
      }
      if (missing) {
        p.reason = missing;
        continue;
      }
      p.protect = [...protect].sort();
      const tag = parsePurgeTag(facts.tags[PURGE_TAG]);
      if (tag && tag.mode === retention.mode && dayNumber(today) - dayNumber(tag.date) < PURGE_EVERY_DAYS) {
        p.reason = `last purge ${tag.date}; the next after ${addDays(tag.date, PURGE_EVERY_DAYS)}`;
        continue;
      }
      const why = !tag ? "never purged" : tag.mode !== retention.mode ? `last purge ${tag.date} in ${tag.mode} mode` : `last purge ${tag.date}`;
      if (!plan.maintenance.inWindow) {
        p.reason = `due (${why}); waits for the maintenance window (${plan.maintenance.until})`;
        ep.waiting++;
        continue;
      }
      p.reason = `due (${why})`;
      candidates.push({ slug, overdue: tag ? dayNumber(today) - dayNumber(tag.date) : Number.MAX_SAFE_INTEGER, key: order(slug, env.name) });
    }
    candidates.sort((a, b) => b.overdue - a.overdue || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    candidates.forEach((c, i) => {
      const p = ep.apps[c.slug]!;
      if (i < PURGE_MAX_APPS) {
        p.run = true;
        p.record = formatPurgeTag(today, retention.mode as "purge" | "dryRun");
        ep.due++;
      } else {
        p.reason += `; deferred to the next window (at most ${PURGE_MAX_APPS} apps per environment and run)`;
        ep.deferred++;
      }
    });
    out.stages[`registry_${env.name}`] = ep.due > 0;
  }
  return out;
}

export function formatRegistryPlan(p: RegistryPlan): string {
  const lines: string[] = [];
  for (const [env, ep] of Object.entries(p.environments)) {
    const what = p.retention.mode === "off" ? "off" : `${ep.due} app(s) this run${ep.deferred ? `, ${ep.deferred} deferred` : ""}${ep.waiting ? `, ${ep.waiting} waiting for the window` : ""}`;
    lines.push(`Registry purge in ${env} (${p.retention.mode}, older than ${p.retention.days} days, newest ${p.retention.keepLatest} kept): ${what}.`);
  }
  return lines.length ? lines.join("\n") + "\n" : "";
}

/** units/registry.json as registry.sh and report.sh read it; refuses anything else. */
export function readRegistryPlan(path: string): RegistryPlan {
  const v = readJson(path, 64 * MiB, "--plan");
  if (!isObject(v) || own(v, "schemaVersion") !== 1 || !isObject(own(v, "environments")) || !isObject(own(v, "retention")) || typeof own(v, "now") !== "number") {
    throw new CheckFailed(["--plan must be units/registry.json of platform provisioning plan-units --registry."]);
  }
  return v as unknown as RegistryPlan;
}

// ------------------------------------------------------------------------------------------
// 2. The decision (stage registry_<env>, per app)
// ------------------------------------------------------------------------------------------

export interface Manifest {
  digest: string;
  tags: string[];
  /** Epoch seconds, or null when the registry didn't say. */
  created: number | null;
  updated: number | null;
  /** changeableAttributes.deleteEnabled; null when absent. */
  deleteEnabled: boolean | null;
}

function epoch(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v)) return null;
  const t = Math.floor(Date.parse(v) / 1000);
  return Number.isFinite(t) && t > EPOCH_MIN && t < EPOCH_MAX ? t : null;
}

/**
 * The output of `az acr manifest list-metadata` (a JSON array of { digest, tags, createdTime,
 * lastUpdateTime, changeableAttributes: { deleteEnabled } }). An entry without a valid digest is
 * counted as unreadable and never deleted. TODO(verify) REG-3: the field names and time format.
 */
export function parseManifests(v: unknown): { manifests: Manifest[]; unreadable: number } {
  if (!Array.isArray(v)) throw new CheckFailed(["--manifests must be the JSON array of az acr manifest list-metadata."]);
  const seen = new Set<string>();
  const manifests: Manifest[] = [];
  let unreadable = 0;
  for (const m of v) {
    const digest = isObject(m) ? own(m, "digest") : undefined;
    if (!isObject(m) || typeof digest !== "string" || !DIGEST_RE.test(digest) || seen.has(digest)) {
      unreadable++;
      continue;
    }
    seen.add(digest);
    const tags = own(m, "tags");
    const attrs = own(m, "changeableAttributes");
    const del = isObject(attrs) ? own(attrs, "deleteEnabled") : undefined;
    manifests.push({
      digest,
      tags: Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [],
      created: epoch(own(m, "createdTime")),
      updated: epoch(own(m, "lastUpdateTime")),
      deleteEnabled: typeof del === "boolean" ? del : null,
    });
  }
  return { manifests, unreadable };
}

export type KeptReason = "running" | "newest" | "young" | "untagged" | "locked" | "otherTag" | "unreadable" | "deferred";

export interface PurgeDecision {
  schemaVersion: 1;
  slug: string | null;
  environment: string | null;
  /** purge: registry.sh deletes `delete`; dryRun: it only reports them. */
  mode: "purge" | "dryRun";
  days: number;
  keepLatest: number;
  now: number;
  total: number;
  /** Oldest first, at most PURGE_MAX_DELETES. */
  delete: { digest: string; tags: string[]; time: string }[];
  kept: Record<KeptReason, number>;
}

export interface PurgeArgs {
  manifests: Manifest[];
  unreadable?: number;
  /** Image references the app runs (digests or tags). */
  protect: readonly string[];
  days: number;
  keepLatest: number;
  now: number;
  maxDeletes?: number;
  mode?: "purge" | "dryRun";
  slug?: string;
  environment?: string;
}

/**
 * Which manifests to delete (ADR-0059). A manifest is kept when it is untagged (it may be part of
 * another image), running (its digest, or one of its tags, is an image the app runs in any
 * environment), among the keepLatest newest builds (by the later of its created and updated times),
 * locked (deleteEnabled false), has a tag the delivery pipeline doesn't write, has no readable time,
 * or is younger than `days`. Every other manifest is deleted, the oldest first, at most maxDeletes;
 * the rest wait for the next purge. Pure.
 */
export function decidePurge(a: PurgeArgs): PurgeDecision {
  if (!Number.isInteger(a.days) || a.days < 1) throw new CheckFailed(["--days must be a whole number of days."]);
  if (!Number.isInteger(a.keepLatest) || a.keepLatest < 1) throw new CheckFailed(["--keep-latest must be at least 1."]);
  if (!Number.isSafeInteger(a.now) || a.now < EPOCH_MIN || a.now > EPOCH_MAX) throw new CheckFailed(["--now must be epoch seconds."]);
  const max = a.maxDeletes ?? PURGE_MAX_DELETES;
  const refs = imageReferences(a.protect);
  const time = (m: Manifest): number | null => (m.created === null && m.updated === null ? null : Math.max(m.created ?? 0, m.updated ?? 0));
  const kept: Record<KeptReason, number> = { running: 0, newest: 0, young: 0, untagged: 0, locked: 0, otherTag: 0, unreadable: a.unreadable ?? 0, deferred: 0 };
  // The newest builds: tagged manifests with a readable time, newest first (ties by digest).
  const builds = a.manifests.filter((m) => m.tags.length > 0 && time(m) !== null);
  builds.sort((x, y) => time(y)! - time(x)! || (x.digest < y.digest ? -1 : 1));
  const newest = new Set(builds.slice(0, a.keepLatest).map((m) => m.digest));
  const candidates: { m: Manifest; t: number }[] = [];
  for (const m of a.manifests) {
    const t = time(m);
    if (m.tags.length === 0) kept.untagged++;
    else if (refs.digests.has(m.digest) || m.tags.some((x) => refs.tags.has(x))) kept.running++;
    else if (t === null) kept.unreadable++;
    else if (newest.has(m.digest)) kept.newest++;
    else if (m.deleteEnabled === false) kept.locked++;
    else if (m.tags.some((x) => !DELIVERY_TAG_RE.test(x))) kept.otherTag++;
    else if (a.now - t < a.days * DAY_S) kept.young++;
    else candidates.push({ m, t });
  }
  candidates.sort((x, y) => x.t - y.t || (x.m.digest < y.m.digest ? -1 : 1));
  const chosen = candidates.slice(0, max);
  kept.deferred = candidates.length - chosen.length;
  return {
    schemaVersion: 1,
    slug: a.slug ?? null,
    environment: a.environment ?? null,
    mode: a.mode ?? "dryRun",
    days: a.days,
    keepLatest: a.keepLatest,
    now: a.now,
    total: a.manifests.length + (a.unreadable ?? 0),
    delete: chosen.map(({ m, t }) => ({ digest: m.digest, tags: [...m.tags].sort(), time: new Date(t * 1000).toISOString() })),
    kept,
  };
}

export function formatPurgeDecision(d: PurgeDecision): string {
  const k = d.kept;
  const who = d.slug ? `${d.slug} in ${d.environment}` : "the listed registry";
  const verb = d.mode === "purge" ? "delete" : "would delete (dry run)";
  const lines = [
    `Registry purge of ${who}: ${d.total} image(s); ${verb} ${d.delete.length}; kept: ${k.running} running, ${k.newest} newest, ${k.young} younger than ${d.days} days, ` +
      `${k.untagged} untagged, ${k.locked} locked, ${k.otherTag} with other tags, ${k.unreadable} unreadable${k.deferred ? `; ${k.deferred} more next time (at most ${d.delete.length} per run)` : ""}.`,
  ];
  for (const x of d.delete.slice(0, 50)) lines.push(`  ${d.mode === "purge" ? "delete" : "would delete"} ${x.digest.slice(0, 19)}  ${x.time.slice(0, 10)}  ${x.tags.join(" ")}`);
  if (d.delete.length > 50) lines.push(`  ... and ${d.delete.length - 50} more (the output file lists them).`);
  return lines.join("\n") + "\n";
}

export const REGISTRY_PURGE_HELP = `  registry-purge --manifests <list-metadata.json> --output <decision.json> [--live <images.json>]
                 (--plan <units/registry.json> --env <name> --slug <slug>
                  | --days <n> --keep-latest <n> [--protect <image or digest>]... [--now <epoch>])
      which manifests of an app's build-environment registry to delete (ADR-0059): --manifests is the
      output of az acr manifest list-metadata for the app's repository; kept are untagged manifests,
      every image the app runs (the plan's protect list, the images in --live: a JSON array of image
      references read right before), the --keep-latest newest builds, locked ones, ones with a tag
      the delivery pipeline doesn't write, ones without a readable time and ones younger than
      --days; the rest are deleted, the oldest first, at most ${PURGE_MAX_DELETES} per run. With --plan, the
      retention and the protected images come from the run's plan, which must purge that app there;
      without it the decision is a dry run (an operator's check of a registry listing). Writes
      { mode, delete: [{ digest, tags, time }], kept: { <reason>: <count> } }; deletes nothing itself
`;

function readImages(path: string): string[] {
  const v = readJson(path, 1 * MiB, "--live");
  if (v === null) return [];
  if (!Array.isArray(v) || v.some((x) => x !== null && typeof x !== "string")) throw new CheckFailed(["--live must be a JSON array of image references."]);
  return (v as (string | null)[]).filter((x): x is string => typeof x === "string");
}

function intArg(v: string | undefined, label: string, min: number, max: number): number {
  if (v === undefined || !/^[0-9]{1,10}$/.test(v) || Number(v) < min || Number(v) > max) throw new CheckFailed([`${label} must be a whole number from ${min} to ${max}.`]);
  return Number(v);
}

export function cmdRegistryPurge(v: { manifests: string; output: string; live?: string; plan?: string; env?: string; slug?: string; days?: string; "keep-latest"?: string; protect?: string[]; now?: string }): string {
  const { manifests, unreadable } = parseManifests(readJson(v.manifests, 64 * MiB, "--manifests"));
  const live = v.live !== undefined ? readImages(v.live) : [];
  let args: PurgeArgs;
  if (v.plan !== undefined) {
    if (v.days !== undefined || v["keep-latest"] !== undefined || v.protect !== undefined || v.now !== undefined) {
      throw new CheckFailed(["--plan takes the retention, the protected images and the time from the plan: no --days, --keep-latest, --protect or --now."]);
    }
    if (!v.env || !ENV_NAME_RE.test(v.env) || !v.slug || !SLUG_RE.test(v.slug)) throw new CheckFailed(["--plan needs --env <name> and --slug <slug>."]);
    const plan = readRegistryPlan(v.plan);
    const app = plan.environments[v.env]?.apps[v.slug];
    if (!app || app.run !== true) throw new CheckFailed([`the plan doesn't purge ${v.slug} in ${v.env}.`]);
    const mode = plan.retention.mode;
    if (mode !== "purge" && mode !== "dryRun") throw new CheckFailed(["the plan's registry retention is off."]);
    args = { manifests, unreadable, protect: [...app.protect, ...live], days: plan.retention.days, keepLatest: plan.retention.keepLatest, now: plan.now, maxDeletes: plan.maxDeletes, mode, slug: v.slug, environment: v.env };
  } else {
    const now = v.now !== undefined ? intArg(v.now, "--now", EPOCH_MIN, EPOCH_MAX) : Math.floor(Date.now() / 1000);
    args = { manifests, unreadable, protect: [...(v.protect ?? []), ...live], days: intArg(v.days, "--days", 1, 3650), keepLatest: intArg(v["keep-latest"], "--keep-latest", 1, 100), now, mode: "dryRun" };
  }
  const d = decidePurge(args);
  writeJson(v.output, d);
  return formatPurgeDecision(d);
}
