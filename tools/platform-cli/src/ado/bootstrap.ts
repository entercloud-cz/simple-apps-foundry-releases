import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CheckFailed, isObject, own } from "../pipeline/common.js";
import { PROVISIONING_YAML, VALIDATION_YAML, platformYaml } from "../provisioning/generate.js";
import { entraChangesMode, instanceEnvironmentsOrdered, loadAppFile, platformConfigDefaultBranch } from "../provisioning/model.js";
import type { EntraChanges, Instance, InstanceEnv } from "../provisioning/model.js";
import { API, CHECK_TYPE, HOSTED_QUEUE, NAMESPACE, POLICY_TYPE } from "./api-versions.js";
import { AdoClient, seg, valueList } from "./client.js";
import { branchToken, tagToken } from "./git.js";
import { DEFAULT_SETTINGS, PIPELINE_SETTINGS } from "./plan.js";
import {
  DELIVERY_FOLDER,
  PLATFORM_FOLDER,
  PLATFORM_TEMPLATE,
  PORTAL_REQUESTS_FOLDER,
  PROVISIONING_PIPELINE,
  PROVISIONING_TEMPLATE,
  VALIDATION_PIPELINE,
  adoEnvironment,
  adoPlatformEnvironment,
  adoPlatformPipeline,
  adoServiceConnection,
  instanceServiceConnection,
  provisioningServiceConnection,
} from "./names.js";
import { StepRunner, approvalCheck, bitNames, branchControlCheck, exclusiveLockCheck, lower, obj, requiredTemplateCheck, typeIs } from "./steps.js";
import type { DesiredCheck, Ref, ServiceConnectionOut } from "./steps.js";

/**
 * `platform ado bootstrap plan|apply --phase core|connections|pipeline|grants|policies`: the platform's own Azure
 * DevOps objects (ADR-0031, ADR-0032), run once by a human with their own token, before the
 * provisioning pipeline exists. Same rules as `platform ado plan|apply`: plan only reads, apply
 * creates and updates object by object, nothing is deleted.
 *
 *   core         the platform project's repository core (ADR-0067), which every pipeline reads at
 *                refs/tags/<coreVersion>: created when missing (empty; only instance.sh core pushes
 *                into it, never this phase); Create tag for Project Administrators only (no Create
 *                tag entry of their own for Contributors and Build Administrators on the project's
 *                repositories and on core, removed rather than denied: a group's deny beats a
 *                person's allow, and an administrator is also a Contributor; denied on core to the
 *                project's build service and Project Collection Build Service Accounts); Force push
 *                denied on each v* tag's own token for Project Valid Users and the build services
 *                (ADO-23: a deny on refs/tags itself has no effect). Needs no platform-config.
 *   connections  sc-platform-provisioning-{env} per environment, sc-platform-ado and
 *                sc-platform-entra (WIF, the bootstrap identities), each with Required template
 *                (app-provisioning.yml; the provisioning connections also platform-environment.yml,
 *                ADR-0043), Branch control (platform-config's default branch and refs/tags/v*) and
 *                Exclusive lock; sc-platform-entra never without a person's approval
 *                (approvals.entraChanges, ADR-0051): `separate` = its own Approval check
 *                (approvals.platformTeam, the requester can't approve unless
 *                approvals.allowSelfApproval; ADR-0023, ADR-0034); `pullRequest` (default) = no
 *                Approval check (an existing one is removed) while platform-config's default branch
 *                has the platform team as required reviewer of every pull request, otherwise the
 *                Approval check stays (or is created) and the row is blocked. The
 *                environment platform-{env} per environment with Approval (the same approvers, never
 *                without it), Required template (platform-environment.yml), Branch control and
 *                Exclusive lock (ADR-0043); the project's Contributors at most Reader on its
 *                environments (ADO-20: no environment created on first use). Outputs issuer and
 *                subject per connection, read back from Azure DevOps, for bootstrap pass 2 (the
 *                federated credentials).
 *   pipeline     \platform\provisioning from pipelines/provisioning.yml, \platform\validation
 *                from pipelines/validation.yml (ADR-0040; no service connection) and
 *                \platform\platform-{env} from pipelines/platform-{env}.yml (ADR-0043); each
 *                provisioning connection usable by \platform\provisioning and, only while
 *                platform-{env} has its Approval check, its environment's platform pipeline;
 *                sc-platform-ado and sc-platform-entra by \platform\provisioning only
 *                (sc-platform-entra only while it has its Approval check or, with
 *                approvals.entraChanges pullRequest, the platform team's required review of
 *                platform-config's default branch), platform-{env} by its
 *                platform pipeline only (only while it has its Approval check), the core repo open
 *                to the project's pipelines; a queueing deny for Contributors on \platform left by
 *                an older core is removed.
 *   grants       id-{prefix}-ado-automation as an organization user (Basic) and its rights (ADO-1),
 *                Create repository in the apps project included, and member of the apps project's
 *                Project Administrators (ADR-0039 H2), never of the platform project's; id-{prefix}-portal,
 *                once an organization administrator has added it, Read and Contribute to pull
 *                requests on platform-config, Create branch and Contribute below
 *                portal/requests/ (ADR-0040), View builds on \apps (ADR-0037) and \platform, Queue
 *                builds on \apps (ADR-0042: deploys from the portal), nothing else; platform-config's
 *                Permissions management setting (asserted).
 *   policies     the platform project's pipeline settings (job token scope) and its build service's
 *                rights on core and platform-config (Read only), then the branch policies of
 *                platform-config's default branch (ADR-0040): minimum reviewers, the platform team
 *                as required reviewer (again for pipelines/), build validation by
 *                \platform\validation, queued by hand.
 */

export type BootstrapPhase = "core" | "connections" | "pipeline" | "grants" | "policies";
export const BOOTSTRAP_PHASES: readonly BootstrapPhase[] = ["core", "connections", "pipeline", "grants", "policies"];

export interface IdentityOut {
  name: string;
  clientId: string;
  principalId: string;
}

/** Outputs of infra/platform/bootstrap.bicep for one environment subscription. */
export interface BootstrapOutputs {
  identitiesResourceGroup: string;
  provisioningIdentity: IdentityOut;
  adoAutomationIdentity: IdentityOut | null;
  /**
   * id-{prefix}-entra-provisioning (ADR-0023) and its deployment scope rg-{prefix}-entra: null
   * unless instanceIdentities, and absent from the outputs of older core versions.
   */
  entraProvisioningIdentity: IdentityOut | null;
  entraResourceGroup: string | null;
  /**
   * id-{prefix}-portal (ADR-0036): null unless instanceIdentities, and absent from the outputs of
   * core versions before the portal.
   */
  portalIdentity: IdentityOut | null;
  tenantId: string;
  subscriptionId: string;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * The bootstrap deployment's outputs: `az deployment sub show -n <name> --query properties.outputs`
 * ({name: {type, value}}), the whole `show` output, or the plain values.
 */
export function parseBootstrapOutputs(v: unknown, label: string): BootstrapOutputs {
  let o = v;
  if (isObject(o) && isObject(own(o, "properties")) && isObject(own(own(o, "properties") as Record<string, unknown>, "outputs"))) o = own(own(o, "properties") as Record<string, unknown>, "outputs");
  if (!isObject(o)) throw new CheckFailed([`${label} must be the bootstrap deployment's outputs (a JSON object).`]);
  const val = (k: string): unknown => {
    const e = own(o as Record<string, unknown>, k);
    return isObject(e) && Object.hasOwn(e, "type") ? (Object.hasOwn(e, "value") ? e.value : null) : e;
  };
  const problems: string[] = [];
  const ident = (k: string, optional: boolean): IdentityOut | null => {
    const x = val(k);
    if (x === null || x === undefined) {
      if (!optional) problems.push(`${label} has no ${k}.`);
      return null;
    }
    if (!isObject(x) || typeof own(x, "name") !== "string" || !GUID_RE.test(String(own(x, "clientId"))) || !GUID_RE.test(String(own(x, "principalId")))) {
      problems.push(`${label} ${k} must be { name, clientId, principalId } (GUIDs).`);
      return null;
    }
    return { name: own(x, "name") as string, clientId: own(x, "clientId") as string, principalId: own(x, "principalId") as string };
  };
  const provisioningIdentity = ident("provisioningIdentity", false);
  const adoAutomationIdentity = ident("adoAutomationIdentity", true);
  const entraProvisioningIdentity = ident("entraProvisioningIdentity", true);
  const portalIdentity = ident("portalIdentity", true);
  const entraResourceGroup = val("entraResourceGroup") ?? null;
  const tenantId = val("tenantId");
  const subscriptionId = val("subscriptionId");
  const rg = val("identitiesResourceGroup");
  if (typeof tenantId !== "string" || !GUID_RE.test(tenantId)) problems.push(`${label} tenantId must be a GUID.`);
  if (typeof subscriptionId !== "string" || !GUID_RE.test(subscriptionId)) problems.push(`${label} subscriptionId must be a GUID.`);
  if (typeof rg !== "string" || !rg) problems.push(`${label} has no identitiesResourceGroup.`);
  if (entraResourceGroup !== null && (typeof entraResourceGroup !== "string" || !entraResourceGroup)) problems.push(`${label} entraResourceGroup must be a resource group name or null.`);
  if (problems.length) throw new CheckFailed(problems);
  return {
    identitiesResourceGroup: rg as string,
    provisioningIdentity: provisioningIdentity!,
    adoAutomationIdentity,
    entraProvisioningIdentity,
    entraResourceGroup: entraResourceGroup as string | null,
    portalIdentity,
    tenantId: tenantId as string,
    subscriptionId: subscriptionId as string,
  };
}

/** Issuer and subject of a WIF service connection (a federated credential of bootstrap pass 2). */
export interface Federation {
  issuer: string;
  subject: string;
}

export interface BootstrapResult {
  organization: string;
  project: Ref;
  /** connections: one entry per platform service connection. */
  connections?: Record<string, ServiceConnectionOut & { identityClientId: string; subscriptionId: string }>;
  /**
   * connections: the `federation` parameter of infra/platform/bootstrap.bicep per environment
   * (pass 2), from the issuers and subjects above; null where a connection does not exist yet.
   */
  federation?: Record<string, { provisioning: Federation | null; adoAutomation?: Federation | null; entra?: Federation | null }>;
  pipeline?: { id: number; name: string; folder: string } | null;
  /** pipeline: \platform\validation (ADR-0040). */
  validationPipeline?: { id: number; name: string; folder: string } | null;
  /** connections: the environment platform-{env} (its Approval) per environment (ADR-0043); null until it exists. */
  platformEnvironments?: Record<string, { id: number; name: string } | null>;
  /** pipeline: \platform\platform-{env} per environment (ADR-0043). */
  platformPipelines?: Record<string, { id: number; name: string; folder: string } | null>;
  identity?: { originId: string; id: string; descriptor: string } | null;
  /** grants: id-{prefix}-portal in the organization; null while it is not (or not in the outputs). */
  portalIdentity?: { originId: string; id: string; descriptor: string } | null;
  /** core (ADR-0067): the repository (null while it doesn't exist) and its v* tags. */
  core?: { repository: Ref | null; tags: string[] };
}

/**
 * Permission names the grants and the pipeline phase need, per security namespace. `build` is the
 * automation identity's ACE on the \apps folder only; DeleteBuildDefinition there lets the delete phase
 * of a decommissioned app remove its \apps\delivery-{slug} (ADR-0056 amendment 2026-11-12, the
 * delivery pipeline's delete; Azure DevOps answers TF215106 without it). Never on \platform or the project.
 */
const NEEDED = {
  build: ["ViewBuilds", "ViewBuildDefinition", "EditBuildDefinition", "CreateBuildDefinition", "DeleteBuildDefinition", "AdministerBuildPermissions", "QueueBuilds"],
  git: ["GenericRead", "ManagePermissions", "CreateRepository"],
  project: ["GENERIC_READ"],
} as const;

/** Role scopes (securityroles) of project-level service connection and environment security. */
const ROLE_SCOPE = {
  endpoints: "distributedtask.project.serviceendpointrole",
  environments: "distributedtask.globalenvironmentreferencerole",
} as const;

/** Role scopes of ONE service connection, environment or agent queue (resource `{projectId}_{objectId}`). */
const OBJECT_ROLE_SCOPE = {
  endpoint: "distributedtask.serviceendpointrole",
  environment: "distributedtask.environmentreferencerole",
  queue: "distributedtask.agentqueuerole",
} as const;

/** The federated credentials per environment: provisioning everywhere, adoAutomation and entra in the host environment. */
type Federations = NonNullable<BootstrapResult["federation"]>[string];

/** Shown to the approvers of sc-platform-entra (ADR-0023). */
const ENTRA_APPROVAL_INSTRUCTIONS =
  "Entra app registrations (stage entra of the provisioning pipeline): check the entra_plan stage's list of registrations to deploy.";

/** Shown to the approvers of a platform environment's deployment (ADR-0043). */
const PLATFORM_APPROVAL_INSTRUCTIONS =
  "Platform environment deployment (stage deploy of \\platform\\platform-<env>): check the plan stage's summary (what changes, the what-if preview).";

/** Access levels the member entitlement API accepts as Basic or above. */
const BASIC_OR_ABOVE = ["express", "advanced"];

export class BootstrapPlanner extends StepRunner {
  readonly result: BootstrapResult;
  private platformProject!: Ref;
  private configRepo!: Ref & { defaultBranch: string };
  private coreRepo!: Ref;
  /** core: the repository core, or null while it doesn't exist (only the phase core tolerates that). */
  private coreRepoOrNull: Ref | null = null;
  private readonly envs: InstanceEnv[];
  private readonly hostEnv: InstanceEnv;
  /** approvals.entraChanges (ADR-0051). */
  private readonly entraMode: EntraChanges;

