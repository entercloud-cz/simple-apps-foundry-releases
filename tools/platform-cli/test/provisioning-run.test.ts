import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { compareDeployment, jsonEqual, parseRecord } from "../src/provisioning/run.js";

// The provisioning pipeline's helpers. test/fixtures/provisioning/records holds real sandbox
// records of one app (`az deployment ... show -o json`, and `az deployment sub validate` of the same
// landing-zone inputs), with IDs and names replaced by placeholders, and that app's app.yaml.
const P = join(FIXTURES, "provisioning");
const R = join(P, "records");
const INSTANCE = join(P, "config", "instance.yaml");
const APP2 = join(R, "apps", "demo2", "app.yaml");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const read = (f: string): Doc => JSON.parse(readFileSync(f, "utf8")) as Doc;
const writeTmp = (name: string, data: unknown): string => {
  const f = join(tmp(), name);
  writeFileSync(f, typeof data === "string" ? data : JSON.stringify(data));
  return f;
};

function configCopy(): string {
  const dir = join(tmp("pc-config-"), "platform-config");
  cpSync(join(P, "config"), dir, { recursive: true });
  return dir;
}

/** The shape of `az network list-service-tags` output, with AzureFrontDoor.Backend holding `prefixes`. */
function serviceTags(prefixes: unknown, extra: Doc[] = []): Doc {
  return {
    changeNumber: "100",
    cloud: "Public",
    values: [
      { id: "AzureCloud", name: "AzureCloud", properties: { addressPrefixes: ["10.0.0.0/8"], changeNumber: "7" } },
      { id: "AzureFrontDoor.Backend", name: "AzureFrontDoor.Backend", properties: { addressPrefixes: prefixes, changeNumber: "42", region: "", systemService: "AzureFrontDoor" } },
      ...extra,
    ],
  };
}

describe("platform provisioning fd-ranges (ADR-0010, amended 2026-11-11)", () => {
  const run = (doc: unknown) => {
    const out = join(tmp(), "ranges.json");
    const r = cli(["provisioning", "fd-ranges", "--service-tags", writeTmp("tags.json", doc), "--output", out]);
    return { ...r, json: r.code === 0 ? read(out) : undefined };
  };

  it("keeps the IPv4 prefixes of AzureFrontDoor.Backend only, sorted numerically and de-duplicated", () => {
    const r = run(serviceTags(["20.21.37.40/29", "13.73.248.8/29", "2a01:111:2050::/44", "147.243.0.0/16", "13.73.248.8/29", "2.18.0.0/16", "13.73.248.0/29"]));
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json!.ranges, ["2.18.0.0/16", "13.73.248.0/29", "13.73.248.8/29", "20.21.37.40/29", "147.243.0.0/16"]);
    assert.equal(r.json!.ipv4, 5);
    assert.equal(r.json!.ipv6, 1);
    assert.equal(r.json!.changeNumber, "42");
    assert.match(r.json!.sha256, /^[0-9a-f]{64}$/);
    assert.match(r.stdout, /^OK {2}AzureFrontDoor\.Backend: 5 IPv4 range\(s\) \(1 IPv6 dropped\), change number 42/);
    // The digest follows the set, not the order or duplicates of the API's list.
    const same = run(serviceTags(["147.243.0.0/16", "2.18.0.0/16", "20.21.37.40/29", "13.73.248.0/29", "13.73.248.8/29"]));
    assert.equal(same.json!.sha256, r.json!.sha256);
    assert.notEqual(run(serviceTags(["2.18.0.0/16"])).json!.sha256, r.json!.sha256);
  });

  it("157 IPv4 prefixes (the sandbox count, 2026-11-11) pass; more than 400 fail", () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => `198.${18 + Math.floor(i / 256)}.${i % 256}.0/29`);
    const r = run(serviceTags([...many(157), "2001:db8::/32"]));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json!.ranges.length, 157);
    assert.equal(run(serviceTags(many(400))).code, 0);
    const over = run(serviceTags(many(401)));
    assert.equal(over.code, 1);
    assert.match(over.stderr, /has 401 ranges, more than the limit of 400/);
  });

  it("fails on anything it can't use: no tag, two tags, no IPv4 prefix, a bad or too wide range", () => {
    assert.match(run({ values: [] }).stderr, /has 0 entries named AzureFrontDoor\.Backend, expected exactly one/);
    assert.match(run(serviceTags(["192.0.2.0/24"], [{ name: "AzureFrontDoor.Backend", properties: { addressPrefixes: [] } }])).stderr, /has 2 entries/);
    assert.match(run({ value: [] }).stderr, /must be the output of az network list-service-tags/);
    assert.match(run(serviceTags("192.0.2.0/24")).stderr, /has no list properties\.addressPrefixes/);
    assert.match(run(serviceTags(["2001:db8::/32"])).stderr, /IPv4 prefixes is empty/);
    for (const [bad, why] of [
      ["192.0.2.0", /is not an IPv4 CIDR range/],
      ["256.0.2.0/24", /is not an IPv4 CIDR range/],
      ["192.0.2.0/33", /is not an IPv4 CIDR range/],
      ["192.000.2.0/24", /is not an IPv4 CIDR range/],
      ["AzureFrontDoor.Backend", /is not an IPv4 CIDR range/],
      ["0.0.0.0/0", /is wider than a \/8/],
      ["10.0.0.0/7", /is wider than a \/8/],
      ["192.0.2.1/24", /is not a network address/],
    ] as const) {
      const r = run(serviceTags(["198.51.100.0/24", bad]));
      assert.equal(r.code, 1, bad);
      assert.match(r.stderr, why, bad);
    }
    assert.equal(run(serviceTags(["198.51.100.7/32"])).code, 0, "a single address");
    assert.equal(cli(["provisioning", "fd-ranges", "--output", join(tmp(), "x.json")]).code, 2);
  });
});

