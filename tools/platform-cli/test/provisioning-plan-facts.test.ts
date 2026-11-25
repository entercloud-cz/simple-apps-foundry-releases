import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { epoch, planFacts, planNames, SETTLE_S } from "../src/provisioning/plan-facts.js";
import { listApps } from "../src/provisioning/run.js";
import { parseAppFacts } from "../src/provisioning/units.js";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";

// The read model of a plan job (ADR-0050): lists in, every app's facts, status and entries out.
const P = join(FIXTURES, "provisioning");
const SUB = "00000000-0000-0000-0000-00000000a001";
const NOW = Date.parse("2026-11-11T12:00:00Z") / 1000;
const CREATED = NOW - 10 * 86_400;
const RG = "rg-contoso-app-demo-nonprod";
const CA_ID = `/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.App/containerApps/ca-demo`;
const IMAGES = join(REPO_ROOT, "images", "images.json");
const DIGEST = (JSON.parse(readFileSync(IMAGES, "utf8")) as { images: Record<string, { digest: string }> }).images["saf-jobs"]!.digest;
const iso = (t: number): string => new Date(t * 1000).toISOString();

type Doc = Record<string, unknown>;

interface Setup {
  dir: string;
  instance: string;
  apps: string;
  bulk: string;
  out: string;
}

/** A platform-config copy, apps.json, and the lists of an environment where demo is provisioned. */
function setup(change: { groups?: Doc[] | null; lz?: Doc[] | null; ca?: Doc[] | null; jobs?: Doc[] | null; secrets?: Doc[] | null; fd?: Doc[] | null; domains?: Doc[] | null; hosts?: Record<string, string> } = {}): Setup {
  const dir = tmp("pc-facts-");
  cpSync(join(P, "config"), join(dir, "config"), { recursive: true });
  const instance = join(dir, "config", "instance.yaml");
  const doc = listApps({ instance, appsDir: join(dir, "config", "apps"), scope: "changed" });
  if (change.hosts) for (const a of doc.apps) if (a.ok) a.frontDoorHosts = change.hosts;
  const apps = join(dir, "apps.json");
  writeFileSync(apps, JSON.stringify(doc));
  const bulk = join(dir, "bulk");
  mkdirSync(join(bulk, "secrets"), { recursive: true });
  mkdirSync(join(bulk, "revisions"), { recursive: true });
  const put = (name: string, v: Doc[] | null | undefined, dflt: Doc[]): void => {
    if (v === null) return;
    writeFileSync(join(bulk, name), JSON.stringify(v ?? dflt));
  };
  put("groups.json", change.groups, [{ name: RG, tags: { "saf-u-lz": "v0.1.0-rc.3 0123456789ab 20261101", owner: "x" } }]);
  put("lz-records.json", change.lz, [
    {
      name: "lz-demo-nonprod",
      properties: {
        provisioningState: "Succeeded",
        parameters: { deliveryFederation: { value: { issuer: "i", subject: "s" } }, easyAuthSecretExists: { value: true }, networkMode: { value: "externalOnly" } },
        outputs: { environmentKeyVaultName: { value: "kv-contoso-nonprod" }, containerAppFqdn: { value: "ca-demo.example.io" } },
      },
    },
  ]);
  put("container-apps.json", change.ca, [{ id: CA_ID, tags: { "saf-easyauth": String(CREATED) }, systemData: { lastModifiedAt: iso(CREATED - 86_400) } }]);
  put("jobs.json", change.jobs, [{ id: `/subscriptions/${SUB}/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.App/jobs/caj-contoso-kvset-ext`, properties: { template: { containers: [{ image: `reg.example/saf-jobs@${DIGEST}` }] } } }]);
  put("fd-records.json", change.fd, []);
  put("fd-domains.json", change.domains, []);
  if (change.secrets !== null) {
    writeFileSync(join(bulk, "secrets", "kv-contoso-nonprod.json"), JSON.stringify(change.secrets ?? [{ name: "easyauth-demo", properties: { attributes: { created: CREATED, exp: CREATED + 180 * 86_400 } } }]));
  }
  return { dir, instance, apps, bulk, out: join(dir, "plan_nonprod") };
}

function run(s: Setup, extra: { fdRanges?: string } = {}) {
  return planFacts({ instance: s.instance, apps: s.apps, env: "nonprod", bulk: s.bulk, images: IMAGES, out: s.out, now: NOW, runId: "42", ...extra });
}

