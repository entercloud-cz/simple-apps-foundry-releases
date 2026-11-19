import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cpSync, existsSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { parse, stringify } from "yaml";
import { check, cli, REPO_ROOT, tmp, write } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import { CheckFailed, UsageError } from "../src/pipeline/common.js";
import { DOCS_FALLBACK, NOT_CONFIGURED, loadManifest, renderAppRepo, renderRepoFiles, repoRenderScope } from "../src/repo/render.js";
import type { RepoRender } from "../src/repo/render.js";
import { parseInstanceText } from "../src/provisioning/model.js";
import { validateData } from "../src/schema.js";
import { BUILT_IN_APP_THEMES, customThemePlaceholder, themeCss, themeCssVariables } from "../src/themes.js";
import type { AppTheme } from "../src/themes.js";
import type { AppData } from "../src/validate-app.js";
import { toolVersion } from "../src/version.js";

const TEMPLATES = join(REPO_ROOT, "templates");
const MANIFEST = join(TEMPLATES, "app", "manifest.json");
const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const APP = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const DATE = "2026-10-30";

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
  files: { source?: string; target: string; type?: string; from?: string; when?: string; generate?: string }[];
  onboarding: string[];
  syncAgentFiles: string[];
  stacks: Record<string, { source: string | null }>;
};
const instanceText = readFileSync(INSTANCE, "utf8");

function appText(mutate?: (d: Doc) => void): string {
  const d = parse(readFileSync(APP, "utf8")) as Doc;
  mutate?.(d);
  return stringify(d);
}

/** Writes an app definition to <tmp>/apps/<slug>/app.yaml. */
function appFile(text: string): string {
  const slug = (parse(text) as Doc).slug as string;
  const file = join(tmp("pc-repo-app-"), "apps", slug, "app.yaml");
  write(join(file, "..", "..", ".."), `apps/${slug}/app.yaml`, text);
  return file;
}

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)).split("\\").join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

function stackTargets(stack: string): string[] {
  return listFiles(join(TEMPLATES, "stacks", stack)).map((p) => p.replace(/\.tmpl$/, ""));
}

function skillTargets(prefix: string): string[] {
  return listFiles(join(TEMPLATES, "app", "agent-files", "skills")).map((p) => `${prefix}/${p}`);
}

function expectedOnboarding(): string[] {
  const out: string[] = [];
  for (const t of manifest.onboarding) {
    if (t === ".agents/skills" || t === ".claude/skills") out.push(...skillTargets(t));
    else out.push(t);
  }
  return out;
}

function render(template: "node-ts" | "python-fastapi" | "dotnet" | "byo", text = appText(), existing?: Map<string, Buffer>): RepoRender {
  return renderAppRepo(instanceText, text, { templatesDir: TEMPLATES, date: DATE, template, ...(existing ? { existing } : {}) });
}

/** The theme files of the manifest (ADR-0044): written only when the app has a theme. */
const THEME_FILES = manifest.files.filter((f) => f.when === "theme").map((f) => f.target).sort();
/** The starter docs: every stack gets them, byo doesn't. */
const STARTER_DOCS = ["README.md", "CHANGELOG.md", "docs/architecture.md", "docs/decisions/0001-record-decisions.md"];

/** An app definition with this ui.theme (undefined: no ui at all). */
const themed = (theme: string | undefined): string =>
  appText((d) => {
    if (theme === undefined) delete d.ui;
    else d.ui = { theme };
  });

const builtIn = (id: string): AppTheme => BUILT_IN_APP_THEMES.find((t) => t.id === id)!;

const asText = (r: RepoRender, path: string): string => {
  const f = r.files.find((x) => x.path === path);
  assert.ok(f, `${path} rendered`);
  return f.content.toString("utf8");
};

