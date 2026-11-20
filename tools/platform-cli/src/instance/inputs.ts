import { parseBootstrapOutputs } from "../ado/bootstrap.js";
import type { BootstrapOutputs, Federation } from "../ado/bootstrap.js";
import { instanceServiceConnection, provisioningServiceConnection } from "../ado/names.js";
import { CheckFailed, KiB, UsageError, isObject, own, readJson } from "../pipeline/common.js";
import { provisioningHostEnvironment } from "../provisioning/generate.js";
import { instanceDefault, instanceEnv, loadInstanceFile } from "../provisioning/model.js";
import type { Instance, InstanceEnv } from "../provisioning/model.js";
import { platformDeployment, portalDeployment } from "../provisioning/names.js";
import { bootstrapDeployment } from "./facts.js";

/**
 * `platform instance inputs <template>` (ADR-0066): the JSON infra/platform/instance/<template>.bicepparam
 * reads (SAF_INSTANCE_JSON) for the templates a person runs while onboarding an instance, from
 * instance.yaml and the instance's state (deployment outputs and the service connections' federation,
 * which instance.sh reads from Azure and Azure DevOps). Pure: files in, JSON out, no Azure calls. Every
 * schema default is resolved and a missing value fails here, so the parameter files take nothing else:
 *
 *   bootstrap (--env, --pass 1|2)  prefix, environmentName, location (region ?? defaultRegion),
 *       instanceIdentities (the environment is portal.hostEnvironment), entraEnvironments (every
 *       environment, list order, in the host; [] elsewhere), federation ({} on pass 1; on pass 2 the
 *       environment's entry of --federation, provisioning and in the host adoAutomation and entra, each
 *       required), instancePrincipals ({} in the host; elsewhere the host's bootstrap outputs
 *       portalIdentity.principalId and entraProvisioningIdentity.principalId, --outputs <host>=<file>),
 *       managedBy (productName), tags ({})
 *   roles                          prefix, environmentSubscriptionIds (every environment's, list order,
 *       each once)
 *   entra-permissions              entraProvisioningPrincipalId (the host's bootstrap output)
 *   portal-registration            prefix, environmentName and environmentKind (the host's), productName,
 *       caeDefaultDomain (--portal-outputs: managedEnvironmentDefaultDomain of portal-{prefix}-{host}),
 *       devRedirectUris (--dev-redirect-uri, nonprod host only), platformAdminsGroupId, platformTeamGroupId,
 *       tenantId, portalIdentityPrincipalId (the host's bootstrap output portalIdentity.principalId)
 *   entra-audit-alert              prefix, location (the host's region, or --workspace-location),
 *       workspaceResourceId (--workspace, else the host's platform workspace: --platform-outputs
 *       logAnalyticsWorkspaceId of platform-{prefix}-{host}), entraProvisioningPrincipalId (the host's
 *       bootstrap output), actionGroupIds (the host's platform action group platformActionGroupId, then
 *       each --action-group), tags ({ManagedBy: productName})
 *
 * GUIDs are lowercased. Bootstrap outputs whose tenant or subscription isn't the instance's fail.
 */

export const INSTANCE_TEMPLATES = ["bootstrap", "roles", "entra-permissions", "portal-registration", "entra-audit-alert"] as const;
export type InstanceTemplate = (typeof INSTANCE_TEMPLATES)[number];

const ENV_FILE_RE = /^([a-z][a-z0-9]{1,7})=(.+)$/;
const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RESOURCE_ID_RE = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/[^/]+\/[^/]+\/[^/]+$/;

/** The state files `inputs` and `sync` take: each is optional here; a template that needs one fails without it. */
export interface InstanceState {
  /** Bootstrap outputs per environment (az deployment sub show -n bootstrap-{prefix}-{env} --query properties.outputs). */
  outputs: Record<string, BootstrapOutputs>;
  /** `federation` of `platform ado bootstrap plan|apply --phase connections --output`. */
  federation?: Record<string, Record<string, Federation | null | undefined>>;
  /** Outputs of portal-{prefix}-{host} (portal.bicep). */
  portal?: Record<string, unknown>;
  /** Outputs of entra-portal-{host} (portal-registration.bicep). */
  registration?: Record<string, unknown>;
  /** Outputs of platform-{prefix}-{host} (environment.bicep). */
  platform?: Record<string, unknown>;
}

export interface InputOptions {
  env?: string;
  pass?: string;
  devRedirectUris?: string[];
  workspace?: string;
  workspaceLocation?: string;
  actionGroups?: string[];
}

