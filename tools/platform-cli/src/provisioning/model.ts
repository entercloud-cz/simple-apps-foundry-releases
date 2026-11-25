import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, MiB, readText } from "../pipeline/common.js";
import { parseYaml, schemaDir, validateData } from "../schema.js";
import type { AppTheme } from "../themes.js";
import type { AppData, AppValidateResult, DnsZoneView } from "../validate-app.js";
import { validateApp } from "../validate-app.js";

/**
 * approvals.entraChanges (ADR-0051): pullRequest = the reviewed platform-config pull request is the
 * approval of the Entra changes it causes; separate = the stage entra also waits for its own
 * Approval check on sc-platform-entra (ADR-0023).
 */
export type EntraChanges = "pullRequest" | "separate";

/**
 * The ManagedBy tag of everything the platform deploys (ADR-0002, amended 2026-11-22): a fixed value, never
 * instance.yaml productName, so renaming the portal doesn't re-tag every resource and start every pipeline.
 */
export const MANAGED_BY_TAG = "SAF";

/** The parts of instance.yaml the generator and the provisioning inputs read. */
export interface Instance {
  coreVersion: string;
  /** The public releases repository (ADR-0067): https://github.com/<owner>/<repository>. */
  coreReleases?: { repository: string };
  productName?: string;
  defaultRegion: string;
  naming: { prefix: string };
  tenantId?: string;
  scm: {
    provider: string;
    azureDevOps?: { organizationUrl?: string; platformProject: string; platformConfigRepo?: string; platformConfigDefaultBranch?: string; appsProject: string; allowedProjects?: string[] };
  };
  /**
   * clientId and apiBaseUrl: the delivery pipelines' deploy events; identityPrincipalId: Reader on app RGs (ADR-0037);
   * network and clientId: portal.bicep through the host's platform pipeline (ADR-0043 decision 10).
   */
  portal?: {
    hostEnvironment: string;
    network?: { vnetAddressSpace: string; caeSubnetPrefix: string; privateEndpointSubnetPrefix: string; routeTableId?: string; approvalReference?: string };
    clientId?: string;
    /** The platform CLI's public client (ADR-0075): the portal API takes its tokens on read routes. */
    cliClientId?: string;
    apiBaseUrl?: string;
    identityPrincipalId?: string;
    /** The portal's own host name through Front Door (ADR-0071): a host, "" = none, unset = portal.{default zone}. */
    hostName?: string;
  };
  platformAdmins?: { objectId: string; displayName?: string };
  approvals?: { platformTeam?: { objectId: string; displayName?: string }; prodDeployApprovers?: string; allowSelfApproval?: boolean; entraChanges?: EntraChanges };
  environments: InstanceEnv[];
  authentication?: { enforcement?: string; defaultAppRoles?: string[] };
  data?: {
    postgres?: { enabled?: boolean; version?: string; cpuCreditAlert?: boolean; sizes?: Record<string, DbSize> };
    azureSql?: { enabled?: boolean; sizes?: Record<string, DbSize>; backupStorageRedundancy?: { prod?: string; nonprod?: string } };
    storage?: {
      enabled?: boolean;
      prodRedundancy?: string;
      nonprodRedundancy?: string;
      protection?: { softDeleteDaysProd?: number; softDeleteDaysNonprod?: number; pointInTimeRestore?: boolean };
    };
    backup?: { retentionDaysProd?: number; retentionDaysNonprod?: number; geoRedundantProd?: boolean };
  };
  budgets?: { mode?: string; defaultMonthlyAmount?: number; notifyAtPercent?: number[]; forecastNotifyAtPercent?: number[] };
  locale?: { currency?: string };
  /** Currency conversion (fx.ts): fixed rates to locale.currency. */
  costs?: { fx?: { source?: string; fixedRates?: Record<string, number>; asOf?: string } };
  notifications?: {
    email?: {
      provider?: string;
      platformTeamAddress?: string;
      /** The SMTP relay (provider smtp); with auth.mode basic the password is a secret of the host's environment vault. */
      smtp?: { auth?: { mode?: string; passwordSecretName?: string } };
    };
  };
  observability?: { defaultAlerts?: boolean; logRetentionDays?: number };
  /** The initial platform configuration's progress (ADR-0073): the setup steps confirmed and skipped. */
  setup?: { confirmed?: string[]; skipped?: string[] };
  /** The platform pipeline's inputs (ADR-0043): the Entra provisioning identity's principal. */
  identities?: { entraProvisioningPrincipalId?: string };
  frontDoor?: {
    mode?: "managed" | "external";
    managed?: { profiles?: FrontDoorProfile[] };
    /** External mode (ADR-0010, amended 2026-11-11): profiles another team runs. */
    external?: { profiles?: { name: string; frontDoorId?: string; allowedEnvironments?: string[] }[] };
  };
  /** DNS zones for custom hosts (ADR-0010): the frontdoor inputs pick the zone of a host. */
  dns?: { zones?: DnsZoneView[]; reservedSubdomains?: string[] };
  /** App themes (ADR-0044): what the instance offers; a seeded repository gets the app's ui.theme. */
  branding?: { appThemes?: AppTheme[]; defaultAppTheme?: string };
  /** The default capacity reservation (ADR-0053, capacity.ts). */
  newApps?: { capacity?: { size?: "xs" | "s" | "m" | "l"; maxReplicas?: number } };
}

