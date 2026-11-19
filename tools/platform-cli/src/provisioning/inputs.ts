import { CheckFailed, DIGEST_RE, MiB, exactKeys, isObject, own, readJson } from "../pipeline/common.js";
import { cellOf } from "../capacity.js";
import { billingCurrencyOf, budgetInBillingCurrency, fxRateOf, instanceCurrencyOf } from "../fx.js";
import { zoneOfHost } from "../validate-app.js";
import { otherAppsHosts, previousFrontDoor, retainedHost } from "./frontdoor-plan.js";
import { backendRangesProblems } from "./frontdoor-ranges.js";
import type { AppData } from "../validate-app.js";
import { environmentVaultInputs, instanceDefault, instanceEnv, loadAppFile, loadInstanceFile } from "./model.js";
import type { DbSize, Instance, InstanceEnv } from "./model.js";

/**
 * `platform provisioning inputs --step lz|entra|release|frontdoor|portal-endpoint ...`: the JSON
 * that the core-owned parameter files read (infra/app/provisioning/landing-zone.bicepparam via
 * SAF_LZ_JSON, infra/entra/provisioning/app-registration.bicepparam via SAF_ENTRA_JSON,
 * infra/app/provisioning/release.bicepparam via SAF_RELEASE_JSON,
 * infra/app/provisioning/frontdoor.bicepparam via SAF_FRONTDOOR_JSON,
 * infra/app/provisioning/portal-endpoint.bicepparam via SAF_PORTAL_ENDPOINT_JSON). Inputs:
 * instance.yaml and apps/{slug}/app.yaml (validated like `platform validate app --instance`), plus
 * state.json for the values that exist only at run time (see STATE below; the frontdoor and
 * portal-endpoint steps need none). Every output key is always present; a missing runtime value
 * fails instead of falling back to a default that could reset deployed state (federation, Easy Auth
 * flag, budget start date).
 */

export type Step = "lz" | "entra" | "release" | "frontdoor" | "portal-endpoint";
export const STEPS: readonly Step[] = ["lz", "entra", "release", "frontdoor", "portal-endpoint"];
/** Steps that read instance.yaml and app.yaml only (no state.json). */
const STATELESS: readonly string[] = ["frontdoor", "portal-endpoint"];
export type ReleaseMode = "bootstrap" | "reapply";

/** state.json: runtime-only values, collected by the provisioning pipeline. */
export interface State {
  /** Landing-zone outputs for release.bicep `landingZone` (lz-{slug}-{env} deployment). */
  landingZone?: { runtimeIdentityClientId: string; database?: { host: string; name: string; user?: string | null } | null; storageBlobEndpoint?: string | null };
  /** Default FQDN of the Container App (ca-{slug}.<CAE default domain>), the Entra redirect host. */
  containerAppFqdn?: string;
  /** Issuer and subject of the app's ADO service connection; null before it exists. */
  ado?: { issuer: string; subject: string } | null;
  /** easyauth-{slug} exists in the environment vault (carried from the last lz record). */
  easyAuthSecretExists?: boolean;
  /** Entra registration outputs; null when the app has none yet. */
  entra?: { clientId: string } | null;
  /** startDate of the existing budget (ADR-0017), or the first day of the current month for a new one. */
  budgetStartDate?: string | null;
  /** `az deployment group show -n release-{slug} --query properties.parameters`; null = no release yet. */
  releaseRecord?: Record<string, unknown> | null;
  /** Bootstrap image and runtime (until the platform placeholder image exists, P2). */
  bootstrap?: { image: string; runtime: Runtime } | null;
  /**
   * The app's custom domain through Front Door as deployed (record fd-{slug}-{env}, Succeeded):
   * its host and the environment profile's Front Door ID (the template's outputs). null = none.
   * serving: Front Door serves the custom domain (its customDomains resource: domainValidationState
   * Approved and deploymentStatus Succeeded); absent = not read, which counts as not serving.
   * retainedHostName: during a host change, the previous host the route still serves until the new
   * one is served (the record's parameter, ADR-0010 amended 2026-11-11).
   */
  frontDoor?: { hostName: string; frontDoorId: string; serving?: boolean; retainedHostName?: string } | null;
  /**
   * The IPv4 prefixes of the AzureFrontDoor.Backend service tag, resolved once per stage azure_<env>
   * (`platform provisioning fd-ranges`, ADR-0010 amended 2026-11-11): the ingress lock-down of an
   * app behind the managed Front Door. Absent = not resolved; never an empty list.
   */
  frontDoorBackendIpRanges?: string[];
  /**
   * ADR-0060: during a network mode change, the live app's default host in the source CAE (the plan's
   * modeChange.fromHost): the registration keeps it as a second redirect host until the move, so sign-in
   * on the old host works while the app still runs there (a move that waits). Only the Entra plan sets it.
   */
  previousContainerAppFqdn?: string;
}

export interface Runtime {
  port: number;
  size: string;
  minReplicas: number;
  maxReplicas: number;
  livenessPath: string;
  readinessPath: string;
}

