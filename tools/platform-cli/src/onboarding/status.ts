/**
 * Where onboarding stands (`platform instance status`, ADR-0072): each step of plan.ts evaluated against what
 * instance.sh status read (OnboardingState) and instance.yaml (OnboardingInstance). Pure and browser-safe: no Node
 * imports, no I/O; src/instance/onboarding.ts reads the files.
 *
 * A step is
 *   done     its check passes (plan.ts CHECKS), or it is not needed (onlyWhen), or (a setup step) it was skipped:
 *            then `skipped` is set, and the text shows it as skipped, never as done;
 *   blocked  a step it depends on is not done (blockedBy);
 *   next     it can be done now: the exact commands (or the action) in `commands` / `action`;
 *   waiting  someone else has to act first (waitingOn), or a deployment is running;
 *   unknown  status could not read what it needs (reason says why: a login, a token, a right to read).
 * A `confirmed` step (nothing records it) is done once a step that depends on it is done; until then it waits on its
 * actor, and the steps that depend on it go on (they name it in `assumes`).
 *
 * The current step is the first one in plan order that is not done; the next step the first one that is `next`.
 */
import { CONDITIONS, PHASES, PLAN_FORMAT_VERSION, STEPS, dependentsOf, stepById } from "./plan.js";
import type { ActorId, Command, Lang, PhaseId, Step, Text } from "./plan.js";
import { commandsLine, fill, stepCommands, stepEnvironments, tr } from "./render.js";
import type { PlanContext } from "./render.js";

export const STATUS_FORMAT_VERSION = 1;

/** One row of a `platform ado bootstrap plan` (src/ado/steps.ts formatItems). */
export interface PlanRow {
  status: "create" | "update" | "ok" | "extra" | "warn" | "blocked";
  kind: string;
  text: string;
}

/** A deployment as `az deployment ... show` answered (instance.sh status). */
export interface DeploymentRead {
  /** succeeded; failed (Failed, Canceled); running (any other state); absent (not found); unknown (an error). */
  state: "succeeded" | "failed" | "running" | "absent" | "unknown";
  provisioningState?: string;
  outputs?: Record<string, unknown>;
  /** The deployment's parameter federation (bootstrap.bicep), or null. */
  federation?: unknown;
  error?: string;
}

export interface AdoPhaseRead {
  read: "ok" | "skipped" | "error";
  exitCode?: number;
  rows?: PlanRow[];
  /** The --output of the plan. */
  output?: Record<string, unknown>;
  /** Why it was skipped, or the error. */
  reason?: string;
}

/** What instance.sh status read (the state directory, src/instance/onboarding.ts). Absent parts: not read. */
export interface OnboardingState {
  azure?: { login: "ok" | "not-logged-in" | "other-tenant"; tenant?: string };
  /** Per subscription: the required resource providers it lacks, or the error of the read. */
  providers?: Record<string, { missing?: string[]; error?: string }>;
  deployments?: Record<string, DeploymentRead>;
  /** Per Azure DNS zone. */
  dnsZones?: Record<string, { state: "exists" | "absent" | "unknown"; error?: string }>;
  /** Per zone, per environment: the provisioning identity's role on it. */
  dnsRoles?: Record<string, Record<string, { state: "ok" | "missing" | "unknown"; detail?: string }>>;
  ado?: { token: "ok" | "missing"; error?: string; phases: Record<string, AdoPhaseRead> };
  portal?: { url?: string; readyz?: number; error?: string };
  /** The workspace the audit alert was read next to (--workspace, else the host's platform workspace). */
  auditAlertWorkspace?: string;
  /** Slugs of the app definitions apps/<slug>/app.yaml next to instance.yaml. */
  apps?: string[];
}

/** What status needs from instance.yaml (src/instance/onboarding.ts builds it). */
export interface OnboardingInstance {
  prefix: string;
  tenantId: string;
  coreVersion: string;
  host: string;
  environments: { name: string; subscriptionId: string; managedNetwork: boolean; hybrid: boolean; egressBaselineActive: boolean }[];
  entraChanges: "pullRequest" | "separate";
  portalNetworkApproval?: string;
  azureDnsZones: { name: string; id: string; idValid: boolean; allowedEnvironments: string[] }[];
  entraProvisioningPrincipalId?: string;
  portalIdentityPrincipalId?: string;
  portalClientId?: string;
  portalApiBaseUrl?: string;
  /** The portal's own host name through Front Door (ADR-0071); absent or "" = none. */
  portalHostName?: string;
  email?: { provider: string; sender?: string; managementScope?: string };
  /** instance.yaml setup (ADR-0073): the setup steps confirmed, and those skipped. */
  setup?: { confirmed: readonly string[]; skipped: readonly string[] };
  /** The deployment names (src/instance/facts.ts). */
  names: {
    bootstrap: Record<string, string>;
    platform: Record<string, string>;
    roles: string;
    entraPermissions: string;
    portal: string;
    registration: string;
    auditAlert: string;
    entraResourceGroup: string;
  };
}

