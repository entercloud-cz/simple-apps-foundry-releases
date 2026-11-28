import { CheckFailed, isObject, own } from "../pipeline/common.js";
import { API, BRANCH_CONTROL, CHECK_TYPE, HOSTED_QUEUE } from "./api-versions.js";
import { AdoClient, seg, valueList } from "./client.js";

/**
 * The object-by-object machinery shared by `platform ado plan|apply` (one app) and
 * `platform ado bootstrap plan|apply` (the platform's own objects): every object is read (GET),
 * compared on the subset the platform owns, and on apply created or updated. Nothing is deleted,
 * except an Approval check the instance no longer wants (sc-platform-entra with
 * approvals.entraChanges pullRequest, ADR-0051), shown as an `extra` row "remove: ...".
 */

export type Status = "create" | "update" | "ok" | "extra" | "warn" | "blocked";

export interface Item {
  status: Status;
  kind: string;
  name: string;
  detail?: string;
  /** Set after apply: "done" or the error. */
  result?: string;
  /**
   * A blocked row that only waits for a person's runbook step (ADR-0039 H3), not an error: when
   * every blocked or failed row is one, the command exits 3 and provisioning marks the app waiting.
   */
  waiting?: true;
}

/**
 * Thrown by a change that Azure DevOps refused and that a person has to do instead (a runbook step,
 * ADR-0039 H3): the row becomes blocked with `waiting`, its detail the step. Never escalates rights.
 */
export class WaitingFor extends CheckFailed {}

/**
 * Thrown by a change that Azure DevOps refused and that blocks nothing, so it is only reported (ADR-0061:
 * the rename of a decommissioned app's repository): the row becomes warn with the message, the command doesn't
 * fail on it.
 */
export class Reported extends CheckFailed {}

/**
 * Thrown by a change that finds, only while it runs, what a plan reports as a blocked row: a person has
 * to act before the next run goes on (ADR-0061: the next free name of a decommissioned app's repository
 * would be longer than Azure DevOps allows). The row becomes blocked with the message, without `waiting`
 * (exit 1, as a plan's blocked row).
 */
export class Blocked extends CheckFailed {}

/** Exit code of `platform ado` when the only open rows wait for a person (ADR-0039 H3). */
export const EXIT_WAITING = 3;

/** 0 all done, 3 only rows that wait for a person, 1 anything else blocked or failed. */
export function exitCode(items: Item[]): number {
  const open = items.filter((i) => i.status === "blocked" || (i.result !== undefined && i.result !== "done"));
  if (!open.length) return 0;
  return open.every((i) => i.waiting) ? EXIT_WAITING : 1;
}

export interface Ref {
  id: string;
  name: string;
}

export interface ServiceConnectionOut {
  id: string;
  name: string;
  issuer: string | null;
  subject: string | null;
}

/** A check the platform owns on a resource, with how to find and compare an existing one. */
export interface DesiredCheck {
  label: string;
  type: { id: string; name: string };
  timeout: number;
  settings?: Record<string, unknown>;
  match: (c: Record<string, unknown>) => boolean;
  compare: (c: Record<string, unknown>) => string[];
  /** A reason the check cannot be planned (e.g. unresolved approvers): the row is blocked. */
  blockedBy?: (existing: Record<string, unknown> | undefined) => string | undefined;
}

export const lower = (s: unknown): string => (typeof s === "string" ? s.toLowerCase() : "");

/**
 * The ACEs of an access control list read with `descriptors=<one descriptor>`. Azure DevOps has already filtered them
 * to that identity, and keys its ACE by the identity's canonical descriptor, which can differ from the descriptor the
 * identities search returned: an alias ([org]\Project Collection Build Service Accounts on the test instance, ONB-2).
 * So every entry is the identity's. Matching the key against the descriptor asked for missed it, and each plan
 * created the same ACE again.
 */
export function filteredAces(acl: unknown): Record<string, unknown>[] {
  const dict = isObject(acl) ? own(acl, "acesDictionary") : undefined;
  return isObject(dict) ? Object.values(dict).filter((v): v is Record<string, unknown> => isObject(v)) : [];
}
export const obj = (v: unknown): Record<string, unknown> => (isObject(v) ? v : {});

export const typeIs = (t: { id: string }) => (c: Record<string, unknown>) => lower(own(obj(own(c, "type")), "id")) === t.id;
export const settingsOf = (c: Record<string, unknown>): Record<string, unknown> => (isObject(own(c, "settings")) ? (own(c, "settings") as Record<string, unknown>) : {});
export const timeoutDiff = (c: Record<string, unknown>, t: number): string[] => (own(c, "timeout") === t ? [] : [`timeout ${String(own(c, "timeout"))} -> ${t}`]);

/**
 * Pauses before retrying a check on a resource created in this run. Azure DevOps gives the creator
 * of a service connection Administer on it, but not at once: a check POSTed right after the
 * connection got HTTP 403 (sandbox, provisioning run 2905). About 90 s in all.
 */
const FRESH_RESOURCE_DELAYS_MS = [3000, 6000, 12000, 24000, 48000];
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Issuer and subject as Azure DevOps returns them on a WIF service connection. */
export function connectionOut(v: unknown, name: string): ServiceConnectionOut {
  const auth = isObject(v) ? own(v, "authorization") : undefined;
  const params = isObject(auth) ? own(auth, "parameters") : undefined;
  return {
    id: String(isObject(v) ? own(v, "id") : ""),
    name,
    issuer: isObject(params) && typeof own(params, "workloadIdentityFederationIssuer") === "string" ? (own(params, "workloadIdentityFederationIssuer") as string) : null,
    subject: isObject(params) && typeof own(params, "workloadIdentityFederationSubject") === "string" ? (own(params, "workloadIdentityFederationSubject") as string) : null,
  };
}

export abstract class StepRunner {
  readonly items: Item[] = [];
  /** IDs of the service connections and environments this run created (fresh-resource retries). */
  protected readonly createdNow = new Set<string>();

  constructor(
    protected readonly client: AdoClient,
    protected readonly apply: boolean,
  ) {}

