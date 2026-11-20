import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, MiB, UsageError, readJson, writeJson } from "../pipeline/common.js";
import { compareDeployment, formatComparison, parseRecord } from "../provisioning/run.js";
import { caeNetworkFiles, formatCaeNetwork } from "./cae-network.js";
import { environmentInputsFiles, portalInputsFiles } from "./inputs.js";
import { formatEnvironmentRun, rolesCheckFiles, validateEnvironmentRun } from "./run.js";

export const ENVIRONMENT_HELP = `platform environment <command>: helpers for the platform pipeline \\platform\\platform-<env>
(ADR-0043; pure: files in, files out, no Azure calls)

  inputs --instance <instance.yaml> --env <name> --images <core images/images.json> --pass 1|2
         --output <environment.json>
      the JSON for infra/platform/pipeline/environment.bicepparam (SAF_ENVIRONMENT_JSON), schema
      defaults resolved; pass 1 (a new environment) without the saf-jobs digest, pass 2 with the one
      images.json pins
  portal-inputs --instance <instance.yaml> --env <portal.hostEnvironment> --images <core images/images.json>
                --pass 1|2|auto [--smtp-secret present|absent] --output <portal.json>
      the JSON for infra/platform/pipeline/portal.bicepparam (SAF_PORTAL_JSON), host environment
      only: pass 1 without the Container App, pass 2 with the saf-portal digest images.json pins and
      portal.clientId (required then); auto = 2 once portal.clientId is set, else 1. With SMTP basic
      auth, --smtp-secret present (the pipeline found the password secret in the host's environment
      vault) gives the portal identity Key Vault Secrets User on it and the portal its vault; absent
      (the default) neither
  validate-run --instance <instance.yaml> --environment <name> --host-environment <name>
               --core-ref <ref>
      the run's environment and hostEnvironment parameters equal what "platform generate" renders
      from instance.yaml (an environment of the instance; portal.hostEnvironment) and the core ref
      is refs/tags/<coreVersion>
  roles-check --names <names snapshot.json> --roles <compiled roles.bicep json>
              --definitions <az role definition list json> --subscription <id>
      the three custom roles of roles.bicep exist with exactly this core's actions and are
      assignable in the subscription; otherwise exit 1 with what differs (a person deploys
      roles.bicep: no pipeline writes role definitions)
  compare --validate <validate.json> [--record <record.json>]
      as "platform provisioning compare --kind environment" (the records platform-<prefix>-<env> and
      portal-<prefix>-<env>): "up-to-date", "changed: <reasons>" or "new", exit 0 in all three cases
  cae-network --names <names snapshot.json> --snapshot <environment.bicepparam snapshot.json>
              --live <caes.json> --output <verdicts.json>
      a CAE's network is fixed once it exists: per CAE of platform-names.bicep (output
      managedEnvironments), the live infrastructure subnet (--live: [{mode, name, resource}], resource
      = az resource show or null; none = the Azure-managed network) against the one environment.bicep
      would deploy (the snapshot's predicted CAEs), case-insensitively. Writes the verdicts (new,
      unchanged, refused, not-enabled, absent); exit 1 with one line per existing CAE whose network
      would change (a new CAE is never refused)

Exit codes: 0 ok, 1 check failed or invalid input (one stderr line per problem), 2 usage or internal error.
`;

function report(cmd: string, e: unknown): number {
  const err = (msg: string): void => {
    process.stderr.write(neutralize(`platform ${cmd}: ${msg.replace(/\s*[\r\n]+\s*/g, " ")}`) + "\n");
  };
  if (e instanceof CheckFailed) {
    for (const p of e.problems) err(p);
    return 1;
  }
  if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    err(`${(e as Error).message} Run "platform environment help" for usage.`);
    return 2;
  }
  err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

const str = { type: "string" } as const;

interface Spec {
  options: Record<string, { type: "string" }>;
  required: string[];
  run: (v: Record<string, string | undefined>) => string;
}

const COMMANDS: Record<string, Spec> = {
  inputs: {
    options: { instance: str, env: str, images: str, pass: str, output: str },
    required: ["instance", "env", "images", "pass", "output"],
    run: (v) => {
      const out = environmentInputsFiles({ instance: v.instance!, env: v.env!, images: v.images!, pass: v.pass! });
      writeJson(v.output!, out);
      return `OK  environment inputs for ${String(out.environmentName)} (pass ${v.pass!}) written to ${v.output!}\n`;
    },
  },
  "portal-inputs": {
    options: { instance: str, env: str, images: str, pass: str, "smtp-secret": str, output: str },
    required: ["instance", "env", "images", "pass", "output"],
    run: (v) => {
      const out = portalInputsFiles({ instance: v.instance!, env: v.env!, images: v.images!, pass: v.pass!, smtpSecret: v["smtp-secret"] });
      writeJson(v.output!, out);
      return `OK  portal inputs for ${String(out.environmentName)} (pass ${out.portalImageDigest === "" ? 1 : 2}) written to ${v.output!}\n`;
    },
  },
  "validate-run": {
    options: { instance: str, environment: str, "host-environment": str, "core-ref": str },
    required: ["instance", "environment", "host-environment", "core-ref"],
    run: (v) => formatEnvironmentRun(validateEnvironmentRun({ instance: v.instance!, environment: v.environment!, hostEnvironment: v["host-environment"]!, coreRef: v["core-ref"]! })),
  },
  "roles-check": {
    options: { names: str, roles: str, definitions: str, subscription: str },
    required: ["names", "roles", "definitions", "subscription"],
    run: (v) => rolesCheckFiles({ names: v.names!, roles: v.roles!, definitions: v.definitions!, subscription: v.subscription! }),
  },
  "cae-network": {
    options: { names: str, snapshot: str, live: str, output: str },
    required: ["names", "snapshot", "live", "output"],
    run: (v) => {
      const r = caeNetworkFiles({ names: v.names!, snapshot: v.snapshot!, live: v.live! });
      writeJson(v.output!, r);
      if (r.refused.length) {
        process.stdout.write(neutralize(formatCaeNetwork(r)));
        throw new CheckFailed(r.refused);
      }
      return formatCaeNetwork(r);
    },
  },
  compare: {
    options: { validate: str, record: str },
    required: ["validate"],
    run: (v) => {
      const validate = parseRecord(readJson(v.validate!, 16 * MiB, "--validate"), "--validate");
      const record = v.record === undefined ? undefined : parseRecord(readJson(v.record, 16 * MiB, "--record"), "--record");
      return formatComparison(compareDeployment("environment", validate, record));
    },
  },
};

/** `platform environment <command>` */
export function cmdEnvironment(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(ENVIRONMENT_HELP);
    return command ? 0 : 2;
  }
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) return report("environment", new UsageError(`unknown command "${command.slice(0, 40)}"; commands: ${Object.keys(COMMANDS).join(", ")}.`));
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: spec.options });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = spec.required.filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    process.stdout.write(neutralize(spec.run(v)));
    return 0;
  } catch (e) {
    return report(`environment ${command}`, e);
  }
}
