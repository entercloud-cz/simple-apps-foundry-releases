import { identitiesLock, identitiesResourceGroup } from "../ado/names.js";
import { CheckFailed } from "../pipeline/common.js";
import { ZONE_ID_RE } from "../provisioning/frontdoor-plan.js";
import { provisioningHostEnvironment } from "../provisioning/generate.js";
import { entraChangesMode, instanceDefault } from "../provisioning/model.js";
import type { Instance } from "../provisioning/model.js";
import { entraResourceGroup, platformDeployment, portalDeployment, portalEntraDeployment } from "../provisioning/names.js";

/**
 * `platform instance facts` (ADR-0066): what infra/platform/instance/instance.sh needs from instance.yaml
 * before it reads any state, as `key=value` lines (no quoting: every value is schema-validated and
 * one line): the subscriptions and regions, the organisation, the platform project and its repository core,
 * coreVersion and coreReleases.repository (ADR-0067), approvals.entraChanges, the DNS zones, and the names of
 * the deployments, groups and lock it reads or touches. The names come from the ports
 * of naming.bicep (src/ado/names.ts, src/provisioning/names.ts, checked against the naming vectors),
 * except the deployment names of the human-run templates, which name no resource and are the ones
 * infra/README.md documents (bootstrap-{prefix}-{env}, roles-{prefix}, entra-permissions,
 * entra-audit-alert). Pure: no Azure calls.
 *
 *   managedEnvironments.<subscription>.<region> = the Container Apps environments the instance's
 *   environments (one per network mode and capacity cell) and the portal put there, for the quota.
 *
 *   databases.<subscription>.<region> = the database engines (postgres, azureSql) that must be allowed there:
 *   Azure SQL for the portal's database in the host environment (ADR-0070), and each engine data enables for apps in every
 *   environment. A subscription can be restricted from an engine in a region (seen on an Azure Sponsorship).
 *
 *   dnsZone.<zone>.id, .subscriptionId, .resourceGroup, .allowedEnvironments = each Azure DNS zone of
 *   dns.zones (azureDnsZones lists them), for `instance.sh dns`; subscriptionId and resourceGroup are
 *   empty when azureDnsZoneId is not the resource ID of a DNS zone with the zone's name.
 */

/** The bootstrap's deployment in an environment subscription (infra/README.md, platform identities bootstrap). */
export const bootstrapDeployment = (prefix: string, env: string): string => `bootstrap-${prefix}-${env}`;
/** The custom roles' deployment in the portal host's subscription (roles.bicep). */
export const rolesDeployment = (prefix: string): string => `roles-${prefix}`;
/** The Graph permissions' deployment in rg-{prefix}-entra (entra-permissions.bicep). */
export const ENTRA_PERMISSIONS_DEPLOYMENT = "entra-permissions";
/** The Entra audit alert's deployment next to its workspace (entra-audit-alert.bicep). */
export const ENTRA_AUDIT_ALERT_DEPLOYMENT = "entra-audit-alert";

/**
 * The git URL of the platform project's repository `core` (ADR-0006: every pipeline reads core there; ADR-0067:
 * instance.sh core pushes the release's tag there), or "" for an instance not on Azure DevOps.
 */
export function coreRepositoryUrl(inst: Instance): string {
  const ado = inst.scm.provider === "azureDevOps" ? inst.scm.azureDevOps : undefined;
  if (!ado?.organizationUrl) return "";
  return `${ado.organizationUrl.replace(/\/+$/, "")}/${encodeURIComponent(ado.platformProject)}/_git/core`;
}