const json = (p: string): Doc => JSON.parse(readFileSync(p, "utf8")) as Doc;
const facts = (s: Setup) => parseAppFacts(json(join(s.out, "facts", "demo.json")), "facts");
const status = (s: Setup): Doc => json(join(s.out, "status", "demo.nonprod.json"));

describe("plan-facts (ADR-0050)", () => {
  it("every fact from the lists, and the entries the later stages read", () => {
    const s = setup();
    const r = run(s);
    assert.deepEqual([r.apps, r.ok, r.failed, r.lazy], [1, 1, [], []]);
    const f = facts(s);
    assert.equal(f.resourceGroup, RG);
    assert.deepEqual(f.tags, { "saf-u-lz": "v0.1.0-rc.3 0123456789ab 20261101" }, "only saf-* tags");
    assert.deepEqual([f.lzRecord, f.federation, f.easyAuthInLandingZone, f.frontDoorRecord, f.rangesChanged, f.entraDeployment], ["ok", true, true, false, false, "entra-demo-nonprod"]);
    assert.deepEqual(f.secret, { state: "present", created: CREATED, expires: CREATED + 180 * 86_400, loaded: CREATED }, "the tag names the version");
    assert.equal(status(s).status, "ok");
    assert.deepEqual(json(join(s.out, "lz-outputs", "demo.nonprod.json")).containerAppFqdn, { value: "ca-demo.example.io" });
    const entry = json(join(s.out, "secret", "demo.nonprod.json"));
    assert.deepEqual([entry.state, entry.vault, entry.jobReady, entry.jobState, entry.loaded], ["present", "kv-contoso-nonprod", true, "current", CREATED]);
    assert.equal(entry.job, `/subscriptions/${SUB}/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.App/jobs/caj-contoso-kvset-ext`);
    assert.deepEqual(json(join(s.out, "lazy.json")), { revisions: [] });
  });

  it("ADR-0059: what the app runs, its registry and the purge role, for the registry purge", () => {
    const plain = setup();
    run(plain);
    const f0 = facts(plain);
    assert.deepEqual([f0.images, f0.registryName, f0.registryPurgeRole], [[], null, false], "no images listed, a landing zone of an older core: no purge role");
    const lz = [
      {
        name: "lz-demo-nonprod",
        properties: {
          provisioningState: "Succeeded",
          parameters: { deliveryFederation: { value: { issuer: "i", subject: "s" } }, easyAuthSecretExists: { value: true }, networkMode: { value: "externalOnly" } },
          outputs: { environmentKeyVaultName: { value: "kv-contoso-nonprod" }, registryName: { value: "crcontosodemononprod1a2b3c" }, registryPurgeRole: { value: true } },
        },
      },
    ];
    const digest = `sha256:${"b".repeat(64)}`;
    const ca = [{ id: CA_ID, tags: { "saf-easyauth": String(CREATED) }, properties: { template: { containers: [{ image: `cr.example.io/demo@${digest}` }, { image: "bad image" }], initContainers: [{ image: "cr.example.io/demo:abc" }] } } }];
    const s = setup({ lz, ca });
    run(s);
    const f = facts(s);
    assert.deepEqual(f.images, [`cr.example.io/demo@${digest}`, "cr.example.io/demo:abc"], "containers and init containers; a malformed reference left out");
    assert.deepEqual([f.registryName, f.registryPurgeRole], ["crcontosodemononprod1a2b3c", true]);
    const gone = setup({ lz, ca: [] });
    run(gone);
    assert.deepEqual(facts(gone).images, [], "no Container App: nothing runs");
  });

  it("a pending restart from the app's last modification; the rotation gets only an exact version", () => {
    const after = setup({ ca: [{ id: CA_ID, tags: {}, systemData: { lastModifiedAt: iso(CREATED + SETTLE_S + 60) } }] });
    run(after);
    assert.equal(facts(after).secret!.loaded, CREATED, "modified after the version settled: a release started with it");
    assert.equal(json(join(after.out, "secret", "demo.nonprod.json")).loaded, null, "no exact version for the rotation");
    const before = setup({ ca: [{ id: CA_ID, tags: { "saf-easyauth": String(CREATED - 99) }, systemData: { lastModifiedAt: iso(CREATED + 60) } }] });
    run(before);
    assert.equal(facts(before).secret!.loaded, CREATED - 99, "every revision predates the version: pending");
    const unknown = setup({ ca: [{ id: CA_ID, tags: {} }] });
    assert.deepEqual(run(unknown).lazy, [{ slug: "demo", id: CA_ID }], "no lastModifiedAt: the revisions are read");
  });

  it("a rotation due within a day: the revisions are read (lazy), then decide exactly; a failed read fails the app", () => {
    const due = [{ name: "easyauth-demo", properties: { attributes: { created: NOW - 100 * 86_400, exp: NOW - 100 * 86_400 + 180 * 86_400 } } }];
    const s = setup({ secrets: due, ca: [{ id: CA_ID, tags: {}, systemData: { lastModifiedAt: iso(NOW) } }] });
    assert.deepEqual(run(s).lazy, [{ slug: "demo", id: CA_ID }]);
    writeFileSync(join(s.bulk, "revisions", "demo.json"), JSON.stringify([{ name: "r1", created: iso(NOW - 100 * 86_400 + SETTLE_S + 1) }]));
    const again = run(s);
    assert.deepEqual(again.lazy, []);
    assert.equal(json(join(s.out, "secret", "demo.nonprod.json")).loaded, NOW - 100 * 86_400, "every active revision started after the version");
    writeFileSync(join(s.bulk, "revisions", "demo.json"), JSON.stringify([{ name: "r1", created: iso(NOW - 100 * 86_400) }]));
    run(s);
    assert.equal(json(join(s.out, "secret", "demo.nonprod.json")).loaded, null, "a revision from before the version");
    writeFileSync(join(s.bulk, "revisions", "demo.failed"), "");
    const failed = run(s);
    assert.equal(failed.failed.length, 1);
    assert.equal(status(s).status, "failed");
  });

  it("a list that can't be read fails the apps that need it, never runs them blind", () => {
    for (const [what, change] of [
      ["tags", { groups: null }],
      ["lz records", { lz: null }],
      ["fd records", { fd: null }],
      ["vault secrets", { secrets: null }],
      ["jobs", { jobs: null }],
      ["Container Apps", { ca: null }],
    ] as const) {
      const s = setup(change);
      const r = run(s);
      assert.equal(r.failed.length, 1, what);
      assert.equal(status(s).status, "failed", what);
      // ADR-0064: a read that failed is PE003.
      assert.equal(status(s).code, "PE003", what);
      assert.equal(existsSync(join(s.out, "facts", "demo.json")), false, what);
    }
  });

  it("a record without parameters, or a usable record without outputs", () => {
    const noParams = setup({ lz: [{ name: "lz-demo-nonprod", properties: { provisioningState: "Succeeded", outputs: {} } }] });
    assert.match(run(noParams).failed[0]!.reason, /without parameters/);
    const failedLz = setup({ lz: [{ name: "lz-demo-nonprod", properties: { provisioningState: "Failed" } }] });
    run(failedLz);
    assert.deepEqual([facts(failedLz).lzRecord, facts(failedLz).secret], ["unusable", null]);
    const none = setup({ lz: [] });
    run(none);
    assert.equal(facts(none).lzRecord, "absent");
  });

  it("the custom domain: no ranges fails the app; the record, its domain and changed ranges from the lists", () => {
    const hosts = { nonprod: "demo.contoso.com" };
    assert.match(run(setup({ hosts })).failed[0]!.reason, /ranges could not be resolved/);
    const cd = `/subscriptions/${SUB}/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.Cdn/profiles/afd-contoso-nonprod/customDomains/cd-demo-contoso-com`;
    const s = setup({
      hosts,
      fd: [{ name: "fd-demo-nonprod", properties: { provisioningState: "Succeeded", outputs: { customDomainId: { value: cd } } } }],
      domains: [{ id: cd, properties: { domainValidationState: "Approved", deploymentStatus: "Succeeded" } }],
      ca: [{ id: CA_ID, tags: { "saf-easyauth": String(CREATED) }, properties: { configuration: { ingress: { ipSecurityRestrictions: [{ name: "afd-backend-0", ipAddressRange: "10.0.0.0/24" }] } } } }],
    });
    const ranges = join(s.dir, "ranges.json");
    writeFileSync(ranges, JSON.stringify({ ranges: ["10.0.0.0/24", "10.0.1.0/24"] }));
    assert.deepEqual(run(s, { fdRanges: ranges }).failed, []);
    assert.deepEqual([facts(s).frontDoorRecord, facts(s).rangesChanged], [true, true]);
    assert.deepEqual(json(join(s.out, "frontdoor", "demo.nonprod.domain.json")), { domainValidationState: "Approved", deploymentStatus: "Succeeded" });
    writeFileSync(ranges, JSON.stringify({ ranges: ["10.0.0.0/24"] }));
    run(s, { fdRanges: ranges });
    assert.equal(facts(s).rangesChanged, false);
  });

  it("epoch times, plan-names and the command line", () => {
    assert.equal(epoch("2026-11-11T12:00:00Z"), NOW);
    assert.equal(epoch("2026-11-11T12:00:00.123+00:00"), NOW);
    assert.equal(epoch("yesterday"), null);
    const s = setup();
    assert.deepEqual(planNames(s.instance, "prod"), {
      subscriptionId: SUB,
      platformResourceGroup: "rg-contoso-platform-prod",
      entraResourceGroup: "rg-contoso-entra",
      // ADR-0063: every environment's Entra records group, in list order.
      entraResourceGroups: { nonprod: "rg-contoso-entra-nonprod", prod: "rg-contoso-entra-prod" },
      // ADR-0060: prod offers External only in a VNet: the private vault, named once with that mode.
      vaultVariants: [{ variant: "private", mode: "externalOnly", modes: ["externalOnly"] }],
    });
    // --apps: the app resource groups by naming, which record_<env> writes tags on (ADR-0052).
    assert.deepEqual(planNames(s.instance, "nonprod", s.apps).appResourceGroups, { demo: "rg-contoso-app-demo-nonprod" });
    // ADR-0059: the Container App and the repository the registry purge reads.
    const n = planNames(s.instance, "nonprod", s.apps);
    assert.deepEqual([n.containerApps, n.registryRepositories], [{ demo: "ca-demo" }, { demo: "demo" }]);
    const r = cli(["provisioning", "plan-facts", "--instance", s.instance, "--apps", s.apps, "--env", "nonprod", "--bulk", s.bulk, "--images", IMAGES, "--output", s.out, "--now", String(NOW)]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Plan of nonprod: 1 app\(s\), 1 read, 0 failed\./);
    assert.deepEqual(json(join(s.bulk, "plan-facts.json")), { failed: [], warnings: [] });
  });
});