  constructor(
    client: AdoClient,
    private readonly inst: Instance & { tenantId?: string },
    apply: boolean,
    private readonly identities: Record<string, BootstrapOutputs>,
    private readonly resaveExisting = false,
    /** instance.yaml path: its apps/ directory lists the apps whose existing objects are adopted (never apps-deleted/, ADR-0061). */
    private readonly instancePath?: string,
  ) {
    super(client, apply);
    this.envs = instanceEnvironmentsOrdered(inst);
    const host = inst.portal?.hostEnvironment;
    const hostEnv = this.envs.find((e) => e.name === host);
    if (!hostEnv) throw new CheckFailed([`instance.yaml portal.hostEnvironment "${String(host)}" is not an environment of this instance.`]);
    this.hostEnv = hostEnv;
    this.entraMode = entraChangesMode(inst);
    this.result ={ organization: client.org.url, project: { id: "", name: "" } };
  }

  private get ado(): NonNullable<Instance["scm"]["azureDevOps"]> {
    const ado = this.inst.scm.azureDevOps;
    if (this.inst.scm.provider !== "azureDevOps" || !ado) throw new CheckFailed(["instance.yaml scm.provider must be azureDevOps."]);
    return ado;
  }

  /**
   * IDs every phase needs; a platform-config default branch other than the instance's fails. The phase core
   * needs the project only: its repository core may be missing (the phase creates it), and it reads no
   * platform-config.
   */
  async resolve(phase?: BootstrapPhase): Promise<void> {
    const ado = this.ado;
    this.platformProject = await this.project(ado.platformProject);
    this.result.project = this.platformProject;
    if (phase === "core") {
      const found = await this.findRepo(ado.platformProject, "core");
      this.coreRepoOrNull = found ? { id: found.id, name: found.name } : null;
      this.add({ status: "ok", kind: "project", name: `${this.platformProject.name} (${this.platformProject.id})` });
      return;
    }
    this.coreRepo = await this.repo(ado.platformProject, "core");
    this.configRepo = await this.repo(ado.platformProject, ado.platformConfigRepo ?? "platform-config");
    const want = `refs/heads/${platformConfigDefaultBranch(this.inst)}`;
    if (this.configRepo.defaultBranch !== want) {
      throw new CheckFailed([
        `${this.configRepo.name}'s default branch is ${this.configRepo.defaultBranch}, but instance.yaml says ${want} (scm.azureDevOps.platformConfigDefaultBranch): make them equal first.`,
      ]);
    }
    this.add({ status: "ok", kind: "project", name: `${this.platformProject.name} (${this.platformProject.id})` });
    this.add({ status: "ok", kind: "repository", name: `core (${this.coreRepo.id}), ${this.configRepo.name} (${this.configRepo.id}, default branch ${this.configRepo.defaultBranch})` });
  }

  // ------------------------------------------------------------------------------------------
  // core (ADR-0067)
  // ------------------------------------------------------------------------------------------

  /**
   * The repository core and its tag protection (ADR-0067, ADO-23). Every pipeline of the instance reads core at
   * refs/tags/<coreVersion> and the Required template checks pin that ref, so a tag there is never created by a
   * pipeline and never deleted or moved. The phase pushes nothing: instance.sh core pushes the release's tag, then
   * runs this phase again so the new tag gets its deny.
   */
  async core(): Promise<void> {
    const project = this.platformProject;
    let repo = this.coreRepoOrNull;
    const out: NonNullable<BootstrapResult["core"]> = { repository: repo, tags: [] };
    this.result.core = out;
    await this.step("repository", `${project.name}/core`, async () => {
      if (repo) return { status: "ok", detail: repo.id };
      return {
        status: "create",
        detail: "empty: instance.sh core pushes the release into it (ADR-0067)",
        change: async () => {
          const created = await this.client.write("POST", `${seg(project.name)}/_apis/git/repositories`, API.git, { name: "core", project: { id: project.id } });
          if (!isObject(created) || typeof own(created, "id") !== "string") throw new CheckFailed(["creating the repository returned no id."]);
          repo = { id: own(created, "id") as string, name: "core" };
          out.repository = repo;
        },
      };
    });
    const git = await this.namespaceBits("Git Repositories", NAMESPACE.gitRepositories, ["CreateTag", "ForcePush"]);
    if (!git) return;
    const createTag = git.CreateTag!;
    const forcePush = git.ForcePush!;
    const group = async (name: string): Promise<[string, string | null]> => [name, await this.identity(name, (v) => lower(own(v, "providerDisplayName")) === lower(name))];
    const contributors = await group(`[${project.name}]\\Contributors`);
    const buildAdmins = await group(`[${project.name}]\\Build Administrators`);
    const validUsers = await group(`[${project.name}]\\Project Valid Users`);
    const collectionBuild = await group(`[${this.client.org.name}]\\Project Collection Build Service Accounts`);
    const buildService: [string, string | null] = [this.buildServiceName(), await this.buildService()];
    const projectToken = `repoV2/${project.id}`;

    // Create tag for Project Administrators only: Contributors and Build Administrators inherit it from the
    // project's all-repositories entry. Their own entry is removed (allow or deny alike: a deny there would refuse
    // the administrators too, ADO-23), on the project's token and on core's.
    for (const [label, descriptor] of [contributors, buildAdmins]) {
      await this.step("repo-acl", `${label}: no Create tag entry of its own on ${project.name} (all repos) or core (Project Administrators only)`, async () => {
        if (!descriptor) throw new CheckFailed([`${label} not found.`]);
        const tokens: [string, string][] = [[`${project.name} (all repos)`, projectToken]];
        if (repo) tokens.push(["core", `repoV2/${project.id}/${repo.id}`]);
        const found: { where: string; token: string; what: string }[] = [];
        for (const [where, token] of tokens) {
          const { allow, deny } = await this.aceBits(NAMESPACE.gitRepositories, token, descriptor);
          if ((allow | deny) & createTag) found.push({ where, token, what: allow & createTag ? "allow" : "deny" });
        }
        if (!found.length) return { status: "ok" };
        return {
          status: "update",
          detail: found.map((f) => `remove its ${f.what} of CreateTag on ${f.where}`).join("; "),
          change: async () => {
            for (const f of found) {
              await this.client.write("DELETE", `_apis/permissions/${NAMESPACE.gitRepositories}/${createTag}`, API.permissions, undefined, { descriptor, token: f.token });
            }
          },
        };
      });
    }
    // The build services (every pipeline's job token) are denied it on core.
    for (const [label, descriptor] of [buildService, collectionBuild]) {
      const name = `core: Create tag denied to ${label}`;
      if (!descriptor) {
        this.add({ status: "blocked", kind: "repo-acl", name, detail: `${label} not found.` });
        continue;
      }
      if (!repo) {
        if (this.apply) this.add({ status: "blocked", kind: "repo-acl", name, detail: "the repository core doesn't exist (see its row above)." });
        else this.add({ status: "create", kind: "repo-acl", name, detail: `deny ${createTag}, once the repository exists` });
        continue;
      }
      await this.ace("repo-acl", name, NAMESPACE.gitRepositories, `repoV2/${project.id}/${repo.id}`, descriptor, { deny: createTag });
    }

    // Every v* tag: Force push (which deletes and moves a tag) denied on the tag's own token.
    if (!repo) return;
    const refs = await this.client.list(`${seg(project.name)}/_apis/git/repositories/${seg(repo.id)}/refs`, API.git, { filter: "tags/v" });
    const tags = refs
      .map((r) => (isObject(r) ? own(r, "name") : undefined))
      .filter((n): n is string => typeof n === "string" && n.startsWith("refs/tags/v"))
      .map((n) => n.slice("refs/tags/".length))
      .sort();
    out.tags = tags;
    if (!tags.length) {
      this.add({ status: "ok", kind: "tag-acl", name: "core: no v* tag yet", detail: "instance.sh core pushes the release's tag, then runs this phase again" });
      return;
    }
    const who = [validUsers, buildService, collectionBuild];
    const missing = who.filter(([, d]) => !d).map(([l]) => l);
    for (const tag of tags) {
      await this.step("tag-acl", `core refs/tags/${tag}: Force push (delete, move) denied to Project Valid Users and the build services`, async () => {
        if (missing.length) throw new CheckFailed([`${missing.join(", ")} not found.`]);
        const token = tagToken(project.id, repo!.id, tag);
        const open: string[] = [];
        for (const [, d] of who) if (!((await this.aceBits(NAMESPACE.gitRepositories, token, d!)).deny & forcePush)) open.push(d!);
        if (!open.length) return { status: "ok" };
        return {
          status: "create",
          detail: `deny ${forcePush} (${open.length} of ${who.length} entries)`,
          change: async () =>
            void (await this.client.write("POST", `_apis/accesscontrolentries/${NAMESPACE.gitRepositories}`, API.accessControl, { token, merge: true, accessControlEntries: open.map((descriptor) => ({ descriptor, allow: 0, deny: forcePush })) })),
        };
      });
    }
  }

  // ------------------------------------------------------------------------------------------
  // connections
  // ------------------------------------------------------------------------------------------

