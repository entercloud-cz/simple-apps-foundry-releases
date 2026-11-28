import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, UsageError, writeJson } from "../pipeline/common.js";
import { loadInstanceFile } from "../provisioning/model.js";
import { formatFacts, instanceFacts } from "./facts.js";
import { INSTANCE_TEMPLATES, instanceInputsFiles } from "./inputs.js";
import { instancePlan, instanceStatus } from "./onboarding.js";
import { instanceSyncFiles } from "./sync.js";

export const INSTANCE_HELP = `platform instance <command>: the templates a person runs while onboarding an instance (ADR-0066),
and the onboarding plan and where an instance stands (ADR-0072). Pure: files in, text or JSON out, no Azure
calls; infra/platform/instance/instance.sh reads the state and runs az

  inputs <template> --instance <instance.yaml> [state files] [--output <file>]
      the JSON for infra/platform/instance/<template>.bicepparam (SAF_INSTANCE_JSON), printed (or written
      to --output); schema defaults resolved, a missing state file fails with what to run first:
    bootstrap --env <name> --pass 1|2 [--outputs <host>=<file>] [--federation <file>]
        instanceIdentities and every environment's Entra group in portal.hostEnvironment only;
        instancePrincipals {} there, elsewhere the host's bootstrap outputs (--outputs); federation {}
        on pass 1, on pass 2 the environment's issuer and subject from --federation (the --output of
        platform ado bootstrap plan --phase connections), each connection required
    roles
        every environment's subscription, once each
    entra-permissions --outputs <host>=<file>
        the Entra provisioning identity's principal
    portal-registration --outputs <host>=<file> --portal-outputs <file> [--dev-redirect-uri <uri>]...
        the portal CAE's domain (outputs of portal-<prefix>-<host>), the groups, the tenant and the
        portal identity's principal; localhost redirect URIs on a nonprod host only
    entra-audit-alert --outputs <host>=<file> --platform-outputs <file> [--workspace <id>
                      --workspace-location <region>] [--action-group <id>]...
        the host's platform workspace (or --workspace) and action group (outputs of
        platform-<prefix>-<host>), then each --action-group (the identity team's)
  sync --instance <instance.yaml> --outputs <host>=<file> [--registration <file>] [--portal-outputs <file>] [--write]
      identities.entraProvisioningPrincipalId and portal.identityPrincipalId from the host's bootstrap
      outputs, portal.clientId from the registration's (entra-portal-<host>), portal.apiBaseUrl from
      the portal's (portal-<prefix>-<host>, only while it is not set); prints what changes, and with
      --write edits instance.yaml in place, comments kept
  facts --instance <instance.yaml>
      key=value lines for instance.sh: subscriptions, regions, organisation, approvals.entraChanges,
      DNS zones, and the names of the deployments, groups and lock it reads or touches
  plan [--instance <instance.yaml>] [--format text|markdown|json] [--lang en|cs]
      every phase and step of onboarding (ADR-0072: src/onboarding/plan.ts), who does each and its
      command; --instance fills <host> and <prefix> and lists each environment; reads nothing else
  plan --format markdown --update <file>
      replaces the checklist between the onboarding-plan markers of <file> (docs/runbooks/onboard-instance.md)
  status --instance <instance.yaml> [--state <dir>] [--format text|json] [--lang en|cs]
      where onboarding stands: each step done, next (its exact commands), waiting (on whom), blocked (by
      which step) or unknown (why); the current phase and step and the next step. --state: the directory
      instance.sh status read Azure, Azure DevOps and the portal into (without it those steps are unknown)

  --outputs <env>=<file>: az deployment sub show -n bootstrap-<prefix>-<env> --query properties.outputs
  (tenant and subscription must be the instance's); --portal-outputs, --platform-outputs and
  --registration: the outputs of those deployments (az deployment ... show --query properties.outputs).

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
    err(`${(e as Error).message} Run "platform instance help" for usage.`);
    return 2;
  }
  err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

const str = { type: "string" } as const;
const many = { type: "string", multiple: true } as const;

/** `platform instance <command>` */
export function cmdInstance(argv: string[]): number {
  const [command, ...args] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(INSTANCE_HELP);
    return command ? 0 : 2;
  }
  try {
    if (command === "inputs") {
      const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: {
          instance: str,
          env: str,
          pass: str,
          outputs: many,
          federation: str,
          "portal-outputs": str,
          "platform-outputs": str,
          "dev-redirect-uri": many,
          workspace: str,
          "workspace-location": str,
          "action-group": many,
          output: str,
        },
      });
      if (positionals.length !== 1) throw new UsageError(`inputs takes one template: ${INSTANCE_TEMPLATES.join(", ")}.`);
      if (!values.instance) throw new UsageError("missing --instance.");
      const out = instanceInputsFiles(positionals[0]!, {
        instance: values.instance,
        ...(values.outputs ? { outputs: values.outputs } : {}),
        ...(values.federation !== undefined ? { federation: values.federation } : {}),
        ...(values["portal-outputs"] !== undefined ? { portalOutputs: values["portal-outputs"] } : {}),
        ...(values["platform-outputs"] !== undefined ? { platformOutputs: values["platform-outputs"] } : {}),
        ...(values.env !== undefined ? { env: values.env } : {}),
        ...(values.pass !== undefined ? { pass: values.pass } : {}),
        ...(values["dev-redirect-uri"] ? { devRedirectUris: values["dev-redirect-uri"] } : {}),
        ...(values.workspace !== undefined ? { workspace: values.workspace } : {}),
        ...(values["workspace-location"] !== undefined ? { workspaceLocation: values["workspace-location"] } : {}),
        ...(values["action-group"] ? { actionGroups: values["action-group"] } : {}),
      });
      if (values.output) writeJson(values.output, out);
      else process.stdout.write(neutralize(JSON.stringify(out, null, 2) + "\n"));
      return 0;
    }
    if (command === "sync") {
      const { values, positionals } = parseArgs({
        args,
        strict: true,
        allowPositionals: true,
        options: { instance: str, outputs: many, registration: str, "portal-outputs": str, write: { type: "boolean", default: false } },
      });
      if (positionals.length) throw new UsageError("sync takes no positional arguments.");
      if (!values.instance) throw new UsageError("missing --instance.");
      process.stdout.write(
        neutralize(
          instanceSyncFiles({
            instance: values.instance,
            write: values.write,
            ...(values.outputs ? { outputs: values.outputs } : {}),
            ...(values.registration !== undefined ? { registration: values.registration } : {}),
            ...(values["portal-outputs"] !== undefined ? { portalOutputs: values["portal-outputs"] } : {}),
          }),
        ),
      );
      return 0;
    }
    if (command === "facts") {
      const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { instance: str } });
      if (positionals.length) throw new UsageError("facts takes no positional arguments.");
      if (!values.instance) throw new UsageError("missing --instance.");
      process.stdout.write(neutralize(formatFacts(instanceFacts(loadInstanceFile(values.instance)))));
      return 0;
    }
    if (command === "plan") {
      const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { instance: str, format: str, lang: str, update: str } });
      if (positionals.length) throw new UsageError("plan takes no positional arguments.");
      process.stdout.write(
        neutralize(
          instancePlan({
            ...(values.instance !== undefined ? { instance: values.instance } : {}),
            ...(values.format !== undefined ? { format: values.format } : {}),
            ...(values.lang !== undefined ? { lang: values.lang } : {}),
            ...(values.update !== undefined ? { update: values.update } : {}),
          }),
        ),
      );
      return 0;
    }
    if (command === "status") {
      const { values, positionals } = parseArgs({ args, strict: true, allowPositionals: true, options: { instance: str, state: str, format: str, lang: str } });
      if (positionals.length) throw new UsageError("status takes no positional arguments.");
      if (!values.instance) throw new UsageError("missing --instance.");
      const { text } = instanceStatus({
        instance: values.instance,
        ...(values.state !== undefined ? { state: values.state } : {}),
        ...(values.format !== undefined ? { format: values.format } : {}),
        ...(values.lang !== undefined ? { lang: values.lang } : {}),
      });
      process.stdout.write(neutralize(text));
      return 0;
    }
    throw new UsageError(`unknown command "${command.slice(0, 40)}"; commands: inputs, sync, facts, plan, status.`);
  } catch (e) {
    return report(`instance ${command}`, e);
  }
}