  protected add(item: Item): Item {
    this.items.push(item);
    return item;
  }

  /** Whether an object's createdBy is the caller (connectionData: the ADO automation identity in the pipeline). */
  protected async createdByCaller(hit: Record<string, unknown>): Promise<boolean> {
    const by = own(obj(own(hit, "createdBy")), "id");
    if (typeof by !== "string" || by === "") return false;
    this.callerIdCache ??= await (async () => {
      const cd = await this.client.get("_apis/connectionData", API.connectionData);
      const id = isObject(cd) ? own(obj(own(cd, "authenticatedUser")), "id") : undefined;
      return typeof id === "string" ? id : "";
    })();
    return this.callerIdCache !== "" && lower(by) === lower(this.callerIdCache);
  }

  private callerIdCache: string | undefined;

  /** Runs one object: plan, and on apply perform the change. Errors become a blocked item. */
  protected async step(kind: string, name: string, fn: () => Promise<{ status: Status; detail?: string; change?: () => Promise<void> }>): Promise<void> {
    try {
      const r = await fn();
      const item = this.add({ kind, name, status: r.status, ...(r.detail ? { detail: r.detail } : {}) });
      if (this.apply && r.change) {
        try {
          await r.change();
          item.result = "done";
        } catch (e) {
          if (!(e instanceof CheckFailed)) throw e;
          if (e instanceof Reported) {
            item.status = "warn";
            item.detail = e.problems.join(" ");
          } else if (e instanceof WaitingFor) {
            item.status = "blocked";
            item.detail = e.problems.join(" ");
            item.waiting = true;
          } else if (e instanceof Blocked) {
            item.status = "blocked";
            item.detail = e.problems.join(" ");
          } else item.result = e.problems.join(" ");
        }
      }
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      this.add({ kind, name, status: "blocked", detail: e.problems.join(" ") });
    }
  }

  protected async project(name: string): Promise<Ref> {
    const p = await this.client.find(`_apis/projects/${seg(name)}`, API.projects);
    if (!isObject(p) || typeof own(p, "id") !== "string") throw new CheckFailed([`project ${name} not found.`]);
    return { id: own(p, "id") as string, name: own(p, "name") as string };
  }

  protected async repo(projectName: string, name: string): Promise<Ref & { defaultBranch: string }> {
    const r = await this.client.find(`${seg(projectName)}/_apis/git/repositories/${seg(name)}`, API.git);
    if (!isObject(r) || typeof own(r, "id") !== "string") throw new CheckFailed([`repository ${projectName}/${name} not found.`]);
    return { id: own(r, "id") as string, name: own(r, "name") as string, defaultBranch: typeof own(r, "defaultBranch") === "string" ? (own(r, "defaultBranch") as string) : "refs/heads/main" };
  }

  /** A repository by name, or null when Azure DevOps answers 404. */
  protected async findRepo(projectName: string, name: string): Promise<(Ref & { defaultBranch: string | null }) | null> {
    const r = await this.client.find(`${seg(projectName)}/_apis/git/repositories/${seg(name)}`, API.git);
    if (r === undefined) return null;
    if (!isObject(r) || typeof own(r, "id") !== "string") throw new CheckFailed([`repository ${projectName}/${name}: unexpected response.`]);
    return { id: own(r, "id") as string, name: own(r, "name") as string, defaultBranch: typeof own(r, "defaultBranch") === "string" ? (own(r, "defaultBranch") as string) : null };
  }

  /**
   * A managed identity in the organization (id-{prefix}-ado-automation, id-{prefix}-portal), by its
   * Entra object ID: graph service principal (originId) -> identity, or null. The identity (ID and
   * identity descriptor, for ACEs) and its Graph subject descriptor (memberships). Used by `ado
   * bootstrap` (grants) and `ado plan` (the portal identity's Reader on the app's connections, ADR-0058).
   */
  protected async orgIdentity(originId: string): Promise<{ id: string; descriptor: string; subjectDescriptor: string } | null> {
    const list = await this.client.list("_apis/graph/serviceprincipals", API.graph, {}, "vssps");
    const sp = list.find((v) => isObject(v) && lower(own(v, "originId")) === lower(originId));
    if (!isObject(sp) || typeof own(sp, "descriptor") !== "string") return null;
    const subjectDescriptor = own(sp, "descriptor") as string;
    const ids = valueList(await this.client.get("_apis/identities", API.identities, { subjectDescriptors: subjectDescriptor, queryMembership: "None" }, "vssps"), "_apis/identities");
    const hit = ids.find((v) => isObject(v) && typeof own(v, "id") === "string" && typeof own(v, "descriptor") === "string");
    return isObject(hit) ? { id: own(hit, "id") as string, descriptor: own(hit, "descriptor") as string, subjectDescriptor } : null;
  }

  /** The descriptor of the one identity (vssps search) that `match` accepts. */
  protected async identity(filterValue: string, match: (v: Record<string, unknown>) => boolean): Promise<string | null> {
    const list = valueList(await this.client.get("_apis/identities", API.identities, { searchFilter: "General", filterValue, queryMembership: "None" }, "vssps"), "_apis/identities");
    const hits = list.filter((v): v is Record<string, unknown> => isObject(v) && match(v));
    return hits.length === 1 && typeof own(hits[0]!, "descriptor") === "string" ? (own(hits[0]!, "descriptor") as string) : null;
  }