export const STATE_KEYS = ["landingZone", "containerAppFqdn", "ado", "easyAuthSecretExists", "entra", "budgetStartDate", "releaseRecord", "bootstrap", "frontDoor", "frontDoorBackendIpRanges", "previousContainerAppFqdn"];

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const START_RE = /^\d{4}-(0[1-9]|1[0-2])-01$/;
const PINNED_IMAGE_RE = /^[a-z0-9][a-z0-9.-]*(:\d+)?\/[a-z0-9._/-]+(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$/;

function checkRuntime(v: unknown, label: string, problems: string[]): void {
  if (!isObject(v)) {
    problems.push(`${label} must be an object.`);
    return;
  }
  problems.push(...exactKeys(v, ["port", "size", "minReplicas", "maxReplicas", "livenessPath", "readinessPath"], label));
  for (const k of ["port", "minReplicas", "maxReplicas"]) if (!Number.isSafeInteger(own(v, k))) problems.push(`${label}.${k} must be an integer.`);
  if (!["xs", "s", "m", "l"].includes(own(v, "size") as string)) problems.push(`${label}.size must be xs, s, m or l.`);
  for (const k of ["livenessPath", "readinessPath"]) if (typeof own(v, k) !== "string" || !(own(v, k) as string).startsWith("/")) problems.push(`${label}.${k} must be a path.`);
}

export function parseState(v: unknown): State {
  if (!isObject(v)) throw new CheckFailed(["state.json must be a JSON object."]);
  const problems: string[] = Object.keys(v).filter((k) => !STATE_KEYS.includes(k)).map((k) => `state.json has an unknown key "${k}".`);
  const lz = own(v, "landingZone");
  if (lz !== undefined) {
    if (!isObject(lz)) problems.push("state.landingZone must be an object.");
    else {
      for (const k of Object.keys(lz)) if (!["runtimeIdentityClientId", "database", "storageBlobEndpoint"].includes(k)) problems.push(`state.landingZone has an unknown key "${k}".`);
      if (typeof own(lz, "runtimeIdentityClientId") !== "string" || !GUID_RE.test(own(lz, "runtimeIdentityClientId") as string)) problems.push("state.landingZone.runtimeIdentityClientId must be a GUID.");
      const db = own(lz, "database");
      if (db !== undefined && db !== null && (!isObject(db) || typeof own(db, "host") !== "string" || typeof own(db, "name") !== "string")) problems.push("state.landingZone.database must be null or { host, name, user? }.");
      const blob = own(lz, "storageBlobEndpoint");
      if (blob !== undefined && blob !== null && (typeof blob !== "string" || !blob.startsWith("https://"))) problems.push("state.landingZone.storageBlobEndpoint must be null or an https URL.");
    }
  }
  const fqdn = own(v, "containerAppFqdn");
  if (fqdn !== undefined && (typeof fqdn !== "string" || !HOST_RE.test(fqdn))) problems.push("state.containerAppFqdn must be a host name.");
  const previous = own(v, "previousContainerAppFqdn");
  if (previous !== undefined && (typeof previous !== "string" || !HOST_RE.test(previous))) problems.push("state.previousContainerAppFqdn must be a host name.");
  const ado = own(v, "ado");
  if (ado !== undefined && ado !== null) {
    if (!isObject(ado)) problems.push("state.ado must be null or { issuer, subject }.");
    else {
      problems.push(...exactKeys(ado, ["issuer", "subject"], "state.ado"));
      if (typeof own(ado, "issuer") !== "string" || !(own(ado, "issuer") as string).startsWith("https://")) problems.push("state.ado.issuer must be an https URL.");
      if (typeof own(ado, "subject") !== "string" || !(own(ado, "subject") as string)) problems.push("state.ado.subject must be a non-empty string.");
    }
  }
  const secret = own(v, "easyAuthSecretExists");
  if (secret !== undefined && typeof secret !== "boolean") problems.push("state.easyAuthSecretExists must be true or false.");
  const entra = own(v, "entra");
  if (entra !== undefined && entra !== null) {
    if (!isObject(entra)) problems.push("state.entra must be null or { clientId }.");
    else {
      problems.push(...exactKeys(entra, ["clientId"], "state.entra"));
      if (typeof own(entra, "clientId") !== "string" || !GUID_RE.test(own(entra, "clientId") as string)) problems.push("state.entra.clientId must be a GUID.");
    }
  }
  const start = own(v, "budgetStartDate");
  if (start !== undefined && start !== null && (typeof start !== "string" || !START_RE.test(start))) problems.push("state.budgetStartDate must be null or the first day of a month (YYYY-MM-01).");
  const record = own(v, "releaseRecord");
  if (record !== undefined && record !== null && !isObject(record)) problems.push("state.releaseRecord must be null or the deployment's properties.parameters.");
  const fd = own(v, "frontDoor");
  if (fd !== undefined && fd !== null) {
    if (!isObject(fd)) problems.push("state.frontDoor must be null or { hostName, frontDoorId, serving?, retainedHostName? }.");
    else {
      problems.push(...Object.keys(fd).filter((k) => !["hostName", "frontDoorId", "serving", "retainedHostName"].includes(k)).map((k) => `state.frontDoor has an unknown key "${k}".`));
      const kept = own(fd, "retainedHostName");
      if (kept !== undefined && (typeof kept !== "string" || !HOST_RE.test(kept) || kept === own(fd, "hostName"))) problems.push("state.frontDoor.retainedHostName must be another host name.");
      if (own(fd, "serving") !== undefined && typeof own(fd, "serving") !== "boolean") problems.push("state.frontDoor.serving must be true or false.");
      if (typeof own(fd, "hostName") !== "string" || !HOST_RE.test(own(fd, "hostName") as string)) problems.push("state.frontDoor.hostName must be a host name.");
      if (typeof own(fd, "frontDoorId") !== "string" || !GUID_RE.test(own(fd, "frontDoorId") as string)) problems.push("state.frontDoor.frontDoorId must be a GUID.");
    }
  }
  const ranges = own(v, "frontDoorBackendIpRanges");
  if (ranges !== undefined) problems.push(...backendRangesProblems(ranges, "state.frontDoorBackendIpRanges"));
  const boot = own(v, "bootstrap");
  if (boot !== undefined && boot !== null) {
    if (!isObject(boot)) problems.push("state.bootstrap must be null or { image, runtime }.");
    else {
      problems.push(...exactKeys(boot, ["image", "runtime"], "state.bootstrap"));
      if (typeof own(boot, "image") !== "string" || !PINNED_IMAGE_RE.test(own(boot, "image") as string)) problems.push("state.bootstrap.image must be an image reference pinned by digest (registry/repo[:tag]@sha256:...).");
      checkRuntime(own(boot, "runtime"), "state.bootstrap.runtime", problems);
    }
  }
  if (problems.length) throw new CheckFailed(problems);
  return v as State;
}

function need<K extends keyof State>(state: State, key: K, why: string): State[K] {
  if (!Object.hasOwn(state, key)) throw new CheckFailed([`state.json needs "${key}" for ${why}.`]);
  return state[key];
}

/**
 * Values shared by the landing zone and the release. `cell` is app.yaml's capacity cell (ADR-0053,
 * default 01): with networkMode it names the CAE the app runs in (landing zone, release, Front Door's
 * origin), so a network mode change moves the app into the CAE of the target mode in that cell.
 */
function common(app: AppData, inst: Instance, env: InstanceEnv) {
  const mode = app.environments[env.name]?.networkMode;
  if (!mode) throw new CheckFailed([`app ${app.slug} does not run in environment ${env.name}.`]);
  const vault = environmentVaultInputs(env);
  return {
    prefix: inst.naming.prefix,
    environmentName: env.name,
    slug: app.slug,
    generation: app.generation ?? 0,
    vaultGeneration: vault.vaultGeneration,
    location: env.region ?? inst.defaultRegion,
    networkMode: mode,
    cell: cellOf(app.environments[env.name]),
    externalOnlyNetwork: vault.externalOnlyNetwork as string,
  };
}

function sizeOf(sizes: Record<string, DbSize>, size: string, engine: string): DbSize {
  const s = Object.hasOwn(sizes, size) ? sizes[size] : undefined;
  if (!s) throw new CheckFailed([`instance.yaml data.${engine}.sizes has no size ${size}.`]);
  return s;
}

function lzData(app: AppData, inst: Instance, env: InstanceEnv): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const prod = env.kind === "prod";
  const db = app.data?.database;
  if (db) {
    const size = app.environments[env.name]?.databaseSize ?? db.size;
    if (db.engine === "postgres") {
      const p = inst.data?.postgres;
      const s = sizeOf(p?.sizes ?? instanceDefault("$defs/dataDefaults/properties/postgres/properties/sizes"), size, "postgres");
      if (!s.tier || s.storageGb === undefined) throw new CheckFailed([`instance.yaml data.postgres.sizes.${size} needs tier and storageGb.`]);
      out.postgres = { skuName: s.sku, tier: s.tier, storageGb: s.storageGb, version: p?.version ?? instanceDefault("$defs/dataDefaults/properties/postgres/properties/version") };
    } else {
      const q = inst.data?.azureSql;
      const s = sizeOf(q?.sizes ?? instanceDefault("$defs/dataDefaults/properties/azureSql/properties/sizes"), size, "azureSql");
      if (s.storageGb === undefined) throw new CheckFailed([`instance.yaml data.azureSql.sizes.${size} needs storageGb.`]);
      const kindKey = prod ? "prod" : "nonprod";
      out.azureSql = {
        skuName: s.sku,
        storageGb: s.storageGb,
        backupStorageRedundancy: q?.backupStorageRedundancy?.[kindKey] ?? instanceDefault(`$defs/dataDefaults/properties/azureSql/properties/backupStorageRedundancy/properties/${kindKey}`),
      };
    }
  }
  if (app.data?.storage) {
    const st = inst.data?.storage;
    const base = "$defs/dataDefaults/properties/storage/properties";
    out.storage = {
      redundancy: prod ? (st?.prodRedundancy ?? instanceDefault(`${base}/prodRedundancy`)) : (st?.nonprodRedundancy ?? instanceDefault(`${base}/nonprodRedundancy`)),
      softDeleteDays: prod
        ? (st?.protection?.softDeleteDaysProd ?? instanceDefault(`${base}/protection/properties/softDeleteDaysProd`))
        : (st?.protection?.softDeleteDaysNonprod ?? instanceDefault(`${base}/protection/properties/softDeleteDaysNonprod`)),
      pointInTimeRestore: st?.protection?.pointInTimeRestore ?? instanceDefault(`${base}/protection/properties/pointInTimeRestore`),
    };
  }
  return out;
}

