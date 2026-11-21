# platform CLI

`platform` runs the same checks on a developer's machine (or inside the developer's AI agent) and
in the delivery pipeline. Decisions: [ADR-0013](../../docs/adr/0013-agent-agnostic-instructions-skills-and-platform-check.md)
(checks, `sync-agent-files`), [ADR-0006](../../docs/adr/0006-pipelines-owned-by-the-platform.md) and
[ADR-0021](../../docs/adr/0021-delivery-permissions-app-deployer-and-pipeline-protection.md) (checks
cannot be skipped in the pipeline), [ADR-0024](../../docs/adr/0024-pinned-and-verified-pipeline-tooling.md)
(pinned tooling), [delivery flow](../../docs/architecture/delivery-flow.md).

Status: v0.1 (F0). The manifest schema is still a draft (`1.0-draft`).

- TypeScript, Node 22, ESM. Runtime dependencies: `ajv`, `ajv-formats` (JSON Schema 2020-12) and
  `yaml`. Everything else is the Node standard library. All versions are pinned exactly.
- The JSON Schemas are copied from `config/schema/` into `dist/schemas/` at build time. The CLI
  never reads files outside its own package, except `platform repo render`, which reads the app
  templates (`templates/`) of the core checkout it runs from (or `--templates`).
- It is also a library: `import { validateAppDefinition, validateInstanceDefinition, renderDeliveryYaml }
  from "@simple-apps-foundry/platform-cli"` ([Library](#library-for-the-portal)).

## Install and use

```bash
# build from a core checkout (needs the whole repo: the schemas come from config/schema)
cd tools/platform-cli
npm ci && npm run build

node dist/src/cli.js check ../my-app          # or: npx --no-install platform check ../my-app
```

| Where | How |
|---|---|
| Local, from the core repo | `npm ci && npm run build` in `tools/platform-cli`, then `node dist/src/cli.js ...` |
| Local, as a command named `platform` | from a core release: the release bundle's `simple-apps-foundry-platform-cli-<version>.tgz` (with `npm-shrinkwrap.json`, the locked dependencies), after `sha256sum --check --strict SHA256SUMS`: `npm install --global --ignore-scripts ./simple-apps-foundry-platform-cli-<version>.tgz` ([release runbook](../../docs/runbooks/release-core.md), ADR-0062). No npm registry has the package yet (`private: true`; ADR-0062 section 7) |
| Container | `docker build -f tools/platform-cli/Dockerfile -t platform-cli .` (context = repo root), then `docker run --rm -v "$PWD:/work:ro" platform-cli check . --skip-runtime` |
| Pipeline | the platform's pipeline template runs a **pinned** version with `--strict` (see below) |

Exit codes: `0` ok, `1` findings with severity error, `2` usage or internal error. Warnings never
change the exit code.

### Commands

```text
platform check [dir] [--format text|sarif|json] [--output file] [--skip-runtime] [--strict]
               [--only groups] [--base ref] [--image ref] [--allowlist file]
               [--agent-manifest file] [--gitleaks auto|off|require]
               [--max-file-mb n] [--smoke-timeout sec] [--no-ai-prompts]
platform validate manifest <platform.yaml>    # app runtime settings: schema validation with line numbers
platform validate instance <instance.yaml>
platform validate app <app.yaml> [--instance <instance.yaml>] [--base <git-ref>]   # app definition, see below
platform validate archive <platform-config dir> [--base <git-ref>]   # the archive of deleted apps (apps-deleted/), see below
platform generate [--config-dir <dir>] [--check]               # apps/<slug>/delivery.yml, pipelines/provisioning.yml, pipelines/validation.yml, pipelines/platform-<env>.yml and the AI guide of a platform-config repo
platform repo render --instance <f> --app <f> --out <dir> ...  # the starter of an app repository, see below
platform provisioning inputs --step lz|entra|release|frontdoor|portal-endpoint ...   # provisioning parameter JSON, see below
platform provisioning validate-run|apps|units|plan-names|plan-facts|plan-units|state|compare ...   # provisioning pipeline helpers, see below
platform provisioning registry-purge --manifests <f> --output <f> ...   # which old images of an app's build registry to delete (ADR-0059), see below
platform provisioning failure-code --log <f> --kind <kind>    # the failure code (PE...) of a failed deployment from its error log (ADR-0064), see below
platform provisioning failures --input <failures.json>         # the run summary's section Failures (ADR-0064)
platform upgrades check [--core-dir <dir>]                     # core CI: infra/app/upgrades.yaml and its notes for unreleased units (ADR-0049), see below
platform provisioning fd-ranges --service-tags <f> --output <f>   # Front Door backend IPv4 ranges for the ingress lock-down, see below
platform provisioning fd-cleanup --before <f> [--after <f>] ...   # what provisioning deletes after removing or changing a custom domain, see below
platform provisioning rotation-due --expires <epoch|none> ...  # whether an Easy Auth secret is due for rotation, see below
platform provisioning easyauth-secret ...                      # Easy Auth secret (new or rotated) through the kvset job (calls Azure), see below
platform provisioning entra-removals --inputs <f> [--record <f>] ...   # role assignments and app roles app.yaml no longer lists, see below
platform provisioning entra-reconcile --removals <f> ...       # delete those assignments from the app's own service principal (calls Microsoft Graph), see below
platform provisioning easyauth-delete --job <id> --vault <v> --secret-name easyauth-<slug> --output <f>   # ADR-0061: the kvset job deletes a decommissioned app's Easy Auth secret (calls Azure), see below
platform provisioning entra-delete --unique-name <n> --output <f>   # ADR-0056: delete a decommissioned app's registration by its uniqueName ({prefix}-{slug}-{env}[--i{incarnation}], ADR-0061; never purged from the recycle bin; calls Microsoft Graph)
platform ado remove plan|apply --instance <f> --app <f> --org-url <u> --lz-outputs <env>=<f>... [--landing-zone-gone <env>]...   # ADR-0056: delete a decommissioned app's ADO objects, each only when it proves to be the app's; a service connection only where its group is gone; the app's repository renamed <name>-deleted-<requestedOn>[-i<incarnation>], -2 … -9 after it while Azure DevOps has the name already, a starter deleted only with decommission.repository delete (ADR-0061)
platform provisioning entra-effect --base <f|none> --head <f|none>   # what a change of app.yaml does in Entra, for the reviewers (ADR-0051), see below
platform provisioning dbinit ...                               # an app's database role through the dbinit job (calls Azure), see below
platform environment inputs|portal-inputs|validate-run|roles-check|compare|cae-network ...   # platform pipeline helpers (ADR-0043), see below
platform instance inputs|sync|facts ...                         # onboarding: the inputs of the templates a person runs, instance.yaml from the state (ADR-0066), see below
platform instance plan|status ...                                # onboarding: every step up front, and where an instance stands (ADR-0072), see below
platform ado plan|apply --phase resources|pipelines ...       # Azure DevOps objects of an app, see below
platform ado bootstrap plan|apply --phase projects|core|config|connections|pipeline|grants|policies ...   # the platform's own Azure DevOps objects
platform network request --env <name> [--config-dir <dir>] [--mode externalHybrid] [--lang en|cs] [--output <file>]   # the network team's text for connecting an environment to the hub, see below
platform sync-agent-files [dir] [--check] [--manifest file]
platform rules                                # list all check IDs
platform rules --explain <id|all> [--lang en|cs] [--format text|markdown]   # a check in plain words with a prompt for your AI agent, see "Checks"
platform pipeline <command> ...               # delivery pipeline helpers, see "Pipeline commands"
```

- **Text output** (default) is grouped by check area. Each finding has the location, the
  message, a one-line `Fix:` hint written for non-developers, and an `AI prompt:` line that can
  be pasted into an AI agent (hide with `--no-ai-prompts`).
- **JSON** (`--format json`): `{ summary, checks[], findings[] }`, every finding with `ruleId`,
  `severity`, `message`, `file`, `line`, `hint`, `aiPrompt`.
- **SARIF 2.1.0** (`--format sarif`): one run, all rule IDs as `tool.driver.rules`, one result per
  finding with `physicalLocation`, `partialFingerprints` (stable across runs) and the hint and
  AI prompt in `properties`. Findings without a file point at `platform.yaml` (or `Dockerfile`
  for runtime findings), because most SARIF viewers need a location.
- `--output <file>` writes the chosen format to the file and still prints the text summary.

### CI usage

```bash
platform check . --strict --format sarif --output $(Build.ArtifactStagingDirectory)/CodeAnalysisLogs/platform-check.sarif
```

- `--strict` makes **skipped checks fail**: no docker means PC060, a required-but-missing
  gitleaks means PC021. `--strict` together with `--skip-runtime` is a usage error (exit 2), so the
  pipeline cannot be configured to skip the smoke test. The docs freshness check is exempt
  (it is warning-only and needs git history that shallow clones do not have).
- `--image <ref>` smoke-tests the image the pipeline already built instead of building a second one.
- The pipeline template, not the app repo, sets `--allowlist`, `--agent-manifest` and the CLI
  version. Delivery templates are described in [`pipelines/`](../../pipelines/README.md).
- **Trivy is not part of the CLI.** The image scan runs in the pipeline from a pinned,
  checksum-verified binary ([ADR-0024](../../docs/adr/0024-pinned-and-verified-pipeline-tooling.md)).
  The CLI only judges Trivy's JSON (`platform pipeline scan-gate`).
- **No logging commands from untrusted text.** Everything the CLI prints, and the report files it
  writes, passes through `src/neutralize.ts`: `##vso[` and `##[` (any case, anywhere in a line)
  get a zero-width space between the two `#`, so docker build output, container logs, file names
  or YAML keys from an app repo cannot set variables or fake log groups in a pipeline job. The only
  logging command the CLI emits itself is the output variable of `pipeline deploy-branch` /
  `pipeline promote-branch --set-output`.

### `platform validate instance` (instance.yaml)

1. **Schema** (`config/schema/instance.schema.json`), always.
2. **Checks the schema cannot express** (on a schema-valid file, same output style as the app
   checks: path, message and line; exit 1; no check IDs, those are `platform check` rules). The
   portal's Settings area runs the same code on every change
   ([ADR-0027](../../docs/adr/0027-instance-settings-in-the-portal-via-pull-requests.md)), so a
   settings pull request and `\platform\validation` never disagree. All of them report every
   problem, not only the first.

   Environments (`validate-instance.ts`):
   - `environments[].name` is unique;
   - `promoteFrom` names an environment of the instance, not the environment itself, and following
     it never loops (each loop is reported once, e.g. `nonprod -> prod -> nonprod`: a promotion
     chain ends at a build environment);
   - every other reference to an environment names one: `portal.hostEnvironment`,
     `network.internalSystems[].allowedEnvironments` and `firewallRules[].environment`,
     `dns.zones[].allowedEnvironments` (each at most once), and the keys of
     `identities.provisioning`; `network.internalSystems[].id` is unique;
   - `identities.provisioning.<env>.resourceId` is in the subscription of that environment (one
     Azure provisioning identity per environment, [ADR-0031](../../docs/adr/0031-platform-identities-and-instance-bootstrap.md));
   - `portal.network.routeTableId` needs a `hub` on the portal's host environment.

   Language and budgets: `locale.defaultLanguage` (default `en`) is one of `locale.languages`
   ([ADR-0018](../../docs/adr/0018-localization-defaults-english-and-eur.md)); `budgets.notifyAtPercent`
   and `forecastNotifyAtPercent` together make at most 5 notifications, with their defaults
   ([ADR-0017](../../docs/adr/0017-cost-visibility-and-budgets.md)).

   Network ranges (`validate-instance-network.ts`, `cidr.ts`;
   [network-modes → Sizing](../../docs/architecture/network-modes.md#sizing)). The ranges of the
   External-only `vnet` variant, the `externalHybrid` and `internalOnly` spokes and the portal's
   VNet form one address plan; managed-network CAEs have none:
   - every range is valid IPv4 (octets up to 255, prefix up to 32, no host bits set), also the
     `cidr` of internal system endpoints;
   - none overlaps a range Container Apps reserves (`169.254.0.0/16`, `172.30.0.0/16`,
     `172.31.0.0/16`, `192.0.2.0/24`, `100.100.0.0/17`, `100.100.128.0/19`, `100.100.160.0/19`,
     `100.100.192.0/19`);
   - subnets of a VNet the platform creates lie inside its address space, and its CAE and
     private-endpoint subnets don't overlap;
   - no two VNets overlap, peered or not (an existing VNet is known by its subnets);
   - the CAE subnet of an environment of kind `prod` is a `/26` or larger (the schema asks for a
     `/27` at least everywhere).

   The library exports `caeSubnetCapacity(prefixLength)` (a `/27` holds 90 replicas, `/26` 250,
   `/25` 570, `/24` 1210) and `caeSubnetIpsNeeded(sumMaxReplicas)`. Not validated yet: the sum of
   the apps' `maxReplicas` per CAE against that capacity (the replicas live in the app repos'
   `platform.yaml` and in Azure, not in platform-config). `TODO(verify)`: the capacity model
   (Verify in sandbox: NET-1 to NET-3) and that Azure refuses an address prefix with host bits
   set and the reserved ranges inside an address space (Verify in sandbox: NET-5).

   Front Door profiles ([ADR-0010](../../docs/adr/0010-custom-domains-certificates-and-front-door.md)):
   - `frontDoor.managed.profiles[].environment` names an environment of the instance, and each
     environment has at most one profile (the platform deploys one profile `afd-{prefix}-{env}`
     per environment);
   - `frontDoor.external.profiles[]`: the names are unique (without case), and every
     `allowedEnvironments` entry names an environment of the instance, at most once per profile.

   The basic mode of the new-app wizard (`newApps.basicMode`,
   [ADR-0047](../../docs/adr/0047-basic-mode-of-the-new-app-wizard.md)), when enabled: every build
   environment offers its network mode (`externalHybrid` with an active egress baseline), its
   database engine is enabled under `data` and defines its size, and `data.storage` is enabled
   when it asks for storage. The library's `basicModeOf(instance)` returns it with the defaults.

   Currency conversion (`costs.fx`, [ADR-0017](../../docs/adr/0017-cost-visibility-and-budgets.md)
   amended 2026-11-11, [ADR-0018](../../docs/adr/0018-localization-defaults-english-and-eur.md)):
   `fixedRates` leaves out `locale.currency` or lists it as 1, `asOf` is a day of the calendar,
   and every environment whose `billingCurrency` differs from `locale.currency` has a fixed rate
   (`source: fixed` with a rate for that currency; `none` and `ecb`, not built yet, reject it).

   Costs off (`costs.enabled: false`, [ADR-0068](../../docs/adr/0068-instances-without-cost-management.md),
   for subscriptions without Cost Management): `budgets.mode` is `off`, because budgets live in
   Cost Management.
3. **Warnings** (never fail the run, printed under `Warnings:` with their check ID): the platform's
   logs kept for less time than the unused-app rule (`log-retention-lifecycle`), and
   `decommission.allowImmediateWithProduction: true` (`decommission-immediate-with-production`,
   ADR-0056 amendment 2026-11-21): apps with production may be deleted immediately, which is for
   developing the platform, not for a production deployment.

`--format json` adds `checks[]` (`path`, `message`, `line`) next to `problems[]`. The same command
runs in `\platform\validation` and in the provisioning pipeline's validate stage.

### `platform validate app` (app definition)

`apps/{slug}/app.yaml` in platform-config says what an app is allowed to have and who owns it
(`config/schema/app.schema.json`, example `config/examples/apps/hotel-inventory/app.yaml`). Not to
be confused with `platform.yaml`, the app's runtime settings in its own repo
(`app-manifest.schema.json`). `--format json` prints the full result.

1. **Schema** (always): unknown keys fail everywhere; `customDomains` and `internalSystems` under
   an environment are reserved for F3 and rejected. `frontDoor: { hostName }` under an environment
   asks for the app's own custom domain through that environment's managed Front Door (ADR-0010,
   amended 2026-11-01): a lower-case host with at least three labels.
2. **App-internal checks** (always, on a schema-valid file): `slug` equals the directory name
   (`apps/<slug>/app.yaml`) and has no reserved word (as PC003); owner and deputy differ (object ID
   and email); no developer twice; role values unique; every assignment names a role of
   `authentication.roles`; no assignment twice; `databaseSize` needs `data.database`; `title`
   and `description` contain no line break, `{{`, backtick, `|`, `<`, `>` or Unicode format
   character (bidi controls, zero-width spaces; they are written into the app repo by
   `platform repo render` and shown in pull requests). `repository.template` (`node-ts`,
   `python-fastapi`, `dotnet`, `byo`; absent = unmanaged: the platform doesn't create, seed or
   onboard the repository) is checked by the schema. No two environments of the app use the same
   custom host.
3. **Instance checks** (`--instance`): every environment exists in the instance; its
   `networkMode` is enabled there; `externalHybrid` needs `egressBaseline.status: active`; a
   promotion environment needs its `promoteFrom` environment in the app too; `anonymous` only with
   `authentication.enforcement: ownerChoice`; without app roles, assignments must name the
   instance's `defaultAppRoles`; the database engine is enabled and its size (and every
   `databaseSize`) exists in the instance's size map; storage and vaulted backup are offered;
   `budgets.mode` off allows no budget, `required` allows no `budget: null` (absent = the instance
   default); the repository provider matches `scm.provider` and the project is `appsProject` or
   one of `allowedProjects`; a custom host (`frontDoor.hostName`) needs `frontDoor.mode: managed`
   with a profile for that environment, lies below a zone of `dns.zones` whose
   `allowedEnvironments` name the environment (the longest matching zone; never the zone apex), its
   first label is not in `dns.reservedSubdomains`, it is not the portal's own host (the host of
   `portal.apiBaseUrl`: an app's DNS records would replace the portal's, ADR-0052), and the app is
   `anonymous` (sign-in on a custom host comes later). An invalid `--instance` file is exit 2.
   When the file is `apps/<slug>/app.yaml` of the platform-config whose `instance.yaml` is the
   `--instance` file (as in `\platform\validation`, `platform generate` and provisioning), the
   other `apps/*/app.yaml` are read too: no two apps may use the same repository
   (`repository.project`/`repository.name`, case-insensitive) or the same custom host
   (case-insensitive); the problem names both slugs. Nor may two apps of one environment have hosts
   that give the same Front Door custom-domain name `cd-{host with dots replaced by hyphens}`
   (`orders-test.contoso.com` and `orders.test.contoso.com`): the second app's deployment would
   overwrite the first app's domain in the environment's shared profile (ADR-0052). Existing domains
   keep their names (a rename re-creates the domain and its validation). The finding carries
   `checkId: front-door-domain-name`, explained in the failure catalogue (`platform rules --explain
   front-door-domain-name`); with `--base`, a host change within one app to a host with the same
   name fails the same way (the old domain stays on the route during the change).
   **Capacity** (ADR-0053, `src/capacity.ts`), with `--instance`: the app's `environments.<env>.cell`
   (default `01`) must be a cell of its network mode (`checkId: cell-unknown`); with the other
   definitions, the reserved cores of every cell the app runs in (each app's size vCPU x
   `maxReplicas`, `capacity` else `newApps.capacity`) must stay within the cell's
   `capacity.cores` (`cell-capacity`), and in a VNet-based mode their `sum(maxReplicas)` within
   the cell's subnet (`caeSubnetCapacity`, `cell-subnet-capacity`). Every app of an overcommitted
   cell reports it, naming the cell, what is reserved and the budget.
   **Decommissioning** (ADR-0056, `src/decommission.ts`): `decommission.reason` one line without
   markup, real dates, `deleteAfter` after `requestedOn`; with `--instance`, `deleteAfter` at least
   `decommission.graceDays` after `requestedOn` (`decommission-grace`). With `--base`: `requestedOn`
   never moves, and from the base's `deleteAfter` on (today's UTC date: a date rule, no Azure state)
   the block is never removed or re-dated (`decommission-tombstone`; ADR-0056 amendment 2026-11-12,
   deleted is detected: there is no `deletedOn` any more); adding the block and removing it before
   `deleteAfter` (Cancel) are listed as destructive with `decommission: true` (the portal's own
   requests), production first. From its `deleteAfter` on, a decommissioned app's hosts and capacity
   don't count for the other apps (library: `today` in `validateAppDefinition`'s options). Immediate
   mode (`decommission.immediate: true`, ADR-0056 amendment 2026-11-12, `decommission-immediate`):
   `deleteAfter` equals `requestedOn`; with `--instance` and `--base` (a rule of the change; a new
   app's file counts as all new), never added to an app with an environment of kind `prod`, nor a
   `prod` environment added to an app with a merged immediate block, unless `instance.yaml`
   `decommission.allowImmediateWithProduction` is true (ADR-0056 amendment 2026-11-21, for developing
   the platform only; the request is then listed as destructive with `PRODUCTION, IMMEDIATELY` first);
   a merged block stays valid when the setting is switched off (the plan decides in every run); with
   `--base`, never added to or removed from a merged block.
   **A slug used again** (ADR-0061, `src/archive.ts`): when `apps-deleted/<slug>/` beside the
   `apps/` folder holds definitions of deleted apps with the file's slug, its `generation` must be
   above every archived `generation` (`checkId: slug-reuse-generation`; the finding names the archived
   generations and the number to set), so everything that must be unique across Azure gets new names,
   and its `incarnation` above every archived `incarnation` (an archived definition without one counts
   as 0; `checkId: slug-reuse-incarnation`, ADR-0061 section 6), so its Entra registration gets its own
   uniqueName `{prefix}-{slug}-{env}--i{n}` (Entra keeps a deleted one's for 30 days and never lets it
   change). Library: `archivedAppYamlTexts` in `validateAppDefinition`'s options.
4. **Immutability** (`--base <git-ref>`, PR validation): the same file at that ref (`git show`;
   absent = new app, nothing to compare). Errors: `slug` changed, `generation` lowered, `incarnation`
   changed (`checkId: incarnation-fixed`, ADR-0061: it names the app's Entra registration for its whole
   life; absent = 0), database engine changed, and a `networkMode` change in an environment the base lists that the platform
   can't make (`checkId: network-mode-change`, ADR-0060): to or from `internalOnly` (deferred), and
   any pair other than `externalOnly` ↔ `externalHybrid`; and a `cell` change of such an environment
   without a change of mode (`checkId: cell-change`, ADR-0053: the platform doesn't move an app
   between the cells of one mode). A new environment may take any offered mode and cell, and a removed
   one is no change of mode. Reported as `DESTRUCTIVE` lines, not errors: `generation` raised
   (registry and app vault re-created), a `networkMode` change between `externalOnly` and
   `externalHybrid`, in any capacity cell, the cell changed with it or not (provisioning moves the app
   with a short outage into the target mode's CAE of `cell`; the line names the cells once either
   isn't `01`, ADR-0060 amendment 2026-11-16; with `--instance` it names case A or B and when the move
   runs: kind `prod` inside the maintenance window), an
   environment removed, the database or the storage account removed, a custom host removed or
   changed (managed Front Door: provisioning re-opens the ingress and removes a removed domain, and
   keeps a changed host's old domain until the new one is served; external mode: the Front Door team
   removes or moves its route; ADR-0010 amended 2026-11-11). The ref must exist locally and not start
   with `-`. **A slug used again** (ADR-0061): when this change adds an archived definition
   `apps-deleted/<slug>/<requestedOn>/app.yaml` (absent at the ref) whose text equals the file at the
   ref, the deleted app's definition moved to the archive and the file is a **new app**: nothing is
   compared (no `decommission-tombstone`, `network-mode-change`, slug, generation, incarnation or engine check, no
   destructive line); the text output says `new app: the deleted app with this slug moved to ...`,
   JSON `base.archivedAs`. **The move back**: when the file is absent at the ref and this change
   removes an archived definition of its slug, the file is compared with that archived definition (the
   one with the same text, else the newest; JSON `base.restoredFrom`): unchanged, nothing is found and
   `slug-reuse-generation` doesn't apply (it is no longer in the archive); edited, the usual checks
   such as `decommission-tombstone` and `incarnation-fixed` apply. Whether the move was allowed is `platform validate
   archive`'s.

Exit codes: `0` valid (destructive changes alone don't fail), `1` problems, `2` usage (bad ref,
file not in a git work tree with `--base`, invalid `--instance`).

### `platform validate archive` (the archive of deleted apps)

`platform validate archive <platform-config dir> [--base <git-ref>] [--format text|json]` checks
`apps-deleted/` beside `apps/` ([ADR-0061](../../docs/adr/0061-deleted-apps-view-and-slug-reuse.md)
section 3, `src/validate-archive.ts`). When a new app asks for a deleted app's slug, its pull request
moves the deleted app's `apps/<slug>/app.yaml` unchanged to `apps-deleted/<slug>/<requestedOn>/app.yaml`
(`<requestedOn>` = its `decommission.requestedOn`), removes `apps/<slug>/delivery.yml` and writes the
new `apps/<slug>/app.yaml` (checks `slug-reuse-generation` and `slug-reuse-incarnation` above). The archive is never provisioned:
`platform generate`, `platform provisioning apps` and every provisioning helper, the checks between apps
(repository, custom hosts, capacity), the network rule of `validate instance --base` and
`platform ado bootstrap` read `apps/` only.

1. **Schema**: every archived definition the change adds against `app.schema.json` (YAML syntax
   first): with `--base` those the ref's archive doesn't have, without it all of them. One already
   merged is never schema-checked again, so a stricter schema of a later core can't fail an archive
   that may not change; it keeps the place and immutability checks below.
2. **Place** (always, `checkId: deleted-archive`): `apps-deleted/` holds only folders
   `<slug>/<requestedOn>/` (a valid slug; a calendar date) with exactly one `app.yaml` each (a regular
   file of at most 1 MiB; no symbolic links, no `delivery.yml` or other files); the definition's
   `slug` equals its `<slug>` folder, it carries its `decommission` block, and
   `decommission.requestedOn` equals its `<requestedOn>` folder.
3. **Against the base** (`--base <git-ref>`, PR validation; offline, `checkId: deleted-archive`):
   every file the ref has under `apps-deleted/` is still there, unchanged (an archived definition never
   changes and is never removed), with one exception, **the move back**: an archived definition may go
   when the same change restores it unchanged to `apps/<slug>/app.yaml` and the ref has no
   `apps/<slug>/app.yaml` (no new app has the slug yet; it was archived before provisioning read the
   app deleted; runbook [decommission-app](../../docs/runbooks/decommission-app.md)). An archived
   definition the ref doesn't have is a move: the ref's `apps/<slug>/app.yaml` with the same text,
   whose `decommission.deleteAfter` is today's UTC date or earlier (the date rule of
   `decommission-tombstone`; an immediate deletion from its request day), and `apps/<slug>/app.yaml`
   no longer holds it (a copy fails). Every "same" or "unchanged" text compares after CRLF -> LF and
   with one trailing newline (`sameDefinitionText` in `src/archive.ts`; also the reuse and move-back
   detection of `validate app`). Whether the app is really deleted can't be read offline: the portal
   offers the slug only once the plan read it deleted, and provisioning guards the rest (ADR-0061
   section 4).