  /**
   * The checks on every platform service connection (ADR-0032).
   * Branch control's "ensure protection of branch" follows the per-app setting (off until ADO-9:
   * it needs a branch policy on platform-config's default branch).
   * TODO(verify) ADO-1: Exclusive lock on a service connection (per-app connections have none).
   */
  desiredChecks(templates: string[] = [PROVISIONING_TEMPLATE]): DesiredCheck[] {
    return [
      requiredTemplateCheck(templates.map((templatePath) => ({ repositoryType: "git" as const, repositoryName: `${this.ado.platformProject}/core`, repositoryRef: `refs/tags/${this.inst.coreVersion}`, templatePath }))),
      branchControlCheck([`refs/heads/${platformConfigDefaultBranch(this.inst)}`, "refs/tags/v*"], DEFAULT_SETTINGS.ensureProtectionOfBranch),
      exclusiveLockCheck(),
    ];
  }

  /**
   * approvals.entraChanges pullRequest (ADR-0051): sc-platform-entra may go without an Approval check
   * only while every change of platform-config is a pull request the platform team must approve: an
   * enabled, required Required reviewers policy on the default branch (scope exact, as --phase
   * policies creates it) with the team (`teamId`, an Azure DevOps identity ID) for every file, in
   * which the creator's vote counts only with approvals.allowSelfApproval. Adds the row `label`: ok
   * with the policy, or blocked with what to do. Read only.
   */
  private async entraReviewGate(teamId: string, label: string): Promise<boolean> {
    const repo = this.configRepo;
    const ref = repo.defaultBranch;
    const self = this.inst.approvals?.allowSelfApproval === true;
    let found: Record<string, unknown> | undefined;
    try {
      const all = (await this.client.list(`${seg(this.platformProject.name)}/_apis/policy/configurations`, API.policy)).filter(isObject);
      found = all.find((c) => isPlatformTeamReview(c, repo.id, ref, teamId, self));
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      this.add({ status: "blocked", kind: "policy", name: label, detail: `${e.problems.join(" ")} sc-platform-entra keeps its Approval check.` });
      return false;
    }
    if (found) {
      this.add({ status: "ok", kind: "policy", name: label, detail: `${repo.name} ${ref}: required reviewer policy ${String(own(found, "id"))} with the platform team on every pull request; sc-platform-entra needs no Approval check of its own` });
      return true;
    }
    this.add({
      status: "blocked",
      kind: "policy",
      name: label,
      detail: `approvals.entraChanges is pullRequest, but ${repo.name} ${ref} has no enabled, required reviewer policy with the platform team (approvals.platformTeam) for every file${self ? "" : " in which the creator's vote doesn't count"}: run --phase policies, then --phase connections again (or set approvals.entraChanges: separate). Until then sc-platform-entra keeps its Approval check.`,
    });
    return false;
  }

  private outputsOf(env: InstanceEnv): BootstrapOutputs {
    const o = Object.hasOwn(this.identities, env.name) ? this.identities[env.name] : undefined;
    if (!o) throw new CheckFailed([`no bootstrap outputs for ${env.name} (--identities ${env.name}=<file>).`]);
    return o;
  }

  async connections(): Promise<void> {
    const connections: NonNullable<BootstrapResult["connections"]> = {};
    const federation: NonNullable<BootstrapResult["federation"]> = {};
    this.result.connections = connections;
    this.result.federation = federation;
    const specs: { name: string; env: InstanceEnv; identity: IdentityOut | null; description: string; purpose: keyof Federations }[] = [];
    for (const env of this.envs) {
      const o = this.outputsOf(env);
      specs.push({ name: provisioningServiceConnection(env.name), env, identity: o.provisioningIdentity, description: `Provisioning of ${env.name} (managed by the platform).`, purpose: "provisioning" });
      federation[env.name] = { provisioning: null, ...(env.name === this.hostEnv.name ? { adoAutomation: null, entra: null } : {}) };
    }
    const host = this.outputsOf(this.hostEnv);
    if (!host.adoAutomationIdentity) throw new CheckFailed([`the bootstrap outputs of ${this.hostEnv.name} (portal.hostEnvironment) have no adoAutomationIdentity (instanceIdentities must be true there).`]);
    specs.push({ name: instanceServiceConnection("ado"), env: this.hostEnv, identity: host.adoAutomationIdentity, description: "Azure DevOps automation of the provisioning pipeline (managed by the platform).", purpose: "adoAutomation" });
    specs.push({ name: instanceServiceConnection("entra"), env: this.hostEnv, identity: host.entraProvisioningIdentity, description: "Entra app registrations of the provisioning pipeline (managed by the platform).", purpose: "entra" });

    for (const s of specs) {
      const tenant = this.inst.tenantId ?? "";
      const o = this.outputsOf(s.env);
      const identity = s.identity;
      if (!identity) {
        // Only the Entra identity is optional: outputs of an older core's bootstrap, or instanceIdentities false.
        this.add({ status: "blocked", kind: "service-connection", name: s.name, detail: `the bootstrap outputs of ${s.env.name} (portal.hostEnvironment) have no entraProvisioningIdentity (instanceIdentities must be true there; re-run bootstrap.bicep pass 1 with this core version).` });
        continue;
      }
      if (lower(o.tenantId) !== lower(tenant) || lower(o.subscriptionId) !== lower(s.env.subscriptionId)) {
        this.add({ status: "blocked", kind: "service-connection", name: s.name, detail: `the bootstrap outputs of ${s.env.name} are for tenant ${o.tenantId} / subscription ${o.subscriptionId}, not this instance's ${tenant} / ${s.env.subscriptionId}.` });
        continue;
      }
      // The provisioning connection of an environment also serves its platform pipeline (ADR-0043).
      const checks = this.desiredChecks(s.purpose === "provisioning" ? [PROVISIONING_TEMPLATE, PLATFORM_TEMPLATE] : [PROVISIONING_TEMPLATE]);
      let removeApproval: ((c: Record<string, unknown>) => string | undefined) | undefined;
      if (s.purpose === "entra") {
        // ADR-0023, ADR-0051: the Entra connection never exists without a human approval: its own
        // Approval check (entraChanges separate), or the required review of every platform-config
        // pull request by the platform team (pullRequest). With the approvers unresolved it is
        // neither created nor changed (an existing one is left as it is).
        const approvers = await this.resolveApprovers(this.inst.approvals?.platformTeam, `${s.name} approvers (approvals.platformTeam)`);
        if (!approvers) {
          this.add({ status: "blocked", kind: "service-connection", name: s.name, detail: `not created or changed without ${this.entraMode === "separate" ? "its Approval check" : "a person's approval"}: the approvers are unresolved (see the identity line above).` });
          continue;
        }
        const reviewed = this.entraMode === "pullRequest" && (await this.entraReviewGate(approvers[0]!, `${s.name}: approval by pull request review (approvals.entraChanges: pullRequest)`));
        if (reviewed) {
          removeApproval = (c) => (typeIs(CHECK_TYPE.approval)(c) ? "approvals.entraChanges is pullRequest: the reviewed platform-config pull request is the approval (ADR-0051)" : undefined);
        } else {
          // separate, or pullRequest without the reviewer policy: the Approval check stays (or is
          // created) until the policy exists, so no Entra change ever runs without a person's approval.
          const self = this.selfApproval(this.inst.approvals, `${s.name} approvers (self-approval)`);
          checks.unshift(approvalCheck(approvers, ENTRA_APPROVAL_INSTRUCTIONS, "the approvers are unresolved", self));
        }
      }
      let current: ServiceConnectionOut | null = null;
      await this.ensureServiceConnection(
        this.platformProject,
        { name: s.name, clientId: identity.clientId, tenantId: tenant, subscriptionId: s.env.subscriptionId, subscriptionName: `${this.inst.naming.prefix}-${s.env.name}`, description: s.description },
        (sc) => {
          current = sc;
          connections[s.name] = { ...sc, identityClientId: identity.clientId, subscriptionId: s.env.subscriptionId };
          const fed = sc.issuer && sc.subject ? { issuer: sc.issuer, subject: sc.subject } : null;
          federation[s.env.name]![s.purpose] = fed;
        },
      );
      await this.ensureChecks(this.platformProject, { type: "endpoint", id: () => (current as ServiceConnectionOut | null)?.id || null, name: s.name }, checks, removeApproval);
    }
    await this.platformEnvironments();
    await this.contributorsEnvironmentReader(this.platformProject);
  }

  /**
   * The environment platform-{env} per instance environment (ADR-0043): the deploy stage of
   * \platform\platform-{env} is a deployment job on it, so its Approval (approvals.platformTeam,
   * as on sc-platform-entra), Branch control, Required template (platform-environment.yml) and
   * Exclusive lock gate every platform deployment. Like sc-platform-entra, it is never created
   * or changed without its Approval check.
   */
  private async platformEnvironments(): Promise<void> {
    const out: NonNullable<BootstrapResult["platformEnvironments"]> = {};
    this.result.platformEnvironments = out;
    const project = this.platformProject;
    const approvers = await this.resolveApprovers(this.inst.approvals?.platformTeam, "platform-<env> approvers (approvals.platformTeam)");
    const self = this.selfApproval(this.inst.approvals, "platform-<env> approvers (self-approval)");
    for (const env of this.envs) {
      const name = adoPlatformEnvironment(env.name);
      out[env.name] = null;
      if (!approvers) {
        this.add({ status: "blocked", kind: "environment", name, detail: "not created or changed without its Approval check: the approvers are unresolved (see the identity line above)." });
        continue;
      }
      await this.step("environment", name, async () => {
        const list = valueList(await this.client.get(`${seg(project.name)}/_apis/pipelines/environments`, API.environments, { name }), "pipelines/environments");
        const existing = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
        if (existing) {
          out[env.name] = { id: Number(own(existing, "id")), name };
          return { status: "ok", detail: `id ${String(own(existing, "id"))}` };
        }
        return {
          status: "create",
          change: async () => {
            const created = await this.client.write("POST", `${seg(project.name)}/_apis/pipelines/environments`, API.environments, {
              name,
              description: `Platform environment ${env.name}: deployments of \\platform\\platform-${env.name} (managed by the platform).`,
            });
            if (!isObject(created) || typeof own(created, "id") !== "number") throw new CheckFailed([`creating environment ${name} returned no id.`]);
            out[env.name] = { id: own(created, "id") as number, name };
          },
        };
      });
      const checks = [approvalCheck(approvers, PLATFORM_APPROVAL_INSTRUCTIONS, "the approvers are unresolved", self), ...this.desiredChecks([PLATFORM_TEMPLATE])];
      await this.ensureChecks(project, { type: "environment", id: () => (out[env.name] ? String(out[env.name]!.id) : null), name }, checks);
    }
  }

  // ------------------------------------------------------------------------------------------
  // pipeline
  // ------------------------------------------------------------------------------------------