describe("plan-facts: a network mode change (ADR-0060)", () => {
  const PLATFORM = `/subscriptions/${SUB}/resourceGroups/rg-contoso-platform-nonprod`;
  const CAE = (abbr: string): string => `${PLATFORM}/providers/Microsoft.App/managedEnvironments/cae-contoso-${abbr}-nonprod`;
  const JOB = (abbr: string): string => `${PLATFORM}/providers/Microsoft.App/jobs/caj-contoso-kvset-${abbr}`;
  const lz = (mode: string, modeChange: Doc | null = null): Doc[] => [
    {
      name: "lz-demo-nonprod",
      properties: {
        provisioningState: "Succeeded",
        parameters: { deliveryFederation: { value: { issuer: "i", subject: "s" } }, easyAuthSecretExists: { value: true }, networkMode: { value: mode }, modeChange: { value: modeChange } },
        outputs: { environmentKeyVaultName: { value: mode === "externalHybrid" ? "kv-contoso-nonprod-n" : "kv-contoso-nonprod" }, containerAppFqdn: { value: "ca-demo.example.io" } },
      },
    },
  ];
  const app = (abbr: string | null): Doc[] =>
    abbr === null ? [] : [{ id: CA_ID, tags: { "saf-easyauth": String(CREATED) }, systemData: { lastModifiedAt: iso(CREATED + 7200) }, properties: { environmentId: CAE(abbr), configuration: { ingress: { fqdn: `ca-demo.${abbr}.example.io` } } } }];
  const both = (s: Setup, privateSecrets: Doc[]): void => {
    writeFileSync(join(s.bulk, "env-vaults.json"), JSON.stringify({ externalOnly: "kv-contoso-nonprod", externalHybrid: "kv-contoso-nonprod-n" }));
    writeFileSync(join(s.bulk, "secrets", "kv-contoso-nonprod-n.json"), JSON.stringify(privateSecrets));
  };
  const jobs = [JOB("ext"), JOB("hyb")].map((id) => ({ id, properties: { template: { containers: [{ image: `reg.example/saf-jobs@${DIGEST}` }] } } }));
  const SECRET = [{ name: "easyauth-demo", properties: { attributes: { created: CREATED, exp: CREATED + 180 * 86_400 } } }];
  const setMode = (s: Setup, mode: string): void => {
    const doc = json(s.apps) as { apps: Doc[] };
    for (const a of doc.apps) a.networkModes = { nonprod: mode };
    writeFileSync(s.apps, JSON.stringify(doc));
  };

  it("steady state: the live app's mode and host, the record's mode, no prepare pass, nothing elsewhere", () => {
    const s = setup({ ca: app("ext"), lz: lz("externalOnly"), jobs });
    both(s, []);
    assert.deepEqual(run(s).failed, []);
    const f = facts(s);
    assert.deepEqual([f.containerAppMode, f.liveFqdn, f.lzNetworkMode, f.lzPrepareFrom, f.secretElsewhere], ["externalOnly", "ca-demo.ext.example.io", "externalOnly", null, false]);
    const entry = json(join(s.out, "secret", "demo.nonprod.json"));
    assert.deepEqual([entry.vault, entry.job, entry.appVault, entry.elsewhere], ["kv-contoso-nonprod", JOB("ext"), "kv-contoso-nonprod", null]);
  });

  it("app.yaml asks for another mode: the secret entry takes the vault and the kvset job of app.yaml's mode, not the record's", () => {
    const s = setup({ ca: app("ext"), lz: lz("externalOnly"), jobs });
    both(s, []);
    setMode(s, "externalHybrid");
    assert.deepEqual(run(s).failed, []);
    const f = facts(s);
    assert.deepEqual([f.containerAppMode, f.lzNetworkMode, f.secret?.state], ["externalOnly", "externalOnly", "absent"], "the target vault has no secret yet (case A)");
    const entry = json(join(s.out, "secret", "demo.nonprod.json"));
    assert.deepEqual([entry.vault, entry.job, entry.state, entry.appVault], ["kv-contoso-nonprod-n", JOB("hyb"), "absent", "kv-contoso-nonprod"]);
  });

  it("a prepare pass recorded and the app gone: the record's mode and its prepare pass's source", () => {
    const s = setup({ ca: app(null), lz: lz("externalHybrid", { phase: "prepare", fromNetworkMode: "externalOnly" }), jobs });
    both(s, SECRET);
    setMode(s, "externalHybrid");
    assert.deepEqual(run(s).failed, []);
    const f = facts(s);
    assert.deepEqual([f.containerAppMode, f.liveFqdn, f.lzNetworkMode, f.lzPrepareFrom], ["none", null, "externalHybrid", "externalOnly"]);
  });

  it("the follow-up: the secret left in the other variant's vault while the app runs in app.yaml's", () => {
    const s = setup({ ca: app("hyb"), lz: lz("externalHybrid"), jobs });
    both(s, SECRET);
    setMode(s, "externalHybrid");
    assert.deepEqual(run(s).failed, []);
    assert.equal(facts(s).secretElsewhere, true, "the public vault still holds easyauth-demo");
    const entry = json(join(s.out, "secret", "demo.nonprod.json"));
    assert.deepEqual([entry.vault, entry.appVault], ["kv-contoso-nonprod-n", "kv-contoso-nonprod-n"]);
    assert.deepEqual(entry.elsewhere, { vault: "kv-contoso-nonprod", job: JOB("ext"), jobReady: true, jobState: "current" });
    // While the app still runs in the old variant (a move that waits), it is no follow-up.
    const waiting = setup({ ca: app("ext"), lz: lz("externalHybrid", { phase: "prepare", fromNetworkMode: "externalOnly" }), jobs });
    both(waiting, SECRET);
    setMode(waiting, "externalHybrid");
    run(waiting);
    assert.equal(facts(waiting).secretElsewhere, false);
  });

  it("a CAE named for no mode is unknown; with a record of another mode than app.yaml the app fails its plan", () => {
    const ca = [{ id: CA_ID, properties: { environmentId: `${PLATFORM}/providers/Microsoft.App/managedEnvironments/cae-other` } }];
    const s = setup({ ca, lz: lz("externalOnly"), jobs });
    both(s, []);
    run(s);
    assert.equal(facts(s).containerAppMode, "unknown");
    const moved = setup({ ca, lz: lz("externalOnly"), jobs });
    both(moved, []);
    setMode(moved, "externalHybrid");
    assert.match(run(moved).failed[0]?.reason ?? "", /named for no network mode/);
  });

  it("capacity cells (ADR-0053): the live app's mode and cell from every cell instance.yaml lists; the kvset job of app.yaml's cell", () => {
    // nonprod's External only has cells 01 and 02 (the schema allows more; validate instance refuses them for now).
    const cells = (s: Setup, appCell: string): void => {
      const text = readFileSync(s.instance, "utf8");
      const withCells = text.replace("      externalOnly:\n        network: managed\n", '      externalOnly:\n        network: managed\n        cells:\n          - id: "01"\n          - id: "02"\n');
      assert.notEqual(withCells, text, "the fixture's nonprod External only gets a second cell");
      writeFileSync(s.instance, withCells);
      const doc = json(s.apps) as { apps: Doc[] };
      for (const a of doc.apps) a.cells = { nonprod: appCell };
      writeFileSync(s.apps, JSON.stringify(doc));
    };
    const c02 = [{ ...app("ext")[0]!, properties: { environmentId: `${CAE("ext")}-c02`, configuration: { ingress: { fqdn: "ca-demo.c02.example.io" } } } }];
    const cellJobs = [...jobs, { id: `${JOB("ext")}-c02`, properties: { template: { containers: [{ image: `reg.example/saf-jobs@${DIGEST}` }] } } }];
    // app.yaml: externalHybrid in cell 01; the app runs in cell 02 of External only: a move from there.
    const s = setup({ ca: c02, lz: lz("externalOnly"), jobs: cellJobs });
    both(s, []);
    setMode(s, "externalHybrid");
    cells(s, "01");
    assert.deepEqual(run(s).failed, []);
    assert.deepEqual([facts(s).containerAppMode, facts(s).containerAppCell, facts(s).liveFqdn], ["externalOnly", "02", "ca-demo.c02.example.io"]);
    // app.yaml: externalOnly in cell 02: the secret entry names the kvset job of cell 02.
    const own = setup({ ca: c02, lz: lz("externalOnly"), jobs: cellJobs });
    both(own, []);
    cells(own, "02");
    assert.deepEqual(run(own).failed, []);
    assert.equal(json(join(own.out, "secret", "demo.nonprod.json")).job, `${JOB("ext")}-c02`);
    assert.equal(facts(own).containerAppCell, "02");
    // app.yaml: externalOnly in cell 01 while the app runs in cell 02: no move between the cells of one mode.
    const other = setup({ ca: c02, lz: lz("externalOnly"), jobs: cellJobs });
    both(other, []);
    cells(other, "01");
    assert.match(run(other).failed[0]?.reason ?? "", /runs in capacity cell 02 of externalOnly, but app\.yaml names cell 01: the platform doesn't move an app between the cells of one network mode/);
    // A cell instance.yaml doesn't list is no CAE of the environment: unknown.
    const c03 = [{ ...c02[0]!, properties: { environmentId: `${CAE("ext")}-c03` } }];
    const unlisted = setup({ ca: c03, lz: lz("externalOnly"), jobs: cellJobs });
    both(unlisted, []);
    cells(unlisted, "01");
    run(unlisted);
    assert.deepEqual([facts(unlisted).containerAppMode, facts(unlisted).containerAppCell], ["unknown", null]);
    // Cell 01 as before: the steady state names cell 01.
    const plain = setup({ ca: app("ext"), lz: lz("externalOnly"), jobs });
    both(plain, []);
    run(plain);
    assert.equal(facts(plain).containerAppCell, "01");
  });

  it("the Container Apps unread while the record names another mode than app.yaml: the app fails its plan", () => {
    const s = setup({ ca: null, lz: lz("externalOnly"), jobs });
    both(s, []);
    setMode(s, "externalHybrid");
    const r = run(s);
    assert.equal(r.failed.length, 1);
    assert.match(r.failed[0]!.reason, /where the app runs can't be told/);
  });

  it("app.yaml's mode has no vault named for it in env-vaults.json: the app fails its plan", () => {
    const s = setup({ ca: app("ext"), lz: lz("externalOnly"), jobs });
    writeFileSync(join(s.bulk, "env-vaults.json"), JSON.stringify({ externalHybrid: "kv-contoso-nonprod-n" }));
    const r = run(s);
    assert.match(r.failed[0]?.reason ?? "", /no environment vault is named for its network mode externalOnly/);
  });
});

describe("plan-facts: a deleted app's slug used again (ADR-0061 section 4)", () => {
  /** demo with this generation; with an archive apps-deleted/demo/2026-10-01/app.yaml (a deleted app's definition) and incarnation 1. */
  function reuse(s: Setup, generation: number, archive = true): void {
    const file = join(s.dir, "config", "apps", "demo", "app.yaml");
    writeFileSync(file, readFileSync(file, "utf8").replace(/^generation: \d+$/m, `generation: ${generation}${archive ? "\nincarnation: 1" : ""}`));
    if (archive) {
      const dir = join(s.dir, "config", "apps-deleted", "demo", "2026-10-01");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "app.yaml"), "slug: demo\n");
    }
    writeFileSync(s.apps, JSON.stringify(listApps({ instance: s.instance, appsDir: join(s.dir, "config", "apps"), scope: "changed" })));
  }
  /** The landing-zone record of demo with this generation (undefined: the parameter is missing). */
  const lz = (generation: number | undefined, state = "Succeeded"): Doc[] => [
    {
      name: "lz-demo-nonprod",
      properties: {
        provisioningState: state,
        parameters: { networkMode: { value: "externalOnly" }, easyAuthSecretExists: { value: true }, ...(generation === undefined ? {} : { generation: { value: generation } }) },
        outputs: { environmentKeyVaultName: { value: "kv-contoso-nonprod" } },
      },
    },
  ];
  const refused = /^the deleted app with this slug is not fully deleted yet: its landing-zone record lz-demo-nonprod has /;

  it("provisioning apps marks an app whose slug has an archive, with its generation; no archive, no marker", () => {
    const s = setup();
    const plain = (JSON.parse(readFileSync(s.apps, "utf8")) as { apps: Doc[] }).apps[0]!;
    assert.ok(!("reusesSlug" in plain) && !("generation" in plain), "an ordinary app: apps.json as before");
    assert.equal(plain.incarnation, 0, "every app: its incarnation (ADR-0061, default 0), for the Entra uniqueName");
    reuse(s, 1);
    const entry = (JSON.parse(readFileSync(s.apps, "utf8")) as { apps: Doc[] }).apps[0]!;
    assert.deepEqual([entry.reusesSlug, entry.generation, entry.incarnation], [true, 1, 1]);
    // An archive directory without an archived app.yaml is no archive.
    const empty = setup();
    mkdirSync(join(empty.dir, "config", "apps-deleted", "demo", "2026-10-01"), { recursive: true });
    const doc = listApps({ instance: empty.instance, appsDir: join(empty.dir, "config", "apps"), scope: "changed" });
    assert.ok(doc.apps[0]?.ok && !doc.apps[0].reusesSlug);
  });

  it("a landing-zone record of a lower generation is the old app's: the new app fails its plan there", () => {
    const s = setup({ lz: lz(0) });
    reuse(s, 1);
    const r = run(s);
    assert.equal(r.ok, 0);
    assert.match(r.failed[0]?.reason ?? "", refused);
    assert.match(r.failed[0]?.reason ?? "", /has generation 0, this app has generation 1 \(ADR-0061/);
    assert.equal(status(s).status, "failed");
    // ADR-0064: a state the plan refuses (not a read) is PE001; its reason is in the log.
    assert.equal(status(s).code, "PE001");
    assert.ok(!existsSync(join(s.out, "facts", "demo.json")), "no facts: nothing runs for it in this environment");
    // A record that didn't succeed, or one without a readable generation, can't be told apart: refused too.
    for (const record of [lz(0, "Failed"), lz(undefined)]) {
      const t = setup({ lz: record });
      reuse(t, 1);
      assert.match(run(t).failed[0]?.reason ?? "", refused);
    }
  });

  it("its own record (the same generation) or none at all: planned as usual", () => {
    for (const record of [lz(1), []]) {
      const s = setup({ lz: record });
      reuse(s, 1);
      const r = run(s);
      assert.deepEqual([r.ok, r.failed], [1, []]);
    }
  });

  it("raising generation on a live app without an archive stays allowed (ADR-0020)", () => {
    const s = setup({ lz: lz(0) });
    reuse(s, 1, false);
    const r = run(s);
    assert.deepEqual([r.ok, r.failed], [1, []]);
  });
});
