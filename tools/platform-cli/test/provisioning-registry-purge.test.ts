import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { loadInstanceFile } from "../src/provisioning/model.js";
import {
  DELIVERY_TAG_RE,
  PURGE_EVERY_DAYS,
  PURGE_MAX_APPS,
  PURGE_TAG,
  decidePurge,
  formatPurgeTag,
  imageReferences,
  parseManifests,
  parsePurgeTag,
  planRegistryPurge,
} from "../src/provisioning/registry-purge.js";
import type { Manifest } from "../src/provisioning/registry-purge.js";
import { listApps } from "../src/provisioning/run.js";
import { desiredUnits, parseUnitManifest, planUnits, readAppsDoc } from "../src/provisioning/units.js";
import type { AppFacts, EnvFacts, PlanInput, RunPlan } from "../src/provisioning/units.js";
import { cli, FIXTURES, tmp } from "./helpers.js";

// The registry image purge (ADR-0059): the plan of which apps are purged, and the decision of what.
const P = join(FIXTURES, "provisioning");
const DAY = 86_400;
const TODAY = "2026-11-11";
// Wednesday 21:00 UTC: inside the default maintenance window (mon-thu 20:00, 6 hours); 12:00 outside.
const NOW = Date.parse(`${TODAY}T21:00:00Z`) / 1000;
const NOON = Date.parse(`${TODAY}T12:00:00Z`) / 1000;
const d = (c: string): string => `sha256:${c.repeat(64)}`;
const commit = (c: string): string => c.repeat(40);
const iso = (t: number): string => new Date(t * 1000).toISOString();

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** A build of `daysOld` days with delivery's commit tag. */
const build = (c: string, daysOld: number, over: Partial<Manifest> = {}): Manifest => ({
  digest: d(c),
  tags: [commit(c)],
  created: NOW - daysOld * DAY,
  updated: NOW - daysOld * DAY,
  deleteEnabled: true,
  ...over,
});