Prints `OK  apps-deleted/ holds <n> valid archived definition(s) of deleted apps (compared with
<ref>).` or `FAILED` with one line per problem (`<file>: line <n>: <path>: <message>`); `--format
json` prints `{kind: "archive", dir, ok, files, problems: [{file, path, message, line?, help?,
checkId?}], base?: {ref, files}}`. Exit codes: `0` valid, `1` problems, `2` usage (no `instance.yaml`
in the folder, bad ref, not a git work tree with `--base`). `\platform\validation` runs it with the
pull request's `--base HEAD^1` (`scripts/platform-validation.sh`, rule V05).

### `platform generate` (platform-config)

`platform generate [--config-dir <dir>] [--check]` reads `<dir>/instance.yaml` and every
`<dir>/apps/<slug>/app.yaml` (each validated like `platform validate app --instance`; never the
archive of deleted apps, `apps-deleted/`, ADR-0061) and writes
`apps/<slug>/delivery.yml`: a `GENERATED ... do not edit` header, then exactly the shape the core
template expects:

- queue-time parameters `action` (`deliver` | `redeploy`), `targetEnvironment` (`none` plus the
  app's environments) and `sourceRunId`;
- the app repo `{repository.project}/{repository.name}` at `refs/heads/{defaultBranch}`, triggering
  on every branch, and the core repo `{scm.azureDevOps.platformProject}/core` at
  `refs/tags/{coreVersion}`;
- `extends: pipelines/azure-devops/app-delivery.yml@core` with `app {slug, defaultBranch}` and the
  app's environments in delivery order (build environments first, then each promotion
  environment after its `promoteFrom`).

It also writes `pipelines/provisioning.yml`, the provisioning pipeline `\platform\provisioning`
(ADR-0032), from `instance.yaml` alone: a CI trigger (batched) on
`refs/heads/{scm.azureDevOps.platformConfigDefaultBranch}` (default `main`) for changes under
`apps` and `instance.yaml`, no PR trigger, the same core repo resource, and
`extends: pipelines/azure-devops/app-provisioning.yml@core` with its only parameter `environments`:
every instance environment as `{name, kind, promoteFrom}` (`''` for build environments), build
environments first, then each promotion environment after its `promoteFrom`. It also has one
schedule on the same branch, the maintenance window (`displayName: Maintenance window`, `always: true`;
[ADR-0048](../../docs/adr/0048-provisioning-by-unit-and-one-maintenance-window.md) section 7): the cron
of `maintenance.window` in `instance.yaml` (its start, UTC, on each of its days; the defaults give
`cron: '0 20 * * 1,2,3,4'`), from `maintenanceOf` and `maintenanceCron` in `src/maintenance.ts`. It
replaces the monthly Easy Auth schedule (ADR-0041) and the weekly Front Door ranges schedule (ADR-0010):
the maintenance run rotates the Easy Auth secrets that are due, re-applies the releases whose
`AzureFrontDoor.Backend` ranges changed, and runs the drift checks and scheduled upgrades that are due.