/** frontDoor.managed.profiles[] (instance.schema.json $defs/frontDoorProfile). */
export interface FrontDoorProfile {
  environment: string;
  sku?: "Standard" | "Premium";
  waf?: { mode?: "off" | "detection" | "prevention"; managedRuleSets?: boolean };
}

export interface InstanceEnv {
  name: string;
  kind: "prod" | "nonprod";
  promoteFrom?: string;
  subscriptionId: string;
  region?: string;
  /** The currency Azure bills the subscription in (absent = locale.currency; fx.ts). */
  billingCurrency?: string;
  vaultGeneration?: number;
  hub?: { vnetId: string; firewallPrivateIp: string };
  networkModes: {
    externalOnly?: {
      network?: "managed" | "vnet";
      /** Capacity cells (ADR-0053; absent: one cell 01). */
      cells?: { id: string; capacity?: { cores?: number } }[];
      vnetAddressSpace?: string;
      caeSubnetPrefix?: string;
      privateEndpointSubnetPrefix?: string;
      natGatewayPublicIpCount?: number;
    };
    externalHybrid?: ConnectedMode;
    internalOnly?: ConnectedMode;
  };
}

/** environments[].networkModes.externalHybrid (instance.schema.json $defs/connectedMode). */
export interface ConnectedMode {
  vnet?: { existingVnetId?: string; create?: { addressSpace: string; useRemoteGateways?: boolean } };
  /** Capacity cells (ADR-0053; absent: one cell 01). */
  cells?: { id: string; capacity?: { cores?: number } }[];
  caeSubnetPrefix?: string;
  privateEndpointSubnetPrefix?: string;
  routeTableId?: string;
  dnsServers?: string[];
  egressAllowListProcess?: string;
  egressBaseline?: { status: "notRequested" | "requested" | "active"; reference?: string };
}

export interface DbSize {
  sku: string;
  tier?: string;
  storageGb?: number;
}

let instanceSchema: unknown;

/**
 * A default declared in the bundled instance schema (JSON pointer below the root, e.g.
 * "properties/budgets/properties/mode"). Reading it from the schema keeps a single source.
 */
export function instanceDefault<T>(pointer: string): T {
  instanceSchema ??= JSON.parse(readFileSync(join(schemaDir(), "instance.schema.json"), "utf8")) as unknown;
  let node = instanceSchema as Record<string, unknown> | undefined;
  for (const part of pointer.split("/")) node = node?.[part] as Record<string, unknown> | undefined;
  if (!node || !Object.hasOwn(node, "default")) throw new Error(`instance.schema.json has no default at ${pointer}`);
  return structuredClone(node.default) as T;
}

/** instance.yaml, schema-validated (same validation as `platform validate instance`). */
export function loadInstanceFile(path: string): Instance {
  return parseInstanceText(readText(path, 4 * MiB, "instance.yaml"));
}

/** loadInstanceFile on text (the library: renderDeliveryYaml, renderAppRepo). */
export function parseInstanceText(text: string): Instance {
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) throw new CheckFailed(parsed.parseErrors.map((e) => `instance.yaml line ${e.line}: YAML syntax error: ${e.message}`));
  const problems = validateData("instance", parsed.data, parsed);
  if (problems.length) throw new CheckFailed(problems.map((p) => `instance.yaml ${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}.`));
  return parsed.data as Instance;
}

/** The lines `platform generate` and `provisioning apps` print for a failed app validation. */
export function appResultLines(r: AppValidateResult): string[] {
  return [
    ...r.parseErrors.map((e) => `line ${e.line}: YAML syntax error: ${e.message}`),
    ...r.problems.map((p) => `${p.line ? `line ${p.line}: ` : ""}${p.path}: ${p.message}`),
    ...r.checks.map((c) => `${c.line ? `line ${c.line}: ` : ""}${c.path}: ${c.message}`),
  ];
}

