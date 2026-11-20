import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { mkdirSync } from "node:fs";
import { CLI, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { APPS_ID, CALLER, DEMO_HEAD, DEMO_REPO, FakeAdo, GIT, GROUP_ID, PLATFORM_ID, PORTAL_OID, TOKEN, branchTokenOf } from "./ado-fake.js";
import { parseOrgUrl } from "../src/ado/client.js";
import { adoDeliveryPipeline, adoEnvironment, adoPlatformEnvironment, adoPlatformPipeline, adoServiceConnection } from "../src/ado/names.js";
import { deliveryClientId } from "../src/ado/index.js";
import { BUILT_IN_APP_THEMES, themeCss } from "../src/themes.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fake = new FakeAdo();
const P = join(FIXTURES, "provisioning", "config");
const SP = { nonprod: "00000000-0000-0000-0000-0000000000d1", prod: "00000000-0000-0000-0000-0000000000d2" };

let instance = "";
let lz: Record<string, string> = {};

before(async () => {
  await fake.start();
  const doc = parse(readFileSync(join(P, "instance.yaml"), "utf8")) as J;
  doc.scm.azureDevOps.organizationUrl = fake.orgUrl;
  doc.approvals.platformTeam.displayName = "sg-platform-team";
  const dir = tmp("pc-ado-");
  instance = join(dir, "instance.yaml");
  writeFileSync(instance, stringify(doc));
  for (const env of ["nonprod", "prod"] as const) {
    lz[env] = join(dir, `lz-${env}.json`);
    writeFileSync(lz[env]!, JSON.stringify({ deliveryIdentityClientId: { type: "String", value: SP[env] }, runtimeIdentityClientId: { type: "String", value: "x" } }));
  }
});
after(() => fake.stop());

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const merged: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SYSTEM_ACCESSTOKEN|AZURE_DEVOPS_TOKEN)$/.test(k))) as Record<string, string>;
  for (const [k, v] of Object.entries({ AZURE_DEVOPS_TOKEN: TOKEN, NO_COLOR: "1", ...env })) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "ado", ...args], { env: merged });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const DEMO_APP = join(P, "apps", "demo", "app.yaml");

function ado(action: "plan" | "apply", phase: "resources" | "pipelines", extra: string[] = [], env: Record<string, string | undefined> = {}, app = DEMO_APP) {
  const output = join(tmp(), "ado-outputs.json");
  return run(
    [action, "--instance", instance, "--app", app, "--phase", phase, "--org-url", fake.orgUrl,
      "--lz-outputs", `nonprod=${lz.nonprod}`, "--lz-outputs", `prod=${lz.prod}`, "--output", output, ...extra],
    env,
  ).then((r) => ({ ...r, outputs: r.code !== 2 && r.stdout ? (JSON.parse(readFileSync(output, "utf8")) as J) : undefined }));
}

const lines = (stdout: string, status: string): string[] => stdout.split("\n").filter((l) => l.startsWith(status.padEnd(8)));
const writes = () => fake.requests.filter((r) => r.method !== "GET");