/** The app's monthly budget amount in an environment, or undefined when it has none. */
export function budgetAmount(app: AppData, inst: Instance, envName: string): number | undefined {
  const appEnv = app.environments[envName];
  if (!appEnv) return undefined;
  const budgetsMode = inst.budgets?.mode ?? instanceDefault<string>("properties/budgets/properties/mode");
  return budgetsMode === "off" || appEnv.budget === null ? undefined : appEnv.budget ? appEnv.budget.monthlyAmount : inst.budgets?.defaultMonthlyAmount;
}

/**
 * The budget's amount as Azure takes it (ADR-0018): app.yaml and budgets.defaultMonthlyAmount are
 * in the instance currency, Azure evaluates the budget in the environment's billing currency. When
 * they differ, the amount is converted with the fixed rate of costs.fx (fx.ts), rounded to a whole
 * unit; without a rate the step fails (platform validate instance rejects such an instance first).
 * A changed rate changes the landing zone's inputs, so the next provisioning run redeploys it.
 */
export function budgetInAzure(amount: number, inst: Instance, env: InstanceEnv): number {
  const billed = billingCurrencyOf(inst, env);
  const currency = instanceCurrencyOf(inst);
  if (billed === currency) return amount;
  const fx = fxRateOf(inst, billed);
  if (!fx) throw new CheckFailed([`Azure bills environment ${env.name} in ${billed}, not ${currency}, and costs.fx has no fixed rate for ${billed}: the budget can't be converted.`]);
  return budgetInBillingCurrency(amount, fx.rate);
}

