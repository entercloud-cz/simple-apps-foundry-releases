import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { CLI, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { APPS_ID, AUTOMATION_OID, CONFIG_REPO, FakeAdo, GIT, GROUP_ID, GROUP_OID, GROUPS, PLATFORM_ID, PORTAL_OID, TOKEN, branchTokenOf } from "./ado-fake.js";
import { isPlatformTeamReview, parseBootstrapOutputs } from "../src/ado/bootstrap.js";
import { identitiesLock, identitiesResourceGroup, instanceServiceConnection, provisioningServiceConnection } from "../src/ado/names.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform ado bootstrap` against the fake organization of ado.test.ts (sandbox shapes; the
// security namespaces and role definitions are the sandbox's real GET responses).
const fake = new FakeAdo();
const P = join(FIXTURES, "provisioning", "config");
const ID = {
  provNonprod: "00000000-0000-0000-0000-00000000f001",
  provProd: "00000000-0000-0000-0000-00000000f011",
  ado: "00000000-0000-0000-0000-00000000f021",
  entra: "00000000-0000-0000-0000-00000000f031",
  portal: "00000000-0000-0000-0000-00000000f041",
};

let instance = "";
/** The same instance without approvals.entraChanges: the default, pullRequest (ADR-0051). */
let prInstance = "";
const ids: Record<string, string> = {};

/**
 * infra/platform/bootstrap.bicep outputs as `az deployment sub show --query properties.outputs` prints
 * them; `instanceIdentities` = the ADO automation and Entra provisioning identities exist there.
 * `legacy`: outputs of a core version before P5a (no entraProvisioningIdentity, no entraResourceGroup).
 * `portal`: with portalIdentity (core versions since the portal, ADR-0036).
 */
function outputs(env: string, provClient: string, instanceIdentities: boolean, legacy = false, portal = false): J {
  return {
    identitiesResourceGroup: { type: "String", value: `rg-contoso-identities-${env}` },
    provisioningIdentity: { type: "Object", value: { name: `id-contoso-provisioning-${env}`, clientId: provClient, principalId: "00000000-0000-0000-0000-00000000f0f0" } },
    adoAutomationIdentity: instanceIdentities ? { type: "Object", value: { name: "id-contoso-ado-automation", clientId: ID.ado, principalId: AUTOMATION_OID } } : { type: "Object" },
    ...(legacy
      ? {}
      : {
          entraProvisioningIdentity: instanceIdentities ? { type: "Object", value: { name: "id-contoso-entra-provisioning", clientId: ID.entra, principalId: "00000000-0000-0000-0000-00000000f032" } } : { type: "Object" },
          entraResourceGroup: { type: "String", value: instanceIdentities ? "rg-contoso-entra" : null },
        }),
    ...(portal ? { portalIdentity: instanceIdentities ? { type: "Object", value: { name: "id-contoso-portal", clientId: ID.portal, principalId: PORTAL_OID } } : { type: "Object" } } : {}),
    tenantId: { type: "String", value: "00000000-0000-0000-0000-000000000001" },
    subscriptionId: { type: "String", value: "00000000-0000-0000-0000-00000000a001" },
  };
}

before(async () => {
  await fake.start();
  const doc = parse(readFileSync(join(P, "instance.yaml"), "utf8")) as J;
  doc.scm.azureDevOps.organizationUrl = fake.orgUrl;
  // The approvers of sc-platform-entra: the fake organization's platform team group.
  doc.approvals.platformTeam.displayName = "sg-platform-team";
  // The suites below test the separate Approval check (ADR-0023); pullRequest has its own (ADR-0051).
  doc.approvals.entraChanges = "separate";
  const dir = tmp("pc-adobs-");
  instance = join(dir, "instance.yaml");
  writeFileSync(instance, stringify(doc));
  delete doc.approvals.entraChanges;
  prInstance = join(dir, "instance-pr.yaml");
  writeFileSync(prInstance, stringify(doc));
  ids.nonprod = join(dir, "nonprod.json");
  ids.prod = join(dir, "prod.json");
  writeFileSync(ids.nonprod, JSON.stringify(outputs("nonprod", ID.provNonprod, false)));
  writeFileSync(ids.prod, JSON.stringify(outputs("prod", ID.provProd, true)));
  ids.prodPortal = join(dir, "prod-portal.json");
  writeFileSync(ids.prodPortal, JSON.stringify(outputs("prod", ID.provProd, true, false, true)));
});
after(() => fake.stop());

function run(args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const merged: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SYSTEM_ACCESSTOKEN|AZURE_DEVOPS_TOKEN)$/.test(k))) as Record<string, string>;
  for (const [k, v] of Object.entries({ AZURE_DEVOPS_TOKEN: TOKEN, NO_COLOR: "1", ...env })) {
    if (v === undefined) delete merged[k];
    else merged[k] = v;
  }
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "ado", "bootstrap", ...args], { env: merged });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function bs(action: "plan" | "apply", phase: string, extra: string[] = [], inst = instance) {
  const output = join(tmp(), "out.json");
  const r = await run([action, "--instance", inst, "--org-url", fake.orgUrl, "--phase", phase, "--identities", `nonprod=${ids.nonprod}`, "--identities", `prod=${ids.prod}`, "--output", output, ...extra]);
  let out: J | undefined;
  try {
    out = JSON.parse(readFileSync(output, "utf8")) as J;
  } catch {
    out = undefined;
  }
  return { ...r, out };
}

const lines = (stdout: string, status: string): string[] => stdout.split("\n").filter((l) => l.startsWith(status.padEnd(8)));
const writes = () => fake.requests.filter((r) => r.method !== "GET");

