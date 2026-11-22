import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { reservationOf } from "../capacity.js";
import { environmentInputs, portalInputs } from "../environment/inputs.js";
import { CheckFailed, isObject } from "../pipeline/common.js";
import { maintenanceCron, maintenanceOf } from "../maintenance.js";
import { AI_GUIDE_FILES, aiGuideFiles } from "../onboarding/agent-files.js";
import type { AppData } from "../validate-app.js";
import { instanceEnvironmentsOrdered, loadAppFile, loadInstanceFile, orderedEnvironments, platformConfigDefaultBranch } from "./model.js";
import type { Instance, InstanceEnv } from "./model.js";

/**
 * `platform generate [--config-dir .] [--check]`: renders apps/{slug}/delivery.yml for every
 * apps/{slug}/app.yaml of a platform-config repo from that file and instance.yaml (never for the
 * archive of deleted apps, apps-deleted/, which has no delivery.yml; ADR-0061). The body is
 * the shape the delivery templates expect (pipelines/azure-devops/app-delivery.yml parameters
 * app, environments, action, targetEnvironment, sourceRunId); only the header says it is
 * generated. It also renders pipelines/provisioning.yml from instance.yaml (the provisioning
 * pipeline, pipelines/azure-devops/app-provisioning.yml with its parameters environments and
 * hostEnvironment; a merge trigger and the maintenance window's schedule, ADR-0048), pipelines/validation.yml (the pull request validation of platform-config,
 * pipelines/azure-devops/platform-validation.yml, no parameters; ADR-0040) and one
 * pipelines/platform-{env}.yml per environment (the platform pipeline,
 * pipelines/azure-devops/platform-environment.yml with its parameters environment and
 * hostEnvironment; ADR-0043). Next to them the pipelines' inputs (ADR-0074): pipelines/inputs/provisioning.json
 * (instance.yaml without the keys only the portal reads) and pipelines/inputs/platform-{env}.json (what that
 * environment's platform pipeline deploys from instance.yaml), which the merge triggers of the pipelines name
 * instead of instance.yaml. And the instance's AI guide (ADR-0072): AGENTS.md, CLAUDE.md, the skill
 * onboard-instance in .agents/skills/ and .claude/skills/, .github/copilot-instructions.md and .gemini/settings.json
 * (src/onboarding/agent-files.ts; the same for every instance of a core version).
 *
 * renderGenerated is the rendering alone, a pure function of instance.yaml and the app definitions; generate()
 * writes its result, --check renders in memory and reports drift instead of writing, and the library's
 * renderGeneratedFiles (src/index.ts) gives the portal the same files for its pull requests.
 */

/** Path of the provisioning pipeline in platform-config. */
export const PROVISIONING_YAML = "pipelines/provisioning.yml";

/** Path of the pull request validation pipeline (\platform\validation) in platform-config. */
export const VALIDATION_YAML = "pipelines/validation.yml";

/** Path of an environment's platform pipeline (\platform\platform-{env}) in platform-config. */
export const platformYaml = (env: string): string => `pipelines/platform-${env}.yml`;
const PLATFORM_YAML_RE = /^platform-([a-z][a-z0-9]{1,7})\.yml$/;

/** Folder of the pipelines' generated inputs in platform-config (ADR-0074). */
export const INPUTS_DIR = "pipelines/inputs";

/** The provisioning pipeline's inputs: instance.yaml without PORTAL_ONLY_KEYS (ADR-0074 section 1). */
export const PROVISIONING_INPUTS_JSON = `${INPUTS_DIR}/provisioning.json`;

/** An environment's platform pipeline inputs: what it deploys from instance.yaml (ADR-0074 section 1). */
export const platformInputsJson = (env: string): string => `${INPUTS_DIR}/platform-${env}.json`;
const PLATFORM_INPUTS_RE = /^platform-([a-z][a-z0-9]{1,7})\.json$/;

