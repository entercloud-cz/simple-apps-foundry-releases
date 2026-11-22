import { CheckFailed, MiB, isObject, own, readJson } from "../pipeline/common.js";
import { zoneOfHost } from "../validate-app.js";
import type { AppData } from "../validate-app.js";
import { instanceEnv, loadAppFile, loadInstanceFile } from "./model.js";
import type { Instance } from "./model.js";
import { armValue, domainServing, readRecord } from "./run.js";
import type { DeploymentRecord } from "./run.js";

/**
 * An app's custom domain through the managed Front Door across host changes and removal (ADR-0010,
 * amended 2026-11-11):
 *
 *   previousFrontDoor   what the last record fd-{slug}-{env} names (host, retained host, their zones)
 *                       and whether Front Door serves its host;
 *   retainedHost        the previous host that stays on the route while a new one isn't served
 *                       (`inputs --step frontdoor`: the template's retainedHostName);
 *   cleanupPlan         `platform provisioning fd-cleanup`: what provisioning deletes after the
 *                       release step, comparing the record before this run's deployment with the one
 *                       after it (none = the domain is removed): the custom domains no longer on the
 *                       route, the DNS records the platform wrote for them in an Azure DNS zone it
 *                       manages, and on removal the route and the origin group. Never a host another
 *                       app requests in that environment.
 *
 * Names from naming.bicep (ADR-0020), ported here; test/naming-vectors.test.ts compares them with
 * infra/tests/naming-vectors.json, which check-naming.py checks against naming.bicep.
 */

const fit = (max: number, name: string): string => {
  if (name.length > max) throw new CheckFailed([`naming: "${name}" is ${name.length} characters, limit ${max}.`]);
  return name;
};
export const platformResourceGroup = (prefix: string, env: string): string => fit(90, `rg-${prefix}-platform-${env}`);
export const frontDoorProfile = (prefix: string, env: string): string => fit(260, `afd-${prefix}-${env}`);
export const frontDoorEndpoint = (prefix: string, env: string): string => fit(46, `fde-${prefix}-${env}`);
export const frontDoorOriginGroup = (slug: string, env: string): string => fit(90, `og-${slug}-${env}`);
export const frontDoorRoute = (slug: string, env: string): string => fit(90, `route-${slug}-${env}`);
export const frontDoorCustomDomain = (host: string): string => fit(260, `cd-${host.toLowerCase().replaceAll(".", "-")}`);
export const frontDoorValidationRecord = (host: string): string => fit(253, `_dnsauth.${host.toLowerCase()}`);
export const frontDoorDeployment = (slug: string, env: string): string => fit(64, `fd-${slug}-${env}`);
export function dnsRelativeRecordName(fqdn: string, zone: string): string {
  const f = fqdn.toLowerCase();
  const z = zone.toLowerCase();
  if (!f.endsWith(`.${z}`) || f.length <= z.length + 1) throw new CheckFailed([`naming: "${fqdn}" is not below the DNS zone "${zone}" (records at the zone apex are not supported).`]);
  return f.slice(0, f.length - z.length - 1);
}

const HOST_RE = /^(?=.{1,244}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$/;
/** An Azure DNS zone's resource ID: subscription, resource group, zone (ARM spells the type dnszones or dnsZones). */
export const ZONE_ID_RE = /^\/subscriptions\/([0-9a-fA-F-]{36})\/resourceGroups\/([-\w.()]{1,90})\/providers\/Microsoft\.Network\/dnsZones\/([a-z0-9.-]{1,253})$/i;

/** The last record fd-{slug}-{env}, as far as host changes and removal need it. */
export interface PreviousFrontDoor {
  hostName: string;
  dnsZoneId: string;
  retainedHostName: string;
  retainedDnsZoneId: string;
  succeeded: boolean;
  /** Front Door serves hostName (--fd-domain); undefined = not read. */
  serving: boolean | undefined;
  /** The environment endpoint's host (output endpointHostName): the CNAME target the platform wrote. */
  endpointHostName: string | undefined;
}

function str(record: DeploymentRecord, name: string, from: "parameters" | "outputs" = "parameters"): string {
  const v = armValue(record[from], name);
  return typeof v === "string" ? v : "";
}

/** The record (raw `az deployment group show`) and, optionally, the state of its custom domain. */
export function previousFrontDoor(recordPath: string | undefined, domainPath: string | undefined, slug: string, env: string): PreviousFrontDoor | undefined {
  const r = readRecord(recordPath, "--fd-record", frontDoorDeployment(slug, env));
  if (!r) {
    if (domainPath !== undefined) throw new CheckFailed(["--fd-domain needs --fd-record."]);
    return undefined;
  }
  const prev: PreviousFrontDoor = {
    hostName: str(r, "hostName").toLowerCase(),
    dnsZoneId: str(r, "dnsZoneId"),
    retainedHostName: str(r, "retainedHostName").toLowerCase(),
    retainedDnsZoneId: str(r, "retainedDnsZoneId"),
    succeeded: r.provisioningState === "Succeeded",
    serving: domainPath === undefined ? undefined : domainServing(domainPath),
    endpointHostName: str(r, "endpointHostName", "outputs").toLowerCase() || undefined,
  };
  const problems: string[] = [];
  if (!HOST_RE.test(prev.hostName)) problems.push("--fd-record has no valid parameter hostName.");
  if (prev.retainedHostName && !HOST_RE.test(prev.retainedHostName)) problems.push("--fd-record has an invalid parameter retainedHostName.");
  for (const k of ["dnsZoneId", "retainedDnsZoneId"] as const) if (prev[k] && !ZONE_ID_RE.test(prev[k])) problems.push(`--fd-record has an invalid parameter ${k}.`);
  if (prev.endpointHostName && !HOST_RE.test(prev.endpointHostName) && !/^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63}){2,}$/.test(prev.endpointHostName)) problems.push("--fd-record has an invalid output endpointHostName.");
  if (problems.length) throw new CheckFailed(problems);
  return prev;
}

