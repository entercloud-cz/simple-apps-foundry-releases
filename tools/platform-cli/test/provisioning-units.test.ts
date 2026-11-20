import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { adoOfflineView } from "../src/ado/plan.js";
import { instanceEnv, loadAppFile, loadInstanceFile, orderedEnvironments } from "../src/provisioning/model.js";
import { windowAt } from "../src/maintenance.js";
import { listApps } from "../src/provisioning/run.js";
import {
  compareVersions,
  desiredUnits,
  detectModeChange,
  driftOffset,
  filesHash,
  formatPlan,
  formatUnitTag,
  parseUnitManifest,
  parseUnitTag,
  parseUpgradeParam,
  planUnits,
  readAppsDoc,
} from "../src/provisioning/units.js";
import type { AppFacts, DesiredUnits, EnvFacts, PlanInput, RunPlan } from "../src/provisioning/units.js";
import { parseUpgradeNotes, requiredWith } from "../src/provisioning/upgrades.js";
import type { UpgradeNotes } from "../src/provisioning/upgrades.js";
import { cli, FIXTURES, tmp } from "./helpers.js";

// Provisioning by unit (ADR-0048): the offline views behind each unit's i, and the decision.
const P = join(FIXTURES, "provisioning");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A platform-config copy: instance.yaml and apps/demo/app.yaml, changed by the callbacks. */
function config(changeInstance?: (i: Doc) => void, changeApp?: (a: Doc) => void): { instance: string; apps: string } {
  const dir = join(tmp("pc-units-"), "platform-config");
  cpSync(join(P, "config"), dir, { recursive: true });
  const ip = join(dir, "instance.yaml");
  const ap = join(dir, "apps", "demo", "app.yaml");
  if (changeInstance) {
    const i = parse(readFileSync(ip, "utf8")) as Doc;
    changeInstance(i);
    writeFileSync(ip, stringify(i));
  }
  if (changeApp) {
    const a = parse(readFileSync(ap, "utf8")) as Doc;
    changeApp(a);
    writeFileSync(ap, stringify(a));
  }
  const apps = join(dir, "apps.json");
  writeFileSync(apps, JSON.stringify(listApps({ instance: ip, appsDir: join(dir, "apps"), scope: "changed" })));
  return { instance: ip, apps };
}

function units(changeInstance?: (i: Doc) => void, changeApp?: (a: Doc) => void): DesiredUnits {
  return desiredUnits(config(changeInstance, changeApp));
}

/** Which units' i differ between two renders: "<env>.<unit>" or "ado". */
function changed(a: DesiredUnits, b: DesiredUnits): string[] {
  const out: string[] = [];
  const x = a.apps.demo!;
  const y = b.apps.demo!;
  if (x.ado !== y.ado) out.push("ado");
  for (const env of Object.keys(x.environments)) {
    for (const u of Object.keys({ ...x.environments[env], ...y.environments[env] })) {
      if ((x.environments[env] as Doc)[u] !== (y.environments[env] as Doc)[u]) out.push(`${env}.${u}`);
    }
  }
  return out.sort();
}