  /**
   * The approvers of an Approval check: an Entra group (instance approvals.platformTeam) as an
   * Azure DevOps identity. Found by display name; a hit is accepted only when the organization's
   * Graph shows it as the Entra group with the configured object ID (origin aad, originId): the
   * identity record of a group has no objectidentifier property, unlike a user's (ADO-23, sandbox).
   * Azure DevOps knows the group only once it is a member of some Azure DevOps group. Adds the row
   * `label` (ok, or blocked with the reason); null when unresolved. Used by `ado plan` (the prod
   * approvers) and `ado bootstrap` (sc-platform-entra, ADR-0023).
   */
  /**
   * An Entra group as an Azure DevOps identity, found by display name and accepted only when the organization's Graph
   * shows it as the Entra group with that object ID (origin aad, originId). Undefined while Azure DevOps doesn't know
   * it: it knows an Entra group only once the group is a member of one of its groups (ADO-23).
   */
  protected async findEntraGroup(team: { objectId: string; displayName: string }): Promise<Record<string, unknown> | undefined> {
    const list = valueList(await this.client.get("_apis/identities", API.identities, { searchFilter: "General", filterValue: team.displayName, queryMembership: "None" }, "vssps"), "_apis/identities");
    for (const v of list) {
      const descriptor = isObject(v) ? own(v, "subjectDescriptor") : undefined;
      if (!isObject(v) || own(v, "isContainer") !== true || typeof descriptor !== "string" || !descriptor.startsWith("aadgp.")) continue;
      const group = await this.client.find(`_apis/graph/groups/${seg(descriptor)}`, API.graph, {}, "vssps");
      if (isObject(group) && own(group, "origin") === "aad" && lower(own(group, "originId")) === lower(team.objectId)) return v;
    }
    return undefined;
  }

  /** The Graph descriptor of the project group [{project}]\{name} (e.g. Readers, Project Administrators). */
  protected async projectGroupDescriptor(p: Ref, name: string): Promise<string> {
    const scope = await this.client.get(`_apis/graph/descriptors/${seg(p.id)}`, API.graph, {}, "vssps");
    const scopeDescriptor = isObject(scope) ? own(scope, "value") : undefined;
    if (typeof scopeDescriptor !== "string") throw new CheckFailed([`no Graph descriptor for the project ${p.name}.`]);
    const groups = await this.client.list("_apis/graph/groups", API.graph, { scopeDescriptor }, "vssps");
    const hit = groups.find((g) => isObject(g) && lower(own(g, "principalName")) === lower(`[${p.name}]\\${name}`));
    const descriptor = isObject(hit) ? own(hit, "descriptor") : undefined;
    if (typeof descriptor !== "string") throw new CheckFailed([`no group [${p.name}]\\${name}.`]);
    return descriptor;
  }

  protected async resolveApprovers(team: { objectId: string; displayName?: string } | undefined, label: string): Promise<string[] | null> {
    if (!team?.displayName) {
      this.add({ status: "blocked", kind: "identity", name: label, detail: "approvals.platformTeam.displayName is needed to find the group in Azure DevOps." });
      return null;
    }
    const hit = await this.findEntraGroup({ objectId: team.objectId, displayName: team.displayName });
    if (!isObject(hit) || typeof own(hit, "id") !== "string") {
      this.add({ status: "blocked", kind: "identity", name: label, detail: `Entra group ${team.objectId} (${team.displayName}) not found in the organization (ADO-23): add it to an Azure DevOps group first, so that Azure DevOps knows it (instance.sh ado projects --apply adds it to the platform project's Readers).` });
      return null;
    }
    this.add({ status: "ok", kind: "identity", name: label, detail: `${team.displayName} -> ${own(hit, "id") as string}` });
    return [own(hit, "id") as string];
  }

  /**
   * approvals.allowSelfApproval (ADR-0034): true lets the requester approve their own runs, for
   * single-operator instances. Adds the warn row `label` while it is on.
   */
  protected selfApproval(approvals: { allowSelfApproval?: boolean } | undefined, label: string): boolean {
    if (approvals?.allowSelfApproval !== true) return false;
    this.add({ status: "warn", kind: "identity", name: label, detail: "approvals.allowSelfApproval is true: the requester can approve their own runs (single-operator instances only, ADR-0034)." });
    return true;
  }

  /**
   * The action bits named `names` of a security namespace, read from the organization (never
   * hardcoded). A missing name is a blocked row; returns null then.
   */
  protected async namespaceBits(label: string, id: string, names: readonly string[]): Promise<Record<string, number> | null> {
    let actions: unknown[] = [];
    try {
      const ns = valueList(await this.client.get(`_apis/securitynamespaces/${seg(id)}`, API.securityNamespaces), "securitynamespaces")[0];
      actions = isObject(ns) && Array.isArray(own(ns, "actions")) ? (own(ns, "actions") as unknown[]) : [];
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      this.add({ status: "blocked", kind: "namespace", name: label, detail: e.problems.join(" ") });
      return null;
    }
    const out: Record<string, number> = {};
    for (const a of actions) if (isObject(a) && typeof own(a, "name") === "string" && Number.isSafeInteger(own(a, "bit"))) out[own(a, "name") as string] = own(a, "bit") as number;
    const missing = names.filter((n) => !Object.hasOwn(out, n) || out[n]! <= 0);
    if (missing.length) {
      this.add({ status: "blocked", kind: "namespace", name: label, detail: `no action ${missing.join(", ")} in security namespace ${id}.` });
      return null;
    }
    return out;
  }

  /** The explicit allow and deny bits of `descriptor` on `token` (its own ACE only, nothing inherited). */
  protected async aceBits(namespace: string, token: string, descriptor: string): Promise<{ allow: number; deny: number }> {
    const acls = valueList(await this.client.get(`_apis/accesscontrollists/${namespace}`, API.accessControl, { token, descriptors: descriptor }), "accesscontrollists");
    let allow = 0;
    let deny = 0;
    for (const acl of acls) {
      for (const ace of filteredAces(acl)) {
        allow |= Number(own(ace, "allow") ?? 0);
        deny |= Number(own(ace, "deny") ?? 0);
      }
    }
    return { allow, deny };
  }

