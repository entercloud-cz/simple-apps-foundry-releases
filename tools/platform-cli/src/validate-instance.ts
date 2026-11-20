import { basicModeOf } from "./basic-mode.js";
import { cellsOfMode, defaultReservation, formatCores, reservedCores } from "./capacity.js";
import type { CapacitySize } from "./capacity.js";
import { billingCurrencyOf, instanceCurrencyOf, isCalendarDate } from "./fx.js";
import type { FxView } from "./fx.js";
import type { ParsedYaml } from "./schema.js";
import { BUILT_IN_APP_THEMES } from "./themes.js";
import { lineAt, pathOf } from "./validate-app.js";
import type { Finding } from "./validate-app.js";
import { networkChecks } from "./validate-instance-network.js";
import type { NetworkModesView, PortalView } from "./validate-instance-network.js";

/**
 * Checks of instance.yaml that the schema cannot express (`platform validate instance`, run on a
 * schema-valid file; the portal's Settings area runs the same ones, ADR-0027).
 *
 * - Environments: names are unique; `promoteFrom` names an environment, not itself, and the
 *   chains never loop; `portal.hostEnvironment` names an environment. Every other reference to an
 *   environment name below is checked against the same list.
 * - `locale.defaultLanguage` is one of `locale.languages` (ADR-0018). Budget notifications, actual
 *   and forecast together, are at most 5 (Azure's limit per budget, ADR-0017).
 * - Network (validate-instance-network.ts): every range is a valid IPv4 range, none overlaps another
 *   range of the instance or a range Container Apps reserves, subnets lie inside the address space
 *   the platform creates, a prod CAE subnet is at least a /26 (network-modes.md#sizing), and
 *   `portal.network.routeTableId` needs a hub on the portal's host environment.
 * - `network.internalSystems`: IDs are unique, `allowedEnvironments` and firewall rules name
 *   environments of the instance. `dns.zones[].allowedEnvironments` too.
 * - `identities.provisioning`: keyed by environment names, each identity in the environment's own
 *   subscription (ADR-0031: one Azure provisioning identity per environment).
 * - `frontDoor.managed.profiles[].environment` names an environment of the instance, and each
 *   environment has at most one profile (the platform deploys exactly one profile afd-{prefix}-{env}
 *   per environment).
 * - `frontDoor.external.profiles[]`: names are unique, and every `allowedEnvironments` entry names an
 *   environment of the instance, at most once per profile.
 * - `newApps.basicMode` (ADR-0047), when enabled: every build environment offers its network mode
 *   (externalHybrid with an active egress baseline), its database engine is enabled and defines its
 *   size, and file storage is enabled when it asks for storage.
 * - Capacity cells (ADR-0053): the cells of a mode have unique ids and start with 01; a second cell
 *   is refused until the platform pipeline deploys more than one cell per mode; the default
 *   reservation (`newApps.capacity`) fits the budget of every cell.
 * - `costs.fx` (ADR-0017 amendment 2026-11-11, ADR-0018): the fixed rates don't list the instance
 *   currency (or list it as 1), `asOf` is a real date, and every environment billed in another
 *   currency (`billingCurrency`) has a fixed rate: with source none (or ecb, not built yet) such an
 *   environment is rejected.
 * - `costs.enabled` (ADR-0068): with false (subscriptions without Cost Management), `budgets.mode`
 *   is off, because budgets live in Cost Management.
 */
export interface InstanceSelfView extends FxView {
  environments: {
    name: string;
    kind?: string;
    promoteFrom?: string;
    subscriptionId?: string;
    hub?: unknown;
    networkModes?: NetworkModesView;
    billingCurrency?: string;
  }[];
  portal?: PortalView;
  locale?: { defaultLanguage?: string; languages?: string[]; currency?: string };
  costs?: FxView["costs"] & { enabled?: boolean };
  budgets?: { mode?: string; notifyAtPercent?: number[]; forecastNotifyAtPercent?: number[] };
  network?: { internalSystems?: { id: string; allowedEnvironments?: string[]; firewallRules?: { environment: string }[]; endpoints?: { cidr?: string }[] }[] };
  dns?: { zones?: { name: string; allowedEnvironments?: string[] }[] };
  identities?: { provisioning?: Record<string, { resourceId: string } | undefined> };
  branding?: { appThemes?: { id: string }[]; defaultAppTheme?: string };
  data?: {
    postgres?: { enabled?: boolean; sizes?: Record<string, unknown> };
    azureSql?: { enabled?: boolean; sizes?: Record<string, unknown> };
    storage?: { enabled?: boolean };
  };
  newApps?: { basicMode?: Record<string, unknown>; capacity?: { size?: CapacitySize; maxReplicas?: number } };
  frontDoor?: {
    managed?: { profiles?: { environment: string }[] };
    external?: { profiles?: { name: string; allowedEnvironments?: string[] }[] };
  };
}

