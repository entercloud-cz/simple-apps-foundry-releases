import { createHash } from "node:crypto";
import { CheckFailed, MiB, isObject, own, readJson, writeJson } from "../pipeline/common.js";

/**
 * The ingress lock-down of apps behind the managed Front Door (ADR-0010, amended 2026-11-11, FD-3).
 * Container Apps IP restrictions take IPv4 CIDR ranges only, no service tags, so provisioning turns
 * the `AzureFrontDoor.Backend` service tag into its IPv4 prefixes: `az network list-service-tags
 * --location <region>` once per stage azure_<env>, then `platform provisioning fd-ranges`, whose
 * output feeds `platform provisioning state --fd-ranges` (state.frontDoorBackendIpRanges) and the
 * scope of targeted runs (its sha256, ADR-0046).
 */

export const FRONT_DOOR_SERVICE_TAG = "AzureFrontDoor.Backend";
/**
 * Upper bound of the ranges a release takes. The sandbox measured 157 IPv4 prefixes in the tag and a
 * Container App that accepted 157 `Allow` rules (2026-11-11); Microsoft Learn documents no maximum.
 * A list above the bound fails the stage's Front Door apps instead of deploying something nobody
 * has seen work. TODO(verify): the Container Apps limit, if any. Verify in sandbox: FD-3.
 */
export const FRONT_DOOR_RANGES_MAX = 400;
/** The widest prefix accepted: a /0 or another huge range would open the ingress it should lock. */
export const FRONT_DOOR_PREFIX_MIN = 8;

const IPV4_CIDR_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

/** The address as a 32-bit number and the prefix length, or undefined when it isn't IPv4 CIDR. */
function parseIpv4Cidr(v: string): { address: number; bits: number } | undefined {
  const m = IPV4_CIDR_RE.exec(v);
  if (!m) return undefined;
  const octets = m.slice(1, 5).map(Number);
  const bits = Number(m[5]);
  // No leading zeros (01.2.3.4 is ambiguous), every octet 0-255, prefix 0-32.
  if (m.slice(1, 6).some((p) => p.length > 1 && p.startsWith("0")) || octets.some((o) => o > 255) || bits > 32) return undefined;
  return { address: ((octets[0]! << 24) >>> 0) + (octets[1]! << 16) + (octets[2]! << 8) + octets[3]!, bits };
}

/** A problem with one range, or undefined: IPv4 CIDR, the network address itself, at most a /8. */
export function ipv4RangeProblem(v: unknown, label: string): string | undefined {
  if (typeof v !== "string") return `${label} must be a string.`;
  const shown = v.slice(0, 50);
  const p = parseIpv4Cidr(v);
  if (!p) return `${label} "${shown}" is not an IPv4 CIDR range (a.b.c.d/n); Container Apps IP rules take no IPv6 and no service tags.`;
  if (p.bits < FRONT_DOOR_PREFIX_MIN) return `${label} "${shown}" is wider than a /${FRONT_DOOR_PREFIX_MIN}.`;
  const hostMask = p.bits === 32 ? 0 : 0xffffffff >>> p.bits;
  if ((p.address & hostMask) !== 0) return `${label} "${shown}" is not a network address (host bits set).`;
  return undefined;
}

/** Numeric order (address, then prefix length): the order every list of ranges is written in. */
function compareRanges(a: string, b: string): number {
  const pa = parseIpv4Cidr(a)!;
  const pb = parseIpv4Cidr(b)!;
  return pa.address - pb.address || pa.bits - pb.bits;
}

/**
 * Problems of a list of ranges as a release takes it (state.frontDoorBackendIpRanges, the
 * fd-ranges output): a non-empty list of at most FRONT_DOOR_RANGES_MAX IPv4 CIDR ranges, sorted
 * and without duplicates.
 */
export function backendRangesProblems(v: unknown, label: string): string[] {
  if (!Array.isArray(v)) return [`${label} must be a list of IPv4 CIDR ranges.`];
  if (v.length === 0) return [`${label} is empty: an app behind Front Door is never released without its ingress ranges.`];
  if (v.length > FRONT_DOOR_RANGES_MAX) return [`${label} has ${v.length} ranges, more than the limit of ${FRONT_DOOR_RANGES_MAX} (ADR-0010, FD-3).`];
  const problems = v.map((r, i) => ipv4RangeProblem(r, `${label}[${i}]`)).filter((p): p is string => p !== undefined);
  if (problems.length) return problems.slice(0, 10);
  const sorted = [...(v as string[])].sort(compareRanges);
  if (new Set(v).size !== v.length) return [`${label} has duplicate ranges.`];
  if (sorted.some((r, i) => r !== v[i])) return [`${label} must be sorted (address, then prefix length).`];
  return [];
}