  /**
   * One ACE: `allow` bits present (and not denied), or `deny` bits present. `descriptor` null =
   * the identity does not exist yet: planned as create, re-resolved (`later`) when applying.
   */
  protected async ace(
    kind: string,
    name: string,
    namespace: string,
    token: string,
    descriptor: string | null,
    bits: { allow?: number; deny?: number },
    later?: { why: string; resolve: () => Promise<string | null> },
  ): Promise<void> {
    await this.step(kind, name, async () => {
      const wantAllow = bits.allow ?? 0;
      const wantDeny = bits.deny ?? 0;
      const entry = { allow: wantAllow, deny: wantDeny };
      const write = async (d: string): Promise<void> => {
        await this.client.write("POST", `_apis/accesscontrolentries/${namespace}`, API.accessControl, { token, merge: true, accessControlEntries: [{ descriptor: d, ...entry }] });
      };
      if (!descriptor) {
        if (!later) throw new CheckFailed(["identity unresolved (see above)."]);
        return {
          status: "create",
          detail: `${wantAllow ? `allow ${wantAllow}` : `deny ${wantDeny}`}, ${later.why}`,
          change: async () => {
            const d = await later.resolve();
            if (!d) throw new CheckFailed(["the identity still does not exist."]);
            await write(d);
          },
        };
      }
      const { allow, deny } = await this.aceBits(namespace, token, descriptor);
      if (wantAllow && deny & wantAllow) throw new CheckFailed([`an explicit deny (${deny}) blocks the permission; remove it by hand.`]);
      if ((allow & wantAllow) === wantAllow && (deny & wantDeny) === wantDeny) return { status: "ok", detail: `allow ${allow}, deny ${deny}` };
      return { status: "create", detail: wantAllow ? `allow ${wantAllow}` : `deny ${wantDeny}`, change: async () => write(descriptor) };
    });
  }

