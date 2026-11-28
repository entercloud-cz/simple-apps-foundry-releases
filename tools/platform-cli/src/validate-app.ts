import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { UsageError } from "./allowlist.js";
import { ARCHIVE_DIR, archivedGeneration, archivedIncarnation, archivedOfSlug, archivedRequestedOn, sameDefinitionText } from "./archive.js";
import { CAPACITY_SIZES, CELL_ID_RE, cellOf, cellsOfMode, cellUsage, DEFAULT_CELL_ID, formatCores, MAX_REPLICAS_LIMIT, reservationOf, reservedCores } from "./capacity.js";
import type { CapacityAppView, CapacityInstanceView, CapacityReservation, CapacitySize } from "./capacity.js";
import { reservedWordIn } from "./checks/manifest.js";
import { addDays, daysBetween, decommissionSettings, deletePhaseDue, immediateAllowed, isDate, utcDate } from "./decommission.js";
import type { DecommissionBlock } from "./decommission.js";
import { parseYaml, validateData } from "./schema.js";
import type { ParsedYaml, SchemaProblem } from "./schema.js";
import { appThemeChoices } from "./themes.js";
import type { AppTheme } from "./themes.js";

/**
 * `platform validate app <app.yaml> [--instance <instance.yaml>] [--base <git-ref>]`
 *
 * 1. Schema (config/schema/app.schema.json).
 * 2. Checks the schema cannot express. Without --instance only the app-internal ones (slug equals
 *    the directory, reserved words, owner != deputy, unique developers, assignments name defined
 *    roles, databaseSize needs a database); with --instance also everything that depends on the
 *    instance (environments, network modes, egress baseline, promotion source, sign-in policy,
 *    data services and sizes, budgets, repository project, custom domains through Front Door).
 * 3. With --base: immutability against the same file at that git ref (slug, generation never
 *    lower, database engine, a network mode change of an environment the base lists that the
 *    platform can't make: check network-mode-change, ADR-0060, and a capacity cell change of such an
 *    environment without a change of mode: check cell-change, ADR-0053) and a list of destructive
 *    changes (reported, not failed), the network mode changes provisioning makes among them (in any
 *    capacity cell; the cell may change with the mode).
 * 4. With the other app definitions (apps/<other>/app.yaml next to the file when --instance is the
 *    instance.yaml of the same platform-config): every app has its own repository, every custom
 *    host (environments.<env>.frontDoor.hostName) belongs to one app and environment, and no two apps
 *    of one environment have hosts that give the same Front Door custom-domain name (check
 *    front-door-domain-name, ADR-0052).
 * 5. Capacity (ADR-0053, capacity.ts), with --instance: the app's cell is a cell of its network mode
 *    (check cell-unknown), and the reserved cores of every cell the app runs in, the app and the other
 *    app definitions together, stay within the cell's budget (check cell-capacity) and, in a VNet-based
 *    mode, the sum of their maxReplicas within the cell's subnet (check cell-subnet-capacity).
 * 6. Decommissioning (ADR-0056, decommission.ts): the block's dates (deleteAfter at least
 *    instance.yaml decommission.graceDays after requestedOn with --instance: check
 *    decommission-grace); with --base, requestedOn never moves, and from the base's deleteAfter on
 *    (today, UTC: a date rule, no Azure state) the block is never removed or changed again (check
 *    decommission-tombstone: the delete phase has started, the app can't come back; ADR-0056
 *    amendment 2026-11-12, deleted detected); adding the block is destructive (listed with checkId
 *    decommission, so the portal, which refuses destructive changes, can tell its own request).
 *    Immediate mode (amendment 2026-11-12, check decommission-immediate): deleteAfter equals
 *    requestedOn; with --instance and --base, never added to an app with an environment of kind prod
 *    (nor a prod environment added to an app with a merged immediate block) unless instance.yaml
 *    decommission.allowImmediateWithProduction is true (amendment 2026-11-21, platform development
 *    only; such a request is then listed as destructive with PRODUCTION first and the setting named;
 *    immediateProductionChecks: a change rule, so a merged block stays valid when the setting is
 *    switched off, and the plan decides at run time); with --base, never added to or removed from a
 *    merged block. From its deleteAfter on, a decommissioned app's
 *    hosts and capacity don't count for the other apps (its Front Door domain and its Container Apps
 *    are being deleted, and it can't come back); its repository does (it may be kept).
 * 7. A slug used again (ADR-0061, archive.ts): when apps-deleted/<slug>/ beside the apps/ folder holds
 *    definitions of deleted apps with this slug, the app's generation must be above every archived
 *    one (check slug-reuse-generation), so everything that must be unique across Azure gets new names,
 *    and so must its incarnation (check slug-reuse-incarnation; an archived definition without it counts
 *    as 0), so its Entra registration gets its own uniqueName. With --base, an existing app's
 *    incarnation never changes (check incarnation-fixed): it keeps one registration for its whole life.
 *    With --base, a change that moves the base's apps/<slug>/app.yaml into apps-deleted/<slug>/ and
 *    writes a new apps/<slug>/app.yaml makes the new file a new app: nothing is compared with the
 *    archived definition (decommission-tombstone, network-mode-change, slug, generation, engine).
 *    The move back (a definition archived too early returns to apps/<slug>/ while the base has no
 *    apps/<slug>/app.yaml): the file is compared with the archived definition this change removes,
 *    so the same app stays the same app (decommission-tombstone applies; unchanged, nothing is found).
 *    Texts compare after CRLF -> LF (archive.ts sameDefinitionText). `platform validate archive`
 *    checks the archive itself (validate-archive.ts).
 */

/** Values of `repository.template` (app.schema.json, ADR-0039). */
export const REPOSITORY_TEMPLATES = ["node-ts", "python-fastapi", "dotnet", "byo"] as const;
export type RepositoryTemplate = (typeof REPOSITORY_TEMPLATES)[number];

/**
 * The app's repository.template. undefined = unmanaged (definitions from before ADR-0039): the
 * platform doesn't create, seed or onboard the repository. Only an explicit `byo` means onboarding.
 */
export function repositoryTemplate(app: Pick<AppData, "repository">): RepositoryTemplate | undefined {
  return app.repository.template;
}

export interface AppData {
  schemaVersion: string;
  slug: string;
  title: string;
  description?: string;
  generation?: number;
  /** The app's place among the apps that had its slug (ADR-0061, default 0): only the Entra uniqueName. Never changes. */
  incarnation?: number;
  costCenter?: string;
  owner: { objectId: string; principalType: string; email: string; displayName?: string };
  deputy: { objectId: string; principalType: string; email: string; displayName?: string };
  developers?: { objectId: string; principalType: string; displayName?: string }[];
  repository: { provider: string; project: string; name: string; defaultBranch?: string; template?: RepositoryTemplate };
  authentication: {
    mode: "required" | "anonymous";
    roles?: { value: string; displayName: string; description?: string }[];
    assignments?: { role: string; principalType: string; objectId: string; displayName?: string }[];
    /** ADR-0077: the roles with an app group per environment kind, whose members the owners manage in the portal. */
    appGroups?: string[];
  };
  data?: { database?: { engine: "postgres" | "azureSql"; size: "S" | "M" | "L" }; storage?: { vaultedBackup?: boolean } };
  /** The app's look: a theme the instance offers, none or custom (themes.ts). */
  ui?: { theme: string };
  /** Decommissioning (ADR-0056): retired, then deleted after the grace period; the definition stays. */
  decommission?: DecommissionBlock;
  environments: Record<
    string,
    {
      networkMode: "externalOnly" | "externalHybrid";
      databaseSize?: "S" | "M" | "L";
      /** Capacity cell (ADR-0053), default 01. */
      cell?: string;
      /** Capacity reservation (ADR-0053); absent = instance.yaml newApps.capacity. */
      capacity?: CapacityReservation;
      budget?: { monthlyAmount: number } | null;
      /** The app on its own custom domain through the environment's managed Front Door (ADR-0010, amended 2026-11-01). */
      frontDoor?: { hostName: string; profile?: string; frontDoorId?: string };
    }
  >;
}

/** A DNS zone of instance.yaml dns.zones, as far as custom hosts need it. */
export interface DnsZoneView {
  name: string;
  provider: "azureDns" | "manual";
  azureDnsZoneId?: string;
  allowedEnvironments: string[];
}

/** What the capacity checks read from a network mode of instance.yaml. */
type CapacityModeView = { network?: string; caeSubnetPrefix?: string; cells?: { id: string; capacity?: { cores?: number } }[] };

interface InstanceView {
  environments: {
    name: string;
    kind: string;
    promoteFrom?: string;
    networkModes: {
      externalOnly?: CapacityModeView;
      externalHybrid?: CapacityModeView & { egressBaseline?: { status?: string } };
      internalOnly?: CapacityModeView;
    };
  }[];
  newApps?: CapacityInstanceView["newApps"];
  scm: { provider: string; azureDevOps?: { appsProject: string; allowedProjects?: string[] } };
  authentication?: { enforcement?: "required" | "ownerChoice"; defaultAppRoles?: string[] };
  data?: {
    postgres?: { enabled?: boolean; sizes?: Record<string, unknown> };
    azureSql?: { enabled?: boolean; sizes?: Record<string, unknown> };
    storage?: { enabled?: boolean; vaultedBackup?: { offeredInProd?: boolean } };
  };
  budgets?: { mode?: "off" | "optional" | "required"; defaultMonthlyAmount?: number };
  dns?: { zones?: DnsZoneView[]; reservedSubdomains?: string[] };
  frontDoor?: {
    mode?: "managed" | "external";
    managed?: { profiles?: { environment: string }[] };
    external?: { profiles?: { name: string; frontDoorId?: string; allowedEnvironments?: string[] }[] };
  };
  branding?: { appThemes?: AppTheme[]; defaultAppTheme?: string };
  portal?: { apiBaseUrl?: string };
  decommission?: { graceDays?: number; repository?: "keep" | "delete"; allowImmediateWithProduction?: boolean };
}