  async pipeline(): Promise<void> {
    const project = this.platformProject;
    let pipelineId: number | null = null;
    this.result.pipeline = null;
    await this.ensurePipeline(project, { name: PROVISIONING_PIPELINE, folder: PLATFORM_FOLDER, path: PROVISIONING_YAML, configRepo: this.configRepo, resave: this.resaveExisting }, (id) => {
      pipelineId = id;
      this.result.pipeline = { id, name: PROVISIONING_PIPELINE, folder: PLATFORM_FOLDER };
    });
    // \platform\validation (ADR-0040): run by the build validation policy on platform-config pull
    // requests (--phase policies). It uses no service connection: every platform connection below
    // is authorised for \platform\provisioning only, so it never gets one.
    this.result.validationPipeline = null;
    await this.ensurePipeline(project, { name: VALIDATION_PIPELINE, folder: PLATFORM_FOLDER, path: VALIDATION_YAML, configRepo: this.configRepo, resave: this.resaveExisting }, (id) => {
      this.result.validationPipeline = { id, name: VALIDATION_PIPELINE, folder: PLATFORM_FOLDER };
    });
    // \platform\platform-{env} (ADR-0043): one per environment, from pipelines/platform-{env}.yml.
    const platformIds: Record<string, number | null> = {};
    this.result.platformPipelines = {};
    for (const env of this.envs) {
      const name = adoPlatformPipeline(env.name);
      platformIds[env.name] = null;
      this.result.platformPipelines[env.name] = null;
      await this.ensurePipeline(project, { name, folder: PLATFORM_FOLDER, path: platformYaml(env.name), configRepo: this.configRepo, resave: this.resaveExisting }, (id) => {
        platformIds[env.name] = id;
        this.result.platformPipelines![env.name] = { id, name, folder: PLATFORM_FOLDER };
      });
    }
    // The environment platform-{env} holds the platform pipeline's only Approval: the provisioning
    // connection has none of its own. So the platform pipeline may use the connection and the
    // environment only while platform-{env} exists with its Approval check (as for
    // sc-platform-entra); otherwise neither is authorised for it and an earlier authorisation is
    // withdrawn. Never authorised against a missing environment, which a run could otherwise
    // create without checks (ADR-0029 item 6).
    const self = this.selfApproval(this.inst.approvals, "platform-<env> environments (self-approval)");
    const platformEnv: Record<string, { id: string | null; approved: boolean }> = {};
    for (const env of this.envs) {
      const name = adoPlatformEnvironment(env.name);
      const list = valueList(await this.client.get(`${seg(project.name)}/_apis/pipelines/environments`, API.environments, { name }), "pipelines/environments");
      const existing = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
      const id = existing ? String(own(existing, "id")) : null;
      platformEnv[env.name] = { id, approved: id !== null && (await this.hasApprovalCheck(project, id, self, "environment")) };
    }
    // Where the platform pipeline is authorised: its ID; null in a plan while it is still to be
    // created; nothing while its environment isn't approved, or when this apply couldn't create it
    // (pipelines/platform-{env}.yml not generated yet: its own row says so), so that
    // \platform\provisioning is still authorised.
    const platformPipeline = (env: string): (number | null)[] => {
      if (!platformEnv[env]!.approved) return [];
      const id = platformIds[env] ?? null;
      return id !== null ? [id] : this.apply ? [] : [null];
    };
    // The provisioning connection of an environment: \platform\provisioning and that environment's
    // platform pipeline, nothing else. sc-platform-ado and sc-platform-entra: provisioning only.
    for (const env of this.envs) {
      const name = provisioningServiceConnection(env.name);
      const sc = await this.lookupServiceConnection(project, name);
      await this.ensurePermission(project, { type: "endpoint", id: sc?.id ?? null, label: name, exclusive: true }, () => pipelineId, "run --phase connections first", () => platformPipeline(env.name));
    }
    // The environment platform-{env}: that environment's platform pipeline only.
    for (const env of this.envs) {
      const name = adoPlatformEnvironment(env.name);
      const pipeline = `${PLATFORM_FOLDER}\\${adoPlatformPipeline(env.name)}`;
      const { id: envId, approved } = platformEnv[env.name]!;
      if (!approved) {
        if (envId) await this.revokePermissions(project, { type: "environment", id: envId, label: name }, "it has no Approval check");
        const why = envId ? `it has no Approval check with an approver${self ? "" : " and requesterCannotBeApprover"}` : "it does not exist";
        this.add({ status: "blocked", kind: "pipeline-permission", name: `environment ${name}`, detail: `${why}, so ${pipeline} may use neither it nor ${provisioningServiceConnection(env.name)}: run --phase connections first (ADR-0043).` });
        continue;
      }
      if (!platformPipeline(env.name).length) {
        this.add({ status: "blocked", kind: "pipeline-permission", name: `environment ${name}`, detail: `${pipeline} does not exist (see its row above): run platform generate, commit pipelines/platform-${env.name}.yml, then run --phase pipeline again.` });
        continue;
      }
      await this.ensurePermission(project, { type: "environment", id: envId, label: name, exclusive: true }, () => platformIds[env.name] ?? null, "run --phase connections first");
    }
    const names = [instanceServiceConnection("ado"), instanceServiceConnection("entra")];
    for (const name of names) {
      const sc = await this.lookupServiceConnection(project, name);
      // sc-platform-entra is usable only while a person approves every Entra change (ADR-0033,
      // ADR-0051): its Approval check, or with approvals.entraChanges pullRequest the platform
      // team's required review of every platform-config pull request. One that lost both (the
      // check removed by hand, a failed POST right after the connection's, the policy removed)
      // loses every authorisation it had, and the phase fails.
      if (name === instanceServiceConnection("entra") && sc?.id) {
        // ADR-0034: the self-approval warn row only where the Approval check is the guard.
        const self = this.entraMode === "separate" ? this.selfApproval(this.inst.approvals, `endpoint ${name} (self-approval)`) : this.inst.approvals?.allowSelfApproval === true;
        let approved = await this.hasApprovalCheck(project, sc.id, self);
        if (!approved && this.entraMode === "pullRequest") {
          const team = await this.resolveApprovers(this.inst.approvals?.platformTeam, `endpoint ${name} reviewers (approvals.platformTeam)`);
          approved = team !== null && (await this.entraReviewGate(team[0]!, `endpoint ${name}: approval by pull request review (approvals.entraChanges: pullRequest)`));
        }
        if (!approved) {
          const why = this.entraMode === "pullRequest" ? "it has neither an Approval check nor the platform team's required review of platform-config" : "it has no Approval check";
          await this.revokePermissions(project, { type: "endpoint", id: sc.id, label: name }, why);
          this.add({
            status: "blocked",
            kind: "pipeline-permission",
            name: `endpoint ${name}`,
            detail:
              this.entraMode === "pullRequest"
                ? `${why}: run --phase policies, or --phase connections (ADR-0051).`
                : `it has no Approval check with an approver${self ? "" : " and requesterCannotBeApprover"}: run --phase connections first (ADR-0033).`,
          });
          continue;
        }
      }
      await this.ensurePermission(project, { type: "endpoint", id: sc?.id ?? null, label: name, exclusive: true }, () => pipelineId, "run --phase connections first");
    }
    // The core repo is open to every pipeline of the platform project (ADR-0031): it holds no
    // secrets, only the platform creates pipelines there, and the Required template checks pin the
    // core tag. Delivery pipelines then need no authorisation on it.
    await this.step("pipeline-permission", `repository ${project.name}/core`, async () => {
      const path = `${seg(project.name)}/_apis/pipelines/pipelinepermissions/repository/${seg(`${project.id}.${this.coreRepo.id}`)}`;
      const current = await this.client.get(path, API.pipelinePermissions);
      const all = isObject(current) ? own(current, "allPipelines") : undefined;
      if (isObject(all) && own(all, "authorized") === true) return { status: "ok", detail: "open to all pipelines of the project" };
      return { status: "update", detail: "open to all pipelines of the project", change: async () => void (await this.client.write("PATCH", path, API.pipelinePermissions, { allPipelines: { authorized: true }, pipelines: [] })) };
    });

    // Manual runs stay possible (ADR-0031): Branch control limits the platform connections to the
    // default branch, so a manual run only re-applies what was merged, and it is how a failed run is
    // retried. A Contributors deny on queueing (added by core v0.1.0-rc.5 to rc.7) also blocked the
    // platform team (sandbox, 2026-10-29); it is removed here.
    const contributors = await this.identity(`[${project.name}]\\Contributors`, (v) => own(v, "providerDisplayName") === `[${project.name}]\\Contributors`);
    const bits = await this.namespaceBits("Build", NAMESPACE.build, ["QueueBuilds"]);
    if (!bits || !contributors) return;
    const token = `${project.id}/${PLATFORM_FOLDER.replace(/^\\/, "")}`;
    await this.step("queue-acl", `${PLATFORM_FOLDER}: no queueing deny for Contributors`, async () => {
      const acls = valueList(await this.client.get(`_apis/accesscontrollists/${NAMESPACE.build}`, API.accessControl, { token, descriptors: contributors }), "accesscontrollists");
      let allow = 0;
      let deny = 0;
      for (const acl of acls) {
        const ace = isObject(acl) && isObject(own(acl, "acesDictionary")) ? Object.entries(own(acl, "acesDictionary") as Record<string, unknown>).find(([d]) => lower(d) === lower(contributors))?.[1] : undefined;
        if (isObject(ace)) {
          allow |= Number(own(ace, "allow") ?? 0);
          deny |= Number(own(ace, "deny") ?? 0);
        }
      }
      if (!(deny & bits.QueueBuilds!)) return { status: "ok" };
      return {
        status: "update",
        detail: `remove deny ${bits.QueueBuilds!}`,
        change: async () => void (await this.client.write("POST", `_apis/accesscontrolentries/${NAMESPACE.build}`, API.accessControl, { token, merge: false, accessControlEntries: [{ descriptor: contributors, allow, deny: deny & ~bits.QueueBuilds! }] })),
      };
    });
  }

  // ------------------------------------------------------------------------------------------
  // policies (ADR-0040)
  // ------------------------------------------------------------------------------------------

  /**
   * The branch policies of platform-config's default branch, so every change of platform-config,
   * the portal's requests included, is reviewed: Minimum reviewers, the platform team
   * (approvals.platformTeam) as required reviewer (once more, with its own message, for changes
   * under pipelines/: the build validation runs the pull request's own validation.yml), and a
   * required build validation by \platform\validation. Policies of other types on the branch are `extra`
   * rows, left in place. Run by a person with Edit policies (or a Project Administrator).
   */
  async policies(): Promise<void> {
    const project = this.platformProject;
    const repo = this.configRepo;
    const ref = repo.defaultBranch;
    await this.pipelineSettings();
    await this.buildServiceRights();
    const team = await this.resolveApprovers(this.inst.approvals?.platformTeam, `${repo.name} required reviewer (approvals.platformTeam)`);
    const self = this.selfApproval(this.inst.approvals, `${repo.name} pull requests (self-approval)`);
    const validation = (await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" })).find(
      (v): v is Record<string, unknown> => isObject(v) && own(v, "name") === VALIDATION_PIPELINE && own(v, "folder") === PLATFORM_FOLDER,
    );
    const validationId = validation && Number.isSafeInteger(own(validation, "id")) ? (own(validation, "id") as number) : null;
    const existing = (await this.client.list(`${seg(project.name)}/_apis/policy/configurations`, API.policy)).filter(isObject).filter((c) => own(c, "isDeleted") !== true && onBranch(c, repo.id, ref));
    const used = new Set<Record<string, unknown>>();
    for (const d of desiredPolicies({ team: team?.[0] ?? null, selfApproval: self, validationId })) {
      const found = existing.find((c) => !used.has(c) && d.match(c));
      if (found) used.add(found);
      await this.step("policy", `${repo.name} ${ref}: ${d.label}`, async () => {
        if (d.blocked) throw new CheckFailed([`${d.blocked}${found ? `; existing policy ${String(own(found, "id"))} left as it is` : ""}.`]);
        if (!found) {
          return {
            status: "create",
            detail: d.summary,
            change: async () => {
              await this.client.write("POST", `${seg(project.name)}/_apis/policy/configurations`, API.policy, {
                isEnabled: true,
                isBlocking: true,
                type: { id: d.type },
                settings: { ...d.settings, scope: [{ repositoryId: repo.id, refName: ref, matchKind: "exact" }] },
              });
            },
          };
        }
        const diffs = d.compare(found);
        if (!diffs.length) return { status: "ok", detail: `id ${String(own(found, "id"))}` };
        return {
          status: "update",
          detail: diffs.join(", "),
          change: async () => {
            const settings = { ...obj(own(found, "settings")), ...d.update(found) };
            await this.client.write("PUT", `${seg(project.name)}/_apis/policy/configurations/${seg(String(own(found, "id")))}`, API.policy, { ...found, isEnabled: true, isBlocking: true, settings });
          },
        };
      });
    }
    for (const c of existing.filter((x) => !used.has(x))) {
      const t = obj(own(c, "type"));
      this.add({ status: "extra", kind: "policy", name: `${repo.name} ${ref}: ${String(own(t, "displayName") ?? own(t, "id"))} (id ${String(own(c, "id"))})`, detail: "not managed by the platform; left in place" });
    }
  }

