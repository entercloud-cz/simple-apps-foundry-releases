/**
 * Capacity cells and app capacity reservations (ADR-0053).
 *
 * A cell is one Container Apps environment (CAE) of one network mode in one environment, with its
 * platform jobs and, in a VNet-based mode, its CAE subnet. instance.yaml lists the cells of a mode
 * (`environments[].networkModes.<mode>.cells`, absent = one cell 01 with the default budget). Each
 * app x environment runs in one cell (app.yaml `environments.<env>.cell`, default 01) and reserves its
 * maximum (`environments.<env>.capacity`, absent = instance.yaml `newApps.capacity`, default size s
 * with 3 replicas). Reserved cores = the size's vCPU x maxReplicas.
 *
 * The checks built on this module:
 * - `platform validate app` with the other app definitions (and so the pull request validation of
 *   platform-config and the portal's forms): a cell's reserved cores stay within its budget, and in a
 *   VNet-based mode the sum of maxReplicas within its subnet's capacity (caeSubnetCapacity);
 * - delivery (`platform pipeline release-inputs`): platform.yaml's size and maxReplicas stay within the
 *   app's reservation in each environment (pipeline check capacity-reservation, enforceFrom).
 *
 * Browser-safe on purpose (package.json exports "./capacity"): the portal's wizard, app page and
 * platform overview use the same numbers. Keep Node imports out. Cores are counted in quarters
 * (xs = 1) so sums are exact.
 */
import { caeSubnetCapacity } from "./cidr.js";

export const CAPACITY_SIZES = ["xs", "s", "m", "l"] as const;
export type CapacitySize = (typeof CAPACITY_SIZES)[number];

/** vCPU of a container size (app-manifest.schema.json runtime.size). */
export const SIZE_VCPU: Readonly<Record<CapacitySize, number>> = { xs: 0.25, s: 0.5, m: 1, l: 2 };
/** Quarter cores of a size: exact arithmetic for sums. */
const QUARTERS: Readonly<Record<CapacitySize, number>> = { xs: 1, s: 2, m: 4, l: 8 };

export interface CapacityReservation {
  size: CapacitySize;
  maxReplicas: number;
}

/** The schema's defaults of instance.yaml newApps.capacity and a cell's capacity.cores. */
export const DEFAULT_RESERVATION: Readonly<CapacityReservation> = { size: "s", maxReplicas: 3 };
export const DEFAULT_CELL_CORES = 80;
export const DEFAULT_CELL_ID = "01";
export const MAX_REPLICAS_LIMIT = 10;
export const CELL_ID_RE = /^(0[1-9]|[1-9][0-9])$/;

/** Network modes an app can run in, and those whose CAE sits in a subnet. */
export type CellNetworkMode = "externalOnly" | "externalHybrid" | "internalOnly";

/** What capacity code reads from instance.yaml (a structural subset; the schema validated the rest). */
export interface CapacityInstanceView {
  environments: {
    name: string;
    networkModes?: Partial<
      Record<
        CellNetworkMode,
        | {
            network?: string;
            caeSubnetPrefix?: string;
            cells?: { id: string; capacity?: { cores?: number } }[];
          }
        | undefined
      >
    >;
  }[];
  newApps?: { capacity?: { size?: CapacitySize; maxReplicas?: number } };
}

/** What capacity code reads from an app definition. */
export interface CapacityAppView {
  slug: string;
  environments: Record<string, { networkMode: string; cell?: string; capacity?: CapacityReservation } | undefined>;
}

export const sizeIndex = (size: CapacitySize): number => CAPACITY_SIZES.indexOf(size);

/** Reserved quarter cores of a reservation (size vCPU x 4 x maxReplicas). */
export const reservedQuarters = (r: CapacityReservation): number => QUARTERS[r.size] * r.maxReplicas;

/** Reserved cores of a reservation: the size's vCPU x maxReplicas. */
export const reservedCores = (r: CapacityReservation): number => reservedQuarters(r) / 4;

/** Cores as people read them: 1.5, 0.25, 12. */
export const formatCores = (cores: number): string => String(Math.round(cores * 100) / 100);

/** instance.yaml newApps.capacity with the schema's defaults. */
export function defaultReservation(inst: Pick<CapacityInstanceView, "newApps">): CapacityReservation {
  const c = inst.newApps?.capacity;
  return { size: c?.size ?? DEFAULT_RESERVATION.size, maxReplicas: c?.maxReplicas ?? DEFAULT_RESERVATION.maxReplicas };
}