/**
 * instance.yaml keys that only the portal reads (ADR-0074 section 2), left out of pipelines/inputs/provisioning.json
 * so that a change of them alone doesn't start \platform\provisioning:
 *   setup                              the setup wizard's progress (ADR-0073)
 *   lifecycle                          the Lifecycle tab and its reminders (ADR-0054)
 *   observability.auditRetentionDays   the retention of the portal's audit log (ADR-0012)
 *   branding.logoUrl                   the portal's logo
 *   branding.primaryColor              the portal's accent colour
 * Not portal-only, so kept: the rest of branding (provisioning seeds a new app's repository with its theme from
 * branding.appThemes, ADR-0044), notifications (platformTeamAddress: the alert emails of prod landing zones),
 * productName (the ManagedBy tag). test/provisioning-inputs-guard.test.ts fails when the provisioning code starts
 * reading one of them.
 */
export const PORTAL_ONLY_KEYS: readonly string[] = ["setup", "lifecycle", "observability.auditRetentionDays", "branding.logoUrl", "branding.primaryColor"];

/** A YAML scalar: plain when unambiguous, otherwise single-quoted. */
export function scalar(s: string): string {
  const plain = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(s) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(s) && !/^[0-9][0-9._-]*$/.test(s);
  return plain ? s : `'${s.replace(/'/g, "''")}'`;
}

function azureDevOps(inst: Instance): NonNullable<Instance["scm"]["azureDevOps"]> {
  const ado = inst.scm.azureDevOps;
  if (inst.scm.provider !== "azureDevOps" || !ado) throw new CheckFailed(["generate: only scm.provider azureDevOps is supported."]);
  return ado;
}

/** The core repository resource, the same in every generated pipeline. */
function coreRepository(inst: Instance): string[] {
  return [
    "    - repository: core",
    "      type: git",
    `      name: ${scalar(`${azureDevOps(inst).platformProject}/core`)}`,
    `      ref: ${scalar(`refs/tags/${inst.coreVersion}`)}`,
  ];
}

/** The `environments` template parameter (indent = the list's indentation). */
function environmentsParam(envs: InstanceEnv[], indent: string): string[] {
  return envs.flatMap((e) => [`${indent}- name: ${e.name}`, `${indent}  kind: ${e.kind}`, `${indent}  promoteFrom: ${e.promoteFrom ? scalar(e.promoteFrom) : "''"}`]);
}

/**
 * The delivery pipeline's `environments` parameter: each entry also carries the app's capacity
 * reservation there (ADR-0053: app.yaml `environments.<env>.capacity`, else instance.yaml
 * `newApps.capacity`). It is data platform-config reviews, never a switch: release-inputs refuses a
 * platform.yaml above it (pipeline check capacity-reservation).
 */
function deliveryEnvironmentsParam(app: AppData, envs: InstanceEnv[], inst: Instance, indent: string): string[] {
  return envs.flatMap((e) => {
    const r = reservationOf(app.environments[e.name], inst);
    return [
      `${indent}- name: ${e.name}`,
      `${indent}  kind: ${e.kind}`,
      `${indent}  promoteFrom: ${e.promoteFrom ? scalar(e.promoteFrom) : "''"}`,
      `${indent}  capacity:`,
      `${indent}    size: ${r.size}`,
      `${indent}    maxReplicas: ${r.maxReplicas}`,
    ];
  });
}

/**
 * The provisioning pipeline's `environments` parameter: every instance environment, build
 * environments first, then each promotion environment after its promoteFrom (instance order
 * otherwise). `platform provisioning validate-run` compares a run's parameter with this.
 */
export function provisioningEnvironments(inst: Instance): { name: string; kind: "prod" | "nonprod"; promoteFrom: string }[] {
  return instanceEnvironmentsOrdered(inst).map((e) => ({ name: e.name, kind: e.kind, promoteFrom: e.promoteFrom ?? "" }));
}

/**
 * The provisioning pipeline's `hostEnvironment` parameter: instance portal.hostEnvironment, whose
 * subscription holds rg-{prefix}-entra (ADR-0033). It must be an environment of the instance.
 */
export function provisioningHostEnvironment(inst: Instance): string {
  const host = inst.portal?.hostEnvironment;
  if (typeof host !== "string" || !instanceEnvironmentsOrdered(inst).some((e) => e.name === host)) {
    throw new CheckFailed([`instance.yaml portal.hostEnvironment "${String(host).slice(0, 40)}" is not an environment of this instance.`]);
  }
  return host;
}

