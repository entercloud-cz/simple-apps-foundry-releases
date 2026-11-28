import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { cli, FIXTURES, git, PKG_ROOT, REPO_ROOT, tmp } from "./helpers.js";
import { appYamlPath, deliveryYamlPath, PlatformConfigError, renderDeliveryYaml, REPOSITORY_TEMPLATES, repositoryTemplate, validateAppDefinition, validateInstanceDefinition } from "../src/index.js";
import type { AppDefinitionProblem } from "../src/index.js";
import { validateFile } from "../src/validate.js";
import { formatAppText, validateApp } from "../src/validate-app.js";
import type { AppValidateResult } from "../src/validate-app.js";

// The library the portal imports (package.json exports ".") must give exactly what the commands
// give: validateAppDefinition = `platform validate app --instance`, renderDeliveryYaml = the
// delivery.yml `platform generate` writes.

const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const FIX = join(FIXTURES, "app-definitions");
const PROV = join(FIXTURES, "provisioning", "config");
const instanceText = readFileSync(INSTANCE, "utf8");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function example(mutate?: (d: Doc) => void): string {
  const d = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  mutate?.(d);
  return stringify(d);
}

/** <tmp>/apps/<slug>/app.yaml, as the CLI expects it. */
function appFile(text: string, dir?: string): string {
  let slug = dir;
  try {
    slug ??= (parse(text) as Doc | null)?.slug as string | undefined;
  } catch {
    // a YAML syntax error: any directory will do
  }
  slug ??= "demo-app";
  const d = join(tmp("pc-lib-"), "apps", slug);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "app.yaml"), text);
  return join(d, "app.yaml");
}

/** The CLI result as library problems (same order: syntax, schema, rules). */
function cliProblems(r: AppValidateResult): Omit<AppDefinitionProblem, "source">[] {
  return [
    ...r.parseErrors.map((e) => ({ kind: "syntax" as const, path: "(root)", message: `YAML syntax error: ${e.message}`, line: e.line, column: e.column })),
    ...r.problems.map((p) => ({ kind: "schema" as const, path: p.path, message: p.message, line: p.line, column: p.column, help: p.help })),
    ...r.checks.map((c) => ({ kind: "rule" as const, path: c.path, message: c.message, line: c.line, checkId: c.checkId, decommission: c.decommission })),
  ].map((p) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined)) as unknown as Omit<AppDefinitionProblem, "source">);
}

const strip = (ps: AppDefinitionProblem[]): Omit<AppDefinitionProblem, "source">[] =>
  ps.map((p) => {
    assert.equal(p.source, "app");
    const { source: _s, ...rest } = p;
    return rest;
  });

