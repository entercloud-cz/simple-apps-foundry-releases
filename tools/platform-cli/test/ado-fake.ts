import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { join } from "node:path";
import { FIXTURES } from "./helpers.js";

/**
 * A fake Azure DevOps organization (dev.azure.com/{org} under /{org}/, vssps under /vssps/{org}/)
 * for `platform ado` tests. Its initial state is the sandbox's real GET responses, scrubbed to
 * placeholders (test/fixtures/ado/sandbox-responses.json): the delivery objects of app `demo`
 * in nonprod and prod. Writes change the state the way Azure DevOps does, and every request is
 * recorded.
 */

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export const ORG = "contoso";
export const TOKEN = "fake-ado-token-" + "y".repeat(24);
export const PLATFORM_ID = "00000000-0000-0000-0000-0000000000e1";
export const APPS_ID = "00000000-0000-0000-0000-0000000000a2";
export const GROUP_ID = "00000000-0000-0000-0000-0000000000a5";
export const GROUP_OID = "00000000-0000-0000-0000-00000000c002";
export const GROUP_DESCRIPTOR = "aadgp.Uy0xLTktMDAwMDAwMDAwMC00MjQyNDI";
/** Entra object ID of id-contoso-ado-automation (bootstrap --phase grants). */
export const AUTOMATION_OID = "00000000-0000-0000-0000-00000000f022";
/** Entra object ID of id-contoso-portal (ADR-0036); an organization administrator adds it, never the CLI. */
export const PORTAL_OID = "00000000-0000-0000-0000-00000000f042";
/** The caller of `platform ado plan|apply` (the ADO automation identity in the pipeline): connectionData. */
export const CALLER = { id: "00000000-0000-0000-0000-0000000000f5", descriptor: "Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;automation", providerDisplayName: "id-contoso-ado-automation" };
export const DEMO_REPO = "00000000-0000-0000-0000-0000000000b1";
export const CONFIG_REPO = "00000000-0000-0000-0000-0000000000b3";
/** Head of main of the demo repo (a bring-your-own repository with code, sandbox app `demo`). */
export const DEMO_HEAD = "c0ffee0000000000000000000000000000000001";
const ZERO = "0".repeat(40);

/** Git Repositories bits (security-definitions.json). */
export const GIT = { read: 2, contribute: 4, forcePush: 8, createBranch: 16, createTag: 32, createRepository: 256, removeOthersLocks: 4096, managePermissions: 8192, pullRequestContribute: 16384 } as const;

/** Groups the phase core (ADR-0067) reads, besides [Platform]\Contributors and the build service (sandbox shapes, trimmed). */
export const GROUPS = {
  buildAdmins: { id: "00000000-0000-0000-0000-000000000911", descriptor: "Microsoft.TeamFoundation.Identity;S-1-9-0000000000-911", subjectDescriptor: "vssgp.buildadmins", providerDisplayName: "[Platform]\\Build Administrators", isContainer: true },
  validUsers: { id: "00000000-0000-0000-0000-000000000912", descriptor: "Microsoft.TeamFoundation.Identity;S-1-9-0000000000-912", subjectDescriptor: "vssgp.validusers", providerDisplayName: "[Platform]\\Project Valid Users", isContainer: true },
  collectionBuild: { id: "00000000-0000-0000-0000-000000000913", descriptor: "Microsoft.TeamFoundation.Identity;S-1-9-0000000000-913", subjectDescriptor: "vssgp.collectionbuild", providerDisplayName: "[contoso]\\Project Collection Build Service Accounts", isContainer: true },
} as const;

