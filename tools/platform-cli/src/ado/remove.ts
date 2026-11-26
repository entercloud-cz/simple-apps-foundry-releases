import { CheckFailed, isObject, own } from "../pipeline/common.js";
import type { DecommissionSettings } from "../decommission.js";
import type { Instance, InstanceEnv } from "../provisioning/model.js";
import type { AppData } from "../validate-app.js";
import { API } from "./api-versions.js";
import type { AdoClient } from "./client.js";
import { seg, valueList } from "./client.js";
import { adoDeliveryPipeline, adoEnvironment, adoServiceConnection, DELIVERY_FOLDER } from "./names.js";
import { repoMode } from "./plan.js";
import { Blocked, Reported, StepRunner, lower, obj } from "./steps.js";
import type { Ref } from "./steps.js";

/**
 * `platform ado remove plan|apply` (ADR-0056, the delete phase of a decommissioned app, unit `ado`
 * with action delete, stage ado_resources): the app's Azure DevOps objects, each only when it proves
 * to be this app's (hard rule 10, ADR-0052). Gone already = ok (a partial delete resumes).
 *
 *   pipeline            \apps\delivery-{slug}: only when its YAML is apps/{slug}/delivery.yml of
 *                       platform-config (otherwise blocked: never another pipeline)
 *   service connection  sc-{slug}-{env}: only when it federates the app's delivery identity of that
 *                       environment (its client ID from the landing zone, --lz-outputs); a connection
 *                       without that proof is blocked (a person looks). Its checks go with it. Only
 *                       for an environment named by --landing-zone-gone (its resource group was
 *                       deleted in this run or before, step 2): Azure DevOps refuses to delete a
 *                       connection while a federated credential of its identity exists ("Cannot
 *                       delete this service connection while federated credentials for app ...
 *                       exist", sandbox run 3421), and the delivery identity's credential goes with
 *                       the group. Before that the proven connection waits (a warning, exit 0), so
 *                       step 1 finishes and is recorded (ADR-0056 amendment 2026-11-12)
 *   environment         {slug}-{env}: only with the description the platform wrote, or the one Azure
 *                       DevOps gives an environment it created by itself when the caller created it
 *                       (ADR-0056 amendment item 7); its checks and deployment history go with it
 *   repository          every repository the definition names (a starter, bring-your-own or
 *                       unmanaged one, ADR-0039) is renamed {name}-deleted-{requestedOn}, with
 *                       -i{incarnation} above incarnation 0, and -2 … -9 after it while Azure DevOps
 *                       answers that the name exists, so its name is free for a new app (ADR-0061
 *                       section 4, amended 2026-11-16); with instance.yaml decommission.repository
 *                       delete a starter the platform created is renamed, then deleted. A
 *                       bring-your-own or unmanaged repository is only renamed, never deleted. A
 *                       refused rename only reports (warn); without a repository of its old name it
 *                       is done (ok: renamed or deleted, by a run or by hand)
 *
 * The pipeline goes first (it references the connections and environments). Exit code as `ado
 * apply`: 1 when a row is blocked or a change failed, so the unit isn't recorded as removed and the
 * next window tries again. TODO(verify) DECOM-5: the automation identity may delete what it created
 * (pipeline, connections, environments), and the DELETE endpoints below.
 */
/** The description Azure DevOps gives an environment it creates by itself (not one a person writes). */
const AUTO_CREATED = "Automatically created environment";

/**
 * Azure DevOps' limit on a Git repository's name (Microsoft Learn, "Naming restrictions": at most 64
 * Unicode characters); app.yaml repository.name has the same maxLength.
 */
export const ADO_REPOSITORY_NAME_MAX = 64;

/**
 * How many names the rename of a decommissioned app's repository tries: the first one, then -2 … -9
 * after it while Azure DevOps answers that a repository of the name exists (ADR-0061 section 4).
 */
