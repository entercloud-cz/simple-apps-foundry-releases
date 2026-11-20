import type { Instance } from "../provisioning/model.js";
import { instanceEnv } from "../provisioning/model.js";
import { zoneOfHost } from "../validate-app.js";
import type { DnsZoneView } from "../validate-app.js";

/**
 * The portal's own host name through the managed Front Door profile of its host environment (ADR-0071).
 *
 * - `portal.hostName` set to a host: that host. Set to "": none (the portal stays on its Container App's own
 *   address, without an ingress restriction).
 * - Not set: `portal.{zone}`, the zone being the host environment's default DNS zone of `dns.zones` (default: true and
 *   the host environment in allowedEnvironments, else the first zone that allows it, as the portal preselects zones
 *   for apps), when frontDoor.mode is managed and frontDoor.managed.profiles has the host environment. Otherwise none.
 *
 * dnsZoneId is the zone's azureDnsZoneId when that zone is an Azure DNS zone in the host environment's subscription
 * (portal.bicep writes the CNAME and _dnsauth TXT there), else "" (the records are made by hand: the portal
 * deployment's output frontDoor.dnsRecords). A host inside a zone of dns.zones must be a reserved subdomain of it
 * (dns.reservedSubdomains), so no app can be given the same host.
 */
export interface PortalHost {
  hostName: string;
  dnsZoneId: string;
  /** instance.yaml (portal.hostName), default (portal.{zone}) or none. */
  source: "instance.yaml" | "default" | "none";
  /** Why there is none, for the plan's report. */
  reason?: string;
  /** The zone of dns.zones that holds the host, if any. */
  zone?: string;
}

/** instance.schema.json default of dns.reservedSubdomains. */
const DEFAULT_RESERVED = ["www", "mail", "portal", "platform", "api", "admin", "autodiscover"];
const HOST_RE = /^(?=.{1,244}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?){2,}$/;

type Zone = DnsZoneView & { default?: boolean };

export function portalHost(inst: Instance): { host: PortalHost; problems: string[] } {
  const hostEnv = inst.portal?.hostEnvironment ?? "";
  const configured = (inst.portal as { hostName?: string } | undefined)?.hostName;
  const zones = (inst.dns?.zones ?? []) as Zone[];
  const mode = inst.frontDoor?.mode ?? "managed";
  const hasProfile = mode === "managed" && (inst.frontDoor?.managed?.profiles ?? []).some((p) => p.environment === hostEnv);
  const problems: string[] = [];

  let hostName = "";
  let source: PortalHost["source"] = "none";
  let reason: string | undefined;
  if (configured !== undefined) {
    if (configured === "") reason = "portal.hostName is \"\" in instance.yaml";
    else {
      hostName = configured.toLowerCase();
      source = "instance.yaml";
    }
  } else if (!hasProfile) {
    reason = mode !== "managed" ? `frontDoor.mode is ${mode}` : `frontDoor.managed.profiles has no profile for ${hostEnv}`;
  } else {
    const allowed = zones.filter((z) => z.allowedEnvironments.includes(hostEnv));
    const zone = allowed.find((z) => z.default === true) ?? allowed[0];
    if (!zone) reason = `dns.zones has no zone that allows ${hostEnv}`;
    else {
      hostName = `portal.${zone.name.toLowerCase()}`;
      source = "default";
    }
  }
  if (!hostName) return { host: { hostName: "", dnsZoneId: "", source: "none", ...(reason ? { reason } : {}) }, problems };

  if (!HOST_RE.test(hostName)) {
    problems.push(`portal.hostName "${hostName.slice(0, 80)}" must be "" or a lowercase host name with at least three labels (a-z, 0-9, inner hyphens).`);
  }
  if (!hasProfile) {
    problems.push(
      `portal.hostName ${hostName} needs a managed Front Door profile in the portal host environment ${hostEnv} (frontDoor.mode managed, frontDoor.managed.profiles with environment ${hostEnv}): the portal's own host name goes only through Front Door (ADR-0071).`,
    );
  }
  const zone = zoneOfHost(zones, hostName);
  let dnsZoneId = "";
  if (zone) {
    const reserved = (inst.dns?.reservedSubdomains ?? DEFAULT_RESERVED).map((s) => s.toLowerCase());
    const relative = hostName.slice(0, hostName.length - zone.name.length - 1);
    if (!reserved.includes(relative)) {
      problems.push(
        `the portal's host name ${hostName} is in the DNS zone ${zone.name}, so its subdomain "${relative}" must be in dns.reservedSubdomains: otherwise an app could be given the same host.`,
      );
    }
    let subscriptionId = "";
    try {
      subscriptionId = instanceEnv(inst, hostEnv).subscriptionId;
    } catch {
      // The host environment's own check reports it.
    }
    const zoneSubscription = /^\/subscriptions\/([^/]+)\//i.exec(zone.azureDnsZoneId ?? "")?.[1];
    if (zone.provider === "azureDns" && zone.azureDnsZoneId && zoneSubscription?.toLowerCase() === subscriptionId.toLowerCase()) {
      dnsZoneId = zone.azureDnsZoneId;
    }
  }
  return { host: { hostName, dnsZoneId, source, ...(zone ? { zone: zone.name } : {}) }, problems };
}