/** The network modes a prepare pass may come from: the modes of iteration 1 (ADR-0060). */
export const PREPARE_FROM_MODES = ["externalOnly", "externalHybrid"] as const;
export type PrepareFrom = (typeof PREPARE_FROM_MODES)[number];

/**
 * landing-zone.bicep `modeChange` (ADR-0060 decision 4): null in the steady state; with --prepare-from
 * the prepare pass of a mode change from that mode to app.yaml's. Only externalOnly <-> externalHybrid,
 * and never the same mode (the template refuses both too).
 */
function modeChangeOf(app: AppData, envName: string, to: string, prepareFrom: string | undefined): { phase: "prepare"; fromNetworkMode: PrepareFrom } | null {
  if (prepareFrom === undefined) return null;
  if (!(PREPARE_FROM_MODES as readonly string[]).includes(prepareFrom)) throw new CheckFailed([`--prepare-from must be ${PREPARE_FROM_MODES.join(" or ")} (the mode changes of ADR-0060).`]);
  if (prepareFrom === to) throw new CheckFailed([`--prepare-from ${prepareFrom} is the mode ${app.slug} has in ${envName} already: a prepare pass belongs to a change of mode.`]);
  return { phase: "prepare", fromNetworkMode: prepareFrom as PrepareFrom };
}

export function lzInputs(app: AppData, inst: Instance, envName: string, state: State, prepareFrom?: string): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const c = common(app, inst, env);
  const prod = env.kind === "prod";
  const modeChange = modeChangeOf(app, envName, c.networkMode, prepareFrom);
  // The hybrid spoke is the target's, or in a prepare pass from externalHybrid the source's.
  const hybridSpoke = c.networkMode === "externalHybrid" || modeChange?.fromNetworkMode === "externalHybrid";
  const backup = "$defs/dataDefaults/properties/backup/properties";

  const amount = budgetAmount(app, inst, envName);
  let budget: Record<string, unknown> | null = null;
  if (amount !== undefined) {
    const start = need(state, "budgetStartDate", `the budget of ${app.slug} in ${envName}`);
    if (!start) throw new CheckFailed([`state.budgetStartDate is null, but ${app.slug} has a budget in ${envName}.`]);
    budget = {
      amount: budgetInAzure(amount, inst, env),
      startDate: start,
      notifyAtPercent: inst.budgets?.notifyAtPercent ?? instanceDefault("properties/budgets/properties/notifyAtPercent"),
      forecastNotifyAtPercent: inst.budgets?.forecastNotifyAtPercent ?? instanceDefault("properties/budgets/properties/forecastNotifyAtPercent"),
    };
  }

  const source = env.promoteFrom ? instanceEnv(inst, env.promoteFrom) : undefined;
  const team = inst.notifications?.email?.platformTeamAddress;
  const ado = need(state, "ado", "the landing zone (deliveryFederation; null before the service connection exists)");
  const secret = need(state, "easyAuthSecretExists", "the landing zone (carried from the last lz record)");
  return {
    prefix: c.prefix,
    environmentName: c.environmentName,
    environmentKind: env.kind,
    location: c.location,
    slug: c.slug,
    generation: c.generation,
    vaultGeneration: c.vaultGeneration,
    networkMode: c.networkMode,
    cell: c.cell,
    externalOnlyNetwork: c.externalOnlyNetwork,
    hybridExistingVnetId: hybridSpoke ? (env.networkModes.externalHybrid?.vnet?.existingVnetId ?? null) : null,
    modeChange,
    promoteFrom: source ? { environmentName: source.name, subscriptionId: source.subscriptionId } : null,
    owner: { principalId: app.owner.objectId, principalType: app.owner.principalType, email: app.owner.email },
    deputy: { principalId: app.deputy.objectId, principalType: app.deputy.principalType, email: app.deputy.email },
    developers: (app.developers ?? []).map((d) => ({ principalId: d.objectId, principalType: d.principalType })),
    data: lzData(app, inst, env),
    backupRetentionDays: prod
      ? (inst.data?.backup?.retentionDaysProd ?? instanceDefault(`${backup}/retentionDaysProd`))
      : (inst.data?.backup?.retentionDaysNonprod ?? instanceDefault(`${backup}/retentionDaysNonprod`)),
    postgresGeoRedundantBackup: prod ? (inst.data?.backup?.geoRedundantProd ?? instanceDefault(`${backup}/geoRedundantProd`)) : false,
    alertEmails: [app.owner.email, app.deputy.email, ...(prod && team ? [team] : [])],
    postgresCpuCreditAlert: inst.data?.postgres?.cpuCreditAlert ?? instanceDefault("$defs/dataDefaults/properties/postgres/properties/cpuCreditAlert"),
    budget,
    deliveryFederation: ado ?? null,
    easyAuthSecretExists: secret,
    managedBy: inst.productName ?? instanceDefault("properties/productName"),
    costCenter: app.costCenter ?? "",
    // Reader on the app resource group for id-{prefix}-portal (ADR-0037); '' = no assignment.
    portalIdentityPrincipalId: inst.portal?.identityPrincipalId ?? "",
  };
}