  /**
   * The platform project's pipeline settings that keep a job token small (Build General Settings,
   * Microsoft Learn 7.1: PATCH {project}/_apis/build/generalsettings): the token of every pipeline
   * there, \platform\validation running a pull request's own YAML included, reaches only this
   * project (enforceJobAuthScope) and the repositories the pipeline references
   * (enforceReferencedRepoScopedToken), and queue-time variables are limited (enforceSettableVar).
   * Set on apply (needs a Project Administrator); a refusal fails the row with the manual step.
   */
  private async pipelineSettings(): Promise<void> {
    const project = this.platformProject;
    const path = `${seg(project.name)}/_apis/build/generalsettings`;
    let current: unknown;
    for (const [field, name] of PIPELINE_SETTINGS) {
      await this.step("setting", `${project.name}: ${name}`, async () => {
        current ??= await this.client.get(path, API.buildGeneralSettings);
        if (isObject(current) && own(current, field) === true) return { status: "ok", detail: field };
        return {
          status: "update",
          detail: `${field} -> true`,
          change: async () => {
            try {
              await this.client.write("PATCH", path, API.buildGeneralSettings, { [field]: true });
            } catch (e) {
              if (!(e instanceof CheckFailed)) throw e;
              throw new CheckFailed([...e.problems, `Turn it on by hand: Project settings > Pipelines > Settings > ${name} (a Project Administrator).`]);
            }
          },
        };
      });
    }
  }

  /**
   * The platform project's build service ({project} Build Service ({org}), the identity of its job
   * tokens with enforceJobAuthScope) needs only Read on core and platform-config: any other bit
   * there (or on the project's or the organization's all-repositories token) would let a pipeline
   * run, \platform\validation on a pull request included, push to them. Only reported.
   * TODO(verify) PORTAL-11: Azure DevOps' default entries for the build service.
   */
  private buildServiceName(): string {
    return `${this.platformProject.name} Build Service (${this.client.org.name})`;
  }

  /** The descriptor of the platform project's build service, the identity of its pipelines' job tokens, or null. */
  private async buildService(): Promise<string | null> {
    const project = this.platformProject;
    return this.identity(this.buildServiceName(), (v) => new RegExp(`^Microsoft\\.TeamFoundation\\.ServiceIdentity;[0-9a-fA-F-]{36}:Build:${project.id}$`, "i").test(String(own(v, "descriptor"))));
  }

  private async buildServiceRights(): Promise<void> {
    const project = this.platformProject;
    const name = this.buildServiceName();
    const descriptor = await this.buildService();
    const git = await this.namespaceBits("Git Repositories", NAMESPACE.gitRepositories, ["GenericRead"]);
    if (!git) return;
    await this.step("repo-acl", `${name}: Read only on core and ${this.configRepo.name}`, async () => {
      if (!descriptor) throw new CheckFailed([`${name} not found.`]);
      const found: string[] = [];
      for (const [where, token] of [
        ["the organization (all repos)", "repoV2"],
        [`${project.name} (all repos)`, `repoV2/${project.id}`],
        ["core", `repoV2/${project.id}/${this.coreRepo.id}`],
        [this.configRepo.name, `repoV2/${project.id}/${this.configRepo.id}`],
      ] as const) {
        const { allow } = await this.aceBits(NAMESPACE.gitRepositories, token, descriptor);
        const more = allow & ~git.GenericRead!;
        if (more) found.push(`${where}: allow ${allow} (${bitNames(git, more)})`);
      }
      if (!found.length) return { status: "ok" };
      return { status: "extra", detail: `${found.join("; ")}: more than Read; remove it by hand (Project settings > Repositories > Security, ADR-0040)` };
    });
  }

  // ------------------------------------------------------------------------------------------
  // grants (ADO-1)
  // ------------------------------------------------------------------------------------------

  /**
   * An Approval check on the service connection with at least one approver, in which the requester
   * can't approve unless `selfApproval` (approvals.allowSelfApproval, ADR-0034).
   */
  private async hasApprovalCheck(project: Ref, id: string, selfApproval: boolean, resourceType: "endpoint" | "environment" = "endpoint"): Promise<boolean> {
    const list = valueList(
      await this.client.get(`${seg(project.name)}/_apis/pipelines/checks/configurations`, API.checks, { resourceType, resourceId: id, $expand: "settings" }),
      "checks/configurations",
    );
    return list.some((c) => {
      const type = isObject(c) ? own(c, "type") : undefined;
      const settings = isObject(c) ? own(c, "settings") : undefined;
      const approvers = isObject(settings) ? own(settings, "approvers") : undefined;
      return isObject(type) && own(type, "name") === "Approval" && isObject(settings) && (selfApproval || own(settings, "requesterCannotBeApprover") === true) && Array.isArray(approvers) && approvers.length > 0;
    });
  }

  private async roleExists(scope: string, role: string): Promise<boolean> {
    const list = valueList(await this.client.get(`_apis/securityroles/scopes/${seg(scope)}/roledefinitions`, API.securityRoles), "roledefinitions");
    return list.some((r) => isObject(r) && own(r, "name") === role);
  }

  async grants(): Promise<void> {
    const host = this.outputsOf(this.hostEnv);
    const sp = host.adoAutomationIdentity;
    if (!sp) throw new CheckFailed([`the bootstrap outputs of ${this.hostEnv.name} (portal.hostEnvironment) have no adoAutomationIdentity.`]);
    const project = this.platformProject;
    const ado = this.ado;
    const appProjects: Ref[] = [];
    for (const name of [...new Set([ado.appsProject, ...(ado.allowedProjects ?? [])])]) appProjects.push(await this.project(name));

    let who = await this.orgIdentity(sp.principalId);
    this.result.identity = who ? { originId: sp.principalId, id: who.id, descriptor: who.descriptor } : null;
    const resolveLater = {
      why: "after the identity is added to the organization",
      resolve: async (): Promise<string | null> => {
        who ??= await this.orgIdentity(sp.principalId);
        if (who) this.result.identity = { originId: sp.principalId, id: who.id, descriptor: who.descriptor };
        return who?.descriptor ?? null;
      },
    };

    // 1. Organization user with Basic access. TODO(verify) ADO-1: a managed identity added through
    // serviceprincipalentitlements (accountLicenseType "express" = Basic) can then use the REST API.
    await this.step("org-user", `${sp.name} (Basic)`, async () => {
      if (who) {
        const ent = await this.client.find(`_apis/serviceprincipalentitlements/${seg(who.id)}`, API.memberEntitlements, {}, "vsaex");
        const level = isObject(ent) ? own(obj(own(ent, "accessLevel")), "accountLicenseType") : undefined;
        if (typeof level === "string" && BASIC_OR_ABOVE.includes(level.toLowerCase())) return { status: "ok", detail: `${who.id}, ${String(own(obj(own(ent as Record<string, unknown>, "accessLevel")), "licenseDisplayName") ?? level)}` };
        if (ent !== undefined) throw new CheckFailed([`${sp.name} is in the organization with access level ${String(level)}; set Basic by hand.`]);
      }
      return {
        status: "create",
        detail: `service principal ${sp.principalId}, access level Basic`,
        change: async () => {
          const r = await this.client.write(
            "POST",
            "_apis/serviceprincipalentitlements",
            API.memberEntitlements,
            { accessLevel: { accountLicenseType: "express", licensingSource: "account" }, servicePrincipal: { origin: "aad", originId: sp.principalId, subjectKind: "servicePrincipal" } },
            {},
            "vsaex",
          );
          const ok = isObject(r) && (own(r, "isSuccess") === true || own(obj(own(r, "operationResult")), "isSuccess") === true);
          if (!ok) throw new CheckFailed([`adding ${sp.name} to the organization did not succeed (see Organization settings > Users).`]);
          await resolveLater.resolve();
        },
      };
    });

    // 2-3. Creator on the platform project's service connections and environments.
    for (const [kind, scope, what] of [
      ["endpoint-role", ROLE_SCOPE.endpoints, "service connections"],
      ["environment-role", ROLE_SCOPE.environments, "environments"],
    ] as const) {
      await this.step(kind, `${project.name}: ${sp.name} may create ${what} (Creator)`, async () => {
        if (!(await this.roleExists(scope, "Creator"))) throw new CheckFailed([`no role Creator in ${scope}.`]);
        const path = `_apis/securityroles/scopes/${seg(scope)}/roleassignments/resources/${seg(project.id)}`;
        const put = async (): Promise<void> => {
          await resolveLater.resolve();
          if (!who) throw new CheckFailed(["the identity still does not exist."]);
          await this.client.write("PUT", path, API.securityRoles, [{ userId: who.id, roleName: "Creator" }]);
        };
        if (!who) return { status: "create", detail: resolveLater.why, change: put };
        const list = valueList(await this.client.get(path, API.securityRoles), "securityroles");
        const a = list.find((v) => isObject(v) && lower(own(obj(own(v, "identity")), "id")) === lower(who!.id));
        const role = isObject(a) ? own(obj(own(a, "role")), "name") : undefined;
        if (role === "Creator") return { status: "ok", detail: "Creator" };
        return { status: role === undefined ? "create" : "update", ...(role !== undefined ? { detail: `${String(role)} -> Creator` } : {}), change: put };
      });
    }

    // 4. The \apps folder: create, edit, delete (decommissioning, ADR-0056) and queue delivery
    // pipelines, set their permissions, view.
    const build = await this.namespaceBits("Build", NAMESPACE.build, NEEDED.build);
    if (build) {
      const allow = NEEDED.build.reduce((acc, n) => acc | build[n]!, 0);
      // TODO(verify) ADO-1: the folder token `{projectId}/apps` and that these bits on it suffice.
      await this.ace("build-acl", `\\apps: ${sp.name} may create, edit, delete, queue and view pipelines and set their permissions`, NAMESPACE.build, `${project.id}/apps`, who?.descriptor ?? null, { allow }, resolveLater);
    }

    // 5-7. Repositories: the app repos' projects (pipeline permissions and the build service's
    // read access on app repos), the core repo (authorising pipelines on it) and platform-config
    // (the delivery pipelines' YAML).
    const git = await this.namespaceBits("Git Repositories", NAMESPACE.gitRepositories, NEEDED.git);
    if (git) {
      const manage = git.GenericRead! | git.ManagePermissions!;
      for (const p of appProjects) {
        // ADR-0039: provisioning creates app repositories, in the apps project only.
        const apps = p.name === ado.appsProject;
        const what = apps ? "read, manage permissions and create repositories" : "read and manage permissions";
        await this.ace("repo-acl", `${p.name} (all repos): ${sp.name} may ${what}`, NAMESPACE.gitRepositories, `repoV2/${p.id}`, who?.descriptor ?? null, { allow: apps ? manage | git.CreateRepository! : manage }, resolveLater);
      }
      // TODO(verify) ADO-1: authorising a pipeline on a repository resource needs Manage permissions on it.
      await this.ace("repo-acl", `${project.name}/core: ${sp.name} may read and manage permissions`, NAMESPACE.gitRepositories, `repoV2/${project.id}/${this.coreRepo.id}`, who?.descriptor ?? null, { allow: manage }, resolveLater);
      await this.ace("repo-acl", `${project.name}/${this.configRepo.name}: ${sp.name} may read`, NAMESPACE.gitRepositories, `repoV2/${project.id}/${this.configRepo.id}`, who?.descriptor ?? null, { allow: git.GenericRead! }, resolveLater);
    }

    // ADR-0039 H2: Project Administrator of the apps project, never of the platform project.
    // Authorising a delivery pipeline on an app repository needs an administrator of the
    // repository's project: Contribute, Manage permissions and Administer on the repository were
    // all refused in the sandbox (ADO-1, ADO-26), Project Administrator was enough (run 2942).
    await this.projectAdmin(appProjects.find((p) => p.name === ado.appsProject)!, sp.name, () => who, resolveLater);

    // 8. View the projects it works in (resolving projects, identities and repos).
    // TODO(verify) ADO-1: whether the role assignments above already make it a project member.
    const proj = await this.namespaceBits("Project", NAMESPACE.project, NEEDED.project);
    if (proj) {
      for (const p of [project, ...appProjects.filter((x) => x.id !== project.id)]) {
        await this.ace("project-acl", `${p.name}: ${sp.name} may view the project`, NAMESPACE.project, `$PROJECT:vstfs:///Classification/TeamProject/${p.id}`, who?.descriptor ?? null, { allow: proj.GENERIC_READ! }, resolveLater);
      }
    }

    // 9. The hosted agent queue: User, so the pipelines it creates get it as their default queue
    // (without one a pipeline doesn't load, sandbox run 2890). Contributors hold the same role.
    await this.objectRole("queue", `agent queue ${HOSTED_QUEUE}`, String(await this.hostedQueue(project)), "User", sp.name, () => who, resolveLater);

    // 10. Adoption: an app's service connections and environments that a human created before the
    // provisioning pipeline existed are invisible to the identity (Creator sees only its own), so
    // `ado apply` in the pipeline would try to create them again. Administrator on exactly those
    // objects, never project-wide: that would include the platform service connections.
    if (this.instancePath) await this.adopt(sp.name, () => who, resolveLater);

    // 11. The portal identity: Read on platform-config (ADR-0036), View and Queue builds on \apps (ADR-0037, ADR-0042)
    //     and on \platform\provisioning (ADR-0046).
    await this.portalGrants();
  }