/** An app's reservation in an environment: app.yaml capacity, else the instance default. */
export function reservationOf(env: { capacity?: CapacityReservation } | undefined, inst: Pick<CapacityInstanceView, "newApps">): CapacityReservation {
  return env?.capacity ? { size: env.capacity.size, maxReplicas: env.capacity.maxReplicas } : defaultReservation(inst);
}

/** An app's cell in an environment: app.yaml cell, else 01. */
export const cellOf = (env: { cell?: string } | undefined): string => env?.cell ?? DEFAULT_CELL_ID;

/** Whether a mode's CAE sits in a subnet the platform sizes (externalOnly network vnet, the connected modes). */
export function isVnetMode(mode: string, config: { network?: string } | undefined): boolean {
  if (mode === "externalOnly") return config?.network === "vnet";
  return mode === "externalHybrid" || mode === "internalOnly";
}

export interface CellDefinition {
  id: string;
  /** Budget of reserved cores. */
  cores: number;
}

/** The cells of a mode with their budgets (absent = one cell 01 with the default budget). */
export function cellsOfMode(config: { cells?: { id: string; capacity?: { cores?: number } }[] } | undefined): CellDefinition[] {
  const cells = config?.cells;
  if (!cells || cells.length === 0) return [{ id: DEFAULT_CELL_ID, cores: DEFAULT_CELL_CORES }];
  return cells.map((c) => ({ id: c.id, cores: c.capacity?.cores ?? DEFAULT_CELL_CORES }));
}

/**
 * The most replicas (sum of maxReplicas) a cell's CAE subnet holds, or undefined when the mode has no
 * subnet. Cell 01 uses the mode's caeSubnetPrefix; a later cell's subnet comes with the platform
 * pipeline's next increment (ADR-0053 section 5), so it has none yet.
 */
export function cellSubnetReplicas(mode: string, config: { network?: string; caeSubnetPrefix?: string } | undefined, cell: string): { prefix: string; maxReplicas: number } | undefined {
  if (!isVnetMode(mode, config) || cell !== DEFAULT_CELL_ID || !config?.caeSubnetPrefix) return undefined;
  const m = /\/(\d{1,2})$/.exec(config.caeSubnetPrefix);
  if (!m) return undefined;
  return { prefix: config.caeSubnetPrefix, maxReplicas: caeSubnetCapacity(Number(m[1])).maxReplicas };
}

/** One app's share of a cell. */
export interface CellApp {
  slug: string;
  reservation: CapacityReservation;
  /** True when app.yaml sets no capacity (the instance default applies). */
  isDefault: boolean;
  reservedCores: number;
}

/** A cell with what its apps reserve (the platform overview, the wizard, the checks). */
export interface CellUsage {
  environment: string;
  networkMode: CellNetworkMode;
  cell: string;
  /** Budget of reserved cores. */
  cores: number;
  reservedCores: number;
  /** Budget minus reserved (negative when overcommitted). */
  freeCores: number;
  /** Sum of the apps' maxReplicas. */
  replicas: number;
  /** VNet-based modes, cell 01: the CAE subnet and the replicas it holds. */
  subnet?: { prefix: string; maxReplicas: number };
  apps: CellApp[];
}

/**
 * Every cell of the instance (each environment, each enabled mode, each cell) with the reservations of
 * the apps placed in it, in instance order. Apps that name a cell or mode the instance doesn't have are
 * left out (validation reports them).
 */
export function cellUsage(inst: CapacityInstanceView, apps: readonly CapacityAppView[]): CellUsage[] {
  const out: CellUsage[] = [];
  const byKey = new Map<string, CellUsage>();
  for (const env of inst.environments) {
    for (const mode of ["externalOnly", "externalHybrid", "internalOnly"] as const) {
      const config = env.networkModes?.[mode];
      if (config === undefined) continue;
      for (const c of cellsOfMode(config)) {
        const subnet = cellSubnetReplicas(mode, config, c.id);
        const u: CellUsage = { environment: env.name, networkMode: mode, cell: c.id, cores: c.cores, reservedCores: 0, freeCores: c.cores, replicas: 0, ...(subnet ? { subnet } : {}), apps: [] };
        out.push(u);
        byKey.set(`${env.name}|${mode}|${c.id}`, u);
      }
    }
  }
  const sorted = [...apps].sort((a, b) => a.slug.localeCompare(b.slug));
  for (const app of sorted) {
    for (const [name, e] of Object.entries(app.environments)) {
      if (!e) continue;
      const u = byKey.get(`${name}|${e.networkMode}|${cellOf(e)}`);
      if (!u) continue;
      const reservation = reservationOf(e, inst);
      u.apps.push({ slug: app.slug, reservation, isDefault: !e.capacity, reservedCores: reservedCores(reservation) });
    }
  }
  for (const u of out) {
    const q = u.apps.reduce((sum, a) => sum + reservedQuarters(a.reservation), 0);
    u.reservedCores = q / 4;
    u.freeCores = (u.cores * 4 - q) / 4;
    u.replicas = u.apps.reduce((sum, a) => sum + a.reservation.maxReplicas, 0);
  }
  return out;
}

