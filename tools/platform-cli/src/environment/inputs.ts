import { CheckFailed, DIGEST_RE, KiB, isObject, own, readJson } from "../pipeline/common.js";
import { instanceDefault, instanceEnv, loadInstanceFile, platformConfigDefaultBranch } from "../provisioning/model.js";
import type { ConnectedMode, DbSize, Instance, InstanceEnv } from "../provisioning/model.js";

/**
 * `platform environment inputs` (ADR-0043): the JSON infra/platform/pipeline/environment.bicepparam
 * reads (SAF_ENVIRONMENT_JSON) for one environment, from instance.yaml and core's images/images.json,
 * with every schema default resolved, so the parameter file takes nothing else:
 *
 *   prefix, environmentName, environmentKind, location (region ?? defaultRegion), vaultGeneration,
 *   networkModes (externalOnly: network, and for vnet its prefixes and natGatewayPublicIpCount;
 *   externalHybrid: vnet, prefixes, routeTableId, dnsServers, egress fields), hub (or null),
 *   frontDoor (this environment's managed profile, or null), logRetentionDays, platformAlertEmails
 *   (notifications.email.platformTeamAddress), managedBy (productName), tags ({}),
 *   platformJobsImageDigest (pass 1: '', pass 2: images.json saf-jobs), entraProvisioningPrincipalId
 *   (identities.entraProvisioningPrincipalId, required), portalIdentityPrincipalId
 *   (portal.identityPrincipalId or '').
 *
 * Pass 1 is a new environment's first deployment (no platform registry yet, so no job: ADR-0035);
 * pass 2 every other one. internalOnly is not built in this core version and fails here.
 */

export type EnvironmentPass = 1 | 2;

/** The digest of one core image pinned in core's images/images.json (saf-jobs, saf-portal). */
export function pinnedImageDigest(imagesPath: string, image: "saf-jobs" | "saf-portal"): string {
  const images = readJson(imagesPath, 256 * KiB, "--images");
  const entry = isObject(images) && isObject(own(images, "images")) ? own(own(images, "images") as Record<string, unknown>, image) : undefined;
  const digest = isObject(entry) ? own(entry, "digest") : undefined;
  if (typeof digest !== "string" || !DIGEST_RE.test(digest)) throw new CheckFailed([`--images has no valid images["${image}"].digest (sha256:<64 hex>).`]);
  return digest;
}

/** The saf-jobs digest pinned in core's images/images.json. */
export function pinnedJobsDigest(imagesPath: string): string {
  return pinnedImageDigest(imagesPath, "saf-jobs");
}

function connected(m: ConnectedMode, label: string): Record<string, unknown> {
  const vnet = m.vnet?.existingVnetId !== undefined
    ? { existingVnetId: m.vnet.existingVnetId }
    : m.vnet?.create !== undefined
      ? { create: { addressSpace: m.vnet.create.addressSpace, useRemoteGateways: m.vnet.create.useRemoteGateways ?? false } }
      : undefined;
  if (!vnet || !m.caeSubnetPrefix || !m.privateEndpointSubnetPrefix || !m.routeTableId) {
    throw new CheckFailed([`${label} needs vnet, caeSubnetPrefix, privateEndpointSubnetPrefix and routeTableId (the schema requires them).`]);
  }
  return {
    vnet,
    caeSubnetPrefix: m.caeSubnetPrefix,
    privateEndpointSubnetPrefix: m.privateEndpointSubnetPrefix,
    routeTableId: m.routeTableId,
    dnsServers: m.dnsServers ?? instanceDefault<string[]>("$defs/connectedMode/properties/dnsServers"),
    ...(m.egressAllowListProcess !== undefined ? { egressAllowListProcess: m.egressAllowListProcess } : {}),
    ...(m.egressBaseline !== undefined ? { egressBaseline: m.egressBaseline } : {}),
  };
}