describe("platform generate: pipelines/provisioning.yml", () => {
  it("renders the provisioning pipeline from instance.yaml; --check reports it missing, then in sync", () => {
    const dir = configCopy();
    const check = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(check.code, 1);
    assert.match(check.stdout, /^DRIFT {4}pipelines\/provisioning\.yml \(missing\)$/m);
    assert.equal(cli(["generate", "--config-dir", dir]).code, 0);
    const text = readFileSync(join(dir, "pipelines", "provisioning.yml"), "utf8");
    assert.match(text, /^# GENERATED by `platform generate` from instance\.yaml: do not edit\.\n# Provisioning pipeline of this instance, registered as \\platform\\provisioning\. Everything runs in\n# the core template \(ADR-0032\): don't add steps\. A merge starts it when apps\/, its inputs or this file\n# change \(pipelines\/inputs\/provisioning\.json: instance\.yaml without the keys only the portal reads; ADR-0074\)\.\n/);
    assert.deepEqual(parse(text), {
      name: "$(Date:yyyyMMdd)$(Rev:.r)",
      appendCommitMessageToRunName: false,
      // ADR-0074: instance.yaml's keys that provisioning reads, through its generated inputs.
      trigger: { batch: true, branches: { include: ["refs/heads/main"] }, paths: { include: ["apps", "pipelines/inputs/provisioning.json", "pipelines/provisioning.yml"] } },
      pr: "none",
      // The maintenance window (ADR-0048), its defaults: Monday to Thursday at 20:00 UTC; `always`: due by date.
      schedules: [{ cron: "0 20 * * 1,2,3,4", displayName: "Maintenance window", branches: { include: ["refs/heads/main"] }, always: true }],
      // Targeted runs (ADR-0046) and upgrades (ADR-0049): queue-time parameters that only widen the run.
      parameters: [
        { name: "scope", displayName: "Apps to check", type: "string", default: "changed", values: ["changed", "all"] },
        { name: "upgrade", displayName: "Apps to upgrade (none, all, or slugs separated by commas)", type: "string", default: "none" },
      ],
      resources: { repositories: [{ repository: "core", type: "git", name: "Platform/core", ref: "refs/tags/v0.1.0-rc.3" }] },
      extends: {
        template: "pipelines/azure-devops/app-provisioning.yml@core",
        parameters: {
          environments: [{ name: "nonprod", kind: "nonprod", promoteFrom: "" }, { name: "prod", kind: "prod", promoteFrom: "nonprod" }],
          hostEnvironment: "prod",
          scope: "${{ parameters.scope }}",
          upgrade: "${{ parameters.upgrade }}",
        },
      },
    });
    assert.match(text, /promoteFrom: ''\n/);
    const again = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(again.code, 0, again.stdout);
    assert.match(again.stdout, /^unchanged pipelines\/provisioning\.yml$/m);
  });

  it("uses platformConfigDefaultBranch, all instance environments in stage order, and is written without apps", () => {
    const dir = configCopy();
    const inst = parse(readFileSync(join(dir, "instance.yaml"), "utf8")) as Doc;
    const [nonprod, prod] = inst.environments;
    inst.environments = [{ ...prod, promoteFrom: "test" }, { ...nonprod, name: "test", promoteFrom: "dev" }, { ...nonprod, name: "dev" }];
    inst.portal.hostEnvironment = "prod";
    inst.scm.azureDevOps.platformConfigDefaultBranch = "release/main";
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    const app = parse(readFileSync(join(dir, "apps", "demo", "app.yaml"), "utf8")) as Doc;
    app.environments = { dev: app.environments.nonprod };
    writeFileSync(join(dir, "apps", "demo", "app.yaml"), stringify(app));
    const r = cli(["generate", "--config-dir", dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const out = parse(readFileSync(join(dir, "pipelines", "provisioning.yml"), "utf8")) as Doc;
    assert.deepEqual(out.trigger.branches.include, ["refs/heads/release/main"]);
    assert.deepEqual(out.schedules[0].branches.include, ["refs/heads/release/main"]);
    assert.deepEqual(out.extends.parameters.environments.map((e: Doc) => [e.name, e.promoteFrom]), [["dev", ""], ["test", "dev"], ["prod", "test"]]);
    assert.equal(out.extends.parameters.hostEnvironment, "prod");

    inst.portal.hostEnvironment = "qa";
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    const noHost = cli(["generate", "--config-dir", dir]);
    assert.equal(noHost.code, 1);
    assert.match(noHost.stderr, /portal\.hostEnvironment "qa" is not an environment of this instance/);

    const noApps = join(tmp(), "cfg");
    mkdirSync(noApps);
    cpSync(join(P, "config", "instance.yaml"), join(noApps, "instance.yaml"));
    const g = cli(["generate", "--config-dir", noApps]);
    assert.equal(g.code, 0, g.stderr);
    assert.match(
      g.stdout,
      /^created {3}pipelines\/provisioning\.yml\ncreated {3}pipelines\/validation\.yml\ncreated {3}pipelines\/platform-nonprod\.yml\ncreated {3}pipelines\/platform-prod\.yml\ncreated {3}pipelines\/inputs\/provisioning\.json\ncreated {3}pipelines\/inputs\/platform-nonprod\.json\ncreated {3}pipelines\/inputs\/platform-prod\.json\ncreated {3}AGENTS\.md\ncreated {3}CLAUDE\.md\ncreated {3}\.agents\/skills\/onboard-instance\/SKILL\.md\ncreated {3}\.claude\/skills\/onboard-instance\/SKILL\.md\ncreated {3}\.github\/copilot-instructions\.md\ncreated {3}\.gemini\/settings\.json\nNo apps\/\*\/app\.yaml found\.\n$/,
    );
  });

  it("renders pipelines/platform-<env>.yml per environment (ADR-0043); a file of a removed environment is reported, not deleted", () => {
    const dir = configCopy();
    assert.equal(cli(["generate", "--config-dir", dir]).code, 0);
    const text = readFileSync(join(dir, "pipelines", "platform-nonprod.yml"), "utf8");
    assert.match(text, /^# GENERATED by `platform generate` from instance\.yaml: do not edit\.\n# Platform pipeline of the environment `nonprod`, registered as \\platform\\platform-nonprod\. Everything runs\n# in the core template \(ADR-0043\): don't add steps\. A merge starts it when its inputs or this file change\n# \(pipelines\/inputs\/platform-nonprod\.json: what it deploys from instance\.yaml; ADR-0074\)\.\n/);
    assert.deepEqual(parse(text), {
      name: "$(Date:yyyyMMdd)$(Rev:.r)",
      appendCommitMessageToRunName: false,
      // ADR-0074: its inputs, and its own file (a core upgrade changes its core ref).
      trigger: { batch: true, branches: { include: ["refs/heads/main"] }, paths: { include: ["pipelines/platform-nonprod.yml", "pipelines/inputs/platform-nonprod.json"] } },
      pr: "none",
      resources: { repositories: [{ repository: "core", type: "git", name: "Platform/core", ref: "refs/tags/v0.1.0-rc.3" }] },
      extends: { template: "pipelines/azure-devops/platform-environment.yml@core", parameters: { environment: "nonprod", hostEnvironment: "prod" } },
    });
    assert.equal((parse(readFileSync(join(dir, "pipelines", "platform-prod.yml"), "utf8")) as Doc).extends.parameters.environment, "prod");

    const inst = parse(readFileSync(join(dir, "instance.yaml"), "utf8")) as Doc;
    inst.environments.push({ ...inst.environments[0], name: "dev" });
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    writeFileSync(join(dir, "pipelines", "platform-old.yml"), "# an environment removed from instance.yaml\n");
    writeFileSync(join(dir, "pipelines", "inputs", "platform-old.json"), "{}\n");
    const check = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(check.code, 1, check.stdout + check.stderr);
    assert.match(check.stdout, /^DRIFT {4}pipelines\/platform-dev\.yml \(missing\)$/m);
    assert.match(check.stdout, /^DRIFT {4}pipelines\/inputs\/platform-dev\.json \(missing\)$/m);
    assert.match(check.stdout, /^WARNING {2}pipelines\/platform-old\.yml names no environment of instance\.yaml \(not generated, not deleted\)$/m);
    assert.match(check.stdout, /^WARNING {2}pipelines\/inputs\/platform-old\.json names no environment of instance\.yaml \(not generated, not deleted\)$/m);
    assert.equal(readFileSync(join(dir, "pipelines", "platform-old.yml"), "utf8"), "# an environment removed from instance.yaml\n");
  });

  it("renders one schedule from the maintenance window, whatever the Front Door mode (ADR-0048 replaces the monthly and weekly runs)", () => {
    const dir = configCopy();
    const inst = parse(readFileSync(join(dir, "instance.yaml"), "utf8")) as Doc;
    inst.frontDoor = { mode: "managed", managed: { profiles: [{ environment: "nonprod" }] } };
    inst.maintenance = { window: { days: ["sun", "fri", "sat"], start: "01:30", hours: 4 } };
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    assert.equal(cli(["generate", "--config-dir", dir]).code, 0);
    const out = parse(readFileSync(join(dir, "pipelines", "provisioning.yml"), "utf8")) as Doc;
    assert.deepEqual(out.schedules, [{ cron: "30 1 * * 0,5,6", displayName: "Maintenance window", branches: { include: ["refs/heads/main"] }, always: true }]);
    assert.equal(cli(["generate", "--config-dir", dir, "--check"]).code, 0);
    inst.maintenance = { window: { days: ["sun", "fri", "sat"], start: "02:30", hours: 4 } };
    writeFileSync(join(dir, "instance.yaml"), stringify(inst));
    const drift = cli(["generate", "--config-dir", dir, "--check"]);
    assert.equal(drift.code, 1);
    assert.match(drift.stdout, /^DRIFT {4}pipelines\/provisioning\.yml/m);
  });

  it("refuses a symbolic link as pipelines/", () => {
    const dir = configCopy();
    const elsewhere = join(tmp(), "elsewhere");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(dir, "pipelines"));
    const r = cli(["generate", "--config-dir", dir]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /pipelines is not a directory/);
  });
});

/** A unit manifest (infra/app/units.json, ADR-0048) of a released core; `since` per unit. */
export function unitManifest(since: Partial<Record<string, string>> = {}, base = "v0.1.0-rc.1"): Doc {
  const units: Doc = {};
  for (const [i, u] of ["lz", "entra", "release", "frontdoor", "pep", "ado"].entries()) units[u] = { revision: 1, fingerprint: String(i).repeat(64), since: since[u] ?? base };
  return { schemaVersion: 1, units };
}

describe("platform provisioning validate-run", () => {
  const envs = JSON.stringify([{ name: "nonprod", kind: "nonprod", promoteFrom: "" }, { name: "prod", kind: "prod", promoteFrom: "nonprod" }]);
  const NOTES = "minAppVersion: v0.1.0-rc.1\nversions: {}\n";
  const APPS_DIR = join(P, "config", "apps");
  /** ADR-0049: core's upgrade notes, the parameter upgrade and the apps it may name. */
  const upgradeArgs = (upgrade = "none", notes = NOTES) => ["--upgrades", writeTmp("upgrades.yaml", notes), "--upgrade", upgrade, "--apps-dir", APPS_DIR];
  const run = (environments: string, coreRef = "refs/tags/v0.1.0-rc.3", host = "prod", branch = "refs/heads/main", units: unknown = unitManifest(), extra: string[] = upgradeArgs()) =>
    cli(["provisioning", "validate-run", "--instance", INSTANCE, "--environments-json", environments, "--host-environment", host, "--core-ref", coreRef, "--source-branch", branch, "--units", typeof units === "string" ? units : writeTmp("units.json", units), ...extra]);

  it("accepts what generate renders and the pinned core tag", () => {
    const r = run(envs);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "OK  provisioning: environments nonprod/nonprod, prod/prod (from nonprod), host prod, core refs/tags/v0.1.0-rc.3, branch refs/heads/main, upgrade none\n");
  });

  it("checks the parameter upgrade: none, all or up to 50 slugs, each with an app definition (ADR-0049)", () => {
    const ok = (upgrade: string, shown: string): void => {
      const r = run(envs, undefined, undefined, undefined, undefined, upgradeArgs(upgrade));
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, new RegExp(`, upgrade ${shown}\\n$`));
    };
    ok("none", "none");
    ok("all", "all apps");
    ok("demo", "demo");
    const fails = (upgrade: string, re: RegExp): void => {
      const r = run(envs, undefined, undefined, undefined, undefined, upgradeArgs(upgrade));
      assert.equal(r.code, 1, upgrade);
      assert.match(r.stderr, re);
    };
    fails("demo,nothere", /parameter upgrade names nothere, which has no app definition \(apps\/nothere\/app\.yaml\)/);
    fails("demo;x", /parameter upgrade must be none, all, or app slugs separated by commas/);
    assert.equal(run(envs, undefined, undefined, undefined, undefined, upgradeArgs("")).code, 2, "an empty upgrade is a usage error");
    fails("demo,demo", /names demo more than once/);
    fails(Array.from({ length: 51 }, (_, n) => `app${n}`).join(","), /names 51 apps; at most 50 in one run/);
    const noDir = cli(["provisioning", "validate-run", "--instance", INSTANCE, "--environments-json", envs, "--host-environment", "prod", "--core-ref", "refs/tags/v0.1.0-rc.3", "--source-branch", "refs/heads/main", "--units", writeTmp("u.json", unitManifest()), "--upgrades", writeTmp("n.yaml", NOTES), "--upgrade", "none"]);
    assert.equal(noDir.code, 2, "--apps-dir is required");
  });

  it("refuses core upgrade notes that are invalid or not released (ADR-0049)", () => {
    const fails = (notes: string, re: RegExp): void => {
      const r = run(envs, undefined, undefined, undefined, undefined, upgradeArgs("none", notes));
      assert.equal(r.code, 1, notes);
      assert.match(r.stderr, re);
    };
    fails("minAppVersion: v0.1.0-rc.1\nversions:\n  unreleased: {}\n", /versions\.unreleased: this core is not a release/);
    fails("minAppVersion: v0.1.0-rc.1\nversions:\n  v0.1.0-rc.4: {}\n", /notes for v0\.1\.0-rc\.4, after this run's core version v0\.1\.0-rc\.3/);
    fails("minAppVersion: latest\nversions: {}\n", /minAppVersion/);
    fails("versions: {}\n", /minAppVersion/);
    const missing = run(envs, undefined, undefined, undefined, undefined, ["--upgrades", join(tmp(), "none.yaml"), "--upgrade", "none", "--apps-dir", APPS_DIR]);
    assert.match(missing.stderr, /infra\/app\/upgrades\.yaml is missing in the core checkout/);
  });

  it("refuses a run that is not on platform-config's default branch (ADR-0046)", () => {
    for (const branch of ["refs/heads/feature/x", "refs/heads/portal/requests/demo", "refs/pull/1/merge", "main"]) {
      const r = run(envs, "refs/tags/v0.1.0-rc.3", "prod", branch);
      assert.equal(r.code, 1, branch);
      assert.match(r.stderr, /provisioning runs only on platform-config's default branch refs\/heads\/main/);
    }
  });

  it("refuses a core whose unit manifest is missing, malformed or not released (ADR-0048)", () => {
    const fails = (units: unknown, re: RegExp): void => {
      const r = run(envs, undefined, undefined, undefined, units);
      assert.equal(r.code, 1, JSON.stringify(units).slice(0, 80));
      assert.match(r.stderr, re);
    };
    fails(join(tmp(), "missing.json"), /infra\/app\/units\.json is missing in the core checkout/);
    fails([], /must be a JSON object/);
    fails(unitManifest({ entra: "unreleased" }), /units\.entra\.since is "unreleased": this core is not a release/);
    fails(unitManifest({ lz: "v0.1.0-rc.4" }), /units\.lz\.since is v0\.1\.0-rc\.4, after this run's core version v0\.1\.0-rc\.3/);
    fails(unitManifest({ pep: "latest" }), /units\.pep\.since must be a core version/);
    const noAdo = unitManifest();
    delete noAdo.units.ado;
    fails(noAdo, /has no unit ado/);
    const bad = unitManifest();
    bad.units.release.fingerprint = "xyz";
    bad.units.lz.revision = 0;
    bad.units.extra = bad.units.pep;
    fails(bad, /units\.release\.fingerprint must be 64 lower-case hex digits/);
    fails(bad, /units\.lz\.revision must be an integer of at least 1/);
    fails(bad, /names an unknown unit "extra"/);
    assert.equal(run(envs, undefined, undefined, undefined, unitManifest({ lz: "v0.1.0-rc.3", ado: "v0.0.9" })).code, 0, "since up to the core version");
    assert.equal(cli(["provisioning", "validate-run", "--instance", INSTANCE, "--environments-json", envs, "--host-environment", "prod", "--core-ref", "refs/tags/v0.1.0-rc.3", "--source-branch", "refs/heads/main", ...upgradeArgs()]).code, 2, "--units is required");
  });

  it("refuses a host environment other than instance.yaml portal.hostEnvironment", () => {
    const r = run(envs, "refs/tags/v0.1.0-rc.3", "nonprod");
    assert.equal(r.code, 1);
    assert.match(r.stderr, /parameters\.hostEnvironment is "nonprod", but instance\.yaml portal\.hostEnvironment is "prod"/);
  });

  it("refuses another order, kind, promoteFrom, a missing or extra environment and another core ref", () => {
    const bad = (list: Doc[]): string => run(JSON.stringify(list)).stderr;
    const np = { name: "nonprod", kind: "nonprod", promoteFrom: "" };
    const pr = { name: "prod", kind: "prod", promoteFrom: "nonprod" };
    assert.match(bad([np]), /parameters\.environments is \[nonprod\/nonprod\/-\], but instance\.yaml gives \[nonprod\/nonprod\/-, prod\/prod\/nonprod\]/);
    assert.match(bad([pr, np]), /but instance\.yaml gives/);
    assert.match(bad([np, { ...pr, kind: "nonprod" }]), /but instance\.yaml gives/);
    assert.match(bad([np, pr, { name: "qa", kind: "nonprod", promoteFrom: "" }]), /but instance\.yaml gives/);
    assert.match(bad([np, { ...pr, promoteFrom: "qa" }]), /promotes from "qa", which is not in this pipeline's environment list/);
    assert.match(bad([{ ...np, extra: 1 }, pr]), /unknown key "extra"/);
    assert.match(run("[]").stderr, /at least one environment/);
    assert.match(run("{").stderr, /not valid JSON/);
    const ref = run(envs, "refs/tags/v9.9.9");
    assert.equal(ref.code, 1);
    assert.match(ref.stderr, /^platform provisioning validate-run: the core repository resolved to "refs\/tags\/v9\.9\.9", but instance\.yaml pins coreVersion v0\.1\.0-rc\.3/m);
    assert.match(run(envs, "main").stderr, /--core-ref must be a git ref/);
    assert.equal(cli(["provisioning", "validate-run", "--instance", INSTANCE]).code, 2);
    assert.equal(cli(["provisioning", "validate-run", "--instance", INSTANCE, "--environments-json", envs, "--host-environment", "prod", "--core-ref", "refs/tags/v0.1.0-rc.3", "--units", writeTmp("u.json", unitManifest()), ...upgradeArgs()]).code, 2, "--source-branch is required");
  });
});

describe("platform provisioning apps", () => {
  function appsDir(): string {
    const dir = join(tmp(), "apps");
    mkdirSync(join(dir, "demo"), { recursive: true });
    cpSync(join(P, "config", "apps", "demo", "app.yaml"), join(dir, "demo", "app.yaml"));
    mkdirSync(join(dir, "demo2"));
    cpSync(APP2, join(dir, "demo2", "app.yaml"));
    return dir;
  }
  const scopeArgs = (scope = "changed", upgrade = "none") => ["--scope", scope, "--upgrade", upgrade];
  const run = (dir: string, extra: string[] = scopeArgs()) => {
    const out = join(tmp(), "apps.json");
    const r = cli(["provisioning", "apps", "--instance", INSTANCE, "--apps-dir", dir, ...extra, "--output", out]);
    return { ...r, json: r.code === 0 ? read(out) : undefined };
  };

  it("lists valid apps with environments in delivery order and their sign-in mode", () => {
    const dir = appsDir();
    const r = run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, {
      checkAllApps: false,
      upgrade: { all: false, apps: [] },
      apps: [
        { slug: "demo", file: join(dir, "demo", "app.yaml"), ok: true, environments: ["nonprod", "prod"], authMode: "required", frontDoorHosts: {}, networkModes: { nonprod: "externalOnly", prod: "externalOnly" }, cells: { nonprod: "01", prod: "01" }, incarnation: 0 },
        { slug: "demo2", file: join(dir, "demo2", "app.yaml"), ok: true, environments: ["nonprod"], authMode: "required", frontDoorHosts: {}, networkModes: { nonprod: "externalOnly" }, cells: { nonprod: "01" }, incarnation: 0 },
      ],
    });
    assert.match(r.stdout, /^ok {7}demo {2}\(nonprod, prod; sign-in required\)$/m);
    assert.match(r.stdout, /^2 apps, 0 invalid\.$/m);
  });

  it("lists each app's custom hosts per environment (frontDoorHosts, lower-case)", () => {
    const root = join(tmp(), "platform-config");
    mkdirSync(join(root, "apps", "hotel-inventory"), { recursive: true });
    const i = parse(readFileSync(join(REPO_ROOT, "config", "examples", "instance.example.yaml"), "utf8")) as Doc;
    i.authentication.enforcement = "ownerChoice";
    writeFileSync(join(root, "instance.yaml"), stringify(i));
    const a = parse(readFileSync(join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml"), "utf8")) as Doc;
    a.authentication = { mode: "anonymous" };
    a.environments.nonprod.frontDoor = { hostName: "hotel-inventory-test.contoso.com" };
    writeFileSync(join(root, "apps", "hotel-inventory", "app.yaml"), stringify(a));
    const out = join(tmp(), "apps.json");
    const r = cli(["provisioning", "apps", "--instance", join(root, "instance.yaml"), "--apps-dir", join(root, "apps"), ...scopeArgs(), "--output", out]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual((read(out) as Doc).apps[0].frontDoorHosts, { nonprod: "hotel-inventory-test.contoso.com" });
  });

  it("an invalid app fails alone; skips directories without app.yaml; neutralises problems", () => {
    const dir = appsDir();
    const a = parse(readFileSync(join(dir, "demo2", "app.yaml"), "utf8")) as Doc;
    a.environments.qa = { networkMode: "externalOnly" };
    a.title = "##vso[task.setvariable variable=x]1";
    writeFileSync(join(dir, "demo2", "app.yaml"), stringify(a));
    mkdirSync(join(dir, "empty"));
    mkdirSync(join(dir, "zeta"));
    writeFileSync(join(dir, "zeta", "app.yaml"), "slug: [\n");
    const r = run(dir);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json!.apps.map((x: Doc) => [x.slug, x.ok]), [["demo", true], ["demo2", false], ["zeta", false]]);
    assert.match(r.json!.apps[1].problems.join("\n"), /^apps\/demo2\/app\.yaml: .*"qa" is not an environment of this instance/m);
    assert.match(r.json!.apps[2].problems[0], /YAML syntax error/);
    assert.match(r.stdout, /^INVALID {2}demo2 /m);
    assert.match(r.stdout, /^3 apps, 2 invalid\.$/m);
  });

  it("fails on an invalid instance or a directory name that is no slug", () => {
    const dir = appsDir();
    mkdirSync(join(dir, "Bad_Name"));
    cpSync(APP2, join(dir, "Bad_Name", "app.yaml"));
    const r = run(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /apps\/Bad_Name "Bad_Name" is not a valid app slug .* \(the directory name is the app's slug\)\./);
    const badInst = writeTmp("instance.yaml", "schemaVersion: nope\n");
    assert.equal(cli(["provisioning", "apps", "--instance", badInst, "--apps-dir", appsDir(), ...scopeArgs(), "--output", join(tmp(), "x.json")]).code, 1);
    const linked = appsDir();
    symlinkSync(join(linked, "demo2"), join(linked, "demo3"));
    const l = run(linked);
    assert.equal(l.code, 0);
    assert.deepEqual(l.json!.apps[2], { slug: "demo3", file: join(linked, "demo3", "app.yaml"), ok: false, problems: ["apps/demo3 is a symbolic link, which is not allowed."] });
    assert.deepEqual(run(join(tmp(), "none")).json, { checkAllApps: false, upgrade: { all: false, apps: [] }, apps: [] });
  });

  it("scope all checks every app (ADR-0046); no fingerprint any more (ADR-0048)", () => {
    const dir = appsDir();
    assert.equal(run(dir).json!.apps[0].fingerprint, undefined);
    const all = run(dir, scopeArgs("all"));
    assert.equal(all.json!.checkAllApps, true);
    assert.match(all.stdout, /This run checks every app\.$/m);
    assert.equal(run(dir, scopeArgs("some")).code, 1);
    assert.equal(run(dir, []).code, 2, "the scope option is required");
    assert.equal(run(dir, ["--scope", "changed", "--upgrade", "none", "--month", "2026-11"]).code, 2, "--month is retired");
  });

  it("hands the parameter upgrade to the plan (ADR-0049)", () => {
    const dir = appsDir();
    const some = run(dir, scopeArgs("changed", "demo2, demo"));
    assert.equal(some.code, 0, some.stderr);
    assert.deepEqual(some.json!.upgrade, { all: false, apps: ["demo2", "demo"] });
    assert.match(some.stdout, /This run upgrades demo2, demo\.$/m);
    assert.deepEqual(run(dir, scopeArgs("changed", "all")).json!.upgrade, { all: true, apps: [] });
    assert.equal(run(dir, scopeArgs("changed", "demo;x")).code, 1);
    assert.equal(run(dir, ["--scope", "changed"]).code, 2, "the upgrade option is required");
  });
});

describe("platform provisioning state", () => {
  const state = (extra: string[], app = APP2, env = "nonprod") => {
    const out = join(tmp(), "state.json");
    const r = cli(["provisioning", "state", "--instance", INSTANCE, "--app", app, "--env", env, "--core-dir", REPO_ROOT, "--today", "2026-11-17", "--output", out, ...extra]);
    return { ...r, json: r.code === 0 ? read(out) : undefined };
  };
  const entraClientId = read(join(R, "entra-demo2-nonprod.json")).properties.outputs.clientId.value as string;
  const records = ["--lz-record", join(R, "lz-demo2-nonprod.json"), "--release-record", join(R, "release-demo2.json"), "--entra-outputs", writeTmp("entra.json", { clientId: entraClientId })];
  const placeholder = (read(join(REPO_ROOT, "images", "images.json")) as Doc).images["saf-placeholder"];

  it("derives every key from the records; the landing-zone inputs then equal the deployed parameters", () => {
    const r = state(records);
    assert.equal(r.code, 0, r.stderr);
    const s = r.json!;
    assert.deepEqual(s.landingZone, { runtimeIdentityClientId: read(join(R, "lz-demo2-nonprod.json")).properties.outputs.runtimeIdentityClientId.value, database: null, storageBlobEndpoint: null });
    assert.equal(s.containerAppFqdn, undefined, "the record predates the containerAppFqdn output");
    assert.deepEqual(s.ado, read(join(R, "lz-demo2-nonprod.json")).properties.parameters.deliveryFederation.value, "carried from the lz record");
    assert.equal(s.easyAuthSecretExists, true);
    assert.deepEqual(s.entra, { clientId: entraClientId });
    assert.equal(s.budgetStartDate, "2026-10-01", "carried, not this month");
    assert.deepEqual(s.releaseRecord, read(join(R, "release-demo2.json")).properties.parameters);
    const server = read(join(R, "lz-demo2-nonprod.json")).properties.outputs.registryLoginServer.value as string;
    assert.deepEqual(s.bootstrap, {
      image: `${server}/saf-placeholder@${placeholder.digest as string}`,
      runtime: { port: placeholder.runtime.port, size: "xs", minReplicas: 0, maxReplicas: 1, livenessPath: placeholder.runtime.livenessPath, readinessPath: placeholder.runtime.readinessPath },
    });

    // D6 end to end: inputs rendered from this state, validated, match the record exactly.
    const stateFile = writeTmp("state.json", s);
    const lz = join(tmp(), "lz.json");
    const i = cli(["provisioning", "inputs", "--step", "lz", "--instance", INSTANCE, "--app", APP2, "--env", "nonprod", "--state", stateFile, "--output", lz]);
    assert.equal(i.code, 0, i.stderr);
    const deployed = read(join(R, "lz-demo2-nonprod.validate.json")).properties.parameters as Doc;
    const rendered = read(lz);
    // The sandbox record predates the portal's Reader (ADR-0037): this instance has no
    // portal.identityPrincipalId, so '' (no assignment). With the parameter the first provisioning
    // run after the upgrade finds the landing zone not up to date and deploys it once.
    assert.equal(rendered.portalIdentityPrincipalId, "");
    delete rendered.portalIdentityPrincipalId;
    // It predates modeChange too (ADR-0060): null in the steady state, which changes no resource.
    assert.equal(rendered.modeChange, null);
    delete rendered.modeChange;
    // And the capacity cell (ADR-0053, ADR-0060 amendment 2026-11-16): 01, today's CAE name.
    assert.equal(rendered.cell, "01");
    delete rendered.cell;
    assert.deepEqual(Object.keys(rendered).sort(), Object.keys(deployed).sort());
    for (const [k, v] of Object.entries(rendered)) assert.deepEqual(v, deployed[k].value ?? null, k);

    const rel = join(tmp(), "rel.json");
    const ri = cli(["provisioning", "inputs", "--step", "release", "--mode", "reapply", "--instance", INSTANCE, "--app", APP2, "--env", "nonprod", "--state", stateFile, "--output", rel]);
    assert.equal(ri.code, 0, ri.stderr);
    const recorded = read(join(R, "release-demo2.json")).properties.parameters as Doc;
    // coreVersion (the tag saf-core, ADR-0049) is newer than this sandbox record; compare ignores it.
    const relInputs = read(rel) as Doc;
    assert.equal(relInputs.coreVersion, "v0.1.0-rc.3");
    // The capacity cell (ADR-0053) is newer than this record too: 01, today's CAE name.
    assert.equal(relInputs.cell, "01");
    for (const [k, v] of Object.entries(relInputs)) if (k !== "alertsEnabled" && k !== "coreVersion" && k !== "cell") assert.deepEqual(v, recorded[k].value, k);
  });

  it("without records: federation null, no secret, budget from --today's month, nothing to carry", () => {
    const r = state([]);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(r.json, { ado: null, easyAuthSecretExists: false, entra: null, budgetStartDate: "2026-11-01", releaseRecord: null });
  });

  it("Easy Auth secret: the lz flag or --easy-auth-secret present; Entra outputs must be { clientId }", () => {
    assert.equal(state(["--easy-auth-secret", "present"]).json!.easyAuthSecretExists, true, "found in the vault, not yet in the lz record");
    assert.equal(state(["--easy-auth-secret", "absent"]).json!.easyAuthSecretExists, false);
    const lz = read(join(R, "lz-demo2-nonprod.json"));
    assert.equal(lz.properties.parameters.easyAuthSecretExists.value, true);
    assert.equal(state(["--lz-record", join(R, "lz-demo2-nonprod.json"), "--easy-auth-secret", "absent"]).json!.easyAuthSecretExists, true, "the record flag stays");
    // ADR-0060: the record's flag speaks of the vault its landing zone used. After a change to the
    // other vault variant (externalOnly on the managed network -> externalHybrid) or a new
    // vaultGeneration, only the target vault (--easy-auth-secret) decides.
    const withParams = (p: Record<string, unknown>): string => {
      const rec = structuredClone(lz) as Doc;
      for (const [k, v] of Object.entries(p)) {
        if (v === undefined) delete rec.properties.parameters[k];
        else rec.properties.parameters[k] = { value: v };
      }
      return writeTmp("lz-demo2-nonprod.json", rec);
    };
    const flag = (p: Record<string, unknown>, secret: "present" | "absent") => state(["--lz-record", withParams(p), "--easy-auth-secret", secret]).json!.easyAuthSecretExists;
    assert.equal(flag({ networkMode: "externalHybrid" }, "absent"), false, "the record's vault is the private one, app.yaml's mode uses the public one");
    assert.equal(flag({ networkMode: "externalHybrid" }, "present"), true, "the secret is in the target vault already");
    assert.equal(flag({ vaultGeneration: 1 }, "absent"), false, "another vaultGeneration is another vault");
    assert.equal(flag({ externalOnlyNetwork: "vnet" }, "absent"), false, "externalOnly in a VNet uses the private vault");
    assert.equal(flag({ networkMode: undefined }, "absent"), true, "a record without the parameter: the flag carries, as before");
    assert.equal(flag({ externalOnlyNetwork: "managed" }, "absent"), true, "the same vault: the flag carries");
    assert.match(state(["--easy-auth-secret", "yes"]).stderr, /--easy-auth-secret must be present or absent/);
    assert.match(state(["--entra-outputs", writeTmp("e.json", { clientId: "x" })]).stderr, /--entra-outputs clientId must be a GUID/);
    assert.match(state(["--entra-outputs", writeTmp("e.json", { clientId: entraClientId, extra: 1 })]).stderr, /unknown key "extra"/);
  });

  it("prefers --ado-outputs, falls back to the release record's client ID, reads containerAppFqdn", () => {
    const ado = writeTmp("ado.json", {
      organization: "https://dev.azure.com/contoso",
      project: { id: "00000000-0000-0000-0000-0000000000e1", name: "Platform" },
      slug: "demo2",
      environments: { nonprod: { serviceConnection: { id: "x", name: "sc-demo2-nonprod", issuer: "https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0", subject: "/eid1/new" }, environment: null } },
      pipeline: null,
    });
    const lz = read(join(R, "lz-demo2-nonprod.json"));
    lz.properties.outputs.containerAppFqdn = { type: "String", value: "ca-demo2.happyfield-00000000.westeurope.azurecontainerapps.io" };
    const r = state(["--lz-record", writeTmp("lz.json", lz), "--release-record", join(R, "release-demo2.json"), "--ado-outputs", ado]);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.json!.ado.subject, "/eid1/new");
    assert.equal(r.json!.entra.clientId, read(join(R, "release-demo2.json")).properties.parameters.authentication.value.clientId);
    assert.equal(r.json!.containerAppFqdn, "ca-demo2.happyfield-00000000.westeurope.azurecontainerapps.io");

    const noSc = writeTmp("ado2.json", { ...read(ado), environments: { nonprod: { serviceConnection: null, environment: null } } });
    assert.equal(state(["--lz-record", join(R, "lz-demo2-nonprod.json"), "--ado-outputs", noSc]).json!.ado.subject, lz.properties.parameters.deliveryFederation.value.subject, "falls back to the record");
    assert.match(state(["--ado-outputs", writeTmp("ado3.json", { ...read(ado), slug: "other" })]).stderr, /--ado-outputs is for app "other", not demo2/);
  });

  it("--fd-record: the custom domain's host and the profile's Front Door ID, only from a Succeeded record with the output", () => {
    const fd = (provisioningState: string, outputs: Doc = { frontDoorId: { type: "String", value: "00000000-0000-0000-0000-0000000000F1" } }) =>
      writeTmp("fd.json", { name: "fd-demo2-nonprod", properties: { provisioningState, parameters: { hostName: { type: "String", value: "Demo2.Contoso.com" } }, outputs } });
    const ok = state(["--fd-record", fd("Succeeded")]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(ok.json!.frontDoor, { hostName: "demo2.contoso.com", frontDoorId: "00000000-0000-0000-0000-0000000000f1" });
    assert.match(ok.stdout, /, frontDoor yes\n$/);
    assert.equal(state(["--fd-record", fd("Failed")]).json!.frontDoor, null);
    assert.equal(state(["--fd-record", fd("Succeeded", {})]).json!.frontDoor, null, "a record from before the frontDoorId output");
    assert.equal(state(["--fd-record", fd("Succeeded", { frontDoorId: { type: "String", value: "afd-x" } })]).json!.frontDoor, null);
    const none = state([]);
    assert.equal(Object.hasOwn(none.json!, "frontDoor"), false, "no domain requested: no key");
    assert.doesNotMatch(none.stdout, /frontDoor/);
    assert.match(state(["--fd-record", writeTmp("fd.json", { name: "fd-demo2-prod", properties: {} })]).stderr, /--fd-record is the record of deployment "fd-demo2-prod", expected fd-demo2-nonprod/);

    // --fd-domain (amended 2026-11-11): Front Door serves the domain once it is Approved and Succeeded.
    const domain = (domainValidationState: unknown, deploymentStatus: unknown) => writeTmp("domain.json", { domainValidationState, deploymentStatus });
    const serving = (v: unknown, d: unknown, rec = fd("Succeeded")) => state(["--fd-record", rec, "--fd-domain", domain(v, d)]).json!.frontDoor;
    assert.equal(serving("Approved", "Succeeded").serving, true);
    assert.equal(serving("Approved", "InProgress").serving, false, "the edge still serves the default certificate (FD-2)");
    assert.equal(serving("Pending", "Succeeded").serving, false);
    assert.equal(serving("PendingRevalidation", "Succeeded").serving, false);
    assert.equal(serving(null, null).serving, false);
    assert.equal(serving("Approved", "Succeeded", fd("Failed")), null, "no deployed domain: nothing to serve");
    assert.equal(Object.hasOwn(ok.json!.frontDoor, "serving"), false, "not read: no key");
    assert.match(state(["--fd-domain", domain("Approved", "Succeeded")]).stderr, /--fd-domain needs --fd-record/);
    assert.match(state(["--fd-record", fd("Succeeded"), "--fd-domain", writeTmp("d.json", { domainValidationState: "Approved" })]).stderr, /deploymentStatus/);
    assert.match(state(["--fd-record", fd("Succeeded"), "--fd-domain", domain("Approved; rm", "Succeeded")]).stderr, /domainValidationState must be null or a word/);
  });

  it("--fd-ranges: the ranges of a platform provisioning fd-ranges output, checked again (ADR-0010, amended 2026-11-11)", () => {
    const tags = writeTmp("tags.json", serviceTags(["203.0.113.8/29", "2001:db8::/48", "192.0.2.0/24"]));
    const rangesFile = join(tmp(), "ranges.json");
    assert.equal(cli(["provisioning", "fd-ranges", "--service-tags", tags, "--output", rangesFile]).code, 0);
    const ok = state(["--fd-ranges", rangesFile]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.deepEqual(ok.json!.frontDoorBackendIpRanges, ["192.0.2.0/24", "203.0.113.8/29"]);
    assert.match(ok.stdout, /, frontDoorBackendIpRanges 2\n$/);
    assert.equal(Object.hasOwn(state([]).json!, "frontDoorBackendIpRanges"), false, "no flag: no key");
    const doc = read(rangesFile);
    assert.match(state(["--fd-ranges", writeTmp("r.json", { ...doc, ranges: ["192.0.2.0/24", "198.51.100.0/24"] })]).stderr, /--fd-ranges sha256 does not match its ranges/);
    assert.match(state(["--fd-ranges", writeTmp("r.json", { ...doc, ranges: [] })]).stderr, /--fd-ranges ranges is empty/);
    assert.match(state(["--fd-ranges", writeTmp("r.json", { ...doc, serviceTag: "AzureCloud" })]).stderr, /must be the output of platform provisioning fd-ranges/);
  });

  it("budget: null for an app without one; refuses records of another deployment and bad input", () => {
    const dir = join(tmp(), "apps", "demo2");
    mkdirSync(dir, { recursive: true });
    const a = parse(readFileSync(APP2, "utf8")) as Doc;
    a.environments.nonprod.budget = null;
    writeFileSync(join(dir, "app.yaml"), stringify(a));
    assert.equal(state([], join(dir, "app.yaml")).json!.budgetStartDate, null);

    const wrong = state(["--lz-record", join(R, "release-demo2.json")]);
    assert.equal(wrong.code, 1);
    assert.match(wrong.stderr, /--lz-record is the record of deployment "release-demo2", expected lz-demo2-nonprod/);
    assert.match(state(["--release-record", writeTmp("x.json", "[]")]).stderr, /must be the JSON of az deployment/);
    const badOut = read(join(R, "lz-demo2-nonprod.json"));
    badOut.properties.outputs.runtimeIdentityClientId.value = "not-a-guid";
    assert.match(state(["--lz-record", writeTmp("lz.json", badOut)]).stderr, /state\.landingZone\.runtimeIdentityClientId must be a GUID/);
    assert.match(state(["--today", "2026-13-01"]).stderr, /--today must be a date/);
    assert.match(state([], APP2, "prod").stderr, /does not run in environment prod/);
    assert.equal(cli(["provisioning", "state", "--instance", INSTANCE]).code, 2);
  });

  it("needs a valid images/images.json in --core-dir for the bootstrap image", () => {
    const core = tmp();
    mkdirSync(join(core, "images"));
    writeFileSync(join(core, "images", "images.json"), JSON.stringify({ formatVersion: 1, images: { "saf-placeholder": { repository: "saf-placeholder", digest: "latest", runtime: { port: 8080, livenessPath: "/", readinessPath: "/" } } } }));
    const out = join(tmp(), "s.json");
    const r = cli(["provisioning", "state", "--instance", INSTANCE, "--app", APP2, "--env", "nonprod", "--core-dir", core, "--lz-record", join(R, "lz-demo2-nonprod.json"), "--output", out]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /saf-placeholder\.digest must be sha256/);
  });
});

describe("platform provisioning compare (D6)", () => {
  const V = join(R, "lz-demo2-nonprod.validate.json");
  const REC = join(R, "lz-demo2-nonprod.json");
  const compare = (kind: string, validate: string, record?: string) => cli(["provisioning", "compare", "--kind", kind, "--validate", validate, ...(record ? ["--record", record] : [])]);

  it("the real validate output and record are up to date (value null equals no value)", () => {
    const v = read(V).properties.parameters as Doc;
    const rec = read(REC).properties.parameters as Doc;
    assert.deepEqual(v.hybridExistingVnetId, { type: "String", value: null });
    assert.deepEqual(rec.hybridExistingVnetId, { type: "String" });
    const r = compare("lz", V, REC);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, "up-to-date\n");
  });

  it("new without a record; changed on state, hash and parameters (at most five names)", () => {
    assert.equal(compare("lz", V).stdout, "new\n");
    const rec = read(REC);
    rec.properties.provisioningState = "Failed";
    rec.properties.templateHash = "1";
    rec.properties.parameters.budget.value.amount = 11;
    delete rec.properties.parameters.costCenter;
    const r = compare("lz", V, writeTmp("r.json", rec));
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "changed: provisioningState Failed; templateHash; parameters budget, costCenter\n");
    const many = read(REC);
    for (const k of ["alertEmails", "backupRetentionDays", "budget", "costCenter", "data", "deputy", "owner"]) many.properties.parameters[k].value = "x";
    assert.equal(compare("lz", V, writeTmp("m.json", many)).stdout, "changed: parameters alertEmails, backupRetentionDays, budget, costCenter, data (+2 more)\n");
    const extra = read(REC);
    extra.properties.parameters.newParam = { type: "String", value: "" };
    assert.equal(compare("lz", V, writeTmp("e.json", extra)).stdout, "changed: parameters newParam\n");
  });

  it("release: deployedBy and alertsEnabled are ignored, everything else counts", () => {
    const rec = read(join(R, "release-demo2.json"));
    const validate = { properties: { templateHash: rec.properties.templateHash, parameters: structuredClone(rec.properties.parameters) } } as Doc;
    validate.properties.parameters.deployedBy.value = "provisioning";
    validate.properties.parameters.alertsEnabled.value = true;
    const v = writeTmp("v.json", validate);
    const r = writeTmp("r.json", rec);
    assert.equal(compare("release", v, r).stdout, "up-to-date\n");
    assert.equal(compare("lz", v, r).stdout, "changed: parameters alertsEnabled, deployedBy\n", "only the release ignores them");
    validate.properties.parameters.runtime.value.maxReplicas = 3;
    assert.equal(compare("release", writeTmp("v2.json", validate), r).stdout, "changed: parameters runtime\n");
  });

  it("entra: every parameter counts", () => {
    const rec = read(join(R, "entra-demo2-nonprod.json"));
    const validate = { properties: { templateHash: rec.properties.templateHash, parameters: structuredClone(rec.properties.parameters) } } as Doc;
    const r = writeTmp("r.json", rec);
    assert.equal(compare("entra", writeTmp("v.json", validate), r).stdout, "up-to-date\n");
    validate.properties.parameters.hosts.value = ["ca-demo2.example.westeurope.azurecontainerapps.io"];
    assert.equal(compare("entra", writeTmp("v2.json", validate), r).stdout, "changed: parameters hosts\n");
    assert.equal(compare("entra", writeTmp("v3.json", validate)).stdout, "new\n");
  });

  it("portal-endpoint: every parameter counts, a new vault environment or generation is a change", () => {
    const params = {
      prefix: { type: "String", value: "contoso" },
      portalEnvironmentName: { type: "String", value: "prod" },
      location: { type: "String", value: "westeurope" },
      environmentName: { type: "String", value: "prod" },
      slug: { type: "String", value: "hotel-inventory" },
      generation: { type: "Int", value: 0 },
      vaultSubscriptionId: { type: "String", value: "00000000-0000-0000-0000-00000000b001" },
      networkMode: { type: "String", value: "externalHybrid" },
      externalOnlyNetwork: { type: "String", value: "managed" },
      managedBy: { type: "String", value: "SAF" },
    };
    const rec = { name: "pep-portal-hotel-inventory-prod", properties: { provisioningState: "Succeeded", templateHash: "42", parameters: structuredClone(params) } };
    const validate = { properties: { templateHash: "42", parameters: structuredClone(params) } } as Doc;
    const r = writeTmp("r.json", rec);
    assert.equal(compare("portal-endpoint", writeTmp("v.json", validate), r).stdout, "up-to-date\n");
    validate.properties.parameters.generation.value = 1;
    assert.equal(compare("portal-endpoint", writeTmp("v2.json", validate), r).stdout, "changed: parameters generation\n");
    assert.equal(compare("portal-endpoint", writeTmp("v3.json", validate)).stdout, "new\n");
  });

  it("invalid input exits 1; usage errors 2", () => {
    assert.equal(compare("lz", writeTmp("x.json", { properties: { parameters: {} } })).code, 1);
    assert.match(compare("lz", writeTmp("x.json", { properties: { templateHash: "1" } })).stderr, /--validate has no properties\.parameters/);
    assert.match(compare("lz", writeTmp("x.json", "{")).stderr, /not valid JSON/);
    assert.match(compare("dns", V).stderr, /--kind must be lz, release, entra, frontdoor, portal-endpoint or environment/);
    assert.equal(compare("frontdoor", V).code, 0, "the custom domain's deployment compares like the others");
    assert.equal(compare("environment", V).code, 0, "the platform environment's record compares like the others");
    assert.equal(compare("lz", V, join(tmp(), "missing.json")).code, 1);
    assert.equal(cli(["provisioning", "compare", "--kind", "lz"]).code, 2);
    assert.equal(cli(["provisioning", "nope"]).code, 2);
  });

  it("compares JSON values exactly (key order ignored, array order kept, null vs missing)", () => {
    assert.ok(jsonEqual({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 }));
    assert.ok(!jsonEqual([1, 2], [2, 1]));
    assert.ok(!jsonEqual({ a: null }, {}));
    assert.ok(!jsonEqual(1, "1"));
    const rec = parseRecord({ name: "x", properties: { provisioningState: "Succeeded", templateHash: "h", parameters: { a: { type: "Object" } } } }, "r");
    const val = parseRecord({ properties: { templateHash: "h", parameters: { a: { type: "Object", value: null } } } }, "v");
    assert.deepEqual(compareDeployment("lz", val, rec), { result: "up-to-date" });
  });
});
