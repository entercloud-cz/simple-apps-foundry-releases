import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { parse, stringify } from "yaml";
import { REPO_ROOT, tmp } from "./helpers.js";
import { callerObjectId, cmdAppGroups } from "../src/provisioning/app-groups.js";

type J = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

// `platform provisioning app-groups` (ADR-0077): the app groups of one environment's kind, against a fake Graph.

const SELF = "00000000-0000-0000-0000-0000000000f1";
const OWNER = "00000000-0000-0000-0000-00000000e001";
const DEPUTY = "00000000-0000-0000-0000-00000000e002";
const NEW_DEPUTY = "00000000-0000-0000-0000-00000000e009";
const APP_ID = "00000000-0000-0000-0000-0000000000c1";
const SP_ID = "00000000-0000-0000-0000-0000000000c3";
const ROLE_READER = "00000000-0000-0000-0000-0000000000e1";
const ROLE_EDITOR = "00000000-0000-0000-0000-0000000000e2";
const ROLE_ADMIN = "00000000-0000-0000-0000-0000000000e3";
const b64 = (o: J): string => Buffer.from(JSON.stringify(o)).toString("base64url");
const GRAPH_TOKEN = `${b64({ alg: "none" })}.${b64({ oid: SELF, roles: ["Group.Create"] })}.${"s".repeat(24)}`;
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const APP = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");

interface Group {
  id: string;
  uniqueName: string;
  displayName: string;
  description?: string;
  owners: string[];
}

class FakeGraph {
  server: Server | undefined;
  base = "";
  requests: { method: string; path: string }[] = [];
  groups: Group[] = [];
  assignments: J[] = [];
  /** POST appRoleAssignedTo answers 400 this many times first (Graph replicating a new group). */
  replicating = 0;
  /** GET /groups answers 403 (the identity has no GroupMember.Read.All). */
  denyList = false;
  next = 0x100;

  reset(): void {
    this.requests = [];
    this.groups = [];
    this.assignments = [];
    this.replicating = 0;
    this.denyList = false;
  }