describe("platform ado plan (sandbox shapes)", () => {
  beforeEach(() => fake.reset("configured"));

  it("resources: the configured demo app is all ok, with only GETs", async () => {
    const r = await ado("plan", "resources");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(lines(r.stdout, "create").concat(lines(r.stdout, "update"), lines(r.stdout, "blocked"), lines(r.stdout, "extra")), []);
    assert.match(r.stdout, /^ok {6}service-connection {2}sc-demo-nonprod {2}\(id 00000000-0000-0000-0000-0000000000c1\)$/m);
    assert.match(r.stdout, /^ok {6}check {15}demo-prod: Approval/m);
    assert.match(r.stdout, /^ok {6}check {15}sc-demo-prod: Branch control/m);
    assert.match(r.stdout, /Plan: 0 create, 0 update, 0 extra, \d+ ok, 0 warn, 0 blocked\./);
    assert.doesNotMatch(r.stdout, /^\S+ +(seed|onboarding|cleanup) /m, "demo has no repository.template: unmanaged");
    assert.ok(!fake.requests.some((q) => q.path.endsWith("/_apis/connectionData")));
    assert.deepEqual(writes(), []);
    assert.ok(fake.requests.every((q) => q.auth === `Bearer ${TOKEN}` && q.query.get("api-version")));
    assert.ok(!(r.stdout + r.stderr).includes(TOKEN));
    assert.deepEqual(r.outputs!.environments.nonprod.serviceConnection, {
      id: "00000000-0000-0000-0000-0000000000c1",
      name: "sc-demo-nonprod",
      issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0",
      subject: "/eid1/c/pub/t/AAAAAAAAAAAAAAAAAAAAAA/a/BBBBBBBBBBBBBBBBBBBBBB/sc/00000000-0000-0000-0000-0000000000f2/00000000-0000-0000-0000-0000000000c1",
    });
    assert.deepEqual(r.outputs!.environments.prod.environment, { id: 22, name: "demo-prod" });
    assert.deepEqual(r.outputs!.project, { id: PLATFORM_ID, name: "Platform" });
  });

  it("approvals.allowSelfApproval: the prod Approval lets the requester approve, with a warn row (ADR-0034)", async () => {
    const strict = instance;
    const doc = parse(readFileSync(strict, "utf8")) as J;
    doc.approvals.allowSelfApproval = true;
    instance = join(tmp("pc-ado-self-"), "instance.yaml");
    writeFileSync(instance, stringify(doc));
    try {
      const r = await ado("plan", "resources");
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.match(r.stdout, /^warn {4}identity {12}prod approvers \(self-approval\) {2}\(approvals\.allowSelfApproval is true: the requester can approve their own runs/m);
      assert.deepEqual(lines(r.stdout, "update").map((l) => l.replace(/ +/g, " ")), ["update check demo-prod: Approval (requesterCannotBeApprover -> false)"]);
      fake.requests = [];
      const a = await ado("apply", "resources");
      assert.equal(a.code, 0, a.stdout);
      const patch = writes().find((w) => w.method === "PATCH" && w.path.includes("/checks/configurations/"))!.body as J;
      assert.equal(patch.settings.requesterCannotBeApprover, false);
      assert.match(patch.settings.instructions, /^Prod release of demo: .*The requester can approve \(approvals\.allowSelfApproval\)\.$/);
      assert.deepEqual(lines((await ado("plan", "resources")).stdout, "update"), [], "a stored check without requesterCannotBeApprover is up to date");
    } finally {
      instance = strict;
    }
  });

  it("portal.identityPrincipalId: the portal identity becomes Reader on each of the app's connections, and only there (ADR-0058)", async () => {
    const plain = instance;
    const doc = parse(readFileSync(plain, "utf8")) as J;
    doc.portal.identityPrincipalId = PORTAL_OID;
    instance = join(tmp("pc-ado-portal-"), "instance.yaml");
    writeFileSync(instance, stringify(doc));
    try {
      // Not in the organization yet: warn rows, nothing written, exit 0.
      const missing = await ado("apply", "resources");
      assert.equal(missing.code, 0, missing.stdout + missing.stderr);
      assert.match(missing.stdout, /^warn {4}identity {12}id-contoso-portal \(portal\.identityPrincipalId\) {2}\(00000000-0000-0000-0000-00000000f042 is not in the organization yet/m);
      assert.equal(lines(missing.stdout, "warn").filter((l) => /endpoint-role/.test(l)).length, 2);
      assert.ok(!writes().some((w) => w.path.includes("serviceendpointrole")));

      const portal = fake.addPortalIdentity();
      fake.requests = [];
      const plan = await ado("plan", "resources");
      assert.equal(plan.code, 0, plan.stdout + plan.stderr);
      // The connections' Reader, and the repository's Read with the project's View (ADR-0039 amendment) from the same lookup.
      assert.deepEqual(lines(plan.stdout, "create").map((l) => l.replace(/ +/g, " ")), [
        "create endpoint-role sc-demo-nonprod: the portal identity is Reader (only)",
        "create endpoint-role sc-demo-prod: the portal identity is Reader (only)",
        "create repo-acl Apps/demo: id-contoso-portal may read (README and CHANGELOG in the portal) (allow 2)",
        "create project-acl Apps: id-contoso-portal may view the project (allow 1)",
      ]);
      assert.equal(lines(plan.stdout, "ok").filter((l) => /^ok +identity +id-contoso-portal /.test(l)).length, 1, "one row for the portal identity");
      assert.deepEqual(writes(), []);

      fake.requests = [];
      const a = await ado("apply", "resources");
      assert.equal(a.code, 0, a.stdout + a.stderr);
      const all = writes();
      const puts = all.filter((w) => w.path.includes("serviceendpointrole"));
      assert.equal(all.filter((w) => !w.path.includes("serviceendpointrole") && !w.path.includes("/_apis/accesscontrolentries/")).length, 0, "besides the two ACEs, nothing else");
      assert.deepEqual(
        puts.map((w) => [w.method, w.path]),
        [
          ["PUT", `/contoso/_apis/securityroles/scopes/distributedtask.serviceendpointrole/roleassignments/resources/${PLATFORM_ID}_00000000-0000-0000-0000-0000000000c1`],
          ["PUT", `/contoso/_apis/securityroles/scopes/distributedtask.serviceendpointrole/roleassignments/resources/${PLATFORM_ID}_00000000-0000-0000-0000-0000000000c2`],
        ].filter(([, p]) => puts.some((w) => w.path === p)),
      );
      assert.equal(puts.length, 2, "one assignment per connection, nothing else");
      for (const w of puts) assert.deepEqual(w.body, [{ userId: portal.id, roleName: "Reader" }]);
      assert.ok(!puts.some((w) => w.path.includes("distributedtask.project.serviceendpointrole")), "never the project-level role");

      const again = await ado("plan", "resources");
      assert.equal(again.code, 0, again.stdout);
      assert.equal(lines(again.stdout, "ok").filter((l) => /endpoint-role/.test(l)).length, 2);
      assert.deepEqual(lines(again.stdout, "create"), []);

      // A higher role given by hand is narrowed to Reader.
      const roles = fake.state.objectRoles[`distributedtask.serviceendpointrole/${PLATFORM_ID}_00000000-0000-0000-0000-0000000000c2`] as J[];
      roles.find((x) => x.identity.id === portal.id)!.role = { name: "User", displayName: "User" };
      const narrowed = await ado("plan", "resources");
      assert.deepEqual(lines(narrowed.stdout, "update").map((l) => l.replace(/ +/g, " ")), ["update endpoint-role sc-demo-prod: the portal identity is Reader (only) (User -> Reader (ADR-0058: the portal only reads the connection))"]);
      // Inherited from the project level: a warn row, not changed.
      roles.find((x) => x.identity.id === portal.id)!.access = "inherited";
      const inherited = await ado("plan", "resources");
      assert.match(inherited.stdout, /^warn {4}endpoint-role {7}sc-demo-prod: the portal identity is Reader \(only\) {2}\(User, inherited from the project's service connection security/m);
    } finally {
      instance = plain;
    }
  });

  it("pipelines: the configured demo app is all ok, pages through the pipeline list", async () => {
    const r = await ado("plan", "pipelines");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok {6}pipeline {12}\\apps\\delivery-demo {2}\(id 42\)$/m);
    assert.equal(lines(r.stdout, "ok").filter((l) => l.includes("pipeline-permission")).length, 6);
    assert.match(r.stdout, /^ok {6}queue-acl/m);
    assert.deepEqual(r.outputs!.pipeline, { id: 42, name: "delivery-demo", folder: "\\apps" });
    assert.ok(fake.requests.some((q) => q.query.get("continuationToken") === "page2"));
    assert.deepEqual(writes(), []);
  });

  it("reports updates: identity, template ref, branches, approver, environment role", async () => {
    const st = fake.state;
    st.endpoints[0].authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    st.endpoints[0].createdBy = { id: CALLER.id, displayName: CALLER.providerDisplayName };
    for (const c of st.checks) {
      if (c.type.name === "ExtendsCheck") c.settings.extendsChecks[0].repositoryRef = "refs/tags/v0.0.9";
      if (c.type.name === "Task Check") c.settings.inputs.allowedBranches = "refs/heads/main";
      if (c.type.name === "Approval") c.settings.approvers = [{ id: "00000000-0000-0000-0000-0000000000a9" }];
    }
    st.envRoles.find((a: J) => a.identity.displayName === "[Platform]\\Contributors").role.name = "Creator";
    const r = await ado("plan", "resources");
    assert.equal(r.code, 0);
    const upd = lines(r.stdout, "update").join("\n");
    assert.match(upd, /sc-demo-nonprod {2}\(serviceprincipalid 00000000-0000-0000-0000-0000000000ff -> 00000000-0000-0000-0000-0000000000d1: deleted and created again \(Azure DevOps doesn't edit a managed-identity connection\)\)/);
    assert.equal((upd.match(/Required template/g) ?? []).length, 4);
    assert.match(upd, /demo-prod: Branch control {2}\(allowedBranches -> refs\/heads\/main,refs\/tags\/v\*\)/);
    assert.match(upd, /demo-prod: Approval {2}\(approvers -> 00000000-0000-0000-0000-0000000000a5\)/);
    assert.match(upd, /Contributors on environments {2}\(Creator -> Reader/);
    assert.deepEqual(writes(), []);
  });

  it("reports pipeline authorisations of other pipelines as extra (not on the shared core repo)", async () => {
    fake.state.permissions["environment/21"].pipelines.push({ id: 43, authorized: true });
    fake.state.permissions[`repository/${PLATFORM_ID}.00000000-0000-0000-0000-0000000000b2`].pipelines.push({ id: 43, authorized: true });
    fake.state.permissions["endpoint/00000000-0000-0000-0000-0000000000c2"].allPipelines = { authorized: true };
    const r = await ado("plan", "pipelines");
    assert.match(r.stdout, /^extra {3}pipeline-permission environment demo-nonprod {2}\(revoke pipelines 43\)$/m);
    assert.match(r.stdout, /^update {2}pipeline-permission endpoint sc-demo-prod {2}\(close access for all pipelines\)$/m);
    assert.match(r.stdout, /^ok {6}pipeline-permission repository Platform\/core/m);
  });

  it("accepts the approver group only when the organization's Graph shows its Entra object ID (ADO-23)", async () => {
    // A group with the same display name but another Entra object ID (the identity itself has none).
    fake.state.graphGroups[0].originId = "00000000-0000-0000-0000-00000000c0ff";
    const r = await ado("plan", "resources");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^blocked identity {12}prod approvers \(platformTeam\) {2}\(Entra group 00000000-0000-0000-0000-00000000c002 \(sg-platform-team\) not found in the organization \(ADO-23\): add it to an Azure DevOps group first/m);
    const graph = fake.requests.filter((q) => q.path.startsWith("/vssps/contoso/_apis/graph/groups/"));
    assert.deepEqual(graph.map((q) => [q.method, q.query.get("api-version")]), [["GET", "7.1-preview.1"]]);
  });

  it("does not retry a refused check on a resource that already existed (a missing permission)", async () => {
    fake.state.checks = fake.state.checks.filter((c: J) => !(c.resource.type === "endpoint" && c.type.name === "Task Check"));
    fake.failures = [{ method: "POST", path: "/checks/configurations", status: 403, message: "You do not have permissions to update checks on this resource.", times: 1 }];
    const a = await ado("apply", "resources");
    assert.equal(a.code, 1, a.stdout);
    assert.match(a.stdout, /^create {2}check {15}sc-demo-prod: Branch control {2}\[FAILED: POST .* returned HTTP 403/m);
    assert.equal(writes().filter((w) => w.method === "POST" && w.path.endsWith("/checks/configurations")).length, 1);
  });

  it("blocks on an unresolvable approver group and on an explicit deny, keeps unmanaged checks", async () => {
    fake.state.identities = fake.state.identities.filter((i: J) => i.id !== GROUP_ID);
    fake.state.acls[`repoV2/${APPS_ID}/00000000-0000-0000-0000-0000000000b1`].acesDictionary[fake.state.identities[0].descriptor].deny = 2;
    fake.state.checks.push({ id: 999, resource: { id: "21", name: "demo-nonprod", type: "environment" }, timeout: 60, type: { id: "00000000-0000-0000-0000-000000000123", name: "BusinessHours" } });
    const r = await ado("plan", "resources");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^blocked identity {12}prod approvers \(platformTeam\) {2}\(Entra group 00000000-0000-0000-0000-00000000c002 \(sg-platform-team\) not found in the organization \(ADO-23/m);
    assert.match(r.stdout, /^blocked check {15}demo-prod: Approval {2}\(.*existing check id 93 left as it is/m);
    assert.match(r.stdout, /^blocked repo-acl .*an explicit deny \(2\) blocks the permission/m);
    assert.match(r.stdout, /^extra {3}check {15}demo-nonprod: BusinessHours \(id 999\) {2}\(not managed by the platform; left in place\)$/m);
  });
});

describe("platform ado plan|apply: the portal reads the app repository (US11.09, ADR-0039 amended 2026-11-12)", () => {
  beforeEach(() => fake.reset("configured"));
  const PORTAL = "Microsoft.VisualStudio.Services.Claims.AadServicePrincipal;portal";
  /** The instance with portal.identityPrincipalId, for one call. */
  async function withPortal<T>(fn: () => Promise<T>): Promise<T> {
    const doc = parse(readFileSync(instance, "utf8")) as J;
    doc.portal.identityPrincipalId = PORTAL_OID;
    const inst = join(tmp("pc-ado-portal-"), "instance.yaml");
    writeFileSync(inst, stringify(doc));
    const saved = instance;
    instance = inst;
    try {
      return await fn();
    } finally {
      instance = saved;
    }
  }

  it("Read on this repository and View on the apps project, nothing else; idempotent", async () => {
    fake.addPortalIdentity();
    const p = await withPortal(() => ado("plan", "resources"));
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /^ok {6}identity {12}id-contoso-portal \(portal\.identityPrincipalId\)/m);
    assert.match(p.stdout, /^create {2}repo-acl {12}Apps\/demo: id-contoso-portal may read \(README and CHANGELOG in the portal\) {2}\(allow 2\)$/m);
    assert.match(p.stdout, /^create {2}project-acl {9}Apps: id-contoso-portal may view the project {2}\(allow 1\)$/m);
    assert.deepEqual(writes(), []);
    const a = await withPortal(() => ado("apply", "resources"));
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const portalAces = writes()
      .filter((w) => w.path.startsWith("/contoso/_apis/accesscontrolentries/"))
      .map((w) => w.body as J)
      .filter((b) => b.accessControlEntries[0].descriptor === PORTAL);
    assert.deepEqual(
      portalAces.map((b) => [b.token, b.merge, b.accessControlEntries[0].allow, b.accessControlEntries[0].deny]),
      [
        [`repoV2/${APPS_ID}/${DEMO_REPO}`, true, 2, 0],
        [`$PROJECT:vstfs:///Classification/TeamProject/${APPS_ID}`, true, 1, 0],
      ],
    );
    // Never the project's or the organization's all-repositories token, never a branch.
    assert.ok(!portalAces.some((b) => b.token === `repoV2/${APPS_ID}` || b.token === "repoV2" || String(b.token).includes("/refs")));
    fake.requests = [];
    const again = await withPortal(() => ado("plan", "resources"));
    assert.deepEqual(lines(again.stdout, "create"), [], again.stdout);
  });

  it("not in the organization yet: warn rows, nothing granted, provisioning goes on", async () => {
    const a = await withPortal(() => ado("apply", "resources"));
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /^warn {4}identity {12}id-contoso-portal \(portal\.identityPrincipalId\) {2}\(\S+ is not in the organization yet/m);
    assert.ok(!a.stdout.includes("id-contoso-portal may read"));
  });

  it("without portal.identityPrincipalId: no row about the portal", async () => {
    fake.addPortalIdentity();
    const p = await ado("plan", "resources");
    assert.ok(!p.stdout.includes("id-contoso-portal"), p.stdout);
  });
});

describe("platform ado apply (new app)", () => {
  beforeEach(() => fake.reset("empty"));

  it("retries a check on a resource it just created while Azure DevOps refuses it (403)", async () => {
    // The creator's Administer on a new service connection arrives late (sandbox, run 2905).
    fake.failures = [{ method: "POST", path: "/checks/configurations", status: 403, message: "You do not have permissions to update checks on this resource.", times: 1 }];
    const a = await ado("apply", "resources");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const posts = writes().filter((w) => w.method === "POST" && w.path.endsWith("/checks/configurations"));
    assert.equal(posts.length, 10, "9 checks, the first one twice");
    assert.deepEqual(posts[1]!.body, posts[0]!.body);
  });

  it("resources: creates connections, environments, checks and ACLs, then plans all ok", async () => {
    const p = await ado("plan", "resources");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    // 2 connections, 2 environments, 9 checks, 2 build service ACEs (demo has no repository.template).
    assert.equal(lines(p.stdout, "create").length, 2 + 2 + 9 + 2);
    assert.match(p.stdout, /^create {2}check {15}demo-nonprod: Exclusive lock {2}\(after the environment is created\)$/m);
    assert.deepEqual(writes(), []);

    const a = await ado("apply", "resources");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const sc = writes().find((w) => w.path === "/contoso/_apis/serviceendpoint/endpoints")!.body as J;
    assert.equal(sc.name, "sc-demo-nonprod");
    assert.deepEqual(sc.authorization, { scheme: "WorkloadIdentityFederation", parameters: { serviceprincipalid: SP.nonprod, tenantid: "00000000-0000-0000-0000-000000000001" } });
    assert.equal(sc.data.identityType, "ManagedIdentity");
    assert.equal(sc.data.subscriptionId, "00000000-0000-0000-0000-00000000a001");
    assert.equal(sc.isShared, false);
    assert.deepEqual(sc.serviceEndpointProjectReferences[0].projectReference, { id: PLATFORM_ID, name: "Platform" });
    const checks = writes().filter((w) => w.path.endsWith("/checks/configurations")).map((w) => w.body as J);
    assert.equal(checks.length, 9);
    const approval = checks.find((c) => c.type.name === "Approval")!;
    assert.deepEqual(approval.settings.approvers, [{ id: GROUP_ID }]);
    assert.equal(approval.settings.requesterCannotBeApprover, true);
    assert.equal(approval.timeout, 10080);
    const branch = checks.filter((c) => c.type.name === "Task Check");
    assert.equal(branch.length, 2);
    assert.equal(branch[0]!.settings.inputs.allowedBranches, "refs/heads/main,refs/tags/v*");
    assert.deepEqual(checks.find((c) => c.type.name === "ExtendsCheck")!.settings.extendsChecks, [
      { repositoryType: "git", repositoryName: "Platform/core", repositoryRef: "refs/tags/v0.1.0-rc.3", templatePath: "pipelines/azure-devops/app-delivery.yml" },
    ]);
    const aces = writes().filter((w) => w.path.startsWith("/contoso/_apis/accesscontrolentries/")).map((w) => w.body as J);
    assert.deepEqual(aces.map((x) => [x.token, x.merge, x.accessControlEntries[0].descriptor === CALLER.descriptor ? "caller" : "build service", x.accessControlEntries[0].allow]), [
      [`repoV2/${APPS_ID}/${DEMO_REPO}`, true, "build service", 2],
      [`$PROJECT:vstfs:///Classification/TeamProject/${APPS_ID}`, true, "build service", 1],
    ]);
    assert.match(a.outputs!.environments.prod.serviceConnection.subject, /\/sc\/00000000-0000-0000-0000-0000000000f2\//);
    assert.equal(typeof a.outputs!.environments.prod.environment.id, "number");

    fake.requests = [];
    const again = await ado("plan", "resources");
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update")), [], again.stdout);
  });

  it("pipelines: creates and previews the pipeline, authorises it, denies queueing; idempotent", async () => {
    await ado("apply", "resources");
    fake.requests = [];
    const a = await ado("apply", "pipelines");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const created = writes().find((w) => w.path === "/contoso/Platform/_apis/pipelines")!.body as J;
    assert.deepEqual(created, { name: "delivery-demo", folder: "\\apps", configuration: { type: "yaml", path: "apps/demo/delivery.yml", repository: { id: "00000000-0000-0000-0000-0000000000b3", type: "azureReposGit" } } });
    const id = a.outputs!.pipeline.id as number;
    // Create, preview, then re-save the build definition unchanged (ADO-24: registers the trigger).
    const order = writes().map((w) => `${w.method} ${w.path}`).filter((x) => x.includes(`/${id}`) || x.endsWith("/_apis/pipelines"));
    assert.deepEqual(order, ["POST /contoso/Platform/_apis/pipelines", `POST /contoso/Platform/_apis/pipelines/${id}/preview`, `PUT /contoso/Platform/_apis/build/definitions/${id}`]);
    const put = writes().find((w) => w.method === "PUT" && w.path.endsWith(`/build/definitions/${id}`))!;
    assert.equal(put.contentType, "application/json");
    assert.equal((put.body as J).revision, 1, "the definition is sent back unchanged");
    assert.deepEqual((put.body as J).queue, { id: 140 }, "a definition without a default queue gets the hosted one");
    assert.equal(fake.state.definitions[id].revision, 2);
    const perms = writes().filter((w) => w.path.includes("/pipelinepermissions/"));
    assert.equal(perms.length, 6);
    assert.deepEqual(perms[0]!.body, { allPipelines: { authorized: false }, pipelines: [{ id, authorized: true }] });
    assert.deepEqual(perms.find((w) => w.path.includes(`${PLATFORM_ID}.`))!.body, { pipelines: [{ id, authorized: true }] }, "core repo: no allPipelines change");
    const queue = writes().find((w) => w.path.includes("33344d9c"))!.body as J;
    assert.equal(queue.token, `${PLATFORM_ID}/apps`);
    assert.deepEqual([queue.accessControlEntries[0].allow, queue.accessControlEntries[0].deny], [0, 128]);

    fake.requests = [];
    const again = await ado("apply", "pipelines");
    assert.equal(again.code, 0);
    assert.deepEqual(writes().map((w) => w.path), [`/contoso/Platform/_apis/pipelines/${id}/preview`], "a re-run only previews");
  });

  it("a failed call shows Azure DevOps' own message, neutralized and cut", async () => {
    await ado("apply", "resources");
    fake.failures = [{ method: "PATCH", path: "/pipelinepermissions/repository/", status: 401, message: "TF400813: The user 'x' is not authorized.\n##vso[task.setvariable variable=x]y " + "z".repeat(400) }];
    const a = await ado("apply", "pipelines");
    assert.equal(a.code, 1);
    const line = a.stdout.split("\n").find((l) => l.includes("pipelinepermissions/repository"))!;
    assert.match(line, /returned HTTP 401 \(the identity lacks a permission in Azure DevOps; see ADR-0022\)\. Azure DevOps: "TF400813: The user 'x' is not authorized\. /);
    assert.ok(!line.includes("##vso["), "logging commands are neutralized");
    assert.ok(line.includes("...\""), "the message is cut");
  });

  it("revokes extra authorisations and applies updates; a connection of an earlier identity is created again", async () => {
    fake.reset("configured");
    fake.state.permissions["environment/21"].pipelines.push({ id: 43, authorized: true });
    fake.state.endpoints[0].authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    fake.state.endpoints[0].createdBy = { id: CALLER.id, displayName: CALLER.providerDisplayName };
    const res = await ado("apply", "resources");
    assert.equal(res.code, 0, res.stdout);
    // Azure DevOps doesn't edit a managed-identity connection (sandbox run 3760): deleted and created again.
    assert.ok(!writes().some((w) => w.method === "PUT" && w.path.includes("serviceendpoint")), "never a PUT");
    const del = writes().find((w) => w.method === "DELETE" && w.path.includes("serviceendpoint"))!;
    assert.match(del.path, /endpoints\/00000000-0000-0000-0000-0000000000c1$/);
    const post = writes().find((w) => w.method === "POST" && w.path.endsWith("_apis/serviceendpoint/endpoints"))!.body as J;
    assert.equal(post.authorization.parameters.serviceprincipalid, SP.nonprod);
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-demo-nonprod");
    assert.notEqual(sc.id, "00000000-0000-0000-0000-0000000000c1");
    assert.equal(res.outputs!.environments.nonprod.serviceConnection.id, sc.id, "the new connection's ID and subject are recorded");
    assert.ok(res.outputs!.environments.nonprod.serviceConnection.subject.endsWith(sc.id));
    // Its checks are created on the new connection in the same apply.
    assert.ok(
      writes().some((w) => w.method === "POST" && w.path.includes("checks/configurations") && (w.body as J).resource?.id === sc.id),
      "a check on the new connection",
    );
    fake.requests = [];
    await ado("apply", "pipelines");
    const patch = writes().find((w) => w.path.endsWith("environment/21"))!.body as J;
    assert.deepEqual(patch, { allPipelines: { authorized: false }, pipelines: [{ id: 42, authorized: true }, { id: 43, authorized: false }] });
  });
});

describe("ado apply: a connection someone else made", () => {
  it("with another identity is left alone: blocked, no delete", async () => {
    fake.reset("configured");
    fake.state.endpoints[0].authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    // The sandbox fixture's connection was made by a person (createdBy Jane Owner).
    const r = await ado("apply", "resources");
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^blocked service-connection +sc-demo-nonprod {2}\(sc-demo-nonprod \(serviceprincipalid 00000000-0000-0000-0000-0000000000ff -> 00000000-0000-0000-0000-0000000000d1\) was created by someone else than this automation identity, and Azure DevOps doesn't edit a managed-identity connection: delete it by hand, and the next run creates it\.\)$/m);
    assert.ok(!writes().some((w) => w.path.includes("serviceendpoint/endpoints/")), "neither deleted nor edited");
  });
});

/** apps/demo/app.yaml with `repository` changed (slug and folder stay demo). */
function appWith(repository: J, ui?: J): string {
  const doc = parse(readFileSync(DEMO_APP, "utf8")) as J;
  doc.repository = { ...doc.repository, ...repository };
  if (ui) doc.ui = ui;
  const dir = join(tmp("pc-ado-app-"), "apps", "demo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.yaml"), stringify(doc));
  return join(dir, "app.yaml");
}

const MAIN = "refs/heads/main";
const ZERO = "0".repeat(40);
const repoWrites = () => writes().filter((w) => w.path.includes("/_apis/git/") || (w.path.includes("accesscontrolentries") && JSON.stringify(w.body).includes(CALLER.descriptor)));

describe("platform ado: the app repository (ADR-0039)", () => {
  beforeEach(() => fake.reset("empty"));
  const GIT_ACES = "/contoso/_apis/accesscontrolentries/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
  const callerAce = (token: string): number => fake.state.acls[token]?.acesDictionary[CALLER.descriptor]?.allow ?? 0;

  it("without repository.template: unmanaged as before (no caller, no rows that grant, push or open pull requests); it must exist", async () => {
    const p = await ado("apply", "resources");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.doesNotMatch(p.stdout, /^\S+ +(seed|onboarding|cleanup|branch-acl) /m);
    assert.ok(!fake.requests.some((q) => q.path.endsWith("/_apis/connectionData") || q.path.includes("/_apis/git/repositories/") && /\/(pushes|pullrequests|refs)$/.test(q.path)));
    assert.deepEqual(repoWrites(), []);
    delete fake.state.repos["Apps/demo"];
    const missing = await ado("plan", "resources");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /repository Apps\/demo not found/);
  });

  it("missing, node-ts: created, rights only until the seed is pushed, seeded with one commit, every right of the caller removed; idempotent", async () => {
    const app = appWith({ name: "shop", template: "node-ts" });
    const p = await ado("plan", "resources", [], {}, app);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.deepEqual(writes(), []);
    assert.match(p.stdout, /^create {2}repository {10}Apps\/shop {2}\(in Apps, seeded below \(template node-ts\)\)$/m);
    assert.match(p.stdout, /^create {2}repo-acl {12}Apps\/shop: id-contoso-ado-automation may contribute and create branches until the seed is pushed \(this repository only\) {2}\(allow 20, after the repository is created\)$/m);
    assert.match(p.stdout, /^create {2}seed {16}Apps\/shop: refs\/heads\/main {2}\(one commit with the node-ts starter, \d+ files \(platform repo render\)\)$/m);
    assert.match(p.stdout, /^update {2}cleanup {13}Apps\/shop: no rights of id-contoso-ado-automation left \(the repository, refs\/heads\/main\) {2}\(after this run's push/m);
    assert.match(p.stdout, /^create {2}repo-acl {12}Apps\/shop: build service may read {2}\(allow 2, after the repository is created\)$/m);

    fake.requests = [];
    const a = await ado("apply", "resources", [], {}, app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const repo = fake.state.repos["Apps/shop"];
    const repoToken = `repoV2/${APPS_ID}/${repo.id}`;
    const mainToken = branchTokenOf(APPS_ID, repo.id, "main");
    const w = repoWrites().map((x): [string, string, J] => [x.method, x.path.replace(repo.id, "{repo}"), x.body as J]);
    assert.deepEqual(w.map(([m, path]) => `${m} ${path}`), [
      "POST /contoso/Apps/_apis/git/repositories",
      `POST ${GIT_ACES}`,
      "POST /contoso/Apps/_apis/git/repositories/{repo}/pushes",
      `POST ${GIT_ACES}`,
      `POST ${GIT_ACES}`,
    ]);
    assert.deepEqual(w[0]![2], { name: "shop", project: { id: APPS_ID } });
    // Contribute + Create branch on this repository's token only (never the project's), for the seed.
    assert.deepEqual(w[1]![2], { token: repoToken, merge: true, accessControlEntries: [{ descriptor: CALLER.descriptor, allow: GIT.contribute | GIT.createBranch, deny: 0 }] });
    assert.ok(!writes().some((x) => (x.body as J)?.token === `repoV2/${APPS_ID}`), "nothing project-wide");
    const push = w[2]![2];
    assert.deepEqual(push.refUpdates, [{ name: MAIN, oldObjectId: ZERO }]);
    assert.equal(push.commits.length, 1);
    assert.match(push.commits[0].comment, /^Start demo from the node-ts starter \(core v0\.1\.0-rc\.3\)/);
    const changes = push.commits[0].changes as J[];
    assert.ok(changes.every((c) => c.changeType === "add" && c.newContent.contentType === "base64encoded" && c.item.path.startsWith("/")));
    const files = fake.filesOf(repo.id, MAIN)!;
    assert.equal(Object.keys(files).length, changes.length);
    for (const f of ["platform.yaml", "AGENTS.md", "CLAUDE.md", ".agents/skills/auth-entra/SKILL.md", ".claude/skills/auth-entra/SKILL.md", "package.json", "Dockerfile"]) assert.ok(files[f], f);
    assert.match(files["platform.yaml"]!.toString("utf8"), /^app: demo\b/m);
    // Then the caller's own grant and its branch creator rights on main are cleared (denies kept).
    assert.deepEqual(w.slice(3).map(([, , b]) => b), [
      { token: repoToken, merge: false, accessControlEntries: [{ descriptor: CALLER.descriptor, allow: 0, deny: 0 }] },
      { token: mainToken, merge: false, accessControlEntries: [{ descriptor: CALLER.descriptor, allow: 0, deny: 0 }] },
    ]);
    assert.deepEqual([callerAce(repoToken), callerAce(mainToken)], [0, 0]);
    assert.deepEqual(a.outputs!.repository, { id: repo.id, name: "shop", project: "Apps", template: "node-ts", created: true, seeded: true, pullRequestId: null });

    fake.requests = [];
    const again = await ado("apply", "resources", [], {}, app);
    assert.equal(again.code, 0, again.stdout);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update"), lines(again.stdout, "extra")), [], again.stdout);
    assert.match(again.stdout, new RegExp(`^ok {6}repository {10}Apps/shop {2}\\(${repo.id}, seeded by id-contoso-ado-automation \\(template node-ts; never re-seeded\\)\\)$`, "m"));
    assert.doesNotMatch(again.stdout, /^\S+ +seed /m);
    assert.deepEqual(repoWrites(), [], "never pushed twice, no rights");

    // Phase pipelines: exactly delivery-demo, as a Project Administrator of the apps project (H2):
    // no rights granted for the call.
    fake.requests = [];
    const pl = await ado("apply", "pipelines", [], {}, app);
    assert.equal(pl.code, 0, pl.stdout + pl.stderr);
    const id = pl.outputs!.pipeline.id as number;
    const seq = writes().filter((x) => x.path === GIT_ACES || x.path.endsWith(`/pipelinepermissions/repository/${APPS_ID}.${repo.id}`)).map((x) => [x.method, x.body]);
    assert.deepEqual(seq, [["PATCH", { allPipelines: { authorized: false }, pipelines: [{ id, authorized: true }] }]]);
    assert.match(pl.stdout, new RegExp(String.raw`^create {2}pipeline-permission repository Apps\/shop {2}\(authorize pipeline ${id} \(ADR-0039\)\) {2}\[done\]$`, "m"));
    assert.equal(callerAce(repoToken), 0);

    // Opened to all pipelines by someone: closed again, a repository provisioning created.
    fake.state.permissions[`repository/${APPS_ID}.${repo.id}`].allPipelines = { authorized: true };
    const close = await ado("plan", "pipelines", [], {}, app);
    assert.match(close.stdout, /^update {2}pipeline-permission repository Apps\/shop {2}\(close access for all pipelines \(a repository provisioning created\)/m);
  });

  it("seeds the app's ui.theme (ADR-0044): an offered theme's tokens, custom's placeholders, nothing for none", async () => {
    const meadow = BUILT_IN_APP_THEMES.find((t) => t.id === "meadow")!;
    const cases = [
      ["meadow", " and the meadow theme"],
      ["custom", " and placeholder theme files \\(custom\\)"],
      ["none", ""],
    ] as const;
    for (const [theme, detail] of cases) {
      fake.reset("empty");
      const a = await ado("apply", "resources", [], {}, appWith({ name: "shop", template: "node-ts" }, { theme }));
      assert.equal(a.code, 0, a.stdout + a.stderr);
      assert.match(a.stdout, new RegExp(`^create {2}seed {16}Apps/shop: refs/heads/main {2}\\(one commit with the node-ts starter${detail}, \\d+ files \\(platform repo render\\)\\) {2}\\[done\\]$`, "m"), theme);
      const push = writes().find((w) => w.path.endsWith("/pushes"))!.body as J;
      assert.match(push.commits[0].comment, new RegExp(`^Start demo from the node-ts starter \\(core v0\\.1\\.0-rc\\.3\\)${detail}\n`));
      const files = fake.filesOf(fake.state.repos["Apps/shop"].id, MAIN)!;
      const themeFiles = Object.keys(files).filter((f) => f.startsWith("theme/")).sort();
      if (theme === "none") {
        assert.deepEqual(themeFiles, []);
        continue;
      }
      assert.deepEqual(themeFiles, ["theme/README.md", "theme/theme.css", "theme/theme.json"], theme);
      const css = files["theme/theme.css"]!.toString("utf8");
      const json = JSON.parse(files["theme/theme.json"]!.toString("utf8")) as J;
      if (theme === "meadow") {
        assert.equal(css, themeCss(meadow));
        assert.deepEqual(json.tokens, meadow.tokens);
        assert.equal(json.placeholder, undefined);
      } else {
        assert.match(css, /^\/\* PLACEHOLDERS: /);
        assert.equal(json.placeholder, true);
        assert.deepEqual(json.tokens, BUILT_IN_APP_THEMES[0]!.tokens);
      }
    }
  });

  it("empty and existing: adopted and seeded", async () => {
    const app = appWith({ name: "shop", template: "python-fastapi" });
    fake.state.repos["Apps/shop"] = { id: "00000000-0000-0000-0000-0000000000b9", name: "shop", project: { id: APPS_ID, name: "Apps" }, size: 0 };
    const p = await ado("plan", "resources", [], {}, app);
    assert.match(p.stdout, /^ok {6}repository {10}Apps\/shop {2}\(00000000-0000-0000-0000-0000000000b9, empty: adopted and seeded below \(template python-fastapi\)\)$/m);
    assert.match(p.stdout, /^create {2}seed {16}Apps\/shop: refs\/heads\/main {2}\(one commit with the python-fastapi starter/m);
    const a = await ado("apply", "resources", [], {}, app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!writes().some((x) => x.path === "/contoso/Apps/_apis/git/repositories"), "not created again");
    assert.ok(Object.keys(fake.filesOf("00000000-0000-0000-0000-0000000000b9", MAIN)!).some((f) => f.endsWith(".py")));
    assert.deepEqual([a.outputs!.repository.created, a.outputs!.repository.seeded], [false, true]);
  });

  it("a stack template on a repository with content provisioning didn't push: blocked, nothing granted, pushed or authorised", async () => {
    const app = appWith({ template: "node-ts" });
    const r = await ado("apply", "resources", [], {}, app);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^blocked repository {10}Apps\/demo {2}\(has content that provisioning did not push \(refs\/heads\/main was not created by a push of id-contoso-ado-automation\): a repository it didn't create is never adopted \(ADR-0039\)/m);
    assert.doesNotMatch(r.stdout, /^\S+ +(seed|cleanup) /m);
    assert.deepEqual(repoWrites(), []);
    assert.ok(fake.requests.some((q) => q.path.endsWith("/pushes") && q.query.get("searchCriteria.pusherId") === CALLER.id && q.query.get("searchCriteria.refName") === MAIN));
    fake.requests = [];
    const pl = await ado("apply", "pipelines", [], {}, app);
    assert.equal(pl.code, 1);
    assert.match(pl.stdout, /^blocked pipeline-permission repository Apps\/demo {2}\(provisioning did not create this repository/m);
    assert.ok(!writes().some((x) => x.path.includes("/pipelinepermissions/repository/") && x.path.includes(DEMO_REPO)));
  });

  it("byo: platform/onboarding (merged with the repo's files) and a pull request, rights only for that, never touches main", async () => {
    const app = appWith({ template: "byo" });
    const before = fake.filesOf(DEMO_REPO, MAIN);
    const p = await ado("plan", "resources", [], {}, app);
    assert.match(p.stdout, /^create {2}repo-acl {12}Apps\/demo: id-contoso-ado-automation may contribute to pull requests for the onboarding pull request \(this repository only\) {2}\(allow 16384\)$/m);
    assert.match(p.stdout, /^create {2}branch-acl {10}Apps\/demo: id-contoso-ado-automation may create and push branches below platform\/ for it {2}\(allow 20\)$/m);
    const a = await ado("apply", "resources", [], {}, app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /^create {2}onboarding {10}Apps\/demo: platform\/onboarding and a pull request into refs\/heads\/main {2}\(push \d+ new, 1 changed, 0 deleted file\(s\) to platform\/onboarding, open a pull request\) {2}\[done\]$/m);
    const pushes = writes().filter((x) => x.path.endsWith("/pushes"));
    assert.equal(pushes.length, 1);
    assert.deepEqual((pushes[0]!.body as J).refUpdates, [{ name: "refs/heads/platform/onboarding", oldObjectId: DEMO_HEAD }], "a new branch from main's head");
    assert.equal(fake.filesOf(DEMO_REPO, MAIN), before, "main unchanged");
    assert.equal(fake.state.refs[DEMO_REPO].find((r: J) => r.name === MAIN).objectId, DEMO_HEAD);
    const branch = fake.filesOf(DEMO_REPO, "refs/heads/platform/onboarding")!;
    assert.equal(branch["README.md"]!.toString(), "# Demo\n\nOur own app.\n", "the app's own files are kept");
    assert.match(branch[".gitignore"]!.toString(), /^node_modules\n\n# Added by the platform template\n/);
    assert.match(branch["platform.yaml"]!.toString(), /^app: demo\b/m);
    assert.ok(branch[".claude/skills/auth-entra/SKILL.md"]!.equals(branch[".agents/skills/auth-entra/SKILL.md"]!));
    const changes = (pushes[0]!.body as J).commits[0].changes as J[];
    assert.ok(!changes.some((c) => ["README.md", "Dockerfile", "src/app.js"].includes(c.item.path.slice(1))));
    const pr = writes().find((x) => x.path.endsWith("/pullrequests"))!.body as J;
    assert.deepEqual([pr.sourceRefName, pr.targetRefName, pr.title], ["refs/heads/platform/onboarding", MAIN, "Platform onboarding: agent files and platform.yaml for demo"]);
    assert.ok(pr.description.length <= 4000 && pr.description.includes("- changed: .gitignore"));
    assert.equal(a.outputs!.repository.pullRequestId, fake.state.pullRequests[DEMO_REPO][0].pullRequestId);
    // Every right of the caller is gone again: its grants and the creator rights on the branch.
    const tokens = [`repoV2/${APPS_ID}/${DEMO_REPO}`, branchTokenOf(APPS_ID, DEMO_REPO, "platform"), branchTokenOf(APPS_ID, DEMO_REPO, "platform/onboarding")];
    assert.deepEqual(tokens.map(callerAce), [0, 0, 0]);
    assert.match(a.stdout, /^extra {3}cleanup {13}Apps\/demo: no rights of id-contoso-ado-automation left \(the repository, platform\/, platform\/onboarding\) {2}\(the repository: allow 16384 \(PullRequestContribute\); platform\/: allow 20 \(GenericContribute, CreateBranch\); platform\/onboarding: allow 12300 \(GenericContribute, ForcePush, RemoveOthersLocks, ManagePermissions\): removed\) {2}\[done\]$/m);

    fake.requests = [];
    const again = await ado("apply", "resources", [], {}, app);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /^ok {6}onboarding {10}.*\(pull request \d+ is active: the owner decides, it is never re-opened\)$/m);
    assert.deepEqual(repoWrites(), []);

    // An abandoned pull request is not re-opened.
    fake.state.pullRequests[DEMO_REPO][0].status = "abandoned";
    assert.match((await ado("plan", "resources", [], {}, app)).stdout, /^ok {6}onboarding {10}.*\(pull request \d+ is abandoned/m);
  });

  it("byo: an existing platform/onboarding is reused only when the caller alone pushed exactly the current render", async () => {
    const app = appWith({ template: "byo" });
    await ado("apply", "resources", [], {}, app);
    fake.state.pullRequests[DEMO_REPO] = [];
    const reuse = await ado("plan", "resources", [], {}, app);
    assert.match(reuse.stdout, /^create {2}onboarding {10}.*\(platform\/onboarding exists \(pushed by id-contoso-ado-automation, the current render\): open the pull request\)$/m);
    assert.doesNotMatch(reuse.stdout, /may create and push branches/, "no branch rights without a push");
    fake.requests = [];
    const a = await ado("apply", "resources", [], {}, app);
    assert.equal(a.code, 0, a.stdout);
    assert.ok(!writes().some((x) => x.path.endsWith("/pushes")), "not pushed again");
    assert.equal(writes().filter((x) => x.path.endsWith("/pullrequests")).length, 1);

    // Someone else pushed to the branch: blocked.
    fake.state.pullRequests[DEMO_REPO] = [];
    const ref = fake.state.refs[DEMO_REPO].find((r: J) => r.name === "refs/heads/platform/onboarding");
    fake.recordPush(DEMO_REPO, { id: "00000000-0000-0000-0000-0000000000a8", providerDisplayName: "Jane Owner" }, ref.name, ref.objectId, ref.objectId);
    const other = await ado("plan", "resources", [], {}, app);
    assert.equal(other.code, 1);
    assert.match(other.stdout, /^blocked onboarding {10}.*\(platform\/onboarding exists but was not pushed by id-contoso-ado-automation alone: it is not proposed\. Delete the branch, and the next run pushes it again\.\)$/m);

    // Pushed by the caller, but not the current render: blocked.
    fake.state.pushes[DEMO_REPO] = fake.state.pushes[DEMO_REPO].filter((x: J) => x.pushedBy.id === CALLER.id || x.refUpdates[0].name === MAIN);
    fake.state.commits[ref.objectId] = { ...fake.state.commits[ref.objectId], "platform.yaml": Buffer.from("app: someone-else\n") };
    const differs = await ado("plan", "resources", [], {}, app);
    assert.match(differs.stdout, /^blocked onboarding {10}.*\(platform\/onboarding exists but differs from the current onboarding files: it is not proposed/m);
    assert.deepEqual(lines(differs.stdout, "create").filter((l) => / (repo|branch)-acl /.test(l) && l.includes("Apps/demo")), [], "no rights when blocked");
  });

  it("byo: nothing to propose when the repository already has the files; empty: warn; missing: blocked", async () => {
    const app = appWith({ template: "byo" });
    await ado("apply", "resources", [], {}, app);
    // Merge the onboarding branch into main by hand, drop the pull request: nothing left to propose.
    const onboarding = fake.state.refs[DEMO_REPO].find((x: J) => x.name === "refs/heads/platform/onboarding").objectId;
    fake.state.refs[DEMO_REPO] = [{ name: MAIN, objectId: onboarding }];
    fake.state.pullRequests[DEMO_REPO] = [];
    const done = await ado("plan", "resources", [], {}, app);
    assert.match(done.stdout, /^ok {6}onboarding {10}.*\(already has the onboarding files: no pull request needed\)$/m);
    assert.match(done.stdout, /^ok {6}cleanup /m);

    fake.state.refs[DEMO_REPO] = [];
    const empty = await ado("plan", "resources", [], {}, app);
    assert.equal(empty.code, 0, empty.stdout);
    assert.match(empty.stdout, /^warn {4}repository {10}Apps\/demo {2}\(.*empty: a bring-your-own repository gets its onboarding pull request once it has refs\/heads\/main/m);
    assert.doesNotMatch(empty.stdout, /^\S+ +onboarding /m);

    delete fake.state.repos["Apps/demo"];
    const missing = await ado("plan", "resources", [], {}, app);
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /^blocked repository {10}Apps\/demo {2}\(not found, and repository\.template is byo: a bring-your-own repository must exist first/m);
    assert.match(missing.stdout, /^blocked repo-acl {12}Apps\/demo: build service may read/m);
  });

  it("missing outside the apps project: blocked, never created there", async () => {
    const doc = parse(readFileSync(instance, "utf8")) as J;
    doc.scm.azureDevOps.allowedProjects = ["Team"];
    const inst = join(tmp("pc-ado-team-"), "instance.yaml");
    writeFileSync(inst, stringify(doc));
    fake.state.projects.push({ id: "00000000-0000-0000-0000-0000000000a7", name: "Team", state: "wellFormed" });
    const app = appWith({ project: "Team", name: "shop", template: "node-ts" });
    const saved = instance;
    instance = inst;
    try {
      const r = await ado("apply", "resources", [], {}, app);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^blocked repository {10}Team\/shop {2}\(not found: provisioning creates repositories only in the apps project Apps \(ADR-0039\); create it by hand first\.\)$/m);
      assert.ok(!writes().some((x) => x.path.includes("/_apis/git/")));
    } finally {
      instance = saved;
    }
  });

  it("an unresolved caller blocks the onboarding and the cleanup; nothing is written to the repository", async () => {
    fake.failures = [{ method: "GET", path: "/_apis/connectionData", status: 401, message: "no" }];
    const r = await ado("apply", "resources", [], {}, appWith({ template: "byo" }));
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^blocked identity {12}the caller \(connectionData\) {2}\(GET _apis\/connectionData returned HTTP 401/m);
    assert.match(r.stdout, /^blocked onboarding {10}Apps\/demo: .*\(the caller's identity is unresolved \(see above\): no onboarding without its rights\.\)$/m);
    assert.match(r.stdout, /^blocked cleanup {13}Apps\/demo: no rights of the caller left/m);
    assert.deepEqual(repoWrites(), []);
  });

  it("a push refused by Azure DevOps fails the seed row (no retry, no escalation); its grant is removed anyway", async () => {
    const app = appWith({ name: "shop", template: "node-ts" });
    fake.failures = [{ method: "POST", path: "/pushes", status: 403, message: "TF401027: You need the Git 'CreateBranch' permission." }];
    const a = await ado("apply", "resources", [], {}, app);
    assert.equal(a.code, 1);
    assert.match(a.stdout, /^create {2}seed {16}Apps\/shop: refs\/heads\/main .*\[FAILED: POST .*pushes returned HTTP 403/m);
    assert.match(a.stdout, /^extra {3}cleanup {13}Apps\/shop: .*\[done\]$/m);
    assert.equal(callerAce(`repoV2/${APPS_ID}/${fake.state.repos["Apps/shop"].id}`), 0);
  });
});

describe("platform ado apply --phase pipelines: the app repository (ADR-0039 H1/H3)", () => {
  beforeEach(() => fake.reset("configured"));
  const REPO_PERM = `repository/${APPS_ID}.${DEMO_REPO}`;
  const REPO_TOKEN = `repoV2/${APPS_ID}/${DEMO_REPO}`;
  const byo = (): string => appWith({ template: "byo" });

  it("without repository.template: as before ADR-0039 (this pipeline added, others kept, no grant)", async () => {
    fake.state.permissions[REPO_PERM] = { pipelines: [{ id: 43, authorized: true }], resource: { id: `${APPS_ID}.${DEMO_REPO}`, type: "repository" } };
    const a = await ado("apply", "pipelines");
    assert.equal(a.code, 0, a.stdout);
    assert.deepEqual(writes().find((x) => x.path.endsWith(REPO_PERM))!.body, { pipelines: [{ id: 42, authorized: true }] });
    assert.ok(!writes().some((x) => (x.body as J)?.token === REPO_TOKEN));
  });

  it("byo: exactly delivery-demo, others revoked, no rights granted for the call", async () => {
    fake.state.permissions[REPO_PERM] = { pipelines: [{ id: 43, authorized: true }], resource: { id: `${APPS_ID}.${DEMO_REPO}`, type: "repository" } };
    const p = await ado("plan", "pipelines", [], {}, byo());
    assert.match(p.stdout, /^extra {3}pipeline-permission repository Apps\/demo {2}\(authorize pipeline 42, revoke pipelines 43 \(ADR-0039\)\)$/m);
    const a = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(a.code, 0, a.stdout);
    assert.deepEqual(writes().find((x) => x.path.endsWith(REPO_PERM))!.body, { allPipelines: { authorized: false }, pipelines: [{ id: 42, authorized: true }, { id: 43, authorized: false }] });
    assert.ok(!writes().some((x) => (x.body as J)?.token === REPO_TOKEN), "no ACE on the repository");
  });

  it("another app's delivery pipeline on the repository is never revoked: blocked", async () => {
    fake.state.pipelines.push({ id: 44, name: "delivery-shop", folder: "\\apps", revision: 1 });
    fake.state.permissions[REPO_PERM] = { pipelines: [{ id: 44, authorized: true }], resource: { id: `${APPS_ID}.${DEMO_REPO}`, type: "repository" } };
    const a = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(a.code, 1, a.stdout);
    assert.match(a.stdout, /^blocked pipeline-permission repository Apps\/demo {2}\(it is also authorised for \\apps\\delivery-shop \(44\): another app's delivery pipeline is never revoked here/m);
    assert.ok(!writes().some((x) => x.path.endsWith(REPO_PERM)));
  });

  it("H3: Azure DevOps refuses (401 as in the sandbox, or 403): a blocked row that waits for a person", async () => {
    fake.state.permissions[REPO_PERM].pipelines = [];
    fake.failures = [{ method: "PATCH", path: `/pipelinepermissions/${REPO_PERM}`, status: 401, message: "The resource doesn't exist or the user doesn't have admin permission." }];
    const a = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(a.code, 3, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    assert.match(a.stdout, /^blocked pipeline-permission repository Apps\/demo {2}\(H3, waiting for a project administrator: Azure DevOps refused to authorise \\apps\\delivery-demo on Apps\/demo \(HTTP 401\)\./m);
    assert.ok(!writes().some((x) => (x.body as J)?.token === REPO_TOKEN), "no ACE on the repository");
  });

  it("H3: Azure DevOps refuses (403): a blocked row that waits for a person, exit 3, the grant removed; other errors fail (exit 1)", async () => {
    fake.state.permissions[REPO_PERM].pipelines = [];
    fake.failures = [{ method: "PATCH", path: `/pipelinepermissions/${REPO_PERM}`, status: 403, message: "Access denied." }];
    const a = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(a.code, 3, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    assert.match(a.stdout, /^blocked pipeline-permission repository Apps\/demo {2}\(H3, waiting for a project administrator: Azure DevOps refused to authorise \\apps\\delivery-demo on Apps\/demo \(HTTP 403\)\. The ADO automation identity must be a Project Administrator of Apps \(platform ado bootstrap --phase grants, ADR-0039 H2\)\. Otherwise an administrator runs platform ado apply --phase pipelines for demo with their own token/m);
    assert.equal(writes().filter((x) => x.path.includes("pipelinepermissions")).length, 1, "tried once, no other way around it");
    assert.ok(!writes().some((x) => (x.body as J)?.token === REPO_TOKEN), "no ACE on the repository");

    fake.failures = [{ method: "PATCH", path: `/pipelinepermissions/${REPO_PERM}`, status: 500, message: "boom" }];
    const b = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(b.code, 1);
    assert.match(b.stdout, /repository Apps\/demo .*\[FAILED: PATCH .* returned HTTP 500/);

    // A waiting row next to a real failure: exit 1.
    fake.failures = [
      { method: "PATCH", path: `/pipelinepermissions/${REPO_PERM}`, status: 403, message: "Access denied." },
      { method: "POST", path: "/preview", status: 400, message: "bad yaml" },
    ];
    assert.equal((await ado("apply", "pipelines", [], {}, byo())).code, 1);
  });

  it("byo: a repository open to all pipelines (from before ADR-0039) is left as it is", async () => {
    fake.state.permissions[REPO_PERM] = { allPipelines: { authorized: true }, pipelines: [], resource: { id: `${APPS_ID}.${DEMO_REPO}`, type: "repository" } };
    const a = await ado("apply", "pipelines", [], {}, byo());
    assert.equal(a.code, 0, a.stdout);
    assert.match(a.stdout, /^ok {6}pipeline-permission repository Apps\/demo {2}\(open to all pipelines of the project \(a repository from before ADR-0039; left as it is\)\)$/m);
    assert.ok(!writes().some((x) => x.path.endsWith(REPO_PERM)));
  });
});

describe("platform ado apply --resave (ADO-24)", () => {
  beforeEach(() => fake.reset("configured"));

  it("re-saves an existing pipeline's build definition only when asked", async () => {
    const plain = await ado("apply", "pipelines");
    assert.equal(plain.code, 0);
    assert.ok(!writes().some((w) => w.path.includes("/build/definitions/")), "no re-save without --resave");

    fake.requests = [];
    const plan = await ado("plan", "pipelines", ["--resave"]);
    assert.match(plan.stdout, /^update {2}pipeline {12}\\apps\\delivery-demo {2}\(id 42: re-save the build definition \(registers the app repo trigger, ADO-24\)\)$/m);
    assert.deepEqual(writes(), []);

    const r = await ado("apply", "pipelines", ["--resave"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(writes().map((w) => `${w.method} ${w.path}`), ["POST /contoso/Platform/_apis/pipelines/42/preview", "PUT /contoso/Platform/_apis/build/definitions/42"]);
    assert.ok(fake.requests.some((q) => q.method === "GET" && q.path.endsWith("/build/definitions/42") && q.query.get("api-version") === "7.1"));
    assert.equal(fake.state.definitions[42].revision, 3);
  });

  it("re-saves without --resave a pipeline still at revision 1 (its re-save after creation never happened)", async () => {
    fake.state.definitions[42].revision = 1;
    const plan = await ado("plan", "pipelines");
    assert.match(plan.stdout, /^update {2}pipeline {12}\\apps\\delivery-demo {2}\(id 42: re-save the build definition \(registers the app repo trigger, ADO-24; never re-saved since its creation\)\)$/m);
    const r = await ado("apply", "pipelines");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(fake.state.definitions[42].revision, 2);
    const again = await ado("plan", "pipelines");
    assert.match(again.stdout, /^ok {6}pipeline {12}\\apps\\delivery-demo {2}\(id 42\)$/m);
  });

  it("fails the pipeline object when the save creates no new revision", async () => {
    fake.freezeRevisions = true;
    const r = await ado("apply", "pipelines", ["--resave"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /FAILED: re-saving build definition 42 did not create a new revision \(2 -> 2\)/);
  });

  it("--resave is for the pipelines phase only", async () => {
    assert.equal((await ado("plan", "resources", ["--resave"])).code, 2);
  });
});

describe("platform ado: inputs and safety", () => {
  beforeEach(() => fake.reset("configured"));

  it("checks the organization, token and arguments before calling anything", async () => {
    assert.match((await run(["plan", "--instance", instance, "--app", join(P, "apps", "demo", "app.yaml"), "--phase", "pipelines", "--org-url", "https://dev.azure.com/fabrikam"])).stderr, /not this instance's organization/);
    assert.match((await ado("plan", "pipelines", [], { AZURE_DEVOPS_TOKEN: undefined })).stderr, /no token/);
    const noLz = await run(["plan", "--instance", instance, "--app", join(P, "apps", "demo", "app.yaml"), "--phase", "resources", "--org-url", fake.orgUrl]);
    assert.equal(noLz.code, 2);
    assert.match(noLz.stderr, /needs --lz-outputs for nonprod, prod/);
    assert.equal((await ado("plan", "pipelines", ["--env", "qa"])).code, 1);
    assert.equal((await run(["delete", "--phase", "resources"])).code, 2);
    assert.equal(fake.requests.length, 0);
  });

  it("help names every right of the portal identity, View project-level information included", async () => {
    const r = await run(["help"]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /id-<prefix>-portal: View\s+project-level information on the platform project, Read and Contribute to pull\s+requests on platform-config, Create branch and Contribute below portal\/requests\//);
    assert.match(r.stdout, /3 \(ado apply\) only\s+rows that wait for a person/);
  });

  it("--env limits the environments", async () => {
    const r = await ado("plan", "resources", ["--env", "nonprod"]);
    assert.equal(r.code, 0);
    assert.ok(!r.stdout.includes("demo-prod"));
    assert.ok(!fake.requests.some((q) => q.path.includes("identities") && q.query.get("filterValue") === "sg-platform-team"), "no approver lookup without prod");
  });

  it("accepts only dev.azure.com organizations (loopback for tests)", () => {
    assert.deepEqual(parseOrgUrl("https://dev.azure.com/contoso/"), { name: "contoso", base: "https://dev.azure.com/contoso/", vssps: "https://vssps.dev.azure.com/contoso/", vsaex: "https://vsaex.dev.azure.com/contoso/", url: "https://dev.azure.com/contoso" });
    for (const bad of ["http://dev.azure.com/contoso", "https://evil.example/contoso", "https://dev.azure.com/contoso/project", "https://dev.azure.com:8443/contoso", "https://user@dev.azure.com/contoso", "https://dev.azure.com/contoso?x=1", "https://contoso.visualstudio.com/"]) {
      assert.throws(() => parseOrgUrl(bad), Error, bad);
    }
  });

  it("reads the delivery identity from ARM deployment outputs or a plain object", () => {
    assert.equal(deliveryClientId({ deliveryIdentityClientId: { type: "String", value: SP.prod } }, "x"), SP.prod);
    assert.equal(deliveryClientId({ deliveryIdentityClientId: SP.prod }, "x"), SP.prod);
    assert.throws(() => deliveryClientId({ deliveryIdentityClientId: { value: "nope" } }, "x"));
  });

  it("names match infra/modules/naming/naming.bicep", () => {
    const text = readFileSync(join(REPO_ROOT, "infra", "modules", "naming", "naming.bicep"), "utf8");
    const pattern = (fn: string): string => {
      const m = new RegExp(`func ${fn}\\([^)]*\\) string => '([^']+)'`).exec(text);
      assert.ok(m, fn);
      return m[1]!.replace(/\$\{s\(slug\)\}/g, "SLUG").replace(/\$\{e\(env\)\}/g, "ENV");
    };
    assert.equal(pattern("adoServiceConnection"), adoServiceConnection("SLUG", "ENV"));
    assert.equal(pattern("adoEnvironment"), adoEnvironment("SLUG", "ENV"));
    assert.equal(pattern("adoDeliveryPipeline"), adoDeliveryPipeline("SLUG"));
    assert.equal(pattern("adoPlatformPipeline"), adoPlatformPipeline("ENV"));
    assert.equal(pattern("adoPlatformEnvironment"), adoPlatformEnvironment("ENV"));
  });
});