  /**
   * A WIF service connection (Azure Resource Manager, managed identity, subscription scope, not
   * shared) in `project`; `record` receives what Azure DevOps returns, issuer and subject included.
   */
  protected async ensureServiceConnection(
    project: Ref,
    spec: {
      name: string;
      clientId: string;
      tenantId: string;
      subscriptionId: string;
      subscriptionName: string;
      description: string;
      /**
       * An app's connection (`ado apply`): one that differs is deleted and created again, since the landing
       * zone's second pass federates the new subject in the same run. Without it (the platform's own
       * connections of `ado bootstrap`, whose federation bootstrap pass 2 deploys) it is updated in place.
       */
      replace?: boolean;
    },
    record: (out: ServiceConnectionOut) => void,
  ): Promise<void> {
    const { name, clientId, tenantId: tenant } = spec;
    await this.step("service-connection", name, async () => {
      const list = valueList(await this.client.get(`${seg(project.name)}/_apis/serviceendpoint/endpoints`, API.serviceEndpoints, { endpointNames: name }), "serviceendpoint/endpoints");
      const existing = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name);
      const body = {
          name,
          type: "AzureRM",
          url: "https://management.azure.com/",
          description: spec.description,
          isShared: false,
          isReady: true,
          owner: "Library",
          authorization: { scheme: "WorkloadIdentityFederation", parameters: { serviceprincipalid: clientId, tenantid: tenant } },
          data: { environment: "AzureCloud", scopeLevel: "Subscription", subscriptionId: spec.subscriptionId, subscriptionName: spec.subscriptionName, creationMode: "Manual", identityType: "ManagedIdentity" },
          serviceEndpointProjectReferences: [{ name, description: "", projectReference: { id: project.id, name: project.name } }],
        };
      const create = async (): Promise<void> => {
        let out = connectionOut(await this.client.write("POST", "_apis/serviceendpoint/endpoints", API.serviceEndpoints, body), name);
        if (!out.issuer) out = connectionOut(valueList(await this.client.get(`${seg(project.name)}/_apis/serviceendpoint/endpoints`, API.serviceEndpoints, { endpointNames: name }), "endpoints")[0], name);
        if (out.id) this.createdNow.add(out.id);
        record(out);
      };
      if (!existing) return { status: "create", detail: `WIF, identity ${clientId}, subscription ${spec.subscriptionId}`, change: create };
      record(connectionOut(existing, name));
      const auth = own(existing, "authorization");
      const params = isObject(auth) ? own(auth, "parameters") : undefined;
      const data = own(existing, "data");
      if (lower(own(existing, "type")) !== "azurerm" || !isObject(auth) || own(auth, "scheme") !== "WorkloadIdentityFederation" || !isObject(params) || !isObject(data)) {
        throw new CheckFailed([`${name} exists but is not an Azure Resource Manager connection with workload identity federation; fix it by hand.`]);
      }
      if (own(existing, "isShared") === true) throw new CheckFailed([`${name} is shared with other projects; unshare it by hand.`]);
      const diffs: string[] = [];
      if (lower(own(params, "serviceprincipalid")) !== lower(clientId)) diffs.push(`serviceprincipalid ${String(own(params, "serviceprincipalid"))} -> ${clientId}`);
      if (lower(own(params, "tenantid")) !== lower(tenant)) diffs.push(`tenantid -> ${tenant}`);
      if (lower(own(data, "subscriptionId")) !== lower(spec.subscriptionId)) diffs.push(`subscriptionId -> ${spec.subscriptionId}`);
      if (own(data, "identityType") !== "ManagedIdentity" || own(data, "scopeLevel") !== "Subscription") diffs.push("identityType ManagedIdentity, scopeLevel Subscription");
      const id = String(own(existing, "id"));
      if (!diffs.length) return { status: "ok", detail: `id ${id}` };
      if (!spec.replace) {
        // TODO(verify) ADO-2: Azure DevOps refuses this PUT on an app's managed-identity connection (sandbox run
        // 3760); for the platform's own connections of `ado bootstrap` it hasn't been tried.
        const updated = {
          ...existing,
          authorization: { ...auth, parameters: { ...params, serviceprincipalid: clientId, tenantid: tenant } },
          data: { ...data, subscriptionId: spec.subscriptionId, identityType: "ManagedIdentity", scopeLevel: "Subscription" },
        };
        return {
          status: "update",
          detail: diffs.join(", "),
          change: async () => record(connectionOut(await this.client.write("PUT", `_apis/serviceendpoint/endpoints/${seg(id)}`, API.serviceEndpoints, updated), name)),
        };
      }
      // Azure DevOps doesn't edit a managed-identity connection: a PUT that changes it answers HTTP 400
      // "Editing managed identity service connections is not supported" (sandbox run 3760, after the
      // app's resource group was deleted by hand and its deploy identity created again with a new client
      // ID). So the connection is deleted and created again under its name: a new ID and subject, whose
      // federated credential the landing zone's second pass deploys in the same run (azure_post_<env>),
      // and the checks after this step are created on it (on apply, each step's change runs before the
      // next step is planned). The old one's identity is not the app's any more, so no federated
      // credential of it holds the delete back. Only a connection this automation identity created
      // (createdBy: the proof it is the platform's, ADR-0052); one a person made is left for a person.
      // Verify in sandbox: ADO-29.
      if (!(await this.createdByCaller(existing))) {
        throw new CheckFailed([
          `${name} (${diffs.join(", ")}) was created by someone else than this automation identity, and Azure DevOps doesn't edit a managed-identity connection: delete it by hand, and the next run creates it.`,
        ]);
      }
      return {
        status: "update",
        detail: `${diffs.join(", ")}: deleted and created again (Azure DevOps doesn't edit a managed-identity connection)`,
        change: async () => {
          await this.client.write("DELETE", `_apis/serviceendpoint/endpoints/${seg(id)}`, API.serviceEndpoints, undefined, { projectIds: project.id });
          await create();
        },
      };
    });
  }

  /** The checks the platform owns on one resource: created, updated, others reported as extra. */
  /**
   * The desired checks on a resource: created, or updated where they differ. Other checks are
   * `extra` rows left in place, except those `remove` names a reason for: removed on apply.
   */
  protected async ensureChecks(
    project: Ref,
    res: { type: "environment" | "endpoint"; id: () => string | null; name: string },
    desired: DesiredCheck[],
    remove?: (c: Record<string, unknown>) => string | undefined,
  ): Promise<void> {
    const id = res.id();
    let existing: Record<string, unknown>[] = [];
    if (id) {
      try {
        existing = valueList(
          await this.client.get(`${seg(project.name)}/_apis/pipelines/checks/configurations`, API.checks, { resourceType: res.type, resourceId: id, $expand: "settings" }),
          "checks/configurations",
        ).filter(isObject);
      } catch (e) {
        if (!(e instanceof CheckFailed)) throw e;
        this.add({ status: "blocked", kind: "check", name: `${res.name}: checks`, detail: e.problems.join(" ") });
        return;
      }
    }
    const used = new Set<Record<string, unknown>>();
    for (const d of desired) {
      // Match first, so an existing check is never reported as "extra" when this one is blocked.
      const found = existing.find((c) => !used.has(c) && d.match(c));
      if (found) used.add(found);
      await this.step("check", `${res.name}: ${d.label}`, async () => {
        const blocked = d.blockedBy?.(found);
        if (blocked) throw new CheckFailed([blocked]);
        const body = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
          ...extra,
          type: d.type,
          timeout: d.timeout,
          ...(d.settings ? { settings: d.settings } : {}),
          resource: { type: res.type, id: res.id(), name: res.name },
        });
        if (!found) {
          return {
            status: "create",
            ...(id ? {} : { detail: `after the ${res.type} is created` }),
            change: async () => {
              if (!res.id()) throw new CheckFailed([`${res.name} does not exist.`]);
              // Only on a resource this run created: elsewhere a 403 is a missing permission.
              const fresh = this.createdNow.has(String(res.id()));
              for (let attempt = 0; ; attempt++) {
                try {
                  await this.client.write("POST", `${seg(project.name)}/_apis/pipelines/checks/configurations`, API.checks, body());
                  return;
                } catch (e) {
                  const delay = FRESH_RESOURCE_DELAYS_MS[attempt];
                  if (!fresh || delay === undefined || !(e instanceof CheckFailed) || !e.problems.some((p) => / returned HTTP 403\b/.test(p))) throw e;
                  await sleep(delay);
                }
              }
            },
          };
        }
        const diffs = d.compare(found);
        if (!diffs.length) return { status: "ok", detail: `id ${String(own(found, "id"))}` };
        return {
          status: "update",
          detail: diffs.join(", "),
          change: async () => {
            await this.client.write("PATCH", `${seg(project.name)}/_apis/pipelines/checks/configurations/${seg(String(own(found, "id")))}`, API.checks, body({ id: own(found, "id") }), { $expand: "settings" });
          },
        };
      });
    }
    for (const c of existing.filter((x) => !used.has(x))) {
      const t = own(c, "type");
      const name = `${res.name}: ${String(isObject(t) ? own(t, "name") : "?")} (id ${String(own(c, "id"))})`;
      const why = remove?.(c);
      if (!why) {
        this.add({ status: "extra", kind: "check", name, detail: "not managed by the platform; left in place" });
        continue;
      }
      // A check the platform owns but no longer wants (sc-platform-entra's Approval with
      // approvals.entraChanges pullRequest, ADR-0051): removed on apply.
      await this.step("check", name, async () => ({
        status: "extra",
        detail: `remove: ${why}`,
        change: async () => void (await this.client.write("DELETE", `${seg(project.name)}/_apis/pipelines/checks/configurations/${seg(String(own(c, "id")))}`, API.checks, undefined)),
      }));
    }
  }

  /**
   * A YAML pipeline `{folder}\{name}` from `path` in `configRepo`. A new one is created, previewed
   * and its build definition re-saved (ADO-24); an existing one is previewed on apply, and
   * re-saved when `resave` is set or when it is still at revision 1 (created, but the re-save after
   * creation never happened, e.g. because its YAML did not load then). `preview: false` leaves the
   * preview of an existing pipeline to the caller (a delivery pipeline whose queue may be disabled,
   * ADR-0056: a disabled definition refuses the preview).
   */
  protected async ensurePipeline(project: Ref, spec: { name: string; folder: string; path: string; configRepo: Ref; resave: boolean; preview?: boolean }, record: (id: number) => void): Promise<void> {
    const { name, folder, path, configRepo } = spec;
    const previewExisting = spec.preview ?? true;
    await this.step("pipeline", `${folder}\\${name}`, async () => {
      const list = await this.client.list(`${seg(project.name)}/_apis/pipelines`, API.pipelines, { $top: "1000" });
      const existing = list.find((v): v is Record<string, unknown> => isObject(v) && own(v, "name") === name && own(v, "folder") === folder);
      if (existing) {
        const id = Number(own(existing, "id"));
        record(id);
        const full = await this.client.get(`${seg(project.name)}/_apis/pipelines/${id}`, API.pipelines);
        const conf = isObject(full) ? own(full, "configuration") : undefined;
        const repo = isObject(conf) ? own(conf, "repository") : undefined;
        const p = isObject(conf) ? String(own(conf, "path") ?? "").replace(/^\//, "") : "";
        if (p !== path || !isObject(repo) || lower(own(repo, "id")) !== lower(configRepo.id)) {
          throw new CheckFailed([`${name} (id ${id}) points at ${p || "?"} in another repository; fix it by hand.`]);
        }
        const neverResaved = isObject(full) && own(full, "revision") === 1;
        if (spec.resave || neverResaved) {
          return {
            status: "update",
            detail: `id ${id}: re-save the build definition (registers the app repo trigger, ADO-24${neverResaved ? "; never re-saved since its creation" : ""})`,
            change: async () => {
              if (previewExisting) await this.preview(project, id, path);
              await this.resave(project, id);
            },
          };
        }
        return previewExisting ? { status: "ok", detail: `id ${id}`, change: async () => this.preview(project, id, path) } : { status: "ok", detail: `id ${id}` };
      }
      return {
        status: "create",
        detail: `${path} in ${configRepo.name}`,
        change: async () => {
          const created = await this.client.write("POST", `${seg(project.name)}/_apis/pipelines`, API.pipelines, {
            name,
            folder,
            configuration: { type: "yaml", path, repository: { id: configRepo.id, type: "azureReposGit" } },
          });
          if (!isObject(created) || typeof own(created, "id") !== "number") throw new CheckFailed([`creating ${name} returned no id.`]);
          const id = own(created, "id") as number;
          record(id);
          await this.preview(project, id, path);
          await this.resave(project, id);
        },
      };
    });
  }

  /** POST preview: the YAML loads (otherwise the repository trigger may stay unregistered, ADO-5/24). */
  protected async preview(project: Ref, id: number, path: string): Promise<void> {
    try {
      await this.client.write("POST", `${seg(project.name)}/_apis/pipelines/${id}/preview`, API.pipelines, { previewRun: true });
    } catch (e) {
      if (!(e instanceof CheckFailed)) throw e;
      throw new CheckFailed([`the pipeline's YAML does not load (${e.problems.join(" ")}); fix ${path.split("/").pop() ?? path}, then run apply --resave (ADO-24).`]);
    }
  }

  /**
   * ADO-24 (verified in the sandbox, 2026-10-29): a pipeline created through `POST _apis/pipelines`
   * does not register its repository-resource trigger, even when its YAML is valid and the preview
   * succeeds; a push to the app repo starts nothing. Saving the build definition unchanged
   * (`GET` then `PUT _apis/build/definitions/{id}`, revision n -> n+1) registers it: the next push
   * started a run. Done after every create, and on `apply --resave` for existing pipelines.
   */
  protected async resave(project: Ref, id: number): Promise<void> {
    const path = `${seg(project.name)}/_apis/build/definitions/${id}`;
    const def = await this.client.get(path, API.buildDefinitions);
    const before = isObject(def) ? own(def, "revision") : undefined;
    if (!isObject(def) || typeof before !== "number" || own(def, "id") !== id) throw new CheckFailed([`build definition ${id}: unexpected response (no id or revision).`]);
    // A definition without a default queue doesn't load (sandbox run 2890): give it the hosted one.
    if (!isObject(own(def, "queue"))) def.queue = { id: await this.hostedQueue(project) };
    const saved = await this.client.write("PUT", path, API.buildDefinitions, def);
    const after = isObject(saved) ? own(saved, "revision") : undefined;
    if (typeof after !== "number" || after <= before) {
      throw new CheckFailed([`re-saving build definition ${id} did not create a new revision (${before} -> ${String(after)}); its trigger may stay unregistered (ADO-24).`]);
    }
  }

  /**
   * Pipeline permission on a resource: the pipeline authorised; `exclusive` = no other pipeline
   * and no open access (others are revoked and reported as extra). `alsoAllowed`: further pipelines
   * that must be authorised too and stay so under `exclusive` (the provisioning connection of an
   * environment serves its platform pipeline as well, ADR-0043).
   */
  protected async ensurePermission(
    project: Ref,
    res: { type: string; id: string | null; label: string; exclusive: boolean },
    pipelineId: () => number | null,
    missingHint = "run --phase resources first",
    alsoAllowed: () => (number | null)[] = () => [],
  ): Promise<void> {
    await this.step("pipeline-permission", `${res.type} ${res.label}`, async () => {
      if (!res.id) throw new CheckFailed([`${res.label} does not exist (${missingHint}).`]);
      const path = `${seg(project.name)}/_apis/pipelines/pipelinepermissions/${res.type}/${seg(res.id)}`;
      const current = await this.client.get(path, API.pipelinePermissions);
      const wanted = [pipelineId(), ...alsoAllowed()];
      const all = isObject(current) ? own(current, "allPipelines") : undefined;
      const openToAll = isObject(all) && own(all, "authorized") === true;
      const authorized = (isObject(current) && Array.isArray(own(current, "pipelines")) ? (own(current, "pipelines") as unknown[]) : [])
        .filter((p) => isObject(p) && own(p, "authorized") === true)
        .map((p) => Number(own(p as Record<string, unknown>, "id")));
      const extras = res.exclusive ? authorized.filter((id) => !wanted.includes(id)) : [];
      // A shared resource open to every pipeline of the project (the core repo, ADR-0031) needs no
      // authorisation per pipeline.
      if (!res.exclusive && openToAll) return { status: "ok", detail: "open to all pipelines of the project" };
      const missing = wanted.filter((pid) => pid === null || !authorized.includes(pid));
      const parts: string[] = [];
      for (const pid of missing) parts.push(pid === null ? "authorize the pipeline (after it is created)" : `authorize pipeline ${pid}`);
      if (openToAll && res.exclusive) parts.push("close access for all pipelines");
      if (extras.length) parts.push(`revoke pipelines ${extras.join(", ")}`);
      if (!parts.length) return { status: "ok", detail: `pipeline${wanted.length > 1 ? "s" : ""} ${wanted.join(", ")}` };
      const status: Status = extras.length ? "extra" : missing.length ? "create" : "update";
      return {
        status,
        detail: parts.join(", "),
        change: async () => {
          const ids = [pipelineId(), ...alsoAllowed()];
          if (ids.some((id) => id === null)) throw new CheckFailed(["the pipeline does not exist."]);
          await this.client.write("PATCH", path, API.pipelinePermissions, {
            ...(res.exclusive ? { allPipelines: { authorized: false } } : {}),
            pipelines: [...(ids as number[]).map((id) => ({ id, authorized: true })), ...extras.map((x) => ({ id: x, authorized: false }))],
          });
        },
      };
    });
  }

  /**
   * ADO-20 (ADR-0029 item 6): the project's Contributors hold at most Reader on its environments, so
   * a pipeline run can't create a missing environment (without checks) on first use. Reader or no
   * role is ok; any other role is set to Reader.
   */
  protected async contributorsEnvironmentReader(project: Ref): Promise<void> {
    const contributors = `[${project.name}]\\Contributors`;
    await this.step("environment-role", `${contributors} on environments`, async () => {
      const path = `_apis/securityroles/scopes/distributedtask.globalenvironmentreferencerole/roleassignments/resources/${seg(project.id)}`;
      const list = valueList(await this.client.get(path, API.securityRoles), "securityroles");
      const a = list.find((v) => isObject(v) && isObject(own(v, "identity")) && own(obj(own(v, "identity")), "displayName") === contributors);
      if (!isObject(a)) return { status: "ok", detail: "no role" };
      const role = own(obj(own(a, "role")), "name");
      if (role === "Reader") return { status: "ok", detail: "Reader" };
      const userId = own(obj(own(a, "identity")), "id");
      return { status: "update", detail: `${String(role)} -> Reader (no environment auto-creation, ADO-20)`, change: async () => void (await this.client.write("PUT", path, API.securityRoles, [{ userId, roleName: "Reader" }])) };
    });
  }

  /** Withdraws every pipeline authorisation of a resource, open access included: none may use it. */
  protected async revokePermissions(project: Ref, res: { type: string; id: string; label: string }, why: string): Promise<void> {
    await this.step("pipeline-permission", `${res.type} ${res.label}`, async () => {
      const path = `${seg(project.name)}/_apis/pipelines/pipelinepermissions/${res.type}/${seg(res.id)}`;
      const current = await this.client.get(path, API.pipelinePermissions);
      const all = isObject(current) ? own(current, "allPipelines") : undefined;
      const openToAll = isObject(all) && own(all, "authorized") === true;
      const authorized = (isObject(current) && Array.isArray(own(current, "pipelines")) ? (own(current, "pipelines") as unknown[]) : [])
        .filter((p) => isObject(p) && own(p, "authorized") === true)
        .map((p) => Number(own(p as Record<string, unknown>, "id")));
      if (!openToAll && !authorized.length) return { status: "ok", detail: "no pipeline may use it" };
      const parts = [...(openToAll ? ["close access for all pipelines"] : []), ...(authorized.length ? [`revoke pipelines ${authorized.join(", ")}`] : [])];
      return {
        status: "extra",
        detail: `${parts.join(", ")}: ${why}`,
        change: async () => {
          await this.client.write("PATCH", path, API.pipelinePermissions, {
            allPipelines: { authorized: false },
            pipelines: authorized.map((id) => ({ id, authorized: false })),
          });
        },
      };
    });
  }

  /** The id of the project's Microsoft-hosted agent queue (HOSTED_QUEUE). */
  protected async hostedQueue(project: Ref): Promise<number> {
    const list = valueList(await this.client.get(`${seg(project.name)}/_apis/distributedtask/queues`, API.queues, { queueNames: HOSTED_QUEUE }), "distributedtask/queues");
    const q = list.find((v) => isObject(v) && own(v, "name") === HOSTED_QUEUE);
    if (!isObject(q) || !Number.isSafeInteger(own(q, "id"))) throw new CheckFailed([`no agent queue "${HOSTED_QUEUE}" visible in ${project.name} (the identity needs the User role on it: platform ado bootstrap --phase grants).`]);
    return own(q, "id") as number;
  }

  /** The id of the service connection called `name` in `project`, or null. */
  protected async lookupServiceConnection(project: Ref, name: string): Promise<ServiceConnectionOut | null> {
    const list = valueList(await this.client.get(`${seg(project.name)}/_apis/serviceendpoint/endpoints`, API.serviceEndpoints, { endpointNames: name }), "endpoints");
    const hit = list.find((v) => isObject(v) && own(v, "name") === name);
    return isObject(hit) ? connectionOut(hit, name) : null;
  }
}

