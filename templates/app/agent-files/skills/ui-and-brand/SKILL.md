---
name: ui-and-brand
description: Use when building or changing anything users see - pages, components, styles, colours, fonts, the logo, forms, buttons, tables, navigation, loading, empty and error states, layout, mobile views or accessibility. Also use when the user asks for a different look, their company's brand or a nicer design, and when theme/theme.css or theme/theme.json is created or edited.
---

# UI and brand

The app's look (colours, fonts, corner radius) was chosen when the app was requested in the
portal. The platform wrote it into `theme/` once, when it created the repository. From then on
it is the app's code: you change it here, and changing the theme in the portal later changes
nothing in the repository.

## Where the look comes from

| In the repository | Meaning | What you do |
|---|---|---|
| `theme/theme.css` + `theme/theme.json` | a theme of the company | Use its variables everywhere. Change the values only when the owner asks. |
| the same, with `"placeholder": true` in `theme.json` and a `PLACEHOLDERS` comment in `theme.css` | the team wants its own brand (`custom`); the values are placeholders | Ask the user for the brand: main colour, text and background colours, fonts, corner style, logo. Replace the values in both files, then remove the flag and the comment. Until then, use the variables anyway. |
| no `theme/` folder | the neutral look (`none`), or an app from before themes | Use the variables with the stack's neutral defaults (node-ts: top of `src/client/styles.css`). Add a theme only when the owner asks (see "Changing the look"). |

## The variables

`theme/theme.css` sets them on `:root`; `theme/theme.json` holds the same values as data (`id`,
`name`, `logoUrl`, `tokens`) for code that can't read CSS (PDF or e-mail templates, charts).

| Variable | Use for |
|---|---|
| `--brand-primary` | primary buttons, links, the header bar, the selected item |
| `--brand-on-primary` | text and icons on `--brand-primary` |
| `--brand-background` | the page background |
| `--brand-surface` | cards, tables, dialogs, inputs |
| `--brand-text` | body text |
| `--brand-muted-text` | secondary text: hints, timestamps, table headers |
| `--brand-border` | borders, dividers, input outlines |
| `--brand-accent` | highlights, badges, focus outlines, the secondary action |
| `--brand-font`, `--brand-heading-font` | body text, headings |
| `--brand-radius` | corners of buttons, inputs and cards |

How the stacks use them:

- **node-ts:** `src/client/main.tsx` imports `theme/theme.css` when it exists;
  `src/client/styles.css` gives every variable a neutral default (for repositories without a
  theme) and has building blocks: `.button`, `.button.secondary`, `.card`, `.muted`, focus
  outlines. Put new styles in CSS files under `src/client/`, not in inline `style` attributes.
- **python-fastapi, dotnet:** the starter has no pages. When you add them, copy `theme/` into the
  image in the `Dockerfile`, serve `theme.css` with the app's own static files (FastAPI
  `StaticFiles`, ASP.NET Core `UseStaticFiles`) and link it before the app's own stylesheet.
- **A CSS framework or component library** (Tailwind, MUI, …): map its colours, fonts and radius
  to the variables (e.g. Tailwind `colors: { primary: 'var(--brand-primary)' }`) instead of
  using its defaults.

## Rules

1. **Never hard-code colours, fonts or radii** in components or CSS: `color: var(--brand-text)`,
   not `#1F2A1F`. A colour the theme lacks (error red, success green, warning): define it once as
   a variable in the app's stylesheet (`--color-error: #B42318;`), check its contrast, use the
   variable.
2. **Contrast (WCAG 2.2 AA):** at least 4.5:1 for text, 3:1 for large text (24px, or 19px bold),
   icons, input borders and focus outlines. The theme's pairs meet it (`--brand-on-primary` on
   `--brand-primary`, `--brand-text` on `--brand-background` and `--brand-surface`). Check every
   other pair you introduce, such as muted text on a coloured background, with a contrast checker.
