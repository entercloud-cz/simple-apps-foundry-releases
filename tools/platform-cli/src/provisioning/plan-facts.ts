import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { cellsOfMode, DEFAULT_CELL_ID } from "../capacity.js";
import { neutralize } from "../neutralize.js";
import { CheckFailed, ENV_NAME_RE, KiB, MiB, SLUG_RE, isObject, own, readJson, writeJson } from "../pipeline/common.js";
import { instanceEnv, loadInstanceFile, offeredModes } from "./model.js";
import type { InstanceEnv } from "./model.js";
import * as names from "./names.js";
import { rotationDue } from "./rotation.js";
import { readAppsDoc } from "./units.js";

/**
 * `platform provisioning plan-facts` (ADR-0050): the read model of a job plan_<env>. plan.sh reads
 * the state of EVERY app of the environment in a constant number of `az` calls (lists, not one
 * read per app), and this command turns those lists into what the decision (`plan-units`) and the
 * later stages read, per app: facts/<slug>.json, status/<slug>.<env>.json and the entries
 * lz-outputs/, secret/ and frontdoor/. Pure: files in, files out.
 *
 * The lists (--bulk <dir>; a missing file = that list could not be read):
 *   groups.json          [{name, tags}]: every resource group of the subscription (az group list)
 *   lz-records.json      [{name, properties: {provisioningState, templateHash, parameters, outputs}}]:
 *                        the deployments lz-* at subscription scope (az deployment sub list)
 *   fd-records.json      the deployments fd-* of the platform resource group (az deployment group list)
 *   fd-domains.json      [ARM customDomains resources]: of the Front Door profiles the fd records name
 *   container-apps.json  [ARM Microsoft.App/containerApps resources]: of the subscription
 *   jobs.json            [ARM Microsoft.App/jobs resources]: of the platform resource group
 *   env-vaults.json      { <mode>: <vault> }: the environment vault of each network mode the environment
 *                        offers, named by names.bicep once per vault variant (plan.sh, ADR-0060); absent
 *                        (an older plan.sh): the vault and the mode of the landing-zone record, as before
 *   secrets/<vault>.json [ARM Microsoft.KeyVault/vaults/secrets resources]: per environment vault of
 *                        env-vaults.json (both variants when the environment offers both, ADR-0060),
 *                        or per vault the lz records name (metadata only; ARM never returns a value)
 *   revisions/<slug>.json [{name, created}]: the active revisions of the apps lazy.json listed
 *
 * Facts, and where each comes from (bulk = one of the lists above):
 *   tags                   bulk (groups)
 *   lzRecord, federation,  bulk (lz records: provisioningState, outputs, parameters deliveryFederation,
 *   easyAuthInLandingZone  easyAuthSecretExists, networkMode)
 *   secret state, created, bulk (the environment vault's secret list: attributes created and exp)
 *   expires
 *   secret loaded          the Container App's tag saf-easyauth (bulk); equal to the version: no
 *                          restart is pending. Otherwise the app's last modification
 *                          (systemData.lastModifiedAt, bulk): at least PROV_EASYAUTH_SETTLE_S after the
 *                          version, a release deployment (delivery or provisioning) created a revision
 *                          that started with it, so no restart is pending; before it, every revision
 *                          predates the version: pending. Unknown, or the rotation due within a day
 *                          (its password removal needs the exact version the app runs with): lazy, the
 *                          app's revisions are read (lazy.json) and decide as before (ADR-0041)
 *   kvset job state        bulk (the platform resource group's jobs: image against the pinned digest)
 *   frontDoorRecord        bulk (fd records); the domain's state bulk (the profile's customDomains)
 *   rangesChanged          bulk (the Container App's ingress rules afd-backend-* against this run's
 *                          AzureFrontDoor.Backend ranges)
 *   entraDeployment        a name (names.ts); the record's existence is decided from the host's one list
 *   images                 bulk (the Container App's containers and init containers): what the app runs,
 *                          protected from the registry purge (ADR-0059); null when the list wasn't read
 *   registryName,          bulk (lz records: outputs registryName and registryPurgeRole): the app's
 *   registryPurgeRole      registry and whether its landing zone gave the provisioning identity the
 *                          purge role (ADR-0059)
 *   containerAppMode,      bulk (the Container App's environmentId against names.ts cellManagedEnvironment
 *   containerAppCell,      of each mode and each of its capacity cells in instance.yaml, ADR-0053; its
 *   liveFqdn               ingress FQDN): the network mode and the cell the app runs in now, none without
 *                          a Container App, unknown for a CAE named for no mode and cell, null when the
 *                          list wasn't read (ADR-0060); the cell only with a mode
 *   lzNetworkMode,         bulk (lz record parameters networkMode and modeChange, also of a record that
 *   lzPrepareFrom          didn't succeed): the mode the landing zone was deployed for, and the source
 *                          mode of a prepare pass (a move under way, ADR-0060)
 *   secretElsewhere        bulk (env-vaults.json, the other variant's vault's secret list): easyauth-{slug}
 *                          is also in the vault of the other variant while the app runs in the variant
 *                          of app.yaml's mode: a case A move left it there (the follow-up, ADR-0060)
 *
 * Entries are written for every app (they cost no call): lz-outputs/ for a usable landing zone,
 * secret/ for sign-in apps with one, frontdoor/ for apps with a record. The secret entry names the vault
 * and the kvset job of app.yaml's network mode in app.yaml's cell (ADR-0060 decision 3, ADR-0053; not the
 * record's, which still names the old mode during a move), and adds appVault (the vault of the mode the app runs in now, for
 * `easyauth-secret --mode remove-old`, as the Entra provisioning identity can't read Container Apps) and
 * elsewhere ({vault, job, jobState, jobReady} of the other variant while secretElsewhere; the job is cell
 * 01's kvset job of the other mode: every mode has a cell 01, and any of its cells reaches that variant's
 * vault). The secret entry's `loaded`
 * (handed to the rotation's password removal) is only ever exact: the tag when it names the version,
 * or the revisions read for the app; otherwise the tag (an older version) or null, so a rotation
 * removes no password it can't prove unused.
 *
 * TODO(verify) UNIT-7: that the lists return what is read here (deployment lists with parameters and
 * outputs, Container Apps with systemData.lastModifiedAt and the ingress rules, vault secrets with
 * attributes created and exp, custom domains with their states), as the single GETs did.
 *
 * An app fails its plan (status failed, nothing runs for it there) when a list it needs could not be
 * read, its custom domain needs ranges that could not be resolved, its record is malformed, its Container
 * App runs in app.yaml's network mode but another capacity cell than app.yaml names (ADR-0053: the
 * platform doesn't move an app between the cells of one mode; its release would be refused), or (ADR-0061
 * section 4) it reuses a deleted app's slug (apps.json reusesSlug) and the landing-zone record of that
 * slug has a lower generation than the app's: "the deleted app with this slug is not fully deleted
 * yet". A
 * list that fails fails only the apps that need it; a failed tag list fails every app of the
 * environment (it used to run every unit, which at hundreds of apps is a stampede; ADR-0050).
 */

