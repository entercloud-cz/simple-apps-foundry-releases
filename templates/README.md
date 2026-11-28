# Templates: the starter for app repos

Sources for every app repo the platform creates: the app developers' agent instructions and
skills, the starter docs, `platform.yaml`, the app's theme, and the starter stacks. Decisions:
[ADR-0013](../docs/adr/0013-agent-agnostic-instructions-skills-and-platform-check.md) (agent
files, skills, `platform check`), [ADR-0015](../docs/adr/0015-application-stacks-and-bring-your-own-container.md)
(stacks, bring your own container), [ADR-0044](../docs/adr/0044-app-themes.md) (app themes).

Everything here is **product content for app developers' agents**, not instructions for agents
working on this core repo. That is why the agent files use neutral names (`AGENTS.md.tmpl`,
`agent-files/skills/`): tools that discover `AGENTS.md`, `.agents/skills/` or `.claude/skills/`
anywhere in a repo must not load them while someone works on core.

## Layout

```
templates/
├── README.md                     # this file
├── app/
│   ├── manifest.json             # how the generator maps sources to the app repo (format below)
│   ├── platform.yaml.tmpl        # → platform.yaml (valid against config/schema/app-manifest.schema.json)
│   ├── agent-files/
│   │   ├── AGENTS.md.tmpl        # → AGENTS.md: the app repo's single source of agent instructions
│   │   ├── CLAUDE.md.tmpl        # → CLAUDE.md (`@AGENTS.md`)
│   │   ├── claude-settings.json.tmpl     # → .claude/settings.json (allow `platform check`, deny reading .env)
│   │   ├── gemini-settings.json.tmpl     # → .gemini/settings.json (context.fileName = AGENTS.md)
│   │   ├── copilot-instructions.md.tmpl  # → .github/copilot-instructions.md (pointer only)
│   │   ├── gitattributes.tmpl    # → .gitattributes (`* text=auto eol=lf`)
│   │   ├── gitignore.tmpl        # → .gitignore   (all stacks)
│   │   ├── dockerignore.tmpl     # → .dockerignore (all stacks)
│   │   ├── editorconfig.tmpl     # → .editorconfig
│   │   ├── platform-cli-version.tmpl     # → .platform/cli-version (pinned `platform` CLI version, see below)
│   │   └── skills/<name>/SKILL.md (+ reference/, helpers/, scripts/)  # → .agents/skills/ and .claude/skills/
│   ├── docs/
│   │   ├── README.md.tmpl, CHANGELOG.md.tmpl
│   │   └── docs/architecture.md.tmpl, docs/decisions/0001-record-decisions.md.tmpl
│   └── theme/README.md.tmpl      # → theme/README.md, next to the generated theme.css and theme.json (apps with a theme)
└── stacks/
    ├── node-ts/                  # DEFAULT: Node 22 + TypeScript, Fastify API + React (Vite) SPA, one container
    ├── python-fastapi/           # Python 3.13 + FastAPI (minimal)
    └── dotnet/                   # .NET 10 minimal API (minimal; offered, not promoted)
```

13 skills (Agent Skills format, frontmatter `name` + `description` only): `app-contract-and-docker`,
`auth-entra`, `secrets-and-config`, `database-postgres`, `database-sql`, `blob-storage`,
`observability`, `deploy-and-rollback`, `security-baseline`, `testing-smoke`, `ui-and-brand`,
`docs-keeping`, `troubleshooting`.

## The app's theme (ADR-0044)

The portal's wizard puts the app's look into the app definition (`ui.theme`): a theme the instance
offers (instance.yaml `branding.appThemes`, else the CLI's built-in `fjord`, `meadow`,
`terracotta`), `none` or `custom`. The starter of a stack gets it once, when the repository is
created; after that `theme/` is the app's code (it is not in `syncAgentFiles`).