describe("library: validateAppDefinition agrees with platform validate app --instance", () => {
  const cases: [string, string][] = [
    ["the Contoso example", readFileSync(EXAMPLE, "utf8")],
    ["schema errors", readFileSync(join(FIX, "schema-errors.yaml"), "utf8")],
    ["semantic and instance errors", readFileSync(join(FIX, "semantic-errors.yaml"), "utf8")],
    ["a YAML syntax error", "slug: [unclosed\n"],
    ["an unknown template", example((d) => (d.repository.template = "java"))],
    ["no template (unmanaged)", example((d) => delete d.repository.template)],
    ["format characters in the title", example((d) => (d.title = "Hotel\u202EInventory"))],
    ["text that can't go into the app repo", example((d) => ((d.title = "Hotel <Inventory>"), (d.description = "Uses `code`.")))],
    ["an environment the instance lacks", example((d) => (d.environments.qa = { networkMode: "externalOnly" }))],
  ];
  for (const [label, text] of cases) {
    it(label, () => {
      const file = appFile(text);
      const fromCli = validateApp(file, { instance: INSTANCE });
      const lib = validateAppDefinition(instanceText, text);
      assert.equal(lib.ok, fromCli.ok);
      assert.deepEqual(strip(lib.problems), cliProblems(fromCli));
      assert.equal(lib.app !== undefined, lib.ok);
      // And the command's exit code says the same.
      assert.equal(cli(["validate", "app", file, "--instance", INSTANCE]).code, fromCli.ok ? 0 : 1);
    });
  }

  it("checks the slug against the path (default apps/<slug>/app.yaml)", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    assert.equal(validateAppDefinition(instanceText, text).ok, true);
    const moved = validateAppDefinition(instanceText, text, { path: "apps/other/app.yaml" });
    assert.equal(moved.ok, false);
    assert.match(moved.problems.map((p) => p.message).join("\n"), /slug "hotel-inventory" must equal the directory name apps\/other\//);
    assert.equal(appYamlPath("hotel-inventory"), "apps/hotel-inventory/app.yaml");
    assert.equal(deliveryYamlPath("hotel-inventory"), "apps/hotel-inventory/delivery.yml");
  });

  it("compares with the base version like --base (immutability and destructive changes)", () => {
    const base = readFileSync(join(FIX, "base-v1.yaml"), "utf8");
    const root = tmp("pc-lib-git-");
    git(root, "init", "-q", "-b", "main");
    mkdirSync(join(root, "apps", "demo-app"), { recursive: true });
    writeFileSync(join(root, "apps", "demo-app", "app.yaml"), base);
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "base");
    const d = parse(base) as Doc;
    d.generation = 1;
    d.environments.prod.networkMode = "externalHybrid";
    delete d.data.storage;
    const now = stringify(d);
    writeFileSync(join(root, "apps", "demo-app", "app.yaml"), now);
    const fromCli = validateApp(join(root, "apps", "demo-app", "app.yaml"), { base: "main", instance: INSTANCE });
    const lib = validateAppDefinition(instanceText, now, { baseAppYamlText: base });
    assert.equal(lib.ok, false);
    assert.deepEqual(
      lib.problems.map((p) => p.message),
      fromCli.checks.map((c) => c.message.replace("the version at main", "the version at base")),
    );
    assert.match(lib.problems.map((p) => p.message).join("\n"), /generation went down from 2 to 1/);
    // ADR-0060: a move between externalOnly and externalHybrid in cell 01 is destructive, not an
    // error; the portal finds it at environments.<env>.networkMode. With the instance it names case A
    // (the example's prod has External only on the managed network) and the maintenance window.
    assert.equal(lib.problems.find((p) => p.checkId === "network-mode-change"), undefined);
    assert.match(lib.destructive.find((p) => p.path === "environments.prod.networkMode")?.message ?? "", /^network mode externalOnly -> externalHybrid in prod \(case A\): provisioning moves the app there with a short outage, inside the maintenance window: /);
    assert.deepEqual(lib.destructive.map((p) => p.message), fromCli.destructive.map((c) => c.message));
    assert.match(lib.destructive.map((p) => p.message).join("\n"), /the storage account is removed/);
    assert.match(formatAppText(fromCli), /DESTRUCTIVE/);
  });

  it("reports an invalid instance as instance problems instead of exiting", () => {
    const r = validateAppDefinition("schemaVersion: nope\n", readFileSync(EXAMPLE, "utf8"));
    assert.equal(r.ok, false);
    assert.ok(r.problems.length > 0 && r.problems.every((p) => p.source === "instance" && p.kind === "schema"));
    const syntax = validateAppDefinition("a: [\n", readFileSync(EXAMPLE, "utf8"));
    assert.equal(syntax.problems[0]?.kind, "syntax");
    assert.equal(cli(["validate", "app", EXAMPLE, "--instance", appFile("schemaVersion: nope\n", "inst")]).code, 2, "the CLI stops with a usage error");
  });

  it("checks that every app has its own repository against otherAppYamlTexts, like the CLI in a platform-config", () => {
    const text = readFileSync(EXAMPLE, "utf8");
    const twin = example((d) => ((d.slug = "hotel-twin"), (d.repository.name = "Hotel-Inventory")));
    const lib = validateAppDefinition(instanceText, text, { otherAppYamlTexts: [twin, "not: [valid\n", example((d) => ((d.slug = "x-app"), (d.repository.name = "x")))] });
    assert.equal(lib.ok, false);
    assert.deepEqual(lib.problems.map((p) => `${p.kind} ${p.path}: ${p.message}`), [
      'rule repository.name: apps "hotel-inventory" and "hotel-twin" both use the repository Apps/hotel-inventory; each app needs its own repository.',
    ]);
    const root = join(tmp("pc-lib-config-"), "platform-config");
    mkdirSync(join(root, "apps", "hotel-inventory"), { recursive: true });
    mkdirSync(join(root, "apps", "hotel-twin"));
    writeFileSync(join(root, "instance.yaml"), instanceText);
    writeFileSync(join(root, "apps", "hotel-inventory", "app.yaml"), text);
    writeFileSync(join(root, "apps", "hotel-twin", "app.yaml"), twin);
    const fromCli = validateApp(join(root, "apps", "hotel-inventory", "app.yaml"), { instance: join(root, "instance.yaml") });
    assert.deepEqual(strip(lib.problems), cliProblems(fromCli));
    assert.equal(validateAppDefinition(instanceText, text, { otherAppYamlTexts: [text] }).ok, true, "its own definition (same slug) is no clash");
  });

  it("repositoryTemplate: undefined without repository.template (unmanaged), never a default", () => {
    assert.equal(repositoryTemplate({ repository: { provider: "azureDevOps", project: "Apps", name: "x" } }), undefined);
    assert.equal(repositoryTemplate({ repository: { provider: "azureDevOps", project: "Apps", name: "x", template: "byo" } }), "byo");
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "config", "schema", "app.schema.json"), "utf8")) as Doc;
    assert.equal("default" in schema.properties.repository.properties.template, false);
  });

  it("exports the repository templates of the schema", () => {
    const schema = JSON.parse(readFileSync(join(REPO_ROOT, "config", "schema", "app.schema.json"), "utf8")) as Doc;
    assert.deepEqual([...REPOSITORY_TEMPLATES], schema.properties.repository.properties.template.enum);
  });
});