/**
 * The maintenance run (ADR-0048 section 7): one schedule at the start of instance.yaml's maintenance
 * window (`maintenance.window`, UTC) on each of its days, `always: true` because what it does is due
 * by date, not by a change. It replaces the monthly schedule of ADR-0041 and the weekly Front Door
 * schedule of ADR-0010. It is an ordinary run (rule P19) and does what any run would do at that
 * time: the drift checks that are due (a unit not checked for `maintenance.driftCheckDays`), the
 * Easy Auth rotations that are due (rotation-due), the releases whose Front Door backend ranges
 * changed, and the upgrades scheduled into the window (ADR-0049).
 */
export function maintenanceSchedule(inst: Instance): string {
  return maintenanceCron(maintenanceOf(inst as { maintenance?: unknown }));
}

export function renderProvisioning(inst: Instance): string {
  azureDevOps(inst);
  const branch = scalar(`refs/heads/${platformConfigDefaultBranch(inst)}`);
  const lines = [
    "# GENERATED by `platform generate` from instance.yaml: do not edit.",
    "# Provisioning pipeline of this instance, registered as \\platform\\provisioning. Everything runs in",
    "# the core template (ADR-0032): don't add steps. A merge starts it when apps/, its inputs or this file",
    `# change (${PROVISIONING_INPUTS_JSON}: instance.yaml without the keys only the portal reads; ADR-0074).`,
    "name: $(Date:yyyyMMdd)$(Rev:.r)",
    "appendCommitMessageToRunName: false",
    "",
    "trigger:",
    "  batch: true",
    "  branches:",
    "    include:",
    `      - ${branch}`,
    "  paths:",
    "    include:",
    "      - apps",
    `      - ${PROVISIONING_INPUTS_JSON}`,
    `      - ${PROVISIONING_YAML}`,
    "pr: none",
    "",
    "# The maintenance window (instance.yaml maintenance, UTC; ADR-0048): drift checks that are due,",
    "# Easy Auth rotations that are due, releases whose Front Door backend ranges changed, scheduled upgrades.",
    "schedules:",
    `  - cron: '${maintenanceSchedule(inst)}'`,
    "    displayName: Maintenance window",
    "    branches:",
    "      include:",
    `        - ${branch}`,
    "    always: true",
    "",
    "# Which apps the run checks (ADR-0046): changed = the apps whose inputs changed since their last",
    "# finished provisioning, and those not finished; all = every app (the portal's \"Check all apps\").",
    "# Which apps the run upgrades (ADR-0049): none, all, or app slugs separated by commas (at most 50);",
    "# their units that this core's templates changed run. Both only widen a run, never skip a check.",
    "parameters:",
    "  - name: scope",
    "    displayName: Apps to check",
    "    type: string",
    "    default: changed",
    "    values:",
    "      - changed",
    "      - all",
    "  - name: upgrade",
    "    displayName: Apps to upgrade (none, all, or slugs separated by commas)",
    "    type: string",
    "    default: none",
    "",
    "resources:",
    "  repositories:",
    ...coreRepository(inst),
    "",
    "extends:",
    "  template: pipelines/azure-devops/app-provisioning.yml@core",
    "  parameters:",
    "    environments:",
    ...environmentsParam(instanceEnvironmentsOrdered(inst), "      "),
    `    hostEnvironment: ${scalar(provisioningHostEnvironment(inst))}`,
    "    scope: ${{ parameters.scope }}",
    "    upgrade: ${{ parameters.upgrade }}",
  ];
  return lines.join("\n") + "\n";
}

/**
 * The platform pipeline of one environment (ADR-0043), registered as \platform\platform-{env}: it
 * deploys infra/platform/environment.bicep with that environment's provisioning identity, after an
 * approval and only when the plan finds a change. It runs on a merge that changes its inputs
 * (pipelines/inputs/platform-{env}.json, ADR-0074) or this file (a core upgrade changes its core ref), and by
 * hand; no queue-time parameters.
 */