export type StepStatus = "done" | "next" | "waiting" | "blocked" | "unknown";

export interface StepReport {
  id: string;
  phase: PhaseId;
  title: Text;
  actor: ActorId;
  status: StepStatus;
  /** Why (English). */
  reason: string;
  /** The exact commands for `next` (in order; `changes`: an --apply). */
  commands: Command[];
  /** What to do when it is no command (English, placeholders filled). */
  action?: string;
  waitingOn?: ActorId;
  blockedBy?: string[];
  /** `confirmed` steps it depends on that nothing records: assumed done. */
  assumes?: string[];
  details: string[];
  notNeeded?: true;
  /** A setup step the person skipped (instance.yaml setup.skipped): done, shown as skipped. */
  skipped?: true;
  runbook: string;
}

export interface OnboardingReport {
  formatVersion: number;
  instance?: { prefix: string; coreVersion: string };
  /** Problems of instance.yaml when it is not valid (then only B01 is evaluated). */
  problems?: string[];
  currentPhase: PhaseId | "complete";
  currentStep?: string;
  nextStep?: string;
  /** done counts the skipped steps too; skipped counts them alone. */
  phases: { id: PhaseId; title: Text; done: number; skipped: number; total: number }[];
  steps: StepReport[];
}

type Own = Pick<StepReport, "status" | "reason"> & Partial<Pick<StepReport, "commands" | "action" | "waitingOn" | "details" | "notNeeded" | "skipped">>;

const done = (reason: string, details?: string[]): Own => ({ status: "done", reason, ...(details?.length ? { details } : {}) });
const unknown = (reason: string): Own => ({ status: "unknown", reason });

class Evaluator {
  readonly ctx: PlanContext;
  constructor(
    readonly inst: OnboardingInstance,
    readonly st: OnboardingState,
  ) {
    const portalIdentity = this.hostOutput("portalIdentity");
    const pi = isObj(portalIdentity) ? portalIdentity : {};
    const values: Record<string, string> = {};
    if (typeof pi.clientId === "string") values["portal-client-id"] = pi.clientId;
    if (typeof pi.principalId === "string") values["portal-object-id"] = pi.principalId;
    if (st.portal?.url) values["portal-url"] = st.portal.url.replace(/\/+$/, "");
    else if (inst.portalApiBaseUrl) values["portal-url"] = inst.portalApiBaseUrl.replace(/\/+$/, "");
    if (inst.email?.sender) values.sender = inst.email.sender;
    if (inst.email?.managementScope) values.scope = inst.email.managementScope;
    this.ctx = { host: inst.host, prefix: inst.prefix, environments: [inst.host, ...inst.environments.map((e) => e.name).filter((n) => n !== inst.host)], values };
  }

  // --- reading ------------------------------------------------------------------------------------
  azure(): Own | undefined {
    const a = this.st.azure;
    if (!a) return unknown("Azure was not read (run instance.sh status)");
    if (a.login === "not-logged-in") return unknown(`not logged in to Azure: az login --tenant ${this.inst.tenantId}`);
    if (a.login === "other-tenant") return unknown(`logged in to tenant ${a.tenant ?? "?"}, not ${this.inst.tenantId}: az login --tenant ${this.inst.tenantId}`);
    return undefined;
  }

  deployment(name: string): DeploymentRead | undefined {
    return this.st.deployments?.[name];
  }

  outputs(name: string): Record<string, unknown> | undefined {
    const d = this.deployment(name);
    return d?.state === "succeeded" ? (d.outputs ?? {}) : undefined;
  }

  hostOutput(key: string): unknown {
    return this.outputs(this.inst.names.bootstrap[this.inst.host] ?? "")?.[key];
  }