describe("platform ado bootstrap --phase connections", () => {
  beforeEach(() => fake.reset("configured"));

  it("plans four connections with three checks each and an Approval on sc-platform-entra, two platform environments with four checks each, only GETs", async () => {
    const r = await bs("plan", "connections");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(writes(), []);
    const create = lines(r.stdout, "create");
    assert.equal(create.filter((l) => l.includes("service-connection")).length, 4);
    assert.equal(create.filter((l) => l.includes(" check ")).length, 21);
    // ADR-0043: the environment platform-{env} carries the platform pipeline's Approval.
    assert.deepEqual(create.filter((l) => / environment {9}platform-/.test(l)).map((l) => l.replace(/ +/g, " ").trim()), ["create environment platform-nonprod", "create environment platform-prod"]);
    assert.deepEqual(create.filter((l) => l.includes("platform-prod: ")).map((l) => l.replace(/ +/g, " ").replace(/ \(.*$/, "")), [
      "create check platform-prod: Approval",
      "create check platform-prod: Required template",
      "create check platform-prod: Branch control",
      "create check platform-prod: Exclusive lock",
    ]);
    assert.match(r.stdout, /create {2}service-connection {2}sc-platform-ado {2}\(WIF, identity 00000000-0000-0000-0000-00000000f021/);
    assert.match(r.stdout, new RegExp(`^ok {6}identity {12}sc-platform-entra approvers \\(approvals\\.platformTeam\\) {2}\\(sg-platform-team -> ${GROUP_ID}\\)$`, "m"));
    assert.match(r.stdout, /create {2}service-connection {2}sc-platform-entra {2}\(WIF, identity 00000000-0000-0000-0000-00000000f031, subscription 00000000-0000-0000-0000-00000000a001\)/);
    assert.deepEqual(create.filter((l) => l.includes("sc-platform-entra: ")).map((l) => l.replace(/ +/g, " ").replace(/ \(.*$/, "")), [
      "create check sc-platform-entra: Approval",
      "create check sc-platform-entra: Required template",
      "create check sc-platform-entra: Branch control",
      "create check sc-platform-entra: Exclusive lock",
    ]);
    assert.match(r.stdout, /nonprod provisioning: not available yet/);
    assert.match(r.stdout, /prod entra: not available yet/);
    assert.deepEqual(r.out!.federation, { nonprod: { provisioning: null }, prod: { provisioning: null, adoAutomation: null, entra: null } });
  });

  it("approvals.allowSelfApproval: the requester can approve sc-platform-entra, with a warn row (ADR-0034)", async () => {
    const doc = parse(readFileSync(instance, "utf8")) as J;
    doc.approvals.allowSelfApproval = true;
    const self = join(tmp("pc-adobs-self-"), "instance.yaml");
    writeFileSync(self, stringify(doc));
    await bs("apply", "connections");
    const r = await bs("plan", "connections", [], self);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^warn {4}identity {12}sc-platform-entra approvers \(self-approval\) {2}\(approvals\.allowSelfApproval is true: the requester can approve their own runs/m);
    assert.deepEqual(lines(r.stdout, "update").map((l) => l.replace(/ +/g, " ")), [
      "update check sc-platform-entra: Approval (requesterCannotBeApprover -> false)",
      "update check platform-nonprod: Approval (requesterCannotBeApprover -> false)",
      "update check platform-prod: Approval (requesterCannotBeApprover -> false)",
    ]);
    fake.requests = [];
    assert.equal((await bs("apply", "connections", [], self)).code, 0);
    const patch = writes().find((w) => w.method === "PATCH" && w.path.includes("/checks/configurations/") && (w.body as J).resource?.name === "sc-platform-entra")!.body as J;
    assert.equal(patch.settings.requesterCannotBeApprover, false);
    assert.match(patch.settings.instructions, /entra_plan.*The requester can approve \(approvals\.allowSelfApproval\)\.$/);
    const again = await bs("plan", "connections", [], self);
    assert.deepEqual(lines(again.stdout, "update"), [], "a stored check without requesterCannotBeApprover is up to date");

    // --phase pipeline authorises sc-platform-entra with that check only while the setting is on.
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    fake.requests = [];
    const p = await bs("apply", "pipeline", [], self);
    assert.equal(p.code, 0, p.stdout);
    assert.match(p.stdout, /^warn {4}identity {12}endpoint sc-platform-entra \(self-approval\)/m);
    assert.ok(writes().some((w) => w.path.endsWith(`/endpoint/${sc.id}`)), "authorised");
    const strict = await bs("plan", "pipeline");
    assert.equal(strict.code, 1);
    assert.match(strict.stdout, /^blocked pipeline-permission endpoint sc-platform-entra {2}\(it has no Approval check with an approver and requesterCannotBeApprover:/m);
  });

  it("apply creates the connections and checks, reads issuer and subject back, then plans all ok", async () => {
    const a = await bs("apply", "connections");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const scs = writes().filter((w) => w.path === "/contoso/_apis/serviceendpoint/endpoints").map((w) => w.body as J);
    assert.deepEqual(scs.map((b) => [b.name, b.authorization.parameters.serviceprincipalid, b.data.subscriptionId, b.isShared, b.data.creationMode, b.data.scopeLevel]), [
      ["sc-platform-provisioning-nonprod", ID.provNonprod, "00000000-0000-0000-0000-00000000a001", false, "Manual", "Subscription"],
      ["sc-platform-provisioning-prod", ID.provProd, "00000000-0000-0000-0000-00000000a001", false, "Manual", "Subscription"],
      ["sc-platform-ado", ID.ado, "00000000-0000-0000-0000-00000000a001", false, "Manual", "Subscription"],
      ["sc-platform-entra", ID.entra, "00000000-0000-0000-0000-00000000a001", false, "Manual", "Subscription"],
    ]);
    const checks = writes().filter((w) => w.path.endsWith("/checks/configurations")).map((w) => w.body as J);
    assert.equal(checks.length, 21);
    // A provisioning connection also serves its environment's platform pipeline (ADR-0043).
    const template = checks.find((c) => c.type.name === "ExtendsCheck")!;
    assert.equal(template.resource.name, "sc-platform-provisioning-nonprod");
    assert.deepEqual(template.settings.extendsChecks, [
      { repositoryType: "git", repositoryName: "Platform/core", repositoryRef: "refs/tags/v0.1.0-rc.3", templatePath: "pipelines/azure-devops/app-provisioning.yml" },
      { repositoryType: "git", repositoryName: "Platform/core", repositoryRef: "refs/tags/v0.1.0-rc.3", templatePath: "pipelines/azure-devops/platform-environment.yml" },
    ]);
    const extendsOf = (name: string): string[] => checks.find((c) => c.type.name === "ExtendsCheck" && c.resource.name === name)!.settings.extendsChecks.map((t: J) => t.templatePath);
    assert.deepEqual(extendsOf("sc-platform-ado"), ["pipelines/azure-devops/app-provisioning.yml"]);
    assert.deepEqual(extendsOf("sc-platform-entra"), ["pipelines/azure-devops/app-provisioning.yml"]);
    assert.deepEqual(extendsOf("platform-nonprod"), ["pipelines/azure-devops/platform-environment.yml"]);
    const branch = checks.find((c) => c.type.name === "Task Check")!;
    assert.deepEqual(branch.settings.inputs, { allowedBranches: "refs/heads/main,refs/tags/v*", ensureProtectionOfBranch: "false", allowUnknownStatusBranch: "false" });
    assert.equal(checks.filter((c) => c.type.name === "ExclusiveLock" && c.resource.type === "endpoint").length, 4);
    assert.equal(checks.filter((c) => c.type.name === "ExclusiveLock" && c.resource.type === "environment").length, 2);
    const envApprovals = checks.filter((c) => c.type.name === "Approval" && c.resource.type === "environment");
    assert.deepEqual(envApprovals.map((c) => [c.resource.name, c.settings.approvers, c.settings.requesterCannotBeApprover]), [
      ["platform-nonprod", [{ id: GROUP_ID }], true],
      ["platform-prod", [{ id: GROUP_ID }], true],
    ]);
    assert.match(envApprovals[0]!.settings.instructions, /stage deploy of \\platform\\platform-<env>.*The requester cannot approve\.$/);
    const envs = writes().filter((w) => w.method === "POST" && w.path.endsWith("/_apis/pipelines/environments")).map((w) => (w.body as J).name);
    assert.deepEqual(envs, ["platform-nonprod", "platform-prod"]);
    assert.deepEqual(Object.keys(a.out!.platformEnvironments), ["nonprod", "prod"]);

    // sc-platform-entra (ADR-0023): the platform team approves, the requester can't; its Approval is
    // the first check written after the connection.
    const entra = a.out!.connections["sc-platform-entra"];
    assert.equal(entra.identityClientId, ID.entra);
    const onEntra = checks.filter((c) => c.resource.id === entra.id);
    assert.deepEqual(onEntra.map((c) => c.type.name), ["Approval", "ExtendsCheck", "Task Check", "ExclusiveLock"]);
    const approvals = checks.filter((c) => c.type.name === "Approval" && c.resource.type === "endpoint");
    assert.equal(approvals.length, 1, "of the connections, only sc-platform-entra has an Approval");
    assert.deepEqual(approvals[0], {
      type: { id: "8c6f20a7-a545-4486-9777-f762fafe0d4d", name: "Approval" },
      timeout: 10080,
      settings: {
        approvers: [{ id: GROUP_ID }],
        blockedApprovers: [],
        executionOrder: "anyOrder",
        instructions: approvals[0]!.settings.instructions,
        minRequiredApprovers: 0,
        requesterCannotBeApprover: true,
      },
      resource: { type: "endpoint", id: entra.id, name: "sc-platform-entra" },
    });
    assert.match(approvals[0]!.settings.instructions, /entra_plan.*The requester cannot approve\.$/);
    const order = writes().map((w) => (w.path === "/contoso/_apis/serviceendpoint/endpoints" ? `sc ${(w.body as J).name}` : w.path.endsWith("/checks/configurations") ? `check ${(w.body as J).resource.name} ${(w.body as J).type.name}` : ""));
    assert.equal(order.indexOf("check sc-platform-entra Approval"), order.indexOf("sc sc-platform-entra") + 1);

    const fed = a.out!.federation;
    assert.match(fed.nonprod.provisioning.subject, /^\/eid1\/c\/pub\/t\/AAAA\/a\/BBBB\/sc\//);
    assert.equal(fed.prod.adoAutomation.issuer, "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0");
    assert.equal(a.out!.connections["sc-platform-ado"].identityClientId, ID.ado);
    assert.match(a.stdout, /prod adoAutomation: issuer https:\/\/login\.microsoftonline\.com\//);
    assert.deepEqual(fed.prod.entra, { issuer: entra.issuer, subject: entra.subject });
    assert.match(fed.prod.entra.subject, new RegExp(`/sc/[0-9a-f-]+/${entra.id}$`));
    assert.match(a.stdout, /prod entra: issuer https:\/\/login\.microsoftonline\.com\/.*subject \/eid1\//);

    fake.requests = [];
    const again = await bs("plan", "connections");
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update")), [], again.stdout);
    assert.deepEqual(again.out!.federation, fed, "read back on every run");
  });

  it("reports a changed identity, template ref and branch as updates", async () => {
    await bs("apply", "connections");
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-provisioning-prod");
    sc.authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    for (const c of fake.state.checks) {
      if (c.resource.id !== sc.id) continue;
      if (c.type.name === "ExtendsCheck") c.settings.extendsChecks[0].repositoryRef = "refs/tags/v0.0.9";
      if (c.type.name === "Task Check") c.settings.inputs.allowedBranches = "refs/heads/*";
    }
    const r = await bs("plan", "connections");
    const upd = lines(r.stdout, "update").join("\n");
    assert.match(upd, /sc-platform-provisioning-prod {2}\(serviceprincipalid 00000000-0000-0000-0000-0000000000ff -> 00000000-0000-0000-0000-00000000f011\)/);
    assert.match(upd, /sc-platform-provisioning-prod: Required template/);
    assert.match(upd, /sc-platform-provisioning-prod: Branch control {2}\(allowedBranches -> refs\/heads\/main,refs\/tags\/v\*\)/);

    // sc-platform-entra's Approval is reconciled like the other checks: changed by hand -> update,
    // removed by hand -> create.
    const entra = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    const approval = fake.state.checks.find((c: J) => c.resource.id === entra.id && c.type.name === "Approval");
    approval.settings.requesterCannotBeApprover = false;
    approval.settings.approvers = [{ id: "00000000-0000-0000-0000-0000000000ee" }];
    const r2 = await bs("plan", "connections");
    assert.match(lines(r2.stdout, "update").join("\n"), new RegExp(`sc-platform-entra: Approval {2}\\(approvers -> ${GROUP_ID}, requesterCannotBeApprover -> true\\)`));
    fake.requests = [];
    const fixed = await bs("apply", "connections");
    const patch = writes().find((w) => w.method === "PATCH" && w.path.endsWith(`/checks/configurations/${approval.id}`))!;
    assert.deepEqual([patch.body as J].map((b) => [b.settings.approvers, b.settings.requesterCannotBeApprover]), [[[{ id: GROUP_ID }], true]], fixed.stdout);
    fake.state.checks = fake.state.checks.filter((c: J) => c !== approval && c.id !== approval.id);
    const r3 = await bs("plan", "connections");
    assert.deepEqual(lines(r3.stdout, "create").map((l) => l.replace(/ +/g, " ")), ["create check sc-platform-entra: Approval"]);
  });

  it("does not create or change sc-platform-entra while its approvers are unresolved; the other connections go on", async () => {
    const group = (i: J): boolean => i.id === GROUP_ID;
    const withoutGroup = (): void => void (fake.state.identities = fake.state.identities.filter((i: J) => !group(i)));
    withoutGroup();
    const a = await bs("apply", "connections");
    assert.equal(a.code, 1, a.stdout);
    assert.match(a.stdout, new RegExp(`^blocked identity {12}sc-platform-entra approvers \\(approvals\\.platformTeam\\) {2}\\(Entra group ${GROUP_OID} \\(sg-platform-team\\) not found in the organization \\(ADO-23`, "m"));
    assert.match(a.stdout, /^blocked service-connection {2}sc-platform-entra {2}\(not created or changed without its Approval check: the approvers are unresolved/m);
    const scs = writes().filter((w) => w.path === "/contoso/_apis/serviceendpoint/endpoints").map((w) => (w.body as J).name);
    assert.deepEqual(scs, ["sc-platform-provisioning-nonprod", "sc-platform-provisioning-prod", "sc-platform-ado"]);
    const checks = writes().filter((w) => w.path.includes("/checks/configurations")).map((w) => w.body as J);
    assert.equal(checks.length, 9);
    assert.ok(!JSON.stringify(writes()).includes("sc-platform-entra"), "nothing written for sc-platform-entra");
    assert.equal(a.out!.federation.prod.entra, null);
    assert.equal(a.out!.connections["sc-platform-entra"], undefined);

    // An existing sc-platform-entra is left as it is (no update of the connection or its checks).
    fake.reset("configured");
    await bs("apply", "connections");
    const entra = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    entra.authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    fake.state.checks.find((c: J) => c.resource.id === entra.id && c.type.name === "Approval").settings.requesterCannotBeApprover = false;
    withoutGroup();
    fake.requests = [];
    const again = await bs("apply", "connections");
    assert.equal(again.code, 1);
    assert.ok(!writes().some((w) => w.path.includes(entra.id) || (w.body as J)?.resource?.id === entra.id), JSON.stringify(writes()));
    assert.ok(!fake.requests.some((q) => q.query.get("endpointNames") === "sc-platform-entra" || q.query.get("resourceId") === entra.id), "not even read");

    // Without approvals.platformTeam.displayName the group can't be looked up: blocked the same way.
    const doc = parse(readFileSync(instance, "utf8")) as J;
    delete doc.approvals.platformTeam.displayName;
    const inst2 = join(tmp(), "instance.yaml");
    writeFileSync(inst2, stringify(doc));
    fake.reset("empty");
    const p = await bs("plan", "connections", [], inst2);
    assert.equal(p.code, 1);
    assert.match(p.stdout, /^blocked identity {12}sc-platform-entra approvers \(approvals\.platformTeam\) {2}\(approvals\.platformTeam\.displayName is needed/m);
    assert.equal(lines(p.stdout, "create").filter((l) => l.includes("service-connection")).length, 3);
  });

  it("sets the project's Contributors to Reader on environments (ADO-20: no environment created on first use)", async () => {
    const contributors = fake.state.envRoles.find((a: J) => a.identity.displayName === "[Platform]\\Contributors");
    contributors.role = { ...contributors.role, name: "User", displayName: "User" };
    const p = await bs("plan", "connections");
    assert.match(p.stdout, /^update {2}environment-role {4}\[Platform\]\\Contributors on environments {2}\(User -> Reader \(no environment auto-creation, ADO-20\)\)$/m);
    fake.requests = [];
    await bs("apply", "connections");
    const put = writes().find((w) => w.method === "PUT" && w.path.includes("distributedtask.globalenvironmentreferencerole"))!;
    assert.deepEqual(put.body, [{ userId: contributors.identity.id, roleName: "Reader" }]);
    const again = await bs("plan", "connections");
    assert.match(again.stdout, /^ok {6}environment-role {4}\[Platform\]\\Contributors on environments {2}\(Reader\)$/m);
  });

  it("blocks sc-platform-entra when the host environment's outputs have no Entra identity (older core); the others go on", async () => {
    const legacy = join(tmp(), "prod-legacy.json");
    writeFileSync(legacy, JSON.stringify(outputs("prod", ID.provProd, true, true)));
    const output = join(tmp(), "out.json");
    const r = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "connections", "--identities", `nonprod=${ids.nonprod}`, "--identities", `prod=${legacy}`, "--output", output]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^blocked service-connection {2}sc-platform-entra {2}\(the bootstrap outputs of prod \(portal\.hostEnvironment\) have no entraProvisioningIdentity/m);
    assert.ok(!r.stdout.includes("sc-platform-entra approvers"), "no approver lookup for a connection that can't be created");
    const scs = writes().filter((w) => w.path === "/contoso/_apis/serviceendpoint/endpoints").map((w) => (w.body as J).name);
    assert.deepEqual(scs, ["sc-platform-provisioning-nonprod", "sc-platform-provisioning-prod", "sc-platform-ado"]);
    const out = JSON.parse(readFileSync(output, "utf8")) as J;
    assert.equal(out.federation.prod.entra, null);
    assert.ok(out.federation.prod.adoAutomation.subject);
  });

  it("refuses outputs of another subscription, missing identities and a platform-config branch mismatch", async () => {
    const other = join(tmp(), "other.json");
    writeFileSync(other, JSON.stringify({ ...outputs("nonprod", ID.provNonprod, false), subscriptionId: { type: "String", value: "00000000-0000-0000-0000-00000000a999" } }));
    const r = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "connections", "--identities", `nonprod=${other}`, "--identities", `prod=${ids.prod}`]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^blocked service-connection {2}sc-platform-provisioning-nonprod {2}\(the bootstrap outputs of nonprod are for tenant .* subscription 00000000-0000-0000-0000-00000000a999/m);

    const one = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "connections", "--identities", `prod=${ids.prod}`]);
    assert.equal(one.code, 2);
    assert.match(one.stderr, /--phase connections needs --identities for nonprod/);

    const doc = parse(readFileSync(instance, "utf8")) as J;
    doc.scm.azureDevOps.platformConfigDefaultBranch = "release";
    const inst2 = join(tmp(), "instance.yaml");
    writeFileSync(inst2, stringify(doc));
    fake.requests = [];
    const branch = await bs("plan", "connections", [], inst2);
    assert.equal(branch.code, 1);
    assert.match(branch.stderr, /platform-config's default branch is refs\/heads\/main, but instance\.yaml says refs\/heads\/release/);
    assert.deepEqual(writes(), []);

    const noAdo = join(tmp(), "prod-noado.json");
    writeFileSync(noAdo, JSON.stringify(outputs("prod", ID.provProd, false)));
    const r2 = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "connections", "--identities", `nonprod=${ids.nonprod}`, "--identities", `prod=${noAdo}`]);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /have no adoAutomationIdentity \(instanceIdentities must be true there\)/);
  });
});

describe("platform ado bootstrap --phase pipeline", () => {
  beforeEach(() => fake.reset("configured"));

  it("creates \\platform\\provisioning, \\platform\\validation and \\platform\\platform-<env>, previews and re-saves them, authorises each connection and environment exclusively, opens the core repo, leaves queueing open", async () => {
    await bs("apply", "connections");
    fake.requests = [];
    const a = await bs("apply", "pipeline");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const created = writes().filter((w) => w.path === "/contoso/Platform/_apis/pipelines").map((w) => w.body as J);
    const yaml = (name: string, path: string): J => ({ name, folder: "\\platform", configuration: { type: "yaml", path, repository: { id: CONFIG_REPO, type: "azureReposGit" } } });
    assert.deepEqual(created, [
      yaml("provisioning", "pipelines/provisioning.yml"),
      yaml("validation", "pipelines/validation.yml"),
      yaml("platform-nonprod", "pipelines/platform-nonprod.yml"),
      yaml("platform-prod", "pipelines/platform-prod.yml"),
    ]);
    const id = a.out!.pipeline.id as number;
    const vid = a.out!.validationPipeline.id as number;
    const pn = a.out!.platformPipelines.nonprod.id as number;
    const pp = a.out!.platformPipelines.prod.id as number;
    assert.deepEqual(a.out!.pipeline, { id, name: "provisioning", folder: "\\platform" });
    assert.deepEqual(a.out!.validationPipeline, { id: vid, name: "validation", folder: "\\platform" });
    assert.deepEqual(a.out!.platformPipelines, { nonprod: { id: pn, name: "platform-nonprod", folder: "\\platform" }, prod: { id: pp, name: "platform-prod", folder: "\\platform" } });
    const order = writes().map((w) => `${w.method} ${w.path}`).filter((x) => x.includes(`/${id}`) || x.includes(`/${vid}`) || x.endsWith("/_apis/pipelines"));
    assert.deepEqual(order.slice(0, 6), [
      "POST /contoso/Platform/_apis/pipelines",
      `POST /contoso/Platform/_apis/pipelines/${id}/preview`,
      `PUT /contoso/Platform/_apis/build/definitions/${id}`,
      "POST /contoso/Platform/_apis/pipelines",
      `POST /contoso/Platform/_apis/pipelines/${vid}/preview`,
      `PUT /contoso/Platform/_apis/build/definitions/${vid}`,
    ]);
    assert.match(a.stdout, /^create {2}pipeline {12}\\platform\\validation {2}\(pipelines\/validation\.yml in platform-config\) {2}\[done\]$/m);
    assert.match(a.stdout, /^create {2}pipeline {12}\\platform\\platform-prod {2}\(pipelines\/platform-prod\.yml in platform-config\) {2}\[done\]$/m);
    const perms = writes().filter((w) => w.path.includes("/pipelinepermissions/"));
    assert.equal(perms.length, 7);
    const scIds = ["sc-platform-provisioning-nonprod", "sc-platform-provisioning-prod", "sc-platform-ado", "sc-platform-entra"].map((n) => fake.state.endpoints.find((e: J) => e.name === n).id);
    const envIds = a.out!.platformEnvironments ?? {};
    assert.deepEqual(envIds, {}, "the pipeline phase doesn't write environments");
    const envId = (name: string): string => String(fake.state.environments.find((e: J) => e.name === name).id);
    assert.deepEqual(perms.slice(0, 6).map((w) => w.path.split("/").slice(-2).join("/")), [
      `endpoint/${scIds[0]}`,
      `endpoint/${scIds[1]}`,
      `environment/${envId("platform-nonprod")}`,
      `environment/${envId("platform-prod")}`,
      `endpoint/${scIds[2]}`,
      `endpoint/${scIds[3]}`,
    ]);
    // ADR-0043: a provisioning connection serves provisioning and its environment's platform
    // pipeline; platform-{env} only that platform pipeline; ado and entra provisioning only.
    const body = (ids: number[]): J => ({ allPipelines: { authorized: false }, pipelines: ids.map((x) => ({ id: x, authorized: true })) });
    assert.deepEqual(perms.slice(0, 6).map((w) => w.body), [body([id, pn]), body([id, pp]), body([pn]), body([pp]), body([id]), body([id])]);
    assert.ok(!JSON.stringify(Object.values(fake.state.permissions)).includes(`"id":${vid}`), "\\platform\\validation is authorised on nothing");
    assert.deepEqual(fake.state.permissions[`endpoint/${scIds[3]}`].pipelines, [{ id, authorized: true }], "sc-platform-entra: the provisioning pipeline only");
    assert.match(perms[6]!.path, new RegExp(`repository/${PLATFORM_ID}\\.`));
    assert.deepEqual(perms[6]!.body, { allPipelines: { authorized: true }, pipelines: [] }, "core repo: open to all pipelines of the platform project");
    assert.ok(!writes().some((w) => w.path.includes("33344d9c")), "no queueing deny on \\platform");
    assert.match(a.stdout, /^ok {6}queue-acl {11}\\platform: no queueing deny for Contributors$/m);

    // A deny left by an earlier core version is removed (other bits kept).
    const contributors = fake.state.identities[1].descriptor;
    fake.state.acls[`${PLATFORM_ID}/platform`] = { token: `${PLATFORM_ID}/platform`, inheritPermissions: true, acesDictionary: { [contributors]: { descriptor: contributors, allow: 1, deny: 128 | 8 } } };
    fake.requests = [];
    const fix = await bs("apply", "pipeline");
    assert.equal(fix.code, 0, fix.stdout);
    const ace = writes().find((w) => w.path.includes("33344d9c"))!.body as J;
    assert.equal(ace.token, `${PLATFORM_ID}/platform`);
    assert.equal(ace.merge, false);
    assert.deepEqual([ace.accessControlEntries[0].allow, ace.accessControlEntries[0].deny], [1, 8]);

    fake.requests = [];
    const again = await bs("apply", "pipeline");
    assert.equal(again.code, 0);
    assert.deepEqual(writes().map((w) => w.path), [id, vid, pn, pp].map((x) => `/contoso/Platform/_apis/pipelines/${x}/preview`), "a re-run only previews");
  });

  it("does not authorise a platform environment without its Approval check (ADR-0043); a foreign pipeline on it is revoked", async () => {
    await bs("apply", "connections");
    const first = await bs("apply", "pipeline");
    const id = first.out!.pipeline.id as number;
    const pp = first.out!.platformPipelines.prod.id as number;
    const env = fake.state.environments.find((e: J) => e.name === "platform-prod");
    fake.state.permissions[`environment/${env.id}`].pipelines.push({ id: 42, authorized: true });
    const extra = await bs("plan", "pipeline");
    assert.match(extra.stdout, /^extra {3}pipeline-permission environment platform-prod {2}\(revoke pipelines 42\)$/m);
    const isApproval = (c: J): boolean => c.resource.type === "environment" && String(c.resource.id) === String(env.id) && c.type.name === "Approval";
    fake.state.checks = fake.state.checks.filter((c: J) => !isApproval(c));
    fake.requests = [];
    const r = await bs("apply", "pipeline");
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^blocked pipeline-permission environment platform-prod {2}\(it has no Approval check with an approver and requesterCannotBeApprover, so \\platform\\platform-prod may use neither it nor sc-platform-provisioning-prod: run --phase connections first \(ADR-0043\)\.\)$/m);
    const revoke = writes().find((w) => w.method === "PATCH" && w.path.endsWith(`/environment/${env.id}`))!.body as J;
    assert.deepEqual(revoke.allPipelines, { authorized: false });
    assert.ok(revoke.pipelines.every((x: J) => x.authorized === false), JSON.stringify(revoke));
    // The connection has no Approval of its own: the platform pipeline loses it too, provisioning keeps it.
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-provisioning-prod");
    assert.match(r.stdout, new RegExp(`^extra {3}pipeline-permission endpoint sc-platform-provisioning-prod {2}\\(revoke pipelines ${pp}\\) {2}\\[done\\]$`, "m"));
    assert.deepEqual(fake.state.permissions[`endpoint/${sc.id}`].pipelines, [
      { id, authorized: true },
      { id: pp, authorized: false },
    ]);
    const nonprod = fake.state.endpoints.find((e: J) => e.name === "sc-platform-provisioning-nonprod");
    assert.equal(fake.state.permissions[`endpoint/${nonprod.id}`].pipelines.filter((x: J) => x.authorized).length, 2, "the other environment is unaffected");
  });

  it("onboarding with the approvers unresolved: provisioning gets its connections, the platform pipelines get no connection or environment (ADR-0043)", async () => {
    fake.state.identities = fake.state.identities.filter((i: J) => i.id !== GROUP_ID);
    assert.equal((await bs("apply", "connections")).code, 1);
    assert.deepEqual(fake.state.environments.filter((e: J) => /^platform-/.test(e.name)), [], "no platform environment without its Approval");
    fake.requests = [];
    const r = await bs("apply", "pipeline");
    assert.equal(r.code, 1, r.stdout);
    const id = r.out!.pipeline.id as number;
    for (const env of ["nonprod", "prod"]) {
      assert.match(r.stdout, new RegExp(`^blocked pipeline-permission environment platform-${env} {2}\\(it does not exist, so \\\\platform\\\\platform-${env} may use neither it nor sc-platform-provisioning-${env}: run --phase connections first \\(ADR-0043\\)\\.\\)$`, "m"));
      const sc = fake.state.endpoints.find((e: J) => e.name === `sc-platform-provisioning-${env}`);
      assert.deepEqual(fake.state.permissions[`endpoint/${sc.id}`].pipelines, [{ id, authorized: true }], `sc-platform-provisioning-${env}: provisioning only`);
    }
    assert.ok(!writes().some((w) => w.path.includes("/pipelinepermissions/environment/")), "no environment authorised");
  });

  it("before platform generate: the platform pipelines can't be created, provisioning is still authorised", async () => {
    await bs("apply", "connections");
    fake.missingYaml = ["pipelines/platform-nonprod.yml", "pipelines/platform-prod.yml"];
    fake.requests = [];
    const r = await bs("apply", "pipeline");
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^create {2}pipeline {12}\\platform\\platform-nonprod {2}\(pipelines\/platform-nonprod\.yml in platform-config\) {2}\[.*not found/m);
    assert.deepEqual(r.out!.platformPipelines, { nonprod: null, prod: null });
    const id = r.out!.pipeline.id as number;
    for (const env of ["nonprod", "prod"]) {
      const sc = fake.state.endpoints.find((e: J) => e.name === `sc-platform-provisioning-${env}`);
      assert.deepEqual(fake.state.permissions[`endpoint/${sc.id}`].pipelines, [{ id, authorized: true }], `sc-platform-provisioning-${env}: provisioning authorised`);
      assert.match(r.stdout, new RegExp(`^blocked pipeline-permission environment platform-${env} {2}\\(\\\\platform\\\\platform-${env} does not exist \\(see its row above\\): run platform generate, commit pipelines/platform-${env}\\.yml, then run --phase pipeline again\\.\\)$`, "m"));
    }
    assert.ok(!writes().some((w) => w.path.includes("/pipelinepermissions/environment/")), "no environment authorised");

    // Once generated, the next run creates and authorises them.
    fake.missingYaml = [];
    const again = await bs("apply", "pipeline");
    assert.equal(again.code, 0, again.stdout);
    const pn = again.out!.platformPipelines.nonprod.id as number;
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-provisioning-nonprod");
    assert.deepEqual(fake.state.permissions[`endpoint/${sc.id}`].pipelines, [{ id, authorized: true }, { id: pn, authorized: true }]);
  });

  it("revokes other pipelines on a platform connection; blocked before the connections exist", async () => {
    const before = await bs("plan", "pipeline");
    assert.equal(before.code, 1);
    assert.match(before.stdout, /^blocked pipeline-permission endpoint sc-platform-ado {2}\(sc-platform-ado does not exist \(run --phase connections first\)\.\)$/m);
    assert.match(before.stdout, /^blocked pipeline-permission endpoint sc-platform-entra {2}\(sc-platform-entra does not exist \(run --phase connections first\)\.\)$/m);
    await bs("apply", "connections");
    await bs("apply", "pipeline");
    for (const name of ["sc-platform-ado", "sc-platform-entra"]) {
      const sc = fake.state.endpoints.find((e: J) => e.name === name);
      fake.state.permissions[`endpoint/${sc.id}`].pipelines.push({ id: 42, authorized: true });
      fake.state.permissions[`endpoint/${sc.id}`].allPipelines = { authorized: true };
    }
    const r = await bs("plan", "pipeline");
    assert.match(r.stdout, /^extra {3}pipeline-permission endpoint sc-platform-ado {2}\(close access for all pipelines, revoke pipelines 42\)$/m);
    assert.match(r.stdout, /^extra {3}pipeline-permission endpoint sc-platform-entra {2}\(close access for all pipelines, revoke pipelines 42\)$/m);
  });

  it("does not authorise sc-platform-entra without its Approval check (ADR-0033)", async () => {
    await bs("apply", "connections");
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    const isApproval = (c: J): boolean => c.resource.type === "endpoint" && String(c.resource.id) === String(sc.id) && c.type.name === "Approval";
    assert.equal(fake.state.checks.filter(isApproval).length, 1);
    fake.state.checks = fake.state.checks.filter((c: J) => !isApproval(c));
    fake.requests = [];
    const a = await bs("apply", "pipeline");
    assert.equal(a.code, 1, a.stdout);
    assert.match(a.stdout, /^blocked pipeline-permission endpoint sc-platform-entra {2}\(it has no Approval check with an approver and requesterCannotBeApprover: run --phase connections first \(ADR-0033\)\.\)$/m);
    assert.ok(!writes().some((w) => w.path.endsWith(`/endpoint/${sc.id}`)), "no permission written for it");
    assert.equal(writes().filter((w) => w.path.includes("/pipelinepermissions/endpoint/")).length, 3, "the other connections are authorised");

    await bs("apply", "connections");
    fake.requests = [];
    assert.equal((await bs("apply", "pipeline")).code, 0);
    assert.ok(writes().some((w) => w.path.endsWith(`/endpoint/${sc.id}`)), "authorised once the check is back");

    // Authorised, then its Approval check is removed by hand: the authorisation is withdrawn.
    fake.state.checks = fake.state.checks.filter((c: J) => !isApproval(c));
    const p = await bs("plan", "pipeline");
    assert.match(p.stdout, /^extra {3}pipeline-permission endpoint sc-platform-entra {2}\(revoke pipelines \d+: it has no Approval check\)$/m);
    fake.requests = [];
    const r = await bs("apply", "pipeline");
    assert.equal(r.code, 1, r.stdout);
    const revoke = writes().find((w) => w.method === "PATCH" && w.path.endsWith(`/endpoint/${sc.id}`))!.body as J;
    assert.deepEqual(revoke.allPipelines, { authorized: false });
    assert.ok(revoke.pipelines.length > 0 && revoke.pipelines.every((x: J) => x.authorized === false), JSON.stringify(revoke));
  });
});

describe("approvals.entraChanges pullRequest: the reviewed pull request is the Entra approval (ADR-0051)", () => {
  beforeEach(() => fake.reset("configured"));
  const GATE = /^(\w+) +policy +sc-platform-entra: approval by pull request review \(approvals\.entraChanges: pullRequest\) {2}\((.*)\)$/m;
  const entraChecks = (): string[] => {
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    return fake.state.checks.filter((c: J) => c.resource.type === "endpoint" && String(c.resource.id) === String(sc?.id)).map((c: J) => c.type.name as string);
  };

  it("without the platform team's required review on main: blocked, and sc-platform-entra keeps (gets) its Approval check", async () => {
    const r = await bs("plan", "connections", [], prInstance);
    assert.equal(r.code, 1, r.stdout);
    const gate = GATE.exec(r.stdout)!;
    assert.equal(gate[1], "blocked");
    assert.match(gate[2]!, /^approvals\.entraChanges is pullRequest, but platform-config refs\/heads\/main has no enabled, required reviewer policy with the platform team \(approvals\.platformTeam\) for every file in which the creator's vote doesn't count: run --phase policies, then --phase connections again \(or set approvals\.entraChanges: separate\)\. Until then sc-platform-entra keeps its Approval check\.$/);
    assert.ok(lines(r.stdout, "create").some((l) => /check +sc-platform-entra: Approval/.test(l)), "the fallback Approval check is planned");
    assert.deepEqual(writes(), []);
  });

  it("onboarding: Approval until the policy exists, then removed; the pipeline phase accepts the policy; a weakened policy brings the check back and withdraws the authorisation", async () => {
    assert.equal((await bs("apply", "connections", [], prInstance)).code, 1);
    assert.ok(entraChecks().includes("Approval"), "created with its Approval check while the policy is missing");
    const pipe = await bs("apply", "pipeline", [], prInstance);
    assert.equal(pipe.code, 0, pipe.stdout);
    assert.doesNotMatch(pipe.stdout, GATE, "the Approval check is enough; the policy isn't asked for");
    assert.equal((await bs("apply", "policies", [], prInstance)).code, 0);

    const plan = await bs("plan", "connections", [], prInstance);
    assert.equal(plan.code, 0, plan.stdout);
    const gate = GATE.exec(plan.stdout)!;
    assert.equal(gate[1], "ok");
    assert.match(gate[2]!, /^platform-config refs\/heads\/main: required reviewer policy \d+ with the platform team on every pull request; sc-platform-entra needs no Approval check of its own$/);
    assert.match(plan.stdout, /^extra {3}check {15}sc-platform-entra: Approval \(id \d+\) {2}\(remove: approvals\.entraChanges is pullRequest: the reviewed platform-config pull request is the approval \(ADR-0051\)\)$/m);
    assert.doesNotMatch(plan.stdout, /self-approval/);

    fake.requests = [];
    const a = await bs("apply", "connections", [], prInstance);
    assert.equal(a.code, 0, a.stdout);
    assert.deepEqual(writes().map((w) => w.method), ["DELETE"]);
    assert.ok(!entraChecks().includes("Approval"));
    assert.equal(entraChecks().length, 3, "Required template, Branch control and Exclusive lock stay");
    const again = await bs("plan", "connections", [], prInstance);
    assert.equal(again.code, 0, again.stdout);
    assert.deepEqual([...lines(again.stdout, "extra"), ...lines(again.stdout, "create"), ...lines(again.stdout, "update")], []);

    // --phase pipeline: no Approval check, the policy is the guard.
    const p = await bs("plan", "pipeline", [], prInstance);
    assert.equal(p.code, 0, p.stdout);
    assert.equal(/^(\w+) +policy +endpoint sc-platform-entra: approval by pull request review/m.exec(p.stdout)?.[1], "ok");

    // Someone makes the review optional: --phase connections plans the Approval check again,
    // --phase pipeline withdraws the authorisation.
    const policy = fake.state.policies.find((c: J) => c.settings.requiredReviewerIds && !c.settings.filenamePatterns);
    policy.isBlocking = false;
    const back = await bs("plan", "connections", [], prInstance);
    assert.equal(back.code, 1);
    assert.equal(GATE.exec(back.stdout)![1], "blocked");
    assert.ok(lines(back.stdout, "create").some((l) => /check +sc-platform-entra: Approval/.test(l)));
    fake.requests = [];
    const w = await bs("apply", "pipeline", [], prInstance);
    assert.equal(w.code, 1, w.stdout);
    assert.match(w.stdout, /^blocked pipeline-permission endpoint sc-platform-entra {2}\(it has neither an Approval check nor the platform team's required review of platform-config: run --phase policies, or --phase connections \(ADR-0051\)\.\)$/m);
    const sc = fake.state.endpoints.find((e: J) => e.name === "sc-platform-entra");
    assert.deepEqual((writes().find((x) => x.method === "PATCH" && x.path.endsWith(`/endpoint/${sc.id}`))!.body as J).allPipelines, { authorized: false });
  });

  it("separate keeps today's Approval check, also when the policy exists", async () => {
    await bs("apply", "connections");
    await bs("apply", "pipeline");
    await bs("apply", "policies");
    const r = await bs("plan", "connections");
    assert.equal(r.code, 0, r.stdout);
    assert.doesNotMatch(r.stdout, GATE);
    assert.ok(lines(r.stdout, "ok").some((l) => /check +sc-platform-entra: Approval/.test(l)));
  });

  it("isPlatformTeamReview: enabled, required, exact scope, the team, every file, the creator's vote only with self-approval", () => {
    const base = { isEnabled: true, isBlocking: true, type: { id: "fd2167ab-b0be-447a-8ec8-39368250530e" }, settings: { requiredReviewerIds: [GROUP_ID], creatorVoteCounts: false, scope: [{ repositoryId: CONFIG_REPO, refName: "refs/heads/main", matchKind: "exact" }] } };
    const ok = (c: J, self = false) => isPlatformTeamReview(c, CONFIG_REPO, "refs/heads/main", GROUP_ID, self);
    assert.equal(ok(base), true);
    assert.equal(ok({ ...base, isBlocking: false }), false);
    assert.equal(ok({ ...base, isEnabled: false }), false);
    assert.equal(ok({ ...base, isDeleted: true }), false);
    assert.equal(ok({ ...base, type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" } }), false);
    assert.equal(ok({ ...base, settings: { ...base.settings, filenamePatterns: ["/pipelines/*"] } }), false);
    assert.equal(ok({ ...base, settings: { ...base.settings, requiredReviewerIds: ["00000000-0000-0000-0000-0000000000ff"] } }), false);
    assert.equal(ok({ ...base, settings: { ...base.settings, scope: [{ repositoryId: CONFIG_REPO, refName: "refs/heads/dev", matchKind: "exact" }] } }), false);
    assert.equal(ok({ ...base, settings: { ...base.settings, creatorVoteCounts: true } }), false);
    assert.equal(ok({ ...base, settings: { ...base.settings, creatorVoteCounts: true } }, true), true);
  });
});

describe("platform ado bootstrap --phase grants (ADO-1)", () => {
  beforeEach(() => fake.reset("configured"));

  it("adds the automation identity with Basic, then its roles and ACEs (bits read from the namespaces); Create repository in the apps project only", async () => {
    const p = await bs("plan", "grants");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.deepEqual(writes(), []);
    assert.match(p.stdout, /^create {2}org-user {12}id-contoso-ado-automation \(Basic\)/m);
    assert.equal(lines(p.stdout, "create").filter((l) => l.includes("after the identity is added to the organization")).length, 10);
    assert.match(p.stdout, /^create {2}project-admin {7}Apps: id-contoso-ado-automation is a Project Administrator \(ADR-0039 H2\) {2}\(after the identity is added to the organization\)$/m);
    assert.doesNotMatch(p.stdout, /project-admin +Platform:/, "never of the platform project");
    assert.match(p.stdout, /^create {2}queue-role {10}agent queue Azure Pipelines: id-contoso-ado-automation is User/m);
    assert.match(p.stdout, /^create {2}repo-acl {12}Apps \(all repos\): id-contoso-ado-automation may read, manage permissions and create repositories {2}\(allow 8450, after the identity is added to the organization\)$/m);
    assert.ok(fake.requests.some((q) => q.path === "/contoso/_apis/securitynamespaces/33344d9c-fc72-4d6f-aba5-fa317101a7e9"));

    const a = await bs("apply", "grants");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const ent = writes().find((w) => w.path.startsWith("/vsaex/"))!;
    assert.deepEqual(ent.body, { accessLevel: { accountLicenseType: "express", licensingSource: "account" }, servicePrincipal: { origin: "aad", originId: AUTOMATION_OID, subjectKind: "servicePrincipal" } });
    const who = a.out!.identity;
    assert.equal(who.originId, AUTOMATION_OID);
    const roles = writes().filter((w) => w.path.includes("/roleassignments/"));
    assert.deepEqual(roles.map((w) => [w.path.split("/")[5], w.path.split("/").pop(), w.body]), [
      ["distributedtask.project.serviceendpointrole", PLATFORM_ID, [{ userId: who.id, roleName: "Creator" }]],
      ["distributedtask.globalenvironmentreferencerole", PLATFORM_ID, [{ userId: who.id, roleName: "Creator" }]],
      ["distributedtask.agentqueuerole", `${PLATFORM_ID}_140`, [{ userId: who.id, roleName: "User" }]],
    ]);
    const aces = writes().filter((w) => w.path.startsWith("/contoso/_apis/accesscontrolentries/")).map((w) => w.body as J);
    assert.ok(aces.every((x) => x.merge === true && x.accessControlEntries[0].descriptor === who.descriptor && x.accessControlEntries[0].deny === 0));
    assert.deepEqual(aces.map((x) => [x.token, x.accessControlEntries[0].allow]), [
      // DeleteBuildDefinition (4096): the delete phase of a decommissioned app removes its pipeline (ADR-0056).
      [`${PLATFORM_ID}/apps`, 1 | 1024 | 2048 | 32768 | 4096 | 16384 | 128],
      [`repoV2/${APPS_ID}`, 2 | 8192 | 256],
      [`repoV2/${PLATFORM_ID}/00000000-0000-0000-0000-0000000000b2`, 2 | 8192],
      [`repoV2/${PLATFORM_ID}/00000000-0000-0000-0000-0000000000b3`, 2],
      [`$PROJECT:vstfs:///Classification/TeamProject/${PLATFORM_ID}`, 1],
      [`$PROJECT:vstfs:///Classification/TeamProject/${APPS_ID}`, 1],
    ]);

    const member = writes().filter((w) => w.path.includes("/_apis/graph/memberships/"));
    assert.deepEqual(member.map((w) => [w.method, w.path.split("/").slice(-2).join("|")]), [["PUT", `${fake.state.graphSps[0].descriptor}|vssgp.admins-${APPS_ID}`]]);

    fake.requests = [];
    const again = await bs("plan", "grants");
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update")), [], again.stdout);
    assert.match(again.stdout, /^ok {6}org-user .*Basic\)$/m);
    assert.match(again.stdout, /^ok {6}project-admin {7}Apps: .* \(member\)$/m);
  });

  it("adopts an app's existing service connections and environments (Administrator on each, nothing project-wide)", async () => {
    const dir = tmp("pc-adobs-adopt-");
    const inst = join(dir, "instance.yaml");
    writeFileSync(inst, readFileSync(instance, "utf8"));
    mkdirSync(join(dir, "apps", "demo"), { recursive: true });
    writeFileSync(join(dir, "apps", "demo", "app.yaml"), readFileSync(join(P, "apps", "demo", "app.yaml"), "utf8"));
    // The archive of deleted apps (ADR-0061) is never adopted: only apps/ lists the apps.
    mkdirSync(join(dir, "apps-deleted", "olddemo", "2026-01-05"), { recursive: true });
    writeFileSync(join(dir, "apps-deleted", "olddemo", "2026-01-05", "app.yaml"), readFileSync(join(P, "apps", "demo", "app.yaml"), "utf8").replace(/^slug: demo$/m, "slug: olddemo"));
    await bs("apply", "grants");
    const p = await bs("plan", "grants", [], inst);
    assert.equal(p.code, 0, p.stdout + p.stderr);
    const adopt = lines(p.stdout, "create").filter((l) => l.includes(" adopt "));
    assert.deepEqual(adopt.map((l) => l.replace(/ +/g, " ").replace(/ \(allow \d+\)$/, "")), [
      "create adopt sc-demo-nonprod: id-contoso-ado-automation is Administrator",
      "create adopt sc-demo-nonprod: id-contoso-ado-automation may administer it (organization level)",
      "create adopt demo-nonprod: id-contoso-ado-automation is Administrator",
      "create adopt sc-demo-prod: id-contoso-ado-automation is Administrator",
      "create adopt sc-demo-prod: id-contoso-ado-automation may administer it (organization level)",
      "create adopt demo-prod: id-contoso-ado-automation is Administrator",
    ]);
    fake.requests = [];
    const a = await bs("apply", "grants", [], inst);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    const puts = writes().filter((w) => w.path.includes("/roleassignments/resources/") && w.path.includes("_"));
    assert.deepEqual(puts.map((w) => w.path.split("/")[5]), ["distributedtask.serviceendpointrole", "distributedtask.environmentreferencerole", "distributedtask.serviceendpointrole", "distributedtask.environmentreferencerole"]);
    assert.ok(puts.every((w) => w.path.split("/").pop()!.startsWith(`${PLATFORM_ID}_`)));
    assert.ok(puts.every((w) => JSON.stringify(w.body) === JSON.stringify([{ userId: a.out!.identity.id, roleName: "Administrator" }])));
    const ace = writes().filter((w) => w.path === "/contoso/_apis/accesscontrolentries/49b48001-ca20-4adc-8111-5b60c903a50c").map((w) => w.body as J);
    assert.deepEqual(ace.map((x) => [x.token.split("/").slice(0, 2).join("/"), x.accessControlEntries[0].allow, x.merge]), [["endpoints/Collection", 2, true], ["endpoints/Collection", 2, true]]);
    const again = await bs("plan", "grants", [], inst);
    assert.equal(lines(again.stdout, "ok").filter((l) => l.includes(" adopt ")).length, 6, again.stdout);
  });

  it("blocks a lower access level and an unknown action name", async () => {
    await bs("apply", "grants");
    for (const e of Object.values(fake.state.entitlements) as J[]) e.accessLevel.accountLicenseType = "stakeholder";
    fake.state.security.namespaces["2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87"].value[0].actions = fake.state.security.namespaces["2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87"].value[0].actions.filter((x: J) => x.name !== "ManagePermissions");
    const r = await bs("plan", "grants");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^blocked org-user .*access level stakeholder; set Basic by hand/m);
    assert.match(r.stdout, /^blocked namespace {11}Git Repositories {2}\(no action ManagePermissions in security namespace/m);
  });

  it("checks organization, phase and identities before calling anything", async () => {
    assert.equal((await run(["plan", "--instance", instance, "--org-url", "https://dev.azure.com/fabrikam", "--phase", "grants", "--identities", `prod=${ids.prod}`])).code, 1);
    assert.equal((await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "grants"])).code, 2);
    assert.equal((await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "users", "--identities", `prod=${ids.prod}`])).code, 2);
    assert.equal((await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "policies", "--resave"])).code, 2);
    assert.equal((await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "grants", "--identities", `qa=${ids.prod}`])).code, 1);
    assert.equal((await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "grants", "--resave", "--identities", `prod=${ids.prod}`])).code, 2);
    assert.equal((await run(["delete", "--instance", instance])).code, 2);
    assert.equal(fake.requests.length, 0);
  });
});

