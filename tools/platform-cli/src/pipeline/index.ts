import { parseArgs } from "node:util";
import type { ParseArgsConfig } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, writeJson } from "./common.js";
import { classifyDeployError } from "./deploy-error.js";
import { formatPortalTarget, formatRunSummary, instanceEnv, portalTarget, validateRun } from "./instance.js";
import { deployBranch, promoteBranch, releaseInputs } from "./manifest.js";
import { ociDigest } from "./oci.js";
import { releaseManifest, releaseParams } from "./release.js";
import { enforcementProblems, formatVerdict, scanGate, trivyDbAge } from "./scan.js";
import { retentionLease, verifySourceRun } from "./source.js";

export const PIPELINE_HELP = `platform pipeline <command>: helpers for the platform's delivery pipeline templates

  validate-run --instance <instance.yaml>
      env SAF_PARAMS_JSON, RESOURCES_REPOSITORIES_CORE_REF; checks the run parameters
  release-inputs --manifest <platform.yaml> --app-dir <dir> --slug <slug> --environments <json>
                 --instance <instance.yaml> --output <file>
  deploy-branch --manifest <platform.yaml> [--set-output <varName>]
      env RESOURCES_REPOSITORIES_APP_REF; prints true|false
  promote-branch --default-branch <ref> [--set-output <varName>]
      env RESOURCES_REPOSITORIES_APP_REF; prints true iff it equals the default branch
  oci-digest <layout-dir>                 prints the image manifest digest
  trivy-db-age --metadata <metadata.json> --max-age-hours <n>
  scan-gate --trivy <trivy.json> --instance <instance.yaml> --output <verdict.json> [--enforce]
  release-manifest --digest <d> --release-inputs <file> --verdict <file> --trivy-db-metadata <file>
                   --core-version <v> --output <file>
      env RESOURCES_REPOSITORIES_APP_VERSION, RESOURCES_REPOSITORIES_APP_REF, BUILD_BUILDID
  instance-env --instance <instance.yaml> --env <name> --output <file>
  portal-target --instance <instance.yaml> --output <file>
      {clientId, apiBaseUrl} of the portal API ('' when not set) for the deploy report step
  release-params --record <record.json> --manifest <release-manifest.json> --env <env.json> --output <release.json>
  classify-deploy-error --log <file>      prints retry|fail
  verify-source-run --run-id <n> --target <env> --promote-from <env|''> --default-branch <ref>
                    --target-kind prod|nonprod --output <source.json>
  retention-lease --run-id <n> --env <name> --days <n> --slug <slug> [--owner-prefix <p>]
      env SYSTEM_ACCESSTOKEN, SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECTID, SYSTEM_DEFINITIONID
      (Azure DevOps REST API 7.1, the token only in the Authorization header)

Exit codes: 0 ok, 1 check failed (one stderr line per problem), 2 usage or internal error.
`;

/** `problems`: printed after the outputs are written; the command then exits 1. */
type Out = { stdout: string; json?: unknown; problems?: string[] };
type Values = Record<string, string | boolean | undefined>;

interface CommandSpec {
  options: NonNullable<ParseArgsConfig["options"]>;
  /** Supports --set-output: stdout is "true\n" or "false\n" and becomes an output variable. */
  setOutput?: boolean;
  /** Required options that may be given as an empty string. */
  allowEmpty?: string[];
  required: string[];
  positionals?: number;
  run: (v: Values, positionals: string[], env: NodeJS.ProcessEnv) => Out | Promise<Out>;
}

const str = { type: "string" } as const;

