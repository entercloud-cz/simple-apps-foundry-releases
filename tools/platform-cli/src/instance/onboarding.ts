import { portalHost } from "../environment/portal-host.js";
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseItemRows } from "../ado/steps.js";
import { CheckFailed, UsageError } from "../pipeline/common.js";
import { provisioningHostEnvironment } from "../provisioning/generate.js";
import { entraChangesMode, instanceDefault, loadInstanceFile } from "../provisioning/model.js";
import type { Instance } from "../provisioning/model.js";
import { entraResourceGroup, platformDeployment, portalDeployment, portalEntraDeployment } from "../provisioning/names.js";
import { evaluateOnboarding, planJson, planMarkdown, planMarkdownBlock, planText, statusText, withPlanBlock } from "../onboarding/index.js";
import type { AdoPhaseRead, DeploymentRead, Lang, OnboardingInstance, OnboardingReport, OnboardingState, PlanContext } from "../onboarding/index.js";
import { ENTRA_AUDIT_ALERT_DEPLOYMENT, ENTRA_PERMISSIONS_DEPLOYMENT, bootstrapDeployment, rolesDeployment } from "./facts.js";
import { deploymentOutputs } from "./inputs.js";

/**
 * `platform instance plan|status` (ADR-0072): the onboarding plan of src/onboarding/ for a person, and where an
 * instance stands. `plan` reads nothing but the optional instance.yaml (it fills <host>, <prefix> and lists each
 * environment). `status` evaluates what `instance.sh status` read into a directory (--state, below); without it
 * every step that needs Azure or Azure DevOps is unknown. Neither calls Azure.
 *
 * The state directory, written by instance.sh status (each file optional; a missing one is "not read"):
 *   azure                          ok | not-logged-in | other-tenant <tenant>
 *   providers/<subscription>.missing   the required resource providers it lacks, one per line (empty: none)
 *   providers/<subscription>.error     why they could not be read
 *   deployments/<name>.json        {state, outputs, federation} of `az deployment ... show` (federation: the
 *                                  bootstrap's parameter), .absent (not found) or .error (the error)
 *   dns/<zone>.exists | .absent | .error
 *   dnsroles/<zone>/<env>.ok (the role and scope) | .missing (the provisioning identity's principal ID) | .error
 *   ado/token.error                no Azure DevOps token (why)
 *   ado/<phase>.rc, .log, .json    `platform ado bootstrap plan --phase <phase>`: its exit code, its output (rows) and
 *                                  its --output; ado/<phase>.skipped: why it was not run
 *   portal/url, portal/readyz      the portal's address and the HTTP status of /readyz; portal/readyz.error
 *   audit-alert-workspace          the workspace the audit alert was read next to
 */

const MAX_FILE = 1024 * 1024;
const LANG_VALUES = ["en", "cs"];