describe("library: validateInstanceDefinition agrees with platform validate instance", () => {
  /** What `platform validate instance` reports for the text, as "<kind> <path>" lines. */
  function cliInstanceProblems(text: string): string[] {
    const file = join(tmp("pc-lib-inst-"), "instance.yaml");
    writeFileSync(file, text);
    const r = validateFile("instance", file);
    return [...r.parseErrors.map(() => "syntax (root)"), ...r.problems.map((p) => `schema ${p.path}`), ...(r.checks ?? []).map((c) => `rule ${c.path}`)];
  }
  const mutated = (mutate: (d: Doc) => void): string => {
    const d = parse(instanceText) as Doc;
    mutate(d);
    return stringify(d);
  };

  it("accepts the Contoso example", () => {
    const r = validateInstanceDefinition(instanceText);
    assert.deepEqual(r.problems, []);
    assert.equal(r.ok, true);
  });

  it("coreImages.registry: a registry with or without the path of its repositories; no scheme, no tag (ADR-0065)", () => {
    for (const registry of ["ghcr.io/contoso", "ghcr.io/contoso/core", "corereleases.azurecr.io"]) {
      const r = validateInstanceDefinition(mutated((d) => (d.coreImages = { registry })));
      assert.deepEqual(r.problems, [], registry);
    }
    for (const registry of ["https://ghcr.io/contoso", "ghcr.io/contoso:latest", "ghcr.io/Contoso", "ghcr.io/contoso/", "localhost"]) {
      const r = validateInstanceDefinition(mutated((d) => (d.coreImages = { registry })));
      assert.equal(r.ok, false, registry);
    }
  });

  it("coreReleases.repository: an https github.com repository, without .git or a trailing slash (ADR-0067)", () => {
    for (const repository of ["https://github.com/contoso/simple-apps-foundry-releases", "https://github.com/contoso-2/releases.v2"]) {
      const r = validateInstanceDefinition(mutated((d) => (d.coreReleases = { repository })));
      assert.deepEqual(r.problems, [], repository);
    }
    for (const repository of ["https://github.com/contoso/releases.git", "https://github.com/contoso/releases/", "http://github.com/contoso/releases", "https://github.com/contoso", "https://github.com/contoso/a/b", "git@github.com:contoso/releases"]) {
      const r = validateInstanceDefinition(mutated((d) => (d.coreReleases = { repository })));
      assert.equal(r.ok, false, repository);
    }
    assert.equal(validateInstanceDefinition(mutated((d) => (d.coreReleases = { repository: "https://github.com/contoso/r", branch: "main" }))).ok, false);
    assert.equal(validateInstanceDefinition(mutated((d) => delete d.coreReleases)).ok, true, "optional");
  });

  it("reports syntax, schema and rule problems as instance problems, like the command", () => {
    const cases: [string, string, AppDefinitionProblem["kind"]][] = [
      ["syntax", "a: [\n", "syntax"],
      ["schema", mutated((d) => (d.budgets.mode = "sometimes")), "schema"],
      ["rule", mutated((d) => d.frontDoor.managed.profiles.push({ environment: "staging" })), "rule"],
    ];
    for (const [label, text, kind] of cases) {
      const r = validateInstanceDefinition(text);
      assert.equal(r.ok, false, label);
      assert.ok(r.problems.length > 0 && r.problems.every((p) => p.source === "instance"), label);
      assert.equal(r.problems[0]?.kind, kind, label);
      assert.deepEqual(
        r.problems.map((p) => `${p.kind} ${p.path}`),
        cliInstanceProblems(text),
        label,
      );
    }
  });
});