export const SETTLE_S = 1800;
/** A rotation due within this long gets the exact read (its password removal needs it). */
const ROTATION_MARGIN_S = 86_400;

const EPOCH_MIN = 946_684_800;
const EPOCH_MAX = 4_102_444_800;

/** Epoch seconds from a number or an RFC 3339 time in UTC (Key Vault attributes, systemData, revisions). */
export function epoch(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v > EPOCH_MIN && v < EPOCH_MAX) return Math.floor(v);
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:00)$/.test(v)) {
    const t = Math.floor(Date.parse(v.replace(/[+-]00:00$/, "Z")) / 1000);
    return Number.isFinite(t) && t > EPOCH_MIN && t < EPOCH_MAX ? t : null;
  }
  return null;
}

type Listed = Record<string, unknown>[] | undefined;

function readList(dir: string, file: string, label: string): Listed {
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  const v = readJson(path, 256 * MiB, label);
  if (!Array.isArray(v)) throw new CheckFailed([`${label} must be a JSON array.`]);
  return v.filter(isObject);
}

const lower = (v: unknown): string => (typeof v === "string" ? v.toLowerCase() : "");

function byName(list: Listed): Map<string, Record<string, unknown>> | undefined {
  if (!list) return undefined;
  const m = new Map<string, Record<string, unknown>>();
  for (const x of list) if (typeof own(x, "name") === "string") m.set(lower(own(x, "name")), x);
  return m;
}

/**
 * ADR-0059: the images a Container App runs (containers and init containers) as the list returns them:
 * [] when the app has no Container App, null when the Container Apps weren't listed. Shapes are checked
 * (an image reference, at most 50), anything else is left out, so the purge protects what is readable
 * and the decision never sees list text it can't parse.
 */
function imagesOf(ca: Record<string, unknown> | undefined, listed: boolean): string[] | null {
  if (!listed) return null;
  if (!ca) return [];
  const t = obj(own(props(ca), "template"));
  const out: string[] = [];
  for (const key of ["containers", "initContainers"]) {
    const list = own(t, key);
    if (!Array.isArray(list)) continue;
    for (const c of list) {
      const image = isObject(c) ? own(c, "image") : undefined;
      if (typeof image === "string" && image.length <= 600 && /^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/.test(image) && out.length < 50 && !out.includes(image)) out.push(image);
    }
  }
  return out;
}

/** v when it is an object, else {} (lists from Azure are untrusted). */
function obj(v: unknown): Record<string, unknown> {
  return isObject(v) ? v : {};
}

function props(x: Record<string, unknown> | undefined): Record<string, unknown> {
  return obj(x ? own(x, "properties") : undefined);
}

/**
 * ADR-0056: the Container App's runningStatus is Stopped (true) or another word (false); null when
 * the list wasn't read, the app isn't in it, or the status is missing (older API answers).
 * TODO(verify) DECOM-2: the list returns properties.runningStatus, "Stopped" after a stop.
 */
function stoppedOf(ca: Record<string, unknown> | undefined, listed: boolean): boolean | null {
  if (!listed || !ca) return null;
  const s = own(props(ca), "runningStatus");
  return typeof s === "string" && /^[A-Za-z]{1,40}$/.test(s) ? s.toLowerCase() === "stopped" : null;
}

export type LiveMode = "externalOnly" | "externalHybrid" | "none" | "unknown";
const MODES = ["externalOnly", "externalHybrid"] as const;