function text(file: string): string | undefined {
  if (!existsSync(file) || lstatSync(file).isSymbolicLink() || !lstatSync(file).isFile()) return undefined;
  if (lstatSync(file).size > MAX_FILE) throw new CheckFailed([`${file} is larger than 1 MiB.`]);
  return readFileSync(file, "utf8");
}
const firstLine = (s: string | undefined): string | undefined => s?.split(/\r?\n/).find((l) => l.trim())?.trim();
const oneLine = (s: string | undefined, max = 400): string | undefined => {
  const t = s?.replace(/\s*[\r\n]+\s*/g, " ").trim();
  return t ? t.slice(0, max) : undefined;
};
const json = (file: string): unknown => {
  const t = text(file);
  if (t === undefined) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const files = (dir: string): string[] => (existsSync(dir) && lstatSync(dir).isDirectory() ? readdirSync(dir).sort() : []);

/** A deployment read: the JSON of instance.sh status's query, .absent or .error. */
function deploymentRead(dir: string, name: string): DeploymentRead | undefined {
  const base = join(dir, "deployments", name);
  const j = json(`${base}.json`);
  if (isObj(j)) {
    const ps = typeof j.state === "string" ? j.state : "";
    const state = ps === "Succeeded" ? "succeeded" : ps === "Failed" || ps === "Canceled" ? "failed" : "running";
    return {
      state,
      provisioningState: ps || "unknown",
      ...(isObj(j.outputs) ? { outputs: deploymentOutputs(j.outputs, `deployment ${name}`) } : {}),
      federation: j.federation ?? null,
    };
  }
  if (existsSync(`${base}.absent`)) return { state: "absent" };
  const err = text(`${base}.error`);
  if (err !== undefined) return { state: "unknown", error: oneLine(err) ?? "no answer" };
  if (existsSync(`${base}.json`)) return { state: "unknown", error: "the answer is not a JSON object" };
  return undefined;
}

/** What instance.sh status read (the directory above). */
export function readOnboardingState(dir: string, inst: OnboardingInstance, configDir: string): OnboardingState {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw new UsageError(`--state ${dir} is not a directory.`);
  const st: OnboardingState = {};
  const azure = firstLine(text(join(dir, "azure")));
  if (azure) {
    const [login, tenant] = azure.split(/\s+/);
    if (login === "ok" || login === "not-logged-in" || login === "other-tenant") st.azure = { login, ...(tenant ? { tenant } : {}) };
  }
  for (const f of files(join(dir, "providers"))) {
    const m = /^(.+)\.(missing|error)$/.exec(f);
    if (!m) continue;
    const t = text(join(dir, "providers", f)) ?? "";
    (st.providers ??= {})[m[1]!] = m[2] === "error" ? { error: oneLine(t) ?? "no answer" } : { missing: t.split(/\s+/).filter(Boolean) };
  }
  const names = [...Object.values(inst.names.bootstrap), ...Object.values(inst.names.platform), inst.names.roles, inst.names.entraPermissions, inst.names.portal, inst.names.registration, inst.names.auditAlert];
  for (const name of names) {
    const d = deploymentRead(dir, name);
    if (d) (st.deployments ??= {})[name] = d;
  }
  for (const z of inst.azureDnsZones) {
    const base = join(dir, "dns", z.name);
    if (existsSync(`${base}.exists`)) (st.dnsZones ??= {})[z.name] = { state: "exists" };
    else if (existsSync(`${base}.absent`)) (st.dnsZones ??= {})[z.name] = { state: "absent" };
    else if (existsSync(`${base}.error`)) (st.dnsZones ??= {})[z.name] = { state: "unknown", error: oneLine(text(`${base}.error`)) ?? "no answer" };
    for (const env of z.allowedEnvironments) {
      const r = join(dir, "dnsroles", z.name, env);
      const roles = ((st.dnsRoles ??= {})[z.name] ??= {});
      if (existsSync(`${r}.ok`)) roles[env] = { state: "ok", detail: oneLine(text(`${r}.ok`)) ?? "" };
      else if (existsSync(`${r}.missing`)) roles[env] = { state: "missing", detail: firstLine(text(`${r}.missing`)) ?? "" };
      else if (existsSync(`${r}.error`)) roles[env] = { state: "unknown", detail: oneLine(text(`${r}.error`)) ?? "no answer" };
    }
  }
  const ado = join(dir, "ado");
  if (existsSync(ado)) {
    const tokenError = text(join(ado, "token.error"));
    const phases: Record<string, AdoPhaseRead> = {};
    for (const phase of ["projects", "core", "config", "connections", "pipeline", "grants", "policies"]) {
      const base = join(ado, phase);
      const skipped = text(`${base}.skipped`);
      if (skipped !== undefined) {
        phases[phase] = { read: "skipped", reason: oneLine(skipped) ?? "skipped" };
        continue;
      }
      const log = text(`${base}.log`);
      if (log === undefined) continue;
      const rc = Number(firstLine(text(`${base}.rc`)) ?? "NaN");
      const rows = parseItemRows(log);
      const output = json(`${base}.json`);
      const tail = log.split(/\r?\n/).filter((l) => l.trim()).slice(-3).join(" ");
      phases[phase] = {
        read: rows.length ? "ok" : "error",
        ...(Number.isInteger(rc) ? { exitCode: rc } : {}),
        rows,
        ...(isObj(output) ? { output } : {}),
        ...(rows.length ? {} : { reason: oneLine(tail) ?? "no output" }),
      };
    }
    st.ado = tokenError !== undefined ? { token: "missing", error: oneLine(tokenError) ?? "no token", phases } : { token: "ok", phases };
  }
  const url = firstLine(text(join(dir, "portal", "url")));
  if (url) {
    const code = Number(firstLine(text(join(dir, "portal", "readyz"))) ?? "NaN");
    const err = text(join(dir, "portal", "readyz.error"));
    st.portal = { url, ...(Number.isInteger(code) ? { readyz: code } : {}), ...(err !== undefined ? { error: oneLine(err) ?? "no answer" } : {}) };
  }
  const ws = firstLine(text(join(dir, "audit-alert-workspace")));
  if (ws) st.auditAlertWorkspace = ws;
  st.apps = files(join(configDir, "apps")).filter((slug) => {
    const p = join(configDir, "apps", slug);
    return lstatSync(p).isDirectory() && !lstatSync(p).isSymbolicLink() && existsSync(join(p, "app.yaml"));
  });
  return st;
}

/** What status needs from instance.yaml (pure names: the ports of facts.ts). */
export function onboardingInstance(inst: Instance): OnboardingInstance {
  const prefix = inst.naming.prefix;
  const host = provisioningHostEnvironment(inst);
  const defaultNetwork = instanceDefault<string>("$defs/externalOnlyMode/properties/network");
  const email = inst.notifications?.email as { provider?: string; sender?: string } | undefined;
  const zoneRe = /^\/subscriptions\/[0-9a-fA-F-]{36}\/resourceGroups\/[^/]+\/providers\/Microsoft\.Network\/dnszones\/([^/]+)$/i;
  return {
    prefix,
    tenantId: (inst.tenantId ?? "").toLowerCase(),
    coreVersion: inst.coreVersion,
    host,
    environments: [...inst.environments]
      .sort((a, b) => (a.name === host ? -1 : b.name === host ? 1 : 0))
      .map((e) => ({
        name: e.name,
        subscriptionId: e.subscriptionId.toLowerCase(),
        managedNetwork: e.networkModes.externalOnly !== undefined && (e.networkModes.externalOnly.network ?? defaultNetwork) === "managed",
        hybrid: e.networkModes.externalHybrid !== undefined,
        egressBaselineActive: e.networkModes.externalHybrid?.egressBaseline?.status === "active",
      })),
    entraChanges: entraChangesMode(inst),
    ...(inst.portal?.network?.approvalReference ? { portalNetworkApproval: inst.portal.network.approvalReference } : {}),
    azureDnsZones: (inst.dns?.zones ?? [])
      .filter((z) => z.provider === "azureDns")
      .map((z) => {
        const id = z.azureDnsZoneId ?? "";
        const m = zoneRe.exec(id);
        return { name: z.name, id, idValid: !!m && m[1]!.toLowerCase() === z.name.toLowerCase(), allowedEnvironments: [...z.allowedEnvironments] };
      }),
    ...(inst.identities?.entraProvisioningPrincipalId ? { entraProvisioningPrincipalId: inst.identities.entraProvisioningPrincipalId } : {}),
    ...(inst.portal?.identityPrincipalId ? { portalIdentityPrincipalId: inst.portal.identityPrincipalId } : {}),
    ...(inst.portal?.clientId ? { portalClientId: inst.portal.clientId } : {}),
    ...(inst.portal?.apiBaseUrl ? { portalApiBaseUrl: inst.portal.apiBaseUrl } : {}),
    portalHostName: portalHost(inst).host.hostName,
    ...(email?.provider ? { email: { provider: email.provider, ...(email.sender ? { sender: email.sender } : {}) } } : {}),
    names: {
      bootstrap: Object.fromEntries(inst.environments.map((e) => [e.name, bootstrapDeployment(prefix, e.name)])),
      platform: Object.fromEntries(inst.environments.map((e) => [e.name, platformDeployment(prefix, e.name)])),
      roles: rolesDeployment(prefix),
      entraPermissions: ENTRA_PERMISSIONS_DEPLOYMENT,
      portal: portalDeployment(prefix, host),
      registration: portalEntraDeployment(host),
      auditAlert: ENTRA_AUDIT_ALERT_DEPLOYMENT,
      entraResourceGroup: entraResourceGroup(prefix),
    },
  };
}

/** The placeholders `plan` fills from instance.yaml. */
export function planContextOf(inst: Instance): PlanContext {
  const o = onboardingInstance(inst);
  return { host: o.host, prefix: o.prefix, environments: o.environments.map((e) => e.name) };
}

function langOf(v: string | undefined): Lang {
  const lang = v ?? "en";
  if (!LANG_VALUES.includes(lang)) throw new UsageError("--lang must be en or cs.");
  return lang as Lang;
}

/** `platform instance plan [--instance f] [--format text|markdown|json] [--lang en|cs] [--update <file>]` */
export function instancePlan(opts: { instance?: string; format?: string; lang?: string; update?: string }): string {
  const lang = langOf(opts.lang);
  const format = opts.format ?? "text";
  if (!["text", "markdown", "json"].includes(format)) throw new UsageError("--format must be text, markdown or json.");
  if (opts.update !== undefined) {
    if (format !== "markdown" || opts.instance) throw new UsageError("--update takes --format markdown and no --instance (the runbook's checklist is the generic plan).");
    const current = text(opts.update);
    if (current === undefined) throw new CheckFailed([`${opts.update} not found.`]);
    const next = withPlanBlock(current, planMarkdownBlock(lang));
    if (next === undefined) throw new CheckFailed([`${opts.update} has no onboarding-plan markers (<!-- onboarding-plan:start ... --> and <!-- onboarding-plan:end -->).`]);
    if (next !== current) writeFileSync(opts.update, next, "utf8");
    return `${next === current ? "unchanged" : "updated  "} ${opts.update}\n`;
  }
  const ctx = opts.instance ? planContextOf(loadInstanceFile(opts.instance)) : {};
  if (format === "json") return JSON.stringify(planJson(ctx), null, 2) + "\n";
  if (format === "markdown") return planMarkdown(lang, ctx);
  return planText(lang, ctx);
}

/** `platform instance status --instance f [--state dir] [--format text|json] [--lang en|cs]` */
export function instanceStatus(opts: { instance: string; state?: string; format?: string; lang?: string }): { text: string; report: OnboardingReport } {
  const lang = langOf(opts.lang);
  const format = opts.format ?? "text";
  if (!["text", "json"].includes(format)) throw new UsageError("--format must be text or json.");
  if (!existsSync(opts.instance)) throw new CheckFailed([`${opts.instance} not found.`]);
  let o: OnboardingInstance | undefined;
  let problems: string[] = [];
  try {
    o = onboardingInstance(loadInstanceFile(opts.instance));
  } catch (e) {
    if (!(e instanceof CheckFailed)) throw e;
    problems = e.problems;
  }
  const report = o ? evaluateOnboarding(o, opts.state ? readOnboardingState(opts.state, o, dirname(opts.instance)) : {}) : evaluateOnboarding(undefined, {}, problems);
  return { text: format === "json" ? JSON.stringify(report, null, 2) + "\n" : statusText(report, lang), report };
}