/** ARM deployment outputs ({name: {type, value}}), the whole `az deployment ... show`, or plain values: name -> value. */
export function deploymentOutputs(v: unknown, label: string): Record<string, unknown> {
  let o = v;
  if (isObject(o) && isObject(own(o, "properties")) && isObject(own(own(o, "properties") as Record<string, unknown>, "outputs"))) {
    o = own(own(o, "properties") as Record<string, unknown>, "outputs");
  }
  if (!isObject(o)) throw new CheckFailed([`${label} must be a deployment's outputs (a JSON object).`]);
  const out: Record<string, unknown> = {};
  for (const [k, e] of Object.entries(o)) out[k] = isObject(e) && Object.hasOwn(e, "type") ? (Object.hasOwn(e, "value") ? e.value : null) : e;
  return out;
}

/** --outputs <env>=<file>: bootstrap outputs of an environment of this instance, for its tenant and subscription. */
export function bootstrapOutputsArg(inst: Instance, spec: string): [string, BootstrapOutputs] {
  const m = ENV_FILE_RE.exec(spec);
  if (!m) throw new UsageError(`--outputs must be <env>=<file> (got "${spec.slice(0, 60)}").`);
  const env = inst.environments.find((e) => e.name === m[1]);
  if (!env) throw new CheckFailed([`--outputs ${m[1]!}: not an environment of this instance.`]);
  const label = `--outputs ${env.name}`;
  const o = parseBootstrapOutputs(readJson(m[2]!, 256 * KiB, label), label);
  const problems: string[] = [];
  if (o.tenantId.toLowerCase() !== (inst.tenantId ?? "").toLowerCase()) problems.push(`${label} is for tenant ${o.tenantId}, not this instance's tenantId ${String(inst.tenantId)}.`);
  if (o.subscriptionId.toLowerCase() !== env.subscriptionId.toLowerCase()) problems.push(`${label} is for subscription ${o.subscriptionId}, not environment ${env.name}'s ${env.subscriptionId}.`);
  if (problems.length) throw new CheckFailed(problems);
  return [env.name, o];
}

/** --federation <file>: the `federation` of `platform ado bootstrap plan|apply --phase connections --output`. */
export function federationArg(path: string): NonNullable<InstanceState["federation"]> {
  const v = readJson(path, 1024 * KiB, "--federation");
  const f = isObject(v) ? own(v, "federation") : undefined;
  if (!isObject(f)) throw new CheckFailed(["--federation has no federation: it must be the --output of platform ado bootstrap plan|apply --phase connections."]);
  return f as NonNullable<InstanceState["federation"]>;
}

const location = (inst: Instance, env: InstanceEnv): string => env.region ?? inst.defaultRegion;
const productName = (inst: Instance): string => inst.productName ?? instanceDefault<string>("properties/productName");
const lowerGuid = (v: string): string => (GUID_RE.test(v) ? v.toLowerCase() : v);

function hostOutputs(inst: Instance, state: InstanceState, why: string): BootstrapOutputs {
  const host = provisioningHostEnvironment(inst);
  const o = Object.hasOwn(state.outputs, host) ? state.outputs[host] : undefined;
  if (!o) {
    throw new CheckFailed([
      `${why} needs the bootstrap outputs of the portal host environment ${host} (--outputs ${host}=<file>, deployment ${bootstrapDeployment(inst.naming.prefix, host)}): bootstrap ${host} first.`,
    ]);
  }
  return o;
}

function hostPrincipal(inst: Instance, state: InstanceState, key: "portalIdentity" | "entraProvisioningIdentity", why: string): string {
  const o = hostOutputs(inst, state, why);
  const id = o[key];
  if (!id) {
    throw new CheckFailed([
      `the bootstrap outputs of ${provisioningHostEnvironment(inst)} (portal.hostEnvironment) have no ${key}: run that environment's bootstrap with this core version (instanceIdentities true there).`,
    ]);
  }
  return id.principalId.toLowerCase();
}