/** The action names of `mask` in a security namespace (its bits from namespaceBits), or the number. */
export function bitNames(bits: Record<string, number>, mask: number): string {
  return Object.entries(bits).filter(([, bit]) => mask & bit).map(([n]) => n).join(", ") || String(mask);
}

/** The rows of a formatItems text (other lines skipped), for `platform instance status` (src/instance/onboarding.ts). */
export function parseItemRows(text: string): { status: Status; kind: string; text: string }[] {
  const out: { status: Status; kind: string; text: string }[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^(create|update|ok|extra|warn|blocked) +(\S+) +(\S.*?)\s*$/.exec(line);
    if (m) out.push({ status: m[1] as Status, kind: m[2]!, text: m[3]! });
  }
  return out;
}

export function formatItems(items: Item[], apply: boolean): string {
  const lines = items.map((i) => {
    const res = apply && i.result ? (i.result === "done" ? "  [done]" : `  [FAILED: ${i.result}]`) : "";
    return `${i.status.padEnd(8)}${i.kind.padEnd(20)}${i.name}${i.detail ? `  (${i.detail})` : ""}${res}`;
  });
  const count = (s: Status): number => items.filter((i) => i.status === s).length;
  lines.push(`${apply ? "Applied" : "Plan"}: ${count("create")} create, ${count("update")} update, ${count("extra")} extra, ${count("ok")} ok, ${count("warn")} warn, ${count("blocked")} blocked.`);
  return lines.join("\n") + "\n";
}