/**
 * The cell a new app (or a new environment of an app) is placed in (ADR-0053 section 2): of the mode's
 * cells in that environment, the one with the most free cores that fits the reservation (cores, and
 * replicas where the cell has a subnet); ties go to the lower id. undefined when none fits.
 */
export function placeInCell(usage: readonly CellUsage[], environment: string, networkMode: string, reservation: CapacityReservation): string | undefined {
  const need = reservedCores(reservation);
  const fits = usage
    .filter((u) => u.environment === environment && u.networkMode === networkMode)
    .filter((u) => u.freeCores >= need && (!u.subnet || u.replicas + reservation.maxReplicas <= u.subnet.maxReplicas))
    .sort((a, b) => b.freeCores - a.freeCores || a.cell.localeCompare(b.cell));
  return fits[0]?.cell;
}

/** Whether a runtime (platform.yaml size and maxReplicas) stays within a reservation. */
export function withinReservation(runtime: { size: CapacitySize; maxReplicas: number }, reservation: CapacityReservation): boolean {
  return sizeIndex(runtime.size) <= sizeIndex(reservation.size) && runtime.maxReplicas <= reservation.maxReplicas;
}

// ------------------------------------------------------------------------------------------
// Names of a cell (ports of naming.bicep cellManagedEnvironment, cellCaeSubnet,
// cellCaeNetworkSecurityGroup and cellPlatformJob; test/capacity.test.ts compares them with
// infra/tests/naming-vectors.json). Cell 01 keeps today's names; a later cell gets -c{cell}.
// ------------------------------------------------------------------------------------------

const TOKEN_RE = /^[a-z][a-z0-9]*$/;
const MODE_ABBREVIATION: Readonly<Record<string, string>> = { externalOnly: "ext", externalHybrid: "hyb", internalOnly: "int" };

function token(value: string, min: number, max: number, what: string): string {
  if (value.length < min || value.length > max || !TOKEN_RE.test(value)) throw new Error(`naming: invalid ${what} "${value}" (${min}-${max} characters, ^[a-z][a-z0-9]{${min - 1},${max - 1}}$, ADR-0020).`);
  return value;
}
function abbreviation(mode: string): string {
  const a = Object.hasOwn(MODE_ABBREVIATION, mode) ? MODE_ABBREVIATION[mode] : undefined;
  if (!a) throw new Error(`naming: unknown network mode "${mode}".`);
  return a;
}
function suffix(cell: string): string {
  if (!CELL_ID_RE.test(cell)) throw new Error(`naming: invalid cell id "${cell}" (two digits, 01 to 99, ADR-0053).`);
  return cell === DEFAULT_CELL_ID ? "" : `-c${cell}`;
}
function fit(max: number, name: string): string {
  if (name.length > max) throw new Error(`naming: "${name}" is ${name.length} characters, limit ${max}.`);
  return name;
}

/** cae-{prefix}-{mode}-{env}[-c{cell}] */
export const cellManagedEnvironmentName = (prefix: string, mode: string, env: string, cell: string): string =>
  fit(32, `cae-${token(prefix, 2, 8, "instance prefix")}-${abbreviation(mode)}-${token(env, 2, 8, "environment name")}${suffix(cell)}`);
/** snet-{prefix}-cae-{mode}-{env}[-c{cell}] */
export const cellCaeSubnetName = (prefix: string, mode: string, env: string, cell: string): string =>
  fit(80, `snet-${token(prefix, 2, 8, "instance prefix")}-cae-${abbreviation(mode)}-${token(env, 2, 8, "environment name")}${suffix(cell)}`);
/** nsg-{prefix}-cae-{mode}-{env}[-c{cell}] */
export const cellCaeNetworkSecurityGroupName = (prefix: string, mode: string, env: string, cell: string): string =>
  fit(80, `nsg-${token(prefix, 2, 8, "instance prefix")}-cae-${abbreviation(mode)}-${token(env, 2, 8, "environment name")}${suffix(cell)}`);
/** caj-{prefix}-{step}-{mode}[-c{cell}] */
export const cellPlatformJobName = (prefix: string, step: string, mode: string, cell: string): string =>
  fit(31, `caj-${token(prefix, 2, 8, "instance prefix")}-${token(step, 2, 6, "job key")}-${abbreviation(mode)}${suffix(cell)}`);