export function instanceSelfChecks(inst: InstanceSelfView, parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const add = (segs: (string | number)[], message: string): void => {
    const line = lineAt(parsed, segs);
    out.push({ path: pathOf(segs), message, ...(line !== undefined ? { line } : {}) });
  };
  const environments = new Set(inst.environments.map((e) => e.name));
  const list = [...environments].join(", ");
  const unknown = (name: string): string => `"${name}" is not an environment of this instance (${list}).`;

  environmentChecks(inst, add, unknown);
  referenceChecks(inst, add, environments, unknown);
  localeAndBudgetChecks(inst, add);
  networkChecks(inst, add);
  provisioningIdentityChecks(inst, add, unknown);

  const managed = inst.frontDoor?.managed?.profiles ?? [];
  const firstManaged = new Map<string, number>();
  managed.forEach((p, i) => {
    const at = ["frontDoor", "managed", "profiles", i, "environment"];
    if (!environments.has(p.environment)) add(at, unknown(p.environment));
    const first = firstManaged.get(p.environment);
    if (first !== undefined) {
      add(at, `environment "${p.environment}" already has a Front Door profile (frontDoor.managed.profiles[${first}]); each environment has at most one.`);
    } else {
      firstManaged.set(p.environment, i);
    }
  });

  const external = inst.frontDoor?.external?.profiles ?? [];
  const firstExternal = new Map<string, number>();
  external.forEach((p, i) => {
    const key = p.name.toLowerCase();
    const first = firstExternal.get(key);
    if (first !== undefined) {
      add(["frontDoor", "external", "profiles", i, "name"], `profile name "${p.name}" is already used by frontDoor.external.profiles[${first}]; names are unique (compared without case).`);
    } else {
      firstExternal.set(key, i);
    }
    const seen = new Set<string>();
    (p.allowedEnvironments ?? []).forEach((env, j) => {
      const at = ["frontDoor", "external", "profiles", i, "allowedEnvironments", j];
      if (!environments.has(env)) add(at, unknown(env));
      if (seen.has(env)) add(at, `environment "${env}" is listed more than once in this profile.`);
      seen.add(env);
    });
  });
  // App themes (themes.ts): ids unique, the default one of the offered choices.
  const themes = inst.branding?.appThemes ?? [];
  const seenTheme = new Map<string, number>();
  themes.forEach((t, i) => {
    const first = seenTheme.get(t.id);
    if (first !== undefined) add(["branding", "appThemes", i, "id"], `theme id "${t.id}" is already used by branding.appThemes[${first}]; ids are unique.`);
    else seenTheme.set(t.id, i);
  });
  const wanted = inst.branding?.defaultAppTheme;
  if (wanted !== undefined) {
    const choices = [...(themes.length ? themes.map((t) => t.id) : BUILT_IN_APP_THEMES.map((t) => t.id)), "none", "custom"];
    if (!choices.includes(wanted)) add(["branding", "defaultAppTheme"], `"${wanted}" is not one of the offered themes (${choices.join(", ")}).`);
  }
  basicModeChecks(inst, add);
  capacityCellChecks(inst, add);
  fxChecks(inst, add);
  costsOffChecks(inst, add);
  return out;
}

type Add = (segs: (string | number)[], message: string) => void;