export const DELETED_REPOSITORY_NAME_TRIES = 9;

/**
 * The name a decommissioned app's repository gets (ADR-0061 section 4, every repository since the
 * amendment of 2026-11-16), so its own name is free for a new app: {name}-deleted-{requestedOn}
 * (decommission.requestedOn, YYYY-MM-DD), with -i{incarnation} above incarnation 0 (app.yaml
 * incarnation, ADR-0061 section 6: a later app of the slug, deleted on the same day as an earlier one,
 * gets another name). `attempt` 2 … DELETED_REPOSITORY_NAME_TRIES adds -{attempt}: the next try after
 * Azure DevOps answered that a repository of the name exists (HTTP 409, TF400948; sandbox run 3662).
 * Never cut: a name that would be longer than ADO_REPOSITORY_NAME_MAX returns { problem } (a person
 * renames it).
 */
export function deletedRepositoryName(name: string, requestedOn: string | undefined, incarnation = 0, attempt = 1): string | { problem: string } {
  if (!requestedOn || !/^\d{4}-\d{2}-\d{2}$/.test(requestedOn)) return { problem: "the app has no decommission.requestedOn to name its kept repository with" };
  if (!Number.isSafeInteger(incarnation) || incarnation < 0) return { problem: `the app's incarnation must be an integer >= 0 to name its kept repository with, got ${String(incarnation).slice(0, 20)}` };
  if (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > DELETED_REPOSITORY_NAME_TRIES) throw new CheckFailed([`internal: rename attempt ${attempt} of a repository.`]);
  const base = `${name}-deleted-${requestedOn}${incarnation > 0 ? `-i${incarnation}` : ""}`;
  const renamed = attempt === 1 ? base : `${base}-${attempt}`;
  if (renamed.length > ADO_REPOSITORY_NAME_MAX) {
    return { problem: `the new name ${renamed} would have ${renamed.length} characters, Azure DevOps allows ${ADO_REPOSITORY_NAME_MAX}; it is never cut: rename the repository by hand (runbook decommission-app.md), then the next run goes on` };
  }
  return renamed;
}

/** Azure DevOps refused a repository's new name because a repository of that name exists (HTTP 409, TF400948; sandbox run 3662). */
const nameTaken = (e: CheckFailed): boolean => e.problems.some((p) => / returned HTTP 409\b/.test(p) || /\bTF400948\b/.test(p));

export class Remover extends StepRunner {
  constructor(
    client: AdoClient,
    private readonly inst: Instance,
    private readonly app: AppData,
    private readonly envs: InstanceEnv[],
    apply: boolean,
    private readonly deliveryClientIds: Record<string, string>,
    private readonly settings: DecommissionSettings,
    private readonly landingZoneGone: ReadonlySet<string> = new Set(),
  ) {
    super(client, apply);
  }

  async run(): Promise<void> {
    const ado = this.inst.scm.azureDevOps;
    if (this.inst.scm.provider !== "azureDevOps" || !ado) throw new CheckFailed(["instance.yaml scm.provider must be azureDevOps."]);
    const project = await this.project(ado.platformProject);
    const configRepo = await this.repoRef(project, ado.platformConfigRepo ?? "platform-config");
    this.add({ status: "ok", kind: "project", name: `${project.name} (${project.id})` });
    await this.pipeline(project, configRepo);
    for (const env of this.envs) await this.serviceConnection(project, env);
    for (const env of this.envs) await this.environment(project, env);
    await this.repository();
  }

  private async repoRef(project: Ref, name: string): Promise<Ref> {
    const r = await this.client.find(`${seg(project.name)}/_apis/git/repositories/${seg(name)}`, API.git);
    if (!isObject(r) || typeof own(r, "id") !== "string") throw new CheckFailed([`repository ${project.name}/${name} not found.`]);
    return { id: own(r, "id") as string, name: own(r, "name") as string };
  }