// ------------------------------------------------------------------------------------------
// Check payloads (types and settings from the sandbox's GETs, ADO-12)
// ------------------------------------------------------------------------------------------

export interface RequiredTemplate {
  repositoryType: "git";
  repositoryName: string;
  repositoryRef: string;
  templatePath: string;
}

/**
 * Required template: `templatePath` in `{repositoryName}` at `repositoryRef`; with several, a run
 * must extend one of them (the platform provisioning connections serve the provisioning pipeline
 * and the environment's platform pipeline, ADR-0043). Exactly this set, in any order.
 * Verify in sandbox: PLAT-1 (two entries mean "any of").
 */
export function requiredTemplateCheck(templates: RequiredTemplate | RequiredTemplate[]): DesiredCheck {
  const want = Array.isArray(templates) ? templates : [templates];
  const key = (t: Record<string, unknown>): string => `${String(own(t, "repositoryName"))}@${String(own(t, "repositoryRef"))}:${String(own(t, "templatePath"))}|${String(own(t, "repositoryType"))}`;
  const wantKeys = want.map((t) => key(t as unknown as Record<string, unknown>)).sort();
  return {
    label: "Required template",
    type: CHECK_TYPE.extends,
    timeout: 43200,
    settings: { extendsChecks: want },
    match: typeIs(CHECK_TYPE.extends),
    compare: (c) => {
      const list = own(settingsOf(c), "extendsChecks");
      const got = Array.isArray(list) && list.every((t) => isObject(t)) ? (list as Record<string, unknown>[]).map(key).sort() : [];
      const ok = got.length === wantKeys.length && got.every((k, i) => k === wantKeys[i]);
      return ok ? timeoutDiff(c, 43200) : [`template -> ${want.map((t) => `${t.repositoryName}@${t.repositoryRef}:${t.templatePath}`).join(" or ")}`];
    },
  };
}

