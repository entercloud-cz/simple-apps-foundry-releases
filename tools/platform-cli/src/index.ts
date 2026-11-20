/**
 * Library entry of @simple-apps-foundry/platform-cli (package.json `exports["."]`).
 *
 * The portal imports these functions instead of re-implementing them (ADR-0040 decision 1). A
 * request the portal pushes to platform-config therefore passes exactly the checks of
 * `platform validate app --instance`, and carries the `apps/{slug}/delivery.yml` that
 * `platform generate` writes. Both use the same code as the commands (validateAppText,
 * renderDelivery).
 *
 * validateInstanceDefinition is `platform validate instance [--base]` on text: the portal's Settings
 * area checks the instance.yaml it would commit with it, against main (ADR-0027).
 *
 * Pure: text in, values out. They read nothing but the JSON Schemas bundled in dist/schemas, never
 * exit the process and never print. Invalid input is a result (validateAppDefinition,
 * validateInstanceDefinition) or a thrown PlatformConfigError (renderDeliveryYaml).
 */
import { CheckFailed } from "./pipeline/common.js";
import { renderDelivery } from "./provisioning/generate.js";
import { parseInstanceText } from "./provisioning/model.js";
import { parseYaml, validateData } from "./schema.js";
import { instanceProblems, otherAppsFromTexts, validateAppText } from "./validate-app.js";
import type { AppData, AppValidateResult } from "./validate-app.js";
import { utcDate } from "./decommission.js";
import { environmentsInUseOf } from "./network-change.js";
import type { AppEnvironmentsView } from "./network-change.js";
import { instanceChangeChecks, instanceWarnings } from "./validate-instance-change.js";
import type { EnvironmentNetworkView, InstanceWarningView } from "./validate-instance-change.js";
import { instanceSelfChecks } from "./validate-instance.js";
import type { InstanceSelfView } from "./validate-instance.js";