describe("registry-purge: the decision (ADR-0059)", () => {
  const base = { days: 90, keepLatest: 2, now: NOW };

  it("deletes old delivery builds, the oldest first, and keeps everything the rules protect", () => {
    const manifests = [
      build("1", 400), // deleted
      build("2", 300), // running elsewhere (by digest)
      build("3", 200, { deleteEnabled: false }), // locked
      build("4", 150, { tags: [commit("4"), "latest"] }), // a tag delivery doesn't write
      build("5", 120, { tags: [] }), // untagged: may belong to another manifest
      build("6", 100, { tags: [`${commit("6")}-4711`] }), // deleted ({commit}-{runId})
      build("7", 60), // younger than 90 days
      build("8", 30), // newest 2
      build("9", 1), // newest 2
      build("a", 500, { created: null, updated: null }), // no readable time
      build("b", 250, { tags: ["v1"] }), // running by tag
    ];
    const r = decidePurge({ ...base, manifests, protect: [`cr.example.io/demo@${d("2")}`, "cr.example.io/demo:v1"], mode: "purge", slug: "demo", environment: "nonprod" });
    assert.deepEqual(r.delete.map((x) => x.digest), [d("1"), d("6")]);
    assert.deepEqual(r.delete[1]!.tags, [`${commit("6")}-4711`]);
    assert.equal(r.delete[0]!.time, iso(NOW - 400 * DAY));
    assert.deepEqual(r.kept, { running: 2, newest: 2, young: 1, untagged: 1, locked: 1, otherTag: 1, unreadable: 1, deferred: 0 });
    assert.deepEqual([r.mode, r.slug, r.environment, r.total], ["purge", "demo", "nonprod", 11]);
  });

  it("the newest builds are kept however old, by the later of created and updated; ties by digest", () => {
    const manifests = [build("1", 900), build("2", 800, { updated: NOW - 5 * DAY }), build("3", 700)];
    const r = decidePurge({ ...base, keepLatest: 1, manifests, protect: [] });
    assert.deepEqual(r.delete.map((x) => x.digest), [d("1"), d("3")], "2 was updated 5 days ago: the newest, and young");
    assert.equal(r.kept.newest, 1);
    const tie = decidePurge({ ...base, keepLatest: 1, days: 1, manifests: [build("2", 400), build("1", 400)], protect: [] });
    assert.deepEqual(tie.delete.map((x) => x.digest), [d("2")], "same time: the lower digest is the newest");
  });

  it("keepLatest 1 never deletes the only build; nothing to delete when every build is young", () => {
    assert.deepEqual(decidePurge({ ...base, keepLatest: 1, manifests: [build("1", 999)], protect: [] }).delete, []);
    assert.deepEqual(decidePurge({ ...base, manifests: [build("1", 10), build("2", 20), build("3", 30)], protect: [] }).delete, []);
  });

  it("at most maxDeletes per run, the oldest first; the rest wait", () => {
    const manifests = ["1", "2", "3", "4", "5"].map((c, i) => build(c, 500 - i));
    const r = decidePurge({ ...base, keepLatest: 1, manifests, protect: [], maxDeletes: 2 });
    assert.deepEqual(r.delete.map((x) => x.digest), [d("1"), d("2")]);
    assert.equal(r.kept.deferred, 2);
  });

  it("refuses a retention it can't apply", () => {
    assert.throws(() => decidePurge({ ...base, days: 0, manifests: [], protect: [] }), /--days/);
    assert.throws(() => decidePurge({ ...base, keepLatest: 0, manifests: [], protect: [] }), /--keep-latest/);
    assert.throws(() => decidePurge({ ...base, now: 5, manifests: [], protect: [] }), /--now/);
  });

  it("parses az acr manifest list-metadata; a bad digest or a repeated one is unreadable", () => {
    const { manifests, unreadable } = parseManifests([
      { digest: d("1"), tags: [commit("1")], createdTime: "2026-01-01T00:00:00.1234567Z", lastUpdateTime: "2026-02-01T00:00:00Z", changeableAttributes: { deleteEnabled: false } },
      { digest: d("2"), createdTime: "yesterday" },
      { digest: "sha256:nope" },
      { digest: d("1") },
      "text",
    ]);
    assert.equal(unreadable, 3);
    assert.deepEqual(manifests[0], { digest: d("1"), tags: [commit("1")], created: Date.parse("2026-01-01T00:00:00Z") / 1000, updated: Date.parse("2026-02-01T00:00:00Z") / 1000, deleteEnabled: false });
    assert.deepEqual(manifests[1], { digest: d("2"), tags: [], created: null, updated: null, deleteEnabled: null });
    assert.throws(() => parseManifests({ value: [] }), /JSON array/);
  });

  it("image references: by digest, a bare digest, by tag (a registry port is no tag)", () => {
    const r = imageReferences([`cr.example.io/demo@${d("A")}`, d("b"), "cr.example.io:5000/demo:1.2", "cr.example.io:5000/demo", "x"]);
    assert.deepEqual([...r.digests].sort(), [d("a"), d("b")]);
    assert.deepEqual([...r.tags], ["1.2"]);
  });

  it("delivery's tags: the commit, or {commit}-{runId}", () => {
    assert.ok(DELIVERY_TAG_RE.test(commit("a")) && DELIVERY_TAG_RE.test(`${commit("a")}-123`));
    for (const t of ["latest", commit("a").slice(1), `${commit("a")}-x`, `sha256-${"a".repeat(64)}`]) assert.ok(!DELIVERY_TAG_RE.test(t), t);
  });

  it("the tag saf-registry-purge", () => {
    assert.equal(formatPurgeTag("2026-11-11", "dryRun"), "20261111 dryRun");
    assert.deepEqual(parsePurgeTag("20261111 purge"), { date: "2026-11-11", mode: "purge" });
    for (const v of ["20261131 purge", "20261111", "20261111 off", undefined]) assert.equal(parsePurgeTag(v), undefined, String(v));
  });
});

// ------------------------------------------------------------------------------------------
// The plan (job decide): which apps of which build environment
// ------------------------------------------------------------------------------------------

