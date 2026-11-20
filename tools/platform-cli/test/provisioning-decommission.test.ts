import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadInstanceFile } from "../src/provisioning/model.js";
import { listApps } from "../src/provisioning/run.js";
import { decommissionPhases, desiredUnits, formatPlan, leftInEnvironment, parseUnitManifest, planUnits, readAppsDoc, REMOVED_RE } from "../src/provisioning/units.js";
import type { AppFacts, DesiredUnits, EnvFacts, PlanInput, RunPlan } from "../src/provisioning/units.js";
import { FIXTURES, tmp } from "./helpers.js";

// Decommissioning in the plan (ADR-0056): retire, the delete phase in two steps, only in the window.
const P = join(FIXTURES, "provisioning");
type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BLOCK = { requestedOn: "2026-10-01", deleteAfter: "2026-10-31", reason: "Replaced by demo-v2.", requestedBy: { objectId: "00000000-0000-0000-0000-00000000e001", displayName: "Jane Owner" } };
const TODAY = "2026-11-11";
const NOW = Date.parse(`${TODAY}T21:00:00Z`) / 1000; // Wednesday 21:00 UTC: inside the default window
const NOON = Date.parse(`${TODAY}T12:00:00Z`) / 1000; // outside it
const CORE = "v0.1.0-rc.3";

function config(changeApp?: (a: Doc) => void): { instance: string; apps: string } {
  const dir = join(tmp("pc-decom-units-"), "platform-config");
  cpSync(join(P, "config"), dir, { recursive: true });
  const ip = join(dir, "instance.yaml");
  const ap = join(dir, "apps", "demo", "app.yaml");
  if (changeApp) {
    const a = parse(readFileSync(ap, "utf8")) as Doc;
    changeApp(a);
    writeFileSync(ap, stringify(a));
  }
  const apps = join(dir, "apps.json");
  writeFileSync(apps, JSON.stringify(listApps({ instance: ip, appsDir: join(dir, "apps"), scope: "changed" })));
  return { instance: ip, apps };
}

const manifest = () =>
  parseUnitManifest({ schemaVersion: 1, units: Object.fromEntries(["lz", "entra", "release", "frontdoor", "pep", "ado"].map((u) => [u, { revision: 1, fingerprint: "a".repeat(64), since: "v0.1.0-rc.1" }])) }, "units.json");
const notes = () => ({ minAppVersion: "v0.1.0-rc.1", versions: {} });

/** Tags as an active app's finished run left them, with the active app's i. */
function activeTags(d: DesiredUnits, env: string): Doc {
  const t: Doc = {};
  const e = d.apps.demo!.environments[env] as Doc;
  for (const u of ["lz", "entra", "release", "pep"]) t[`saf-u-${u}`] = `${CORE} ${(e[u] as string).slice(0, 12)} 20261101`;
  t["saf-u-ado"] = `${CORE} ${d.apps.demo!.ado!.slice(0, 12)} 20261101`;
  return t;
}

const facts = (env: string, tags: Doc, over: Partial<AppFacts> = {}): AppFacts => ({
  resourceGroup: `rg-contoso-app-demo-${env}`,
  tags,
  lzRecord: "ok",
  federation: true,
  easyAuthInLandingZone: true,
  secret: { state: "present", created: NOW - 10 * 86_400, expires: NOW + 170 * 86_400, loaded: NOW - 10 * 86_400 },
  frontDoorRecord: false,
  rangesChanged: false,
  entraDeployment: `entra-demo-${env}`,
  resourceGroupExists: true,
  containerAppStopped: false,
  ...over,
});
const ENTRA_BOTH = [{ name: "entra-demo-nonprod", state: "Succeeded" }, { name: "entra-demo-prod", state: "Succeeded" }];
/** The plan of an environment; prod is the host (portal.hostEnvironment): it carries the Entra records. */
const envPlan = (env: string, f: AppFacts | undefined, entra: EnvFacts["entraRecords"] = ENTRA_BOTH): EnvFacts => ({
  environment: env,
  tagsRead: true,
  apps: f ? { demo: f } : {},
  failed: f ? [] : ["demo"],
  ...(env === "prod" ? { entraRecords: entra } : {}),
});