export { REPOSITORY_TEMPLATES, repositoryTemplate } from "./validate-app.js";
// The archive of deleted apps (ADR-0061): apps-deleted/{slug}/{requestedOn}/app.yaml, never provisioned.
export { ARCHIVE_DIR, archivedAppYamlPath, archivedGeneration, archivedIncarnation } from "./archive.js";
export type { AppData as AppDefinition, RepositoryTemplate } from "./validate-app.js";
export { PROVISIONING_YAML, VALIDATION_YAML } from "./provisioning/generate.js";
// The failure catalogue (US09.05): the check rules and a plain-language explanation and AI prompt for
// each, in English and Czech. The portal's failed-check view and failure mail use the same text. The
// browser-safe subset is also exported as "@simple-apps-foundry/platform-cli/explanations" (package.json).
export { RULES, RULE_ALIASES, canonicalRuleId } from "./rules.js";
export type { RuleDef } from "./rules.js";
export {
  DEFINITION_CHECK_IDS,
  DEFINITION_EXPLANATIONS,
  INSTANCE_CHECK_IDS,
  INSTANCE_EXPLANATIONS,
  PIPELINE_CHECK_IDS,
  PIPELINE_EXPLANATIONS,
  PROVISIONING_FAILURES,
  PROVISIONING_FAILURE_IDS,
  RULE_EXPLANATIONS,
  UNKNOWN_PROVISIONING_FAILURE,
  checkAiPrompt,
  explainCheck,
  explainProvisioningFailure,
  isProvisioningFailureCode,
} from "./explanations.js";
export type { CheckExplanation, ExplanationLanguage, InstanceCheckId, LocalizedText, PipelineCheckId, PromptContext, ProvisioningFailureExplanation, ProvisioningFailureId } from "./explanations.js";
// CAE subnet capacity (network-modes.md#sizing): what a subnet holds, for the portal's check of the
// sum of the apps' maxReplicas against it, and the ranges `platform validate instance` refuses.
export { CAE_RESERVED_IPS, CONTAINER_APPS_RESERVED_RANGES, caeSubnetCapacity, caeSubnetIpsNeeded } from "./cidr.js";
export { BASIC_DATABASE_ENGINES, BASIC_DATABASE_SIZES, BASIC_MODE_DEFAULTS, BASIC_NETWORK_MODES, BASIC_STACKS, basicModeOf } from "./basic-mode.js";
export type { BasicModeSetting } from "./basic-mode.js";
// The maintenance window (ADR-0048 section 7), also browser-safe as "@simple-apps-foundry/platform-cli/maintenance".
export { MAINTENANCE_DEFAULTS, REGISTRY_RETENTION_MODES, WEEK_DAYS, maintenanceCron, maintenanceOf, nextWindowStart, windowAt } from "./maintenance.js";
export type { MaintenanceSettings, MaintenanceWindow, RegistryRetention, WeekDay, WindowAt } from "./maintenance.js";
// Decommissioning (ADR-0056), also browser-safe as "@simple-apps-foundry/platform-cli/decommission".
export { DECOMMISSION_DEFAULTS, DECOMMISSION_REMINDER_DAYS, addDays, daysBetween, decommissionOf, decommissionSettings, deleteAfterFor, deletePhaseDue, isDate, offlinePhase, utcDate } from "./decommission.js";
export type { DecommissionBlock, DecommissionSettings, OfflinePhase } from "./decommission.js";
// Capacity cells and reservations (ADR-0053), also browser-safe as "@simple-apps-foundry/platform-cli/capacity".
export {
  CAPACITY_SIZES,
  CELL_ID_RE,
  DEFAULT_CELL_CORES,
  DEFAULT_CELL_ID,
  DEFAULT_RESERVATION,
  SIZE_VCPU,
  cellCaeNetworkSecurityGroupName,
  cellCaeSubnetName,
  cellManagedEnvironmentName,
  cellOf,
  cellPlatformJobName,
  cellUsage,
  cellsOfMode,
  defaultReservation,
  placeInCell,
  reservationOf,
  reservedCores,
  withinReservation,
} from "./capacity.js";
export type { CapacityReservation, CapacitySize, CellApp, CellUsage } from "./capacity.js";
export {
  BUILT_IN_APP_THEMES,
  THEME_CUSTOM,
  THEME_NONE,
  appThemeById,
  appThemeChoices,
  appThemesOf,
  contrastRatio,
  customThemePlaceholder,
  defaultAppThemeOf,
  themeCss,
  themeCssVariables,
  themeJson,
  themeSeedCss,
} from "./themes.js";
export type { AppTheme, AppThemeText, AppThemeTokens } from "./themes.js";

/** One problem, in the order `platform validate app` prints them (syntax, schema, rules). */
export interface AppDefinitionProblem {
  /** The input it is in: the app definition, or the instance configuration it is checked against. */
  source: "app" | "instance";
  /** syntax = YAML; schema = the JSON Schema; rule = a check the schema can't express. */
  kind: "syntax" | "schema" | "rule";
  /** Field path such as `environments.prod.networkMode`; `(root)` for the document. */
  path: string;
  message: string;
  line?: number;
  column?: number;
  /** The schema's description of the field, shortened (schema problems only). */
  help?: string;
  /** The check of an app definition, when it has an explanation (DEFINITION_CHECK_IDS). */
  checkId?: string;
  /** A destructive change that decommissioning itself makes (ADR-0056): the request, Cancel. */
  decommission?: true;
}

export interface AppDefinitionResult {
  ok: boolean;
  /** Errors; empty when ok. */
  problems: AppDefinitionProblem[];
  /** Destructive changes against `baseAppYamlText` (reported, not errors; ADR-0032). */
  destructive: AppDefinitionProblem[];
  /** The parsed definition, only when ok. */
  app?: AppData;
}

