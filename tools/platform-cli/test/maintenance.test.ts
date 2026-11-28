import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { MAINTENANCE_DEFAULTS, REGISTRY_RETENTION_MODES, WEEK_DAYS, maintenanceCron, maintenanceOf, nextWindowStart } from "../src/index.js";
import { validateFile } from "../src/validate.js";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const schema = JSON.parse(readFileSync(join(REPO_ROOT, "config", "schema", "instance.schema.json"), "utf8")) as Doc;
const m = schema.properties.maintenance.properties as Doc;

describe("maintenance window (maintenance.ts, ADR-0048 section 7)", () => {
  it("the defaults and enums equal the schema's", () => {
    assert.deepEqual(m.window.properties.days.default, MAINTENANCE_DEFAULTS.window.days);
    assert.deepEqual(m.window.properties.days.items.enum, [...WEEK_DAYS]);
    assert.equal(m.window.properties.start.default, MAINTENANCE_DEFAULTS.window.start);
    assert.equal(m.window.properties.hours.default, MAINTENANCE_DEFAULTS.window.hours);
    assert.equal(m.driftCheckDays.default, MAINTENANCE_DEFAULTS.driftCheckDays);
    assert.equal(m.requiredUpgradeDays.default, MAINTENANCE_DEFAULTS.requiredUpgradeDays);
    assert.equal(m.upgrades.default, MAINTENANCE_DEFAULTS.upgrades);
    // ADR-0059: the registry retention.
    const r = m.registryRetention.properties as Doc;
    assert.deepEqual({ mode: r.mode.default, days: r.days.default, keepLatest: r.keepLatest.default }, MAINTENANCE_DEFAULTS.registryRetention);
    assert.deepEqual(r.mode.enum, [...REGISTRY_RETENTION_MODES]);
    assert.deepEqual([r.days.minimum, r.days.maximum, r.keepLatest.minimum, r.keepLatest.maximum], [45, 3650, 1, 100]);
  });

  it("the registry retention (ADR-0059): defaults, values, and malformed values fall back", () => {
    assert.deepEqual(maintenanceOf({}).registryRetention, { mode: "dryRun", days: 90, keepLatest: 10 });
    assert.deepEqual(maintenanceOf({ maintenance: { registryRetention: { mode: "purge", days: 180 } } }).registryRetention, { mode: "purge", days: 180, keepLatest: 10 });
    assert.deepEqual(maintenanceOf({ maintenance: { registryRetention: { mode: "never", days: 30, keepLatest: 0 } } }).registryRetention, MAINTENANCE_DEFAULTS.registryRetention);
  });

  it("fills in the defaults, keeps the days in week order and renders the cron (UTC, Sunday = 0)", () => {
    assert.deepEqual(maintenanceOf({}), MAINTENANCE_DEFAULTS);
    assert.equal(maintenanceCron(maintenanceOf(undefined)), "0 20 * * 1,2,3,4");
    const s = maintenanceOf({ maintenance: { window: { days: ["sun", "mon"], start: "03:05" }, upgrades: "automatic" } });
    assert.deepEqual(s.window, { days: ["mon", "sun"], start: "03:05", hours: 6 });
    assert.equal(s.upgrades, "automatic");
    assert.equal(maintenanceCron(s), "5 3 * * 0,1");
    assert.deepEqual(maintenanceOf({ maintenance: { window: { days: [], start: "25:00", hours: 0 }, driftCheckDays: 1.5 } }), MAINTENANCE_DEFAULTS, "malformed values fall back");
  });

  it("the next window start: the same day when it is still ahead, else the next window day", () => {
    const w = { days: ["mon", "thu"] as const, start: "20:00" };
    const at = (iso: string) => nextWindowStart({ ...w, days: [...w.days] }, new Date(iso)).toISOString();
    assert.equal(at("2026-11-09T19:59:00Z"), "2026-11-09T20:00:00.000Z", "Monday before the start");
    assert.equal(at("2026-11-09T20:00:00Z"), "2026-11-09T20:00:00.000Z", "at the start");
    assert.equal(at("2026-11-09T20:01:00Z"), "2026-11-12T20:00:00.000Z", "Monday after: Thursday");
    assert.equal(at("2026-11-13T08:00:00Z"), "2026-11-16T20:00:00.000Z", "Friday: next Monday");
    assert.equal(nextWindowStart({ days: ["sun"], start: "00:00" }, new Date("2026-11-15T00:00:01Z")).toISOString(), "2026-11-22T00:00:00.000Z", "a week later");
  });

  it("the schema refuses a bad window; a valid one needs no other check", () => {
    const run = (maintenance: unknown) => validateFile("instance", instanceFile((d) => ((d as Doc).maintenance = maintenance)));
    assert.deepEqual(run({ window: { days: ["sat", "sun"], start: "23:30", hours: 24 }, driftCheckDays: 7, requiredUpgradeDays: 30, upgrades: "automatic", registryRetention: { mode: "dryRun", days: 45, keepLatest: 1 } }).problems, []);
    for (const bad of [{ window: { days: [] } }, { window: { days: ["mon", "mon"] } }, { window: { days: ["monday"] } }, { window: { start: "8:00" } }, { window: { start: "24:00" } }, { window: { hours: 25 } }, { driftCheckDays: 0 }, { requiredUpgradeDays: 181 }, { upgrades: "never" }, { other: 1 },
      { registryRetention: { days: 44 } }, { registryRetention: { keepLatest: 0 } }, { registryRetention: { mode: "delete" } }, { registryRetention: { other: 1 } }]) {
      assert.notDeepEqual(run(bad).problems, [], JSON.stringify(bad));
    }
  });
});