const COMMANDS: Record<string, CommandSpec> = {
  "validate-run": {
    options: { instance: str },
    required: ["instance"],
    run: (v, _p, env) => ({ stdout: formatRunSummary(validateRun({ instance: v.instance as string }, env)) }),
  },
  "release-inputs": {
    options: { manifest: str, "app-dir": str, slug: str, environments: str, instance: str, output: str },
    required: ["manifest", "app-dir", "slug", "environments", "instance", "output"],
    run: (v) => {
      const r = releaseInputs({
        manifest: v.manifest as string,
        appDir: v["app-dir"] as string,
        slug: v.slug as string,
        environments: v.environments as string,
        instance: v.instance as string,
      });
      const warnings = r.warnings.map((w) => `WARNING  ${w}\n`).join("");
      return { stdout: `${warnings}OK  release inputs for ${r.slug}: environments ${Object.keys(r.environments).join(", ")}; deploy branches ${r.deployBranches.join(" ")}\n`, json: r };
    },
  },
  "deploy-branch": {
    options: { manifest: str, "set-output": str },
    required: ["manifest"],
    setOutput: true,
    run: (v, _p, env) => ({ stdout: deployBranch({ manifest: v.manifest as string }, env) ? "true\n" : "false\n" }),
  },
  "promote-branch": {
    options: { "default-branch": str, "set-output": str },
    required: ["default-branch"],
    setOutput: true,
    run: (v, _p, env) => ({ stdout: promoteBranch({ defaultBranch: v["default-branch"] as string }, env) ? "true\n" : "false\n" }),
  },
  "oci-digest": {
    options: {},
    required: [],
    positionals: 1,
    run: (_v, p) => ({ stdout: `${ociDigest(p[0] as string)}\n` }),
  },
  "trivy-db-age": {
    options: { metadata: str, "max-age-hours": str },
    required: ["metadata", "max-age-hours"],
    run: (v) => {
      const raw = v["max-age-hours"] as string;
      const hours = Number(raw);
      if (!/^\d+(\.\d+)?$/.test(raw) || !(hours > 0)) throw new UsageError("--max-age-hours must be a positive number.");
      return { stdout: `${trivyDbAge({ metadata: v.metadata as string, maxAgeHours: hours })}\n` };
    },
  },
  "scan-gate": {
    options: { trivy: str, instance: str, output: str, enforce: { type: "boolean" } },
    required: ["trivy", "instance", "output"],
    run: (v) => {
      const verdict = scanGate({ trivy: v.trivy as string, instance: v.instance as string });
      return { stdout: formatVerdict(verdict), json: verdict, ...(v.enforce ? { problems: enforcementProblems(verdict) } : {}) };
    },
  },
  "release-manifest": {
    options: { digest: str, "release-inputs": str, verdict: str, "trivy-db-metadata": str, "core-version": str, output: str },
    required: ["digest", "release-inputs", "verdict", "trivy-db-metadata", "core-version", "output"],
    run: (v, _p, env) => {
      const m = releaseManifest(
        {
          digest: v.digest as string,
          releaseInputs: v["release-inputs"] as string,
          verdict: v.verdict as string,
          trivyDbMetadata: v["trivy-db-metadata"] as string,
          coreVersion: v["core-version"] as string,
        },
        env,
      );
      return { stdout: `OK  release manifest: ${m.slug} ${m.commit} ${m.digest} (run ${m.runId})\n`, json: m };
    },
  },
  "instance-env": {
    options: { instance: str, env: str, output: str },
    required: ["instance", "env", "output"],
    run: (v) => {
      const e = instanceEnv({ instance: v.instance as string, env: v.env as string });
      return { stdout: `OK  environment ${e.name} (${e.kind}), region ${e.region}\n`, json: e };
    },
  },
  "portal-target": {
    options: { instance: str, output: str },
    required: ["instance", "output"],
    run: (v) => {
      const t = portalTarget({ instance: v.instance as string });
      return { stdout: formatPortalTarget(t), json: t };
    },
  },
  "release-params": {
    options: { record: str, manifest: str, env: str, output: str },
    required: ["record", "manifest", "env", "output"],
    run: (v) => {
      const p = releaseParams({ record: v.record as string, manifest: v.manifest as string, env: v.env as string });
      return { stdout: `OK  release parameters: ${p.slug} in ${p.environmentName}, generation ${p.generation}, image ${p.image.digest}\n`, json: p };
    },
  },
  "verify-source-run": {
    options: { "run-id": str, target: str, "promote-from": str, "default-branch": str, "target-kind": str, output: str },
    required: ["run-id", "target", "promote-from", "default-branch", "target-kind", "output"],
    allowEmpty: ["promote-from"],
    run: async (v, _p, env) => {
      const s = await verifySourceRun(
        {
          runId: v["run-id"] as string,
          target: v.target as string,
          promoteFrom: v["promote-from"] as string,
          defaultBranch: v["default-branch"] as string,
          targetKind: v["target-kind"] as string,
        },
        env,
      );
      return { stdout: `OK  run ${s.runId} (${s.commit}, ${s.appRef}) may be deployed to ${v.target as string}: ${s.path}\n`, json: s };
    },
  },
  "retention-lease": {
    options: { "run-id": str, env: str, days: str, slug: str, "owner-prefix": str },
    required: ["run-id", "env", "days", "slug"],
    run: async (v, _p, env) => {
      const l = await retentionLease(
        {
          runId: v["run-id"] as string,
          env: v.env as string,
          days: v.days as string,
          slug: v.slug as string,
          ownerPrefix: (v["owner-prefix"] as string | undefined) ?? "saf-deployed",
        },
        env,
      );
      return { stdout: `OK  retention lease ${l.leaseId} ${l.action} for run ${l.runId} (${l.ownerId}), valid until ${l.validUntil ?? "unknown"}\n` };
    },
  },
  "classify-deploy-error": {
    options: { log: str },
    required: ["log"],
    run: (v) => ({ stdout: `${classifyDeployError({ log: v.log as string })}\n` }),
  },
};