export function renderPlatform(inst: Instance, env: InstanceEnv): string {
  azureDevOps(inst);
  const branch = scalar(`refs/heads/${platformConfigDefaultBranch(inst)}`);
  const lines = [
    "# GENERATED by `platform generate` from instance.yaml: do not edit.",
    `# Platform pipeline of the environment \`${env.name}\`, registered as \\platform\\platform-${env.name}. Everything runs`,
    "# in the core template (ADR-0043): don't add steps. A merge starts it when its inputs or this file change",
    `# (${platformInputsJson(env.name)}: what it deploys from instance.yaml; ADR-0074).`,
    "name: $(Date:yyyyMMdd)$(Rev:.r)",
    "appendCommitMessageToRunName: false",
    "",
    "trigger:",
    "  batch: true",
    "  branches:",
    "    include:",
    `      - ${branch}`,
    "  paths:",
    "    include:",
    `      - ${platformYaml(env.name)}`,
    `      - ${platformInputsJson(env.name)}`,
    "pr: none",
    "",
    "resources:",
    "  repositories:",
    ...coreRepository(inst),
    "",
    "extends:",
    "  template: pipelines/azure-devops/platform-environment.yml@core",
    "  parameters:",
    `    environment: ${scalar(env.name)}`,
    `    hostEnvironment: ${scalar(provisioningHostEnvironment(inst))}`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * The instance's pull request validation pipeline, registered as \platform\validation and run by
 * the build validation policy on platform-config's default branch (ADR-0040 decision 3). No
 * trigger of its own: Azure Repos ignores `pr:`, the policy queues it for every pull request.
 */
export function renderValidation(inst: Instance): string {
  azureDevOps(inst);
  const lines = [
    "# GENERATED by `platform generate` from instance.yaml: do not edit.",
    "# Pull request validation of this instance, registered as \\platform\\validation and required by the",
    `# build validation policy on ${platformConfigDefaultBranch(inst)} (ADR-0040). Everything runs in the core template: don't`,
    "# add steps. It has no credentials and no service connection.",
    "name: $(Date:yyyyMMdd)$(Rev:.r)",
    "appendCommitMessageToRunName: false",
    "",
    "trigger: none",
    "pr: none",
    "",
    "resources:",
    "  repositories:",
    ...coreRepository(inst),
    "",
    "extends:",
    "  template: pipelines/azure-devops/platform-validation.yml@core",
  ];
  return lines.join("\n") + "\n";
}

/**
 * JSON for the generated inputs (ADR-0074): object keys sorted (UTF-16 order, at every level), arrays in their
 * order, two spaces of indentation, one value per line and a final newline, so a change shows in a pull
 * request's diff as the lines of the values it changes. Undefined members are left out, like JSON.stringify.
 */
export function stableJson(value: unknown): string {
  const render = (v: unknown, indent: string): string => {
    const inner = `${indent}  `;
    if (Array.isArray(v)) return v.length === 0 ? "[]" : `[\n${v.map((x) => inner + render(x ?? null, inner)).join(",\n")}\n${indent}]`;
    if (isObject(v) && !(v instanceof Date)) {
      const keys = Object.keys(v)
        .filter((k) => v[k] !== undefined)
        .sort();
      return keys.length === 0 ? "{}" : `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${render(v[k], inner)}`).join(",\n")}\n${indent}}`;
    }
    return JSON.stringify(v ?? null);
  };
  return `${render(value, "")}\n`;
}

/** obj without the key path segs (a parent left empty by it goes too, so adding a portal-only key changes nothing). */
function withoutPath(obj: Record<string, unknown>, segs: readonly string[]): void {
  const [head, ...rest] = segs;
  if (head === undefined || !Object.hasOwn(obj, head)) return;
  if (rest.length === 0) {
    delete obj[head];
    return;
  }
  const child = obj[head];
  if (!isObject(child)) return;
  withoutPath(child, rest);
  if (Object.keys(child).length === 0) delete obj[head];
}

/** instance.yaml as data without PORTAL_ONLY_KEYS: what pipelines/inputs/provisioning.json holds (ADR-0074). */
export function provisioningInputs(inst: Instance): Record<string, unknown> {
  const copy = structuredClone(inst) as unknown as Record<string, unknown>;
  for (const key of PORTAL_ONLY_KEYS) withoutPath(copy, key.split("."));
  return copy;
}

export function renderProvisioningInputs(inst: Instance): string {
  return stableJson({
    $comment: `GENERATED by \`platform generate\` from instance.yaml: do not edit. The inputs of \\platform\\provisioning (ADR-0074): instance.yaml without the keys only the portal reads (leftOut). A merge that changes this file, apps/ or ${PROVISIONING_YAML} starts the pipeline.`,
    instance: provisioningInputs(inst),
    leftOut: [...PORTAL_ONLY_KEYS],
  });
}