/** Environment names are unique; promotion chains (promoteFrom) name an environment and end at a build environment. */
function environmentChecks(inst: InstanceSelfView, add: Add, unknown: (name: string) => string): void {
  const first = new Map<string, number>();
  inst.environments.forEach((e, i) => {
    const seen = first.get(e.name);
    if (seen !== undefined) add(["environments", i, "name"], `environment name "${e.name}" is already used by environments[${seen}]; names are unique.`);
    else first.set(e.name, i);
  });
  const byName = new Map(inst.environments.filter((e, i) => first.get(e.name) === i).map((e) => [e.name, e]));
  inst.environments.forEach((e, i) => {
    if (e.promoteFrom === undefined) return;
    const at = ["environments", i, "promoteFrom"];
    if (e.promoteFrom === e.name) add(at, `environment "${e.name}" can't promote from itself.`);
    else if (!byName.has(e.promoteFrom)) add(at, unknown(e.promoteFrom));
  });
  // A promotion chain ends at a build environment (one without promoteFrom). Each loop is reported
  // once, at the environment listed first.
  const inLoop = new Set<string>();
  inst.environments.forEach((start, i) => {
    if (first.get(start.name) !== i || inLoop.has(start.name)) return;
    const path: string[] = [];
    for (let cur: InstanceSelfView["environments"][number] | undefined = start; cur; cur = cur.promoteFrom ? byName.get(cur.promoteFrom) : undefined) {
      const at = path.indexOf(cur.name);
      if (at >= 0) {
        const loop = path.slice(at);
        if (loop.length > 1 && !loop.some((n) => inLoop.has(n))) {
          loop.forEach((n) => inLoop.add(n));
          const head = loop.reduce((a, b) => ((first.get(b) ?? 0) < (first.get(a) ?? 0) ? b : a));
          const from = loop.indexOf(head);
          const ordered = [...loop.slice(from), ...loop.slice(0, from), head];
          add(["environments", first.get(head) ?? 0, "promoteFrom"], `promoteFrom forms a loop (${ordered.join(" -> ")}); a promotion chain ends at a build environment, one without promoteFrom.`);
        }
        break;
      }
      path.push(cur.name);
    }
  });
  const host = inst.portal?.hostEnvironment;
  if (host !== undefined && !byName.has(host)) add(["portal", "hostEnvironment"], unknown(host));
  const hostEnv = host === undefined ? undefined : byName.get(host);
  if (inst.portal?.network?.routeTableId !== undefined && hostEnv && hostEnv.hub === undefined) {
    add(
      ["portal", "network", "routeTableId"],
      `the portal's host environment "${hostEnv.name}" has no hub (environments[${first.get(hostEnv.name)}].hub), and a route table through the hub needs one: the portal VNet is then peered to it. Add the hub or remove routeTableId.`,
    );
  }
}

/** The other references to an environment name (internal systems, DNS zones) and the IDs of internal systems. */
function referenceChecks(inst: InstanceSelfView, add: Add, environments: Set<string>, unknown: (name: string) => string): void {
  const firstSystem = new Map<string, number>();
  (inst.network?.internalSystems ?? []).forEach((s, i) => {
    const seen = firstSystem.get(s.id);
    if (seen !== undefined) add(["network", "internalSystems", i, "id"], `system ID "${s.id}" is already used by network.internalSystems[${seen}]; IDs are unique.`);
    else firstSystem.set(s.id, i);
    (s.allowedEnvironments ?? []).forEach((env, j) => {
      if (!environments.has(env)) add(["network", "internalSystems", i, "allowedEnvironments", j], unknown(env));
    });
    (s.firewallRules ?? []).forEach((r, j) => {
      if (!environments.has(r.environment)) add(["network", "internalSystems", i, "firewallRules", j, "environment"], unknown(r.environment));
    });
  });
  (inst.dns?.zones ?? []).forEach((z, i) => {
    const seen = new Set<string>();
    (z.allowedEnvironments ?? []).forEach((env, j) => {
      const at = ["dns", "zones", i, "allowedEnvironments", j];
      if (!environments.has(env)) add(at, unknown(env));
      if (seen.has(env)) add(at, `environment "${env}" is listed more than once for this zone.`);
      seen.add(env);
    });
  });
}

/** `locale.defaultLanguage` is offered (ADR-0018); at most 5 budget notifications in all (ADR-0017). */
function localeAndBudgetChecks(inst: InstanceSelfView, add: Add): void {
  // What instance.yaml leaves out takes the schema's default.
  const languages = inst.locale?.languages ?? ["en", "cs"];
  const wanted = inst.locale?.defaultLanguage ?? "en";
  if (!languages.includes(wanted)) {
    const set = inst.locale !== undefined && Object.hasOwn(inst.locale, "defaultLanguage");
    add(
      set ? ["locale", "defaultLanguage"] : ["locale", "languages"],
      `the default language "${wanted}"${set ? "" : " (the default)"} is not one of locale.languages (${languages.join(", ")}); add it there${set ? " or choose another default language" : " or set locale.defaultLanguage"}.`,
    );
  }
  const actual = inst.budgets?.notifyAtPercent ?? [80, 100];
  const forecast = inst.budgets?.forecastNotifyAtPercent ?? [100];
  if (actual.length + forecast.length > 5) {
    const key = inst.budgets !== undefined && Object.hasOwn(inst.budgets, "forecastNotifyAtPercent") ? "forecastNotifyAtPercent" : "notifyAtPercent";
    add(
      inst.budgets ? ["budgets", key] : ["budgets"],
      `notifyAtPercent (${actual.length}) and forecastNotifyAtPercent (${forecast.length}) make ${actual.length + forecast.length} budget notifications; Azure allows at most 5 per budget (ADR-0017). Remove some.`,
    );
  }
}