/** environments[].networkModes with the defaults resolved, in the shape of types.networkModesConfig. */
export function networkModesInput(env: InstanceEnv): Record<string, unknown> {
  const modes = env.networkModes;
  if (modes.internalOnly !== undefined) throw new CheckFailed([`environment ${env.name}: networkModes.internalOnly is not built in this core version (iteration 2).`]);
  const out: Record<string, unknown> = {};
  const ext = modes.externalOnly;
  if (ext !== undefined) {
    const network = ext.network ?? instanceDefault<string>("$defs/externalOnlyMode/properties/network");
    out.externalOnly = network === "vnet"
      ? {
          network,
          vnetAddressSpace: ext.vnetAddressSpace,
          caeSubnetPrefix: ext.caeSubnetPrefix,
          privateEndpointSubnetPrefix: ext.privateEndpointSubnetPrefix,
          natGatewayPublicIpCount: ext.natGatewayPublicIpCount ?? instanceDefault<number>("$defs/externalOnlyMode/properties/natGatewayPublicIpCount"),
        }
      : { network };
  }
  if (modes.externalHybrid !== undefined) out.externalHybrid = connected(modes.externalHybrid, `environment ${env.name}: networkModes.externalHybrid`);
  return out;
}

/** The network modes with a CAE (the keys names.bicep takes). */
export function enabledModes(env: InstanceEnv): ("externalOnly" | "externalHybrid")[] {
  return (["externalOnly", "externalHybrid"] as const).filter((m) => env.networkModes[m] !== undefined);
}

/** This environment's managed Front Door profile, or null (frontDoor.mode external or not listed). */
export function frontDoorInput(inst: Instance, envName: string): Record<string, unknown> | null {
  const mode = inst.frontDoor?.mode ?? instanceDefault<string>("properties/frontDoor/properties/mode");
  if (mode !== "managed") return null;
  const profile = (inst.frontDoor?.managed?.profiles ?? []).find((p) => p.environment === envName);
  return profile ? (JSON.parse(JSON.stringify(profile)) as Record<string, unknown>) : null;
}

export function environmentInputs(inst: Instance, envName: string, digest: string, pass: EnvironmentPass): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const entra = inst.identities?.entraProvisioningPrincipalId;
  if (typeof entra !== "string" || entra === "") {
    throw new CheckFailed([
      "instance.yaml identities.entraProvisioningPrincipalId is required by the platform pipeline: the bootstrap output entraProvisioningIdentity.principalId of the portal host environment (ADR-0043).",
    ]);
  }
  const team = inst.notifications?.email?.platformTeamAddress;
  return {
    prefix: inst.naming.prefix,
    environmentName: env.name,
    environmentKind: env.kind,
    location: env.region ?? inst.defaultRegion,
    vaultGeneration: env.vaultGeneration ?? instanceDefault<number>("$defs/environment/properties/vaultGeneration"),
    networkModes: networkModesInput(env),
    hub: env.hub ?? null,
    frontDoor: frontDoorInput(inst, env.name),
    logRetentionDays: inst.observability?.logRetentionDays ?? instanceDefault<number>("properties/observability/properties/logRetentionDays"),
    platformAlertEmails: team ? [team] : [],
    managedBy: inst.productName ?? instanceDefault<string>("properties/productName"),
    tags: {},
    platformJobsImageDigest: pass === 1 ? "" : digest,
    entraProvisioningPrincipalId: entra.toLowerCase(),
    portalIdentityPrincipalId: (inst.portal?.identityPrincipalId ?? "").toLowerCase(),
  };
}

export function environmentInputsFiles(args: { instance: string; env: string; images: string; pass: string }): Record<string, unknown> {
  if (args.pass !== "1" && args.pass !== "2") throw new CheckFailed(["--pass must be 1 (a new environment: no platform job yet) or 2."]);
  const inst = loadInstanceFile(args.instance);
  return environmentInputs(inst, args.env, pinnedJobsDigest(args.images), args.pass === "1" ? 1 : 2);
}