/** The values, or why they don't resolve (the pipeline's stage validate fails with the same problems then). */
function resolved(f: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return f();
  } catch (e) {
    if (e instanceof CheckFailed) return { unresolved: e.problems };
    throw e;
  }
}

/**
 * What the platform pipeline of `env` deploys from instance.yaml (ADR-0074 section 1), the content of
 * pipelines/inputs/platform-{env}.json:
 *   environment     `platform environment inputs` of pass 2 (environment.bicepparam's SAF_ENVIRONMENT_JSON)
 *                   without platformJobsImageDigest
 *   portal          in the portal host only (else null): `platform environment portal-inputs` of pass 2 as far as
 *                   instance.yaml holds it (portal.bicepparam's SAF_PORTAL_JSON; portalClientId is portal.clientId,
 *                   '' until it is set) without portalImageDigest, smtpPasswordSecretExists and
 *                   frontDoor.backendIpRanges
 *   subscriptionId  the subscription it deploys to
 * Left out: what comes from core at coreVersion (the saf-jobs and saf-portal digests: a coreVersion change changes
 * the pipeline's own file, its core ref) and what the run reads from Azure (whether the SMTP password secret
 * exists, the Front Door ranges, whether the environment or the portal is new, so which pass it deploys first), and
 * coreImages.registry (where the deploy copies the pinned digests from: no deployed value). Values that don't
 * resolve are listed as `unresolved` (the run would fail its validate stage with them), so fixing them changes the
 * file and starts the pipeline.
 */
export function platformInputs(inst: Instance, env: InstanceEnv): Record<string, unknown> {
  const environment = resolved(() => {
    const v = environmentInputs(inst, env.name, "", 2);
    delete v.platformJobsImageDigest;
    return v;
  });
  const portal =
    inst.portal?.hostEnvironment !== env.name
      ? null
      : resolved(() => {
          const v = portalInputs(inst, env.name, "", "auto", "absent");
          delete v.portalImageDigest;
          delete v.smtpPasswordSecretExists;
          if (isObject(v.frontDoor)) delete v.frontDoor.backendIpRanges;
          return v;
        });
  return { environment, portal, subscriptionId: env.subscriptionId };
}

export function renderPlatformInputs(inst: Instance, env: InstanceEnv): string {
  return stableJson({
    $comment: `GENERATED by \`platform generate\` from instance.yaml: do not edit. What \\platform\\platform-${env.name} deploys from instance.yaml (ADR-0074), without the image digests of core and what the run reads from Azure. A merge that changes this file or ${platformYaml(env.name)} starts the pipeline.`,
    ...platformInputs(inst, env),
  });
}