And `pipelines/validation.yml`, the pull request validation `\platform\validation` (ADR-0040),
also from `instance.yaml` alone: no trigger (`trigger: none`, `pr: none`; the build validation
policy on the default branch queues it), the same core repo resource and
`extends: pipelines/azure-devops/platform-validation.yml@core` without parameters
([pipelines](../../pipelines/README.md#platform-config-validation-template)).

And the instance's AI guide ([ADR-0072](../../docs/adr/0072-onboarding-plan-status-and-ai-guide.md),
`src/onboarding/agent-files.ts`): `AGENTS.md`, `CLAUDE.md` (`@AGENTS.md`), the skill
`.agents/skills/onboard-instance/SKILL.md` and the same bytes in `.claude/skills/onboard-instance/SKILL.md`,
`.github/copilot-instructions.md` and `.gemini/settings.json`. They carry no value of `instance.yaml` (the same for every
instance of a core version), so a settings pull request never changes them. A folder on the way that is a symbolic link
is refused before anything is written. When `--check` finds one of them missing (an instance from before this core), it
says so and names the command that writes them.

And one `pipelines/platform-<env>.yml` per environment, the platform pipeline
`\platform\platform-<env>` ([ADR-0043](../../docs/adr/0043-platform-pipeline.md)): a batched CI
trigger on the default branch for changes of `instance.yaml`, no PR trigger, the same core repo
resource, and `extends: pipelines/azure-devops/platform-environment.yml@core` with `environment`
and `hostEnvironment` (`portal.hostEnvironment`), no queue-time parameters
([pipelines](../../pipelines/README.md#platform-pipeline)).

`--check` renders in memory and exits 1 with a line diff for every file that differs or is
missing (PR validation). Symbolic links under `apps/` (and `pipelines/` itself) are refused; a
`delivery.yml` without an `app.yaml`, and a `pipelines/platform-<env>.yml` of an environment that
is no longer in `instance.yaml`, are reported as warnings and never deleted. Nothing is written
when any app is invalid.

### `platform network request` (the network team's text)

```bash
platform network request --env <name> [--config-dir <dir>] [--mode externalHybrid] [--lang en|cs] [--output <file>]
platform network help
```

Firewalls and the hub are the customer's: the platform deploys or changes no firewall rule
([ADR-0027](../../docs/adr/0027-instance-settings-in-the-portal-via-pull-requests.md), amended 2026-11-12).
This command reads `<dir>/instance.yaml` (default dir `.`, schema-validated) and prints, in English or
Czech, the ready-to-send request for the customer's network team to connect the environment's connected
network mode to the hub, for their ITSM tool or an email; `--output` writes it to a file instead. Pure:
no Azure or Azure DevOps call. The text covers:

1. the spoke VNet: the existing one (`vnet.existingVnetId`; the platform creates only its two subnets
   there) or `vnet-{prefix}-hyb-{env}`, created with its address space (`vnet.create`), with the subnets'
   names and prefixes;
2. the peering with the hub both ways and who creates which side (with `vnet.create` the platform
   creates `peer-{prefix}-hyb-{env}-to-hub`, the network team the hub side), and `useRemoteGateways`;
3. the route table (`routeTableId`) with the default route to `hub.firewallPrivateIp`;
4. the DNS servers and what they must resolve, the private DNS zones the platform creates in
   `rg-{prefix}-dns-hyb-{env}`, and with custom DNS servers the open point where those zones live
   ([ADR-0028](../../docs/adr/0028-in-vnet-platform-jobs-for-private-endpoint-steps.md), deferred);
5. the standing egress baseline
   ([network-modes](../../docs/architecture/network-modes.md#standing-egress-baseline-for-hybrid-caes))
   with its source subnet, rule type, state (`egressBaseline`) and accepted risk;
6. the internal systems of the catalogue for that environment with their rule state.

`--mode` takes `externalHybrid` (the default); `internalOnly` is refused until it is built (ADR-0003).
Exit 1 when the environment doesn't exist, has no such mode or no `hub`, or `instance.yaml` is invalid
(one stderr line per problem); 2 for usage errors. The portal writes the same text in *Settings →
Environments* (platform admins) and an app owner's request for an internal system on the app's
*Internal systems* tab, both from `src/network-request.ts`: browser-safe, exported as
`@simple-apps-foundry/platform-cli/network-request`. That module also holds the baseline as data
(`EGRESS_BASELINE`; `test/network-request.test.ts` checks network-modes.md's table against it) and
the ports of the `naming.bicep` names the text uses (checked against `infra/tests/naming-vectors.json`).

### `platform repo render` (app repository starter)

```text
platform repo render --instance <instance.yaml> --app <apps/<slug>/app.yaml> --out <dir>
                     [--templates <core>/templates] [--date YYYY-MM-DD] [--template <id>]
                     [--theme <id|none|custom>] [--output <files.json>]
```

Renders the starter of an app repository ([ADR-0039](../../docs/adr/0039-app-repos-created-and-seeded-by-provisioning.md))
from `templates/app/manifest.json` and the stack named by `repository.template` (format and
placeholder sources in [templates/README.md](../../templates/README.md)). The app definition must
pass `platform validate app --instance` (exit 1 otherwise).

- `node-ts`, `python-fastapi`, `dotnet`: every file of `templates/stacks/<stack>/`, then every
  `files` entry of the manifest (agent files, skills and their mirror, `platform.yaml`, starter
  docs). The result passes `platform check` (tested for every stack).
- `byo`: only the manifest's `onboarding` entries, the agent files
  and `platform.yaml`.
- No `repository.template`: the repository is unmanaged (app definitions from before ADR-0039);
  exit 1 with a message, unless `--template` is given.
- The modes apply to what `<dir>` already holds: `create` never overwrites, `mergeLines` appends
  the missing lines, `managed` rewrites (`AGENTS.md` keeps its `app-notes` block), mirrors become
  copies of their source (extra files are deleted). Only changed files are written; a second run
  prints `nothing to do`. Symbolic links in `<dir>` are refused.
- The app's theme ([ADR-0044](../../docs/adr/0044-app-themes.md)), from `ui.theme` or `--theme`
  (which overrides it), for the stacks only (`byo` gets no theme files):
  - a theme the instance offers (`branding.appThemes`, else the built-in `fjord`, `meadow`,
    `terracotta`): `theme/theme.css` (`themeCss()`: the `--brand-*` variables), `theme/theme.json`
    (`themeJson()`: id, names, description, logo, tokens) and `theme/README.md`;
  - `custom`: the same files with the first built-in theme's tokens as placeholders
    (`"placeholder": true` in `theme.json`, a `PLACEHOLDERS` comment in `theme.css`);
  - `none`, or no `ui`: no theme files, the starter as before themes.

  The files are `create` entries with `"when": "theme"` in the manifest. A theme the instance
  doesn't offer is exit 1 in `ui.theme` (as in `platform validate app`) and exit 2 in `--theme`.
- Deterministic: the same inputs, `--date` (`CREATED_DATE`, default today in UTC) and templates
  give the same bytes. `--templates` defaults to `templates/` of the core checkout the CLI runs
  from. `--template` overrides `repository.template` (e.g. `byo` for a repository that already has
  content). `--output` writes `{ slug, template, theme, files: [ { path, change: add|edit|delete } ] }`
  (`theme`: the theme written, or `none`).

In TypeScript (inside the CLI, e.g. the provisioning ADO stage), `renderAppRepo(instanceYamlText,
appYamlText, opts)` from `src/repo/render.ts` returns `{ slug, template, theme, files: [ { path,
change, content: Buffer } ] }` without touching the disk; `opts.existing` (a `Map` of the
repository's current files below `repoRenderScope(template)`) plays the role of `<dir>`, and
`opts.theme` the role of `--theme`. The provisioning ADO stage calls `renderRepoFiles` with the
app definition and instance it loaded, so the seed carries the app's `ui.theme` (its `seed` row
and commit message name the theme).

### `platform provisioning inputs`

```text
platform provisioning inputs --step lz|entra|release|frontdoor|portal-endpoint --instance <instance.yaml>
                             --app <apps/<slug>/app.yaml> --env <name> [--state <state.json>]
                             --output <x.json> [--mode bootstrap|reapply]
                             [--prepare-from externalOnly|externalHybrid]
```

Writes the JSON that the core-owned parameter files read; the provisioning pipeline passes it in
an environment variable and nothing else (no `--parameters`):

| Step | Parameter file | Variable |
|---|---|---|
| `lz` | `infra/app/provisioning/landing-zone.bicepparam` | `SAF_LZ_JSON` |
| `entra` | `infra/entra/provisioning/app-registration.bicepparam` | `SAF_ENTRA_JSON` |
| `release` | `infra/app/provisioning/release.bicepparam` (`deployedBy 'provisioning'` is a literal) | `SAF_RELEASE_JSON` |
| `frontdoor` | `infra/app/provisioning/frontdoor.bicepparam` (no `--state`: instance.yaml and app.yaml only) | `SAF_FRONTDOOR_JSON` |
| `portal-endpoint` | `infra/app/provisioning/portal-endpoint.bicepparam` (no `--state`; the app vault's portal-side private endpoint in the portal resource group, ADR-0025) | `SAF_PORTAL_ENDPOINT_JSON` |

`frontdoor` (ADR-0010, amended 2026-11-01) writes `prefix`, `environmentName`, `slug`, `networkMode`,
`hostName` (`environments.<env>.frontDoor.hostName`, lower-case) and `dnsZoneId`: the zone's
`azureDnsZoneId` when the host's zone (the longest of `dns.zones` it lies below) is an `azureDns`
zone in the environment's subscription, else `''` (records by hand). `dnsZone` and `dnsProvider`
are for the run's log; the parameter file doesn't read them. An environment without a custom host
fails.

`portal-endpoint` (ADR-0025) writes `prefix`, `portalEnvironmentName`
(`portal.hostEnvironment`), `location` (the host's `region` ?? `defaultRegion`, the portal VNet's),
`environmentName` (`--env`, the vault's environment), `slug`, `generation`, `vaultSubscriptionId`
(that environment's `subscriptionId`), `networkMode`, `externalOnlyNetwork`, `managedBy`
(`productName`), and `vnetBased` (`externalHybrid`, or `externalOnly` with `network: vnet`), which
only the pipeline reads: it deploys the endpoint only then, and the template refuses a
managed-network app anyway.

Every key of the template's parameters is always present. Values come from `app.yaml` and
`instance.yaml` (defaults read from the bundled instance schema, never copied into code), plus
`state.json` for what only exists at run time. `state.json` is strict (unknown keys fail), every key
is optional overall, and each step requires the ones it uses, so a re-run never resets deployed
state by falling back to a default:

| Key | Shape | Needed by |
|---|---|---|
| `ado` | `{issuer, subject}` of the app's service connection, or `null` before it exists | `lz` (`deliveryFederation`) |
| `easyAuthSecretExists` | boolean, carried from the last lz record | `lz` |
| `budgetStartDate` | `YYYY-MM-01` of the existing budget (or the current month for a new one), or `null` | `lz` when a budget applies |
| `containerAppFqdn` | the Container App's default host (`ca-{slug}.<CAE default domain>`) | `entra` (`hosts`; with `environments.<env>.frontDoor.hostName` the custom host follows it, so sign-in works on both; only the custom host once the ingress is locked, see below) |
| `landingZone` | `{runtimeIdentityClientId, database?, storageBlobEndpoint?}` (lz outputs) | `release` |
| `entra` | `{clientId}` or `null` | `release` of an app with `authentication.mode: required` (no clientId = no release, never an anonymous one) |
| `releaseRecord` | `properties.parameters` of the last `release-{slug}` deployment, or `null` | `release --mode reapply` (app-owned `image`, `runtime`, `env`, `secrets`, `run`; its prefix/environment/slug must match) |
| `bootstrap` | `{image: <registry/repo[:tag]@sha256:...>, runtime}` | `release --mode bootstrap` (refused when a release exists) |
| `frontDoor` | `{hostName, frontDoorId, serving?, retainedHostName?}` of the app's deployed custom domain, or `null`; absent = not read. `serving`: Front Door serves it (domain `Approved`, deployment `Succeeded`); `retainedHostName`: during a host change, the previous host still on the route | `release` (optional): `frontDoor: {mode: managed, frontDoorId, hostNames, backendIpRanges}` when `hostName` equals `environments.<env>.frontDoor.hostName` (`hostNames`: the retained host first while the new one isn't served, then the requested host), else `{mode: none, backendIpRanges: []}` (also during a removal); `entra` (`hosts`: the default host, the requested host and every host the route still serves, see below) |
| `frontDoorBackendIpRanges` | the stage's `AzureFrontDoor.Backend` IPv4 ranges (`fd-ranges`): 1 to 400 IPv4 CIDR network addresses, sorted, no duplicates, none wider than /8; absent = not resolved, never `[]` | `release` (required once the domain is deployed: no release without them), `entra` |

`lz` also carries `portalIdentityPrincipalId`: `portal.identityPrincipalId` of `instance.yaml`, or
`''` without it. The landing zone gives that principal (`id-{prefix}-portal`) Reader on the app
resource group, so the portal can check the delivery identity behind a deploy event (ADR-0037);
`''` assigns nothing.

`lz`, `release` and `frontdoor` carry `cell`: app.yaml's `environments.<env>.cell` (default `01`;
ADR-0053, ADR-0060 amendment 2026-11-16), with `networkMode` the CAE the templates name. `platform
provisioning apps` writes `cells: {<env>: <cell>}` per app into `apps.json`; `plan-facts` matches the
live Container App against every cell's CAE (`containerAppCell`), and `plan-units` adds `fromCell` and
`toCell` to a move's `modeChange`. The units' views name the cell only when it isn't `01`.

`lz` always carries `modeChange` ([ADR-0060](../../docs/adr/0060-network-mode-change-of-an-app.md)
decision 4): `null`, the steady state. `--prepare-from <mode>` (step `lz` only) writes the prepare
pass of a network mode change from `<mode>` to the app's mode in `app.yaml`, `{phase: prepare,
fromNetworkMode}`: only `externalOnly` and `externalHybrid`, never the app's current mode. From
`externalHybrid`, `hybridExistingVnetId` names the hybrid spoke's existing VNet (the source spoke)
also when the app's mode is `externalOnly`. The pipeline doesn't pass it yet (batch 2b).

`lz`'s `budget.amount` is in the currency Azure bills the environment in (ADR-0018): the app's
budget (`environments.<env>.budget.monthlyAmount`, else `budgets.defaultMonthlyAmount`) is in
`locale.currency`; when `environments[].billingCurrency` differs, it is divided by the fixed rate
`costs.fx.fixedRates.<billing currency>` (units of the instance currency per 1 unit of it) and
rounded to a whole unit, at least 1 (50 EUR at USD 0.92 = 54 USD). Without a rate the step fails.
A changed rate changes the inputs, so the next run redeploys the landing zone.

The release goes behind Front Door (`frontDoor.mode: managed`: `FRONT_DOOR_ID` and Easy Auth's
`forwardProxy` Standard) only once the app's custom domain is deployed for the host `app.yaml` asks
for now (state `frontDoor`, ADR-0010 amended 2026-11-02). **The ingress lock-down** (amended
2026-11-11): `backendIpRanges` gets `frontDoorBackendIpRanges` once Front Door serves the domain
(`frontDoor.serving`), or when the release record already has ranges for that host (a locked
ingress stays locked); until then `[]`. A deployed domain without `frontDoorBackendIpRanges` fails.
`entra` lists only the custom host under the same condition (without the release record), else
the default host and the custom host. `customDomains` is always `[]`: custom domains go through
Front Door only, never bound on the Container App (ADR-0010, amended 2026-11-12); the parameter stays
in `release.bicep` until that template changes anyway. Not generated yet: vaulted backup (no
landing-zone parameter yet). The example inputs in
`infra/app/provisioning/examples/` and `infra/entra/provisioning/examples/` are what this command
writes for the Contoso examples and the `*.state.json` there (a test keeps them in sync);
`infra/tests/check-infra.py` snapshots the parameter files with them.

### `platform provisioning validate-run|apps|units|plan-names|plan-facts|plan-units|state|compare`

The provisioning pipeline's other helpers. All are pure (files in, files out, no Azure or Azure
DevOps calls), print one stderr line per problem and exit `0` ok, `1` check failed or invalid input,
`2` usage or internal error.

```text
platform provisioning validate-run --instance <instance.yaml> --environments-json <json> --host-environment <name>
                                   --core-ref <ref> --source-branch <ref> --units <core>/infra/app/units.json
                                   --upgrades <core>/infra/app/upgrades.yaml --upgrade <none|all|slug,...> --apps-dir <dir>
platform provisioning apps --instance <instance.yaml> --apps-dir <dir> --scope changed|all --upgrade <none|all|slug,...>
                           --output <apps.json>
platform provisioning units --instance <instance.yaml> --apps <apps.json> --output <unit-inputs.json>
platform provisioning plan-names --instance <instance.yaml> --env <name> --output <names.json>
platform provisioning plan-facts --instance <instance.yaml> --apps <apps.json> --env <name> --bulk <dir>
                                 --images <core>/images/images.json [--fd-ranges <f>] [--now <epoch>] [--run-id <id>]
                                 --output <plan_<env> dir>
platform provisioning plan-units --instance <instance.yaml> --apps <apps.json> --inputs <unit-inputs.json>
                                 --manifest <core>/infra/app/units.json --upgrades <core>/infra/app/upgrades.yaml
                                 --plan <env>=<dir>... [--today YYYY-MM-DD] --output <units.json>
                                 [--decommission <decommission.json>] [--registry <registry.json>]
platform provisioning state --instance <instance.yaml> --app <apps/<slug>/app.yaml> --env <name> --core-dir <core checkout>
                            [--lz-record <f>] [--release-record <f>] [--fd-record <f> [--fd-domain <f>]] [--fd-ranges <f>]
                            [--entra-outputs <f>] [--ado-outputs <f>] [--today YYYY-MM-DD] --output <state.json>
platform provisioning compare --kind lz|release|entra|frontdoor|portal-endpoint --validate <validate.json> [--record <record.json>]
```

- **`validate-run`**: the run's `environments` parameter (JSON, e.g. `${{ convertToJson(parameters.environments) }}`)
  must equal what `platform generate` renders from `instance.yaml` (names, kinds, `promoteFrom`,
  order), `--host-environment` its `portal.hostEnvironment`, `--core-ref` (the resolved core repo
  ref) must be `refs/tags/{coreVersion}`, `--source-branch` platform-config's default branch, and
  `--units` (core's unit manifest, ADR-0048) must exist, name the six units with a revision, a
  64-hex fingerprint and a released `since` (never `unreleased`, never after `coreVersion`).
  `--upgrades` (core's upgrade notes, ADR-0049) must match `config/schema/upgrades.schema.json`,
  have no `versions.unreleased` and no version after `coreVersion`. `--upgrade` (the pipeline's
  parameter) must be `none`, `all`, or up to 50 slugs separated by commas (spaces around them
  ignored, each once), each with `<--apps-dir>/<slug>/app.yaml`.
  Prints `OK  provisioning: environments ..., core <ref>, branch <ref>, upgrade <none|all apps|slugs>`.
- **`apps`**: validates every `<dir>/<slug>/app.yaml` like `platform validate app --instance`
  (the pipeline passes `--apps-dir <platform-config>/apps`, so the archive of deleted apps,
  `apps-deleted/`, is never listed or provisioned; ADR-0061)
  (no `--base`) and writes `{ apps: [...] }` sorted by slug, each
  `{slug, file, ok: true, environments: [names in delivery order], authMode, frontDoorHosts: {<env>: <host>}, networkModes, incarnation}` or
  `{slug, file, ok: false, problems: [...]}` (problems neutralised). `file` is
  `<--apps-dir>/<slug>/app.yaml` as given. An invalid app or a symbolic link is an `ok: false`
  entry and the command still exits 0 (that app fails alone); an invalid instance or a directory
  name that is not a valid slug exits 1. Directories without `app.yaml` are skipped. `checkAllApps`
  is `--scope all` (every unit runs, except the outdated ones ADR-0049 holds); `upgrade` is
  `{all, apps}` from `--upgrade` (the apps whose outdated units run). A decommissioned app is listed
  in every phase with its `decommission` dates (ADR-0056: whether it is deleted is the plan's to read
  in Azure, so the listing never depends on the date). `incarnation` is app.yaml's (default 0,
  ADR-0061 section 6): `prov_names` hands it to `names.bicep` for the Entra registration's uniqueName.
- **`units`** (ADR-0048): `i` of every unit of every valid app, the sha256 of its inputs in the
  offline view: `lz`, `entra` (sign-in apps), `release`, `frontdoor` (managed Front Door mode) and
  `pep` per environment, as `provisioning inputs` renders them from `app.yaml` and `instance.yaml`
  alone (runtime values such as the federation, the budget's start date, landing-zone outputs,
  the client ID and the Front Door state left out or fixed placeholders; the end state assumed:
  the custom domain served, the ingress locked); `ado` from the desired objects of `ado plan`
  offline, with the Required template ref (so a core version changes it). Writes
  `{schemaVersion, coreVersion, apps: {<slug>: {ado, files, environments: {<env>: {<unit>: <hex>|null}}, problems}}}`
  (`null`: the inputs could not be rendered; the unit then always runs). `files` (ADR-0049): the
  sha256 of the app's `app.yaml` bytes and `instance.yaml` as canonical JSON without `coreVersion` and `coreReleases` (ADR-0067),
  each length-prefixed; its first 12 hex are the tag `saf-u-files`. The release's `coreVersion` (tag
  `saf-core`) is left out of its view, so a core version alone changes no unit's `i`.
- **`plan-units`** (ADR-0048 section 4, rule 2 amended by ADR-0049): decides every unit from
  `--inputs`, the tags and facts of the artifacts `plan_<env>` (`plan.json`, `status/`,
  `facts/<slug>.json`), core's `units.json` and `upgrades.yaml`, the `upgrade` of `--apps` and
  `--today`: it runs when it has no tag (`new`), its `i` changed (`inputs`), another fact needs it
  (`dependency`: a new landing zone, no federation, the Easy Auth secret absent, due or not in the
  landing zone, a pending restart, no Entra record, changed Front Door ranges; frontdoor and release
  together), its last check is `maintenance.driftCheckDays` old (`drift`) or `checkAllApps`
  (`all`). A unit whose tag's version is older than its `since` is outdated: it runs only when the
  app is in `upgrade` (`upgrade`), its version is older than `minAppVersion` (`minAppVersion`) or it
  runs for `new`, `inputs` or `dependency`, each then with `template`, and brings the units its
  upgrade notes `requires` (`requires`); otherwise it is held (`run: false`, `held: true`, reason
  `held`, its detail "<unit> changed in <since>; applied by <version>"), also for `drift` and
  `all`. `ado` is never held (`template` alone runs it). An outdated unit whose `i` changed while
  `saf-u-files` equals the app's files hash is rebased (`rebase`: the tag's version and date with
  the new `i`, detail `rebased`) instead of run. Writes the run's plan: `upgrade`, `minAppVersion`,
  per app and environment `plan` (ok | failed), `resourceGroup`, `filesTag`, `files`, `legacyTag`,
  `entraSingleHost` and per unit `{run, reasons, details, tag, record, outdated, held, rebase}`
  (`record`: the tag value record_<env> writes when the unit finishes, a first one backdated by
  sha256(slug|env|unit) mod driftCheckDays days), and `stages`: the outputs `lz_<env>`,
  `post_<env>`, `record_<env>` (also for a rebase), `ado`, `entraPlan` (ADR-0050: only an `entra` unit
  that runs together with its `lz`; the others are compared in the plan's job `decide`). A
  decommissioned app (ADR-0056) gets `decommission: {phase, requestedOn, deleteAfter, dueOn, waits}`:
  `retired`, `deleting`, or `deleted` when its delete phase is due by the dates, every environment
  was planned, the Entra records were read and nothing is left (no resource group, no `lz-` or `fd-`
  record in any environment, no `entra-` record in the host's list; amendment 2026-11-12, nothing
  runs for it then). `--decommission` writes those phases (`{schemaVersion, today, now, apps:
  {<slug>: {phase, requestedOn, deleteAfter, immediate?}}}`), the file the portal reads.
  `--registry` writes the plan of the registry image purge (ADR-0059), with the same input and time:
  per build environment (no `promoteFrom`) each app's `{run, reason, tag, record, resourceGroup,
  registry, protect}` and `due`, `deferred`, `waiting`; `retention` (`maintenance.registryRetention`),
  `everyDays` 7, `maxApps` 100, `maxDeletes` 200 and `stages`: the outputs `registry_<env>`. An app
  runs when the run is inside the window, the mode isn't `off`, it isn't decommissioned, it was planned
  in every environment it has with the Container Apps read (`protect`: every image it runs anywhere),
  its landing-zone record says `registryPurgeRole` and its `lz` doesn't run now, and its tag
  `saf-registry-purge` is absent, malformed, of another mode or at least 7 days old; at most 100 per
  environment, never purged first, then the most overdue.
- **`plan-names --apps`** also gives `appResourceGroups` (by naming): `plan.sh` lists the Container
  Apps for a decommissioned app only while its group is in the group list, `record.sh` and
  `registry.sh` write tags only on these groups; and `containerApps` and `registryRepositories`, which
  the registry purge reads (ADR-0059).
- **`plan-names`** (ADR-0050): `{subscriptionId, platformResourceGroup, entraResourceGroup}` of the
  environment, the names `plan.sh` lists by (`src/provisioning/names.ts`, the port of `naming.bicep`
  that `test/naming-vectors.test.ts` checks against `infra/tests/naming-vectors.json`), and
  `vaultVariants` `[{variant, mode, modes}]`: the environment vault variants the environment offers,
  which `plan.sh` names once each with `names.bicep` (a vault's name holds a Bicep hash, ADR-0060), and
  `entraResourceGroups` `{<env>: rg-{prefix}-entra-{env}}`: the Entra records group of every environment
  of the instance (ADR-0063), which `plan.sh` of `portal.hostEnvironment` lists with
  `entraResourceGroup` (the instance's group, which holds the records deployed before ADR-0063).
- **`plan-facts`** (ADR-0050): the read model of a job `plan_<env>`. From the lists `plan.sh` read once
  for the whole environment (`--bulk`: `groups.json`, `lz-records.json`, `fd-records.json`,
  `fd-domains.json`, `container-apps.json`, `jobs.json`, `secrets/<vault>.json`, and
  `revisions/<slug>.json` or `.failed` for the apps a previous call named; a missing file = that list
  could not be read) writes for every app of the environment `status/<slug>.<env>.json`,
  `facts/<slug>.json` and its entries `lz-outputs/`, `secret/` and `frontdoor/`, and `lazy.json`
  `{revisions: [{slug, id}]}`: the apps whose Easy Auth restart the lists can't decide (no
  `systemData.lastModifiedAt`) or whose rotation is due within a day (its password removal needs the
  exact version). The pending restart: the Container App's tag `saf-easyauth` equal to the version,
  or modified at least 30 minutes after it, is not pending; modified before, it is. The secret entry's
  `loaded` is only ever exact (the tag naming the version, or the revisions), else the tag or `null`.
  An app whose list could not be read, whose custom domain needs ranges that could not be resolved, or
  whose record is malformed fails its plan; `<bulk>/plan-facts.json` lists the failures and warnings
  (neutralised) for the log. For the registry purge (ADR-0059) the facts also carry `images` (what the
  app's Container App runs, containers and init containers; `[]` without one, `null` when the list
  wasn't read), `registryName` and `registryPurgeRole` (landing-zone outputs). For a network mode
  change (ADR-0060): `env-vaults.json` in `--bulk` (`{<mode>: <vault>}`, from `plan.sh`) makes the secret
  entry name the vault and the `kvset` job of app.yaml's mode (absent: the record's, as before) and adds
  `appVault` and `elsewhere`; the facts carry `containerAppMode` (the live app's CAE by
  `names.ts` `managedEnvironment`: a mode, `none`, `unknown`; `null` when the list wasn't read),
  `liveFqdn`, `lzNetworkMode`, `lzPrepareFrom` and `secretElsewhere`. A record naming another mode
  than app.yaml with the Container Apps unread fails the app's plan. `plan-units` decides the move
  from them (`modeChange`, release action `move`, or `followUp remove-old`); in an environment of kind
  `prod` while `--now` is outside the maintenance window, `modeChange.waitsForWindow` names the next
  window's start and the move step waits (product owner, 2026-11-14).
- **`state`**: the `state.json` of `provisioning inputs` from the deployment records, each the raw
  `az deployment sub|group show -o json` (no flag = no record; a record of another deployment name
  is refused). Keys without a source are left out, so the step that needs them fails:

  | Key | Source |
  |---|---|
  | `landingZone` | lz outputs `runtimeIdentityClientId`, `database`, `storageBlobEndpoint` (left out without them) |
  | `containerAppFqdn` | lz output `containerAppFqdn` (left out when the record predates that output) |
  | `ado` | `--ado-outputs` (`platform ado apply --output`) entry of this environment ?? lz parameter `deliveryFederation` ?? `null` |
  | `easyAuthSecretExists` | lz parameter (`false` without a record), only while the record's environment vault is the one of the app's mode now (same vault variant from `networkMode` and `externalOnlyNetwork`, same `vaultGeneration`; ADR-0060), or `--easy-auth-secret present` |
  | `entra` | entra output `clientId` ?? release parameter `authentication.clientId` ?? `null` |
  | `budgetStartDate` | lz parameter `budget.startDate` ?? first day of `--today`'s month (default: today, UTC); `null` when the app has no budget there |
  | `releaseRecord` | release `properties.parameters`, or `null` |
  | `bootstrap` | `{image: <lz output registryLoginServer>/saf-placeholder@<digest>, runtime}` from `<core-dir>/images/images.json` (size `xs`, replicas 0..1); left out without an lz record |
  | `frontDoor` | `--fd-record` (`fd-{slug}-{env}`): `{hostName: <parameter hostName>, frontDoorId: <output frontDoorId>}` (lower-case) when `Succeeded` with a GUID output, plus `retainedHostName` when that parameter isn't empty, else `null` (failed, or a record from before that output); left out without the flag. With `--fd-domain` (`{domainValidationState, deploymentStatus}` of the record's `customDomainId`, an ARM read) also `serving`: both `Approved` and `Succeeded` |
  | `frontDoorBackendIpRanges` | `--fd-ranges` (the output of `fd-ranges`), checked again, its `sha256` included; left out without the flag |

  The result is validated like `provisioning inputs` validates `state.json`.
- **`compare`** (ADR-0032 D6): prints exactly one line, `up-to-date`, `changed: <reasons>` or `new`
  (no `--record`), and exits 0 in all three cases. `--validate` is the output of
  `az deployment sub|group validate` of the rendered inputs, `--record` the last
  `az deployment ... show`. Up to date = the record's `provisioningState` is `Succeeded`, its
  `templateHash` equals the validate output's, and its `parameters` equal the validate output's,
  where an entry without `value` equals `value: null` (ARM omits null values in records). For
  `--kind release` the parameters `deployedBy` and `alertsEnabled` are ignored (delivery records
  carry `delivery` and `false`). Reasons are `provisioningState <state>`, `templateHash` and
  `parameters <up to 5 names>[ (+n more)]`, joined with `; `.

### `platform provisioning fd-ranges`

```text
platform provisioning fd-ranges --service-tags <az network list-service-tags output> --output <ranges.json>
```

The ingress lock-down of apps behind the managed Front Door (ADR-0010, amended 2026-11-11). Stage
`azure_<env>` runs `az network list-service-tags --location <region>` once and this command on its
output. It keeps the `addressPrefixes` of the one entry named `AzureFrontDoor.Backend` that are IPv4
(Container Apps IP rules take no IPv6 and no service tags), sorted numerically and de-duplicated,
and writes `{serviceTag, changeNumber, ipv4, ipv6, sha256, ranges}`. `sha256` (of the sorted list)
is part of the scope of targeted runs for apps on a custom domain. It exits 1 when there is not
exactly one such entry, when no IPv4 prefix is left, with more than 400 (the sandbox counted 157,
2026-11-11), or on any prefix that is not an IPv4 CIDR network address or is wider than /8.

**Host changes, removal and external mode** (ADR-0010, amended 2026-11-11).

- `inputs --step frontdoor` takes `--fd-record` (the record `fd-{slug}-{env}` as it is before this
  run), `--fd-domain` (whether Front Door serves its host) and `--apps` (`plan/apps.json`). It writes
  `retainedHostName` and `retainedDnsZoneId`, the previous host that stays on the route while the
  requested one isn't served:
  - the record's host when Front Door serves it;
  - the host it retained when it doesn't;
  - when unknown (a failed deployment, the domain not read): the retained host, else the record's
    host;
  - never the requested host or a host another app requests now.
- `entra` lists every host a browser may sign in on during the run:
  - the default host and the requested one, or only the requested one once the ingress is locked;
  - plus the record's hosts the route still serves, until the requested host is served;
  - during a removal (no requested host, a record left), the default host and the record's hosts.
- External mode (`frontDoor.mode: external`): `release` writes `{mode: external, frontDoorId,
  hostNames: [host], backendIpRanges: []}`. The ID is the instance profile's `frontDoorId`, else the
  app's. `entra` lists the default and the custom host, and `--step frontdoor` refuses (nothing is
  deployed in another team's profile).

### `platform provisioning fd-cleanup`

```text
platform provisioning fd-cleanup --instance <instance.yaml> --app <apps/<slug>/app.yaml> --env <name>
                                 --before <record.json> [--after <record.json>] [--apps <plan/apps.json>]
                                 --output <plan.json>
```

What `azure_post_<env>` deletes after the release step (`front_door_cleanup`, ADR-0010 amended
2026-11-11). `--before` is the record `fd-{slug}-{env}` as it was before this run's deployment,
`--after` the deployment of this run; without `--after`, app.yaml must request no domain (a
removal). It writes `{slug, environmentName, deployment, resourceGroup, profileId, endpointId,
removeRoute, routeId, originGroupId, expectedCname, domains: [{host, customDomainId, dns, manualDns}],
skipped}`:

- `domains`: the hosts of `--before` (`hostName`, `retainedHostName`) that are neither in `--after`
  nor requested.
- `dns`: the CNAME and `_dnsauth` TXT record set IDs, only when the deployment wrote them in a zone
  `instance.yaml` lists as an Azure DNS zone of the environment's subscription. Otherwise
  `manualDns` names both records for the DNS team.
- `skipped`: hosts another app requests now (`--apps`).
- `removeRoute`: true for a removal.
- `expectedCname`: the endpoint host of `--before`; the pipeline deletes a CNAME only while it still
  points there.

Names come from the port of `naming.bicep` in `src/provisioning/frontdoor-plan.ts`, checked against
the naming vectors. The command exits 1 when a requested domain would be removed, when `--after` is
not `Succeeded` or names another host than app.yaml, and when DNS records would be deleted without a
known endpoint host.

### `platform provisioning failure-code` and `failures`

Provisioning failure codes (ADR-0064, `src/provisioning/failure-code.ts`). The codes and their texts
are in the failure catalogue (`src/explanations.ts`, `PROVISIONING_FAILURES`; `platform rules --explain
PE009`). `failure-code --log <az stderr> --kind lz|release|entra|frontdoor|portal-endpoint` prints one
code for a failed deployment: PE007 `RequestDisallowedByPolicy`, PE006 `AuthorizationFailed` or
`LinkedAuthorizationFailed`, PE005 `SkuNotAvailable`, PE008 `Authorization_RequestDenied` (entra only),
PE004 when every error is one `classify-deploy-error` retries, PE001 otherwise. Only codes seen in the
sandbox or documented by Microsoft are mapped. `failures --input <failures.json>` prints the run
summary's section Failures (report.sh): one row per failed step, then what to do per code, in English.

### `platform provisioning registry-purge`

Which manifests of an app's build-environment registry to delete (ADR-0059). Pure: it reads a listing
and writes a decision; `scripts/provisioning/registry.sh` deletes what it returns (mode `purge`).

```text
platform provisioning registry-purge --manifests <list-metadata.json> --output <decision.json> [--live <images.json>]
    (--plan <units/registry.json> --env <name> --slug <slug>
     | --days <n> --keep-latest <n> [--protect <image or digest>]... [--now <epoch>])
```

- `--manifests`: the output of `az acr manifest list-metadata --registry <name> --name <slug>` (objects
  with `digest`, `tags`, `createdTime`, `lastUpdateTime`, `changeableAttributes.deleteEnabled`;
  `TODO(verify)` REG-3). An entry without a valid digest counts as unreadable.
- Kept: untagged manifests; every image the app runs (by digest, or by tag for an image deployed by
  tag): the plan's `protect` and `--live` (a JSON array of image references read right before); the
  `keepLatest` newest builds (by the later of created and updated); locked ones; ones with a tag the
  delivery pipeline doesn't write (only the commit or `{commit}-{runId}` are its tags); ones without a
  readable time; ones younger than `days`. The rest is deleted, the oldest first, at most 200.
- `--plan`: the retention, the protected images, the time and the mode from the run's plan, which must
  purge that app there (else exit 1); `--days`, `--keep-latest`, `--protect` and `--now` are refused
  with it. Without `--plan` the decision is a dry run: an operator's check of a listing
  ([runbook](../../docs/runbooks/registry-purge.md)).
- Writes `{schemaVersion, slug, environment, mode, days, keepLatest, now, total, delete: [{digest, tags,
  time}], kept: {running, newest, young, untagged, locked, otherTag, unreadable, deferred}}` and prints
  the counts and up to 50 deletes.

### `platform provisioning rotation-due`

```text
platform provisioning rotation-due --expires <epoch seconds|none> [--created <epoch seconds|none>] [--now <epoch seconds>]
```

Whether an Easy Auth secret whose vault version expires at `--expires` (Key Vault `exp`, which the
`kvset` job sets to the password's end) is due for rotation
([ADR-0041](../../docs/adr/0041-easy-auth-secret-rotation-in-provisioning.md)). `entra_plan` asks it
for every present secret, with the version's `created`. Pure; prints one line:

- `due <days left>`: at most 120 days left (the password lives 180), or expired (negative days);
- `current <days left>`: more than 120 days left;
- `due none`: the vault records no expiry (a secret written by hand) and the version is at least
  60 days old by `--created`, or `--created` is `none` too;
- `current none`: no expiry, but the version is younger than 60 days.

`--now` defaults to the current time. Values must be epoch seconds between 2000 and 2100 (or
`none` for `--expires` and `--created`); anything else exits 1.

### `platform provisioning easyauth-secret`

```text
platform provisioning easyauth-secret [--mode new|rotate|remove-old] --client-id <appId> --job <ARM ID of the kvset job>
    --secret-name easyauth-<slug> --vault <expected vault name> --display-name <credential name>
    [--current-created <epoch seconds|none>] [--current-expires <epoch seconds|none>]
    [--loaded-created <epoch seconds|none>] [--app-vault <vault name|none>] --output <file>
env: SAF_ARM_TOKEN, SAF_GRAPH_TOKEN (required, never arguments)
     SAF_ARM_ENDPOINT, SAF_GRAPH_ENDPOINT (optional, default https://management.azure.com/ and
     https://graph.microsoft.com/)
```

The Entra stage's Easy Auth secret step ([ADR-0035](../../docs/adr/0035-kvset-job-and-automated-easy-auth-secret.md)):
it creates the app registration's client secret and has the `kvset` job of the app's CAE write it to
the environment vault of that network variant. It and `dbinit` are the provisioning commands that call Azure.
One process; the value exists only in its memory:

1. **Check the job** (`GET`, api-version `2024-03-01`): manual trigger, exactly one container, no
   init containers, image `<registry>/saf-jobs@sha256:…`, no command override, args exactly
   `["kvset"]`, no `SAF_SECRET_*` of its own, and its `SAF_VAULT_URI` is
   `https://<--vault>.<Key Vault DNS suffix>/` (public, China or US Government cloud). Anything
   else stops the command before any write. Secrets left on the job by an earlier run are reported
   (`warn`) and replaced.
2. **Password:** Graph `GET applications(appId='…')?$select=id`, then `addPassword` with
   `--display-name` and an end 180 days ahead. A 404 is retried three times (10, 20, 40 s) while a
   registration created moments ago replicates.
3. **Job secret:** `PATCH` the job with `configuration.secrets = [{name: saf-kvset-<slug>, value}]`
   and follow `Azure-AsyncOperation` (or `Location` on a 202) until the operation ends. If the
   operation URL answers 401 or 403 (it lies outside the job's scope, where *Platform Job Secret
   Writer* is assigned), the command follows the job's own `provisioningState` instead, within the
   same timeout (`wait` line; `Succeeded` ends it, `Failed` or `Canceled` fail).
4. **Start** (`POST <job>/start`) with the job's container (name, image, args, cpu and memory), its
   env plus `SAF_SECRET_NAME`, `SAF_SECRET_VALUE` (`secretRef: saf-kvset-<slug>`) and
   `SAF_SECRET_EXPIRES` (the credential's end).
5. **Wait** for the execution: every 5 s, at most 10 minutes, until `Succeeded` or `Failed`,
   `Stopped`, `Degraded` (a 404 right after the start counts as not visible yet).
6. **Always** `PATCH` `configuration.secrets = []`, wait, and check with a `GET` that the secret is
   gone. If the job was never started (a failure before the start, or the start refused with a
   4xx), Graph `removePassword` (best effort), so no unused credential stays. Once a start may
   have reached the job (accepted, answered without an execution name, a 5xx or no answer, an
   execution that failed or ran out of time), the password stays: the job may have written it,
   and revoking it would leave a dead credential in the vault that the plan takes as present. The
   failure then names the keyId, its expiry, and the `az ad app credential delete` command for
   the case that the job's console logs show no write. If only the removal of the job secret
   fails, the command still fails, naming the `az containerapp job secret remove` command that
   fixes it.
7. **`--output`**: `{secretName, vault, execution, keyId, endDateTime, mode, written: true}`,
   written as soon as the job wrote the vault, also when a later step fails (exit 1 then), so the
   pipeline knows the vault holds a new version. Never after a failure before that.

**`--mode rotate`** ([ADR-0041](../../docs/adr/0041-easy-auth-secret-rotation-in-provisioning.md);
`--mode new`, the default, takes `--current-*` and `--loaded-created` `none`). `--display-name` must
be a platform credential name, `easyauth-<env>[-run-<id>]`. `--current-created` and
`--current-expires` are the vault version's `created` and `exp` as `azure_<env>` read them (before
the approval). `--loaded-created` is the version the app's active revisions are known to run with:
the Container App's tag `saf-easyauth` (set only once the version has settled for 30 minutes), or
that version when every revision was created at least 30 minutes after it. Between steps 1 and 2:

- Graph `GET applications(appId='…')?$select=id,passwordCredentials` (never the hint or text);
- the **current** password: the platform-named credential (`easyauth-<env>[-run-<id>]`) whose
  `endDateTime` equals `--current-expires` and which is the newest one created before
  `--current-created`. If the two don't name the same single credential, or either value is `none`,
  nothing is removed (`warn` says why);
- nothing is removed either unless `--loaded-created` equals `--current-created`: a revision may
  still use an older password because its restart never happened (`warn`);
- `removePassword` for every platform-named credential **strictly older** than the current one,
  before `addPassword`. A newer one stays: a re-run of a failed `entra` stage with the same plan,
  or an overlapping run, may already have written it to the vault. Normally two platform passwords
  remain; after such a re-run, three remain until the next rotation. A failed removal is reported
  and the rotation goes on; the command exits 1 at the end;
- credentials with other names are kept, with a `warn` that names only their `keyId`.

The output adds `currentKeyId` (or `null`) and `removedKeyIds`. If the job never started, only
the new password is removed; the current one stays.

**`--mode remove-old`** ([ADR-0060](../../docs/adr/0060-network-mode-change-of-an-app.md) decision 8):
the run after a move between the managed network and a VNet-based mode (case A), which re-issued the
secret in the target vault. Not called by the pipeline yet (batch 2b). It adds no password and sets
no job secret:

1. the reads of step 1 and rotate (the job, the app's `passwordCredentials`), before any write;
   `--job` must be a `kvset` job by name (`caj-<prefix>-kvset-<ext|hyb|int>`), the **old** variant's,
   and its `SAF_VAULT_URI` must be `--vault`, the old vault;
2. only when the app no longer runs in that variant: `--app-vault` (required; the environment vault of
   the CAE the app runs in now, from the plan) must be a vault name other than `--vault`. With `none`
   or the same vault nothing is deleted or removed (`warn`, exit 0, `oldSecret: kept`);
3. **delete:** `POST <job>/start` with the job's container and env plus `SAF_SECRET_NAME` and
   `SAF_SECRET_ACTION: delete` (no `SAF_SECRET_VALUE`, no `SAF_SECRET_EXPIRES`). `saf-jobs` soft-deletes
   `easyauth-<slug>` in the job's vault, never purges, and counts an absent secret as done. Wait as in
   step 5;
4. **predecessors:** as `--mode rotate` before `addPassword`, with the same guards: `--current-*` are
   the version in the vault the app runs with now, `--loaded-created` the version the app runs with.

A failure of the delete doesn't stop the removal (and the other way); the command exits 1 at the end.
`--output`: `{secretName, vault, appVault, mode: remove-old, oldSecret: deleted | kept, execution,
currentKeyId, removedKeyIds}`, written whenever step 3 ran. A job template that sets
`SAF_SECRET_ACTION` itself is refused in every mode (`SAF_SECRET_*` are set on start only).

Progress goes to stdout, one line per step (`job`, `password`, `job secret`, `execution`, `warn`,
`wait`) and a final `OK  easyauth-<slug> written to <vault> by execution <name> (keyId …, expires …)`
(rotate: `rotated in <vault> … ; <n> predecessor(s) removed`; remove-old:
`OK  remove-old easyauth-<slug>: deleted from <vault> by execution <name> | kept in <vault>; <n> predecessor(s) removed`).
Problems go to stderr, one line each, and exit 1; usage errors exit 2.

**SIGINT / SIGTERM** (Azure DevOps cancels the step: run cancelled or job timeout): the first
signal ends the request or wait in flight; step 6 then runs as usual, bounded to 60 s, and the
command exits 1 with `stopped by <signal>` first, followed by the cleanup's outcome. Further signals
are logged (`warn`) and don't cut the cleanup short; only the bound does. A job secret that a
cleanup could not remove is reported by the next run (`warn`) and replaced, then removed.
`TODO(verify)`: which process the agent signals (the CLI, or only the step's shell) and how long it
waits before it kills the step.

The value, the tokens and request bodies never reach stdout, stderr, the output file or an error
message: messages are built from fixed text, HTTP statuses and Azure error codes; Azure's error
message is quoted only for calls that don't carry the value, and every printed line also passes a
redaction of the value and both tokens. Tokens go only to the ARM and Graph endpoints, as an
`Authorization` header, https only (plain http only on a loopback host, for tests), without
redirects; operation URLs must stay on the ARM endpoint and in the job's subscription. Rights: the
Entra provisioning identity needs *Platform Job Secret Writer* on the job and ownership of the app
registration (ADR-0023, ADR-0035).

`Verify in sandbox: JOB-3` (PATCH semantics of `configuration.secrets`, where the value shows up,
whether the role reads the operation status) and `JOB-4` (start response, execution statuses,
cancellation signals).

### `platform provisioning easyauth-delete`

```text
platform provisioning easyauth-delete --job <ARM ID of the kvset job> --vault <vault name>
                --secret-name easyauth-<slug> --output <result.json>
```

[ADR-0061](../../docs/adr/0061-deleted-apps-view-and-slug-reuse.md) section 4: the delete phase of a
decommissioned app frees the name of its Easy Auth secret, so a new app with the same slug writes its
own. Called by the landing zone's delete (`azure_<env>`, `lz_secret_delete`, with the environment's
Azure provisioning identity's ARM token in `SAF_ARM_TOKEN`, as for `dbinit`) when the secret is in the
environment vault of the app's network mode. The job is checked as in step 1 of `easyauth-secret` and
must be a kvset job by its name (`caj-<prefix>-kvset-<ext|hyb|int>`); the start passes only
`SAF_SECRET_NAME` and `SAF_SECRET_ACTION=delete` (ADR-0060: no job secret, no value; saf-jobs
soft-deletes the secret, never purges it, and counts an absent one as done). The execution is polled
until it ends; only `Succeeded` is success, anything else exits 1 (the landing zone's record stays and
the next run tries again). `--output`: `{secretName, vault, job, execution, secret: deleted}`. No
Microsoft Graph call. `Verify in sandbox: DECOM-23`.

### `platform provisioning entra-removals` and `entra-reconcile`

```text
platform provisioning entra-removals --inputs <entra inputs json> [--record <entra-{slug}-{env} record>]
    --output <removals.json> [--disable-output <inputs.json>]
platform provisioning entra-reconcile --removals <removals.json> --inputs <entra inputs json>
    --unique-name <prefix-slug-env[--iN]> --output <result.json>
env (entra-reconcile): SAF_GRAPH_TOKEN (required, never an argument), SAF_GRAPH_ENDPOINT (optional,
     default https://graph.microsoft.com/)
```

Graph Bicep doesn't delete what a template stops declaring
([ADR-0033](../../docs/adr/0033-entra-stages-of-the-provisioning-pipeline.md), amended 2026-11-11).
`entra-removals` (stage `entra_plan`, pure) compares the record of the registration's last
deployment (`az deployment group show`) with the new inputs: the record's `roleAssignments`
(principal and role, the principal compared without case) and `appRoles` that the inputs no longer
have. Only what the platform declared can be listed; no `--record` lists nothing. It writes
`{prefix, slug, environmentName, assignments: [{principalId, role}], roles: [{value, displayName,
description, enabledInRecord}]}`, prints one `remove` line per item, and, when a retired role is
still enabled in the record, writes `--disable-output`: the inputs plus those roles with
`isEnabled: false`, the first of the two deployments. A record of another instance, app or
environment, or of another incarnation of the slug (ADR-0061 section 6: the record's parameter
`incarnation`, absent = 0, against the inputs'), an invalid entry, inputs without `incarnation` or
inputs that set `isEnabled` exit 1.

`entra-reconcile` (stage `entra`) deletes the listed assignments: `GET
applications(uniqueName='…')` (the app's own registration, never an ID from the record; `--unique-name`
must be `{prefix}-{slug}-{env}`, with `--i{incarnation}` of `--inputs` above incarnation 0), `GET
servicePrincipals(appId='…')`, `GET servicePrincipals/{id}/appRoleAssignedTo` (all pages, on the
Graph endpoint only), then `DELETE servicePrincipals/{id}/appRoleAssignedTo/{assignment}` for each
assignment of a User or Group with the listed principal and the listed role's ID, on that service
principal. An assignment `--inputs` still declares is never deleted (exit 1 before any call); one
already gone is reported as `absent`; a role the application doesn't have fails that removal. It
writes `{uniqueName, servicePrincipalId, removed, absent}`, also on a failure (exit 1). Permissions:
`Application.Read.All` and `AppRoleAssignment.ReadWrite.All` of the Entra provisioning identity
(ADR-0023). Nothing printed contains the token. `Verify in sandbox: ENT-3`.

### `platform provisioning entra-effect`

```text
platform provisioning entra-effect --base <app.yaml|none> --head <app.yaml|none>
    [--instance <instance.yaml>] [--output <effect.json>]
```

With `approvals.entraChanges: pullRequest` the reviewed `platform-config` pull request is the
approval of the Entra changes it causes ([ADR-0051](../../docs/adr/0051-one-approval-for-entra-changes.md)),
so the reviewers should see them. `entra-effect` compares two versions of an app definition (`none`
for a side without the file: a new app) on what the stage `entra` deploys from them: sign-in turned
on or off, registrations of environments added or removed (while sign-in is required), role
assignments (role, principal type, object ID) and the app's own app roles added or removed, and the
custom hosts whose redirect URIs change. It prints one line per change (or "no Entra change") and,
with `--output`, writes `{slug, entraChanges?, signIn, environments, assignments, roles, hosts,
changes}`. `--instance` adds how the change is approved. Pure and offline: the files are read as
YAML, not validated (`platform validate app` does that). The validation pipeline
(`\platform\validation`) can print it for every changed `app.yaml` of a pull request; it doesn't yet.

### `platform provisioning dbinit`

```text
platform provisioning dbinit --job <ARM ID of the dbinit job> --engine postgres|azureSql
    --host <server FQDN> --database <name> --principal-name <runtime identity name>
    --principal-id <its object ID> --principal-client-id <its client ID> --output <file>
env: SAF_ARM_TOKEN (required, never an argument), SAF_ARM_ENDPOINT (optional, default
     https://management.azure.com/)
```

The Azure stage's database step ([ADR-0028](../../docs/adr/0028-in-vnet-platform-jobs-for-private-endpoint-steps.md),
amended 2026-10-31): the `dbinit` job of the app's CAE creates the runtime identity's PostgreSQL role
and its grants, or its Azure SQL user in `db_owner` (`images/saf-jobs`, subcommand `dbinit`). Nothing
secret is involved: the inputs are names and IDs.

1. **Flags:** the job ID names a `caj-…-dbinit-…` job; `--engine` is `postgres` or `azureSql`;
   host, database and principal name have the shape of the platform's names. The job itself checks
   them strictly against its own instance prefix and environment.
2. **Check the job** (`GET`, api-version `2024-03-01`): manual trigger, exactly one container, no
   init containers, image `<registry>/saf-jobs@sha256:…`, no command override, args exactly
   `["dbinit"]`, plain env values only, `SAF_DB_ADMIN` set, none of the start variables, no job
   secrets. Anything else stops the command before the start.
3. **Start** (`POST <job>/start`) with the job's container and its env plus `SAF_DB_ENGINE`,
   `SAF_DB_HOST`, `SAF_DB_NAME`, `SAF_PRINCIPAL_NAME`, `SAF_PRINCIPAL_ID` and
   `SAF_PRINCIPAL_CLIENT_ID`.
4. **Wait** for the execution as `easyauth-secret` does (every 5 s, at most 10 minutes). Anything
   but `Succeeded` fails and points to the job's console logs, where the job names the step and
   the database's error (PostgreSQL SQLSTATE and message, or sqlcmd's `Msg` line).
5. **`--output`:** `{job, execution, status}`.

The token goes only to the ARM endpoint, and every printed line passes a redaction of it. Rights:
the Azure provisioning identity's Contributor role on its environment subscription (a 401 or 403
says so). `Verify in sandbox: JOB-2` (the role and grants on a real server), `JOB-4`.

### `platform environment` (platform pipeline)

```text
platform environment inputs --instance <instance.yaml> --env <name> --images <core images/images.json>
                            --pass 1|2 --output <environment.json>
platform environment portal-inputs --instance <instance.yaml> --env <portal.hostEnvironment>
                                   --images <core images/images.json> --pass 1|2|auto
                                   [--smtp-secret present|absent] --output <portal.json>
platform environment validate-run --instance <instance.yaml> --environment <name>
                                  --host-environment <name> --core-ref <ref>
platform environment roles-check --names <names snapshot.json> --roles <compiled roles.bicep json>
                                 --definitions <az role definition list json> --subscription <id>
platform environment compare --validate <validate.json> [--record <record.json>]
platform environment cae-network --names <names snapshot.json> --snapshot <environment.bicepparam snapshot.json>
                                 --live <caes.json> --output <verdicts.json>
```

Helpers of the platform pipeline `\platform\platform-<env>`
([ADR-0043](../../docs/adr/0043-platform-pipeline.md),
[pipelines](../../pipelines/README.md#platform-pipeline)). Pure: files in, files out, no Azure
calls; the pipeline's scripts (`pipelines/azure-devops/scripts/platform/`) make the calls.

- **`inputs`:** the JSON that `infra/platform/pipeline/environment.bicepparam` reads
  (`SAF_ENVIRONMENT_JSON`): the environment's `location`, `subscriptionId`, its network modes with
  the schema defaults resolved (`network`, `natGatewayPublicIpCount`, `dnsServers`,
  `useRemoteGateways`; `internalOnly` is refused), Front Door, log retention, alert emails, the
  hub, `portal.identityPrincipalId`, and the instance's `identities.entraProvisioningPrincipalId`
  (required: the `kvset` job's secret writer).
  Pass 1 (a new environment, no platform registry yet) leaves out the jobs; pass 2 adds the
  `saf-jobs` digest that `images.json` pins. GUIDs are lowercased. The examples
  `infra/platform/pipeline/examples/contoso-*.environment.json` are its output for
  `config/examples/instance.example.yaml`, and `check-infra.py` checks they predict the same
  resources as the hand-written environment examples.
- **`portal-inputs`** (ADR-0043 amendment 2026-11-14): the JSON that
  `infra/platform/pipeline/portal.bicepparam` reads (`SAF_PORTAL_JSON`), only for the portal host
  environment (`portal.hostEnvironment`; any other environment exits 1):
  - `tenantId` and `portal.network`; `routeTableId` is refused, as `portal.bicep` refuses it;
  - the four `scm.azureDevOps` fields the portal reads (`platformConfigDefaultBranch` defaulted);
  - the database: `data.postgres.sizes.S` and `version`, and `data.backup` of the host's kind;
  - the host's `vaultGeneration` and `environmentVault`: `private` when the host environment has a
    VNet-based CAE (`externalHybrid`, or `externalOnly` with `network: vnet`), else `public`: the
    environment vault of the portal's own secrets; the private one gets the portal-side private
    endpoint in `portal.bicep` (ADR-0025 amendment 2026-11-14);
  - `smtpPasswordSecretName`: `notifications.email.smtp.auth.passwordSecretName` with provider `smtp`
    and auth mode `basic`, else empty; `smtpPasswordSecretExists`: true only with `--smtp-secret
    present`, which the pipeline passes after reading the secret in that vault through ARM (a role
    on a secret needs the secret; absent is the default, and `present` without SMTP basic auth exits 1);
  - `productName`, `tags: {}`.

  Pass 1 leaves out the Container App (empty `portalImageDigest` and `portalClientId`). Pass 2 adds
  the `saf-portal` digest of `images.json` and `portal.clientId`, which it requires. `auto` is pass 2
  once `portal.clientId` is set, else pass 1. GUIDs are lowercased.
  `infra/platform/pipeline/examples/contoso-prod.portal.json` is its output for the example
  instance, and `check-infra.py` checks that it predicts the same resources as the hand-written
  portal example.
- **`validate-run`:** the run's `environment` and `hostEnvironment` parameters equal what
  `platform generate` renders (an environment of `instance.yaml`; `portal.hostEnvironment`), and
  the core ref is `refs/tags/<coreVersion>`.
- **`roles-check`** (the roles gate): the three custom roles of `infra/platform/roles.bicep`
  (`customRoles` of the names snapshot `platform-names.bicep`) exist in the subscription's role
  definitions with exactly the actions and data actions this core compiles (`appDeployerActions`,
  `appEnvironmentJoinerActions`, `platformJobSecretWriterActions` of the compiled template) and
  list the subscription as assignable scope. Anything missing or different exits 1 and names it;
  the pipeline never writes role definitions, a person deploys `roles.bicep`.
- **`compare`:** as `platform provisioning compare --kind environment`: `up-to-date`,
  `changed: <reasons>` or `new` against the deployment record (`platform-{prefix}-{env}`, and in the
  portal host `portal-{prefix}-{env}`), exit 0 in all three cases.
- **`cae-network`** (ADR-0043 amendment 2026-11-15, backlog US03.03): a Container Apps environment's
  network is fixed once the CAE exists. For each CAE of the names snapshot (`managedEnvironments` of
  `platform-names.bicep`: one per buildable mode, enabled or not), it compares the live
  `properties.vnetConfiguration.infrastructureSubnetId` (`--live`: a JSON list of `{mode, name,
  resource}`, `resource` being the raw `az resource show` or `null`; absent, null or empty = the
  Azure-managed network) with the one `environment.bicep` would deploy (`--snapshot`: the predicted
  CAEs of `bicep snapshot` of `infra/platform/pipeline/environment.bicepparam` with the run's
  inputs), case-insensitively. It writes the verdict per CAE (`new`, `unchanged`, `refused`,
  `not-enabled`, `absent`) to `--output` and exits 1 with one line per existing CAE whose network
  type or subnet would change: the CAE, its network now, the network `instance.yaml` asks for, and
  the runbook `docs/runbooks/change-external-only-network.md`. A new CAE is never refused; a CAE of a
  mode no longer enabled is reported, not compared. Fails closed (exit 1) on a CAE the snapshot
  predicts that the names don't list, a predicted subnet that isn't a resource ID, or a missing live
  entry. A live subnet of an unexpected shape is never quoted back.

### `platform instance` (onboarding)

```text
platform instance inputs <template> --instance <instance.yaml> [state files] [--output <file>]
    bootstrap --env <name> --pass 1|2 [--outputs <host>=<file>] [--federation <file>]
    roles
    entra-permissions --outputs <host>=<file>
    portal-registration --outputs <host>=<file> --portal-outputs <file> [--dev-redirect-uri <uri>]...
    entra-audit-alert --outputs <host>=<file> --platform-outputs <file>
                      [--workspace <id> --workspace-location <region>] [--action-group <id>]...
platform instance sync --instance <instance.yaml> --outputs <host>=<file> [--registration <file>] [--portal-outputs <file>] [--write]
platform instance facts --instance <instance.yaml>
```

The templates a person runs while onboarding an instance
([ADR-0066](../../docs/adr/0066-instance-onboarding-from-instance-yaml.md),
[onboard an instance](../../docs/runbooks/onboard-instance.md)). Pure: files in, JSON out, no Azure calls;
`infra/platform/instance/instance.sh` reads the state from Azure and Azure DevOps and runs `az`.

- **`inputs`** prints the JSON `infra/platform/instance/<template>.bicepparam` reads (`SAF_INSTANCE_JSON`;
  `--output` writes it to a file), schema defaults resolved, GUIDs lowercased. State files:
  `--outputs <env>=<file>` the outputs of `bootstrap-{prefix}-{env}` (`az deployment sub show --query
  properties.outputs`, or the whole `show`; tenant and subscription must be the instance's), `--federation`
  the `--output` of `platform ado bootstrap plan|apply --phase connections`, `--portal-outputs` and
  `--platform-outputs` the outputs of `portal-{prefix}-{host}` and `platform-{prefix}-{host}`. A template
  that needs a missing file fails (exit 1) with what to run first.

  | Template | Parameters and where they come from |
  |---|---|
  | `bootstrap` | `prefix`; `environmentName`; `location` (`region` ?? `defaultRegion`); `instanceIdentities` (the environment is `portal.hostEnvironment`); `entraEnvironments` (every environment, list order, in the host; `[]` elsewhere); `federation` (`{}` on pass 1; on pass 2 the environment's `provisioning` and, in the host, `adoAutomation` and `entra` from `--federation`, each required: a connection that doesn't exist yet fails); `instancePrincipals` (`{}` in the host; elsewhere the host's outputs `portalIdentity.principalId` and `entraProvisioningIdentity.principalId`); `managedBy` (`productName`); `tags` (`{}`) |
  | `roles` | `prefix`; `environmentSubscriptionIds` (every environment's, list order, each once) |
  | `entra-permissions` | `entraProvisioningPrincipalId` (the host's output `entraProvisioningIdentity.principalId`) |
  | `portal-registration` | `prefix`; `environmentName` and `environmentKind` (the host's); `productName`; `caeDefaultDomain` (`managedEnvironmentDefaultDomain` of `--portal-outputs`); `devRedirectUris` (`--dev-redirect-uri`, a nonprod host only); `platformAdminsGroupId`, `platformTeamGroupId` (`platformAdmins.objectId`, `approvals.platformTeam.objectId`); `tenantId`; `portalIdentityPrincipalId` (the host's output `portalIdentity.principalId`) |
  | `entra-audit-alert` | `prefix`; `location` (the host's region, or `--workspace-location`); `workspaceResourceId` (`--workspace`, else `logAnalyticsWorkspaceId` of `--platform-outputs`); `entraProvisioningPrincipalId`; `actionGroupIds` (`platformActionGroupId` of `--platform-outputs`, then each `--action-group`: the identity team's); `tags` (`{ManagedBy: productName}`) |

  `infra/platform/instance/examples/` holds the output for `config/examples/instance.example.yaml` and the
  state of `test/fixtures/instance/`; the tests compare them, and `check-infra.py` compiles each parameter
  file with it.
- **`sync`** sets `identities.entraProvisioningPrincipalId` and `portal.identityPrincipalId` from the host's
  bootstrap outputs, `portal.clientId` from `--registration` (the outputs of `entra-portal-{host}`; without
  it `portal.clientId` stays) and `portal.apiBaseUrl` from `--portal-outputs` (`https://` and `portalFqdn` of
  `portal-{prefix}-{host}`), only while it is not set: a value set by hand is `kept` and reported with the
  portal's own host name. It prints each value (`unchanged`, `<old> -> <new>`, `kept`, `not available`) and,
  with `--write`, edits `instance.yaml` in place: a value is replaced in the source text, a missing key is
  added first in its section (a missing section at the end), every other byte stays, comments included.
  GUIDs compare case-insensitively; a result that fails the schema is not written.
- **`facts`** prints `key=value` lines for `instance.sh`: the subscriptions and regions, the organisation,
  the platform project and the git URL of its repository `core` (`coreRepositoryUrl`, the project
  URL-encoded), `coreVersion` and `coreReleases.repository` (`coreReleasesRepository`, empty when unset;
  ADR-0067), `portal.apiBaseUrl` (`portalApiBaseUrl`, empty when unset: where `status` reads `/readyz`, ADR-0072),
  `approvals.entraChanges`, `dns.zones` (and, for `instance.sh dns`, each Azure DNS zone's
  `azureDnsZoneId`, the subscription and resource group in it, empty when it isn't that zone's ID, and its
  `allowedEnvironments`), the Container Apps environments the instance puts in each
  subscription and region, the database engines each subscription and region must allow (`databases.*`:
  PostgreSQL for the portal in the host, and each engine `data` enables), and the names of the deployments, groups and lock it reads or touches (from
  the ports of `naming.bicep`; the human-run deployments `bootstrap-{prefix}-{env}`, `roles-{prefix}`,
  `entra-permissions` and `entra-audit-alert` as `infra/README.md` names them).

### `platform instance plan` and `status` (the onboarding plan)

```text
platform instance plan [--instance <instance.yaml>] [--format text|markdown|json] [--lang en|cs]
platform instance plan --format markdown --update <file>
platform instance status --instance <instance.yaml> [--state <dir>] [--format text|json] [--lang en|cs]
```

The onboarding plan of [ADR-0072](../../docs/adr/0072-onboarding-plan-status-and-ai-guide.md): one definition,
`src/onboarding/plan.ts`, browser-safe and exported as `@simple-apps-foundry/platform-cli/onboarding` (the portal's
setup wizard reads the same steps). Two phases: `base` (the base deployment with `instance.sh`, steps B01 to B32) and
`setup` (the initial platform configuration in the portal's setup wizard or an AI chat, [ADR-0073](../../docs/adr/0073-platform-setup-wizard.md):
S01 the portal's email, then S02 to S05, each with the Settings cards it shows (`settings`: card ID, section, title,
`instance.yaml` keys) and `skippable`; their progress is `instance.yaml` `setup.confirmed` and `setup.skipped`). Each step has a stable ID
(never renumbered or reused; the list order is the order), a title in English and Czech, its actor, the right it needs,
its commands (`changes: true` on the ones that change something), a pipeline run or an action, its gates
(`pullRequest`, `pipelineApproval`, `adminConsent`), its runbook section, its dependencies (earlier steps), the
`instance.yaml` keys it sets, an optional condition (`onlyWhen`) and its check (below). `test/onboarding.test.ts` pins
the IDs and checks the dependencies, the runbook anchors and both languages.

- **`plan`** prints every phase and step. Pure: with `--instance` it fills `<host>` and `<prefix>` and lists a
  per-environment step once per environment, the portal host first. `--format markdown` is the checklist of
  [onboard an instance](../../docs/runbooks/onboard-instance.md#step-by-step), and `--update <file>` rewrites the
  checklist between the file's markers `<!-- onboarding-plan:start ... -->` and `<!-- onboarding-plan:end -->` (a test
  fails while the runbook's is stale). `--format json` is the definition.
- **`status`** evaluates each step against instance.yaml and the state directory that `instance.sh status` reads into
  (`--state`; without it every step that needs Azure or Azure DevOps is `unknown`): `done` (its check passes, or it is
  not needed), `next` (the exact commands, or an action), `waiting` (on whom), `blocked` (by which earlier step) or
  `unknown` (what could not be read, and why). A `confirmed` step (nothing records it) is done once a step that depends
  on it is; until then its dependents go on and name it in `assumes`. The report ends with the current phase, the
  current step (the first one not done) and the next step (the first one `next`); `--format json` has every step with
  its `reason`, `commands`, `details`, `waitingOn`, `blockedBy`. An invalid instance.yaml is step B01 with its problems
  (exit 0). The `platform ado bootstrap plan` rows are read with `parseItemRows` (`src/ado/steps.ts`, the inverse of
  `formatItems`).

  The state directory (each file optional; a missing one is "not read"): `azure` (`ok`, `not-logged-in`,
  `other-tenant <tenant>`); `providers/<subscription>.missing` (the required providers it lacks) or `.error`;
  `deployments/<name>.json` (`{state, outputs, federation}`, one `az deployment ... show` of it), `.absent` or `.error`;
  `dns/<zone>.exists|.absent|.error`; `dnsroles/<zone>/<env>.ok|.missing|.error`; `ado/token.error`,
  `ado/<phase>.rc|.log|.json` (the plan's exit code, rows and `--output`) or `ado/<phase>.skipped`; `portal/url`,
  `portal/readyz` (the HTTP status) or `portal/readyz.error`; `audit-alert-workspace`. App definitions are read from
  `apps/` next to the instance file.

| Check | Done when |
|---|---|
| `instance-valid` | instance.yaml passes `platform validate instance` |
| `confirmed` | nothing records it: done once a step that depends on it is done |
| `login` | `az` is logged in to `tenantId`, and every environment subscription's resource providers can be read |
| `providers` | no environment subscription lacks a resource provider of [infra/README → subscription prerequisites](../../infra/README.md#subscription-prerequisites) |
| `network-approvals` | `portal.network.approvalReference` is set, and every `externalHybrid` environment has `egressBaseline.status: active` |
| `dns-zones` | every `azureDns` zone of `dns.zones` exists at its `azureDnsZoneId` |
| `ado-projects`, `ado-config`, `ado-grants`, `ado-policies` | that phase's plan shows no `create`, `update` or `blocked` row |
| `core-tag` | `--phase core` likewise, and `core` has the tag `coreVersion` |
| `bootstrap-host`, `bootstrap-others` | `bootstrap-{prefix}-{env}` succeeded in the host, in every other environment |
| `dns-roles` | each allowed environment's provisioning identity holds DNS Zone Contributor, Contributor or Owner on each Azure DNS zone or above |
| `instance-principals` | `identities.entraProvisioningPrincipalId` and `portal.identityPrincipalId` are the host bootstrap's outputs, and that instance.yaml is on the default branch (`--phase config`: "equals") |
| `deployment-entra-permissions`, `deployment-roles`, `deployment-portal`, `deployment-portal-registration` | `entra-permissions`, `roles-{prefix}`, `portal-{prefix}-{host}`, `entra-portal-{host}` succeeded |
| `ado-connections` | `--phase connections` shows no `create` or `update` row and reads back every connection's issuer and subject |
| `bootstrap-federation` | each environment's bootstrap was deployed with the federation (its parameter `federation`) the connections have now |
| `ado-pipeline` | `--phase pipeline` finds every platform pipeline and shows no `create`, `update` or `extra` row (with `approvals.entraChanges: separate`, no `blocked` row either) |
| `entra-pull-request` | `--phase connections` and `--phase pipeline` show no `create`, `update`, `extra` or `blocked` row |
| `deployment-platform` | `platform-{prefix}-{env}` succeeded in every environment |
| `deployment-audit-alert` | `entra-audit-alert` succeeded next to the host's platform workspace (or `instance.sh status --workspace`) |
| `instance-portal` | `portal.clientId` is the registration's `clientId`, `portal.apiBaseUrl` is set, and that instance.yaml is on the default branch |
| `portal-app` | the portal deployment's output `containerApp` is set |
| `portal-ready` | `/readyz` answers 200 at `portal.apiBaseUrl`, else at `https://` and `portalFqdn` |
| `first-app` | `apps/{slug}/app.yaml` exists next to instance.yaml |
| `email-setting` | instance.yaml has `notifications.email`, and that instance.yaml is on the default branch |
| `setup-step` | `setup.confirmed` or `setup.skipped` names the step (confirmed wins), and that instance.yaml is on the default branch; a skipped step is `done` with `skipped: true` (text: `skipped`; `phases[].skipped` counts them) |


### `platform ado plan|apply`

```text
platform ado plan|apply --instance <instance.yaml> --app <apps/<slug>/app.yaml> --phase resources|pipelines
                        --org-url https://dev.azure.com/<org> [--env <name>]... [--lz-outputs <env>=<file>]...
                        [--templates <core>/templates] [--output ado-outputs.json] [--resave]
```

The Azure DevOps objects of one app (provisioning plan §4, ADR-0022, ADR-0039). `plan` only reads and prints
one line per object, `create`, `update`, `ok`, `extra` (something the platform doesn't own:
reported, and for pipeline authorisations and branch creator rights revoked by `apply`), `warn` (reported, never changed) or
`blocked` (can't be planned, exit 1). `apply` does the same reads and then the changes, object by
object (GET, compare the subset the platform owns, POST/PATCH/PUT only on a difference). It never
deletes anything. Run it twice and the second run changes nothing (the pipeline phase only
re-runs the preview). Exit 3 (`apply`): the only open rows wait for a person (ADR-0039 H3, below);
provisioning marks the app `waiting` then, not failed.

| Phase | Objects |
|---|---|
| both | resolve: platform project, the app repo's project, the app repo (phase `resources`: may be missing), `{platformProject}/core`, the platform-config repo |
| `resources`: the app repository (ADR-0039), first | only with `repository.template`; without it the repository is unmanaged as before ADR-0039 (it must exist; no caller lookup, nothing granted, pushed or opened). The caller (`_apis/connectionData`, then its descriptor from the Identities API: the ADO automation identity in the pipeline) holds rights on the repository only while it needs them: each is granted right before its push or pull request (through its Manage permissions, on this repository's tokens only) and removed at the end of the same run (`cleanup`: its own entries cleared, denies kept), together with the branch creator rights its pushes gave it (Contribute, Force push, Manage permissions, Remove others' locks; branch tokens `refs/heads/{hex UTF-16LE}/`). **Stack** (`node-ts`, `python-fastapi`, `dotnet`): `repository` is created (`POST {project}/_apis/git/repositories`) when missing, only in `scm.azureDevOps.appsProject` (elsewhere blocked); an empty one is adopted; one with content is used only when the caller itself created its default branch (Pushes - List by `pusherId`: a push of that ref with `oldObjectId` 0, the seed), otherwise blocked: a repository provisioning didn't create is never adopted. While it is empty: Contribute and Create branch on `repoV2/{projectId}/{repoId}`, then `seed`: one REST push (`oldObjectId` 40 zeros, base64 changes) that creates `refs/heads/{defaultBranch}` with the starter, rendered by the code of `platform repo render` from the core checkout's `templates/` (`--templates`, default the one next to the CLI), including the theme files of the app's `ui.theme` (ADR-0044; the row and the commit message name the theme). **byo** (`repository.template: byo`): the repository must exist (missing: blocked; empty: `warn`). `onboarding`: nothing when a pull request from `platform/onboarding` exists (open, completed or abandoned: never re-opened) or when nothing would change; otherwise the onboarding files (agent files, skills and their mirror, `platform.yaml`) rendered against the repository's own files in the render scope (create never overwrites, mergeLines appends, managed rewrites, AGENTS.md keeps its `app-notes`), pushed as `platform/onboarding` from the default branch's head, and a pull request into the default branch; for that only, Contribute to pull requests on the repository and Create branch + Contribute on the folder `refs/heads/platform/` (never the default branch). An existing `platform/onboarding` without a pull request is reused only when every push to it is the caller's and it differs from the default branch by exactly the current render (blob IDs); otherwise blocked (delete the branch, the next run pushes it again) |
| `resources`: then | build service identity `{platformProject} Build Service ({org})` (descriptor `...ServiceIdentity;…:Build:{platformProjectId}`); prod approvers (`approvals.platformTeam`, found by display name and accepted only when the organization's Graph group has the same Entra object ID as `originId`; the group must be a member of some Azure DevOps group, ADO-23); per environment: service connection `sc-{slug}-{env}` (workload identity federation, the delivery identity from `--lz-outputs`, the environment's subscription; issuer and subject read back), environment `{slug}-{env}`, checks; Git Read on the app repo and View on its project for the build service; Contributors' role on environments (Reader, ADO-20); the project's pipeline settings "Limit variables that can be set at queue time", "Limit job authorization scope to current project for non-release pipelines" and "Protect access to repositories in YAML pipelines" (`enforceSettableVar`, `enforceJobAuthScope`, `enforceReferencedRepoScopedToken`; set by `ado bootstrap --phase policies`) and Contributors' role on service connections (asserted, `warn` only) |
| `pipelines` | `\apps\delivery-{slug}` (YAML `apps/{slug}/delivery.yml` in platform-config; created, then `POST …/preview` must succeed, then the build definition is saved unchanged, see ADO-24 below); pipeline permissions on the app's connections and environments (only this pipeline, open access off), on the app repo and on the core repo (this pipeline added, others kept). The app repo (ADR-0039 decision 4), with `repository.template`: `allPipelines` false and only this pipeline, other pipelines revoked, but another app's `\apps\delivery-*` on it is never revoked (blocked: one repository per app); a stack repository only when provisioning created it (as in phase `resources`), and if it was opened to all pipelines it is closed again; a byo repository open to all pipelines (from before ADR-0039) is left as it is. H1: the caller grants itself Contribute on the repository for the call and restores its entry right after; if Azure DevOps answers 403, a `blocked` row that waits for a project administrator (H3, exit 3: they run this phase with their own token, or choose Permit on the waiting run); rights are never escalated. Without `repository.template`, as before ADR-0039: this pipeline added, others kept, no grant. Contributors denied Queue builds on the `\apps` folder |

Checks per resource (types and payloads from the sandbox, ADO-12): Required template
(`{platformProject}/core`, `refs/tags/{coreVersion}`, `pipelines/azure-devops/app-delivery.yml`)
on every connection and environment; Exclusive lock on every environment; for prod-kind
environments Approval (platform team, requester can't approve unless `approvals.allowSelfApproval`,
ADR-0034, 7 days) on the environment and
Branch control (`evaluatebranchProtection`, `refs/heads/{platform-config default},refs/heads/{app
default},refs/tags/v*`) on the connection and the environment. Checks of other types are reported
as `extra` and left in place. A core upgrade shows up as `update` of every Required template.
A check on a connection or environment this run created is retried on HTTP 403 for about 90 s:
Azure DevOps gives the creator Administer on a new connection, but not at once (sandbox).

- **Delivery identity:** `--lz-outputs <env>=<file>` per environment (phase `resources`), the
  landing zone's deployment outputs (`az deployment sub show -n lz-{slug}-{env} --query
  properties.outputs`, or `{"deliveryIdentityClientId": "<guid>"}`).
- **Token:** `AZURE_DEVOPS_TOKEN` (a human: `az account get-access-token --resource
  499b84ac-1321-427f-aa17-267ca6975798`) or `SYSTEM_ACCESSTOKEN` (the automation identity's token
  in the pipeline). It goes only into the Authorization header; requests go only to
  `https://dev.azure.com/{org}/`, `https://vssps.dev.azure.com/{org}/` and (bootstrap grants only)
  `https://vsaex.dev.azure.com/{org}/` (`--org-url` must equal
  `scm.azureDevOps.organizationUrl`), redirects are refused and response bodies are never echoed.
- **API versions** are pinned in `src/ado/api-versions.ts`; names come from `src/ado/names.ts`,
  which a test compares with `naming.bicep`.
- **ADO-24 (verified):** a pipeline created through `POST _apis/pipelines` doesn't register its
  app repo trigger, even with valid YAML and a successful preview; a push starts nothing. Saving its
  build definition unchanged (`GET` then `PUT {project}/_apis/build/definitions/{id}`, the revision
  must go up) registers it. `apply` does this after every create; `apply --phase pipelines --resave`
  does it for an existing pipeline (`plan --resave` shows it as `update`).
- **Outputs** (`--output`): `{organization, project, slug, repository: {id, name, project, template,
  created, seeded, pullRequestId} | null, environments: {<env>: {serviceConnection: {id, name, issuer,
  subject}, environment: {id, name}}}, pipeline: {id, name, folder}}` (`repository` in phase
  `resources`; `pullRequestId` is the byo onboarding pull request).
- Open points (`TODO(verify)` in `src/ado/plan.ts`): ADO-9 (`ensureProtectionOfBranch` stays false until branch policies are part of
  onboarding), ADO-2 (a PUT that changes `serviceprincipalid` keeps issuer and subject), the
  `\apps` folder token `{projectId}/apps` of the Build namespace, which project roles on service
  connections matter. ADR-0039 (`src/ado/plan.ts`, `src/ado/git.ts`, `src/ado/api-versions.ts`):
  ADO-25 (`_apis/connectionData` `7.1-preview.1`, the rights on a repository created by REST, the
  branch creator entry, the branch token form: lower-case hex, trailing slash, and the ref updates
  in Pushes - List that tell a seeded repository), ADO-26 (H1: Contribute is enough to authorise
  the delivery pipeline, and the authorisation stays when the temporary Contribute is removed; else
  H2 needs an ADR amendment, H3 stays the runbook step), ADO-27 (the seed push of a rendered stack), ADO-28 (the byo pull request;
  the Items API returns text content byte for byte).

### `platform ado bootstrap plan|apply`

```text
platform ado bootstrap plan|apply --instance <instance.yaml> --org-url https://dev.azure.com/<org>
                                  --phase projects|core|config|connections|pipeline|grants|policies [--identities <env>=<file>]...
                                  [--output <file>] [--resave]
```

The platform's own Azure DevOps objects (ADR-0031, ADR-0032), run once by a human with their own
token (`AZURE_DEVOPS_TOKEN`), before the provisioning pipeline exists. Same client, output format,
statuses and exit codes as `platform ado plan|apply`; `plan` only reads. `--identities` are the
outputs of `infra/platform/bootstrap.bicep` per environment subscription (`az deployment sub show
-n <deployment> --query properties.outputs`, or the whole `show` output); their tenant and
subscription must be the instance's. `entraProvisioningIdentity`, `entraResourceGroup` and
`portalIdentity` are optional (null without `instanceIdentities`, absent in outputs of older core
versions; `entraEnvironmentResourceGroups`, ADR-0063, isn't read); without the Entra identity in the host environment's outputs, `sc-platform-entra` is a
blocked row; without the portal identity, `grants` shows a `warn` row and grants the portal nothing.

| Phase | Needs | Objects |
|---|---|---|
| all but `projects`, `core` and `config` | | platform project, `core`, platform-config; platform-config's default branch must be `refs/heads/{platformConfigDefaultBranch}` (else exit 1) |
| `projects` | *Create new projects* in the organization (Project Collection Administrators have it) | ADR-0069: `scm.azureDevOps.platformProject` and `appsProject`, each created when missing (`POST _apis/projects`: private, Git, the organization's default process from `_apis/process/processes`, a description naming its role; the creation is an operation, polled through `_apis/operations/{id}` for about three minutes). An existing project is only read: `ok`, or a `warn` row when it isn't private or isn't `wellFormed`. `allowedProjects` are app teams' existing projects: checked, never created (a missing one is blocked). Then `approvals.platformTeam` known to Azure DevOps (ADO-23): found as for the Approval checks, else added to `[{platformProject}]\Readers` (Graph Groups - Create, `originId` and `groupDescriptors`), never removed. Reads nothing else, so it runs first |
| `config` | a Project Administrator of the platform project | ADR-0069: the platform project only. `scm.azureDevOps.platformConfigRepo` created when missing (Git repositories API). While it has no ref, one commit (Pushes - Create, `oldObjectId` zero) on `refs/heads/{platformConfigDefaultBranch}`: `instance.yaml` (the `--instance` file, byte for byte) and the files of `platform generate` (`pipelines/provisioning.yml`, `pipelines/validation.yml`, `pipelines/platform-{env}.yml`); the repository is read again right before the push, and one with a ref is never pushed to. With commits: a default branch other than the configured one is blocked; `instance.yaml` on that branch (Items API at its head) equal to the file is `ok`, different or missing a `warn` row (change it through a pull request) |
| `core` | a Project Administrator of the platform project | ADR-0067: the platform project only (no platform-config). The repository `core`, which every pipeline reads at `refs/tags/{coreVersion}`: created when missing (Git repositories API), empty; the phase never pushes (`instance.sh core` does, then runs the phase again). **Create tag** for Project Administrators only: `[{platformProject}]\Contributors` and `[{platformProject}]\Build Administrators` keep no Create tag entry of their own on the project's all-repositories token `repoV2/{projectId}` (the default allow they pass on to every repository) or on core's `repoV2/{projectId}/{repoId}`; an allow or a deny there is an `update` row, removed on apply with Permissions - Remove (`DELETE _apis/permissions/{namespace}/{bit}`): never a deny, because a group's deny beats a person's allow and an administrator is also a Contributor (ADO-23). Create tag **denied** on core to the build service `{platformProject} Build Service ({org})` and `[{org}]\Project Collection Build Service Accounts`. **Force push** (which deletes and moves a tag) denied on each `v*` tag's own token `repoV2/{projectId}/{repoId}/refs/tags/{name as UTF-16LE hex}` (the tags read through the refs API) for `[{platformProject}]\Project Valid Users` and both build services; a deny on `refs/tags` itself has no effect (ADO-23). A group that can't be found blocks its rows. Bits by name (`CreateTag`, `ForcePush`) |
| `connections` | `--identities` for every environment; for `sc-platform-entra`, `approvals.platformTeam` (with `displayName`) resolvable in the organization (ADO-23) | `sc-platform-provisioning-{env}` (identity `provisioningIdentity`, the environment's subscription), `sc-platform-ado` (`adoAutomationIdentity` of `portal.hostEnvironment`, its subscription) and `sc-platform-entra` (`entraProvisioningIdentity` of `portal.hostEnvironment`, its subscription; ADR-0023): WIF, manual, subscription scope, not shared. Checks on each: Required template (`{platformProject}/core`, `refs/tags/{coreVersion}`, `pipelines/azure-devops/app-provisioning.yml`; on `sc-platform-provisioning-{env}` also `pipelines/azure-devops/platform-environment.yml`, ADR-0043, PLAT-1), Branch control (`refs/heads/{platformConfigDefaultBranch},refs/tags/v*`; `ensureProtectionOfBranch` as for the per-app checks, false until ADO-9), Exclusive lock. `sc-platform-entra` never exists without a person's approval (`approvals.entraChanges`, ADR-0051). With `separate` it gets an Approval check (first): approver `approvals.platformTeam`, resolved like the prod approvers of `ado plan`, the requester can't approve (unless `approvals.allowSelfApproval`, ADR-0034; a `warn` row while it is on), timeout 7 days. With `pullRequest` (the default) the phase reads the policies of platform-config's default branch: a Required reviewers policy, enabled and required, scope exactly that branch, every file, with the `approvals.platformTeam` group, the creator's vote not counting (unless `approvals.allowSelfApproval`), as `--phase policies` creates it, is an `ok` row (`policy  sc-platform-entra: approval by pull request review`), and an existing Approval check on the connection is an `extra` row `remove: approvals.entraChanges is pullRequest: ...`, deleted on apply (the only object `bootstrap` deletes). Without that policy the row is `blocked` (run `--phase policies`, then `--phase connections` again, or set `separate`; exit 1) and the connection keeps, or when new gets, its Approval check. If the group doesn't resolve, `sc-platform-entra` is a blocked row and is neither created nor changed; the other connections go on. ADR-0043: per environment, the Azure DevOps environment `platform-{env}` (the platform pipeline's deploy job) with the same Approval check (approver `approvals.platformTeam`, timeout 7 days) followed by Required template (`pipelines/azure-devops/platform-environment.yml` only), Branch control and Exclusive lock, for every environment kind; blocked, and neither created nor changed, while the approvers don't resolve. Then the project's Contributors at most **Reader** on its environments (ADO-20, as `ado plan` does for app projects: a run can't create a missing environment, without checks, on first use) |
| `pipeline` | | `\platform\provisioning` from `pipelines/provisioning.yml`, `\platform\validation` from `pipelines/validation.yml` (ADR-0040, written by `platform generate`; no service connection) and `\platform\platform-{env}` from `pipelines/platform-{env}.yml` per environment (ADR-0043) (create, preview, re-save as for delivery pipelines, ADO-24; `--resave` for existing ones); pipeline permissions: `sc-platform-provisioning-{env}` for `\platform\provisioning` and `\platform\platform-{env}` exactly (any other pipeline is removed), the environment `platform-{env}` for `\platform\platform-{env}` only. The platform pipeline gets the connection and the environment only while `platform-{env}` exists with an Approval check with an approver (the connection has no Approval of its own): otherwise a blocked row, the environment's authorisations and the platform pipeline's on the connection are withdrawn, and the connection stays authorised for `\platform\provisioning`. A platform pipeline that can't be created yet (`pipelines/platform-{env}.yml` not generated) fails its own row and leaves `\platform\provisioning` authorised; every other platform connection (`sc-platform-ado`, `sc-platform-entra`; a missing one is blocked, "run --phase connections first") for `\platform\provisioning` only, `sc-platform-entra` only while it has an Approval check with an approver and `requesterCannotBeApprover` (or `approvals.allowSelfApproval`) or, with `approvals.entraChanges: pullRequest`, while platform-config's default branch has the platform team's required review described under `connections` (otherwise blocked, and every authorisation it had is withdrawn, ADR-0033, ADR-0051); the core repo open to every pipeline of the platform project (ADR-0031); a Contributors deny on queueing in `\platform` left by an older core is removed |
| `grants` | `--identities` for the host environment | ADO-1: `id-{prefix}-ado-automation` as an organization user with Basic access (member entitlement API, `vsaex.dev.azure.com`), Creator on the platform project's service connections and environments, on `\apps` (Build namespace) view, create, edit, delete (`DeleteBuildDefinition`, the delete phase of a decommissioned app, ADR-0022 amended 2026-11-12) and queue pipelines and administer their permissions, Read and Manage permissions on the repos of `appsProject` and `allowedProjects` (`repoV2/{projectId}`), **Create repository** on `appsProject` only (ADR-0039), Read and Manage permissions on `core`, Read on platform-config, View on those projects. ADR-0036, ADR-0040: `id-{prefix}-portal` (`portalIdentity`) gets **Read** and **Contribute to pull requests** (`GenericRead`, `PullRequestContribute`) on platform-config, **Create branch** and **Contribute** (`CreateBranch`, `GenericContribute`) on the branch folder `portal/requests/` only (token `repoV2/{projectId}/{repoId}/refs/heads/70006f007200740061006c00/72006500710075006500730074007300/`, each name part hex-encoded UTF-16LE) and **View project-level information** (`GENERIC_READ`) on the platform project, nothing else (without the project permission the Git APIs answer 404): no permission on `main`, no bypass, Edit policies or Manage permissions. An organization administrator adds it to the organization (Basic) first; the CLI never does, and until then it is one blocked row while the rest of the phase goes on. An access level below Basic or an explicit deny of Read is blocked. Any other bit on its platform-config or `portal/requests/` entry is an `extra` row and is removed on apply; entries on `repoV2/{projectId}`, `repoV2` or platform-config's default branch are `extra` rows left for a human to remove. The repository setting *Permissions management* (a branch's creator gets Manage permissions on it) must be off for platform-config; Azure DevOps documents no API for it, so it is a `warn` row with the manual step (Project settings > Repositories > platform-config > Settings), and its effect is checked: the portal's Manage permissions on a branch below `portal/requests/` (`recurse=true` ACL query) is an `extra` row and removed on apply. ADR-0037, ADR-0040: the portal identity also gets **View builds** (`ViewBuilds`) on `\apps` and `\platform` (Build tokens `{projectId}/apps`, `{projectId}/platform`, inherited by every pipeline there), to read the runs, timelines and artifacts behind deploy events and the request journey (`\platform\provisioning`); not *View build pipeline* (`ViewBuildDefinition`), since the run's own `definition` reference names the pipeline and folder. ADR-0042: on `\apps` it also gets **Queue builds** (`QueueBuilds`), to queue the `action: redeploy` runs people ask for in the portal (rollbacks, production requests); nothing on `\platform` but View builds. Other bits on those entries are `extra` and removed on apply, an explicit deny of View builds or Queue builds is blocked, and an entry on the project's all-pipelines token `{projectId}` is an `extra` row left for a human |
| `policies` | `--phase pipeline` first (`\platform\validation`); `approvals.platformTeam` resolvable (ADO-23); a person with *Edit policies* (and Project Administrator for the settings) | First the platform project's pipeline settings, so a job token (a validation run of a pull request's own YAML included) reaches only this project and the repositories the pipeline references: `enforceJobAuthScope`, `enforceReferencedRepoScopedToken`, `enforceSettableVar` (Build General Settings, `PATCH {project}/_apis/build/generalsettings` on apply; a refusal fails the row with the manual step), and the build service `{platformProject} Build Service ({org})` with no more than Read on `core`, platform-config, the project's and the organization's all-repositories tokens (more is an `extra` row, only reported). Then ADR-0040, on platform-config's default branch (scope: that repository and ref, `exact`), each enabled and required: **Minimum reviewers** (`fa4e907d-…`: `minimumApproverCount` 1 or a stricter existing count, `creatorVoteCounts` = `approvals.allowSelfApproval` (a `warn` row while it is on), `resetOnSourcePush`, `blockLastPusherVote`, `allowDownvotes` false), **Required reviewers** (`fd2167ab-…`: the platform team group, `creatorVoteCounts` as above; and a second one limited to `/pipelines/*` with its own message, because the build validation runs the pull request's own `pipelines/validation.yml`, so its result proves nothing for such a change) and **Build validation** (`0609b952-…`: `buildDefinitionId` of `\platform\validation`, required but **queued by hand** (`manualQueueOnly`): it runs the pull request's own `pipelines/validation.yml`, so a branch the portal pushed runs only after a reviewer has read it; `queueOnSourceUpdateOnly`, valid 12 hours after main changes or a shorter existing validity; anything weaker is an `update`). A policy that is disabled, optional, limited to some files or has other settings is an `update`; other policies on the branch are `extra` rows left in place; with the pipeline or the group unresolved, that row is blocked and an existing policy is left as it is |

- `--output`: `connections` writes `{organization, project, connections: {<name>: {id, name, issuer,
  subject, identityClientId, subscriptionId}}, federation: {<env>: {provisioning: {issuer, subject}
  | null, adoAutomation?: ..., entra?: ...}}}` (`adoAutomation` and `entra` in the host environment
  only); `federation` is the `federation` parameter of bootstrap pass 2,
  read back from Azure DevOps, never computed (also printed). `connections` also writes `platformEnvironments: {<env>: {id, name} | null}`. `pipeline` writes `{organization,
  project, pipeline: {id, name, folder}, validationPipeline: {id, name, folder}, platformPipelines:
  {<env>: {id, name, folder} | null}}`, `grants`
  `{organization, project, identity: {originId, id, descriptor} | null, portalIdentity: {originId,
  id, descriptor} | null}`, `policies` `{organization, project}`, `core` `{organization, project, core:
  {repository: {id, name} | null, tags: [<v* tag>...]}}` (`repository` null in a plan while it is missing), `projects`
  `{organization, project: {id: "", name: ""}}`.
- Action bits are read by name from `GET _apis/securitynamespaces/{id}` and role names from
  `GET _apis/securityroles/scopes/{scope}/roledefinitions` at run time; a missing name blocks the row.
- Open points (`TODO(verify) ADO-1` in `src/ado/bootstrap.ts`): the exact grant set (whether the
  role assignments already make the identity a project member, what authorising a pipeline on a
  repository needs, the folder tokens `{projectId}/apps` and `{projectId}/platform`), and that a
  managed identity added through `serviceprincipalentitlements` (`accountLicenseType: express` =
  Basic) can call the REST API. Exclusive lock on service connections and Branch control with
  `ensureProtectionOfBranch: true` (needs a branch policy on platform-config's default branch) are
  to be confirmed in the sandbox too. PORTAL-3 (`TODO(verify)` in `src/ado/bootstrap.ts`): that Read
  on the repository is enough for the portal's Git Items API calls without *View project-level
  information*, and permissions the portal identity inherits from groups, which its own entries don't show.
  PORTAL-9: that *View builds* on `\apps` alone lets the portal read a run, its timeline and its
  artifacts, and that it can't read other folders. PORTAL-16: that *Queue builds* with View builds
  and View build pipeline on `\apps` lets it queue a delivery pipeline through the Runs API with
  template parameters, and nothing in `\platform`. PORTAL-11 (`TODO(verify)` in `src/ado/bootstrap.ts`, `src/ado/git.ts`): the
  portal's refusals (branches outside `portal/requests/`, a push to `main`, a merge, a policy
  change), the folder token form, and the policy settings not shown in the Learn samples
  (`resetOnSourcePush`, `blockLastPusherVote`, `allowDownvotes`, `creatorVoteCounts` on required
  reviewers, the build policy's `queueOnSourceUpdateOnly`, `manualQueueOnly`, `validDuration`).

## Library (for the portal)

The package entry (`exports["."]`, ESM, types in `dist/src/index.d.ts`) holds the functions the
portal shares with the CLI (ADR-0040 decision 1). They are pure: text in, values out, no file
access beyond the bundled schemas, no `process.exit`, no console output. The portal depends on the
package as `"@simple-apps-foundry/platform-cli": "file:../tools/platform-cli"`; build the CLI first
(`npm ci && npm run build`), since the entry points into `dist/`.

| Export | What it is |
|---|---|
| `validateAppDefinition(instanceYamlText, appYamlText, opts?)` → `{ ok, problems, destructive, app? }` | exactly `platform validate app <path> --instance` (the same `validateAppText`). `problems[]`: `{ source: "app" \| "instance", kind: "syntax" \| "schema" \| "rule", path, message, line?, column?, help? }`, in the CLI's order. `opts.path` (default `apps/<slug>/app.yaml`), `opts.baseAppYamlText` (the file on the base branch: the `--base` immutability checks and `destructive[]`; omit it for a new app, also one that uses a deleted app's slug), `opts.otherAppYamlTexts` (the other apps' `app.yaml`: every app has its own repository and its own custom hosts), `opts.archivedAppYamlTexts` (the slug's definitions in `apps-deleted/<slug>/`: check `slug-reuse-generation`, ADR-0061). `app` only when ok. An invalid instance gives `source: "instance"` problems. `archivedAppYamlPath(slug, requestedOn)` and `ARCHIVE_DIR` name the archive's paths |
| `renderDeliveryYaml(instanceYamlText, appYamlText)` → `string` | the exact `apps/{slug}/delivery.yml` text `platform generate` writes (the same `renderDelivery`); throws `PlatformConfigError` (`problems[]`) for an invalid definition |
| `validateInstanceDefinition(instanceYamlText)` → `{ ok, problems }` | exactly `platform validate instance <file>`: YAML syntax, the instance schema, then the rules the schema can't express (`validate-instance.ts`). `problems[]` as above, all `source: "instance"`. The portal's Settings area checks the `instance.yaml` it would commit with it (ADR-0027) |
| `caeSubnetCapacity(prefixLength)` → `{ addresses, usable, maxReplicas }`, `caeSubnetIpsNeeded(sumMaxReplicas)`, `CAE_RESERVED_IPS`, `CONTAINER_APPS_RESERVED_RANGES` | what a Container Apps environment subnet holds ([network-modes → Sizing](../../docs/architecture/network-modes.md#sizing): `/27` 90 replicas, `/26` 250, `/25` 570), and the ranges `platform validate instance` refuses (`cidr.ts`; `TODO(verify)` NET-1 to NET-3) |
| `appYamlPath(slug)`, `deliveryYamlPath(slug)`, `PROVISIONING_YAML`, `VALIDATION_YAML` | paths in platform-config |
| `REPOSITORY_TEMPLATES`, `repositoryTemplate(app)` (`undefined` = no `repository.template`: unmanaged, the platform leaves the repository alone; only an explicit `byo` means onboarding), types `AppDefinition`, `RepositoryTemplate`, `AppDefinitionProblem`, `AppDefinitionResult` | the values of `repository.template` |
| `@simple-apps-foundry/platform-cli/onboarding`: `PHASES`, `STEPS`, `ACTORS`, `GATES`, `CHECKS`, `SETTINGS_SECTIONS`, `SETUP_PROGRESS_KEYS`, `setupDecisionSteps()`, `titleParts(step, lang)`, `fill`, `whoLine`, `evaluateOnboarding(inst, state)`, `planText`, `planMarkdown`, `planJson`, `statusText`, `aiGuideFiles()`, types `Step`, `SettingsCard`, `OnboardingState`, `OnboardingReport` | the onboarding plan (ADR-0072), browser-safe: the portal's setup wizard reads the same steps, see "platform instance plan and status" |
| `RULES`, `RULE_ALIASES`, `canonicalRuleId(id)`, `RULE_EXPLANATIONS`, `PIPELINE_EXPLANATIONS`, `explainCheck(id)`, `checkAiPrompt(id, lang, context)`, types `CheckExplanation`, `PromptContext` | the failure catalogue: a rule's plain-language explanation (EN, CS) and the prompt for the AI agent, see "The failure catalogue". The browser-safe part is also `@simple-apps-foundry/platform-cli/explanations` |

`test/library.test.ts` runs them against the commands on the examples and the negative fixtures
(same problems, same exit codes, the same delivery.yml bytes) and imports the package by name the
way a `file:` dependency does.

## Checks

Run `platform rules` to print this table from the code. IDs are stable; they appear in SARIF,
JSON and the portal.

| ID | Group | Severity | What it checks |
|---|---|---|---|
| PC001 | platform.yaml | error | `platform.yaml` missing, not valid YAML or not a mapping |
| PC002 | platform.yaml | error | does not match `config/schema/app-manifest.schema.json` (line numbers, readable text) |
| PC003 | platform.yaml | error | schema-valid but inconsistent: secret used in `env` but not in `secrets`, reserved app word, `minReplicas` > `maxReplicas`, duplicate env var |
| PC010 | Dockerfile | error | Dockerfile (path from `build.dockerfile`) missing, has no `FROM`, or the path leaves the repo |
| PC011 | Dockerfile | error | a `FROM` is not pinned: needs an exact `x.y.z` tag or a `@sha256:` digest. `latest`, no tag, `22`, `22-alpine`, `22.11`, `lts`, unresolvable `ARG` all fail. Stage references and `scratch` are fine |
| PC012 | Dockerfile | error | the final stage has no `USER`, or it is root/`0` (inherits `USER` through `FROM <stage>`) |
| PC013 | Dockerfile | error | `EXPOSE` or `ENV PORT` disagrees with `runtime.port` (default 8080) |
| PC014 | Dockerfile | warning | no `EXPOSE` in the final stage |
| PC020 | Secrets | error | built-in rule hit: private keys, AWS/GitHub/Slack/Google/Stripe/npm/SendGrid tokens, Entra client secrets, Azure storage keys and SAS signatures, passwords in connection strings and URLs, high-entropy `password`/`token`/`api_key` assignments |
| PC021 | Secrets | error | `gitleaks` finding (only when `gitleaks` is on PATH; `--gitleaks require` fails without it) |
| PC030 | Forbidden files | error | `.env`, `.env.*` and any other `*.env` file. `example.env` and `.env.example` (fake values) are allowed. The starters ship `example.env` because the agent deny rule `Read(./.env.*)` would block `.env.example` |
| PC031 | Forbidden files | error | `bin/`, `obj/`, `node_modules/` (reported once per directory) |
| PC032 | Forbidden files | error | file larger than `--max-file-mb` (default 5) |
| PC033 | Forbidden files | error | key or certificate stores: `.pfx .p12 .jks .keystore .key .ppk` |
| PC040 | Documentation | warning | code changed against the base ref but `CHANGELOG.md` did not (skipped without git base) |
| PC041 | Documentation | warning | `README.md` or `CHANGELOG.md` missing |
| PC050 | AI agent files | error | `SKILL.md` missing or frontmatter invalid: starts on line 1, `name` equals the folder and matches `^[a-z0-9]+(-[a-z0-9]+)*$` (max 64), `description` 1-1024 chars, `metadata` is a string map. Keys outside `name description license compatibility metadata` are a warning |
| PC051 | AI agent files | error | `.claude/skills/` is not byte-identical to `.agents/skills/` (LF-normalised): missing, differing or extra files. Fix: `platform sync-agent-files` |
| PC052 | AI agent files | error | `CLAUDE.md` missing or does not start with `@AGENTS.md` |
| PC053 | AI agent files | error | `AGENTS.md` missing or 32 KiB (32768 bytes) or larger |
| PC054 | AI agent files | error | symbolic link in `.agents/`, `.claude/`, `.gemini/`, `CLAUDE.md`, `AGENTS.md`, `.github/copilot-instructions.md` |
| PC055 | AI agent files | warning | stub file missing or wrong: `.gemini/settings.json`, `.claude/settings.json`, `.gitattributes`, `.github/copilot-instructions.md` |
| PC056 | AI agent files | warning | `.github/copilot-instructions.md` is more than a short pointer |
| PC060 | Runtime | error | the smoke test was skipped (no docker) and `--strict` is on |
| PC061 | Runtime | error | `docker build` failed (output tail included) |
| PC062 | Runtime | error | liveness path (`runtime.health.liveness`, default `/healthz`) did not return 2xx within `--smoke-timeout` |
| PC063 | Runtime | error / warning | **configured** readiness path (`runtime.health.readiness`) did not return 2xx: error. **503 is a warning**: the smoke test runs the image with only `PORT` set, so an app waiting for its database, storage or secrets may answer "not ready"; the environment's readiness probe checks it before a revision gets traffic. Not configured (bring-your-own containers): `/readyz` is only probed and any non-2xx answer is a warning. The starters always configure it (ADR-0015) |
| PC064 | Runtime | error | the container runs as uid 0 (`docker exec id -u`, falls back to the image `USER`) |
| PC065 | Runtime | error | the container could not start or exited before it became healthy (log tail included) |

`--only manifest,dockerfile,secrets,forbidden-files,docs,agent-files,runtime` restricts the run to
some groups (the core repo uses `--only agent-files`).

### Checks that warn before they block (`enforceFrom`, ADR-0049)

A rule in `src/rules.ts` may carry `enforceFrom: "YYYY-MM-DD"`. Before that UTC date its errors are
reported as **warnings**: the message ends with "(a warning until <date>; an error from that date)",
and the hint starts with the rule's explanation and says when it starts blocking. From that date on
they are errors, as usual; warnings and notes of the rule are left alone. Use it when a core release
adds or tightens a check of the delivery pipeline (build, scan or release gates), so a core upgrade
never fails an app's next build overnight; remove it once the date has passed in every supported core
version. `src/enforcement.ts` applies it to every finding of `platform check` (`CheckOptions.today`
injects the date in tests). A check of the delivery pipeline that isn't a rule of `platform check` takes
its date from `PIPELINE_CHECK_ENFORCE_FROM` in `src/rules.ts`: so far `capacity-reservation` (ADR-0053,
`pipeline release-inputs`), 2026-12-11.

### `platform upgrades check` (core CI, ADR-0049)

```text
platform upgrades check [--core-dir <core checkout>]
```

Validates `infra/app/upgrades.yaml` against `config/schema/upgrades.schema.json` (a unit never
requires itself, `deadlineDays` only with level `required`), and checks it against
`infra/app/units.json`: every unit whose `since` is `unreleased` has a note in `versions.unreleased`,
and only those; a note under a released version names a unit that changed in it. Core CI runs it;
`provisioning validate-run` and `plan-units` read the same file of the run's core.

### The failure catalogue (US09.05)

Every rule has a plain-language explanation and a prompt for the developer's AI agent, in English and
Czech, in `src/explanations.ts` (`RULE_EXPLANATIONS`; the delivery pipeline's own checks, the scan gate
and a deployment that didn't finish, are `PIPELINE_EXPLANATIONS`; the checks of an app definition that
`platform validate app` reports with a `checkId` (`front-door-domain-name`, ADR-0052; `cell-unknown`,
`cell-capacity`, `cell-subnet-capacity`, ADR-0053; `decommission-grace`, `decommission-tombstone`,
`decommission-immediate`, ADR-0056; `network-mode-change`, ADR-0060; `cell-change`, ADR-0053; `slug-reuse-generation`,
`slug-reuse-incarnation`, `incarnation-fixed`, ADR-0061)
and `platform validate archive` (`deleted-archive`, ADR-0061), are
`DEFINITION_EXPLANATIONS`, whose prompts finish with `platform validate app` (`deleted-archive`:
`platform validate archive`) in platform-config instead of `platform check`). Their IDs are names, not
`PCnnn` numbers, which are the rules of `platform check`; like those, they never change. One text serves
four readers:

- `platform rules --explain PC012 [--lang cs]` prints it; `--explain all --format markdown` prints the
  whole catalogue, which is
  [docs/user-guide/check-catalogue.en.md](../../docs/user-guide/check-catalogue.en.md) and
  [.cs.md](../../docs/user-guide/check-catalogue.cs.md) (`test/explanations.test.ts` fails when they
  are out of date: regenerate them with that command).
- The portal shows it next to a failed check (Deployments tab, approvals), in the *Copy prompt for AI*
  buttons and in the failure mail. It imports `explainCheck(id)` and `checkAiPrompt(id, lang, context)`
  from the package, and the SPA from the browser-safe subpath `@simple-apps-foundry/platform-cli/explanations`
  (no Node imports: a test checks that).
- `checkAiPrompt` wraps the rule's prompt with what the portal knows (app, environment, file, line, the
  run, facts such as the blocking vulnerabilities) and the usual finish (`platform check`, CHANGELOG.md,
  commit). Its inputs come from the app's own repository, so they are shortened and stripped of line
  breaks and backticks. The CLI's own per-finding `AI prompt:` stays richer: it has the finding's message,
  which the portal never reads (a secret finding's message quotes part of the value).
- Czech: informal "ty", plain words, no Azure jargon (the test checks both).

**Rule IDs are stable.** A rule keeps its ID in every CLI version; an ID is never reused for another check.
A rule that is renamed or merged keeps its old ID as an alias (`RULE_ALIASES`, `canonicalRuleId`), so a SARIF
file from an older run still resolves. `test/explanations.test.ts` holds the list of published IDs and
fails when one disappears without an alias.

### What the checks look at

- **File set:** inside a git work tree, tracked files plus untracked files that are not ignored
  (so a local, git-ignored `node_modules/` or `.env` is not reported, but a committed one is).
  Without git, a directory walk. A `.dockerignore` is not evaluated.
- **Secret scan:** text files up to 1 MiB, binaries and lock files skipped. Findings print the
  location, a fingerprint and at most the first 4 characters of the value, never the value.
  Vendor-specific rules win over the generic assignment rule on the same line. Inline
  `gitleaks:allow` comments and a repo `.gitleaks.toml` are **not** honoured; gitleaks runs with a
  platform-owned config.
- **Reserved variables:** the schema rejects `PORT`, `AZURE_CLIENT_ID`, `APPLICATIONINSIGHTS_CONNECTION_STRING`,
  `CONTAINER_APP_NAME`, `DATABASE_HOST`, `DATABASE_NAME`, `DATABASE_USER`, `STORAGE_BLOB_ENDPOINT` and
  `FRONT_DOOR_ID` in `runtime.env` (PC002; contract in
  [data-services](../../docs/architecture/data-services.md#environment-variables-injected-by-the-platform)).
- **Runtime smoke test:** builds the image (or uses `--image`), runs it detached with
  `PORT=<runtime.port>`, the non-secret `runtime.env` values, `--cap-drop ALL`,
  `no-new-privileges`, 1 GiB memory and a port bound to `127.0.0.1`. The app must start with
  only that environment (no secrets, no database). Containers and the built image are always
  removed. No docker (or no daemon) means the check is reported as `SKIPPED`.
- **Docs freshness:** base ref from `--base`, `PLATFORM_CHECK_BASE_REF`, or the first of
  `origin/HEAD origin/main origin/master main master` that exists; compares the working tree with
  the merge base. Markdown, `docs/`, agent folders and `.github`/`.azuredevops` do not count as code.

## Secret allowlist (platform-owned)

An app must not be able to allow its own secrets. The allowlist is therefore **not** read from
the app repo. The pipeline (or the platform team on a machine) passes it with
`--allowlist <file>` or `PLATFORM_SECRETS_ALLOWLIST`; a file that lives inside the checked
directory, directly or through a symlink, is rejected with exit code 2.

```json
{
  "version": 1,
  "entries": [
    { "ruleId": "aws-access-key-id", "path": "docs/**", "reason": "documented example key, revoked" },
    { "fingerprint": "3f9a0c1d2e4b5a69", "reason": "test credential for the local emulator", "expires": "2027-06-30" }
  ]
}
```

- An entry needs a `reason` (5+ characters) and either a `fingerprint` (the 16 hex characters
  printed in the finding, which pin one exact value, optionally narrowed by `ruleId`/`path`) or
  both `ruleId` and a `path` glob (`**`, `*`, `?`). No blanket entries.
- Rule IDs are the built-in ones (`aws-access-key-id`, `github-token`, `private-key`,
  `connection-string-password`, `url-embedded-credentials`, `generic-secret-assignment`, ...,
  see `src/checks/secrets.ts`) or `gitleaks:<RuleID>` for gitleaks findings.
- Expired entries (`expires`, ISO date) are ignored and mentioned in the output.
- Allowlist changes are reviewed in the platform repo that owns the pipeline, not in app repos.

## Agent files and `sync-agent-files`

Layout (built-in default, from ADR-0013 and the
[agent tooling spike](../../docs/spikes/2026-10-26-agent-tooling.md)):

| File | Rule |
|---|---|
| `AGENTS.md` | the single source of instructions, under 32 KiB |
| `.agents/skills/<name>/SKILL.md` | canonical skills (portable frontmatter only) |
| `.claude/skills/<name>/...` | **generated**, byte-identical mirror (real files, no symlinks) |
| `CLAUDE.md` | starts with `@AGENTS.md` |
| `.gemini/settings.json` | contains `{"context":{"fileName":["AGENTS.md"]}}` |
| `.claude/settings.json` | created if missing (allow `Bash(platform check)`, deny reading `.env*`); never overwritten |
| `.gitattributes` | contains `* text=auto eol=lf` |
| `.github/copilot-instructions.md` | created if missing, short pointer to `AGENTS.md` |

`platform sync-agent-files [dir]` makes the mirror match (copies, overwrites, **deletes extras**),
creates missing stub files and repairs `CLAUDE.md` (prepends `@AGENTS.md`), `.gemini/settings.json`
(merges) and `.gitattributes` (appends a line) without losing existing content. `--check` prints
the drift and exits 1 without writing. It never touches `AGENTS.md` or the skill sources.

**Template manifest.** `templates/app/manifest.json` (`formatVersion` 1, documented in
[templates/README.md](../../templates/README.md#manifestjson-formatversion-1)) is the single source of
truth for the app repo layout. `--manifest <file>` (or `PLATFORM_AGENT_FILES_MANIFEST`, also for
`check --agent-manifest`) makes the CLI derive its layout from it; without it the CLI uses a built-in
layout equal to the manifest (`test/template-manifest.test.ts` fails when they drift). The CLI reads:

- `files` entries with `"type": "mirror"`: the `from` of the first one is the skills source, every
  `target` is a mirror (PC051, `sync-agent-files`).
- `syncAgentFiles`: a known stub (`CLAUDE.md`, `.gemini/settings.json`, `.claude/settings.json`,
  `.gitattributes`, `.github/copilot-instructions.md`) is checked only when it is listed there. The
  *rule* (mode, severity, PC052/PC055) is the CLI's; the *text written when the file is missing*
  is the template source file (ignored when it contains `{{placeholders}}`, then the built-in text
  is used). Any other single file listed there becomes a "create if missing" stub (PC055 warning).
- Conditional entries (`"when": "theme"`: the theme files of `platform repo render`, some
  `generate`d without a source) depend on the app definition: they are never stubs, and listing one
  in `syncAgentFiles` is rejected. `platform check` treats `theme/` like any other app file.
- An unknown `formatVersion` or a manifest in the former `agentFiles` shape is rejected (exit 2).

The AGENTS.md size limit (32 KiB) is not part of the manifest.

```bash
node dist/src/cli.js sync-agent-files ../my-app --manifest ../../templates/app/manifest.json
```

## Pipeline commands

`platform pipeline <command>` holds the logic of the app delivery pipeline
(`pipelines/azure-devops/app-delivery.yml`), so the YAML templates only wire steps together. The
commands run in **trusted** jobs but read untrusted data: `platform.yaml` and the OCI image built
from app code, Trivy output over that image, ARM error text. They are strict about it: exact key
sets where the contract says so, no symlinked `platform.yaml`, every path from the app repo or the
image layout must resolve (realpath) inside the given directory, size caps on every file read
(`platform.yaml` 1 MiB, image manifest 4 MiB, image config 8 MiB, Trivy JSON 128 MiB, deploy log:
last 1 MiB), JSON and YAML are parsed as data only.

Conventions for all of them:

- Exit codes: `0` ok, `1` a check failed (one line per problem on stderr, prefixed
  `platform pipeline <command>:`), `2` usage or internal error.
- JSON outputs go to `--output <file>` (UTF-8, 2-space indent, trailing newline); stdout gets a
  one-line summary. Everything printed is neutralised (see above).
- Agent variables are read from the environment, never from arguments, so untrusted values never
  appear in script text: `SAF_PARAMS_JSON`, `RESOURCES_REPOSITORIES_APP_REF`,
  `RESOURCES_REPOSITORIES_APP_VERSION`, `RESOURCES_REPOSITORIES_CORE_REF`, `BUILD_BUILDID`, and for
  the REST commands `SYSTEM_ACCESSTOKEN`, `SYSTEM_COLLECTIONURI`, `SYSTEM_TEAMPROJECTID`,
  `SYSTEM_DEFINITIONID`.

| Command | Reads | Checks / does | Output |
|---|---|---|---|
| `validate-run --instance <instance.yaml>` | env `SAF_PARAMS_JSON` (the five template parameters `{app, environments, action, targetEnvironment, sourceRunId}`), `RESOURCES_REPOSITORIES_CORE_REF` | `instance.yaml` schema-valid, unique environment names; `app` has exactly `slug` (`^[a-z](-?[a-z0-9])+$`, 3-20, not `platform`/`portal`) and `defaultBranch` (`refs/heads/...`); each environment has exactly `name`, `kind`, `promoteFrom` and equals the instance.yaml environment of that name (kind; `promoteFrom`, absent = `''`); names unique; a subset is allowed; a promotion environment's `promoteFrom` must be another environment of the list, and following `promoteFrom` must not loop (dev -> test -> prod is fine); `action` deliver needs `targetEnvironment` `none` and `sourceRunId` 0, `action` redeploy needs a `targetEnvironment` from the list and `sourceRunId` > 0 (a JSON number or a string of digits); core ref == `refs/tags/<coreVersion>` | one `OK` line |
| `release-inputs --manifest <platform.yaml> --app-dir <dir> --slug <slug> --environments <json> --instance <instance.yaml> --output <file>` | `platform.yaml` (no symlink, inside `--app-dir`), instance.yaml | schema + PC003 consistency; `app == --slug`; keys of `environments:` must be environments of instance.yaml (a typo fails, an override for an environment this pipeline does not deliver is fine); `--environments` (same JSON array as the template parameter, every name an instance environment) only selects which environments appear in the output; `build.dockerfile` / `build.context` (default `Dockerfile` / `.`) must be relative and resolve, symlinks followed, inside `--app-dir` (file / directory); each entry's `capacity` (ADR-0053, rendered by `platform generate`) bounds the resolved size and `maxReplicas`: above it fails (check `capacity-reservation`), a warning before its `enforceFrom`; an entry without one is a warning | `{slug, build:{dockerfile, context} (absolute), deployBranches, environments:{<env>:{runtime, env, secrets}}, warnings}`; warnings also printed as `WARNING` lines |
| `deploy-branch --manifest <platform.yaml> [--set-output <var>]` | env `RESOURCES_REPOSITORIES_APP_REF` (unset: exit 1) | ref must start with `refs/heads/`; the branch must fully match one of `deploy.branches` (default `["*"]`): `*` any sequence including `/`, `?` one character, everything else literal | `true` or `false`; with `--set-output X` also `##vso[task.setvariable variable=X;isoutput=true]true\|false` |
| `promote-branch --default-branch <ref> [--set-output <var>]` | env `RESOURCES_REPOSITORIES_APP_REF` (unset: exit 1) | `--default-branch` must be `refs/heads/...` (else exit 1); `true` only when the run's ref equals it exactly (only default-branch builds are promoted) | `true` or `false`; with `--set-output X` also the `setvariable` line as for `deploy-branch` |
| `oci-digest <layout-dir>` | OCI image layout | `oci-layout` 1.0.0; `index.json` lists exactly one descriptor, an image manifest (OCI or Docker v2), **not an index** (build with `--provenance=false --sbom=false`), platform linux/amd64 if given; manifest and config blobs hash to their digests and match their sizes; config `os: linux`, `architecture: amd64`; every layer blob exists inside the layout with the declared size (layer digests are verified by the registry on push) | `sha256:<64 hex>` |
| `trivy-db-age --metadata <cache>/db/metadata.json --max-age-hours <n>` | Trivy DB metadata | `UpdatedAt` present, RFC 3339, not older than n hours and not more than 1 hour in the future | `UpdatedAt` |
| `scan-gate --trivy <trivy.json> --instance <instance.yaml> --output <verdict.json> [--enforce]` | Trivy JSON (`SchemaVersion` 2), `scanning` of instance.yaml | findings from `Results[].Vulnerabilities[]`, de-duplicated by id + package + installed version; unknown severities count as `UNKNOWN`; "fix available" = `FixedVersion` set or `Status: fixed`; gate from `scanning` (`provider` trivy, `blockProdPromotionOn` critical, `onlyWithAvailableFix` true by default). Without `--enforce`, exit 0 when the input is valid (the scan job never blocks). With `--enforce` (deploy stage of a prod environment, re-evaluated against today's instance.yaml): the verdict is written, then exit 1 with one stderr line per blocking finding when `pass` is false, and exit 1 when `pass` is null (provider `defender`: not supported by this core release, fail closed) | `{provider, gate:{blockOn, onlyWithAvailableFix}, counts:{CRITICAL,HIGH,MEDIUM,LOW,UNKNOWN}, blocking:[{id,pkg,installed,fixed,severity}], pass}`; provider `defender`: `pass: null` and a `reason` |
| `release-manifest --digest <d> --release-inputs <file> --verdict <file> --trivy-db-metadata <file> --core-version <v> --output <file>` | env `RESOURCES_REPOSITORIES_APP_VERSION` (40 hex), `RESOURCES_REPOSITORIES_APP_REF`, `BUILD_BUILDID` (digits) | shapes of the inputs (release inputs exact keys, verdict, `UpdatedAt`), digest, core version | `{schemaVersion:1, slug, runId, commit, appRef, digest, tag, verdict, dbUpdatedAt, coreVersion, cliVersion, releaseInputs}`, `tag` = commit |
| `instance-env --instance <instance.yaml> --env <name> --output <file>` | instance.yaml | schema-valid, environment exists | `{prefix, name, kind, subscriptionId, region, promoteFrom, vaultGeneration, coreVersion}` (region = environment region or `defaultRegion`, `promoteFrom` `''` when absent, `vaultGeneration` 0 by default, `coreVersion` the core this run runs) |
| `portal-target --instance <instance.yaml> --output <file>` | instance.yaml | schema-valid (`portal.clientId` a GUID, `portal.apiBaseUrl` an https origin without path, query, fragment or trailing slash) | `{clientId, apiBaseUrl}`, `''` for a value that is not set; stdout `OK  portal API ...` or `SKIP  instance.yaml has no ...`. `scripts/report.sh` (the deploy event, ADR-0037) sends nothing unless both are set |
| `release-params --record <record.json> --manifest <release-manifest.json> --env <env.json> --output <release.json>` | `az deployment group show ... --query properties.parameters` of the last `release-<slug>` deployment (`{"<param>": {"type", "value"}}`), the release manifest, `instance-env` output | record `prefix`/`environmentName`/`slug` equal env prefix/name and the manifest slug; digest shape; the environment has release inputs; platform-owned values present and of the right basic type (`cell` two digits, 01 to 99; a record without it gives `01`, ADR-0053) | the JSON read by `infra/app/delivery/release.bicepparam`, all keys always present: `prefix, environmentName, slug, generation, vaultGeneration, location, networkMode, cell, externalOnlyNetwork, image:{digest}, runtime, env, secrets, landingZone, frontDoor, customDomains, authentication, run:{id, commit}, coreVersion`. Platform-owned keys come from the record, `runtime`/`env`/`secrets` from the build, `run` (strings: the manifest's `runId` and `commit`, written to the Container App tags `saf-run-id` and `saf-commit`) from the manifest, `coreVersion` from the env file (the core this run runs, never the manifest's build version; the Container App tag `saf-core`, ADR-0049), never `deployedBy` or `alertsEnabled` |
| `verify-source-run --run-id <n> --target <env> --promote-from <env\|''> --default-branch <ref> --target-kind prod\|nonprod --output <source.json>` | Azure DevOps REST API (see below) | the source run is a run of this pipeline (`SYSTEM_DEFINITIONID`), completed, not deleted, its job `verify.scan` succeeded; path `rollback`: its stage `deploy_<target>` succeeded; else path `promotion`: `--promote-from` set, its stage `deploy_<promote-from>` succeeded and its app ref is the default branch; a prod target needs a default-branch build on both paths. Only `succeeded` counts (`succeededWithIssues` is how a deploy stage reports "nothing to do"). A redeploy run has no scan job and is never a source | `{runId, commit, appRef, path}` (`runId` a number, like in the release manifest) |
| `retention-lease --run-id <n> --env <name> --days <n> --slug <slug> [--owner-prefix <p>]` | Azure DevOps REST API | owner `<prefix>:<slug>:<env>` (prefix default `saf-deployed`); renews the lease of that owner and run (`daysValid` from now) or creates one; `protectPipeline` false; days 1-36500 | one `OK` line |
| `classify-deploy-error --log <file>` | the output of a failed `az deployment group create` (last 1 MiB) | see below | `retry` or `fail` (exit 0); unreadable log: exit 1 |

**Azure DevOps REST calls** (`verify-source-run`, `retention-lease`; the jobs `source.resolve`
and `retain`, the only ones that map `System.AccessToken`). Env: `SYSTEM_ACCESSTOKEN`,
`SYSTEM_COLLECTIONURI` (https; plain http only for a loopback host, which the tests use),
`SYSTEM_TEAMPROJECTID` (GUID), `SYSTEM_DEFINITIONID`. The token goes only into the
`Authorization: Bearer` header, redirects are refused, errors name the call and the HTTP status but
never echo a response body, responses are capped at 32 MiB, 30 s timeout, no retries. All calls use
api-version 7.1:

| Call | Used for |
|---|---|
| `GET {project}/_apis/build/builds/{runId}` | `definition.id`, `status` (`completed`), `deleted` |
| `GET {project}/_apis/pipelines/{definitionId}/runs/{runId}` | `resources.repositories.app.refName` and `.version` (app ref and commit) |
| `GET {project}/_apis/build/builds/{runId}/timeline` | `records[]`: Stage by `identifier` = YAML stage name (`deploy_<env>`; `name`, the display name, only for a record without identifier); scan job = Phase `verify.scan` or Job `verify.scan.__default` (deployment jobs are `<stage>.<job>.<hook>`, e.g. `deploy_prod.release.release`); identifiers as in sandbox run 2874 |
| `GET {project}/_apis/build/retention/leases?ownerId=&definitionId=&runId=` | existing lease of this owner and run |
| `PATCH {project}/_apis/build/retention/leases/{leaseId}` | renew: `{daysValid, protectPipeline: false}` |
| `POST {project}/_apis/build/retention/leases` | create: `[{daysValid, definitionId, ownerId, protectPipeline: false, runId}]` |

Open points (`TODO(verify)` in `src/pipeline/source.ts` and `instance.ts`): that the job token may
create leases (ADO-22), and that `convertToJson` renders `sourceRunId` as a JSON number.

**`classify-deploy-error`** extracts ARM errors (`code` + `message`) from az JSON output and from
the az text form (`(Code) message`, `Code:` / `Message:`), unwraps errors whose message is itself
a JSON error, and ignores the wrapper codes `DeploymentFailed`, `ResourceDeploymentFailure` and
`InvalidTemplateDeployment`. It prints `retry` only when every remaining error is an RBAC
propagation symptom:

- `PrincipalNotFound` (replication delay of a new principal;
  [Troubleshoot Azure RBAC](https://learn.microsoft.com/azure/role-based-access-control/troubleshooting)), or
- `InvalidParameterValueInContainerTemplate` or `ContainerAppOperationError` whose message names
  the image and contains `unable to pull image using Managed identity`, `UNAUTHORIZED`, `DENIED` or
  `MANIFEST_UNKNOWN` (the AcrPull assignment of the runtime identity, or the just-pushed digest,
  is not visible yet;
  [Container Apps deployment errors](https://learn.microsoft.com/azure/container-apps/troubleshoot-deployment-errors)).

Anything else, including `AuthorizationFailed` and `Operation expired`, is `fail`. Sources and
open verification points are in `src/pipeline/deploy-error.ts`.

## Using the CLI in an app repo (version pinning)

An app repo is created with the CLI version of its core release in `.platform/cli-version` and in
`AGENTS.md` (template placeholder `PLATFORM_CLI_VERSION`, see
[templates/README.md](../../templates/README.md#pinning-the-platform-cli-version)). Install exactly that version
from the core release, the tarball the release carries:

```bash
npm install --global --ignore-scripts ./simple-apps-foundry-platform-cli-<version>.tgz
platform check                                                   # add --skip-runtime without Docker
```

The CLI's version is the core version without the `v` (`0.2.0`, `0.2.0-rc.1`; ADR-0062 section 4): each
release commit sets it with `node tools/scripts/release-bundle.mjs cli-version <version>`, and the release
bundle carries its npm tarball, published with the GitHub Release in the public releases repository
(ADR-0065). The package is never published to npm (`private: true`). Don't fetch it by name with `npx`: a
package of that name on a public registry could be anyone's.

## Develop

```bash
npm ci
npm run build           # tsc + bundle schemas into dist/schemas
npm test                # build, then node --test on dist/test (hermetic: docker and gitleaks are faked)
npm run demo:bad-app    # text output for a failing fixture (demo:good-app for the passing one)
```

- `test/fixtures/good-app` passes every check; `test/fixtures/bad-app` fails several. Fixtures
  are stored under neutral names (`dot-agents/`, `AGENTS.md.fixture`, `Dockerfile.fixture`, ...)
  so that agents working on the core repo do not load them as live instructions, skills or
  Dockerfiles. `test/materialize.ts` writes the real layout into a temp directory (tests and
  `npm run demo:*` do this). Tests then mutate that copy. Fake credentials are assembled at
  runtime so no scannable secret sits in the repo.
- `platform ado` tests run against a fake organization (`test/ado-fake.ts`) seeded with the
  sandbox's real GET responses, scrubbed to placeholders (`test/fixtures/ado/sandbox-responses.json`);
  security namespaces and role definitions (`test/fixtures/ado/security-definitions.json`) are
  real responses too (organization-independent).
- `platform provisioning easyauth-secret` and `dbinit` tests run against a fake ARM and Graph on one loopback
  origin (`test/azure-fake.ts`): one `kvset` (or `dbinit`) job, its operations and executions, one app
  registration. Its shapes follow the Container Apps API 2024-03-01 documentation (no sandbox
  response yet, JOB-3/JOB-4). The secret value and tokens are random or assembled at run time, and
  every test checks stdout, stderr and the output file for them.
- Provisioning fixtures live in `test/fixtures/provisioning/`: an instance, app and hand-written
  `delivery.yml` shaped like the sandbox, the expected parameter values converted from the
  sandbox's hand-written bootstrap `.bicepparam` files (`bicep build-params`, IDs replaced by
  placeholders) and the matching `state.json` files. `records/` holds one app's real deployment
  records (`az deployment sub|group show`, and `az deployment sub validate` of the same
  landing-zone inputs), scrubbed to placeholders, with that app's `app.yaml`: the `state` and
  `compare` tests use them end to end.
- App definition fixtures live in `test/fixtures/app-definitions/` (`schema-errors.yaml`,
  `semantic-errors.yaml`, `base-v1.yaml`); tests copy them to `<tmp>/apps/<slug>/app.yaml` because
  the slug must equal the directory name.
- Pipeline command fixtures live in `test/fixtures/pipeline/` (ARM error logs, a Trivy report, a
  deployment record, a `platform.yaml`); OCI layouts are generated from bytes in
  `test/pipeline-helpers.ts`. Strings that would be Azure DevOps logging commands are assembled at
  runtime, never stored in a fixture.
- Adding a check: add the rule to `src/rules.ts` (ID, group, severity, summary), implement it in
  `src/checks/`, wire it in `src/run.ts`, add tests and a row to the table above.
- Do not add a `bin/` folder to this package: `bin/` is a forbidden directory for apps and the
  repo `.gitignore` ignores it. The executable is `dist/src/cli.js`.
