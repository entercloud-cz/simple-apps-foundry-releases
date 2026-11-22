/**
 * IPv4 ranges for `platform validate instance` (network sections of instance.yaml) and Container
 * Apps subnet capacity. Pure functions, no I/O, safe to import from the portal.
 *
 * Addresses are plain numbers (0 .. 2^32-1), never signed 32-bit integers.
 */

export interface Ipv4Range {
  /** The range as written, e.g. 10.20.0.0/25. */
  text: string;
  prefix: number;
  /** First address. */
  start: number;
  /** Last address. */
  end: number;
}

export type CidrParse = { ok: true; range: Ipv4Range } | { ok: false; message: string };

const SHAPE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/;

export function formatIpv4(n: number): string {
  return [Math.floor(n / 2 ** 24) % 256, Math.floor(n / 2 ** 16) % 256, Math.floor(n / 2 ** 8) % 256, n % 256].join(".");
}

/**
 * Parses `a.b.c.d/n`. The instance schema only checks the shape (digits and dots), so this also
 * rejects octets above 255 and a prefix above 32, and an address with host bits set (10.20.0.1/25):
 * the network address is what a VNet or subnet takes.
 *
 * TODO(verify): that Azure refuses an address prefix with host bits set (InvalidCIDRNotation) is
 * from memory of the error, not from a deployment; the check is offline only. Verify in sandbox: NET-5.
 */
export function parseCidr(text: string): CidrParse {
  const m = SHAPE.exec(text);
  if (!m) return { ok: false, message: `"${text}" is not an IPv4 range in CIDR notation (for example 10.20.0.0/24).` };
  const octets = m.slice(1, 5).map(Number);
  const prefix = Number(m[5]);
  if (octets.some((o) => o > 255)) return { ok: false, message: `"${text}" is not an IPv4 range: an address part is above 255.` };
  if (prefix > 32) return { ok: false, message: `"${text}" is not an IPv4 range: the prefix length is above 32.` };
  const address = ((octets[0]! * 256 + octets[1]!) * 256 + octets[2]!) * 256 + octets[3]!;
  const size = 2 ** (32 - prefix);
  if (address % size !== 0) {
    const network = address - (address % size);
    return { ok: false, message: `"${text}" has host bits set; the network address of that range is ${formatIpv4(network)}/${prefix}.` };
  }
  return { ok: true, range: { text, prefix, start: address, end: address + size - 1 } };
}

export function rangesOverlap(a: Ipv4Range, b: Ipv4Range): boolean {
  return a.start <= b.end && b.start <= a.end;
}

/** `inner` lies completely inside `outer` (equal ranges contain each other). */
export function rangeContains(outer: Ipv4Range, inner: Ipv4Range): boolean {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/**
 * Ranges that Container Apps reserves (network-modes.md#sizing, spike 2026-10-26): the first four
 * for every environment, the `100.100.*` ones in addition for workload-profile environments, which
 * is every environment this platform deploys. They must not overlap any range of an instance.
 *
 * TODO(verify): the Microsoft documentation names them for the subnet of the environment; this
 * platform also refuses them for a VNet's address space, as network-modes.md says ("Ranges must
 * not overlap"). Re-check against the page when it changes. Verify in sandbox: NET-5.
 */
export const CONTAINER_APPS_RESERVED_RANGES: readonly string[] = [
  "169.254.0.0/16",
  "172.30.0.0/16",
  "172.31.0.0/16",
  "192.0.2.0/24",
  "100.100.0.0/17",
  "100.100.128.0/19",
  "100.100.160.0/19",
  "100.100.192.0/19",
];

/** Addresses of a subnet that Container Apps keeps for itself and Azure (network-modes.md#sizing). */
export const CAE_RESERVED_IPS = 14;

/**
 * What a Container Apps environment subnet of this prefix length holds (the capacity table of
 * network-modes.md#sizing): `usable` = addresses - 14, `maxReplicas` = the sum of maxReplicas of
 * all apps it carries, from `14 + 2 x ceil(sum(maxReplicas) / 10)` <= addresses. /27 -> 90,
 * /26 -> 250, /25 -> 570, /24 -> 1210. 0 when the subnet is smaller than the /27 minimum.
 *
 * TODO(verify): NET-1 to NET-3 (idle use, whether job executions consume IPs, the Consumption
 * cores quota); the model is the Microsoft documentation's, not measured.
 */
export function caeSubnetCapacity(prefixLength: number): { addresses: number; usable: number; maxReplicas: number } {
  const addresses = 2 ** (32 - prefixLength);
  const usable = Math.max(0, addresses - CAE_RESERVED_IPS);
  return { addresses, usable, maxReplicas: prefixLength > 27 ? 0 : 10 * Math.floor(usable / 2) };
}

/** IPs a CAE subnet needs for apps whose maxReplicas add up to `sumMaxReplicas`: 14 + 2 x ceil(sum / 10). */
export function caeSubnetIpsNeeded(sumMaxReplicas: number): number {
  return CAE_RESERVED_IPS + 2 * Math.ceil(sumMaxReplicas / 10);
}
