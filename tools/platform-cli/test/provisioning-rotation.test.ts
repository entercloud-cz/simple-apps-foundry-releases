import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cli } from "./helpers.js";
import { ROTATE_AFTER_DAYS, ROTATE_WITHIN_DAYS, WARN_WITHIN_DAYS, rotationDue } from "../src/provisioning/rotation.js";

// `platform provisioning rotation-due` (ADR-0041): entra_plan asks it for every present Easy Auth
// secret, with the expiry of the vault's version.
const NOW = 1_793_534_400; // 2026-11-01T12:00:00Z
const DAY = 86_400;

describe("platform provisioning rotation-due", () => {
  it("due at 120 days left or fewer, or expired; current above", () => {
    assert.equal(ROTATE_WITHIN_DAYS, 120);
    assert.equal(WARN_WITHIN_DAYS, 60);
    assert.deepEqual(rotationDue(NOW + 180 * DAY, NOW), { due: false, daysLeft: 180 });
    assert.deepEqual(rotationDue(NOW + 120 * DAY + 1, NOW), { due: false, daysLeft: 120 });
    assert.deepEqual(rotationDue(NOW + 120 * DAY, NOW), { due: true, daysLeft: 120 });
    assert.deepEqual(rotationDue(NOW + 30 * DAY, NOW), { due: true, daysLeft: 30 });
    assert.deepEqual(rotationDue(NOW - 1, NOW), { due: true, daysLeft: -1 });
    // An expiry decides alone; the creation time doesn't matter then.
    assert.deepEqual(rotationDue(NOW + 150 * DAY, NOW, NOW - 100 * DAY), { due: false, daysLeft: 150 });
  });

  it("without an expiry: due once the version is 60 days old, or when its creation time is unknown too", () => {
    assert.equal(ROTATE_AFTER_DAYS, 60);
    assert.deepEqual(rotationDue(undefined, NOW), { due: true, daysLeft: undefined });
    assert.deepEqual(rotationDue(undefined, NOW, NOW - 60 * DAY), { due: true, daysLeft: undefined });
    assert.deepEqual(rotationDue(undefined, NOW, NOW - 60 * DAY + 1), { due: false, daysLeft: undefined });
    assert.deepEqual(rotationDue(undefined, NOW, NOW - DAY), { due: false, daysLeft: undefined });
  });

  it("prints one line for the scripts", () => {
    const run = (expires: string, created?: string): string => {
      const r = cli(["provisioning", "rotation-due", "--expires", expires, ...(created ? ["--created", created] : []), "--now", String(NOW)]);
      assert.equal(r.code, 0, r.stderr);
      return r.stdout;
    };
    assert.equal(run(String(NOW + 150 * DAY)), "current 150\n");
    assert.equal(run(String(NOW + 90 * DAY + 3600)), "due 90\n");
    assert.equal(run(String(NOW - 2 * DAY)), "due -2\n");
    assert.equal(run("none"), "due none\n");
    assert.equal(run("none", "none"), "due none\n");
    assert.equal(run("none", String(NOW - 10 * DAY)), "current none\n");
    assert.equal(run("none", String(NOW - 61 * DAY)), "due none\n");
  });

  it("refuses what isn't epoch seconds; --expires is required", () => {
    const bad = cli(["provisioning", "rotation-due", "--expires", "2027-04-28", "--created", "yesterday", "--now", "x"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /--expires must be epoch seconds or none\./);
    assert.match(bad.stderr, /--created must be epoch seconds or none\./);
    assert.match(bad.stderr, /--now must be epoch seconds or none\./);
    const none = cli(["provisioning", "rotation-due", "--expires", "none", "--now", "none"]);
    assert.equal(none.code, 1);
    assert.match(none.stderr, /--now must be epoch seconds\./);
    assert.equal(cli(["provisioning", "rotation-due"]).code, 2);
  });
});