/**
 * The CAEs an app of the environment can run in, by their ID in lower case (ADR-0053): each mode of
 * iteration 1 with each cell instance.yaml lists for it (absent: cell 01, also for a mode the
 * environment doesn't offer, so an app left in it is still recognised).
 */
function caeIndex(env: InstanceEnv, base: string, prefix: string): Map<string, { mode: (typeof MODES)[number]; cell: string }> {
  const out = new Map<string, { mode: (typeof MODES)[number]; cell: string }>();
  for (const mode of MODES) {
    for (const c of cellsOfMode(env.networkModes[mode])) {
      out.set(`${base}/providers/microsoft.app/managedenvironments/${names.cellManagedEnvironment(prefix, mode, env.name, c.id)}`.toLowerCase(), { mode, cell: c.id });
    }
  }
  return out;
}

/**
 * ADR-0060: the network mode and the capacity cell (ADR-0053) a Container App runs in now, from its
 * environmentId (managedEnvironmentId in older answers) against the CAE naming gives each mode and cell
 * in the environment's platform resource group (caeIndex): mode none without a Container App, unknown for
 * any other environment (or none listed), null when the list wasn't read; the cell only with a mode.
 * TODO(verify) UNIT-7: the list returns properties.environmentId.
 */
function liveModeOf(ca: Record<string, unknown> | undefined, listed: boolean, caes: Map<string, { mode: (typeof MODES)[number]; cell: string }>): { mode: LiveMode; cell: string | null } | null {
  if (!listed) return null;
  if (!ca) return { mode: "none", cell: null };
  const p = props(ca);
  const hit = caes.get(lower(own(p, "environmentId") ?? own(p, "managedEnvironmentId")));
  return hit ?? { mode: "unknown", cell: null };
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** ADR-0060: the live app's ingress FQDN as the list returns it (a host name), or null. */
function liveFqdnOf(ca: Record<string, unknown> | undefined): string | null {
  const ingress = own(obj(own(props(ca), "configuration")), "ingress");
  const fqdn = lower(isObject(ingress) ? own(ingress, "fqdn") : undefined);
  return fqdn.length <= 253 && HOST_RE.test(fqdn) ? fqdn : null;
}

/** env-vaults.json of plan.sh: { <mode>: <vault> } (ADR-0060), or undefined when it wasn't written. */
function readEnvVaults(dir: string): Map<string, string> | undefined {
  const path = join(dir, "env-vaults.json");
  if (!existsSync(path)) return undefined;
  const v = readJson(path, 64 * KiB, "env-vaults.json");
  if (!isObject(v)) throw new CheckFailed(["env-vaults.json must be a JSON object { <mode>: <vault> }."]);
  const out = new Map<string, string>();
  for (const [mode, vault] of Object.entries(v)) {
    if (!(MODES as readonly string[]).includes(mode) || typeof vault !== "string" || !VAULT_RE.test(vault)) throw new CheckFailed([`env-vaults.json has an invalid entry for "${mode.slice(0, 20)}".`]);
    out.set(mode, vault);
  }
  return out;
}

function param(record: Record<string, unknown>, name: string): unknown {
  const p = own(props(record), "parameters");
  if (!isObject(p)) return undefined;
  const e = own(p, name);
  return isObject(e) && Object.hasOwn(e, "value") ? e.value : undefined;
}

export interface PlanFactsArgs {
  instance: string;
  apps: string;
  env: string;
  bulk: string;
  images: string;
  out: string;
  fdRanges?: string;
  now?: number;
  runId?: string;
}

export interface PlanFactsResult {
  env: string;
  apps: number;
  ok: number;
  failed: { slug: string; reason: string }[];
  /** The apps whose active revisions plan.sh reads, with their Container App's ARM ID. */
  lazy: { slug: string; id: string }[];
  warnings: string[];
}

const VAULT_RE = /^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$/;
const CUSTOM_DOMAIN_RE = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[-A-Za-z0-9._()]{1,90}\/providers\/Microsoft\.Cdn\/profiles\/[-A-Za-z0-9]{1,260}\/customDomains\/[-A-Za-z0-9]{1,260}$/;

/** The secret attributes of every vault list read (lower-case secret name -> {created, expires}). */
function vaultSecrets(dir: string): Map<string, Map<string, { created: number | null; expires: number | null }>> {
  const out = new Map<string, Map<string, { created: number | null; expires: number | null }>>();
  const sdir = join(dir, "secrets");
  if (!existsSync(sdir)) return out;
  for (const f of readdirSync(sdir)) {
    const m = /^([A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9])\.json$/.exec(f);
    if (!m) continue;
    const list = readList(sdir, f, `secrets/${f}`) ?? [];
    const secrets = new Map<string, { created: number | null; expires: number | null }>();
    for (const s of list) {
      const attrs = own(props(s), "attributes");
      const a = isObject(attrs) ? attrs : {};
      secrets.set(lower(own(s, "name")), { created: epoch(own(a, "created")), expires: epoch(own(a, "exp")) });
    }
    out.set(m[1]!.toLowerCase(), secrets);
  }
  return out;
}

/** The revisions read for an app: undefined when not read, "failed" when the read failed (marker file). */
function readRevisions(dir: string, slug: string): { name: string; created: number | null }[] | "failed" | undefined {
  if (existsSync(join(dir, "revisions", `${slug}.failed`))) return "failed";
  const path = join(dir, "revisions", `${slug}.json`);
  if (!existsSync(path)) return undefined;
  const v = readJson(path, 4 * MiB, `revisions/${slug}.json`);
  if (!Array.isArray(v)) throw new CheckFailed([`revisions/${slug}.json must be a JSON array.`]);
  return v.filter(isObject).map((r) => ({ name: String(own(r, "name") ?? ""), created: epoch(own(r, "created")) }));
}

function rangesOf(path: string | undefined): string[] | undefined {
  if (!path || !existsSync(path)) return undefined;
  const v = readJson(path, 1 * MiB, "--fd-ranges");
  const r = isObject(v) ? own(v, "ranges") : undefined;
  if (!Array.isArray(r) || r.some((x) => typeof x !== "string")) throw new CheckFailed(["--fd-ranges must be the output of fd-ranges ({ ranges })."]);
  return r as string[];
}

function sameSet(a: string[], b: string[]): boolean {
  const x = [...a].sort();
  const y = [...b].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

export function planFacts(args: PlanFactsArgs): PlanFactsResult {
  if (!ENV_NAME_RE.test(args.env)) throw new CheckFailed(["--env must be an environment name."]);
  const inst = loadInstanceFile(args.instance);
  const env = instanceEnv(inst, args.env);
  const prefix = inst.naming.prefix;
  const sub = env.subscriptionId.toLowerCase();
  const doc = readAppsDoc(args.apps);
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const stage = `plan_${args.env}`;
  const images = readJson(args.images, 256 * KiB, "--images");
  const digest = isObject(images) && isObject(own(images, "images")) ? own(own(images, "images") as Record<string, unknown>, "saf-jobs") : undefined;
  const jobsDigest = isObject(digest) ? own(digest, "digest") : undefined;
  if (typeof jobsDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(jobsDigest)) throw new CheckFailed(["--images has no valid saf-jobs digest."]);

  const groups = readList(args.bulk, "groups.json", "groups.json");
  const lzRecords = byName(readList(args.bulk, "lz-records.json", "lz-records.json"));
  const fdRecords = byName(readList(args.bulk, "fd-records.json", "fd-records.json"));
  const fdDomainList = readList(args.bulk, "fd-domains.json", "fd-domains.json");
  const caList = readList(args.bulk, "container-apps.json", "container-apps.json");
  const jobList = readList(args.bulk, "jobs.json", "jobs.json");
  const secrets = vaultSecrets(args.bulk);
  const ranges = rangesOf(args.fdRanges);
  // ADR-0060: the environment vault of each mode the environment offers (names.bicep, plan.sh).
  const envVaults = readEnvVaults(args.bulk);

  const tags = new Map<string, Record<string, string>>();
  for (const g of groups ?? []) {
    const t = own(g, "tags");
    const saf: Record<string, string> = {};
    if (isObject(t)) for (const [k, v] of Object.entries(t)) if (typeof v === "string" && k.toLowerCase().startsWith("saf-")) saf[k.toLowerCase()] = v;
    tags.set(lower(own(g, "name")), saf);
  }
  const apps = new Map<string, Record<string, unknown>>();
  for (const a of caList ?? []) apps.set(lower(own(a, "id")), a);
  const jobs = new Map<string, string>();
  for (const j of jobList ?? []) {
    const c = own(obj(own(props(j), "template")), "containers");
    const image = Array.isArray(c) && isObject(c[0]) ? own(c[0], "image") : undefined;
    jobs.set(lower(own(j, "id")), typeof image === "string" ? image : "");
  }
  const domains = new Map<string, Record<string, unknown>>();
  for (const d of fdDomainList ?? []) domains.set(lower(own(d, "id")), d);

  const out = args.out;
  for (const d of ["status", "facts", "lz-outputs", "secret", "frontdoor"]) mkdirSync(join(out, d), { recursive: true });
  const result: PlanFactsResult = { env: args.env, apps: 0, ok: 0, failed: [], lazy: [], warnings: [] };
  const platformRg = names.platformResourceGroup(prefix, args.env);
  const caes = caeIndex(env, `/subscriptions/${sub}/resourceGroups/${platformRg}`, prefix);

  for (const entry of doc.apps) {
    if (!entry.ok || !entry.environments?.includes(args.env)) continue;
    if (!SLUG_RE.test(entry.slug)) throw new CheckFailed(["--apps lists an invalid slug."]);
    const slug = entry.slug;
    result.apps++;
    const detail: Record<string, string> = {};
    // The failure code (ADR-0064): PE003 when a read failed (the app's state can't be told), PE001 for
    // a state the plan refuses (another cell, a slug not free yet, a malformed record), whose reason the log names.
    const status = (s: "ok" | "failed", reason: string | null, code: "PE001" | "PE003" | null = null): void => {
      writeJson(join(out, "status", `${slug}.${args.env}.json`), { schemaVersion: 1, stage, slug, environment: args.env, status: s, reason, code, runId: args.runId ?? "", detail, done: [] });
    };
    const fail = (reason: string, code: "PE001" | "PE003" = "PE003"): void => {
      result.failed.push({ slug, reason });
      status("failed", `failed in ${stage}: ${reason}`, code);
    };
    try {
      if (!groups) {
        fail("the tags of the resource groups could not be read");
        continue;
      }
      if (!lzRecords) {
        fail("the landing-zone records could not be listed");
        continue;
      }
      if (!fdRecords) {
        fail("the custom domains' records could not be listed");
        continue;
      }
      const rg = names.appResourceGroup(prefix, slug, args.env);
      const lz = lzRecords.get(names.provisioningDeployment(slug, args.env));
      const ca = caList ? apps.get(`/subscriptions/${sub}/resourceGroups/${rg}/providers/Microsoft.App/containerApps/${names.containerApp(slug)}`.toLowerCase()) : undefined;
      // ADR-0060: where the app runs now, what its landing zone was deployed for, and app.yaml's mode.
      const toMode = entry.networkModes?.[args.env] ?? "";
      const toCell = entry.cells?.[args.env] ?? DEFAULT_CELL_ID;
      const live = liveModeOf(ca, !!caList, caes);
      const liveMode = live === null ? null : live.mode;
      const liveCell = live === null ? null : live.cell;
      const lzParam = (name: string): unknown => (lz && isObject(own(props(lz), "parameters")) ? param(lz, name) : undefined);
      // ADR-0061 section 4: an app whose slug has a deleted app's archive is a new incarnation. A
      // landing-zone record with a lower generation than its own is the old app's (the delete phase
      // deletes that record last, so it is left until everything else of the old app is gone): the new
      // app never takes it over. Raising generation on a live app without an archive is not refused here.
      if (entry.reusesSlug && lz) {
        const g = lzParam("generation");
        const mine = entry.generation ?? 0;
        if (!Number.isSafeInteger(g) || (g as number) < mine) {
          fail(`the deleted app with this slug is not fully deleted yet: its landing-zone record ${names.provisioningDeployment(slug, args.env)} has ${Number.isSafeInteger(g) ? `generation ${String(g)}` : "no readable generation"}, this app has generation ${mine} (ADR-0061; runbook decommission-app.md)`, "PE001");
          continue;
        }
      }
      const lzNetworkMode = typeof lzParam("networkMode") === "string" && (MODES as readonly string[]).includes(lzParam("networkMode") as string) ? (lzParam("networkMode") as string) : null;
      const change = lzParam("modeChange");
      const lzPrepareFrom = isObject(change) && own(change, "phase") === "prepare" && (MODES as readonly string[]).includes(own(change, "fromNetworkMode") as string) ? (own(change, "fromNetworkMode") as string) : null;
      const otherMode = lzPrepareFrom !== null || (lzNetworkMode !== null && toMode !== "" && lzNetworkMode !== toMode);
      if (!caList && otherMode) {
        fail("the Container Apps could not be listed, and its landing zone names another network mode than app.yaml: where the app runs can't be told (ADR-0060)");
        continue;
      }
      if (liveMode === "unknown" && otherMode) {
        fail("its Container App runs in a Container Apps environment named for no network mode and capacity cell, and its landing zone names another mode than app.yaml: it is not moved (ADR-0060; check it by hand)", "PE001");
        continue;
      }
      // ADR-0053: the cells of one mode are separate CAEs, and a Container App can't change its CAE; the
      // platform moves an app into another cell only with a network mode change (ADR-0060 amendment
      // 2026-11-16). Its release would be refused, so nothing runs for it here.
      if (liveMode === toMode && liveCell !== null && liveCell !== toCell) {
        fail(`its Container App runs in capacity cell ${liveCell} of ${toMode}, but app.yaml names cell ${toCell}: the platform doesn't move an app between the cells of one network mode (ADR-0053; put the cell back, or check it by hand)`, "PE001");
        continue;
      }
      let lzState: "ok" | "absent" | "unusable" = "absent";
      let federation = false;
      let inLz = false;
      let mode = "";
      let registryName: string | null = null;
      let registryPurgeRole = false;
      if (lz) {
        const p = props(lz);
        if (own(p, "provisioningState") === "Succeeded" && isObject(own(p, "outputs"))) {
          if (!isObject(own(p, "parameters"))) {
            fail("its landing-zone record was listed without parameters (TODO(verify) UNIT-7)");
            continue;
          }
          lzState = "ok";
          federation = param(lz, "deliveryFederation") !== undefined && param(lz, "deliveryFederation") !== null;
          inLz = param(lz, "easyAuthSecretExists") === true;
          mode = typeof param(lz, "networkMode") === "string" ? (param(lz, "networkMode") as string) : "";
          // ADR-0059: the registry and the purge role, as the landing zone's outputs say.
          const outs = own(p, "outputs") as Record<string, unknown>;
          const reg = own(obj(own(outs, "registryName")), "value");
          registryName = typeof reg === "string" && /^[a-z0-9]{5,50}$/.test(reg) ? reg : null;
          registryPurgeRole = own(obj(own(outs, "registryPurgeRole")), "value") === true;
          writeJson(join(out, "lz-outputs", `${slug}.${args.env}.json`), own(p, "outputs"));
        } else lzState = "unusable";
      }
      detail.landingZone = lzState;

      const auth = entry.authMode === "required";
      let secret: { state: "present" | "absent"; created: number | null; expires: number | null; loaded: number | null } | null = null;
      let secretElsewhere = false;
      if (auth && lzState === "ok") {
        if (mode !== "externalOnly" && mode !== "externalHybrid") {
          fail("its landing zone has no valid networkMode", "PE001");
          continue;
        }
        let vault: unknown;
        if (envVaults) {
          // ADR-0060 decision 3: the vault and the kvset job of app.yaml's mode, not the record's.
          if (!envVaults.has(toMode)) {
            fail(`no environment vault is named for its network mode ${toMode || "(none)"} in ${args.env} (env-vaults.json)`, "PE001");
            continue;
          }
          mode = toMode;
          vault = envVaults.get(toMode);
        } else {
          const outputs = own(props(lz), "outputs") as Record<string, unknown>;
          const vaultOut = own(outputs, "environmentKeyVaultName");
          vault = isObject(vaultOut) ? own(vaultOut, "value") : undefined;
        }
        if (typeof vault !== "string" || !VAULT_RE.test(vault)) {
          fail("its landing zone has no valid output environmentKeyVaultName", "PE001");
          continue;
        }
        const list = secrets.get(vault.toLowerCase());
        if (!list) {
          fail(`the secrets of the environment vault ${vault} could not be listed`);
          continue;
        }
        if (!jobList) {
          fail("the platform jobs could not be listed");
          continue;
        }
        if (!caList) {
          fail("the Container Apps could not be listed");
          continue;
        }
        // The kvset job of the app's CAE: app.yaml's mode (or the record's, with an older plan.sh) in app.yaml's cell.
        const jobId = `/subscriptions/${sub}/resourceGroups/${platformRg}/providers/Microsoft.App/jobs/${names.cellPlatformJob(prefix, "kvset", mode, toCell)}`;
        const image = jobs.get(jobId.toLowerCase());
        const jobState = image === undefined ? "missing" : image.endsWith(`@${jobsDigest}`) ? "current" : "outdated";
        const meta = list.get(names.easyAuthSecret(slug).toLowerCase());
        const state = meta ? "present" : "absent";
        const created = meta?.created ?? null;
        const expires = meta?.expires ?? null;
        let loaded: number | null = null;
        let decided: number | null = null;
        if (state === "present") {
          const t = ca ? own(obj(own(ca, "tags")), "saf-easyauth") : undefined;
          const tag = typeof t === "string" && /^[0-9]{9,10}$/.test(t) ? Number(t) : null;
          const revisions = readRevisions(args.bulk, slug);
          if (revisions === "failed") {
            fail("the revisions of its Container App could not be read");
            continue;
          }
          if (!ca) {
            loaded = null;
            decided = null;
          } else if (revisions) {
            // As prov_easyauth_app: every active revision created at least the settle time after the version.
            const allAfter = created !== null && revisions.length > 0 && revisions.every((r) => r.created !== null && r.created >= created + SETTLE_S);
            loaded = allAfter ? created : tag;
            decided = loaded;
          } else if (tag !== null && tag === created) {
            loaded = created;
            decided = created;
          } else {
            loaded = tag;
            const sys = own(ca, "systemData");
            const modified = isObject(sys) ? epoch(own(sys, "lastModifiedAt")) : null;
            const soon = rotationDue(expires ?? undefined, now + ROTATION_MARGIN_S, created ?? undefined).due;
            if (soon || modified === null || created === null) {
              result.lazy.push({ slug, id: String(own(ca, "id")) });
              decided = tag;
            } else decided = modified >= created + SETTLE_S ? created : tag;
          }
        }
        // ADR-0060: the vault of the mode the app runs in now (remove-old's --app-vault), and the secret
        // left in the other variant's vault while the app runs in the variant of app.yaml's mode.
        const appVault = envVaults && (liveMode === "externalOnly" || liveMode === "externalHybrid") ? (envVaults.get(liveMode) ?? null) : null;
        let elsewhere: { vault: string; job: string; jobReady: boolean; jobState: string } | null = null;
        if (envVaults && appVault !== null && appVault.toLowerCase() === vault.toLowerCase()) {
          for (const [otherMode, other] of envVaults) {
            if (other.toLowerCase() === vault.toLowerCase()) continue;
            const otherList = secrets.get(other.toLowerCase());
            if (!otherList) {
              result.warnings.push(`could not tell whether the Easy Auth secret of ${slug} in ${args.env} is left in ${other} (its secrets were not listed); a later run removes it`);
              break;
            }
            if (!otherList.has(names.easyAuthSecret(slug).toLowerCase())) break;
            const otherJob = `/subscriptions/${sub}/resourceGroups/${platformRg}/providers/Microsoft.App/jobs/${names.platformJob(prefix, "kvset", otherMode)}`;
            const otherImage = jobs.get(otherJob.toLowerCase());
            const otherState = otherImage === undefined ? "missing" : otherImage.endsWith(`@${jobsDigest}`) ? "current" : "outdated";
            elsewhere = { vault: other, job: otherJob, jobReady: otherState === "current", jobState: otherState };
            secretElsewhere = true;
            break;
          }
        }
        writeJson(join(out, "secret", `${slug}.${args.env}.json`), { state, vault, job: jobId, jobReady: jobState === "current", jobState, created, expires, loaded, appVault, elsewhere });
        secret = { state, created, expires, loaded: decided };
        detail.secret = state;
      }

      // The custom domain (ADR-0010 amended 2026-11-11).
      const host = entry.frontDoorHosts?.[args.env];
      if (host && !ranges) {
        fail(`it is on a custom domain through Front Door in ${args.env}, but the AzureFrontDoor.Backend ranges could not be resolved in this run; nothing is released with a guessed list`);
        continue;
      }
      const fd = fdRecords.get(names.frontDoorDeployment(slug, args.env));
      if (fd) {
        writeJson(join(out, "frontdoor", `${slug}.${args.env}.json`), fd);
        const id = own(obj(own(props(fd), "outputs")), "customDomainId");
        const cd = isObject(id) ? own(id, "value") : undefined;
        if (own(props(fd), "provisioningState") === "Succeeded") {
          if (typeof cd !== "string" || !CUSTOM_DOMAIN_RE.test(cd)) result.warnings.push(`the record of the custom domain of ${slug} in ${args.env} has no valid output customDomainId; its ingress is not locked for the first time in this run`);
          else if (!fdDomainList) result.warnings.push(`could not read the custom domain of ${slug} in ${args.env}; its ingress is not locked for the first time in this run`);
          else {
            const d = domains.get(cd.toLowerCase());
            if (d) {
              const p = props(d);
              const word = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z]{1,40}$/.test(v) ? v : null);
              writeJson(join(out, "frontdoor", `${slug}.${args.env}.domain.json`), { domainValidationState: word(own(p, "domainValidationState")), deploymentStatus: word(own(p, "deploymentStatus")) });
            }
          }
        }
      }
      // The release's backend ranges against this run's: from the Container App's ingress rules.
      let rangesChanged = false;
      if (host && ranges && lzState === "ok") {
        if (!caList) {
          fail("the Container Apps could not be listed");
          continue;
        }
        const ingress = ca ? own(obj(own(props(ca), "configuration")), "ingress") : undefined;
        const rules = isObject(ingress) ? own(ingress, "ipSecurityRestrictions") : undefined;
        const current = Array.isArray(rules)
          ? rules.filter((r) => isObject(r) && typeof own(r, "name") === "string" && (own(r, "name") as string).startsWith("afd-backend-") && typeof own(r, "ipAddressRange") === "string").map((r) => own(r as Record<string, unknown>, "ipAddressRange") as string)
          : [];
        rangesChanged = current.length > 0 && !sameSet(current, ranges);
      }
      writeJson(join(out, "facts", `${slug}.json`), {
        resourceGroup: rg,
        tags: tags.get(rg.toLowerCase()) ?? {},
        lzRecord: lzState,
        federation,
        easyAuthInLandingZone: inLz,
        secret,
        frontDoorRecord: !!fd,
        rangesChanged,
        entraDeployment: auth ? names.entraDeployment(slug, args.env) : null,
        // ADR-0056: the group's existence (the list), and whether the Container App is stopped.
        resourceGroupExists: tags.has(rg.toLowerCase()),
        containerAppStopped: stoppedOf(ca, !!caList),
        // ADR-0059: what the app runs here (protected from the registry purge), its registry and the purge role.
        images: imagesOf(ca, !!caList),
        registryName,
        registryPurgeRole,
        // ADR-0060: the mode the app runs in now, its host there, the landing zone's mode and prepare pass,
        // and the secret left in the other variant's vault after a case A move.
        containerAppMode: liveMode,
        containerAppCell: liveCell,
        liveFqdn: liveMode === "externalOnly" || liveMode === "externalHybrid" ? liveFqdnOf(ca) : null,
        lzNetworkMode,
        lzPrepareFrom,
        secretElsewhere,
      });
      status("ok", null);
      result.ok++;
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      fail(e.problems.join(" "), "PE001");
    }
  }
  writeJson(join(out, "lazy.json"), { revisions: result.lazy });
  // What plan.sh turns into warnings and errors on the run (the CLI's own output is neutralised).
  writeJson(join(args.bulk, "plan-facts.json"), { failed: result.failed.map((f) => ({ slug: f.slug, reason: neutralize(f.reason) })), warnings: result.warnings.map(neutralize) });
  return result;
}

