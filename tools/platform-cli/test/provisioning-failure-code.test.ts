import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, REPO_ROOT, tmp } from "./helpers.js";
import { PIPE } from "./pipeline-helpers.js";
import { PROVISIONING_FAILURE_IDS } from "../src/explanations.js";
import { failureCodeOf, failureRows, formatFailures, MAX_FAILURE_ROWS } from "../src/provisioning/failure-code.js";

// ADR-0064 (US04.10): the failure code of a failed provisioning deployment, from its log. The cloud
// codes mapped are the ones seen in the sandbox or documented by Microsoft (failure-code.ts); the
// envelopes are az's JSON and text forms, as in the deploy-error fixtures.

const DEPLOY_ERRORS = join(PIPE, "deploy-errors");
const nested = (code: string, message = "m"): string =>
  `ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","message":"At least one resource deployment operation failed.","details":[{"code":"ResourceDeploymentFailure","message":"x","details":[{"code":"${code}","message":"${message}"}]}]}}`;

describe("provisioning failure-code", () => {
  it("maps the seen and documented cloud codes, and anything else to PE001", () => {
    assert.equal(failureCodeOf(nested("SkuNotAvailable", "Specified SKU is not available in location."), "lz"), "PE005");
    assert.equal(failureCodeOf(nested("AuthorizationFailed", "does not have authorization to perform action 'Microsoft.App/managedEnvironments/read'"), "release"), "PE006");
    assert.equal(failureCodeOf("ERROR: (LinkedAuthorizationFailed) The client has permission to perform action on scope, however it does not have permission on the linked scope(s).\nCode: LinkedAuthorizationFailed\nMessage: x\n", "release"), "PE006");
    assert.equal(failureCodeOf(nested("RequestDisallowedByPolicy", "Resource was disallowed by policy."), "lz"), "PE007");
    // Sandbox run 3727: the resource group deleted by hand, the Joiner assignment on the CAE left behind.
    assert.equal(failureCodeOf(nested("RoleAssignmentUpdateNotPermitted", "Tenant ID, application ID, principal ID, and scope are not allowed to be updated."), "lz"), "PE010");
    assert.equal(failureCodeOf(nested("InvalidTemplate"), "lz"), "PE001");
    assert.equal(failureCodeOf("no error code at all", "lz"), "PE001");
    assert.equal(failureCodeOf("", "frontdoor"), "PE001");
  });

  it("the policy wins over a permission, a permission over capacity", () => {
    const both = `ERROR: {"error":{"code":"DeploymentFailed","details":[{"code":"SkuNotAvailable","message":"a"},{"code":"AuthorizationFailed","message":"b"},{"code":"RequestDisallowedByPolicy","message":"c"}]}}`;
    assert.equal(failureCodeOf(both, "lz"), "PE007");
    assert.equal(failureCodeOf(`ERROR: {"error":{"code":"DeploymentFailed","details":[{"code":"SkuNotAvailable","message":"a"},{"code":"AuthorizationFailed","message":"b"}]}}`, "lz"), "PE006");
  });

  it("errors that are only retried give PE004 once the retries ran out; a mix with another error doesn't", () => {
    for (const f of readdirSync(DEPLOY_ERRORS).filter((x) => x.startsWith("retry-"))) {
      assert.equal(failureCodeOf(readFileSync(join(DEPLOY_ERRORS, f), "utf8"), "release"), "PE004", f);
    }
    assert.equal(failureCodeOf(readFileSync(join(DEPLOY_ERRORS, "fail-mixed.log"), "utf8"), "release"), "PE001");
    assert.equal(failureCodeOf(readFileSync(join(DEPLOY_ERRORS, "fail-authorization-failed.log"), "utf8"), "release"), "PE006");
  });

  it("Graph's Authorization_RequestDenied is PE008 for the Entra registration only (ENT-2)", () => {
    const graph = `ERROR: {"error":{"code":"DeploymentFailed","details":[{"code":"BadRequest","message":"Request failed: Authorization_RequestDenied: Insufficient privileges to complete the operation."}]}}`;
    assert.equal(failureCodeOf(graph, "entra"), "PE008");
    assert.equal(failureCodeOf(nested("Authorization_RequestDenied"), "entra"), "PE008");
    assert.equal(failureCodeOf(graph, "lz"), "PE001");
  });

  it("the command prints one code; a missing log or an unknown kind is refused", () => {
    const dir = tmp("pc-failure-");
    const log = join(dir, "arm.err");
    writeFileSync(log, nested("SkuNotAvailable"));
    const r = cli(["provisioning", "failure-code", "--log", log, "--kind", "lz"]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "PE005\n");
    assert.equal(cli(["provisioning", "failure-code", "--log", join(dir, "missing.err"), "--kind", "lz"]).code, 1);
    assert.equal(cli(["provisioning", "failure-code", "--log", log, "--kind", "vault"]).code, 2);
  });
});