  /**
   * id-{prefix}-portal, and nothing else:
   *   - platform-config through the Git REST API (ADR-0036, ADR-0040): Read and Contribute to pull
   *     requests on that one repository; Create branch and Contribute only on the branch folder
   *     portal/requests/ (a folder token, so the portal can't create or push other branches, and
   *     nothing on the default branch); no bypass, Edit policies or Manage permissions;
   *   - the runs of the delivery pipelines (deploy events, ADR-0037) and of \platform\provisioning
   *     (the request journey, ADR-0040): View builds on the \apps and \platform folders, inherited
   *     by every pipeline in them;
   *   - deploys people ask for in the portal (ADR-0042): Queue builds on the \apps folder, so the
   *     portal can queue a delivery pipeline (action redeploy);
   *   - "Check all apps" (ADR-0046): Queue builds on \platform\provisioning alone (its definition
   *     token), nothing else in \platform.
   *
   * An organization administrator adds the identity to the organization (Basic), as for the ADO
   * automation identity once (ADR-0022); this phase never adds it. Until then it is one blocked row,
   * and the rest of the phase goes on. Any other bit on the platform's entries (the repository, the
   * branch folder, the two pipeline folders) is removed on apply; entries on the project's and the
   * organization's all-repositories tokens, on platform-config's default branch and on the project's
   * all-pipelines token are only reported. The Git APIs answer 404 for a project the caller can't
   * see, so the identity also gets "View project-level information" (GENERIC_READ) on the platform
   * project, and no other project permission (sandbox 2026-10-30: refs of platform-config were 404
   * with the repository Read alone). TODO(verify) PORTAL-3: permissions inherited from group
   * memberships, which these ACEs don't show. TODO(verify) PORTAL-11: the refusals (other
   * branches, main, merge, policies).
   */
  private async portalGrants(): Promise<void> {
    const project = this.platformProject;
    const repo = this.configRepo;
    const portal = this.outputsOf(this.hostEnv).portalIdentity;
    const label = `${project.name}/${repo.name}`;
    const folders = [DELIVERY_FOLDER, PLATFORM_FOLDER];
    this.result.portalIdentity = null;
    if (!portal) {
      this.add({ status: "warn", kind: "identity", name: `portal identity: pull requests on ${label}, View builds on ${folders.join(" and ")}, Queue builds on ${DELIVERY_FOLDER}`, detail: `the bootstrap outputs of ${this.hostEnv.name} (portal.hostEnvironment) have no portalIdentity: re-run bootstrap.bicep with this core version (ADR-0036); nothing granted to the portal.` });
      return;
    }
    const notInOrg = `not in the organization yet: an organization administrator must add ${portal.name} first (Organization settings > Users, access level Basic; ADR-0036), then run --phase grants again.`;
    const who = await this.orgIdentity(portal.principalId);
    if (!who) {
      this.add({ status: "blocked", kind: "org-user", name: portal.name, detail: notInOrg });
      return;
    }
    this.result.portalIdentity = { originId: portal.principalId, id: who.id, descriptor: who.descriptor };

    // Only checked, never changed: Git repositories of a private project need Basic (Stakeholder
    // has no Repos access; PORTAL-3).
    let member = false;
    await this.step("org-user", `${portal.name} (in the organization)`, async () => {
      const ent = await this.client.find(`_apis/serviceprincipalentitlements/${seg(who.id)}`, API.memberEntitlements, {}, "vsaex");
      if (!isObject(ent)) throw new CheckFailed([notInOrg]);
      const level = own(obj(own(ent, "accessLevel")), "accountLicenseType");
      if (typeof level !== "string" || !BASIC_OR_ABOVE.includes(level.toLowerCase())) {
        throw new CheckFailed([`${portal.name} has access level ${String(level)}; reading Git repositories needs Basic: an organization administrator sets it (ADR-0036).`]);
      }
      member = true;
      return { status: "ok", detail: `${who.id}, ${String(own(obj(own(ent, "accessLevel")), "licenseDisplayName") ?? level)}` };
    });
    if (!member) return;

    const proj = await this.namespaceBits("Project", NAMESPACE.project, NEEDED.project);
    if (proj) {
      await this.ace("project-acl", `${project.name}: ${portal.name} may view the project (View project-level information)`, NAMESPACE.project, `$PROJECT:vstfs:///Classification/TeamProject/${project.id}`, who.descriptor, { allow: proj.GENERIC_READ! });
    }

    const git = await this.namespaceBits("Git Repositories", NAMESPACE.gitRepositories, ["GenericRead", "GenericContribute", "CreateBranch", "PullRequestContribute", "ManagePermissions"]);
    if (git) {
      const folder = branchToken(project.id, repo.id, PORTAL_REQUESTS_FOLDER);
      await this.onlyAce("repo-acl", `${label}: ${portal.name} may read and contribute to pull requests (only these)`, NAMESPACE.gitRepositories, `repoV2/${project.id}/${repo.id}`, who.descriptor, git, ["GenericRead", "PullRequestContribute"], "ADR-0040");
      await this.onlyAce("branch-acl", `${label} ${PORTAL_REQUESTS_FOLDER}/: ${portal.name} may create branches and push there (only these)`, NAMESPACE.gitRepositories, folder, who.descriptor, git, ["CreateBranch", "GenericContribute"], "ADR-0040");
      await this.noAce("repo-acl", `${project.name} (all repos), the organization (all repos) and ${label} ${repo.defaultBranch}: ${portal.name} has no Git permission`, NAMESPACE.gitRepositories, [[`${project.name} (all repos)`, `repoV2/${project.id}`], ["the organization (all repos)", "repoV2"], [`${repo.defaultBranch}`, branchToken(project.id, repo.id, repo.defaultBranch)]], who.descriptor, git, `ADR-0040: pull requests on ${repo.name} and branches below ${PORTAL_REQUESTS_FOLDER}/ only`);
      await this.permissionsManagement(label, folder, who.descriptor, git);
    }

    // View builds (ViewBuilds) on \apps and \platform: GET of a run (its `definition` reference
    // names the pipeline and folder), its timeline and its artifacts. Queue builds (QueueBuilds) and
    // View build pipeline (ViewBuildDefinition) on \apps only: the Runs API for a deploy someone
    // asked for in the portal (ADR-0042) resolves the pipeline first, and without
    // ViewBuildDefinition it answered 404 in the sandbox (PORTAL-16, 2026-11-01). The delivery
    // template decides what a run may do (ADR-0029). In \platform the portal may queue only
    // \platform\provisioning (ADR-0046, provisioningQueueGrant), never \platform\validation. Folder
    // tokens as for the automation identity (`{projectId}/apps`). TODO(verify) PORTAL-9: those reads
    // succeed with ViewBuilds alone, other folders are refused. TODO(verify) PORTAL-16: \platform
    // pipelines other than provisioning can't be queued (PROV-PAR-5: provisioning can).
    const build = await this.namespaceBits("Build", NAMESPACE.build, ["ViewBuilds", "ViewBuildDefinition", "QueueBuilds"]);
    if (build) {
      await this.onlyAce("build-acl", `${DELIVERY_FOLDER}: ${portal.name} may view and queue builds (View builds, View build pipeline and Queue builds only)`, NAMESPACE.build, `${project.id}/${DELIVERY_FOLDER.replace(/^\\/, "")}`, who.descriptor, build, ["ViewBuilds", "ViewBuildDefinition", "QueueBuilds"], "ADR-0037, ADR-0042");
      await this.onlyAce("build-acl", `${PLATFORM_FOLDER}: ${portal.name} may view builds (View builds only)`, NAMESPACE.build, `${project.id}/${PLATFORM_FOLDER.replace(/^\\/, "")}`, who.descriptor, build, ["ViewBuilds"], "ADR-0040");
      await this.provisioningQueueGrant(project, who.descriptor, portal.name, build);
      await this.noAce("build-acl", `${project.name} (all pipelines): ${portal.name} has no build permission`, NAMESPACE.build, [[`${project.name} (all pipelines)`, project.id]], who.descriptor, build, `ADR-0037, ADR-0040, ADR-0042, ADR-0046: View builds on ${folders.join(" and ")}, Queue builds on ${DELIVERY_FOLDER} and ${PLATFORM_FOLDER}\\${PROVISIONING_PIPELINE} only`);
    }
  }

