import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { BASIC_DATABASE_ENGINES, BASIC_MODE_DEFAULTS, BASIC_NETWORK_MODES, BASIC_STACKS, basicModeOf } from "../src/index.js";
import { validateFile } from "../src/validate.js";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const schema = JSON.parse(readFileSync(join(REPO_ROOT, "config", "schema", "instance.schema.json"), "utf8")) as Doc;
const basicSchema = schema.properties.newApps.properties.basicMode.properties as Doc;

function checks(edit: (doc: Doc) => void): string[] {
  const r = validateFile("instance", instanceFile((doc) => edit(doc as Doc)));
  assert.deepEqual(r.problems, [], "schema-valid");
  return (r.checks ?? []).map((c) => `${c.path}: ${c.message}`);
}

describe("basic mode of the new-app wizard (basic-mode.ts, ADR-0047)", () => {
  it("the defaults and enums equal the schema's", () => {
    for (const [key, value] of Object.entries(BASIC_MODE_DEFAULTS)) assert.deepEqual(basicSchema[key].default, value, key);
    assert.deepEqual(basicSchema.networkMode.enum, [...BASIC_NETWORK_MODES]);
    assert.deepEqual(basicSchema.databaseEngine.enum, [...BASIC_DATABASE_ENGINES]);
    assert.deepEqual(basicSchema.stack.enum, [...BASIC_STACKS]);
  });

  it("fills in the defaults for what instance.yaml doesn't set", () => {
    assert.deepEqual(basicModeOf(), BASIC_MODE_DEFAULTS);
    assert.deepEqual(basicModeOf({ newApps: { basicMode: { databaseEngine: "none", stack: "dotnet" } } }), { ...BASIC_MODE_DEFAULTS, databaseEngine: "none", stack: "dotnet" });
  });

  it("the example instance and the defaults are valid", () => {
    assert.deepEqual(checks(() => {}), []);
    assert.deepEqual(checks((d) => (d.newApps = { basicMode: { enabled: false, networkMode: "externalHybrid" } })), [], "disabled: nothing to check");
  });

  it("refuses a network mode a build environment doesn't offer", () => {
    const out = checks((d) => {
      d.newApps = { basicMode: { networkMode: "externalHybrid" } };
      for (const e of d.environments) if (!e.promoteFrom) delete e.networkModes.externalHybrid;
    });
    assert.equal(out.length, 1, out.join("\n"));
    assert.match(out[0]!, /^newApps\.basicMode\.networkMode: the build environment \S+ doesn't offer network mode externalHybrid/);
  });

  it("refuses externalHybrid without an active egress baseline", () => {
    const out = checks((d) => {
      d.newApps = { basicMode: { networkMode: "externalHybrid" } };
      for (const e of d.environments) if (!e.promoteFrom && e.networkModes.externalHybrid) e.networkModes.externalHybrid.egressBaseline = { status: "requested" };
    });
    assert.ok(out.length >= 1 && out.every((x) => /needs an active egress baseline/.test(x)), out.join("\n"));
  });

  it("refuses a database engine that is switched off, a size it doesn't define, and storage when it's off", () => {
    const azureSqlOff = (d: Doc): void => void (d.data = { ...(d.data ?? {}), azureSql: { enabled: false } });
    assert.match(checks(azureSqlOff).join("\n"), /^newApps\.basicMode\.databaseEngine: azureSql is switched off/m);
    assert.match(
      checks((d) => {
        azureSqlOff(d);
        delete d.newApps;
      }).join("\n"),
      /^newApps\.basicMode: azureSql is switched off/m,
      "not set in instance.yaml: the default engine, the error points at basicMode",
    );
    assert.match(
      checks((d) => {
        d.newApps = { basicMode: { databaseEngine: "azureSql", databaseSize: "L" } };
        d.data = { ...(d.data ?? {}), azureSql: { enabled: true, sizes: { S: { sku: "S0", storageGb: 250 } } } };
      }).join("\n"),
      /^newApps\.basicMode\.databaseSize: azureSql has no size L \(data\.azureSql\.sizes: S\)/m,
    );
    assert.deepEqual(checks((d) => (d.newApps = { basicMode: { databaseEngine: "none" } })).filter((x) => /database/.test(x)), []);
    assert.match(checks((d) => (d.data = { ...(d.data ?? {}), storage: { enabled: false } })).join("\n"), /^newApps\.basicMode\.storage: file storage is switched off/m);
    assert.deepEqual(checks((d) => {
      d.newApps = { basicMode: { storage: false } };
      d.data = { ...(d.data ?? {}), storage: { enabled: false } };
    }), []);
  });

  it("the schema refuses unknown keys and values", () => {
    for (const bad of [{ stack: "byo" }, { databaseEngine: "mysql" }, { extra: 1 }]) {
      const r = validateFile("instance", instanceFile((doc) => ((doc as Doc).newApps = { basicMode: bad })));
      assert.equal(r.ok, false, JSON.stringify(bad));
    }
  });
});