export function formatPlanFacts(r: PlanFactsResult): string {
  const lines = r.failed.map((f) => `FAILED  ${f.slug} in ${r.env}: ${f.reason}`);
  lines.push(`Plan of ${r.env}: ${r.apps} app(s), ${r.ok} read, ${r.failed.length} failed${r.lazy.length ? `; revisions to read for ${r.lazy.length}: ${r.lazy.map((l) => l.slug).join(" ")}` : ""}.`);
  return lines.join("\n") + "\n";
}

/** `plan-names`: the environment-wide names plan.sh lists by (names.ts, verified against naming.bicep). */
export function planNames(instance: string, envName: string, apps?: string): Record<string, string | Record<string, string> | { variant: string; mode: string; modes: string[] }[]> {
  if (!ENV_NAME_RE.test(envName)) throw new CheckFailed(["--env must be an environment name."]);
  const inst = loadInstanceFile(instance);
  const env = instanceEnv(inst, envName);
  // ADR-0060: per environment vault variant the environment offers, a mode that names it and every mode
  // that uses it (plan.sh names each vault once with names.bicep and lists its secrets).
  const variants: { variant: string; mode: string; modes: string[] }[] = [];
  for (const m of offeredModes(env)) {
    const v = variants.find((x) => x.variant === m.variant);
    if (v) v.modes.push(m.mode);
    else variants.push({ variant: m.variant, mode: m.mode, modes: [m.mode] });
  }
  const out: Record<string, string | Record<string, string> | { variant: string; mode: string; modes: string[] }[]> = {
    subscriptionId: env.subscriptionId,
    platformResourceGroup: names.platformResourceGroup(inst.naming.prefix, envName),
    entraResourceGroup: names.entraResourceGroup(inst.naming.prefix),
    // ADR-0063: the Entra records group of every environment of the instance (all in the portal host's
    // subscription; plan.sh of portal.hostEnvironment lists each, and rg-{prefix}-entra for the records
    // deployed before ADR-0063).
    entraResourceGroups: Object.fromEntries(inst.environments.map((x) => [x.name, names.entraEnvironmentResourceGroup(inst.naming.prefix, x.name)])),
    vaultVariants: variants,
  };
  // --apps: the app resource group of every valid app of the environment, by naming, so a stage that
  // writes tags never takes a group from an artifact alone (record_<env>, ADR-0052); and its
  // landing-zone record, which record_<env> deletes last for a decommissioned app (ADR-0056).
  if (apps !== undefined) {
    const here = readAppsDoc(apps).apps.filter((a) => a.ok && a.environments?.includes(envName));
    out.appResourceGroups = Object.fromEntries(here.map((a) => [a.slug, names.appResourceGroup(inst.naming.prefix, a.slug, envName)]));
    out.landingZoneRecords = Object.fromEntries(here.map((a) => [a.slug, names.provisioningDeployment(a.slug, envName)]));
    // ADR-0059: the registry purge reads what the Container App runs and lists the app's repository.
    out.containerApps = Object.fromEntries(here.map((a) => [a.slug, names.containerApp(a.slug)]));
    out.registryRepositories = Object.fromEntries(here.map((a) => [a.slug, names.registryRepository(a.slug)]));
  }
  return out;
}

