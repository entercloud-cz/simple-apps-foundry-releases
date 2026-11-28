import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, writeJson } from "../pipeline/common.js";
import { APP_GROUPS_HELP, cmdAppGroups } from "./app-groups.js";
import { DBINIT_HELP, cmdDbinit } from "./dbinit.js";
import { EASYAUTH_HELP, cmdEasyAuthSecret } from "./easyauth.js";
import { EASYAUTH_DELETE_HELP, cmdEasyAuthDelete } from "./easyauth-delete.js";
import { ENTRA_EFFECT_HELP, cmdEntraEffect } from "./entra-effect.js";
import { ENTRA_RECONCILE_HELP, cmdEntraReconcile, cmdEntraRemovals } from "./entra-reconcile.js";
import { ENTRA_DELETE_HELP, cmdEntraDelete } from "./entra-delete.js";
import { FAILURE_CODE_HELP, cmdFailureCode, cmdFailures } from "./failure-code.js";
import { formatGenerate, generate } from "./generate.js";
import { FD_CLEANUP_HELP, FD_DNS_GUARD_HELP, cleanupPlan, dnsGuard } from "./frontdoor-plan.js";
import { FD_RANGES_HELP, cmdFdRanges } from "./frontdoor-ranges.js";
import { provisioningInputs } from "./inputs.js";
import { PLAN_FACTS_HELP, cmdPlanFacts, planNames } from "./plan-facts.js";
import { REGISTRY_PURGE_HELP, cmdRegistryPurge } from "./registry-purge.js";
import { ROTATION_HELP, cmdRotationDue } from "./rotation.js";
import { buildState, compareFiles, formatApps, formatComparison, formatProvisioningRun, formatState, listApps, validateProvisioningRun } from "./run.js";
import { UNITS_HELP, cmdPlanUnits, cmdUnits } from "./units.js";
import { UPGRADES_HELP, checkUpgrades, formatUpgradesCheck } from "./upgrades.js";