describe("platform repo render: stacks", () => {
  for (const stack of ["node-ts", "python-fastapi", "dotnet"] as const) {
    it(`${stack}: the stack and every manifest entry, placeholders filled, passes platform check`, async () => {
      const r = render(stack);
      assert.equal(r.template, stack);
      assert.equal(r.slug, "hotel-inventory");
      assert.equal(r.theme, "fjord", "the example app's ui.theme");
      const paths = r.files.map((f) => f.path);
      assert.ok(r.files.every((f) => f.change === "add"));
      const want = new Set([...stackTargets(stack), ...expectedOnboarding(), ...STARTER_DOCS, ...THEME_FILES]);
      assert.deepEqual(paths, [...want].sort());
      assert.deepEqual(paths, [...paths].sort(), "sorted by path");
      assert.equal(asText(r, "theme/theme.css"), themeCss(builtIn("fjord")));

      // Every .tmpl source was rendered: no placeholder left in its output.
      const tmplTargets = [
        ...listFiles(join(TEMPLATES, "stacks", stack)).filter((p) => p.endsWith(".tmpl")).map((p) => p.replace(/\.tmpl$/, "")),
        ...manifest.files.filter((f) => f.source?.endsWith(".tmpl")).map((f) => f.target),
      ];
      for (const t of tmplTargets) assert.doesNotMatch(asText(r, t), /\{\{[A-Z_]+\}\}/, t);
      const agents = asText(r, "AGENTS.md");
      assert.match(agents, /^# AGENTS\.md — Hotel Inventory$/m);
      assert.match(agents, /\| Portal page \| https:\/\/portal\.contoso\.com\/apps\/hotel-inventory \|/);
      assert.match(agents, /\| Created from template \| v0\.1\.0 on 2026-10-30 \|/);
      assert.match(agents, new RegExp(`\\(\`${stack}\`\\)`));
      assert.equal(asText(r, ".platform/cli-version"), `${toolVersion()}\n`);
      const platform = parse(asText(r, "platform.yaml")) as Doc;
      assert.equal(platform.app, "hotel-inventory");
      assert.deepEqual(validateData("manifest", platform), [], "platform.yaml is a valid app manifest");
      assert.match(asText(r, "platform.yaml"), /this platform: nonprod, prod\)/);
      // Skills are copied byte for byte and mirrored.
      for (const s of skillTargets(".agents/skills")) {
        const rel = s.slice(".agents/skills/".length);
        const src = readFileSync(join(TEMPLATES, "app", "agent-files", "skills", rel));
        assert.ok(r.files.find((f) => f.path === s)?.content.equals(src), s);
        assert.ok(r.files.find((f) => f.path === `.claude/skills/${rel}`)?.content.equals(src), `mirror ${rel}`);
      }

      const out = join(tmp("pc-repo-"), stack);
      const c = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--template", stack, "--date", DATE]);
      assert.equal(c.code, 0, c.stderr);
      assert.deepEqual(listFiles(out), paths);
      for (const f of r.files) assert.ok(readFileSync(join(out, f.path)).equals(f.content), `CLI wrote the same bytes: ${f.path}`);
      const report = await check(out, { agentManifestPath: MANIFEST });
      const problems = report.findings.filter((f) => f.severity !== "note").map((f) => `${f.ruleId} ${f.file ?? ""} ${f.message}`);
      assert.deepEqual(problems, [], `platform check on the rendered ${stack} repo`);
    });
  }

  it("is deterministic and repository.template picks the stack (absent = unmanaged: nothing to render)", () => {
    const a = renderAppRepo(instanceText, appText(), { templatesDir: TEMPLATES, date: DATE });
    const b = renderAppRepo(instanceText, appText(), { templatesDir: TEMPLATES, date: DATE });
    assert.equal(a.template, "node-ts");
    assert.deepEqual(a, b);
    const py = renderAppRepo(instanceText, appText((d) => (d.repository.template = "python-fastapi")), { templatesDir: TEMPLATES, date: DATE });
    assert.equal(py.template, "python-fastapi");
    const unmanaged = appText((d) => delete d.repository.template);
    assert.throws(
      () => renderAppRepo(instanceText, unmanaged, { templatesDir: TEMPLATES, date: DATE }),
      (e: unknown) => e instanceof CheckFailed && /has no repository\.template, so the platform doesn't manage its repository/.test(e.problems.join("\n")),
    );
    assert.equal(renderAppRepo(instanceText, unmanaged, { templatesDir: TEMPLATES, date: DATE, template: "byo" }).template, "byo", "an explicit template still renders");
    const unmanagedFile = appFile(unmanaged);
    const u = cli(["repo", "render", "--instance", INSTANCE, "--app", unmanagedFile, "--out", tmp(), "--date", DATE]);
    assert.equal(u.code, 1);
    assert.match(u.stderr, /^platform repo render: app hotel-inventory has no repository\.template/m);
    // The CLI finds templates/ of the core checkout it runs from.
    const out = tmp("pc-repo-default-");
    const c = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--date", DATE]);
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /^OK {2}node-ts starter of hotel-inventory with the fjord theme rendered into .*: 89 created, 0 updated, 0 deleted\.$/m);
    assert.deepEqual(listFiles(out), a.files.map((f) => f.path));
  });

  it("uses fallbacks for instance values that are not configured", () => {
    const inst = parse(instanceText) as Doc;
    delete inst.portal.apiBaseUrl;
    const r = renderAppRepo(stringify(inst), appText((d) => delete d.description), { templatesDir: TEMPLATES, date: DATE });
    const agents = asText(r, "AGENTS.md");
    assert.match(agents, new RegExp(`\\| Portal page \\| ${NOT_CONFIGURED} \\|`));
    assert.match(agents, new RegExp(`\\| Platform docs \\| ${DOCS_FALLBACK} \\|`));
    assert.match(agents, /\| Purpose \| No description yet\. \|/);
  });
});