function config(changeInstance?: (i: Doc) => void, changeApp?: (a: Doc) => void): { instance: string; apps: string } {
  const dir = join(tmp("pc-purge-"), "platform-config");
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

describe("registry-purge: the plan (ADR-0059)", () => {
  const REG = "crcontosodemononprod1a2b3c";
  const setup = (changeInstance?: (i: Doc) => void, changeApp?: (a: Doc) => void) => {
    const c = config(changeInstance, changeApp);
    const desired = desiredUnits(c);
    const tags = (env: string): Record<string, string> => {
      const t: Record<string, string> = {};
      const units = desired.apps.demo!.environments[env] as Doc;
      for (const u of ["lz", "entra", "release", "pep"]) t[`saf-u-${u}`] = `v0.1.0-rc.3 ${String(units[u]).slice(0, 12)} 20261101`;
      t["saf-u-ado"] = `v0.1.0-rc.3 ${desired.apps.demo!.ado!.slice(0, 12)} 20261101`;
      return t;
    };
    const facts = (env: string, over: Partial<AppFacts> = {}): AppFacts => ({
      resourceGroup: `rg-contoso-app-demo-${env}`,
      tags: tags(env),
      lzRecord: "ok",
      federation: true,
      easyAuthInLandingZone: true,
      secret: { state: "present", created: NOW - 10 * DAY, expires: NOW + 170 * DAY, loaded: NOW - 10 * DAY },
      frontDoorRecord: false,
      rangesChanged: false,
      entraDeployment: `entra-demo-${env}`,
      images: [`${env}.example.io/demo@${d(env === "prod" ? "e" : "f")}`],
      registryName: env === "nonprod" ? REG : "crcontosodemoprod4d5e6f",
      registryPurgeRole: env === "nonprod",
      ...over,
    });
    const envPlan = (env: string, f: AppFacts | undefined): EnvFacts => ({
      environment: env,
      tagsRead: true,
      apps: f ? { demo: f } : {},
      failed: f ? [] : ["demo"],
      ...(env === "prod" ? { entraRecords: [{ name: "entra-demo-nonprod", state: "Succeeded" }, { name: "entra-demo-prod", state: "Succeeded" }] } : {}),
    });
    const run = (o: { nonprod?: Partial<AppFacts> | null; prod?: Partial<AppFacts> | null; now?: number; decommission?: boolean } = {}): { input: PlanInput; plan: RunPlan } => {
      const apps = readAppsDoc(c.apps);
      if (o.decommission) apps.apps[0]!.decommission = { requestedOn: "2026-11-01", deleteAfter: "2026-12-01" };
      const input: PlanInput = {
        inst: loadInstanceFile(c.instance),
        apps,
        desired,
        manifest: parseUnitManifest({ schemaVersion: 1, units: Object.fromEntries(["lz", "entra", "release", "frontdoor", "pep", "ado"].map((u) => [u, { revision: 1, fingerprint: "a".repeat(64), since: "v0.1.0-rc.1" }])) }, "units.json"),
        upgrades: { minAppVersion: "v0.1.0-rc.1", versions: {} },
        plans: {
          nonprod: envPlan("nonprod", o.nonprod === null ? undefined : facts("nonprod", o.nonprod)),
          prod: envPlan("prod", o.prod === null ? undefined : facts("prod", o.prod)),
        },
        today: TODAY,
        now: o.now ?? NOW,
      };
      return { input, plan: planUnits(input) };
    };
    const purge = (o: Parameters<typeof run>[0] = {}) => {
      const { input, plan } = run(o);
      return planRegistryPurge(input, plan);
    };
    return { purge, tags };
  };

  // The default mode is dryRun (deleting is the instance's explicit choice); these cases purge.
  const PURGE = (i: Doc): void => void (i.maintenance = { registryRetention: { mode: "purge" } });
  const s = setup(PURGE);

  it("without a setting it only reports (dryRun): the plan runs, the record says dryRun", () => {
    const r = setup().purge();
    assert.deepEqual([r.retention, r.environments.nonprod!.apps.demo!.run, r.environments.nonprod!.apps.demo!.record], [{ mode: "dryRun", days: 90, keepLatest: 10 }, true, "20261111 dryRun"]);
  });

  it("an app never purged: it runs in its build environment only, protecting what it runs everywhere", () => {
    const r = s.purge();
    assert.deepEqual(Object.keys(r.environments), ["nonprod"], "prod promotes from nonprod: never purged");
    assert.deepEqual(r.stages, { registry_nonprod: true });
    const a = r.environments.nonprod!.apps.demo!;
    assert.deepEqual([a.run, a.reason, a.record, a.registry, a.resourceGroup, a.tag], [true, "due (never purged)", "20261111 purge", REG, "rg-contoso-app-demo-nonprod", null]);
    assert.deepEqual(a.protect, [`nonprod.example.io/demo@${d("f")}`, `prod.example.io/demo@${d("e")}`]);
    assert.deepEqual([r.retention, r.everyDays, r.maxApps, r.inWindow, r.now], [{ mode: "purge", days: 90, keepLatest: 10 }, PURGE_EVERY_DAYS, PURGE_MAX_APPS, true, NOW]);
  });

  it("purged again 7 days after the last purge, or at once when the mode changed", () => {
    const at = (tag: string): boolean => s.purge({ nonprod: { tags: { ...s.tags("nonprod"), [PURGE_TAG]: tag } } }).environments.nonprod!.apps.demo!.run;
    assert.equal(at("20261105 purge"), false, "6 days ago");
    assert.equal(at("20261104 purge"), true, "7 days ago");
    assert.equal(at("20261110 dryRun"), true, "yesterday, but in dry-run mode");
    assert.equal(at("garbage"), true, "a malformed tag is due");
    const recent = s.purge({ nonprod: { tags: { ...s.tags("nonprod"), [PURGE_TAG]: "20261105 purge" } } });
    assert.deepEqual([recent.environments.nonprod!.apps.demo!.reason, recent.stages.registry_nonprod], ["last purge 2026-11-05; the next after 2026-11-12", false]);
  });

  it("outside the maintenance window a due purge waits", () => {
    const r = s.purge({ now: NOON });
    const a = r.environments.nonprod!.apps.demo!;
    assert.equal(a.run, false);
    assert.match(a.reason, /^due \(never purged\); waits for the maintenance window \(2026-11-11T20:00:00\.000Z\)$/);
    assert.deepEqual([r.environments.nonprod!.waiting, r.stages.registry_nonprod, r.inWindow], [1, false, false]);
  });

  it("nothing runs when what the app runs is unknown, its landing zone isn't ready or runs now", () => {
    const why = (o: Parameters<typeof s.purge>[0]): string => {
      const a = s.purge(o).environments.nonprod!.apps.demo!;
      assert.equal(a.run, false);
      return a.reason;
    };
    assert.equal(why({ prod: { images: null } }), "the Container Apps of prod could not be read: what it runs there is unknown");
    assert.equal(why({ prod: null }), "not planned in prod: what it runs there is unknown");
    assert.equal(why({ nonprod: { registryPurgeRole: false } }), "its landing zone has no purge role yet (it comes with the landing zone's upgrade, ADR-0059)");
    assert.equal(why({ nonprod: { registryName: null } }), "its landing-zone record names no valid registry");
    assert.equal(why({ nonprod: { lzRecord: "absent" } }), "no landing zone yet");
    const t = s.tags("nonprod");
    delete t["saf-u-lz"];
    assert.equal(why({ nonprod: { tags: t } }), "its landing zone runs in this run; the purge waits for the next window");
  });

  it("off, or a decommissioned app: nothing runs", () => {
    const off = setup((i) => (i.maintenance = { registryRetention: { mode: "off" } })).purge();
    assert.deepEqual([off.environments.nonprod!.apps.demo!.run, off.stages.registry_nonprod, off.retention.mode], [false, false, "off"]);
    const dry = setup((i) => (i.maintenance = { registryRetention: { mode: "dryRun", days: 120, keepLatest: 3 } })).purge();
    assert.deepEqual([dry.environments.nonprod!.apps.demo!.record, dry.retention], ["20261111 dryRun", { mode: "dryRun", days: 120, keepLatest: 3 }]);
    const decom = s.purge({ decommission: true });
    assert.deepEqual([decom.environments.nonprod!.apps.demo!.run, decom.environments.nonprod!.apps.demo!.reason], [false, "the app is being decommissioned"]);
  });

  it("at most PURGE_MAX_APPS per environment and run: never purged first, then the most overdue", () => {
    const { input, plan } = (() => {
      const c = config();
      const inst = loadInstanceFile(c.instance);
      const n = PURGE_MAX_APPS + 5;
      const slugs = Array.from({ length: n }, (_, k) => `app-${String(k).padStart(3, "0")}`);
      const facts = (slug: string, k: number): AppFacts => ({
        resourceGroup: `rg-contoso-app-${slug}-nonprod`,
        tags: k < 3 ? {} : { [PURGE_TAG]: formatPurgeTag(new Date((Date.parse(`${TODAY}T00:00:00Z`) / 1000 - (8 + (k % 50)) * DAY) * 1000).toISOString().slice(0, 10), "purge") },
        lzRecord: "ok",
        federation: true,
        easyAuthInLandingZone: true,
        secret: null,
        frontDoorRecord: false,
        rangesChanged: false,
        entraDeployment: null,
        images: [],
        registryName: "crcontosoappnonprod1a2b3c",
        registryPurgeRole: true,
      });
      const apps = { checkAllApps: false, upgrade: { all: false, apps: [] }, apps: slugs.map((slug) => ({ slug, file: "", ok: true, environments: ["nonprod"], authMode: "anonymous", frontDoorHosts: {} })) };
      const input = { inst, apps, plans: { nonprod: { environment: "nonprod", tagsRead: true, apps: Object.fromEntries(slugs.map((sl, k) => [sl, facts(sl, k)])), failed: [] } } } as unknown as PlanInput;
      const plan = { today: TODAY, maintenance: { now: NOW, inWindow: true, until: "2026-11-12T02:00:00.000Z" }, apps: {} } as unknown as RunPlan;
      return { input, plan };
    })();
    const r = planRegistryPurge(input, plan);
    const ep = r.environments.nonprod!;
    assert.deepEqual([ep.due, ep.deferred], [PURGE_MAX_APPS, 5]);
    for (const k of [0, 1, 2]) assert.equal(ep.apps[`app-00${k}`]!.run, true, "never purged: first");
    const deferred = Object.entries(ep.apps).filter(([, a]) => !a.run).map(([, a]) => a.reason);
    assert.ok(deferred.every((x) => x.endsWith(`; deferred to the next window (at most ${PURGE_MAX_APPS} apps per environment and run)`)), deferred[0]);
    // The deferred are the least overdue: their last purge is no older than any purged app's.
    const last = (reason: string): string => /last purge (\d{4}-\d{2}-\d{2})/.exec(reason)?.[1] ?? "0000-00-00";
    const ran = Object.values(ep.apps).filter((a) => a.run).map((a) => last(a.reason));
    assert.ok(deferred.every((x) => ran.every((y) => last(x) >= y)), deferred.join(" | "));
  });
});

// ------------------------------------------------------------------------------------------
// The CLI
// ------------------------------------------------------------------------------------------

describe("platform provisioning registry-purge", () => {
  const listing = [
    { digest: d("1"), tags: [commit("1")], createdTime: iso(NOW - 400 * DAY), lastUpdateTime: iso(NOW - 400 * DAY), changeableAttributes: { deleteEnabled: true } },
    { digest: d("2"), tags: [commit("2")], createdTime: iso(NOW - 300 * DAY), lastUpdateTime: iso(NOW - 300 * DAY), changeableAttributes: { deleteEnabled: true } },
    { digest: d("3"), tags: [commit("3")], createdTime: iso(NOW - 1 * DAY), lastUpdateTime: iso(NOW - 1 * DAY), changeableAttributes: { deleteEnabled: true } },
  ];

  it("a dry run from a listing: what would go, nothing deleted", () => {
    const dir = tmp("purge-cli-");
    const m = join(dir, "m.json");
    const out = join(dir, "d.json");
    writeFileSync(m, JSON.stringify(listing));
    const r = cli(["provisioning", "registry-purge", "--manifests", m, "--days", "90", "--keep-latest", "1", "--protect", d("2"), "--now", String(NOW), "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    const dec = JSON.parse(readFileSync(out, "utf8")) as Doc;
    assert.deepEqual([dec.mode, dec.delete.map((x: Doc) => x.digest)], ["dryRun", [d("1")]]);
    assert.match(r.stdout, /would delete \(dry run\) 1; kept: 1 running, 1 newest/);
  });

  it("with the run's plan: its retention, its protected images and the live read; refused for an app it doesn't purge", () => {
    const dir = tmp("purge-cli-");
    const m = join(dir, "m.json");
    const live = join(dir, "live.json");
    const plan = join(dir, "registry.json");
    const out = join(dir, "d.json");
    writeFileSync(m, JSON.stringify(listing));
    writeFileSync(live, JSON.stringify([`cr.example.io/demo@${d("1")}`, null]));
    const doc = {
      schemaVersion: 1,
      today: TODAY,
      now: NOW,
      inWindow: true,
      until: "",
      retention: { mode: "purge", days: 90, keepLatest: 1 },
      everyDays: 7,
      maxApps: 100,
      maxDeletes: 200,
      stages: { registry_nonprod: true },
      environments: { nonprod: { due: 1, deferred: 0, waiting: 0, apps: { demo: { run: true, reason: "due", tag: null, record: "20261111 purge", resourceGroup: "rg", registry: "cr", protect: [] }, other: { run: false } } } },
    };
    writeFileSync(plan, JSON.stringify(doc));
    const r = cli(["provisioning", "registry-purge", "--plan", plan, "--env", "nonprod", "--slug", "demo", "--manifests", m, "--live", live, "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    const dec = JSON.parse(readFileSync(out, "utf8")) as Doc;
    assert.deepEqual([dec.mode, dec.delete.map((x: Doc) => x.digest), dec.kept.running], ["purge", [d("2")], 1], "1 runs now (the live read): kept");
    const refused = cli(["provisioning", "registry-purge", "--plan", plan, "--env", "nonprod", "--slug", "other", "--manifests", m, "--output", out]);
    assert.equal(refused.code, 1);
    assert.match(refused.stderr, /the plan doesn't purge other in nonprod/);
    const mixed = cli(["provisioning", "registry-purge", "--plan", plan, "--env", "nonprod", "--slug", "demo", "--days", "1", "--manifests", m, "--output", out]);
    assert.equal(mixed.code, 1);
  });
});