  /**
   * "Check all apps" in the portal (ADR-0046): the portal queues \platform\provisioning with the
   * parameter scope: all, through the Runs API like a redeploy (ADR-0042), which resolves the
   * pipeline first (View build pipeline). So the portal identity gets View builds, View build
   * pipeline and Queue builds on that one definition (token {projectId}/platform/{definitionId}),
   * nothing on \platform\validation. A queued run can't do more than a merge: the run provisions
   * only platform-config's default branch (validate-run), every platform service connection has
   * Branch control and Required template, and the parameter only widens the run. The pipeline is
   * created by the phase `pipeline`; until then this is a blocked row.
   */
  private async provisioningQueueGrant(project: Ref, descriptor: string, portalName: string, build: Record<string, number>): Promise<void> {
    const list = await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" });
    const found = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === PROVISIONING_PIPELINE && own(v, "folder") === PLATFORM_FOLDER);
    const id = found ? own(found, "id") : undefined;
    const label = `${PLATFORM_FOLDER}\\${PROVISIONING_PIPELINE}: ${portalName} may view and queue it (View builds, View build pipeline and Queue builds only; "Check all apps")`;
    if (typeof id !== "number" || !Number.isSafeInteger(id)) {
      this.add({ status: "warn", kind: "build-acl", name: label, detail: "the pipeline doesn't exist yet: run --phase pipeline first, then --phase grants again." });
      return;
    }
    await this.onlyAce("build-acl", label, NAMESPACE.build, `${project.id}/${PLATFORM_FOLDER.replace(/^\\/, "")}/${id}`, descriptor, build, ["ViewBuilds", "ViewBuildDefinition", "QueueBuilds"], "ADR-0046");
  }

  /**
   * platform-config's repository setting "Permissions management" gives a branch's creator Manage
   * permissions on it; for the portal it must be off (ADR-0040). Azure DevOps documents the setting
   * only in the web portal (Microsoft Learn, "Set Git repository settings", checked 2026-10-30): no
   * REST API or az command, so it is a `warn` row with the manual step and never changed here. Its
   * effect is checked: Manage permissions of the portal on a branch below portal/requests/ (the
   * entries Azure DevOps writes for a branch's creator) is an `extra` row and removed on apply.
   */
  private async permissionsManagement(label: string, folder: string, descriptor: string, git: Record<string, number>): Promise<void> {
    const mp = git.ManagePermissions!;
    const manual = `Project settings > Repositories > ${this.configRepo.name} > Settings > Permissions management: Off (no documented API; set by hand, ADR-0040)`;
    await this.step("repo-setting", `${label}: Permissions management off (a branch creator gets no Manage permissions)`, async () => {
      const acls = valueList(await this.client.get(`_apis/accesscontrollists/${NAMESPACE.gitRepositories}`, API.accessControl, { token: folder, descriptors: descriptor, recurse: "true" }), "accesscontrollists");
      const found: { token: string; allow: number; deny: number }[] = [];
      for (const acl of acls) {
        const token = isObject(acl) ? own(acl, "token") : undefined;
        const dict = isObject(acl) ? own(acl, "acesDictionary") : undefined;
        if (typeof token !== "string" || token === folder || !token.startsWith(folder) || !isObject(dict)) continue;
        for (const [d, ace] of Object.entries(dict)) {
          if (lower(d) !== lower(descriptor) || !isObject(ace)) continue;
          const allow = Number(own(ace, "allow") ?? 0);
          if (allow & mp) found.push({ token, allow, deny: Number(own(ace, "deny") ?? 0) });
        }
      }
      if (!found.length) return { status: "warn", detail: `check it: ${manual}` };
      return {
        status: "extra",
        detail: `the portal has Manage permissions on ${found.length} branch(es) below ${PORTAL_REQUESTS_FOLDER}/, so the setting is on: removed from those branches; turn it off: ${manual}`,
        change: async () => {
          for (const f of found) {
            await this.client.write("POST", `_apis/accesscontrolentries/${NAMESPACE.gitRepositories}`, API.accessControl, { token: f.token, merge: false, accessControlEntries: [{ descriptor, allow: f.allow & ~mp, deny: f.deny }] });
          }
        },
      };
    });
  }

  /**
   * An entry the platform owns completely: exactly the bits `names` for `descriptor` on `token`.
   * Missing: created (merge). Other allowed bits: `extra`, cut back on apply (merge false, denies
   * kept). An explicit deny of a wanted bit: blocked, never overwritten.
   */
  private async onlyAce(kind: string, name: string, namespace: string, token: string, descriptor: string, bits: Record<string, number>, names: string[], why: string): Promise<void> {
    const want = names.reduce((acc, n) => acc | bits[n]!, 0);
    const write = async (merge: boolean, deny: number): Promise<void> => {
      await this.client.write("POST", `_apis/accesscontrolentries/${namespace}`, API.accessControl, { token, merge, accessControlEntries: [{ descriptor, allow: want, deny }] });
    };
    await this.step(kind, name, async () => {
      const { allow, deny } = await this.aceBits(namespace, token, descriptor);
      if (deny & want) throw new CheckFailed([`an explicit deny (${deny}) blocks ${bitNames(bits, deny & want)}; remove it by hand.`]);
      const extra = allow & ~want;
      if (extra) return { status: "extra", detail: `allow ${allow}: remove ${bitNames(bits, extra)} (${names.join(", ")} only, ${why})`, change: async () => write(false, deny) };
      if ((allow & want) === want) return { status: "ok", detail: `allow ${allow}, deny ${deny}` };
      return { status: "create", detail: `allow ${want}${allow ? ` (has ${allow})` : ""}`, change: async () => write(true, 0) };
    });
  }

  /** Broader tokens on which the platform grants `descriptor` nothing: only reported, never changed. */
  private async noAce(kind: string, name: string, namespace: string, tokens: [string, string][], descriptor: string, bits: Record<string, number>, why: string): Promise<void> {
    await this.step(kind, name, async () => {
      const found: string[] = [];
      for (const [where, t] of tokens) {
        const { allow } = await this.aceBits(namespace, t, descriptor);
        if (allow) found.push(`${where}: allow ${allow} (${bitNames(bits, allow)})`);
      }
      if (!found.length) return { status: "ok" };
      return { status: "extra", detail: `${found.join("; ")}: not granted by the platform; remove it by hand (${why})` };
    });
  }

  /**
   * The organization-level Administer entry of one service connection. Its creator gets it with the
   * connection; the per-object Administrator role does not set it, but updating the connection's
   * checks needs it (sandbox run 2890: 403 on adopted connections, the created ones had it).
   */
  /** `spName` in [{project}]\Project Administrators (a Graph membership; ADR-0039 H2). Never removed here. */
  private async projectAdmin(p: Ref, spName: string, who: () => { subjectDescriptor: string } | null, later: { why: string; resolve: () => Promise<string | null> }): Promise<void> {
    await this.step("project-admin", `${p.name}: ${spName} is a Project Administrator (ADR-0039 H2)`, async () => {
      const scope = await this.client.get(`_apis/graph/descriptors/${seg(p.id)}`, API.graph, {}, "vssps");
      const scopeDescriptor = isObject(scope) ? own(scope, "value") : undefined;
      if (typeof scopeDescriptor !== "string") throw new CheckFailed([`no Graph descriptor for the project ${p.name}.`]);
      const groups = await this.client.list("_apis/graph/groups", API.graph, { scopeDescriptor }, "vssps");
      const admins = groups.find((g) => isObject(g) && lower(own(g, "principalName")) === lower(`[${p.name}]\\Project Administrators`));
      const container = isObject(admins) ? own(admins, "descriptor") : undefined;
      if (typeof container !== "string") throw new CheckFailed([`no group [${p.name}]\\Project Administrators.`]);
      const add = async (): Promise<void> => {
        await later.resolve();
        const w = who();
        if (!w) throw new CheckFailed(["the identity still does not exist."]);
        await this.client.write("PUT", `_apis/graph/memberships/${seg(w.subjectDescriptor)}/${seg(container)}`, API.graph, undefined, {}, "vssps");
      };
      const w = who();
      if (!w) return { status: "create", detail: later.why, change: add };
      const member = await this.client.find(`_apis/graph/memberships/${seg(w.subjectDescriptor)}/${seg(container)}`, API.graph, {}, "vssps");
      return member !== undefined ? { status: "ok", detail: "member" } : { status: "create", change: add };
    });
  }

  private async endpointAdminAce(name: string, id: string, spName: string, who: () => { descriptor: string } | null, later: { why: string; resolve: () => Promise<string | null> }): Promise<void> {
    const bits = await this.namespaceBits("Service Endpoints", NAMESPACE.serviceEndpoints, ["Administer"]);
    if (!bits) return;
    await this.ace("adopt", `${name}: ${spName} may administer it (organization level)`, NAMESPACE.serviceEndpoints, `endpoints/Collection/${id}`, who()?.descriptor ?? null, { allow: bits.Administer! }, later);
  }

  private async adopt(spName: string, who: () => { id: string; descriptor: string } | null, later: { why: string; resolve: () => Promise<string | null> }): Promise<void> {
    const project = this.platformProject;
    const appsDir = join(this.instancePath!, "..", "apps");
    const slugs = existsSync(appsDir)
      ? readdirSync(appsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(appsDir, d.name, "app.yaml"))).map((d) => d.name).sort()
      : [];
    for (const slug of slugs) {
      let envNames: string[];
      try {
        envNames = Object.keys(loadAppFile(join(appsDir, slug, "app.yaml"), this.instancePath!).environments ?? {});
      } catch (e) {
        if (!(e instanceof CheckFailed)) throw e;
        this.add({ status: "blocked", kind: "adopt", name: slug, detail: `apps/${slug}/app.yaml is invalid: ${e.problems[0] ?? ""}` });
        continue;
      }
      for (const env of envNames) {
        const scName = adoServiceConnection(slug, env);
        const scs = valueList(await this.client.get(`${seg(project.name)}/_apis/serviceendpoint/endpoints`, API.serviceEndpoints, { endpointNames: scName }), "serviceendpoint/endpoints");
        const sc = scs.find((v) => isObject(v) && own(v, "name") === scName);
        if (isObject(sc) && typeof own(sc, "id") === "string") {
          await this.objectRole("endpoint", scName, own(sc, "id") as string, "Administrator", spName, who, later);
          await this.endpointAdminAce(scName, own(sc, "id") as string, spName, who, later);
        }
        const envName = adoEnvironment(slug, env);
        const envs = valueList(await this.client.get(`${seg(project.name)}/_apis/pipelines/environments`, API.environments, { name: envName }), "environments");
        const e = envs.find((v) => isObject(v) && own(v, "name") === envName);
        if (isObject(e) && Number.isSafeInteger(own(e, "id"))) await this.objectRole("environment", envName, String(own(e, "id")), "Administrator", spName, who, later);
      }
    }
  }

  private async objectRole(type: keyof typeof OBJECT_ROLE_SCOPE, name: string, id: string, roleName: "Administrator" | "User", spName: string, who: () => { id: string } | null, later: { why: string; resolve: () => Promise<string | null> }): Promise<void> {
    const project = this.platformProject;
    await this.step(type === "queue" ? "queue-role" : "adopt", `${name}: ${spName} is ${roleName}`, async () => {
      const path = `_apis/securityroles/scopes/${OBJECT_ROLE_SCOPE[type]}/roleassignments/resources/${seg(`${project.id}_${id}`)}`;
      const put = async (): Promise<void> => {
        await later.resolve();
        const w = who();
        if (!w) throw new CheckFailed(["the identity still does not exist."]);
        await this.client.write("PUT", path, API.securityRoles, [{ userId: w.id, roleName }]);
      };
      const w = who();
      if (!w) return { status: "create", detail: later.why, change: put };
      const list = valueList(await this.client.get(path, API.securityRoles), "securityroles");
      const a = list.find((v) => isObject(v) && lower(own(obj(own(v, "identity")), "id")) === lower(w.id));
      const role = isObject(a) ? own(obj(own(a, "role")), "name") : undefined;
      if (role === roleName || (roleName === "User" && role === "Administrator")) return { status: "ok", ...(role !== roleName ? { detail: String(role) } : {}) };
      return { status: role === undefined ? "create" : "update", ...(role !== undefined ? { detail: `${String(role)} -> ${roleName}` } : {}), change: put };
    });
  }
}