export interface Finding {
  path: string;
  message: string;
  line?: number;
  /** The check of an app definition that found it, when it has an explanation (explanations.ts DEFINITION_CHECK_IDS). */
  checkId?: string;
  /** A destructive change that decommissioning itself makes (ADR-0056): the request, Cancel. */
  decommission?: true;
}

/**
 * Front Door custom-domain resource name of a host: cd-{host with dots replaced by hyphens}, a port of
 * naming.bicep frontDoorCustomDomain (test/naming-vectors.test.ts compares it with the vectors). Not
 * injective: x-y.zone and x.y.zone give the same name, so validation keeps such hosts of one
 * environment apart (ADR-0052). Never renamed: a rename re-creates the domain and its validation.
 */
export function frontDoorCustomDomainName(host: string): string {
  return `cd-${host.toLowerCase().replaceAll(".", "-")}`;
}

/** The host of instance.yaml portal.apiBaseUrl (lower-case, without port), or undefined. */
export function portalHost(inst: { portal?: { apiBaseUrl?: string } }): string | undefined {
  const url = inst.portal?.apiBaseUrl;
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

export interface AppValidateResult {
  kind: "app";
  file: string;
  ok: boolean;
  parseErrors: { message: string; line: number; column: number }[];
  problems: SchemaProblem[];
  /** Semantic and immutability problems (errors). */
  checks: Finding[];
  /** Destructive changes against --base (reported, not errors). */
  destructive: Finding[];
  instance?: string;
  /**
   * With --base: the ref, whether the file existed there and, when this change moved that file into
   * the archive of deleted apps (ADR-0061), the archived path (`archivedAs`: the file is then a new
   * app); when this change moved an archived definition back to this file, its path (`restoredFrom`:
   * the file was compared with it).
   */
  base?: { ref: string; found: boolean; archivedAs?: string; restoredFrom?: string };
}

/** Sizes the instance schema uses when data.<engine>.sizes is absent. */
const DEFAULT_SIZES: Record<"postgres" | "azureSql", string[]> = { postgres: ["S", "M", "L"], azureSql: ["S"] };
const DEFAULT_ROLES = ["Reader", "Editor", "Admin"];
/** instance.schema.json defaults of dns.reservedSubdomains and frontDoor.mode. */
const DEFAULT_RESERVED_SUBDOMAINS = ["www", "mail", "portal", "platform", "api", "admin", "autodiscover"];
const DEFAULT_FRONT_DOOR_MODE = "managed";

const lower = (s: string): string => s.toLowerCase();

/**
 * The DNS zone of instance.yaml dns.zones that holds `host` (the longest zone name the host ends
 * with, compared lower-case); undefined when none does. A host equal to a zone name is no match
 * (the CNAME can't sit at a zone apex). Shared by `platform validate app` and `provisioning inputs`.
 */
export function zoneOfHost(zones: readonly DnsZoneView[] | undefined, host: string): DnsZoneView | undefined {
  const h = lower(host);
  return (zones ?? []).filter((z) => h.endsWith(`.${lower(z.name)}`)).sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * Characters a value from the app definition must not carry into a rendered template, a pull
 * request or the portal: line breaks, `{{`, Markdown/HTML/table syntax, and Unicode format
 * characters (\p{Cf}: bidi controls, zero-width spaces), which make text read differently than it is.
 */
export const UNSAFE_TEXT = /[\r\n`|<>\p{Cf}]|\{\{/u;

/** Same path style as the schema problems: runtime.env[0].name. */
export function pathOf(segs: (string | number)[]): string {
  if (!segs.length) return "(root)";
  return segs.reduce<string>((acc, s) => (typeof s === "number" ? `${acc}[${s}]` : acc ? `${acc}.${s}` : s), "");
}

export function lineAt(parsed: ParsedYaml | undefined, segs: (string | number)[]): number | undefined {
  if (!parsed) return undefined;
  for (let n = segs.length; n >= 0; n--) {
    const node = (n === 0 ? parsed.doc.contents : parsed.doc.getIn(segs.slice(0, n), true)) as { range?: [number, number, number] } | null | undefined;
    if (node && typeof node === "object" && node.range) return parsed.lc.linePos(node.range[0]).line;
  }
  return undefined;
}

/** Checks that need only the app definition itself. */
export function appChecks(app: AppData, file: string, parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const add = (segs: (string | number)[], message: string): void => {
    const line = lineAt(parsed, segs);
    out.push({ path: pathOf(segs), message, ...(line !== undefined ? { line } : {}) });
  };

  // Title and description are written into the app repo (AGENTS.md table, README, YAML comments)
  // by `platform repo render`, verbatim (templates/README.md, rendering rules).
  for (const key of ["title", "description"] as const) {
    const v = app[key];
    if (typeof v === "string" && UNSAFE_TEXT.test(v)) {
      add([key], `${key} must not contain line breaks, "{{", backticks, |, < or >, nor invisible formatting characters such as bidi controls or zero-width spaces (it is written into the app repo's AGENTS.md and README).`);
    }
  }

  const dir = basename(dirname(resolve(file)));
  if (dir !== app.slug) add(["slug"], `slug "${app.slug}" must equal the directory name apps/${dir}/.`);
  const hit = reservedWordIn(app.slug);
  if (hit) add(["slug"], `slug "${app.slug}" uses a reserved word ("${hit}").`);

  if (lower(app.owner.objectId) === lower(app.deputy.objectId)) add(["deputy", "objectId"], "owner and deputy must be different people.");
  if (lower(app.owner.email) === lower(app.deputy.email)) add(["deputy", "email"], "owner and deputy must have different email addresses.");
  const devIds = new Set<string>();
  (app.developers ?? []).forEach((d, i) => {
    if (devIds.has(lower(d.objectId))) add(["developers", i], `developer ${d.objectId} is listed more than once.`);
    devIds.add(lower(d.objectId));
  });

  const roles = app.authentication.roles;
  if (roles) {
    const seen = new Set<string>();
    roles.forEach((r, i) => {
      if (seen.has(r.value)) add(["authentication", "roles", i], `role "${r.value}" is defined more than once.`);
      seen.add(r.value);
    });
    (app.authentication.assignments ?? []).forEach((a, i) => {
      if (!seen.has(a.role)) add(["authentication", "assignments", i, "role"], `assignment uses role "${a.role}", which is not in authentication.roles.`);
    });
    (app.authentication.appGroups ?? []).forEach((r, i) => {
      if (!seen.has(r)) add(["authentication", "appGroups", i], `app group for role "${r}", which is not in authentication.roles.`);
    });
    // App group names hold the role value in lower case (ADR-0077): two roles that differ only in case would share them.
    const lowerRoles = new Set<string>();
    roles.forEach((r, i) => {
      if (lowerRoles.has(lower(r.value))) add(["authentication", "roles", i], `role "${r.value}" differs from another role only in upper and lower case.`);
      lowerRoles.add(lower(r.value));
    });
  }
  if ((app.authentication.appGroups ?? []).length > 0 && app.authentication.mode !== "required") {
    add(["authentication", "appGroups"], "app groups need sign-in (authentication.mode required).");
  }
  const pairs = new Set<string>();
  (app.authentication.assignments ?? []).forEach((a, i) => {
    const key = `${a.role}|${lower(a.objectId)}`;
    if (pairs.has(key)) add(["authentication", "assignments", i], `${a.objectId} is assigned role "${a.role}" twice.`);
    pairs.add(key);
  });

  const d = app.decommission;
  if (d) {
    if (UNSAFE_TEXT.test(d.reason)) add(["decommission", "reason"], 'decommission.reason must be one line without "{{", backticks, |, < or >, nor invisible formatting characters (it is shown in the pull request, the portal and mails).');
    if (d.reason.trim().length < 3) add(["decommission", "reason"], "decommission.reason must say why the app is no longer needed.");
    for (const k of ["requestedOn", "deleteAfter"] as const) {
      const v = d[k];
      if (v !== undefined && !isDate(v)) add(["decommission", k], `decommission.${k} "${v}" is not a calendar date (YYYY-MM-DD).`);
    }
    if (d.immediate === true) {
      // ADR-0056 amendment 2026-11-12: no grace period, so the dates are one day.
      if (isDate(d.requestedOn) && isDate(d.deleteAfter) && d.deleteAfter !== d.requestedOn) {
        const segs = ["decommission", "deleteAfter"];
        const line = lineAt(parsed, segs);
        out.push({ path: pathOf(segs), message: `decommission.deleteAfter ${d.deleteAfter} must equal requestedOn ${d.requestedOn} with immediate: true (no grace period; check decommission-immediate).`, checkId: "decommission-immediate", ...(line !== undefined ? { line } : {}) });
      }
    } else if (isDate(d.requestedOn) && isDate(d.deleteAfter) && daysBetween(d.requestedOn, d.deleteAfter) < 1) {
      add(["decommission", "deleteAfter"], `decommission.deleteAfter ${d.deleteAfter} must be after requestedOn ${d.requestedOn} (check decommission-grace).`);
    }
  }

  const hosts = new Map<string, string>();
  for (const [name, e] of Object.entries(app.environments)) {
    if (e.databaseSize !== undefined && !app.data?.database) add(["environments", name, "databaseSize"], "databaseSize needs data.database.");
    if (e.frontDoor) {
      const h = lower(e.frontDoor.hostName);
      const first = hosts.get(h);
      if (first !== undefined) add(["environments", name, "frontDoor", "hostName"], `host "${e.frontDoor.hostName}" is already the custom domain of environment ${first}; each environment needs its own host.`);
      else hosts.set(h, name);
    }
  }
  return out;
}

/**
 * Immediate deletion of an app with production (check decommission-immediate; ADR-0056 amendments
 * 2026-11-12 and 2026-11-21), with --instance and --base: unless instance.yaml
 * decommission.allowImmediateWithProduction is true (platform development only), a change never adds an
 * immediate block to an app whose app.yaml has an environment of kind prod (a new app's file included:
 * `base` undefined), and never adds a prod environment to an app with a merged immediate block. A merged
 * block is never refused afterwards: switching the setting off must leave every definition on main valid
 * (the build validation checks them all, and a definition stays after its app is deleted). The
 * provisioning plan checks the setting again in every run and, while it is off, plans such a block as
 * an ordinary decommissioning (fail closed). A base with an ordinary block: the rule that immediate is
 * never added to a merged block applies instead (decommissionChanges).
 */
export function immediateProductionChecks(base: AppData | undefined, app: AppData, inst: InstanceView, parsed?: ParsedYaml): Finding[] {
  const d = app.decommission;
  if (d?.immediate !== true || (base?.decommission && base.decommission.immediate !== true)) return [];
  const { allowed, production } = immediateAllowed(app, inst);
  if (allowed) return [];
  const off = "instance.yaml decommission.allowImmediateWithProduction is off, as a production deployment keeps it";
  if (base?.decommission?.immediate === true) {
    const before = new Set(immediateAllowed(base, inst).production);
    const added = production.filter((e) => !before.has(e));
    if (!added.length) return [];
    const segs = ["environments", added[0]!];
    const line = lineAt(parsed, segs);
    return [
      {
        path: pathOf(segs),
        message: `decommission.immediate: the app is being deleted immediately, so a production environment (${added.join(", ")}) can't be added to it (${off}; check decommission-immediate).`,
        checkId: "decommission-immediate",
        ...(line !== undefined ? { line } : {}),
      },
    ];
  }
  const segs = ["decommission", "immediate"];
  const line = lineAt(parsed, segs);
  return [
    {
      path: pathOf(segs),
      message: `decommission.immediate: the app has production (${production.join(", ")}); only an app without an environment of kind prod can be deleted immediately (${off}). Remove immediate and set deleteAfter to ${isDate(d.requestedOn) ? addDays(d.requestedOn, decommissionSettings(inst).graceDays) : "requestedOn + the grace period"} or later (check decommission-immediate).`,
      checkId: "decommission-immediate",
      ...(line !== undefined ? { line } : {}),
    },
  ];
}

/** Checks against instance.yaml. */
export function instanceChecks(app: AppData, inst: InstanceView, parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const add = (segs: (string | number)[], message: string): void => {
    const line = lineAt(parsed, segs);
    out.push({ path: pathOf(segs), message, ...(line !== undefined ? { line } : {}) });
  };
  const byName = new Map(inst.environments.map((e) => [e.name, e]));
  const names = inst.environments.map((e) => e.name).join(", ");

  // Immediate deletion and production: a rule of the change against the base (immediateProductionChecks,
  // ADR-0056 amendment 2026-11-21), never of the file alone, so a merged block stays valid.
  const d = app.decommission;
  if (d && d.immediate !== true && isDate(d.requestedOn) && isDate(d.deleteAfter)) {
    const { graceDays } = decommissionSettings(inst);
    if (daysBetween(d.requestedOn, d.deleteAfter) < graceDays) {
      const segs = ["decommission", "deleteAfter"];
      const line = lineAt(parsed, segs);
      out.push({
        path: pathOf(segs),
        message: `decommission.deleteAfter ${d.deleteAfter} is less than the instance's grace period of ${graceDays} days after requestedOn ${d.requestedOn}; set it to ${addDays(d.requestedOn, graceDays)} or later (check decommission-grace).`,
        checkId: "decommission-grace",
        ...(line !== undefined ? { line } : {}),
      });
    }
  }

  for (const [name, e] of Object.entries(app.environments)) {
    const ie = byName.get(name);
    if (!ie) {
      add(["environments", name], `"${name}" is not an environment of this instance (${names}).`);
      continue;
    }
    const mode = ie.networkModes[e.networkMode];
    if (mode === undefined) add(["environments", name, "networkMode"], `network mode ${e.networkMode} is not enabled in environment ${name}.`);
    if (e.networkMode === "externalHybrid" && mode !== undefined) {
      const status = ie.networkModes.externalHybrid?.egressBaseline?.status;
      if (status !== "active") add(["environments", name, "networkMode"], `externalHybrid in ${name} needs the egress baseline firewall rules to be active (status: ${status ?? "not set"}).`);
    }
    if (ie.promoteFrom && !Object.hasOwn(app.environments, ie.promoteFrom)) {
      add(["environments", name], `${name} receives builds from ${ie.promoteFrom}, so the app must also run in ${ie.promoteFrom}.`);
    }
    const budgetsMode = inst.budgets?.mode ?? "optional";
    if (budgetsMode === "off" && e.budget) add(["environments", name, "budget"], "budgets are switched off in this instance (budgets.mode off); remove the budget.");
    if (budgetsMode === "required" && e.budget === null) add(["environments", name, "budget"], "this instance requires a budget (budgets.mode required); set monthlyAmount or leave budget out to use the default.");
    if (e.databaseSize && app.data?.database) {
      const sizes = Object.keys(inst.data?.[app.data.database.engine]?.sizes ?? {}) ;
      const allowed = sizes.length ? sizes : DEFAULT_SIZES[app.data.database.engine];
      if (!allowed.includes(e.databaseSize)) add(["environments", name, "databaseSize"], `database size ${e.databaseSize} is not offered for ${app.data.database.engine} (${allowed.join(", ")}).`);
    }
    if (e.frontDoor) frontDoorRules(inst, name, e.frontDoor, add);
  }

  if (app.ui) {
    const choices = appThemeChoices(inst);
    if (!choices.includes(app.ui.theme)) add(["ui", "theme"], `theme "${app.ui.theme}" is not offered in this instance (${choices.join(", ")}).`);
  }

  const enforcement = inst.authentication?.enforcement ?? "required";
  if (app.authentication.mode === "anonymous" && enforcement !== "ownerChoice") {
    add(["authentication", "mode"], "anonymous apps are not allowed in this instance (authentication.enforcement is required).");
  }
  if (!app.authentication.roles) {
    const roles = inst.authentication?.defaultAppRoles ?? DEFAULT_ROLES;
    (app.authentication.assignments ?? []).forEach((a, i) => {
      if (!roles.includes(a.role)) add(["authentication", "assignments", i, "role"], `assignment uses role "${a.role}", which is not a default app role of this instance (${roles.join(", ")}).`);
    });
    (app.authentication.appGroups ?? []).forEach((r, i) => {
      if (!roles.includes(r)) add(["authentication", "appGroups", i], `app group for role "${r}", which is not a default app role of this instance (${roles.join(", ")}).`);
    });
  }

  const db = app.data?.database;
  if (db) {
    const svc = inst.data?.[db.engine];
    if (svc?.enabled === false) add(["data", "database", "engine"], `${db.engine} is not offered in this instance.`);
    const sizes = Object.keys(svc?.sizes ?? {});
    const allowed = sizes.length ? sizes : DEFAULT_SIZES[db.engine];
    if (!allowed.includes(db.size)) add(["data", "database", "size"], `database size ${db.size} is not offered for ${db.engine} (${allowed.join(", ")}).`);
  }
  const storage = app.data?.storage;
  if (storage) {
    if (inst.data?.storage?.enabled === false) add(["data", "storage"], "storage accounts are not offered in this instance.");
    if (storage.vaultedBackup && inst.data?.storage?.vaultedBackup?.offeredInProd === false) {
      add(["data", "storage", "vaultedBackup"], "vaulted backup is not offered in this instance.");
    }
  }

  if (app.repository.provider !== inst.scm.provider) add(["repository", "provider"], `this instance uses ${inst.scm.provider} repositories.`);
  else if (inst.scm.azureDevOps) {
    const projects = [inst.scm.azureDevOps.appsProject, ...(inst.scm.azureDevOps.allowedProjects ?? [])];
    if (!projects.includes(app.repository.project)) add(["repository", "project"], `project "${app.repository.project}" is not allowed for app repos (${projects.join(", ")}).`);
  }
  return out;
}

/**
 * environments.<env>.frontDoor (ADR-0010, amended 2026-11-01 and 2026-11-11). Managed mode: the
 * instance runs a managed Front Door profile in that environment; no profile or frontDoorId (the
 * profile's ID comes from its deployment). External mode (another team runs Front Door): profile
 * names an entry of frontDoor.external.profiles allowed in that environment, and the expected
 * X-Azure-FDID comes from exactly one place: the profile's frontDoorId, else the app's. In both modes
 * the host lies below a DNS zone of dns.zones allowed there (never its apex) and its first label is no
 * reserved subdomain. Apps with sign-in may have one too (amended 2026-11-02): the Entra registration
 * lists the host's callback and Easy Auth trusts Front Door's forwarded host.
 */
function frontDoorRules(inst: InstanceView, env: string, fd: { hostName: string; profile?: string; frontDoorId?: string }, add: (segs: (string | number)[], message: string) => void): void {
  const host = fd.hostName;
  const at = ["environments", env, "frontDoor", "hostName"];
  const mode = inst.frontDoor?.mode ?? DEFAULT_FRONT_DOOR_MODE;
  if (mode === "managed") {
    if (!(inst.frontDoor?.managed?.profiles ?? []).some((p) => p.environment === env)) {
      add(["environments", env, "frontDoor"], `environment ${env} has no managed Front Door profile (instance.yaml frontDoor.managed.profiles).`);
    }
    if (fd.profile !== undefined) add(["environments", env, "frontDoor", "profile"], "profile is for external Front Door mode only; this instance runs its own Front Door (frontDoor.mode managed).");
    if (fd.frontDoorId !== undefined) add(["environments", env, "frontDoor", "frontDoorId"], "frontDoorId is for external Front Door mode only; in managed mode the platform reads it from the environment's profile.");
  } else {
    const profiles = inst.frontDoor?.external?.profiles ?? [];
    const names = profiles.map((p) => p.name).join(", ");
    const profile = fd.profile === undefined ? undefined : profiles.find((p) => p.name === fd.profile);
    if (fd.profile === undefined) {
      add(["environments", env, "frontDoor"], `name the external Front Door profile that serves the app (profile: ${names ? `one of ${names}` : "none defined: instance.yaml frontDoor.external.profiles is empty"}).`);
    } else if (!profile) {
      add(["environments", env, "frontDoor", "profile"], `"${fd.profile}" is not an external Front Door profile of this instance (frontDoor.external.profiles: ${names || "none"}).`);
    } else {
      if (profile.allowedEnvironments && !profile.allowedEnvironments.includes(env)) {
        add(["environments", env, "frontDoor", "profile"], `the external Front Door profile ${profile.name} is not allowed in environment ${env} (allowedEnvironments: ${profile.allowedEnvironments.join(", ")}).`);
      }
      if (profile.frontDoorId && fd.frontDoorId !== undefined) {
        add(["environments", env, "frontDoor", "frontDoorId"], `the external Front Door profile ${profile.name} defines its Front Door ID in instance.yaml; leave frontDoorId out here.`);
      } else if (!profile.frontDoorId && fd.frontDoorId === undefined) {
        add(["environments", env, "frontDoor", "frontDoorId"], `instance.yaml defines no Front Door ID for the external profile ${profile.name}: give the expected X-Azure-FDID here (frontDoorId, from the team that runs it).`);
      }
    }
  }
  const zones = inst.dns?.zones ?? [];
  const h = lower(host);
  if (zones.some((z) => lower(z.name) === h)) add(at, `"${host}" is a DNS zone itself; use a host below it (records at the zone apex are not supported).`);
  else {
    const zone = zoneOfHost(zones, host);
    if (!zone) add(at, `"${host}" is not inside a DNS zone of this instance (dns.zones: ${zones.map((z) => z.name).join(", ") || "none"}).`);
    else if (!zone.allowedEnvironments.includes(env)) add(at, `the DNS zone ${zone.name} is not allowed in environment ${env} (allowedEnvironments: ${zone.allowedEnvironments.join(", ")}).`);
  }
  const first = h.split(".")[0] ?? "";
  if ((inst.dns?.reservedSubdomains ?? DEFAULT_RESERVED_SUBDOMAINS).map(lower).includes(first)) add(at, `"${first}" is a reserved subdomain of this instance (dns.reservedSubdomains); choose another host.`);
  // The portal's own address (ADR-0052): an app's DNS records would overwrite the portal's.
  if (portalHost(inst) === h) add(at, `"${host}" is the portal's own address (instance.yaml portal.apiBaseUrl); no app may use it.`);
}

/** Another app definition of the same platform-config, as far as the cross-app rules need it. */
export interface OtherApp {
  slug: string;
  repository?: { provider?: unknown; project?: unknown; name?: unknown };
  /** environments.<env>.frontDoor.hostName of that app, lower-case. */
  hosts?: string[];
  /** The same hosts with their environment (the Front Door profile is per environment). */
  frontDoorHosts?: { environment: string; host: string }[];
  /** Per environment: network mode, cell and capacity reservation, for the cell budgets (ADR-0053). */
  environments?: CapacityAppView["environments"];
}

const SIZES: readonly string[] = CAPACITY_SIZES;

/**
 * The network mode, cell and capacity of each environment of a parsed definition, as far as they are
 * well formed (a malformed cell or capacity fails that app's own validation; here a malformed capacity
 * counts as the instance default and a malformed cell or mode leaves the environment out).
 */
function capacityEnvironmentsOf(d: { environments?: unknown }): CapacityAppView["environments"] | undefined {
  const envs = d.environments;
  if (!envs || typeof envs !== "object") return undefined;
  const out: CapacityAppView["environments"] = {};
  for (const [name, e] of Object.entries(envs as Record<string, unknown>)) {
    if (!e || typeof e !== "object") continue;
    const { networkMode, cell, capacity } = e as { networkMode?: unknown; cell?: unknown; capacity?: unknown };
    if (typeof networkMode !== "string") continue;
    if (cell !== undefined && (typeof cell !== "string" || !CELL_ID_RE.test(cell))) continue;
    const c = capacity as { size?: unknown; maxReplicas?: unknown } | undefined;
    const valid =
      c && typeof c === "object" && typeof c.size === "string" && SIZES.includes(c.size) && Number.isInteger(c.maxReplicas) && (c.maxReplicas as number) >= 1 && (c.maxReplicas as number) <= MAX_REPLICAS_LIMIT;
    out[name] = { networkMode, ...(typeof cell === "string" ? { cell } : {}), ...(valid ? { capacity: { size: c.size as CapacitySize, maxReplicas: c.maxReplicas as number } } : {}) };
  }
  return out;
}

/** The custom hosts (environments.<env>.frontDoor.hostName) of a parsed definition with their environment, lower-case. */
function hostsOf(d: { environments?: unknown }): { environment: string; host: string }[] {
  const envs = d.environments;
  if (!envs || typeof envs !== "object") return [];
  const out: { environment: string; host: string }[] = [];
  for (const [environment, e] of Object.entries(envs as Record<string, unknown>)) {
    const fd = e && typeof e === "object" ? (e as { frontDoor?: unknown }).frontDoor : undefined;
    const host = fd && typeof fd === "object" ? (fd as { hostName?: unknown }).hostName : undefined;
    if (typeof host === "string") out.push({ environment, host: lower(host) });
  }
  return out;
}

/**
 * The other definitions given as text (unparseable ones are skipped: they fail on their own). `today`
 * (UTC, default now) decides which decommissioned apps no longer count (deletePhaseDue).
 */
export function otherAppsFromTexts(texts: { slug?: string; text: string }[], today: string = utcDate()): OtherApp[] {
  const out: OtherApp[] = [];
  for (const t of texts) {
    const p = parseYaml(t.text);
    const d = p.data as { slug?: unknown; repository?: unknown; environments?: unknown; decommission?: unknown } | undefined;
    if (p.parseErrors.length || !d || typeof d !== "object") continue;
    const slug = t.slug ?? (typeof d.slug === "string" ? d.slug : undefined);
    if (!slug) continue;
    // ADR-0056: from deleteAfter on, a decommissioned app's domains and Container Apps are being
    // deleted and it can't come back (check decommission-tombstone); its repository may be kept.
    const gone = deletePhaseDue(d, today);
    const fdHosts = gone ? [] : hostsOf(d);
    const environments = gone ? undefined : capacityEnvironmentsOf(d);
    out.push({
      slug,
      ...(d.repository && typeof d.repository === "object" ? { repository: d.repository as OtherApp["repository"] } : {}),
      ...(fdHosts.length ? { hosts: fdHosts.map((x) => x.host), frontDoorHosts: fdHosts } : {}),
      ...(environments ? { environments } : {}),
    });
  }
  return out;
}

/**
 * Every app of an apps directory, parsed once per process while the files stay the same (their names,
 * sizes and modification times): validating N apps of one platform-config reads each app.yaml once
 * instead of N times (ADR-0050: hundreds of apps made `provisioning apps` quadratic).
 */
const siblingCache = new Map<string, { signature: string; apps: OtherApp[] }>();

/**
 * The app.yaml files next to `file` (apps/<other>/app.yaml), when `file` is apps/<dir>/app.yaml of the
 * platform-config whose instance.yaml is `instance`. Symbolic links and files over 1 MiB are skipped.
 */
export function siblingApps(file: string, instance: string, today: string = utcDate()): OtherApp[] | undefined {
  const appDir = dirname(resolve(file));
  const appsDir = dirname(appDir);
  if (basename(appsDir) !== "apps") return undefined;
  try {
    if (realpathSync(dirname(appsDir)) !== realpathSync(dirname(resolve(instance)))) return undefined;
  } catch {
    return undefined;
  }
  const files: { slug: string; file: string }[] = [];
  const signature: string[] = [];
  for (const e of readdirSync(appsDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const f = join(appsDir, e.name, "app.yaml");
    try {
      const st = lstatSync(f);
      if (st.isFile() && st.size <= 1024 * 1024) {
        files.push({ slug: e.name, file: f });
        signature.push(`${e.name}:${st.size}:${st.mtimeMs}:${st.ino}`);
      }
    } catch {
      // no app.yaml in that folder
    }
  }
  // The day is part of the signature: a decommissioned app stops counting from its deleteAfter on.
  const sig = `${today}|${signature.sort().join("|")}`;
  let cached = siblingCache.get(appsDir);
  if (!cached || cached.signature !== sig) {
    cached = { signature: sig, apps: otherAppsFromTexts(files.map((f) => ({ slug: f.slug, text: readFileSync(f.file, "utf8") })), today) };
    siblingCache.set(appsDir, cached);
  }
  const me = basename(appDir);
  return cached.apps.filter((a) => a.slug !== me);
}

/** instance.yaml validated once per process while the file stays the same (see siblingCache). */
const instanceCache = new Map<string, { signature: string; result: ReturnType<typeof instanceProblems> }>();

function instanceOnce(path: string): ReturnType<typeof instanceProblems> {
  const st = lstatSync(path);
  const sig = `${st.size}:${st.mtimeMs}:${st.ino}`;
  const key = resolve(path);
  const cached = instanceCache.get(key);
  if (cached && cached.signature === sig) return cached.result;
  const result = instanceProblems(readFileSync(path, "utf8"));
  instanceCache.set(key, { signature: sig, result });
  return result;
}

/** Every app has its own repository (Azure DevOps names compare case-insensitively). */
export function repositoryChecks(app: AppData, others: OtherApp[], parsed?: ParsedYaml): Finding[] {
  const key = (r: { provider?: unknown; project?: unknown; name?: unknown }): string => `${String(r.provider)}|${lower(String(r.project))}|${lower(String(r.name))}`;
  const mine = key(app.repository);
  const clashes = others
    .filter((o) => o.slug !== app.slug && typeof o.repository?.project === "string" && typeof o.repository.name === "string" && key(o.repository) === mine)
    .map((o) => o.slug)
    .sort();
  if (!clashes.length) return [];
  const line = lineAt(parsed, ["repository", "name"]);
  const apps = [app.slug, ...clashes].map((s) => `"${s}"`).join(" and ");
  return [
    {
      path: "repository.name",
      message: `apps ${apps} both use the repository ${app.repository.project}/${app.repository.name}; each app needs its own repository.`,
      ...(line !== undefined ? { line } : {}),
    },
  ];
}

/**
 * Every custom host belongs to one app (hosts compare lower-case), and no two apps of one environment
 * have hosts that give the same custom-domain name in its Front Door profile (ADR-0052): cd-{host with
 * dots replaced by hyphens} is not injective, so the second app's deployment would overwrite the
 * first app's domain.
 */
export function frontDoorHostChecks(app: AppData, others: OtherApp[], parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  for (const [name, e] of Object.entries(app.environments)) {
    if (!e.frontDoor) continue;
    const h = lower(e.frontDoor.hostName);
    const segs = ["environments", name, "frontDoor", "hostName"];
    const line = lineAt(parsed, segs);
    const clashes = others.filter((o) => o.slug !== app.slug && (o.hosts ?? []).includes(h)).map((o) => o.slug).sort();
    if (clashes.length) {
      out.push({
        path: pathOf(segs),
        message: `host "${e.frontDoor.hostName}" is already the custom domain of app ${clashes.map((s) => `"${s}"`).join(" and ")}; each custom domain belongs to one app and environment.`,
        ...(line !== undefined ? { line } : {}),
      });
      continue;
    }
    const cd = frontDoorCustomDomainName(h);
    const confusable = others
      .filter((o) => o.slug !== app.slug)
      .flatMap((o) => (o.frontDoorHosts ?? []).filter((x) => x.environment === name && x.host !== h && frontDoorCustomDomainName(x.host) === cd).map((x) => ({ slug: o.slug, host: x.host })))
      .sort((a, b) => a.slug.localeCompare(b.slug));
    if (!confusable.length) continue;
    out.push({
      path: pathOf(segs),
      message: `host "${e.frontDoor.hostName}" gets the Front Door custom-domain name ${cd}, which app ${confusable.map((c) => `"${c.slug}" already uses for "${c.host}"`).join(" and ")} in environment ${name}; choose a host that differs in more than dots and hyphens (check front-door-domain-name).`,
      checkId: "front-door-domain-name",
      ...(line !== undefined ? { line } : {}),
    });
  }
  return out;
}

const describeReservation = (r: CapacityReservation): string => `size ${r.size} x ${r.maxReplicas} replica${r.maxReplicas === 1 ? "" : "s"}`;

/**
 * Capacity (ADR-0053): the app's cell exists in its network mode (check cell-unknown); with the other
 * app definitions, every cell the app runs in keeps its reserved cores within its budget (check
 * cell-capacity) and, where the cell has a subnet, the sum of maxReplicas within the subnet's capacity
 * (check cell-subnet-capacity). Every app of an overcommitted cell reports it, so a pull request that
 * overcommits a cell fails whichever app it changes.
 */
export function capacityChecks(app: AppData, inst: InstanceView, others: OtherApp[], parsed?: ParsedYaml): Finding[] {
  const out: Finding[] = [];
  const at = (segs: (string | number)[], message: string, checkId: string): void => {
    const line = lineAt(parsed, segs);
    out.push({ path: pathOf(segs), message, checkId, ...(line !== undefined ? { line } : {}) });
  };
  const view: CapacityInstanceView = { environments: inst.environments, ...(inst.newApps ? { newApps: inst.newApps } : {}) };
  const placed: CapacityAppView["environments"] = {};
  for (const [name, e] of Object.entries(app.environments)) {
    const ie = inst.environments.find((x) => x.name === name);
    const mode = ie?.networkModes[e.networkMode];
    if (!ie || mode === undefined) continue; // instanceChecks reports these
    const cells = cellsOfMode(mode).map((c) => c.id);
    const cell = cellOf(e);
    if (!cells.includes(cell)) {
      at(["environments", name, "cell"], `cell ${cell} is not a cell of ${e.networkMode} in environment ${name} (cells: ${cells.join(", ")}); name one of them, or leave cell out for 01 (check cell-unknown).`, "cell-unknown");
      continue;
    }
    placed[name] = e;
  }
  const mine: CapacityAppView = { slug: app.slug, environments: placed };
  const rest: CapacityAppView[] = others.filter((o) => o.slug !== app.slug && o.environments).map((o) => ({ slug: o.slug, environments: o.environments! }));
  const usage = cellUsage(view, [mine, ...rest]);
  for (const [name, e] of Object.entries(placed)) {
    if (!e) continue;
    const u = usage.find((x) => x.environment === name && x.networkMode === e.networkMode && x.cell === cellOf(e));
    if (!u) continue;
    const own = reservationOf(e, view);
    const segs = e.capacity ? ["environments", name, "capacity"] : ["environments", name];
    const otherApps = u.apps.length - 1;
    const whose = `this app reserves ${formatCores(reservedCores(own))} (${describeReservation(own)}${e.capacity ? "" : ", the instance default"})${otherApps > 0 ? ` and ${otherApps} other app${otherApps === 1 ? "" : "s"} ${formatCores(u.reservedCores - reservedCores(own))}` : ""}`;
    if (u.reservedCores > u.cores) {
      at(
        segs,
        `cell ${u.cell} of ${u.networkMode} in environment ${name} would reserve ${formatCores(u.reservedCores)} cores, more than its budget of ${u.cores}: ${whose}. Lower the reservation, or ask the platform team for room in the cell (check cell-capacity).`,
        "cell-capacity",
      );
    }
    if (u.subnet && u.replicas > u.subnet.maxReplicas) {
      at(
        segs,
        `cell ${u.cell} of ${u.networkMode} in environment ${name} would run up to ${u.replicas} replicas in total, more than its subnet ${u.subnet.prefix} holds (${u.subnet.maxReplicas}); this app reserves ${own.maxReplicas}. Lower maxReplicas, or ask the platform team (check cell-subnet-capacity).`,
        "cell-subnet-capacity",
      );
    }
  }
  return out;
}

/**
 * A slug used again (ADR-0061 section 3): `archived` are the definitions of deleted apps with this slug
 * (apps-deleted/<slug>/<requestedOn>/app.yaml). The app needs a generation above every archived
 * generation, so the names that must be unique across Azure (app vault, registry, storage account,
 * database servers; ADR-0020) are new and no soft-deleted resource of the deleted app collides
 * (check slug-reuse-generation). It also needs an incarnation above every archived incarnation (an
 * archived definition without one counts as 0), so its Entra registration gets its own uniqueName: a
 * deleted application keeps its uniqueName in Entra's recycle bin for 30 days, and a uniqueName can't be
 * changed (check slug-reuse-incarnation).
 */
export function slugReuseChecks(app: AppData, archived: readonly { path?: string; text: string }[], parsed?: ParsedYaml): Finding[] {
  if (!archived.length) return [];
  const olds = archived
    .map((a) => ({ requestedOn: archivedRequestedOn(a) ?? "?", generation: archivedGeneration(a.text), incarnation: archivedIncarnation(a.text) }))
    .sort((a, b) => (a.requestedOn < b.requestedOn ? -1 : a.requestedOn > b.requestedOn ? 1 : 0));
  const deleted = `the slug "${app.slug}" belonged to ${olds.length === 1 ? "a deleted app" : `${olds.length} deleted apps`}`;
  const out: Finding[] = [];
  const finding = (field: "generation" | "incarnation", message: string, checkId: "slug-reuse-generation" | "slug-reuse-incarnation"): void => {
    const segs = app[field] === undefined ? ["slug"] : [field];
    const line = lineAt(parsed, segs);
    out.push({ path: pathOf(segs), message, checkId, ...(line !== undefined ? { line } : {}) });
  };
  const highest = Math.max(...olds.map((g) => g.generation));
  const mine = app.generation ?? 0;
  if (mine <= highest) {
    const list = olds.map((g) => `requested for deletion on ${g.requestedOn}: generation ${g.generation}`).join("; ");
    finding(
      "generation",
      `generation ${mine}${app.generation === undefined ? " (not set)" : ""} must be above ${highest}: ${deleted} (${ARCHIVE_DIR}/${app.slug}/: ${list}). Set generation to ${highest + 1}, so the new app gets new names for everything that must be unique across Azure (check slug-reuse-generation).`,
      "slug-reuse-generation",
    );
  }
  const top = Math.max(...olds.map((g) => g.incarnation));
  const mineI = app.incarnation ?? 0;
  if (mineI <= top) {
    const list = olds.map((g) => `requested for deletion on ${g.requestedOn}: incarnation ${g.incarnation}`).join("; ");
    finding(
      "incarnation",
      `incarnation ${mineI}${app.incarnation === undefined ? " (not set)" : ""} must be above ${top}: ${deleted} (${ARCHIVE_DIR}/${app.slug}/: ${list}). Set incarnation to ${top + 1}, so the new app gets its own Entra registration: a deleted app's registration keeps its name for 30 days (check slug-reuse-incarnation).`,
      "slug-reuse-incarnation",
    );
  }
  return out;
}

/**
 * Immutability (errors) and destructive changes (reported) between the base version and now. `today`
 * (UTC, default now) is the day decommissioning's date rule compares with (decommissionChanges).
 */
export function compareWithBase(
  base: AppData,
  app: AppData,
  parsed?: ParsedYaml,
  inst?: Pick<InstanceView, "environments" | "decommission">,
  today: string = utcDate(),
): { checks: Finding[]; destructive: Finding[] } {
  const checks: Finding[] = [];
  const destructive: Finding[] = [];
  const at = (list: Finding[], segs: (string | number)[], message: string): void => {
    const line = lineAt(parsed, segs);
    list.push({ path: pathOf(segs), message, ...(line !== undefined ? { line } : {}) });
  };
  decommissionChanges(base, app, parsed, inst, today, checks, destructive);
  if (base.slug !== app.slug) at(checks, ["slug"], `slug changed from "${base.slug}" to "${app.slug}"; the slug is immutable.`);
  const g0 = base.generation ?? 0;
  const g1 = app.generation ?? 0;
  if (g1 < g0) at(checks, ["generation"], `generation went down from ${g0} to ${g1}; it can never be lowered.`);
  // ADR-0061: the incarnation names the app's Entra registration for its whole life.
  const i0 = base.incarnation ?? 0;
  const i1 = app.incarnation ?? 0;
  if (i1 !== i0) {
    const segs = app.incarnation === undefined ? ["slug"] : ["incarnation"];
    const line = lineAt(parsed, segs);
    checks.push({
      path: pathOf(segs),
      message: `incarnation changed from ${i0} to ${i1}; it never changes: it names the app's Entra registration for its whole life (a new app with a deleted app's slug gets its own in the pull request that archives the deleted app's definition) (check incarnation-fixed).`,
      checkId: "incarnation-fixed",
      ...(line !== undefined ? { line } : {}),
    });
  }
  if (g1 > g0) at(destructive, ["generation"], `generation ${g0} -> ${g1}: the app's registry and app vault are re-created in every environment (images and secrets must be restored).`);
  const e0 = base.data?.database?.engine;
  const e1 = app.data?.database?.engine;
  if (e0 && e1 && e0 !== e1) at(checks, ["data", "database", "engine"], `database engine changed from ${e0} to ${e1}; the engine never changes (migrate to a new app instead).`);
  if (e0 && !e1) at(destructive, ["data"], `the ${e0} database is removed in every environment (its data is deleted).`);
  if (base.data?.storage && !app.data?.storage) at(destructive, ["data"], "the storage account is removed in every environment (its blobs are deleted).");
  for (const [name, e] of Object.entries(base.environments)) {
    const now = Object.hasOwn(app.environments, name) ? app.environments[name] : undefined;
    if (!now) at(destructive, ["environments"], `the app is removed from environment ${name} (all its resources there are deleted).`);
    else if (now.networkMode !== e.networkMode) {
      // ADR-0060: provisioning moves the app (destructive, a short outage), or the change is one it
      // can't make (refused). A new environment, or one removed, is no change of mode.
      const segs = ["environments", name, "networkMode"];
      const line = lineAt(parsed, segs);
      const mc = networkModeChange(name, e, now, inst?.environments.find((x) => x.name === name));
      if ("refused" in mc) checks.push({ path: pathOf(segs), message: mc.refused, checkId: "network-mode-change", ...(line !== undefined ? { line } : {}) });
      else destructive.push({ path: pathOf(segs), message: mc.destructive, ...(line !== undefined ? { line } : {}) });
    } else if (cellOf(now) !== cellOf(e)) {
      // ADR-0053: the cells of one mode are separate CAEs and a Container App can't change its CAE; the
      // platform places an app in another cell only when it moves it to another mode (ADR-0060 amendment
      // 2026-11-16), where it creates the app again anyway.
      const segs = Object.hasOwn(now, "cell") ? ["environments", name, "cell"] : ["environments", name];
      const line = lineAt(parsed, segs);
      checks.push({
        path: pathOf(segs),
        message: `capacity cell ${cellOf(e)} -> ${cellOf(now)} in ${name}: the app runs in ${e.networkMode} there, and the platform doesn't move an app between the cells of one network mode (ADR-0053); a cell changes only with a network mode change (ADR-0060). Keep cell ${cellOf(e)} (check cell-change).`,
        checkId: "cell-change",
        ...(line !== undefined ? { line } : {}),
      });
    }
    // Managed mode: provisioning removes a domain no longer requested, and replaces a changed one
    // after an overlap (ADR-0010, amended 2026-11-11). External mode: the Front Door team does.
    const was = e.frontDoor?.hostName;
    const is = now?.frontDoor?.hostName;
    const external = e.frontDoor?.profile !== undefined;
    if (now && was && !is) {
      at(
        destructive,
        ["environments", name],
        external
          ? `the custom domain ${was} is no longer requested in ${name}: the app answers on its default URL again; the team that runs the external Front Door profile removes its route and domain.`
          : `the custom domain ${was} is removed in ${name}: provisioning opens the app's ingress again, then deletes its Front Door route, custom domain and the DNS records it wrote (fd-${app.slug}-${name}); ${was} stops working.`,
      );
    } else if (now && was && is && lower(was) !== lower(is) && !external && frontDoorCustomDomainName(was) === frontDoorCustomDomainName(is)) {
      // The old domain stays on the route during the change (ADR-0010, amended 2026-11-11): both hosts
      // would be the one custom domain cd-{host} (ADR-0052).
      const segs = ["environments", name, "frontDoor", "hostName"];
      const line = lineAt(parsed, segs);
      checks.push({
        path: pathOf(segs),
        message: `custom domain ${was} -> ${is} in ${name}: both get the Front Door custom-domain name ${frontDoorCustomDomainName(is)}, and the old domain stays until the new one works; choose a host that differs in more than dots and hyphens (check front-door-domain-name).`,
        checkId: "front-door-domain-name",
        ...(line !== undefined ? { line } : {}),
      });
    } else if (now && was && is && lower(was) !== lower(is)) {
      at(
        destructive,
        ["environments", name, "frontDoor", "hostName"],
        external
          ? `custom domain ${was} -> ${is} in ${name}: the team that runs the external Front Door profile moves the route.`
          : `custom domain ${was} -> ${is} in ${name}: ${was} keeps working until Front Door serves ${is}; then provisioning deletes the old custom domain and the DNS records it wrote.`,
      );
    }
  }
  return { checks, destructive };
}

/**
 * A network mode change of an environment the app already runs in (ADR-0060). Provisioning moves the
 * app between External only and External with internal access (case A: External only on the managed
 * network; case B: External only in a VNet): destructive, a short outage, in an environment of kind
 * prod only inside the maintenance window. Refused (check network-mode-change, its ID kept from the
 * stopgap of batch 1): Internal only, to or from (deferred; app.schema.json doesn't offer it yet), and
 * any other pair. Any capacity cell (ADR-0060 amendment 2026-11-16): the app is created again in the
 * target mode's CAE of `now.cell`, which may differ from the source's number (cells are per mode,
 * ADR-0053); that the cell exists in the target mode and has room is cell-unknown's and cell-capacity's
 * (with --instance). The destructive line is the only one at environments.<env>.networkMode, which is
 * how the portal tells the change it asked for (portal/api requests/cli.ts validateNetworkModeChange).
 * `env` is the environment in instance.yaml, when known: it names the case and when the move runs.
 */
export function networkModeChange(
  name: string,
  was: { networkMode: string; cell?: string },
  now: { networkMode: string; cell?: string },
  env?: Pick<InstanceView["environments"][number], "kind" | "networkModes">,
): { refused: string } | { destructive: string } {
  const from = was.networkMode;
  const to = now.networkMode;
  const head = `network mode ${from} -> ${to} in ${name}`;
  if (from === "internalOnly" || to === "internalOnly") {
    return { refused: `${head}: Internal only isn't available yet, so the platform can't move an app to or from it (ADR-0060). Keep ${from} (check network-mode-change).` };
  }
  const pair = new Set([from, to]);
  if (from === to || !pair.has("externalOnly") || !pair.has("externalHybrid")) {
    return { refused: `${head}: the platform moves an app only between externalOnly and externalHybrid (ADR-0060). Keep ${from} (check network-mode-change).` };
  }
  const cellWas = cellOf(was);
  const cellNow = cellOf(now);
  // Cells are per mode (ADR-0053): name them once either isn't 01, so the line says where the app lands.
  const cells = cellWas === DEFAULT_CELL_ID && cellNow === DEFAULT_CELL_ID ? "" : ` (capacity cell ${cellWas} -> ${cellNow})`;
  const into = to === "externalHybrid";
  const kase = env ? (env.networkModes.externalOnly?.network === "vnet" ? "B" : "A") : undefined;
  const what =
    kase === "A"
      ? `; its vault and any database and storage ${into ? "get private endpoints and lose public access" : "get public access (Entra-only) back and lose their private endpoints"}, and a sign-in secret is issued again in the ${into ? "private" : "public"} environment vault`
      : kase === "B"
        ? `; its private endpoints are created again in the ${into ? "hybrid" : "External-only"} spoke`
        : "";
  const when = env ? (env.kind === "prod" ? ", inside the maintenance window" : ", in the merge's provisioning run") : "";
  return {
    destructive: `${head}${cells}${kase ? ` (case ${kase})` : ""}: provisioning moves the app there with a short outage${when}: its Container App is deleted and created again in the ${to} Container Apps environment${cells ? ` of cell ${cellNow}` : ""} with the same image${what} (ADR-0060).`,
  };
}

/**
 * Decommissioning against the base version (ADR-0056). Errors: requestedOn moved; from the base's
 * deleteAfter on (`today`, UTC; an immediate decommissioning from its merge, deleteAfter =
 * requestedOn) the block removed (the app revived) or its dates or immediate changed (check
 * decommission-tombstone: the delete phase has started and nothing brings the app back; ADR-0056
 * amendment 2026-11-12, deleted detected). A date rule against the base: no Azure state is needed, so
 * the build validation stays offline. Destructive, with checkId decommission (the portal's own request
 * and Cancel are recognised by it): the block added (the app stops everywhere, production named first;
 * deleted on or after deleteAfter), the block removed before deleteAfter (Cancel).
 */
function decommissionChanges(
  base: AppData,
  app: AppData,
  parsed: ParsedYaml | undefined,
  inst: Pick<InstanceView, "environments" | "decommission"> | undefined,
  today: string,
  checks: Finding[],
  destructive: Finding[],
): void {
  const was = base.decommission;
  const is = app.decommission;
  const push = (list: Finding[], segs: (string | number)[], message: string, checkId: string): void => {
    const line = lineAt(parsed, segs);
    list.push({ path: pathOf(segs), message, ...(checkId === "decommission" ? { decommission: true as const } : { checkId }), ...(line !== undefined ? { line } : {}) });
  };
  if (was && deletePhaseDue(base, today)) {
    // The delete phase has started (the dates alone say so): provisioning deletes the app, then finds
    // out by itself that nothing is left. The definition stays as it is until a new app asks for the
    // slug; that request moves it to apps-deleted/ (ADR-0061), and the new file is a new app.
    const since = was.immediate ? `its immediate deletion, requested on ${was.requestedOn}, started with the first run after the merge` : `its delete phase started on ${was.deleteAfter}`;
    if (!is) push(checks, ["decommission"], `the app is being deleted or is already deleted (${since}), so it can't come back. Request a new app instead: once the app is deleted, the new app's request may use this slug again and moves this definition to ${ARCHIVE_DIR}/${app.slug}/ (check decommission-tombstone).`, "decommission-tombstone");
    else if (is.requestedOn !== was.requestedOn || is.deleteAfter !== was.deleteAfter || is.immediate !== was.immediate) {
      push(checks, ["decommission"], `the app is being deleted or is already deleted (${since}), so its decommission dates don't change any more (check decommission-tombstone).`, "decommission-tombstone");
    }
    return;
  }
  if (was && is && is.requestedOn !== was.requestedOn) {
    push(checks, ["decommission", "requestedOn"], `decommission.requestedOn changed from ${was.requestedOn} to ${is.requestedOn}; it never changes once merged (Cancel, then request again).`, "decommission-grace");
  }
  if (was && is && is.immediate !== was.immediate) {
    push(
      checks,
      ["decommission", "immediate"],
      was.immediate
        ? "decommission.immediate can't be removed: the deletion has started with the first run after the merge (check decommission-immediate)."
        : "decommission.immediate can't be added to a decommissioning that is already merged; Cancel it, then request immediate deletion (check decommission-immediate).",
      "decommission-immediate",
    );
  }
  const envs = Object.keys(app.environments);
  const prod = (inst?.environments ?? []).filter((e) => e.kind === "prod" && envs.includes(e.name)).map((e) => e.name);
  if (!was && is && is.immediate === true && prod.length) {
    // Amendment 2026-11-21: only instance.yaml decommission.allowImmediateWithProduction lets this through
    // (instanceChecks refuses it otherwise); the reviewer reads production first and the setting named.
    push(
      destructive,
      ["decommission"],
      `PRODUCTION, IMMEDIATELY: the app runs in ${prod.join(", ")} and is deleted there too, without a grace period or the maintenance window. Only instance.yaml decommission.allowImmediateWithProduction allows this; it is meant for developing the platform, not for a production deployment.`,
      "decommission",
    );
    push(
      destructive,
      ["decommission"],
      `IMMEDIATE decommissioning of an app with production: the first provisioning run after the merge stops it in every environment (${envs.join(", ")}), disables and deletes its delivery pipeline, and deletes its Entra registrations, Front Door domains and portal-side endpoints; the next run deletes its resource groups with the data, vaults and identities, production's included. Nothing can be cancelled after the merge (ADR-0056 amendments 2026-11-12 and 2026-11-21).`,
      "decommission",
    );
  } else if (!was && is && is.immediate === true) {
    push(
      destructive,
      ["decommission"],
      `IMMEDIATE decommissioning: the app has no production. The first provisioning run after the merge stops it in every environment (${envs.join(", ")}), disables and deletes its delivery pipeline, and deletes its Entra registrations, Front Door domains and portal-side endpoints; the next run deletes its resource groups with the data, vaults and identities, without a grace period or the maintenance window. Nothing can be cancelled after the merge (ADR-0056 amendment 2026-11-12).`,
      "decommission",
    );
  } else if (!was && is) {
    if (prod.length) {
      push(destructive, ["decommission"], `PRODUCTION: the app stops in ${prod.join(", ")} at the next provisioning run, together with every other environment.`, "decommission");
    }
    push(
      destructive,
      ["decommission"],
      `decommissioning: the app stops in every environment (${envs.join(", ")}) at the next provisioning run and its delivery pipeline is disabled; nothing is deleted until ${is.deleteAfter}. From then on, at least ${decommissionSettings(inst ?? {}).graceDays} days after it stopped and in the maintenance window, its resources are deleted: data, vaults, identities, its registrations, pipeline and Front Door domains (ADR-0056).`,
      "decommission",
    );
  } else if (was && !is) {
    push(destructive, ["decommission"], `decommissioning cancelled: the app starts again at the next provisioning run and its delivery pipeline is enabled (possible until ${was.deleteAfter}, when the delete phase starts).`, "decommission");
  }
}

const REF_RE = /^(?!-)[A-Za-z0-9._/@^~-]{1,200}$/;

/**
 * The git work tree around `path` (a file or a directory) and the commit `ref` names, for reading
 * files as they are at --base. `rel` is `path` relative to the work tree's top ("/"-separated).
 */
export function baseCommit(path: string, ref: string): { root: string; commit: string; rel: string } {
  if (!REF_RE.test(ref) || ref.includes("..")) throw new UsageError(`--base "${ref}" is not a valid git ref.`);
  const abs = realpathSync(resolve(path));
  const top = spawnSync("git", ["-C", lstatSync(abs).isDirectory() ? abs : dirname(abs), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) throw new UsageError(`--base needs ${path} to be inside a git work tree.`);
  const root = realpathSync(top.stdout.trim());
  const verify = spawnSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { encoding: "utf8" });
  if (verify.status !== 0) throw new UsageError(`--base: git ref "${ref}" not found (fetch it first).`);
  return { root, commit: verify.stdout.trim(), rel: relative(root, abs).split(sep).join("/") };
}

/** A file's content at a commit of the work tree `root` (path relative to it), or undefined when it isn't there. */
export function showAtCommit(root: string, commit: string, rel: string): string | undefined {
  const show = spawnSync("git", ["-C", root, "show", `${commit}:${rel}`], { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
  return show.status === 0 ? show.stdout : undefined;
}

/** The file's content at a git ref, or undefined when it did not exist there. */
export function readAtRef(file: string, ref: string): string | undefined {
  const { root, commit, rel } = baseCommit(file, ref);
  return showAtCommit(root, commit, rel);
}

/** The instance a definition is checked against: its file name (messages) and parsed data. */
export interface InstanceInput {
  file: string;
  data: InstanceView;
}

/**
 * Validates an instance configuration given as text: YAML syntax, then the instance schema
 * (`platform validate instance`). `data` is set only when it is valid. Shared by the CLI
 * (`--instance`) and the library.
 */
export function instanceProblems(text: string): { parseErrors: AppValidateResult["parseErrors"]; problems: SchemaProblem[]; data?: InstanceView } {
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) return { parseErrors: parsed.parseErrors, problems: [] };
  const problems = validateData("instance", parsed.data, parsed);
  return { parseErrors: [], problems, ...(problems.length ? {} : { data: parsed.data as InstanceView }) };
}

/**
 * The core of `platform validate app` on text, without file or git access: schema, app-internal
 * checks, instance checks (with `instance`) and immutability against `base` (its `read()` returns
 * the definition at the base ref, undefined when the app is new there). `file` is the path whose
 * directory name the slug must equal. `today` (UTC, default now) is the day of decommissioning's
 * date rule (ADR-0056). The CLI and the library (validateAppDefinition) both call it, so they can't
 * drift.
 */
export function validateAppText(
  text: string,
  args: {
    file: string;
    instance?: InstanceInput;
    /**
     * `archivedAs`: this change moved the base's file into the archive of deleted apps (ADR-0061), so
     * the file is a new app and nothing is compared. `restoredFrom`: this change moved that archived
     * definition back to the file; `read()` returns the archived text, which the file is compared with.
     */
    base?: { ref: string; read: () => string | undefined; archivedAs?: string; restoredFrom?: string };
    others?: OtherApp[];
    /** The definitions of deleted apps with this slug in apps-deleted/<slug>/ (check slug-reuse-generation). */
    archived?: readonly { path?: string; text: string }[];
    today?: string;
  },
): AppValidateResult {
  const { file } = args;
  const result: AppValidateResult = { kind: "app", file, ok: false, parseErrors: [], problems: [], checks: [], destructive: [] };
  const parsed = parseYaml(text);
  if (parsed.parseErrors.length) return { ...result, parseErrors: parsed.parseErrors };
  result.problems = validateData("app", parsed.data, parsed);
  if (args.instance) result.instance = args.instance.file;

  // Semantic checks need a schema-valid document.
  if (result.problems.length === 0) {
    const app = parsed.data as AppData;
    result.checks.push(...appChecks(app, file, parsed));
    if (args.instance) result.checks.push(...instanceChecks(app, args.instance.data, parsed));
    if (args.others) result.checks.push(...repositoryChecks(app, args.others, parsed), ...frontDoorHostChecks(app, args.others, parsed));
    if (args.instance) result.checks.push(...capacityChecks(app, args.instance.data, args.others ?? [], parsed));
    if (args.archived) result.checks.push(...slugReuseChecks(app, args.archived, parsed));
    if (args.base?.archivedAs !== undefined) {
      // A slug used again (ADR-0061): the base's definition is the deleted app's, archived in this change.
      result.base = { ref: args.base.ref, found: true, archivedAs: args.base.archivedAs };
      if (args.instance) result.checks.push(...immediateProductionChecks(undefined, app, args.instance.data, parsed));
    } else if (args.base) {
      const baseText = args.base.read();
      result.base = { ref: args.base.ref, found: baseText !== undefined, ...(args.base.restoredFrom !== undefined ? { restoredFrom: args.base.restoredFrom } : {}) };
      if (baseText !== undefined) {
        const bp = parseYaml(baseText);
        // A base version that no longer parses or validates cannot be compared field by field.
        if (bp.parseErrors.length || validateData("app", bp.data, bp).length) {
          result.checks.push({ path: "(base)", message: `the version at ${args.base.ref} is not a valid app definition; immutability was not checked.` });
        } else {
          const cmp = compareWithBase(bp.data as AppData, app, parsed, args.instance?.data, args.today ?? utcDate());
          result.checks.push(...cmp.checks);
          result.destructive.push(...cmp.destructive);
          if (args.instance) result.checks.push(...immediateProductionChecks(bp.data as AppData, app, args.instance.data, parsed));
        }
      } else if (args.instance) {
        // A new app (absent at the base): its file is all new.
        result.checks.push(...immediateProductionChecks(undefined, app, args.instance.data, parsed));
      }
    }
  } else if (args.base) {
    result.base = {
      ref: args.base.ref,
      found: args.base.read() !== undefined,
      ...(args.base.archivedAs !== undefined ? { archivedAs: args.base.archivedAs } : {}),
      ...(args.base.restoredFrom !== undefined ? { restoredFrom: args.base.restoredFrom } : {}),
    };
  }
  result.checks.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  result.ok = result.problems.length === 0 && result.checks.length === 0;
  return result;
}

/** `platform validate app <file> [--instance <file>] [--base <ref>]`: files and git around validateAppText. */
export function validateApp(file: string, opts: { instance?: string; base?: string; today?: string } = {}): AppValidateResult {
  const text = readFileSync(file, "utf8");
  let instance: InstanceInput | undefined;
  if (opts.instance) {
    const iv = instanceOnce(opts.instance);
    if (!iv.data) throw new UsageError(`--instance ${opts.instance} is not a valid instance configuration (run "platform validate instance ${opts.instance}").`);
    instance = { file: opts.instance, data: iv.data };
  }
  const base = opts.base;
  const today = opts.today ?? utcDate();
  const others = opts.instance ? siblingApps(file, opts.instance, today) : undefined;
  const archived = archivedOfSlug(file);
  let baseArg: { ref: string; read: () => string | undefined; archivedAs?: string; restoredFrom?: string } | undefined;
  if (base !== undefined) {
    const baseText = readAtRef(file, base);
    const archivedAs = baseText !== undefined && archived?.length ? movedToArchive(base, baseText, archived) : undefined;
    const restored = baseText === undefined && archived !== undefined ? restoredFromArchive(file, base, text) : undefined;
    baseArg = restored
      ? { ref: base, read: () => restored.text, restoredFrom: restored.path }
      : { ref: base, read: () => baseText, ...(archivedAs !== undefined ? { archivedAs } : {}) };
  }
  return validateAppText(text, {
    file,
    today,
    ...(instance ? { instance } : {}),
    ...(others ? { others } : {}),
    ...(archived?.length ? { archived } : {}),
    ...(baseArg ? { base: baseArg } : {}),
  });
}

/**
 * The archive move of a slug used again (ADR-0061 section 3): the archived definition this change
 * added (absent at `ref`) whose text equals `file` at `ref`, i.e. the base's apps/<slug>/app.yaml moved
 * unchanged into apps-deleted/<slug>/<requestedOn>/. undefined when there is none: the file is then
 * compared with the base as usual. Whether the move itself was allowed is check deleted-archive's.
 */
function movedToArchive(ref: string, baseText: string, archived: readonly { path: string; abs: string; text: string }[]): string | undefined {
  return archived.find((a) => sameDefinitionText(a.text, baseText) && readAtRef(a.abs, ref) === undefined)?.path;
}

/**
 * The move back (ADR-0061): `file` (apps/<slug>/app.yaml) is absent at `ref`, and this change removes
 * an archived definition of the slug (apps-deleted/<slug>/<requestedOn>/app.yaml at `ref`, gone from the
 * work tree). The one whose text equals the file's, else the newest: the file is compared with it, so
 * a restored definition is the same app as before (and an edited one is a change of it). undefined
 * when the change removes none: the file is then a new app.
 */
function restoredFromArchive(file: string, ref: string, text: string): { path: string; text: string } | undefined {
  const appDir = dirname(resolve(file));
  const configRoot = dirname(dirname(appDir));
  const slug = basename(appDir);
  const { root, commit, rel } = baseCommit(file, ref);
  const tail = `apps/${slug}/app.yaml`;
  if (rel !== tail && !rel.endsWith(`/${tail}`)) return undefined;
  const prefix = rel.slice(0, rel.length - tail.length);
  const list = spawnSync("git", ["-C", root, "ls-tree", "-r", "-z", "--name-only", commit, "--", `${prefix}${ARCHIVE_DIR}/${slug}/`], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (list.status !== 0) return undefined;
  const removed: { path: string; text: string }[] = [];
  for (const full of list.stdout.split("\0").sort()) {
    const path = full.slice(prefix.length);
    const m = /^([^/]+)\/([^/]+)\/\d{4}-\d{2}-\d{2}\/app\.yaml$/.exec(path);
    if (!full.startsWith(prefix) || !m || m[1] !== ARCHIVE_DIR || m[2] !== slug) continue;
    try {
      lstatSync(join(configRoot, path));
      continue; // still archived: not moved back
    } catch {
      // gone from the work tree in this change
    }
    const was = showAtCommit(root, commit, full);
    if (was !== undefined) removed.push({ path, text: was });
  }
  return removed.find((r) => sameDefinitionText(r.text, text)) ?? removed.at(-1);
}

export function formatAppText(r: AppValidateResult): string {
  const lines: string[] = [];
  const where = (f: { line?: number }): string => (f.line ? `line ${f.line}: ` : "");
  if (r.ok) lines.push(`OK  ${r.file} is a valid app definition${r.instance ? ` for ${r.instance}` : ""}.`);
  else {
    lines.push(`FAILED  ${r.file} is not a valid app definition:`);
    for (const e of r.parseErrors) lines.push(`  line ${e.line}: YAML syntax error: ${e.message}`);
    for (const p of r.problems) {
      lines.push(`  ${where(p)}${p.path}: ${p.message}`);
      if (p.help) lines.push(`      ${p.help}`);
    }
    for (const c of r.checks) lines.push(`  ${where(c)}${c.path}: ${c.message}`);
  }
  if (!r.instance && r.problems.length === 0 && r.parseErrors.length === 0) lines.push("  (no --instance: environment, network, data, budget, sign-in, repository and custom domain rules were not checked)");
  if (r.base) {
    lines.push(
      r.base.archivedAs !== undefined
        ? `  new app: the deleted app with this slug moved to ${r.base.archivedAs} in this change; nothing compared with ${r.base.ref} (ADR-0061)`
        : r.base.restoredFrom !== undefined
          ? `  moved back from ${r.base.restoredFrom} in this change: compared with that archived definition at ${r.base.ref} (ADR-0061)`
          : r.base.found
            ? `  compared with ${r.base.ref}`
            : `  new app: not present at ${r.base.ref}`,
    );
  }
  for (const d of r.destructive) lines.push(`DESTRUCTIVE  ${where(d)}${d.path}: ${d.message}`);
  return lines.join("\n") + "\n";
}
