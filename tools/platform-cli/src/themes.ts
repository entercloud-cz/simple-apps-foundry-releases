/**
 * App themes: the brand variants an app starts with (app.yaml `ui.theme`).
 *
 * The portal's new-app wizard offers the instance's themes (instance.yaml `branding.appThemes`,
 * else the core's three built-in themes below) with a preview, plus `none` (the starter's neutral
 * look) and `custom` (the team brings its own brand). Provisioning writes the chosen theme into the
 * repository it seeds (theme/theme.json, theme/theme.css); after that the look is the app team's
 * code, like everything else in the repository.
 *
 * The built-in themes are product defaults, not a company brand: an instance replaces them with
 * its own variants in instance.yaml (hard rule 1). Fonts are system font stacks, so an app never
 * loads fonts from a third party. Colour pairs (primary/onPrimary, text/background,
 * text/surface) meet WCAG AA contrast (4.5:1); the CLI tests check it for the built-in themes.
 */

export interface AppThemeTokens {
  /** Buttons, links, the header bar. */
  primary: string;
  /** Text and icons on `primary`. */
  onPrimary: string;
  /** Page background. */
  background: string;
  /** Cards, tables, dialogs. */
  surface: string;
  text: string;
  mutedText: string;
  border: string;
  /** Highlights, badges, the secondary action. */
  accent: string;
  /** CSS font-family list for body text. */
  fontFamily: string;
  /** CSS font-family list for headings. */
  headingFontFamily: string;
  /** Corner radius of controls and cards, e.g. `8px`. */
  radius: string;
}

export interface AppThemeText {
  en: string;
  cs?: string;
}

export interface AppTheme {
  id: string;
  name: AppThemeText;
  description?: AppThemeText;
  /** An https URL of a logo the app may show in its header. */
  logoUrl?: string;
  tokens: AppThemeTokens;
}

/** The starter's neutral look, without theme tokens. */
export const THEME_NONE = "none";
/** The team's own brand: the repository gets a theme file with placeholders to fill in. */
export const THEME_CUSTOM = "custom";

const SYSTEM_SANS = "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

export const BUILT_IN_APP_THEMES: readonly AppTheme[] = [
  {
    id: "fjord",
    name: { en: "Fjord", cs: "Fjord" },
    description: {
      en: "Calm blue, clean lines: suits internal tools and data-heavy screens.",
      cs: "Klidná modrá a čisté linie: hodí se pro interní nástroje a obrazovky plné dat.",
    },
    tokens: {
      primary: "#1F5FAD",
      onPrimary: "#FFFFFF",
      background: "#F6F8FB",
      surface: "#FFFFFF",
      text: "#14213D",
      mutedText: "#4F5E78",
      border: "#D8DEE9",
      accent: "#0E7C7B",
      fontFamily: SYSTEM_SANS,
      headingFontFamily: SYSTEM_SANS,
      radius: "8px",
    },
  },
  {
    id: "meadow",
    name: { en: "Meadow", cs: "Louka" },
    description: {
      en: "Friendly green with soft, rounded shapes: suits forms and self-service apps.",
      cs: "Přívětivá zelená a měkké zaoblené tvary: hodí se pro formuláře a samoobslužné aplikace.",
    },
    tokens: {
      primary: "#2F7D4F",
      onPrimary: "#FFFFFF",
      background: "#F7F9F4",
      surface: "#FFFFFF",
      text: "#1F2A1F",
      mutedText: "#556255",
      border: "#DCE5D6",
      accent: "#9A6700",
      fontFamily: "ui-rounded, 'SF Pro Rounded', " + SYSTEM_SANS,
      headingFontFamily: "ui-rounded, 'SF Pro Rounded', " + SYSTEM_SANS,
      radius: "14px",
    },
  },
  {
    id: "terracotta",
    name: { en: "Terracotta", cs: "Terakota" },
    description: {
      en: "Warm, editorial look with serif headings: suits content, catalogues and reports.",
      cs: "Teplý, časopisecký vzhled s patkovými nadpisy: hodí se pro obsah, katalogy a přehledy.",
    },
    tokens: {
      primary: "#A6461F",
      onPrimary: "#FFFFFF",
      background: "#FBF7F2",
      surface: "#FFFFFF",
      text: "#2B1D14",
      mutedText: "#66503F",
      border: "#EADFD3",
      accent: "#2C5F7C",
      fontFamily: SYSTEM_SANS,
      headingFontFamily: "Georgia, 'Times New Roman', serif",
      radius: "4px",
    },
  },
];

interface BrandingView {
  branding?: { appThemes?: AppTheme[]; defaultAppTheme?: string };
}

