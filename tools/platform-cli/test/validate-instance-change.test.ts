import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { changedNetworkFields, environmentsInUseOf, NETWORK_FIELDS, networkValue } from "../src/network-change.js";
import { validateInstanceDefinition } from "../src/index.js";
import { validateFile } from "../src/validate.js";
import { cli, git, REPO_ROOT, tmp } from "./helpers.js";

/**
 * ADR-0027 amendment 2026-11-12: the log retention warning of `platform validate instance`, and with
 * `--base` the rule that the network of an environment with apps doesn't change (network-change.ts).
 */

type Obj = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const EXAMPLE = readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8");
const example = (mutate?: (d: Obj) => void): Obj => {
  const d = parse(EXAMPLE) as Obj;
  mutate?.(d);
  return d;
};
const env = (d: Obj, name: string): Obj => (d.environments as Obj[]).find((e) => e.name === name)!;
const app = (slug: string, envs: string[], extra: Obj = {}): string =>
  stringify({ slug, environments: Object.fromEntries(envs.map((e) => [e, {}])), ...extra });

describe("log retention against the unused-app rule (warning)", () => {
  it("warns when the logs are kept for less time than the rule, never fails", () => {
    const short = validateInstanceDefinition(stringify(example((d) => (d.observability.logRetentionDays = 30))));
    assert.equal(short.ok, true);
    assert.equal(short.warnings.length, 1);
    assert.equal(short.warnings[0]!.checkId, "log-retention-lifecycle");
    assert.equal(short.warnings[0]!.path, "observability.logRetentionDays");
    assert.match(short.warnings[0]!.message, /kept 30 days .* only after 60 days/);
  });

  it("is quiet with the defaults (90 days of logs, 60 days for the rule) and with equal values", () => {
    assert.deepEqual(validateInstanceDefinition(EXAMPLE).warnings, []);
    const none = example((d) => {
      delete d.observability.logRetentionDays;
      delete d.lifecycle;
    });
    assert.deepEqual(validateInstanceDefinition(stringify(none)).warnings, []);
    const equal = example((d) => {
      d.observability.logRetentionDays = 45;
      d.lifecycle.unusedAfterDaysWithoutRequests = 45;
    });
    assert.deepEqual(validateInstanceDefinition(stringify(equal)).warnings, []);
  });

  it("points at the lifecycle rule when the retention is the default", () => {
    const d = example((x) => {
      delete x.observability.logRetentionDays;
      x.lifecycle.unusedAfterDaysWithoutRequests = 120;
    });
    const r = validateInstanceDefinition(stringify(d));
    assert.equal(r.warnings[0]?.path, "lifecycle.unusedAfterDaysWithoutRequests");
  });

  it("prints the warning and exits 0 on the command line", () => {
    const file = join(tmp("pc-ret-"), "instance.yaml");
    writeFileSync(file, stringify(example((d) => (d.observability.logRetentionDays = 30))));
    const r = cli(["validate", "instance", file]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Warnings:\n {2}line \d+: observability\.logRetentionDays: .*platform rules --explain log-retention-lifecycle/);
  });
});

describe("network fields (network-change.ts)", () => {
  it("lists the fields, those fixed once deployed first among the CAE's", () => {
    const fixed = NETWORK_FIELDS.filter((f) => f.fixedOnceDeployed).map((f) => f.path);
    assert.ok(fixed.includes("networkModes.externalOnly.network"));
    assert.ok(fixed.includes("networkModes.externalHybrid.caeSubnetPrefix"));
    assert.ok(fixed.includes("networkModes.externalHybrid.privateEndpointSubnetPrefix"));
    assert.ok(fixed.includes("networkModes.externalHybrid.vnet.existingVnetId"));
    assert.ok(fixed.includes("hub.vnetId"));
    const open = NETWORK_FIELDS.filter((f) => !f.fixedOnceDeployed).map((f) => f.path);
    assert.ok(open.includes("networkModes.externalOnly.vnetAddressSpace"));
    assert.ok(open.includes("networkModes.externalHybrid.routeTableId"));
    assert.ok(open.includes("networkModes.externalHybrid.dnsServers"));
    assert.ok(open.includes("hub.firewallPrivateIp"));
  });

  it("counts the schema's defaults as set", () => {
    const a = { networkModes: { externalOnly: {} } };
    const b = { networkModes: { externalOnly: { network: "managed" } } };
    assert.equal(networkValue(a, "networkModes.externalOnly.network"), "managed");
    assert.deepEqual(changedNetworkFields(a, b), []);
    const v = { networkModes: { externalOnly: { network: "vnet" } } };
    assert.equal(networkValue(v, "networkModes.externalOnly.natGatewayPublicIpCount"), 1);
    const h = { networkModes: { externalHybrid: { vnet: { create: { addressSpace: "10.0.0.0/23" } } } } };
    assert.deepEqual(networkValue(h, "networkModes.externalHybrid.dnsServers"), []);
    assert.equal(networkValue(h, "networkModes.externalHybrid.vnet.create.useRemoteGateways"), false);
  });

  it("compares only the modes and the hub both versions have", () => {
    const d = example();
    const before = env(d, "prod");
    const added = structuredClone(before);
    delete added.networkModes.externalHybrid;
    assert.deepEqual(changedNetworkFields(before, added), []);
    const moved = structuredClone(before);
    moved.networkModes.externalHybrid.routeTableId = moved.networkModes.externalHybrid.routeTableId.replace("rt-to-firewall", "rt-other");
    moved.hub.firewallPrivateIp = "10.0.1.5";
    assert.deepEqual(changedNetworkFields(before, moved).map((f) => f.path), ["hub.firewallPrivateIp", "networkModes.externalHybrid.routeTableId"]);
  });

  it("finds the environments in use, except a decommissioned app's from its deleteAfter on (ADR-0056)", () => {
    const apps = [
      { environments: { nonprod: {} } },
      { environments: { prod: {} }, decommission: { requestedOn: "2026-01-01", deleteAfter: "2026-02-01" } },
      { environments: "nonsense" },
    ];
    assert.deepEqual([...environmentsInUseOf(apps, "2026-02-01")], ["nonprod"], "the delete phase has started: it can't come back");
    assert.deepEqual([...environmentsInUseOf(apps, "2026-01-31")].sort(), ["nonprod", "prod"], "the grace period: Cancel would bring it back");
  });
});

