import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import {
  cellCaeNetworkSecurityGroupName,
  cellCaeSubnetName,
  cellManagedEnvironmentName,
  cellPlatformJobName,
  cellUsage,
  defaultReservation,
  placeInCell,
  reservedCores,
  withinReservation,
} from "../src/capacity.js";
import type { CapacityInstanceView } from "../src/capacity.js";
import { enforceFromOf } from "../src/enforcement.js";
import { explainCheck } from "../src/explanations.js";
import { PIPELINE_CHECK_ENFORCE_FROM } from "../src/rules.js";
import { validateFile } from "../src/validate.js";
import { otherAppsFromTexts, validateAppText } from "../src/validate-app.js";
import type { AppValidateResult } from "../src/validate-app.js";
import { instanceProblems } from "../src/validate-app.js";
import { REPO_ROOT } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";

/** Capacity cells and app capacity reservations (ADR-0053). */

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const EXAMPLE_APP = readFileSync(join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml"), "utf8");
const EXAMPLE_INSTANCE = readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8");

function instanceData(mutate?: (d: Doc) => void): { file: string; data: never } {
  const d = parse(EXAMPLE_INSTANCE) as Doc;
  mutate?.(d);
  const iv = instanceProblems(stringify(d));
  assert.deepEqual(iv.problems, [], "the changed instance is schema-valid");
  return { file: "instance.yaml", data: iv.data as never };
}

/** An app of the example's shape in nonprod only, with the given cell and capacity. */
function app(slug: string, env: Doc = {}): string {
  const d = parse(EXAMPLE_APP) as Doc;
  d.slug = slug;
  d.repository.name = slug;
  d.environments = { nonprod: { networkMode: "externalOnly", ...env } };
  delete d.data;
  return stringify(d);
}

function validate(slug: string, env: Doc, others: { slug: string; env: Doc }[], mutate?: (d: Doc) => void): AppValidateResult {
  return validateAppText(app(slug, env), {
    file: `apps/${slug}/app.yaml`,
    instance: instanceData(mutate),
    others: otherAppsFromTexts(others.map((o) => ({ slug: o.slug, text: app(o.slug, o.env) }))),
  });
}
const checks = (r: AppValidateResult): string[] => r.checks.map((c) => `${c.path}: ${c.message}`);

describe("capacity model", () => {
  it("reserves the size's vCPU times maxReplicas, and defaults to size s with 3 replicas", () => {
    assert.equal(reservedCores({ size: "xs", maxReplicas: 1 }), 0.25);
    assert.equal(reservedCores({ size: "s", maxReplicas: 3 }), 1.5);
    assert.equal(reservedCores({ size: "l", maxReplicas: 10 }), 20);
    assert.deepEqual(defaultReservation({}), { size: "s", maxReplicas: 3 });
    assert.deepEqual(defaultReservation({ newApps: { capacity: { size: "m" } } }), { size: "m", maxReplicas: 3 });
  });

  it("checks a runtime against a reservation by size and by replicas", () => {
    assert.ok(withinReservation({ size: "s", maxReplicas: 3 }, { size: "s", maxReplicas: 3 }));
    assert.ok(withinReservation({ size: "xs", maxReplicas: 2 }, { size: "m", maxReplicas: 2 }));
    assert.ok(!withinReservation({ size: "m", maxReplicas: 1 }, { size: "s", maxReplicas: 3 }), "a larger size is refused even with fewer replicas");
    assert.ok(!withinReservation({ size: "xs", maxReplicas: 4 }, { size: "s", maxReplicas: 3 }), "more replicas are refused even at a smaller size");
  });

  it("adds up the apps of each cell, with the subnet in a VNet-based mode, and places a new app in the cell with the most room", () => {
    const inst: CapacityInstanceView = {
      environments: [
        {
          name: "prod",
          networkModes: {
            externalOnly: { network: "vnet", caeSubnetPrefix: "10.0.0.0/26", cells: [{ id: "01", capacity: { cores: 4 } }, { id: "02" }] },
            externalHybrid: { caeSubnetPrefix: "10.0.1.0/25" },
          },
        },
      ],
      newApps: { capacity: { size: "s", maxReplicas: 2 } },
    };
    const usage = cellUsage(inst, [
      { slug: "a", environments: { prod: { networkMode: "externalOnly", capacity: { size: "m", maxReplicas: 3 } } } },
      { slug: "b", environments: { prod: { networkMode: "externalOnly" } } },
      { slug: "c", environments: { prod: { networkMode: "externalOnly", cell: "02" } }, },
      { slug: "d", environments: { prod: { networkMode: "externalOnly", cell: "07" } } },
    ]);
    const c01 = usage.find((u) => u.networkMode === "externalOnly" && u.cell === "01")!;
    assert.deepEqual([c01.cores, c01.reservedCores, c01.freeCores, c01.replicas], [4, 4, 0, 5]);
    assert.deepEqual(c01.subnet, { prefix: "10.0.0.0/26", maxReplicas: 250 });
    assert.deepEqual(c01.apps.map((a) => [a.slug, a.isDefault]), [["a", false], ["b", true]]);
    const c02 = usage.find((u) => u.cell === "02")!;
    assert.deepEqual([c02.cores, c02.reservedCores, c02.subnet], [80, 1, undefined], "a later cell has no subnet yet");
    assert.equal(usage.find((u) => u.networkMode === "externalHybrid")!.subnet?.maxReplicas, 570);
    assert.equal(placeInCell(usage, "prod", "externalOnly", { size: "s", maxReplicas: 3 }), "02");
    assert.equal(placeInCell(usage, "prod", "externalHybrid", { size: "l", maxReplicas: 10 }), "01");
    assert.equal(placeInCell(usage, "prod", "externalHybrid", { size: "l", maxReplicas: 10 }), "01");
    assert.equal(placeInCell(usage, "nonprod", "externalOnly", { size: "s", maxReplicas: 3 }), undefined);
  });
});

describe("capacity: cell names (ports of naming.bicep, shared vectors)", () => {
  const vectors = JSON.parse(readFileSync(join(REPO_ROOT, "infra", "tests", "naming-vectors.json"), "utf8")) as {
    base: Doc;
    cases: { input: { prefix: string; env: string; cell?: string }; names: Record<string, string> }[];
    invalid: { label: string; override: Doc }[];
  };
  for (const c of vectors.cases) {
    it(`${c.input.prefix}/${c.input.env}: every cell name equals the vector`, () => {
      const { prefix, env } = c.input;
      const cell = c.input.cell ?? "02";
      const n = c.names;
      assert.equal(cellManagedEnvironmentName(prefix, "externalOnly", env, "01"), n.caeExtCell01);
      assert.equal(cellManagedEnvironmentName(prefix, "externalOnly", env, "01"), n.caeExt, "cell 01 keeps today's name");
      assert.equal(cellManagedEnvironmentName(prefix, "externalOnly", env, cell), n.caeExtCell);
      assert.equal(cellManagedEnvironmentName(prefix, "externalHybrid", env, cell), n.caeHybCell);
      assert.equal(cellCaeSubnetName(prefix, "externalOnly", env, "01"), n.snetCaeExtCell01);
      assert.equal(cellCaeSubnetName(prefix, "externalHybrid", env, cell), n.snetCaeHybCell);
      assert.equal(cellCaeNetworkSecurityGroupName(prefix, "externalHybrid", env, "01"), n.nsgCaeHybCell01);
      assert.equal(cellCaeNetworkSecurityGroupName(prefix, "externalHybrid", env, cell), n.nsgCaeHybCell);
      assert.equal(cellPlatformJobName(prefix, "kvset", "externalOnly", "01"), n.platformJobKvsetExtCell01);
      assert.equal(cellPlatformJobName(prefix, "kvset", "externalOnly", cell), n.platformJobKvsetExtCell);
      assert.equal(cellPlatformJobName(prefix, "dbinit", "externalHybrid", cell), n.platformJobDbinitHybCell);
    });
  }
  it("refuses the cell ids naming.bicep refuses", () => {
    const cells = vectors.invalid.map((v) => v.override.cell).filter((x): x is string => typeof x === "string");
    assert.ok(cells.length >= 4);
    for (const cell of cells) assert.throws(() => cellManagedEnvironmentName("contoso", "externalOnly", "prod", cell), /naming: invalid cell id/, cell);
    assert.throws(() => cellManagedEnvironmentName("contoso", "portal", "prod", "02"), /unknown network mode/);
  });
});

describe("platform validate app: capacity (ADR-0053)", () => {
  it("accepts apps whose reservations fit the cell", () => {
    const r = validate("orders", { capacity: { size: "m", maxReplicas: 4 } }, [{ slug: "stock", env: {} }]);
    assert.deepEqual(checks(r), []);
  });

  it("refuses a cell the network mode doesn't have (check cell-unknown)", () => {
    const r = validate("orders", { cell: "02" }, []);
    assert.deepEqual(checks(r), [
      "environments.nonprod.cell: cell 02 is not a cell of externalOnly in environment nonprod (cells: 01); name one of them, or leave cell out for 01 (check cell-unknown).",
    ]);
    assert.equal(r.checks[0]!.checkId, "cell-unknown");
  });

  it("fails every app of an overcommitted cell, naming the cell, what is reserved and the budget (check cell-capacity)", () => {
    const small = (d: Doc) => (d.environments[0].networkModes.externalOnly.cells = [{ id: "01", capacity: { cores: 5 } }]);
    const r = validate("orders", { capacity: { size: "m", maxReplicas: 4 } }, [{ slug: "stock", env: {} }], small);
    assert.deepEqual(checks(r), [
      "environments.nonprod.capacity: cell 01 of externalOnly in environment nonprod would reserve 5.5 cores, more than its budget of 5: this app reserves 4 (size m x 4 replicas) and 1 other app 1.5. Lower the reservation, or ask the platform team for room in the cell (check cell-capacity).",
    ]);
    assert.equal(r.checks[0]!.checkId, "cell-capacity");
    const other = validate("stock", {}, [{ slug: "orders", env: { capacity: { size: "m", maxReplicas: 4 } } }], small);
    assert.match(checks(other)[0]!, /^environments\.nonprod: cell 01 .* this app reserves 1\.5 \(size s x 3 replicas, the instance default\) and 1 other app 4\./);
    // An app of another environment or mode doesn't count.
    assert.deepEqual(checks(validate("stock", {}, [{ slug: "orders", env: { networkMode: "externalHybrid", capacity: { size: "l", maxReplicas: 10 } } }], small)), []);
  });

  it("checks the sum of maxReplicas against the subnet in a VNet-based mode (check cell-subnet-capacity)", () => {
    const vnet = (d: Doc) => {
      d.environments[0].networkModes.externalOnly = {
        network: "vnet",
        vnetAddressSpace: "10.20.0.0/23",
        caeSubnetPrefix: "10.20.0.0/27",
        privateEndpointSubnetPrefix: "10.20.1.0/24",
      };
    };
    const others = Array.from({ length: 9 }, (_, i) => ({ slug: `app${i}`, env: { capacity: { size: "xs", maxReplicas: 10 } } }));
    const r = validate("orders", { capacity: { size: "xs", maxReplicas: 1 } }, others, vnet);
    assert.deepEqual(checks(r), [
      "environments.nonprod.capacity: cell 01 of externalOnly in environment nonprod would run up to 91 replicas in total, more than its subnet 10.20.0.0/27 holds (90); this app reserves 1. Lower maxReplicas, or ask the platform team (check cell-subnet-capacity).",
    ]);
    assert.equal(r.checks[0]!.checkId, "cell-subnet-capacity");
  });

  it("reports the schema errors of cell and capacity", () => {
    const r = validateAppText(app("orders", { cell: "1", capacity: { size: "xl", maxReplicas: 11 } }), { file: "apps/orders/app.yaml" });
    const text = r.problems.map((p) => `${p.path}: ${p.message}`).join("\n");
    assert.match(text, /^environments\.nonprod\.cell: has an invalid format/m);
    assert.match(text, /^environments\.nonprod\.capacity\.size: must be one of: "xs", "s", "m", "l"/m);
    assert.match(text, /^environments\.nonprod\.capacity\.maxReplicas: must be <= 10/m);
  });
});

describe("platform validate instance: capacity cells (ADR-0053)", () => {
  const validate = (mutate: (d: Doc) => void) => validateFile("instance", instanceFile((d) => mutate(d as unknown as Doc)));
  const msgs = (r: ReturnType<typeof validateFile>): string[] => [...r.problems.map((p) => `${p.path}: ${p.message}`), ...(r.checks ?? []).map((c) => `${c.path}: ${c.message}`)];
  const ext = (d: Doc, name = "nonprod"): Doc => d.environments.find((e: Doc) => e.name === name).networkModes.externalOnly;

  it("accepts one cell 01, and no cells at all", () => {
    assert.deepEqual(msgs(validate((d) => (ext(d).cells = [{ id: "01", capacity: { cores: 60 } }]))), []);
    assert.deepEqual(msgs(validate((d) => delete ext(d, "prod").cells)), []);
  });

  it("refuses a second cell: not yet, the platform pipeline deploys one cell per mode", () => {
    const r = validate((d) => (ext(d).cells = [{ id: "01" }, { id: "02" }]));
    assert.deepEqual(msgs(r), [
      "environments[0].networkModes.externalOnly.cells[1]: not yet: cell 02 would be a second cell of externalOnly in nonprod, but the platform pipeline deploys one cell per network mode for now (ADR-0053). Keep only cell 01; more cells come with the platform pipeline's next increment.",
    ]);
  });

  it("needs cell 01 first, unique ids, and a default reservation that fits every cell", () => {
    assert.match(msgs(validate((d) => (ext(d).cells = [{ id: "02" }])))[0]!, /cells\[0\]\.id: the first cell of externalOnly in nonprod must be 01/);
    assert.ok(msgs(validate((d) => (ext(d).cells = [{ id: "01" }, { id: "01" }]))).some((m) => /cells\[1\]\.id: cell 01 is already listed as cells\[0\]/.test(m)));
    const r = validate((d) => {
      ext(d).cells = [{ id: "01", capacity: { cores: 2 } }];
      d.newApps.capacity = { size: "m", maxReplicas: 3 };
    });
    assert.deepEqual(msgs(r), [
      "environments[0].networkModes.externalOnly.cells[0].capacity.cores: the default reservation (newApps.capacity: size m x 3 replicas, 3 cores) doesn't fit the budget of cell 01 of externalOnly in nonprod (2 cores).",
    ]);
  });

  it("reports the schema errors of cells and newApps.capacity", () => {
    const r = validate((d) => {
      ext(d).cells = [{ id: "1", capacity: { cores: 0 } }];
      d.newApps.capacity = { size: "xl", maxReplicas: 0 };
    });
    const text = msgs(r).join("\n");
    assert.match(text, /cells\[0\]\.id: has an invalid format/);
    assert.match(text, /cells\[0\]\.capacity\.cores: must be >= 1/);
    assert.match(text, /newApps\.capacity\.size: must be one of/);
    assert.match(text, /newApps\.capacity\.maxReplicas: must be >= 1/);
  });
});

describe("capacity: the catalogue and the enforcement date", () => {
  it("explains every capacity check in EN and CS, and the delivery check warns until its date", () => {
    for (const id of ["capacity-reservation", "cell-unknown", "cell-capacity", "cell-subnet-capacity"]) {
      const e = explainCheck(id);
      assert.ok(e && e.title.cs && e.text.cs && e.fix.cs && e.prompt.cs, id);
    }
    assert.equal(enforceFromOf("capacity-reservation"), PIPELINE_CHECK_ENFORCE_FROM["capacity-reservation"]);
    assert.match(enforceFromOf("capacity-reservation")!, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(enforceFromOf("cell-capacity"), undefined, "a definition check blocks from the start");
  });
});