  private async pipeline(project: Ref, configRepo: Ref): Promise<void> {
    const name = adoDeliveryPipeline(this.app.slug);
    const path = `apps/${this.app.slug}/delivery.yml`;
    await this.step("pipeline", `${DELIVERY_FOLDER}\\${name}`, async () => {
      const list = await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" });
      const hit = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name && own(v, "folder") === DELIVERY_FOLDER);
      if (!hit) return { status: "ok", detail: "gone" };
      const id = Number(own(hit, "id"));
      const full = obj(await this.client.get(`${seg(project.name)}/_apis/pipelines/${id}`, API.pipelines));
      const conf = obj(own(full, "configuration"));
      const p = String(own(conf, "path") ?? "").replace(/^\//, "");
      // The guard: the pipeline is the app's delivery pipeline from platform-config, nothing else.
      if (p !== path || lower(own(obj(own(conf, "repository")), "id")) !== lower(configRepo.id)) {
        return { status: "blocked", detail: `id ${id} points at ${p || "?"} in another repository: not this app's delivery pipeline, left alone` };
      }
      return { status: "extra", detail: `id ${id}: delete`, change: async () => void (await this.client.write("DELETE", `${seg(project.name)}/_apis/build/definitions/${id}`, API.buildDefinitions, undefined)) };
    });
  }

  private async serviceConnection(project: Ref, env: InstanceEnv): Promise<void> {
    const name = adoServiceConnection(this.app.slug, env.name);
    await this.step("service-connection", name, async () => {
      const list = valueList(await this.client.get(`${seg(project.name)}/_apis/serviceendpoint/endpoints`, API.serviceEndpoints, { endpointNames: name }), "endpoints");
      const hit = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
      if (!hit) return { status: "ok", detail: "gone" };
      const id = String(own(hit, "id"));
      const want = this.deliveryClientIds[env.name];
      const got = own(obj(own(obj(own(hit, "authorization")), "parameters")), "serviceprincipalid");
      // The guard: it federates this app's delivery identity of that environment.
      if (!want) return { status: "blocked", detail: `no delivery identity client ID for ${env.name} (--lz-outputs): can't prove it is this app's, left alone` };
      if (lower(got) !== lower(want)) {
        // A connection of an earlier delivery identity of the app (its resource group was deleted by hand and
        // the identity created again; sandbox run 3763): the platform's when this automation identity created
        // it for the environment's subscription. That identity is gone, so no federated credential holds the
        // delete back, and it goes now. Anything else is left alone.
        const sub = own(obj(own(hit, "data")), "subscriptionId");
        if ((await this.createdByCaller(hit)) && lower(sub) === lower(env.subscriptionId)) {
          return {
            status: "extra",
            detail: `id ${id}: delete (it federates an earlier delivery identity of the app, which is gone)`,
            change: async () => void (await this.client.write("DELETE", `_apis/serviceendpoint/endpoints/${seg(id)}`, API.serviceEndpoints, undefined, { projectIds: project.id })),
          };
        }
        return { status: "blocked", detail: `id ${id} federates another identity than the app's delivery identity: left alone` };
      }
      // ADR-0056 amendment 2026-11-12: its federated credential lives on the delivery identity in the
      // app's resource group; Azure DevOps refuses the delete until that is gone (step 2).
      if (!this.landingZoneGone.has(env.name)) return { status: "warn", detail: `id ${id}: waits for the landing zone (its federated credential goes with the resource group); deleted after it, in step 2` };
      return {
        status: "extra",
        detail: `id ${id}: delete`,
        change: async () => void (await this.client.write("DELETE", `_apis/serviceendpoint/endpoints/${seg(id)}`, API.serviceEndpoints, undefined, { projectIds: project.id })),
      };
    });
  }