describe("platform provisioning units: the offline views (ADR-0048)", () => {
  const base = units();

  it("renders every unit that applies, deterministically, from the files alone", () => {
    const d = base.apps.demo!;
    assert.match(d.ado!, /^[0-9a-f]{64}$/);
    assert.deepEqual(Object.keys(d.environments), ["nonprod", "prod"]);
    assert.deepEqual(Object.keys(d.environments.nonprod!), ["lz", "entra", "release", "frontdoor", "pep"]);
    assert.deepEqual(d.problems, []);
    assert.deepEqual(units(), base, "deterministic");
  });

  it("a role assignment changes only entra", () => {
    const u = units(undefined, (a) => a.authentication.assignments.push({ role: "Editor", principalType: "User", objectId: "00000000-0000-0000-0000-00000000e003", displayName: "Eve" }));
    assert.deepEqual(changed(base, u), ["nonprod.entra", "prod.entra"]);
  });

  it("ADR-0061: incarnation 0 written out changes nothing (every existing app keeps its i); a later incarnation changes only entra", () => {
    assert.deepEqual(changed(base, units(undefined, (a) => (a.incarnation = 0))), []);
    assert.deepEqual(changed(base, units(undefined, (a) => (a.incarnation = 1))), ["nonprod.entra", "prod.entra"]);
  });

  it("an instance setting no unit uses (the audit retention) changes nothing", () => {
    const u = units((i) => (i.observability = { ...(i.observability ?? {}), auditRetentionDays: 400 }));
    assert.deepEqual(changed(base, u), []);
  });

  it("the network of one environment changes lz and release of that environment's apps only", () => {
    const u = units((i) => {
      const prod = (i.environments as Doc[]).find((e) => e.name === "prod")!;
      prod.networkModes.externalOnly.vnetAddressSpace = "10.30.0.0/24";
      prod.networkModes.externalOnly.caeSubnetPrefix = "10.30.0.0/25";
      prod.networkModes.externalOnly.privateEndpointSubnetPrefix = "10.30.0.128/26";
      prod.networkModes.externalOnly.network = "managed";
      for (const k of ["vnetAddressSpace", "caeSubnetPrefix", "privateEndpointSubnetPrefix"]) delete prod.networkModes.externalOnly[k];
    });
    const c = changed(base, u);
    assert.ok(c.includes("prod.lz") && c.includes("prod.release"), c.join(" "));
    assert.ok(c.every((x) => x.startsWith("prod.")), `only prod: ${c.join(" ")}`);
  });

  it("a core version changes only ado (the Required template ref)", () => {
    const u = units((i) => (i.coreVersion = "v0.1.0-rc.4"));
    assert.deepEqual(changed(base, u), ["ado"]);
    assert.equal(u.coreVersion, "v0.1.0-rc.4");
  });

  it("a budget changes lz of that environment only; a custom domain changes frontdoor, release and entra", () => {
    assert.deepEqual(changed(base, units(undefined, (a) => (a.environments.prod.budget.monthlyAmount = 25))), ["prod.lz"]);
    const withFrontDoor = (i: Doc): void => {
      i.dns = { zones: [{ name: "contoso.com", provider: "manual", allowedEnvironments: ["nonprod", "prod"] }] };
      i.frontDoor = { mode: "managed", managed: { profiles: [{ environment: "nonprod" }] } };
    };
    const fd = units(withFrontDoor, (a) => (a.environments.nonprod.frontDoor = { hostName: "demo-test.contoso.com" }));
    assert.deepEqual(changed(units(withFrontDoor), fd), ["nonprod.entra", "nonprod.frontdoor", "nonprod.release"]);
  });

  it("an app without sign-in has no entra unit; external Front Door mode no frontdoor unit", () => {
    const anon = units((i) => (i.authentication.enforcement = "ownerChoice"), (a) => (a.authentication = { mode: "anonymous" })).apps.demo!;
    assert.equal(anon.environments.nonprod!.entra, undefined);
    const ext = units((i) => (i.frontDoor = { mode: "external", external: { profiles: [] } })).apps.demo!;
    assert.equal(ext.environments.nonprod!.frontdoor, undefined);
  });

  it("the CLI writes the same document", () => {
    const c = config();
    const out = join(tmp(), "unit-inputs.json");
    const r = cli(["provisioning", "units", "--instance", c.instance, "--apps", c.apps, "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), desiredUnits(c));
    assert.match(r.stdout, /^ok {2}demo: ado; nonprod: lz entra release frontdoor pep; prod: lz entra release frontdoor pep$/m);
  });

  it("the ado view carries the Required template ref and no Azure state", () => {
    const c = config();
    const inst = loadInstanceFile(c.instance);
    const app = loadAppFile(join(c.instance, "..", "apps", "demo", "app.yaml"), c.instance);
    const v = adoOfflineView(inst as never, app, orderedEnvironments(app, inst).map((e) => instanceEnv(inst, e.name)));
    const text = JSON.stringify(v);
    assert.match(text, /"repositoryRef":"refs\/tags\/v0\.1\.0-rc\.3"/);
    assert.doesNotMatch(text, /clientId/);
  });
});

describe("unit tags, versions and the drift offset", () => {
  it("orders versions like semver, pre-releases numerically", () => {
    const sorted = ["v0.1.0-rc.10", "v0.1.0", "v0.1.0-rc.9", "v0.0.9", "v0.1.0-rc.9.1", "v1.0.0-alpha", "v0.1.0-beta", "v0.1.1"].sort(compareVersions);
    assert.deepEqual(sorted, ["v0.0.9", "v0.1.0-beta", "v0.1.0-rc.9", "v0.1.0-rc.9.1", "v0.1.0-rc.10", "v0.1.0", "v0.1.1", "v1.0.0-alpha"]);
    assert.equal(compareVersions("v0.1.0-rc.32", "v0.1.0-rc.32"), 0);
    assert.throws(() => compareVersions("1.0.0", "v1.0.0"));
  });

  it("parses and formats saf-u-<unit> values; anything else counts as no tag", () => {
    const v = formatUnitTag("v0.1.0-rc.32", "abcdef0123456789".padEnd(64, "0"), "2026-11-11");
    assert.equal(v, "v0.1.0-rc.32 abcdef012345 20261111");
    assert.deepEqual(parseUnitTag(v), { version: "v0.1.0-rc.32", i12: "abcdef012345", date: "2026-11-11" });
    for (const bad of ["stale", "v0.1.0 abcdef012345 20261131", "v0.1.0  abcdef012345 20261111", "v0.1.0 ABCDEF012345 20261111", "0.1.0 abcdef012345 20261111", undefined, 7]) {
      assert.equal(parseUnitTag(bad), undefined, String(bad));
    }
  });

  it("spreads the first recorded date by a stable offset below driftCheckDays", () => {
    const seen = new Set<number>();
    for (let n = 0; n < 200; n++) {
      const o = driftOffset(`app-${n}`, "nonprod", "lz", 30);
      assert.ok(o >= 0 && o < 30);
      seen.add(o);
    }
    assert.ok(seen.size > 20, `spread over the cycle (${seen.size} distinct offsets)`);
    assert.equal(driftOffset("demo", "prod", "release", 30), driftOffset("demo", "prod", "release", 30));
    assert.notEqual(`${driftOffset("demo", "prod", "release", 30)}${driftOffset("demo", "prod", "lz", 30)}${driftOffset("demo", "nonprod", "release", 30)}`, "000");
    assert.equal(driftOffset("demo", "prod", "release", 1), 0);
  });

  it("parses the unit manifest", () => {
    const m = parseUnitManifest({ schemaVersion: 1, units: Object.fromEntries(["lz", "entra", "release", "frontdoor", "pep", "ado"].map((u) => [u, { revision: 1, fingerprint: "a".repeat(64), since: "v0.1.0-rc.32" }])), extra: true }, "units.json", "v0.1.0-rc.33");
    assert.equal(m.units.ado.since, "v0.1.0-rc.32");
  });
});

// ------------------------------------------------------------------------------------------
// The decision
// ------------------------------------------------------------------------------------------

const TODAY = "2026-11-11";
// Wednesday 21:00 UTC: inside the default maintenance window (mon-thu 20:00, 6 hours).
const NOW = Date.parse(`${TODAY}T21:00:00Z`) / 1000;
// Wednesday 12:00 UTC: outside it (the next one starts at 20:00).
const NOON = Date.parse(`${TODAY}T12:00:00Z`) / 1000;
const CORE = "v0.1.0-rc.3";

describe("platform provisioning plan-units: the decision (ADR-0048 section 4)", () => {
  const c = config();
  const desired = desiredUnits(c);
  const appsDoc = readAppsDoc(c.apps);
  const i = (env: string, unit: string): string => (unit === "ado" ? desired.apps.demo!.ado! : (desired.apps.demo!.environments[env] as Doc)[unit]);
  const notes = (minAppVersion = "v0.1.0-rc.1", versions: UpgradeNotes["versions"] = {}): UpgradeNotes => ({ minAppVersion, versions });
  const manifest = (since: Doc = {}) =>
    parseUnitManifest({ schemaVersion: 1, units: Object.fromEntries(["lz", "entra", "release", "frontdoor", "pep", "ado"].map((u) => [u, { revision: 1, fingerprint: "a".repeat(64), since: since[u] ?? "v0.1.0-rc.1" }])) }, "units.json");
  /** Every applying unit tagged as current, checked `date`. */
  const tags = (env: string, date = "20261101", version = CORE): Doc => {
    const t: Doc = {};
    for (const u of ["lz", "entra", "release", "pep", "ado"]) t[`saf-u-${u}`] = `${version} ${i(env, u).slice(0, 12)} ${date}`;
    return t;
  };
  const facts = (env: string, over: Partial<AppFacts> = {}): AppFacts => ({
    resourceGroup: `rg-contoso-app-demo-${env}`,
    tags: tags(env),
    lzRecord: "ok",
    federation: true,
    easyAuthInLandingZone: true,
    secret: { state: "present", created: NOW - 10 * 86_400, expires: NOW + 170 * 86_400, loaded: NOW - 10 * 86_400 },
    frontDoorRecord: false,
    rangesChanged: false,
    entraDeployment: `entra-demo-${env}`,
    ...over,
  });
  const envPlan = (env: string, f: AppFacts | undefined, extra: Partial<EnvFacts> = {}): EnvFacts => ({
    environment: env,
    tagsRead: true,
    apps: f ? { demo: f } : {},
    failed: f ? [] : ["demo"],
    ...(env === "prod" ? { entraRecords: [{ name: "entra-demo-nonprod", state: "Succeeded" }, { name: "entra-demo-prod", state: "Succeeded" }] } : {}),
    ...extra,
  });
  const plan = (over: { nonprod?: Partial<AppFacts>; prod?: Partial<AppFacts>; input?: Partial<PlanInput>; prodPlan?: Partial<EnvFacts>; nonprodPlan?: Partial<EnvFacts> } = {}): RunPlan =>
    planUnits({
      inst: loadInstanceFile(c.instance),
      apps: appsDoc,
      desired,
      manifest: manifest(),
      plans: { nonprod: envPlan("nonprod", facts("nonprod", over.nonprod), over.nonprodPlan), prod: envPlan("prod", facts("prod", over.prod), over.prodPlan) },
      upgrades: notes(),
      today: TODAY,
      now: NOW,
      ...over.input,
    });
  const ran = (p: RunPlan): string[] =>
    Object.entries(p.apps.demo!.environments)
      .flatMap(([env, e]) => Object.entries(e.units).filter(([, d]) => d!.run).map(([u, d]) => `${env}.${u}:${d!.reasons.join("+")}`))
      .sort();
  const on = (p: RunPlan): string[] => Object.entries(p.stages).filter(([, v]) => v).map(([k]) => k).sort();

  it("nothing to do when every unit is tagged with its i, recent and current", () => {
    const p = plan();
    assert.deepEqual(ran(p), []);
    assert.deepEqual(on(p), []);
    assert.equal(p.apps.demo!.environments.nonprod!.units.frontdoor, undefined, "no domain, no record, no tag: frontdoor doesn't apply");
    assert.equal(p.driftCheckDays, 30);
  });

  it("rule 1: an untagged unit runs (new) and is recorded backdated by its stable offset", () => {
    const t = tags("nonprod");
    delete t["saf-u-entra"];
    const p = plan({ nonprod: { tags: t } });
    assert.deepEqual(ran(p), ["nonprod.entra:new"]);
    // Its landing zone doesn't run: compared in the job decide (ADR-0050), so no stage entra_plan.
    assert.deepEqual(on(p), ["record_nonprod"]);
    const d = p.apps.demo!.environments.nonprod!.units.entra!;
    const offset = driftOffset("demo", "nonprod", "entra", 30);
    const day = new Date(Date.parse(`${TODAY}T00:00:00Z`) - offset * 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    assert.equal(d.record, `${CORE} ${i("nonprod", "entra").slice(0, 12)} ${day}`);
    assert.equal(d.tag, null);
  });

  it("rule 2 as ADR-0049 amends it: a tag older than the unit's since is outdated and held, with pre-release ordering", () => {
    const p = plan({ input: { manifest: manifest({ release: "v0.1.0-rc.3" }) }, nonprod: { tags: tags("nonprod", "20261101", "v0.1.0-rc.2") } });
    assert.deepEqual(ran(p), []);
    assert.deepEqual(on(p), []);
    const d = p.apps.demo!.environments.nonprod!.units.release!;
    assert.deepEqual([d.outdated, d.held, d.reasons, d.details], [true, true, ["held"], ["release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2"]]);
    assert.equal(p.apps.demo!.environments.nonprod!.units.lz!.outdated, false);
    const both = (since: string, version: string): RunPlan =>
      plan({ input: { manifest: manifest({ release: since }), apps: { ...appsDoc, upgrade: { all: true, apps: [] } } }, nonprod: { tags: tags("nonprod", "20261101", version) }, prod: { tags: tags("prod", "20261101", version) } });
    assert.deepEqual(ran(both("v0.1.0-rc.10", "v0.1.0-rc.9")), ["nonprod.release:upgrade+template", "prod.release:upgrade+template"]);
    assert.deepEqual(ran(both("v0.1.0-rc.9", "v0.1.0-rc.10")), []);
    const up = both("v0.1.0-rc.10", "v0.1.0-rc.9");
    assert.equal(up.apps.demo!.environments.nonprod!.units.release!.record, `${CORE} ${i("nonprod", "release").slice(0, 12)} 20261111`, "an existing tag records today");
  });

  it("rule 3: changed inputs run (inputs)", () => {
    const t = tags("prod");
    t["saf-u-lz"] = `${CORE} 000000000000 20261101`;
    assert.deepEqual(ran(plan({ prod: { tags: t } })), ["prod.lz:inputs"]);
  });

  it("rule 5: a unit last checked driftCheckDays ago runs (drift); maintenance.driftCheckDays applies", () => {
    const t = tags("prod", "20261101");
    t["saf-u-pep"] = `${CORE} ${i("prod", "pep").slice(0, 12)} 20261012`;
    assert.deepEqual(ran(plan({ prod: { tags: t } })), ["prod.pep:drift"]);
    t["saf-u-pep"] = `${CORE} ${i("prod", "pep").slice(0, 12)} 20261013`;
    assert.deepEqual(ran(plan({ prod: { tags: t } })), [], "29 days");
    const short = config((x) => (x.maintenance = { driftCheckDays: 7 }));
    const p = planUnits({ inst: loadInstanceFile(short.instance), apps: appsDoc, desired, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod", { tags: tags("nonprod", "20261110") })), prod: envPlan("prod", facts("prod", { tags: tags("prod", "20261104") })) }, today: TODAY, now: NOW });
    assert.deepEqual(ran(p), ["nonprod.ado:drift", "prod.ado:drift", "prod.entra:drift", "prod.lz:drift", "prod.pep:drift", "prod.release:drift"]);
  });

  it("rule 6: scope all runs every unit (all), never skips one", () => {
    const p = plan({ input: { apps: { ...appsDoc, checkAllApps: true } } });
    assert.equal(ran(p).length, 10);
    assert.ok(ran(p).every((x) => x.endsWith(":all")));
    assert.deepEqual(on(p), ["ado", "entraPlan", "lz_nonprod", "lz_prod", "post_nonprod", "post_prod", "record_nonprod", "record_prod"]);
  });

  it("ado runs for every environment of the app when any one needs it (a core version)", () => {
    const t = tags("nonprod");
    t["saf-u-ado"] = `v0.1.0-rc.2 ${"f".repeat(12)} 20261101`;
    const p = plan({ nonprod: { tags: t } });
    assert.deepEqual(ran(p), ["nonprod.ado:inputs", "prod.ado:inputs"]);
    assert.deepEqual(on(p), ["ado", "record_nonprod", "record_prod"]);
    const failed = planUnits({ inst: loadInstanceFile(c.instance), apps: appsDoc, desired, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod", { tags: t })), prod: envPlan("prod", undefined) }, today: TODAY, now: NOW });
    assert.equal(failed.apps.demo!.environments.prod!.plan, "failed");
    assert.equal(failed.apps.demo!.ado.run, false, "not planned in every environment");
    assert.deepEqual(on(failed), []);
  });

  describe("rule 4: dependencies", () => {
    it("a new landing zone runs lz, entra, release, pep and ado", () => {
      const p = plan({ nonprod: { lzRecord: "absent", secret: null } });
      assert.deepEqual(ran(p), ["nonprod.ado:dependency", "nonprod.entra:dependency", "nonprod.lz:dependency", "nonprod.pep:dependency", "nonprod.release:dependency", "prod.ado:dependency"]);
      assert.deepEqual(on(p), ["ado", "entraPlan", "lz_nonprod", "post_nonprod", "post_prod", "record_nonprod", "record_prod"]);
      assert.ok(p.apps.demo!.environments.nonprod!.units.lz!.details.includes("a new landing zone"));
    });

    it("a landing zone without the service connection's federation runs lz (second pass) and ado", () => {
      assert.deepEqual(ran(plan({ prod: { federation: false } })), ["nonprod.ado:dependency", "prod.ado:dependency", "prod.lz:dependency"]);
    });

    it("the Easy Auth secret: absent, not in the landing zone, due, a pending restart", () => {
      assert.deepEqual(ran(plan({ prod: { secret: { state: "absent", created: null, expires: null, loaded: null } } })), ["prod.entra:dependency", "prod.lz:dependency", "prod.release:dependency"]);
      assert.deepEqual(ran(plan({ prod: { easyAuthInLandingZone: false } })), ["prod.lz:dependency"]);
      assert.deepEqual(ran(plan({ prod: { secret: { state: "present", created: NOW - 70 * 86_400, expires: NOW + 110 * 86_400, loaded: NOW - 70 * 86_400 } } })), ["prod.entra:dependency", "prod.release:dependency"]);
      assert.deepEqual(ran(plan({ prod: { secret: { state: "present", created: NOW - 10 * 86_400, expires: NOW + 170 * 86_400, loaded: NOW - 99 * 86_400 } } })), ["prod.release:dependency"]);
      assert.deepEqual(ran(plan({ prod: { secret: { state: "present", created: NOW - 10 * 86_400, expires: NOW + 170 * 86_400, loaded: null } } })), ["prod.release:dependency"]);
    });

    it("no Entra record runs entra and release; unreadable records run entra only", () => {
      assert.deepEqual(ran(plan({ prodPlan: { entraRecords: [{ name: "entra-demo-prod", state: "Succeeded" }, { name: "entra-demo-nonprod", state: "Failed" }] } })), ["nonprod.entra:dependency", "nonprod.release:dependency"]);
      assert.deepEqual(ran(plan({ prodPlan: { entraRecords: null } })), ["nonprod.entra:dependency", "prod.entra:dependency"]);
    });

    it("changed Front Door backend ranges run the release; frontdoor and release run together", () => {
      assert.deepEqual(ran(plan({ nonprod: { rangesChanged: true } })), ["nonprod.release:dependency"]);
      const t = tags("nonprod");
      t["saf-u-frontdoor"] = `${CORE} ${i("nonprod", "frontdoor").slice(0, 12)} 20261101`;
      assert.deepEqual(ran(plan({ nonprod: { tags: t, rangesChanged: true } })), ["nonprod.frontdoor:dependency", "nonprod.release:dependency"]);
      t["saf-u-frontdoor"] = `${CORE} 000000000000 20261101`;
      assert.deepEqual(ran(plan({ nonprod: { tags: t } })), ["nonprod.frontdoor:inputs", "nonprod.release:dependency"]);
      assert.deepEqual(ran(plan({ nonprod: { frontDoorRecord: true } })), ["nonprod.frontdoor:new", "nonprod.release:dependency"], "a record without a request: a removal to finish");
    });
  });

  describe("time-based work only inside the maintenance window (ADR-0048 section 7, amended 2026-11-11)", () => {
    // The facts of NOW, moved to NOON with the same distances, so only the window differs.
    const at = (now: number, over: { nonprod?: Partial<AppFacts>; prod?: Partial<AppFacts>; input?: Partial<PlanInput> } = {}): RunPlan =>
      plan({ ...over, input: { now, ...over.input } });
    const secret = (now: number, createdAgo: number, expiresIn: number, loadedAgo: number | null = createdAgo): AppFacts["secret"] => ({
      state: "present",
      created: now - createdAgo * 86_400,
      expires: now + expiresIn * 86_400,
      loaded: loadedAgo === null ? null : now - loadedAgo * 86_400,
    });
    const waits = (p: RunPlan): string[] =>
      Object.entries(p.apps.demo!.environments)
        .flatMap(([env, e]) => Object.entries(e.units).filter(([, d]) => d!.waits.length).map(([u, d]) => `${env}.${u}:${d!.waits.join("+")}`))
        .sort();

    it("windowAt: start <= now < start + hours, on a window day, past midnight into the next day", () => {
      const w = { days: ["mon", "tue", "wed", "thu"] as ("mon" | "tue" | "wed" | "thu")[], start: "20:00", hours: 6 };
      const t = (iso: string): boolean => windowAt(w, new Date(iso)).inside;
      assert.equal(t("2026-11-11T19:59:59Z"), false, "Wednesday before the start");
      assert.equal(t("2026-11-11T20:00:00Z"), true, "Wednesday at the start");
      assert.equal(t("2026-11-12T01:59:59Z"), true, "Thursday early: Wednesday's window");
      assert.equal(t("2026-11-12T02:00:00Z"), false, "its end is exclusive");
      assert.equal(t("2026-11-13T21:00:00Z"), false, "Friday is no window day");
      assert.equal(t("2026-11-14T01:00:00Z"), false, "Saturday early: Friday had none");
      assert.equal(t("2026-11-13T01:00:00Z"), true, "Friday early: Thursday's window");
      assert.equal(windowAt({ days: ["sun"], start: "00:00", hours: 24 }, new Date("2026-11-15T23:59:00Z")).inside, true, "a 24-hour window");
      assert.equal(windowAt(w, new Date("2026-11-11T21:00:00Z")).end!.toISOString(), "2026-11-12T02:00:00.000Z");
    });

    it("the plan says where the run's time is; --now and --today must agree", () => {
      const inside = at(NOW);
      assert.deepEqual([inside.maintenance.inWindow, inside.maintenance.now, inside.maintenance.until], [true, NOW, "2026-11-12T02:00:00.000Z"]);
      const outside = at(NOON);
      assert.deepEqual([outside.maintenance.inWindow, outside.maintenance.until], [false, "2026-11-11T20:00:00.000Z"]);
      assert.throws(() => at(NOW + 86_400), /is not the UTC date of --now/);
    });

    it("drift checks wait for the window; the unit says so and keeps its tag", () => {
      const t = tags("prod", "20261101");
      t["saf-u-pep"] = `${CORE} ${i("prod", "pep").slice(0, 12)} 20261012`;
      assert.deepEqual(ran(at(NOW, { prod: { tags: t } })), ["prod.pep:drift"]);
      const p = at(NOON, { prod: { tags: t } });
      assert.deepEqual(ran(p), []);
      assert.deepEqual(on(p), []);
      assert.deepEqual(waits(p), ["prod.pep:drift check (last checked 2026-10-12)"]);
      assert.equal(p.apps.demo!.environments.prod!.units.pep!.tag, t["saf-u-pep"]);
    });

    it("a rotation due, its restart and the Front Door ranges wait; inside the window they run", () => {
      const due = (now: number) => ({ prod: { secret: secret(now, 70, 110) } });
      assert.deepEqual(ran(at(NOW, due(NOW))), ["prod.entra:dependency", "prod.release:dependency"]);
      assert.deepEqual(ran(at(NOON, due(NOON))), []);
      assert.deepEqual(waits(at(NOON, due(NOON))), ["prod.entra:Easy Auth rotation", "prod.release:Easy Auth rotation"]);
      const pending = (now: number) => ({ prod: { secret: secret(now, 10, 170, 99) } });
      assert.deepEqual(ran(at(NOW, pending(NOW))), ["prod.release:dependency"]);
      assert.deepEqual(waits(at(NOON, pending(NOON))), ["prod.release:Easy Auth restart"]);
      assert.deepEqual(ran(at(NOON, { nonprod: { rangesChanged: true } })), []);
      assert.deepEqual(waits(at(NOON, { nonprod: { rangesChanged: true } })), ["nonprod.release:Front Door backend ranges"]);
    });

    it("exceptions at any time: an urgent rotation (at most 14 days left) and its restart, an absent secret", () => {
      const urgent = at(NOON, { prod: { secret: secret(NOON, 170, 13) } });
      assert.deepEqual(ran(urgent), ["prod.entra:dependency", "prod.release:dependency"]);
      assert.ok(urgent.apps.demo!.environments.prod!.units.entra!.details.some((d) => /urgent: at most 14 days left/.test(d)));
      assert.deepEqual(ran(at(NOON, { prod: { secret: secret(NOON, 170, -2, 300) } })), ["prod.entra:dependency", "prod.release:dependency"], "expired");
      assert.deepEqual(ran(at(NOON, { prod: { secret: secret(NOON, 170, 15) } })), [], "15 days left waits");
      assert.deepEqual(ran(at(NOON, { prod: { secret: { state: "absent", created: null, expires: null, loaded: null } } })), ["prod.entra:dependency", "prod.lz:dependency", "prod.release:dependency"]);
    });

    it("a unit that runs for its own reason reports no wait; scope all and changed inputs run at any time", () => {
      const t = tags("nonprod");
      t["saf-u-release"] = `${CORE} 000000000000 20261101`;
      const p = at(NOON, { nonprod: { tags: t, rangesChanged: true } });
      assert.deepEqual(ran(p), ["nonprod.release:inputs"]);
      assert.deepEqual(waits(p), []);
      assert.equal(ran(at(NOON, { input: { apps: { ...appsDoc, checkAllApps: true } } })).length, 10);
    });

    it("the decision depends on the time and instance.yaml only: another window moves it", () => {
      const always = config((x) => (x.maintenance = { window: { days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "00:00", hours: 24 } }));
      const t = tags("prod", "20261001");
      const p = planUnits({ inst: loadInstanceFile(always.instance), apps: appsDoc, desired, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod")), prod: envPlan("prod", facts("prod", { tags: t })) }, today: TODAY, now: NOON });
      assert.ok(ran(p).includes("prod.lz:drift"), ran(p).join(" "));
    });
  });

  it("the stage outputs: the host's releases stage runs for any environment's portal-side endpoint", () => {
    const t = tags("nonprod");
    delete t["saf-u-pep"];
    const p = plan({ nonprod: { tags: t } });
    assert.deepEqual(ran(p), ["nonprod.pep:new"]);
    assert.deepEqual(on(p), ["post_prod", "record_nonprod"], "both share one subscription: no approval stage in nonprod");
    const split = config((x) => ((x.environments as Doc[]).find((e) => e.name === "nonprod")!.subscriptionId = "00000000-0000-0000-0000-00000000a002"));
    const q = planUnits({ inst: loadInstanceFile(split.instance), apps: appsDoc, desired, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod", { tags: t })), prod: envPlan("prod", facts("prod")) }, today: TODAY, now: NOW });
    assert.deepEqual(on(q), ["post_nonprod", "post_prod", "record_nonprod"], "another subscription: nonprod approves the connection");
  });

  it("unreadable tags count as none (every unit runs once); the legacy tag is reported for deletion", () => {
    const p = plan({ prodPlan: { tagsRead: false }, prod: { tags: { ...tags("prod"), "saf-provisioned": "f".repeat(64) } } });
    assert.ok(ran(p).filter((x) => x.startsWith("prod.")).every((x) => x.endsWith(":new")));
    assert.equal(p.apps.demo!.environments.prod!.legacyTag, "f".repeat(64));
  });

  it("the CLI reads the plan_<env> artifacts and writes units.json", () => {
    const dir = tmp();
    const write = (rel: string, data: unknown): void => {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), JSON.stringify(data));
    };
    for (const env of ["nonprod", "prod"]) {
      write(`plan_${env}/plan.json`, { environment: env, tagsRead: true, ...(env === "prod" ? { entraRecords: [{ name: "entra-demo-nonprod", state: "Succeeded" }, { name: "entra-demo-prod", state: "Succeeded" }] } : {}) });
      write(`plan_${env}/status/demo.${env}.json`, { status: "ok" });
      write(`plan_${env}/facts/demo.json`, facts(env));
    }
    write("plan_prod/facts/demo.json", { ...facts("prod"), tags: { ...tags("prod"), "saf-u-lz": "garbage" } });
    write("inputs.json", desired);
    write("units.json", manifest());
    write("upgrades.yaml", notes());
    const out = join(dir, "out.json");
    const args = ["provisioning", "plan-units", "--instance", c.instance, "--apps", c.apps, "--inputs", join(dir, "inputs.json"), "--manifest", join(dir, "units.json"), "--upgrades", join(dir, "upgrades.yaml"), "--plan", `nonprod=${join(dir, "plan_nonprod")}`, "--plan", `prod=${join(dir, "plan_prod")}`, "--today", TODAY, "--now", String(NOW), "--output", out];
    const r = cli(args);
    assert.equal(r.code, 0, r.stderr);
    const p = JSON.parse(readFileSync(out, "utf8")) as RunPlan;
    assert.deepEqual(ran(p), ["prod.lz:new"]);
    assert.match(r.stdout, /^run {6}demo in prod: lz \(new\)$/m);
    assert.match(r.stdout, /^Stages with work: lz_prod, post_prod, record_prod\.$/m);
    // A plan_<env> without its app's status: failed there, nothing runs for it.
    writeFileSync(join(dir, "plan_prod", "status", "demo.prod.json"), JSON.stringify({ status: "failed" }));
    assert.equal(cli(args).code, 0);
    assert.equal((JSON.parse(readFileSync(out, "utf8")) as RunPlan).apps.demo!.environments.prod!.plan, "failed");
    // unreleased units.json fails.
    write("units.json", { ...manifest(), units: { ...manifest().units, lz: { revision: 1, fingerprint: "a".repeat(64), since: "unreleased" } } });
    assert.equal(cli(args).code, 1);
    // upgrades.yaml with `unreleased` fails too (a run never sees it).
    write("units.json", manifest());
    write("upgrades.yaml", notes("v0.1.0-rc.1", { unreleased: {} }));
    const r2 = cli(args);
    assert.equal(r2.code, 1);
    assert.match(r2.stderr, /versions\.unreleased: this core is not a release/);
  });

  describe("ADR-0060: a network mode change", () => {
    const host = "ca-demo.old.example.io";
    const mc = (p: RunPlan, env: string) => p.apps.demo!.environments[env]!.modeChange;
    const action = (p: RunPlan, env: string) => p.apps.demo!.environments[env]!.units.release!.action;

    it("the live app in another mode's CAE moves: case A on the managed network, B in a VNet; lz, entra and release run", () => {
      // app.yaml says externalOnly; the app runs in the hybrid CAE in both environments.
      const p = plan({ nonprod: { containerAppMode: "externalHybrid", liveFqdn: host }, prod: { containerAppMode: "externalHybrid", liveFqdn: host } });
      assert.deepEqual(mc(p, "nonprod"), { from: "externalHybrid", to: "externalOnly", case: "A", fromHost: host, resume: false, waitsForWindow: null, fromCell: "01", toCell: "01" });
      assert.deepEqual(mc(p, "prod"), { from: "externalHybrid", to: "externalOnly", case: "B", fromHost: host, resume: false, waitsForWindow: null, fromCell: "01", toCell: "01" }, "prod inside the window moves");
      assert.deepEqual([action(p, "nonprod"), action(p, "prod")], ["move", "move"]);
      assert.deepEqual(ran(p), ["nonprod.entra:dependency", "nonprod.lz:dependency", "nonprod.release:dependency", "prod.entra:dependency", "prod.lz:dependency", "prod.release:dependency"]);
      assert.match(p.apps.demo!.environments.nonprod!.units.release!.details.join(" "), /network mode change externalHybrid to externalOnly \(case A\)/);
      assert.deepEqual(on(p), ["entraPlan", "lz_nonprod", "lz_prod", "post_nonprod", "post_prod", "record_nonprod", "record_prod"]);
      assert.match(formatPlan(p), /^move {5}demo in nonprod: externalHybrid to externalOnly \(case A: Easy Auth secret re-issued in the other vault\); short outage/m);
    });

    it("kind nonprod: an approved change, it moves outside the maintenance window too", () => {
      const p = plan({ nonprod: { containerAppMode: "externalHybrid", liveFqdn: host }, input: { now: NOON } });
      assert.equal(p.maintenance.inWindow, false);
      assert.equal(action(p, "nonprod"), "move");
      assert.equal(mc(p, "nonprod")!.waitsForWindow, null);
      assert.deepEqual(ran(p), ["nonprod.entra:dependency", "nonprod.lz:dependency", "nonprod.release:dependency"]);
    });

    it("kind prod outside the maintenance window (product owner, 2026-11-14): the prepare pass and Entra run now, the move waits for the window", () => {
      const p = plan({ prod: { containerAppMode: "externalHybrid", liveFqdn: host }, input: { now: NOON } });
      assert.equal(mc(p, "prod")!.waitsForWindow, p.maintenance.until);
      assert.equal(mc(p, "prod")!.waitsForWindow, "2026-11-11T20:00:00.000Z", "the next window's start");
      assert.equal(action(p, "prod"), "move", "the release still reaches the move step, which waits there");
      assert.deepEqual(ran(p), ["prod.entra:dependency", "prod.lz:dependency", "prod.release:dependency"]);
      assert.match(p.apps.demo!.environments.prod!.units.release!.details.join(" "), /the move waits for the maintenance window \(2026-11-11T20:00:00\.000Z\)/);
      assert.match(formatPlan(p), /^move {5}demo in prod: .*waits for the maintenance window \(2026-11-11T20:00:00\.000Z\): a production environment; the prepare pass and the Entra step run now, the app is untouched$/m);
      // A resumed move (the app is down already) never waits.
      const resumed = plan({ prod: { containerAppMode: "none", lzNetworkMode: "externalOnly", lzPrepareFrom: "externalHybrid" }, input: { now: NOON } });
      assert.equal(mc(resumed, "prod")!.waitsForWindow, null);
    });

    it("resumed: no Container App, the landing zone's prepare pass (or its own mode) names another mode", () => {
      const prepared = plan({ nonprod: { containerAppMode: "none", lzNetworkMode: "externalOnly", lzPrepareFrom: "externalHybrid" } });
      assert.deepEqual(mc(prepared, "nonprod"), { from: "externalHybrid", to: "externalOnly", case: "A", fromHost: null, resume: true, waitsForWindow: null, fromCell: null, toCell: "01" });
      const unprepared = plan({ prod: { containerAppMode: "none", lzNetworkMode: "externalHybrid", lzPrepareFrom: null } });
      assert.deepEqual(mc(unprepared, "prod"), { from: "externalHybrid", to: "externalOnly", case: "B", fromHost: null, resume: true, waitsForWindow: null, fromCell: null, toCell: "01" });
      assert.match(formatPlan(prepared), /the app is gone, the move resumes after its delete/);
    });

    it("no move: the same mode, an app never created, a CAE named for no mode, or the Container Apps unread", () => {
      for (const over of [
        { containerAppMode: "externalOnly" as const },
        { containerAppMode: "none" as const, lzNetworkMode: "externalOnly", lzPrepareFrom: null },
        { containerAppMode: "none" as const, lzRecord: "absent" as const, lzNetworkMode: "externalHybrid" },
        { containerAppMode: "unknown" as const },
        { containerAppMode: null },
        {},
      ]) {
        const p = plan({ nonprod: over });
        assert.equal(mc(p, "nonprod"), undefined, JSON.stringify(over));
        assert.notEqual(action(p, "nonprod"), "move");
      }
    });

    it("runtime state only: the units' i (their views) don't know modeChange, and a move is never held for an upgrade", () => {
      assert.deepEqual(desiredUnits(c), desired, "rendering again without facts gives the same inputs");
      const p = plan({
        input: { manifest: manifest({ release: CORE, lz: CORE }) },
        nonprod: { tags: tags("nonprod", "20261101", "v0.1.0-rc.2"), containerAppMode: "externalHybrid", liveFqdn: host },
        prod: { tags: tags("prod", "20261101", "v0.1.0-rc.2") },
      });
      const rel = p.apps.demo!.environments.nonprod!.units.release!;
      assert.deepEqual([rel.run, rel.held, rel.action], [true, false, "move"]);
      assert.ok(rel.reasons.includes("template"), "the move applies this core's template");
      assert.equal(p.apps.demo!.environments.prod!.units.release!.held, true, "the other environment still waits for its upgrade");
    });

    it("the follow-up: the secret left in the other variant's vault runs entra (remove-old), at any time", () => {
      const p = plan({ nonprod: { containerAppMode: "externalOnly", secretElsewhere: true }, input: { now: NOON } });
      assert.equal(p.apps.demo!.environments.nonprod!.followUp, "remove-old");
      assert.equal(mc(p, "nonprod"), undefined);
      assert.deepEqual(ran(p), ["nonprod.entra:dependency"]);
      assert.match(formatPlan(p), /^followup demo in nonprod: remove the Easy Auth secret and passwords left from the previous network variant$/m);
    });

    it("a decommissioned app never moves", () => {
      const decommissioned = { ...appsDoc, apps: appsDoc.apps.map((a) => ({ ...a, decommission: { requestedOn: "2026-11-01", deleteAfter: "2026-12-31" } })) };
      const p = plan({ nonprod: { containerAppMode: "externalHybrid", liveFqdn: host }, input: { apps: decommissioned } });
      assert.equal(mc(p, "nonprod"), undefined);
      assert.equal(action(p, "nonprod"), "retire");
    });

    it("any capacity cell (ADR-0053, ADR-0060 amendment 2026-11-16): the live app's cell is the source, app.yaml's the target", () => {
      const inCells = { ...appsDoc, apps: appsDoc.apps.map((a) => ({ ...a, cells: { nonprod: "03", prod: "01" } })) };
      const p = plan({ nonprod: { containerAppMode: "externalHybrid", containerAppCell: "02", liveFqdn: host }, input: { apps: inCells } });
      assert.deepEqual(mc(p, "nonprod"), { from: "externalHybrid", to: "externalOnly", case: "A", fromHost: host, resume: false, waitsForWindow: null, fromCell: "02", toCell: "03" });
      assert.equal(action(p, "nonprod"), "move");
      assert.match(p.apps.demo!.environments.nonprod!.units.release!.details.join(" "), /network mode change externalHybrid to externalOnly, cell 02 to cell 03 \(case A\)/);
      assert.match(formatPlan(p), /^move {5}demo in nonprod: externalHybrid to externalOnly, cell 02 to cell 03 \(case A: /m);
      // Resumed: no source cell (the app is gone), the target cell named.
      const resumed = plan({ nonprod: { containerAppMode: "none", lzNetworkMode: "externalOnly", lzPrepareFrom: "externalHybrid" }, input: { apps: inCells } });
      assert.deepEqual([mc(resumed, "nonprod")!.fromCell, mc(resumed, "nonprod")!.toCell], [null, "03"]);
      assert.match(formatPlan(resumed), /externalHybrid to externalOnly, into cell 03 \(case A/);
      // An apps.json with an invalid cell is refused; one without cells (older) reads as none.
      const raw = JSON.parse(readFileSync(c.apps, "utf8")) as { apps: Doc[] };
      assert.deepEqual(readAppsDoc(c.apps).apps[0]!.cells, { nonprod: "01", prod: "01" }, "provisioning apps writes every environment's cell");
      const file = join(tmp(), "apps.json");
      writeFileSync(file, JSON.stringify({ ...raw, apps: raw.apps.map((a) => ({ ...a, cells: { nonprod: "3" } })) }));
      assert.throws(() => readAppsDoc(file), /invalid cells entry/);
      writeFileSync(file, JSON.stringify({ ...raw, apps: raw.apps.map((a) => ({ ...a, cells: undefined })) }));
      assert.deepEqual(readAppsDoc(file).apps[0]!.cells, {});
    });

    it("detectModeChange on its own", () => {
      const f = (over: Partial<AppFacts>): AppFacts => ({ resourceGroup: "rg", tags: {}, lzRecord: "ok", federation: true, easyAuthInLandingZone: true, secret: null, frontDoorRecord: false, rangesChanged: false, entraDeployment: null, ...over });
      assert.deepEqual(detectModeChange("externalHybrid", f({ containerAppMode: "externalOnly", containerAppCell: "02" }), "managed", "01")?.fromCell, "02");
      assert.equal(detectModeChange("externalHybrid", f({ containerAppMode: "externalOnly" }), "managed")?.fromCell, "01", "an older facts file: cell 01");
      assert.equal(detectModeChange("externalHybrid", f({ containerAppMode: "externalOnly" }), "managed")?.toCell, "01");
      assert.equal(detectModeChange("internalOnly", f({ containerAppMode: "externalOnly" }), "managed"), undefined);
      assert.equal(detectModeChange("externalHybrid", f({ containerAppMode: "externalOnly" }), "vnet")?.case, "B");
      assert.equal(detectModeChange("externalHybrid", f({ containerAppMode: "externalOnly" }), "managed")?.case, "A");
      assert.equal(detectModeChange("externalHybrid", f({ containerAppMode: "externalHybrid", lzPrepareFrom: "externalOnly" }), "managed"), undefined, "moved already");
    });
  });

  describe("ADR-0049: outdated units wait for their upgrade", () => {
    const OLD = "v0.1.0-rc.2";
    const files12 = desired.apps.demo!.files.slice(0, 12);
    /** release and lz changed in rc.3; every unit applied by rc.2 (tagged with its i). */
    const behindPlan = (over: { nonprod?: Partial<AppFacts>; prod?: Partial<AppFacts>; input?: Partial<PlanInput>; date?: string; since?: Doc } = {}): RunPlan =>
      plan({
        input: { manifest: manifest(over.since ?? { release: CORE, lz: CORE }), ...over.input },
        nonprod: { tags: tags("nonprod", over.date ?? "20261101", OLD), ...over.nonprod },
        prod: { tags: tags("prod", over.date ?? "20261101", OLD), ...over.prod },
      });
    const unit = (p: RunPlan, env: string, u: string) => (p.apps.demo!.environments[env]!.units as Doc)[u];
    const upgrade = (apps: string[], all = false): Partial<PlanInput> => ({ apps: { ...appsDoc, upgrade: { all, apps } } });

    it("held: nothing runs, the units say behind", () => {
      const p = behindPlan();
      assert.deepEqual(ran(p), []);
      assert.deepEqual(on(p), []);
      for (const env of ["nonprod", "prod"]) for (const u of ["lz", "release"]) assert.equal(unit(p, env, u).held, true, `${env}.${u}`);
      assert.equal(unit(p, "nonprod", "entra").held, false);
      assert.deepEqual(unit(p, "prod", "lz").details, ["lz changed in v0.1.0-rc.3; applied by v0.1.0-rc.2"]);
      assert.equal(unit(p, "prod", "lz").tag, `${OLD} ${i("prod", "lz").slice(0, 12)} 20261101`, "the tag stays");
    });

    it("2.1: the app in the run's upgrade (or all) runs its outdated units, nothing else", () => {
      const want = ["nonprod.lz:upgrade+template", "nonprod.release:upgrade+template", "prod.lz:upgrade+template", "prod.release:upgrade+template"];
      assert.deepEqual(ran(behindPlan({ input: upgrade(["demo"]) })), want);
      assert.deepEqual(ran(behindPlan({ input: upgrade([], true) })), want);
      assert.deepEqual(ran(behindPlan({ input: upgrade(["other-app"]) })), [], "another app's upgrade holds this one");
      const p = behindPlan({ input: upgrade(["demo"]) });
      assert.deepEqual(on(p), ["lz_nonprod", "lz_prod", "post_nonprod", "post_prod", "record_nonprod", "record_prod"]);
      assert.deepEqual(p.upgrade, { all: false, apps: ["demo"] });
    });

    it("2.2: a unit applied by a version older than minAppVersion is upgraded by any run", () => {
      const p = behindPlan({ input: { upgrades: notes(CORE) } });
      assert.deepEqual(ran(p), ["nonprod.lz:minAppVersion+template", "nonprod.release:minAppVersion+template", "prod.lz:minAppVersion+template", "prod.release:minAppVersion+template"]);
      assert.equal(p.minAppVersion, CORE);
      assert.deepEqual(ran(behindPlan({ input: { upgrades: notes(OLD) } })), [], "at minAppVersion: held");
    });

    it("2.3: an outdated unit that runs anyway (inputs, dependency, new) applies this core's template; the others stay held", () => {
      assert.deepEqual(ran(behindPlan({ nonprod: { rangesChanged: true } })), ["nonprod.release:dependency+template"]);
      const t = tags("prod", "20261101", OLD);
      t["saf-u-lz"] = `${OLD} 000000000000 20261101`;
      const p = behindPlan({ prod: { tags: t } });
      assert.deepEqual(ran(p), ["prod.lz:inputs+template"], "no saf-u-files: a changed i is a changed input");
      assert.equal(unit(p, "prod", "release").held, true);
    });

    it("2.3: the units its upgrade notes require run with it (every version after the one that applied it)", () => {
      const req = (version: string): Partial<PlanInput> => ({
        upgrades: notes("v0.1.0-rc.1", { [version]: { release: { level: "optional", restart: true, entraApproval: false, requires: ["lz"], notes: { en: "x", cs: "x" } } } }),
      });
      assert.deepEqual(ran(behindPlan({ nonprod: { rangesChanged: true }, input: req(CORE) })), ["nonprod.lz:requires+template", "nonprod.release:dependency+template"]);
      assert.deepEqual(ran(behindPlan({ nonprod: { rangesChanged: true }, input: req(OLD) })), ["nonprod.release:dependency+template"], "a note of the applied version itself is not after it");
      assert.deepEqual(ran(behindPlan({ nonprod: { rangesChanged: true }, input: req(CORE), since: { release: CORE } })), ["nonprod.release:dependency+template"], "a required unit that is current doesn't run");
    });

    it("drift checks and scope all skip held units", () => {
      const drift = behindPlan({ date: "20261001" });
      assert.ok(!ran(drift).some((x) => /\.(lz|release):/.test(x)), ran(drift).join(" "));
      assert.ok(ran(drift).includes("prod.entra:drift"));
      const all = behindPlan({ input: { apps: { ...appsDoc, checkAllApps: true } } });
      assert.equal(ran(all).length, 6, ran(all).join(" "));
      assert.equal(unit(all, "nonprod", "release").held, true);
    });

    it("ado is never held", () => {
      assert.deepEqual(ran(behindPlan({ since: { ado: CORE } })), ["nonprod.ado:template", "prod.ado:template"]);
    });

    it("frontdoor and release: a drift check on one doesn't upgrade the other, which is held", () => {
      const t = tags("nonprod", "20261001");
      t["saf-u-frontdoor"] = `${OLD} ${i("nonprod", "frontdoor").slice(0, 12)} 20261101`;
      const p = plan({ input: { manifest: manifest({ frontdoor: CORE }) }, nonprod: { tags: t } });
      assert.equal(unit(p, "nonprod", "frontdoor").held, true);
      assert.equal(unit(p, "nonprod", "release").run, false);
      assert.deepEqual(unit(p, "nonprod", "release").details, ["deferred: frontdoor waits for its upgrade"]);
      const q = plan({ input: { manifest: manifest({ frontdoor: CORE }) }, nonprod: { tags: t, rangesChanged: true } });
      assert.ok(ran(q).includes("nonprod.frontdoor:dependency+template"), "a real dependency does");
    });

    it("rebase: an outdated unit whose i changed while saf-u-files did not is re-tagged, not run", () => {
      const t: Doc = { ...tags("nonprod", "20261101", OLD), "saf-u-files": files12 };
      t["saf-u-release"] = `${OLD} 000000000000 20261101`;
      const p = behindPlan({ nonprod: { tags: t } });
      assert.deepEqual(ran(p), []);
      const d = unit(p, "nonprod", "release");
      assert.equal(d.held, true);
      assert.equal(d.rebase, `${OLD} ${i("nonprod", "release").slice(0, 12)} 20261101`, "version and date kept, the new i");
      assert.deepEqual(d.details, ["release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2", "rebased"]);
      assert.deepEqual(on(p), ["record_nonprod"], "record writes the rebase");
      assert.equal(p.apps.demo!.environments.nonprod!.files, files12);
      assert.equal(p.apps.demo!.environments.nonprod!.filesTag, files12);
      // The files changed too: it runs (2.3), no rebase.
      const q = behindPlan({ nonprod: { tags: { ...t, "saf-u-files": "0".repeat(12) } } });
      assert.deepEqual(ran(q), ["nonprod.release:inputs+template"]);
      assert.equal(unit(q, "nonprod", "release").rebase, null);
      // Upgraded in the same run: no rebase, the record after it.
      const u = behindPlan({ nonprod: { tags: t }, input: upgrade(["demo"]) });
      assert.equal(unit(u, "nonprod", "release").rebase, null);
      assert.ok(ran(u).includes("nonprod.release:upgrade+template"));
    });
  });
});

describe("ADR-0049: the parameter upgrade, the files hash and the upgrade notes", () => {
  it("parseUpgradeParam: none, all, or up to 50 slugs, each once", () => {
    assert.deepEqual(parseUpgradeParam("none"), { all: false, apps: [] });
    assert.deepEqual(parseUpgradeParam("all"), { all: true, apps: [] });
    assert.deepEqual(parseUpgradeParam("demo, hotel-inventory"), { all: false, apps: ["demo", "hotel-inventory"] });
    const fifty = Array.from({ length: 50 }, (_, n) => `app${n}`).join(",");
    assert.equal(parseUpgradeParam(fifty).apps.length, 50);
    for (const bad of ["", "None", "demo,", "demo;x", "Demo", "demo,demo", `${fifty},app50`, "-x"]) {
      assert.throws(() => parseUpgradeParam(bad), (e: unknown) => e instanceof Error, bad);
    }
  });

  it("filesHash: app.yaml's bytes and instance.yaml without coreVersion and coreReleases", () => {
    const inst = { coreVersion: "v1.0.0", naming: { prefix: "contoso" }, environments: [] };
    const h = filesHash("slug: demo\n", inst);
    assert.match(h, /^[0-9a-f]{64}$/);
    assert.equal(filesHash("slug: demo\n", { ...inst, coreVersion: "v2.0.0" }), h, "a core upgrade alone keeps it");
    // ADR-0067: the first bump onto a core that knows coreReleases brings it along, and stays a bump alone.
    assert.equal(filesHash("slug: demo\n", { ...inst, coreVersion: "v2.0.0", coreReleases: { repository: "https://github.com/contoso/releases" } }), h);
    // The hash of an instance.yaml without coreReleases is the one every earlier core computed (pinned).
    assert.equal(h, filesHash("slug: demo\n", { naming: { prefix: "contoso" }, environments: [] }));
    assert.equal(filesHash("slug: demo\n", { environments: [], naming: { prefix: "contoso" }, coreVersion: "v1.0.0" }), h, "key order doesn't matter");
    assert.notEqual(filesHash("slug: demo\n# note\n", inst), h, "app.yaml bytes count");
    assert.notEqual(filesHash("slug: demo\n", { ...inst, naming: { prefix: "fabrikam" } }), h);
  });

  it("the unit inputs carry the files hash", () => {
    const d = units();
    assert.match(d.apps.demo!.files, /^[0-9a-f]{64}$/);
    assert.equal(units((x) => (x.coreVersion = "v9.9.9")).apps.demo!.files, d.apps.demo!.files);
    assert.notEqual(units(undefined, (a) => (a.description = "changed")).apps.demo!.files, d.apps.demo!.files);
  });

  it("parseUpgradeNotes and requiredWith", () => {
    const text = [
      "minAppVersion: v0.1.0-rc.2",
      "versions:",
      "  v0.1.0-rc.3:",
      "    release: {level: required, restart: true, entraApproval: false, requires: [lz], deadlineDays: 14, notes: {en: a, cs: b}}",
      "  v0.1.0-rc.5:",
      "    release: {level: optional, restart: false, entraApproval: false, requires: [entra], notes: {en: a, cs: b}}",
      "",
    ].join("\n");
    const n = parseUpgradeNotes(text);
    assert.equal(n.minAppVersion, "v0.1.0-rc.2");
    assert.deepEqual(requiredWith(n, "release", "v0.1.0-rc.2", "v0.1.0-rc.5"), ["lz", "entra"]);
    assert.deepEqual(requiredWith(n, "release", "v0.1.0-rc.3", "v0.1.0-rc.5"), ["entra"]);
    assert.deepEqual(requiredWith(n, "release", "v0.1.0-rc.2", "v0.1.0-rc.4"), ["lz"]);
    assert.deepEqual(requiredWith(n, "lz", "v0.1.0-rc.1", "v0.1.0-rc.5"), []);
    assert.throws(() => parseUpgradeNotes(text, "u", { coreVersion: "v0.1.0-rc.4" }), /after this run's core version/);
    assert.throws(() => parseUpgradeNotes(text.replace("requires: [lz]", "requires: [release]")), /names the unit itself/);
    assert.throws(() => parseUpgradeNotes(text.replace("level: optional", "level: optional, deadlineDays: 3")), /deadlineDays applies to level required only/);
    assert.throws(() => parseUpgradeNotes(text.replace("level: optional", "level: urgent")), /level/);
    assert.throws(() => parseUpgradeNotes("minAppVersion: v0.1.0\nversions:\n  unreleased: {}\n", "u", { release: true }), /not a release/);
    assert.doesNotThrow(() => parseUpgradeNotes("minAppVersion: v0.1.0\nversions:\n  unreleased: {}\n"));
  });
});