/**
 * The previous host that stays on the route while `requested` isn't served yet (a host change, the
 * old URL keeps working until the new one is live), with the zone its records were written in:
 *   - the last deployment Succeeded and Front Door serves its host: that host, unless it is the
 *     requested one (then nothing is retained any more: the change is complete);
 *   - it doesn't serve it (validation or certificate pending): the host that deployment retained,
 *     which still serves; its own host was never live and is dropped;
 *   - unknown (a failed deployment, or the domain couldn't be read): keep what is most likely live:
 *     the retained host, else the previous host.
 * Never the requested host and never a host another app of the environment requests now.
 */
export function retainedHost(requested: string, prev: PreviousFrontDoor | undefined, others: ReadonlySet<string>): { hostName: string; dnsZoneId: string } {
  const none = { hostName: "", dnsZoneId: "" };
  if (!prev) return none;
  const host = { hostName: prev.hostName, dnsZoneId: prev.dnsZoneId };
  const kept = { hostName: prev.retainedHostName, dnsZoneId: prev.retainedDnsZoneId };
  const live = prev.succeeded ? prev.serving : undefined;
  let pick: { hostName: string; dnsZoneId: string };
  if (live === true) pick = host;
  else if (live === false) pick = kept;
  else pick = kept.hostName ? kept : host;
  if (!pick.hostName || pick.hostName === requested.toLowerCase() || others.has(pick.hostName)) return none;
  return pick;
}

/** Hosts other apps request through the managed Front Door in env (plan/apps.json frontDoorHosts). */
export function otherAppsHosts(appsPath: string | undefined, slug: string, env: string): Set<string> {
  const out = new Set<string>();
  if (appsPath === undefined) return out;
  const doc = readJson(appsPath, 16 * MiB, "--apps");
  const apps = isObject(doc) ? own(doc, "apps") : undefined;
  if (!Array.isArray(apps)) throw new CheckFailed(["--apps must be plan/apps.json ({ apps: [...] })."]);
  for (const a of apps) {
    if (!isObject(a) || own(a, "slug") === slug) continue;
    const hosts = own(a, "frontDoorHosts");
    const h = isObject(hosts) ? own(hosts, env) : undefined;
    if (typeof h === "string" && h) out.add(h.toLowerCase());
  }
  // An invalid app.yaml (ok: false) has no hosts in the plan; its last valid host may still be in use.
  // TODO(verify): whether such an app should block the cleanup of every host; today it doesn't.
  return out;
}

/** One custom domain to delete, with the DNS records the platform wrote for it or the records to report. */
export interface DomainCleanup {
  host: string;
  customDomainId: string;
  /** Records in an Azure DNS zone the platform manages, written by the deployment: provisioning deletes them. */
  dns: { zoneId: string; cnameId: string; txtId: string } | null;
  /** Records provisioning doesn't delete (manual zone, or a zone it no longer manages): a report line each. */
  manualDns: { cname: string; txt: string; zone: string } | null;
}

export interface CleanupPlan {
  slug: string;
  environmentName: string;
  deployment: string;
  resourceGroup: string;
  profileId: string;
  endpointId: string;
  /** The domain is removed (no deployment after this run's): route, origin group and the record go too. */
  removeRoute: boolean;
  routeId: string;
  originGroupId: string;
  /** The CNAME target the platform wrote (the endpoint's host): a record pointing elsewhere is left alone. */
  expectedCname: string;
  domains: DomainCleanup[];
  /** Hosts of the old record that another app requests now: left alone. */
  skipped: { host: string; reason: string }[];
}

