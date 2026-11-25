import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { tmp } from "./helpers.js";
import { cmdEntraDelete } from "../src/provisioning/entra-delete.js";

// `platform provisioning entra-delete` (ADR-0056): a decommissioned app's registration, by its
// uniqueName only, and its service principal; gone = done; the token is never printed. ADR-0061: never
// the recycle bin (the purge needs Application.ReadWrite.All, DECOM-21); a later incarnation of a slug
// has its own uniqueName ({prefix}-{slug}-{env}--i{n}).

const APP_OID = "00000000-0000-0000-0000-0000000000c2";
const APP_ID = "00000000-0000-0000-0000-0000000000c1";
const SP_ID = "00000000-0000-0000-0000-0000000000c3";
const GRAPH_TOKEN = ["fake", "graph", "token", "d".repeat(24)].join("-");

class FakeGraph {
  server: Server | undefined;
  base = "";
  calls: string[] = [];
  app: { uniqueName: string } | undefined;
  sp = true;

  reset(): void {
    this.calls = [];
    this.app = { uniqueName: "contoso-demo-dev" };
    this.sp = true;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const url = decodeURIComponent(req.url ?? "");
      this.calls.push(`${req.method} ${url.split("?")[0]}`);
      const send = (status: number, body?: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(body === undefined ? "" : JSON.stringify(body));
      };
      if (req.headers.authorization !== `Bearer ${GRAPH_TOKEN}`) return send(401, { error: { code: "InvalidAuthenticationToken" } });
      if (req.method === "GET" && url.startsWith("/v1.0/applications(uniqueName=")) {
        return this.app ? send(200, { id: APP_OID, appId: APP_ID, uniqueName: this.app.uniqueName }) : send(404, { error: { code: "Request_ResourceNotFound" } });
      }
      if (req.method === "DELETE" && url.startsWith(`/v1.0/applications/${APP_OID}`)) {
        this.app = undefined;
        return send(204);
      }
      if (req.method === "GET" && url.startsWith(`/v1.0/servicePrincipals(appId='${APP_ID}')`)) {
        return this.sp ? send(200, { id: SP_ID, appId: APP_ID }) : send(404, { error: { code: "Request_ResourceNotFound" } });
      }
      if (req.method === "DELETE" && url.startsWith(`/v1.0/servicePrincipals/${SP_ID}`)) {
        this.sp = false;
        return send(204);
      }
      return send(400, { error: { code: "Unexpected", message: url } });
    });
    await new Promise<void>((r) => this.server!.listen(0, "127.0.0.1", r));
    const addr = this.server.address();
    this.base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}/`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server?.close(() => r()));
  }
}

describe("platform provisioning entra-delete (ADR-0056, ADR-0061)", () => {
  const fake = new FakeGraph();
  before(() => fake.start());
  after(() => fake.stop());
  beforeEach(() => fake.reset());

  async function run(uniqueName = "contoso-demo-dev"): Promise<{ code: number; out: string; err: string; result?: Record<string, unknown> }> {
    let out = "";
    let err = "";
    const file = join(tmp("pc-entra-delete-"), "result.json");
    const code = await cmdEntraDelete(["--unique-name", uniqueName, "--output", file], { SAF_GRAPH_TOKEN: GRAPH_TOKEN, SAF_GRAPH_ENDPOINT: fake.base }, { out: (s) => (out += s), err: (s) => (err += s) });
    assert.ok(!out.includes(GRAPH_TOKEN) && !err.includes(GRAPH_TOKEN), "the token is never printed");
    let result: Record<string, unknown> | undefined;
    try {
      result = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    } catch {
      result = undefined;
    }
    return { code, out, err, ...(result ? { result } : {}) };
  }

  it("deletes the application found by its uniqueName, then its service principal", async () => {
    const r = await run();
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result, { uniqueName: "contoso-demo-dev", application: "deleted", appId: APP_ID, servicePrincipal: "deleted" });
    assert.deepEqual(fake.calls, [
      "GET /v1.0/applications(uniqueName='contoso-demo-dev')",
      `DELETE /v1.0/applications/${APP_OID}`,
      `GET /v1.0/servicePrincipals(appId='${APP_ID}')`,
      `DELETE /v1.0/servicePrincipals/${SP_ID}`,
    ]);
  });

  it("gone already is done (a partial delete resumes)", async () => {
    fake.app = undefined;
    const r = await run();
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result, { uniqueName: "contoso-demo-dev", application: "gone", appId: null, servicePrincipal: "gone" });
    assert.deepEqual(fake.calls, ["GET /v1.0/applications(uniqueName='contoso-demo-dev')"]);
  });

  it("a later incarnation's registration by its own uniqueName; the recycle bin is never touched (ADR-0061)", async () => {
    fake.app = { uniqueName: "contoso-demo-dev--i2" };
    const r = await run("contoso-demo-dev--i2");
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(r.result, { uniqueName: "contoso-demo-dev--i2", application: "deleted", appId: APP_ID, servicePrincipal: "deleted" });
    assert.equal(fake.calls[0], "GET /v1.0/applications(uniqueName='contoso-demo-dev--i2')");
    assert.ok(!fake.calls.some((c) => c.includes("deletedItems")), fake.calls.join("\n"));
  });

  it("an earlier incarnation's registration is not a later one's (nothing deleted)", async () => {
    fake.app = { uniqueName: "contoso-demo-dev" };
    const r = await run("contoso-demo-dev--i1");
    assert.equal(r.code, 1);
    assert.match(r.err, /no application with exactly the uniqueName contoso-demo-dev--i1; nothing is deleted/);
    assert.ok(!fake.calls.some((c) => c.startsWith("DELETE")));
    for (const bad of ["contoso-demo-dev--i0", "contoso-demo-dev--i01", "contoso-demo-dev--x1"]) {
      const b = await run(bad);
      assert.equal(b.code, 1, bad);
      assert.match(b.err, /--unique-name must be/, bad);
    }
  });

  it("refuses an application whose uniqueName differs, and a uniqueName that isn't one (nothing deleted)", async () => {
    fake.app = { uniqueName: "contoso-other-dev" };
    const r = await run();
    assert.equal(r.code, 1);
    assert.match(r.err, /no application with exactly the uniqueName contoso-demo-dev; nothing is deleted/);
    assert.ok(!fake.calls.some((c) => c.startsWith("DELETE")));
    const bad = await run("Contoso Demo");
    assert.equal(bad.code, 1);
    assert.match(bad.err, /--unique-name must be/);
  });
});