describe("plan-units: decommissioning (ADR-0056)", () => {
  const active = config();
  const retiredCfg = config((a) => (a.decommission = BLOCK));
  const dActive = desiredUnits(active);
  const dRetired = desiredUnits(retiredCfg);
  const appsRetired = readAppsDoc(retiredCfg.apps);

  const plan = (
    tags: { nonprod: Doc; prod: Doc },
    over: { nonprod?: Partial<AppFacts>; prod?: Partial<AppFacts>; input?: Partial<PlanInput>; prodFailed?: boolean; entra?: EnvFacts["entraRecords"] } = {},
  ): RunPlan =>
    planUnits({
      inst: loadInstanceFile(retiredCfg.instance),
      apps: appsRetired,
      desired: dRetired,
      manifest: manifest(),
      upgrades: notes(),
      plans: {
        nonprod: envPlan("nonprod", facts("nonprod", tags.nonprod, over.nonprod)),
        prod: envPlan("prod", over.prodFailed ? undefined : facts("prod", tags.prod, over.prod), over.entra === undefined ? ENTRA_BOTH : over.entra),
      },
      today: TODAY,
      now: NOW,
      ...over.input,
    });
  const ran = (p: RunPlan): string[] =>
    Object.entries(p.apps.demo!.environments)
      .flatMap(([env, e]) => Object.entries(e.units).filter(([, d]) => d!.run).map(([u, d]) => `${env}.${u}:${d!.action ?? "apply"}`))
      .sort();
  const on = (p: RunPlan): string[] => Object.entries(p.stages).filter(([, v]) => v).map(([k]) => k).sort();

  it("the block changes only release (retired: true) and ado (delivery: disabled), in every environment", () => {
    const a = dActive.apps.demo!;
    const r = dRetired.apps.demo!;
    assert.notEqual(a.ado, r.ado);
    for (const env of ["nonprod", "prod"]) {
      for (const u of ["lz", "entra", "frontdoor", "pep"]) assert.equal((a.environments[env] as Doc)[u], (r.environments[env] as Doc)[u], `${env}.${u}`);
      assert.notEqual((a.environments[env] as Doc).release, (r.environments[env] as Doc).release, `${env}.release`);
    }
    assert.equal(appsRetired.apps[0]!.decommission?.deleteAfter, "2026-10-31");
  });

  it("retire: release stops the app and ado disables the pipeline in every environment; the rest is frozen", () => {
    const p = plan({ nonprod: activeTags(dActive, "nonprod"), prod: activeTags(dActive, "prod") });
    assert.deepEqual(ran(p), ["nonprod.ado:apply", "nonprod.release:retire", "prod.ado:apply", "prod.release:retire"]);
    assert.deepEqual(on(p), ["ado", "post_nonprod", "post_prod", "record_nonprod", "record_prod"]);
    const n = p.apps.demo!.environments.nonprod!;
    assert.deepEqual(n.retired, { tag: null, record: "20261111", remove: false });
    assert.match(n.units.lz!.details[0]!, /^frozen/);
    assert.equal(p.apps.demo!.decommission?.phase, "retired");
    assert.equal(p.apps.demo!.decommission?.dueOn, null, "no stop recorded yet");
    assert.match(formatPlan(p), /^decommissioned demo \(requested 2026-10-01, deleteAfter 2026-10-31\): stopped; the delete phase starts once every environment recorded its stop$/m);
  });

  it("retired and recorded: nothing runs, nothing is created, rotations and drift are frozen", () => {
    const t = (env: string): Doc => {
      const x = activeTags(dActive, env);
      x["saf-u-release"] = `${CORE} ${(dRetired.apps.demo!.environments[env] as Doc).release.slice(0, 12)} 20261105`;
      x["saf-u-ado"] = `${CORE} ${dRetired.apps.demo!.ado!.slice(0, 12)} 20261105`;
      x["saf-u-retired"] = "20261105";
      return x;
    };
    const quiet = plan({ nonprod: t("nonprod"), prod: t("prod") }, { nonprod: { containerAppStopped: true, secret: { state: "absent", created: null, expires: null, loaded: null } }, prod: { containerAppStopped: true, lzRecord: "absent" } });
    assert.deepEqual(ran(quiet), [], "an absent secret or landing-zone record runs nothing for a retired app");
    assert.equal(quiet.apps.demo!.decommission?.dueOn, "2026-12-05", "graceDays (30) after the stop, later than deleteAfter");
    // Found running again: stopped again, at any time (no time-based work).
    const running = plan({ nonprod: t("nonprod"), prod: t("prod") }, { input: { now: NOON }, nonprod: { containerAppStopped: true }, prod: { containerAppStopped: false } });
    assert.deepEqual(ran(running), ["prod.release:retire"]);
  });

  /** Tags of an app retired on `date`, with the step-1 units removed as listed. */
  const retiredTags = (env: string, date: string, removed: string[] = []): Doc => {
    const x = activeTags(dActive, env);
    // Checked recently (a drift check of ado in the window is the ordinary rule); stopped on `date`.
    x["saf-u-release"] = `${CORE} ${(dRetired.apps.demo!.environments[env] as Doc).release.slice(0, 12)} 20261105`;
    x["saf-u-ado"] = `${CORE} ${dRetired.apps.demo!.ado!.slice(0, 12)} 20261105`;
    x["saf-u-retired"] = date;
    for (const u of removed) x[`saf-u-${u}`] = "removed 20261110";
    return x;
  };
  const stopped = { nonprod: { containerAppStopped: true }, prod: { containerAppStopped: true } };

  it("delete phase, step 1: ado, entra and pep (frontdoor where it applies) with action delete; lz waits", () => {
    const p = plan({ nonprod: retiredTags("nonprod", "20261001"), prod: retiredTags("prod", "20261001") }, stopped);
    assert.equal(p.apps.demo!.decommission?.phase, "deleting");
    assert.equal(p.apps.demo!.decommission?.dueOn, "2026-10-31");
    assert.deepEqual(ran(p), ["nonprod.ado:delete", "nonprod.entra:delete", "nonprod.pep:delete", "prod.ado:delete", "prod.entra:delete", "prod.pep:delete"]);
    assert.deepEqual(on(p), ["ado", "post_prod", "record_nonprod", "record_prod"], "pep runs in the host's azure_post (prod); no landing-zone stage");
    const n = p.apps.demo!.environments.nonprod!;
    assert.match(n.units.entra!.record!, REMOVED_RE);
    assert.equal(n.units.entra!.record, "removed 20261111");
    assert.equal(n.units.lz!.run, false);
    assert.match(n.units.lz!.details[0]!, /waits until ado, entra, pep are removed/);
    assert.equal(p.stages.entraPlan, false, "entra deletes are planned in decide, never with their landing zone");
  });

  it("delete phase, step 2: lz with action delete once step 1 is recorded removed in that environment; ado again after it (the connection)", () => {
    const all = ["ado", "entra", "pep"];
    const p = plan({ nonprod: retiredTags("nonprod", "20261001", all), prod: retiredTags("prod", "20261001", ["ado", "entra"]) }, stopped);
    // Sandbox run 3421: Azure DevOps refuses to delete a service connection while the delivery
    // identity's federated credential exists; it goes with the group, so ado runs after azure_<env>.
    assert.deepEqual(ran(p), ["nonprod.ado:delete", "nonprod.lz:delete", "prod.ado:delete", "prod.pep:delete"]);
    assert.deepEqual(on(p), ["ado", "lz_nonprod", "post_prod", "record_nonprod", "record_prod"], "the delete of a landing zone has no second pass");
    assert.equal(p.apps.demo!.environments.nonprod!.units.ado!.record, "removed 20261110", "the removed tag is kept as it is");
    assert.equal(p.apps.demo!.environments.prod!.units.ado!.record, "removed 20261110");
    assert.match(p.apps.demo!.environments.nonprod!.units.lz!.details[0]!, /delete the resource group \(step 2\), then its service connection and its record/);
  });

  it("step 1: ado runs once for the app, the same in every planned environment (the stages read the first)", () => {
    const p = plan({ nonprod: {}, prod: retiredTags("prod", "20261001") }, { nonprod: gone, prod: { containerAppStopped: true } });
    assert.equal(p.apps.demo!.decommission?.phase, "deleting");
    const ado = (env: string) => p.apps.demo!.environments[env]!.units.ado!;
    assert.deepEqual([ado("nonprod").run, ado("nonprod").action, ado("nonprod").record], [true, "delete", null], "a gone environment: nothing to tag");
    assert.deepEqual([ado("prod").run, ado("prod").action, ado("prod").record], [true, "delete", "removed 20261111"]);
  });

  // What the lists say once everything is gone (ADR-0056 amendment 2026-11-12, deleted detected).
  const gone = { resourceGroupExists: false, lzRecord: "absent" as const, frontDoorRecord: false, containerAppStopped: null };

  it("what is left, from the lists alone: the group, the landing-zone record, the custom domain's record, the Entra record", () => {
    const f = facts("prod", {}, { ...gone });
    assert.deepEqual(leftInEnvironment("demo", "prod", f, new Set()), []);
    assert.deepEqual(leftInEnvironment("demo", "prod", facts("prod", {}), new Set(["entra-demo-prod"])), [
      "the resource group rg-contoso-app-demo-prod",
      "the landing-zone record lz-demo-prod",
      "the Entra registration's record entra-demo-prod",
    ]);
    assert.deepEqual(leftInEnvironment("demo", "prod", facts("prod", {}, { ...gone, frontDoorRecord: true }), null), ["the custom domain's record fd-demo-prod"], "an unread Entra list adds nothing here; the phase checks it");
  });

  it("deleted: due, every environment planned, nothing left anywhere, Entra read: nothing runs, at any time, and nobody marks it", () => {
    for (const now of [NOW, NOON]) {
      const p = plan({ nonprod: {}, prod: {} }, { nonprod: gone, prod: gone, entra: [{ name: "entra-other-prod", state: "Succeeded" }], input: { now } });
      assert.deepEqual(ran(p), []);
      assert.deepEqual(on(p), []);
      assert.equal(p.apps.demo!.decommission?.phase, "deleted", `now ${now}: the window gates work, and there is none`);
      assert.deepEqual(p.apps.demo!.decommission?.waits, []);
      assert.equal(p.apps.demo!.environments.prod!.gone, true);
      assert.equal(p.apps.demo!.environments.nonprod!.gone, true);
      assert.match(formatPlan(p), /^decommissioned demo \(requested 2026-10-01, deleteAfter 2026-10-31\): deleted: nothing is left in Azure \(read in this run\); nothing runs for it, the portal shows it as deleted$/m);
      assert.deepEqual(decommissionPhases(p), { schemaVersion: 1, today: TODAY, now, apps: { demo: { phase: "deleted", requestedOn: "2026-10-01", deleteAfter: "2026-10-31" } } });
    }
  });

  it("not deleted while something is left: an Entra record is deleted in the window (record writes nothing), and waits outside it", () => {
    const p = plan({ nonprod: {}, prod: {} }, { nonprod: gone, prod: gone, entra: [{ name: "entra-demo-prod", state: "Failed" }] });
    assert.equal(p.apps.demo!.decommission?.phase, "deleting", "an Entra record in any state is left");
    assert.deepEqual(ran(p), ["prod.entra:delete"]);
    assert.equal(p.apps.demo!.environments.prod!.units.entra!.record, null, "no group to tag");
    assert.equal(p.apps.demo!.environments.nonprod!.gone, true);
    assert.deepEqual(on(p), ["record_prod"], "compared in decide (no landing zone runs), recorded nowhere");
    const noon = plan({ nonprod: {}, prod: {} }, { nonprod: gone, prod: gone, entra: [{ name: "entra-demo-prod", state: "Succeeded" }], input: { now: NOON } });
    assert.deepEqual(ran(noon), []);
    assert.equal(noon.apps.demo!.decommission?.phase, "retired");
    assert.deepEqual(noon.apps.demo!.decommission?.waits, ["decommission: the delete phase waits for the maintenance window"]);
  });

  it("not deleted when the Entra records weren't read, or an environment wasn't planned", () => {
    const unread = plan({ nonprod: {}, prod: {} }, { nonprod: gone, prod: gone, entra: null });
    assert.equal(unread.apps.demo!.decommission?.phase, "deleting", "in the delete phase, and whether something is left can't be told");
    assert.deepEqual(ran(unread), []);
    assert.match(unread.apps.demo!.decommission!.waits[0]!, /the Entra records of prod were not read in this run/);
    const failed = plan({ nonprod: {}, prod: {} }, { nonprod: gone, prodFailed: true, entra: [] });
    assert.equal(failed.apps.demo!.decommission?.phase, "retired");
  });

  it("not deleted before deleteAfter, even with nothing left (Cancel is still possible)", () => {
    const early = config((a) => (a.decommission = { ...BLOCK, deleteAfter: "2026-12-01" }));
    const p = planUnits({
      inst: loadInstanceFile(early.instance),
      apps: readAppsDoc(early.apps),
      desired: desiredUnits(early),
      manifest: manifest(),
      upgrades: notes(),
      plans: { nonprod: envPlan("nonprod", facts("nonprod", {}, gone)), prod: envPlan("prod", facts("prod", {}, gone), []) },
      today: TODAY,
      now: NOW,
    });
    assert.equal(p.apps.demo!.decommission?.phase, "retired");
    assert.deepEqual(ran(p), [], "nothing to stop: the groups are gone");
  });

  it("the group gone, its landing-zone record left: step 2 resumes (lz delete only, nothing to tag); a custom domain's record left waits for a person", () => {
    const p = plan({ nonprod: {}, prod: retiredTags("prod", "20261001", ["ado", "entra", "pep"]) }, { nonprod: { ...gone, lzRecord: "ok", frontDoorRecord: true }, prod: { ...gone }, entra: [] });
    assert.equal(p.apps.demo!.decommission?.phase, "deleting");
    assert.deepEqual(ran(p), ["nonprod.ado:delete", "nonprod.lz:delete", "prod.ado:delete"], "the connection after the group, then the record (record_<env>)");
    assert.deepEqual(on(p), ["ado", "lz_nonprod", "record_nonprod", "record_prod"]);
    assert.deepEqual(p.apps.demo!.environments.nonprod!.units.ado!.record, null);
    assert.deepEqual(p.apps.demo!.environments.nonprod!.retired, { tag: null, record: null, remove: false });
    assert.match(p.apps.demo!.decommission!.waits.join("\n"), /in nonprod the custom domain's record fd-demo-nonprod is left without the resource group; a person removes it/);
    // Its Entra record waits until the landing-zone record is gone (never in the same run).
    const both = plan({ nonprod: {}, prod: {} }, { nonprod: { ...gone, lzRecord: "ok" }, prod: gone, entra: [{ name: "entra-demo-nonprod", state: "Succeeded" }] });
    assert.deepEqual(ran(both), ["nonprod.ado:delete", "nonprod.lz:delete", "prod.ado:delete"]);
    assert.equal(both.stages.entraPlan, false);
  });

  it("the retired phase never stops an app whose group is gone (nothing to stop, nothing to tag)", () => {
    const t = retiredTags("prod", "20261105");
    const p = plan({ nonprod: {}, prod: t }, { nonprod: { ...gone, lzRecord: "ok" }, prod: { containerAppStopped: true } });
    assert.equal(p.apps.demo!.decommission?.phase, "retired");
    assert.deepEqual(ran(p), []);
    assert.equal(p.apps.demo!.decommission?.dueOn, "2026-12-05", "the stop of the environment that still has its group");
  });

  it("an active app whose group is missing is created, never treated as deleted", () => {
    const p = planUnits({
      inst: loadInstanceFile(active.instance),
      apps: readAppsDoc(active.apps),
      desired: dActive,
      manifest: manifest(),
      upgrades: notes(),
      plans: { nonprod: envPlan("nonprod", facts("nonprod", {}, { ...gone, secret: null })), prod: envPlan("prod", facts("prod", activeTags(dActive, "prod"))) },
      today: TODAY,
      now: NOON,
    });
    assert.equal(p.apps.demo!.decommission, undefined);
    assert.equal(p.apps.demo!.environments.nonprod!.gone, undefined);
    assert.equal(p.apps.demo!.environments.nonprod!.units.lz!.run, true);
    assert.ok(p.apps.demo!.environments.nonprod!.units.lz!.reasons.includes("new"));
    assert.equal(p.apps.demo!.environments.nonprod!.units.lz!.action, undefined);
    assert.deepEqual(decommissionPhases(p).apps, {});
  });

  it("the delete phase only inside the maintenance window, only after deleteAfter and graceDays since the stop, only when every environment was planned", () => {
    const tags = { nonprod: retiredTags("nonprod", "20261001"), prod: retiredTags("prod", "20261001") };
    const noon = plan(tags, { ...stopped, input: { now: NOON } });
    assert.deepEqual(ran(noon), []);
    assert.equal(noon.apps.demo!.decommission?.phase, "retired");
    assert.deepEqual(noon.apps.demo!.decommission?.waits, ["decommission: the delete phase waits for the maintenance window"]);
    const recent = plan({ nonprod: retiredTags("nonprod", "20261020"), prod: retiredTags("prod", "20261001") }, stopped);
    assert.deepEqual(ran(recent), [], "nonprod stopped 22 days ago");
    assert.equal(recent.apps.demo!.decommission?.dueOn, "2026-11-19");
    const early = config((a) => (a.decommission = { ...BLOCK, deleteAfter: "2026-12-01" }));
    const e = planUnits({ inst: loadInstanceFile(early.instance), apps: readAppsDoc(early.apps), desired: desiredUnits(early), manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod", tags.nonprod, stopped.nonprod)), prod: envPlan("prod", facts("prod", tags.prod, stopped.prod)) }, today: TODAY, now: NOW });
    assert.deepEqual(ran(e), [], "before deleteAfter");
    const failed = plan(tags, { ...stopped, prodFailed: true });
    assert.deepEqual(ran(failed), [], "prod not planned: nothing is deleted anywhere");
    assert.equal(failed.apps.demo!.decommission?.phase, "retired");
  });

  it("Cancel: the active app's release and ado run (i changed back) and record removes saf-u-retired", () => {
    const appsActive = readAppsDoc(active.apps);
    const t = (env: string): Doc => retiredTags(env, "20261105");
    const p = planUnits({ inst: loadInstanceFile(active.instance), apps: appsActive, desired: dActive, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", facts("nonprod", t("nonprod"), { containerAppStopped: true })), prod: envPlan("prod", facts("prod", t("prod"), { containerAppStopped: true })) }, today: TODAY, now: NOON });
    assert.deepEqual(ran(p), ["nonprod.ado:apply", "nonprod.release:apply", "prod.ado:apply", "prod.release:apply"]);
    assert.deepEqual(p.apps.demo!.environments.prod!.retired, { tag: "20261105", record: null, remove: true });
    assert.equal(p.apps.demo!.decommission, undefined);
  });
});

describe("plan-units: immediate decommissioning (ADR-0056 amendment 2026-11-12)", () => {
  const IMMEDIATE = { ...BLOCK, requestedOn: TODAY, deleteAfter: TODAY, immediate: true };
  const noProd = (a: Doc): void => {
    delete a.environments.prod;
  };
  const activeCfg = config(noProd);
  const cfg = config((a) => {
    noProd(a);
    a.decommission = IMMEDIATE;
  });
  const dActive = desiredUnits(activeCfg);
  const d = desiredUnits(cfg);
  const apps = readAppsDoc(cfg.apps);
  const tagsOf = (removed: string[] = [], retired?: string): Doc => {
    const t: Doc = {};
    const e = dActive.apps.demo!.environments.nonprod as Doc;
    for (const u of ["lz", "entra", "release", "pep"]) t[`saf-u-${u}`] = `${CORE} ${(e[u] as string).slice(0, 12)} 20261101`;
    t["saf-u-ado"] = `${CORE} ${dActive.apps.demo!.ado!.slice(0, 12)} 20261101`;
    for (const u of removed) t[`saf-u-${u}`] = "removed 20261111";
    if (retired) t["saf-u-retired"] = retired;
    return t;
  };
  const plan = (tags: Doc, over: Partial<AppFacts> = {}): RunPlan =>
    planUnits({
      inst: loadInstanceFile(cfg.instance),
      apps,
      desired: d,
      manifest: manifest(),
      upgrades: notes(),
      plans: { nonprod: envPlan("nonprod", facts("nonprod", tags, over)), prod: envPlan("prod", undefined) },
      today: TODAY,
      now: NOON,
    });
  const ran = (p: RunPlan): string[] =>
    Object.entries(p.apps.demo!.environments)
      .flatMap(([env, e]) => Object.entries(e.units).filter(([, x]) => x!.run).map(([u, x]) => `${env}.${u}:${x!.action ?? "apply"}`))
      .sort();
  const on = (p: RunPlan): string[] => Object.entries(p.stages).filter(([, v]) => v).map(([k]) => k).sort();

  it("the apps list carries immediate", () => {
    assert.equal(apps.apps[0]!.decommission?.immediate, true);
    assert.deepEqual(apps.apps[0]!.environments, ["nonprod"]);
  });

  it("first run, outside the window, the day of the merge: the stop and step 1 together; the resource group waits", () => {
    const p = plan(tagsOf());
    assert.deepEqual(ran(p), ["nonprod.ado:delete", "nonprod.entra:delete", "nonprod.pep:delete", "nonprod.release:retire"]);
    assert.deepEqual(on(p), ["ado", "post_nonprod", "post_prod", "record_nonprod"], "no landing-zone stage: nothing in the group is deleted");
    const n = p.apps.demo!.environments.nonprod!;
    assert.deepEqual(n.retired, { tag: null, record: "20261111", remove: false });
    assert.equal(n.units.lz!.run, false);
    assert.match(n.units.lz!.details[0]!, /waits until ado, entra, pep are removed/);
    assert.deepEqual(p.apps.demo!.decommission, { phase: "deleting", requestedOn: TODAY, deleteAfter: TODAY, dueOn: TODAY, waits: [], immediate: true });
    assert.match(formatPlan(p), /^decommissioned demo \(requested 2026-11-11, immediate\): delete phase \(immediate: no grace period, no maintenance window\): step 1 .* in a later run$/m);
  });

  it("step 1 removed but the stop not recorded: the stop again, the resource group still waits", () => {
    const p = plan(tagsOf(["ado", "entra", "pep"]));
    assert.deepEqual(ran(p), ["nonprod.release:retire"]);
    assert.match(p.apps.demo!.environments.nonprod!.units.lz!.details[0]!, /waits until the stop is recorded/);
  });

  it("second run: step 2 at any time once step 1 and the stop are recorded", () => {
    const p = plan(tagsOf(["ado", "entra", "pep"], "20261111"), { containerAppStopped: true });
    assert.deepEqual(ran(p), ["nonprod.ado:delete", "nonprod.lz:delete"], "the service connection goes after the group, in the same run");
    assert.deepEqual(on(p), ["ado", "lz_nonprod", "record_nonprod"]);
    const running = plan(tagsOf(["ado", "entra", "pep"], "20261111"), { containerAppStopped: false });
    assert.deepEqual(ran(running), ["nonprod.ado:delete", "nonprod.lz:delete", "nonprod.release:retire"], "a running app is stopped again; its group goes in the same run");
  });

  it("an environment that wasn't planned: nothing is deleted", () => {
    const p = planUnits({ inst: loadInstanceFile(cfg.instance), apps, desired: d, manifest: manifest(), upgrades: notes(), plans: { nonprod: envPlan("nonprod", undefined), prod: envPlan("prod", undefined) }, today: TODAY, now: NOON });
    assert.deepEqual(ran(p), []);
    assert.equal(p.apps.demo!.decommission?.phase, "retired");
  });

  it("immediate on an app with production: invalid (nothing runs); a forged apps list is planned like an ordinary decommissioning", () => {
    const refused = config((a) => (a.decommission = IMMEDIATE));
    const entry = readAppsDoc(refused.apps).apps[0]!;
    assert.equal(entry.ok, false, "listApps validates with the instance: check decommission-immediate");
    // The plan checks again (fail closed) when an apps list says immediate for an app with production.
    const prodCfg = config((a) => (a.decommission = BLOCK));
    const dp = desiredUnits(prodCfg);
    const forged = readAppsDoc(prodCfg.apps);
    forged.apps[0]!.decommission!.immediate = true;
    const p = planUnits({
      inst: loadInstanceFile(prodCfg.instance),
      apps: forged,
      desired: dp,
      manifest: manifest(),
      upgrades: notes(),
      plans: { nonprod: envPlan("nonprod", facts("nonprod", activeTags(dp, "nonprod"))), prod: envPlan("prod", facts("prod", activeTags(dp, "prod"))) },
      today: TODAY,
      now: NOW,
    });
    assert.equal(p.apps.demo!.decommission?.phase, "retired");
    assert.equal(p.apps.demo!.decommission?.immediate, undefined);
    assert.match(p.apps.demo!.decommission!.waits[0]!, /immediate refused, the app has production \(prod\)/);
    assert.ok(!Object.values(p.apps.demo!.environments).some((e) => Object.values(e.units).some((x) => x?.action === "delete")), "nothing is deleted");
  });
});