export const PLAN_FACTS_HELP = `  plan-names --instance <instance.yaml> --env <name> [--apps <plan/apps.json>] --output <names.json>
      { subscriptionId, platformResourceGroup, entraResourceGroup } of the environment (naming.bicep's
      names, ported and checked against infra/tests/naming-vectors.json): what plan.sh lists by;
      entraResourceGroups { <env>: rg-{prefix}-entra-{env} }: the Entra records group of every
      environment of the instance (ADR-0063; plan.sh of portal.hostEnvironment lists them and
      entraResourceGroup, the instance's group, for the records deployed before ADR-0063);
      vaultVariants [{ variant, mode, modes }]: the environment vault variants the environment offers,
      a mode that names each and the modes that use it (plan.sh names each vault once, ADR-0060);
      with --apps also appResourceGroups { <slug>: rg-{prefix}-app-{slug}-{env} } of the valid apps
      there (record_<env> writes tags only on these, ADR-0052), landingZoneRecords { <slug>:
      lz-{slug}-{env} } (record_<env> deletes a decommissioned app's last, ADR-0056), containerApps
      { <slug>: ca-{slug} } and registryRepositories { <slug>: <slug> } (the registry purge, ADR-0059)
  plan-facts --instance <instance.yaml> --apps <plan/apps.json> --env <name> --bulk <dir>
             --images <core>/images/images.json [--fd-ranges <backend-ranges.json>] [--now <epoch>]
             [--run-id <id>] --output <plan_<env> artifact dir>
      the read model of a job plan_<env> (ADR-0050): from the lists plan.sh read once for the whole
      environment (resource group tags, landing-zone and custom-domain records, the environment
      vaults' secret attributes, Container Apps, platform jobs, custom domains, and env-vaults.json,
      the vault of each mode named by names.bicep; --bulk) and the
      revisions it read for the apps a previous call listed (revisions/<slug>.json), writes for every
      app of the environment status/<slug>.<env>.json, facts/<slug>.json and its entries lz-outputs/,
      secret/ and frontdoor/, and lazy.json { revisions: [{ slug, id }] }: the apps whose Easy Auth
      restart can't be decided from the lists, or whose rotation is due (exact read needed); a
      revisions/<slug>.failed marker fails that app
`;

export function cmdPlanFacts(v: Record<string, string | undefined>): string {
  const now = v.now !== undefined ? Number(v.now) : undefined;
  if (now !== undefined && (!Number.isSafeInteger(now) || now < EPOCH_MIN || now > EPOCH_MAX)) throw new CheckFailed(["--now must be epoch seconds."]);
  const r = planFacts({
    instance: v.instance!,
    apps: v.apps!,
    env: v.env!,
    bulk: v.bulk!,
    images: v.images!,
    out: v.output!,
    ...(v["fd-ranges"] !== undefined ? { fdRanges: v["fd-ranges"] } : {}),
    ...(now !== undefined ? { now } : {}),
    ...(v["run-id"] !== undefined ? { runId: v["run-id"] } : {}),
  });
  return formatPlanFacts(r);
}
