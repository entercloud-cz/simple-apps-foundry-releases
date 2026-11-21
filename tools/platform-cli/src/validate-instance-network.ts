import { caeSubnetCapacity, CONTAINER_APPS_RESERVED_RANGES, parseCidr, rangeContains, rangesOverlap } from "./cidr.js";
import type { Ipv4Range } from "./cidr.js";
import { pathOf } from "./validate-app.js";

/**
 * The network rules of `platform validate instance` (network-modes.md#sizing, ADR-0027) on a
 * schema-valid instance.yaml. Every address range the platform allocates belongs to one plan:
 *
 * - each range is a valid IPv4 range (the schema checks only digits and dots);
 * - none overlaps a range Container Apps reserves (cidr.ts);
 * - the subnets of a VNet the platform creates lie inside its address space, and the two subnets
 *   of one VNet don't overlap;
 * - no two VNets overlap, peered or not. An existing VNet is known by its subnets only, which
 *   stand for it. An overlap would block a later peering or hub connection;
 * - the CAE subnet of a prod environment is at least a /26 (the /27 floor is in the schema).
 *
 * The VNets: the External-only spoke (`network: vnet`), the connected spokes (`externalHybrid`,
 * `internalOnly`) and the portal's VNet. A managed-network External-only CAE has none.
 */
export interface ModeView {
  network?: string;
  vnetAddressSpace?: string;
  caeSubnetPrefix?: string;
  privateEndpointSubnetPrefix?: string;
  vnet?: { existingVnetId?: string; create?: { addressSpace?: string } };
  egressBaseline?: { status?: string };
  /** Capacity cells (ADR-0053, validate-instance.ts capacityCellChecks). */
  cells?: { id: string; capacity?: { cores?: number } }[];
}

export interface NetworkModesView {
  externalOnly?: ModeView;
  externalHybrid?: ModeView;
  internalOnly?: ModeView;
}

export interface PortalView {
  hostEnvironment?: string;
  network?: { vnetAddressSpace?: string; caeSubnetPrefix?: string; privateEndpointSubnetPrefix?: string; routeTableId?: string };
}

export interface NetworkView {
  environments: { name: string; kind?: string; networkModes?: NetworkModesView }[];
  portal?: PortalView;
  network?: { internalSystems?: { endpoints?: { cidr?: string }[] }[] };
}

type Segs = (string | number)[];
type Add = (segs: Segs, message: string) => void;

interface Placed {
  segs: Segs;
  range: Ipv4Range;
}

/** One VNet (or the subnets of an existing one) with the ranges instance.yaml gives it. */
interface Vnet {
  label: string;
  /** The address space, only where the platform creates the VNet. */
  space?: Placed;
  cae?: Placed;
  pe?: Placed;
  /** The CAE subnet belongs to an environment of kind prod. */
  prodCae: boolean;
}

interface VnetFields {
  label: string;
  spaceSegs: Segs;
  space: string | undefined;
  caeSegs: Segs;
  cae: string | undefined;
  peSegs: Segs;
  pe: string | undefined;
  prodCae: boolean;
}

const RESERVED: Ipv4Range[] = CONTAINER_APPS_RESERVED_RANGES.map((text) => {
  const p = parseCidr(text);
  if (!p.ok) throw new Error(`reserved range ${text}: ${p.message}`);
  return p.range;
});