export interface ValidateAppDefinitionOptions {
  /**
   * Path of the file in platform-config. Its directory must equal the slug, as with the CLI.
   * Default `apps/<slug>/app.yaml`, the path the portal writes.
   */
  path?: string;
  /**
   * The same file on the base branch, for the immutability checks of `platform validate app
   * --base` (slug, generation never lower, database engine) and the destructive changes. Omit it
   * for a new app.
   */
  baseAppYamlText?: string;
  /**
   * The other apps' definitions (apps/<other>/app.yaml on the base branch), for the rule that every
   * app has its own repository. The CLI reads them from the folders next to the file.
   */
  otherAppYamlTexts?: string[];
  /**
   * The definitions of deleted apps with this slug (apps-deleted/<slug>/<requestedOn>/app.yaml, ADR-0061),
   * for the rule that a slug used again gets a generation above every archived one (check
   * slug-reuse-generation). The CLI reads them from apps-deleted/ beside the apps/ folder. A new app
   * that uses a deleted app's slug is a new app: pass no `baseAppYamlText` for it.
   */
  archivedAppYamlTexts?: string[];
  /**
   * Today's UTC date (YYYY-MM-DD), default now: the day decommissioning's date rule compares with
   * (ADR-0056: from deleteAfter on, the block stays and the app no longer counts for the others).
   */
  today?: string;
}

/** Thrown by renderDeliveryYaml when the inputs are not valid. */
export class PlatformConfigError extends Error {
  constructor(
    message: string,
    readonly problems: AppDefinitionProblem[],
  ) {
    super(message);
    this.name = "PlatformConfigError";
  }
}

/** Path of an app's definition in platform-config. */
export function appYamlPath(slug: string): string {
  return `apps/${slug}/app.yaml`;
}

/** Path of the generated delivery pipeline of an app in platform-config. */
export function deliveryYamlPath(slug: string): string {
  return `apps/${slug}/delivery.yml`;
}

function fromResult(source: AppDefinitionProblem["source"], r: Pick<AppValidateResult, "parseErrors" | "problems" | "checks">): AppDefinitionProblem[] {
  return [
    ...r.parseErrors.map((e): AppDefinitionProblem => ({ source, kind: "syntax", path: "(root)", message: `YAML syntax error: ${e.message}`, line: e.line, column: e.column })),
    ...r.problems.map(
      (p): AppDefinitionProblem => ({
        source,
        kind: "schema",
        path: p.path,
        message: p.message,
        ...(p.line !== undefined ? { line: p.line } : {}),
        ...(p.column !== undefined ? { column: p.column } : {}),
        ...(p.help !== undefined ? { help: p.help } : {}),
      }),
    ),
    ...r.checks.map(
      (c): AppDefinitionProblem => ({
        source,
        kind: "rule",
        path: c.path,
        message: c.message,
        ...(c.line !== undefined ? { line: c.line } : {}),
        ...(c.checkId !== undefined ? { checkId: c.checkId } : {}),
        ...(c.decommission ? { decommission: true as const } : {}),
      }),
    ),
  ];
}

function slugOf(appYamlText: string): string {
  const parsed = parseYaml(appYamlText);
  const slug = (parsed.data as { slug?: unknown } | undefined)?.slug;
  // An unusable slug fails the schema; the semantic checks (and the path) don't run then.
  return typeof slug === "string" && /^[a-z0-9-]{1,64}$/.test(slug) ? slug : "_";
}

/**
 * Exactly `platform validate app <path> --instance <instance.yaml>` (plus `--base` when
 * `baseAppYamlText` is given, the own-repository rule when `otherAppYamlTexts` is, and check
 * slug-reuse-generation when `archivedAppYamlTexts` is): YAML
 * syntax, app.schema.json, the app-internal rules and the rules against the instance. An invalid instance gives problems with `source: "instance"` (the CLI
 * stops with a usage error there).
 */
export function validateAppDefinition(instanceYamlText: string, appYamlText: string, opts: ValidateAppDefinitionOptions = {}): AppDefinitionResult {
  const iv = instanceProblems(instanceYamlText);
  if (!iv.data) return { ok: false, problems: fromResult("instance", { parseErrors: iv.parseErrors, problems: iv.problems, checks: [] }), destructive: [] };
  const file = opts.path ?? appYamlPath(slugOf(appYamlText));
  const base = opts.baseAppYamlText;
  const today = opts.today ?? utcDate();
  const others = opts.otherAppYamlTexts ? otherAppsFromTexts(opts.otherAppYamlTexts.map((text) => ({ text })), today) : undefined;
  const r = validateAppText(appYamlText, {
    file,
    today,
    instance: { file: "instance.yaml", data: iv.data },
    ...(others ? { others } : {}),
    ...(opts.archivedAppYamlTexts?.length ? { archived: opts.archivedAppYamlTexts.map((text) => ({ text })) } : {}),
    ...(base !== undefined ? { base: { ref: "base", read: () => base } } : {}),
  });
  const result: AppDefinitionResult = {
    ok: r.ok,
    problems: fromResult("app", r),
    destructive: fromResult("app", { parseErrors: [], problems: [], checks: r.destructive }),
  };
  if (r.ok) result.app = parseYaml(appYamlText).data as AppData;
  return result;
}