export function entraInputs(app: AppData, inst: Instance, envName: string, state: State): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  if (!app.environments[envName]) throw new CheckFailed([`app ${app.slug} does not run in environment ${envName}.`]);
  const fqdn = need(state, "containerAppFqdn", "the Entra redirect host");
  const roles =
    app.authentication.roles?.map((r) => ({ value: r.value, displayName: r.displayName, description: r.description ?? r.displayName })) ??
    (inst.authentication?.defaultAppRoles ?? instanceDefault<string[]>("properties/authentication/properties/defaultAppRoles")).map((v) => ({ value: v, displayName: v, description: v }));
  const hosts = entraHosts(app, inst, envName, state, fqdn!);
  return {
    prefix: inst.naming.prefix,
    environmentName: env.name,
    environmentKind: env.kind,
    slug: app.slug,
    // ADR-0061: the registration's uniqueName ({prefix}-{slug}-{env}[--i{incarnation}]); always passed (no default).
    incarnation: app.incarnation ?? 0,
    appTitle: app.title,
    hosts,
    appRoles: roles,
    roleAssignments: (app.authentication.assignments ?? []).map((a) => ({ principalId: a.objectId, role: a.role })),
  };
}

/**
 * The redirect hosts of the registration (ADR-0010, amended 2026-11-02 and 2026-11-11): every host
 * a browser may sign in on during this run, so no step leaves a reachable host without its callback.
 *   - The custom domain's callback joins the default host's, so sign-in works on both. Once the
 *     ingress is locked down (the domain deployed and served by Front Door, the ranges resolved; the
 *     condition the release follows), only the custom host: the default host no longer answers.
 *   - Previous hosts the route still serves (a host change whose new host isn't served yet, or a
 *     removal not finished: the record fd-{slug}-{env} still names them) keep their callback until
 *     provisioning has deleted them; the next run drops it (record_<env> does not record its entra unit as finished).
 *   - A removal: the default host's callback comes back before the release opens the ingress, and
 *     azure_post_<env> waits for it (an app with sign-in is never opened on a host Entra rejects).
 *   - External mode: the default host and the custom host the other team's Front Door serves (the
 *     platform can't see when that team's route is live, so the ingress isn't locked).
 */
function entraHosts(app: AppData, inst: Instance, envName: string, state: State, fqdn: string): string[] {
  const hosts = entraHostsNow(app, inst, envName, state, fqdn);
  // ADR-0060: during a move, the source CAE's default host stays a redirect host next to the new one,
  // only where the default host is one (not behind a locked Front Door ingress).
  const previous = state.previousContainerAppFqdn?.toLowerCase();
  return previous && hosts.includes(fqdn) && !hosts.includes(previous) ? [...hosts, previous] : hosts;
}

function entraHostsNow(app: AppData, inst: Instance, envName: string, state: State, fqdn: string): string[] {
  const requested = app.environments[envName]?.frontDoor?.hostName?.toLowerCase();
  const uniq = (hs: (string | undefined)[]): string[] => [...new Set(hs.filter((h): h is string => !!h))];
  if ((inst.frontDoor?.mode ?? "managed") === "external") return uniq([fqdn, requested]);
  const fd = Object.hasOwn(state, "frontDoor") ? state.frontDoor : undefined;
  const deployed = deployedFrontDoor(app, envName, state);
  // The previous hosts drop out in the run where the requested one is served: azure_post_<env> deletes them then.
  const old = fd && !(deployed && fd.serving === true) ? [fd.hostName, fd.retainedHostName].filter((h) => h && h !== requested) : [];
  if (!requested) return uniq([fqdn, ...old]);
  return frontDoorLockdown(app, envName, state) ? uniq([requested, ...old]) : uniq([fqdn, requested, ...old]);
}

function recordValue(record: Record<string, unknown>, name: string): unknown {
  const e = own(record, name);
  if (!isObject(e) || !Object.hasOwn(e, "value")) throw new CheckFailed([`state.releaseRecord has no parameter "${name}".`]);
  return e.value;
}