/** The ACL token of a branch or branch folder (UTF-16LE hex per name part), as Azure DevOps writes it. */
export function branchTokenOf(projectId: string, repoId: string, branch: string): string {
  const parts = branch.replace(/^refs\/heads\//, "").replace(/\/+$/, "").split("/");
  return `repoV2/${projectId}/${repoId}/refs/heads/${parts.map((x) => Buffer.from(x, "utf16le").toString("hex")).join("/")}/`;
}

export const blobId = (b: Buffer): string => createHash("sha1").update(`blob ${b.length}\0`).update(b).digest("hex");

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  auth: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

/** A check as Azure DevOps stores it: an Approval keeps requesterCannotBeApprover only when true (sandbox). */
function stored(check: J): J {
  if (check.settings?.requesterCannotBeApprover !== false) return check;
  const { requesterCannotBeApprover: _, ...settings } = check.settings as J;
  return { ...check, settings };
}

export class FakeAdo {
  server!: Server;
  base = "";
  requests: Recorded[] = [];
  state!: J;
  /** Simulates a PUT of a build definition that doesn't create a new revision. */
  freezeRevisions = false;
  /** Pushes need the caller's Create branch / Contribute (repository or branch folder ACEs), as in Azure DevOps. */
  enforceGitRights = true;
  /** Calls answered with an error instead (method and a path substring), with Azure DevOps' error body. */
  /** Injected errors; `times` limits how often one fires (default: every matching request). */
  failures: { method: string; path: string; status: number; message: string; times?: number }[] = [];
  /** YAML files missing from platform-config (not generated yet): creating a pipeline on one is refused. */
  missingYaml: string[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (d: Buffer) => (raw += d.toString()));
      req.on("end", () => this.handle(req, res, raw));
    });
    await new Promise<void>((r) => this.server.listen(0, "127.0.0.1", r));
    this.base = `http://127.0.0.1:${(this.server.address() as { port: number }).port}`;
  }

  stop(): void {
    this.server.close();
  }

  get orgUrl(): string {
    return `${this.base}/${ORG}`;
  }

  /** The demo app fully configured (all `ok`), or an organization without any app objects. */
  reset(kind: "configured" | "empty"): void {
    const s = JSON.parse(readFileSync(join(FIXTURES, "ado", "sandbox-responses.json"), "utf8")) as J;
    // An Entra group known to the organization (sandbox shape, trimmed): the identity has no
    // objectidentifier property; its Entra object ID is the Graph group's originId.
    const approvalGroup = {
      id: GROUP_ID,
      descriptor: "Microsoft.TeamFoundation.Identity;S-1-9-0000000000-424242",
      subjectDescriptor: GROUP_DESCRIPTOR,
      providerDisplayName: "[TEAM FOUNDATION]\\sg-platform-team",
      isActive: true,
      isContainer: true,
      properties: {
        SchemaClassName: { $type: "System.String", $value: "Group" },
        Account: { $type: "System.String", $value: "sg-platform-team" },
        SpecialType: { $type: "System.String", $value: "AzureActiveDirectoryApplicationGroup" },
      },
    };
    this.requests = [];
    this.freezeRevisions = false;
    this.enforceGitRights = true;
    this.failures = [];
    this.missingYaml = [];
    this.state = {
      projects: [s["project-platform"], s["project-apps"]],
      repos: { "Apps/demo": s["repo-demo"], "Platform/core": s["repo-core"], "Platform/platform-config": s["repo-config"] },
      identities: [...s["identity-build"].value, ...s["identity-contrib"].value, approvalGroup, ...Object.values(GROUPS).map((g) => ({ ...g }))],
      endpoints: kind === "configured" ? s.endpoints.value : [],
      environments: kind === "configured" ? [...s["env-nonprod"].value, ...s["env-prod"].value] : [],
      checks: kind === "configured" ? [...s["checks-env-21"].value, ...s["checks-env-22"].value, ...s["checks-sc-nonprod"].value, ...s["checks-sc-prod"].value] : [],
      permissions: {} as Record<string, J>,
      envRoles: s["env-roles"].value,
      endpointRoles: s["endpoint-sec"].value,
      acls: {} as Record<string, J>,
      generalsettings: s.generalsettings,
      // Platform bootstrap (ado bootstrap): security definitions are the sandbox's real responses.
      security: JSON.parse(readFileSync(join(FIXTURES, "ado", "security-definitions.json"), "utf8")) as J,
      projectEndpointRoles: [] as J[],
      graphSps: [] as J[],
      /** Graph memberships "{subject}|{container}" (ADR-0039 H2: Project Administrators). */
      memberships: [] as string[],
      graphGroups: [{ subjectKind: "group", origin: "aad", originId: GROUP_OID, displayName: "sg-platform-team", principalName: "[TEAM FOUNDATION]\\sg-platform-team", descriptor: GROUP_DESCRIPTOR }] as J[],
      entitlements: {} as Record<string, J>,
      pipelines: kind === "configured" ? s.pipelines.value : s.pipelines.value.filter((p: J) => p.folder !== "\\apps"),
      pipelineDetails: { 42: s["pipeline-42"] } as Record<string, J>,
      // Build definitions (the classic view of a pipeline), trimmed to the fields that matter here.
      definitions: (kind === "configured"
        ? { 42: { id: 42, name: "delivery-demo", path: "\\apps", revision: 2, process: { type: 2, yamlFilename: "/apps/demo/delivery.yml" }, repository: { id: "00000000-0000-0000-0000-0000000000b3", type: "TfsGit" }, triggers: [] } }
        : {}) as Record<string, J>,
      // The project's agent queues: only the Microsoft-hosted one (real sandbox shape, trimmed).
      queues: [{ id: 140, name: "Azure Pipelines", pool: { id: 9, name: "Azure Pipelines", isHosted: true } }],
      nextId: 500,
      // Git: refs per repository id, files per commit, pull requests per repository id.
      caller: { ...CALLER },
      refs: { [DEMO_REPO]: [{ name: "refs/heads/main", objectId: DEMO_HEAD }] } as Record<string, J[]>,
      commits: {
        [DEMO_HEAD]: {
          "Dockerfile": Buffer.from("FROM node:22-alpine\nCOPY . .\nCMD [\"node\", \"src/app.js\"]\n"),
          ".gitignore": Buffer.from("node_modules\n"),
          "README.md": Buffer.from("# Demo\n\nOur own app.\n"),
          "src/app.js": Buffer.from("console.log('demo');\n"),
        },
      } as Record<string, Record<string, Buffer>>,
      pullRequests: {} as Record<string, J[]>,
      // Pushes per repository id, newest first (Pushes - List), as the push API records them.
      pushes: { [DEMO_REPO]: [{ pushId: 1, date: "2026-10-28T22:13:13Z", pushedBy: { id: "00000000-0000-0000-0000-0000000000a8", displayName: "Jane Owner" }, refUpdates: [{ name: "refs/heads/main", oldObjectId: ZERO, newObjectId: DEMO_HEAD }] }] } as Record<string, J[]>,
      policies: [] as J[],
      // ADR-0069: the organisation's processes (Microsoft Learn shape, trimmed) and asynchronous operations; each
      // operation answers the statuses in operationReplies in turn, then succeeded.
      processes: [
        { id: "00000000-0000-0000-0000-0000000000c1", name: "Agile", type: "system", isDefault: true },
        { id: "00000000-0000-0000-0000-0000000000c2", name: "Basic", type: "system", isDefault: false },
      ] as J[],
      operations: {} as Record<string, string[]>,
      // The tenant's Entra groups, for Graph Groups - Create (ADR-0069: the approvers made known to the organization).
      entraGroups: [{ originId: GROUP_OID, displayName: "sg-platform-team", descriptor: GROUP_DESCRIPTOR, identity: approvalGroup }] as J[],
      // ONB-2 (test instance): an identity can have a second descriptor, an alias. The identities search returns the
      // alias; ACLs key the identity's ACE by the canonical one, and a read filtered by the alias returns it under
      // that canonical key. Lower-case alias -> canonical descriptor.
      descriptorAliases: {} as Record<string, string>,
      operationReplies: [] as string[],
    };
    // In the sandbox the deputy approves; here the platform team group does (approvals.platformTeam).
    for (const c of this.state.checks) if (c.type.name === "Approval") c.settings.approvers = [{ id: GROUP_ID, displayName: null }];
    const aclOf = (a: J): void => {
      for (const acl of a.value) this.state.acls[acl.token] = acl;
    };
    if (kind === "configured") {
      for (const [k, f] of [["environment/21", "perm-env-21"], ["environment/22", "perm-env-22"], ["endpoint/00000000-0000-0000-0000-0000000000c1", "perm-sc-nonprod"], [`repository/${APPS_ID}.00000000-0000-0000-0000-0000000000b1`, "perm-repo-demo"], [`repository/${PLATFORM_ID}.00000000-0000-0000-0000-0000000000b2`, "perm-repo-core"]] as const) {
        this.state.permissions[k] = s[f];
      }
      this.state.permissions["endpoint/00000000-0000-0000-0000-0000000000c2"] = { pipelines: [{ authorized: true, id: 42 }], resource: { id: "00000000-0000-0000-0000-0000000000c2", type: "endpoint" } };
      aclOf(s["acl-repo"]);
      aclOf(s["acl-project"]);
      const contributors = this.state.identities[1].descriptor;
      this.state.acls[`${PLATFORM_ID}/apps`] = { token: `${PLATFORM_ID}/apps`, inheritPermissions: true, acesDictionary: { [contributors]: { descriptor: contributors, allow: 0, deny: 128 } } };

    } else {
      // The project ACL exists with other entries, the build service has none yet.
      this.state.acls[s["acl-project"].value[0].token] = { ...s["acl-project"].value[0], acesDictionary: {} };
    }
  }

  /**
   * id-contoso-portal as an organization administrator adds it (Organization settings > Users):
   * Graph service principal, identity and entitlement with `accountLicenseType`.
   */
  addPortalIdentity(accountLicenseType = "express"): { id: string; descriptor: string } {
    const id = "00000000-0000-0000-0000-0000000000f4";
    const descriptor = "Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;portal";
    const subjectDescriptor = "aadsp.portal";
    this.state.graphSps.push({ subjectKind: "servicePrincipal", origin: "aad", originId: PORTAL_OID, descriptor: subjectDescriptor, displayName: "id-contoso-portal" });
    this.state.identities.push({ id, descriptor, subjectDescriptor, providerDisplayName: "id-contoso-portal" });
    this.state.entitlements[id] = { id, accessLevel: { accountLicenseType, licensingSource: "account", licenseDisplayName: accountLicenseType === "express" ? "Basic" : accountLicenseType }, servicePrincipal: { origin: "aad", originId: PORTAL_OID, subjectKind: "servicePrincipal" } };
    return { id, descriptor };
  }

  /** The approvers' Entra group not yet known to the organization (ADO-23): no identity, no Graph group. */
  forgetApprovers(): void {
    this.state.identities = this.state.identities.filter((i: J) => i.id !== GROUP_ID);
    this.state.graphGroups = this.state.graphGroups.filter((g: J) => g.originId !== GROUP_OID);
  }

  /** Adds (merges) an allow entry, as POST accesscontrolentries with merge: true. */
  setAce(token: string, descriptor: string, allow: number, deny = 0): void {
    const acl = (this.state.acls[token] ??= { token, inheritPermissions: true, acesDictionary: {} });
    const key = this.canon(descriptor);
    const prev = acl.acesDictionary[key] ?? { descriptor: key, allow: 0, deny: 0 };
    acl.acesDictionary[key] = { descriptor: key, allow: prev.allow | allow, deny: prev.deny | deny };
  }

  /** The descriptor an ACE is stored under: the canonical one for an alias, else the descriptor itself. */
  canon(descriptor: string): string {
    return (this.state.descriptorAliases as Record<string, string>)[descriptor.toLowerCase()] ?? descriptor;
  }

  /** The allow bits `descriptor` has on `token` and every token above it (repository, folders). */
  private effectiveAllow(token: string, descriptor: string): number {
    let allow = 0;
    for (const [t, acl] of Object.entries(this.state.acls as Record<string, J>)) {
      if (!token.startsWith(t) || !t.startsWith("repoV2/")) continue;
      allow |= (acl.acesDictionary[this.canon(descriptor)]?.allow as number | undefined) ?? 0;
    }
    return allow;
  }

  /** A push as Pushes - List returns it (newest first). */
  recordPush(repoId: string, pusher: { id: string; providerDisplayName?: string }, ref: string, oldObjectId: string, newObjectId: string): void {
    (this.state.pushes[repoId] ??= []).unshift({ pushId: this.state.nextId++, date: "2026-10-30T12:00:00Z", pushedBy: { id: pusher.id, displayName: pusher.providerDisplayName ?? "someone" }, refUpdates: [{ name: ref, oldObjectId, newObjectId }] });
  }

  /** A repository by id, with its project name. */
  repoById(id: string): J | undefined {
    return Object.values(this.state.repos as Record<string, J>).find((r) => r.id === id);
  }

  /** The files of a branch of a repository (path -> content), or undefined. */
  filesOf(repoId: string, ref: string): Record<string, Buffer> | undefined {
    const head = (this.state.refs[repoId] ?? []).find((r: J) => r.name === ref);
    return head ? this.state.commits[head.objectId] : undefined;
  }

  private git(res: ServerResponse, method: string, project: string, repoId: string, rest: string, q: (k: string) => string, body: J): void {
    const st = this.state;
    const repo = this.repoById(repoId);
    if (!repo || repo.project.name !== project) return this.send(res, 404);
    const refs: J[] = (st.refs[repoId] ??= []);
    if (rest === "refs" && method === "GET") {
      const filter = q("filter");
      const hits = refs.filter((r) => !filter || r.name.startsWith(`refs/${filter}`));
      const top = Number(q("$top") || "0");
      return this.send(res, 200, { count: hits.length, value: top ? hits.slice(0, top) : hits });
    }
    if (rest === "pushes" && method === "GET") {
      const ref = q("searchCriteria.refName");
      const pusher = q("searchCriteria.pusherId").toLowerCase();
      const hits = (st.pushes[repoId] ?? []).filter((x: J) => (!ref || x.refUpdates.some((u: J) => u.name === ref)) && (!pusher || x.pushedBy.id.toLowerCase() === pusher));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (rest === "pushes" && method === "POST") {
      const ids: string[] = [];
      for (const [i, u] of (body.refUpdates as J[]).entries()) {
        const current = refs.find((r) => r.name === u.name);
        if (current && current.objectId !== u.oldObjectId) return this.send(res, 409, { message: "TF401028: The reference has already been updated by another client." });
        if (!current && u.oldObjectId !== ZERO && !st.commits[u.oldObjectId]) return this.send(res, 400, { message: "unknown base commit" });
        const token = branchTokenOf(repo.project.id, repoId, u.name);
        const need = current ? GIT.contribute : GIT.createBranch;
        if (this.enforceGitRights && !(this.effectiveAllow(token, st.caller.descriptor) & need)) return this.send(res, 403, { message: "TF401027: You need the Git 'CreateBranch' or 'GenericContribute' permission to perform this action." });
        const base: Record<string, Buffer> = u.oldObjectId === ZERO ? {} : { ...st.commits[u.oldObjectId] };
        for (const c of (body.commits as J[])[i]?.changes ?? []) {
          const path = String(c.item.path).replace(/^\//, "");
          if (c.changeType === "add" && base[path]) return this.send(res, 409, { message: `${path} exists` });
          if ((c.changeType === "edit" || c.changeType === "delete") && !base[path]) return this.send(res, 404, { message: `${path} not found` });
          if (c.changeType === "delete") delete base[path];
          else base[path] = c.newContent.contentType === "base64encoded" ? Buffer.from(c.newContent.content, "base64") : Buffer.from(c.newContent.content);
        }
        const id = createHash("sha1").update(`${repoId}${u.name}${st.nextId++}`).digest("hex");
        st.commits[id] = base;
        if (current) current.objectId = id;
        else {
          refs.push({ name: u.name, objectId: id });
          // The branch creator's explicit rights (Microsoft Learn, branch permissions).
          this.setAce(token, st.caller.descriptor, GIT.contribute | GIT.forcePush | GIT.removeOthersLocks | GIT.managePermissions);
        }
        repo.defaultBranch ??= u.name;
        repo.size = 1000;
        ids.push(id);
        this.recordPush(repoId, st.caller, u.name, current ? u.oldObjectId : ZERO, id);
      }
      return this.send(res, 201, { pushId: st.nextId++, refUpdates: body.refUpdates, commits: ids.map((commitId) => ({ commitId })) });
    }
    if (rest === "items" && method === "GET") {
      const files: Record<string, Buffer> | undefined = st.commits[q("versionDescriptor.version")];
      if (!files) return this.send(res, 404);
      if (q("path")) {
        const path = q("path").replace(/^\//, "");
        const f = files[path];
        return f ? this.send(res, 200, { path: `/${path}`, objectId: blobId(f), gitObjectType: "blob", content: f.toString("utf8") }) : this.send(res, 404);
      }
      const folders = new Set<string>();
      for (const p of Object.keys(files)) for (let i = p.indexOf("/"); i > 0; i = p.indexOf("/", i + 1)) folders.add(p.slice(0, i));
      const value = [
        { path: "/", isFolder: true, gitObjectType: "tree", objectId: "f".repeat(40) },
        ...[...folders].map((f) => ({ path: `/${f}`, isFolder: true, gitObjectType: "tree", objectId: "e".repeat(40) })),
        ...Object.entries(files).map(([p, b]) => ({ path: `/${p}`, gitObjectType: "blob", objectId: blobId(b) })),
      ];
      return this.send(res, 200, { count: value.length, value });
    }
    if (rest === "pullrequests") {
      const prs: J[] = (st.pullRequests[repoId] ??= []);
      if (method === "POST") {
        if (!refs.some((r) => r.name === body.sourceRefName) || !refs.some((r) => r.name === body.targetRefName)) return this.send(res, 400, { message: "TF401398: the source or target branch does not exist" });
        if (this.enforceGitRights && !(this.effectiveAllow(`repoV2/${repo.project.id}/${repoId}`, st.caller.descriptor) & GIT.pullRequestContribute)) return this.send(res, 403, { message: "TF401027: You need the Git 'PullRequestContribute' permission." });
        const pr = { ...body, pullRequestId: st.nextId++, status: "active", repository: { id: repoId } };
        prs.push(pr);
        return this.send(res, 201, pr);
      }
      const status = q("searchCriteria.status") || "active";
      const hits = prs.filter((p) => (!q("searchCriteria.sourceRefName") || p.sourceRefName === q("searchCriteria.sourceRefName")) && (!q("searchCriteria.targetRefName") || p.targetRefName === q("searchCriteria.targetRefName")) && (status === "all" || p.status === status));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    return this.send(res, 404);
  }

  private send(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(body === undefined ? "" : JSON.stringify(body));
  }

  private handle(req: IncomingMessage, res: ServerResponse, raw: string): void {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const method = req.method ?? "GET";
    const body = raw ? (JSON.parse(raw) as unknown) : undefined;
    const p = decodeURIComponent(url.pathname);
    this.requests.push({ method, path: p, query: url.searchParams, auth: req.headers.authorization, contentType: req.headers["content-type"], body });
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return this.send(res, 401);
    if (!url.searchParams.get("api-version")) return this.send(res, 400);
    const failure = this.failures.find((f) => f.method === method && p.includes(f.path) && f.times !== 0);
    if (failure?.times !== undefined) failure.times--;
    if (failure) return this.send(res, failure.status, { $id: "1", message: failure.message, typeKey: "UnauthorizedRequestException", errorCode: 0 });
    const st = this.state;
    const q = (k: string): string => url.searchParams.get(k) ?? "";
    let m: RegExpExecArray | null;

    if (p === `/${ORG}/_apis/connectionData` && method === "GET") {
      return this.send(res, 200, { authenticatedUser: { ...st.caller, isActive: true }, authorizedUser: { ...st.caller, isActive: true }, instanceId: "00000000-0000-0000-0000-0000000000ff" });
    }
    if (p === `/vssps/${ORG}/_apis/identities` && q("identityIds")) {
      const ids = q("identityIds").toLowerCase().split(",");
      const hits = [st.caller, ...st.identities].filter((i: J) => ids.includes(String(i.id).toLowerCase()));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (p === `/vssps/${ORG}/_apis/identities` && q("subjectDescriptors")) {
      const hits = st.identities.filter((i: J) => i.subjectDescriptor === q("subjectDescriptors"));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if ((m = /^\/vssps\/contoso\/_apis\/graph\/groups\/([^/]+)$/.exec(p))) {
      const hit = st.graphGroups.find((g: J) => g.descriptor === m![1]);
      return hit ? this.send(res, 200, hit) : this.send(res, 404);
    }
    if ((m = /^\/vssps\/contoso\/_apis\/graph\/descriptors\/([0-9a-f-]+)$/.exec(p))) {
      return this.send(res, 200, { value: `scp.${m[1]}` });
    }
    if (p === `/vssps/${ORG}/_apis/graph/groups` && method === "POST") {
      // Groups - Create with an originId (Microsoft Learn 7.1): the Entra group becomes known to the organization as a
      // member of each group in groupDescriptors.
      const b = body as J;
      const entra = st.entraGroups.find((g: J) => g.originId === b.originId);
      if (!entra) return this.send(res, 404, { message: `VS860015: Entra group ${b.originId} not found.` });
      let group = st.graphGroups.find((g: J) => g.originId === b.originId);
      if (!group) {
        group = { subjectKind: "group", origin: "aad", originId: b.originId, displayName: entra.displayName, principalName: `[TEAM FOUNDATION]\\${entra.displayName}`, descriptor: entra.descriptor };
        st.graphGroups.push(group);
        st.identities.push({ ...entra.identity });
      }
      for (const container of q("groupDescriptors").split(",").filter(Boolean)) {
        const key = `${group.descriptor}|${container}`;
        if (!st.memberships.includes(key)) st.memberships.push(key);
      }
      return this.send(res, 201, group);
    }
    if (p === `/vssps/${ORG}/_apis/graph/groups` && q("scopeDescriptor")) {
      const proj = st.projects.find((x: J) => `scp.${x.id}` === q("scopeDescriptor"));
      const value = proj
        ? [
            { subjectKind: "group", origin: "vsts", displayName: "Project Administrators", principalName: `[${proj.name}]\\Project Administrators`, descriptor: `vssgp.admins-${proj.id}` },
            { subjectKind: "group", origin: "vsts", displayName: "Readers", principalName: `[${proj.name}]\\Readers`, descriptor: `vssgp.readers-${proj.id}` },
          ]
        : [];
      return this.send(res, 200, { count: value.length, value });
    }
    if ((m = /^\/vssps\/contoso\/_apis\/graph\/memberships\/([^/]+)\/([^/]+)$/.exec(p))) {
      const key = `${m[1]}|${m[2]}`;
      if (method === "PUT") {
        if (!st.memberships.includes(key)) st.memberships.push(key);
        return this.send(res, 200, { memberDescriptor: m[1], containerDescriptor: m[2] });
      }
      return st.memberships.includes(key) ? this.send(res, 200, { memberDescriptor: m[1], containerDescriptor: m[2] }) : this.send(res, 404);
    }
    if (p === `/vssps/${ORG}/_apis/graph/serviceprincipals`) {
      return this.send(res, 200, { count: st.graphSps.length, value: st.graphSps });
    }
    if (p === `/vsaex/${ORG}/_apis/serviceprincipalentitlements` && method === "POST") {
      const b = body as J;
      const n = st.nextId++;
      const id = `00000000-0000-0000-0000-00000000${String(n).padStart(4, "0")}`;
      const descriptor = `aadsp.fake${n}`;
      st.graphSps.push({ subjectKind: "servicePrincipal", origin: "aad", originId: b.servicePrincipal.originId, descriptor, displayName: "id-contoso-ado-automation" });
      st.identities.push({ id, descriptor: `Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;fake${n}`, subjectDescriptor: descriptor, providerDisplayName: "id-contoso-ado-automation" });
      st.entitlements[id] = { id, accessLevel: { ...b.accessLevel, licenseDisplayName: "Basic" }, servicePrincipal: b.servicePrincipal };
      return this.send(res, 200, { isSuccess: true, operationResult: { isSuccess: true, servicePrincipalId: id, errors: [] }, servicePrincipalEntitlement: st.entitlements[id] });
    }
    if ((m = /^\/vsaex\/contoso\/_apis\/serviceprincipalentitlements\/([^/]+)$/.exec(p))) {
      const hit = st.entitlements[m[1]!];
      return hit ? this.send(res, 200, hit) : this.send(res, 404);
    }
    if ((m = /^\/contoso\/_apis\/securitynamespaces\/([0-9a-f-]+)$/.exec(p))) {
      const hit = st.security.namespaces[m[1]!];
      return hit ? this.send(res, 200, hit) : this.send(res, 404);
    }
    if ((m = /^\/contoso\/_apis\/securityroles\/scopes\/([^/]+)\/roledefinitions$/.exec(p))) {
      const hit = st.security.roleDefinitions[m[1]!];
      return hit ? this.send(res, 200, hit) : this.send(res, 404);
    }
    if (p === `/vssps/${ORG}/_apis/identities`) {
      const f = q("filterValue");
      const hits = st.identities.filter((i: J) => {
        const display: string = i.providerDisplayName ?? "";
        return display === f || display.endsWith(`\\${f}`) || display === `${f}` || (f.endsWith("Build Service (contoso)") && i.descriptor.includes(":Build:"));
      });
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (p === "/contoso/_apis/process/processes") return this.send(res, 200, { count: st.processes.length, value: st.processes });
    if (p === "/contoso/_apis/projects" && method === "POST") {
      // Projects - Create (Microsoft Learn 7.1): 202 with an operation reference; the project exists at once.
      const b = body as J;
      const template = b.capabilities?.processTemplate?.templateTypeId;
      if (typeof b.name !== "string" || !["private", "public"].includes(b.visibility) || b.capabilities?.versioncontrol?.sourceControlType !== "Git" || !st.processes.some((x: J) => x.id === template)) {
        return this.send(res, 400, { message: "VS402371: invalid project." });
      }
      if (st.projects.some((x: J) => x.name.toLowerCase() === b.name.toLowerCase())) return this.send(res, 409, { message: `TF200019: The project ${b.name} already exists.` });
      const n = st.nextId++;
      st.projects.push({ id: `00000000-0000-0000-0000-00000000${String(n).padStart(4, "0")}`, name: b.name, description: b.description, state: "wellFormed", visibility: b.visibility, revision: n });
      const op = `00000000-0000-0000-0000-0000000f${String(n).padStart(4, "0")}`;
      st.operations[op] = [...st.operationReplies];
      return this.send(res, 202, { id: op, status: "notSet", url: `${this.orgUrl}/_apis/operations/${op}` });
    }
    if ((m = /^\/contoso\/_apis\/operations\/([^/]+)$/.exec(p))) {
      const replies = st.operations[m[1]!];
      if (!replies) return this.send(res, 404);
      const status = replies.length ? replies.shift()! : "succeeded";
      return this.send(res, 200, { id: m[1], status, ...(status === "failed" ? { resultMessage: "The project could not be created." } : {}) });
    }
    if ((m = /^\/contoso\/_apis\/projects\/([^/]+)$/.exec(p))) {
      const hit = st.projects.find((x: J) => x.name === m![1]);
      return hit ? this.send(res, 200, hit) : this.send(res, 404);
    }
    if ((m = /^\/contoso\/([^/]+)\/_apis\/git\/repositories$/.exec(p)) && method === "POST") {
      const b = body as J;
      const project = st.projects.find((x: J) => x.name === m![1]);
      if (!project || b.project?.id !== project.id) return this.send(res, 400);
      if (st.repos[`${m[1]}/${b.name}`]) return this.send(res, 409, { message: "TF400948: A Git repository with the name already exists." });
      const id = `00000000-0000-0000-0000-00000000${String(st.nextId++).padStart(4, "0")}`;
      st.repos[`${m[1]}/${b.name}`] = { id, name: b.name, project: { id: project.id, name: project.name }, size: 0, isDisabled: false };
      return this.send(res, 201, st.repos[`${m[1]}/${b.name}`]);
    }
    if ((m = /^\/contoso\/([^/]+)\/_apis\/git\/repositories\/([^/]+)\/(refs|pushes|items|pullrequests)$/.exec(p))) {
      return this.git(res, method, m[1]!, m[2]!, m[3]!, q, body as J);
    }
    if ((m = /^\/contoso\/([^/]+)\/_apis\/git\/repositories\/([^/]+)$/.exec(p))) {
      const key = Object.keys(st.repos).find((k) => k.toLowerCase() === `${m![1]}/${m![2]}`.toLowerCase())
        ?? Object.keys(st.repos).find((k) => st.repos[k].id === m![2] && st.repos[k].project.name === m![1]);
      const hit = key ? st.repos[key] : undefined;
      if (!hit || !key) return this.send(res, 404);
      // Repositories - Update (a new name) and Delete (ADR-0056, ADR-0061: a decommissioned app's starter).
      if (method === "PATCH") {
        const name = (body as J)?.name as string;
        if (st.repos[`${m[1]}/${name}`]) return this.send(res, 409, { message: "TF400948: A Git repository with the name already exists." });
        delete st.repos[key];
        st.repos[`${m[1]}/${name}`] = { ...hit, name };
        return this.send(res, 200, st.repos[`${m[1]}/${name}`]);
      }
      if (method === "DELETE") {
        delete st.repos[key];
        return this.send(res, 204);
      }
      return this.send(res, 200, hit);
    }
    if (p === "/contoso/Platform/_apis/policy/configurations") {
      if (method === "POST") {
        const created = { ...(body as J), id: st.nextId++, revision: 1, isDeleted: false };
        st.policies.push(created);
        return this.send(res, 200, created);
      }
      return this.send(res, 200, { count: st.policies.length, value: st.policies });
    }
    if ((m = /^\/contoso\/Platform\/_apis\/policy\/configurations\/(\d+)$/.exec(p)) && method === "PUT") {
      const i = st.policies.findIndex((c: J) => c.id === Number(m![1]));
      if (i < 0) return this.send(res, 404);
      st.policies[i] = { ...(body as J), id: st.policies[i].id, revision: st.policies[i].revision + 1 };
      return this.send(res, 200, st.policies[i]);
    }
    if (p === "/contoso/Platform/_apis/serviceendpoint/endpoints" && method === "GET") {
      const names = q("endpointNames").split(",");
      const hits = st.endpoints.filter((e: J) => names.includes(e.name));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (p === "/contoso/_apis/serviceendpoint/endpoints" && method === "POST") {
      const b = body as J;
      const id = `00000000-0000-0000-0000-00000000${String(st.nextId++).padStart(4, "0")}`;
      const created = {
        ...b,
        id,
        createdBy: { id: CALLER.id, displayName: CALLER.providerDisplayName },
        authorization: {
          ...b.authorization,
          parameters: {
            ...b.authorization.parameters,
            workloadIdentityFederationIssuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0",
            workloadIdentityFederationIssuerType: "EntraID",
            workloadIdentityFederationSubject: `/eid1/c/pub/t/AAAA/a/BBBB/sc/00000000-0000-0000-0000-0000000000f2/${id}`,
          },
        },
      };
      st.endpoints.push(created);
      return this.send(res, 200, created);
    }
    // ADR-0056 (platform ado remove): the DELETEs of a decommissioned app's objects.
    if ((m = /^\/contoso\/_apis\/serviceendpoint\/endpoints\/([^/]+)$/.exec(p)) && method === "DELETE") {
      const i = st.endpoints.findIndex((e: J) => e.id === m![1]);
      if (i < 0 || !q("projectIds")) return this.send(res, 404);
      st.endpoints.splice(i, 1);
      return this.send(res, 204);
    }
    if ((m = /^\/contoso\/Platform\/_apis\/distributedtask\/environments\/(\d+)$/.exec(p)) && method === "DELETE") {
      const i = st.environments.findIndex((e: J) => e.id === Number(m![1]));
      if (i < 0) return this.send(res, 404);
      st.environments.splice(i, 1);
      return this.send(res, 204);
    }
    if ((m = /^\/contoso\/Platform\/_apis\/build\/definitions\/(\d+)$/.exec(p)) && method === "DELETE") {
      if (!st.definitions[m[1]!]) return this.send(res, 404);
      delete st.definitions[m[1]!];
      delete st.pipelineDetails[m[1]!];
      st.pipelines = st.pipelines.filter((x: J) => String(x.id) !== m![1]);
      return this.send(res, 204);
    }
    if ((m = /^\/contoso\/_apis\/serviceendpoint\/endpoints\/([^/]+)$/.exec(p)) && method === "PUT") {
      const i = st.endpoints.findIndex((e: J) => e.id === m![1]);
      if (i < 0) return this.send(res, 404);
      st.endpoints[i] = body;
      return this.send(res, 200, body);
    }
    if (p === "/contoso/Platform/_apis/pipelines/environments") {
      if (method === "POST") {
        const created = { ...(body as J), id: st.nextId++ };
        st.environments.push(created);
        return this.send(res, 200, created);
      }
      const hits = st.environments.filter((e: J) => e.name === q("name"));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (p === "/contoso/Platform/_apis/pipelines/checks/configurations") {
      if (method === "POST") {
        const created = stored({ ...(body as J), id: st.nextId++, version: 1 });
        st.checks.push(created);
        return this.send(res, 200, created);
      }
      const hits = st.checks.filter((c: J) => c.resource.type === q("resourceType") && String(c.resource.id) === q("resourceId"));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if ((m = /^\/contoso\/Platform\/_apis\/pipelines\/checks\/configurations\/(\d+)$/.exec(p)) && method === "DELETE") {
      const i = st.checks.findIndex((c: J) => c.id === Number(m![1]));
      if (i < 0) return this.send(res, 404);
      st.checks.splice(i, 1);
      return this.send(res, 204);
    }
    if ((m = /^\/contoso\/Platform\/_apis\/pipelines\/checks\/configurations\/(\d+)$/.exec(p)) && method === "PATCH") {
      const i = st.checks.findIndex((c: J) => c.id === Number(m![1]));
      if (i < 0) return this.send(res, 404);
      st.checks[i] = stored({ ...st.checks[i], ...(body as J) });
      return this.send(res, 200, st.checks[i]);
    }
    if ((m = /^\/contoso\/_apis\/accesscontrollists\/([0-9a-f-]+)$/.exec(p)) && q("recurse") === "true") {
      const d = q("descriptors");
      const value = Object.values(st.acls as Record<string, J>)
        .filter((acl) => acl.token.startsWith(q("token")))
        .map((acl) => ({ ...acl, acesDictionary: Object.fromEntries(Object.entries(acl.acesDictionary as J).filter(([k]) => !d || k.toLowerCase() === this.canon(d).toLowerCase())) }));
      return this.send(res, 200, { count: value.length, value });
    }
    if ((m = /^\/contoso\/_apis\/accesscontrollists\/([0-9a-f-]+)$/.exec(p))) {
      const acl = st.acls[q("token")];
      if (!acl) return this.send(res, 200, { count: 0, value: [] });
      const d = q("descriptors");
      const dict = Object.fromEntries(Object.entries(acl.acesDictionary as J).filter(([k]) => !d || k.toLowerCase() === this.canon(d).toLowerCase()));
      return this.send(res, 200, { count: 1, value: [{ ...acl, acesDictionary: dict }] });
    }
    // Permissions - Remove: clears the bits from the allow and the deny of one ACE (the sandbox's tag protection, ADO-23).
    if ((m = /^\/contoso\/_apis\/permissions\/([0-9a-f-]+)\/(\d+)$/.exec(p)) && method === "DELETE") {
      const acl = st.acls[q("token")];
      const d = q("descriptor");
      const key = acl ? Object.keys(acl.acesDictionary as J).find((k) => k.toLowerCase() === this.canon(d).toLowerCase()) : undefined;
      if (!acl || !key) return this.send(res, 200, { descriptor: d, allow: 0, deny: 0 });
      const bits = Number(m[2]);
      const ace = acl.acesDictionary[key];
      acl.acesDictionary[key] = { ...ace, allow: ace.allow & ~bits, deny: ace.deny & ~bits };
      return this.send(res, 200, acl.acesDictionary[key]);
    }
    if ((m = /^\/contoso\/_apis\/accesscontrolentries\/([0-9a-f-]+)$/.exec(p)) && method === "POST") {
      const b = body as J;
      const acl = (st.acls[b.token] ??= { token: b.token, inheritPermissions: true, acesDictionary: {} });
      for (const ace of b.accessControlEntries) {
        const key = this.canon(ace.descriptor);
        const prev = acl.acesDictionary[key] ?? { descriptor: key, allow: 0, deny: 0 };
        acl.acesDictionary[key] = b.merge ? { ...prev, allow: prev.allow | ace.allow, deny: prev.deny | ace.deny } : { ...ace, descriptor: key };
      }
      return this.send(res, 200, { count: b.accessControlEntries.length, value: b.accessControlEntries });
    }
    if ((m = /^\/contoso\/_apis\/securityroles\/scopes\/([^/]+)\/roleassignments\/resources\/([^/]+)$/.exec(p))) {
      // One service connection or environment: resource `{projectId}_{objectId}`, its own list.
      const object = m[2]!.includes("_") ? ((st.objectRoles ??= {})[`${m[1]}/${m[2]}`] ??= []) : null;
      const key = m[1] === "distributedtask.globalenvironmentreferencerole" ? "envRoles" : m[1] === "distributedtask.project.serviceendpointrole" ? "projectEndpointRoles" : "endpointRoles";
      const list: J[] = object ?? st[key];
      if (method === "PUT") {
        for (const a of body as J[]) {
          const hit = list.find((x: J) => x.identity.id === a.userId);
          if (hit) hit.role = { ...hit.role, name: a.roleName, displayName: a.roleName };
          else list.push({ access: "assigned", identity: { id: a.userId, displayName: "?" }, role: { name: a.roleName, displayName: a.roleName } });
        }
      }
      return this.send(res, 200, { count: list.length, value: list });
    }
    if (p === "/contoso/Platform/_apis/build/generalsettings") {
      if (method === "PATCH") st.generalsettings = { ...st.generalsettings, ...(body as J) };
      return this.send(res, 200, st.generalsettings);
    }
    if (p === "/contoso/Platform/_apis/distributedtask/queues") {
      const hits = st.queues.filter((x: J) => !q("queueNames") || x.name === q("queueNames"));
      return this.send(res, 200, { count: hits.length, value: hits });
    }
    if (p === "/contoso/Platform/_apis/pipelines") {
      if (method === "POST") {
        const b = body as J;
        if (this.missingYaml.includes(b.configuration.path)) return this.send(res, 400, { $id: "1", message: `File ${b.configuration.path} not found in repository platform-config.`, typeKey: "PipelineValidationException", errorCode: 0 });
        const created = { ...b, id: st.nextId++, revision: 1, configuration: { ...b.configuration, path: `/${b.configuration.path}` } };
        st.pipelines.push({ id: created.id, name: b.name, folder: b.folder, revision: 1 });
        st.pipelineDetails[created.id] = created;
        st.definitions[created.id] = { id: created.id, name: b.name, path: b.folder, revision: 1, process: { type: 2, yamlFilename: created.configuration.path }, repository: { id: b.configuration.repository.id, type: "TfsGit" }, triggers: [] };
        return this.send(res, 200, created);
      }
      // Two pages, to exercise x-ms-continuationtoken.
      if (!q("continuationToken")) return this.send(res, 200, { count: 1, value: st.pipelines.slice(0, 1) }, st.pipelines.length > 1 ? { "x-ms-continuationtoken": "page2" } : {});
      return this.send(res, 200, { count: st.pipelines.length - 1, value: st.pipelines.slice(1) });
    }
    if ((m = /^\/contoso\/Platform\/_apis\/build\/definitions\/(\d+)$/.exec(p))) {
      const def = st.definitions[m[1]!];
      if (!def) return this.send(res, 404);
      if (method === "GET") return this.send(res, 200, def);
      if (method === "PUT") {
        const b = body as J;
        // Like Azure DevOps: the body must carry the current revision; the save creates the next one.
        if (b.revision !== def.revision || req.headers["content-type"] !== "application/json") return this.send(res, 409);
        st.definitions[m[1]!] = { ...b, revision: this.freezeRevisions ? def.revision : def.revision + 1 };
        return this.send(res, 200, st.definitions[m[1]!]);
      }
    }
    if ((m = /^\/contoso\/Platform\/_apis\/pipelines\/(\d+)\/preview$/.exec(p)) && method === "POST") {
      if (!st.pipelineDetails[m[1]!]) return this.send(res, 404);
      // Like Azure DevOps (sandbox run 3412): a disabled pipeline can't be previewed.
      const def = st.definitions[m[1]!];
      if (def?.queueStatus === "disabled") return this.send(res, 500, { message: `Build pipeline ${def.name} is disabled for project Platform.` });
      return this.send(res, 200, { finalYaml: "stages: []" });
    }
    if ((m = /^\/contoso\/Platform\/_apis\/pipelines\/(\d+)$/.exec(p))) {
      const hit = st.pipelineDetails[m[1]!];
      // The pipeline's revision is its build definition's (a PUT of the definition raises both).
      return hit ? this.send(res, 200, { ...hit, revision: st.definitions[m[1]!]?.revision ?? hit.revision }) : this.send(res, 404);
    }
    if ((m = /^\/contoso\/Platform\/_apis\/pipelines\/pipelinepermissions\/([a-z]+)\/(.+)$/.exec(p))) {
      const key = `${m[1]}/${m[2]}`;
      const cur = (st.permissions[key] ??= { pipelines: [], resource: { id: m[2], type: m[1] } });
      if (method === "PATCH") {
        const b = body as J;
        if (b.allPipelines) cur.allPipelines = b.allPipelines;
        for (const pl of b.pipelines ?? []) {
          const i = cur.pipelines.findIndex((x: J) => x.id === pl.id);
          if (i >= 0) cur.pipelines[i] = { ...cur.pipelines[i], authorized: pl.authorized };
          else cur.pipelines.push({ id: pl.id, authorized: pl.authorized });
        }
      }
      return this.send(res, 200, cur);
    }
    this.send(res, 404);
  }
}