  private async environment(project: Ref, env: InstanceEnv): Promise<void> {
    const name = adoEnvironment(this.app.slug, env.name);
    const description = `Delivery of ${this.app.slug} to ${env.name} (managed by the platform).`;
    await this.step("environment", name, async () => {
      const list = valueList(await this.client.get(`${seg(project.name)}/_apis/pipelines/environments`, API.environments, { name }), "pipelines/environments");
      const hit = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
      if (!hit) return { status: "ok", detail: "gone" };
      const id = Number(own(hit, "id"));
      // The guard: the description the platform wrote when it created it, or Azure DevOps' own text for an
      // environment it created by itself, when the caller (this automation identity) created it. Sandbox
      // run 3441: after the platform's environment was deleted, Azure DevOps created demo4-nonprod again
      // as the automation identity, "Automatically created environment", which no person writes.
      // TODO(verify) DECOM-20: which call makes Azure DevOps create it again.
      const desc = own(hit, "description");
      const auto = desc === AUTO_CREATED && (await this.createdByCaller(hit));
      if (desc !== description && !auto) return { status: "blocked", detail: `id ${id} has another description than the platform writes: left alone` };
      return {
        status: "extra",
        detail: `id ${id}: delete (with its checks and deployment history)${auto ? "; Azure DevOps created it again by itself as this identity" : ""}`,
        change: async () => void (await this.client.write("DELETE", `${seg(project.name)}/_apis/distributedtask/environments/${id}`, API.environments, undefined)),
      };
    });
  }

  /**
   * The app repository (ADR-0039, ADR-0061 section 4, amended 2026-11-16). Every repository the
   * definition names, a starter the platform created, a bring-your-own or an unmanaged one, is renamed
   * {name}-deleted-{requestedOn}, with -i{incarnation} above incarnation 0 (deletedRepositoryName), so
   * its name is free for a new app. When Azure DevOps answers that a repository of that name exists
   * (HTTP 409, TF400948; sandbox run 3662: an earlier app of the slug, deleted the same day before the
   * incarnation was part of the name; or another app's, or one a person made), the rename tries -2 …
   * -9 after it; when every one is taken, it reports as a refused rename. With instance.yaml
   * decommission.repository delete a starter is renamed first and then deleted (the project's recycle
   * bin keeps a deleted repository for a while, under the new name); a bring-your-own or unmanaged
   * repository belongs to the team and is only renamed, never deleted. The repository is this app's by
   * its definition: validation lets no other app in apps/ name it (repositoryChecks, which counts a
   * decommissioned app's repository too). A refused rename only reports (a warn row, exit 0): a taken
   * repository name blocks nothing. A new name longer than Azure DevOps allows is never cut, the first
   * one or a later try: the row is blocked and a person renames the repository (runbook), after which
   * the old name is gone and the row is ok. Idempotent: without a repository of the old name the
   * repository is done (ok): renamed by an earlier run (under whichever name) or by hand, or deleted;
   * also when its project isn't there (or this identity can't see it). A repository under a new name
   * is never looked up, so a later run never deletes one: with the suffixes, a name of the rule can be
   * another app's kept repository.
   * Verify in sandbox: DECOM-22 (the automation identity renames the repository it created), DECOM-24
   * (a repository it didn't create: bring-your-own or unmanaged; the next name after a 409).
   */
  private async repository(): Promise<void> {
    const { project, name } = this.app.repository;
    const label = `${project}/${name}`;
    const starter = repoMode(this.app) === "stack";
    const del = starter && this.settings.repository === "delete";
    const requestedOn = this.app.decommission?.requestedOn;
    const incarnation = this.app.incarnation ?? 0;
    const target = deletedRepositoryName(name, requestedOn, incarnation);
    await this.step("repository", label, async () => {
      const p = await this.client.find(`_apis/projects/${seg(project)}`, API.projects);
      if (!isObject(p) || typeof own(p, "name") !== "string") return { status: "ok", detail: `gone: the project ${project} isn't there (or this identity can't see it), nothing to rename` };
      const projectName = own(p, "name") as string;
      const repoPath = (nameOrId: string): string => `${seg(projectName)}/_apis/git/repositories/${seg(nameOrId)}`;
      const r = await this.client.find(repoPath(name), API.git);
      const id = isObject(r) && typeof own(r, "id") === "string" ? (own(r, "id") as string) : undefined;
      // Done: no repository has the old name any more. Renamed by an earlier run (a partial delete
      // resumes; step 2 of the delete phase runs this again), or renamed or deleted by hand (e.g. after
      // a blocked row for a new name over 64 characters, runbook).
      if (!id) return { status: "ok", detail: "gone: no repository with this name (renamed or deleted, by a run or by hand)" };
      if (typeof target !== "string") return { status: "blocked", detail: target.problem };
      const deleting = "the project's recycle bin keeps it for a while; TODO(verify) DECOM-9";
      const whose = starter ? "" : "; the team's own repository: renamed, never deleted";
      return {
        status: "extra",
        detail: del ? `id ${id}: rename to ${target}, then delete (${deleting})` : `id ${id}: rename to ${target} (kept; its name is free for a new app${whose})`,
        change: async () => {
          const renamed = await this.renameRepository(repoPath(id), name, target, requestedOn, incarnation);
          if (typeof renamed !== "string" && renamed.blocked) throw new Blocked([renamed.blocked]);
          const refused = typeof renamed === "string" ? undefined : renamed.refused;
          if (renamed !== target && typeof renamed === "string") {
            this.add({ status: "ok", kind: "repository", name: label, detail: `renamed to ${renamed}: Azure DevOps has a repository named ${target} already` });
          }
          if (!del) {
            if (refused) throw new Reported([`kept as ${name}: ${refused}; its name stays taken. Rename it by hand (runbook decommission-app.md) or leave it.`]);
            return;
          }
          try {
            await this.client.write("DELETE", repoPath(id), API.git, undefined);
          } catch (e) {
            if (!(e instanceof CheckFailed) || typeof renamed !== "string") throw e;
            // Its old name is gone now, so later runs count the repository done and never delete it.
            throw new CheckFailed([`renamed to ${renamed}, then the delete failed: ${e.problems.join(" ")} Later runs count it done (its old name is gone) and don't delete it: delete ${projectName}/${renamed} by hand (runbook decommission-app.md) or leave it kept.`]);
          }
          if (refused) this.add({ status: "warn", kind: "repository", name: label, detail: `deleted without the rename: ${refused}; the recycle bin holds it under its own name for a while` });
        },
      };
    });
  }

