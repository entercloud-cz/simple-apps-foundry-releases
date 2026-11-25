#!/usr/bin/env node
import { existsSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { UsageError } from "./allowlist.js";
import { applyPlan, loadLayout, planSync } from "./agentfiles.js";
import { catalogueMarkdown, formatExplanation } from "./report/explain.js";
import { formatJson } from "./report/json.js";
import { formatSarif } from "./report/sarif.js";
import { formatText } from "./report/text.js";
import { DEFINITION_CHECK_IDS, INSTANCE_CHECK_IDS, PIPELINE_CHECK_IDS, PROVISIONING_FAILURE_IDS } from "./explanations.js";
import { RULES } from "./rules.js";
import { defaultOptions, parseGroups, runChecks, toolVersion } from "./run.js";
import { formatValidateText, validateFile } from "./validate.js";
import { formatAppText, validateApp } from "./validate-app.js";
import { formatArchiveText, validateArchive } from "./validate-archive.js";
import type { SchemaKind } from "./schema.js";
import { neutralize } from "./neutralize.js";
import { cmdPipeline } from "./pipeline/index.js";
import { cmdEnvironment } from "./environment/index.js";
import { cmdInstance } from "./instance/index.js";
import { cmdGenerate, cmdProvisioning, cmdUpgrades } from "./provisioning/index.js";
import { cmdAdo } from "./ado/index.js";
import { cmdRepo } from "./repo/index.js";
import { cmdNetwork } from "./network/index.js";
import { cmdDeploy, cmdLogin, cmdLogout, PORTAL_HELP } from "./portal/index.js";
import { cmdPreview, PREVIEW_HELP } from "./preview/index.js";

/**
 * Everything the CLI prints may contain text from the checked repo, docker or other tools, so it
 * is neutralised against Azure DevOps logging commands (see neutralize.ts).
 */
function out(s: string): void {
  process.stdout.write(neutralize(s));
}

const HELP = `platform ${toolVersion()}: checks and helpers for SAF app repos

Usage
  platform check [dir] [options]            run all checks (default dir: .)
  platform validate manifest <file>         validate a platform.yaml (app runtime settings)
  platform validate instance <file> [--base <git-ref>]
                                            validate an instance.yaml (with --base: the network of an
                                            environment with apps doesn't change)
  platform validate app <file> [--instance <instance.yaml>] [--base <git-ref>]
                                            validate an app definition (apps/<slug>/app.yaml)
  platform validate archive <platform-config dir> [--base <git-ref>]
                                            validate the archive of deleted apps
                                            (apps-deleted/<slug>/<requestedOn>/app.yaml; with --base:
                                            added only by a move, never changed or removed
                                            except by an unchanged move back)
  platform sync-agent-files [dir] [--check] regenerate .claude/skills/ and agent stub files
  platform rules                            list check IDs
  platform rules --explain <id|all> [--lang en|cs] [--format text|markdown]
                                            explain a check in plain words, with a prompt for your AI agent;
                                            also a provisioning failure code PE001... (ADR-0064)
  platform pipeline <command> ...           delivery pipeline helpers ("platform pipeline help")
  platform generate [--config-dir <dir>] [--check]
                                            render apps/<slug>/delivery.yml, pipelines/provisioning.yml,
                                            pipelines/validation.yml, pipelines/platform-<env>.yml, their
                                            inputs pipelines/inputs/*.json (what starts them) and the AI
                                            guide (AGENTS.md, the skill onboard-instance) of a
                                            platform-config repo
  platform repo render --instance <f> --app <f> --out <dir>
                                            render the starter of an app repository ("platform repo help")
  platform provisioning <command> ...       provisioning pipeline helpers: inputs, validate-run, apps,
                                            state, compare, rotation-due, easyauth-secret, entra-removals,
                                            entra-effect, entra-reconcile, dbinit
                                            ("platform provisioning help")
  platform upgrades check [--core-dir <dir>] core CI: infra/app/upgrades.yaml valid, a note for every
                                            unit of infra/app/units.json that is since: unreleased
  platform environment <command> ...        platform pipeline helpers: inputs, validate-run,
                                            roles-check, compare ("platform environment help")
  platform instance inputs|sync|facts ...   onboarding an instance (ADR-0066): the JSON of the templates a
                                            person runs, instance.yaml from the instance's state
                                            ("platform instance help"; infra/platform/instance/instance.sh)
  platform instance plan|status ...         the onboarding plan, every step up front, and where an instance
                                            stands (ADR-0072; instance.sh plan|status)
  platform ado plan|apply ...               Azure DevOps objects of an app ("platform ado help")
  platform ado bootstrap plan|apply ...     the platform's own Azure DevOps objects: --phase projects|core|
                                            config|connections|pipeline|grants|policies ("platform ado help")
  platform network request --env <name> [--config-dir <dir>] [--mode externalHybrid] [--lang en|cs]
                                            the network team's text for connecting an environment to
                                            the hub: spoke VNet, peering, route table, DNS, standing
                                            egress baseline ("platform network help")
  ${PORTAL_HELP}
  ${PREVIEW_HELP}

check options
  --format text|sarif|json   output format (default text)
  --output <file>            write the report to a file (the text summary still goes to stdout)
  --skip-runtime             skip the docker smoke test (local use only; not allowed with --strict)
  --strict                   CI mode: skipped checks (no docker, missing required tool) fail the run
  --only <groups>            comma list: manifest,dockerfile,secrets,forbidden-files,docs,agent-files,runtime
  --base <ref>               git base ref for the docs freshness warning (env: PLATFORM_CHECK_BASE_REF)
  --image <ref>              smoke-test an already built image instead of building one
  --allowlist <file>         platform-owned secret allowlist, must be OUTSIDE the repo (env: PLATFORM_SECRETS_ALLOWLIST)
  --agent-manifest <file>    template manifest describing the agent-file layout (env: PLATFORM_AGENT_FILES_MANIFEST)
  --gitleaks auto|off|require  run gitleaks too when installed (default auto)
  --max-file-mb <n>          forbidden-file size limit (default 5)
  --smoke-timeout <sec>      wait for /healthz this long (default 60)
  --no-ai-prompts            hide the "AI prompt" lines in the text output

Exit codes: 0 ok, 1 findings (errors), 2 usage or internal error.
`;

function fail(message: string): never {
  throw new UsageError(message);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    out(HELP);
    return command ? 0 : 2;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    out(toolVersion() + "\n");
    return 0;
  }

  switch (command) {
    case "check":
      return cmdCheck(rest);
    case "validate":
      return cmdValidate(rest);
    case "sync-agent-files":
      return cmdSync(rest);
    case "pipeline":
      return cmdPipeline(rest);
    case "generate":
      return cmdGenerate(rest);
    case "provisioning":
      return cmdProvisioning(rest);
    case "environment":
      return cmdEnvironment(rest);
    case "instance":
      return cmdInstance(rest);
    case "upgrades":
      return cmdUpgrades(rest);
    case "ado":
      return cmdAdo(rest);
    case "repo":
      return cmdRepo(rest);
    case "network":
      return cmdNetwork(rest);
    case "rules":
      return cmdRules(rest);
    case "login":
      return cmdLogin(rest);
    case "logout":
      return cmdLogout(rest);
    case "deploy":
      return cmdDeploy(rest);
    case "preview":
      return cmdPreview(rest);
    default:
      return fail(`Unknown command "${command}". Run "platform help".`);
  }
}