3. **No fonts, icons, scripts or styles from other websites** (Google Fonts, CDNs): the app's
   Content Security Policy blocks them and they would send users' data elsewhere. The theme's
   fonts are installed on users' devices. A company font goes into the repository only if its
   licence allows it; record that in `docs/decisions/`. Icons: an npm package bundled with the
   app (e.g. `lucide-react`), not an icon font from a CDN.
4. **Don't convey meaning by colour alone:** a status badge has a word or an icon too.

## Accessible by default

- Semantic HTML: `<button>` for actions, `<a href>` for navigation, `<main>`, `<nav>`,
  `<header>`, headings in order (one `<h1>` per page), `<table>` with `<th scope="col">` for data.
- Keyboard: everything works with Tab, Enter, Space and Escape. Focus is always visible: never
  `outline: none` without a replacement (node-ts: the `:focus-visible` rule in `styles.css`).
- Forms: a visible `<label>` for every input (a placeholder is not a label); hints and errors
  linked with `aria-describedby`; `aria-invalid="true"` on a field with an error; errors in words
  next to the field and a summary at the top; keep what the user typed after an error. The server
  validates again (`security-baseline`).
- Images: meaningful `alt` text; `alt=""` for decorative ones.
- `<html lang="…">` matches the UI language. Respect `prefers-reduced-motion` for animations.
- Click targets at least 24×24px (44×44px for the main actions on touch screens).

## States every screen needs

| State | Show |
|---|---|
| Loading | "Loading…" or a skeleton; `aria-busy="true"` on the region |
| Empty | what it means and the next step ("No orders yet. Create the first one.") |
| Error | a plain message and a way to retry; details only in the logs (`role="alert"`) |
| Success | short feedback after an action (`role="status"`) |

The starter's `App.tsx` (node-ts) shows loading and error for the signed-in user.

## Layout and spacing

- Mobile first: the app works from 360px wide and at 200% zoom without horizontal scrolling of
  the page (wide tables scroll inside their own container).
- Content width about 960–1200px, centred. One spacing scale (0.25, 0.5, 1, 1.5, 2rem), used
  consistently. One primary button per area; secondary actions use `.button.secondary` or links.

## UI language

The UI language is the owner's decision, recorded in `docs/decisions/` (see `docs-keeping`); if
it isn't, ask. With two languages (e.g. English and Czech), keep the strings in one file per
language, never mix languages on a screen, and format dates, numbers and money with `Intl` and
the user's locale (currency EUR unless the owner says otherwise).

## The logo

- `logoUrl` in `theme/theme.json` (when present) is the company's logo. Don't hot-link it: the
  Content Security Policy allows images only from the app itself (`img-src 'self'`). With the
  owner's OK, save the file in the repository (node-ts: `src/client/public/`) and use a relative
  path, with the company name as `alt` text.
- Show it at its own proportions (about 32–40px high in the header); never stretch, recolour or
  crop it. No `logoUrl`: show the app's name as text and don't invent a logo.

## Changing the look

- Edit `theme/theme.css` and `theme/theme.json` together, with the same values, and add a
  CHANGELOG entry (users notice). A new brand is a decision record.
- To give a repository without `theme/` a theme: create both files in the same format (any
  repository the platform created with a theme is an example). node-ts picks up
  `theme/theme.css` without other changes.

## Checklist (every UI change)

- [ ] Colours, fonts and radii only through `var(--brand-*)` or app variables defined once.
- [ ] New colour pairs checked for contrast; focus visible; works with the keyboard alone.
- [ ] Labels, hints and errors on every form field; loading, empty and error states.
- [ ] Works at 360px wide and at 200% zoom.
- [ ] Nothing loaded from other websites at runtime.
- [ ] UI texts in the agreed language(s); CHANGELOG entry.

## Common mistakes

- Copying a hex value from `theme.css` into a component → it no longer follows the theme.
- `outline: none` on buttons "because it looks nicer" → keyboard users lose their place.
- Grey text on a coloured background without checking the contrast.
- Loading a web font or icon font from a CDN → blocked by the CSP, and a privacy issue.
- Building the brand into a component library's theme file with fixed values → map it to the
  variables instead.
- Expecting a theme chosen later in the portal to reach the app → it doesn't; edit `theme/` with
  the values the owner wants.