  /**
   * Renames the repository to `first` (deletedRepositoryName's first try), then -2 … -9 after it while
   * Azure DevOps answers that a repository of the name exists. Returns the new name; or `refused`
   * (Azure DevOps refused for another reason, or every name was taken); or `blocked` (the next name to
   * try would be longer than Azure DevOps allows: never cut).
   */
  private async renameRepository(path: string, name: string, first: string, requestedOn: string | undefined, incarnation: number): Promise<string | { refused?: string; blocked?: string }> {
    const taken: string[] = [];
    for (let attempt = 1; attempt <= DELETED_REPOSITORY_NAME_TRIES; attempt++) {
      const next = attempt === 1 ? first : deletedRepositoryName(name, requestedOn, incarnation, attempt);
      if (typeof next !== "string") return { blocked: `Azure DevOps has a repository named ${taken.join(", ")} already, and ${next.problem}` };
      try {
        await this.client.write("PATCH", path, API.git, { name: next });
        return next;
      } catch (e) {
        if (!(e instanceof CheckFailed)) throw e;
        if (!nameTaken(e)) return { refused: `Azure DevOps refused the rename to ${next} (${e.problems.join(" ")})` };
        taken.push(next);
      }
    }
    return { refused: `Azure DevOps has a repository with each name from ${taken[0]} to ${taken[taken.length - 1]} already, so it refused the rename` };
  }
}