  /** A deployment's check: done when it succeeded; next with `commands` when absent or failed. */
  deployed(name: string, commands: Command[], action?: string): Own {
    const a = this.azure();
    if (a) return a;
    const d = this.deployment(name);
    const what = { commands, ...(action ? { action } : {}) };
    if (!d) return unknown(`the deployment ${name} was not read`);
    switch (d.state) {
      case "succeeded":
        return done(`the deployment ${name} succeeded`);
      case "absent":
        return { status: "next", reason: `no deployment ${name} yet`, ...what };
      case "failed":
        return { status: "next", reason: `the deployment ${name} ended ${d.provisioningState ?? "Failed"}: run it again (its error is in the deployment's history)`, ...what };
      case "running":
        return { status: "waiting", reason: `the deployment ${name} is ${d.provisioningState ?? "running"}: wait until it ends`, waitingOn: "platformTeam" };
      default:
        return unknown(`could not read the deployment ${name}: ${d.error ?? "no answer"}`);
    }
  }

  ado(phase: string): { rows: PlanRow[]; output: Record<string, unknown> } | Own {
    const a = this.st.ado;
    if (!a) return unknown("Azure DevOps was not read (run instance.sh status)");
    if (a.token !== "ok") return unknown(`no Azure DevOps token (${a.error ?? "az login, or export AZURE_DEVOPS_TOKEN"})`);
    const p = a.phases[phase];
    if (!p) return unknown(`platform ado bootstrap plan --phase ${phase} was not read`);
    if (p.read === "skipped") return unknown(`platform ado bootstrap plan --phase ${phase} was not run: ${p.reason ?? "skipped"}`);
    if (p.read === "error" || !p.rows?.length) return unknown(`platform ado bootstrap plan --phase ${phase} failed (exit ${p.exitCode ?? "?"}): ${p.reason ?? "no rows"}`);
    return { rows: p.rows, output: p.output ?? {} };
  }

  /** instance.yaml here against the default branch: the seed row of --phase config. */
  onMain(): "yes" | "no" | Own {
    const r = this.ado("config");
    if (!("rows" in r)) return unknown(`instance.yaml could not be compared with the default branch: ${r.reason}`);
    const seed = r.rows.find((x) => x.kind === "seed");
    if (seed?.status === "ok" && /\bequals\b/.test(seed.text)) return "yes";
    if (seed && /\bdiffers\b|no instance\.yaml/.test(seed.text)) return "no";
    return unknown(`--phase config shows no comparison of instance.yaml (${seed ? seed.text : "no seed row"})`);
  }

  merged(what: string): Own {
    const m = this.onMain();
    if (m === "yes") return done(`${what}, and that instance.yaml is on the default branch`);
    if (m === "no") return { status: "waiting", reason: `${what} here, but instance.yaml on the default branch differs: complete the pull request (or update this clone)`, waitingOn: "platformTeam" };
    return m;
  }