| `ui.theme` | Seeded files |
|---|---|
| a theme id | `theme/theme.css` (the tokens as `--brand-*` CSS variables on `:root`, `themeCss()` of the CLI library, the same CSS as the wizard's preview), `theme/theme.json` (id, names, description, logo URL, tokens) and `theme/README.md` |
| `custom` | the same files with the first built-in theme's tokens as placeholders: `"placeholder": true` in `theme.json`, a `PLACEHOLDERS` comment in `theme.css`; the README and the `ui-and-brand` skill tell the team to replace them with its brand |
| `none`, or no `ui` | nothing: the starter as before themes |

How the stacks use it:

- **node-ts:** `src/client/main.tsx` imports `../../theme/theme.css` with an eager
  `import.meta.glob`, so the app also builds without the file; `src/client/styles.css` gives every
  `--brand-*` variable a neutral default under `:where(:root)` (no specificity, so a theme's
  `:root` always wins; the defaults are system colours, light and dark, as before themes) and
  styles the page and a few building blocks (`.button`, `.card`, `.muted`, focus outlines) with
  the variables. Adding `theme/theme.css` to a repository without one is all it takes to adopt a
  theme.
- **python-fastapi, dotnet:** the starters have no pages, so they get only the files; the
  `ui-and-brand` skill says how to serve `theme.css` once the app has pages.
- **byo:** no theme files (they are not in `onboarding`): a bring-your-own app keeps its look.

## How a repo is instantiated

| Case | What is written |
|---|---|
| **New app, starter stack** (portal wizard, `repository.template` `node-ts`, `python-fastapi` or `dotnet`) | 1. all files of `stacks/<stack>/` (mode `create`); 2. every entry of `files` in the manifest (the `"when": "theme"` entries only when the app has a theme). Placeholders come from the app definition, the instance config, the core release and the stack's `values`. Provisioning pushes the result as the one commit that creates `main` of the new, empty repository ([ADR-0039](../docs/adr/0039-app-repos-created-and-seeded-by-provisioning.md)). |
| **Bring your own container** ("I already have an app", `repository.template: byo`) | only the `files` entries whose target is listed in `onboarding` (the agent files and `platform.yaml`), applied to the existing repo, with stack `byo`. `create` never overwrites existing files; `mergeLines` appends missing lines to existing `.gitignore`, `.dockerignore`, `.gitattributes`; an existing `AGENTS.md` without the `app-notes` block moves into that block. Provisioning proposes the result in a pull request from a `platform/` branch and never pushes to the default branch (ADR-0039). The app's agent then adapts the app using the BYO checklist in the `app-contract-and-docker` skill. |
| **Template update** (`platform sync-agent-files`, or the portal after a core upgrade) | only the paths listed in `syncAgentFiles`: `managed` files are rewritten from the new release, `AGENTS.md` keeps its `app-notes` block, `.agents/skills/` gets the new platform skills (app-own skill folders stay), `.claude/skills/` is regenerated as a mirror, `create` files are written only if missing. Stack files and docs are never touched after creation. |

The generator is `platform repo render --instance <instance.yaml> --app <apps/<slug>/app.yaml>
--out <dir>` (and `renderAppRepo` inside the CLI, which provisioning's Azure DevOps stage calls);
template updates are `platform sync-agent-files`. The template set used is the one of the
instance's pinned core release: in the pipelines the CLI runs from the core checkout at that tag
and reads this folder next to it. The output is deterministic (same inputs, `--date` and templates
give the same bytes); `--out` may hold the repo's current files, and the modes apply to them.

## manifest.json (formatVersion 1)

Source paths are relative to `templates/`; target paths are relative to the app repo root.

This file is the **single source of truth** for the app repo layout. The platform CLI reads it
too (`platform sync-agent-files --manifest templates/app/manifest.json`, `platform check
--agent-manifest ...`, or the env var `PLATFORM_AGENT_FILES_MANIFEST`) and derives from it which
mirrors and stub files exist: the `mirror` entries (skills source and mirrors), and the targets in
`syncAgentFiles` (the stub files `CLAUDE.md`, `.gemini/settings.json`, `.claude/settings.json`,
`.gitattributes`, `.github/copilot-instructions.md`, plus any other single file listed there, which
the CLI creates when missing). How a stub is judged (for example "`CLAUDE.md` must start with
`@AGENTS.md`") is the CLI's rule; what is written when it is missing is the template source file.
Without `--manifest` the CLI uses a built-in layout equal to this one (a CLI test compares them),
so an app repo needs no copy of the manifest. Details: [tools/platform-cli](../tools/platform-cli/README.md#agent-files-and-sync-agent-files).

- `placeholders`: every placeholder that may appear in a `.tmpl` file, with where the value comes
  from: `app` (portal request), `stack` (the stack's `values`), `instance` (instance config),
  `core` (release metadata). The generator fails when a `.tmpl` file uses a name not listed here
  or a listed value is missing. Sources in `platform repo render`: `APP_NAME` = `title`,
  `APP_DESCRIPTION` = `description` ("No description yet." when absent), `APP_DATA` = the
  database and file storage of `data` in plain words ("none yet" without either), `APP_ROLES` = the
  app's roles and what each may do, "Reader: …; Editor: …" (`authentication.roles`, else the
  instance's default roles with `defaultAppRoleDescriptions` or the core's descriptions, `src/roles.ts`),
  `CREATED_DATE` =
  `--date` (default today, UTC); `PORTAL_URL` = instance `portal.apiBaseUrl` and `APP_PORTAL_URL`
  = `<apiBaseUrl>/apps/<slug>` ("not configured yet" without it); `PLATFORM_DOCS_URL` = "ask the
  platform team" (the instance has no documentation link yet); `ENVIRONMENT_NAMES` = the
  instance's environments in pipeline order; `TEMPLATE_VERSION` = `coreVersion`;
  `PLATFORM_CLI_VERSION` = the CLI's own version; `MANIFEST_SCHEMA_VERSION` from the bundled
  schema.
- `files`: ordered entries:
  - `{ "source", "target", "mode" }`: one file. `"type": "dir"` copies a directory recursively.
  - `{ "type": "mirror", "from", "target" }`: after all other entries, make `target` a
    byte-identical copy of `from` **in the app repo** (so app-own skills are mirrored too), deleting
    extra files. Real files, never symlinks.
  - `"when": "theme"` on a file entry: written only when the app has a theme (`ui.theme` is a
    theme id or `custom`), never for `none`. Such a target can't be in `syncAgentFiles`.
  - `{ "generate", "target", "mode", "when": "theme" }`: a file without a source, made by the
    CLI from the app's theme: `themeCss` (`theme/theme.css`) or `themeJson` (`theme/theme.json`);
    mode `create` or `managed`.
- `mode`:
  - `create`: write only if the target doesn't exist. The app owns the file afterwards.
  - `managed`: always write (platform-owned). For `type: dir`, files present in the source are
    overwritten and other files in the target are left alone.
  - `mergeLines`: create if missing; otherwise append each non-empty, non-comment line of the
    source that the target lacks (exact line match), under `# Added by the platform template`.
  - `mergeJson` (`.claude/settings.json`): create if missing; otherwise add each string of the
    source's arrays the target's same array lacks, and each key it lacks. Nothing the team added is
    removed or changed; a target that isn't a JSON object stays as it is (ADR-0076).
  - `preserveBlock: "<id>"` (with `managed`): keep the existing text between
    `<!-- <id>:start` (the rest of that line belongs to the marker) and `<!-- <id>:end -->` in
    the target. An existing target without the block is kept whole inside the block.
- `syncAgentFiles`: the agent files: what `platform sync-agent-files` keeps in an existing repo, and
  what `platform agent-files update` renders again from the templates the CLI carries (ADR-0076).
- `onboarding`: targets of `files` that make up the bring-your-own set (`byo`): the agent files
  and `platform.yaml`, not the starter docs. Every `syncAgentFiles` target is in it.

An app definition without `repository.template` (from before ADR-0039) is **unmanaged**: the
platform doesn't create, seed or onboard its repository, and `platform repo render` has nothing to
render for it (exit 1 unless `--template` is given). Only an explicit `byo` means onboarding.
- `stacks.<id>`: `source` (folder under `templates/`, `null` for `byo`), `values` for the
  stack placeholders, `default: true` for the wizard's default.

### Rendering rules

- Only files ending in `.tmpl` are rendered; the suffix is removed. Every other file (all skills,
  stack code) is copied byte for byte, so `{{` in code (JSX, Go templates, f-strings) is safe.
- Placeholders are `{{UPPER_SNAKE}}`, replaced in a single pass, no expressions, no conditionals.
  Stack-specific text comes from stack `values`, not from conditionals.
- Values are inserted verbatim. No value may contain `{{` or line breaks. Values from the app
  request (`APP_NAME`, `APP_DESCRIPTION`) must also not contain backticks, `|`, `<` or `>`
  (they land in Markdown tables, inline code, HTML and YAML comments). `platform validate app`
  rejects such a `title` or `description` (so the portal, which uses the same code, does too);
  the generator rejects violations again. Stack `values` are authored in core and may use Markdown.
- Output uses LF line endings and UTF-8 without BOM.

## Platform-injected environment variables (contract with the release module)

The stacks, `AGENTS.md` and the skills rely on these names. The authoritative table is
[data-services](../docs/architecture/data-services.md#environment-variables-injected-by-the-platform);
the names are **reserved** in `config/schema/app-manifest.schema.json` (a developer cannot set them
in `platform.yaml`). Change them only together with `infra/app/` (release module), the schema and
that table. A variable that does not apply is not set.

| Variable | When | Value |
|---|---|---|
| `PORT` | always | `runtime.port` from `platform.yaml` |
| `AZURE_CLIENT_ID` | always | client id of the app's runtime managed identity |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | always | the app's Application Insights |
| `CONTAINER_APP_NAME` | always (set by Azure Container Apps itself) | used by the apps to detect "running on Azure" |
| `DATABASE_HOST`, `DATABASE_NAME` | app has PostgreSQL **or** Azure SQL (one relational database per app) | server FQDN, database name |
| `DATABASE_USER` | app has PostgreSQL | database role of the runtime identity (not set for Azure SQL: the token identifies the identity) |
| `STORAGE_BLOB_ENDPOINT` | app has a storage account | `https://<account>.blob.core.windows.net/` |
| `FRONT_DOOR_ID` | app is served through Front Door | expected `X-Azure-FDID` of the environment's profile |

Local-only variables used by the stacks: `DEV_FAKE_USER`, `DEV_FAKE_ROLES`, `DATABASE_PASSWORD`
(all refused when `CONTAINER_APP_NAME` is set), `LOG_LEVEL`.

## `example.env`, not `.env.example`

The stacks ship `example.env` (fake values, committed; developers copy it to `.env`, which is
git-ignored). The name is deliberate: `.claude/settings.json` denies `Read(./.env)` and
`Read(./.env.*)` so agents never read real secrets, and `.env.example` would match that deny rule
and be unreadable for the agent. `platform check` (PC030) allows `example.env` and `.env.example`
and rejects `.env`, `.env.*` and every other `*.env` file.

## Pinning the `platform` CLI version

ADR-0013: the CLI is a versioned contract. In the pipeline the instance's pinned version always
runs. For the developer's machine and agent, the app repo carries the version of the core release
it was created from (or last updated to):

- `{{PLATFORM_CLI_VERSION}}` is the exact version of `@simple-apps-foundry/platform-cli` in that core release
  (`version` in `tools/platform-cli/package.json` at the release tag, no range). It equals the core
  version without the `v`, for example `0.2.0` or `0.2.0-rc.1`: each release commit sets it
  ([ADR-0062](../docs/adr/0062-core-releases-changelog-cut-and-checksummed-release-bundle.md) section 4).
  The generator takes it from the CLI's own `package.json`.
- It is written to `AGENTS.md` (the "Commands" section) and to **`.platform/cli-version`**
  (one line, the same version; `managed`, so a template update keeps it current). The portal and
  scripts can read the file without parsing Markdown.
- Install: the tarball of that version from the core release
  (`simple-apps-foundry-platform-cli-<version>.tgz`, a file of the GitHub Release in the public releases
  repository), `npm install --global --ignore-scripts <file>`; then the command is `platform check`.
- Not on npm, deliberately (ADR-0065): the package is `private` and never published, so `AGENTS.md` tells
  agents never to fetch it by name with `npx`. A package of that name on a public registry could be anyone's.
- Not done (deliberately): no schema field in `platform.yaml`, and the CLI does not warn when its
  own version differs from `.platform/cli-version`.

## Updating the templates

Templates are versioned with core releases: every change ships in a core release with a
`CHANGELOG.md` entry. App repos pull the agent files themselves (ADR-0076): `platform check` warns
with PC057 while they are older than the templates its CLI carries (the delivery pipeline's check
runs with the instance's core, so the portal shows it), and `platform agent-files update` renders
them again in the repo, keeping AGENTS.md's app-specific notes. The platform never pushes them. The
stack code and the docs belong to the app after creation and are never updated. The CLI bundles
`templates/app/manifest.json` and `templates/app/agent-files` in `dist/templates` for that.

1. Keep names consistent across `AGENTS.md.tmpl`, skills and stack code (env vars, header names,
   role guards, commands). Grep before changing a name.
2. `AGENTS.md.tmpl` must stay well under 32 KiB after rendering (Codex limit); put detail in skills.
3. Skill frontmatter: `name` equals the folder name, `description` ≤ 1024 characters and says
   *when* to load the skill. No tool-specific keys.
4. `skills/auth-entra/helpers/*` are copies of the stacks' principal parsers. Keep them identical:
   `diff stacks/node-ts/src/server/auth/principal.ts app/agent-files/skills/auth-entra/helpers/principal.ts`
   (likewise `principal.py`, `ClientPrincipal.cs`).
5. Dependency or base image updates: pick exact versions, update the Dockerfiles and the
   `app-contract-and-docker/reference/dockerfiles.md` examples together. For node-ts regenerate the
   lockfile: render the stack into a scratch folder, `npm install`, then copy `package-lock.json`
   back as `package-lock.json.tmpl` with the root `"name"` (2 places) replaced by `{{APP_SLUG}}`.
6. Verify each stack in a scratch copy (never inside this repo, to keep build output out of git):
   - node-ts: `npm ci && npm run build && npm test && npm run lint`
   - python-fastapi: `pip install -r requirements-dev.txt && pytest && ruff check . && ruff format --check .`
   - dotnet: `dotnet build App.slnx && dotnet test && dotnet format App.slnx --verify-no-changes`
   - node-ts after a change to its styles: once rendered with a theme (`--theme meadow`) and once
     without (`--theme none`); both must build.
   - generated `platform.yaml` validates against `config/schema/app-manifest.schema.json`.
   - `platform check --skip-runtime` on a generated repo: `node tools/platform-cli/dist/src/cli.js
     repo render --instance config/examples/instance.example.yaml --app
     config/examples/apps/hotel-inventory/app.yaml --template <stack> --out <scratch dir>`, then
     `node tools/platform-cli/dist/src/cli.js check <dir> --skip-runtime`; it must pass with no
     errors (the CLI tests do this for every stack). (planned) the same including the container
     smoke test, for each stack.