describe("platform validate instance --base: the network of an environment with apps", () => {
  const changed = (d: Obj): void => {
    env(d, "prod").networkModes.externalHybrid.dnsServers = ["10.0.0.6"];
  };

  it("refuses a network change of an environment an app uses (library)", () => {
    const base = { instanceYamlText: EXAMPLE, appYamlTexts: [app("stock", ["nonprod", "prod"])] };
    const r = validateInstanceDefinition(stringify(example(changed)), base);
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1);
    assert.equal(r.problems[0]!.checkId, "environment-network-in-use");
    assert.match(r.problems[0]!.message, /networkModes\.externalHybrid\.dnsServers of environment prod changed, but apps run in prod/);
  });

  it("accepts it when no app uses the environment (or only an app past its deleteAfter does)", () => {
    const none = { instanceYamlText: EXAMPLE, appYamlTexts: [app("stock", ["nonprod"])] };
    assert.equal(validateInstanceDefinition(stringify(example(changed)), none).ok, true);
    const block = { decommission: { requestedOn: "2026-01-01", deleteAfter: "2026-02-01" } };
    const gone = { instanceYamlText: EXAMPLE, appYamlTexts: [app("stock", ["prod"], block)], today: "2026-02-01" };
    assert.equal(validateInstanceDefinition(stringify(example(changed)), gone).ok, true);
    const grace = { instanceYamlText: EXAMPLE, appYamlTexts: [app("stock", ["prod"], block)], today: "2026-01-20" };
    assert.equal(validateInstanceDefinition(stringify(example(changed)), grace).ok, false, "during the grace period the app still uses prod");
  });

  it("accepts every other change of an environment with apps (billing currency, egress baseline, cells)", () => {
    const base = { instanceYamlText: EXAMPLE, appYamlTexts: [app("stock", ["nonprod", "prod"])] };
    const other = example((d) => {
      const p = env(d, "prod");
      p.billingCurrency = "EUR";
      p.networkModes.externalHybrid.egressBaseline.reference = "CHG-2000";
      p.networkModes.externalOnly.cells[0].capacity.cores = 60;
    });
    assert.equal(validateInstanceDefinition(stringify(other), base).ok, true);
  });

  it("compares with the instance.yaml and the apps at the git ref, and the apps of the work tree", () => {
    const root = tmp("pc-inst-git-");
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "instance.yaml"), EXAMPLE);
    mkdirSync(join(root, "apps", "stock"), { recursive: true });
    writeFileSync(join(root, "apps", "stock", "app.yaml"), app("stock", ["nonprod"]));
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const file = join(root, "instance.yaml");
    writeFileSync(file, stringify(example(changed)));
    // Only nonprod has an app: prod's network may change.
    const ok = validateFile("instance", file, { base: "main" });
    assert.equal(ok.ok, true, JSON.stringify(ok.checks));
    assert.deepEqual(ok.base, { ref: "main", found: true });
    // An app added in the same change uses prod: refused.
    mkdirSync(join(root, "apps", "orders"), { recursive: true });
    writeFileSync(join(root, "apps", "orders", "app.yaml"), app("orders", ["prod"]));
    const bad = validateFile("instance", file, { base: "main" });
    assert.equal(bad.ok, false);
    assert.equal(bad.checks?.[0]?.checkId, "environment-network-in-use");
    const out = cli(["validate", "instance", file, "--base", "main"]);
    assert.equal(out.code, 1);
    assert.match(out.stdout, /apps run in prod/);
  });

  it("compares nothing when instance.yaml is new at the ref, and refuses --base for a manifest", () => {
    const root = tmp("pc-inst-git-");
    git(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, "README.md"), "x");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const file = join(root, "instance.yaml");
    writeFileSync(file, EXAMPLE);
    const r = validateFile("instance", file, { base: "main" });
    assert.equal(r.ok, true);
    assert.deepEqual(r.base, { ref: "main", found: false });
    assert.notEqual(cli(["validate", "manifest", file, "--base", "main"]).code, 0);
  });
});