describe("platform ado bootstrap --phase grants: the portal identity (ADR-0036, ADR-0040)", () => {
  beforeEach(() => fake.reset("configured"));
  const CONFIG_TOKEN = `repoV2/${PLATFORM_ID}/${CONFIG_REPO}`;
  // refs/heads/portal/requests/: each name part hex-encoded UTF-16LE.
  const FOLDER_TOKEN = `${CONFIG_TOKEN}/refs/heads/70006f007200740061006c00/72006500710075006500730074007300/`;
  const MAIN_TOKEN = `${CONFIG_TOKEN}/refs/heads/6d00610069006e00/`;
  const GIT_ACES = "/contoso/_apis/accesscontrolentries/2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
  const PROJECT_ACES = "/contoso/_apis/accesscontrolentries/52d39943-cb85-4d7f-8fa8-c6baac873819";
  const PROJECT_TOKEN = `$PROJECT:vstfs:///Classification/TeamProject/${PLATFORM_ID}`;
  const BUILD_ACES = "/contoso/_apis/accesscontrolentries/33344d9c-fc72-4d6f-aba5-fa317101a7e9";
  const APPS_TOKEN = `${PLATFORM_ID}/apps`;
  const PLATFORM_TOKEN = `${PLATFORM_ID}/platform`;

  async function grants(action: "plan" | "apply", prod = ids.prodPortal) {
    const output = join(tmp(), "out.json");
    const r = await run([action, "--instance", instance, "--org-url", fake.orgUrl, "--phase", "grants", "--identities", `prod=${prod}`, "--output", output]);
    return { ...r, out: JSON.parse(readFileSync(output, "utf8")) as J };
  }
  const writesFor = (needle: string) => writes().filter((w) => JSON.stringify(w.body ?? null).includes(needle));

  it("the folder token is the hex-encoded UTF-16LE form of portal/requests", () => {
    assert.equal(branchTokenOf(PLATFORM_ID, CONFIG_REPO, "portal/requests"), FOLDER_TOKEN);
    assert.equal(branchTokenOf(PLATFORM_ID, CONFIG_REPO, "refs/heads/main"), MAIN_TOKEN);
  });

  it("outputs of an older core (no portalIdentity): a warn row, nothing for the portal", async () => {
    const r = await grants("plan", ids.prod);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^warn {4}identity {12}portal identity: pull requests on Platform\/platform-config, View builds on \\apps and \\platform, Queue builds on \\apps {2}\(the bootstrap outputs of prod \(portal\.hostEnvironment\) have no portalIdentity: re-run bootstrap\.bicep/m);
    assert.equal(r.out.portalIdentity, null);
  });

  it("not in the organization yet: one blocked row, the rest of the phase goes on, the CLI never adds it", async () => {
    const p = await grants("plan");
    assert.equal(p.code, 1, p.stdout + p.stderr);
    assert.deepEqual(writes(), []);
    assert.deepEqual(lines(p.stdout, "blocked").map((l) => l.replace(/ +/g, " ")), [
      "blocked org-user id-contoso-portal (not in the organization yet: an organization administrator must add id-contoso-portal first (Organization settings > Users, access level Basic; ADR-0036), then run --phase grants again.)",
    ]);
    assert.match(p.stdout, /^create {2}org-user {12}id-contoso-ado-automation \(Basic\)/m);

    const a = await grants("apply");
    assert.equal(a.code, 1, a.stdout);
    assert.ok(!a.stdout.includes("FAILED"), a.stdout);
    const added = writes().filter((w) => w.path.startsWith("/vsaex/")).map((w) => (w.body as J).servicePrincipal.originId);
    assert.deepEqual(added, [AUTOMATION_OID], "only the automation identity is added to the organization");
    assert.deepEqual(writesFor(PORTAL_OID), []);
    assert.ok(a.out.identity, "the automation identity's grants were applied");
    assert.equal(a.out.portalIdentity, null);
  });

  it("in the organization: Read + Contribute to pull requests on platform-config, Create branch + Contribute below portal/requests/, View builds on \\apps and \\platform, Queue builds on \\apps, nothing else; a re-run changes nothing", async () => {
    const portal = fake.addPortalIdentity();
    const p = await grants("plan");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.deepEqual(writes(), []);
    assert.match(p.stdout, new RegExp(`^ok {6}org-user {12}id-contoso-portal \\(in the organization\\) {2}\\(${portal.id}, Basic\\)$`, "m"));
    assert.match(p.stdout, /^create {2}project-acl {9}Platform: id-contoso-portal may view the project \(View project-level information\) {2}\(allow 1\)$/m);
    assert.match(p.stdout, /^create {2}repo-acl {12}Platform\/platform-config: id-contoso-portal may read and contribute to pull requests \(only these\) {2}\(allow 16386\)$/m);
    assert.match(p.stdout, /^create {2}branch-acl {10}Platform\/platform-config portal\/requests\/: id-contoso-portal may create branches and push there \(only these\) {2}\(allow 20\)$/m);
    assert.match(p.stdout, /^ok {6}repo-acl {12}Platform \(all repos\), the organization \(all repos\) and Platform\/platform-config refs\/heads\/main: id-contoso-portal has no Git permission$/m);
    assert.match(p.stdout, /^warn {4}repo-setting {8}Platform\/platform-config: Permissions management off \(a branch creator gets no Manage permissions\) {2}\(check it: Project settings > Repositories > platform-config > Settings > Permissions management: Off \(no documented API; set by hand, ADR-0040\)\)$/m);
    assert.match(p.stdout, /^create {2}build-acl {11}\\apps: id-contoso-portal may view and queue builds \(View builds, View build pipeline and Queue builds only\) {2}\(allow 1153\)$/m);
    assert.match(p.stdout, /^create {2}build-acl {11}\\platform: id-contoso-portal may view builds \(View builds only\) {2}\(allow 1\)$/m);
    assert.match(p.stdout, /^ok {6}build-acl {11}Platform \(all pipelines\): id-contoso-portal has no build permission$/m);

    fake.requests = [];
    const a = await grants("apply");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(
      [...writesFor(portal.descriptor), ...writesFor(portal.id)].map((w) => [w.method, w.path, w.body]),
      [
        ["POST", PROJECT_ACES, { token: PROJECT_TOKEN, merge: true, accessControlEntries: [{ descriptor: portal.descriptor, allow: 1, deny: 0 }] }],
        ["POST", GIT_ACES, { token: CONFIG_TOKEN, merge: true, accessControlEntries: [{ descriptor: portal.descriptor, allow: GIT.read | GIT.pullRequestContribute, deny: 0 }] }],
        ["POST", GIT_ACES, { token: FOLDER_TOKEN, merge: true, accessControlEntries: [{ descriptor: portal.descriptor, allow: GIT.createBranch | GIT.contribute, deny: 0 }] }],
        ["POST", BUILD_ACES, { token: APPS_TOKEN, merge: true, accessControlEntries: [{ descriptor: portal.descriptor, allow: 1 | 128 | 1024, deny: 0 }] }],
        ["POST", BUILD_ACES, { token: PLATFORM_TOKEN, merge: true, accessControlEntries: [{ descriptor: portal.descriptor, allow: 1, deny: 0 }] }],
      ],
      "no role, no other repository or branch, no Manage permissions, bypass or Edit policies, no ViewBuildDefinition, Queue builds on \\apps only",
    );
    assert.deepEqual(a.out.portalIdentity, { originId: PORTAL_OID, ...portal });

    // Already granted: ok, nothing written.
    fake.requests = [];
    const again = await grants("apply");
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /^ok {6}repo-acl {12}Platform\/platform-config: id-contoso-portal may read and contribute to pull requests \(only these\) {2}\(allow 16386, deny 0\)$/m);
    assert.match(again.stdout, /^ok {6}branch-acl {10}Platform\/platform-config portal\/requests\/: .* {2}\(allow 20, deny 0\)$/m);
    assert.match(again.stdout, /^ok {6}build-acl {11}\\platform: id-contoso-portal may view builds \(View builds only\) {2}\(allow 1, deny 0\)$/m);
    assert.match(again.stdout, /^ok {6}build-acl {11}\\apps: id-contoso-portal may view and queue builds \(View builds, View build pipeline and Queue builds only\) {2}\(allow 1153, deny 0\)$/m);
    assert.deepEqual(writesFor(portal.descriptor), []);
  });

  it("Check all apps (ADR-0046): View and Queue builds on \\platform\\provisioning alone, once the pipeline exists", async () => {
    const portal = fake.addPortalIdentity();
    const before = await grants("plan");
    assert.equal(before.code, 0, before.stdout + before.stderr);
    assert.match(before.stdout, /^warn {4}build-acl {11}\\platform\\provisioning: id-contoso-portal may view and queue it \(View builds, View build pipeline and Queue builds only; "Check all apps"\) {2}\(the pipeline doesn't exist yet: run --phase pipeline first, then --phase grants again\.\)$/m);
    fake.state.pipelines.push({ id: 77, name: "provisioning", folder: "\\platform", revision: 2 }, { id: 78, name: "validation", folder: "\\platform", revision: 2 });
    fake.requests = [];
    const a = await grants("apply");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /^create {2}build-acl {11}\\platform\\provisioning: id-contoso-portal may view and queue it \(View builds, View build pipeline and Queue builds only; "Check all apps"\) {2}\(allow 1153\) {2}\[done\]$/m);
    const tokens = writesFor(portal.descriptor).filter((w) => w.path === BUILD_ACES).map((w) => (w.body as J).token);
    assert.deepEqual(tokens, [APPS_TOKEN, PLATFORM_TOKEN, `${PLATFORM_TOKEN}/77`], "the provisioning definition only, never validation (78)");
    assert.equal(fake.state.acls[`${PLATFORM_TOKEN}/77`].acesDictionary[portal.descriptor].allow, 1 | 128 | 1024);
    assert.equal(fake.state.acls[PLATFORM_TOKEN].acesDictionary[portal.descriptor].allow, 1, "the folder stays View builds only");
  });

  it("View and Queue builds: other build bits are cut back on apply, a project-wide entry is only reported, a deny blocks", async () => {
    const portal = fake.addPortalIdentity();
    // Edit build pipeline (2048) next to View builds, View build pipeline and Queue builds on \apps; Queue builds (128) on \platform; Edit build pipeline (2048) project-wide.
    fake.state.acls[APPS_TOKEN] = { token: APPS_TOKEN, inheritPermissions: true, acesDictionary: { [portal.descriptor]: { descriptor: portal.descriptor, allow: 1 | 128 | 1024 | 2048, deny: 0 } } };
    fake.state.acls[PLATFORM_TOKEN] = { token: PLATFORM_TOKEN, inheritPermissions: true, acesDictionary: { [portal.descriptor]: { descriptor: portal.descriptor, allow: 1 | 128, deny: 0 } } };
    fake.state.acls[PLATFORM_ID] = { token: PLATFORM_ID, inheritPermissions: true, acesDictionary: { [portal.descriptor]: { descriptor: portal.descriptor, allow: 2048, deny: 0 } } };
    const p = await grants("plan");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /^extra {3}build-acl {11}\\apps: id-contoso-portal may view and queue builds \(View builds, View build pipeline and Queue builds only\) {2}\(allow 3201: remove EditBuildDefinition \(ViewBuilds, ViewBuildDefinition, QueueBuilds only, ADR-0037, ADR-0042\)\)$/m);
    assert.match(p.stdout, /^extra {3}build-acl {11}\\platform: id-contoso-portal may view builds \(View builds only\) {2}\(allow 129: remove QueueBuilds \(ViewBuilds only, ADR-0040\)\)$/m);
    assert.match(p.stdout, /^extra {3}build-acl {11}Platform \(all pipelines\): id-contoso-portal has no build permission {2}\(Platform \(all pipelines\): allow 2048 \(EditBuildDefinition\): not granted by the platform; remove it by hand \(ADR-0037, ADR-0040, ADR-0042, ADR-0046: View builds on \\apps and \\platform, Queue builds on \\apps and \\platform\\provisioning only\)\)$/m);

    fake.requests = [];
    const a = await grants("apply");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(writesFor(portal.descriptor).filter((w) => w.path === BUILD_ACES && (w.body as J).token === APPS_TOKEN).map((w) => w.body), [{ token: APPS_TOKEN, merge: false, accessControlEntries: [{ descriptor: portal.descriptor, allow: 1 | 128 | 1024, deny: 0 }] }]);
    assert.equal(fake.state.acls[APPS_TOKEN].acesDictionary[portal.descriptor].allow, 1 | 128 | 1024);
    assert.equal(fake.state.acls[PLATFORM_TOKEN].acesDictionary[portal.descriptor].allow, 1, "no queueing in \\platform");
    assert.equal(fake.state.acls[PLATFORM_ID].acesDictionary[portal.descriptor].allow, 2048, "left in place");

    fake.state.acls[APPS_TOKEN].acesDictionary[portal.descriptor] = { descriptor: portal.descriptor, allow: 0, deny: 1 };
    fake.requests = [];
    const d = await grants("apply");
    assert.equal(d.code, 1, d.stdout);
    assert.match(d.stdout, /^blocked build-acl {11}\\apps: id-contoso-portal may view and queue builds \(View builds, View build pipeline and Queue builds only\) {2}\(an explicit deny \(1\) blocks ViewBuilds; remove it by hand\.\)$/m);
    assert.deepEqual(writesFor(portal.descriptor).filter((w) => w.path === BUILD_ACES && (w.body as J).token === APPS_TOKEN), [], "the denied View builds is not overwritten");
  });

  it("reports extra Git permissions: the repository and folder entries are cut back on apply; all-repos and main entries only reported", async () => {
    const portal = fake.addPortalIdentity();
    // Contribute, CreateBranch, ManagePermissions next to Read and PullRequestContribute on platform-config; Contribute on every repo of the project; Contribute on main.
    fake.setAce(CONFIG_TOKEN, portal.descriptor, GIT.read | GIT.contribute | GIT.createBranch | GIT.pullRequestContribute | GIT.managePermissions);
    fake.setAce(FOLDER_TOKEN, portal.descriptor, GIT.createBranch | GIT.contribute | GIT.forcePush);
    fake.setAce(`repoV2/${PLATFORM_ID}`, portal.descriptor, GIT.contribute);
    fake.setAce(MAIN_TOKEN, portal.descriptor, GIT.contribute);
    const p = await grants("plan");
    assert.equal(p.code, 0, p.stdout + p.stderr);
    assert.match(p.stdout, /^extra {3}repo-acl {12}Platform\/platform-config: id-contoso-portal may read and contribute to pull requests \(only these\) {2}\(allow 24598: remove GenericContribute, CreateBranch, ManagePermissions \(GenericRead, PullRequestContribute only, ADR-0040\)\)$/m);
    assert.match(p.stdout, /^extra {3}branch-acl {10}Platform\/platform-config portal\/requests\/: .* {2}\(allow 28: remove ForcePush \(CreateBranch, GenericContribute only, ADR-0040\)\)$/m);
    assert.match(p.stdout, /^extra {3}repo-acl {12}Platform \(all repos\), the organization \(all repos\) and Platform\/platform-config refs\/heads\/main: id-contoso-portal has no Git permission {2}\(Platform \(all repos\): allow 4 \(GenericContribute\); refs\/heads\/main: allow 4 \(GenericContribute\): not granted by the platform; remove it by hand/m);

    fake.requests = [];
    const a = await grants("apply");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(writesFor(portal.descriptor).filter((w) => w.path === GIT_ACES).map((w) => w.body), [
      { token: CONFIG_TOKEN, merge: false, accessControlEntries: [{ descriptor: portal.descriptor, allow: GIT.read | GIT.pullRequestContribute, deny: 0 }] },
      { token: FOLDER_TOKEN, merge: false, accessControlEntries: [{ descriptor: portal.descriptor, allow: GIT.createBranch | GIT.contribute, deny: 0 }] },
    ]);
    assert.equal(fake.state.acls[`repoV2/${PLATFORM_ID}`].acesDictionary[portal.descriptor].allow, GIT.contribute, "left in place");
    assert.equal(fake.state.acls[MAIN_TOKEN].acesDictionary[portal.descriptor].allow, GIT.contribute, "left in place");
  });

  it("Permissions management: the portal's Manage permissions on its request branches is reported and removed", async () => {
    const portal = fake.addPortalIdentity();
    await grants("apply");
    // Two request branches the portal created while the setting was on (creator rights).
    const b1 = branchTokenOf(PLATFORM_ID, CONFIG_REPO, "portal/requests/shop-1");
    const b2 = branchTokenOf(PLATFORM_ID, CONFIG_REPO, "portal/requests/shop-2");
    fake.setAce(b1, portal.descriptor, GIT.contribute | GIT.forcePush | GIT.removeOthersLocks | GIT.managePermissions);
    fake.setAce(b2, portal.descriptor, GIT.contribute | GIT.forcePush | GIT.removeOthersLocks);
    fake.requests = [];
    const p = await grants("plan");
    assert.equal(p.code, 0, p.stdout);
    assert.match(p.stdout, /^extra {3}repo-setting {8}Platform\/platform-config: Permissions management off .* {2}\(the portal has Manage permissions on 1 branch\(es\) below portal\/requests\/, so the setting is on: removed from those branches; turn it off: Project settings > Repositories > platform-config > Settings > Permissions management: Off/m);
    assert.ok(fake.requests.some((q) => q.query.get("recurse") === "true" && q.query.get("token") === FOLDER_TOKEN));
    const a = await grants("apply");
    assert.equal(a.code, 0, a.stdout);
    assert.deepEqual(writesFor(portal.descriptor).filter((w) => (w.body as J).token === b1).map((w) => w.body), [
      { token: b1, merge: false, accessControlEntries: [{ descriptor: portal.descriptor, allow: GIT.contribute | GIT.forcePush | GIT.removeOthersLocks, deny: 0 }] },
    ]);
    assert.ok(!writesFor(portal.descriptor).some((w) => (w.body as J).token === b2), "a branch without Manage permissions is left alone");
    assert.match((await grants("plan")).stdout, /^warn {4}repo-setting /m);
  });

  it("blocks an access level below Basic and an explicit deny of Read", async () => {
    const portal = fake.addPortalIdentity("stakeholder");
    const s = await grants("plan");
    assert.equal(s.code, 1, s.stdout);
    assert.match(s.stdout, /^blocked org-user {12}id-contoso-portal \(in the organization\) {2}\(id-contoso-portal has access level stakeholder; reading Git repositories needs Basic/m);
    assert.ok(!s.stdout.includes("id-contoso-portal may read"), "no repository rows below Basic");

    fake.state.entitlements[portal.id].accessLevel.accountLicenseType = "express";
    fake.state.acls[CONFIG_TOKEN] = { token: CONFIG_TOKEN, inheritPermissions: true, acesDictionary: { [portal.descriptor]: { descriptor: portal.descriptor, allow: 0, deny: 2 } } };
    fake.requests = [];
    const d = await grants("apply");
    assert.equal(d.code, 1, d.stdout);
    assert.match(d.stdout, /^blocked repo-acl {12}Platform\/platform-config: id-contoso-portal may read and contribute to pull requests \(only these\) {2}\(an explicit deny \(2\) blocks GenericRead; remove it by hand\.\)$/m);
    assert.deepEqual(writesFor(portal.descriptor).filter((w) => w.path === GIT_ACES && (w.body as J).token === CONFIG_TOKEN), [], "the denied Read is not overwritten");
  });
});

describe("platform ado bootstrap --phase policies (ADR-0040)", () => {
  beforeEach(() => fake.reset("configured"));
  const SCOPE = [{ repositoryId: CONFIG_REPO, refName: "refs/heads/main", matchKind: "exact" }];
  const POLICIES = "/contoso/Platform/_apis/policy/configurations";
  const PIPELINES_MESSAGE = "This pull request changes pipelines/. The build validation ran this pull request's own pipelines/validation.yml, so its result proves nothing here: review the pipeline files themselves (ADR-0040).";

  it("blocked before \\platform\\validation exists; then minimum reviewers, the platform team and build validation; idempotent", async () => {
    const before = await bs("plan", "policies");
    assert.equal(before.code, 1, before.stdout + before.stderr);
    assert.match(before.stdout, /^create {2}policy {14}platform-config refs\/heads\/main: Minimum reviewers {2}\(at least 1, the requester can't approve, votes reset on push, the last pusher can't approve\)$/m);
    assert.match(before.stdout, new RegExp(`^create {2}policy {14}platform-config refs/heads/main: Required reviewer approvals\\.platformTeam {2}\\(the platform team group ${GROUP_ID} on every pull request, the requester can't approve\\)$`, "m"));
    assert.match(before.stdout, new RegExp(`^create {2}policy {14}platform-config refs/heads/main: Required reviewer approvals\\.platformTeam for /pipelines/\\* {2}\\(the platform team group ${GROUP_ID} on changes of /pipelines/\\*, the requester can't approve\\)$`, "m"));
    assert.match(before.stdout, /^blocked policy {14}platform-config refs\/heads\/main: Build validation \\platform\\validation {2}\(\\platform\\validation does not exist: run --phase pipeline first\.\)$/m);
    assert.deepEqual(writes(), []);

    await bs("apply", "connections");
    await bs("apply", "pipeline");
    const vid = fake.state.pipelines.find((x: J) => x.name === "validation" && x.folder === "\\platform").id as number;
    fake.requests = [];
    const a = await bs("apply", "policies");
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(writes().map((w) => [w.method, w.path, w.body]), [
      ["POST", POLICIES, { isEnabled: true, isBlocking: true, type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" }, settings: { minimumApproverCount: 1, creatorVoteCounts: false, allowDownvotes: false, resetOnSourcePush: true, blockLastPusherVote: true, scope: SCOPE } }],
      ["POST", POLICIES, { isEnabled: true, isBlocking: true, type: { id: "fd2167ab-b0be-447a-8ec8-39368250530e" }, settings: { requiredReviewerIds: [GROUP_ID], filenamePatterns: ["/pipelines/*"], creatorVoteCounts: false, message: PIPELINES_MESSAGE, scope: SCOPE } }],
      ["POST", POLICIES, { isEnabled: true, isBlocking: true, type: { id: "fd2167ab-b0be-447a-8ec8-39368250530e" }, settings: { requiredReviewerIds: [GROUP_ID], creatorVoteCounts: false, message: "The platform team reviews every change of platform-config (ADR-0040).", scope: SCOPE } }],
      ["POST", POLICIES, { isEnabled: true, isBlocking: true, type: { id: "0609b952-1397-4640-95ec-e00a01b2c241" }, settings: { buildDefinitionId: vid, displayName: "platform validation", manualQueueOnly: true, queueOnSourceUpdateOnly: true, validDuration: 720, scope: SCOPE } }],
    ]);

    assert.match(a.stdout, /^create {2}policy {14}platform-config refs\/heads\/main: Build validation \\platform\\validation {2}\(pipeline \d+, required, queued by a reviewer after reading the change \(manual\), valid 12 hours\) {2}\[done\]$/m);
    // The sandbox project already limits job tokens; the build service has Read only on core and platform-config.
    assert.match(a.stdout, /^ok {6}setting {13}Platform: Limit job authorization scope to current project for non-release pipelines {2}\(enforceJobAuthScope\)$/m);
    assert.match(a.stdout, /^ok {6}setting {13}Platform: Protect access to repositories in YAML pipelines {2}\(enforceReferencedRepoScopedToken\)$/m);
    assert.match(a.stdout, /^ok {6}setting {13}Platform: Limit variables that can be set at queue time {2}\(enforceSettableVar\)$/m);
    assert.match(a.stdout, /^ok {6}repo-acl {12}Platform Build Service \(contoso\): Read only on core and platform-config$/m);

    fake.requests = [];
    const again = await bs("apply", "policies");
    assert.equal(again.code, 0, again.stdout);
    assert.equal(lines(again.stdout, "ok").filter((l) => l.includes(" policy ")).length, 4);

    assert.deepEqual(writes(), []);
  });

  it("approvals.allowSelfApproval: the requester's vote counts (update), with a warn row; a stricter count is kept; others are extra", async () => {
    await bs("apply", "pipeline");
    await bs("apply", "policies");
    const min = fake.state.policies.find((c: J) => c.type.id === "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd");
    min.settings.minimumApproverCount = 2;
    // A comment policy on main (not the platform's) and a policy on another branch (not shown).
    fake.state.policies.push({ id: 900, isEnabled: true, isBlocking: true, type: { id: "c6a1889d-b943-4856-b76f-9e46bb6b0df2", displayName: "Comment requirements" }, settings: { scope: [{ repositoryId: CONFIG_REPO, refName: "refs/heads/main", matchKind: "Exact" }] } });
    fake.state.policies.push({ id: 901, isEnabled: true, isBlocking: true, type: { id: "fa4e907d-c16b-4a4c-9dfa-4906e5d171dd" }, settings: { minimumApproverCount: 0, scope: [{ repositoryId: CONFIG_REPO, refName: "refs/heads/release", matchKind: "exact" }] } });
    const doc = parse(readFileSync(instance, "utf8")) as J;
    doc.approvals.allowSelfApproval = true;
    const self = join(tmp("pc-adobs-pol-"), "instance.yaml");
    writeFileSync(self, stringify(doc));
    const p = await bs("plan", "policies", [], self);
    assert.equal(p.code, 0, p.stdout);
    assert.match(p.stdout, /^warn {4}identity {12}platform-config pull requests \(self-approval\)/m);
    assert.deepEqual(lines(p.stdout, "update").map((l) => l.replace(/ +/g, " ")), [
      "update policy platform-config refs/heads/main: Minimum reviewers (creatorVoteCounts -> true, blockLastPusherVote -> false)",
      "update policy platform-config refs/heads/main: Required reviewer approvals.platformTeam for /pipelines/* (creatorVoteCounts -> true)",
      "update policy platform-config refs/heads/main: Required reviewer approvals.platformTeam (creatorVoteCounts -> true)",
    ]);
    assert.deepEqual(lines(p.stdout, "extra").map((l) => l.replace(/ +/g, " ")), ["extra policy platform-config refs/heads/main: Comment requirements (id 900) (not managed by the platform; left in place)"]);
    fake.requests = [];
    assert.equal((await bs("apply", "policies", [], self)).code, 0);
    const put = writes().find((w) => w.method === "PUT" && w.path === `${POLICIES}/${min.id}`)!.body as J;
    assert.deepEqual([put.settings.minimumApproverCount, put.settings.creatorVoteCounts, put.settings.scope], [2, true, min.settings.scope]);
    assert.deepEqual(lines((await bs("plan", "policies", [], self)).stdout, "update"), []);
  });

  it("pipeline settings: off is set on apply (PATCH), a refusal fails with the manual step", async () => {
    await bs("apply", "pipeline");
    fake.state.generalsettings = { ...fake.state.generalsettings, enforceJobAuthScope: false, enforceReferencedRepoScopedToken: false };
    const p = await bs("plan", "policies");
    assert.deepEqual(lines(p.stdout, "update").filter((l) => l.includes(" setting ")).map((l) => l.replace(/ +/g, " ")), [
      "update setting Platform: Limit job authorization scope to current project for non-release pipelines (enforceJobAuthScope -> true)",
      "update setting Platform: Protect access to repositories in YAML pipelines (enforceReferencedRepoScopedToken -> true)",
    ]);
    fake.requests = [];
    const a = await bs("apply", "policies");
    assert.equal(a.code, 0, a.stdout);
    assert.deepEqual(writes().filter((w) => w.path.endsWith("/build/generalsettings")).map((w) => [w.method, w.body]), [
      ["PATCH", { enforceJobAuthScope: true }],
      ["PATCH", { enforceReferencedRepoScopedToken: true }],
    ]);
    assert.deepEqual([fake.state.generalsettings.enforceJobAuthScope, fake.state.generalsettings.enforceReferencedRepoScopedToken], [true, true]);

    fake.state.generalsettings.enforceSettableVar = false;
    fake.failures = [{ method: "PATCH", path: "/build/generalsettings", status: 403, message: "Access denied." }];
    const r = await bs("apply", "policies");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^update {2}setting {13}Platform: Limit variables that can be set at queue time {2}\(enforceSettableVar -> true\) {2}\[FAILED: PATCH .*returned HTTP 403.* Turn it on by hand: Project settings > Pipelines > Settings > Limit variables that can be set at queue time \(a Project Administrator\)\.\]$/m);
  });

  it("the build service with more than Read on core, platform-config or all repositories: reported, never changed", async () => {
    await bs("apply", "pipeline");
    const build = fake.state.identities[0].descriptor;
    fake.setAce(`repoV2/${PLATFORM_ID}`, build, GIT.read | GIT.contribute | GIT.createBranch);
    fake.setAce(`repoV2/${PLATFORM_ID}/${CONFIG_REPO}`, build, GIT.read);
    fake.requests = [];
    const r = await bs("apply", "policies");
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^extra {3}repo-acl {12}Platform Build Service \(contoso\): Read only on core and platform-config {2}\(Platform \(all repos\): allow 22 \(GenericContribute, CreateBranch\): more than Read; remove it by hand/m);
    assert.ok(!writes().some((w) => JSON.stringify(w.body ?? null).includes(build)), "only reported");
  });

  it("a weaker build validation is updated (queued automatically, no expiry); a shorter validity is kept", async () => {
    await bs("apply", "pipeline");
    await bs("apply", "policies");
    const build = fake.state.policies.find((c: J) => c.type.id === "0609b952-1397-4640-95ec-e00a01b2c241");
    Object.assign(build.settings, { manualQueueOnly: false, queueOnSourceUpdateOnly: false, validDuration: 0 });
    const r = await bs("plan", "policies");
    assert.match(r.stdout, /^update {2}policy {14}platform-config refs\/heads\/main: Build validation \\platform\\validation {2}\(manualQueueOnly -> true, queueOnSourceUpdateOnly -> true, validDuration 0 -> 720\)$/m);
    fake.requests = [];
    assert.equal((await bs("apply", "policies")).code, 0);
    const put = writes().find((w) => w.method === "PUT")!.body as J;
    assert.deepEqual([put.settings.manualQueueOnly, put.settings.queueOnSourceUpdateOnly, put.settings.validDuration, put.settings.buildDefinitionId], [true, true, 720, build.settings.buildDefinitionId]);
    build.settings.validDuration = 60;
    const kept = await bs("plan", "policies");
    assert.match(kept.stdout, /^ok {6}policy {14}platform-config refs\/heads\/main: Build validation /m);
  });

  it("a disabled or optional policy is updated; an unresolved platform team blocks only its row", async () => {
    await bs("apply", "pipeline");
    await bs("apply", "policies");
    const build = fake.state.policies.find((c: J) => c.type.id === "0609b952-1397-4640-95ec-e00a01b2c241");
    build.isBlocking = false;
    build.settings.filenamePatterns = ["/apps/*"];
    const r = await bs("plan", "policies");
    assert.match(r.stdout, /^update {2}policy {14}platform-config refs\/heads\/main: Build validation \\platform\\validation {2}\(make it required, filenamePatterns -> all files\)$/m);
    fake.state.identities = fake.state.identities.filter((i: J) => i.id !== GROUP_ID);
    const u = await bs("plan", "policies");
    assert.equal(u.code, 1);
    assert.match(u.stdout, /^blocked policy {14}platform-config refs\/heads\/main: Required reviewer approvals\.platformTeam {2}\(the platform team group is unresolved \(see the identity line above\); existing policy \d+ left as it is\.\)$/m);
    assert.match(u.stdout, /^ok {6}policy {14}platform-config refs\/heads\/main: Minimum reviewers/m);
    assert.equal(lines(u.stdout, "blocked").filter((l) => l.includes(" policy ")).length, 2, "both required reviewer policies, each left as it is");
    assert.deepEqual(lines(u.stdout, "extra"), []);
  });
});

describe("platform ado bootstrap --phase projects (ADR-0069)", () => {
  const AGILE = "00000000-0000-0000-0000-0000000000c1";
  /** instance.yaml with these scm.azureDevOps changes (written next to the others). */
  function variant(change: (ado: J) => void): string {
    const doc = parse(readFileSync(instance, "utf8")) as J;
    change(doc.scm.azureDevOps);
    const file = join(tmp("pc-adoproj-"), "instance.yaml");
    writeFileSync(file, stringify(doc));
    return file;
  }
  const dropProjects = (): void => {
    fake.state.projects = fake.state.projects.filter((x: J) => !["Platform", "Apps"].includes(x.name));
  };
  beforeEach(() => fake.reset("configured"));

  it("plan: both projects exist and the approvers are known, ok rows, only reads (no process, no repository), exit 0", async () => {
    const r = await bs("plan", "projects");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(lines(r.stdout, "ok").map((l) => l.replace(/ +/g, " ").trim()), [
      `ok project Platform (${PLATFORM_ID})`,
      `ok project Apps (${APPS_ID})`,
      "ok approvers approvals.platformTeam sg-platform-team: known to Azure DevOps (ADO-23)",
    ]);
    assert.deepEqual(writes(), []);
    assert.ok(!fake.requests.some((x) => /process|git\/repositories/.test(x.path)));
  });

  it("approvers unknown to Azure DevOps (ADO-23): a create row; apply adds the Entra group to [Platform]\\Readers; then ok", async () => {
    fake.forgetApprovers();
    const plan = await bs("plan", "projects");
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /create +approvers +approvals\.platformTeam sg-platform-team: known to Azure DevOps \(ADO-23\) +\(add the Entra group 00000000-0000-0000-0000-00000000c002 to \[Platform\]\\Readers, so that Azure DevOps knows it\)/);
    assert.deepEqual(writes(), []);
    const r = await bs("apply", "projects");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const posts = writes();
    assert.deepEqual(posts.map((w) => [w.method, w.path, w.query.get("groupDescriptors"), w.body]), [["POST", "/vssps/contoso/_apis/graph/groups", `vssgp.readers-${PLATFORM_ID}`, { originId: GROUP_OID }]]);
    const again = await bs("plan", "projects");
    assert.match(again.stdout, /ok +approvers /);
  });

  it("plan: missing projects are create rows with the default process, nothing written", async () => {
    dropProjects();
    const r = await bs("plan", "projects");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const create = lines(r.stdout, "create").map((l) => l.replace(/ +/g, " ").trim());
    assert.deepEqual(create, [
      "create project Platform (private, Git, process Agile: SAF platform: platform-config, core and the platform pipelines)",
      "create project Apps (private, Git, process Agile: SAF apps: the app repositories and pipelines the portal creates)",
    ]);
    assert.deepEqual(writes(), []);
  });

  it("apply creates each missing project (private, Git, the default process, its role), waits for the operation; a re-run is all ok", async () => {
    dropProjects();
    fake.state.operationReplies = ["inProgress"];
    const r = await bs("apply", "projects");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const posts = writes();
    assert.deepEqual(posts.map((w) => [w.method, w.path.split("?")[0]]), [["POST", "/contoso/_apis/projects"], ["POST", "/contoso/_apis/projects"]]);
    assert.deepEqual(posts.map((w) => w.body), [
      { name: "Platform", description: "SAF platform: platform-config, core and the platform pipelines (platform ado bootstrap --phase projects).", visibility: "private", capabilities: { versioncontrol: { sourceControlType: "Git" }, processTemplate: { templateTypeId: AGILE } } },
      { name: "Apps", description: "SAF apps: the app repositories and pipelines the portal creates (platform ado bootstrap --phase projects).", visibility: "private", capabilities: { versioncontrol: { sourceControlType: "Git" }, processTemplate: { templateTypeId: AGILE } } },
    ]);
    assert.ok(fake.requests.filter((x) => x.path.startsWith("/contoso/_apis/operations/")).length >= 3, "the first operation is polled until it succeeds");
    const again = await bs("plan", "projects");
    assert.equal(again.code, 0);
    assert.equal(lines(again.stdout, "ok").length, 3, "both projects and the approvers");
  });

  it("an operation that fails fails its row (exit 1); the next project is still created", async () => {
    dropProjects();
    fake.state.operationReplies = ["failed"];
    const r = await bs("apply", "projects");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /creating the project Platform: the operation failed: The project could not be created\./);
    assert.equal(writes().length, 2);
  });

  it("an existing project is never changed: not private or not wellFormed is a warn row (exit 0)", async () => {
    fake.state.projects.find((x: J) => x.name === "Apps").visibility = "public";
    fake.state.projects.find((x: J) => x.name === "Platform").state = "createPending";
    const r = await bs("apply", "projects");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const warn = lines(r.stdout, "warn").map((l) => l.replace(/ +/g, " ").trim());
    assert.deepEqual(warn, [
      "warn project Platform (state createPending: wait until Azure DevOps has created it, then run this phase again)",
      "warn project Apps (visibility public: the platform's projects are private (Project settings, Overview))",
    ]);
    assert.deepEqual(writes(), []);
  });

  it("allowedProjects: an existing one is ok, a missing one blocked and never created; a project named twice is read once", async () => {
    const file = variant((ado) => {
      ado.allowedProjects = ["Platform", "Team-X", "apps"];
    });
    const r = await run(["apply", "--instance", file, "--org-url", fake.orgUrl, "--phase", "projects"]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /blocked +project +Team-X +\(an allowed app project \(scm\.azureDevOps\.allowedProjects\) doesn't exist: create it, or remove it from scm\.azureDevOps\.allowedProjects\.\)/);
    assert.equal(lines(r.stdout, "ok").length, 3, "Platform, Apps (named twice) and the approvers");
    assert.deepEqual(writes(), []);
  });

  it("needs no --identities and no platform-config", async () => {
    delete fake.state.repos["Platform/platform-config"];
    delete fake.state.repos["Platform/core"];
    const r = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "projects"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });
});

describe("platform ado bootstrap --phase config (ADR-0069)", () => {
  const PUSHES = `/contoso/Platform/_apis/git/repositories/${CONFIG_REPO}/pushes`;
  const GENERATED = ["pipelines/provisioning.yml", "pipelines/validation.yml", "pipelines/platform-nonprod.yml", "pipelines/platform-prod.yml"];
  beforeEach(() => {
    fake.reset("configured");
    // The person runs it as a Project Administrator: Create branch and Contribute on the project's repositories.
    fake.setAce(`repoV2/${PLATFORM_ID}`, fake.state.caller.descriptor, GIT.createBranch | GIT.contribute);
  });
  /** platform-config with one commit on main holding these files. */
  function withCommit(files: Record<string, string>): void {
    const head = "9".repeat(40);
    fake.state.refs[CONFIG_REPO] = [{ name: "refs/heads/main", objectId: head }];
    fake.state.commits[head] = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)]));
  }

  it("plan: a missing platform-config is created, then seeded with instance.yaml and the generated pipelines; only GETs", async () => {
    delete fake.state.repos["Platform/platform-config"];
    const r = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(lines(r.stdout, "create").map((l) => l.replace(/ +/g, " ").trim()), [
      "create repository Platform/platform-config (then seeded below)",
      "create seed Platform/platform-config: refs/heads/main (one commit: instance.yaml and the 4 pipeline files of platform generate)",
    ]);
    assert.deepEqual(writes(), []);
  });

  it("apply: creates the repository and pushes one commit (instance.yaml byte for byte, the files platform generate writes); a plan right after is ok", async () => {
    delete fake.state.repos["Platform/platform-config"];
    const r = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const created = fake.state.repos["Platform/platform-config"];
    assert.ok(created);
    const push = writes().find((w) => w.path.endsWith("/pushes"))! as { body: J };
    assert.deepEqual(push.body.refUpdates, [{ name: "refs/heads/main", oldObjectId: "0".repeat(40) }]);
    const changes = push.body.commits[0].changes as J[];
    assert.deepEqual(changes.map((c) => [c.changeType, c.item.path]), [["add", "/instance.yaml"], ...GENERATED.map((g) => ["add", `/${g}`])]);
    assert.equal(Buffer.from(changes[0]!.newContent.content, "base64").toString("utf8"), readFileSync(instance, "utf8"));
    // The same files platform generate writes for that instance.yaml.
    const dir = tmp("pc-adocfg-");
    writeFileSync(join(dir, "instance.yaml"), readFileSync(instance));
    const gen = spawnSync(process.execPath, [CLI, "generate", "--config-dir", dir], { encoding: "utf8" });
    assert.equal(gen.status, 0, gen.stderr);
    for (const [i, g] of GENERATED.entries()) assert.equal(Buffer.from(changes[i + 1]!.newContent.content, "base64").toString("utf8"), readFileSync(join(dir, g), "utf8"), g);
    assert.match(push.body.commits[0].comment, /^Start platform-config: instance\.yaml and its pipelines \(core v/);
    const again = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "ok").map((l) => l.replace(/ +/g, " ").trim()).slice(1), [`ok repository Platform/platform-config (${created.id})`, "ok seed Platform/platform-config: refs/heads/main (instance.yaml on refs/heads/main equals instance.yaml)"]);
  });

  it("an existing empty repository is seeded, not created again", async () => {
    const r = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(writes().map((w) => [w.method, w.path]), [["POST", PUSHES]]);
  });

  it("a repository with commits is never pushed to: a different or missing instance.yaml is a warn row (exit 0)", async () => {
    withCommit({ "instance.yaml": "schemaVersion: other\n" });
    const r = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /warn +seed +Platform\/platform-config: refs\/heads\/main +\(instance\.yaml on refs\/heads\/main differs from instance\.yaml: change it through a pull request \(this phase never pushes to a repository with commits\)\)/);
    withCommit({ "README.md": "x" });
    const missing = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.match(missing.stdout, /warn +seed .*no instance\.yaml on refs\/heads\/main: add it through a pull request/);
    assert.deepEqual(writes(), []);
  });

  it("a default branch other than the instance's blocks (exit 1), nothing pushed", async () => {
    withCommit({ "instance.yaml": readFileSync(instance, "utf8") });
    fake.state.repos["Platform/platform-config"].defaultBranch = "refs/heads/master";
    const r = await run(["apply", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /blocked +seed .*default branch is refs\/heads\/master, but instance\.yaml says refs\/heads\/main/);
    assert.deepEqual(writes(), []);
  });

  it("needs no --identities and no core", async () => {
    delete fake.state.repos["Platform/core"];
    const r = await run(["plan", "--instance", instance, "--org-url", fake.orgUrl, "--phase", "config"]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
  });
});