export interface InstanceDefinitionResult {
  ok: boolean;
  /** Errors (source "instance"), in the order `platform validate instance` prints them; empty when ok. */
  problems: AppDefinitionProblem[];
  /** Findings that don't fail it (validate-instance-change.ts instanceWarnings), with their checkId. */
  warnings: AppDefinitionProblem[];
}

/** What `platform validate instance --base` compares against: the base's instance.yaml and the app definitions. */
export interface InstanceBase {
  /** instance.yaml at the base (main); a base that doesn't parse or validate is not compared. */
  instanceYamlText: string;
  /**
   * Every apps/<slug>/app.yaml (the environments they list are in use; a decommissioned app's not
   * from its deleteAfter on, ADR-0056).
   */
  appYamlTexts: readonly string[];
  /** Today's UTC date (YYYY-MM-DD), default now: the day that decommissioning's date rule compares with. */
  today?: string;
}

/**
 * Exactly `platform validate instance <file> [--base <ref>]` on text: YAML syntax,
 * instance.schema.json, then the rules the schema can't express (validate-instance.ts), which run
 * only on a schema-valid document, and with `base` the checks against it (the network of an
 * environment with apps doesn't change, validate-instance-change.ts).
 */
export function validateInstanceDefinition(instanceYamlText: string, base?: InstanceBase): InstanceDefinitionResult {
  const parsed = parseYaml(instanceYamlText);
  if (parsed.parseErrors.length) return { ok: false, problems: fromResult("instance", { parseErrors: parsed.parseErrors, problems: [], checks: [] }), warnings: [] };
  const problems = validateData("instance", parsed.data, parsed);
  if (problems.length > 0) return { ok: false, problems: fromResult("instance", { parseErrors: [], problems, checks: [] }), warnings: [] };
  const checks = instanceSelfChecks(parsed.data as InstanceSelfView, parsed);
  if (base) {
    const old = parseYaml(base.instanceYamlText);
    if (!old.parseErrors.length && validateData("instance", old.data, old).length === 0) {
      const apps = base.appYamlTexts.map((t) => parseYaml(t)).filter((p) => !p.parseErrors.length && p.data && typeof p.data === "object").map((p) => p.data as AppEnvironmentsView);
      checks.push(...instanceChangeChecks(old.data as EnvironmentNetworkView, parsed.data as EnvironmentNetworkView, environmentsInUseOf(apps, base.today ?? utcDate()), parsed));
    }
  }
  const warnings = fromResult("instance", { parseErrors: [], problems: [], checks: instanceWarnings(parsed.data as InstanceWarningView, parsed) });
  return { ok: checks.length === 0, problems: fromResult("instance", { parseErrors: [], problems: [], checks }), warnings };
}

/**
 * The exact text `platform generate` writes to `apps/{slug}/delivery.yml` for this instance and
 * app definition. Throws PlatformConfigError when the definition does not pass
 * validateAppDefinition or the instance can't carry a delivery pipeline.
 */
export function renderDeliveryYaml(instanceYamlText: string, appYamlText: string): string {
  const v = validateAppDefinition(instanceYamlText, appYamlText);
  if (!v.ok || !v.app) throw new PlatformConfigError("the app definition is not valid for this instance", v.problems);
  try {
    return renderDelivery(v.app, parseInstanceText(instanceYamlText));
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    const problems = e.problems.map((message): AppDefinitionProblem => ({ source: "instance", kind: "rule", path: "(root)", message }));
    throw new PlatformConfigError(e.problems.join(" "), problems);
  }
}
