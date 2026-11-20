import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkUpgrades } from "../src/provisioning/upgrades.js";
import { cli, REPO_ROOT, tmp } from "./helpers.js";

// `platform upgrades check` (ADR-0049 section 5): core CI's check of infra/app/upgrades.yaml.
const UNITS = ["lz", "entra", "release", "frontdoor", "pep", "ado"];

function core(since: Record<string, string>, notes: string): string {
  const dir = tmp("pc-upgrades-");
  mkdirSync(join(dir, "infra", "app"), { recursive: true });
  const units = Object.fromEntries(UNITS.map((u) => [u, { revision: 1, fingerprint: "a".repeat(64), since: since[u] ?? "v0.1.0" }]));
  writeFileSync(join(dir, "infra", "app", "units.json"), JSON.stringify({ schemaVersion: 1, units }));
  writeFileSync(join(dir, "infra", "app", "upgrades.yaml"), notes);
  return dir;
}
const note = (unit: string, extra = ""): string =>
  `    ${unit}: {level: optional, restart: false, entraApproval: false${extra}, notes: {en: Something changes., cs: Něco se změní.}}\n`;

describe("platform upgrades check", () => {
  it("this repository: every unit that is since: unreleased has a note", () => {
    const r = cli(["upgrades", "check", "--core-dir", REPO_ROOT]);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^OK {2}upgrade notes: minAppVersion v/);
  });

  it("passes with a note for exactly the unreleased units", () => {
    const r = checkUpgrades(core({ lz: "unreleased" }, `minAppVersion: v0.1.0\nversions:\n  unreleased:\n${note("lz")}`));
    assert.deepEqual(r.unreleasedUnits, ["lz"]);
    assert.doesNotThrow(() => checkUpgrades(core({}, "minAppVersion: v0.1.0\nversions: {}\n")));
  });

  it("fails without a note for an unreleased unit, with one for a unit that didn't change, and on schema errors", () => {
    const fails = (dir: string, re: RegExp): void => {
      const r = cli(["upgrades", "check", "--core-dir", dir]);
      assert.equal(r.code, 1, r.stdout);
      assert.match(r.stderr, re);
    };
    fails(core({ lz: "unreleased", ado: "unreleased" }, `minAppVersion: v0.1.0\nversions:\n  unreleased:\n${note("lz")}`), /no note for ado in versions\.unreleased/);
    fails(core({ lz: "unreleased" }, "minAppVersion: v0.1.0\nversions: {}\n"), /no note for lz/);
    fails(core({}, `minAppVersion: v0.1.0\nversions:\n  unreleased:\n${note("pep")}`), /note for pep, which did not change since the last release/);
    fails(core({ lz: "v0.1.0" }, `minAppVersion: v0.1.0\nversions:\n  v0.2.0:\n${note("lz")}`), /versions\.v0\.2\.0 has a note for lz, but .* last changed in v0\.1\.0/);
    fails(core({}, `minAppVersion: v0.1.0\nversions:\n  unreleased:\n    lz: {level: optional}\n`), /upgrades\.yaml/);
    fails(core({}, "minAppVersion: v0.1.0\nversions: {}\nextra: 1\n"), /extra/);
    fails(core({ lz: "unreleased" }, `minAppVersion: v0.1.0\nversions:\n  unreleased:\n${note("lz", ", requires: [lz]")}`), /names the unit itself/);
    assert.equal(cli(["upgrades", "nope"]).code, 2);
  });
});
