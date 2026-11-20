import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { reservationOf } from "../capacity.js";
import { CheckFailed } from "../pipeline/common.js";
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
 * hostEnvironment; ADR-0043). And the instance's AI guide (ADR-0072): AGENTS.md, CLAUDE.md, the skill
 * onboard-instance in .agents/skills/ and .claude/skills/, .github/copilot-instructions.md and .gemini/settings.json
 * (src/onboarding/agent-files.ts; the same for every instance of a core version).
 * --check renders in memory and reports drift instead of writing.
 */

/** Path of the provisioning pipeline in platform-config. */
export const PROVISIONING_YAML = "pipelines/provisioning.yml";

/** Path of the pull request validation pipeline (\platform\validation) in platform-config. */
export const VALIDATION_YAML = "pipelines/validation.yml";

/** Path of an environment's platform pipeline (\platform\platform-{env}) in platform-config. */
export const platformYaml = (env: string): string => `pipelines/platform-${env}.yml`;
const PLATFORM_YAML_RE = /^platform-([a-z][a-z0-9]{1,7})\.yml$/;

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
    "# the core template (ADR-0032): don't add steps.",
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
    "      - instance.yaml",
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
 * approval and only when the plan finds a change. It runs on a merge that changes instance.yaml
 * (a core upgrade bumps coreVersion there) and by hand; no queue-time parameters.
 */
export function renderPlatform(inst: Instance, env: InstanceEnv): string {
  azureDevOps(inst);
  const branch = scalar(`refs/heads/${platformConfigDefaultBranch(inst)}`);
  const lines = [
    "# GENERATED by `platform generate` from instance.yaml: do not edit.",
    `# Platform pipeline of the environment \`${env.name}\`, registered as \\platform\\platform-${env.name}. Everything runs`,
    "# in the core template (ADR-0043): don't add steps.",
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
    "      - instance.yaml",
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

export function renderDelivery(app: AppData, inst: Instance): string {
  azureDevOps(inst);
  const envs = orderedEnvironments(app, inst);
  const defaultBranch = `refs/heads/${app.repository.defaultBranch ?? "main"}`;
  // Decommissioning (ADR-0056): said in the header only, from the block alone (never today's date,
  // so `generate --check` stays deterministic); provisioning disables the pipeline and later deletes
  // it, and the file stays with the definition after the app is deleted.
  const d = app.decommission;
  const decommission = !d
    ? []
    : d.immediate === true
      ? [`# DECOMMISSIONED (ADR-0056): requested on ${d.requestedOn}, deleted immediately (no production); the next provisioning run deletes the pipeline.`]
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
  const rendered: { rel: string; abs: string; text: string }[] = [];
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
      const app = loadAppFile(appYaml, instancePath);
      rendered.push({ rel: `${rel}/delivery.yml`, abs: delivery, text: renderDelivery(app, inst) });
    } catch (e) {
      if (e instanceof CheckFailed) problems.push(...e.problems.map((p) => p.replace(appYaml, `${rel}/app.yaml`)));
      else throw e;
    }
  }
  const pipelinesDir = join(root, "pipelines");
  if (lstatExists(pipelinesDir) && !lstatSync(pipelinesDir).isDirectory()) problems.push("pipelines is not a directory (a symbolic link is not allowed).");
  try {
    rendered.push({ rel: PROVISIONING_YAML, abs: join(root, PROVISIONING_YAML), text: renderProvisioning(inst) });
    rendered.push({ rel: VALIDATION_YAML, abs: join(root, VALIDATION_YAML), text: renderValidation(inst) });
    for (const env of instanceEnvironmentsOrdered(inst)) rendered.push({ rel: platformYaml(env.name), abs: join(root, platformYaml(env.name)), text: renderPlatform(inst, env) });
    for (const f of aiGuideFiles()) rendered.push({ rel: f.path, abs: join(root, f.path), text: f.text });
  } catch (e) {
    if (e instanceof CheckFailed) problems.push(...e.problems);
    else throw e;
  }
  if (problems.length) throw new CheckFailed(problems);
  // A platform pipeline file of an environment that is no longer in instance.yaml: reported, never
  // deleted (its pipeline and the environment's resources stay until a person removes them).
  if (lstatExists(pipelinesDir) && lstatSync(pipelinesDir).isDirectory()) {
    const wanted = new Set(inst.environments.map((e) => platformYaml(e.name)));
    for (const name of readdirSync(pipelinesDir).sort()) {
      if (PLATFORM_YAML_RE.test(name) && !wanted.has(`pipelines/${name}`)) orphans.push(`pipelines/${name}`);
    }
  }

  // Symbolic links first, so nothing is written when one is found: a file, or a folder on the way to one (the AI
  // guide's .agents, .claude, ...), which would write outside platform-config.
  for (const r of rendered) {
    if (lstatExists(r.abs) && lstatSync(r.abs).isSymbolicLink()) throw new CheckFailed([`${r.rel} is a symbolic link, which is not allowed.`]);
    const link = linkedParent(root, r.abs);
    if (link) throw new CheckFailed([`${link} is a symbolic link, which is not allowed.`]);
  }

  const files: GenerateResult["files"] = [];
  for (const r of rendered) {
    const exists = lstatExists(r.abs);
    const current = exists ? readFileSync(r.abs, "utf8") : undefined;
    if (current === r.text) {
      files.push({ path: r.rel, status: "unchanged" });
      continue;
    }
    if (opts.check) {
      files.push({ path: r.rel, status: current === undefined ? "missing" : "drift", ...(current !== undefined ? { diff: lineDiff(current, r.text) } : {}) });
      continue;
    }
    mkdirSync(dirname(r.abs), { recursive: true });
    writeFileSync(r.abs, r.text, "utf8");
    files.push({ path: r.rel, status: current === undefined ? "created" : "updated" });
  }
  return { files, orphans };
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
  if (check && r.files.some((f) => f.status === "missing" && guide.has(f.path))) {
    lines.push(
      "The AI guide (AGENTS.md, CLAUDE.md, the skill onboard-instance in .agents/skills/ and .claude/skills/, .github/copilot-instructions.md and .gemini/settings.json; ADR-0072) is missing: platform generate writes it from this core version on.",
      'Fix: in a clone of platform-config, run "platform generate --config-dir ." with the CLI of coreVersion and commit every file it writes in a pull request (core: docs/runbooks/upgrade-instance-core.md, step 3).',
    );
  } else if (check && drift) lines.push('Fix: run "platform generate" and commit the result.');
  return { text: lines.join("\n") + "\n", drift };
}