describe("platform repo render: bring your own (onboarding set)", () => {
  it("renders only the onboarding entries: agent files and platform.yaml, no stack, no docs", () => {
    const r = render("byo");
    assert.deepEqual(r.files.map((f) => f.path), expectedOnboarding().sort());
    assert.match(asText(r, "AGENTS.md"), /\| Stack \| Bring your own container \(`byo`\) \|/);
    for (const t of manifest.syncAgentFiles) assert.ok(manifest.onboarding.includes(t), `onboarding includes ${t}`);
    assert.ok(manifest.onboarding.includes("platform.yaml"));
    assert.deepEqual(repoRenderScope("byo", { templatesDir: TEMPLATES }), {
      files: manifest.onboarding.filter((t) => !t.endsWith("/skills")).sort(),
      dirs: [".agents/skills", ".claude/skills"],
    });
  });

  it("applies the modes to the repository's files and changes nothing the second time", () => {
    const existing = new Map<string, Buffer>([
      ["README.md", Buffer.from("# Mine\n")],
      [".gitignore", Buffer.from("node_modules/\nbuild/")],
      [".editorconfig", Buffer.from("root = true\n")],
      ["AGENTS.md", Buffer.from("# Our agent notes\nUse tabs.\n")],
      [".agents/skills/own/SKILL.md", Buffer.from("---\nname: own\ndescription: Our skill.\n---\n")],
      [".claude/skills/stale/SKILL.md", Buffer.from("old\n")],
      [".platform/cli-version", Buffer.from("0.0.1\n")],
    ]);
    const r = render("byo", appText(), existing);
    const by = new Map(r.files.map((f) => [f.path, f]));
    assert.equal(by.get("README.md"), undefined, "not part of the onboarding set");
    assert.equal(by.get(".editorconfig"), undefined, "create never overwrites");
    assert.equal(by.get(".gitignore")?.change, "edit");
    const gitignore = asText(r, ".gitignore");
    assert.ok(gitignore.startsWith("node_modules/\nbuild/\n\n# Added by the platform template\n.env\n"), gitignore.slice(0, 120));
    assert.equal(gitignore.match(/^node_modules\/$/gm)?.length, 1, "existing lines are not repeated");
    const agents = asText(r, "AGENTS.md");
    assert.match(agents, /<!-- app-notes:start[^\n]*\n# Our agent notes\nUse tabs\.\n<!-- app-notes:end -->/, "an AGENTS.md without the block moves into it");
    assert.equal(by.get(".platform/cli-version")?.change, "edit", "managed");
    assert.equal(by.get(".claude/skills/own/SKILL.md")?.change, "add", "app-own skills are mirrored");
    assert.equal(by.get(".claude/skills/stale/SKILL.md")?.change, "delete", "the mirror loses extra files");
    assert.equal(by.get(".agents/skills/own/SKILL.md"), undefined, "app-own skills stay");

    // Apply the result and render again: nothing to do; the block keeps the notes.
    const after = new Map(existing);
    for (const f of r.files) {
      if (f.change === "delete") after.delete(f.path);
      else after.set(f.path, f.content);
    }
    assert.deepEqual(render("byo", appText(), after).files, []);
    const edited = new Map(after);
    edited.set("AGENTS.md", Buffer.from(asText(r, "AGENTS.md").replace("Use tabs.", "Use spaces.").replace("## This app", "## This app (edited)")));
    const again = render("byo", appText(), edited);
    assert.deepEqual(again.files.map((f) => f.path), ["AGENTS.md"]);
    assert.match(asText(again, "AGENTS.md"), /Use spaces\./);
    assert.match(asText(again, "AGENTS.md"), /^## This app$/m, "outside the block the platform text wins");
  });

  it("CLI: renders into a folder with content, writes --output, refuses symbolic links", () => {
    const dir = join(tmp("pc-repo-byo-"), "repo");
    write(dir, "README.md", "# Mine\n");
    write(dir, ".claude/skills/stale/SKILL.md", "old\n");
    const json = join(tmp(), "files.json");
    const c = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", dir, "--template", "byo", "--date", DATE, "--output", json]);
    assert.equal(c.code, 0, c.stderr);
    assert.match(c.stdout, /^deleted {2}\.claude\/skills\/stale\/SKILL\.md$/m);
    assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "# Mine\n");
    assert.ok(!existsSync(join(dir, ".claude/skills/stale/SKILL.md")));
    const files = (JSON.parse(readFileSync(json, "utf8")) as { slug: string; template: string; files: { path: string; change: string }[] });
    assert.equal(files.template, "byo");
    assert.ok(files.files.some((f) => f.path === "AGENTS.md" && f.change === "add"));
    const twice = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", dir, "--template", "byo", "--date", DATE]);
    assert.match(twice.stdout, /^OK {2}nothing to do/m);

    // .agents -> a folder outside the repo: nothing is read or written through it.
    const linked = join(tmp("pc-repo-link-"), "repo");
    write(linked, "x", "");
    symlinkSync(tmp("pc-repo-target-"), join(linked, ".agents"));
    const l = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", linked, "--date", DATE]);
    assert.equal(l.code, 1);
    assert.match(l.stderr, /\.agents.* symbolic link/);
  });
});

describe("platform repo render: the app's theme (ADR-0044)", () => {
  it("an offered theme: theme.css (themeCss), theme.json (the theme as data) and README.md; nothing else differs", () => {
    const meadow = builtIn("meadow");
    const r = render("node-ts", themed("meadow"));
    assert.equal(r.theme, "meadow");
    assert.equal(asText(r, "theme/theme.css"), themeCss(meadow));
    assert.match(asText(r, "theme/theme.css"), /^ {2}--brand-primary: #2F7D4F;$/m);
    const json = JSON.parse(asText(r, "theme/theme.json")) as Doc;
    assert.deepEqual(json, { id: "meadow", name: meadow.name, description: meadow.description, tokens: meadow.tokens });
    const order = ["primary", "onPrimary", "background", "surface", "text", "mutedText", "border", "accent", "fontFamily", "headingFontFamily", "radius"];
    assert.deepEqual(Object.keys(json.tokens), order, "the order of theme.css");
    assert.match(asText(r, "theme/README.md"), /^# The look of Hotel Inventory$/m);
    const none = render("node-ts", themed(undefined));
    assert.deepEqual(r.files.map((f) => f.path).filter((p) => !THEME_FILES.includes(p)), none.files.map((f) => f.path));
    for (const f of none.files) assert.ok(r.files.find((x) => x.path === f.path)?.content.equals(f.content), `same bytes: ${f.path}`);
  });

  it("none and no ui: no theme files, as before themes; node-ts falls back to the neutral look", () => {
    for (const choice of [undefined, "none"]) {
      for (const stack of ["node-ts", "python-fastapi", "dotnet"] as const) {
        const r = render(stack, themed(choice));
        assert.equal(r.theme, "none");
        assert.deepEqual(r.files.map((f) => f.path), [...new Set([...stackTargets(stack), ...expectedOnboarding(), ...STARTER_DOCS])].sort(), `${stack}, ui.theme ${choice}`);
      }
    }
    // node-ts: main.tsx imports theme/theme.css only when it exists (a glob), and styles.css gives
    // every --brand-* variable a neutral default at zero specificity, so a theme always wins.
    const r = render("node-ts", themed("none"));
    const glob = /^import\.meta\.glob\('([^']+)', \{ eager: true \}\);$/m.exec(asText(r, "src/client/main.tsx"));
    assert.ok(glob, "main.tsx imports the theme with a glob");
    assert.equal(join("src/client", glob[1]!).split("\\").join("/"), "theme/theme.css", "the glob points at the manifest's theme.css");
    assert.ok(THEME_FILES.includes("theme/theme.css"));
    const styles = asText(r, "src/client/styles.css");
    const defaults = /:where\(:root\) \{([^}]*)\}/.exec(styles)?.[1] ?? "";
    for (const [name] of themeCssVariables(builtIn("fjord").tokens)) assert.match(defaults, new RegExp(`^ {2}${name}: \\S`, "m"), `neutral default of ${name}`);
    assert.doesNotMatch(styles.replace(/\/\*[\s\S]*?\*\//g, ""), /#[0-9A-Fa-f]{3,8}\b/, "no hard-coded colours in the starter's styles");
  });

  it("custom: the first built-in theme's tokens as placeholders, with a note to replace them", () => {
    const first = BUILT_IN_APP_THEMES[0]!;
    const r = render("python-fastapi", themed("custom"));
    assert.equal(r.theme, "custom");
    const css = asText(r, "theme/theme.css");
    assert.match(css, /^\/\* PLACEHOLDERS: this app brings its own brand \(ui\.theme: custom\)/);
    assert.ok(css.endsWith(themeCss(customThemePlaceholder())), css);
    assert.match(css, new RegExp(`--brand-primary: ${first.tokens.primary};`));
    const json = JSON.parse(asText(r, "theme/theme.json")) as Doc;
    assert.equal(json.id, "custom");
    assert.equal(json.placeholder, true);
    assert.deepEqual(json.tokens, first.tokens);
    assert.match(json.description.en, /^Placeholders/);
    assert.match(asText(r, "theme/README.md"), /"placeholder": true/);
  });

  it("the instance's own themes (branding.appThemes), logo included; a theme the instance doesn't offer is refused", () => {
    const inst = parse(instanceText) as Doc;
    const harbour: AppTheme = { id: "harbour", name: { en: "Harbour", cs: "Přístav" }, logoUrl: "https://www.contoso.com/logo.svg", tokens: { ...builtIn("fjord").tokens, primary: "#123456" } };
    inst.branding = { appThemes: [harbour] };
    const own = stringify(inst);
    const r = renderAppRepo(own, themed("harbour"), { templatesDir: TEMPLATES, date: DATE, template: "dotnet" });
    assert.equal(asText(r, "theme/theme.css"), themeCss(harbour));
    assert.deepEqual(JSON.parse(asText(r, "theme/theme.json")), { id: "harbour", name: harbour.name, logoUrl: harbour.logoUrl, tokens: harbour.tokens });
    assert.throws(
      () => renderAppRepo(own, themed("fjord"), { templatesDir: TEMPLATES, date: DATE }),
      (e: unknown) => e instanceof CheckFailed && /ui\.theme: theme "fjord" is not offered in this instance \(harbour, none, custom\)/.test(e.problems.join("\n")),
    );
    // The library alone (as the provisioning ADO stage calls it) refuses it too.
    const app = parse(themed("fjord")) as AppData;
    assert.throws(
      () => renderRepoFiles(app, parseInstanceText(own), { templatesDir: TEMPLATES, date: DATE }),
      (e: unknown) => e instanceof CheckFailed && /^app hotel-inventory: ui\.theme: theme "fjord" is not offered/.test(e.problems.join("\n")),
    );
    assert.throws(() => renderRepoFiles(app, parseInstanceText(own), { templatesDir: TEMPLATES, date: DATE, theme: "meadow" }), UsageError, "an override");
  });

  it("byo: no theme files (not part of the onboarding set), whatever ui.theme says", () => {
    const r = render("byo", themed("meadow"));
    assert.equal(r.theme, "none");
    assert.deepEqual(r.files.map((f) => f.path), expectedOnboarding().sort());
  });

  it("create: theme files the repository already has are kept", () => {
    const mine = Buffer.from(":root { --brand-primary: #000000; }\n");
    const r = render("node-ts", themed("meadow"), new Map([["theme/theme.css", mine]]));
    assert.equal(r.files.find((f) => f.path === "theme/theme.css"), undefined);
    assert.equal(r.files.find((f) => f.path === "theme/theme.json")?.change, "add");
    assert.ok(repoRenderScope("node-ts", { templatesDir: TEMPLATES }).files.includes("theme/theme.css"), "read from --out");
    assert.ok(!repoRenderScope("byo", { templatesDir: TEMPLATES }).files.some((p) => p.startsWith("theme/")));
  });

  it("CLI: --theme overrides ui.theme, --output names it, values the instance doesn't offer exit 2", () => {
    const cases = [
      ["meadow", / with the meadow theme rendered into /, true],
      ["custom", / with placeholder theme files \(custom\) rendered into /, true],
      ["none", /^OK {2}node-ts starter of hotel-inventory rendered into /m, false],
    ] as const;
    for (const [theme, line, has] of cases) {
      const out = join(tmp("pc-repo-theme-"), theme);
      const json = join(tmp(), "files.json");
      const c = cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--template", "node-ts", "--date", DATE, "--theme", theme, "--output", json]);
      assert.equal(c.code, 0, c.stderr);
      assert.match(c.stdout, line);
      assert.equal(existsSync(join(out, "theme", "theme.css")), has, theme);
      assert.equal((JSON.parse(readFileSync(json, "utf8")) as Doc).theme, theme);
      if (theme === "meadow") assert.equal(readFileSync(join(out, "theme", "theme.css"), "utf8"), themeCss(builtIn("meadow")));
    }
    const base = ["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", tmp(), "--date", DATE, "--theme"];
    const unknown = cli([...base, "harbour"]);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /theme "harbour" is not offered in this instance \(fjord, meadow, terracotta, none, custom\)/);
    assert.equal(cli([...base, "Fjord!"]).code, 2);
  });

  it("the manifest format: theme entries need when: theme; generate only names a known generator, without a source", () => {
    const cases: [Doc, RegExp][] = [
      [{ generate: "themeCss", target: "theme/x.css", mode: "create" }, /needs "when": "theme"/],
      [{ generate: "logo", target: "theme/x", mode: "create", when: "theme" }, /unknown "generate" "logo"/],
      [{ generate: "themeCss", source: "app/x", target: "theme/x.css", mode: "create", when: "theme" }, /a generated file has no "source"/],
      [{ generate: "themeJson", target: "theme/x.json", mode: "mergeLines", when: "theme" }, /needs mode create or managed/],
      [{ source: "app/theme/README.md.tmpl", target: "theme/x.md", mode: "create", when: "dark" }, /unknown "when" "dark"/],
      [{ type: "mirror", from: ".agents/skills", target: ".x/skills", when: "theme" }, /a mirror can't have "when"/],
    ];
    for (const [entry, re] of cases) {
      const dir = tmp("pc-manifest-");
      const m = JSON.parse(readFileSync(MANIFEST, "utf8")) as Doc;
      m.files.push(entry);
      write(dir, "app/manifest.json", JSON.stringify(m));
      assert.throws(() => loadManifest(dir), (e: unknown) => e instanceof CheckFailed && re.test(e.problems.join("\n")), JSON.stringify(entry));
    }
    assert.ok(loadManifest(TEMPLATES).files.some((e) => e.generate === "themeCss"));
  });
});

describe("platform repo render: errors", () => {
  it("needs a valid app definition (same checks as validate app --instance)", () => {
    assert.throws(() => render("node-ts", appText((d) => (d.title = "Hotel | Inventory"))), (e: unknown) => {
      assert.ok(e instanceof CheckFailed);
      assert.match(e.problems.join("\n"), /title: title must not contain line breaks, "\{\{", backticks, \|, < or >/);
      return true;
    });
    const qa = appFile(appText((d) => (d.environments.qa = { networkMode: "externalOnly" })));
    const r = cli(["repo", "render", "--instance", INSTANCE, "--app", qa, "--out", tmp()]);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^platform repo render: .*app\.yaml: line \d+: environments\.qa: "qa" is not an environment of this instance/m);
    const broken = instanceFile((d) => ((d as Doc).schemaVersion = "nope"));
    assert.equal(cli(["repo", "render", "--instance", broken, "--app", APP, "--out", tmp()]).code, 1);
  });

  it("usage errors exit 2", () => {
    const out = tmp();
    assert.equal(cli(["repo", "render", "--instance", INSTANCE, "--app", APP]).code, 2, "no --out");
    assert.equal(cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--date", "2026-02-30"]).code, 2);
    assert.equal(cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--template", "java"]).code, 2);
    assert.equal(cli(["repo", "render", "--instance", INSTANCE, "--app", APP, "--out", out, "--templates", tmp()]).code, 2);
    assert.equal(cli(["repo", "clone"]).code, 2);
    assert.equal(cli(["repo"]).code, 2);
    assert.match(cli(["repo", "help"]).stdout, /platform repo render/);
  });

  it("rejects a template that uses an unlisted placeholder", () => {
    const copy = join(tmp("pc-templates-"), "templates");
    cpSync(TEMPLATES, copy, { recursive: true });
    writeFileSync(join(copy, "app", "agent-files", "CLAUDE.md.tmpl"), "@AGENTS.md\n{{NOT_LISTED}}\n");
    assert.throws(
      () => renderAppRepo(instanceText, appText(), { templatesDir: copy, date: DATE }),
      (e: unknown) => e instanceof CheckFailed && /CLAUDE\.md\.tmpl uses \{\{NOT_LISTED\}\}, which manifest\.json does not list/.test(e.problems.join("\n")),
    );
  });
});
