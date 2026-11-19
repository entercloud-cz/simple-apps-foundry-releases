import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { cli, tmp } from "./helpers.js";
import { cmdEntraReconcile, disableInputs, entraRemovals, parseEntraInputs } from "../src/provisioning/entra-reconcile.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform provisioning entra-removals` and `entra-reconcile` (ADR-0033 amended 2026-11-11,
// US06.03): what the platform assigned and app.yaml no longer lists, and the Graph DELETEs.

const KEPT = "00000000-0000-0000-0000-0000000000a1";
const GONE_GROUP = "00000000-0000-0000-0000-0000000000a2";
const GONE_USER = "00000000-0000-0000-0000-0000000000a3";
const MANUAL = "00000000-0000-0000-0000-0000000000a4";
const APP_ID = "00000000-0000-0000-0000-0000000000c1";
const APP_OID = "00000000-0000-0000-0000-0000000000c2";
const SP_ID = "00000000-0000-0000-0000-0000000000c3";
const OTHER_SP = "00000000-0000-0000-0000-0000000000c9";
const ROLE_READER = "00000000-0000-0000-0000-0000000000e1";
const ROLE_EDITOR = "00000000-0000-0000-0000-0000000000e2";
const ROLE_ADMIN = "00000000-0000-0000-0000-0000000000e3";
const GRAPH_TOKEN = ["fake", "graph", "token", "g".repeat(24)].join("-");

const role = (value: string, extra: J = {}): J => ({ value, displayName: value, description: value, ...extra });

function inputs(over: J = {}): J {
  return {
    prefix: "contoso",
    environmentName: "dev",
    environmentKind: "nonprod",
    slug: "demo",
    incarnation: 0,
    appTitle: "Demo",
    hosts: ["ca-demo.example.io"],
    appRoles: [role("Reader"), role("Editor")],
    roleAssignments: [{ principalId: KEPT, role: "Reader" }],
    ...over,
  };
}

function record(params: J, state = "Succeeded"): J {
  const p = { prefix: "contoso", environmentName: "dev", environmentKind: "nonprod", slug: "demo", appTitle: "Demo", hosts: ["ca-demo.example.io"], ...params };
  return {
    name: "entra-demo-dev",
    properties: {
      provisioningState: state,
      templateHash: "123",
      parameters: Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { type: "Object", value: v }])),
      outputs: { clientId: { type: "String", value: APP_ID }, servicePrincipalId: { type: "String", value: OTHER_SP } },
    },
  };
}

