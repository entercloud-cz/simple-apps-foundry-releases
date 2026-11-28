import { CheckFailed, UsageError, isObject, own } from "../pipeline/common.js";
import { platformConfigDefaultBranch } from "../provisioning/model.js";
import type { Instance, InstanceEnv } from "../provisioning/model.js";
import { renderRepoFiles, repoRenderScope } from "../repo/render.js";
import type { RenderedFile, RepoRender } from "../repo/render.js";
import { THEME_CUSTOM, THEME_NONE } from "../themes.js";
import { repositoryTemplate } from "../validate-app.js";
import type { AppData, RepositoryTemplate } from "../validate-app.js";
import { API, BIT, NAMESPACE } from "./api-versions.js";
import { AdoClient, seg, valueList } from "./client.js";
import { ZERO_ID, branchToken, gitBlobId, pushChange } from "./git.js";
import { adoDeliveryPipeline, adoEnvironment, adoServiceConnection, DELIVERY_FOLDER, ONBOARDING_BRANCH } from "./names.js";
import { StepRunner, WaitingFor, approvalCheck, bitNames, branchControlCheck, exclusiveLockCheck, lower, obj, requiredTemplateCheck } from "./steps.js";
import type { DesiredCheck, Ref, Status } from "./steps.js";

export { exitCode, formatItems } from "./steps.js";
export type { Item, Status } from "./steps.js";

/**
 * `platform ado plan|apply`: the Azure DevOps objects of one app, rows 0-8 of the provisioning
 * plan (§4). Every object is read (GET), compared on the subset the platform owns, and on apply
 * created or updated (POST/PATCH/PUT). Nothing is deleted; pipeline authorisations of other
 * pipelines on the app's connections, environments and repo are revoked ("extra").
 *
 *   --phase resources: 0 resolve IDs, R the app repository (ADR-0039: created and seeded, or the
 *                      onboarding pull request of a bring-your-own repository), 1 service
 *                      connections (the portal identity Reader on each, ADR-0058),
 *                      2 environments, 3 checks, 4 repo and project ACLs, 8 instance assertions
 *   --phase pipelines: 0 resolve IDs, 5 delivery pipeline, 6 pipeline permissions (the app repo:
 *                      this pipeline only, ADR-0039 H1/H3), 7 queue rights on the \apps folder
 */

/**
 * How provisioning treats the app repository (ADR-0039), from repository.template: `stack` (a
 * starter: created and seeded by provisioning), `byo` (onboarded by a pull request) or `legacy`
 * (no template: unmanaged, as before ADR-0039: it must exist, nothing is granted, pushed or opened).
 */
export type RepoMode = "stack" | "byo" | "legacy";

export function repoMode(app: AppData): RepoMode {
  const t = repositoryTemplate(app);
  return t === undefined ? "legacy" : t === "byo" ? "byo" : "stack";
}

const lowerId = lower;

/**
 * Pipeline settings of the platform project (Build General Settings, Microsoft Learn 7.1) the
 * platform relies on: job tokens scoped to the project and to the repositories a pipeline
 * references, and no variables set at queue time unless marked settable.
 */
export const PIPELINE_SETTINGS: readonly (readonly [string, string])[] = [
  ["enforceSettableVar", "Limit variables that can be set at queue time"],
  ["enforceJobAuthScope", "Limit job authorization scope to current project for non-release pipelines"],
  ["enforceReferencedRepoScopedToken", "Protect access to repositories in YAML pipelines"],
];

/**
 * The existing branch differs from the default branch by exactly `changes` (the current render):
 * every changed path and nothing else, compared by blob ID.
 */
function sameDiff(main: Map<string, string>, branch: Map<string, string>, changes: RenderedFile[]): boolean {
  const diff = new Set([...main.keys(), ...branch.keys()].filter((p) => main.get(p) !== branch.get(p)));
  if (diff.size !== changes.length) return false;
  return changes.every((c) => diff.has(c.path) && (c.change === "delete" ? !branch.has(c.path) : branch.get(c.path) === gitBlobId(c.content)));
}

export interface RepoOutput {
  id: string;
  name: string;
  project: string;
  template: string;
  /** This run created the repository / pushed the starter (ADR-0039). */
  created: boolean;
  seeded: boolean;
  /** The onboarding pull request of a bring-your-own repository, once there is one. */
  pullRequestId: number | null;
}

export interface EnvOutput {
  serviceConnection: { id: string; name: string; issuer: string | null; subject: string | null } | null;
  environment: { id: number; name: string } | null;
}

export interface AdoOutputs {
  organization: string;
  project: { id: string; name: string };
  slug: string;
  /** Phase resources: the app repository; null when it doesn't exist (yet). */
  repository: RepoOutput | null;
  environments: Record<string, EnvOutput>;
  pipeline: { id: number; name: string; folder: string } | null;
}

export interface Settings {
  /** Branch control: require branch protection on the allowed branches. */
  ensureProtectionOfBranch: boolean;
  /** Re-save an existing delivery pipeline's build definition (repairs its trigger, ADO-24). */
  resave: boolean;
  /**
   * Phase resources: templates/ of the core checkout (--templates; default the one next to the
   * CLI, as for `platform repo render`). Read only to seed an empty repository or to open the
   * onboarding pull request of a bring-your-own one.
   */
  templatesDir?: string;
}

/**
 * Branch control's "ensure protection of branch" stays off until ADO-9 is settled: it needs branch
 * policies on platform-config's and every app repo's default branch, which the sandbox lacks.
 * TODO(verify) ADO-9: turn it on once those policies are part of onboarding.
 */
export const DEFAULT_SETTINGS: Settings = { ensureProtectionOfBranch: false, resave: false };

/** The caller (the ADO automation identity in the pipeline): its identity ID and ACL descriptor. */
interface Caller {
  id: string;
  descriptor: string;
  name: string;
}

interface Resolved {
  platformProject: Ref;
  /** The app repository's project (scm.azureDevOps.appsProject or one of allowedProjects). */
  appsProject: Ref;
  /** null in phase resources while the repository doesn't exist (it is created there). */
  appRepo: Ref | null;
  coreRepo: Ref;
  configRepo: Ref & { defaultBranch: string };
  buildService: string | null;
  contributors: string | null;
  approvers: string[] | null;
  selfApproval: boolean;
  caller: Caller | null;
  /**
   * Phase resources: id-{prefix}-portal (instance portal.identityPrincipalId) in the organization;
   * undefined when the instance names no portal identity, null when it isn't in the organization yet.
   */
  portal?: { id: string; name: string; descriptor: string } | null;
}

const GUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export class Planner extends StepRunner {
  readonly outputs: AdoOutputs;
  private r!: Resolved;
  /** Phase resources: the app repository has no ref at all (new, or adopted while empty). */
  private repoEmpty = false;
  /** Phase resources, plan: the repository row plans to create it. */
  private repoPlanned = false;
  private readonly mode: RepoMode;

  constructor(
    client: AdoClient,
    private readonly inst: Instance & { tenantId?: string; approvals?: { platformTeam?: { objectId: string; displayName?: string }; prodDeployApprovers?: string; allowSelfApproval?: boolean } },
    private readonly app: AppData,
    private readonly envs: InstanceEnv[],
    apply: boolean,
    private readonly deliveryClientIds: Record<string, string>,
    private readonly settings: Settings = DEFAULT_SETTINGS,
  ) {
    super(client, apply);
    this.mode = repoMode(app);
    this.outputs = { organization: client.org.url, project: { id: "", name: "" }, slug: app.slug, repository: null, environments: {}, pipeline: null };
    for (const e of envs) this.outputs.environments[e.name] = { serviceConnection: null, environment: null };
  }

  // ------------------------------------------------------------------------------------------
  // 0. Resolve IDs
  // ------------------------------------------------------------------------------------------

  async resolve(phase: "resources" | "pipelines"): Promise<void> {
    const ado = this.inst.scm.azureDevOps;
    if (this.inst.scm.provider !== "azureDevOps" || !ado) throw new CheckFailed(["instance.yaml scm.provider must be azureDevOps."]);
    const platformProject = await this.project(ado.platformProject);
    const appsProject = await this.project(this.app.repository.project);
    this.outputs.project = platformProject;
    // The app repo may be missing only in phase resources of an app with repository.template, which
    // creates it or reports it (ADR-0039); otherwise it must exist, as before.
    const managed = phase === "resources" && this.mode !== "legacy";
    const appRepo = managed ? await this.findRepo(this.app.repository.project, this.app.repository.name) : await this.repo(this.app.repository.project, this.app.repository.name);
    const r: Resolved = {
      platformProject,
      appsProject,
      appRepo,
      coreRepo: await this.repo(ado.platformProject, "core"),
      configRepo: await this.repo(ado.platformProject, ado.platformConfigRepo ?? "platform-config"),
      buildService: null,
      contributors: null,
      approvers: null,
      selfApproval: false,
      caller: null,
    };
    this.add({ status: "ok", kind: "project", name: `${platformProject.name} (${platformProject.id}), app repo project ${appsProject.name} (${appsProject.id})` });
    const appRepoText = appRepo ? `${appsProject.name}/${appRepo.name} (${appRepo.id})` : `${appsProject.name}/${this.app.repository.name} (not found, see below)`;
    this.add({ status: "ok", kind: "repository", name: `${appRepoText}, core (${r.coreRepo.id}), ${r.configRepo.name} (${r.configRepo.id})` });

    if (this.mode !== "legacy") r.caller = await this.caller();
    if (phase === "resources") {
      r.buildService = await this.identity(`${platformProject.name} Build Service (${this.client.org.name})`, (v) =>
        new RegExp(`^Microsoft\\.TeamFoundation\\.ServiceIdentity;[0-9a-fA-F-]{36}:Build:${platformProject.id}$`, "i").test(String(own(v, "descriptor"))),
      );
      this.add({ status: r.buildService ? "ok" : "blocked", kind: "identity", name: `${platformProject.name} Build Service`, ...(r.buildService ? {} : { detail: "not found" }) });
      const portalOid = this.inst.portal?.identityPrincipalId;
      if (portalOid) r.portal = await this.portalIdentity(portalOid);
      if (this.envs.some((e) => e.kind === "prod")) {
        r.approvers = await this.prodApprovers();
        r.selfApproval = this.selfApproval(this.inst.approvals, "prod approvers (self-approval)");
      }
    } else {
      r.contributors = await this.identity(`[${platformProject.name}]\\Contributors`, (v) => own(v, "providerDisplayName") === `[${platformProject.name}]\\Contributors`);
      this.add({ status: r.contributors ? "ok" : "blocked", kind: "identity", name: `[${platformProject.name}]\\Contributors`, ...(r.contributors ? {} : { detail: "not found" }) });
    }
    this.r = r;
  }

  /**
   * The portal identity id-{prefix}-portal, by its Entra object ID (the organization's service
   * principal whose originId it is): one row either way, for both of its per-app rights, Reader on
   * the app's service connections (ADR-0058) and Read on the app repository (ADR-0039 as amended
   * 2026-11-12). Missing from the organization is a warn row, not blocked: an organization
   * administrator adds it (ADR-0036), and until then nothing is granted and the portal can't show
   * the connections' state or the README and CHANGELOG.
   */
  private async portalIdentity(oid: string): Promise<{ id: string; name: string; descriptor: string } | null> {
    const label = `id-${this.inst.naming.prefix}-portal (portal.identityPrincipalId)`;
    const who = await this.orgIdentity(oid);
    if (!who) {
      this.add({ status: "warn", kind: "identity", name: label, detail: `${oid} is not in the organization yet (an organization administrator adds it, ADR-0036): until then the portal can't show this app's service connections, README or CHANGELOG; nothing granted.` });
      return null;
    }
    this.add({ status: "ok", kind: "identity", name: label, detail: `${oid} -> ${who.id}` });
    return { id: who.id, name: `the portal identity`, descriptor: who.descriptor };
  }

  /**
   * Prod approvers: approvals.platformTeam (the only approvals.prodDeployApprovers mode so far),
   * resolved by the shared resolveApprovers (steps.ts).
   */
  private async prodApprovers(): Promise<string[] | null> {
    const mode = this.inst.approvals?.prodDeployApprovers ?? "platformTeam";
    const label = `prod approvers (${mode})`;
    if (mode !== "platformTeam") {
      this.add({ status: "blocked", kind: "identity", name: label, detail: "only approvals.prodDeployApprovers platformTeam is supported." });
      return null;
    }
    return this.resolveApprovers(this.inst.approvals?.platformTeam, label);
  }

  /**
   * Who runs this (the ADO automation identity in the pipeline): `_apis/connectionData` names its
   * identity ID, the Identities API its ACL descriptor. Needed for the rights it grants itself on
   * the app repository and for removing its branch creator rights (ADR-0039). A row either way.
   */
  private async caller(): Promise<Caller | null> {
    const label = "the caller (connectionData)";
    try {
      const cd = await this.client.get("_apis/connectionData", API.connectionData);
      const id = isObject(cd) ? own(obj(own(cd, "authenticatedUser")), "id") : undefined;
      if (typeof id !== "string" || !GUID_RE.test(id)) throw new CheckFailed(["connectionData names no authenticated user."]);
      const list = valueList(await this.client.get("_apis/identities", API.identities, { identityIds: id, queryMembership: "None" }, "vssps"), "_apis/identities");
      const hit = list.find((v) => isObject(v) && typeof own(v, "descriptor") === "string" && String(own(v, "id")).toLowerCase() === id.toLowerCase());
      if (!isObject(hit)) throw new CheckFailed([`identity ${id} not found.`]);
      const name = typeof own(hit, "providerDisplayName") === "string" ? (own(hit, "providerDisplayName") as string) : id;
      this.add({ status: "ok", kind: "identity", name: label, detail: `${name} (${id})` });
      return { id, descriptor: own(hit, "descriptor") as string, name };
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      this.add({ status: "blocked", kind: "identity", name: label, detail: e.problems.join(" ") });
      return null;
    }
  }

  // ------------------------------------------------------------------------------------------
  // Phase resources
  // ------------------------------------------------------------------------------------------

  async resources(): Promise<void> {
    if (this.mode !== "legacy") await this.repository();
    for (const env of this.envs) {
      await this.serviceConnection(env);
      await this.portalReader(env);
      await this.environment(env);
      await this.checksFor(env);
    }
    await this.acls();
    await this.instanceAssertions();
  }

  // ------------------------------------------------------------------------------------------
  // R. The app repository (ADR-0039)
  // ------------------------------------------------------------------------------------------

  /**
   * Rows before anything else uses the repository, only for an app with repository.template
   * (without it the repository is unmanaged, as before ADR-0039: it must exist, nothing is pushed).
   * The caller holds rights on the repository only while it needs them: each is granted right
   * before its push or pull request and removed at the end of the same run (`cleanup`), together
   * with the branch creator rights the push gave it.
   *
   * Stack (node-ts, python-fastapi, dotnet):
   *   repository   created in the apps project when missing (never in another project); an empty
   *                one is adopted; one with content only when the caller itself created its default
   *                branch (a push by the caller with oldObjectId 0: the seed), otherwise blocked:
   *                a repository provisioning didn't create is never adopted;
   *   repo-acl     while it is empty: Contribute and Create branch on this repository only;
   *   seed         one commit that creates the default branch with the starter (the renderer of
   *                `platform repo render`), only while the repository has no ref at all;
   *   cleanup      no rights of the caller left on the repository and its default branch.
   * byo (repository.template: byo):
   *   repository   must exist (a missing one is blocked, an empty one a warn row);
   *   onboarding   a pull request from platform/onboarding into the default branch with the
   *                onboarding files rendered against the repository's own; nothing when such a
   *                pull request exists (open, completed or abandoned) or nothing would change; an
   *                existing branch is reused only when the caller alone pushed it and it differs
   *                from the default branch exactly by the current render, otherwise blocked;
   *   repo-acl     only for that pull request: Contribute to pull requests on the repository, and
   *                Create branch and Contribute below platform/ (a folder token, never the default
   *                branch) when the branch is pushed;
   *   cleanup      no rights of the caller left on the repository, platform/ and the branch.
   */
  private async repository(): Promise<void> {
    const rp = this.app.repository;
    const project = this.r.appsProject;
    const template = repositoryTemplate(this.app) ?? "byo";
    const stack = this.mode === "stack";
    const label = `${project.name}/${rp.name}`;
    const branch = `refs/heads/${rp.defaultBranch ?? "main"}`;
    const appsProject = this.inst.scm.azureDevOps!.appsProject;
    const record = (repo: Ref, created: boolean): void => {
      this.outputs.repository = { id: repo.id, name: repo.name, project: project.name, template, created, seeded: false, pullRequestId: null };
    };
    let usable = false;
    await this.step("repository", label, async () => {
      const found = this.r.appRepo;
      if (found) {
        record(found, false);
        this.repoEmpty = await this.isEmpty(project, found.id);
        usable = true;
        if (this.repoEmpty && !stack) return { status: "warn", detail: `${found.id}, empty: a bring-your-own repository gets its onboarding pull request once it has ${branch} (or set repository.template to a stack to seed it)` };
        if (this.repoEmpty) return { status: "ok", detail: `${found.id}, empty: adopted and seeded below (template ${template})` };
        if (!stack) return { status: "ok", detail: `${found.id}, has content (template byo)` };
        usable = false;
        if (!this.r.caller) throw new CheckFailed(["has content, and the caller's identity is unresolved (see above): it can't be told whether provisioning created it."]);
        if (!(await this.seededBy(project, found.id, branch, this.r.caller))) {
          throw new CheckFailed([
            `has content that provisioning did not push (${branch} was not created by a push of ${this.r.caller.name}): a repository it didn't create is never adopted (ADR-0039). Give the app an empty or new repository, or set repository.template to byo to onboard this one with a pull request.`,
          ]);
        }
        usable = true;
        return { status: "ok", detail: `${found.id}, seeded by ${this.r.caller.name} (template ${template}; never re-seeded)` };
      }
      if (!stack) {
        throw new CheckFailed([`not found, and repository.template is byo: a bring-your-own repository must exist first; create it, or set repository.template to a stack (ADR-0039).`]);
      }
      if (rp.project !== appsProject) throw new CheckFailed([`not found: provisioning creates repositories only in the apps project ${appsProject} (ADR-0039); create it by hand first.`]);
      this.repoPlanned = true;
      this.repoEmpty = true;
      usable = true;
      return {
        status: "create",
        detail: `in ${project.name}, seeded below (template ${template})`,
        change: async () => {
          const created = await this.client.write("POST", `${seg(project.name)}/_apis/git/repositories`, API.git, { name: rp.name, project: { id: project.id } });
          if (!isObject(created) || typeof own(created, "id") !== "string") throw new CheckFailed(["creating the repository returned no id."]);
          this.r.appRepo = { id: own(created, "id") as string, name: rp.name };
          record(this.r.appRepo, true);
        },
      };
    });
    // Nothing below without a usable repository (blocked or failed above).
    if (!usable || (this.apply && !this.r.appRepo)) return;

    const git = await this.namespaceBits("Git Repositories", NAMESPACE.gitRepositories, ["GenericContribute", "CreateBranch", "PullRequestContribute"]);
    if (!git) return;
    const who = this.r.caller?.name ?? "the caller";
    const repoToken = (id: string): string => `repoV2/${project.id}/${id}`;
    if (stack) {
      if (this.repoEmpty) {
        await this.selfAce("repo-acl", `${label}: ${who} may contribute and create branches until the seed is pushed (this repository only)`, repoToken, git.GenericContribute! | git.CreateBranch!);
        await this.seed(label, branch, template);
      }
      await this.cleanup(label, [["the repository", repoToken], [branch, (id) => branchToken(project.id, id, branch)]], git, this.repoEmpty);
      return;
    }
    if (this.repoEmpty) return;
    const source = `refs/heads/${ONBOARDING_BRANCH}`;
    const plan = await this.planOnboarding(label, branch);
    if (plan.pr) {
      await this.selfAce("repo-acl", `${label}: ${who} may contribute to pull requests for the onboarding pull request (this repository only)`, repoToken, git.PullRequestContribute!);
      if (plan.push) await this.selfAce("branch-acl", `${label}: ${who} may create and push branches below platform/ for it`, (id) => branchToken(project.id, id, "platform"), git.GenericContribute! | git.CreateBranch!);
    }
    await this.step("onboarding", `${label}: ${ONBOARDING_BRANCH} and a pull request into ${branch}`, async () => {
      if (plan.blocked) throw new CheckFailed([plan.blocked]);
      return plan.row;
    });
    await this.cleanup(
      label,
      [
        ["the repository", repoToken],
        ["platform/", (id) => branchToken(project.id, id, "platform")],
        [ONBOARDING_BRANCH, (id) => branchToken(project.id, id, source)],
      ],
      git,
      plan.pr,
    );
  }

  /** A right the caller grants itself on the app repository (through its Manage permissions). */
  private async selfAce(kind: string, name: string, token: (repoId: string) => string, allow: number): Promise<void> {
    const repo = this.r.appRepo;
    const caller = this.r.caller;
    if (!caller) {
      this.add({ status: "blocked", kind, name, detail: "the caller's identity is unresolved (see above)." });
      return;
    }
    if (!repo) {
      this.add({ status: "create", kind, name, detail: `allow ${allow}, after the repository is created` });
      return;
    }
    await this.ace(kind, name, NAMESPACE.gitRepositories, token(repo.id), caller.descriptor, { allow });
  }

  /**
   * The caller's own entries on the repository's tokens cleared at the end of the run (its denies
   * kept): the rights it granted itself and the branch creator rights its pushes gave it
   * (Contribute, Force push, Manage permissions, Remove others' locks; Microsoft Learn, branch
   * permissions). `pending`: a grant or push of this run comes first (plan: an `update` row).
   * TODO(verify) ADO-25: a REST push leaves exactly that creator entry, on the branch token of git.ts.
   */
  private async cleanup(label: string, tokens: [string, (repoId: string) => string][], git: Record<string, number>, pending: boolean): Promise<void> {
    const caller = this.r.caller;
    const later = { status: "update" as const, detail: "after this run's push: remove the rights it granted itself and its branch creator rights" };
    await this.step("cleanup", `${label}: no rights of ${caller?.name ?? "the caller"} left (${tokens.map(([n]) => n).join(", ")})`, async () => {
      if (!caller) throw new CheckFailed(["the caller's identity is unresolved (see above)."]);
      const repo = this.r.appRepo;
      if (!repo) return later;
      const found: { where: string; token: string; allow: number; deny: number }[] = [];
      for (const [where, token] of tokens) {
        const t = token(repo.id);
        const { allow, deny } = await this.aceBits(NAMESPACE.gitRepositories, t, caller.descriptor);
        if (allow) found.push({ where, token: t, allow, deny });
      }
      if (!found.length) return pending && !this.apply ? later : { status: "ok" };
      return {
        status: "extra",
        detail: `${found.map((f) => `${f.where}: allow ${f.allow} (${bitNames(git, f.allow)})`).join("; ")}: removed`,
        change: async () => {
          for (const f of found) {
            await this.client.write("POST", `_apis/accesscontrolentries/${NAMESPACE.gitRepositories}`, API.accessControl, { token: f.token, merge: false, accessControlEntries: [{ descriptor: caller.descriptor, allow: 0, deny: f.deny }] });
          }
        },
      };
    });
  }

  /** True when the repository has no ref at all (nothing was ever pushed). */
  private async isEmpty(project: Ref, repoId: string): Promise<boolean> {
    const refs = valueList(await this.client.get(`${seg(project.name)}/_apis/git/repositories/${seg(repoId)}/refs`, API.git, { $top: "1" }), "git/refs");
    return refs.length === 0;
  }

  /** The pushes to `ref` (newest first; Microsoft Learn, Pushes - List), with their ref updates. */
  private async pushesTo(project: Ref, repoId: string, ref: string, pusherId?: string): Promise<Record<string, unknown>[]> {
    const q: Record<string, string> = { "searchCriteria.refName": ref, "searchCriteria.includeRefUpdates": "true", $top: "100" };
    if (pusherId) q["searchCriteria.pusherId"] = pusherId;
    return valueList(await this.client.get(`${seg(project.name)}/_apis/git/repositories/${seg(repoId)}/pushes`, API.git, q), "git/pushes").filter(isObject);
  }

  /**
   * Provisioning created `ref` of this repository: a push by the caller that created it
   * (oldObjectId 0), i.e. the seed. TODO(verify) ADO-25: the ref updates of Pushes - List.
   */
  private async seededBy(project: Ref, repoId: string, ref: string, caller: Caller): Promise<boolean> {
    for (const p of await this.pushesTo(project, repoId, ref, caller.id)) {
      if (lowerId(own(obj(own(p, "pushedBy")), "id")) !== lowerId(caller.id)) continue;
      const updates = own(p, "refUpdates");
      if (Array.isArray(updates) && updates.some((u) => isObject(u) && own(u, "name") === ref && own(u, "oldObjectId") === ZERO_ID)) return true;
    }
    return false;
  }

  /** The commit a branch points at, or null. */
  private async refHead(base: string, ref: string): Promise<string | null> {
    const refs = valueList(await this.client.get(`${base}/refs`, API.git, { filter: ref.replace(/^refs\//, "") }), "git/refs");
    const hit = refs.find((v) => isObject(v) && own(v, "name") === ref);
    return isObject(hit) && typeof own(hit, "objectId") === "string" ? (own(hit, "objectId") as string) : null;
  }

  /**
   * The starter of this app (src/repo/render.ts, the code of `platform repo render`): rendered
   * against `existing` (the repository's current files in the render scope), only the files that
   * change. The app's ui.theme and the instance's themes come with this.app and this.inst
   * (ADR-0044). A missing templates folder is a blocked row, not a usage error.
   */
  private render(template: RepositoryTemplate, existing?: Map<string, Buffer>): RepoRender {
    try {
      return renderRepoFiles(this.app, this.inst, { template, ...(this.settings.templatesDir ? { templatesDir: this.settings.templatesDir } : {}), ...(existing ? { existing } : {}) });
    } catch (e) {
      if (e instanceof UsageError) throw new CheckFailed([e.message]);
      throw e;
    }
  }

  private scope(): { files: string[]; dirs: string[] } {
    try {
      return repoRenderScope("byo", this.settings.templatesDir ? { templatesDir: this.settings.templatesDir } : {});
    } catch (e) {
      if (e instanceof UsageError) throw new CheckFailed([e.message]);
      throw e;
    }
  }

  private async seed(label: string, branch: string, template: RepositoryTemplate): Promise<void> {
    const project = this.r.appsProject;
    await this.step("seed", `${label}: ${branch}`, async () => {
      if (!this.r.caller) throw new CheckFailed(["the caller's identity is unresolved (see above): not seeded without its rights."]);
      const { files, theme } = this.render(template);
      const withTheme = theme === THEME_NONE ? "" : theme === THEME_CUSTOM ? " and placeholder theme files (custom)" : ` and the ${theme} theme`;
      return {
        status: "create",
        detail: `one commit with the ${template} starter${withTheme}, ${files.length} files (platform repo render)`,
        change: async () => {
          const repo = this.r.appRepo;
          if (!repo) throw new CheckFailed(["the repository does not exist."]);
          // A person may have pushed since the plan: never push a starter over content.
          if (!(await this.isEmpty(project, repo.id))) throw new CheckFailed(["the repository has content now: not seeded (never re-seeded)."]);
          await this.client.write("POST", `${seg(project.name)}/_apis/git/repositories/${seg(repo.id)}/pushes`, API.git, {
            refUpdates: [{ name: branch, oldObjectId: ZERO_ID }],
            commits: [
              {
                comment: `Start ${this.app.slug} from the ${template} starter (core ${this.inst.coreVersion})${withTheme}\n\nRendered by platform repo render and pushed by the provisioning pipeline (ADR-0039).`,
                changes: files.map(pushChange),
              },
            ],
          });
          if (this.outputs.repository) this.outputs.repository.seeded = true;
        },
      };
    });
  }

  /**
   * What the onboarding row of a byo repository does (reads only): `pr` when a pull request is
   * opened (`push` when the branch is pushed first), `blocked` with the reason, `row` otherwise.
   */
  private async planOnboarding(label: string, branch: string): Promise<{ pr: boolean; push: boolean; blocked?: string; row: { status: Status; detail?: string; change?: () => Promise<void> } }> {
    const project = this.r.appsProject;
    const repo = this.r.appRepo!;
    const caller = this.r.caller;
    const base = `${seg(project.name)}/_apis/git/repositories/${seg(repo.id)}`;
    const source = `refs/heads/${ONBOARDING_BRANCH}`;
    const none = { pr: false, push: false };
    try {
      if (!caller) return { ...none, blocked: "the caller's identity is unresolved (see above): no onboarding without its rights.", row: { status: "blocked" } };
      const prs = valueList(await this.client.get(`${base}/pullrequests`, API.git, { "searchCriteria.sourceRefName": source, "searchCriteria.targetRefName": branch, "searchCriteria.status": "all" }), "pullrequests")
        .filter(isObject)
        .sort((a, b) => Number(own(b, "pullRequestId")) - Number(own(a, "pullRequestId")));
      const pr = prs[0];
      if (pr) {
        if (this.outputs.repository) this.outputs.repository.pullRequestId = Number(own(pr, "pullRequestId"));
        return { ...none, row: { status: "ok", detail: `pull request ${String(own(pr, "pullRequestId"))} is ${String(own(pr, "status"))}: the owner decides, it is never re-opened` } };
      }
      const head = await this.refHead(base, branch);
      if (!head) return { ...none, blocked: `${branch} does not exist (repository.defaultBranch): the onboarding pull request needs it.`, row: { status: "blocked" } };
      const mainTree = await this.tree(base, head);
      const changes = this.render("byo", await this.existingFiles(base, head, mainTree)).files;
      const branchHead = await this.refHead(base, source);
      if (branchHead) {
        // Reused only when the caller alone pushed it and it is exactly the current render.
        const pushes = await this.pushesTo(project, repo.id, source);
        const onlyCaller = pushes.length > 0 && pushes.every((p) => lowerId(own(obj(own(p, "pushedBy")), "id")) === lowerId(caller.id));
        if (!onlyCaller || !sameDiff(mainTree, await this.tree(base, branchHead), changes)) {
          return {
            ...none,
            blocked: `${ONBOARDING_BRANCH} exists but ${onlyCaller ? "differs from the current onboarding files" : `was not pushed by ${caller.name} alone`}: it is not proposed. Delete the branch, and the next run pushes it again.`,
            row: { status: "blocked" },
          };
        }
      } else if (!changes.length) {
        return { ...none, row: { status: "ok", detail: "already has the onboarding files: no pull request needed" } };
      }
      const count = (c: RenderedFile["change"]): number => changes.filter((x) => x.change === c).length;
      const title = `Platform onboarding: agent files and platform.yaml for ${this.app.slug}`;
      const push = branchHead === null;
      return {
        pr: true,
        push,
        row: {
          status: "create",
          detail: push ? `push ${count("add")} new, ${count("edit")} changed, ${count("delete")} deleted file(s) to ${ONBOARDING_BRANCH}, open a pull request` : `${ONBOARDING_BRANCH} exists (pushed by ${caller.name}, the current render): open the pull request`,
          change: async () => {
            if (push) {
              await this.client.write("POST", `${base}/pushes`, API.git, {
                refUpdates: [{ name: source, oldObjectId: head }],
                commits: [{ comment: `${title}\n\nRendered by platform repo render (core ${this.inst.coreVersion}) and pushed by the provisioning pipeline (ADR-0039).`, changes: changes.map(pushChange) }],
              });
            }
            const created = await this.client.write("POST", `${base}/pullrequests`, API.git, { sourceRefName: source, targetRefName: branch, title, description: onboardingDescription(this.app.slug, this.inst.coreVersion, changes) });
            if (isObject(created) && Number.isSafeInteger(own(created, "pullRequestId")) && this.outputs.repository) this.outputs.repository.pullRequestId = own(created, "pullRequestId") as number;
          },
        },
      };
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      return { ...none, blocked: `${label}: ${e.problems.join(" ")}`, row: { status: "blocked" } };
    }
  }

  /** Path (no leading slash) -> blob objectId of every file at `commit`. */
  private async tree(base: string, commit: string): Promise<Map<string, string>> {
    const items = valueList(
      await this.client.get(`${base}/items`, API.git, { scopePath: "/", recursionLevel: "Full", "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit" }),
      "git/items",
    );
    const out = new Map<string, string>();
    for (const i of items) {
      if (!isObject(i) || own(i, "isFolder") === true || own(i, "gitObjectType") === "tree") continue;
      const path = own(i, "path");
      const id = own(i, "objectId");
      if (typeof path === "string" && typeof id === "string") out.set(path.replace(/^\//, ""), id.toLowerCase());
    }
    return out;
  }

  /**
   * The repository's files at `commit` that a byo render reads (repoRenderScope: the onboarding
   * files and the skills folders), as the renderer's `existing`: one Items call per file in scope.
   * TODO(verify) ADO-28: the Items API returns text content byte for byte.
   */
  private async existingFiles(base: string, commit: string, tree: Map<string, string>): Promise<Map<string, Buffer>> {
    const scope = this.scope();
    const inScope = (p: string): boolean => scope.files.includes(p) || scope.dirs.some((d) => p.startsWith(`${d}/`));
    const out = new Map<string, Buffer>();
    for (const path of tree.keys()) if (inScope(path)) out.set(path, await this.itemContent(base, commit, path));
    return out;
  }

  private async itemContent(base: string, commit: string, path: string): Promise<Buffer> {
    const item = await this.client.get(`${base}/items`, API.git, { path: `/${path}`, includeContent: "true", "versionDescriptor.version": commit, "versionDescriptor.versionType": "commit" });
    const content = isObject(item) ? own(item, "content") : undefined;
    if (typeof content !== "string") throw new CheckFailed([`${path}: no content in the Items API response.`]);
    return Buffer.from(content, "utf8");
  }

  private async serviceConnection(env: InstanceEnv): Promise<void> {
    const name = adoServiceConnection(this.app.slug, env.name);
    const out = this.outputs.environments[env.name]!;
    const clientId = this.deliveryClientIds[env.name];
    if (!clientId) {
      this.add({ status: "blocked", kind: "service-connection", name, detail: `no delivery identity client ID for ${env.name} (--lz-outputs ${env.name}=<file>).` });
      return;
    }
    await this.ensureServiceConnection(this.r.platformProject, {
      name,
      clientId,
      tenantId: this.inst.tenantId ?? "",
      subscriptionId: env.subscriptionId,
      subscriptionName: `${this.inst.naming.prefix}-${env.name}`,
      description: `Delivery of ${this.app.slug} to ${env.name} (managed by the platform).`,
      replace: true,
    }, (sc) => (out.serviceConnection = sc));
  }

  /**
   * ADR-0058: the portal identity is Reader on the app's service connection sc-{slug}-{env} and on
   * nothing else, so the portal can show whether the connection is disabled and when it was last used
   * (Endpoints - Get Service Endpoints By Names, Executionhistory - List). Reader is the narrowest
   * service connection role ("Can view service connections", Microsoft Learn, "Manage security in
   * Azure Pipelines"); it can't use, change, enable or share it. An object-level assignment on
   * this connection only, never the project-level role (that would cover every connection of the
   * platform project). The caller created the connection and is its Administrator, so it may assign
   * roles on it. A higher role assigned directly is narrowed to Reader; one inherited from the
   * project level is a warn row (not changed here). TODO(verify) SC-1: Reader is enough for both
   * reads, and for isDisabled in the answer.
   */
  private async portalReader(env: InstanceEnv): Promise<void> {
    const portal = this.r.portal;
    if (portal === undefined) return;
    const name = adoServiceConnection(this.app.slug, env.name);
    const label = `${name}: ${portal ? portal.name : "the portal identity"} is Reader (only)`;
    if (portal === null) {
      this.add({ status: "warn", kind: "endpoint-role", name: label, detail: "the portal identity is not in the organization yet (see above)." });
      return;
    }
    const out = this.outputs.environments[env.name]!;
    const project = this.r.platformProject;
    await this.step("endpoint-role", label, async () => {
      const id = out.serviceConnection?.id;
      const path = (endpointId: string) => `_apis/securityroles/scopes/distributedtask.serviceendpointrole/roleassignments/resources/${seg(`${project.id}_${endpointId}`)}`;
      const put = async (): Promise<void> => {
        const endpointId = out.serviceConnection?.id;
        if (!endpointId) throw new CheckFailed([`${name} does not exist (see above).`]);
        await this.client.write("PUT", path(endpointId), API.securityRoles, [{ userId: portal.id, roleName: "Reader" }]);
      };
      if (!id) return { status: "create", detail: "after the service connection is created", change: put };
      const list = valueList(await this.client.get(path(id), API.securityRoles), "securityroles");
      const a = list.find((v) => isObject(v) && lower(own(obj(own(v, "identity")), "id")) === lower(portal.id));
      const role = isObject(a) ? own(obj(own(a, "role")), "name") : undefined;
      if (role === "Reader") return { status: "ok" };
      if (role === undefined) return { status: "create", change: put };
      if (isObject(a) && lower(own(a, "access")) === "inherited") return { status: "warn", detail: `${String(role)}, inherited from the project's service connection security: the portal needs Reader only (ADR-0058); not changed here.` };
      return { status: "update", detail: `${String(role)} -> Reader (ADR-0058: the portal only reads the connection)`, change: put };
    });
  }

  private async environment(env: InstanceEnv): Promise<void> {
    const name = adoEnvironment(this.app.slug, env.name);
    const out = this.outputs.environments[env.name]!;
    const project = this.r.platformProject;
    await this.step("environment", name, async () => {
      const list = valueList(await this.client.get(`${seg(project.name)}/_apis/pipelines/environments`, API.environments, { name }), "pipelines/environments");
      const existing = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
      if (existing) {
        out.environment = { id: Number(own(existing, "id")), name };
        return { status: "ok", detail: `id ${String(own(existing, "id"))}` };
      }
      return {
        status: "create",
        change: async () => {
          const created = await this.client.write("POST", `${seg(project.name)}/_apis/pipelines/environments`, API.environments, {
            name,
            description: `Delivery of ${this.app.slug} to ${env.name} (managed by the platform).`,
          });
          if (!isObject(created) || typeof own(created, "id") !== "number") throw new CheckFailed([`creating environment ${name} returned no id.`]);
          out.environment = { id: own(created, "id") as number, name };
          this.createdNow.add(String(own(created, "id")));
        },
      };
    });
  }

  /** The checks the platform owns on a resource (ADR-0021, ADR-0029). */
  desiredChecks(env: InstanceEnv, resourceType: "environment" | "endpoint"): DesiredCheck[] {
    return desiredChecksFor(this.inst, this.app, env, resourceType, { approvers: this.r.approvers, selfApproval: this.r.selfApproval, configDefaultBranch: this.r.configRepo.defaultBranch }, this.settings);
  }

  private async checksFor(env: InstanceEnv): Promise<void> {
    const out = this.outputs.environments[env.name]!;
    const resources: { type: "environment" | "endpoint"; id: () => string | null; name: string }[] = [
      { type: "endpoint", id: () => out.serviceConnection?.id || null, name: adoServiceConnection(this.app.slug, env.name) },
      { type: "environment", id: () => (out.environment ? String(out.environment.id) : null), name: adoEnvironment(this.app.slug, env.name) },
    ];
    for (const res of resources) await this.ensureChecks(this.r.platformProject, res, this.desiredChecks(env, res.type));
  }

  private async acls(): Promise<void> {
    const r = this.r;
    const repoName = `${r.appsProject.name}/${this.app.repository.name}: build service may read`;
    if (r.appRepo) await this.ace("repo-acl", repoName, NAMESPACE.gitRepositories, `repoV2/${r.appsProject.id}/${r.appRepo.id}`, r.buildService, { allow: BIT.gitRead });
    else if (this.repoPlanned && !this.apply) this.add({ status: "create", kind: "repo-acl", name: repoName, detail: `allow ${BIT.gitRead}, after the repository is created` });
    else this.add({ status: "blocked", kind: "repo-acl", name: repoName, detail: "the repository does not exist (see above)." });
    await this.ace("project-acl", `${r.appsProject.name}: build service may view the project`, NAMESPACE.project, `$PROJECT:vstfs:///Classification/TeamProject/${r.appsProject.id}`, r.buildService, { allow: BIT.projectView });
    await this.portalRead();
  }

  /**
   * The portal shows the app repository's README and CHANGELOG (US11.09, ADR-0039 as amended
   * 2026-11-12): id-{prefix}-portal (instance.yaml portal.identityPrincipalId) gets Read on this
   * repository alone (its repoV2 token; never the project's or the organization's all-repositories
   * token, never a branch right) and View project-level information on the apps project (the Git
   * APIs answer 404 for a project the caller can't see). Nothing else, and no row without
   * portal.identityPrincipalId (the portal isn't set up). The identity is the organization's
   * service principal whose Entra object ID (originId) is that principal ID, resolved once with the
   * service connections' Reader (portalIdentity); until an organization administrator has added it
   * (ADR-0036) that row warns and nothing is granted, so provisioning goes on. Only these bits are
   * ensured; other entries are left as they are (the bootstrap reports the portal's rights).
   * TODO(verify) README-3: the ADO automation identity may list the organization's Graph service
   * principals and write these two entries.
   */
  private async portalRead(): Promise<void> {
    const r = this.r;
    if (!r.portal) return;
    const descriptor = r.portal.descriptor;
    const name = `id-${this.inst.naming.prefix}-portal`;
    const repoLabel = `${r.appsProject.name}/${this.app.repository.name}: ${name} may read (README and CHANGELOG in the portal)`;
    const projectLabel = `${r.appsProject.name}: ${name} may view the project`;
    if (r.appRepo) await this.ace("repo-acl", repoLabel, NAMESPACE.gitRepositories, `repoV2/${r.appsProject.id}/${r.appRepo.id}`, descriptor, { allow: BIT.gitRead });
    else if (this.repoPlanned && !this.apply) this.add({ status: "create", kind: "repo-acl", name: repoLabel, detail: `allow ${BIT.gitRead}, after the repository is created` });
    else this.add({ status: "blocked", kind: "repo-acl", name: repoLabel, detail: "the repository does not exist (see above)." });
    await this.ace("project-acl", projectLabel, NAMESPACE.project, `$PROJECT:vstfs:///Classification/TeamProject/${r.appsProject.id}`, descriptor, { allow: BIT.projectView });
  }

  private async instanceAssertions(): Promise<void> {
    const project = this.r.platformProject;
    const contributors = `[${project.name}]\\Contributors`;
    await this.contributorsEnvironmentReader(project);
    // The project's pipeline settings that keep a job token small (`platform ado bootstrap --phase
    // policies` sets them): asserted here, never changed.
    let general: unknown;
    for (const [field, name] of PIPELINE_SETTINGS) {
      await this.step("setting", name, async () => {
        general ??= await this.client.get(`${seg(project.name)}/_apis/build/generalsettings`, API.buildGeneralSettings);
        return isObject(general) && own(general, field) === true ? { status: "ok" } : { status: "warn", detail: `off (${field}): turn it on in the project settings or with platform ado bootstrap --phase policies (not changed here)` };
      });
    }
    await this.step("endpoint-security", `${contributors} on service connections`, async () => {
      const list = valueList(await this.client.get(`_apis/securityroles/scopes/distributedtask.project.serviceendpointrole/roleassignments/resources/${seg(project.id)}`, API.securityRoles), "securityroles");
      const a = list.find((v) => isObject(v) && isObject(own(v, "identity")) && own(obj(own(v, "identity")), "displayName") === contributors);
      const role = isObject(a) ? own(obj(own(a, "role")), "name") : undefined;
      // TODO(verify): which project-level roles let Contributors use a connection in a new pipeline.
      return role === undefined || role === "Reader" ? { status: "ok", detail: String(role ?? "no role") } : { status: "warn", detail: `${String(role)}: should be Reader or none (not changed by the platform)` };
    });
  }

  // ------------------------------------------------------------------------------------------
  // Phase pipelines
  // ------------------------------------------------------------------------------------------

  async pipelines(): Promise<void> {
    const project = this.r.platformProject;
    const name = adoDeliveryPipeline(this.app.slug);
    const path = `apps/${this.app.slug}/delivery.yml`;
    const decommissioned = !!this.app.decommission;
    // 5b. ADR-0056: a decommissioned app's delivery pipeline is disabled; Cancel enables it again.
    // The queue status of an existing pipeline comes before its YAML preview: Azure DevOps refuses to
    // preview a disabled pipeline (HTTP 500 "Build pipeline … is disabled", sandbox run 3412), so a
    // cancelled decommissioning is enabled first, and a decommissioned app's pipeline is not previewed
    // (it runs nothing until a Cancel enables it; the next apply previews it then).
    const existingId = await this.pipelineIdByName(project, name, DELIVERY_FOLDER);
    let pipelineId: number | null = existingId;
    if (existingId !== null) await this.queueStatus(project, name, () => existingId);
    await this.ensurePipeline(project, { name, folder: DELIVERY_FOLDER, path, configRepo: this.r.configRepo, resave: this.settings.resave, preview: !decommissioned }, (id) => {
      pipelineId = id;
      this.outputs.pipeline = { id, name, folder: DELIVERY_FOLDER };
    });
    // A pipeline created in this run is enabled (and previewed when created); disabled after it when the app is decommissioned.
    if (existingId === null) await this.queueStatus(project, name, () => pipelineId);
    if (decommissioned && existingId !== null) {
      this.add({ status: "ok", kind: "pipeline-yaml", name: `${DELIVERY_FOLDER}\\${name}: YAML`, detail: "not previewed: the app is being decommissioned and its pipeline is disabled (ADR-0056)" });
    }

    // 6. Pipeline permissions and repository pre-authorisation.
    const resources: { type: string; id: string | null; label: string; exclusive: boolean }[] = [];
    for (const env of this.envs) {
      const sc = await this.findServiceConnection(env);
      const ev = await this.findEnvironment(env);
      resources.push({ type: "endpoint", id: sc, label: adoServiceConnection(this.app.slug, env.name), exclusive: true });
      resources.push({ type: "environment", id: ev === null ? null : String(ev), label: adoEnvironment(this.app.slug, env.name), exclusive: true });
    }
    for (const res of resources) await this.ensurePermission(project, res, () => pipelineId);
    // The app repo: this pipeline only (ADR-0039 decision 4).
    await this.authoriseRepository(project, () => pipelineId);
    // The core repo is open to every pipeline of the platform project (ADR-0031).
    await this.ensurePermission(project, { type: "repository", id: `${project.id}.${this.r.coreRepo.id}`, label: `${project.name}/core`, exclusive: false }, () => pipelineId);

    // 7. Queue rights on the \apps folder: Contributors may not queue delivery runs by hand.
    // TODO(verify): the folder token form `{projectId}/apps` (a definition's token is `{projectId}/apps/{id}`).
    await this.ace("queue-acl", `${DELIVERY_FOLDER}: Contributors may not queue`, NAMESPACE.build, `${project.id}/${DELIVERY_FOLDER.replace(/^\\/, "")}`, this.r.contributors, { deny: BIT.queueBuilds });
  }

  /** The ID of the YAML pipeline `{folder}\\{name}`, or null when there is none (the list ensurePipeline reads). */
  private async pipelineIdByName(project: Ref, name: string, folder: string): Promise<number | null> {
    let list: unknown[];
    try {
      list = await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" });
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      return null; // ensurePipeline lists again and reports the failure in its row
    }
    const hit = list.find((v) => isObject(v) && own(v, "name") === name && own(v, "folder") === folder);
    return isObject(hit) && typeof own(hit, "id") === "number" ? (own(hit, "id") as number) : null;
  }

  /**
   * ADR-0056: the build definition's queueStatus, `disabled` while app.yaml has a decommission block
   * (nothing can queue a run: a push, the portal's redeploy), `enabled` otherwise. A pipeline
   * created in this run is enabled. TODO(verify) DECOM-3: a disabled definition refuses every queue,
   * and PUT with queueStatus enabled brings it back.
   */
  private async queueStatus(project: Ref, name: string, pipelineId: () => number | null): Promise<void> {
    const want = this.app.decommission ? "disabled" : "enabled";
    await this.step("pipeline-queue", `${DELIVERY_FOLDER}\\${name}: ${want}`, async () => {
      const id = pipelineId();
      if (id === null) return want === "enabled" ? { status: "ok", detail: "created enabled" } : { status: "update", detail: "after its creation: disable" };
      const path = `${seg(project.name)}/_apis/build/definitions/${id}`;
      const def = await this.client.get(path, API.buildDefinitions);
      if (!isObject(def) || own(def, "id") !== id) throw new CheckFailed([`build definition ${id}: unexpected response.`]);
      const now = typeof own(def, "queueStatus") === "string" ? (own(def, "queueStatus") as string) : "enabled";
      if (now === want) return { status: "ok", detail: now };
      return {
        status: "update",
        detail: `${now} -> ${want}`,
        change: async () => {
          const fresh = await this.client.get(path, API.buildDefinitions);
          if (!isObject(fresh) || own(fresh, "id") !== id) throw new CheckFailed([`build definition ${id}: unexpected response.`]);
          await this.client.write("PUT", path, API.buildDefinitions, { ...fresh, queueStatus: want });
        },
      };
    });
  }

  /**
   * ADR-0039 decision 4: the app repository authorised for this pipeline only (allPipelines off,
   * other pipelines revoked), for an app with repository.template:
   *   - stack: only a repository provisioning created (empty, or its default branch created by a
   *     push of the caller); a repository it created that is open to all pipelines is closed;
   *   - byo: a repository open to all pipelines (from before ADR-0039) is left as it is;
   *   - another app's delivery pipeline on the repository is never revoked: blocked;
   *   - H2: the caller is a Project Administrator of the apps project (`ado bootstrap --phase
   *     grants`), which Azure DevOps requires: Contribute, Manage permissions and Administer on the
   *     repository were refused with HTTP 401 "The resource doesn't exist or the user doesn't have
   *     admin permission" (ADO-1, ADO-26);
   *   - H3: if Azure DevOps refuses anyway (HTTP 401 or 403: a repository in another project, or
   *     an instance whose bootstrap predates H2), the row waits for a person (exit 3). Rights are
   *     never escalated here.
   * Without repository.template (legacy) as before ADR-0039: this pipeline is added, others kept.
   */
  private async authoriseRepository(project: Ref, pipelineId: () => number | null): Promise<void> {
    const repo = this.r.appRepo!;
    const label = `${this.r.appsProject.name}/${repo.name}`;
    const resourceId = `${this.r.appsProject.id}.${repo.id}`;
    if (this.mode === "legacy") {
      await this.ensurePermission(project, { type: "repository", id: resourceId, label, exclusive: false }, pipelineId);
      return;
    }
    const pipeline = `${DELIVERY_FOLDER}\\${adoDeliveryPipeline(this.app.slug)}`;
    const caller = this.r.caller;
    await this.step("pipeline-permission", `repository ${label}`, async () => {
      if (!caller) throw new CheckFailed(["the caller's identity is unresolved (see above)."]);
      const branch = `refs/heads/${this.app.repository.defaultBranch ?? "main"}`;
      const created = this.mode === "stack" && ((await this.isEmpty(this.r.appsProject, repo.id)) || (await this.seededBy(this.r.appsProject, repo.id, branch, caller)));
      if (this.mode === "stack" && !created) throw new CheckFailed([`provisioning did not create this repository (${branch} was not pushed by ${caller.name}): no pipeline is authorised on it (ADR-0039).`]);
      const path = `${seg(project.name)}/_apis/pipelines/pipelinepermissions/repository/${seg(resourceId)}`;
      const current = await this.client.get(path, API.pipelinePermissions);
      const pid = pipelineId();
      const all = isObject(current) ? own(current, "allPipelines") : undefined;
      const openToAll = isObject(all) && own(all, "authorized") === true;
      if (openToAll && !created) return { status: "ok", detail: "open to all pipelines of the project (a repository from before ADR-0039; left as it is)" };
      const authorized = (isObject(current) && Array.isArray(own(current, "pipelines")) ? (own(current, "pipelines") as unknown[]) : [])
        .filter((p) => isObject(p) && own(p, "authorized") === true)
        .map((p) => Number(own(p as Record<string, unknown>, "id")));
      const extras = authorized.filter((x) => x !== pid);
      if (extras.length) {
        const names = new Map(
          (await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" }))
            .filter(isObject)
            .map((p) => [Number(own(p, "id")), `${String(own(p, "folder"))}\\${String(own(p, "name"))}`] as const),
        );
        const others = extras.filter((x) => (names.get(x) ?? "").startsWith(`${DELIVERY_FOLDER}\\delivery-`));
        if (others.length) {
          throw new CheckFailed([`it is also authorised for ${others.map((x) => `${names.get(x)} (${x})`).join(", ")}: another app's delivery pipeline is never revoked here. Each app needs its own repository; fix the app definitions or the authorisation by hand.`]);
        }
      }
      const missing = pid === null || !authorized.includes(pid);
      if (!missing && !extras.length && !openToAll) return { status: "ok", detail: `pipeline ${pid} only` };
      const parts = [
        ...(missing ? [pid === null ? `authorize ${pipeline} (after it is created)` : `authorize pipeline ${pid}`] : []),
        ...(openToAll ? ["close access for all pipelines (a repository provisioning created)"] : []),
        ...(extras.length ? [`revoke pipelines ${extras.join(", ")}`] : []),
      ];
      return {
        status: extras.length ? "extra" : missing ? "create" : "update",
        detail: `${parts.join(", ")} (ADR-0039)`,
        change: async () => {
          const id = pipelineId();
          if (id === null) throw new CheckFailed(["the pipeline does not exist."]);
          try {
            await this.client.write("PATCH", path, API.pipelinePermissions, { allPipelines: { authorized: false }, pipelines: [{ id, authorized: true }, ...extras.map((x) => ({ id: x, authorized: false }))] });
          } catch (e) {
            const refused = e instanceof CheckFailed ? e.problems.map((p) => / returned HTTP (401|403)\b/.exec(p)?.[1]).find((s) => s !== undefined) : undefined;
            if (!refused) throw e;
            throw new WaitingFor([
              `H3, waiting for a project administrator: Azure DevOps refused to authorise ${pipeline} on ${label} (HTTP ${refused}). The ADO automation identity must be a Project Administrator of ${this.r.appsProject.name} (platform ado bootstrap --phase grants, ADR-0039 H2). Otherwise an administrator runs platform ado apply --phase pipelines for ${this.app.slug} with their own token, or chooses Permit on the run that waits for the repository (runbook).`,
            ]);
          }
        },
      };
    });
  }

  private async findServiceConnection(env: InstanceEnv): Promise<string | null> {
    const known = this.outputs.environments[env.name]?.serviceConnection?.id;
    if (known) return known;
    const hit = await this.lookupServiceConnection(this.r.platformProject, adoServiceConnection(this.app.slug, env.name));
    if (!hit) return null;
    this.outputs.environments[env.name]!.serviceConnection = hit;
    return hit.id;
  }

  private async findEnvironment(env: InstanceEnv): Promise<number | null> {
    const known = this.outputs.environments[env.name]?.environment?.id;
    if (known !== undefined) return known;
    const name = adoEnvironment(this.app.slug, env.name);
    const list = valueList(await this.client.get(`${seg(this.r.platformProject.name)}/_apis/pipelines/environments`, API.environments, { name }), "environments");
    const hit = list.find((v) => isObject(v) && own(v, "name") === name);
    if (!isObject(hit)) return null;
    this.outputs.environments[env.name]!.environment = { id: Number(own(hit, "id")), name };
    return Number(own(hit, "id"));
  }
}

/** The onboarding pull request's description (Azure DevOps keeps up to 4000 characters). */
function onboardingDescription(slug: string, coreVersion: string, changes: RenderedFile[]): string {
  const head = [
    `The platform adds its agent files (AGENTS.md, skills, tool settings) and platform.yaml for app ${slug}, rendered by core ${coreVersion} (ADR-0039).`,
    "",
    "Nothing else changes and nothing is pushed to the default branch. Existing files are kept: files the platform creates are only added when missing, ignore files get missing lines appended, platform-managed files are replaced (AGENTS.md keeps its app-notes block), and .claude/skills mirrors .agents/skills. Review and merge it when it fits; the app's agent then follows the bring-your-own checklist in the app-contract-and-docker skill.",
  ];
  if (changes.length) head.push("", "Files:");
  const lines = changes.map((c) => `- ${c.change === "add" ? "new" : c.change === "edit" ? "changed" : "deleted"}: ${c.path}`);
  let text = head.join("\n");
  for (const [i, l] of lines.entries()) {
    if (text.length + l.length + 40 > 4000) {
      text += `\n- ... and ${lines.length - i} more`;
      break;
    }
    text += `\n${l}`;
  }
  return text;
}

/** What desiredChecksFor needs from Azure DevOps (resolved by Planner.resolve, or placeholders offline). */
export interface ChecksContext {
  /** Prod approvers' identity IDs; null = unresolved (the approval row is blocked). */
  approvers: string[] | null;
  selfApproval: boolean;
  /** platform-config's default branch as a ref (refs/heads/<name>). */
  configDefaultBranch: string;
}

/**
 * The checks the platform owns on an app's service connection (endpoint) or environment in one
 * environment (ADR-0021, ADR-0029): Required template (the core release's app-delivery.yml),
 * Exclusive lock on environments, Approval on prod environments, Branch control on prod.
 */
export function desiredChecksFor(
  inst: Instance & { approvals?: { allowSelfApproval?: boolean } },
  app: AppData,
  env: InstanceEnv,
  resourceType: "environment" | "endpoint",
  ctx: ChecksContext,
  settings: Settings = DEFAULT_SETTINGS,
): DesiredCheck[] {
  const ado = inst.scm.azureDevOps!;
  const prod = env.kind === "prod";
  const out: DesiredCheck[] = [
    requiredTemplateCheck({ repositoryType: "git", repositoryName: `${ado.platformProject}/core`, repositoryRef: `refs/tags/${inst.coreVersion}`, templatePath: "pipelines/azure-devops/app-delivery.yml" }),
  ];
  if (resourceType === "environment") out.push(exclusiveLockCheck());
  if (prod && resourceType === "environment") {
    out.push(
      approvalCheck(
        ctx.approvers,
        `Prod release of ${app.slug}: check the run summary (scan verdict, what-if preview).`,
        "the prod approvers are unresolved (see the identity line above)",
        ctx.selfApproval,
      ),
    );
  }
  if (prod) {
    out.push(branchControlCheck([ctx.configDefaultBranch, `refs/heads/${app.repository.defaultBranch ?? "main"}`, "refs/tags/v*"], settings.ensureProtectionOfBranch));
  }
  return out;
}

/**
 * The offline view of an app's Azure DevOps objects (ADR-0048, unit `ado`): what `platform ado
 * apply` makes them look like, rendered from instance.yaml and app.yaml alone, without reading
 * Azure DevOps or Azure. What only Azure or Azure DevOps knows is left out: the delivery
 * identities' client IDs (landing-zone outputs), the resolved approvers and every object ID. The
 * Required template ref (refs/tags/<coreVersion>) is in it, so every core version changes it.
 * `platform provisioning units` hashes it; nothing deploys it.
 */
export function adoOfflineView(
  inst: Instance & { approvals?: { platformTeam?: { objectId: string; displayName?: string }; prodDeployApprovers?: string; allowSelfApproval?: boolean } },
  app: AppData,
  envs: InstanceEnv[],
): Record<string, unknown> {
  const ado = inst.scm.azureDevOps;
  if (inst.scm.provider !== "azureDevOps" || !ado) throw new CheckFailed(["instance.yaml scm.provider must be azureDevOps."]);
  const ctx: ChecksContext = {
    approvers: null,
    selfApproval: inst.approvals?.allowSelfApproval === true,
    configDefaultBranch: `refs/heads/${platformConfigDefaultBranch(inst)}`,
  };
  const check = (c: DesiredCheck): Record<string, unknown> => ({ label: c.label, type: c.type.id, timeout: c.timeout, settings: c.settings ?? null });
  return {
    view: "ado-offline-view v1",
    organizationUrl: ado.organizationUrl ?? null,
    platformProject: ado.platformProject,
    platformConfigRepo: ado.platformConfigRepo ?? "platform-config",
    configDefaultBranch: ctx.configDefaultBranch,
    tenantId: inst.tenantId ?? "",
    approvals: {
      prodDeployApprovers: inst.approvals?.prodDeployApprovers ?? "platformTeam",
      platformTeam: inst.approvals?.platformTeam?.objectId ?? null,
      allowSelfApproval: ctx.selfApproval,
    },
    settings: { ensureProtectionOfBranch: DEFAULT_SETTINGS.ensureProtectionOfBranch, pipelineSettings: PIPELINE_SETTINGS.map(([f]) => f) },
    slug: app.slug,
    repository: {
      project: app.repository.project,
      name: app.repository.name,
      defaultBranch: app.repository.defaultBranch ?? "main",
      mode: repoMode(app),
      template: repositoryTemplate(app) ?? null,
    },
    environments: envs.map((env) => ({
      name: env.name,
      kind: env.kind,
      serviceConnection: {
        name: adoServiceConnection(app.slug, env.name),
        subscriptionId: env.subscriptionId,
        subscriptionName: `${inst.naming.prefix}-${env.name}`,
        checks: desiredChecksFor(inst, app, env, "endpoint", ctx).map(check),
      },
      environment: {
        name: adoEnvironment(app.slug, env.name),
        checks: desiredChecksFor(inst, app, env, "environment", ctx).map(check),
      },
    })),
    pipeline: { name: adoDeliveryPipeline(app.slug), folder: DELIVERY_FOLDER, path: `apps/${app.slug}/delivery.yml` },
  };
}
