import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { neutralize } from "../neutralize.js";
import { CheckFailed, KiB, UsageError, isObject, own, readJson, writeJson } from "../pipeline/common.js";
import { instanceEnv, loadAppFile, loadInstanceFile, orderedEnvironments } from "../provisioning/model.js";
import { BOOTSTRAP_PHASES, BootstrapPlanner, formatFederation, parseBootstrapOutputs } from "./bootstrap.js";
import type { BootstrapOutputs, BootstrapPhase } from "./bootstrap.js";
import { AdoClient, adoToken, parseOrgUrl } from "./client.js";
import { DEFAULT_SETTINGS, Planner, exitCode, formatItems } from "./plan.js";
import { decommissionSettings } from "../decommission.js";
import { Remover } from "./remove.js";

export const ADO_HELP = `platform ado plan|apply --instance <instance.yaml> --app <apps/<slug>/app.yaml> --phase resources|pipelines
                        --org-url https://dev.azure.com/<org> [--env <name>]... [--lz-outputs <env>=<file>]...
                        [--templates <core>/templates]
                        [--output ado-outputs.json] [--resave]
    The Azure DevOps objects of one app (the app repository, service connections, environments,
    checks, ACLs, the delivery pipeline and its permissions; with instance portal.identityPrincipalId
    the portal identity is Reader on each of the app's service connections, ADR-0058). plan only
    reads; apply creates and updates, never deletes. Token: AZURE_DEVOPS_TOKEN (az account get-access-token --resource
    499b84ac-1321-427f-aa17-267ca6975798) or SYSTEM_ACCESSTOKEN. --lz-outputs (phase resources, one per
    environment): the landing zone's deployment outputs (az deployment sub show -n lz-<slug>-<env>
    --query properties.outputs).
    Phase resources also creates the app repository when it is missing and seeds an empty one with
    the starter (repository.template a stack), or opens the onboarding pull request of a
    bring-your-own one (ADR-0039), rendered like platform repo render; --templates: templates/ of
    the core checkout (default: the one next to the CLI).
    --resave (phase pipelines): save the existing delivery pipeline's build definition unchanged, which
    registers its app repo trigger (ADO-24; done automatically after a create).

platform ado remove plan|apply --instance <instance.yaml> --app <apps/<slug>/app.yaml>
                        --org-url https://dev.azure.com/<org> --lz-outputs <env>=<file>...
                        [--landing-zone-gone <env>]...
    ADR-0056, the delete phase of a decommissioned app (app.yaml decommission): deletes the app's
    delivery pipeline (only when its YAML is apps/<slug>/delivery.yml of platform-config), its service
    connections (only when each federates the app's delivery identity of --lz-outputs, and only in an
    environment named by --landing-zone-gone: until its resource group is deleted the delivery
    identity's federated credential exists and Azure DevOps refuses the delete, so the connection
    waits, a warning), its environments (only with the description the platform writes); the app's
    repository, whether a starter, bring-your-own or unmanaged, is renamed <name>-deleted-<requestedOn>,
    with -i<incarnation> above incarnation 0, and -2 … -9 after it while Azure DevOps answers that the
    name exists, so its name is free again (ADR-0061; a refused rename or every name taken is a warn
    row, a name over 64 characters a blocked one, never cut; done once no repository has the old name),
    and with instance.yaml decommission.repository delete a starter is renamed, then deleted (a
    bring-your-own or unmanaged repository is never deleted). Anything that doesn't prove to be the
    app's is left alone (a blocked row, exit 1). Gone already = ok.

platform ado bootstrap plan|apply --instance <instance.yaml> --org-url https://dev.azure.com/<org>
                        --phase core|connections|pipeline|grants|policies [--identities <env>=<file>]...
                        [--output <file>] [--resave]
    The platform's own objects, run once by a human with their own token (ADR-0031, ADR-0032):
    core         the platform project's repository core (ADR-0067): created when missing (empty; this
                 phase never pushes, instance.sh core does), Create tag for Project Administrators only
                 (no Create tag entry of their own for Contributors and Build Administrators on the
                 project's repositories and core; denied on core to the build services), Force push
                 denied on each v* tag's own token for Project Valid Users and the build services
                 (ADO-23); needs no platform-config; --output: core: {repository, tags}
    connections  sc-platform-provisioning-<env> per environment, sc-platform-ado and sc-platform-entra
                 (WIF), each with Required template (app-provisioning.yml), Branch control and
                 Exclusive lock; sc-platform-entra never without a person's approval
                 (approvals.entraChanges, ADR-0051): separate = its own Approval (approvals.platformTeam,
                 which must resolve in the organization first, ADO-23; otherwise it is not created);
                 pullRequest (default) = no Approval check (an existing one is removed) while
                 platform-config's default branch has the platform team as required reviewer of every
                 pull request, else blocked and the Approval check stays;
                 --output has the issuer and subject of each (read back) for bootstrap pass 2
    pipeline     \\platform\\provisioning from pipelines/provisioning.yml and \\platform\\validation from
                 pipelines/validation.yml (--resave: re-save them, ADO-24); the platform connections
                 for \\platform\\provisioning only (sc-platform-entra only while it has its Approval
                 check or, with entraChanges pullRequest, that review), the core repo open to the
                 project's pipelines, no queueing deny for
                 Contributors on \\platform
    grants       id-<prefix>-ado-automation as an organization user (Basic) and its rights (ADO-1),
                 Create repository in the apps project (ADR-0039); id-<prefix>-portal: View
                 project-level information on the platform project, Read and Contribute to pull
                 requests on platform-config, Create branch and Contribute below portal/requests/
                 (ADR-0040), View builds on \\apps and \\platform, nothing else, once an
                 organization administrator has added it (until then a blocked row); platform-config's
                 Permissions management setting (no API: a warn row with the manual step)
    policies     the platform project's pipeline settings (job authorization scope limited to the
                 project and to referenced repositories, settable variables; set on apply, needs a
                 Project Administrator), the build service's rights on core and platform-config
                 (Read only; more is reported), and platform-config's default branch: minimum
                 reviewers (requester's vote per approvals.allowSelfApproval), approvals.platformTeam
                 as required reviewer (and again for /pipelines/*), build validation by
                 \\platform\\validation, required and queued by hand (ADR-0040; needs Edit policies)
    --identities: the outputs of infra/platform/bootstrap.bicep per environment (az deployment sub
    show -n <deployment> --query properties.outputs); connections needs every environment, grants
    the portal host environment's.

Exit codes: 0 ok, 1 blocked objects or failed changes, 2 usage or internal error, 3 (ado apply) only
rows that wait for a person (ADR-0039 H3: authorising the delivery pipeline on its repository).
`;

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** deliveryIdentityClientId from ARM deployment outputs ({name: {type, value}}) or a plain object. */
export function deliveryClientId(v: unknown, label: string): string {
  const raw = isObject(v) ? own(v, "deliveryIdentityClientId") : undefined;
  const value = isObject(raw) ? own(raw, "value") : raw;
  if (typeof value !== "string" || !GUID_RE.test(value)) throw new CheckFailed([`${label} has no deliveryIdentityClientId (a GUID).`]);
  return value;
}