describe("library: renderDeliveryYaml equals what platform generate writes", () => {
  function generated(instance: string, apps: Record<string, string>): { dir: string; read: (slug: string) => string } {
    const dir = join(tmp("pc-lib-config-"), "platform-config");
    mkdirSync(join(dir, "apps"), { recursive: true });
    writeFileSync(join(dir, "instance.yaml"), instance);
    for (const [slug, text] of Object.entries(apps)) {
      mkdirSync(join(dir, "apps", slug));
      writeFileSync(join(dir, "apps", slug, "app.yaml"), text);
    }
    const r = cli(["generate", "--config-dir", dir]);
    assert.equal(r.code, 0, r.stderr);
    return { dir, read: (slug) => readFileSync(join(dir, deliveryYamlPath(slug)), "utf8") };
  }

  it("the Contoso example and the provisioning fixture, byte for byte", () => {
    const ex = readFileSync(EXAMPLE, "utf8");
    assert.equal(renderDeliveryYaml(instanceText, ex), generated(instanceText, { "hotel-inventory": ex }).read("hotel-inventory"));
    const provInstance = readFileSync(join(PROV, "instance.yaml"), "utf8");
    const demo = readFileSync(join(PROV, "apps", "demo", "app.yaml"), "utf8");
    const g = generated(provInstance, { demo });
    assert.equal(renderDeliveryYaml(provInstance, demo), g.read("demo"));
    assert.equal(cli(["generate", "--config-dir", g.dir, "--check"]).code, 0);
  });

  it("production on request (ADR-0045): a new app in its build environment only, then production added", () => {
    // A new app runs only where builds go directly: valid, and its pipeline has no promotion.
    const nonprodOnly = example((d) => {
      d.environments = { nonprod: d.environments.nonprod };
    });
    assert.deepEqual(validateAppDefinition(instanceText, nonprodOnly).problems, []);
    const before = renderDeliveryYaml(instanceText, nonprodOnly);
    assert.match(before, /values: \[none, nonprod\]/);
    assert.doesNotMatch(before, /name: prod/);
    assert.equal(before, generated(instanceText, { "hotel-inventory": nonprodOnly }).read("hotel-inventory"));
    // Production added later: a valid change against that base, not a destructive one.
    const withProd = readFileSync(EXAMPLE, "utf8");
    const added = validateAppDefinition(instanceText, withProd, { baseAppYamlText: nonprodOnly });
    assert.deepEqual(added.problems, []);
    assert.deepEqual(added.destructive, []);
    assert.match(renderDeliveryYaml(instanceText, withProd), /values: \[none, nonprod, prod\]/);
    // Taking it away again is reported as destructive.
    const removed = validateAppDefinition(instanceText, nonprodOnly, { baseAppYamlText: withProd });
    assert.deepEqual(
      removed.destructive.map((p) => p.message),
      ["the app is removed from environment prod (all its resources there are deleted)."],
    );
    // Production alone, without the environment it promotes from, stays invalid.
    const prodOnly = validateAppDefinition(instanceText, example((d) => (d.environments = { prod: d.environments.prod })));
    assert.ok(prodOnly.problems.some((p) => p.message === "prod receives builds from nonprod, so the app must also run in nonprod."));
  });

  it("throws PlatformConfigError with the problems for an invalid definition", () => {
    assert.throws(
      () => renderDeliveryYaml(instanceText, example((d) => (d.environments.qa = { networkMode: "externalOnly" }))),
      (e: unknown) => e instanceof PlatformConfigError && e.problems.some((p) => p.path === "environments.qa"),
    );
  });
});

