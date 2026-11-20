import { existsSync, lstatSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cellOf } from "../capacity.js";
import { CheckFailed, DIGEST_RE, KiB, MiB, REF_RE, exactKeys, isObject, own, parseEnvironmentsParam, parseJsonText, readJson, slugProblem } from "../pipeline/common.js";
import { promotionProblems } from "../pipeline/instance.js";
import type { AppData } from "../validate-app.js";
import { readBackendRanges } from "./frontdoor-ranges.js";
import { provisioningEnvironments, provisioningHostEnvironment } from "./generate.js";
import { budgetAmount, parseState } from "./inputs.js";
import type { Runtime, State } from "./inputs.js";
import { environmentVaultInputs, environmentVaultVariant, instanceEnv, loadAppFile, loadInstanceFile, orderedEnvironments, platformConfigDefaultBranch } from "./model.js";
import type { InstanceEnv } from "./model.js";
import { parseUpgradeParam, readUnitManifest } from "./units.js";
import type { UpgradeParam } from "./units.js";
import { readUpgradeNotes } from "./upgrades.js";

/**
 * The provisioning pipeline's helpers (ADR-0032), all pure: files in, files out, no Azure calls.
 *
 *   validate-run  the run's `environments`, `hostEnvironment` and `upgrade` parameters, core ref and
 *                 source branch against instance.yaml and apps/, core's unit manifest
 *                 infra/app/units.json (ADR-0048) and its upgrade notes infra/app/upgrades.yaml
 *                 (ADR-0049)
 *   apps          every apps/{slug}/app.yaml validated, one entry per app (invalid apps fail alone)
 *   state         state.json for `provisioning inputs`, from the deployment records
 *   compare       is a deployment up to date? (record vs `az deployment ... validate`, D6)
 */

// ------------------------------------------------------------------------------------------
// validate-run
// ------------------------------------------------------------------------------------------

export interface ProvisioningRun {
  environments: { name: string; kind: "prod" | "nonprod"; promoteFrom: string }[];
  hostEnvironment: string;
  coreRef: string;
  sourceBranch: string;
  /** The parameter `upgrade` (ADR-0049 section 4); none when not checked. */
  upgrade: UpgradeParam;
}

/**
 * The run's parameters against instance.yaml, and where it runs from: only platform-config's
 * default branch (refs/heads/<scm.azureDevOps.platformConfigDefaultBranch>) provisions, so whoever
 * may queue the pipeline (the portal's "Check all apps", ADR-0046) can't provision an unreviewed
 * branch. Branch control on the platform service connections refuses other branches too; this
 * stops the run before any stage that has credentials.
 */