export function instanceFacts(inst: Instance): [string, string][] {
  const prefix = inst.naming.prefix;
  const host = provisioningHostEnvironment(inst);
  const hostEnv = inst.environments.find((e) => e.name === host)!;
  const region = (e: { region?: string }): string => e.region ?? inst.defaultRegion;
  const subscriptions: string[] = [];
  for (const e of inst.environments) if (!subscriptions.includes(e.subscriptionId.toLowerCase())) subscriptions.push(e.subscriptionId.toLowerCase());
  const caes = new Map<string, number>();
  const count = (sub: string, loc: string, n: number): void => {
    const k = `${sub.toLowerCase()}.${loc}`;
    caes.set(k, (caes.get(k) ?? 0) + n);
  };
  for (const e of inst.environments) {
    for (const mode of [e.networkModes.externalOnly, e.networkModes.externalHybrid]) if (mode) count(e.subscriptionId, region(e), mode.cells?.length ?? 1);
  }
  count(hostEnv.subscriptionId, region(hostEnv), 1);
  // The database engines each subscription and region must allow: Azure SQL for the portal's own database in the
  // host, and the engines data offers to apps in every environment (preflight reads their capabilities).
  const dbs = new Map<string, Set<string>>();
  const need = (sub: string, loc: string, engine: string): void => {
    const k = `${sub.toLowerCase()}.${loc}`;
    (dbs.get(k) ?? dbs.set(k, new Set()).get(k)!).add(engine);
  };
  const postgresOn = inst.data?.postgres?.enabled ?? instanceDefault<boolean>("$defs/dataDefaults/properties/postgres/properties/enabled");
  const sqlOn = inst.data?.azureSql?.enabled ?? instanceDefault<boolean>("$defs/dataDefaults/properties/azureSql/properties/enabled");
  need(hostEnv.subscriptionId, region(hostEnv), "azureSql");
  for (const e of inst.environments) {
    if (postgresOn) need(e.subscriptionId, region(e), "postgres");
    if (sqlOn) need(e.subscriptionId, region(e), "azureSql");
  }
  const azureZones = (inst.dns?.zones ?? []).filter((z) => z.provider === "azureDns");
  const facts: [string, string][] = [
    ["prefix", prefix],
    ["tenantId", (inst.tenantId ?? "").toLowerCase()],
    ["hostEnvironment", host],
    ["environments", inst.environments.map((e) => e.name).join(" ")],
    ["subscriptions", subscriptions.join(" ")],
    ["scmProvider", inst.scm.provider],
    ["organizationUrl", inst.scm.azureDevOps?.organizationUrl ?? ""],
    ["platformProject", inst.scm.azureDevOps?.platformProject ?? ""],
    ["coreRepositoryUrl", coreRepositoryUrl(inst)],
    ["coreVersion", inst.coreVersion],
    ["coreReleasesRepository", inst.coreReleases?.repository ?? ""],
    ["entraChanges", entraChangesMode(inst)],
    ["dnsZones", (inst.dns?.zones ?? []).map((z) => z.name).join(" ")],
    ["azureDnsZones", azureZones.map((z) => z.name).join(" ")],
    ["identitiesLock", identitiesLock(prefix)],
    ["entraResourceGroup", entraResourceGroup(prefix)],
    ["rolesDeployment", rolesDeployment(prefix)],
    ["entraPermissionsDeployment", ENTRA_PERMISSIONS_DEPLOYMENT],
    ["auditAlertDeployment", ENTRA_AUDIT_ALERT_DEPLOYMENT],
    ["portalDeployment", portalDeployment(prefix, host)],
    ["registrationDeployment", portalEntraDeployment(host)],
    ["platformDeployment", platformDeployment(prefix, host)],
    // instance.sh status (ADR-0072): /readyz at portal.apiBaseUrl, else at the portal deployment's portalFqdn.
    ["portalApiBaseUrl", inst.portal?.apiBaseUrl ?? ""],
  ];
  for (const e of inst.environments) {
    facts.push(
      [`env.${e.name}.subscriptionId`, e.subscriptionId.toLowerCase()],
      [`env.${e.name}.location`, region(e)],
      [`env.${e.name}.kind`, e.kind],
      [`env.${e.name}.bootstrapDeployment`, bootstrapDeployment(prefix, e.name)],
      [`env.${e.name}.platformDeployment`, platformDeployment(prefix, e.name)],
      [`env.${e.name}.identitiesResourceGroup`, identitiesResourceGroup(prefix, e.name)],
    );
  }
  for (const [k, n] of caes) facts.push([`managedEnvironments.${k}`, String(n)]);
  for (const [k, engines] of dbs) facts.push([`databases.${k}`, ["postgres", "azureSql"].filter((x) => engines.has(x)).join(" ")]);
  for (const z of azureZones) {
    const id = z.azureDnsZoneId ?? "";
    const m = ZONE_ID_RE.exec(id);
    const parsed = m && m[3]!.toLowerCase() === z.name.toLowerCase() ? m : undefined;
    facts.push(
      [`dnsZone.${z.name}.id`, id],
      [`dnsZone.${z.name}.subscriptionId`, parsed ? parsed[1]!.toLowerCase() : ""],
      [`dnsZone.${z.name}.resourceGroup`, parsed ? parsed[2]! : ""],
      [`dnsZone.${z.name}.allowedEnvironments`, z.allowedEnvironments.join(" ")],
    );
  }
  for (const [k, v] of facts) {
    if (/[\r\n]/.test(v)) throw new CheckFailed([`instance.yaml: the value of ${k} spans lines.`]);
  }
  return facts;
}

export function formatFacts(facts: [string, string][]): string {
  return facts.map(([k, v]) => `${k}=${v}\n`).join("");
}
