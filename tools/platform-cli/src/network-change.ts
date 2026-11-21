/**
 * The network fields of an environment in instance.yaml and when they may change (ADR-0027 amendment
 * 2026-11-12, network-modes.md). Browser-safe on purpose (package.json exports
 * "./network-change"): `platform validate instance --base` refuses the changes in Node, and the
 * portal's Settings area uses the same list to show which fields it may edit.
 *
 * An environment is in use when an app definition (apps/<slug>/app.yaml) lists it under
 * `environments`, unless the app is decommissioned and its deleteAfter has passed (ADR-0056: it can't
 * come back, and what is left of it is being deleted). The network fields of an environment in use
 * never change: its apps' Container Apps, private endpoints and firewall rules depend on them.
 *
 * Without apps, a field may change unless Azure can't change it once the platform pipeline has
 * deployed the environment (`fixedOnceDeployed`). The platform pipeline deploys an environment's
 * Container Apps environments (CAEs), their subnets and the environment vault's private endpoint
 * whether apps exist or not (environment.bicep), so these stay as they are:
 *
 *   externalOnly.network          a CAE's network type can't change after creation (Microsoft Learn,
 *                                 Networking in Azure Container Apps)
 *   <mode>.caeSubnetPrefix        the CAE's subnet; a subnet in use can't change its range
 *   <mode>.privateEndpointSubnetPrefix  holds the private endpoint of the environment's private vault
 *   <mode>.vnet.existingVnetId    the CAE's subnets are in that VNet
 *   hub.vnetId                    the spoke's peering names its remote VNet, which can't change
 *
 * `platform validate instance` refuses those only for an environment in use: it can't see whether the
 * environment has been deployed either, and an operator may fix them by hand before the first run of
 * the platform pipeline (the deployment fails loudly when Azure refuses). The portal keeps them locked
 * for every environment. TODO(verify): a subnet with resources can't change its range; a route table
 * and a VNet's DNS servers can change on a subnet in use by a CAE; a peered VNet's address space
 * can change (the hub side then needs a peering sync). Verify in sandbox: SET-7, SET-8.
 */

export const NETWORK_MODES = ["externalOnly", "externalHybrid", "internalOnly"] as const;
export type NetworkModeName = (typeof NETWORK_MODES)[number];

/** A network field of an environment: its path below the environment, and whether it is fixed once deployed. */
export interface NetworkField {
  /** Dotted path below the environment, e.g. networkModes.externalHybrid.routeTableId. */
  path: string;
  /** Azure can't change it once the platform pipeline has deployed the environment. */
  fixedOnceDeployed: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const MODE_FIELDS: Record<NetworkModeName, readonly [string, boolean][]> = {
  externalOnly: [
    ["network", true],
    ["vnetAddressSpace", false],
    ["caeSubnetPrefix", true],
    ["privateEndpointSubnetPrefix", true],
    ["natGatewayPublicIpCount", false],
  ],
  externalHybrid: [
    ["vnet.existingVnetId", true],
    ["vnet.create.addressSpace", false],
    ["vnet.create.useRemoteGateways", false],
    ["caeSubnetPrefix", true],
    ["privateEndpointSubnetPrefix", true],
    ["routeTableId", false],
    ["dnsServers", false],
  ],
  internalOnly: [
    ["vnet.existingVnetId", true],
    ["vnet.create.addressSpace", false],
    ["vnet.create.useRemoteGateways", false],
    ["caeSubnetPrefix", true],
    ["privateEndpointSubnetPrefix", true],
    ["routeTableId", false],
    ["dnsServers", false],
  ],
};

/** Every network field of an environment, in a fixed order: the hub, then each mode's. */
export const NETWORK_FIELDS: readonly NetworkField[] = [
  { path: "hub.vnetId", fixedOnceDeployed: true },
  { path: "hub.firewallPrivateIp", fixedOnceDeployed: false },
  ...NETWORK_MODES.flatMap((mode) => MODE_FIELDS[mode].map(([p, fixed]) => ({ path: `networkModes.${mode}.${p}`, fixedOnceDeployed: fixed }))),
];

const at = (env: unknown, path: string): unknown => {
  let n: unknown = env;
  for (const k of path.split(".")) n = isObj(n) ? n[k] : undefined;
  return n;
};

/** A field's value in effect: the schema's defaults (network managed, one NAT IP with vnet, no DNS servers, no remote gateways) count as set. */
export function networkValue(env: unknown, path: string): unknown {
  const v = at(env, path);
  if (v !== undefined) return v;
  const mode = /^networkModes\.(\w+)\./.exec(path)?.[1];
  if (!mode || !isObj(at(env, `networkModes.${mode}`))) return undefined;
  if (path === "networkModes.externalOnly.network") return "managed";
  if (path === "networkModes.externalOnly.natGatewayPublicIpCount") return at(env, "networkModes.externalOnly.network") === "vnet" ? 1 : undefined;
  if (path.endsWith(".dnsServers")) return [];
  if (path.endsWith(".vnet.create.useRemoteGateways")) return isObj(at(env, `networkModes.${mode}.vnet.create`)) ? false : undefined;
  return undefined;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The network fields that differ between two versions of one environment. A mode that only one of
 * them has is not compared (adding a mode is a new CAE; removing one that apps use fails their
 * validation), and neither is the hub when only one of them has it.
 */
export function changedNetworkFields(before: unknown, after: unknown): NetworkField[] {
  return NETWORK_FIELDS.filter((f) => {
    const owner = f.path.startsWith("hub.") ? "hub" : f.path.split(".").slice(0, 2).join(".");
    if (!isObj(at(before, owner)) || !isObj(at(after, owner))) return false;
    return !same(networkValue(before, f.path), networkValue(after, f.path));
  });
}

/** An app definition as far as the environments it uses go. */
export interface AppEnvironmentsView {
  environments?: unknown;
  decommission?: unknown;
}

/**
 * The environments some app uses: every key of an app definition's `environments`, except those of a
 * decommissioned app from its deleteAfter on (`today`, UTC, default now; ADR-0056: its delete phase
 * has started and it can't come back). Before that, Cancel would bring it back where it was.
 */
export function environmentsInUseOf(apps: Iterable<AppEnvironmentsView>, today: string = new Date().toISOString().slice(0, 10)): Set<string> {
  const out = new Set<string>();
  for (const app of apps) {
    const d = isObj(app.decommission) ? app.decommission : undefined;
    // deleteAfter is a calendar date (YYYY-MM-DD): the string comparison is the date comparison.
    if (typeof d?.deleteAfter === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d.deleteAfter) && d.deleteAfter <= today) continue;
    if (isObj(app.environments)) for (const name of Object.keys(app.environments)) out.add(name);
  }
  return out;
}
