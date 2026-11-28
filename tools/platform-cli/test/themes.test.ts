import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { REPO_ROOT } from "./helpers.js";
import { instanceFile } from "./pipeline-helpers.js";
import {
  BUILT_IN_APP_THEMES,
  appThemeById,
  appThemeChoices,
  appThemesOf,
  contrastRatio,
  defaultAppThemeOf,
  themeCss,
  themeCssVariables,
  validateAppDefinition,
} from "../src/index.js";
import type { AppTheme } from "../src/index.js";
import { validateFile } from "../src/validate.js";
import type { ValidateResult } from "../src/validate.js";

const INSTANCE = join(REPO_ROOT, "config", "examples", "instance.example.yaml");
const EXAMPLE = join(REPO_ROOT, "config", "examples", "apps", "hotel-inventory", "app.yaml");
const instanceText = readFileSync(INSTANCE, "utf8");

type Doc = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const own: AppTheme = {
  id: "harbour",
  name: { en: "Harbour", cs: "Přístav" },
  tokens: { ...BUILT_IN_APP_THEMES[0]!.tokens, primary: "#123456" },
};

function app(theme: string | undefined): string {
  const d = parse(readFileSync(EXAMPLE, "utf8")) as Doc;
  if (theme === undefined) delete d.ui;
  else d.ui = { theme };
  return stringify(d);
}

function instanceWith(branding: Doc): string {
  const d = parse(instanceText) as Doc;
  d.branding = { ...(d.branding ?? {}), ...branding };
  return stringify(d);
}

const rules = (r: ReturnType<typeof validateAppDefinition>): string[] => r.problems.map((p) => `${p.path}: ${p.message}`);

describe("app themes (themes.ts)", () => {
  it("three built-in themes with unique ids, names in English and Czech", () => {
    assert.deepEqual(
      BUILT_IN_APP_THEMES.map((t) => t.id),
      ["fjord", "meadow", "terracotta"],
    );
    for (const t of BUILT_IN_APP_THEMES) {
      assert.ok(t.name.en && t.name.cs, t.id);
      assert.ok(t.description?.en && t.description.cs, t.id);
    }
  });

  it("the built-in themes meet WCAG AA contrast for their text pairs", () => {
    for (const { id, tokens } of BUILT_IN_APP_THEMES) {
      for (const [fg, bg] of [
        [tokens.onPrimary, tokens.primary],
        [tokens.text, tokens.background],
        [tokens.text, tokens.surface],
        [tokens.mutedText, tokens.surface],
        [tokens.mutedText, tokens.background],
        [tokens.accent, tokens.surface],
        [tokens.accent, tokens.background],
        [tokens.primary, tokens.surface],
      ] as const) {
        assert.ok(contrastRatio(fg, bg) >= 4.5, `${id}: ${fg} on ${bg} is ${contrastRatio(fg, bg).toFixed(2)}:1`);
      }
    }
    assert.equal(contrastRatio("#000000", "#FFFFFF").toFixed(1), "21.0");
  });

  it("the built-in themes are valid instance branding.appThemes (schema)", () => {
    const file = instanceFile((doc) => {
      (doc as Doc).branding = { appThemes: BUILT_IN_APP_THEMES, defaultAppTheme: "meadow" };
    });
    const r = validateFile("instance", file);
    assert.deepEqual(r.problems, []);
    assert.deepEqual(r.checks ?? [], []);
  });

  it("offers the built-in themes unless the instance lists its own; none and custom always", () => {
    assert.deepEqual(appThemeChoices(), ["fjord", "meadow", "terracotta", "none", "custom"]);
    assert.deepEqual(appThemeChoices({ branding: { appThemes: [own] } }), ["harbour", "none", "custom"]);
    assert.equal(appThemesOf({ branding: { appThemes: [] } }), BUILT_IN_APP_THEMES);
    assert.equal(defaultAppThemeOf(), "fjord");
    assert.equal(defaultAppThemeOf({ branding: { defaultAppTheme: "none" } }), "none");
    assert.equal(defaultAppThemeOf({ branding: { appThemes: [own], defaultAppTheme: "fjord" } }), "harbour", "a default that isn't offered falls back to the first theme");
    assert.equal(appThemeById(undefined, "meadow")?.name.cs, "Louka");
    assert.equal(appThemeById(undefined, "custom"), undefined);
  });

  it("theme.css: every token as a --brand-* custom property on :root", () => {
    const css = themeCss(BUILT_IN_APP_THEMES[0]!);
    assert.match(css, /^\/\* App theme "fjord" \(Fjord\)/);
    assert.match(css, /:root \{\n {2}color-scheme: light;\n/);
    for (const [name, value] of themeCssVariables(BUILT_IN_APP_THEMES[0]!.tokens)) assert.ok(css.includes(`  ${name}: ${value};\n`), name);
    assert.equal(themeCssVariables(BUILT_IN_APP_THEMES[0]!.tokens).length, 11);
  });
});

describe("validate: ui.theme in app.yaml and branding in instance.yaml", () => {
  it("accepts an offered theme, none, custom, and no ui at all", () => {
    for (const theme of ["fjord", "terracotta", "none", "custom", undefined]) {
      const r = validateAppDefinition(instanceText, app(theme));
      assert.deepEqual(rules(r), [], String(theme));
    }
  });

  it("refuses a theme the instance doesn't offer, and a malformed one by the schema", () => {
    const r = validateAppDefinition(instanceText, app("harbour"));
    assert.deepEqual(rules(r), ['ui.theme: theme "harbour" is not offered in this instance (fjord, meadow, terracotta, none, custom).']);
    const withOwn = validateAppDefinition(instanceWith({ appThemes: [own] }), app("harbour"));
    assert.deepEqual(rules(withOwn), []);
    const builtInGone = validateAppDefinition(instanceWith({ appThemes: [own] }), app("fjord"));
    assert.deepEqual(rules(builtInGone), ['ui.theme: theme "fjord" is not offered in this instance (harbour, none, custom).']);
    const bad = validateAppDefinition(instanceText, app("Bad Theme"));
    assert.equal(bad.ok, false);
    assert.equal(bad.problems[0]?.kind, "schema");
    assert.equal(bad.problems[0]?.path, "ui.theme");
  });

  it("instance: theme ids are unique and the default is one of the offered choices", () => {
    const result = (branding: Doc): ValidateResult =>
      validateFile(
        "instance",
        instanceFile((doc) => {
          (doc as Doc).branding = branding;
        }),
      );
    const dup = result({ appThemes: [own, own] });
    assert.deepEqual(
      (dup.checks ?? []).map((c) => `${c.path}: ${c.message}`),
      ['branding.appThemes[1].id: theme id "harbour" is already used by branding.appThemes[0]; ids are unique.'],
    );
    const badDefault = result({ appThemes: [own], defaultAppTheme: "fjord" });
    assert.deepEqual(
      (badDefault.checks ?? []).map((c) => `${c.path}: ${c.message}`),
      ['branding.defaultAppTheme: "fjord" is not one of the offered themes (harbour, none, custom).'],
    );
    assert.equal(result({ defaultAppTheme: "terracotta" }).ok, true);
    const reserved = result({ appThemes: [{ ...own, id: "none" }] });
    assert.equal(reserved.ok, false, "none and custom are not theme ids");
    const webFont = result({ appThemes: [{ ...own, tokens: { ...own.tokens, fontFamily: "url(https://fonts.example/x.woff)" } }] });
    assert.equal(webFont.ok, false, "a font stack can't load a web font");
  });
});