describe("platform ado bootstrap --phase core (ADR-0067)", () => {
  const CORE = "00000000-0000-0000-0000-0000000000b2";
  const NS = "2e9eb7ed-3c0a-47d4-87c1-0ffdd275fd87";
  const projectToken = `repoV2/${PLATFORM_ID}`;
  const repoToken = (id = CORE): string => `repoV2/${PLATFORM_ID}/${id}`;
  const tagTokenOf = (tag: string, id = CORE): string => `${repoToken(id)}/refs/tags/${Buffer.from(tag, "utf16le").toString("hex")}`;
  /** Azure DevOps' defaults: Contributors and Build Administrators may create tags on every repository of the project. */
  const DEFAULT_ALLOW = GIT.read | GIT.contribute | GIT.createBranch | GIT.createTag | 64 | GIT.pullRequestContribute;
  let contributors = "";
  let buildService = "";
  const ace = (token: string, d: string): J => fake.state.acls[token]?.acesDictionary[d] ?? { allow: 0, deny: 0 };
  beforeEach(() => {
    fake.reset("configured");
    contributors = fake.state.identities.find((i: J) => i.providerDisplayName === "[Platform]\\Contributors").descriptor;
    buildService = fake.state.identities.find((i: J) => String(i.descriptor).includes(":Build:")).descriptor;
    fake.setAce(projectToken, contributors, DEFAULT_ALLOW);
    fake.setAce(projectToken, GROUPS.buildAdmins.descriptor, DEFAULT_ALLOW);
  });

  it("plan: a missing core is a create row, the Create tag rows planned, only GETs and no platform-config read (exit 0)", async () => {
    delete fake.state.repos["Platform/core"];
    delete fake.state.repos["Platform/platform-config"];
    const r = await bs("plan", "core");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.deepEqual(writes(), []);
    const rows = r.stdout.split("\n").map((l) => l.replace(/ +/g, " ").trim());
    assert.ok(rows.includes("create repository Platform/core (empty: instance.sh core pushes the release into it (ADR-0067))"), r.stdout);
    assert.ok(rows.includes("update repo-acl [Platform]\\Contributors: no Create tag entry of its own on Platform (all repos) or core (Project Administrators only) (remove its allow of CreateTag on Platform (all repos))"), r.stdout);
    assert.ok(rows.some((l) => l.startsWith("update repo-acl [Platform]\\Build Administrators: ")));
    assert.ok(rows.includes("create repo-acl core: Create tag denied to Platform Build Service (contoso) (deny 32, once the repository exists)"), r.stdout);
    assert.ok(rows.includes("create repo-acl core: Create tag denied to [contoso]\\Project Collection Build Service Accounts (deny 32, once the repository exists)"), r.stdout);
    assert.ok(!rows.some((l) => l.includes("tag-acl")));
    assert.deepEqual(r.out!.core, { repository: null, tags: [] });
  });

  it("apply: creates core, removes the inherited allows (no deny), denies Create tag to the build services; then all ok", async () => {
    delete fake.state.repos["Platform/core"];
    const r = await bs("apply", "core");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const repo = fake.state.repos["Platform/core"];
    assert.ok(repo, "created");
    assert.deepEqual(r.out!.core, { repository: { id: repo.id, name: "core" }, tags: [] });
    for (const d of [contributors, GROUPS.buildAdmins.descriptor]) {
      assert.deepEqual(ace(projectToken, d), { descriptor: d, allow: DEFAULT_ALLOW & ~GIT.createTag, deny: 0 }, "the other bits stay, nothing denied");
      assert.equal(ace(repoToken(repo.id), d).deny, 0);
    }
    for (const d of [buildService, GROUPS.collectionBuild.descriptor]) assert.equal(ace(repoToken(repo.id), d).deny, GIT.createTag);
    const removals = fake.requests.filter((x) => x.method === "DELETE");
    assert.deepEqual(removals.map((x) => [x.path, x.query.get("token"), x.query.get("descriptor")]), [
      [`/contoso/_apis/permissions/${NS}/32`, projectToken, contributors],
      [`/contoso/_apis/permissions/${NS}/32`, projectToken, GROUPS.buildAdmins.descriptor],
    ]);
    assert.match(r.stdout, /ok {6}tag-acl {13}core: no v\* tag yet/);
    const again = await bs("plan", "core");
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update")), []);
  });

  it("every v* tag gets Force push denied on its own token for Project Valid Users and the build services; refs/tags itself counts for nothing", async () => {
    fake.state.refs[CORE] = [
      { name: "refs/heads/main", objectId: "a".repeat(40) },
      { name: "refs/tags/v0.1.0", objectId: "b".repeat(40) },
      { name: "refs/tags/v0.2.0-rc.1", objectId: "c".repeat(40) },
      { name: "refs/tags/other", objectId: "d".repeat(40) },
    ];
    // ADO-23: a deny on the folder refs/tags didn't stop a delete or a move.
    fake.setAce(`${repoToken()}/refs/tags`, GROUPS.validUsers.descriptor, 0, GIT.forcePush);
    const plan = await bs("plan", "core");
    assert.equal(plan.code, 0, plan.stdout);
    assert.deepEqual(
      lines(plan.stdout, "create").filter((l) => l.includes("tag-acl")).map((l) => l.replace(/ +/g, " ")),
      ["create tag-acl core refs/tags/v0.1.0: Force push (delete, move) denied to Project Valid Users and the build services (deny 8 (3 of 3 entries))", "create tag-acl core refs/tags/v0.2.0-rc.1: Force push (delete, move) denied to Project Valid Users and the build services (deny 8 (3 of 3 entries))"],
    );
    assert.deepEqual(plan.out!.core.tags, ["v0.1.0", "v0.2.0-rc.1"]);
    const r = await bs("apply", "core");
    assert.equal(r.code, 0, r.stdout);
    for (const tag of ["v0.1.0", "v0.2.0-rc.1"]) {
      for (const d of [GROUPS.validUsers.descriptor, buildService, GROUPS.collectionBuild.descriptor]) assert.equal(ace(tagTokenOf(tag), d).deny, GIT.forcePush, `${tag} ${d}`);
    }
    assert.ok(fake.state.acls[`${repoToken()}/refs/tags/760030002e0031002e003000`], "the token of v0.1.0: its name as UTF-16LE hex, no trailing slash");
    assert.equal(fake.state.acls[tagTokenOf("other")], undefined, "only v* tags");
    const again = await bs("plan", "core");
    assert.deepEqual(lines(again.stdout, "ok").filter((l) => l.includes("tag-acl")).length, 2);
    assert.deepEqual(lines(again.stdout, "create"), []);
  });

  it("a group whose ACEs Azure DevOps keys by another descriptor (an alias, ONB-2): applied once, then ok", async () => {
    // On the test instance the identities search returned one SID for [org]\Project Collection Build Service
    // Accounts, and the ACL kept its deny under another; a plan keyed by the searched one created it on every run.
    const CANONICAL = "Microsoft.TeamFoundation.Identity;S-1-9-0000000000-913-1-1";
    fake.state.descriptorAliases = { [GROUPS.collectionBuild.descriptor.toLowerCase()]: CANONICAL };
    fake.state.refs[CORE] = [{ name: "refs/tags/v0.2.0-rc.1", objectId: "c".repeat(40) }];
    const r = await bs("apply", "core");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(ace(repoToken(), CANONICAL).deny, GIT.createTag, "stored under the canonical descriptor");
    assert.equal(ace(tagTokenOf("v0.2.0-rc.1"), CANONICAL).deny, GIT.forcePush);
    assert.equal(ace(repoToken(), GROUPS.collectionBuild.descriptor).deny, 0, "nothing under the alias");
    const again = await bs("plan", "core");
    assert.equal(again.code, 0);
    assert.deepEqual(lines(again.stdout, "create").concat(lines(again.stdout, "update")), []);
  });

  it("an explicit deny of Create tag on Contributors (it refuses the administrators too, ADO-23) is removed, not kept", async () => {
    fake.setAce(repoToken(), contributors, 0, GIT.createTag);
    const plan = await bs("plan", "core");
    assert.match(plan.stdout, /update {2}repo-acl {12}\[Platform\]\\Contributors: .*\(remove its allow of CreateTag on Platform \(all repos\); remove its deny of CreateTag on core\)/);
    assert.equal((await bs("apply", "core")).code, 0);
    assert.deepEqual([ace(repoToken(), contributors).allow, ace(repoToken(), contributors).deny], [0, 0]);
  });

  it("a group that can't be found blocks its rows (exit 1); the other phases still need core", async () => {
    fake.state.refs[CORE] = [{ name: "refs/tags/v0.1.0", objectId: "b".repeat(40) }];
    fake.state.identities = fake.state.identities.filter((i: J) => i.id !== GROUPS.validUsers.id && i.id !== GROUPS.collectionBuild.id);
    const r = await bs("plan", "core");
    assert.equal(r.code, 1);
    assert.match(r.stdout, /blocked repo-acl {12}core: Create tag denied to \[contoso\]\\Project Collection Build Service Accounts {2}\(\[contoso\]\\Project Collection Build Service Accounts not found\.\)/);
    assert.match(r.stdout, /blocked tag-acl {13}core refs\/tags\/v0\.1\.0: .*\(\[Platform\]\\Project Valid Users, \[contoso\]\\Project Collection Build Service Accounts not found\.\)/);
    delete fake.state.repos["Platform/core"];
    const pipeline = await bs("plan", "pipeline");
    assert.equal(pipeline.code, 1);
    assert.match(pipeline.stderr, /repository Platform\/core not found/);
  });

  it("usage: the phase core is listed, a wrong phase exits 2", async () => {
    const r = await bs("plan", "mirror");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--phase must be projects, core, config, connections, pipeline, grants or policies/);
  });
});

