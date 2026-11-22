/**
 * App decommissioning (ADR-0056): the `decommission` block of app.yaml and the `decommission`
 * section of instance.yaml, shared by validation, `platform generate`, the provisioning plan and the
 * portal (through the library).
 *
 *   active     no block
 *   retired    the block, and the delete phase not (yet) due: the app is stopped, its delivery
 *              pipeline disabled, every other unit frozen; Cancel (the block removed) starts it again
 *   deleting   the block, deleteAfter reached, graceDays since the stop in every environment, inside
 *              the maintenance window: the plan's decision (provisioning/units.ts), not an offline one
 *   deleted    the block, and nothing of the app is left in Azure: the plan finds it out from the lists
 *              it reads anyway (provisioning/units.ts; ADR-0056 amendment 2026-11-12, deleted
 *              detected). Nobody marks it: the definition stays as it is in apps/{slug}/ until a new
 *              app asks for the slug; that request moves it to apps-deleted/{slug}/{requestedOn}/
 *              (ADR-0061, archive.ts), where nothing provisions it
 *
 * Offline (validation, the other apps' checks) only the dates are known: from deleteAfter on
 * (`offlinePhase` due) the decommissioning can't be cancelled any more (check
 * decommission-tombstone), and the app's custom hosts, capacity and environments no longer count for
 * the other apps.
 *
 * Immediate mode (ADR-0056 amendment 2026-11-12): `immediate: true` on an app with no environment of
 * kind prod in its app.yaml (check decommission-immediate). deleteAfter equals requestedOn; the plan
 * skips the grace period and the maintenance-window gate of the delete phase, never its order or
 * guards: the first run stops the app and deletes what lies outside its resource groups (step 1), a
 * later run deletes the groups (step 2). instance.yaml decommission.allowImmediateWithProduction
 * (amendment 2026-11-21, platform development only, never a production deployment) allows it for an
 * app with production too (immediateAllowed); `platform validate instance` warns while it is on.
 */

export interface DecommissionBlock {
  requestedOn: string;
  deleteAfter: string;
  reason: string;
  requestedBy: { objectId: string; displayName: string };
  /** ADR-0056 amendment 2026-11-12: delete without grace period or maintenance window (no production only). */
  immediate?: true;
}

export interface DecommissionSettings {
  graceDays: number;
  repository: "keep" | "delete";
  /** Immediate deletion also for an app with production (amendment 2026-11-21): platform development only. */
  allowImmediateWithProduction: boolean;
}

/** instance.yaml decommission defaults (config/schema/instance.schema.json). */
export const DECOMMISSION_DEFAULTS: Readonly<DecommissionSettings> = { graceDays: 30, repository: "keep", allowImmediateWithProduction: false };

/** What instance.yaml `decommission` may say (every key optional; the schema checks the types). */
export interface DecommissionInstanceView {
  decommission?: { graceDays?: number; repository?: "keep" | "delete"; allowImmediateWithProduction?: boolean };
}

/** The reminder mail goes this many days before deleteAfter (ADR-0056 section 11). */
export const DECOMMISSION_REMINDER_DAYS = 7;

export function decommissionSettings(inst: DecommissionInstanceView): DecommissionSettings {
  const d = inst.decommission ?? {};
  return {
    graceDays: Number.isSafeInteger(d.graceDays) && (d.graceDays as number) >= 7 && (d.graceDays as number) <= 365 ? (d.graceDays as number) : DECOMMISSION_DEFAULTS.graceDays,
    repository: d.repository === "delete" ? "delete" : "keep",
    // Only an explicit true turns it on.
    allowImmediateWithProduction: d.allowImmediateWithProduction === true,
  };
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date YYYY-MM-DD. */
export function isDate(d: unknown): d is string {
  if (typeof d !== "string" || !DATE_RE.test(d)) return false;
  const t = Date.parse(`${d}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === d;
}

export function dayNumber(d: string): number {
  return Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000);
}

export function addDays(d: string, n: number): string {
  return new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);
}

/** Days from a to b (b - a). */
export function daysBetween(a: string, b: string): number {
  return dayNumber(b) - dayNumber(a);
}

export function decommissionOf(app: { decommission?: unknown }): DecommissionBlock | undefined {
  const d = app.decommission;
  return d && typeof d === "object" ? (d as DecommissionBlock) : undefined;
}

/** Immediate mode (ADR-0056 amendment 2026-11-12): the block asks to delete without a grace period. */
export function isImmediate(app: { decommission?: unknown }): boolean {
  return decommissionOf(app)?.immediate === true;
}

/**
 * The app's environments of kind prod (instance.yaml), from its app.yaml as it is: a production
 * environment requested but not merged yet counts as none. Immediate mode needs this to be empty.
 */
export function productionEnvironmentsOf(app: { environments?: unknown }, inst: { environments?: readonly { name: string; kind: string }[] }): string[] {
  const envs = app.environments && typeof app.environments === "object" ? Object.keys(app.environments) : [];
  return (inst.environments ?? []).filter((e) => e.kind === "prod" && envs.includes(e.name)).map((e) => e.name);
}

/**
 * Whether the app may be deleted immediately under this instance (ADR-0056 amendment 2026-11-12, and
 * 2026-11-21): always without production (`production` empty, from app.yaml as it is), and with
 * production only while instance.yaml decommission.allowImmediateWithProduction is true. Validation
 * (decommission-immediate), the provisioning plan and the portal's offer all ask this.
 */
export function immediateAllowed(
  app: { environments?: unknown },
  inst: DecommissionInstanceView & { environments?: readonly { name: string; kind: string }[] },
): { allowed: boolean; production: string[] } {
  const production = productionEnvironmentsOf(app, inst);
  return { allowed: production.length === 0 || decommissionSettings(inst).allowImmediateWithProduction, production };
}

/**
 * The phase as far as the files alone tell it (the plan also needs the stop dates, the window and
 * what is left in Azure): due from deleteAfter on (an immediate decommissioning: from requestedOn,
 * which deleteAfter equals). Deterministic for a given `today`.
 */
export type OfflinePhase = "active" | "retired" | "due";

export function offlinePhase(app: { decommission?: unknown }, today: string): OfflinePhase {
  const d = decommissionOf(app);
  if (!d) return "active";
  return isDate(d.deleteAfter) && isDate(today) && dayNumber(today) >= dayNumber(d.deleteAfter) ? "due" : "retired";
}

/**
 * The delete phase is due by the dates (ADR-0056 amendment 2026-11-12, deleted detected): the
 * decommissioning can no longer be cancelled, and the app's hosts, capacity and environments don't
 * count for other apps any more (what is still in Azure is being deleted; the guards of a new app's
 * provisioning refuse what still belongs to it).
 */
export function deletePhaseDue(app: { decommission?: unknown }, today: string): boolean {
  return offlinePhase(app, today) === "due";
}

/** Today's UTC date (YYYY-MM-DD): the default `today` of validation. */
export function utcDate(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** deleteAfter for a request made on `today` (UTC date) under these settings. */
export function deleteAfterFor(today: string, settings: Pick<DecommissionSettings, "graceDays">): string {
  return addDays(today, settings.graceDays);
}