function oneLine(s: string): string {
  return s.replace(/\s*[\r\n]+\s*/g, " ");
}

/**
 * Runs `platform pipeline <command>`. Everything printed is neutralised (no Azure DevOps logging
 * commands), except the single output-variable line of `deploy-branch` / `promote-branch --set-output`.
 */
export async function cmdPipeline(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...args] = argv;
  const err = (cmd: string, msg: string): void => {
    process.stderr.write(neutralize(`platform pipeline ${cmd}: ${oneLine(msg)}`) + "\n");
  };
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(PIPELINE_HELP);
    return command ? 0 : 2;
  }
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) {
    err(neutralize(command.slice(0, 60)), `unknown command. Commands: ${Object.keys(COMMANDS).join(", ")}.`);
    return 2;
  }
  try {
    let parsed;
    try {
      parsed = parseArgs({ args, options: spec.options, allowPositionals: Boolean(spec.positionals), strict: true });
    } catch (e) {
      throw new UsageError((e as Error).message);
    }
    const values = parsed.values as Values;
    const missing = spec.required.filter((k) => typeof values[k] !== "string" || (values[k] === "" && !spec.allowEmpty?.includes(k)));
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    if ((spec.positionals ?? 0) !== parsed.positionals.length) {
      throw new UsageError(spec.positionals ? `expects exactly ${spec.positionals} argument(s).` : "takes no positional arguments.");
    }
    const setOutput = spec.setOutput ? values["set-output"] : undefined;
    if (typeof setOutput === "string" && !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(setOutput)) {
      throw new UsageError("--set-output must be a variable name (letters, digits, underscores).");
    }
    const out = await spec.run(values, parsed.positionals, env);
    if (out.json !== undefined) writeJson(values.output as string, out.json);
    process.stdout.write(neutralize(out.stdout));
    if (typeof setOutput === "string") {
      // The only logging command the CLI emits: name validated above, value is true|false.
      const value = out.stdout.trim() === "true" ? "true" : "false";
      process.stdout.write(`##vso[task.setvariable variable=${setOutput};isoutput=true]${value}\n`);
    }
    if (out.problems?.length) {
      for (const p of out.problems) err(command, p);
      return 1;
    }
    return 0;
  } catch (e) {
    if (e instanceof CheckFailed) {
      for (const p of e.problems) err(command, p);
      return 1;
    }
    if (e instanceof UsageError) {
      err(command, `${e.message} Run "platform pipeline help" for usage.`);
      return 2;
    }
    err(command, `internal error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}