/** sha256 (hex) of the ranges, one per line: the scope of targeted runs compares it (ADR-0046). */
export function rangesDigest(ranges: readonly string[]): string {
  return createHash("sha256").update(`saf-frontdoor-ranges v1\n${ranges.join("\n")}\n`).digest("hex");
}

export interface BackendRanges {
  serviceTag: string;
  changeNumber: string | null;
  ipv4: number;
  ipv6: number;
  sha256: string;
  ranges: string[];
}

/**
 * The IPv4 prefixes of AzureFrontDoor.Backend from the output of `az network list-service-tags`
 * (Service Tag Discovery API, {values: [{name, properties: {addressPrefixes, changeNumber}}]}):
 * exactly one entry of that name; IPv6 prefixes are counted and dropped; the IPv4 ones sorted and
 * de-duplicated, then checked like a release's ranges (anything else fails, nothing is guessed).
 */
export function frontDoorBackendRanges(doc: unknown, label = "--service-tags"): BackendRanges {
  const values = isObject(doc) ? own(doc, "values") : undefined;
  if (!Array.isArray(values)) throw new CheckFailed([`${label} must be the output of az network list-service-tags (an object with values).`]);
  const tags = values.filter((v) => isObject(v) && own(v, "name") === FRONT_DOOR_SERVICE_TAG) as Record<string, unknown>[];
  if (tags.length !== 1) throw new CheckFailed([`${label} has ${tags.length} entries named ${FRONT_DOOR_SERVICE_TAG}, expected exactly one.`]);
  const props = own(tags[0]!, "properties");
  const prefixes = isObject(props) ? own(props, "addressPrefixes") : undefined;
  if (!Array.isArray(prefixes) || prefixes.some((p) => typeof p !== "string")) throw new CheckFailed([`${label} ${FRONT_DOOR_SERVICE_TAG} has no list properties.addressPrefixes.`]);
  const ipv6 = (prefixes as string[]).filter((p) => p.includes(":"));
  const ranges = [...new Set((prefixes as string[]).filter((p) => !p.includes(":")))];
  const bad = ranges.map((r) => ipv4RangeProblem(r, `${label} ${FRONT_DOOR_SERVICE_TAG} prefix`)).filter((p): p is string => p !== undefined);
  if (bad.length) throw new CheckFailed(bad.slice(0, 10));
  ranges.sort(compareRanges);
  const problems = backendRangesProblems(ranges, `${label} ${FRONT_DOOR_SERVICE_TAG} IPv4 prefixes`);
  if (problems.length) throw new CheckFailed(problems);
  const change = isObject(props) ? own(props, "changeNumber") : undefined;
  return {
    serviceTag: FRONT_DOOR_SERVICE_TAG,
    changeNumber: typeof change === "string" || typeof change === "number" ? String(change).slice(0, 40) : null,
    ipv4: ranges.length,
    ipv6: ipv6.length,
    sha256: rangesDigest(ranges),
    ranges,
  };
}

/** Reads an fd-ranges output (--fd-ranges of `platform provisioning state`) and checks it again. */
export function readBackendRanges(path: string, label = "--fd-ranges"): string[] {
  const doc = readJson(path, 1 * MiB, label);
  if (!isObject(doc) || own(doc, "serviceTag") !== FRONT_DOOR_SERVICE_TAG) throw new CheckFailed([`${label} must be the output of platform provisioning fd-ranges.`]);
  const ranges = own(doc, "ranges");
  const problems = backendRangesProblems(ranges, `${label} ranges`);
  if (problems.length) throw new CheckFailed(problems);
  if (own(doc, "sha256") !== rangesDigest(ranges as string[])) throw new CheckFailed([`${label} sha256 does not match its ranges.`]);
  return ranges as string[];
}

export const FD_RANGES_HELP = `  fd-ranges --service-tags <az network list-service-tags output> --output <ranges.json>
      the IPv4 prefixes of the ${FRONT_DOOR_SERVICE_TAG} service tag for the ingress lock-down of apps
      behind the managed Front Door (ADR-0010, FD-3): sorted, de-duplicated, IPv6 dropped; fails
      unless there are 1 to ${FRONT_DOOR_RANGES_MAX} valid IPv4 CIDR ranges (none wider than /${FRONT_DOOR_PREFIX_MIN}). Writes
      { serviceTag, changeNumber, ipv4, ipv6, sha256, ranges }
`;

export function cmdFdRanges(v: { "service-tags": string; output: string }): string {
  const r = frontDoorBackendRanges(readJson(v["service-tags"], 64 * MiB, "--service-tags"));
  writeJson(v.output, r);
  return `OK  ${r.serviceTag}: ${r.ipv4} IPv4 range(s) (${r.ipv6} IPv6 dropped), change number ${r.changeNumber ?? "unknown"}, written to ${v.output}\n`;
}
