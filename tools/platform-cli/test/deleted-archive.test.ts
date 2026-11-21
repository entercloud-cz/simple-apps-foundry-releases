import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, git, REPO_ROOT, tmp } from "./helpers.js";
import { archivedAppYamlPath, archivedGeneration, archivedIncarnation, archivedOfSlug, archivedRequestedOn, sameDefinitionText } from "../src/archive.js";
import { checkAiPrompt, DEFINITION_CHECK_IDS, explainCheck } from "../src/explanations.js";
import { validateAppDefinition } from "../src/index.js";
import { generate } from "../src/provisioning/generate.js";
import { listApps } from "../src/provisioning/run.js";
import { validateFile } from "../src/validate.js";
import { slugReuseChecks, validateApp } from "../src/validate-app.js";
import type { AppData, AppValidateResult } from "../src/validate-app.js";
import { validateArchive } from "../src/validate-archive.js";
import type { ArchiveValidateResult } from "../src/validate-archive.js";

/**
 * ADR-0061 section 3: the archive of deleted apps, apps-deleted/{slug}/{requestedOn}/app.yaml. It is
 * never provisioned (everything that enumerates apps reads apps/ only), `platform validate archive`
 * checks it (check deleted-archive), a slug used again needs a higher generation (check
 * slug-reuse-generation) and a higher incarnation (check slug-reuse-incarnation: the Entra
 * registration's uniqueName), an app's incarnation never changes (check incarnation-fixed), and the new
 * definition of a slug used again is a new app.
 */

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
/** A day after every deleteAfter below (the date rule reads `today`). */
const TODAY = "2026-03-01";
const REQUESTED = "2026-01-05";
const BLOCK = { requestedOn: REQUESTED, deleteAfter: "2026-02-04", reason: "Replaced by a newer app.", requestedBy: { objectId: "00000000-0000-0000-0000-00000000e001", displayName: "Jane Owner" } };

function app(slug: string, mutate?: (d: Doc) => void): Doc {
  const d = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  d.slug = slug;
  d.repository.name = slug;
  mutate?.(d);
  return d;
}
const deleted = (slug: string, mutate?: (d: Doc) => void): Doc =>
  app(slug, (d) => {
    d.decommission = { ...BLOCK };
    mutate?.(d);
  });

function put(root: string, rel: string, content: string | Doc): void {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, typeof content === "string" ? content : stringify(content));
}

/** An empty platform-config (the example instance), optionally a git repository with one commit. */
function config(files: Record<string, string | Doc> = {}, opts: { git?: boolean } = {}): string {
  const root = join(tmp("pc-archive-"), "platform-config");
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "instance.yaml"), readFileSync(INSTANCE, "utf8"));
  for (const [rel, content] of Object.entries(files)) put(root, rel, content);
  if (opts.git) {
    git(root, "init", "-q", "-b", "main");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
  }
  return root;
}

/** The pull request that uses a deleted app's slug again: archive move + a new apps/<slug>/app.yaml. */
function reuse(root: string, slug: string, newApp: Doc): void {
  const text = readFileSync(join(root, "apps", slug, "app.yaml"), "utf8");
  put(root, archivedAppYamlPath(slug, REQUESTED), text);
  rmSync(join(root, "apps", slug, "delivery.yml"), { force: true });
  put(root, `apps/${slug}/app.yaml`, newApp);
}

const problems = (r: ArchiveValidateResult): string => r.problems.map((p) => `${p.file}: ${p.path}: ${p.message}`).join("\n");
const msgs = (r: AppValidateResult): string => [...r.problems.map((p) => `${p.path}: ${p.message}`), ...r.checks.map((c) => `${c.path}: ${c.message}`)].join("\n");

describe("the archive of deleted apps (ADR-0061): helpers", () => {
  it("names the archived path and reads generation and request day", () => {
    assert.equal(archivedAppYamlPath("stock", REQUESTED), "apps-deleted/stock/2026-01-05/app.yaml");
    assert.equal(archivedGeneration(stringify(deleted("stock", (d) => (d.generation = 2)))), 2);
    assert.equal(archivedGeneration(stringify(deleted("stock", (d) => delete d.generation))), 0, "default 0 (ADR-0020)");
    assert.equal(archivedGeneration("a: [unclosed"), 0, "unreadable: 0 (validate archive fails it)");
    assert.equal(archivedIncarnation(stringify(deleted("stock", (d) => (d.incarnation = 3)))), 3);
    assert.equal(archivedIncarnation(stringify(deleted("stock"))), 0, "a definition from before the field: the first app with the slug");
    assert.equal(archivedIncarnation("a: [unclosed"), 0);
    assert.equal(archivedRequestedOn({ path: archivedAppYamlPath("stock", "2026-02-02"), text: "" }), "2026-02-02", "the folder");
    assert.equal(archivedRequestedOn({ text: stringify(deleted("stock")) }), REQUESTED, "the block, without a path");
  });

  it("lists the archived definitions of one slug beside apps/, and nothing outside apps/", () => {
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock"), [archivedAppYamlPath("stock", "2026-06-01")]: deleted("stock"), [archivedAppYamlPath("orders", REQUESTED)]: deleted("orders") });
    const found = archivedOfSlug(join(root, "apps", "stock", "app.yaml"));
    assert.deepEqual(found?.map((a) => a.path), ["apps-deleted/stock/2026-01-05/app.yaml", "apps-deleted/stock/2026-06-01/app.yaml"]);
    assert.deepEqual(archivedOfSlug(join(root, "apps", "fresh", "app.yaml")), []);
    assert.equal(archivedOfSlug(join(root, "elsewhere", "stock", "app.yaml")), undefined);
  });
});