function bootstrapInputs(inst: Instance, state: InstanceState, opts: InputOptions): Record<string, unknown> {
  if (!opts.env) throw new UsageError("bootstrap needs --env <name>.");
  if (opts.pass !== "1" && opts.pass !== "2") throw new UsageError("bootstrap needs --pass 1 (no federation yet) or 2 (the federated credentials of the service connections).");
  const env = instanceEnv(inst, opts.env);
  const host = provisioningHostEnvironment(inst);
  const isHost = env.name === host;
  const federation: Record<string, Federation> = {};
  if (opts.pass === "2") {
    if (!state.federation) {
      throw new CheckFailed([
        `bootstrap pass 2 needs --federation <file>: the --output of platform ado bootstrap plan --phase connections (the service connections' issuer and subject, read back from Azure DevOps).`,
      ]);
    }
    const entry = Object.hasOwn(state.federation, env.name) ? state.federation[env.name] : undefined;
    const wanted: [string, string][] = [["provisioning", provisioningServiceConnection(env.name)]];
    if (isHost) wanted.push(["adoAutomation", instanceServiceConnection("ado")], ["entra", instanceServiceConnection("entra")]);
    const problems: string[] = [];
    for (const [purpose, connection] of wanted) {
      const f = isObject(entry) ? own(entry, purpose) : undefined;
      if (!isObject(f) || typeof own(f, "issuer") !== "string" || typeof own(f, "subject") !== "string") {
        problems.push(
          `--federation has no issuer and subject of ${connection} (environment ${env.name}, ${purpose}): the service connection doesn't exist yet, so run platform ado bootstrap apply --phase connections first (a blocked row there says why).`,
        );
        continue;
      }
      const issuer = own(f, "issuer") as string;
      const subject = own(f, "subject") as string;
      if (!issuer.startsWith("https://") || !subject.trim()) problems.push(`--federation ${env.name} ${purpose}: the issuer must be an https:// URL and the subject not empty.`);
      federation[purpose] = { issuer, subject };
    }
    if (problems.length) throw new CheckFailed(problems);
  } else if (state.federation) {
    throw new UsageError("--federation applies to --pass 2 only (pass 1 has no federated credential).");
  }
  return {
    prefix: inst.naming.prefix,
    environmentName: env.name,
    location: location(inst, env),
    instanceIdentities: isHost,
    entraEnvironments: isHost ? inst.environments.map((e) => e.name) : [],
    federation,
    instancePrincipals: isHost
      ? {}
      : {
          portal: hostPrincipal(inst, state, "portalIdentity", `the bootstrap of ${env.name} (not the portal host)`),
          entraProvisioning: hostPrincipal(inst, state, "entraProvisioningIdentity", `the bootstrap of ${env.name} (not the portal host)`),
        },
    managedBy: productName(inst),
    tags: {},
  };
}

function rolesInputs(inst: Instance): Record<string, unknown> {
  const ids: string[] = [];
  for (const e of inst.environments) {
    const id = e.subscriptionId.toLowerCase();
    if (!ids.includes(id)) ids.push(id);
  }
  return { prefix: inst.naming.prefix, environmentSubscriptionIds: ids };
}

function stringOutput(outputs: Record<string, unknown> | undefined, key: string, problem: string): string {
  const v = outputs ? own(outputs, key) : undefined;
  if (typeof v !== "string" || !v.trim()) throw new CheckFailed([problem]);
  return v;
}

function portalRegistrationInputs(inst: Instance, state: InstanceState, opts: InputOptions): Record<string, unknown> {
  const hostName = provisioningHostEnvironment(inst);
  const host = instanceEnv(inst, hostName);
  const deployment = portalDeployment(inst.naming.prefix, hostName);
  if (!state.portal) {
    throw new CheckFailed([
      `the portal registration needs the portal environment's domain: --portal-outputs <file>, the outputs of ${deployment} (portal pass 1, by the platform pipeline of ${hostName}).`,
    ]);
  }
  const domain = stringOutput(state.portal, "managedEnvironmentDefaultDomain", `--portal-outputs has no managedEnvironmentDefaultDomain: ${deployment} must be portal pass 1 or later of this core version.`);
  const dev = opts.devRedirectUris ?? [];
  if (dev.length && host.kind !== "nonprod") {
    throw new CheckFailed([`--dev-redirect-uri: localhost redirect URIs are allowed only on a nonprod portal host, and ${hostName} is ${host.kind}.`]);
  }
  const team = inst.approvals?.platformTeam?.objectId;
  const admins = inst.platformAdmins?.objectId;
  if (!admins || !team || !inst.tenantId) throw new CheckFailed(["instance.yaml needs tenantId, platformAdmins.objectId and approvals.platformTeam.objectId for the portal registration."]);
  return {
    prefix: inst.naming.prefix,
    environmentName: hostName,
    environmentKind: host.kind,
    productName: productName(inst),
    caeDefaultDomain: domain,
    devRedirectUris: dev,
    platformAdminsGroupId: lowerGuid(admins),
    platformTeamGroupId: lowerGuid(team),
    tenantId: lowerGuid(inst.tenantId),
    portalIdentityPrincipalId: hostPrincipal(inst, state, "portalIdentity", "the portal registration"),
  };
}