/**
 * Approval by `approvers` (Azure DevOps identity IDs from resolveApprovers; null = unresolved, the
 * row is blocked with `unresolved` as the reason). Every approver must approve (one group: any of
 * its members), seven days to decide. The requester cannot approve unless `selfApproval`
 * (approvals.allowSelfApproval, ADR-0034).
 */
export function approvalCheck(approvers: string[] | null, instructions: string, unresolved: string, selfApproval: boolean): DesiredCheck {
  const settings = {
    approvers: (approvers ?? []).map((id) => ({ id })),
    blockedApprovers: [],
    executionOrder: "anyOrder",
    instructions: `${instructions} ${selfApproval ? "The requester can approve (approvals.allowSelfApproval)." : "The requester cannot approve."}`,
    minRequiredApprovers: 0,
    requesterCannotBeApprover: !selfApproval,
  };
  return {
    label: "Approval",
    type: CHECK_TYPE.approval,
    timeout: 10080,
    settings,
    match: typeIs(CHECK_TYPE.approval),
    blockedBy: (found) => (approvers === null ? `${unresolved}${found ? `; existing check id ${String(own(found, "id"))} left as it is` : ""}.` : undefined),
    compare: (c) => {
      const s = settingsOf(c);
      const diffs: string[] = [];
      const have = Array.isArray(own(s, "approvers")) ? (own(s, "approvers") as unknown[]).map((a) => lower(isObject(a) ? own(a, "id") : "")).sort() : [];
      const want = (approvers ?? []).map(lower).sort();
      if (approvers === null) diffs.push("approver unresolved");
      else if (have.join() !== want.join()) diffs.push(`approvers -> ${want.join(", ")}`);
      // Azure DevOps returns requesterCannotBeApprover only when it is true (sandbox).
      if ((own(s, "requesterCannotBeApprover") === true) === selfApproval) diffs.push(`requesterCannotBeApprover -> ${String(!selfApproval)}`);
      if (own(s, "minRequiredApprovers") !== 0) diffs.push("minRequiredApprovers -> 0 (all)");
      return [...diffs, ...timeoutDiff(c, 10080)];
    },
  };
}

export function exclusiveLockCheck(): DesiredCheck {
  return { label: "Exclusive lock", type: CHECK_TYPE.exclusiveLock, timeout: 43200, match: typeIs(CHECK_TYPE.exclusiveLock), compare: (c) => timeoutDiff(c, 43200) };
}

/** Branch control (task check evaluatebranchProtection) allowing only `branches`. */
export function branchControlCheck(branches: string[], ensureProtectionOfBranch: boolean): DesiredCheck {
  const inputs = { allowedBranches: [...new Set(branches)].join(","), ensureProtectionOfBranch: String(ensureProtectionOfBranch), allowUnknownStatusBranch: "false" };
  return {
    label: "Branch control",
    type: CHECK_TYPE.task,
    timeout: 1440,
    settings: { definitionRef: { ...BRANCH_CONTROL }, displayName: "Branch control", inputs, retryInterval: 5 },
    match: (c) => typeIs(CHECK_TYPE.task)(c) && own(obj(own(settingsOf(c), "definitionRef")), "name") === BRANCH_CONTROL.name,
    compare: (c) => {
      const have = own(settingsOf(c), "inputs");
      const diffs: string[] = [];
      const set = (v: unknown): string => (typeof v === "string" ? v.split(",").map((x) => x.trim()).filter(Boolean).sort().join(",") : "");
      if (!isObject(have)) return ["inputs missing"];
      if (set(own(have, "allowedBranches")) !== set(inputs.allowedBranches)) diffs.push(`allowedBranches -> ${inputs.allowedBranches}`);
      if (String(own(have, "ensureProtectionOfBranch")) !== inputs.ensureProtectionOfBranch) diffs.push(`ensureProtectionOfBranch -> ${inputs.ensureProtectionOfBranch}`);
      if (String(own(have, "allowUnknownStatusBranch")) !== "false") diffs.push("allowUnknownStatusBranch -> false");
      return [...diffs, ...timeoutDiff(c, 1440)];
    },
  };
}