export function releaseInputs(app: AppData, inst: Instance, envName: string, state: State, mode: ReleaseMode): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const c = common(app, inst, env);
  const lz = need(state, "landingZone", "the release (landing-zone outputs)");
  if (!lz) throw new CheckFailed(["state.landingZone is required for the release."]);
  const landingZone: Record<string, unknown> = { runtimeIdentityClientId: lz.runtimeIdentityClientId };
  if (lz.database) landingZone.database = lz.database;
  if (lz.storageBlobEndpoint) landingZone.storageBlobEndpoint = lz.storageBlobEndpoint;

  let authentication: Record<string, unknown>;
  if (app.authentication.mode === "required") {
    const entra = Object.hasOwn(state, "entra") ? state.entra : undefined;
    // An app with required sign-in never gets an anonymous release while its registration is missing.
    if (!entra) throw new CheckFailed([`${app.slug} requires sign-in, but state.entra has no clientId (the Entra stage has not run): no release.`]);
    authentication = { mode: "required", clientId: entra.clientId };
  } else authentication = { mode: "anonymous" };

  const record = Object.hasOwn(state, "releaseRecord") ? state.releaseRecord : undefined;
  let image: Record<string, unknown>;
  let runtime: unknown;
  let envVars: unknown;
  let secrets: unknown;
  let run: unknown = null;
  if (mode === "bootstrap") {
    if (record) throw new CheckFailed([`release-${app.slug} already exists in ${envName}: use --mode reapply (a bootstrap would replace the running image).`]);
    const boot = need(state, "bootstrap", "a bootstrap release");
    if (!boot) throw new CheckFailed(["state.bootstrap is required for --mode bootstrap."]);
    image = { bootstrapImage: boot.image };
    runtime = boot.runtime;
    envVars = [];
    secrets = [];
  } else {
    if (!record) throw new CheckFailed([`--mode reapply needs state.releaseRecord (the last release-${app.slug} deployment); without one, bootstrap.`]);
    const problems: string[] = [];
    for (const [k, want] of [["prefix", c.prefix], ["environmentName", c.environmentName], ["slug", c.slug]] as const) {
      const got = recordValue(record, k);
      if (got !== want) problems.push(`state.releaseRecord ${k} is "${String(got)}", expected "${want}".`);
    }
    const img = recordValue(record, "image");
    if (!isObject(img)) problems.push("state.releaseRecord image must be an object.");
    else {
      const digest = own(img, "digest");
      const boot = own(img, "bootstrapImage");
      if (typeof digest === "string" && DIGEST_RE.test(digest)) image = { digest };
      else if (typeof boot === "string" && PINNED_IMAGE_RE.test(boot)) image = { bootstrapImage: boot };
      else problems.push("state.releaseRecord image has neither a digest nor a pinned bootstrapImage.");
    }
    runtime = recordValue(record, "runtime");
    checkRuntime(runtime, "state.releaseRecord runtime", problems);
    envVars = recordValue(record, "env");
    secrets = recordValue(record, "secrets");
    if (!Array.isArray(envVars)) problems.push("state.releaseRecord env must be a list.");
    if (!Array.isArray(secrets) || secrets.some((s) => typeof s !== "string")) problems.push("state.releaseRecord secrets must be a list of names.");
    const r = isObject(own(record, "run")) ? (own(record, "run") as Record<string, unknown>).value : null;
    if (r !== null && r !== undefined) {
      if (!isObject(r) || typeof own(r, "id") !== "string" || typeof own(r, "commit") !== "string") problems.push("state.releaseRecord run must be null or { id, commit }.");
      else run = { id: own(r, "id"), commit: own(r, "commit") };
    }
    if (problems.length) throw new CheckFailed(problems);
  }
  return {
    ...c,
    image: image!,
    runtime,
    env: envVars,
    secrets,
    landingZone,
    frontDoor: releaseFrontDoor(app, inst, envName, state),
    customDomains: [],
    authentication,
    alertsEnabled: inst.observability?.defaultAlerts ?? instanceDefault("properties/observability/properties/defaultAlerts"),
    run,
    // The Container App's tag saf-core (ADR-0049 section 7): the core version that applied it.
    coreVersion: inst.coreVersion,
  };
}

/**
 * The app's custom domain is deployed (state.frontDoor from the record fd-{slug}-{env}, for the
 * host app.yaml requests now): its host and the profile's Front Door ID, else undefined.
 */
function deployedFrontDoor(app: AppData, envName: string, state: State): { host: string; frontDoorId: string } | undefined {
  const host = app.environments[envName]?.frontDoor?.hostName?.toLowerCase();
  const fd = Object.hasOwn(state, "frontDoor") ? state.frontDoor : undefined;
  return host && fd && fd.hostName.toLowerCase() === host ? { host, frontDoorId: fd.frontDoorId } : undefined;
}

/** The release record already locks the ingress for this host (frontDoor with ranges, ADR-0010). */
function recordLocked(state: State, host: string): boolean {
  const record = Object.hasOwn(state, "releaseRecord") ? state.releaseRecord : undefined;
  const e = record ? own(record, "frontDoor") : undefined;
  const fd = isObject(e) ? own(e, "value") : undefined;
  if (!isObject(fd) || own(fd, "mode") === "none") return false;
  const hosts = own(fd, "hostNames");
  const ranges = own(fd, "backendIpRanges");
  return Array.isArray(hosts) && hosts.some((h) => typeof h === "string" && h.toLowerCase() === host) && Array.isArray(ranges) && ranges.length > 0;
}

