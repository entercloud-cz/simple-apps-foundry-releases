import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { FIXTURES, REPO_ROOT, tmp } from "./helpers.js";
import { addDays, daysBetween, decommissionSettings, deleteAfterFor, deletePhaseDue, immediateAllowed, isDate, offlinePhase } from "../src/decommission.js";
import { explainCheck } from "../src/explanations.js";
import { generate, renderDelivery } from "../src/provisioning/generate.js";
import { loadInstanceFile } from "../src/provisioning/model.js";
import { listApps } from "../src/provisioning/run.js";
import { compareWithBase, instanceProblems, otherAppsFromTexts, validateApp, validateAppText } from "../src/validate-app.js";
import type { AppData, AppValidateResult } from "../src/validate-app.js";
import { validateAppDefinition } from "../src/index.js";

const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const FIX = join(FIXTURES, "app-definitions");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const BLOCK = { requestedOn: "2026-11-12", deleteAfter: "2026-12-12", reason: "Replaced by orders-v2.", requestedBy: { objectId: "00000000-0000-0000-0000-00000000e001", displayName: "Jane Owner" } };

function example(mutate?: (d: Doc) => void): Doc {
  const d = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  mutate?.(d);
  return d;
}

function appFile(d: Doc): string {
  const dir = join(tmp("pc-decom-"), "apps", d.slug as string);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "app.yaml"), stringify(d));
  return join(dir, "app.yaml");
}

const msgs = (r: AppValidateResult): string => [...r.problems.map((p) => `${p.path}: ${p.message}`), ...r.checks.map((c) => `${c.path}: ${c.message}`)].join("\n");

/** `platform validate app --instance <file> --base main` on a definition, with `base` as main's (undefined: a new app). */
function withBase(d: Doc, instanceFile: string, base: Doc | undefined = example()): AppValidateResult {
  const data = instanceProblems(readFileSync(instanceFile, "utf8")).data!;
  return validateAppText(stringify(d), { file: `apps/${d.slug as string}/app.yaml`, instance: { file: instanceFile, data }, base: { ref: "main", read: () => (base ? stringify(base) : undefined) }, today: "2026-11-12" });
}

describe("decommission dates and settings (ADR-0056)", () => {
  it("defaults, settings and dates", () => {
    assert.deepEqual(decommissionSettings({}), { graceDays: 30, repository: "keep", allowImmediateWithProduction: false });
    assert.deepEqual(decommissionSettings({ decommission: { graceDays: 14, repository: "delete" } }), { graceDays: 14, repository: "delete", allowImmediateWithProduction: false });
    assert.equal(decommissionSettings({ decommission: { allowImmediateWithProduction: true } }).allowImmediateWithProduction, true);
    assert.equal(decommissionSettings({ decommission: { allowImmediateWithProduction: "true" as never } }).allowImmediateWithProduction, false, "only an explicit true");
    // Immediate deletion: always without production, with it only under the setting (amendment 2026-11-21).
    const envs = [{ name: "nonprod", kind: "nonprod" }, { name: "prod", kind: "prod" }];
    const both = { environments: { nonprod: {}, prod: {} } };
    assert.deepEqual(immediateAllowed({ environments: { nonprod: {} } }, { environments: envs }), { allowed: true, production: [] });
    assert.deepEqual(immediateAllowed(both, { environments: envs }), { allowed: false, production: ["prod"] });
    assert.deepEqual(immediateAllowed(both, { environments: envs, decommission: { allowImmediateWithProduction: true } }), { allowed: true, production: ["prod"] });
    assert.equal(decommissionSettings({ decommission: { graceDays: 3 } }).graceDays, 30, "below the schema minimum: the default");
    assert.equal(deleteAfterFor("2026-11-12", decommissionSettings({})), "2026-12-12");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(daysBetween("2026-11-12", "2026-12-12"), 30);
    assert.equal(isDate("2026-02-30"), false);
    assert.equal(isDate("2026-02-28"), true);
  });

  it("offline phase: active, retired, due (deleted is the plan's, from Azure)", () => {
    assert.equal(offlinePhase({}, "2026-11-12"), "active");
    assert.equal(offlinePhase({ decommission: BLOCK }, "2026-12-11"), "retired");
    assert.equal(offlinePhase({ decommission: BLOCK }, "2026-12-12"), "due");
    assert.equal(deletePhaseDue({ decommission: BLOCK }, "2026-12-11"), false);
    assert.equal(deletePhaseDue({ decommission: BLOCK }, "2026-12-12"), true);
    assert.equal(deletePhaseDue({ decommission: { ...BLOCK, deleteAfter: BLOCK.requestedOn, immediate: true } }, "2026-11-12"), true, "immediate: from the merge");
    assert.equal(deletePhaseDue({}, "2026-12-12"), false);
  });
});