/** The themes the instance offers: instance.yaml branding.appThemes, else the built-in themes. */
export function appThemesOf(instance?: BrandingView): readonly AppTheme[] {
  const own = instance?.branding?.appThemes;
  return own && own.length ? own : BUILT_IN_APP_THEMES;
}

/** Every value `ui.theme` may take in this instance: the offered themes, then none and custom. */
export function appThemeChoices(instance?: BrandingView): string[] {
  return [...appThemesOf(instance).map((t) => t.id), THEME_NONE, THEME_CUSTOM];
}

/** The theme the wizard preselects: branding.defaultAppTheme when offered, else the first theme. */
export function defaultAppThemeOf(instance?: BrandingView): string {
  const wanted = instance?.branding?.defaultAppTheme;
  if (wanted && appThemeChoices(instance).includes(wanted)) return wanted;
  return appThemesOf(instance)[0]?.id ?? THEME_NONE;
}

/** The theme with this id, if the instance offers it (undefined for none, custom or unknown). */
export function appThemeById(instance: BrandingView | undefined, id: string): AppTheme | undefined {
  return appThemesOf(instance).find((t) => t.id === id);
}

const TOKEN_VARS: [keyof AppThemeTokens, string][] = [
  ["primary", "--brand-primary"],
  ["onPrimary", "--brand-on-primary"],
  ["background", "--brand-background"],
  ["surface", "--brand-surface"],
  ["text", "--brand-text"],
  ["mutedText", "--brand-muted-text"],
  ["border", "--brand-border"],
  ["accent", "--brand-accent"],
  ["fontFamily", "--brand-font"],
  ["headingFontFamily", "--brand-heading-font"],
  ["radius", "--brand-radius"],
];

/** The CSS custom property of each token, in a fixed order (theme.css and the portal's preview). */
export function themeCssVariables(tokens: AppThemeTokens): [string, string][] {
  return TOKEN_VARS.map(([key, name]) => [name, tokens[key]]);
}

/** theme/theme.css of a seeded repository: the theme's tokens as CSS custom properties on :root. */
export function themeCss(theme: AppTheme): string {
  const lines = themeCssVariables(theme.tokens).map(([name, value]) => `  ${name}: ${value};`);
  return `/* App theme "${theme.id}" (${theme.name.en}), written by the platform when the repository was created.\n   Change it freely: it is your app's code now. */\n:root {\n  color-scheme: light;\n${lines.join("\n")}\n}\n`;
}

/**
 * What `custom` seeds: the first built-in theme's tokens as placeholders, under the id `custom`,
 * for the team to replace with its own brand.
 */
export function customThemePlaceholder(): AppTheme {
  const base = BUILT_IN_APP_THEMES[0]!;
  return {
    id: THEME_CUSTOM,
    name: { en: "Own brand", cs: "Vlastní značka" },
    description: {
      en: `Placeholders (the built-in ${base.name.en} theme): replace every token with your brand's colours, fonts and corner radius.`,
      cs: `Zástupné hodnoty (vestavěný motiv ${base.name.cs ?? base.name.en}): nahraď každý token barvami, písmy a zaoblením rohů své značky.`,
    },
    tokens: { ...base.tokens },
  };
}

const PLACEHOLDER_NOTE = `/* PLACEHOLDERS: this app brings its own brand (ui.theme: custom). The values below are only a
   starting point (the platform's ${BUILT_IN_APP_THEMES[0]!.id} theme): replace them with your brand's colours,
   fonts and corner radius, keep theme.json the same, then delete this comment and
   "placeholder" in theme.json. See theme/README.md. */\n`;

/** theme/theme.css of a seeded repository; `placeholder` (custom) adds the note to replace the values. */
export function themeSeedCss(theme: AppTheme, placeholder = false): string {
  return (placeholder ? PLACEHOLDER_NOTE : "") + themeCss(theme);
}

/**
 * theme/theme.json of a seeded repository: the theme as data (id, names, description, logo,
 * tokens in the order of theme.css), for code that can't read CSS. `placeholder` (custom) marks
 * the values as placeholders to replace.
 */
export function themeJson(theme: AppTheme, placeholder = false): string {
  const text = (t: AppThemeText): AppThemeText => ({ en: t.en, ...(t.cs !== undefined ? { cs: t.cs } : {}) });
  const doc = {
    id: theme.id,
    ...(placeholder ? { placeholder: true } : {}),
    name: text(theme.name),
    ...(theme.description ? { description: text(theme.description) } : {}),
    ...(theme.logoUrl ? { logoUrl: theme.logoUrl } : {}),
    tokens: Object.fromEntries(TOKEN_VARS.map(([key]) => [key, theme.tokens[key]])),
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

/** Relative luminance of a #RRGGBB colour (WCAG 2.x). */
function luminance(hex: string): number {
  const channel = (i: number): number => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

/** WCAG contrast ratio of two #RRGGBB colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}