/**
 * The ingress lock-down applies (ADR-0010, amended 2026-11-11): the custom domain is deployed, the
 * stage resolved the AzureFrontDoor.Backend ranges (state.frontDoorBackendIpRanges, non-empty by
 * parseState) and Front Door serves the domain (state.frontDoor.serving), or the release record
 * already locks it for this host (a locked ingress is never opened again while the domain stays,
 * e.g. while Front Door revalidates it). Locking earlier would leave the app reachable from nowhere
 * until the certificate is issued (about 20 minutes, FD-2), and its smoke test, which goes through
 * the custom host, would fail. The release locks the ingress then, and the Entra registration keeps
 * only the custom host's redirect URI.
 */
function frontDoorLockdown(app: AppData, envName: string, state: State): boolean {
  const fd = deployedFrontDoor(app, envName, state);
  if (!fd || !Object.hasOwn(state, "frontDoorBackendIpRanges")) return false;
  // A host change keeps the lock of the previous host while the route still serves it (amended 2026-11-11).
  const kept = state.frontDoor?.retainedHostName;
  return state.frontDoor?.serving === true || recordLocked(state, fd.host) || (!!kept && recordLocked(state, kept));
}

/**
 * The release's frontDoor (ADR-0010, amended 2026-11-02 and 2026-11-11): `managed` with the
 * profile's Front Door ID once the app's custom domain is deployed, so the release sets
 * FRONT_DOOR_ID and Easy Auth trusts Front Door's forwarded host (forwardProxy Standard); else
 * `none`. hostNames: the custom host, which Easy Auth trusts as the origin of a signed-in browser's
 * writes (CSRF check, FD-9). backendIpRanges: the AzureFrontDoor.Backend IPv4 prefixes the stage
 * resolved (one `Allow` rule each, so only Front Door reaches the ingress) once the lock-down
 * applies; empty while Front Door doesn't serve the new domain yet (the run does not record its release unit as finished,
 * so the next run locks it). A deployed domain without resolved ranges fails the release: the
 * ranges are never guessed, and a locked ingress is never opened by a failed lookup. The app's
 * X-Azure-FDID check tells this profile from other Front Door customers on the same addresses.
 */
function releaseFrontDoor(app: AppData, inst: Instance, envName: string, state: State): Record<string, unknown> {
  const requested = app.environments[envName]?.frontDoor;
  // External mode (amended 2026-11-11): another team's profile; FRONT_DOOR_ID and forwardProxy, no
  // lock-down (the platform can't see when that team's route serves the host).
  if ((inst.frontDoor?.mode ?? "managed") === "external") {
    if (!requested) return { mode: "none", backendIpRanges: [] };
    const profile = (inst.frontDoor?.external?.profiles ?? []).find((p) => p.name === requested.profile);
    const id = profile?.frontDoorId ?? requested.frontDoorId;
    if (!id || !GUID_RE.test(id)) {
      throw new CheckFailed([`${app.slug} is behind the external Front Door profile ${requested.profile ?? "(none)"} in ${envName}, but no expected Front Door ID is known (instance.yaml frontDoor.external.profiles[].frontDoorId or app.yaml frontDoor.frontDoorId).`]);
    }
    return { mode: "external", frontDoorId: id.toLowerCase(), hostNames: [requested.hostName.toLowerCase()], backendIpRanges: [] };
  }
  const fd = deployedFrontDoor(app, envName, state);
  if (!fd) return { mode: "none", backendIpRanges: [] };
  if (!Object.hasOwn(state, "frontDoorBackendIpRanges")) {
    throw new CheckFailed([`${app.slug} is behind Front Door in ${envName} (its custom domain ${fd.host} is deployed), but state.json has no frontDoorBackendIpRanges (the AzureFrontDoor.Backend ranges were not resolved): no release, so its ingress is never opened.`]);
  }
  const ranges = frontDoorLockdown(app, envName, state) ? [...state.frontDoorBackendIpRanges!] : [];
  // A host change: the previous host stays trusted while the route serves it, and comes first, so the
  // smoke test probes a host Front Door serves (amended 2026-11-11).
  const kept = state.frontDoor?.serving === true ? undefined : state.frontDoor?.retainedHostName;
  return { mode: "managed", frontDoorId: fd.frontDoorId, hostNames: kept && kept !== fd.host ? [kept, fd.host] : [fd.host], backendIpRanges: ranges };
}

/**
 * The app on its custom domain through the environment's managed Front Door (frontdoor.bicep,
 * deployment fd-{slug}-{env} in the environment's platform resource group; ADR-0010, amended
 * 2026-11-01). dnsZoneId is the zone's azureDnsZoneId when the zone is an Azure DNS zone in the
 * environment's subscription (the template writes the _dnsauth TXT and the CNAME there), else ''
 * (records by hand: the provisioning run lists them). dnsZone and dnsProvider are for the run's
 * report; the parameter file doesn't read them.
 */