describe("provisioning failures (the run summary's section)", () => {
  const file = (failures: unknown): string => {
    const dir = tmp("pc-failures-");
    const f = join(dir, "failures.json");
    writeFileSync(f, JSON.stringify({ schemaVersion: 1, runId: "42", failures }));
    return f;
  };

  it("one row per failure, then what to do per code; malformed rows left out, an unknown code shown with PE001's text", () => {
    const rows = failureRows(
      file([
        { slug: "hotel-inventory", environment: "nonprod", stage: "azure_nonprod", code: "PE009" },
        { slug: "room-booking", environment: null, stage: "validate", code: "PE002" },
        { slug: "Bad Slug", environment: "nonprod", stage: "azure_nonprod", code: "PE001" },
        { slug: "timesheets", environment: "NonProd", stage: "azure_nonprod", code: "PE001" },
        { slug: "timesheets", environment: "nonprod", stage: "azure_post_nonprod", code: "PE999" },
        { slug: "orders", environment: "nonprod", stage: "azure_nonprod", code: "##vso[task.setvariable]x" },
      ]),
    );
    assert.deepEqual(rows.map((r) => `${r.slug}/${r.environment}/${r.code}`), ["hotel-inventory/nonprod/PE009", "room-booking/null/PE002", "timesheets/nonprod/PE999", "orders/nonprod/PE001"]);
    const md = formatFailures(rows);
    assert.match(md, /^\n### Failures\n/);
    assert.match(md, /\| hotel-inventory \| nonprod \| azure_nonprod \| PE009 \| The name of the app's vault is still held by a deleted vault \|/);
    assert.match(md, /\| room-booking \| - \| validate \| PE002 \|/);
    assert.match(md, /- \*\*PE009\*\* .*raises generation in apps\/<slug>\/app\.yaml.* Runbook: docs\/runbooks\/key-vault-name-clash\.md\./);
    assert.match(md, /- \*\*PE999\*\* \(a code this core version doesn't know\) Setting up the app stopped/);
    assert.doesNotMatch(md, /##vso/);
  });

  it("nothing failed: no section; more than the row limit: a pointer to the artifact", () => {
    assert.equal(formatFailures([]), "");
    const many = Array.from({ length: MAX_FAILURE_ROWS + 3 }, (_, i) => ({ slug: `app${i}`, environment: "nonprod", stage: "azure_nonprod", code: "PE001" }));
    const md = formatFailures(failureRows(file(many)));
    assert.equal(md.split("\n").filter((l) => l.startsWith("| app")).length, MAX_FAILURE_ROWS);
    assert.match(md, /\.\.\. and 3 more row\(s\) \(artifact report, failures\.json\)\./);
  });

  it("the command renders the file and refuses one without a list", () => {
    const r = cli(["provisioning", "failures", "--input", file([{ slug: "hotel-inventory", environment: "prod", stage: "entra", code: "PE008" }])]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /\| hotel-inventory \| prod \| entra \| PE008 \| The platform may not change the app's sign-in registration \|/);
    const dir = tmp("pc-failures-");
    writeFileSync(join(dir, "bad.json"), "{}");
    assert.equal(cli(["provisioning", "failures", "--input", join(dir, "bad.json")]).code, 1);
  });
});

describe("the codes the pipeline scripts set", () => {
  it("every literal code of a provisioning script (prov_failure PExxx, code PExxx) is in the catalogue", () => {
    const dir = join(REPO_ROOT, "pipelines", "azure-devops", "scripts", "provisioning");
    const used = new Set<string>();
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sh"))) {
      for (const m of readFileSync(join(dir, f), "utf8").matchAll(/\bPE[0-9]{3}\b/g)) used.add(m[0]);
    }
    for (const m of readFileSync(join(REPO_ROOT, "tools", "platform-cli", "src", "provisioning", "plan-facts.ts"), "utf8").matchAll(/\bPE[0-9]{3}\b/g)) used.add(m[0]);
    assert.ok(used.has("PE001") && used.has("PE002") && used.has("PE003") && used.has("PE009"), [...used].join(" "));
    for (const code of used) assert.ok((PROVISIONING_FAILURE_IDS as readonly string[]).includes(code), `${code} is used by a script but not in PROVISIONING_FAILURE_IDS`);
  });
});