/** A policy configuration scoped to exactly `ref` of the repository (matchKind exact). */
function onBranch(c: Record<string, unknown>, repoId: string, ref: string): boolean {
  const scope = own(obj(own(c, "settings")), "scope");
  return Array.isArray(scope) && scope.some((x) => isObject(x) && lower(own(x, "repositoryId")) === lower(repoId) && own(x, "refName") === ref && lower(own(x, "matchKind")) === "exact");
}

/**
 * The platform team's required review of every pull request into `ref` (ADR-0040, the guard of
 * approvals.entraChanges pullRequest, ADR-0051): a Required reviewers policy, enabled and blocking,
 * scoped to exactly `ref` of the repository, with `teamId` among its reviewers, for every file, and
 * the creator's vote not counting unless `selfApproval`.
 */
export function isPlatformTeamReview(c: Record<string, unknown>, repoId: string, ref: string, teamId: string, selfApproval: boolean): boolean {
  if (own(c, "isDeleted") === true || own(c, "isEnabled") !== true || own(c, "isBlocking") !== true) return false;
  if (lower(own(obj(own(c, "type")), "id")) !== POLICY_TYPE.requiredReviewers || !onBranch(c, repoId, ref)) return false;
  const s = obj(own(c, "settings"));
  const ids = own(s, "requiredReviewerIds");
  const files = own(s, "filenamePatterns");
  if (!Array.isArray(ids) || !ids.some((x) => lower(x) === lower(teamId))) return false;
  if (Array.isArray(files) && files.length > 0) return false;
  return selfApproval || own(s, "creatorVoteCounts") !== true;
}

interface DesiredPolicy {
  label: string;
  type: string;
  summary: string;
  settings: Record<string, unknown>;
  /** A reason the policy can't be planned (unresolved group, missing pipeline): blocked. */
  blocked?: string;
  match: (c: Record<string, unknown>) => boolean;
  compare: (c: Record<string, unknown>) => string[];
  /** The settings an update writes (merged over the existing ones; scope and others kept). */
  update: (c: Record<string, unknown>) => Record<string, unknown>;
}

const typeOf = (c: Record<string, unknown>): string => lower(own(obj(own(c, "type")), "id"));
const settings = (c: Record<string, unknown>): Record<string, unknown> => obj(own(c, "settings"));
const blocking = (c: Record<string, unknown>): string[] => [...(own(c, "isEnabled") === true ? [] : ["enable it"]), ...(own(c, "isBlocking") === true ? [] : ["make it required"])];
const allFiles = (c: Record<string, unknown>): string[] => {
  const f = own(settings(c), "filenamePatterns");
  return Array.isArray(f) && f.length ? ["filenamePatterns -> all files"] : [];
};

/**
 * How long a build validation result stays valid after the target branch changed (minutes; the
 * web portal's default "after 12 hours").
 */
const VALID_MINUTES = 720;

/** Path filter of platform-config's pipeline files (Learn: patterns starting with `/` are from the root). */
const PIPELINES_PATTERN = "/pipelines/*";
const PIPELINES_MESSAGE =
  "This pull request changes pipelines/. The build validation ran this pull request's own pipelines/validation.yml, so its result proves nothing here: review the pipeline files themselves (ADR-0040).";

/**
 * The policies of ADR-0040 decision 3, and a required review of changes under pipelines/. Setting names from Microsoft Learn (Policy
 * Configurations - Create samples: minimumApproverCount, creatorVoteCounts, requiredReviewerIds,
 * buildDefinitionId, filenamePatterns). TODO(verify) PORTAL-11: resetOnSourcePush, blockLastPusherVote (the most
 * recent pusher can't approve), allowDownvotes, the build policy's queueOnSourceUpdateOnly,
 * manualQueueOnly and validDuration (720 = the UI default "after 12 hours if main was updated"),
 * and creatorVoteCounts on the required reviewer policy.
 *
 * With approvals.allowSelfApproval (one operator, ADR-0034) the last pusher may approve too: the operator
 * pushes their own break-glass pull requests and is the only reviewer. Otherwise the last pusher can't.
 * The build validation is queued by hand (manualQueueOnly): it runs the pull request's own
 * pipelines/validation.yml, so a request branch the portal pushed must not run before a person
 * has read it. It stays required: no completion without a passing run.
 */
export function desiredPolicies(o: { team: string | null; selfApproval: boolean; validationId: number | null }): DesiredPolicy[] {
  const self = o.selfApproval;
  const selfText = self ? "the requester can approve (approvals.allowSelfApproval)" : "the requester can't approve";
  return [
    {
      label: "Minimum reviewers",
      type: POLICY_TYPE.minimumReviewers,
      summary: `at least 1, ${selfText}, votes reset on push, ${self ? "the last pusher can approve (single operator)" : "the last pusher can't approve"}`,
      settings: { minimumApproverCount: 1, creatorVoteCounts: self, allowDownvotes: false, resetOnSourcePush: true, blockLastPusherVote: !self },
      match: (c) => typeOf(c) === POLICY_TYPE.minimumReviewers,
      compare: (c) => {
        const s = settings(c);
        const n = own(s, "minimumApproverCount");
        return [
          ...blocking(c),
          ...(typeof n === "number" && n >= 1 ? [] : ["minimumApproverCount -> 1"]),
          ...(own(s, "creatorVoteCounts") === self ? [] : [`creatorVoteCounts -> ${String(self)}`]),
          ...(own(s, "allowDownvotes") === true ? ["allowDownvotes -> false"] : []),
          ...(own(s, "resetOnSourcePush") === true ? [] : ["resetOnSourcePush -> true"]),
          ...(own(s, "blockLastPusherVote") === !self ? [] : [`blockLastPusherVote -> ${String(!self)}`]),
        ];
      },
      // A stricter count (2 reviewers for a production instance) is kept.
      update: (c) => {
        const n = own(settings(c), "minimumApproverCount");
        return { minimumApproverCount: typeof n === "number" && n >= 1 ? n : 1, creatorVoteCounts: self, allowDownvotes: false, resetOnSourcePush: true, blockLastPusherVote: !self };
      },
    },
    // First, so the general policy below never takes it: changes under pipelines/ get their own
    // required review, because \platform\validation runs the pull request's own validation.yml, so
    // its result proves nothing for such a change (ADR-0040).
    {
      label: `Required reviewer approvals.platformTeam for ${PIPELINES_PATTERN}`,
      type: POLICY_TYPE.requiredReviewers,
      summary: `the platform team group ${o.team ?? "?"} on changes of ${PIPELINES_PATTERN}, ${selfText}`,
      settings: { requiredReviewerIds: o.team ? [o.team] : [], filenamePatterns: [PIPELINES_PATTERN], creatorVoteCounts: self, message: PIPELINES_MESSAGE },
      ...(o.team ? {} : { blocked: "the platform team group is unresolved (see the identity line above)" }),
      match: (c) => {
        const ids = own(settings(c), "requiredReviewerIds");
        const f = own(settings(c), "filenamePatterns");
        return typeOf(c) === POLICY_TYPE.requiredReviewers && Array.isArray(f) && f.includes(PIPELINES_PATTERN) && (o.team === null || (Array.isArray(ids) && ids.some((x) => lower(x) === lower(o.team))));
      },
      compare: (c) => {
        const f = own(settings(c), "filenamePatterns");
        return [
          ...blocking(c),
          ...(Array.isArray(f) && f.length === 1 ? [] : [`filenamePatterns -> ${PIPELINES_PATTERN}`]),
          ...(own(settings(c), "creatorVoteCounts") === self ? [] : [`creatorVoteCounts -> ${String(self)}`]),
          ...(own(settings(c), "message") === PIPELINES_MESSAGE ? [] : ["message"]),
        ];
      },
      update: () => ({ filenamePatterns: [PIPELINES_PATTERN], creatorVoteCounts: self, message: PIPELINES_MESSAGE }),
    },
    {
      label: "Required reviewer approvals.platformTeam",
      type: POLICY_TYPE.requiredReviewers,
      summary: `the platform team group ${o.team ?? "?"} on every pull request, ${selfText}`,
      settings: { requiredReviewerIds: o.team ? [o.team] : [], creatorVoteCounts: self, message: "The platform team reviews every change of platform-config (ADR-0040)." },
      ...(o.team ? {} : { blocked: "the platform team group is unresolved (see the identity line above)" }),
      match: (c) => {
        const ids = own(settings(c), "requiredReviewerIds");
        // Unresolved team: the first such policy is matched, so it is "left as it is", never extra.
        return typeOf(c) === POLICY_TYPE.requiredReviewers && (o.team === null || (Array.isArray(ids) && ids.some((x) => lower(x) === lower(o.team))));
      },
      compare: (c) => [...blocking(c), ...allFiles(c), ...(own(settings(c), "creatorVoteCounts") === self ? [] : [`creatorVoteCounts -> ${String(self)}`])],
      update: () => ({ creatorVoteCounts: self, filenamePatterns: [] }),
    },
    {
      label: `Build validation ${PLATFORM_FOLDER}\\${VALIDATION_PIPELINE}`,
      type: POLICY_TYPE.build,
      summary: `pipeline ${o.validationId ?? "?"}, required, queued by a reviewer after reading the change (manual), valid ${VALID_MINUTES / 60} hours`,
      settings: { buildDefinitionId: o.validationId, displayName: "platform validation", manualQueueOnly: true, queueOnSourceUpdateOnly: true, validDuration: VALID_MINUTES },
      ...(o.validationId === null ? { blocked: `${PLATFORM_FOLDER}\\${VALIDATION_PIPELINE} does not exist: run --phase pipeline first` } : {}),
      match: (c) => typeOf(c) === POLICY_TYPE.build && (o.validationId === null || own(settings(c), "buildDefinitionId") === o.validationId),
      compare: (c) => {
        const s = settings(c);
        const d = own(s, "validDuration");
        return [
          ...blocking(c),
          ...allFiles(c),
          ...(own(s, "manualQueueOnly") === true ? [] : ["manualQueueOnly -> true"]),
          ...(own(s, "queueOnSourceUpdateOnly") === true ? [] : ["queueOnSourceUpdateOnly -> true"]),
          ...(typeof d === "number" && d > 0 && d <= VALID_MINUTES ? [] : [`validDuration ${String(d)} -> ${VALID_MINUTES}`]),
        ];
      },
      // A shorter validity than 12 hours is stricter and kept.
      update: (c) => {
        const d = own(settings(c), "validDuration");
        return { manualQueueOnly: true, queueOnSourceUpdateOnly: true, validDuration: typeof d === "number" && d > 0 && d <= VALID_MINUTES ? d : VALID_MINUTES, filenamePatterns: [] };
      },
    },
  ];
}

export function formatFederation(r: BootstrapResult): string {
  if (!r.federation) return "";
  const lines = ["Federation for infra/platform/bootstrap.bicep pass 2 (read back from Azure DevOps):"];
  for (const [env, f] of Object.entries(r.federation)) {
    const show = (x: Federation | null | undefined): string => (x ? `issuer ${x.issuer}, subject ${x.subject}` : "not available yet");
    lines.push(`  ${env} provisioning: ${show(f.provisioning)}`);
    if (Object.hasOwn(f, "adoAutomation")) lines.push(`  ${env} adoAutomation: ${show(f.adoAutomation)}`);
    if (Object.hasOwn(f, "entra")) lines.push(`  ${env} entra: ${show(f.entra)}`);
  }
  return lines.join("\n") + "\n";
}