/**
 * `platform environment portal-inputs` (ADR-0043 decision 10): the JSON
 * infra/platform/pipeline/portal.bicepparam reads (SAF_PORTAL_JSON) for the portal host environment
 * (portal.hostEnvironment; any other environment fails), schema defaults resolved:
 *
 *   prefix, environmentName, environmentKind, location (region ?? defaultRegion), tenantId,
 *   network (portal.network; routeTableId fails: portal.bicep can't peer the portal VNet yet),
 *   azureDevOps (organizationUrl, platformProject, platformConfigRepo, platformConfigDefaultBranch:
 *   only what the portal reads, so another allowedProjects doesn't redeploy it), database
 *   (data.postgres.sizes.S and version; data.backup of the host's kind, as an app database there),
 *   portalImageDigest (pass 1: '', pass 2: images.json saf-portal), portalClientId (pass 1: '',
 *   pass 2: portal.clientId, required), vaultGeneration (the host's), environmentVault (private when
 *   the host environment has a VNet-based CAE, else public: the vault of the portal's own secrets,
 *   ADR-0025), smtpPasswordSecretName (notifications.email.smtp.auth.passwordSecretName with provider
 *   smtp and auth mode basic, else ''), smtpPasswordSecretExists (--smtp-secret present: the pipeline
 *   read the secret in that vault through ARM; absent by default), managedBy (productName), tags ({}).
 *
 * Pass 1 is everything but the Container App (the portal registration needs the CAE's default
 * domain first); pass 2 adds the Container App. `auto` is the pass the instance is ready for: 2 once
 * portal.clientId is set, else 1. GUIDs are lowercased.
 */

export type PortalPass = 1 | 2 | "auto";
/** Whether the SMTP password secret exists in the host's environment vault (the pipeline reads it). */
export type SmtpSecretState = "present" | "absent";

/** The host environment has a VNet-based CAE (externalHybrid, or externalOnly with network vnet): its private environment vault exists (environment.bicep needsPrivateVault). */
export function hasPrivateEnvironmentVault(env: InstanceEnv): boolean {
  const ext = env.networkModes.externalOnly;
  const extNetwork = ext === undefined ? undefined : (ext.network ?? instanceDefault<string>("$defs/externalOnlyMode/properties/network"));
  return env.networkModes.externalHybrid !== undefined || extNetwork === "vnet";
}

/** notifications.email.smtp.auth.passwordSecretName with provider smtp and auth mode basic, else '' (no SMTP password). */
export function smtpPasswordSecretName(inst: Instance): string {
  const email = inst.notifications?.email;
  if (email?.provider !== "smtp" || email.smtp?.auth?.mode !== "basic") return "";
  return email.smtp.auth.passwordSecretName ?? "";
}

/** The portal database's size: data.postgres.sizes.S and data.postgres.version (ADR-0038). */
function portalDatabaseSize(inst: Instance): Record<string, unknown> {
  const p = inst.data?.postgres;
  const sizes = p?.sizes ?? instanceDefault<Record<string, DbSize>>("$defs/dataDefaults/properties/postgres/properties/sizes");
  const s = Object.hasOwn(sizes, "S") ? sizes.S : undefined;
  if (!s) throw new CheckFailed(["instance.yaml data.postgres.sizes has no size S (the portal database's size, ADR-0038)."]);
  if (!s.tier || s.storageGb === undefined) throw new CheckFailed(["instance.yaml data.postgres.sizes.S needs tier and storageGb (the portal database's size, ADR-0038)."]);
  return {
    skuName: s.sku,
    tier: s.tier,
    storageGb: s.storageGb,
    version: p?.version ?? instanceDefault<string>("$defs/dataDefaults/properties/postgres/properties/version"),
  };
}