  group(uniqueName: string, displayName: string, owners: string[]): Group {
    const g = { id: `00000000-0000-0000-0000-${(this.next++).toString(16).padStart(12, "0")}`, uniqueName, displayName, owners };
    this.groups.push(g);
    return g;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c.toString()));
      req.on("end", () => {
        const u = new URL(req.url ?? "/", "http://127.0.0.1");
        const path = decodeURIComponent(u.pathname);
        const method = req.method ?? "";
        this.requests.push({ method, path });
        const body = raw ? (JSON.parse(raw) as J) : {};
        const send = (status: number, b?: J): void => {
          res.writeHead(status, { "Content-Type": "application/json" });
          res.end(b === undefined ? "" : JSON.stringify(b));
        };
        const denied = (): void => send(403, { error: { code: "Authorization_RequestDenied", message: "Insufficient privileges to complete the operation." } });
        const byId = (id: string): Group | undefined => this.groups.find((g) => g.id === id);
        if (method === "GET" && path === "/v1.0/groups") {
          if (this.denyList) return denied();
          const m = /startswith\(uniqueName,'([^']*)'\)/.exec(u.searchParams.get("$filter") ?? "");
          return send(200, { value: this.groups.filter((g) => m && g.uniqueName.startsWith(m[1]!)).map(({ id, uniqueName, displayName, description }) => ({ id, uniqueName, displayName, description: description ?? null })) });
        }
        if (method === "POST" && path === "/v1.0/groups") {
          if (this.groups.some((g) => g.uniqueName === body.uniqueName)) return send(400, { error: { code: "Request_BadRequest", message: "Another object with the same value for property uniqueName already exists." } });
          const owners = (body["owners@odata.bind"] as string[]).map((x) => x.split("/").pop()!);
          const g = this.group(body.uniqueName as string, body.displayName as string, owners);
          g.description = body.description as string;
          return send(201, { id: g.id, uniqueName: g.uniqueName });
        }
        let m = /^\/v1\.0\/groups\/([^/]+)$/.exec(path);
        if (m) {
          const g = byId(m[1]!);
          if (!g) return send(404, { error: { code: "Request_ResourceNotFound" } });
          if (!g.owners.includes(SELF)) return denied();
          if (method === "PATCH") {
            if (typeof body.displayName === "string") g.displayName = body.displayName;
            if (typeof body.description === "string") g.description = body.description;
            return send(204);
          }
          if (method === "DELETE") {
            this.groups = this.groups.filter((x) => x !== g);
            this.assignments = this.assignments.filter((a) => a.principalId !== g.id);
            return send(204);
          }
        }
        m = /^\/v1\.0\/groups\/([^/]+)\/owners\/microsoft\.graph\.user$/.exec(path);
        if (m && method === "GET") return send(200, { value: (byId(m[1]!)?.owners ?? []).filter((o) => o !== SELF).map((id) => ({ id })) });
        m = /^\/v1\.0\/groups\/([^/]+)\/owners\/\$ref$/.exec(path);
        if (m && method === "POST") {
          const g = byId(m[1]!)!;
          if (!g.owners.includes(SELF)) return denied();
          const id = (body["@odata.id"] as string).split("/").pop()!;
          if (g.owners.includes(id)) return send(400, { error: { code: "Request_BadRequest", message: "One or more added object references already exist for the following modified properties: 'owners'." } });
          g.owners.push(id);
          return send(204);
        }
        m = /^\/v1\.0\/groups\/([^/]+)\/owners\/([^/]+)\/\$ref$/.exec(path);
        if (m && method === "DELETE") {
          const g = byId(m[1]!)!;
          if (!g.owners.includes(m[2]!)) return send(404, { error: { code: "Request_ResourceNotFound" } });
          g.owners = g.owners.filter((o) => o !== m![2]);
          return send(204);
        }
        if (method === "GET" && path === "/v1.0/applications(uniqueName='contoso-hotel-inventory-nonprod')") {
          return send(200, { appId: APP_ID, uniqueName: "contoso-hotel-inventory-nonprod", appRoles: [{ id: ROLE_READER, value: "Reader", isEnabled: true }, { id: ROLE_EDITOR, value: "Editor", isEnabled: true }, { id: ROLE_ADMIN, value: "Admin", isEnabled: true }] });
        }
        if (method === "GET" && path === `/v1.0/servicePrincipals(appId='${APP_ID}')`) return send(200, { id: SP_ID, appId: APP_ID });
        if (path === `/v1.0/servicePrincipals/${SP_ID}/appRoleAssignedTo`) {
          if (method === "GET") return send(200, { value: this.assignments });
          if (method === "POST") {
            if (this.replicating > 0) {
              this.replicating--;
              return send(400, { error: { code: "Request_BadRequest", message: "Resource does not exist or one of its queried reference-property objects are not present." } });
            }
            const a = { id: `assignment-${this.assignments.length + 1}-xxxxxx`, principalId: body.principalId, appRoleId: body.appRoleId, principalType: "Group", resourceId: SP_ID };
            this.assignments.push(a);
            return send(201, a);
          }
        }
        send(404, { error: { code: "Request_ResourceNotFound", message: "not found" } });
      });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()));
  }
}