/** `platform rules`: the check IDs, or one or all checks explained (the failure catalogue, US09.05). */
function cmdRules(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { explain: { type: "string" }, lang: { type: "string" }, format: { type: "string" } },
  });
  if (positionals.length > 0) fail("Usage: platform rules [--explain <id|all> [--lang en|cs] [--format text|markdown]]");
  if (values.explain === undefined) {
    if (values.lang !== undefined || values.format !== undefined) fail("--lang and --format apply to --explain only.");
    for (const r of RULES) out(`${r.id}  ${r.severity.padEnd(7)} ${r.group.padEnd(16)} ${r.summary}\n`);
    return 0;
  }
  const lang = values.lang ?? "en";
  if (lang !== "en" && lang !== "cs") fail("--lang must be en or cs.");
  const format = values.format ?? "text";
  if (format !== "text" && format !== "markdown") fail("--format must be text or markdown.");
  if (values.explain === "all") {
    out(format === "markdown" ? catalogueMarkdown(lang) : [...RULES.map((r) => r.id), ...PIPELINE_CHECK_IDS, ...DEFINITION_CHECK_IDS, ...INSTANCE_CHECK_IDS, ...PROVISIONING_FAILURE_IDS].map((id) => formatExplanation(id, lang)).join("\n"));
    return 0;
  }
  const id = /^p[ce]\d+$/i.test(values.explain) ? values.explain.toUpperCase() : values.explain;
  const text = formatExplanation(id, lang);
  if (text === undefined) fail(`Unknown check "${values.explain}". Run "platform rules" for the IDs.`);
  out(text);
  return 0;
}