export function validateProvisioningRun(args: {
  instance: string;
  environmentsJson: string;
  hostEnvironment: string;
  coreRef: string;
  sourceBranch: string;
  units?: string;
  /** core's infra/app/upgrades.yaml (ADR-0049): valid, released, nothing after coreVersion. */
  upgrades?: string;
  /** The parameter `upgrade`, checked with appsDir: every slug has apps/<slug>/app.yaml. */
  upgrade?: string;
  appsDir?: string;
}): ProvisioningRun {
  const inst = loadInstanceFile(args.instance);
  const problems: string[] = [];
  if (args.environmentsJson.length > 64 * KiB) throw new CheckFailed(["--environments-json is larger than 64 KiB."]);
  let envs: ProvisioningRun["environments"] = [];
  try {
    envs = parseEnvironmentsParam(parseJsonText(args.environmentsJson, "--environments-json"), "parameters.environments");
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    problems.push(...e.problems);
  }
  if (!problems.length) problems.push(...promotionProblems(envs));
  const want = provisioningEnvironments(inst);
  const show = (l: ProvisioningRun["environments"]): string => l.map((e) => `${e.name}/${e.kind}/${e.promoteFrom || "-"}`).join(", ");
  if (!problems.length && JSON.stringify(envs) !== JSON.stringify(want)) {
    problems.push(`parameters.environments is [${show(envs)}], but instance.yaml gives [${show(want)}] (name/kind/promoteFrom, in order): run "platform generate" and commit pipelines/provisioning.yml.`);
  }
  try {
    const host = provisioningHostEnvironment(inst);
    if (args.hostEnvironment !== host) {
      problems.push(`parameters.hostEnvironment is "${args.hostEnvironment.slice(0, 40)}", but instance.yaml portal.hostEnvironment is "${host}": run "platform generate" and commit pipelines/provisioning.yml.`);
    }
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    problems.push(...e.problems);
  }
  const expected = `refs/tags/${inst.coreVersion}`;
  if (!REF_RE.test(args.coreRef)) problems.push("--core-ref must be a git ref (refs/...).");
  else if (args.coreRef !== expected) problems.push(`the core repository resolved to "${args.coreRef}", but instance.yaml pins coreVersion ${inst.coreVersion} (expected ${expected}).`);
  const branch = `refs/heads/${platformConfigDefaultBranch(inst)}`;
  if (args.sourceBranch !== branch) {
    problems.push(`this run is on "${args.sourceBranch.slice(0, 80)}", but provisioning runs only on platform-config's default branch ${branch} (scm.azureDevOps.platformConfigDefaultBranch).`);
  }
  // The unit manifest of this core (ADR-0048): present, well formed, released (no `unreleased`).
  if (args.units !== undefined) {
    try {
      readUnitManifest(args.units, inst.coreVersion);
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      problems.push(...e.problems);
    }
  }
  // The upgrade notes of this core (ADR-0049): valid, released (no `unreleased`).
  if (args.upgrades !== undefined) {
    try {
      readUpgradeNotes(args.upgrades, { release: true, coreVersion: inst.coreVersion });
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      problems.push(...e.problems);
    }
  }
  // The parameter upgrade (ADR-0049 section 4): it only widens the run, but a typo must not pass
  // silently, so another shape or a slug without an app definition fails the run.
  let upgrade: UpgradeParam = { all: false, apps: [] };
  if (args.upgrade !== undefined) {
    try {
      upgrade = parseUpgradeParam(args.upgrade);
      if (args.appsDir === undefined) throw new CheckFailed(["--upgrade needs --apps-dir."]);
      for (const slug of upgrade.apps) {
        if (!lstatExists(join(args.appsDir, slug, "app.yaml")) || !lstatSync(join(args.appsDir, slug, "app.yaml")).isFile()) {
          problems.push(`parameter upgrade names ${slug}, which has no app definition (apps/${slug}/app.yaml).`);
        }
      }
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      problems.push(...e.problems);
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  return { environments: envs, hostEnvironment: args.hostEnvironment, coreRef: args.coreRef, sourceBranch: args.sourceBranch, upgrade };
}

export function formatProvisioningRun(r: ProvisioningRun): string {
  const up = r.upgrade.all ? "all apps" : r.upgrade.apps.length ? r.upgrade.apps.join(", ") : "none";
  return `OK  provisioning: environments ${r.environments.map((e) => `${e.name}/${e.kind}${e.promoteFrom ? ` (from ${e.promoteFrom})` : ""}`).join(", ")}, host ${r.hostEnvironment}, core ${r.coreRef}, branch ${r.sourceBranch}, upgrade ${up}\n`;
}

// ------------------------------------------------------------------------------------------
// apps
// ------------------------------------------------------------------------------------------

export type AppEntry =
  | {
      slug: string;
      file: string;
      ok: true;
      environments: string[];
      authMode: "required" | "anonymous";
      /** environments.<env>.frontDoor.hostName per environment, managed Front Door mode only (ADR-0010, amended 2026-11-01 and 2026-11-11). */
      frontDoorHosts: Record<string, string>;
      /** environments.<env>.networkMode per environment: names the kvset and dbinit jobs of the app's CAE (ADR-0052). */
      networkModes: Record<string, string>;
      /** environments.<env>.cell per environment (default 01, ADR-0053): with the mode, the app's CAE and its jobs. */
      cells: Record<string, string>;
      /** app.yaml incarnation (ADR-0061, default 0): prov_names hands it to names.bicep for the Entra uniqueName. */
      incarnation: number;
      /**
       * app.yaml decommission (ADR-0056), when the app is being decommissioned or is deleted: it stays
       * listed, and the plan finds out from Azure that nothing is left (phase deleted: nothing runs).
       */
      decommission?: { requestedOn: string; deleteAfter: string; immediate?: true };
      /**
       * ADR-0061 section 4: platform-config has an archived definition of this slug (apps-deleted/{slug}/),
       * so this app is a new incarnation of a deleted app's slug; with its generation (app.yaml, default 0)
       * the plan refuses it while a landing-zone record of a lower generation (the old app's) is left.
       * Both only for such an app.
       */
      reusesSlug?: true;
      generation?: number;
    }
  | { slug: string; file: string; ok: false; problems: string[] };

/**
 * Every apps/{slug}/app.yaml, validated like `platform validate app --instance` (no --base). An
 * invalid app is an entry with ok false and its problems; only an invalid instance or a directory
 * whose name cannot be a slug (no status file can be named after it) fails the whole command.
 * Directories without app.yaml are skipped (as `platform generate` does). The archive of deleted
 * apps (apps-deleted/, ADR-0061) is outside appsDir and never listed. A decommissioned app is
 * listed whatever its phase, deleted included (ADR-0056 amendment 2026-11-12: the plan decides from
 * what it reads in Azure, never from the date alone), so the listing doesn't depend on today's date.
 */
export function listApps(args: { instance: string; appsDir: string; scope: string; upgrade?: string }): { apps: AppEntry[]; checkAllApps: boolean; upgrade: UpgradeParam } {
  if (args.scope !== "changed" && args.scope !== "all") throw new CheckFailed(["--scope must be changed or all."]);
  // The parameter upgrade (ADR-0049) reaches the plan through apps.json; validate-run checked it.
  const upgrade = parseUpgradeParam(args.upgrade ?? "none");
  const inst = loadInstanceFile(args.instance);
  const checkAllApps = args.scope === "all";
  if (!existsSync(args.appsDir)) return { apps: [], checkAllApps, upgrade };
  if (!lstatSync(args.appsDir).isDirectory()) throw new CheckFailed([`${args.appsDir} is not a directory.`]);
  const problems: string[] = [];
  const apps: AppEntry[] = [];
  for (const d of readdirSync(args.appsDir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    if (!d.isDirectory() && !d.isSymbolicLink()) continue;
    const file = join(args.appsDir, d.name, "app.yaml");
    const sp = slugProblem(d.name, `apps/${d.name.slice(0, 60)}`);
    if (d.isSymbolicLink()) {
      if (sp) problems.push(`apps/${d.name.slice(0, 60)} is a symbolic link, which is not allowed.`);
      else apps.push({ slug: d.name, file, ok: false, problems: [`apps/${d.name} is a symbolic link, which is not allowed.`] });
      continue;
    }
    if (!lstatExists(file)) continue;
    if (sp) {
      problems.push(`${sp} (the directory name is the app's slug).`);
      continue;
    }
    if (lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) {
      apps.push({ slug: d.name, file, ok: false, problems: [`apps/${d.name}/app.yaml is a symbolic link or not a file, which is not allowed.`] });
      continue;
    }
    try {
      const app = loadAppFile(file, args.instance);
      const envs = orderedEnvironments(app, inst).map((e) => e.name);
      // Hosts through the instance's managed Front Door only: in external mode provisioning deploys
      // nothing in Front Door (the release and the Entra inputs read app.yaml themselves).
      const frontDoorHosts: Record<string, string> = {};
      for (const e of envs) {
        const host = app.environments[e]?.frontDoor?.hostName;
        if (host && (inst.frontDoor?.mode ?? "managed") === "managed") frontDoorHosts[e] = host.toLowerCase();
      }
      const networkModes: Record<string, string> = Object.fromEntries(envs.map((e) => [e, app.environments[e]?.networkMode ?? ""]));
      const cells: Record<string, string> = Object.fromEntries(envs.map((e) => [e, cellOf(app.environments[e])]));
      const dc = app.decommission ? { decommission: { requestedOn: app.decommission.requestedOn, deleteAfter: app.decommission.deleteAfter, ...(app.decommission.immediate === true ? { immediate: true as const } : {}) } } : {};
      // ADR-0061: the archive is read for the guard of a reused slug only; it is never provisioned.
      const reused = hasDeletedArchive(args.appsDir, d.name) ? { reusesSlug: true as const, generation: app.generation ?? 0 } : {};
      apps.push({ slug: d.name, file, ok: true, environments: envs, authMode: app.authentication.mode, frontDoorHosts, networkModes, cells, incarnation: app.incarnation ?? 0, ...dc, ...reused });
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      apps.push({ slug: d.name, file, ok: false, problems: e.problems.map((p) => p.split(file).join(`apps/${d.name}/app.yaml`)) });
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  return { apps, checkAllApps, upgrade };
}

/**
 * ADR-0061 section 3: platform-config keeps a deleted app's definition in
 * apps-deleted/{slug}/{requestedOn}/app.yaml (next to the apps directory) once a new app took its slug.
 * True when at least one such archived definition exists; its content isn't read here. Only the guard
 * of a reused slug asks (plan-facts); the archive is never provisioned.
 */
export function hasDeletedArchive(appsDir: string, slug: string): boolean {
  const dir = join(dirname(resolve(appsDir)), "apps-deleted", slug);
  try {
    if (!lstatSync(dir).isDirectory()) return false;
    return readdirSync(dir, { withFileTypes: true }).some((d) => d.isDirectory() && lstatExists(join(dir, d.name, "app.yaml")));
  } catch {
    return false;
  }
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function formatApps(r: { apps: AppEntry[]; checkAllApps?: boolean; upgrade?: UpgradeParam }): string {
  const lines = r.apps.map((a) =>
    a.ok
      ? `ok       ${a.slug}  (${a.environments.join(", ")}; sign-in ${a.authMode}${a.decommission ? (a.decommission.immediate ? "; decommissioned, deleted immediately (no production)" : `; decommissioned, deleted on or after ${a.decommission.deleteAfter}`) : ""}${a.reusesSlug ? `; reuses a deleted app's slug, generation ${a.generation ?? 0}, incarnation ${a.incarnation}` : ""})`
      : `INVALID  ${a.slug}  (${a.problems.length} problem${a.problems.length === 1 ? "" : "s"}: ${a.problems[0] ?? ""})`,
  );
  const bad = r.apps.filter((a) => !a.ok).length;
  const up = r.upgrade?.all ? " This run upgrades every app." : r.upgrade?.apps.length ? ` This run upgrades ${r.upgrade.apps.join(", ")}.` : "";
  lines.push(`${r.apps.length} app${r.apps.length === 1 ? "" : "s"}, ${bad} invalid.${r.checkAllApps ? " This run checks every app." : ""}${up}`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------------
// Deployment records
// ------------------------------------------------------------------------------------------

/** A record as `az deployment sub|group show -o json` writes it (or validate). */
export interface DeploymentRecord {
  name: string | undefined;
  provisioningState: string | undefined;
  templateHash: string | undefined;
  parameters: Record<string, unknown>;
  outputs: Record<string, unknown>;
}

export function parseRecord(v: unknown, label: string): DeploymentRecord {
  if (!isObject(v)) throw new CheckFailed([`${label} must be the JSON of az deployment ... show (an object).`]);
  const props = own(v, "properties");
  if (!isObject(props)) throw new CheckFailed([`${label} has no properties object.`]);
  const params = own(props, "parameters");
  const outputs = own(props, "outputs");
  if (params !== undefined && params !== null && !isObject(params)) throw new CheckFailed([`${label} properties.parameters must be an object.`]);
  if (outputs !== undefined && outputs !== null && !isObject(outputs)) throw new CheckFailed([`${label} properties.outputs must be an object.`]);
  const str = (x: unknown): string | undefined => (typeof x === "string" ? x : undefined);
  return {
    name: str(own(v, "name")),
    provisioningState: str(own(props, "provisioningState")),
    templateHash: str(own(props, "templateHash")),
    parameters: isObject(params) ? params : {},
    outputs: isObject(outputs) ? outputs : {},
  };
}

/** The value of an ARM parameter or output entry ({type, value}); an entry without value is null. */
export function armValue(entries: Record<string, unknown>, name: string): unknown {
  const e = own(entries, name);
  if (!isObject(e)) return undefined;
  return Object.hasOwn(e, "value") ? e.value : null;
}

export function readRecord(path: string | undefined, label: string, expectedName: string): DeploymentRecord | undefined {
  if (path === undefined) return undefined;
  const r = parseRecord(readJson(path, 16 * MiB, label), label);
  if (r.name !== undefined && r.name !== expectedName) throw new CheckFailed([`${label} is the record of deployment "${r.name}", expected ${expectedName}.`]);
  return r;
}

// ------------------------------------------------------------------------------------------
// state
// ------------------------------------------------------------------------------------------

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The placeholder image and its runtime from images/images.json of the core checkout (ADR-0030). */
export function placeholderImage(coreDir: string): { repository: string; digest: string; runtime: Omit<Runtime, "size" | "minReplicas" | "maxReplicas"> } {
  const label = "images/images.json";
  const doc = readJson(join(coreDir, "images", "images.json"), 256 * KiB, label, { noFollow: true });
  const img = isObject(doc) && isObject(own(doc, "images")) ? own(own(doc, "images") as Record<string, unknown>, "saf-placeholder") : undefined;
  if (!isObject(doc) || own(doc, "formatVersion") !== 1 || !isObject(img)) throw new CheckFailed([`${label} has no formatVersion 1 entry images.saf-placeholder.`]);
  const repository = own(img, "repository");
  const digest = own(img, "digest");
  const rt = own(img, "runtime");
  const problems: string[] = [];
  if (typeof repository !== "string" || !/^[a-z0-9]+([._/-][a-z0-9]+)*$/.test(repository)) problems.push(`${label} saf-placeholder.repository must be a repository name.`);
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) problems.push(`${label} saf-placeholder.digest must be sha256:<64 hex>.`);
  if (!isObject(rt)) problems.push(`${label} saf-placeholder.runtime must be an object.`);
  else {
    problems.push(...exactKeys(rt, ["port", "livenessPath", "readinessPath"], `${label} saf-placeholder.runtime`));
    if (!Number.isSafeInteger(own(rt, "port"))) problems.push(`${label} saf-placeholder.runtime.port must be an integer.`);
    for (const k of ["livenessPath", "readinessPath"]) if (typeof own(rt, k) !== "string" || !(own(rt, k) as string).startsWith("/")) problems.push(`${label} saf-placeholder.runtime.${k} must be a path.`);
  }
  if (problems.length) throw new CheckFailed(problems);
  const r = rt as Record<string, unknown>;
  return { repository: repository as string, digest: digest as string, runtime: { port: r.port as number, livenessPath: r.livenessPath as string, readinessPath: r.readinessPath as string } };
}

/** issuer/subject of this environment's service connection from `platform ado apply --output`, if known. */
function adoFromOutputs(path: string | undefined, slug: string, env: string): { issuer: string; subject: string } | undefined {
  if (path === undefined) return undefined;
  const label = "--ado-outputs";
  const doc = readJson(path, 1 * MiB, label);
  if (!isObject(doc) || !isObject(own(doc, "environments"))) throw new CheckFailed([`${label} must be the output of platform ado apply (with environments).`]);
  if (own(doc, "slug") !== slug) throw new CheckFailed([`${label} is for app "${String(own(doc, "slug")).slice(0, 40)}", not ${slug}.`]);
  const e = own(own(doc, "environments") as Record<string, unknown>, env);
  const sc = isObject(e) ? own(e, "serviceConnection") : undefined;
  if (!isObject(sc)) return undefined;
  const issuer = own(sc, "issuer");
  const subject = own(sc, "subject");
  return typeof issuer === "string" && issuer && typeof subject === "string" && subject ? { issuer, subject } : undefined;
}

export interface StateArgs {
  instance: string;
  app: string;
  env: string;
  coreDir: string;
  lzRecord?: string;
  releaseRecord?: string;
  /** The record of fd-{slug}-{env} (the app's custom domain through Front Door, ADR-0010). */
  fdRecord?: string;
  /** The output of `platform provisioning fd-ranges`: the stage's AzureFrontDoor.Backend IPv4 prefixes. */
  fdRanges?: string;
  /** The custom domain's state: `az resource show --ids <customDomainId> --query '{domainValidationState: …, deploymentStatus: …}'`. */
  fdDomain?: string;
  entraOutputs?: string;
  adoOutputs?: string;
  /** Whether the Easy Auth secret exists in the environment vault (the pipeline checks it with ARM). */
  easyAuthSecret?: string;
  today: string;
}

/** `{clientId}` of an Entra registration, written by the entra_plan or entra stage (ADR-0033). */
function entraFromOutputs(path: string | undefined): { clientId: string } | undefined {
  if (path === undefined) return undefined;
  const label = "--entra-outputs";
  const doc = readJson(path, 64 * KiB, label);
  if (!isObject(doc)) throw new CheckFailed([`${label} must be a JSON object { clientId }.`]);
  const problems = exactKeys(doc, ["clientId"], label);
  if (typeof own(doc, "clientId") !== "string" || !GUID_RE.test(own(doc, "clientId") as string)) problems.push(`${label} clientId must be a GUID.`);
  if (problems.length) throw new CheckFailed(problems);
  return { clientId: own(doc, "clientId") as string };
}

/**
 * Front Door serves the custom domain (ADR-0010, amended 2026-11-11): its customDomains resource
 * has domainValidationState Approved and deploymentStatus Succeeded (FD-2: the edge served the
 * profile's default certificate until deploymentStatus was Succeeded). Anything else, an unknown
 * value included, is not serving.
 */
export function domainServing(path: string): boolean {
  const label = "--fd-domain";
  const doc = readJson(path, 64 * KiB, label);
  if (!isObject(doc)) throw new CheckFailed([`${label} must be a JSON object { domainValidationState, deploymentStatus }.`]);
  const problems = exactKeys(doc, ["domainValidationState", "deploymentStatus"], label);
  for (const k of ["domainValidationState", "deploymentStatus"]) {
    const v = own(doc, k);
    if (v !== null && (typeof v !== "string" || !/^[A-Za-z]{1,40}$/.test(v))) problems.push(`${label} ${k} must be null or a word.`);
  }
  if (problems.length) throw new CheckFailed(problems);
  return own(doc, "domainValidationState") === "Approved" && own(doc, "deploymentStatus") === "Succeeded";
}

/**
 * Whether the lz record's landing zone used another environment vault than the app's mode in app.yaml
 * does now (ADR-0060): another variant (a network mode change between the managed network and a
 * VNet-based mode) or another vaultGeneration. Its easyAuthSecretExists then speaks of the other vault,
 * so it doesn't carry. A record without these parameters (or with values this core doesn't know)
 * counts as the same vault, as before.
 */
function otherEnvironmentVault(lz: DeploymentRecord | undefined, app: AppData, env: InstanceEnv): boolean {
  if (!lz) return false;
  const was = environmentVaultVariant(armValue(lz.parameters, "networkMode"), armValue(lz.parameters, "externalOnlyNetwork"));
  const generation = armValue(lz.parameters, "vaultGeneration");
  if (was === undefined || typeof generation !== "number") return false;
  const now = environmentVaultInputs(env);
  return was !== environmentVaultVariant(app.environments[env.name]?.networkMode, now.externalOnlyNetwork) || generation !== now.vaultGeneration;
}

/**
 * state.json for `platform provisioning inputs`, derived from the deployment records (each the raw
 * `az deployment ... show -o json`; no file = no record):
 *   landingZone          lz outputs runtimeIdentityClientId, database, storageBlobEndpoint
 *   containerAppFqdn     lz output containerAppFqdn (left out when the record predates it)
 *   ado                  --ado-outputs entry ?? lz parameter deliveryFederation ?? null
 *   easyAuthSecretExists lz parameter, or --easy-auth-secret present (false otherwise); the lz
 *                        parameter only while the record's environment vault is the one of the app's
 *                        mode now (same variant and vaultGeneration; ADR-0060)
 *   entra                --entra-outputs clientId ?? release parameter authentication.clientId ?? null
 *   budgetStartDate      lz parameter budget.startDate ?? first day of --today's month; null without a budget
 *   releaseRecord        release properties.parameters, or null
 *   bootstrap            {<lz output registryLoginServer>/<placeholder>@<digest>, images.json runtime, xs, 0..1}
 *   frontDoor            fd record, Succeeded: {parameter hostName, output frontDoorId, parameter
 *                        retainedHostName when not empty}; null otherwise
 *                        (no record, not Succeeded, or a record from before the frontDoorId output);
 *                        with --fd-domain also serving (the custom domain Approved and Succeeded)
 *   frontDoorBackendIpRanges  --fd-ranges ranges (checked again); left out without the flag
 * Keys without a source are left out, so the step that needs them fails instead of defaulting.
 */
export function buildState(args: StateArgs): State {
  if (!/^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(args.today)) throw new CheckFailed(["--today must be a date YYYY-MM-DD."]);
  const inst = loadInstanceFile(args.instance);
  const app: AppData = loadAppFile(args.app, args.instance);
  const env = instanceEnv(inst, args.env);
  if (!Object.hasOwn(app.environments, env.name)) throw new CheckFailed([`app ${app.slug} does not run in environment ${env.name}.`]);
  const lz = readRecord(args.lzRecord, "--lz-record", `lz-${app.slug}-${env.name}`);
  const release = readRecord(args.releaseRecord, "--release-record", `release-${app.slug}`);
  const fd = readRecord(args.fdRecord, "--fd-record", `fd-${app.slug}-${env.name}`);
  const entra = entraFromOutputs(args.entraOutputs);
  const problems: string[] = [];
  if (args.easyAuthSecret !== undefined && args.easyAuthSecret !== "present" && args.easyAuthSecret !== "absent") problems.push("--easy-auth-secret must be present or absent.");
  const state: State = {};

  if (lz) {
    const clientId = armValue(lz.outputs, "runtimeIdentityClientId");
    if (typeof clientId === "string") {
      const db = armValue(lz.outputs, "database");
      const blob = armValue(lz.outputs, "storageBlobEndpoint");
      state.landingZone = { runtimeIdentityClientId: clientId, database: isObject(db) ? (db as { host: string; name: string; user?: string | null }) : null, storageBlobEndpoint: typeof blob === "string" ? blob : null };
    }
    const fqdn = armValue(lz.outputs, "containerAppFqdn");
    if (typeof fqdn === "string") state.containerAppFqdn = fqdn;
  }

  const fed = lz ? armValue(lz.parameters, "deliveryFederation") : undefined;
  state.ado = adoFromOutputs(args.adoOutputs, app.slug, env.name) ?? (isObject(fed) ? { issuer: own(fed, "issuer") as string, subject: own(fed, "subject") as string } : null);

  const secret = lz ? armValue(lz.parameters, "easyAuthSecretExists") : undefined;
  if (secret !== undefined && secret !== null && typeof secret !== "boolean") problems.push("--lz-record parameter easyAuthSecretExists is not a boolean.");
  state.easyAuthSecretExists = (secret === true && !otherEnvironmentVault(lz, app, env)) || args.easyAuthSecret === "present";

  const auth = release ? armValue(release.parameters, "authentication") : undefined;
  const releaseId = isObject(auth) ? own(auth, "clientId") : undefined;
  state.entra = entra ?? (typeof releaseId === "string" && GUID_RE.test(releaseId) ? { clientId: releaseId } : null);

  if (budgetAmount(app, inst, env.name) === undefined) state.budgetStartDate = null;
  else {
    const budget = lz ? armValue(lz.parameters, "budget") : undefined;
    const start = isObject(budget) ? own(budget, "startDate") : undefined;
    state.budgetStartDate = typeof start === "string" ? start.slice(0, 10) : `${args.today.slice(0, 7)}-01`;
  }

  state.releaseRecord = release ? release.parameters : null;

  if (args.fdRecord !== undefined) {
    const host = fd ? armValue(fd.parameters, "hostName") : undefined;
    const id = fd ? armValue(fd.outputs, "frontDoorId") : undefined;
    state.frontDoor =
      fd?.provisioningState === "Succeeded" && typeof host === "string" && typeof id === "string" && GUID_RE.test(id)
        ? { hostName: host.toLowerCase(), frontDoorId: id.toLowerCase() }
        : null;
    // A host change (ADR-0010, amended 2026-11-11): the previous host the route still serves.
    const retained = fd ? armValue(fd.parameters, "retainedHostName") : undefined;
    if (state.frontDoor && typeof retained === "string" && retained) state.frontDoor.retainedHostName = retained.toLowerCase();
    if (state.frontDoor && args.fdDomain !== undefined) state.frontDoor.serving = domainServing(args.fdDomain);
  } else if (args.fdDomain !== undefined) problems.push("--fd-domain needs --fd-record.");

  if (args.fdRanges !== undefined) state.frontDoorBackendIpRanges = readBackendRanges(args.fdRanges);

  if (lz) {
    const server = armValue(lz.outputs, "registryLoginServer");
    if (typeof server === "string") {
      const img = placeholderImage(args.coreDir);
      state.bootstrap = { image: `${server}/${img.repository}@${img.digest}`, runtime: { port: img.runtime.port, size: "xs", minReplicas: 0, maxReplicas: 1, livenessPath: img.runtime.livenessPath, readinessPath: img.runtime.readinessPath } };
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  // The same validation `provisioning inputs` applies: a record with an unexpected shape fails here.
  return parseState(state);
}

export function formatState(s: State, slug: string, env: string): string {
  const has = (k: keyof State): string => (s[k] === undefined ? "-" : s[k] === null ? "null" : "yes");
  return `OK  state for ${slug} in ${env}: landingZone ${has("landingZone")}, containerAppFqdn ${has("containerAppFqdn")}, ado ${has("ado")}, easyAuthSecretExists ${String(s.easyAuthSecretExists)}, entra ${has("entra")}, budgetStartDate ${s.budgetStartDate ?? "null"}, releaseRecord ${has("releaseRecord")}, bootstrap ${has("bootstrap")}${s.frontDoor === undefined ? "" : `, frontDoor ${has("frontDoor")}`}${s.frontDoorBackendIpRanges === undefined ? "" : `, frontDoorBackendIpRanges ${s.frontDoorBackendIpRanges.length}`}\n`;
}

// ------------------------------------------------------------------------------------------
// compare
// ------------------------------------------------------------------------------------------

/**
 * Release parameters that delivery sets differently from provisioning (D6), and coreVersion (the
 * tag saf-core, ADR-0049): a release whose template and settings are unchanged is not redeployed
 * only because the instance moved to another core version.
 */
export const RELEASE_IGNORED = ["deployedBy", "alertsEnabled", "coreVersion"];

/** Deep equality of JSON values (object key order ignored, array order kept). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

export type Comparison = { result: "new" } | { result: "up-to-date" } | { result: "changed"; reasons: string[] };

/**
 * D6: a deployment is up to date when its last record Succeeded, has the templateHash that
 * `az deployment ... validate` of the rendered inputs returns, and the same parameters (an entry
 * without value equals value null). For the release, deployedBy and alertsEnabled are ignored.
 */
/** `environment`: the platform pipeline's record platform-{prefix}-{env} (ADR-0043). */
export const COMPARE_KINDS = ["lz", "release", "entra", "frontdoor", "portal-endpoint", "environment"] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];

export function compareDeployment(kind: CompareKind, validate: DeploymentRecord, record: DeploymentRecord | undefined): Comparison {
  if (!validate.templateHash) throw new CheckFailed(["--validate has no properties.templateHash (is it the output of az deployment ... validate?)."]);
  if (Object.keys(validate.parameters).length === 0) throw new CheckFailed(["--validate has no properties.parameters."]);
  if (!record) return { result: "new" };
  const reasons: string[] = [];
  if (record.provisioningState !== "Succeeded") reasons.push(`provisioningState ${record.provisioningState ?? "missing"}`);
  if (record.templateHash !== validate.templateHash) reasons.push("templateHash");
  const ignored = kind === "release" ? RELEASE_IGNORED : [];
  const names = [...new Set([...Object.keys(validate.parameters), ...Object.keys(record.parameters)])].filter((n) => !ignored.includes(n)).sort();
  const differ = names.filter((n) => {
    const a = armValue(validate.parameters, n);
    const b = armValue(record.parameters, n);
    if (a === undefined || b === undefined) return true;
    return !jsonEqual(a, b);
  });
  if (differ.length) reasons.push(`parameters ${differ.slice(0, 5).join(", ")}${differ.length > 5 ? ` (+${differ.length - 5} more)` : ""}`);
  return reasons.length ? { result: "changed", reasons } : { result: "up-to-date" };
}

export function compareFiles(args: { kind: string; validate: string; record?: string }): Comparison {
  if (!(COMPARE_KINDS as readonly string[]).includes(args.kind)) throw new CheckFailed([`--kind must be ${COMPARE_KINDS.slice(0, -1).join(", ")} or ${COMPARE_KINDS.at(-1)!}.`]);
  const validate = parseRecord(readJson(args.validate, 16 * MiB, "--validate"), "--validate");
  const record = args.record === undefined ? undefined : parseRecord(readJson(args.record, 16 * MiB, "--record"), "--record");
  return compareDeployment(args.kind as CompareKind, validate, record);
}

export function formatComparison(c: Comparison): string {
  return c.result === "changed" ? `changed: ${c.reasons.join("; ")}\n` : `${c.result}\n`;
}