export const PROVISIONING_HELP = `platform provisioning <command>: helpers for the provisioning pipeline (pure: files in, files out;
easyauth-secret, entra-reconcile and dbinit are the ones that call Azure or Microsoft Graph)

  inputs --step lz|entra|release|frontdoor|portal-endpoint --instance <instance.yaml>
         --app <apps/<slug>/app.yaml> --env <name> [--state <state.json>] --output <x.json>
         [--mode bootstrap|reapply] [--fd-record <f> [--fd-domain <f>]] [--apps <plan/apps.json>]
         [--prepare-from externalOnly|externalHybrid]
      the JSON for infra/app/provisioning/*.bicepparam and infra/entra/provisioning/*.bicepparam
      (--mode is required for --step release; --state for every step but frontdoor and
      portal-endpoint, which read only instance.yaml and app.yaml: the app's custom domain in that
      environment, ADR-0010; the vault's portal-side private endpoint plus vnetBased for the
      pipeline, ADR-0025); --step frontdoor also takes the last record fd-{slug}-{env}, whether
      Front Door serves its domain and the plan's other apps: during a host change the previous
      host stays on the route (retainedHostName) until the new one is served (ADR-0010, amended
      2026-11-11); --step lz writes modeChange: null, or with --prepare-from the prepare pass of a
      network mode change from that mode to app.yaml's (ADR-0060; not called by the pipeline yet)
  validate-run --instance <instance.yaml> --environments-json <json> --host-environment <name>
               --core-ref <ref> --source-branch <ref> --units <core>/infra/app/units.json
               --upgrades <core>/infra/app/upgrades.yaml --upgrade <none|all|slug,...> --apps-dir <dir>
      the run's environments and hostEnvironment parameters equal what "platform generate" renders
      from instance.yaml (names, kinds, promoteFrom, order; portal.hostEnvironment), the core ref is
      refs/tags/<coreVersion>, the run is on platform-config's default branch, core's unit
      manifest exists, is well formed and names released versions only (no "unreleased", none
      after coreVersion; ADR-0048), core's upgrade notes are valid and released, and the parameter
      upgrade is none, all or at most 50 slugs separated by commas, each with <dir>/<slug>/app.yaml
      (ADR-0049)
  apps --instance <instance.yaml> --apps-dir <dir> --scope changed|all --upgrade <none|all|slug,...>
       --output <apps.json>
      validates every <dir>/<slug>/app.yaml; writes { checkAllApps, upgrade: { all, apps }, apps: [
      { slug, file, ok: true, environments, authMode, frontDoorHosts: { <env>: <host> }, networkModes: { <env>: <mode> }, cells: { <env>: <cell> } } | { slug,
      file, ok: false, problems } ] } sorted by slug; an app whose slug has a deleted app's archive
      (apps-deleted/<slug>/<requestedOn>/app.yaml next to <dir>, ADR-0061) also has reusesSlug: true and
      its generation (the plan's guard against the old app's landing zone; the archive is never
      provisioned). checkAllApps: --scope all (every unit runs,
      ADR-0046, ADR-0048, except the outdated units ADR-0049 holds); upgrade: the apps whose outdated
      units run (ADR-0049). Invalid apps don't fail the command (exit 0); an invalid instance or a
      directory name that is no slug does (exit 1)
${UNITS_HELP}${PLAN_FACTS_HELP}  state --instance <instance.yaml> --app <apps/<slug>/app.yaml> --env <name> --core-dir <core checkout>
        [--lz-record <f>] [--release-record <f>] [--fd-record <f> [--fd-domain <f>]] [--fd-ranges <f>]
        [--entra-outputs <f>] [--ado-outputs <f>] [--easy-auth-secret present|absent]
        [--today YYYY-MM-DD] --output <state.json>
      state.json for "inputs" from the raw records (az deployment ... show -o json; no flag = no
      record), the Entra client ID ({clientId}, from stage entra or entra_plan), "platform ado
      apply --output", whether the Easy Auth secret exists, whether Front Door serves the custom
      domain (--fd-domain: {domainValidationState, deploymentStatus} of its customDomains resource)
      and the Front Door backend ranges (the output of fd-ranges); --today defaults to the current
      UTC date
  compare --kind lz|release|entra|frontdoor|portal-endpoint|environment --validate <validate.json> [--record <record.json>]
      prints "up-to-date", "changed: <reasons>" or "new" (no --record) and exits 0 in all three
      cases; up to date = record Succeeded, same templateHash and parameters as the validate output
      (an entry without value equals null; release: deployedBy, alertsEnabled and coreVersion ignored)
${REGISTRY_PURGE_HELP}${FAILURE_CODE_HELP}${FD_RANGES_HELP}${FD_CLEANUP_HELP}${FD_DNS_GUARD_HELP}${ROTATION_HELP}${EASYAUTH_HELP}${EASYAUTH_DELETE_HELP}${ENTRA_RECONCILE_HELP}${ENTRA_DELETE_HELP}${ENTRA_EFFECT_HELP}${DBINIT_HELP}
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
    err(`${(e as Error).message} Run "platform help" for usage.`);
    return 2;
  }
  err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

/** `platform generate [--config-dir <dir>] [--check]` */
export function cmdGenerate(args: string[]): number {
  try {
    const { values, positionals } = parseArgs({ args, options: { "config-dir": { type: "string", default: "." }, check: { type: "boolean", default: false } }, allowPositionals: true, strict: true });
    if (positionals.length) throw new UsageError("platform generate takes no positional arguments (use --config-dir).");
    const check = values.check as boolean;
    const r = generate(values["config-dir"] as string, { check });
    const { text, drift } = formatGenerate(r, check);
    process.stdout.write(neutralize(text));
    return check && drift ? 1 : 0;
  } catch (e) {
    return report("generate", e);
  }
}

const str = { type: "string" } as const;

interface Spec {
  options: Record<string, { type: "string"; multiple?: boolean }>;
  required: string[];
  run: (v: Record<string, string | undefined>) => string;
}

const COMMANDS: Record<string, Spec> = {
  inputs: {
    options: { step: str, instance: str, app: str, env: str, state: str, output: str, mode: str, "fd-record": str, "fd-domain": str, apps: str, "prepare-from": str },
    required: ["step", "instance", "app", "env", "output"],
    run: (v) => {
      const out = provisioningInputs({
        step: v.step!,
        instance: v.instance!,
        app: v.app!,
        env: v.env!,
        ...(v.state !== undefined ? { state: v.state } : {}),
        ...(v.mode !== undefined ? { mode: v.mode } : {}),
        ...(v["fd-record"] !== undefined ? { fdRecord: v["fd-record"] } : {}),
        ...(v["fd-domain"] !== undefined ? { fdDomain: v["fd-domain"] } : {}),
        ...(v.apps !== undefined ? { apps: v.apps } : {}),
        ...(v["prepare-from"] !== undefined ? { prepareFrom: v["prepare-from"] } : {}),
      });
      writeJson(v.output!, out);
      return `OK  ${v.step!} inputs for ${String(out.slug)} in ${String(out.environmentName)} written to ${v.output!}\n`;
    },
  },
  "validate-run": {
    options: { instance: str, "environments-json": str, "host-environment": str, "core-ref": str, "source-branch": str, units: str, upgrades: str, upgrade: str, "apps-dir": str },
    required: ["instance", "environments-json", "host-environment", "core-ref", "source-branch", "units", "upgrades", "upgrade", "apps-dir"],
    run: (v) =>
      formatProvisioningRun(
        validateProvisioningRun({
          instance: v.instance!,
          environmentsJson: v["environments-json"]!,
          hostEnvironment: v["host-environment"]!,
          coreRef: v["core-ref"]!,
          sourceBranch: v["source-branch"]!,
          units: v.units!,
          upgrades: v.upgrades!,
          upgrade: v.upgrade!,
          appsDir: v["apps-dir"]!,
        }),
      ),
  },
  apps: {
    options: { instance: str, "apps-dir": str, scope: str, upgrade: str, output: str },
    required: ["instance", "apps-dir", "scope", "upgrade", "output"],
    run: (v) => {
      const r = listApps({ instance: v.instance!, appsDir: v["apps-dir"]!, scope: v.scope!, upgrade: v.upgrade! });
      // Problems quote app.yaml content: neutralised here too, since the pipeline prints them.
      writeJson(v.output!, { checkAllApps: r.checkAllApps, upgrade: r.upgrade, apps: r.apps.map((a) => (a.ok ? a : { ...a, problems: a.problems.map(neutralize) })) });
      return formatApps(r);
    },
  },
  state: {
    options: { instance: str, app: str, env: str, "core-dir": str, "lz-record": str, "release-record": str, "fd-record": str, "fd-domain": str, "fd-ranges": str, "entra-outputs": str, "ado-outputs": str, "easy-auth-secret": str, today: str, output: str },
    required: ["instance", "app", "env", "core-dir", "output"],
    run: (v) => {
      const s = buildState({
        instance: v.instance!,
        app: v.app!,
        env: v.env!,
        coreDir: v["core-dir"]!,
        today: v.today ?? new Date().toISOString().slice(0, 10),
        ...(v["lz-record"] !== undefined ? { lzRecord: v["lz-record"] } : {}),
        ...(v["release-record"] !== undefined ? { releaseRecord: v["release-record"] } : {}),
        ...(v["fd-record"] !== undefined ? { fdRecord: v["fd-record"] } : {}),
        ...(v["fd-domain"] !== undefined ? { fdDomain: v["fd-domain"] } : {}),
        ...(v["fd-ranges"] !== undefined ? { fdRanges: v["fd-ranges"] } : {}),
        ...(v["entra-outputs"] !== undefined ? { entraOutputs: v["entra-outputs"] } : {}),
        ...(v["ado-outputs"] !== undefined ? { adoOutputs: v["ado-outputs"] } : {}),
        ...(v["easy-auth-secret"] !== undefined ? { easyAuthSecret: v["easy-auth-secret"] } : {}),
      });
      writeJson(v.output!, s);
      const slug = /([^/\\]+)[/\\]app\.yaml$/.exec(v.app!)?.[1] ?? "app";
      return formatState(s, slug, v.env!);
    },
  },
  compare: {
    options: { kind: str, validate: str, record: str },
    required: ["kind", "validate"],
    run: (v) => formatComparison(compareFiles({ kind: v.kind!, validate: v.validate!, ...(v.record !== undefined ? { record: v.record } : {}) })),
  },
  "fd-cleanup": {
    options: { instance: str, app: str, env: str, apps: str, before: str, after: str, output: str },
    required: ["instance", "app", "env", "before", "output"],
    run: (v) => {
      const p = cleanupPlan({ instance: v.instance!, app: v.app!, env: v.env!, before: v.before!, ...(v.after !== undefined ? { after: v.after } : {}), ...(v.apps !== undefined ? { apps: v.apps } : {}) });
      writeJson(v.output!, p);
      const what = [...(p.removeRoute ? ["route", "origin group"] : []), ...p.domains.map((d) => d.host)];
      return `OK  Front Door cleanup of ${p.slug} in ${p.environmentName}: ${what.length ? what.join(", ") : "nothing"}${p.skipped.length ? `; left alone: ${p.skipped.map((s) => s.host).join(", ")}` : ""}\n`;
    },
  },
  "fd-dns-guard": {
    options: { instance: str, app: str, env: str, output: str },
    required: ["instance", "app", "env", "output"],
    run: (v) => {
      const g = dnsGuard({ instance: v.instance!, app: v.app!, env: v.env! });
      writeJson(v.output!, g);
      return `OK  DNS records of ${g.host} (${g.slug} in ${g.environmentName}): ${g.zoneId ? "in an Azure DNS zone, read before the deployment" : "made by hand, nothing to read"}\n`;
    },
  },
  "fd-ranges": {
    options: { "service-tags": str, output: str },
    required: ["service-tags", "output"],
    run: (v) => cmdFdRanges({ "service-tags": v["service-tags"]!, output: v.output! }),
  },
  "entra-removals": {
    options: { inputs: str, record: str, output: str, "disable-output": str },
    required: ["inputs", "output"],
    run: (v) => cmdEntraRemovals(v),
  },
  "entra-effect": {
    options: { base: str, head: str, instance: str, output: str },
    required: ["base", "head"],
    run: (v) => cmdEntraEffect(v),
  },
  units: {
    options: { instance: str, apps: str, output: str },
    required: ["instance", "apps", "output"],
    run: (v) => cmdUnits({ instance: v.instance!, apps: v.apps!, output: v.output! }),
  },
  "plan-units": {
    options: { instance: str, apps: str, inputs: str, manifest: str, upgrades: str, plan: { type: "string", multiple: true }, today: str, now: str, output: str, decommission: str, registry: str },
    required: ["instance", "apps", "inputs", "manifest", "upgrades", "plan", "output"],
    run: (v) =>
      cmdPlanUnits({
        instance: v.instance as string,
        apps: v.apps as string,
        inputs: v.inputs as string,
        manifest: v.manifest as string,
        upgrades: v.upgrades as string,
        plan: v.plan as unknown as string[],
        ...(v.today !== undefined ? { today: v.today as string } : {}),
        ...(v.now !== undefined ? { now: v.now as string } : {}),
        output: v.output as string,
        ...(v.decommission !== undefined ? { decommission: v.decommission as string } : {}),
        ...(v.registry !== undefined ? { registry: v.registry as string } : {}),
      }),
  },
  "registry-purge": {
    options: { manifests: str, output: str, live: str, plan: str, env: str, slug: str, days: str, "keep-latest": str, protect: { type: "string", multiple: true }, now: str },
    required: ["manifests", "output"],
    run: (v) =>
      cmdRegistryPurge({
        manifests: v.manifests as string,
        output: v.output as string,
        ...(v.live !== undefined ? { live: v.live as string } : {}),
        ...(v.plan !== undefined ? { plan: v.plan as string } : {}),
        ...(v.env !== undefined ? { env: v.env as string } : {}),
        ...(v.slug !== undefined ? { slug: v.slug as string } : {}),
        ...(v.days !== undefined ? { days: v.days as string } : {}),
        ...(v["keep-latest"] !== undefined ? { "keep-latest": v["keep-latest"] as string } : {}),
        ...(v.protect !== undefined ? { protect: v.protect as unknown as string[] } : {}),
        ...(v.now !== undefined ? { now: v.now as string } : {}),
      }),
  },
  "plan-names": {
    options: { instance: str, env: str, apps: str, output: str },
    required: ["instance", "env", "output"],
    run: (v) => {
      writeJson(v.output!, planNames(v.instance!, v.env!, v.apps));
      return `OK  names of ${v.env!} written to ${v.output!}\n`;
    },
  },
  "plan-facts": {
    options: { instance: str, apps: str, env: str, bulk: str, images: str, "fd-ranges": str, now: str, "run-id": str, output: str },
    required: ["instance", "apps", "env", "bulk", "images", "output"],
    run: (v) => cmdPlanFacts(v),
  },
  "failure-code": {
    options: { log: str, kind: str },
    required: ["log", "kind"],
    run: (v) => cmdFailureCode({ log: v.log!, kind: v.kind! }),
  },
  failures: {
    options: { input: str },
    required: ["input"],
    run: (v) => cmdFailures({ input: v.input! }),
  },
  "rotation-due": {
    options: { expires: str, created: str, now: str },
    required: ["expires"],
    run: (v) => cmdRotationDue({ expires: v.expires!, ...(v.created !== undefined ? { created: v.created } : {}), ...(v.now !== undefined ? { now: v.now } : {}) }),
  },
};

/** `platform provisioning <command>` */
export function cmdProvisioning(argv: string[]): number | Promise<number> {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(PROVISIONING_HELP);
    return command ? 0 : 2;
  }
  // The commands with Azure calls (async, tokens from the environment): ADR-0035, ADR-0028, ADR-0056, ADR-0061.
  if (command === "easyauth-secret") return cmdEasyAuthSecret(args);
  if (command === "easyauth-delete") return cmdEasyAuthDelete(args);
  if (command === "dbinit") return cmdDbinit(args);
  if (command === "entra-reconcile") return cmdEntraReconcile(args);
  if (command === "entra-delete") return cmdEntraDelete(args);
  if (command === "app-groups") return cmdAppGroups(args);
  const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : undefined;
  if (!spec) return report("provisioning", new UsageError(`unknown command "${command.slice(0, 40)}"; commands: ${[...Object.keys(COMMANDS), "easyauth-secret", "easyauth-delete", "entra-reconcile", "entra-delete", "app-groups", "dbinit"].join(", ")}.`));
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: spec.options });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const v = values as Record<string, string | undefined>;
    const missing = spec.required.filter((k) => !v[k]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    process.stdout.write(neutralize(spec.run(v)));
    return 0;
  } catch (e) {
    return report(`provisioning ${command}`, e);
  }
}

/** `platform upgrades check [--core-dir <dir>]`: the upgrade notes of core (ADR-0049 section 5, core CI). */
export function cmdUpgrades(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(UPGRADES_HELP);
    return command ? 0 : 2;
  }
  if (command !== "check") return report("upgrades", new UsageError(`unknown command "${command.slice(0, 40)}"; commands: check.`));
  try {
    const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { "core-dir": str } });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    process.stdout.write(neutralize(formatUpgradesCheck(checkUpgrades(values["core-dir"] ?? "."))));
    return 0;
  } catch (e) {
    return report("upgrades check", e);
  }
}