function auditAlertInputs(inst: Instance, state: InstanceState, opts: InputOptions): Record<string, unknown> {
  const hostName = provisioningHostEnvironment(inst);
  const host = instanceEnv(inst, hostName);
  const deployment = platformDeployment(inst.naming.prefix, hostName);
  if (!state.platform) {
    throw new CheckFailed([
      `the Entra audit alert needs the host's platform deployment: --platform-outputs <file>, the outputs of ${deployment} (the platform pipeline of ${hostName}): its action group, and its workspace unless --workspace names another.`,
    ]);
  }
  if ((opts.workspace === undefined) !== (opts.workspaceLocation === undefined)) {
    throw new UsageError("--workspace and --workspace-location go together (the workspace that receives the tenant's Entra audit log, and its region).");
  }
  const workspace = opts.workspace ?? stringOutput(state.platform, "logAnalyticsWorkspaceId", `--platform-outputs has no logAnalyticsWorkspaceId (${deployment}).`);
  const platformGroup = stringOutput(state.platform, "platformActionGroupId", `--platform-outputs has no platformActionGroupId (${deployment}).`);
  const problems: string[] = [];
  if (!RESOURCE_ID_RE.test(workspace) || !/\/providers\/microsoft\.operationalinsights\/workspaces\//i.test(workspace)) problems.push("the workspace must be the resource ID of a Log Analytics workspace.");
  const groups = [platformGroup, ...(opts.actionGroups ?? [])];
  for (const g of groups) if (!RESOURCE_ID_RE.test(g) || !/\/providers\/microsoft\.insights\/actiongroups\//i.test(g)) problems.push(`action group ${g.slice(0, 200)} is not the resource ID of an action group.`);
  if (new Set(groups.map((g) => g.toLowerCase())).size !== groups.length) problems.push("an action group is listed twice.");
  if (problems.length) throw new CheckFailed(problems);
  return {
    prefix: inst.naming.prefix,
    location: opts.workspaceLocation ?? location(inst, host),
    workspaceResourceId: workspace,
    entraProvisioningPrincipalId: hostPrincipal(inst, state, "entraProvisioningIdentity", "the Entra audit alert"),
    actionGroupIds: groups,
    tags: { ManagedBy: productName(inst) },
  };
}

export function instanceInputs(template: InstanceTemplate, inst: Instance, state: InstanceState, opts: InputOptions = {}): Record<string, unknown> {
  if (template !== "bootstrap" && (opts.env !== undefined || opts.pass !== undefined)) throw new UsageError("--env and --pass apply to bootstrap only.");
  if (template !== "bootstrap" && state.federation) throw new UsageError("--federation applies to bootstrap only.");
  if (template !== "portal-registration" && (opts.devRedirectUris?.length || state.portal)) throw new UsageError("--dev-redirect-uri and --portal-outputs apply to portal-registration only.");
  if (template !== "entra-audit-alert" && (opts.workspace !== undefined || opts.workspaceLocation !== undefined || opts.actionGroups?.length || state.platform)) {
    throw new UsageError("--workspace, --workspace-location, --action-group and --platform-outputs apply to entra-audit-alert only.");
  }
  switch (template) {
    case "bootstrap":
      return bootstrapInputs(inst, state, opts);
    case "roles":
      return rolesInputs(inst);
    case "entra-permissions":
      return { entraProvisioningPrincipalId: hostPrincipal(inst, state, "entraProvisioningIdentity", "the Graph permissions") };
    case "portal-registration":
      return portalRegistrationInputs(inst, state, opts);
    case "entra-audit-alert":
      return auditAlertInputs(inst, state, opts);
  }
}

export interface StateFiles {
  outputs?: string[];
  federation?: string;
  portalOutputs?: string;
  registration?: string;
  platformOutputs?: string;
}

/** Reads the state files: bootstrap outputs (checked against the instance), federation and deployment outputs. */
export function loadState(inst: Instance, files: StateFiles): InstanceState {
  const state: InstanceState = { outputs: {} };
  for (const spec of files.outputs ?? []) {
    const [env, o] = bootstrapOutputsArg(inst, spec);
    if (Object.hasOwn(state.outputs, env)) throw new UsageError(`--outputs ${env} is given twice.`);
    state.outputs[env] = o;
  }
  if (files.federation !== undefined) state.federation = federationArg(files.federation);
  if (files.portalOutputs !== undefined) state.portal = deploymentOutputs(readJson(files.portalOutputs, 1024 * KiB, "--portal-outputs"), "--portal-outputs");
  if (files.registration !== undefined) state.registration = deploymentOutputs(readJson(files.registration, 256 * KiB, "--registration"), "--registration");
  if (files.platformOutputs !== undefined) state.platform = deploymentOutputs(readJson(files.platformOutputs, 1024 * KiB, "--platform-outputs"), "--platform-outputs");
  return state;
}

export function instanceInputsFiles(template: string, args: { instance: string } & StateFiles & InputOptions): Record<string, unknown> {
  if (!(INSTANCE_TEMPLATES as readonly string[]).includes(template)) {
    throw new UsageError(`unknown template "${template.slice(0, 40)}"; templates: ${INSTANCE_TEMPLATES.join(", ")}.`);
  }
  const inst = loadInstanceFile(args.instance);
  return instanceInputs(template as InstanceTemplate, inst, loadState(inst, args), args);
}