  // --- the checks ---------------------------------------------------------------------------------
  check(step: Step): Own {
    const cmds = (envs?: readonly string[]): Command[] => stepCommands(step, this.ctx, envs);
    const action = (env?: string): string | undefined => (step.action ? fill(step.action.en, this.ctx, env) : undefined);
    const rows = (phase: string, opts: { extraNeedsApply?: boolean; blockedOk?: boolean; waitsOn?: ActorId } = {}): Own => {
      const r = this.ado(phase);
      if (!("rows" in r)) return r;
      const fmt = (x: PlanRow): string => `${x.status} ${x.kind} ${x.text}`;
      const todo = r.rows.filter((x) => x.status === "create" || x.status === "update" || (opts.extraNeedsApply && x.status === "extra"));
      const blocked = r.rows.filter((x) => x.status === "blocked");
      const notes = r.rows.filter((x) => x.status === "warn" || (!opts.extraNeedsApply && x.status === "extra")).map(fmt);
      if (todo.length) return { status: "next", reason: `--phase ${phase} has ${todo.length} row(s) to apply`, commands: cmds(), details: [...todo, ...blocked].map(fmt) };
      if (blocked.length && !opts.blockedOk) return { status: "waiting", reason: `--phase ${phase} has blocked row(s)`, waitingOn: opts.waitsOn ?? step.waitsOn ?? step.actor, details: blocked.map(fmt) };
      return done(`--phase ${phase}: nothing to apply`, notes);
    };
    const inst = this.inst;
    switch (step.done) {
      case "instance-valid":
        return done("instance.yaml is valid");
      case "confirmed":
        return { status: "waiting", reason: "nothing records it: confirm it is done, then go on", waitingOn: step.actor, ...(action() ? { action: action()! } : {}) };
      case "login": {
        const a = this.azure();
        if (a && !this.st.azure) return a;
        if (a) return { ...a, status: "next", commands: [{ run: `az login --tenant ${inst.tenantId}` }, ...cmds()] };
        const bad = Object.entries(this.st.providers ?? {}).filter(([, p]) => p.error);
        if (bad.length) return { status: "unknown", reason: "a subscription could not be read", details: bad.map(([s, p]) => `${s}: ${p.error}`) };
        return done(`logged in to ${inst.tenantId}; every environment subscription answers`);
      }
      case "providers": {
        const a = this.azure();
        if (a) return a;
        const subs = [...new Set(inst.environments.map((e) => e.subscriptionId))];
        const missing: string[] = [];
        for (const s of subs) {
          const p = this.st.providers?.[s];
          if (!p) return unknown(`the resource providers of ${s} were not read`);
          if (p.error) return unknown(`could not read the resource providers of ${s}: ${p.error}`);
          if (p.missing?.length) missing.push(`${s}: ${p.missing.join(", ")}`);
        }
        return missing.length ? { status: "next", reason: "resource providers are not registered", commands: cmds(), details: missing } : done("every resource provider is registered");
      }
      case "network-approvals": {
        const missing: string[] = [];
        if (!inst.portalNetworkApproval) missing.push("portal.network.approvalReference is not set (the portal VNet's address space)");
        const hybrid = inst.environments.filter((e) => e.hybrid && !e.egressBaselineActive);
        for (const e of hybrid) missing.push(`${e.name}: networkModes.externalHybrid.egressBaseline.status is not active (the hub connection and the egress baseline)`);
        if (!missing.length) return done("the network team's approvals are in instance.yaml");
        return { status: "waiting", reason: "the network team's approval is not in instance.yaml", waitingOn: "networkTeam", details: missing, commands: hybrid.length ? cmds(hybrid.map((e) => e.name)) : [], ...(action() ? { action: action()! } : {}) };
      }
      case "dns-zones": {
        const a = this.azure();
        if (a) return a;
        const todo: string[] = [];
        for (const z of inst.azureDnsZones) {
          if (!z.idValid) return { status: "next", reason: `the azureDnsZoneId of ${z.name} is not that zone's resource ID: correct instance.yaml (a pull request)`, commands: [] };
          const r = this.st.dnsZones?.[z.name];
          if (!r) return unknown(`the zone ${z.name} was not read`);
          if (r.state === "unknown") return unknown(`could not read the zone ${z.name}: ${r.error ?? "no answer"}`);
          if (r.state === "absent") todo.push(`${z.name}: no such zone yet`);
        }
        return todo.length ? { status: "next", reason: "an Azure DNS zone is missing", commands: cmds(), details: todo } : done("every Azure DNS zone exists");
      }
      case "ado-projects":
        return rows("projects", { waitsOn: "adoAdmins" });
      case "ado-config":
        return rows("config");
      case "core-tag": {
        const r = rows("core");
        if (r.status !== "done") return r;
        const out = this.ado("core");
        const core = "output" in out && isObj(out.output.core) ? out.output.core : {};
        if (!core.repository) return { status: "next", reason: "the platform project has no repository core", commands: cmds() };
        const tags = Array.isArray(core.tags) ? core.tags : [];
        if (!tags.includes(inst.coreVersion)) return { status: "next", reason: `core has no tag ${inst.coreVersion} (coreVersion)`, commands: cmds() };
        return done(`core has the tag ${inst.coreVersion}`, r.details);
      }
      case "bootstrap-host":
        return this.deployed(inst.names.bootstrap[inst.host]!, cmds());
      case "bootstrap-others":
      case "deployment-platform": {
        const envs = stepEnvironments(step, this.ctx) ?? [];
        const names = step.done === "bootstrap-others" ? inst.names.bootstrap : inst.names.platform;
        return this.perEnvironment(envs, (e) => this.deployed(names[e]!, cmds([e]), action(e)));
      }
      case "dns-roles": {
        const a = this.azure();
        if (a) return a;
        const missing: string[] = [];
        const grant: Command[] = [];
        for (const z of inst.azureDnsZones) {
          for (const e of z.allowedEnvironments) {
            const r = this.st.dnsRoles?.[z.name]?.[e];
            if (!r) return unknown(`the role of ${e}'s provisioning identity on ${z.name} was not read`);
            if (r.state === "unknown") return unknown(`could not read the role of ${e}'s provisioning identity on ${z.name}: ${r.detail ?? "no answer"}`);
            if (r.state === "missing") {
              missing.push(`${e} on ${z.name}`);
              if (r.detail) grant.push({ run: `az role assignment create --role "DNS Zone Contributor" --assignee-object-id ${r.detail} --assignee-principal-type ServicePrincipal --scope ${z.id}`, changes: true });
            }
          }
        }
        if (!missing.length) return done("every allowed environment's provisioning identity may write records in its zones");
        return { status: "next", reason: "a provisioning identity holds no DNS Zone Contributor, Contributor or Owner on its zone", commands: [...cmds(), ...grant], details: missing };
      }
      case "instance-principals": {
        const want = { "identities.entraProvisioningPrincipalId": principal(this.hostOutput("entraProvisioningIdentity")), "portal.identityPrincipalId": principal(this.hostOutput("portalIdentity")) };
        const have = { "identities.entraProvisioningPrincipalId": inst.entraProvisioningPrincipalId, "portal.identityPrincipalId": inst.portalIdentityPrincipalId };
        if (!want["identities.entraProvisioningPrincipalId"] || !want["portal.identityPrincipalId"]) return unknown("the host bootstrap's outputs have no principal IDs");
        const off = (Object.keys(want) as (keyof typeof want)[]).filter((k) => (have[k] ?? "").toLowerCase() !== want[k]!.toLowerCase());
        if (off.length) return { status: "next", reason: `instance.yaml lacks the bootstrap's ${off.join(" and ")}: write them, then a pull request`, commands: cmds(), details: off.map((k) => `${k}: ${have[k] ?? "unset"} -> ${want[k]}`) };
        return this.merged("instance.yaml has the bootstrap's principal IDs");
      }
      case "deployment-entra-permissions":
        return this.deployed(inst.names.entraPermissions, cmds());
      case "ado-connections": {
        const r = rows("connections", { blockedOk: true });
        if (r.status !== "done") return r;
        const out = this.ado("connections");
        const fed = "output" in out && isObj(out.output.federation) ? out.output.federation : {};
        const missing: string[] = [];
        for (const e of inst.environments) {
          const f = isObj(fed[e.name]) ? (fed[e.name] as Record<string, unknown>) : {};
          for (const k of e.name === inst.host ? ["provisioning", "adoAutomation", "entra"] : ["provisioning"]) if (!isObj(f[k])) missing.push(`${e.name}.${k}`);
        }
        if (missing.length) {
          const blocked = "rows" in out ? out.rows.filter((x) => x.status === "blocked").map((x) => `${x.status} ${x.kind} ${x.text}`) : [];
          return { status: "waiting", reason: `no issuer and subject read back for ${missing.join(", ")}`, waitingOn: step.actor, details: blocked };
        }
        return done("every service connection exists and its federation is read back", r.details);
      }
      case "bootstrap-federation": {
        const out = this.ado("connections");
        const fed = "output" in out && isObj(out.output.federation) ? out.output.federation : undefined;
        return this.perEnvironment(stepEnvironments(step, this.ctx) ?? [], (e) => {
          const name = inst.names.bootstrap[e]!;
          const d = this.deployed(name, cmds([e]));
          if (d.status !== "done") return d;
          const param = isObj(this.deployment(name)?.federation) ? (this.deployment(name)!.federation as Record<string, unknown>) : {};
          if (!isObj(param.provisioning)) return { status: "next", reason: `${name} has no federation yet (pass 1 only)`, commands: cmds([e]) };
          if (fed && isObj(fed[e])) {
            const now = fed[e] as Record<string, unknown>;
            const differs = Object.keys(now).filter((k) => isObj(now[k]) && !sameFederation(now[k], param[k]));
            if (differs.length) return { status: "next", reason: `${name} was deployed with another federation than the service connections have now (${differs.join(", ")})`, commands: cmds([e]) };
          }
          return done(`${name} has the service connections' federation${fed ? "" : " (not compared: --phase connections was not read)"}`);
        });
      }
      case "deployment-roles":
        return this.deployed(inst.names.roles, cmds());
      case "ado-pipeline": {
        const r = rows("pipeline", { extraNeedsApply: true, blockedOk: inst.entraChanges === "pullRequest" });
        if (r.status !== "done") return r;
        const out = this.ado("pipeline");
        const o = "output" in out ? out.output : {};
        const platform = isObj(o.platformPipelines) ? o.platformPipelines : {};
        const missing = [...(isObj(o.pipeline) ? [] : ["\\platform\\provisioning"]), ...(isObj(o.validationPipeline) ? [] : ["\\platform\\validation"]), ...inst.environments.filter((e) => !isObj(platform[e.name])).map((e) => `\\platform\\platform-${e.name}`)];
        if (missing.length) return { status: "next", reason: `not registered yet: ${missing.join(", ")}`, commands: cmds() };
        return done("every platform pipeline is registered", r.details);
      }
      case "ado-grants":
        return rows("grants", { waitsOn: "adoAdmins" });
      case "ado-policies":
        return rows("policies");
      case "entra-pull-request": {
        const c = rows("connections", { extraNeedsApply: true });
        if (c.status === "unknown") return c;
        const p = rows("pipeline", { extraNeedsApply: true });
        if (p.status === "unknown") return p;
        const open = [c, p].filter((x) => x.status !== "done");
        if (!open.length) return done("--phase connections and --phase pipeline: nothing to apply, the review of platform-config approves Entra changes");
        return { status: "next", reason: "the connections and pipelines don't follow the pull request review yet", commands: cmds(), details: open.flatMap((x) => x.details ?? []) };
      }
      case "deployment-audit-alert": {
        if (!this.st.auditAlertWorkspace) return unknown("the host's platform workspace is not known (its platform deployment has no logAnalyticsWorkspaceId)");
        const d = this.deployed(inst.names.auditAlert, cmds());
        return d.status === "done" ? done(`${d.reason}, next to ${this.st.auditAlertWorkspace}`) : d;
      }
      case "deployment-portal":
        return this.deployed(inst.names.portal, [], action());
      case "deployment-portal-registration":
        return this.deployed(inst.names.registration, cmds());
      case "instance-portal": {
        const reg = this.outputs(inst.names.registration);
        const clientId = typeof reg?.clientId === "string" ? reg.clientId : isObj(reg?.clientId) ? String((reg!.clientId as Record<string, unknown>).value ?? "") : "";
        if (!clientId) return unknown(`the registration ${inst.names.registration} has no output clientId`);
        const off: string[] = [];
        if ((inst.portalClientId ?? "").toLowerCase() !== clientId.toLowerCase()) off.push(`portal.clientId: ${inst.portalClientId ?? "unset"} -> ${clientId}`);
        if (!inst.portalApiBaseUrl) off.push("portal.apiBaseUrl: unset");
        if (off.length) return { status: "next", reason: "instance.yaml lacks the portal's client ID or base URL: write them, then a pull request", commands: cmds(), details: off };
        return this.merged("instance.yaml has portal.clientId and portal.apiBaseUrl");
      }
      case "portal-app": {
        const d = this.deployed(inst.names.portal, [], action());
        if (d.status !== "done") return d;
        const o = this.outputs(inst.names.portal) ?? {};
        if (o.containerApp !== null && o.containerApp !== undefined) return done("the portal's Container App is deployed (pass 2)");
        return { status: "next", reason: "the portal deployment has no Container App yet (pass 1 only)", commands: [], ...(action() ? { action: action()! } : {}) };
      }
      case "portal-ready": {
        const p = this.st.portal;
        if (!p?.url) return unknown("no portal address: portal.apiBaseUrl is not set and the portal deployment has no portalFqdn");
        if (p.error) return unknown(`could not reach ${p.url}/readyz: ${p.error}`);
        if (p.readyz === 200) return done(`${p.url}/readyz answers 200`);
        return { status: "next", reason: `${p.url}/readyz answers ${p.readyz ?? "nothing"}: find out what it waits for (infra/README.md, Portal)`, commands: cmds() };
      }
      case "first-app": {
        const apps = this.st.apps ?? [];
        if (apps.length) return done(`platform-config has apps/${apps[0]}/app.yaml: follow it on its page in the portal`);
        return { status: "next", reason: "platform-config has no app definition yet", commands: [], ...(action() ? { action: action()! } : {}) };
      }
      case "email-setting": {
        if (!inst.email) {
          const commands = (step.tasks ?? []).flatMap((t) => t.commands.map((x) => ({ ...x, run: fill(x.run, this.ctx) })));
          return { status: "next", reason: "instance.yaml has no notifications.email: the tasks below, in order", commands };
        }
        const m = this.merged(`instance.yaml has notifications.email (${inst.email.provider})`);
        return m.status === "done" ? { ...m, reason: `${m.reason}; send the test mail (Settings > Platform setup, or Settings > Notifications) if you haven't` } : m;
      }
      case "setup-step": {
        const confirmed = inst.setup?.confirmed.includes(step.id) ?? false;
        const skipped = !confirmed && (inst.setup?.skipped.includes(step.id) ?? false);
        if (!confirmed && !skipped) return { status: "next", reason: `instance.yaml setup lists ${step.id} neither as confirmed nor as skipped`, commands: [], ...(action() ? { action: action()! } : {}) };
        const m = this.merged(`instance.yaml setup.${confirmed ? "confirmed" : "skipped"} lists ${step.id}`);
        return m.status === "done" && skipped ? { ...m, skipped: true } : m;
      }
    }
  }