export function renderDelivery(app: AppData, inst: Instance): string {
  azureDevOps(inst);
  const envs = orderedEnvironments(app, inst);
  const defaultBranch = `refs/heads/${app.repository.defaultBranch ?? "main"}`;
  // Decommissioning (ADR-0056): said in the header only, from the block alone (never today's date,
  // so `generate --check` stays deterministic); provisioning disables the pipeline and later deletes
  // it, and the file stays with the definition after the app is deleted.
  const d = app.decommission;
  // Immediate with production only under instance.yaml decommission.allowImmediateWithProduction (amendment 2026-11-21).
  const production = envs.filter((e) => e.kind === "prod").map((e) => e.name);
  const decommission = !d
    ? []
    : d.immediate === true
      ? [
          production.length
            ? `# DECOMMISSIONED (ADR-0056): requested on ${d.requestedOn}, deleted immediately, production (${production.join(", ")}) included (decommission.allowImmediateWithProduction); the next provisioning run deletes the pipeline.`
            : `# DECOMMISSIONED (ADR-0056): requested on ${d.requestedOn}, deleted immediately (no production); the next provisioning run deletes the pipeline.`,
        ]
      : [`# DECOMMISSIONED (ADR-0056): requested on ${d.requestedOn}; the pipeline is disabled, the app is deleted on or after ${d.deleteAfter}.`];
  const lines = [
    `# GENERATED by \`platform generate\` from instance.yaml and apps/${app.slug}/app.yaml: do not edit.`,
    ...decommission,
    `# Delivery pipeline of the app \`${app.slug}\`, registered as \\apps\\delivery-${app.slug}. Everything runs in the`,
    "# core template (ADR-0006, ADR-0029): don't add steps. A push to any branch of the app repo starts a",
    "# run; platform.yaml deploy.branches decides whether the build environments deploy.",
    "name: $(Date:yyyyMMdd)$(Rev:.r)",
    "appendCommitMessageToRunName: false",
    "",
    "trigger: none",
    "pr: none",
    "",
    "# Queue-time parameters for the portal and the platform team (Runs API): a push always delivers.",
    "parameters:",
    "  - name: action",
    "    type: string",
    "    default: deliver",
    "    values: [deliver, redeploy]",
    "  - name: targetEnvironment",
    "    type: string",
    "    default: none",
    `    values: [${["none", ...envs.map((e) => e.name)].join(", ")}]`,
    "  - name: sourceRunId",
    "    type: number",
    "    default: 0",
    "",
    "resources:",
    "  repositories:",
    "    - repository: app",
    "      type: git",
    `      name: ${scalar(`${app.repository.project}/${app.repository.name}`)}`,
    `      ref: ${scalar(defaultBranch)}`,
    "      trigger:",
    "        branches:",
    "          include:",
    "            - '*'",
    ...coreRepository(inst),
    "",
    "extends:",
    "  template: pipelines/azure-devops/app-delivery.yml@core",
    "  parameters:",
    "    app:",
    `      slug: ${scalar(app.slug)}`,
    `      defaultBranch: ${scalar(defaultBranch)}`,
    "    environments:",
    ...deliveryEnvironmentsParam(app, envs, inst, "      "),
    "    action: ${{ parameters.action }}",
    "    targetEnvironment: ${{ parameters.targetEnvironment }}",
    "    sourceRunId: ${{ parameters.sourceRunId }}",
  ];
  return lines.join("\n") + "\n";
}

/** A minimal line diff (LCS), enough for files of a few dozen lines. */
export function lineDiff(oldText: string, newText: string): string {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      i++;
      j++;
    } else if (j < m && (i >= n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) out.push(`+ ${b[j++]}`);
    else out.push(`- ${a[i++]}`);
  }
  return out.join("\n");
}

/**
 * Every file `platform generate` writes, path (relative to platform-config) to content, in the order it lists them:
 * the apps' delivery.yml (by slug), the pipelines, their inputs and the AI guide. Pure: instance.yaml and the app
 * definitions in, text out; it reads nothing but the bundled schemas. The apps must have passed `platform validate
 * app --instance`. Throws CheckFailed with every problem (an app's environments that can't be ordered, an instance
 * the pipelines can't be rendered for).
 */