describe("platform provisioning entra-removals", () => {
  it("lists the record's assignments and roles the inputs no longer have; a new registration has none", () => {
    const i = parseEntraInputs(inputs());
    assert.deepEqual(entraRemovals(i, undefined), { prefix: "contoso", slug: "demo", environmentName: "dev", assignments: [], roles: [] });
    const r = entraRemovals(
      i,
      record({
        appRoles: [role("Reader"), role("Editor"), role("Admin")],
        roleAssignments: [
          { principalId: KEPT.toUpperCase(), role: "Reader" }, // same principal, other case: kept
          { principalId: GONE_USER, role: "Admin" },
          { principalId: GONE_GROUP, role: "Reader" },
          { principalId: KEPT, role: "Editor" }, // role changed: the old one goes
        ],
      }),
    );
    assert.deepEqual(r.assignments, [
      { principalId: KEPT, role: "Editor" },
      { principalId: GONE_GROUP, role: "Reader" },
      { principalId: GONE_USER, role: "Admin" },
    ]);
    assert.deepEqual(r.roles, [{ value: "Admin", displayName: "Admin", description: "Admin", enabledInRecord: true }]);
    const first = disableInputs(i, r) as J;
    assert.deepEqual(first.appRoles, [role("Reader"), role("Editor"), role("Admin", { isEnabled: false })]);
    assert.deepEqual(first.roleAssignments, [{ principalId: KEPT, role: "Reader" }], "the first deployment declares the final assignments");
    assert.equal(first.slug, "demo");
  });

  it("ADR-0061: the inputs carry the incarnation; a record of another incarnation is the deleted app's (a record from before the parameter is 0)", () => {
    assert.throws(() => parseEntraInputs({ ...inputs(), incarnation: undefined }), /must carry the app's incarnation/);
    assert.throws(() => parseEntraInputs(inputs({ incarnation: -1 })), /must carry the app's incarnation/);
    const later = parseEntraInputs(inputs({ incarnation: 1 }));
    assert.throws(() => entraRemovals(later, record({ appRoles: [role("Reader")], roleAssignments: [] })), /another incarnation of the slug/);
    assert.deepEqual(entraRemovals(later, record({ incarnation: 1, appRoles: [role("Reader"), role("Editor")], roleAssignments: [] })).roles, []);
    assert.deepEqual(entraRemovals(parseEntraInputs(inputs()), record({ incarnation: 0, appRoles: [role("Reader"), role("Editor")], roleAssignments: [] })).roles, []);
  });

  it("a role the record already disabled is removed without another first deployment", () => {
    const i = parseEntraInputs(inputs());
    const r = entraRemovals(i, record({ appRoles: [role("Reader"), role("Editor"), role("Admin", { isEnabled: false })], roleAssignments: [] }));
    assert.deepEqual(r.roles, [{ value: "Admin", displayName: "Admin", description: "Admin", enabledInRecord: false }]);
    assert.equal(disableInputs(i, r), undefined);
  });

  it("refuses a record of another app, an invalid entry or inputs that set isEnabled", () => {
    const i = parseEntraInputs(inputs());
    assert.throws(() => entraRemovals(i, record({ slug: "other", appRoles: [], roleAssignments: [] })), /another instance, app or environment/);
    assert.throws(() => entraRemovals(i, record({ appRoles: [], roleAssignments: [{ principalId: "x", role: "Reader" }] })), /roleAssignments\[0\]/);
    assert.throws(() => parseEntraInputs(inputs({ appRoles: [role("Reader", { isEnabled: true })] })), /must not set isEnabled/);
  });

  it("CLI: writes the removals, the first deployment's inputs only when needed, and prints remove lines", () => {
    const dir = tmp("pc-entra-removals-");
    writeFileSync(join(dir, "inputs.json"), JSON.stringify(inputs()));
    writeFileSync(join(dir, "record.json"), JSON.stringify(record({ appRoles: [role("Reader"), role("Editor"), role("Admin")], roleAssignments: [{ principalId: GONE_GROUP, role: "Admin" }] })));
    const out = join(dir, "removals.json");
    const first = join(dir, "first.json");
    const r = cli(["provisioning", "entra-removals", "--inputs", join(dir, "inputs.json"), "--record", join(dir, "record.json"), "--output", out, "--disable-output", first]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /1 role assignment\(s\) and 1 app role\(s\) to remove/);
    assert.match(r.stdout, new RegExp(`remove  assignment: principal ${GONE_GROUP}, role Admin`));
    assert.match(r.stdout, /remove  app role Admin \(disabled first, then removed\)/);
    assert.equal(JSON.parse(readFileSync(out, "utf8")).assignments.length, 1);
    assert.ok(existsSync(first));

    const none = join(dir, "none.json");
    const first2 = join(dir, "first2.json");
    const n = cli(["provisioning", "entra-removals", "--inputs", join(dir, "inputs.json"), "--output", none, "--disable-output", first2]);
    assert.equal(n.code, 0, n.stderr);
    assert.match(n.stdout, /nothing to remove/);
    assert.ok(!existsSync(first2));
  });
});

// A fake Microsoft Graph: one application, its service principal and assignments (two pages).
class FakeGraph {
  server: Server | undefined;
  base = "";
  requests: { method: string; path: string; auth: string | undefined }[] = [];
  assignments: J[] = [];
  deleteStatus = 204;
  appRoles: J[] = [];

  reset(): void {
    this.requests = [];
    this.deleteStatus = 204;
    this.appRoles = [
      { id: ROLE_READER, value: "Reader", isEnabled: true },
      { id: ROLE_EDITOR, value: "Editor", isEnabled: true },
      { id: ROLE_ADMIN, value: "Admin", isEnabled: true },
    ];
    const a = (id: string, principalId: string, appRoleId: string, principalType = "Group", resourceId = SP_ID): J => ({ id, principalId, appRoleId, principalType, resourceId });
    this.assignments = [
      a("assignment-kept-0001", KEPT, ROLE_READER),
      a("assignment-group-0002", GONE_GROUP, ROLE_READER),
      a("assignment-user-00003", GONE_USER, ROLE_ADMIN, "User"),
      a("assignment-manual-004", MANUAL, ROLE_EDITOR, "User"), // made by hand: not in any record
      a("assignment-group-0005", GONE_GROUP, ROLE_EDITOR), // same principal, another role: stays
      a("assignment-spn-000006", GONE_USER, ROLE_ADMIN, "ServicePrincipal"),
    ];
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      this.requests.push({ method: req.method ?? "", path: decodeURIComponent(u.pathname), auth: req.headers.authorization });
      const send = (status: number, body?: J): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      const path = decodeURIComponent(u.pathname);
      if (req.method === "GET" && path === "/v1.0/applications(uniqueName='contoso-demo-dev')") {
        return send(200, { id: APP_OID, appId: APP_ID, uniqueName: "contoso-demo-dev", appRoles: this.appRoles });
      }
      if (req.method === "GET" && path === `/v1.0/servicePrincipals(appId='${APP_ID}')`) return send(200, { id: SP_ID, appId: APP_ID });
      if (req.method === "GET" && path === `/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo`) {
        const page = u.searchParams.get("page");
        if (page === "2") return send(200, { value: this.assignments.slice(3) });
        return send(200, { value: this.assignments.slice(0, 3), "@odata.nextLink": `${this.base}/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo?page=2` });
      }
      const del = /^\/v1\.0\/servicePrincipals\/([^/]+)\/appRoleAssignedTo\/([^/]+)$/.exec(path);
      if (req.method === "DELETE" && del) {
        if (this.deleteStatus !== 204) return send(this.deleteStatus, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges" } });
        this.assignments = this.assignments.filter((x) => x.id !== del[2]);
        return send(204);
      }
      send(404, { error: { code: "Request_ResourceNotFound", message: "not found" } });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()));
  }
}

describe("platform provisioning entra-reconcile", () => {
  const fake = new FakeGraph();
  before(() => fake.start());
  after(() => fake.stop());
  beforeEach(() => fake.reset());

  function files(assignments: J[], over: J = {}, inputsOver: J = {}): { dir: string; args: string[] } {
    const dir = tmp("pc-entra-reconcile-");
    writeFileSync(join(dir, "inputs.json"), JSON.stringify(inputs(inputsOver)));
    writeFileSync(join(dir, "removals.json"), JSON.stringify({ prefix: "contoso", slug: "demo", environmentName: "dev", assignments, roles: [], ...over }));
    return { dir, args: ["--removals", join(dir, "removals.json"), "--inputs", join(dir, "inputs.json"), "--unique-name", "contoso-demo-dev", "--output", join(dir, "result.json")] };
  }

  async function run(args: string[], env: J = {}): Promise<{ code: number; out: string; err: string }> {
    let out = "";
    let err = "";
    const code = await cmdEntraReconcile(args, { SAF_GRAPH_TOKEN: GRAPH_TOKEN, SAF_GRAPH_ENDPOINT: fake.base, ...env }, { out: (s) => (out += s), err: (s) => (err += s) });
    assert.ok(!out.includes(GRAPH_TOKEN) && !err.includes(GRAPH_TOKEN), "the token is never printed");
    return { code, out, err };
  }

  it("deletes only the planned User and Group assignments on the app's own service principal", async () => {
    const { dir, args } = files([
      { principalId: GONE_GROUP, role: "Reader" },
      { principalId: GONE_USER, role: "Admin" },
      { principalId: "00000000-0000-0000-0000-0000000000a9", role: "Editor" }, // already gone
    ]);
    const r = await run(args);
    assert.equal(r.code, 0, r.err);
    const deletes = fake.requests.filter((x) => x.method === "DELETE").map((x) => x.path);
    assert.deepEqual(deletes, [`/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo/assignment-group-0002`, `/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo/assignment-user-00003`]);
    assert.ok(fake.requests.every((x) => x.auth === `Bearer ${GRAPH_TOKEN}`));
    const left = fake.assignments.map((x) => x.id);
    assert.deepEqual(left, ["assignment-kept-0001", "assignment-manual-004", "assignment-group-0005", "assignment-spn-000006"], "kept, manual, other role and service principal assignments stay");
    const result = JSON.parse(readFileSync(join(dir, "result.json"), "utf8")) as J;
    assert.equal(result.servicePrincipalId, SP_ID);
    assert.equal(result.removed.length, 2);
    assert.deepEqual(result.absent, [{ principalId: "00000000-0000-0000-0000-0000000000a9", role: "Editor" }]);
    assert.match(r.out, /2 role assignment\(s\) removed, 1 already gone/);
  });

  it("refuses removals that the inputs still declare, another uniqueName, or a missing token", async () => {
    const kept = files([{ principalId: KEPT, role: "Reader" }]);
    let r = await run(kept.args);
    assert.equal(r.code, 1);
    assert.match(r.err, /still declares/);
    const other = files([{ principalId: GONE_GROUP, role: "Reader" }]);
    r = await run(other.args.map((x) => (x === "contoso-demo-dev" ? "contoso-other-dev" : x)));
    assert.equal(r.code, 1);
    assert.match(r.err, /--unique-name must be/);
    // ADR-0061: a later incarnation's uniqueName is {prefix}-{slug}-{env}--i{n}, never the first one's.
    const later = files([{ principalId: GONE_GROUP, role: "Reader" }], {}, { incarnation: 2 });
    r = await run(later.args);
    assert.equal(r.code, 1);
    assert.match(r.err, /--unique-name must be the application's uniqueName \{prefix\}-\{slug\}-\{env\}\[--i\{incarnation\}\]/);
    r = await run(other.args.map((x) => (x === "contoso-demo-dev" ? "contoso-demo-dev--i2" : x)));
    assert.equal(r.code, 1, "incarnation 0's inputs with a later uniqueName");
    r = await run(other.args, { SAF_GRAPH_TOKEN: "" });
    assert.equal(r.code, 1);
    assert.match(r.err, /SAF_GRAPH_TOKEN is not set/);
    assert.equal(fake.requests.length, 0, "nothing called Graph");
    r = await run(["--removals", "x"]);
    assert.equal(r.code, 2);
  });

  it("a refused DELETE fails the command with the permission hint and still writes the result", async () => {
    fake.deleteStatus = 403;
    const { dir, args } = files([{ principalId: GONE_GROUP, role: "Reader" }]);
    const r = await run(args);
    assert.equal(r.code, 1);
    assert.match(r.err, /HTTP 403.*AppRoleAssignment\.ReadWrite\.All/);
    assert.ok(existsSync(join(dir, "result.json")));
  });

  it("a role the application no longer has fails that removal (the manual fallback)", async () => {
    fake.appRoles = fake.appRoles.filter((x) => x.value !== "Admin");
    const { args } = files([{ principalId: GONE_USER, role: "Admin" }]);
    const r = await run(args);
    assert.equal(r.code, 1);
    assert.match(r.err, /has no app role Admin/);
    assert.equal(fake.requests.filter((x) => x.method === "DELETE").length, 0);
  });
});