function dirArg(positionals: string[]): string {
  const dir = resolve(positionals[0] ?? ".");
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`Directory not found: ${positionals[0] ?? "."}`);
  return dir;
}

async function cmdCheck(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      format: { type: "string", default: "text" },
      output: { type: "string" },
      "skip-runtime": { type: "boolean", default: false },
      strict: { type: "boolean", default: false },
      only: { type: "string" },
      base: { type: "string" },
      image: { type: "string" },
      allowlist: { type: "string" },
      "agent-manifest": { type: "string" },
      gitleaks: { type: "string", default: "auto" },
      "max-file-mb": { type: "string", default: "5" },
      "smoke-timeout": { type: "string", default: "60" },
      "no-ai-prompts": { type: "boolean", default: false },
    },
  });
  if (positionals.length > 1) fail("platform check takes at most one directory.");
  const format = values.format as string;
  if (!["text", "json", "sarif"].includes(format)) fail(`--format must be text, json or sarif (got "${format}").`);
  if (!["auto", "off", "require"].includes(values.gitleaks as string)) fail("--gitleaks must be auto, off or require.");
  const maxMb = Number(values["max-file-mb"]);
  const timeout = Number(values["smoke-timeout"]);
  if (!Number.isFinite(maxMb) || maxMb <= 0) fail("--max-file-mb must be a positive number.");
  if (!Number.isFinite(timeout) || timeout <= 0) fail("--smoke-timeout must be a positive number of seconds.");

  const opts = {
    ...defaultOptions(dirArg(positionals)),
    skipRuntime: values["skip-runtime"] as boolean,
    strict: values.strict as boolean,
    gitleaks: values.gitleaks as "auto" | "off" | "require",
    maxFileMb: maxMb,
    smokeTimeoutSec: timeout,
    ...(values.only ? { only: parseGroups(values.only) } : {}),
    ...(values.base ? { baseRef: values.base } : {}),
    ...(values.image ? { image: values.image } : {}),
    ...(values.allowlist ? { allowlistPath: values.allowlist } : {}),
    ...(values["agent-manifest"] ? { agentManifestPath: resolve(values["agent-manifest"]) } : {}),
  };
  const report = await runChecks(opts);

  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  const text = formatText(report, { color: color && !values.output, aiPrompts: !values["no-ai-prompts"] });
  const rendered = format === "json" ? formatJson(report) : format === "sarif" ? JSON.stringify(formatSarif(report), null, 2) + "\n" : text;

  if (values.output) {
    writeFileSync(values.output, neutralize(format === "text" ? formatText(report, { color: false, aiPrompts: !values["no-ai-prompts"] }) : rendered));
    out(text);
    out(`Report (${format}) written to ${values.output}\n`);
  } else {
    out(rendered);
  }
  return report.exitCode;
}