describe("platform validate archive: schema and place", () => {
  it("accepts no archive and a valid one", () => {
    const empty = validateArchive(config());
    assert.deepEqual([empty.ok, empty.files], [true, []]);
    const r = validateArchive(config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") }));
    assert.equal(r.ok, true, problems(r));
    assert.deepEqual(r.files, ["apps-deleted/stock/2026-01-05/app.yaml"]);
  });

  it("checks every archived definition against app.schema.json", () => {
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock", (d) => (d.color = "red")), [archivedAppYamlPath("orders", REQUESTED)]: "slug: [unclosed\n" });
    const r = validateArchive(root);
    assert.equal(r.ok, false);
    assert.match(problems(r), /^apps-deleted\/orders\/2026-01-05\/app\.yaml: \(root\): YAML syntax error/m);
    assert.match(problems(r), /^apps-deleted\/stock\/2026-01-05\/app\.yaml: color: unknown property "color"/m);
    assert.ok(r.problems.every((p) => p.checkId === undefined), "schema and syntax problems carry no checkId");
  });

  it("files a definition under its slug and its request day, with its decommission block (check deleted-archive)", () => {
    const root = config({
      [archivedAppYamlPath("stock", REQUESTED)]: deleted("orders"),
      [archivedAppYamlPath("orders", "2026-01-06")]: deleted("orders"),
      [archivedAppYamlPath("billing", REQUESTED)]: app("billing"),
    });
    const r = validateArchive(root);
    const text = problems(r);
    assert.match(text, /^apps-deleted\/stock\/2026-01-05\/app\.yaml: slug: slug "orders" must equal the folder apps-deleted\/stock\/ it is archived under \(check deleted-archive\)\.$/m);
    assert.match(text, /^apps-deleted\/orders\/2026-01-06\/app\.yaml: decommission\.requestedOn: decommission\.requestedOn 2026-01-05 must equal the folder apps-deleted\/orders\/2026-01-06\/ it is archived under/m);
    assert.match(text, /^apps-deleted\/billing\/2026-01-05\/app\.yaml: decommission: an archived definition is a deleted app's and carries its decommission block/m);
    assert.equal(r.problems.length, 3, text);
    assert.ok(r.problems.every((p) => p.checkId === "deleted-archive" && p.line !== undefined), "with the check and the line");
  });

  it("holds only <slug>/<requestedOn>/app.yaml: no delivery.yml, other files, bad names or symbolic links", () => {
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") });
    put(root, "apps-deleted/stock/2026-01-05/delivery.yml", "x: 1\n");
    put(root, "apps-deleted/README.md", "notes\n");
    put(root, "apps-deleted/stock/latest/app.yaml", stringify(deleted("stock")));
    put(root, "apps-deleted/Bad_Name/2026-01-05/app.yaml", stringify(deleted("stock")));
    mkdirSync(join(root, "apps-deleted", "orders", "2026-01-05"), { recursive: true });
    mkdirSync(join(root, "apps-deleted", "billing", "2026-01-05"), { recursive: true });
    symlinkSync(join(root, "instance.yaml"), join(root, "apps-deleted", "billing", "2026-01-05", "app.yaml"));
    const r = validateArchive(root);
    const text = problems(r);
    assert.match(text, /^apps-deleted\/stock\/2026-01-05\/delivery\.yml: \(file\): an archived app's folder holds only its app\.yaml, not apps-deleted\/stock\/2026-01-05\/delivery\.yml \(the move removes apps\/<slug>\/delivery\.yml\) \(check deleted-archive\)\.$/m);
    assert.match(text, /^apps-deleted\/README\.md: \(file\): apps-deleted\/ holds only the folders apps-deleted\/<slug>\/<requestedOn>\/ of deleted apps/m);
    assert.match(text, /^apps-deleted\/stock\/latest: \(file\): apps-deleted\/stock\/ holds only folders named for the day the app's decommissioning was requested/m);
    assert.match(text, /^apps-deleted\/Bad_Name: \(file\): the folder apps-deleted\/Bad_Name "Bad_Name" is not a valid app slug .*; the folder is the deleted app's slug/m);
    assert.match(text, /^apps-deleted\/orders\/2026-01-05: \(file\): apps-deleted\/orders\/2026-01-05 holds no app\.yaml/m);
    assert.match(text, /^apps-deleted\/billing\/2026-01-05\/app\.yaml: \(file\): .* a symbolic link is not allowed/m);
    assert.deepEqual(r.files, ["apps-deleted/stock/2026-01-05/app.yaml"], "the valid one is still read");
  });

  it("the command: exit codes, text and JSON; needs the platform-config root", () => {
    const good = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") });
    const ok = cli(["validate", "archive", good]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(ok.stdout, "OK  apps-deleted/ holds 1 valid archived definition of deleted apps.\n");
    const none = cli(["validate", "archive", config()]);
    assert.equal(none.stdout, "OK  no archived definitions of deleted apps (apps-deleted/ is empty or absent).\n");
    const bad = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("orders") });
    const failed = cli(["validate", "archive", bad]);
    assert.equal(failed.code, 1);
    assert.match(failed.stdout, /^FAILED {2}apps-deleted\/ \(the archive of deleted apps\) is not valid:\n {2}apps-deleted\/stock\/2026-01-05\/app\.yaml: line \d+: slug: slug "orders" must equal/);
    const json = JSON.parse(cli(["validate", "archive", bad, "--format", "json"]).stdout) as ArchiveValidateResult;
    assert.equal(json.kind, "archive");
    assert.equal(json.problems[0]?.checkId, "deleted-archive");
    assert.equal(cli(["validate", "archive", join(good, "apps-deleted")]).code, 2, "not the platform-config root");
    assert.equal(cli(["validate", "archive", join(good, "instance.yaml")]).code, 2, "a file, not a folder");
    assert.equal(cli(["validate", "archive", good, "--instance", join(good, "instance.yaml")]).code, 2);
  });
});

describe("platform validate archive --base: only a move, once the delete phase is due; never changed or removed", () => {
  it("accepts the move of a deleted app's definition with a new app in its place", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock"), "apps/stock/delivery.yml": "# generated\n" }, { git: true });
    reuse(root, "stock", app("stock", (d) => (d.generation = 1)));
    const r = validateArchive(root, { base: "main", today: TODAY });
    assert.equal(r.ok, true, problems(r));
    assert.deepEqual(r.base, { ref: "main", files: 0 });
    // Moved without a new app (the slug simply leaves apps/): allowed too.
    const alone = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    put(alone, archivedAppYamlPath("stock", REQUESTED), readFileSync(join(alone, "apps", "stock", "app.yaml"), "utf8"));
    rmSync(join(alone, "apps", "stock"), { recursive: true });
    assert.equal(validateArchive(alone, { base: "main", today: TODAY }).ok, true);
    // An immediate deletion is due from its request day.
    const now = config({ "apps/stock/app.yaml": deleted("stock", (d) => (d.decommission = { ...BLOCK, deleteAfter: REQUESTED, immediate: true })) }, { git: true });
    reuse(now, "stock", app("stock", (d) => (d.generation = 1)));
    assert.equal(validateArchive(now, { base: "main", today: REQUESTED }).ok, true);
  });

  it("refuses an archived definition that isn't the base's apps/<slug>/app.yaml moved unchanged", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", app("stock", (d) => (d.generation = 1)));
    put(root, archivedAppYamlPath("stock", REQUESTED), deleted("stock", (d) => (d.title = "Stock (old)")));
    put(root, archivedAppYamlPath("orders", REQUESTED), deleted("orders"));
    const r = validateArchive(root, { base: "main", today: TODAY });
    const text = problems(r);
    assert.match(text, /^apps-deleted\/stock\/2026-01-05\/app\.yaml: \(file\): apps-deleted\/stock\/2026-01-05\/app\.yaml is new and differs from apps\/stock\/app\.yaml at main: the deleted app's definition moves here unchanged \(check deleted-archive\)\.$/m);
    assert.match(text, /^apps-deleted\/orders\/2026-01-05\/app\.yaml: \(file\): apps-deleted\/orders\/2026-01-05\/app\.yaml is new, but main has no apps\/orders\/app\.yaml: an archived definition is only added by moving/m);
    assert.equal(r.problems.length, 2, text);
  });

  it("refuses the move before the delete phase is due, or of an app that isn't decommissioned (the date rule of decommission-tombstone)", () => {
    const early = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(early, "stock", app("stock", (d) => (d.generation = 1)));
    const r = validateArchive(early, { base: "main", today: "2026-02-03" });
    assert.equal(r.ok, false);
    assert.equal(r.problems.length, 1, problems(r));
    assert.equal(r.problems[0]!.path, "decommission.deleteAfter");
    assert.ok(r.problems[0]!.line !== undefined);
    assert.match(r.problems[0]!.message, /^apps\/stock\/app\.yaml at main isn't due for deletion: its delete phase starts on 2026-02-04 and today is 2026-02-03 \(UTC\)\. Only a deleted app's definition moves to the archive, when a new app asks for its slug \(check deleted-archive\)\.$/);
    assert.equal(validateArchive(early, { base: "main", today: "2026-02-04" }).ok, true, "from deleteAfter on");
    const live = config({ "apps/stock/app.yaml": app("stock") }, { git: true });
    reuse(live, "stock", app("stock", (d) => (d.generation = 1)));
    assert.match(problems(validateArchive(live, { base: "main", today: TODAY })), /apps\/stock\/app\.yaml at main has no decommission block: only a deleted app's definition moves to the archive/);
  });

  it("refuses a copy: apps/<slug>/app.yaml still holds the archived definition", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    put(root, archivedAppYamlPath("stock", REQUESTED), readFileSync(join(root, "apps", "stock", "app.yaml"), "utf8"));
    const r = validateArchive(root, { base: "main", today: TODAY });
    assert.match(problems(r), /apps\/stock\/app\.yaml still holds the same definition: the move takes it out of apps\/stock\/, and a new app there is a new definition/);
    // ...and the app's own validation says the generation isn't above the archived one.
    assert.ok(validateApp(join(root, "apps", "stock", "app.yaml"), { base: "main", today: TODAY }).checks.some((c) => c.checkId === "slug-reuse-generation"));
  });

  it("never changes or removes an archived definition once merged", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", app("stock", (d) => (d.generation = 1)));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "reuse");
    assert.equal(validateArchive(root, { base: "main", today: "2030-01-01" }).ok, true, "unchanged, years later");
    const file = join(root, archivedAppYamlPath("stock", REQUESTED));
    const text = readFileSync(file, "utf8");
    writeFileSync(file, text.replace(/\n/g, "\r\n"));
    assert.equal(validateArchive(root, { base: "main", today: TODAY }).ok, true, "line endings alone are no change");
    writeFileSync(file, text.replace("Replaced by a newer app.", "Replaced."));
    assert.match(problems(validateArchive(root, { base: "main", today: TODAY })), /^apps-deleted\/stock\/2026-01-05\/app\.yaml: \(file\): apps-deleted\/stock\/2026-01-05\/app\.yaml changed against main; an archived definition never changes \(check deleted-archive\)\.$/m);
    rmSync(join(root, "apps-deleted"), { recursive: true });
    const gone = problems(validateArchive(root, { base: "main", today: TODAY }));
    assert.match(gone, /apps-deleted\/stock\/2026-01-05\/app\.yaml is in the archive at main and was removed or replaced; an archived definition is never removed, and it can't move back while apps\/stock\/app\.yaml holds a new app/);
    // Not even "moved back" over the new app: the slug belongs to the new app now.
    writeFileSync(join(root, "apps", "stock", "app.yaml"), text);
    assert.match(problems(validateArchive(root, { base: "main", today: TODAY })), /can't move back while apps\/stock\/app\.yaml holds a new app/);
  });

  it("the move back: an archived definition returns unchanged to apps/<slug>/ while no new app has the slug", () => {
    // Archived too early (no new app asked for the slug): the base has the archive and no apps/stock/.
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") }, { git: true });
    const archived = join(root, archivedAppYamlPath("stock", REQUESTED));
    const text = readFileSync(archived, "utf8");
    rmSync(join(root, "apps-deleted"), { recursive: true });
    put(root, "apps/stock/app.yaml", text.replace(/\n/g, "\r\n").replace(/\r\n$/, "")); // CRLF and no last newline: still unchanged
    const r = validateArchive(root, { base: "main", today: TODAY });
    assert.equal(r.ok, true, problems(r));
    // The restored file is the same app: compared with the archived definition, nothing is found.
    const file = join(root, "apps", "stock", "app.yaml");
    const v = validateApp(file, { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(v.ok, true, msgs(v));
    assert.deepEqual(v.base, { ref: "main", found: true, restoredFrom: "apps-deleted/stock/2026-01-05/app.yaml" });
    assert.deepEqual([v.checks, v.destructive], [[], []], "no slug-reuse-generation, no tombstone, nothing destructive");
    const out = cli(["validate", "app", file, "--instance", join(root, "instance.yaml"), "--base", "main"]);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /^ {2}moved back from apps-deleted\/stock\/2026-01-05\/app\.yaml in this change: compared with that archived definition at main \(ADR-0061\)$/m);
  });

  it("the move back must be unchanged: an edited definition is refused, and is a change of the same app", () => {
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") }, { git: true });
    rmSync(join(root, "apps-deleted"), { recursive: true });
    put(root, "apps/stock/app.yaml", app("stock"));
    const r = validateArchive(root, { base: "main", today: TODAY });
    assert.match(problems(r), /apps-deleted\/stock\/2026-01-05\/app\.yaml is in the archive at main and was removed or replaced; an archived definition is never removed, except by moving it back unchanged to apps\/stock\/app\.yaml while no app has the slug \(check deleted-archive\)\./);
    const v = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(v.base?.restoredFrom, "apps-deleted/stock/2026-01-05/app.yaml");
    assert.ok(v.checks.some((c) => c.checkId === "decommission-tombstone"), "compared with the archived definition: the block can't go");
    // Removed without restoring anything: refused as well.
    rmSync(join(root, "apps", "stock"), { recursive: true });
    assert.match(problems(validateArchive(root, { base: "main", today: TODAY })), /except by moving it back unchanged to apps\/stock\/app\.yaml/);
  });

  it("checks only the archived definitions a change adds against the schema; merged ones keep their place and stay unchanged", () => {
    // An archived definition that today's schema refuses (as a stricter schema of a later core would).
    const old = deleted("stock", (d) => (d.color = "red"));
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: old }, { git: true });
    assert.equal(validateArchive(root, { base: "main", today: TODAY }).ok, true, "already merged: no schema check");
    assert.match(problems(validateArchive(root)), /color: unknown property "color"/, "without --base every definition is checked");
    put(root, archivedAppYamlPath("orders", REQUESTED), deleted("orders", (d) => (d.color = "red")));
    const added = problems(validateArchive(root, { base: "main", today: TODAY }));
    assert.match(added, /^apps-deleted\/orders\/2026-01-05\/app\.yaml: color: unknown property "color"/m, "added in this change: checked");
    assert.doesNotMatch(added, /apps-deleted\/stock\/2026-01-05\/app\.yaml: color/);
    // The place is still checked for a merged one.
    put(root, archivedAppYamlPath("stock", "2026-01-09"), readFileSync(join(root, archivedAppYamlPath("stock", REQUESTED)), "utf8"));
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "misfiled");
    assert.match(problems(validateArchive(root, { base: "HEAD", today: TODAY })), /apps-deleted\/stock\/2026-01-09\/app\.yaml: decommission\.requestedOn: decommission\.requestedOn 2026-01-05 must equal the folder/);
  });

  it("the command with --base", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", app("stock", (d) => (d.generation = 1)));
    const ok = cli(["validate", "archive", root, "--base", "main"]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.equal(ok.stdout, "OK  apps-deleted/ holds 1 valid archived definition of deleted apps (compared with main).\n");
    assert.equal(cli(["validate", "archive", root, "--base", "nothere"]).code, 2);
    assert.equal(cli(["validate", "archive", config(), "--base", "main"]).code, 2, "not a git work tree");
  });
});

describe("check slug-reuse-generation", () => {
  it("needs a generation above every archived one", () => {
    const root = config({
      [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock", (d) => (d.generation = 0)),
      [archivedAppYamlPath("stock", "2026-06-01")]: deleted("stock", (d) => ((d.generation = 3), (d.decommission.requestedOn = "2026-06-01"), (d.decommission.deleteAfter = "2026-07-01"))),
      "apps/stock/app.yaml": app("stock", (d) => delete d.generation),
      "apps/orders/app.yaml": app("orders"),
    });
    const file = join(root, "apps", "stock", "app.yaml");
    const r = validateApp(file, { instance: join(root, "instance.yaml") });
    assert.equal(r.ok, false);
    const c = r.checks.find((x) => x.checkId === "slug-reuse-generation");
    assert.equal(c?.path, "slug", "without generation: the slug's line");
    assert.equal(
      c?.message,
      'generation 0 (not set) must be above 3: the slug "stock" belonged to 2 deleted apps (apps-deleted/stock/: requested for deletion on 2026-01-05: generation 0; requested for deletion on 2026-06-01: generation 3). Set generation to 4, so the new app gets new names for everything that must be unique across Azure (check slug-reuse-generation).',
    );
    put(root, "apps/stock/app.yaml", app("stock", (d) => (d.generation = 3)));
    assert.equal(validateApp(file, { instance: join(root, "instance.yaml") }).checks.find((x) => x.checkId === "slug-reuse-generation")?.path, "generation");
    put(root, "apps/stock/app.yaml", app("stock", (d) => ((d.generation = 4), (d.incarnation = 1))));
    const ok = validateApp(file, { instance: join(root, "instance.yaml") });
    assert.equal(ok.ok, true, msgs(ok));
    assert.equal(validateApp(join(root, "apps", "orders", "app.yaml"), { instance: join(root, "instance.yaml") }).ok, true, "another slug: no archive");
    // Also without --instance: the archive lies beside apps/.
    put(root, "apps/stock/app.yaml", app("stock", (d) => (d.generation = 1)));
    assert.ok(validateApp(file).checks.some((x) => x.checkId === "slug-reuse-generation"));
  });

  it("the pure check and the library (archivedAppYamlTexts, for the portal)", () => {
    const archived = [{ text: stringify(deleted("stock", (d) => (d.generation = 1))) }];
    assert.deepEqual(slugReuseChecks(app("stock") as AppData, []), []);
    assert.equal(slugReuseChecks(app("stock", (d) => (d.generation = 1)) as AppData, archived)[0]?.checkId, "slug-reuse-generation");
    assert.deepEqual(slugReuseChecks(app("stock", (d) => ((d.generation = 2), (d.incarnation = 1))) as AppData, archived), []);
    const inst = readFileSync(INSTANCE, "utf8");
    const lib = validateAppDefinition(inst, stringify(app("stock")), { archivedAppYamlTexts: archived.map((a) => a.text) });
    assert.equal(lib.ok, false);
    const gen = lib.problems.find((x) => x.checkId === "slug-reuse-generation");
    assert.match(gen?.message ?? "", /requested for deletion on 2026-01-05: generation 1\)\. Set generation to 2/);
    assert.deepEqual(lib.problems.map((x) => x.checkId).sort(), ["slug-reuse-generation", "slug-reuse-incarnation"]);
    assert.equal(validateAppDefinition(inst, stringify(app("stock", (d) => ((d.generation = 2), (d.incarnation = 1)))), { archivedAppYamlTexts: archived.map((a) => a.text) }).ok, true);
  });
});

describe("check slug-reuse-incarnation (ADR-0061: the new app's own Entra registration)", () => {
  it("needs an incarnation above every archived one; an archived definition without it counts as 0", () => {
    const root = config({
      [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock"),
      [archivedAppYamlPath("stock", "2026-06-01")]: deleted("stock", (d) => ((d.generation = 1), (d.incarnation = 1), (d.decommission.requestedOn = "2026-06-01"), (d.decommission.deleteAfter = "2026-07-01"))),
      "apps/stock/app.yaml": app("stock", (d) => (d.generation = 2)),
    });
    const file = join(root, "apps", "stock", "app.yaml");
    const r = validateApp(file, { instance: join(root, "instance.yaml") });
    assert.deepEqual(r.checks.map((c) => c.checkId), ["slug-reuse-incarnation"], msgs(r));
    assert.equal(r.checks[0]?.path, "slug", "without incarnation: the slug's line");
    assert.equal(
      r.checks[0]?.message,
      'incarnation 0 (not set) must be above 1: the slug "stock" belonged to 2 deleted apps (apps-deleted/stock/: requested for deletion on 2026-01-05: incarnation 0; requested for deletion on 2026-06-01: incarnation 1). Set incarnation to 2, so the new app gets its own Entra registration: a deleted app\'s registration keeps its name for 30 days (check slug-reuse-incarnation).',
    );
    put(root, "apps/stock/app.yaml", app("stock", (d) => ((d.generation = 2), (d.incarnation = 1))));
    assert.equal(validateApp(file, { instance: join(root, "instance.yaml") }).checks.find((x) => x.checkId === "slug-reuse-incarnation")?.path, "incarnation");
    put(root, "apps/stock/app.yaml", app("stock", (d) => ((d.generation = 2), (d.incarnation = 2))));
    const ok = validateApp(file, { instance: join(root, "instance.yaml") });
    assert.equal(ok.ok, true, msgs(ok));
  });

  it("the pure check and the library (archivedAppYamlTexts, for the portal): both numbers are checked", () => {
    const archived = [{ text: stringify(deleted("stock", (d) => (d.generation = 1))) }];
    assert.deepEqual(slugReuseChecks(app("stock", (d) => (d.generation = 2)) as AppData, archived).map((c) => c.checkId), ["slug-reuse-incarnation"]);
    assert.deepEqual(slugReuseChecks(app("stock", (d) => (d.incarnation = 1)) as AppData, archived).map((c) => c.checkId), ["slug-reuse-generation"]);
    const inst = readFileSync(INSTANCE, "utf8");
    const lib = validateAppDefinition(inst, stringify(app("stock", (d) => (d.generation = 2))), { archivedAppYamlTexts: archived.map((a) => a.text) });
    assert.deepEqual(lib.problems.map((p) => p.checkId), ["slug-reuse-incarnation"]);
    assert.match(lib.problems[0]!.message, /requested for deletion on 2026-01-05: incarnation 0\)\. Set incarnation to 1/);
  });
});

describe("check incarnation-fixed (ADR-0061: one Entra registration for an app's whole life)", () => {
  it("with --base, an existing app's incarnation never changes (no value is 0); raising generation leaves it alone", () => {
    const root = config({ "apps/stock/app.yaml": app("stock") }, { git: true });
    const file = join(root, "apps", "stock", "app.yaml");
    const check = (): AppValidateResult => validateApp(file, { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    put(root, "apps/stock/app.yaml", app("stock", (d) => (d.incarnation = 0)));
    assert.equal(check().ok, true, msgs(check()));
    put(root, "apps/stock/app.yaml", app("stock", (d) => (d.incarnation = 1)));
    const r = check();
    const c = r.checks.find((x) => x.checkId === "incarnation-fixed");
    assert.equal(c?.path, "incarnation");
    assert.match(c!.message, /^incarnation changed from 0 to 1; it never changes: it names the app's Entra registration for its whole life/);
    // A deliberate re-creation (ADR-0020) raises generation only: the registration stays.
    put(root, "apps/stock/app.yaml", app("stock", (d) => (d.generation = 1)));
    const g = check();
    assert.ok(!g.checks.some((x) => x.checkId === "incarnation-fixed"), msgs(g));
    assert.ok(g.destructive.some((x) => x.path === "generation"));
    const cliOut = cli(["validate", "app", file, "--instance", join(root, "instance.yaml"), "--base", "main"]);
    assert.equal(cliOut.code, 0, cliOut.stdout);
  });

  it("a slug used again is a new app (nothing compared); a definition moved back is compared with its archived one", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", app("stock", (d) => ((d.generation = 1), (d.incarnation = 1))));
    const r = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(r.ok, true, msgs(r));
    const back = config({ [archivedAppYamlPath("stock", REQUESTED)]: deleted("stock") }, { git: true });
    rmSync(join(back, "apps-deleted"), { recursive: true });
    put(back, "apps/stock/app.yaml", deleted("stock", (d) => (d.incarnation = 1)));
    const v = validateApp(join(back, "apps", "stock", "app.yaml"), { instance: join(back, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(v.base?.restoredFrom, "apps-deleted/stock/2026-01-05/app.yaml");
    assert.ok(v.checks.some((x) => x.checkId === "incarnation-fixed"), msgs(v));
  });
});

describe("a slug used again: the new apps/<slug>/app.yaml is a new app", () => {
  /** The new app: no decommission block, another database engine (both refused as a change). */
  const fresh = (): Doc =>
    app("stock", (d) => {
      d.generation = 1;
      d.incarnation = 1;
      d.title = "Stock 2";
      d.data.database = { engine: "azureSql", size: "S" };
    });

  it("compares nothing with the archived definition (decommission-tombstone, database engine, ...)", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock"), "apps/orders/app.yaml": app("orders") }, { git: true });
    reuse(root, "stock", fresh());
    const r = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(r.ok, true, msgs(r));
    assert.deepEqual(r.destructive, []);
    assert.deepEqual(r.base, { ref: "main", found: true, archivedAs: "apps-deleted/stock/2026-01-05/app.yaml" });
    const out = cli(["validate", "app", join(root, "apps", "stock", "app.yaml"), "--instance", join(root, "instance.yaml"), "--base", "main"]);
    assert.equal(out.code, 0, out.stdout);
    assert.match(out.stdout, /^ {2}new app: the deleted app with this slug moved to apps-deleted\/stock\/2026-01-05\/app\.yaml in this change; nothing compared with main \(ADR-0061\)$/m);
  });

  it("an unchanged move is recognised whatever the line endings (CRLF, no last newline)", () => {
    assert.equal(sameDefinitionText("a: 1\r\nb: 2", "a: 1\nb: 2\n"), true);
    assert.equal(sameDefinitionText("a: 1\n", "a: 2\n"), false);
    assert.equal(sameDefinitionText(undefined, "a: 1\n"), false);
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", fresh());
    const archived = join(root, archivedAppYamlPath("stock", REQUESTED));
    writeFileSync(archived, readFileSync(archived, "utf8").replace(/\n/g, "\r\n").replace(/\r\n$/, ""));
    assert.equal(validateArchive(root, { base: "main", today: TODAY }).ok, true);
    const r = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(r.base?.archivedAs, "apps-deleted/stock/2026-01-05/app.yaml", msgs(r));
    assert.equal(r.ok, true, msgs(r));
  });

  it("without the archive move, the same file is a change of the deleted app and is refused", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    put(root, "apps/stock/app.yaml", fresh());
    const r = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(r.base?.archivedAs, undefined);
    assert.ok(r.checks.some((c) => c.checkId === "decommission-tombstone"), msgs(r));
    assert.match(msgs(r), /database engine changed from postgres to azureSql/);
    // An archived definition that differs from the base's file is no move either (and deleted-archive refuses it).
    put(root, archivedAppYamlPath("stock", REQUESTED), deleted("stock", (d) => (d.title = "Other")));
    const other = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.equal(other.base?.archivedAs, undefined);
    assert.ok(other.checks.some((c) => c.checkId === "decommission-tombstone"));
  });

  it("an archive from an earlier change doesn't make a later change a new app", () => {
    const root = config({ "apps/stock/app.yaml": deleted("stock") }, { git: true });
    reuse(root, "stock", fresh());
    git(root, "add", "-A");
    git(root, "commit", "-q", "-m", "reuse");
    put(root, "apps/stock/app.yaml", app("stock", (d) => ((d.generation = 0), (d.data.database = { engine: "azureSql", size: "S" }))));
    const r = validateApp(join(root, "apps", "stock", "app.yaml"), { instance: join(root, "instance.yaml"), base: "main", today: TODAY });
    assert.deepEqual(r.base, { ref: "main", found: true });
    assert.match(msgs(r), /generation went down from 1 to 0/);
    assert.ok(r.checks.some((c) => c.checkId === "slug-reuse-generation"));
  });
});

describe("everything that enumerates apps reads apps/ only (the archive is never provisioned)", () => {
  /** An archived definition that would clash with apps/orders in every way: repository, host, network. */
  const ghost = (): Doc =>
    app("stock", (d) => {
      d.repository.name = "orders";
      d.decommission = { ...BLOCK, deleteAfter: "2999-01-01" };
    });

  it("platform generate (and --check) renders apps/<slug>/delivery.yml for apps/ only", () => {
    const root = config({ "apps/orders/app.yaml": app("orders"), [archivedAppYamlPath("stock", REQUESTED)]: ghost() });
    const r = generate(root, { check: false });
    assert.ok(r.files.some((f) => f.path === "apps/orders/delivery.yml"));
    assert.ok(!r.files.some((f) => f.path.startsWith("apps-deleted/")), JSON.stringify(r.files.map((f) => f.path)));
    assert.equal(existsSync(join(root, "apps-deleted", "stock", REQUESTED, "delivery.yml")), false);
    const check = cli(["generate", "--config-dir", root, "--check"]);
    assert.equal(check.code, 0, check.stdout + check.stderr);
    // An archived definition that isn't even valid doesn't break generate.
    put(root, archivedAppYamlPath("billing", REQUESTED), "slug: [unclosed\n");
    assert.equal(cli(["generate", "--config-dir", root, "--check"]).code, 0);
  });

  it("platform provisioning apps and validate-run --upgrade", () => {
    const root = config({ "apps/orders/app.yaml": app("orders"), [archivedAppYamlPath("stock", REQUESTED)]: ghost() });
    const r = listApps({ instance: join(root, "instance.yaml"), appsDir: join(root, "apps"), scope: "all" });
    assert.deepEqual(r.apps.map((a) => a.slug), ["orders"]);
    // validate-run: the parameter upgrade may name only apps of apps/.
    const P = join(FIXTURES, "provisioning", "config");
    const cfg = join(tmp("pc-archive-run-"), "config");
    cpSync(P, cfg, { recursive: true });
    put(cfg, archivedAppYamlPath("olddemo", REQUESTED), readFileSync(join(cfg, "apps", "demo", "app.yaml"), "utf8"));
    const units: Doc = { schemaVersion: 1, units: {} };
    for (const [i, u] of ["lz", "entra", "release", "frontdoor", "pep", "ado"].entries()) units.units[u] = { revision: 1, fingerprint: String(i).repeat(64), since: "v0.1.0-rc.1" };
    const scratch = tmp("pc-archive-run-in-");
    writeFileSync(join(scratch, "units.json"), JSON.stringify(units));
    writeFileSync(join(scratch, "upgrades.yaml"), "minAppVersion: v0.1.0-rc.1\nversions: {}\n");
    const envs = JSON.stringify([{ name: "nonprod", kind: "nonprod", promoteFrom: "" }, { name: "prod", kind: "prod", promoteFrom: "nonprod" }]);
    const run = (upgrade: string) =>
      cli(["provisioning", "validate-run", "--instance", join(cfg, "instance.yaml"), "--environments-json", envs, "--host-environment", "prod", "--core-ref", "refs/tags/v0.1.0-rc.3", "--source-branch", "refs/heads/main", "--units", join(scratch, "units.json"), "--upgrades", join(scratch, "upgrades.yaml"), "--upgrade", upgrade, "--apps-dir", join(cfg, "apps")]);
    assert.equal(run("demo").code, 0, run("demo").stderr);
    const archived = run("olddemo");
    assert.equal(archived.code, 1);
    assert.match(archived.stderr, /parameter upgrade names olddemo, which has no app definition \(apps\/olddemo\/app\.yaml\)/);
  });

  it("the checks between apps: repository, custom host and capacity ignore archived definitions", () => {
    const owner = (d: Doc): void => {
      d.authentication = { mode: "anonymous" };
      d.environments.nonprod.frontDoor = { hostName: "orders-test.contoso.com" };
      d.environments.prod.capacity = { size: "l", maxReplicas: 10 }; // 20 of the cell's 30 cores below
    };
    const inst = parse(readFileSync(INSTANCE, "utf8")) as Doc;
    inst.authentication.enforcement = "ownerChoice";
    (inst.environments as Doc[]).find((e) => e.name === "prod")!.networkModes.externalHybrid.cells = [{ id: "01", capacity: { cores: 30 } }];
    const root = config({ "apps/orders/app.yaml": app("orders", owner), [archivedAppYamlPath("orders", REQUESTED)]: app("orders", (d) => (owner(d), (d.repository.name = "orders"), (d.decommission = { ...BLOCK, deleteAfter: "2999-01-01" }))) });
    put(root, "instance.yaml", inst);
    put(root, "apps/orders/app.yaml", app("orders", (d) => (owner(d), (d.generation = 1), (d.incarnation = 1))));
    // A sibling in apps/ with the same repository and host fails; the archived one doesn't count.
    const r = validateApp(join(root, "apps", "orders", "app.yaml"), { instance: join(root, "instance.yaml") });
    assert.equal(msgs(r), "", "the archived definition (same repository, host and a full cell) is no other app");
    put(root, "apps/billing/app.yaml", app("billing", (d) => (owner(d), (d.repository.name = "orders"))));
    const clash = msgs(validateApp(join(root, "apps", "orders", "app.yaml"), { instance: join(root, "instance.yaml") }));
    assert.match(clash, /apps "orders" and "billing" both use the repository/);
    assert.match(clash, /host "orders-test\.contoso\.com" is already the custom domain of app "billing"/);
    assert.match(clash, /cell 01 of externalHybrid in environment prod would reserve 40 cores, more than its budget of 30/);
  });

  it("validate instance --base: the network rule counts the apps of apps/ only", () => {
    const root = config({ [archivedAppYamlPath("stock", REQUESTED)]: app("stock", (d) => (d.environments = { prod: { networkMode: "externalHybrid" } })) }, { git: true });
    const inst = parse(readFileSync(join(root, "instance.yaml"), "utf8")) as Doc;
    (inst.environments as Doc[]).find((e) => e.name === "prod")!.networkModes.externalHybrid.dnsServers = ["10.0.0.6"];
    put(root, "instance.yaml", inst);
    const r = validateFile("instance", join(root, "instance.yaml"), { base: "main" });
    assert.equal(r.ok, true, JSON.stringify(r.checks));
    put(root, "apps/orders/app.yaml", app("orders"));
    assert.equal(validateFile("instance", join(root, "instance.yaml"), { base: "main" }).ok, false, "an app of apps/ in prod: refused");
  });
});

describe("the failure catalogue explains the checks", () => {
  it("in English and Czech, with the archive's own command for deleted-archive", () => {
    for (const id of ["slug-reuse-generation", "slug-reuse-incarnation", "incarnation-fixed", "deleted-archive"]) {
      assert.ok((DEFINITION_CHECK_IDS as readonly string[]).includes(id), id);
      const e = explainCheck(id);
      assert.ok(e && e.title.en && e.title.cs && e.prompt.cs, id);
    }
    assert.match(checkAiPrompt("deleted-archive", "en")!, /platform validate archive \. --base <target branch>/);
    assert.match(checkAiPrompt("deleted-archive", "cs")!, /platform validate archive \. --base <cílová větev>/);
    assert.match(checkAiPrompt("slug-reuse-generation", "en")!, /platform validate app apps\/<slug>\/app\.yaml --instance instance\.yaml/);
    assert.match(cli(["rules", "--explain", "slug-reuse-generation", "--lang", "cs"]).stdout, /^slug-reuse-generation {2}Nová aplikace se jménem smazané aplikace potřebuje vyšší generaci$/m);
  });
});