describe("platform validate app: decommission (ADR-0056)", () => {
  it("accepts a decommissioned app with the instance's grace period", () => {
    const r = validateApp(appFile(example((d) => (d.decommission = BLOCK))), { instance: INSTANCE });
    assert.equal(msgs(r), "");
    assert.equal(r.ok, true);
  });

  it("reports the negative fixture: grace, markup", () => {
    const r = validateApp(appFile(parse(readFileSync(join(FIX, "decommission-errors.yaml"), "utf8")) as Doc), { instance: INSTANCE });
    assert.equal(r.problems.length, 0, msgs(r));
    const text = msgs(r);
    for (const expected of [
      /^decommission\.reason: decommission\.reason must be one line without/m,
      /^decommission\.deleteAfter: decommission\.deleteAfter 2026-11-20 is less than the instance's grace period of 30 days after requestedOn 2026-11-12; set it to 2026-12-12 or later \(check decommission-grace\)\.$/m,
    ]) assert.match(text, expected);
    assert.equal(r.checks.find((c) => c.path === "decommission.deleteAfter")?.checkId, "decommission-grace");
    assert.ok(r.checks.every((c) => typeof c.line === "number"), "every finding points at a line");
  });

  it("refuses an unknown key, a missing reason and a date that isn't one (schema)", () => {
    const r = validateApp(appFile(example((d) => (d.decommission = { ...BLOCK, reason: undefined, extra: 1, deleteAfter: "12/12/2026" }))));
    const text = msgs(r);
    assert.match(text, /^decommission: missing required property "reason"/m);
    assert.match(text, /^decommission\.extra: unknown property "extra"/m);
    assert.match(text, /^decommission\.deleteAfter: has an invalid format/m);
  });

  it("deletedOn is gone from the schema: nobody marks an app deleted (amendment 2026-11-12)", () => {
    const r = validateApp(appFile(example((d) => (d.decommission = { ...BLOCK, deletedOn: "2026-12-15" }))));
    assert.match(msgs(r), /^decommission\.deletedOn: unknown property "deletedOn"/m);
  });

  it("against the base: the request is destructive with production first; Cancel is listed", () => {
    const inst = loadInstanceFile(INSTANCE);
    const base = example() as AppData;
    const req = compareWithBase(base, example((d) => (d.decommission = BLOCK)) as AppData, undefined, inst as never);
    assert.deepEqual(req.checks, []);
    assert.equal(req.destructive.length, 2);
    assert.match(req.destructive[0]!.message, /^PRODUCTION: the app stops in prod at the next provisioning run/);
    assert.match(req.destructive[1]!.message, /the app stops in every environment \(nonprod, prod\) .* nothing is deleted until 2026-12-12/);
    assert.ok(req.destructive.every((f) => f.decommission === true && f.checkId === undefined));

    const cancel = compareWithBase(example((d) => (d.decommission = BLOCK)) as AppData, base, undefined, undefined, "2026-12-11");
    assert.deepEqual(cancel.checks, []);
    assert.match(cancel.destructive[0]!.message, /^decommissioning cancelled: the app starts again .*possible until 2026-12-12/);
  });

  it("against the base: from deleteAfter on the block is never removed or re-dated (a date rule, no Azure state)", () => {
    const leaving = example((d) => (d.decommission = BLOCK)) as AppData;
    // The last day of the grace period: Cancel is still a destructive note, not an error.
    assert.deepEqual(compareWithBase(leaving, example() as AppData, undefined, undefined, "2026-12-11").checks, []);
    // From deleteAfter on: removing the block would revive an app that is being deleted or is gone.
    const revive = compareWithBase(leaving, example() as AppData, undefined, undefined, "2026-12-12");
    assert.equal(revive.checks.length, 1);
    assert.equal(revive.checks[0]?.checkId, "decommission-tombstone");
    assert.match(revive.checks[0]!.message, /being deleted or is already deleted \(its delete phase started on 2026-12-12\), so it can't come back/);
    assert.deepEqual(revive.destructive, [], "no Cancel note: it is refused");
    const later = compareWithBase(leaving, example((d) => (d.decommission = { ...BLOCK, deleteAfter: "2027-01-12" })) as AppData, undefined, undefined, "2026-12-20");
    assert.equal(later.checks[0]?.checkId, "decommission-tombstone");
    assert.match(later.checks[0]!.message, /so its decommission dates don't change any more/);
    const reason = compareWithBase(leaving, example((d) => (d.decommission = { ...BLOCK, reason: "Replaced by orders-v3." })) as AppData, undefined, undefined, "2027-06-01");
    assert.deepEqual(reason.checks, [], "only the dates and immediate are fixed");
    const kept = compareWithBase(leaving, leaving, undefined, undefined, "2030-01-01");
    assert.deepEqual([kept.checks, kept.destructive], [[], []], "the definition stays as it is, years later");
    // Before deleteAfter requestedOn still can't move.
    const moved = compareWithBase(leaving, example((d) => (d.decommission = { ...BLOCK, requestedOn: "2026-11-20", deleteAfter: "2026-12-20" })) as AppData, undefined, undefined, "2026-11-25");
    assert.match(moved.checks[0]!.message, /requestedOn changed from 2026-11-12 to 2026-11-20/);
    // The same through validateAppText's today (the CLI and the library).
    const text = validateAppText(stringify(example()), { file: "apps/hotel-inventory/app.yaml", base: { ref: "main", read: () => stringify(leaving) }, today: "2026-12-12" });
    assert.equal(text.checks.find((c) => c.checkId === "decommission-tombstone")?.path, "decommission");
    const lib = validateAppDefinition(readFileSync(INSTANCE, "utf8"), stringify(example()), { baseAppYamlText: stringify(leaving), today: "2026-12-12" });
    assert.ok(lib.problems.some((p) => p.checkId === "decommission-tombstone"), JSON.stringify(lib.problems));
  });

  it("the library passes the instance to the base comparison (portal requests)", () => {
    const base = readFileSync(EXAMPLE, "utf8");
    const instanceText = readFileSync(INSTANCE, "utf8");
    const r = validateAppDefinition(instanceText, stringify(example((d) => (d.decommission = BLOCK))), { baseAppYamlText: base });
    assert.equal(r.problems.length, 0, JSON.stringify(r.problems));
    assert.ok(r.destructive.some((d) => d.message.startsWith("PRODUCTION") && d.decommission === true), JSON.stringify(r.destructive));
  });

  it("from deleteAfter on, a decommissioned app's hosts and capacity no longer count for other apps; its repository does", () => {
    const fd = (d: Doc): void => {
      d.environments.nonprod.frontDoor = { hostName: "hotel-test.contoso.com" };
    };
    const oldText = stringify(example((d) => (fd(d), (d.slug = "old"), (d.decommission = BLOCK))));
    const tomb = otherAppsFromTexts([{ slug: "old", text: oldText }], "2026-12-12");
    assert.equal(tomb[0]!.hosts, undefined);
    assert.equal(tomb[0]!.environments, undefined);
    assert.ok(tomb[0]!.repository);
    const retired = otherAppsFromTexts([{ slug: "old", text: oldText }], "2026-12-11");
    assert.deepEqual(retired[0]!.hosts, ["hotel-test.contoso.com"], "a retired app still holds its domain (Cancel brings it back)");
    const r = validateAppText(stringify(example((d) => (fd(d), (d.repository.name = "new-hotel"), (d.slug = "new-hotel")))), { file: "apps/new-hotel/app.yaml", others: tomb });
    assert.equal(msgs(r), "");
  });

  it("immediate (amendment 2026-11-12): only without production, deleteAfter = requestedOn, never switched after the merge", () => {
    const IMM = { ...BLOCK, deleteAfter: BLOCK.requestedOn, immediate: true };
    const noProd = (d: Doc): void => {
      delete d.environments.prod;
    };
    const ok = validateApp(appFile(example((d) => (noProd(d), (d.decommission = IMM)))), { instance: INSTANCE });
    assert.equal(msgs(ok), "", "no grace period with immediate");
    // With production: a rule of the change (--base), so a merged block stays valid (amendment 2026-11-21).
    const prod = withBase(example((d) => (d.decommission = IMM)), INSTANCE);
    const p = prod.checks.find((c) => c.checkId === "decommission-immediate");
    assert.match(p?.message ?? "", /^decommission\.immediate: the app has production \(prod\); only an app without an environment of kind prod can be deleted immediately \(instance\.yaml decommission\.allowImmediateWithProduction is off, .*\)\. Remove immediate and set deleteAfter to 2026-12-12 or later/);
    assert.equal(p?.path, "decommission.immediate");
    assert.equal(typeof p?.line, "number");
    assert.equal(withBase(example((d) => (d.decommission = IMM)), INSTANCE, undefined).checks.filter((c) => c.checkId === "decommission-immediate").length, 1, "a new app's file too");
    const merged = validateApp(appFile(example((d) => (d.decommission = IMM))), { instance: INSTANCE });
    assert.equal(merged.checks.filter((c) => c.checkId === "decommission-immediate").length, 0, "the file alone (a merged block): the plan decides");
    const prodAdded = withBase(example((d) => (d.decommission = IMM)), INSTANCE, example((d) => (noProd(d), (d.decommission = IMM))));
    const pa = prodAdded.checks.find((c) => c.checkId === "decommission-immediate");
    assert.match(pa?.message ?? "", /^decommission\.immediate: the app is being deleted immediately, so a production environment \(prod\) can't be added to it/);
    assert.equal(pa?.path, "environments.prod");
    assert.deepEqual(withBase(example((d) => (d.decommission = IMM)), INSTANCE, example((d) => (d.decommission = IMM))).checks.filter((c) => c.checkId === "decommission-immediate"), [], "unchanged since the merge: never refused afterwards");
    const late = validateApp(appFile(example((d) => (noProd(d), (d.decommission = { ...IMM, deleteAfter: "2026-11-13" })))), { instance: INSTANCE });
    assert.match(msgs(late), /deleteAfter 2026-11-13 must equal requestedOn 2026-11-12 with immediate: true/);
    assert.equal(late.checks.find((c) => c.path === "decommission.deleteAfter")?.checkId, "decommission-immediate");
    const falsy = validateApp(appFile(example((d) => (noProd(d), (d.decommission = { ...BLOCK, immediate: false })))));
    assert.match(msgs(falsy), /^decommission\.immediate: /m, "only true (schema const)");

    // Against the base: the request is listed as immediate; immediate never added or removed afterwards.
    const inst = loadInstanceFile(INSTANCE);
    const base = example(noProd) as AppData;
    const req = compareWithBase(base, example((d) => (noProd(d), (d.decommission = IMM))) as AppData, undefined, inst as never);
    assert.deepEqual(req.checks, []);
    assert.equal(req.destructive.length, 1);
    assert.match(req.destructive[0]!.message, /^IMMEDIATE decommissioning: the app has no production\. .* Nothing can be cancelled after the merge/);
    assert.equal(req.destructive[0]!.decommission, true);
    const added = compareWithBase(example((d) => (noProd(d), (d.decommission = BLOCK))) as AppData, example((d) => (noProd(d), (d.decommission = { ...BLOCK, immediate: true }))) as AppData, undefined, undefined, "2026-11-20");
    assert.equal(added.checks[0]?.checkId, "decommission-immediate");
    assert.match(added.checks[0]!.message, /can't be added to a decommissioning that is already merged/);
    const removed = compareWithBase(example((d) => (noProd(d), (d.decommission = IMM))) as AppData, example((d) => (noProd(d), (d.decommission = { ...IMM, immediate: undefined }))) as AppData, undefined, undefined, "2026-11-11");
    assert.equal(removed.checks[0]?.checkId, "decommission-immediate", "before the request day (a base dated ahead): the immediate rule");
    const removedLater = compareWithBase(example((d) => (noProd(d), (d.decommission = IMM))) as AppData, example((d) => (noProd(d), (d.decommission = { ...IMM, immediate: undefined }))) as AppData, undefined, undefined, "2026-11-12");
    assert.equal(removedLater.checks[0]?.checkId, "decommission-tombstone", "from the merge: the delete phase has started");
    const cancel = compareWithBase(example((d) => (noProd(d), (d.decommission = IMM))) as AppData, base, undefined, undefined, "2026-11-12");
    assert.equal(cancel.checks[0]?.checkId, "decommission-tombstone");
    assert.match(cancel.checks[0]!.message, /its immediate deletion, requested on 2026-11-12, started with the first run after the merge\), so it can't come back/);
  });

  it("immediate with production (amendment 2026-11-21): only with instance.yaml decommission.allowImmediateWithProduction; every other rule stays", () => {
    const IMM = { ...BLOCK, deleteAfter: BLOCK.requestedOn, immediate: true };
    const dir = tmp("pc-decom-prodnow-");
    const instanceOn = join(dir, "instance.yaml");
    writeFileSync(instanceOn, readFileSync(INSTANCE, "utf8").replace("allowImmediateWithProduction: false", "allowImmediateWithProduction: true"));
    // Off (the example, a production deployment): the request is refused, as before.
    const off = withBase(example((d) => (d.decommission = IMM)), INSTANCE);
    assert.equal(off.checks.filter((c) => c.checkId === "decommission-immediate").length, 1);
    // On: the app with production may ask for it, and production may be added (nothing is created for it).
    const on = withBase(example((d) => (d.decommission = IMM)), instanceOn);
    assert.equal(msgs(on), "");
    assert.equal(on.ok, true);
    assert.equal(on.destructive.length, 2, "listed for the reviewer");
    assert.equal(msgs(withBase(example((d) => (d.decommission = IMM)), instanceOn, example((d) => (delete d.environments.prod, (d.decommission = IMM))))), "");
    // Switched off after the merge: the merged block stays valid (every app is validated on every pull
    // request; the plan plans it as an ordinary decommissioning from then on).
    assert.equal(msgs(withBase(example((d) => (d.decommission = IMM)), INSTANCE, example((d) => (d.decommission = IMM)))), "");
    // deleteAfter still equals requestedOn.
    const late = validateApp(appFile(example((d) => (d.decommission = { ...IMM, deleteAfter: "2026-11-13" }))), { instance: instanceOn });
    assert.equal(late.checks.find((c) => c.path === "decommission.deleteAfter")?.checkId, "decommission-immediate");
    // Against the base: the request lists PRODUCTION first and names the setting (the reviewer's warning).
    const inst = loadInstanceFile(instanceOn);
    const req = compareWithBase(example() as AppData, example((d) => (d.decommission = IMM)) as AppData, undefined, inst as never);
    assert.deepEqual(req.checks, []);
    assert.equal(req.destructive.length, 2);
    assert.match(req.destructive[0]!.message, /^PRODUCTION, IMMEDIATELY: the app runs in prod and is deleted there too, .* decommission\.allowImmediateWithProduction allows this; it is meant for developing the platform, not for a production deployment\.$/);
    assert.match(req.destructive[1]!.message, /^IMMEDIATE decommissioning of an app with production: .* production's included\. Nothing can be cancelled after the merge/);
    assert.ok(req.destructive.every((d) => d.decommission === true), "the portal's own request: notes, not refused");
    // Never added to or removed from a merged block, the setting on or off.
    const added = compareWithBase(example((d) => (d.decommission = BLOCK)) as AppData, example((d) => (d.decommission = { ...BLOCK, immediate: true })) as AppData, undefined, inst as never, "2026-11-20");
    assert.equal(added.checks[0]?.checkId, "decommission-immediate");
    const removed = compareWithBase(example((d) => (d.decommission = IMM)) as AppData, example((d) => (d.decommission = { ...IMM, immediate: undefined })) as AppData, undefined, inst as never, "2026-11-12");
    assert.equal(removed.checks[0]?.checkId, "decommission-tombstone", "from the merge the deletion has started");
    // The same through the library, as the portal and the build validation call it.
    const lib = validateAppDefinition(readFileSync(instanceOn, "utf8"), stringify(example((d) => (d.decommission = IMM))), { baseAppYamlText: readFileSync(EXAMPLE, "utf8") });
    assert.equal(lib.ok, true, JSON.stringify(lib.problems));
    assert.match(lib.destructive[0]!.message, /^PRODUCTION, IMMEDIATELY/);
  });

  it("explains the checks in English and Czech", () => {
    for (const id of ["decommission-grace", "decommission-tombstone", "decommission-immediate", "decommission-immediate-with-production"]) {
      const x = explainCheck(id);
      assert.ok(x?.title.en && x.title.cs && x.text.cs && x.fix.en && x.prompt.cs, id);
    }
  });
});

describe("generate and provisioning apps: decommission (ADR-0056)", () => {
  it("delivery.yml says decommissioned in its header, from the block alone (never today's date)", () => {
    const inst = loadInstanceFile(INSTANCE);
    const active = renderDelivery(example() as AppData, inst);
    const retired = renderDelivery(example((d) => (d.decommission = BLOCK)) as AppData, inst);
    assert.doesNotMatch(active, /DECOMMISSIONED|DELETED/);
    assert.match(retired.split("\n")[1]!, /^# DECOMMISSIONED \(ADR-0056\): requested on 2026-11-12; the pipeline is disabled, the app is deleted on or after 2026-12-12\.$/);
    // Years after the deletion the file is the same: generate --check stays deterministic.
    const past = renderDelivery(example((d) => (d.decommission = { ...BLOCK, requestedOn: "2020-01-01", deleteAfter: "2020-02-01" })) as AppData, inst);
    assert.match(past.split("\n")[1]!, /^# DECOMMISSIONED \(ADR-0056\): requested on 2020-01-01; the pipeline is disabled, the app is deleted on or after 2020-02-01\.$/);
    const now = renderDelivery(example((d) => (delete d.environments.prod, (d.decommission = { ...BLOCK, deleteAfter: BLOCK.requestedOn, immediate: true }))) as AppData, inst);
    assert.match(now.split("\n")[1]!, /^# DECOMMISSIONED \(ADR-0056\): requested on 2026-11-12, deleted immediately \(no production\); the next provisioning run deletes the pipeline\.$/);
    // Amendment 2026-11-21: with production (only under decommission.allowImmediateWithProduction) the header names it.
    const nowProd = renderDelivery(example((d) => (d.decommission = { ...BLOCK, deleteAfter: BLOCK.requestedOn, immediate: true })) as AppData, inst);
    assert.match(nowProd.split("\n")[1]!, /^# DECOMMISSIONED \(ADR-0056\): requested on 2026-11-12, deleted immediately, production \(prod\) included \(decommission\.allowImmediateWithProduction\); the next provisioning run deletes the pipeline\.$/);
    // The rest of the file is the same: the pipeline's shape doesn't change.
    assert.equal(retired.split("\n").slice(2).join("\n"), active.split("\n").slice(1).join("\n"));
  });

  it("generate --check reports the header as drift until it is generated", () => {
    const root = join(tmp("pc-decom-gen-"), "platform-config");
    mkdirSync(join(root, "apps", "hotel-inventory"), { recursive: true });
    writeFileSync(join(root, "instance.yaml"), readFileSync(INSTANCE, "utf8"));
    writeFileSync(join(root, "apps", "hotel-inventory", "app.yaml"), readFileSync(EXAMPLE, "utf8"));
    generate(root, { check: false });
    writeFileSync(join(root, "apps", "hotel-inventory", "app.yaml"), stringify(example((d) => (d.decommission = BLOCK))));
    const r = generate(root, { check: true });
    const f = r.files.find((x) => x.path === "apps/hotel-inventory/delivery.yml");
    assert.equal(f?.status, "drift");
    assert.match(f?.diff ?? "", /\+ # DECOMMISSIONED/);
  });

  it("provisioning apps lists every decommissioned app with its dates, deleted ones too (the plan tells them apart)", () => {
    const root = join(tmp("pc-decom-apps-"), "platform-config");
    const gone = { ...BLOCK, requestedOn: "2020-01-01", deleteAfter: "2020-02-01" };
    for (const [slug, block] of [["alive", undefined], ["leaving", BLOCK], ["gone", gone]] as const) {
      mkdirSync(join(root, "apps", slug), { recursive: true });
      writeFileSync(join(root, "apps", slug, "app.yaml"), stringify(example((d) => ((d.slug = slug), (d.repository.name = slug), block ? (d.decommission = block) : undefined))));
    }
    writeFileSync(join(root, "instance.yaml"), readFileSync(INSTANCE, "utf8"));
    const r = listApps({ instance: join(root, "instance.yaml"), appsDir: join(root, "apps"), scope: "changed" });
    assert.deepEqual(r.apps.map((a) => a.slug), ["alive", "gone", "leaving"]);
    assert.equal(Object.hasOwn(r, "tombstones"), false);
    const g = r.apps.find((a) => a.slug === "gone");
    assert.ok(g?.ok && g.decommission?.deleteAfter === "2020-02-01", "listed: whether it is deleted is read in Azure");
    const leaving = r.apps.find((a) => a.slug === "leaving");
    assert.ok(leaving?.ok && leaving.decommission?.deleteAfter === "2026-12-12");
    const alive = r.apps.find((a) => a.slug === "alive");
    assert.ok(alive?.ok && alive.decommission === undefined);
  });
});
