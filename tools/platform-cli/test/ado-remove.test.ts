import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { CLI, FIXTURES, tmp } from "./helpers.js";
import { CALLER, FakeAdo, TOKEN } from "./ado-fake.js";
import { adoServiceConnection } from "../src/ado/names.js";
import { ADO_REPOSITORY_NAME_MAX, DELETED_REPOSITORY_NAME_TRIES, deletedRepositoryName } from "../src/ado/remove.js";

// `platform ado remove` and the delivery pipeline's queueStatus (ADR-0056).

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const fake = new FakeAdo();
const P = join(FIXTURES, "provisioning", "config");
const SP = { nonprod: "00000000-0000-0000-0000-0000000000d1", prod: "00000000-0000-0000-0000-0000000000d2" };
const DEMO_APP = join(P, "apps", "demo", "app.yaml");
let instance = "";
const lz: Record<string, string> = {};

before(async () => {
  await fake.start();
  const doc = parse(readFileSync(join(P, "instance.yaml"), "utf8")) as J;
  doc.scm.azureDevOps.organizationUrl = fake.orgUrl;
  doc.approvals.platformTeam.displayName = "sg-platform-team";
  const dir = tmp("pc-ado-remove-");
  instance = join(dir, "instance.yaml");
  writeFileSync(instance, stringify(doc));
  for (const env of ["nonprod", "prod"] as const) {
    lz[env] = join(dir, `lz-${env}.json`);
    writeFileSync(lz[env]!, JSON.stringify({ deliveryIdentityClientId: { type: "String", value: SP[env] }, runtimeIdentityClientId: { type: "String", value: "x" } }));
  }
});
after(() => fake.stop());
beforeEach(() => fake.reset("empty"));

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(SYSTEM_ACCESSTOKEN|AZURE_DEVOPS_TOKEN)$/.test(k))) as Record<string, string>;
  env.AZURE_DEVOPS_TOKEN = TOKEN;
  env.NO_COLOR = "1";
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, "ado", ...args], { env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    p.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const lzArgs = (): string[] => ["--lz-outputs", `nonprod=${lz.nonprod}`, "--lz-outputs", `prod=${lz.prod}`];
const apply = (phase: "resources" | "pipelines", app = DEMO_APP) => run(["apply", "--instance", instance, "--app", app, "--phase", phase, "--org-url", fake.orgUrl, ...lzArgs()]);
/** `ado remove`; `gone`: the environments whose landing zone is gone (step 2, every one by default). */
const remove = (action: "plan" | "apply", app: string, gone: string[] = ["nonprod", "prod"]) =>
  run(["remove", action, "--instance", instance, "--app", app, "--org-url", fake.orgUrl, ...lzArgs(), ...gone.flatMap((e) => ["--landing-zone-gone", e])]);
const lines = (stdout: string, status: string): string[] => stdout.split("\n").filter((l) => l.startsWith(status.padEnd(8)));

/** apps/demo/app.yaml with a decommission block; `change` edits the definition first (e.g. a starter repository). */
function decommissioned(change: (doc: J) => void = () => undefined): string {
  const dir = join(tmp("pc-ado-decom-"), "apps", "demo");
  mkdirSync(dir, { recursive: true });
  const doc = parse(readFileSync(DEMO_APP, "utf8")) as J;
  doc.decommission = { requestedOn: "2026-10-01", deleteAfter: "2026-10-31", reason: "Replaced.", requestedBy: { objectId: "00000000-0000-0000-0000-00000000e001", displayName: "Jane Owner" } };
  change(doc);
  writeFileSync(join(dir, "app.yaml"), stringify(doc));
  return join(dir, "app.yaml");
}
const starter = (doc: J): void => void (doc.repository.template = "node-ts");

/** The test instance with instance.yaml decommission.repository delete. */
function deletingInstance(): string {
  const doc = parse(readFileSync(instance, "utf8")) as J;
  doc.decommission = { ...(doc.decommission ?? {}), repository: "delete" };
  const file = join(tmp("pc-ado-remove-delete-"), "instance.yaml");
  writeFileSync(file, stringify(doc));
  return file;
}
const removeWith = (inst: string, action: "plan" | "apply", app: string) =>
  run(["remove", action, "--instance", inst, "--app", app, "--org-url", fake.orgUrl, ...lzArgs(), "--landing-zone-gone", "nonprod", "--landing-zone-gone", "prod"]);
const repoNames = (): string[] => Object.keys(fake.state.repos as J).filter((k) => k.startsWith("Apps/")).sort();
/** Another repository in the apps project (an earlier app's renamed one, or one a person made). */
const addRepo = (name: string, n: number): void => {
  fake.state.repos[`Apps/${name}`] = { ...fake.state.repos["Apps/demo"], id: `00000000-0000-0000-0000-0000000${String(n).padStart(5, "0")}`, name };
};
const repoRenames = (): unknown[] => fake.requests.filter((r) => r.method === "PATCH" && r.path.includes("/_apis/git/repositories/")).map((r) => r.body);
const GONE = /^ok +repository +Apps\/demo {2}\(gone: no repository with this name \(renamed or deleted, by a run or by hand\)\)$/m;

describe("platform ado remove and the disabled pipeline (ADR-0056)", () => {
  it("pipelines: a decommissioned app's delivery pipeline is disabled, an active app's enabled again", async () => {
    assert.equal((await apply("resources")).code, 0);
    assert.equal((await apply("pipelines")).code, 0);
    const off = await apply("pipelines", decommissioned());
    assert.equal(off.code, 0, off.stdout + off.stderr);
    assert.match(off.stdout, /^update {2}pipeline-queue +\\apps\\delivery-demo: disabled {2}\(enabled -> disabled\)/m);
    const id = Object.keys(fake.state.definitions)[0]!;
    assert.equal(fake.state.definitions[id].queueStatus, "disabled");
    // Azure DevOps refuses to preview a disabled pipeline (HTTP 500, sandbox run 3412): not previewed, the app doesn't fail.
    assert.match(off.stdout, /^ok {6}pipeline-yaml +\\apps\\delivery-demo: YAML {2}\(not previewed: the app is being decommissioned/m);
    assert.ok(!/FAILED/.test(off.stdout), off.stdout);
    fake.requests = [];
    const again = await apply("pipelines", decommissioned());
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.ok(!fake.requests.some((r) => r.path.endsWith("/preview")), "a decommissioned app's pipeline is not previewed");
    // Cancel: enabled first, then previewed (the preview of a disabled pipeline would fail).
    fake.requests = [];
    const on = await apply("pipelines");
    assert.equal(on.code, 0, on.stdout + on.stderr);
    assert.ok(!/FAILED/.test(on.stdout), on.stdout);
    assert.match(on.stdout, /^update {2}pipeline-queue +\\apps\\delivery-demo: enabled {2}\(disabled -> enabled\)/m);
    assert.equal(fake.state.definitions[id].queueStatus, "enabled");
    const order = fake.requests.filter((r) => r.method !== "GET").map((r) => `${r.method} ${r.path}`);
    assert.ok(order.indexOf(`PUT /contoso/Platform/_apis/build/definitions/${id}`) < order.indexOf(`POST /contoso/Platform/_apis/pipelines/${id}/preview`), order.join("\n"));
  });

  it("remove: deletes the pipeline, connections and environments; gone is done; renames the (unmanaged) repository", async () => {
    assert.equal((await apply("resources")).code, 0);
    assert.equal((await apply("pipelines")).code, 0);
    const app = decommissioned();
    const plan = await remove("plan", app);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.equal(lines(plan.stdout, "extra").length, 1 + 2 + 2 + 1, plan.stdout);
    assert.deepEqual(fake.requests.filter((r) => r.method === "DELETE"), []);
    const a = await remove("apply", app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(fake.state.endpoints, []);
    assert.deepEqual(fake.state.environments, []);
    assert.deepEqual(fake.state.definitions, {});
    assert.match(a.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01 \(kept; its name is free for a new app; the team's own repository: renamed, never deleted\)\)/m);
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01"]);
    const again = await remove("apply", app);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.equal(lines(again.stdout, "extra").length, 0);
  });

  it("remove (sandbox run 3441): an environment Azure DevOps created again by itself as this identity is deleted; one created by someone else is left alone", async () => {
    assert.equal((await apply("resources")).code, 0);
    assert.equal((await apply("pipelines")).code, 0);
    const app = decommissioned();
    assert.equal((await remove("apply", app)).code, 0);
    assert.deepEqual(fake.state.environments, []);
    // Azure DevOps creates demo-nonprod again, as the automation identity, with its own description.
    (fake.state.environments as J[]).push({ id: 901, name: "demo-nonprod", description: "Automatically created environment", createdBy: { id: CALLER.id, displayName: "id-contoso-ado-automation" } });
    const again = await remove("apply", app);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, /^extra +environment +demo-nonprod {2}\(id 901: delete \(with its checks and deployment history\); Azure DevOps created it again by itself as this identity\)/m);
    assert.deepEqual(fake.state.environments, []);
    // The same text, created by a person: not provably the platform's, left alone (exit 1, retried later).
    (fake.state.environments as J[]).push({ id: 902, name: "demo-nonprod", description: "Automatically created environment", createdBy: { id: "00000000-0000-0000-0000-0000000000e7", displayName: "Someone" } });
    const someone = await remove("apply", app);
    assert.equal(someone.code, 1, someone.stdout);
    assert.match(someone.stdout, /^blocked +environment +demo-nonprod {2}\(id 902 has another description than the platform writes: left alone\)/m);
    assert.equal(fake.state.environments.length, 1);
  });

  it("remove, step 1 (sandbox run 3421): the connections wait for the landing zone (a warning, exit 0); step 2 deletes them", async () => {
    assert.equal((await apply("resources")).code, 0);
    assert.equal((await apply("pipelines")).code, 0);
    const app = decommissioned();
    const step1 = await remove("apply", app, []);
    assert.equal(step1.code, 0, step1.stdout + step1.stderr);
    const waits = lines(step1.stdout, "warn");
    assert.equal(waits.length, 2, step1.stdout);
    for (const [i, name] of ["sc-demo-nonprod", "sc-demo-prod"].entries()) {
      assert.match(waits[i]!, new RegExp(`^warn +service-connection +${name} {2}\\(id [0-9a-f-]+: waits for the landing zone \\(its federated credential goes with the resource group\\); deleted after it, in step 2\\)$`));
    }
    assert.equal(fake.state.endpoints.length, 2, "Azure DevOps would refuse: the federated credentials still exist");
    assert.deepEqual(fake.state.environments, []);
    assert.deepEqual(fake.state.definitions, {});
    // Step 2 in nonprod only: its connection goes, prod's still waits.
    const nonprod = await remove("apply", app, ["nonprod"]);
    assert.equal(nonprod.code, 0, nonprod.stdout + nonprod.stderr);
    assert.deepEqual(fake.state.endpoints.map((e: J) => e.name), ["sc-demo-prod"]);
    const prod = await remove("apply", app, ["prod"]);
    assert.equal(prod.code, 0, prod.stdout + prod.stderr);
    assert.deepEqual(fake.state.endpoints, []);
    const bad = await remove("plan", app, ["qa"]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--landing-zone-gone qa is not an environment of the app/);
  });

  // ADR-0061 section 4: the starter's name is free again. Verify in sandbox: DECOM-22.
  it("remove: a kept starter repository is renamed <name>-deleted-<requestedOn>; without the old name it is done (ok)", async () => {
    const app = decommissioned(starter);
    const plan = await remove("plan", app);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01 \(kept; its name is free for a new app\)\)$/m);
    assert.deepEqual(repoNames(), ["Apps/demo"]);
    const a = await remove("apply", app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01"]);
    const patch = fake.requests.find((r) => r.method === "PATCH" && r.path.includes("/_apis/git/repositories/"));
    assert.deepEqual(patch?.body, { name: "demo-deleted-2026-10-01" });
    assert.ok(!fake.requests.some((r) => r.method === "DELETE" && r.path.includes("/_apis/git/repositories/")), "keep: never deleted");
    // Step 2 runs the removal again: no repository has the old name, so it is done; nothing written.
    fake.requests = [];
    const again = await remove("apply", app);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, GONE);
    assert.ok(!fake.requests.some((r) => r.method !== "GET"), "idempotent");
    assert.ok(!fake.requests.some((r) => r.path.includes("/_apis/git/repositories/demo-deleted")), "a new name is never looked up");
  });

  it("remove with decommission.repository delete: renamed first, then deleted; one an earlier run renamed is never deleted later", async () => {
    const inst = deletingInstance();
    const app = decommissioned(starter);
    const plan = await removeWith(inst, "plan", app);
    assert.match(plan.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01, then delete \(the project's recycle bin keeps it for a while/m);
    const a = await removeWith(inst, "apply", app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(repoNames(), []);
    const writes = fake.requests.filter((r) => r.method !== "GET" && r.path.includes("/_apis/git/repositories/")).map((r) => r.method);
    assert.deepEqual(writes, ["PATCH", "DELETE"], "the rename before the delete");
    // The rename succeeds and the delete fails: the row fails and says what is left to do by hand.
    fake.reset("empty");
    fake.failures.push({ method: "DELETE", path: "/_apis/git/repositories/", status: 403, message: "TF401027: You need the Git 'DeleteRepository' permission to perform this action." });
    const failed = await removeWith(inst, "apply", app);
    assert.equal(failed.code, 1, failed.stdout + failed.stderr);
    assert.match(failed.stdout, /^extra +repository +Apps\/demo {2}\(.*\) {2}\[FAILED: renamed to demo-deleted-2026-10-01, then the delete failed: DELETE .* returned HTTP 403.* Later runs count it done \(its old name is gone\) and don't delete it: delete Apps\/demo-deleted-2026-10-01 by hand/m);
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01"]);
    // The next run: no repository has the old name, so it is done. The renamed one is never looked up
    // or deleted (with the suffixes, a name of the rule can be another app's kept repository).
    fake.failures = [];
    fake.requests = [];
    const resumed = await removeWith(inst, "apply", app);
    assert.equal(resumed.code, 0, resumed.stdout + resumed.stderr);
    assert.match(resumed.stdout, GONE);
    assert.ok(!fake.requests.some((r) => r.method !== "GET"), "nothing deleted");
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01"]);
  });

  it("remove: a refused rename only reports (warn, exit 0); with delete the repository is still deleted", async () => {
    fake.failures.push({ method: "PATCH", path: "/_apis/git/repositories/", status: 403, message: "TF401027: You need the Git 'RenameRepository' permission to perform this action." });
    const kept = await remove("apply", decommissioned(starter));
    assert.equal(kept.code, 0, kept.stdout + kept.stderr);
    assert.match(kept.stdout, /^warn +repository +Apps\/demo {2}\(kept as demo: Azure DevOps refused the rename to demo-deleted-2026-10-01 \(PATCH .* returned HTTP 403.*\); its name stays taken\. Rename it by hand/m);
    assert.ok(!/FAILED/.test(kept.stdout), kept.stdout);
    assert.deepEqual(repoNames(), ["Apps/demo"]);
    const deleted = await removeWith(deletingInstance(), "apply", decommissioned(starter));
    assert.equal(deleted.code, 0, deleted.stdout + deleted.stderr);
    assert.match(deleted.stdout, /^warn +repository +Apps\/demo {2}\(deleted without the rename: Azure DevOps refused the rename/m);
    assert.deepEqual(repoNames(), []);
  });

  it("remove: a new name longer than Azure DevOps allows is never cut (blocked, exit 1); renamed by hand, the old name is gone (ok)", async () => {
    const long = "a".repeat(46);
    const longRepo = (): void => {
      fake.state.repos[`Apps/${long}`] = { ...fake.state.repos["Apps/demo"], id: "00000000-0000-0000-0000-00000000a046", name: long };
    };
    longRepo();
    const tooLongApp = decommissioned((doc) => ((doc.repository.name = long), starter(doc)));
    const tooLong = await remove("apply", tooLongApp);
    assert.equal(tooLong.code, 1, tooLong.stdout + tooLong.stderr);
    assert.match(tooLong.stdout, new RegExp(`^blocked repository +Apps/${long} {2}\\(the new name ${long}-deleted-2026-10-01 would have 65 characters, Azure DevOps allows 64; it is never cut`, "m"));
    assert.ok(!fake.requests.some((r) => r.method === "PATCH"));
    // A person renamed it (runbook): the next run finds nothing under the old name and goes on.
    const byHand = fake.state.repos[`Apps/${long}`];
    delete fake.state.repos[`Apps/${long}`];
    fake.state.repos["Apps/aaaa-deleted-2026-10-01"] = { ...byHand, name: "aaaa-deleted-2026-10-01" };
    const after = await remove("apply", tooLongApp);
    assert.equal(after.code, 0, after.stdout + after.stderr);
    assert.match(after.stdout, new RegExp(`^ok +repository +Apps/${long} {2}\\(gone: no repository with this name \\(renamed or deleted, by a run or by hand\\)\\)$`, "m"));
    const fits = await remove("plan", decommissioned((doc) => ((doc.repository.name = "a".repeat(45)), starter(doc))));
    assert.ok(!/^blocked +repository/m.test(fits.stdout), fits.stdout);
    // Neither the repository nor its project is there (or visible): gone, the unit finishes.
    fake.reset("empty");
    fake.state.projects = (fake.state.projects as J[]).filter((x) => x.name !== "Apps");
    const noProject = await remove("apply", decommissioned());
    assert.equal(noProject.code, 0, noProject.stdout + noProject.stderr);
    assert.match(noProject.stdout, /^ok +repository +Apps\/demo {2}\(gone: the project Apps isn't there \(or this identity can't see it\), nothing to rename\)$/m);
  });

  // ADR-0061 section 4, amended 2026-11-16: a bring-your-own repository is renamed too, never deleted. Verify in sandbox: DECOM-24.
  it("remove: a bring-your-own repository is renamed <name>-deleted-<requestedOn> and never deleted, also with decommission.repository delete", async () => {
    for (const inst of [instance, deletingInstance()]) {
      fake.reset("empty");
      const app = decommissioned((doc) => void (doc.repository.template = "byo"));
      const plan = await removeWith(inst, "plan", app);
      assert.equal(plan.code, 0, plan.stdout + plan.stderr);
      assert.match(plan.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01 \(kept; its name is free for a new app; the team's own repository: renamed, never deleted\)\)$/m);
      const byo = await removeWith(inst, "apply", app);
      assert.equal(byo.code, 0, byo.stdout + byo.stderr);
      assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01"]);
      const writes = fake.requests.filter((r) => r.method !== "GET" && r.path.includes("/_apis/git/repositories/"));
      assert.deepEqual(writes.map((r) => [r.method, r.body]), [["PATCH", { name: "demo-deleted-2026-10-01" }]], "renamed, never deleted");
      fake.requests = [];
      const again = await removeWith(inst, "apply", app);
      assert.equal(again.code, 0, again.stdout + again.stderr);
      assert.match(again.stdout, GONE);
      assert.ok(!fake.requests.some((r) => r.method !== "GET"), "idempotent");
    }
    // Deleted by hand before the delete phase: gone.
    fake.reset("empty");
    delete fake.state.repos["Apps/demo"];
    const gone = await remove("apply", decommissioned((doc) => void (doc.repository.template = "byo")));
    assert.equal(gone.code, 0, gone.stdout + gone.stderr);
    assert.match(gone.stdout, GONE);
    // The automation identity may not rename a repository it didn't create: only reported, the unit finishes.
    fake.reset("empty");
    fake.failures.push({ method: "PATCH", path: "/_apis/git/repositories/", status: 403, message: "TF401027: You need the Git 'RenameRepository' permission to perform this action." });
    const refused = await removeWith(deletingInstance(), "apply", decommissioned((doc) => void (doc.repository.template = "byo")));
    assert.equal(refused.code, 0, refused.stdout + refused.stderr);
    assert.match(refused.stdout, /^warn +repository +Apps\/demo {2}\(kept as demo: Azure DevOps refused the rename to demo-deleted-2026-10-01 /m);
    assert.deepEqual(repoNames(), ["Apps/demo"]);
    assert.ok(!fake.requests.some((r) => r.method === "DELETE" && r.path.includes("/_apis/git/repositories/")), "never deleted");
  });

  // ADR-0061 section 4: the name rule, incarnation and the next name after a 409 (sandbox run 3662).
  it("deletedRepositoryName: {name}-deleted-{requestedOn}, -i{incarnation} above 0, -2 … -9 for a later try; never cut", () => {
    assert.equal(deletedRepositoryName("demo", "2026-10-01"), "demo-deleted-2026-10-01");
    assert.equal(deletedRepositoryName("demo", "2026-10-01", 0), "demo-deleted-2026-10-01");
    assert.equal(deletedRepositoryName("demo", "2026-10-01", 1), "demo-deleted-2026-10-01-i1");
    assert.equal(deletedRepositoryName("demo", "2026-10-01", 12, 2), "demo-deleted-2026-10-01-i12-2");
    assert.equal(deletedRepositoryName("demo", "2026-10-01", 0, DELETED_REPOSITORY_NAME_TRIES), "demo-deleted-2026-10-01-9");
    assert.deepEqual(deletedRepositoryName("demo", undefined), { problem: "the app has no decommission.requestedOn to name its kept repository with" });
    assert.match((deletedRepositoryName("demo", "2026-10-01", -1) as { problem: string }).problem, /incarnation must be an integer >= 0/);
    assert.throws(() => deletedRepositoryName("demo", "2026-10-01", 0, DELETED_REPOSITORY_NAME_TRIES + 1), /internal: rename attempt/);
    // The length rule holds for every candidate: 44 + 19 = 63 fits, its -2 (65) doesn't, and -i1 counts too.
    const n44 = "a".repeat(44);
    assert.equal((deletedRepositoryName(n44, "2026-10-01") as string).length, 63);
    assert.match((deletedRepositoryName(n44, "2026-10-01", 0, 2) as { problem: string }).problem, new RegExp(`^the new name ${n44}-deleted-2026-10-01-2 would have 65 characters, Azure DevOps allows ${ADO_REPOSITORY_NAME_MAX}; it is never cut`));
    assert.match((deletedRepositoryName("a".repeat(45), "2026-10-01", 1) as { problem: string }).problem, /-deleted-2026-10-01-i1 would have 67 characters/);
  });

  it("remove (sandbox run 3662): a later incarnation deleted the same day gets -i{incarnation}, beside the earlier app's renamed repository", async () => {
    // The earlier app of the slug (incarnation 0) was deleted the same day: its repository has the base name.
    addRepo("demo-deleted-2026-10-01", 1);
    const app = decommissioned((doc) => void (doc.incarnation = 1));
    const plan = await remove("plan", app);
    assert.equal(plan.code, 0, plan.stdout + plan.stderr);
    assert.match(plan.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01-i1 \(kept; its name is free for a new app; the team's own repository: renamed, never deleted\)\)$/m);
    const a = await remove("apply", app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.deepEqual(repoRenames(), [{ name: "demo-deleted-2026-10-01-i1" }], "one rename, no 409");
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01", "Apps/demo-deleted-2026-10-01-i1"]);
    assert.equal(fake.state.repos["Apps/demo-deleted-2026-10-01"].id, "00000000-0000-0000-0000-000000000001", "the earlier app's repository is untouched");
  });

  it("remove: Azure DevOps has the new name already (409, TF400948): the next name -2; every one taken only reports (warn)", async () => {
    // Taken: the rename goes on with -2 and says so in a row of its own.
    addRepo("demo-deleted-2026-10-01", 1);
    const app = decommissioned(starter);
    const a = await remove("apply", app);
    assert.equal(a.code, 0, a.stdout + a.stderr);
    assert.match(a.stdout, /^extra +repository +Apps\/demo {2}\(id [0-9a-f-]+: rename to demo-deleted-2026-10-01 \(kept; its name is free for a new app\)\) {2}\[done\]$/m);
    assert.match(a.stdout, /^ok +repository +Apps\/demo {2}\(renamed to demo-deleted-2026-10-01-2: Azure DevOps has a repository named demo-deleted-2026-10-01 already\)$/m);
    assert.deepEqual(repoRenames(), [{ name: "demo-deleted-2026-10-01" }, { name: "demo-deleted-2026-10-01-2" }]);
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01", "Apps/demo-deleted-2026-10-01-2"]);
    assert.equal(fake.state.repos["Apps/demo-deleted-2026-10-01"].id, "00000000-0000-0000-0000-000000000001", "the other repository is untouched");
    fake.requests = [];
    const again = await remove("apply", app);
    assert.equal(again.code, 0, again.stdout + again.stderr);
    assert.match(again.stdout, GONE);
    assert.ok(!fake.requests.some((r) => r.method !== "GET"), "idempotent");

    // With decommission.repository delete: renamed to the next free name, then this repository is deleted.
    fake.reset("empty");
    addRepo("demo-deleted-2026-10-01", 1);
    addRepo("demo-deleted-2026-10-01-2", 2);
    const del = await removeWith(deletingInstance(), "apply", app);
    assert.equal(del.code, 0, del.stdout + del.stderr);
    assert.match(del.stdout, /^ok +repository +Apps\/demo {2}\(renamed to demo-deleted-2026-10-01-3: Azure DevOps has a repository named demo-deleted-2026-10-01 already\)$/m);
    assert.deepEqual(repoRenames(), [{ name: "demo-deleted-2026-10-01" }, { name: "demo-deleted-2026-10-01-2" }, { name: "demo-deleted-2026-10-01-3" }]);
    assert.deepEqual(repoNames(), ["Apps/demo-deleted-2026-10-01", "Apps/demo-deleted-2026-10-01-2"], "only this app's repository deleted");

    // Every name taken: kept as it is (warn, exit 0); with delete, deleted without the rename (warn).
    const all = ["demo-deleted-2026-10-01", ...Array.from({ length: DELETED_REPOSITORY_NAME_TRIES - 1 }, (_, i) => `demo-deleted-2026-10-01-${i + 2}`)];
    for (const inst of [instance, deletingInstance()]) {
      fake.reset("empty");
      all.forEach((n, i) => addRepo(n, i + 1));
      const r = await removeWith(inst, "apply", app);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.deepEqual(repoRenames(), all.map((name) => ({ name })), "nine tries, then no more");
      if (inst === instance) {
        assert.match(r.stdout, /^warn +repository +Apps\/demo {2}\(kept as demo: Azure DevOps has a repository with each name from demo-deleted-2026-10-01 to demo-deleted-2026-10-01-9 already, so it refused the rename; its name stays taken\. Rename it by hand/m);
        assert.ok(repoNames().includes("Apps/demo"));
      } else {
        assert.match(r.stdout, /^warn +repository +Apps\/demo {2}\(deleted without the rename: Azure DevOps has a repository with each name from demo-deleted-2026-10-01 to demo-deleted-2026-10-01-9 already/m);
        assert.ok(!repoNames().includes("Apps/demo"));
      }
      assert.ok(!/FAILED/.test(r.stdout), r.stdout);
      assert.equal(repoNames().filter((n) => n.startsWith("Apps/demo-deleted-")).length, DELETED_REPOSITORY_NAME_TRIES, "the others untouched");
    }

    // Another refusal than "the name exists" ends the tries at once.
    fake.reset("empty");
    fake.failures.push({ method: "PATCH", path: "/_apis/git/repositories/", status: 403, message: "TF401027: You need the Git 'RenameRepository' permission to perform this action." });
    const refused = await remove("apply", app);
    assert.equal(refused.code, 0, refused.stdout + refused.stderr);
    assert.deepEqual(repoRenames(), [{ name: "demo-deleted-2026-10-01" }]);
  });

  it("remove: the next name after a 409 that would be longer than Azure DevOps allows is never cut (blocked, exit 1)", async () => {
    const n44 = "a".repeat(44);
    for (const inst of [instance, deletingInstance()]) {
      fake.reset("empty");
      addRepo(n44, 1);
      addRepo(`${n44}-deleted-2026-10-01`, 2);
      const app = decommissioned((doc) => ((doc.repository.name = n44), starter(doc)));
      const r = await removeWith(inst, "apply", app);
      assert.equal(r.code, 1, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`^blocked repository +Apps/${n44} {2}\\(Azure DevOps has a repository named ${n44}-deleted-2026-10-01 already, and the new name ${n44}-deleted-2026-10-01-2 would have 65 characters, Azure DevOps allows 64; it is never cut: rename the repository by hand`, "m"));
      assert.deepEqual(repoRenames(), [{ name: `${n44}-deleted-2026-10-01` }], "never a cut name");
      assert.ok(repoNames().includes(`Apps/${n44}`), "neither renamed nor deleted");
      assert.ok(!fake.requests.some((r) => r.method === "DELETE" && r.path.includes("/_apis/git/repositories/")));
    }
  });

  it("remove: a connection of an earlier delivery identity that this automation identity made goes at once (sandbox run 3763)", async () => {
    assert.equal((await apply("resources")).code, 0);
    const sc = fake.state.endpoints.find((e: J) => e.name === adoServiceConnection("demo", "prod"));
    sc.authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    const r = await remove("apply", decommissioned());
    assert.match(r.stdout, /^extra +service-connection +sc-demo-prod {2}\(id [0-9a-f-]+: delete \(it federates an earlier delivery identity of the app, which is gone\)\) {2}\[done\]$/m);
    assert.ok(!fake.state.endpoints.some((e: J) => e.name === "sc-demo-prod"));
  });

  it("remove: a connection that federates another identity and that someone else made, or for another subscription, is left alone (blocked, exit 1); an active app is refused", async () => {
    assert.equal((await apply("resources")).code, 0);
    const sc = fake.state.endpoints.find((e: J) => e.name === adoServiceConnection("demo", "prod"));
    sc.authorization.parameters.serviceprincipalid = "00000000-0000-0000-0000-0000000000ff";
    sc.createdBy = { id: "00000000-0000-0000-0000-0000000000e7", displayName: "Someone" };
    const r = await remove("apply", decommissioned());
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^blocked service-connection +sc-demo-prod {2}\(id [0-9a-f-]+ federates another identity than the app's delivery identity: left alone\)$/m);
    assert.ok(fake.state.endpoints.some((e: J) => e.name === "sc-demo-prod"));
    sc.createdBy = { id: CALLER.id };
    sc.data.subscriptionId = "00000000-0000-0000-0000-00000000c0ff";
    const other = await remove("apply", decommissioned());
    assert.match(other.stdout, /^blocked service-connection +sc-demo-prod {2}\(id [0-9a-f-]+ federates another identity than the app's delivery identity: left alone\)$/m);
    assert.ok(fake.state.endpoints.some((e: J) => e.name === "sc-demo-prod"));
    const active = await remove("plan", DEMO_APP);
    assert.equal(active.code, 1);
    assert.match(active.stderr, /is not being decommissioned/);
  });
});