export function portalInputs(inst: Instance, envName: string, digest: string, pass: PortalPass, smtpSecret: SmtpSecretState = "absent"): Record<string, unknown> {
  const env = instanceEnv(inst, envName);
  const portal = inst.portal;
  if (portal?.hostEnvironment !== env.name) {
    throw new CheckFailed([
      `environment ${env.name} is not portal.hostEnvironment (${String(portal?.hostEnvironment).slice(0, 40)}): only the host environment's platform pipeline deploys the portal.`,
    ]);
  }
  const problems: string[] = [];
  const net = portal.network;
  if (!net) problems.push("instance.yaml portal.network is required (the portal VNet).");
  if (net?.routeTableId !== undefined) {
    problems.push(
      "instance.yaml portal.network.routeTableId is not available in this core version: a hub connection needs the portal VNet peered to the hub, which portal.bicep does not create yet (ADR-0025). Remove it; the portal egresses through its NAT Gateway.",
    );
  }
  const ado = inst.scm.provider === "azureDevOps" ? inst.scm.azureDevOps : undefined;
  if (!ado?.organizationUrl || !ado.platformConfigRepo) {
    problems.push("instance.yaml scm.azureDevOps with organizationUrl and platformConfigRepo is required: the portal reads platform-config through Azure DevOps.");
  }
  if (!inst.tenantId) problems.push("instance.yaml tenantId is required: the portal validates tokens against it.");
  const clientId = (portal.clientId ?? "").toLowerCase();
  const effective: 1 | 2 = pass === "auto" ? (clientId ? 2 : 1) : pass;
  if (effective === 2 && !clientId) {
    problems.push(
      "instance.yaml portal.clientId is required for pass 2 (the Container App): the client ID of the portal registration (infra/entra/portal-registration.bicep), which a person creates after pass 1.",
    );
  }
  // The schema requires passwordSecretName with auth mode basic (loadInstanceFile validates it).
  const secretName = smtpPasswordSecretName(inst);
  if (smtpSecret === "present" && !secretName) {
    problems.push("--smtp-secret present needs SMTP with a password in instance.yaml (notifications.email provider smtp, smtp.auth.mode basic).");
  }
  if (problems.length || !net || !ado) throw new CheckFailed(problems);
  const prod = env.kind === "prod";
  const backup = "$defs/dataDefaults/properties/backup/properties";
  return {
    prefix: inst.naming.prefix,
    environmentName: env.name,
    environmentKind: env.kind,
    location: env.region ?? inst.defaultRegion,
    tenantId: inst.tenantId!.toLowerCase(),
    network: {
      vnetAddressSpace: net.vnetAddressSpace,
      caeSubnetPrefix: net.caeSubnetPrefix,
      privateEndpointSubnetPrefix: net.privateEndpointSubnetPrefix,
      ...(net.approvalReference !== undefined ? { approvalReference: net.approvalReference } : {}),
    },
    azureDevOps: {
      organizationUrl: ado.organizationUrl,
      platformProject: ado.platformProject,
      platformConfigRepo: ado.platformConfigRepo,
      platformConfigDefaultBranch: platformConfigDefaultBranch(inst),
    },
    database: {
      size: portalDatabaseSize(inst),
      backupRetentionDays: prod
        ? (inst.data?.backup?.retentionDaysProd ?? instanceDefault<number>(`${backup}/retentionDaysProd`))
        : (inst.data?.backup?.retentionDaysNonprod ?? instanceDefault<number>(`${backup}/retentionDaysNonprod`)),
      geoRedundantBackup: prod ? (inst.data?.backup?.geoRedundantProd ?? instanceDefault<boolean>(`${backup}/geoRedundantProd`)) : false,
    },
    portalImageDigest: effective === 1 ? "" : digest,
    portalClientId: effective === 1 ? "" : clientId,
    vaultGeneration: env.vaultGeneration ?? instanceDefault<number>("$defs/environment/properties/vaultGeneration"),
    environmentVault: hasPrivateEnvironmentVault(env) ? "private" : "public",
    smtpPasswordSecretName: secretName,
    smtpPasswordSecretExists: secretName !== "" && smtpSecret === "present",
    managedBy: inst.productName ?? instanceDefault<string>("properties/productName"),
    tags: {},
  };
}


export function portalInputsFiles(args: { instance: string; env: string; images: string; pass: string; smtpSecret?: string }): Record<string, unknown> {
  if (args.pass !== "1" && args.pass !== "2" && args.pass !== "auto") {
    throw new CheckFailed(["--pass must be 1 (no Container App), 2 (the Container App; needs portal.clientId) or auto (2 once portal.clientId is set, else 1)."]);
  }
  if (args.smtpSecret !== undefined && args.smtpSecret !== "present" && args.smtpSecret !== "absent") {
    throw new CheckFailed(["--smtp-secret must be present or absent (whether the SMTP password secret exists in the host's environment vault)."]);
  }
  const inst = loadInstanceFile(args.instance);
  const pass: PortalPass = args.pass === "auto" ? "auto" : args.pass === "1" ? 1 : 2;
  return portalInputs(inst, args.env, pinnedImageDigest(args.images, "saf-portal"), pass, (args.smtpSecret ?? "absent") as SmtpSecretState);
}