/** The Azure DNS zone of instance.yaml dns.zones with this resource ID, in the environment's subscription. */
function managedZone(inst: Instance, zoneId: string, subscriptionId: string): { name: string } | undefined {
  const m = ZONE_ID_RE.exec(zoneId);
  if (!m || m[1]!.toLowerCase() !== subscriptionId.toLowerCase()) return undefined;
  const z = (inst.dns?.zones ?? []).find((x) => x.provider === "azureDns" && (x.azureDnsZoneId ?? "").toLowerCase() === zoneId.toLowerCase());
  return z ? { name: z.name.toLowerCase() } : undefined;
}

export function cleanupPlan(args: { instance: string; app: string; env: string; apps?: string; before: string; after?: string }): CleanupPlan {
  const inst = loadInstanceFile(args.instance);
  const app: AppData = loadAppFile(args.app, args.instance);
  const env = instanceEnv(inst, args.env);
  if (!Object.hasOwn(app.environments, env.name)) throw new CheckFailed([`app ${app.slug} does not run in environment ${env.name}.`]);
  if ((inst.frontDoor?.mode ?? "managed") !== "managed") throw new CheckFailed(["fd-cleanup is for the managed Front Door mode only."]);
  const before = previousFrontDoor(args.before, undefined, app.slug, env.name)!;
  const after = args.after === undefined ? undefined : previousFrontDoor(args.after, undefined, app.slug, env.name);
  // ADR-0056: a decommissioned app requests no domain any more, whatever its environments still say;
  // the removal is the delete phase's (the plan sends frontdoor with action delete only then).
  const requested = app.decommission ? undefined : app.environments[env.name]?.frontDoor?.hostName?.toLowerCase();
  if (!after && requested) throw new CheckFailed([`${app.slug} still requests ${requested} in ${env.name}: pass --after (the deployment of this run); a requested domain is never removed.`]);
  if (after && !after.succeeded) throw new CheckFailed(["--after is not a Succeeded deployment: nothing is cleaned up after a failed one."]);
  if (after && after.hostName !== requested) throw new CheckFailed([`--after names ${after.hostName}, but app.yaml requests ${requested ?? "none"} in ${env.name}.`]);
  const others = otherAppsHosts(args.apps, app.slug, env.name);
  const keep = new Set([after?.hostName, after?.retainedHostName, requested].filter((h): h is string => !!h));

  const prefix = inst.naming.prefix;
  const rg = platformResourceGroup(prefix, env.name);
  const profileId = `/subscriptions/${env.subscriptionId}/resourceGroups/${rg}/providers/Microsoft.Cdn/profiles/${frontDoorProfile(prefix, env.name)}`;
  const endpointId = `${profileId}/afdEndpoints/${frontDoorEndpoint(prefix, env.name)}`;
  const plan: CleanupPlan = {
    slug: app.slug,
    environmentName: env.name,
    deployment: frontDoorDeployment(app.slug, env.name),
    resourceGroup: rg,
    profileId,
    endpointId,
    removeRoute: !after,
    routeId: `${endpointId}/routes/${frontDoorRoute(app.slug, env.name)}`,
    originGroupId: `${profileId}/originGroups/${frontDoorOriginGroup(app.slug, env.name)}`,
    expectedCname: before.endpointHostName ?? "",
    domains: [],
    skipped: [],
  };
  const candidates: { host: string; zoneId: string }[] = [
    { host: before.hostName, zoneId: before.dnsZoneId },
    ...(before.retainedHostName ? [{ host: before.retainedHostName, zoneId: before.retainedDnsZoneId }] : []),
  ];
  for (const c of candidates) {
    if (keep.has(c.host)) continue;
    if (others.has(c.host)) {
      plan.skipped.push({ host: c.host, reason: "another app requests it now" });
      continue;
    }
    const zone = c.zoneId ? managedZone(inst, c.zoneId, env.subscriptionId) : undefined;
    let dns: DomainCleanup["dns"] = null;
    let manualDns: DomainCleanup["manualDns"] = null;
    if (zone && c.host.endsWith(`.${zone.name}`)) {
      const rel = dnsRelativeRecordName(c.host, zone.name);
      dns = { zoneId: c.zoneId, cnameId: `${c.zoneId}/CNAME/${rel}`, txtId: `${c.zoneId}/TXT/${dnsRelativeRecordName(frontDoorValidationRecord(c.host), zone.name)}` };
    } else {
      const z = (inst.dns?.zones ?? []).filter((x) => c.host.endsWith(`.${x.name.toLowerCase()}`)).sort((a, b) => b.name.length - a.name.length)[0];
      manualDns = { cname: c.host, txt: frontDoorValidationRecord(c.host), zone: z?.name.toLowerCase() ?? "" };
    }
    plan.domains.push({ host: c.host, customDomainId: `${profileId}/customDomains/${frontDoorCustomDomain(c.host)}`, dns, manualDns });
  }
  if (plan.domains.some((d) => d.dns) && !plan.expectedCname) {
    throw new CheckFailed(["--before has no output endpointHostName: the CNAME target the platform wrote is unknown, so no DNS record is deleted (delete them by hand)."]);
  }
  return plan;
}