function normalizeOrg(u: string): string {
  return u.replace(/\/+$/, "").toLowerCase();
}

export async function cmdAdo(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [action, ...args] = argv;
  const err = (msg: string): void => {
    process.stderr.write(neutralize(`platform ado: ${msg.replace(/\s*[\r\n]+\s*/g, " ")}`) + "\n");
  };
  if (!action || action === "help" || action === "--help" || action === "-h") {
    process.stdout.write(ADO_HELP);
    return action ? 0 : 2;
  }
  if (action === "bootstrap") return cmdBootstrap(args, env, err);
  if (action === "remove") return cmdRemove(args, env, err);
  try {
    if (action !== "plan" && action !== "apply") throw new UsageError(`unknown command "${action.slice(0, 40)}"; use plan, apply or bootstrap.`);
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        instance: { type: "string" },
        app: { type: "string" },
        env: { type: "string", multiple: true },
        phase: { type: "string" },
        "org-url": { type: "string" },
        "lz-outputs": { type: "string", multiple: true },
        output: { type: "string" },
        resave: { type: "boolean", default: false },
        templates: { type: "string" },
      },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const missing = ["instance", "app", "phase", "org-url"].filter((k) => !values[k as keyof typeof values]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    const phase = values.phase as string;
    if (phase !== "resources" && phase !== "pipelines") throw new UsageError("--phase must be resources or pipelines.");
    if (values.resave && phase !== "pipelines") throw new UsageError("--resave applies to --phase pipelines only.");
    if (values.templates && phase !== "resources") throw new UsageError("--templates applies to --phase resources only.");

    const inst = loadInstanceFile(values.instance as string);
    const app = loadAppFile(values.app as string, values.instance as string);
    const org = parseOrgUrl(values["org-url"] as string);
    const configured = inst.scm.azureDevOps?.organizationUrl;
    if (!configured || normalizeOrg(configured) !== normalizeOrg(org.url)) {
      throw new CheckFailed([`--org-url ${org.url} is not this instance's organization (scm.azureDevOps.organizationUrl).`]);
    }

    const all = orderedEnvironments(app, inst);
    const wanted = (values.env as string[] | undefined) ?? all.map((e) => e.name);
    for (const name of wanted) {
      if (!all.some((e) => e.name === name)) throw new CheckFailed([`app ${app.slug} does not run in environment ${name}.`]);
    }
    const envs = all.filter((e) => wanted.includes(e.name)).map((e) => instanceEnv(inst, e.name));

    const clientIds: Record<string, string> = {};
    for (const spec of (values["lz-outputs"] as string[] | undefined) ?? []) {
      const m = /^([a-z][a-z0-9]{1,7})=(.+)$/.exec(spec);
      if (!m) throw new UsageError(`--lz-outputs must be <env>=<file> (got "${spec.slice(0, 60)}").`);
      clientIds[m[1]!] = deliveryClientId(readJson(m[2]!, 256 * KiB, `--lz-outputs ${m[1]!}`), `--lz-outputs ${m[1]!}`);
    }
    if (phase === "resources") {
      const without = envs.filter((e) => !clientIds[e.name]).map((e) => e.name);
      if (without.length) throw new UsageError(`--phase resources needs --lz-outputs for ${without.join(", ")} (the delivery identity of each service connection).`);
    }

    const client = new AdoClient(org, adoToken(env), action === "plan");
    const planner = new Planner(client, inst as never, app, envs, action === "apply", clientIds, {
      ...DEFAULT_SETTINGS,
      resave: values.resave as boolean,
      ...(values.templates ? { templatesDir: resolve(values.templates as string) } : {}),
    });
    await planner.resolve(phase);
    if (phase === "resources") await planner.resources();
    else await planner.pipelines();

    process.stdout.write(neutralize(`platform ado ${action} --phase ${phase}: ${app.slug} in ${envs.map((e) => e.name).join(", ")} (${org.url})\n`));
    process.stdout.write(neutralize(formatItems(planner.items, action === "apply")));
    if (values.output) writeJson(values.output as string, planner.outputs);
    return exitCode(planner.items);
  } catch (e) {
    return failure(e, err);
  }
}