/** identities.provisioning (ADR-0031): one identity per environment, each in its environment's subscription. */
function provisioningIdentityChecks(inst: InstanceSelfView, add: Add, unknown: (name: string) => string): void {
  const byName = new Map<string, InstanceSelfView["environments"][number]>();
  for (const e of inst.environments) if (!byName.has(e.name)) byName.set(e.name, e);
  for (const [name, ref] of Object.entries(inst.identities?.provisioning ?? {})) {
    const env = byName.get(name);
    if (!env) {
      add(["identities", "provisioning", name], `${unknown(name)} The key names the environment the identity provisions.`);
      continue;
    }
    const subscription = ref ? /^\/subscriptions\/([0-9a-fA-F-]{36})\//.exec(ref.resourceId)?.[1] : undefined;
    if (subscription && env.subscriptionId && subscription.toLowerCase() !== env.subscriptionId.toLowerCase()) {
      add(
        ["identities", "provisioning", name, "resourceId"],
        `the identity is in subscription ${subscription}, but environment "${name}" is in subscription ${env.subscriptionId}; the Azure provisioning identity of an environment lives in that environment's subscription (ADR-0031).`,
      );
    }
  }
}

/** costs.fx and environments[].billingCurrency (fx.ts). */
function fxChecks(inst: InstanceSelfView, add: (segs: (string | number)[], message: string) => void): void {
  const currency = instanceCurrencyOf(inst);
  const fx = inst.costs?.fx;
  const own = fx?.fixedRates?.[currency];
  if (own !== undefined && own !== 1) add(["costs", "fx", "fixedRates", currency], `${currency} is the instance currency (locale.currency): leave it out of the rates, or set it to 1.`);
  if (fx?.asOf !== undefined && !isCalendarDate(fx.asOf)) add(["costs", "fx", "asOf"], `"${fx.asOf}" is not a day of the calendar (YYYY-MM-DD).`);
  const source = fx?.source ?? "none";
  inst.environments.forEach((env, i) => {
    const billed = billingCurrencyOf(inst, env);
    if (billed === currency) return;
    const at = ["environments", i, "billingCurrency"];
    if (source !== "fixed") {
      const why = source === "ecb" ? "costs.fx.source ecb isn't built yet" : "costs.fx.source is none";
      add(at, `Azure bills environment ${env.name} in ${billed}, not in the instance currency ${currency}, and ${why}: set costs.fx.source to fixed with a rate for ${billed} (costs.fx.fixedRates, costs.fx.asOf).`);
    } else if (fx?.fixedRates?.[billed] === undefined) {
      add(at, `Azure bills environment ${env.name} in ${billed}, but costs.fx.fixedRates has no rate for ${billed} (units of ${currency} per 1 ${billed}).`);
    }
  });
}

/**
 * costs.enabled false (ADR-0068: subscriptions without Cost Management, such as an Azure Sponsorship):
 * budgets live in Cost Management, so budgets.mode must be off. Reported at budgets.mode when it is
 * set, else at costs.enabled (the default mode is optional).
 */
function costsOffChecks(inst: InstanceSelfView, add: Add): void {
  if (inst.costs?.enabled !== false) return;
  const set = inst.budgets !== undefined && Object.hasOwn(inst.budgets, "mode");
  const mode = inst.budgets?.mode ?? "optional";
  if (mode === "off") return;
  add(
    set ? ["budgets", "mode"] : ["costs", "enabled"],
    `costs.enabled is false (no Cost Management in this instance's subscriptions), but budgets.mode is ${mode}${set ? "" : " (the default)"}: budgets live in Cost Management, so set budgets.mode to off.`,
  );
}