  /** A per-environment step: done when done in each; else the first that is next (with every such one's commands). */
  perEnvironment(envs: readonly string[], one: (env: string) => Own): Own {
    const each = envs.map((e) => ({ env: e, own: one(e) }));
    const pick = (s: StepStatus): typeof each => each.filter((x) => x.own.status === s);
    const details = each.map((x) => `${x.env}: ${x.own.status} (${x.own.reason})`);
    for (const s of ["next", "waiting", "unknown"] as const) {
      const hit = pick(s);
      if (!hit.length) continue;
      const first = hit[0]!.own;
      return {
        status: s,
        reason: hit.map((x) => `${x.env}: ${x.own.reason}`).join("; "),
        commands: hit.flatMap((x) => x.own.commands ?? []),
        ...(hit.some((x) => x.own.action) ? { action: hit.map((x) => x.own.action).filter(Boolean).join("; ") } : {}),
        ...(first.waitingOn ? { waitingOn: first.waitingOn } : {}),
        details,
      };
    }
    return done(envs.length ? `done in ${envs.join(", ")}` : "no environment", details);
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** principalId of a bootstrap output (an identityInfo object). */
function principal(v: unknown): string | undefined {
  return isObj(v) && typeof v.principalId === "string" ? v.principalId : undefined;
}

function sameFederation(a: unknown, b: unknown): boolean {
  return isObj(a) && isObj(b) && a.issuer === b.issuer && a.subject === b.subject;
}

const CONDITION_HOLDS: Record<NonNullable<Step["onlyWhen"]>, (inst: OnboardingInstance) => boolean> = {
  managedNetwork: (inst) => inst.environments.some((e) => e.managedNetwork),
  severalEnvironments: (inst) => inst.environments.length > 1,
  azureDnsZones: (inst) => inst.azureDnsZones.length > 0,
  entraChangesPullRequest: (inst) => inst.entraChanges === "pullRequest",
  portalWithoutHostName: (inst) => !inst.portalHostName,
};

/** The report: every step evaluated, in plan order. `inst` undefined: instance.yaml is not valid (`problems`). */
export function evaluateOnboarding(inst: OnboardingInstance | undefined, state: OnboardingState, problems: string[] = []): OnboardingReport {
  const own = new Map<string, Own>();
  const ev = inst ? new Evaluator(inst, state) : undefined;
  for (const step of STEPS) {
    if (!inst || !ev) {
      own.set(step.id, step.done === "instance-valid" ? { status: "next", reason: "instance.yaml is not valid", commands: stepCommands(step, {}), details: problems } : unknown("instance.yaml is not valid"));
      continue;
    }
    if (step.onlyWhen && !CONDITION_HOLDS[step.onlyWhen](inst)) {
      own.set(step.id, { status: "done", reason: `not needed: ${CONDITIONS[step.onlyWhen].en}`, notNeeded: true });
      continue;
    }
    own.set(step.id, ev.check(step));
  }
  // A confirmed step is done once a step that depends on it is done by its own check.
  for (const step of STEPS) {
    if (step.done !== "confirmed" || own.get(step.id)!.status === "done") continue;
    const by = dependentsOf(step.id).find((d) => d.done !== "confirmed" && own.get(d.id)!.status === "done" && !own.get(d.id)!.notNeeded);
    if (by) own.set(step.id, done(`${by.id} is done, so this was`));
  }
  const reports = new Map<string, StepReport>();
  for (const step of STEPS) {
    const o = own.get(step.id)!;
    const base = { id: step.id, phase: step.phase, title: step.title, actor: step.actor, runbook: step.runbook, details: o.details ?? [], commands: [] as Command[] };
    if (o.status === "done") {
      reports.set(step.id, { ...base, status: "done", reason: o.reason, ...(o.notNeeded ? { notNeeded: true as const } : {}), ...(o.skipped ? { skipped: true as const } : {}) });
      continue;
    }
    const deps = step.dependsOn.map((d) => reports.get(d)!);
    const assumed = deps.filter((d) => d.status === "waiting" && stepById(d.id)!.done === "confirmed");
    const blockers = deps.filter((d) => d.status !== "done" && !assumed.includes(d));
    if (blockers.length) {
      reports.set(step.id, { ...base, status: "blocked", reason: `waits for ${blockers.map((b) => b.id).join(", ")}`, blockedBy: blockers.map((b) => b.id) });
      continue;
    }
    reports.set(step.id, {
      ...base,
      status: o.status,
      reason: o.reason,
      commands: o.commands ?? [],
      ...(o.action ? { action: o.action } : {}),
      ...(o.status === "waiting" ? { waitingOn: o.waitingOn ?? step.actor } : {}),
      ...(assumed.length ? { assumes: assumed.map((a) => a.id) } : {}),
    });
  }
  const steps = STEPS.map((s) => reports.get(s.id)!);
  const current = steps.find((s) => s.status !== "done");
  const next = steps.find((s) => s.status === "next");
  return {
    formatVersion: STATUS_FORMAT_VERSION,
    ...(inst ? { instance: { prefix: inst.prefix, coreVersion: inst.coreVersion } } : {}),
    ...(inst ? {} : { problems }),
    currentPhase: current ? current.phase : "complete",
    ...(current ? { currentStep: current.id } : {}),
    ...(next ? { nextStep: next.id } : {}),
    phases: PHASES.map((p) => ({
      id: p.id,
      title: p.title,
      done: steps.filter((s) => s.phase === p.id && s.status === "done").length,
      skipped: steps.filter((s) => s.phase === p.id && s.skipped).length,
      total: steps.filter((s) => s.phase === p.id).length,
    })),
    steps,
  };
}

const ACTOR_EN: Record<ActorId, string> = {
  platformTeam: "the platform team",
  securityTeam: "the security team",
  subscriptionOwners: "the subscription owners",
  networkTeam: "the network team",
  identityTeam: "the identity team",
  adoAdmins: "the Azure DevOps organisation admins",
  dnsTeam: "the DNS team",
  exchangeAdmins: "the Exchange admins",
};

/** `platform instance status` as text: the current phase and step first, then every step. Titles in `lang`. */
export function statusText(r: OnboardingReport, lang: Lang): string {
  const out: string[] = [];
  const title = (id: string): string => tr(stepById(id)!.title, lang);
  const head = r.instance ? `Onboarding of ${r.instance.prefix} (core ${r.instance.coreVersion})` : "Onboarding (instance.yaml is not valid)";
  const skipped = r.steps.filter((x) => x.skipped).map((x) => x.id);
  const complete = skipped.length ? `${head}: every step is done (skipped: ${skipped.join(", ")}).` : `${head}: every step is done.`;
  out.push(r.currentPhase === "complete" ? complete : `${head}: phase ${r.currentPhase}, step ${r.currentStep} (${title(r.currentStep!)}).`);
  const s = r.steps.find((x) => x.id === r.currentStep);
  if (s && s.status !== "next") out.push(`  ${s.status}${s.waitingOn ? ` on ${ACTOR_EN[s.waitingOn]}` : ""}${s.blockedBy ? ` by ${s.blockedBy.join(", ")}` : ""}: ${s.reason}`);
  if (r.nextStep) {
    const n = r.steps.find((x) => x.id === r.nextStep)!;
    out.push(`Next: ${n.id} ${title(n.id)}: ${n.reason}`);
    if (n.action) out.push(`  ${n.action}`);
    if (n.commands.length) out.push(`  ${commandsLine(n.commands, "en", (x) => x)}`);
  }
  for (const p of r.phases) {
    out.push("", `Phase ${p.id}: ${tr(PHASES.find((x) => x.id === p.id)!.title, lang)}, ${p.done} of ${p.total} done${p.skipped ? ` (${p.skipped} skipped)` : ""}`);
    for (const step of r.steps.filter((x) => x.phase === p.id)) {
      const extra = step.status === "blocked" ? ` (waits for ${step.blockedBy!.join(", ")})` : step.status === "waiting" ? ` (on ${ACTOR_EN[step.waitingOn!]})` : step.notNeeded ? " (not needed)" : "";
      out.push(`  ${(step.skipped ? "skipped" : step.status).padEnd(8)} ${step.id}  ${title(step.id)}${extra}`);
      if (step.status === "done" || step.status === "blocked") continue;
      out.push(`           ${step.reason}`);
      for (const d of step.details) out.push(`           - ${d}`);
      if (step.assumes) out.push(`           assumes ${step.assumes.join(", ")} (status can't read it)`);
      if (step.action) out.push(`           ${step.action}`);
      for (const c of step.commands) out.push(`           $ ${c.run}`);
    }
  }
  return out.join("\n") + "\n";
}