export function renderGenerated(inst: Instance, apps: readonly AppData[]): Map<string, string> {
  const files = new Map<string, string>();
  const problems: string[] = [];
  for (const app of [...apps].sort((x, y) => x.slug.localeCompare(y.slug))) {
    try {
      files.set(`apps/${app.slug}/delivery.yml`, renderDelivery(app, inst));
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems);
      else throw e;
    }
  }
  try {
    const envs = instanceEnvironmentsOrdered(inst);
    files.set(PROVISIONING_YAML, renderProvisioning(inst));
    files.set(VALIDATION_YAML, renderValidation(inst));
    for (const env of envs) files.set(platformYaml(env.name), renderPlatform(inst, env));
    files.set(PROVISIONING_INPUTS_JSON, renderProvisioningInputs(inst));
    for (const env of envs) files.set(platformInputsJson(env.name), renderPlatformInputs(inst, env));
    for (const f of aiGuideFiles()) files.set(f.path, f.text);
  } catch (e) {
    if (e instanceof CheckFailed) problems.push(...e.problems);
    else throw e;
  }
  if (problems.length) throw new CheckFailed(problems);
  return files;
}

export interface GenerateResult {
  files: { path: string; status: "created" | "updated" | "unchanged" | "drift" | "missing"; diff?: string }[];
  orphans: string[];
}

export function generate(configDir: string, opts: { check: boolean }): GenerateResult {
  const root = resolve(configDir);
  const instancePath = join(root, "instance.yaml");
  if (!existsSync(instancePath)) throw new CheckFailed([`${instancePath} not found: --config-dir must be a platform-config checkout.`]);
  const inst = loadInstanceFile(instancePath);
  const appsDir = join(root, "apps");
  const entries = existsSync(appsDir) ? readdirSync(appsDir, { withFileTypes: true }).sort((x, y) => x.name.localeCompare(y.name)) : [];

  const problems: string[] = [];
  const apps: AppData[] = [];
  const orphans: string[] = [];
  for (const d of entries) {
    const rel = `apps/${d.name}`;
    if (d.isSymbolicLink()) {
      problems.push(`${rel} is a symbolic link, which is not allowed.`);
      continue;
    }
    if (!d.isDirectory()) continue;
    const appYaml = join(appsDir, d.name, "app.yaml");
    const delivery = join(appsDir, d.name, "delivery.yml");
    if (!existsSync(appYaml) && !lstatExists(appYaml)) {
      if (lstatExists(delivery)) orphans.push(`${rel}/delivery.yml`);
      continue;
    }
    if (lstatSync(appYaml).isSymbolicLink()) {
      problems.push(`${rel}/app.yaml is a symbolic link, which is not allowed.`);
      continue;
    }
    try {
      apps.push(loadAppFile(appYaml, instancePath));
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems.map((p) => p.replace(appYaml, `${rel}/app.yaml`)));
      else throw e;
    }
  }
  const pipelinesDir = join(root, "pipelines");
  const inputsDir = join(root, INPUTS_DIR);
  if (lstatExists(pipelinesDir) && !lstatSync(pipelinesDir).isDirectory()) problems.push("pipelines is not a directory (a symbolic link is not allowed).");
  else if (lstatExists(inputsDir) && !lstatSync(inputsDir).isDirectory()) problems.push(`${INPUTS_DIR} is not a directory (a symbolic link is not allowed).`);
  let files = new Map<string, string>();
  try {
    files = renderGenerated(inst, apps);
  } catch (e) {
    if (e instanceof CheckFailed) problems.push(...e.problems);
    else throw e;
  }
  if (problems.length) throw new CheckFailed(problems);
  const rendered = [...files].map(([rel, text]) => ({ rel, abs: join(root, rel), text }));
  // A platform pipeline file, or its inputs, of an environment that is no longer in instance.yaml: reported, never
  // deleted (its pipeline and the environment's resources stay until a person removes them).
  const wanted = new Set(inst.environments.flatMap((e) => [platformYaml(e.name), platformInputsJson(e.name)]));
  for (const [dir, rel, re] of [
    [pipelinesDir, "pipelines", PLATFORM_YAML_RE],
    [inputsDir, INPUTS_DIR, PLATFORM_INPUTS_RE],
  ] as const) {
    if (!lstatExists(dir) || !lstatSync(dir).isDirectory()) continue;
    for (const name of readdirSync(dir).sort()) {
      if (re.test(name) && !wanted.has(`${rel}/${name}`)) orphans.push(`${rel}/${name}`);
    }
  }

  // Symbolic links first, so nothing is written when one is found: a file, or a folder on the way to one (the AI
  // guide's .agents, .claude, ...), which would write outside platform-config.
  for (const r of rendered) {
    if (lstatExists(r.abs) && lstatSync(r.abs).isSymbolicLink()) throw new CheckFailed([`${r.rel} is a symbolic link, which is not allowed.`]);
    const link = linkedParent(root, r.abs);
    if (link) throw new CheckFailed([`${link} is a symbolic link, which is not allowed.`]);
  }

  const out: GenerateResult["files"] = [];
  for (const r of rendered) {
    const exists = lstatExists(r.abs);
    const current = exists ? readFileSync(r.abs, "utf8") : undefined;
    if (current === r.text) {
      out.push({ path: r.rel, status: "unchanged" });
      continue;
    }
    if (opts.check) {
      out.push({ path: r.rel, status: current === undefined ? "missing" : "drift", ...(current !== undefined ? { diff: lineDiff(current, r.text) } : {}) });
      continue;
    }
    mkdirSync(dirname(r.abs), { recursive: true });
    writeFileSync(r.abs, r.text, "utf8");
    out.push({ path: r.rel, status: current === undefined ? "created" : "updated" });
  }
  return { files: out, orphans };
}

