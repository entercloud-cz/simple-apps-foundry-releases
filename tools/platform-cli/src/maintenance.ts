/**
 * The instance's maintenance window (ADR-0048): one window for all scheduled provisioning work. The maintenance
 * run of \platform\provisioning starts at the window's start on each of its days; drift checks, Easy Auth rotations,
 * the Front Door backend ranges and the upgrades the portal schedules (ADR-0049) happen in it.
 *
 * instance.yaml `maintenance` is validated by config/schema/instance.schema.json; this module only applies the
 * defaults (the schema's `default`s, repeated here) and renders the cron of the schedule. Shared by the CLI
 * (`platform generate`, the provisioning plan) and the portal (Settings, the upgrade scheduler). The registry
 * retention (ADR-0059) is maintenance work too: old build images are purged in the window.
 */

export const WEEK_DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type WeekDay = (typeof WEEK_DAYS)[number];

export interface MaintenanceWindow {
  /** Nights that start on these days, in week order, without duplicates. */
  days: WeekDay[];
  /** UTC, HH:MM: Azure Pipelines schedules are UTC. */
  start: string;
  hours: number;
}

/** Old build images in the app registries of build environments (ADR-0059). */
export interface RegistryRetention {
  /** purge: delete what the rules allow; dryRun: only report it; off: nothing. */
  mode: "purge" | "dryRun" | "off";
  /** An image younger than this many days is kept (at least 45: longer than any wait for a promotion). */
  days: number;
  /** The app's newest builds that are always kept. */
  keepLatest: number;
}

export const REGISTRY_RETENTION_MODES = ["purge", "dryRun", "off"] as const;

export interface MaintenanceSettings {
  window: MaintenanceWindow;
  /** A unit not checked for this many days is checked again (ADR-0048 rule 5). */
  driftCheckDays: number;
  /** Default time to apply a required upgrade (ADR-0049). */
  requiredUpgradeDays: number;
  /** Instance default for app upgrades (ADR-0049). */
  upgrades: "manual" | "automatic";
  /** Old build images purged in the window (ADR-0059). */
  registryRetention: RegistryRetention;
}

export const MAINTENANCE_DEFAULTS: Readonly<MaintenanceSettings> = Object.freeze({
  window: Object.freeze({ days: ["mon", "tue", "wed", "thu"] as WeekDay[], start: "20:00", hours: 6 }),
  driftCheckDays: 30,
  requiredUpgradeDays: 14,
  upgrades: "manual",
  registryRetention: Object.freeze({ mode: "dryRun", days: 90, keepLatest: 10 }) as RegistryRetention,
});

const START_RE = /^([01][0-9]|2[0-3]):([0-5][0-9])$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function intIn(v: unknown, min: number, max: number): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v >= min && v <= max ? v : undefined;
}

/**
 * `maintenance` of an instance with the defaults applied. Expects a schema-validated instance; a value of the wrong
 * shape falls back to its default rather than throwing, so a caller that runs before validation never crashes.
 */
export function maintenanceOf(inst: { maintenance?: unknown } | undefined): MaintenanceSettings {
  const m = isObj(inst?.maintenance) ? inst.maintenance : {};
  const w = isObj(m.window) ? m.window : {};
  const days = Array.isArray(w.days) ? WEEK_DAYS.filter((d) => (w.days as unknown[]).includes(d)) : [];
  const r = isObj(m.registryRetention) ? m.registryRetention : {};
  const rd = MAINTENANCE_DEFAULTS.registryRetention;
  return {
    window: {
      days: days.length ? days : [...MAINTENANCE_DEFAULTS.window.days],
      start: typeof w.start === "string" && START_RE.test(w.start) ? w.start : MAINTENANCE_DEFAULTS.window.start,
      hours: intIn(w.hours, 1, 24) ?? MAINTENANCE_DEFAULTS.window.hours,
    },
    driftCheckDays: intIn(m.driftCheckDays, 1, 90) ?? MAINTENANCE_DEFAULTS.driftCheckDays,
    requiredUpgradeDays: intIn(m.requiredUpgradeDays, 1, 180) ?? MAINTENANCE_DEFAULTS.requiredUpgradeDays,
    upgrades: m.upgrades === "automatic" ? "automatic" : "manual",
    registryRetention: {
      mode: (REGISTRY_RETENTION_MODES as readonly unknown[]).includes(r.mode) ? (r.mode as RegistryRetention["mode"]) : rd.mode,
      days: intIn(r.days, 45, 3650) ?? rd.days,
      keepLatest: intIn(r.keepLatest, 1, 100) ?? rd.keepLatest,
    },
  };
}

/** Cron (UTC, Azure Pipelines syntax) of the maintenance run: the window's start on each of its days, e.g. `0 20 * * 1,2,3,4`. */
export function maintenanceCron(m: MaintenanceSettings): string {
  const match = START_RE.exec(m.window.start);
  if (!match) throw new Error(`maintenance.window.start "${m.window.start}" is not HH:MM`);
  const dow = m.window.days.map((d) => (WEEK_DAYS.indexOf(d) + 1) % 7).sort((a, b) => a - b);
  return `${Number(match[2])} ${Number(match[1])} * * ${dow.join(",")}`;
}

/**
 * The first start of the maintenance window at or after `from` (UTC): the time the maintenance run is scheduled. The
 * portal shows it (the next Easy Auth renewal, the Settings preview in the viewer's local time).
 */
export function nextWindowStart(window: Pick<MaintenanceWindow, "days" | "start">, from: Date): Date {
  const match = START_RE.exec(window.start);
  if (!match) throw new Error(`maintenance.window.start "${window.start}" is not HH:MM`);
  const days = new Set(window.days.map((d) => (WEEK_DAYS.indexOf(d) + 1) % 7));
  if (days.size === 0) throw new Error("maintenance.window.days is empty");
  for (let i = 0; i <= 7; i++) {
    const at = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + i, Number(match[1]), Number(match[2])));
    if (days.has(at.getUTCDay()) && at.getTime() >= from.getTime()) return at;
  }
  throw new Error("unreachable: a window day comes within eight days");
}

/** Whether a time is inside the maintenance window, and that window's bounds when it is. */
export interface WindowAt {
  inside: boolean;
  /** The start of the window the time is in; undefined outside. */
  start?: Date;
  /** Its end (start + hours, exclusive); undefined outside. */
  end?: Date;
}

/**
 * Whether `at` is inside the maintenance window (ADR-0048 section 7, amended 2026-11-11): a window
 * starts at `start` (UTC) on each of its days and lasts `hours`, so it can run past midnight into the
 * next day. Inside means start <= at < start + hours, for the start on the same UTC day or on the day
 * before. Pure: the provisioning plan passes the run's time, so the decision depends on the clock and
 * instance.yaml only, never on what started the run (rule P19).
 */
export function windowAt(window: MaintenanceWindow, at: Date): WindowAt {
  const match = START_RE.exec(window.start);
  if (!match) throw new Error(`maintenance.window.start "${window.start}" is not HH:MM`);
  if (!Number.isInteger(window.hours) || window.hours < 1 || window.hours > 24) throw new Error("maintenance.window.hours must be 1 to 24");
  const days = new Set(window.days.map((d) => (WEEK_DAYS.indexOf(d) + 1) % 7));
  for (const back of [0, 1]) {
    const start = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() - back, Number(match[1]), Number(match[2])));
    const end = new Date(start.getTime() + window.hours * 3_600_000);
    if (days.has(start.getUTCDay()) && start.getTime() <= at.getTime() && at.getTime() < end.getTime()) return { inside: true, start, end };
  }
  return { inside: false };
}