/** `platform ado remove plan|apply ...` (ADR-0056). */
async function cmdRemove(argv: string[], env: NodeJS.ProcessEnv, err: (msg: string) => void): Promise<number> {
  const [action, ...args] = argv;
  try {
    if (action !== "plan" && action !== "apply") throw new UsageError(`remove: unknown command "${String(action).slice(0, 40)}"; use remove plan or remove apply.`);
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: { instance: { type: "string" }, app: { type: "string" }, "org-url": { type: "string" }, "lz-outputs": { type: "string", multiple: true }, "landing-zone-gone": { type: "string", multiple: true } },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const missing = ["instance", "app", "org-url"].filter((k) => !values[k as keyof typeof values]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    const inst = loadInstanceFile(values.instance as string);
    const app = loadAppFile(values.app as string, values.instance as string);
    if (!app.decommission) throw new CheckFailed([`app ${app.slug} is not being decommissioned (app.yaml decommission): nothing of it is removed.`]);
    const org = parseOrgUrl(values["org-url"] as string);
    const configured = inst.scm.azureDevOps?.organizationUrl;
    if (!configured || normalizeOrg(configured) !== normalizeOrg(org.url)) {
      throw new CheckFailed([`--org-url ${org.url} is not this instance's organization (scm.azureDevOps.organizationUrl).`]);
    }
    const envs = orderedEnvironments(app, inst).map((e) => instanceEnv(inst, e.name));
    const clientIds: Record<string, string> = {};
    for (const spec of (values["lz-outputs"] as string[] | undefined) ?? []) {
      const m = /^([a-z][a-z0-9]{1,7})=(.+)$/.exec(spec);
      if (!m) throw new UsageError(`--lz-outputs must be <env>=<file> (got "${spec.slice(0, 60)}").`);
      clientIds[m[1]!] = deliveryClientId(readJson(m[2]!, 256 * KiB, `--lz-outputs ${m[1]!}`), `--lz-outputs ${m[1]!}`);
    }
    // ADR-0056 amendment 2026-11-12: the environments whose resource group is gone (step 2): only there
    // the service connection can be deleted.
    const gone = new Set<string>();
    for (const e of (values["landing-zone-gone"] as string[] | undefined) ?? []) {
      if (!envs.some((x) => x.name === e)) throw new UsageError(`--landing-zone-gone ${e.slice(0, 20)} is not an environment of the app.`);
      gone.add(e);
    }
    const client = new AdoClient(org, adoToken(env), action === "plan");
    const remover = new Remover(client, inst, app, envs, action === "apply", clientIds, decommissionSettings(inst as never), gone);
    await remover.run();
    process.stdout.write(neutralize(`platform ado remove ${action}: ${app.slug} in ${envs.map((e) => e.name).join(", ")} (${org.url})\n`));
    process.stdout.write(neutralize(formatItems(remover.items, action === "apply")));
    return exitCode(remover.items) === 0 ? 0 : 1;
  } catch (e) {
    return failure(e, err);
  }
}

function failure(e: unknown, err: (msg: string) => void): number {
  if (e instanceof CheckFailed) {
    for (const p of e.problems) err(p);
    return 1;
  }
  if (e instanceof UsageError || (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
    err(`${(e as Error).message} Run "platform ado help" for usage.`);
    return 2;
  }
  err(`internal error: ${e instanceof Error ? e.message : String(e)}`);
  return 2;
}

/** `platform ado bootstrap plan|apply --phase core|connections|pipeline|grants|policies ...` */
async function cmdBootstrap(argv: string[], env: NodeJS.ProcessEnv, err: (msg: string) => void): Promise<number> {
  const [action, ...args] = argv;
  try {
    if (action !== "plan" && action !== "apply") throw new UsageError(`bootstrap: unknown command "${String(action).slice(0, 40)}"; use bootstrap plan or bootstrap apply.`);
    const { values, positionals } = parseArgs({
      args,
      strict: true,
      allowPositionals: true,
      options: {
        instance: { type: "string" },
        phase: { type: "string" },
        "org-url": { type: "string" },
        identities: { type: "string", multiple: true },
        output: { type: "string" },
        resave: { type: "boolean", default: false },
      },
    });
    if (positionals.length) throw new UsageError("takes no positional arguments.");
    const missing = ["instance", "phase", "org-url"].filter((k) => !values[k as keyof typeof values]);
    if (missing.length) throw new UsageError(`missing ${missing.map((m) => `--${m}`).join(", ")}.`);
    const phase = values.phase as BootstrapPhase;
    if (!BOOTSTRAP_PHASES.includes(phase)) throw new UsageError("--phase must be core, connections, pipeline, grants or policies.");
    if (values.resave && phase !== "pipeline") throw new UsageError("--resave applies to --phase pipeline only.");

    const inst = loadInstanceFile(values.instance as string);
    const org = parseOrgUrl(values["org-url"] as string);
    const configured = inst.scm.azureDevOps?.organizationUrl;
    if (!configured || normalizeOrg(configured) !== normalizeOrg(org.url)) {
      throw new CheckFailed([`--org-url ${org.url} is not this instance's organization (scm.azureDevOps.organizationUrl).`]);
    }
    const identities: Record<string, BootstrapOutputs> = {};
    for (const spec of (values.identities as string[] | undefined) ?? []) {
      const m = /^([a-z][a-z0-9]{1,7})=(.+)$/.exec(spec);
      if (!m) throw new UsageError(`--identities must be <env>=<file> (got "${spec.slice(0, 60)}").`);
      if (!inst.environments.some((e) => e.name === m[1])) throw new CheckFailed([`--identities ${m[1]!}: not an environment of this instance.`]);
      identities[m[1]!] = parseBootstrapOutputs(readJson(m[2]!, 256 * KiB, `--identities ${m[1]!}`), `--identities ${m[1]!}`);
    }
    const host = inst.portal?.hostEnvironment ?? "";
    const needed = phase === "connections" ? inst.environments.map((e) => e.name) : phase === "grants" ? [host] : [];
    const without = needed.filter((n) => !identities[n]);
    if (without.length) throw new UsageError(`--phase ${phase} needs --identities for ${without.join(", ")} (the outputs of infra/platform/bootstrap.bicep).`);

    const client = new AdoClient(org, adoToken(env), action === "plan");
    const planner = new BootstrapPlanner(client, inst as never, action === "apply", identities, values.resave as boolean, values.instance as string);
    await planner.resolve(phase);
    if (phase === "core") await planner.core();
    else if (phase === "connections") await planner.connections();
    else if (phase === "pipeline") await planner.pipeline();
    else if (phase === "grants") await planner.grants();
    else await planner.policies();

    process.stdout.write(neutralize(`platform ado bootstrap ${action} --phase ${phase} (${org.url})\n`));
    process.stdout.write(neutralize(formatItems(planner.items, action === "apply")));
    process.stdout.write(neutralize(formatFederation(planner.result)));
    if (values.output) writeJson(values.output as string, planner.result);
    // No waiting rows in bootstrap: a person runs it, so anything open is 1.
    return exitCode(planner.items) === 0 ? 0 : 1;
  } catch (e) {
    return failure(e, err);
  }
}