/** The first folder between root and file (exclusive) that is a symbolic link, relative to root, or undefined. */
function linkedParent(root: string, file: string): string | undefined {
  const parts = relative(root, dirname(file)).split(sep).filter(Boolean);
  for (let i = 1; i <= parts.length; i++) {
    const p = join(root, ...parts.slice(0, i));
    if (lstatExists(p) && lstatSync(p).isSymbolicLink()) return parts.slice(0, i).join("/");
  }
  return undefined;
}

function lstatExists(p: string): boolean {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

export function formatGenerate(r: GenerateResult, check: boolean): { text: string; drift: boolean } {
  const lines: string[] = [];
  let drift = false;
  for (const f of r.files) {
    if (f.status === "drift" || f.status === "missing") {
      drift = true;
      lines.push(`DRIFT    ${f.path}${f.status === "missing" ? " (missing)" : ""}`);
      if (f.diff) lines.push(...f.diff.split("\n").map((l) => `  ${l}`));
    } else lines.push(`${f.status.padEnd(10)}${f.path}`);
  }
  for (const o of r.orphans) {
    lines.push(o.startsWith("pipelines/") ? `WARNING  ${o} names no environment of instance.yaml (not generated, not deleted)` : `WARNING  ${o} has no app.yaml next to it (not generated, not deleted)`);
  }
  if (!r.files.some((f) => f.path.startsWith("apps/"))) lines.push("No apps/*/app.yaml found.");
  const guide = new Set<string>(AI_GUIDE_FILES);
  const missing = (f: GenerateResult["files"][number]): boolean => f.status === "missing";
  const upgrade = 'Fix: in a clone of platform-config, run "platform generate --config-dir ." with the CLI of coreVersion and commit every file it writes in a pull request (core: docs/runbooks/upgrade-instance-core.md, step 3).';
  const newFiles: string[] = [];
  if (check && r.files.some((f) => missing(f) && f.path.startsWith(`${INPUTS_DIR}/`))) {
    newFiles.push(
      `The pipelines' inputs (${PROVISIONING_INPUTS_JSON} and ${INPUTS_DIR}/platform-<env>.json; ADR-0074) are missing: platform generate writes them from this core version on, and the generated pipelines start when they change instead of on every change of instance.yaml.`,
    );
  }
  if (check && r.files.some((f) => missing(f) && guide.has(f.path))) {
    newFiles.push(
      "The AI guide (AGENTS.md, CLAUDE.md, the skill onboard-instance in .agents/skills/ and .claude/skills/, .github/copilot-instructions.md and .gemini/settings.json; ADR-0072) is missing: platform generate writes it from this core version on.",
    );
  }
  if (newFiles.length) lines.push(...newFiles, upgrade);
  else if (check && drift) lines.push('Fix: run "platform generate --config-dir ." with the CLI of coreVersion and commit every file it writes.');
  return { text: lines.join("\n") + "\n", drift };
}