/** An app definition that passes `platform validate app --instance` (schema and instance checks). */
export function loadAppFile(path: string, instancePath: string): AppData {
  const r = validateApp(path, { instance: instancePath });
  if (!r.ok) throw new CheckFailed(appResultLines(r).map((l) => `${path}: ${l}`));
  return parseYaml(readFileSync(path, "utf8")).data as AppData;
}

/**
 * The app's environments in delivery order: build environments first (instance order), then each
 * promotion environment after its promoteFrom environment.
 */
export function orderedEnvironments(app: AppData, inst: Instance): InstanceEnv[] {
  return orderEnvironments(
    inst.environments.filter((e) => Object.hasOwn(app.environments, e.name)),
    `app ${app.slug}: the promoteFrom chain of its environments cannot be ordered (missing source or cycle).`,
  );
}

/** All instance environments in the same order (the provisioning pipeline's stage order). */
export function instanceEnvironmentsOrdered(inst: Instance): InstanceEnv[] {
  return orderEnvironments(inst.environments, "instance.yaml: the promoteFrom chain of the environments cannot be ordered (missing source or cycle).");
}

function orderEnvironments(wanted: InstanceEnv[], problem: string): InstanceEnv[] {
  const placed: InstanceEnv[] = wanted.filter((e) => !e.promoteFrom);
  const done = new Set<string>(placed.map((e) => e.name));
  let progress = true;
  while (placed.length < wanted.length && progress) {
    progress = false;
    for (const e of wanted) {
      if (done.has(e.name)) continue;
      if (!e.promoteFrom || done.has(e.promoteFrom)) {
        placed.push(e);
        done.add(e.name);
        progress = true;
      }
    }
  }
  if (placed.length < wanted.length) throw new CheckFailed([problem]);
  return placed;
}

/** scm.azureDevOps.platformConfigDefaultBranch (short name, schema default "main"). */
export function platformConfigDefaultBranch(inst: Instance): string {
  return inst.scm.azureDevOps?.platformConfigDefaultBranch ?? instanceDefault<string>("$defs/scm/properties/azureDevOps/properties/platformConfigDefaultBranch");
}

/** approvals.entraChanges, or the schema's default (pullRequest). */
export function entraChangesMode(inst: Pick<Instance, "approvals">): EntraChanges {
  return inst.approvals?.entraChanges ?? instanceDefault<EntraChanges>("properties/approvals/properties/entraChanges");
}

export function instanceEnv(inst: Instance, name: string): InstanceEnv {
  const e = inst.environments.find((x) => x.name === name);
  if (!e) throw new CheckFailed([`instance.yaml has no environment "${name}".`]);
  return e;
}

/**
 * What names an environment's vault besides the prefix and the environment (landing-zone.bicep and
 * names.bicep environmentVault): environments[].vaultGeneration and networkModes.externalOnly.network,
 * schema defaults applied. The landing zone's inputs (`inputs --step lz`) and prov-lib.sh's names.bicep
 * evaluation (prov_vault_inputs, ADR-0060) both take them from here.
 */
export function environmentVaultInputs(env: InstanceEnv): { vaultGeneration: number; externalOnlyNetwork: "managed" | "vnet" } {
  return {
    vaultGeneration: env.vaultGeneration ?? instanceDefault<number>("$defs/environment/properties/vaultGeneration"),
    externalOnlyNetwork: env.networkModes.externalOnly?.network ?? instanceDefault<"managed" | "vnet">("$defs/externalOnlyMode/properties/network"),
  };
}

/** The environment vault variant a mode uses, as landing-zone.bicep picks it: private when VNet-based. */
export function environmentVaultVariant(networkMode: unknown, externalOnlyNetwork: unknown): "public" | "private" | undefined {
  if (networkMode === "externalHybrid") return "private";
  if (networkMode !== "externalOnly") return undefined;
  return externalOnlyNetwork === "vnet" ? "private" : externalOnlyNetwork === "managed" ? "public" : undefined;
}

/**
 * The network modes of iteration 1 (externalOnly, externalHybrid) the environment offers, each with the
 * environment vault variant it uses (ADR-0060): environment.bicep creates the public vault for an
 * External-only variant on the managed network and the private one for a VNet-based mode, so the plan
 * lists the secrets of exactly these vaults, named by names.bicep for a mode of each variant.
 */
export function offeredModes(env: InstanceEnv): { mode: "externalOnly" | "externalHybrid"; variant: "public" | "private" }[] {
  const out: { mode: "externalOnly" | "externalHybrid"; variant: "public" | "private" }[] = [];
  const network = environmentVaultInputs(env).externalOnlyNetwork;
  if (env.networkModes.externalOnly) out.push({ mode: "externalOnly", variant: network === "vnet" ? "private" : "public" });
  if (env.networkModes.externalHybrid) out.push({ mode: "externalHybrid", variant: "private" });
  return out;
}