function cmdValidate(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { format: { type: "string", default: "text" }, instance: { type: "string" }, base: { type: "string" } },
  });
  const [kind, file] = positionals;
  if ((kind !== "manifest" && kind !== "instance" && kind !== "app" && kind !== "archive") || !file || positionals.length > 2) {
    fail(
      "Usage: platform validate manifest <file>, platform validate instance <file> [--base <git-ref>], platform validate app <app.yaml> [--instance <instance.yaml>] [--base <git-ref>], or platform validate archive <platform-config dir> [--base <git-ref>]",
    );
  }
  if (!["text", "json"].includes(values.format as string)) fail("--format must be text or json.");
  if (kind === "archive") {
    if (!existsSync(file) || !statSync(file).isDirectory()) fail(`Directory not found: ${file}`);
    if (values.instance !== undefined) fail("--instance applies to platform validate app only.");
    const r = validateArchive(file, values.base !== undefined ? { base: values.base } : {});
    out(values.format === "json" ? JSON.stringify(r, null, 2) + "\n" : formatArchiveText(r));
    return r.ok ? 0 : 1;
  }
  if (!existsSync(file)) fail(`File not found: ${file}`);
  if (kind === "app") {
    if (values.instance !== undefined && !existsSync(values.instance)) fail(`File not found: ${values.instance}`);
    const r = validateApp(file, {
      ...(values.instance !== undefined ? { instance: values.instance } : {}),
      ...(values.base !== undefined ? { base: values.base } : {}),
    });
    out(values.format === "json" ? JSON.stringify(r, null, 2) + "\n" : formatAppText(r));
    return r.ok ? 0 : 1;
  }
  if (values.instance !== undefined) fail("--instance applies to platform validate app only.");
  if (values.base !== undefined && kind !== "instance") fail("--base applies to platform validate app, instance and archive only.");
  const result = validateFile(kind as SchemaKind, file, values.base !== undefined ? { base: values.base } : {});
  out(values.format === "json" ? JSON.stringify(result, null, 2) + "\n" : formatValidateText(result));
  return result.ok ? 0 : 1;
}

function cmdSync(args: string[]): number {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      check: { type: "boolean", default: false },
      manifest: { type: "string" },
    },
  });
  if (positionals.length > 1) fail("platform sync-agent-files takes at most one directory.");
  const dir = dirArg(positionals);
  const manifest = (values.manifest as string | undefined) ?? process.env.PLATFORM_AGENT_FILES_MANIFEST;
  const layout = loadLayout(manifest ? resolve(manifest) : undefined);
  const plan = planSync(dir, layout);
  const out = { write: (s: string): void => void process.stdout.write(neutralize(s)) };

  for (const p of plan.problems) out.write(`PROBLEM  ${p.path} ${p.message}\n`);

  if (values.check) {
    for (const a of plan.actions) out.write(`DRIFT    ${a.path}: ${a.detail}${a.kind === "delete" ? " (would delete)" : ""}\n`);
    if (plan.actions.length === 0 && plan.problems.length === 0) {
      out.write("OK  agent files are in sync.\n");
      return 0;
    }
    out.write('Fix: run "platform sync-agent-files" (without --check), review the changes and commit them.\n');
    return 1;
  }

  applyPlan(dir, plan);
  for (const a of plan.actions) {
    const verb = a.kind === "delete" ? "deleted" : a.cause === "mirror-differs" || a.cause === "stub-fix" ? "updated" : "created";
    out.write(`${verb.padEnd(8)} ${a.path}\n`);
  }
  if (plan.actions.length === 0) out.write("Nothing to do: agent files are already in sync.\n");
  const mirrors = layout.skillMirrors.join(", ");
  out.write(`Layout: ${layout.source}; skills ${layout.skillsSource} -> ${mirrors}.\n`);
  return plan.problems.length ? 1 : 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    if (err instanceof UsageError || (err as { code?: string }).code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" || (err as { code?: string }).code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
      process.stderr.write(neutralize(`platform: ${msg}\nRun "platform help" for usage.\n`));
    } else {
      process.stderr.write(neutralize(`platform: internal error: ${err instanceof Error ? (err.stack ?? msg) : msg}\n`));
    }
    process.exitCode = 2;
  },
);