describe("library: package entry", () => {
  it("resolves as @simple-apps-foundry/platform-cli (exports, ESM, types) from a dependent package", () => {
    const app = tmp("pc-lib-consumer-");
    mkdirSync(join(app, "node_modules", "@simple-apps-foundry"), { recursive: true });
    // npm links a file: dependency the same way.
    symlinkSync(PKG_ROOT, join(app, "node_modules", "@simple-apps-foundry", "platform-cli"));
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "consumer", type: "module", dependencies: { "@simple-apps-foundry/platform-cli": "file:../tools/platform-cli" } }));
    cpSync(EXAMPLE, join(app, "app.yaml"));
    cpSync(INSTANCE, join(app, "instance.yaml"));
    writeFileSync(
      join(app, "main.js"),
      [
        'import { readFileSync } from "node:fs";',
        'import { validateAppDefinition, renderDeliveryYaml } from "@simple-apps-foundry/platform-cli";',
        'const i = readFileSync("instance.yaml", "utf8"), a = readFileSync("app.yaml", "utf8");',
        "const r = validateAppDefinition(i, a);",
        "process.stdout.write(JSON.stringify({ ok: r.ok, slug: r.app.slug, lines: renderDeliveryYaml(i, a).split('\\n').length }));",
      ].join("\n"),
    );
    const r = spawnSync(process.execPath, ["main.js"], { cwd: app, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout) as { ok: boolean; slug: string; lines: number };
    assert.deepEqual({ ok: out.ok, slug: out.slug }, { ok: true, slug: "hotel-inventory" });
    assert.ok(out.lines > 30);
    const pkg = JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")) as Doc;
    assert.equal(pkg.exports["."].types, "./dist/src/index.d.ts");
    assert.match(readFileSync(join(PKG_ROOT, "dist", "src", "index.d.ts"), "utf8"), /export declare function validateAppDefinition\(instanceYamlText: string, appYamlText: string, opts\?: ValidateAppDefinitionOptions\): AppDefinitionResult;/);
    assert.equal(r.stdout.includes("console"), false);
  });
});