describe("platform provisioning app-groups (ADR-0077)", () => {
  const fake = new FakeGraph();
  before(() => fake.start());
  after(() => fake.stop());
  beforeEach(() => fake.reset());

  /** app.yaml of hotel-inventory with app groups (and the changes of a test), instance.yaml as in the examples. */
  function files(mutate: (app: J, inst: J) => void = () => undefined): { dir: string; app: string; inst: string } {
    const dir = tmp("pc-app-groups-");
    const app = parse(readFileSync(APP, "utf8")) as J;
    const inst = parse(readFileSync(INSTANCE, "utf8")) as J;
    app.authentication.appGroups = ["Reader", "Editor"];
    mutate(app, inst);
    // The slug must equal its directory: apps/hotel-inventory/app.yaml.
    mkdirSync(join(dir, "apps", "hotel-inventory"), { recursive: true });
    writeFileSync(join(dir, "apps", "hotel-inventory", "app.yaml"), stringify(app));
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    return { dir, app: join(dir, "apps", "hotel-inventory", "app.yaml"), inst: join(dir, "instance.yaml") };
  }

  async function run(f: { dir: string; app: string; inst: string }, extra: string[] = ["--unique-name", "contoso-hotel-inventory-nonprod"], env = "nonprod"): Promise<{ code: number; out: string; err: string; result: J | undefined }> {
    let out = "";
    let err = "";
    const output = join(f.dir, "result.json");
    writeFileSync(output, "");
    const code = await cmdAppGroups(["--instance", f.inst, "--app", f.app, "--env", env, "--output", output, ...extra], { SAF_GRAPH_TOKEN: GRAPH_TOKEN, SAF_GRAPH_ENDPOINT: fake.base }, { out: (s) => (out += s), err: (s) => (err += s), retryDelayMs: 0, tries: 4 });
    assert.ok(!out.includes(GRAPH_TOKEN) && !err.includes(GRAPH_TOKEN), "the token is never printed");
    const text = readFileSync(output, "utf8");
    return { code, out, err, result: text ? (JSON.parse(text) as J) : undefined };
  }

  it("reads its own object ID from the token", () => {
    assert.equal(callerObjectId(GRAPH_TOKEN), SELF);
    assert.throws(() => callerObjectId(`${b64({})}.${b64({ roles: [] })}.x`), /no object ID/);
  });

  it("creates the groups with itself, the owner and the deputy as owners, and assigns them to their roles", async () => {
    const r = await run(files());
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(
      fake.groups.map((g) => [g.uniqueName, g.displayName]),
      [
        ["contoso-hotel-inventory-nonprod-reader", "SAF - App - Hotel Inventory - Non-prod - Reader"],
        ["contoso-hotel-inventory-nonprod-editor", "SAF - App - Hotel Inventory - Non-prod - Editor"],
      ],
    );
    for (const g of fake.groups) assert.deepEqual(g.owners, [SELF, OWNER, DEPUTY]);
    // What the role may do (the core's default descriptions; hotel-inventory defines its own roles' descriptions).
    assert.match(fake.groups[0]!.description ?? "", /^Non-production users of Hotel Inventory with the role Reader\. .+ Its owners manage the members in the portal\.$/);
    assert.deepEqual(fake.assignments.map((a) => a.appRoleId).sort(), [ROLE_EDITOR, ROLE_READER].sort());
    assert.equal(r.result?.assigned, 2);
    assert.deepEqual(r.result?.groups.map((g: J) => g.status), ["created", "created"]);
    assert.match(r.out, /OK {2}hotel-inventory in nonprod: 2 app group\(s\) \(2 created, 0 renamed\), 0 deleted, 2 assignment\(s\) made/);

    // A second run: nothing to do (no create, no rename, no owner or assignment call).
    fake.requests = [];
    const again = await run(files());
    assert.equal(again.code, 0, again.err);
    assert.deepEqual(again.result?.groups.map((g: J) => g.status), ["unchanged", "unchanged"]);
    assert.equal(again.result?.assigned, 0);
    assert.ok(!fake.requests.some((x) => x.method !== "GET"), `only reads: ${JSON.stringify(fake.requests.filter((x) => x.method !== "GET"))}`);
  });

  it("renames on a new title or name prefix, and keeps the owners equal to the owner and the deputy", async () => {
    await run(files());
    const r = await run(
      files((app, inst) => {
        app.title = "Hotel Stock";
        app.deputy.objectId = NEW_DEPUTY;
        inst.authentication.groupNamePrefix = "Apps";
      }),
    );
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(fake.groups.map((g) => g.displayName), ["Apps - Hotel Stock - Non-prod - Reader", "Apps - Hotel Stock - Non-prod - Editor"]);
    for (const g of fake.groups) assert.deepEqual(g.owners, [SELF, OWNER, NEW_DEPUTY], "the old deputy is no owner any more; the identity stays one");
    assert.equal(r.result?.ownersAdded, 2);
    assert.equal(r.result?.ownersRemoved, 2);
    assert.deepEqual(r.result?.groups.map((g: J) => g.status), ["renamed", "renamed"]);
  });

  it("deletes the group of a role that lost its app group, and never touches another app's or incarnation's groups", async () => {
    await run(files());
    const foreign = [
      fake.group("contoso-hotel-inventory-nonprod-x-reader", "another app's", [SELF]),
      fake.group("contoso-hotel-inventory-nonprod-reader--i2", "a later incarnation's", [SELF]),
      fake.group("contoso-hotel-inventory-prod-reader", "the prod kind's", [SELF]),
    ];
    const r = await run(files((app) => (app.authentication.appGroups = ["Reader"])));
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result?.deleted.map((d: J) => d.uniqueName), ["contoso-hotel-inventory-nonprod-editor"]);
    for (const g of foreign) assert.ok(fake.groups.includes(g), `${g.uniqueName} stays`);
    assert.ok(!fake.assignments.some((a) => a.appRoleId === ROLE_EDITOR), "its assignment went with it");
  });

  it("waits while Graph replicates a new group before the assignment", async () => {
    fake.replicating = 2;
    const r = await run(files((app) => (app.authentication.appGroups = ["Admin"])));
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /waiting .* \(try 1 of 4\)/);
    assert.equal(r.result?.assigned, 1);
  });

  it("fails clearly when it lost the ownership of a group", async () => {
    fake.group("contoso-hotel-inventory-nonprod-reader", "renamed by hand", [OWNER]);
    const r = await run(files((app) => (app.authentication.appGroups = ["Reader"])));
    assert.equal(r.code, 1);
    assert.match(r.err, /HTTP 403 .*must still own the app's groups/);
  });

  it("--delete: deletes the kind's groups, or keeps them while the app runs in another environment of the kind", async () => {
    await run(files());
    fake.group("contoso-hotel-inventory-prod-reader", "the prod kind's", [SELF, OWNER, DEPUTY]);
    // Another nonprod environment of the app keeps them.
    const kept = await run(
      files((app, inst) => {
        const qa = structuredClone(inst.environments.find((e: J) => e.name === "nonprod"));
        qa.name = "qa";
        qa.promoteFrom = "nonprod";
        inst.environments.splice(1, 0, qa);
        app.environments.qa = structuredClone(app.environments.nonprod);
      }),
      ["--delete"],
    );
    assert.equal(kept.code, 0, kept.err);
    assert.deepEqual(kept.result?.keptFor, ["qa"]);
    assert.equal(fake.groups.length, 3);
    // Decommissioning: they go, also with another environment of the kind; the prod kind's stay.
    const gone = await run(
      files((app) => (app.decommission = { requestedOn: "2026-11-01", deleteAfter: "2026-12-01", reason: "Replaced by the new stock app.", requestedBy: { objectId: OWNER, displayName: "Jane Owner" } })),
      ["--delete"],
    );
    assert.equal(gone.code, 0, gone.err);
    assert.equal(gone.result?.deleted.length, 2);
    assert.deepEqual(fake.groups.map((g) => g.uniqueName), ["contoso-hotel-inventory-prod-reader"]);
  });

  it("an app without app groups on an instance without GroupMember.Read.All: skipped, not failed", async () => {
    fake.denyList = true;
    const none = await run(files((app) => delete app.authentication.appGroups), ["--delete"]);
    assert.equal(none.code, 0, none.err);
    assert.equal(none.result?.skipped, true);
    const some = await run(files(), ["--delete"]);
    assert.equal(some.code, 1, "an app with app groups needs the permission");
    assert.match(some.err, /HTTP 403/);
  });

  it("usage: --unique-name is required to sync and must be the registration's", async () => {
    const f = files();
    const missing = await run(f, []);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /missing --unique-name/);
    const other = await run(f, ["--unique-name", "contoso-other-nonprod"]);
    assert.equal(other.code, 1);
    assert.match(other.err, /--unique-name must be the registration's uniqueName/);
    assert.equal(fake.requests.length, 0, "no Graph call");
  });
});