export const FD_CLEANUP_HELP = `  fd-cleanup --instance <instance.yaml> --app <apps/<slug>/app.yaml> --env <name> --before <record.json>
             [--after <record.json>] [--apps <plan/apps.json>] --output <plan.json>
      what provisioning deletes after the release step (ADR-0010, amended 2026-11-11): --before is the
      record fd-{slug}-{env} as it was before this run's deployment, --after the deployment of this run
      (none = app.yaml no longer requests a domain: removal). The custom domains no longer on the
      route, the DNS records the platform wrote for them in an Azure DNS zone it manages (else the
      records to report), on removal the route and the origin group; never a host another app of
      the environment requests (--apps)
`;

/**
 * What provisioning reads before the deployment fd-{slug}-{env} PUTs the DNS records of the app's
 * custom domain (ADR-0052, finding F7: a PUT replaces a record set, whoever made it). The record sets
 * frontdoor.bicep writes (dns-records.bicep: CNAME {host}, TXT _dnsauth.{host}) in the Azure DNS zone
 * of `inputs --step frontdoor` (dnsZoneId), and the environment's Front Door endpoint, whose host a
 * CNAME without the platform's mark must point at to count as this app's. zoneId "" = the records are
 * made by hand (nothing to guard). Names from naming.bicep, ported (test/naming-vectors.test.ts).
 */
export interface DnsGuard {
  slug: string;
  environmentName: string;
  host: string;
  zoneId: string;
  cnameId: string;
  txtId: string;
  endpointId: string;
}

export function dnsGuard(args: { instance: string; app: string; env: string }): DnsGuard {
  const inst = loadInstanceFile(args.instance);
  const app: AppData = loadAppFile(args.app, args.instance);
  const env = instanceEnv(inst, args.env);
  if ((inst.frontDoor?.mode ?? "managed") !== "managed") throw new CheckFailed(["fd-dns-guard is for the managed Front Door mode only."]);
  const host = app.environments[env.name]?.frontDoor?.hostName?.toLowerCase();
  if (!host || !HOST_RE.test(host)) throw new CheckFailed([`app ${app.slug} requests no custom domain in environment ${env.name}.`]);
  const prefix = inst.naming.prefix;
  const profileId = `/subscriptions/${env.subscriptionId}/resourceGroups/${platformResourceGroup(prefix, env.name)}/providers/Microsoft.Cdn/profiles/${frontDoorProfile(prefix, env.name)}`;
  const out: DnsGuard = { slug: app.slug, environmentName: env.name, host, zoneId: "", cnameId: "", txtId: "", endpointId: `${profileId}/afdEndpoints/${frontDoorEndpoint(prefix, env.name)}` };
  const zone = zoneOfHost(inst.dns?.zones, host);
  const zoneId = zone?.provider === "azureDns" ? (zone.azureDnsZoneId ?? "") : "";
  const m = ZONE_ID_RE.exec(zoneId);
  // Only a zone the deployment writes in: an Azure DNS zone in the environment's subscription (as frontDoorInputs).
  if (!zone || !m || m[1]!.toLowerCase() !== env.subscriptionId.toLowerCase()) return out;
  const name = zone.name.toLowerCase();
  out.zoneId = zoneId;
  out.cnameId = `${zoneId}/CNAME/${dnsRelativeRecordName(host, name)}`;
  out.txtId = `${zoneId}/TXT/${dnsRelativeRecordName(frontDoorValidationRecord(host), name)}`;
  return out;
}

export const FD_DNS_GUARD_HELP = `  fd-dns-guard --instance <instance.yaml> --app <apps/<slug>/app.yaml> --env <name> --output <guard.json>
      the record sets the deployment fd-{slug}-{env} writes in an Azure DNS zone (CNAME {host}, TXT
      _dnsauth.{host}) and the environment's Front Door endpoint, which provisioning reads before it
      deploys (ADR-0052: a record set that isn't this app's is never overwritten); zoneId "" when the
      records are made by hand
`;