/** The schema's default database sizes per engine (data.<engine>.sizes when instance.yaml has none). */
const DEFAULT_SIZES: Record<"postgres" | "azureSql", string[]> = { postgres: ["S", "M", "L"], azureSql: ["S"] };

/** newApps.basicMode (ADR-0047): what basic mode asks for must be offered by the instance. */
/**
 * Capacity cells (ADR-0053). The model, the checks, the placement and the portal handle any number of
 * cells, but the platform pipeline deploys one CAE per mode (cell 01) until its next increment, so a
 * second cell is refused here with that reason.
 */
function capacityCellChecks(inst: InstanceSelfView, add: (segs: (string | number)[], message: string) => void): void {
  const reservation = defaultReservation(inst);
  const need = reservedCores(reservation);
  inst.environments.forEach((env, i) => {
    for (const mode of ["externalOnly", "externalHybrid", "internalOnly"] as const) {
      const config = env.networkModes?.[mode];
      if (config === undefined) continue;
      const base = ["environments", i, "networkModes", mode, "cells"];
      const seen = new Map<string, number>();
      (config.cells ?? []).forEach((c, j) => {
        const first = seen.get(c.id);
        if (first !== undefined) add([...base, j, "id"], `cell ${c.id} is already listed as cells[${first}]; cell ids are unique within a network mode.`);
        else seen.set(c.id, j);
        if (j === 0 && c.id !== "01") add([...base, 0, "id"], `the first cell of ${mode} in ${env.name} must be 01: cell 01 is the mode's existing Container Apps environment (cae-{prefix}-{mode}-{env}).`);
        if (j > 0) {
          add(
            [...base, j],
            `not yet: cell ${c.id} would be a second cell of ${mode} in ${env.name}, but the platform pipeline deploys one cell per network mode for now (ADR-0053). Keep only cell 01; more cells come with the platform pipeline's next increment.`,
          );
        }
      });
      for (const c of cellsOfMode(config)) {
        if (need > c.cores) {
          const j = (config.cells ?? []).findIndex((x) => x.id === c.id);
          add(
            j >= 0 ? [...base, j, "capacity", "cores"] : ["newApps", "capacity"],
            `the default reservation (newApps.capacity: size ${reservation.size} x ${reservation.maxReplicas} replicas, ${formatCores(need)} cores) doesn't fit the budget of cell ${c.id} of ${mode} in ${env.name} (${c.cores} cores).`,
          );
        }
      }
    }
  });
}

function basicModeChecks(inst: InstanceSelfView, add: (segs: (string | number)[], message: string) => void): void {
  const basic = basicModeOf(inst as Parameters<typeof basicModeOf>[0]);
  if (!basic.enabled) return;
  const set = inst.newApps?.basicMode;
  const at = (key: string): (string | number)[] => (set && Object.hasOwn(set, key) ? ["newApps", "basicMode", key] : ["newApps", "basicMode"]);
  const why = "basic mode would request it for every new app (newApps.basicMode.enabled: false offers advanced mode only)";
  for (const env of inst.environments.filter((e) => !e.promoteFrom)) {
    const mode = env.networkModes?.[basic.networkMode];
    if (env.networkModes ? mode === undefined : basic.networkMode !== "externalOnly") {
      add(at("networkMode"), `the build environment ${env.name} doesn't offer network mode ${basic.networkMode}, but ${why}.`);
    } else if (basic.networkMode === "externalHybrid" && mode?.egressBaseline?.status !== "active") {
      add(at("networkMode"), `network mode externalHybrid needs an active egress baseline in the build environment ${env.name} (networkModes.externalHybrid.egressBaseline.status: active), because ${why}.`);
    }
  }
  if (basic.databaseEngine !== "none") {
    const engine = basic.databaseEngine;
    const offer = inst.data?.[engine];
    if (offer?.enabled === false) {
      add(at("databaseEngine"), `${engine} is switched off (data.${engine}.enabled: false), but ${why}.`);
    } else {
      const sizes = offer?.sizes ? Object.keys(offer.sizes) : DEFAULT_SIZES[engine];
      if (!sizes.includes(basic.databaseSize)) add(at("databaseSize"), `${engine} has no size ${basic.databaseSize} (data.${engine}.sizes: ${sizes.join(", ") || "none"}), but ${why}.`);
    }
  }
  if (basic.storage && inst.data?.storage?.enabled === false) add(at("storage"), `file storage is switched off (data.storage.enabled: false), but ${why}.`);
}