describe("bootstrap outputs and names", () => {
  it("reads ARM outputs, the whole show output and plain values", () => {
    const arm = outputs("prod", ID.provProd, true);
    const a = parseBootstrapOutputs(arm, "x");
    assert.equal(a.adoAutomationIdentity!.principalId, AUTOMATION_OID);
    assert.deepEqual(parseBootstrapOutputs({ properties: { outputs: arm } }, "x"), a);
    assert.equal(parseBootstrapOutputs(outputs("nonprod", ID.provNonprod, false), "x").adoAutomationIdentity, null);
    assert.throws(() => parseBootstrapOutputs({ ...arm, tenantId: { type: "String", value: "x" } }, "x"), /tenantId must be a GUID/);
    assert.throws(() => parseBootstrapOutputs({ ...arm, provisioningIdentity: { type: "Object" } }, "x"), /has no provisioningIdentity/);
  });

  it("reads the Entra identity and resource group, null without instanceIdentities and in older outputs", () => {
    const a = parseBootstrapOutputs(outputs("prod", ID.provProd, true), "x");
    assert.deepEqual(a.entraProvisioningIdentity, { name: "id-contoso-entra-provisioning", clientId: ID.entra, principalId: "00000000-0000-0000-0000-00000000f032" });
    assert.equal(a.entraResourceGroup, "rg-contoso-entra");
    const none = parseBootstrapOutputs(outputs("nonprod", ID.provNonprod, false), "x");
    assert.deepEqual([none.entraProvisioningIdentity, none.entraResourceGroup], [null, null]);
    const legacy = outputs("prod", ID.provProd, true, true);
    assert.ok(!("entraProvisioningIdentity" in legacy) && !("entraResourceGroup" in legacy));
    const old = parseBootstrapOutputs(legacy, "x");
    assert.deepEqual([old.entraProvisioningIdentity, old.entraResourceGroup, old.adoAutomationIdentity!.clientId], [null, null, ID.ado]);
    assert.equal(parseBootstrapOutputs({ ...legacy, entraResourceGroup: { type: "String" } }, "x").entraResourceGroup, null);
    assert.throws(() => parseBootstrapOutputs({ ...legacy, entraProvisioningIdentity: { type: "Object", value: { name: "x", clientId: "nope", principalId: ID.entra } } }, "x"), /entraProvisioningIdentity must be \{ name, clientId, principalId \}/);
    assert.throws(() => parseBootstrapOutputs({ ...legacy, entraResourceGroup: { type: "String", value: "" } }, "x"), /entraResourceGroup must be a resource group name or null/);
    assert.throws(() => parseBootstrapOutputs({ ...legacy, entraResourceGroup: 42 }, "x"), /entraResourceGroup must be a resource group name or null/);
  });

  it("reads the portal identity, null without instanceIdentities and in older outputs", () => {
    const a = parseBootstrapOutputs(outputs("prod", ID.provProd, true, false, true), "x");
    assert.deepEqual(a.portalIdentity, { name: "id-contoso-portal", clientId: ID.portal, principalId: PORTAL_OID });
    assert.equal(parseBootstrapOutputs(outputs("nonprod", ID.provNonprod, false, false, true), "x").portalIdentity, null);
    assert.equal(parseBootstrapOutputs(outputs("prod", ID.provProd, true), "x").portalIdentity, null);
    assert.throws(() => parseBootstrapOutputs({ ...outputs("prod", ID.provProd, true), portalIdentity: { type: "Object", value: { name: "id-contoso-portal", clientId: ID.portal, principalId: "nope" } } }, "x"), /portalIdentity must be \{ name, clientId, principalId \}/);
  });

  it("platform names match infra/modules/naming/naming.bicep", () => {
    const text = readFileSync(join(REPO_ROOT, "infra", "modules", "naming", "naming.bicep"), "utf8");
    const body = (fn: string): string => {
      const m = new RegExp(`func ${fn}\\([^)]*\\) string =>\\s*([^\\n]+(?:\\n {4}[^\\n]+)*)`).exec(text);
      assert.ok(m, fn);
      return m[1]!;
    };
    const literal = (fn: string): string => {
      const m = /'([^']*\$\{[^']*)'/.exec(body(fn));
      assert.ok(m, fn);
      return m[1]!.replace(/\$\{p\(prefix\)\}/g, "PREFIX").replace(/\$\{e\(env\)\}/g, "ENV").replace(/\$\{purpose\}/g, "PURPOSE");
    };
    assert.equal(literal("identitiesResourceGroup"), identitiesResourceGroup("PREFIX", "ENV"));
    assert.equal(literal("identitiesLock"), identitiesLock("PREFIX"));
    assert.equal(literal("provisioningServiceConnection"), provisioningServiceConnection("ENV"));
    assert.equal(literal("instanceServiceConnection").replace("PURPOSE", "ado"), instanceServiceConnection("ado"));
    assert.match(body("instanceServiceConnection"), /contains\(\['ado', 'entra'\], purpose\)/);
    assert.equal(instanceServiceConnection("entra"), "sc-platform-entra");
    assert.throws(() => instanceServiceConnection("portal" as "ado"));
  });
});