export function frontDoorInputs(app: AppData, inst: Instance, envName: string, previous?: { record?: string; domain?: string; apps?: string }): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const c = common(app, inst, env);
  if ((inst.frontDoor?.mode ?? "managed") !== "managed") throw new CheckFailed([`frontDoor.mode is ${String(inst.frontDoor?.mode)}: provisioning deploys nothing in an external Front Door profile.`]);
  const host = app.environments[envName]?.frontDoor?.hostName;
  if (!host) throw new CheckFailed([`app ${app.slug} requests no custom domain in environment ${envName} (environments.${envName}.frontDoor.hostName).`]);
  // A host change (amended 2026-11-11): the previous host stays on the route until the new one is served.
  const prev = previousFrontDoor(previous?.record, previous?.domain, app.slug, envName);
  const kept = retainedHost(host, prev, otherAppsHosts(previous?.apps, app.slug, envName));
  const zone = zoneOfHost(inst.dns?.zones, host);
  if (!zone) throw new CheckFailed([`the host ${host} of ${app.slug} in ${envName} is inside no DNS zone of instance.yaml dns.zones.`]);
  const zoneSubscription = /^\/subscriptions\/([^/]+)\//i.exec(zone.azureDnsZoneId ?? "")?.[1];
  const written = zone.provider === "azureDns" && !!zone.azureDnsZoneId && zoneSubscription?.toLowerCase() === env.subscriptionId.toLowerCase();
  return {
    prefix: c.prefix,
    environmentName: c.environmentName,
    slug: c.slug,
    networkMode: c.networkMode,
    cell: c.cell,
    hostName: host.toLowerCase(),
    dnsZoneId: written ? zone.azureDnsZoneId : "",
    retainedHostName: kept.hostName,
    retainedDnsZoneId: kept.dnsZoneId,
    dnsZone: zone.name,
    dnsProvider: zone.provider,
  };
}

/**
 * The portal-side private endpoint of the app's vault in one environment (ADR-0025,
 * infra/app/portal-vault-endpoint.bicep), deployed in the portal resource group of
 * portal.hostEnvironment: the host's region (the portal VNet's, as portal.bicep resolves it), the
 * vault environment's subscription, the app's generation (part of the vault name) and network mode.
 * `vnetBased` is for the pipeline, which deploys the endpoint only then (the template refuses a
 * managed-network vault too); the parameter file ignores it.
 */
export function portalEndpointInputs(app: AppData, inst: Instance, envName: string): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const c = common(app, inst, env);
  const hostName = inst.portal?.hostEnvironment;
  if (!hostName) throw new CheckFailed(["instance.yaml has no portal.hostEnvironment."]);
  const host = instanceEnv(inst, hostName);
  return {
    prefix: c.prefix,
    portalEnvironmentName: host.name,
    location: host.region ?? inst.defaultRegion,
    environmentName: c.environmentName,
    slug: c.slug,
    generation: c.generation,
    vaultSubscriptionId: env.subscriptionId,
    networkMode: c.networkMode,
    externalOnlyNetwork: c.externalOnlyNetwork,
    managedBy: inst.productName ?? instanceDefault("properties/productName"),
    vnetBased: c.networkMode === "externalHybrid" || c.externalOnlyNetwork === "vnet",
  };
}

export function provisioningInputs(args: { step: string; instance: string; app: string; env: string; state?: string; mode?: string; fdRecord?: string; fdDomain?: string; apps?: string; prepareFrom?: string }): Record<string, unknown> {
  if (!(STEPS as readonly string[]).includes(args.step)) throw new CheckFailed([`--step must be ${STEPS.slice(0, -1).join(", ")} or ${STEPS.at(-1)!}.`]);
  if (args.step === "release" && args.mode !== "bootstrap" && args.mode !== "reapply") throw new CheckFailed(["--step release needs --mode bootstrap or reapply."]);
  if (args.step !== "release" && args.mode !== undefined) throw new CheckFailed(["--mode applies to --step release only."]);
  if (args.step !== "lz" && args.prepareFrom !== undefined) throw new CheckFailed(["--prepare-from applies to --step lz only."]);
  if (args.step !== "frontdoor" && (args.fdRecord !== undefined || args.fdDomain !== undefined || args.apps !== undefined)) throw new CheckFailed(["--fd-record, --fd-domain and --apps apply to --step frontdoor only."]);
  if (STATELESS.includes(args.step) && args.state !== undefined) throw new CheckFailed([`--step ${args.step} takes no --state (it reads instance.yaml and app.yaml only).`]);
  if (!STATELESS.includes(args.step) && args.state === undefined) throw new CheckFailed([`--step ${args.step} needs --state.`]);
  const inst = loadInstanceFile(args.instance);
  const app = loadAppFile(args.app, args.instance);
  if (!Object.hasOwn(app.environments, args.env)) throw new CheckFailed([`app ${app.slug} does not run in environment ${args.env}.`]);
  if (args.step === "frontdoor") return frontDoorInputs(app, inst, args.env, { record: args.fdRecord, domain: args.fdDomain, apps: args.apps });
  if (args.step === "portal-endpoint") return portalEndpointInputs(app, inst, args.env);
  const state = parseState(readJson(args.state!, 16 * MiB, "state.json"));
  if (args.step === "lz") return lzInputs(app, inst, args.env, state, args.prepareFrom);
  if (args.step === "entra") return entraInputs(app, inst, args.env, state);
  return releaseInputs(app, inst, args.env, state, args.mode as ReleaseMode);
}