export function networkChecks(inst: NetworkView, add: Add): void {
  const parseAt = (segs: Segs, value: string | undefined): Placed | undefined => {
    if (value === undefined) return undefined;
    const p = parseCidr(value);
    if (!p.ok) {
      add(segs, p.message);
      return undefined;
    }
    return { segs, range: p.range };
  };

  const vnets: Vnet[] = [];
  const vnet = (f: VnetFields): void => {
    const v: Vnet = { label: f.label, prodCae: f.prodCae };
    const space = parseAt(f.spaceSegs, f.space);
    const cae = parseAt(f.caeSegs, f.cae);
    const pe = parseAt(f.peSegs, f.pe);
    if (space) v.space = space;
    if (cae) v.cae = cae;
    if (pe) v.pe = pe;
    vnets.push(v);
  };

  inst.environments.forEach((env, i) => {
    const modes = env.networkModes ?? {};
    const at = (mode: string, ...rest: string[]): Segs => ["environments", i, "networkModes", mode, ...rest];
    const prodCae = env.kind === "prod";
    const eo = modes.externalOnly;
    if (eo?.network === "vnet") {
      vnet({
        label: `External-only VNet of ${env.name}`,
        spaceSegs: at("externalOnly", "vnetAddressSpace"),
        space: eo.vnetAddressSpace,
        caeSegs: at("externalOnly", "caeSubnetPrefix"),
        cae: eo.caeSubnetPrefix,
        peSegs: at("externalOnly", "privateEndpointSubnetPrefix"),
        pe: eo.privateEndpointSubnetPrefix,
        prodCae,
      });
    }
    for (const mode of ["externalHybrid", "internalOnly"] as const) {
      const m = modes[mode];
      if (!m) continue;
      vnet({
        label: `${mode} VNet of ${env.name}`,
        spaceSegs: at(mode, "vnet", "create", "addressSpace"),
        space: m.vnet?.create?.addressSpace,
        caeSegs: at(mode, "caeSubnetPrefix"),
        cae: m.caeSubnetPrefix,
        peSegs: at(mode, "privateEndpointSubnetPrefix"),
        pe: m.privateEndpointSubnetPrefix,
        prodCae,
      });
    }
  });
  const portal = inst.portal?.network;
  if (portal) {
    vnet({
      label: "portal VNet",
      spaceSegs: ["portal", "network", "vnetAddressSpace"],
      space: portal.vnetAddressSpace,
      caeSegs: ["portal", "network", "caeSubnetPrefix"],
      cae: portal.caeSubnetPrefix,
      peSegs: ["portal", "network", "privateEndpointSubnetPrefix"],
      pe: portal.privateEndpointSubnetPrefix,
      prodCae: false, // the portal's CAE carries the portal only: the /27 floor of the schema applies
    });
  }
  // Destinations of internal systems live on the customer's network: only well-formed.
  (inst.network?.internalSystems ?? []).forEach((s, i) =>
    (s.endpoints ?? []).forEach((e, j) => {
      parseAt(["network", "internalSystems", i, "endpoints", j, "cidr"], e.cidr);
    }),
  );

  const reserved = (p: Placed): void => {
    const hit = RESERVED.filter((r) => rangesOverlap(p.range, r));
    if (hit.length) {
      add(p.segs, `${p.range.text} overlaps ${hit.map((r) => r.text).join(", ")}, which Container Apps reserves for itself; choose another range (network-modes.md#sizing).`);
    }
  };

  for (const v of vnets) {
    const subnets = [v.cae, v.pe].filter((p): p is Placed => p !== undefined);
    if (v.space) reserved(v.space);
    for (const sn of subnets) {
      const inside = v.space !== undefined && rangeContains(v.space.range, sn.range);
      if (v.space && !inside) {
        add(sn.segs, `${sn.range.text} is outside the address space ${v.space.range.text} of the ${v.label} (${pathOf(v.space.segs)}); a subnet lies inside its VNet.`);
      }
      // A subnet inside a reserved address space is reported with the space.
      if (!inside) reserved(sn);
    }
    if (v.cae && v.pe && rangesOverlap(v.cae.range, v.pe.range)) {
      add(v.pe.segs, `${v.pe.range.text} overlaps the CAE subnet ${v.cae.range.text} (${pathOf(v.cae.segs)}); the CAE subnet is delegated to Container Apps and used by nothing else, so private endpoints need a subnet of their own.`);
    }
    if (v.prodCae && v.cae && v.cae.range.prefix > 26) {
      const { maxReplicas } = caeSubnetCapacity(v.cae.range.prefix);
      add(v.cae.segs, `the CAE subnet of a prod environment is a /26 or larger, and ${v.cae.range.text} holds about ${maxReplicas} replicas in all (a /26 about 250, the default /25 about 570). A subnet can't be resized once its CAE exists; /27 is for pilots only (network-modes.md#sizing).`);
    }
  }

  // No two VNets overlap. An existing VNet has no address space here: its subnets stand for it.
  const standIns: { vnet: Vnet; placed: Placed }[] = vnets.flatMap((v) =>
    v.space ? [{ vnet: v, placed: v.space }] : [v.cae, v.pe].filter((p): p is Placed => p !== undefined).map((placed) => ({ vnet: v, placed })),
  );
  standIns.forEach((later, j) => {
    const earlier = standIns.slice(0, j).find((e) => e.vnet !== later.vnet && rangesOverlap(e.placed.range, later.placed.range));
    if (earlier) {
      add(
        later.placed.segs,
        `${later.placed.range.text} (${later.vnet.label}) overlaps ${earlier.placed.range.text} (${earlier.vnet.label}, ${pathOf(earlier.placed.segs)}); the ranges of one instance don't overlap, peered or not, so a later peering or hub connection stays possible.`,
      );
    }
  });
}
