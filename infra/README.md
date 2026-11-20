# infra: Bicep for platform environments, app landing zones and releases

Iteration 1 (F1) infrastructure of the core. Tenant-independent: every instance value comes
from the instance's `platform-config` repo. Parts of it run in the sandbox
([dev-log](../docs/dev-log/2026-10-28-sandbox-verification.md)); behaviour that
depends on an unverified Azure assumption carries a `Verify in sandbox: <ID>` or
`TODO(verify)` comment ([sandbox plan](../docs/runbooks/sandbox-verification.md)).

## Module map

| Path | Scope | What it does |
|---|---|---|
| `platform/environment.bicep` | subscription | One platform environment (one `environments[]` entry): platform RG, Log Analytics workspace, platform action group, environment Key Vaults (public `kv{prefix}{env}p{h5}` / private `kv{prefix}{env}n{h5}`, each only when a CAE of that variant exists), CAE per enabled mode, spokes, NSGs, NAT Gateway, private DNS zones, platform job identities, platform registry `cr{prefix}{env}{h6}` and, with a jobs image digest, the `kvset` job per CAE ([below](#platform-registry-and-kvset-jobs)), managed Front Door profile + WAF. Deployed by the platform pipeline ([below](#platform-pipeline)) |
| `platform/pipeline/` | – | The platform pipeline's only parameter file `environment.bicepparam` (`SAF_ENVIRONMENT_JSON`) and `platform-names.bicep` (names, evaluated offline), with example inputs (ADR-0043) |
| `platform/instance/` | – | The onboarding steps a person runs ([below](#onboarding-an-instance), ADR-0066): one parameter file per human-run template (bootstrap, roles, Graph permissions, portal registration, Entra audit alert), each reading `SAF_INSTANCE_JSON` from `platform instance inputs`, with example inputs, and `instance.sh`, which runs them |
| `platform/roles.bicep` | subscription | Custom roles `App Deployer ({prefix})` and `App Environment Joiner ({prefix})` (ADR-0021) and `Platform Job Secret Writer ({prefix})` (ADR-0035), one definition per instance |
| `platform/bootstrap.bicep` | subscription | Platform identities of one environment subscription, run by a human with Owner ([below](#platform-identities-bootstrap), ADR-0031): identities RG, provisioning identity with Contributor and condition-constrained RBAC Administrator at the subscription; in the portal host subscription also the ADO automation, Entra provisioning and portal runtime identities, `rg-{prefix}-entra`, the Entra records group `rg-{prefix}-entra-{env}` of every environment (ADR-0063) and the custom role `Entra Deployment Operator ({prefix})` |
| `platform/bootstrap-identities.bicep` | identities RG | The identities, their federated credentials, Reader for the ADO automation identity, and the ReadOnly lock (created last) |
| `platform/portal.bicep` | subscription | The portal in its host environment ([below](#portal), ADR-0036, ADR-0025, ADR-0038, ADR-0070): `rg-{prefix}-portal-{env}` with the portal VNet (CAE and private-endpoint subnets, NSGs, NAT Gateway), its own `privatelink.vaultcore.azure.net` and `privatelink.database.windows.net` zones, the portal database on Azure SQL (Entra administrator `id-{prefix}-portal`), the CAE `cae-{prefix}-portal-{env}` and, with an image digest, the Container App `ca-{prefix}-portal`; Repository Reader for `id-{prefix}-portal` on the platform registry |
| `platform/bootstrap-entra.bicep` | `rg-{prefix}-entra`, each `rg-{prefix}-entra-{env}` | The Entra provisioning identity's only Azure role: Entra Deployment Operator at that RG (one assignment per Entra group, ADR-0063) |
| `platform/entra-permissions.bicep` | `rg-{prefix}-entra` (Graph) | Microsoft Graph application permissions of the Entra provisioning identity, deployed once by the tenant's identity team ([below](#entra-provisioning-identity-permissions), ADR-0023) |
| `app/landing-zone.bicep` | subscription | App RG with tags + `landing-zone-resources.bicep`; role assignments outside the RG (Joiner on the CAE, Easy Auth secret reader, importer on the `promoteFrom` registry); Reader on the app RG for the portal identity when `portalIdentityPrincipalId` is set (ADR-0037). `modeChange` (null in the steady state) runs the prepare pass of a network mode change (ADR-0060, [below](#network-mode-change-prepare-pass)). Outputs include `containerAppFqdn` (`ca-{slug}.{CAE default domain}`, known before the release exists; the provisioning smoke test calls it) |
| `app/landing-zone-resources.bicep` | app RG | Identities (run, deploy, auth) + federated credential, ACR, app Key Vault, App Insights, optional PostgreSQL or Azure SQL, Storage, action group, CPU-credit alert, budget, in-RG role assignments. Inputs `publicNetworkAccess` and `privateNetwork` (null = no private endpoints) are separate (ADR-0060) |
| `app/release.bicep` | app RG | The Container App (the only template that defines it), Easy Auth `authConfigs` and Container App alerts in provisioning mode |
| `app/frontdoor.bicep` | platform RG | One app on its own custom domain through the managed Front Door profile of its environment ([below](#front-door-app-route), ADR-0010 amended 2026-11-01): origin group, origin, custom domain with a Front Door-managed certificate, a route that serves only that domain, no WAF link (app domains have no WAF yet); with an Azure DNS zone of the same subscription also the `_dnsauth` TXT and the CNAME (`modules/frontdoor/app-route.bicep`, `modules/frontdoor/dns-records.bicep`) |
| `app/portal-vault-endpoint.bicep` | portal RG | The portal-side private endpoint `pep-{vaultName}-portal` of one app vault in a VNet-based mode ([below](#portal-side-vault-endpoints), ADR-0025): in the portal VNet's private-endpoint subnet, DNS zone group into the portal's `privatelink.vaultcore.azure.net`; automatic connection for a vault in the same subscription, a manual request otherwise. Deployed by provisioning (`azure_post_<host>`) |
| `app/delivery/` | – | Used by the app delivery pipeline only: `release.bicepparam` (its only parameter file for `app/release.bicep`; reads `SAF_RELEASE_JSON`, `deployedBy: delivery` and `alertsEnabled: false` are literals) and `names.bicep` + `.bicepparam` (every name delivery needs, evaluated offline with `bicep snapshot`, never deployed) |
| `entra/app-registration.bicep` | any (Graph) | Entra app registration per app × environment for Easy Auth: application (`uniqueName` `{prefix}-{slug}-{env}`, redirect URIs per host, ID tokens, app roles, delegated `openid`/`profile`/`email`), service principal with `appRoleAssignmentRequired`, group → role assignments on its own service principal only (Microsoft Graph Bicep v1.0, `bicepconfig.json`) |
| `entra/portal-registration.bicep` (+ `portal-registration-uri.bicep`) | `rg-{prefix}-entra` (Graph) | The portal's one Entra app registration (ADR-0036, ADR-0040), run by a person ([below](#portal), step 5): uniqueName `{prefix}-portal-{env}`, SPA redirect URI on the portal FQDN, scope `access_as_user`, groups claim `ApplicationGroup`, the platform groups assigned to its service principal, delegated Graph `User.Read.All` and `GroupMember.Read.All` with tenant-wide (admin) consent, and one federated identity credential for `id-{prefix}-portal` as the OBO client credential; no secret, no certificate |
| `modules/naming/naming.bicep` | – | Exported functions for every name (ADR-0020), with input and length guards (`fail()`) |
| `modules/types.bicep` | – | Shared types mirroring `instance.schema.json`, built-in role GUIDs, reserved env var names |
| `modules/cae/` | RG | Workload-profile CAE (Consumption), logs to the workspace (resource-specific tables) |
| `modules/jobs/dbinit-job.bicep` | platform RG | One `dbinit` platform job (ADR-0028): PostgreSQL roles and Azure SQL users of runtime identities, no role assignment of its own |
| `modules/jobs/kvset-job.bicep` | platform RG | One `kvset` platform job (ADR-0035) and the Entra provisioning identity's Platform Job Secret Writer assignment on it |
| `modules/portal/portal-app.bicep` | portal RG | The portal Container App (ADR-0036): the portal identity only, image by digest from the platform registry, external HTTPS-only ingress, probes, the portal's env var contract |
| `modules/network/` | RG | `spoke-vnet` (VNet with inline subnets and peering), `existing-vnet-subnets` (subnets in the network team's VNet), `nsg`, `nat-gateway`, `private-dns-zones` |
| `modules/keyvault/`, `registry/`, `data/` (`postgres`, `sql`, `storage`), `privateendpoint/`, `monitoring/`, `frontdoor/`, `identity/`, `rbac/` | RG | One concern each. The data modules take `publicNetworkAccess` explicitly, next to `privateEndpointTarget` (the endpoint); `false` without an endpoint fails (ADR-0060) |
| `tests/` | – | `check-naming.py` (naming matrix, and every name against `naming-vectors.json`, the shared test vectors the portal's and the CLI's TypeScript ports are tested against too), `check-infra.py` (lint, build, function limit, example and negative snapshots, role and hand-built-name checks, bootstrap role set, condition and lock order, Entra Deployment Operator, Graph permissions, platform registry, kvset jobs and Platform Job Secret Writer in pass 1 and pass 2, the portal in pass 1 and pass 2, the portal registration, the Front Door profile and the Front Door app route) |
| `*/examples/*.bicepparam` | – | Fictional Contoso instance, placeholder GUIDs |

## How instance config maps to parameters

`.bicepparam` files are **generated** by the pipelines in the instance's `platform-config`
repo, never written by hand and never committed there with secrets (there are none):

| Pipeline (platform-config) | Template | Inputs | Deployment name |
|---|---|---|---|
| none: a human with Owner, once per environment subscription | `platform/bootstrap.bicep` | `naming.prefix`; the env's `name` and `region` ?? `defaultRegion`; `instanceIdentities` (true only for the portal host environment); `instancePrincipals` (outside the portal host: the host's `portalIdentity.principalId` and `entraProvisioningIdentity.principalId`; `{}` in the host, ADR-0043); `federation` (pass 2: issuer and subject from `platform ado bootstrap apply --phase connections`); through `platform/instance/bootstrap.bicepparam` (`instance.sh bootstrap`) | `bootstrap-{prefix}-{env}` |
| none: a human with Owner on the portal host subscription, until the platform pipeline exists ([below](#portal)) | `platform/portal.bicep` | `naming.prefix`; `portal.hostEnvironment` and that env's `region` ?? `defaultRegion`; `tenantId`; `portal.network`; `database` (`data.azureSql.sizes.S`, a provisioned Standard SKU; `data.backup` retention and `data.azureSql.backupStorageRedundancy` of the host environment's kind, as for an app database); `scm.azureDevOps` (`platformConfigDefaultBranch` resolved, default `main`); `SAF_PORTAL_IMAGE_DIGEST` (unset on pass 1, else the `saf-portal` digest of `images/images.json`) and `SAF_PORTAL_CLIENT_ID` (output `clientId` of `entra/portal-registration.bicep`) through `readEnvironmentVariable()` | `portal-{prefix}-{env}` |
| none: the tenant's identity team, once per instance | `platform/entra-permissions.bicep` | `entraProvisioningPrincipalId` = bootstrap output `entraProvisioningIdentity.principalId`; through `platform/instance/entra-permissions.bicepparam` (`instance.sh entra-permissions`) | `entra-permissions` in `rg-{prefix}-entra` |
| none: a human with Owner or User Access Administrator on every environment subscription, from the portal host subscription, once per instance and when core changes the roles (`\platform\platform-{env}` only checks them, ADR-0043) | `platform/roles.bicep` | `naming.prefix`, all `environments[].subscriptionId`, each once; through `platform/instance/roles.bicepparam` (`instance.sh roles`) | `roles-{prefix}` |
| `\platform\platform-{env}` ([below](#platform-pipeline), ADR-0043) | `platform/environment.bicep` through `platform/pipeline/environment.bicepparam` | `SAF_ENVIRONMENT_JSON` from `platform environment inputs --pass 1\|2`: `naming.prefix`; the env entry: `name`, `kind`, `region` ?? `defaultRegion`, `vaultGeneration`, `networkModes` (defaults resolved), `hub`; the env's `frontDoor.managed.profiles[]` entry when `frontDoor.mode` is `managed` (else `null`); `observability.logRetentionDays`; `notifications.email.platformTeamAddress`; `platformJobsImageDigest` (`''` on pass 1, else the `saf-jobs` digest of `images/images.json`); `entraProvisioningPrincipalId` (`identities.entraProvisioningPrincipalId`, the bootstrap output `entraProvisioningIdentity.principalId` of the portal host environment); `portalIdentityPrincipalId` (`portal.identityPrincipalId`, `''` while the portal isn't set up: Log Analytics Reader on the workspace for the log viewer, ADR-0026, Cost Management Reader on the subscription for the Costs tab, ADR-0017, and Reader on the managed Front Door profile for the apps' custom domains, ADR-0010) | `platform-{prefix}-{env}` |
| `\platform\provisioning`, Azure stage | `app/landing-zone.bicep` through `app/provisioning/landing-zone.bicepparam` | `SAF_LZ_JSON` from `platform provisioning inputs --step lz`: `apps/{slug}/app.yaml` (slug, generation, owner, deputy, developers, network mode per env, data services, budget) + the env entry of `instance.yaml` + `portal.identityPrincipalId` (`portalIdentityPrincipalId`, `''` when unset: the portal identity's Reader on the app RG, ADR-0037) + run-time state (`state.json`: the service connection's issuer and subject once it exists, the Easy Auth secret flag carried from the last record, the budget start date); `modeChange` `null`, or with `--prepare-from <mode>` the prepare pass of a mode change (ADR-0060; not called by the pipeline yet) | `lz-{slug}-{env}` |
| `\platform\provisioning`, Azure post-step | same | the same command once issuer and subject exist or the `kvset` job has written the Easy Auth secret (second pass) | `lz-{slug}-{env}` |
| `\platform\provisioning`, after the landing zone | `app/release.bicep` through `app/provisioning/release.bicepparam` (`deployedBy: provisioning` is a literal there) | `SAF_RELEASE_JSON` from `platform provisioning inputs --step release --mode bootstrap\|reapply`: bootstrap = the core placeholder image ([ADR-0030](../docs/adr/0030-core-container-images.md)) imported into the app registry, its runtime; reapply = image, runtime, env, secret names and run copied from the last `release-{slug}` record; platform-owned values from `app.yaml`, `instance.yaml` and the landing-zone and Entra outputs | `release-{slug}` |
| `\platform\provisioning`, `entra` stage | `entra/app-registration.bicep` through `entra/provisioning/app-registration.bicepparam` | `SAF_ENTRA_JSON` from `platform provisioning inputs --step entra`: title, roles and assignments from `app.yaml`, the app's host names | `entra-{slug}-{env}` in `rg-{prefix}-entra` |
| `\platform\provisioning`, stage `azure_post_<host>` (the portal host environment's) | `app/portal-vault-endpoint.bicep` through `app/provisioning/portal-endpoint.bicepparam` | `SAF_PORTAL_ENDPOINT_JSON` from `platform provisioning inputs --step portal-endpoint`: `naming.prefix`, `portal.hostEnvironment` and its `region` ?? `defaultRegion`, the vault's environment and its `subscriptionId`, the app's slug, `generation` and network mode there, `productName` (only for apps in a VNet-based mode) | `pep-portal-{slug}-{env}` in `rg-{prefix}-portal-{host}` |
| `\platform\provisioning`, stage `azure_post_<env>` ([below](#front-door-app-route); by hand only as break-glass) | `app/frontdoor.bicep` through `app/provisioning/frontdoor.bicepparam` | `SAF_FRONTDOOR_JSON` from `platform provisioning inputs --step frontdoor`: `naming.prefix`; the environment's `name`; the slug; the app's network mode in that environment; `hostName` (`environments.<env>.frontDoor.hostName` of app.yaml); `dnsZoneId` (the zone's `azureDnsZoneId` when it is an Azure DNS zone of the environment's subscription, else `''`) | `fd-{slug}-{env}` in `rg-{prefix}-platform-{env}` |
| `\apps\delivery-{slug}` | `app/release.bicep` through `app/delivery/release.bicepparam` (`deployedBy: delivery` is a literal there) | `SAF_RELEASE_JSON` from `platform pipeline release-params`: the digest from the verified release manifest, `platform.yaml` runtime, env and secret names, every platform-owned value copied from the last `release-{slug}` deployment record ([ADR-0029](../docs/adr/0029-delivery-pipeline-trust-boundaries.md)) | `release-{slug}` (fixed) |

Contract rules:

- **Defaults are resolved by the generator.** Schema defaults (`network: managed`,
  `natGatewayPublicIpCount: 1`, `dnsServers: []`, `useRemoteGateways: false`, backup and size
  defaults by kind) are written explicitly. The templates have **no defaults** for
  environment-specific values, so a missing value fails the deployment (AGENTS.md rule 6).
  Exception by design: an omitted Front Door `sku` / `waf.mode` / `waf.managedRuleSets` takes
  the default of the environment kind inside `environment.bicep` (ADR-0010).
- **Pipeline-injected values use `readEnvironmentVariable()`** inside the `.bicepparam`
  (`SAF_IMAGE_DIGEST`, `SAF_DELIVERY_FIC_ISSUER`, `SAF_DELIVERY_FIC_SUBJECT`,
  `SAF_EASYAUTH_SECRET_EXISTS`), never `--parameters key=value` (lessons-from-v1).
- **Names are never passed in.** Templates compute every name from prefix, environment, slug,
  generation and `vaultGeneration` with the naming module. Hash values are never typed.
- **Validation in Bicep:** inconsistent input (e.g. `internalOnly`, hybrid without `hub`,
  managed rule sets on Standard, PostgreSQL and SQL together, reserved env var names, an
  ACA-bound domain behind Front Door, a guard left from the dropped ACA-bound path) stops the deployment with a `fail()` message before
  anything is created. `platform validate` should catch the same cases earlier.

### Platform-injected environment variables (release.bicep)

Reserved in `platform.yaml`; a variable that doesn't apply is not set at all:

| Variable | Value | When |
|---|---|---|
| `PORT` | `runtime.port` | always |
| `AZURE_CLIENT_ID` | runtime identity client ID (landing-zone output) | always |
| `APPLICATIONINSIGHTS_CONNECTION_STRING` | read from the app's App Insights | always |
| `DATABASE_HOST` | public server FQDN (`<server>.postgres.database.azure.com` or `<server>.database.windows.net`), never the `privatelink` name | app has PostgreSQL or Azure SQL (one relational database per app in iteration 1) |
| `DATABASE_NAME` | database name | same |
| `DATABASE_USER` | the runtime identity's database role (`id-{prefix}-{slug}-run-{env}`) | PostgreSQL only |
| `STORAGE_BLOB_ENDPOINT` | blob endpoint of the app's storage account | app has storage |
| `FRONT_DOOR_ID` | expected `X-Azure-FDID` (managed: the environment profile's `frontDoorId`; external: `frontDoor.external` value) | app behind Front Door |

Secrets from `platform.yaml` become env vars with the names the developer declared, as Key
Vault references **by name** into the app vault of the target environment. `CONTAINER_APP_NAME`
is set by Container Apps itself.

## Onboarding an instance

The templates a person runs (bootstrap, roles, Graph permissions, portal registration, Entra audit alert)
need no hand-written parameter file ([ADR-0066](../docs/adr/0066-instance-onboarding-from-instance-yaml.md)).
`platform/instance/` holds one core-owned `.bicepparam` per template, each reading `SAF_INSTANCE_JSON`,
which `platform instance inputs <template>` writes from `instance.yaml` and the instance's state
([platform CLI](../tools/platform-cli/README.md#platform-instance-onboarding)). `platform/instance/instance.sh`
reads that state from Azure (the outputs of `bootstrap-{prefix}-{env}`, `portal-{prefix}-{host}`,
`platform-{prefix}-{host}` and `entra-portal-{host}`) and from Azure DevOps (the connections' issuer and
subject, by `platform ado bootstrap plan --phase connections`), and runs `az` with the person's login:
what-if by default (validate for Graph), `--apply` to deploy. `instance.sh providers` registers the resource
providers an environment subscription lacks ([below](#subscription-prerequisites)); `instance.sh dns` creates a
missing Azure DNS zone of `dns.zones` (never changes an existing one), prints its name servers for the
delegation, and checks, read only, that each allowed environment's provisioning identity may write records in
it. `instance.sh core` takes a core release from
`coreReleases.repository` into the platform project's `core`: it checks the release's mirror tag against
`release.json` and the pipelines list, then pushes it (never forced) and protects it
([ADR-0067](../docs/adr/0067-instances-take-core-from-the-public-releases-repository.md),
[an instance's core mirror](../pipelines/README.md#an-instances-core-mirror)).

```bash
instance=core/infra/platform/instance/instance.sh     # each step without --apply first: the preview
$instance preflight                                  # read-only; exit 1 on a blocking finding
$instance providers --apply                          # the missing resource providers (Contributor or Owner, each subscription)
$instance dns --apply                                # missing Azure DNS zones; NS records; provisioning identities' roles checked
$instance ado projects --apply                       # the platform and apps projects (Create new projects, ADR-0069)
$instance ado config --apply                         # platform-config: instance.yaml and its pipelines, while empty (ADR-0069)
$instance core --apply                               # coreVersion from coreReleases.repository into core (Project Administrator)
$instance bootstrap <host env> --apply               # pass 1, the portal host first; then each other environment
$instance sync --apply                               # instance.yaml's principal IDs, for a pull request
$instance entra-permissions --apply                  # the identity team (Privileged Role Administrator)
$instance ado connections --apply                    # the service connections (Project Administrator)
$instance bootstrap <env> --pass 2 --apply --remove-lock   # their federated credentials, in each environment
$instance roles --apply
$instance ado all --apply                            # projects, core, config, connections, pipeline, grants, policies (, connections)
$instance portal-registration --apply                # after portal pass 1 (Application Administrator); then sync again
$instance audit-alert --action-group <id> --apply    # after the host's platform pipeline (the identity team)
```

The order and the rights: [onboard an instance](../docs/runbooks/onboard-instance.md). `check-infra.py`
compiles each parameter file with its example input, which must predict exactly the resources of the
template's hand-written example below; `infra/tests/check-instance-sh.sh` tests the script with a fake `az`
(and, for `core`, real git against local repositories and a fake `curl`).

## Platform identities bootstrap

`platform/bootstrap.bicep` creates the identities the platform pipelines log in with, so no
pipeline can run it. A human with **Owner** on the environment subscription runs it once per
environment subscription (ADR-0031): `instance.sh bootstrap <env> [--pass 2]` ([above](#onboarding-an-instance))
derives every input below from `instance.yaml` and the state; `platform/examples/contoso-bootstrap-*.bicepparam`
shows them written out. `what-if` first, then `create`.

| Input | Value |
|---|---|
| `prefix`, `environmentName`, `location` | `naming.prefix`, the environment's `name`, `region` ?? `defaultRegion` |
| `instanceIdentities` | `true` only in the portal host environment's subscription: also creates `id-{prefix}-ado-automation`, `id-{prefix}-entra-provisioning`, `id-{prefix}-portal`, `rg-{prefix}-entra`, the Entra records groups and the Entra Deployment Operator role |
| `entraEnvironments` | with `instanceIdentities`: the `name` of **every** environment of `instance.yaml`, the host's own included; each gets its Entra records group `rg-{prefix}-entra-{env}` (ADR-0063). `[]` in every other subscription. A list without the host's environment, a duplicate, or a list outside the host fails. A new environment needs this bootstrap run again in the host subscription |
| `federation` | `{}` on pass 1; on pass 2 `provisioning` (and, with `instanceIdentities`, `adoAutomation` and `entra`) `{issuer, subject}` read back from the platform service connections. `adoAutomation` or `entra` without `instanceIdentities` fails |
| `instancePrincipals` | outside the portal host: `{portal, entraProvisioning}`, the host bootstrap outputs `portalIdentity.principalId` and `entraProvisioningIdentity.principalId` (GUIDs, required); in the portal host `{}` (this deployment creates both identities and uses their principals). The principals of the limited roles below (ADR-0043) |
| `managedBy`, `tags` | as for `environment.bicep` |

What it creates, in `rg-{prefix}-identities-{env}`:

- `id-{prefix}-provisioning-{env}` with, at the subscription, **Contributor** and **Role Based
  Access Control Administrator** limited by an ABAC condition (version 2.0, "constrain roles" and
  "constrain roles and principals"). Role assignment writes (`@Request`) and deletes (`@Resource`)
  are allowed only:
  - for the platform's unrestricted role set, to any principal: every `builtInRoles` value of
    `modules/types.bicep` plus the two delivery roles of `platform/roles.bicep` (App Deployer, App
    Environment Joiner);
  - for Log Analytics Reader and Cost Management Reader (`platformEnvironmentRoles`), only to the
    portal identity;
  - for Platform Job Secret Writer, only to the Entra provisioning identity (ADR-0043: the platform
    pipeline deploys `environment.bicep` with this identity);
  - for Container Registry Repository Contributor (`registryPurgeRole`), only to the provisioning
    identity itself (ADR-0059: `landing-zone.bicep` gives its deployer that role on the app's registry
    of a build environment, for the registry image purge). Verify in sandbox: REG-1.

  Never Owner, User Access Administrator, RBAC Administrator or Entra Deployment Operator. A new
  role a template assigns must be added to the set and the bootstrap re-run (`check-infra.py` fails
  until it is in it). Verify in sandbox: PLAT-5.
- `id-{prefix}-ado-automation` (portal host only): Reader on the identities RG and nothing else
  in Azure (`TODO(verify)` G10); its rights are in Azure DevOps.
- `id-{prefix}-entra-provisioning` (portal host only, ADR-0023, ADR-0033): no role in the
  identities RG. Graph Bicep runs as an ARM deployment, so its one Azure role is
  **Entra Deployment Operator ({prefix})** on `rg-{prefix}-entra` and on each environment's
  `rg-{prefix}-entra-{env}` (ADR-0063), which also makes the subscription visible to `az login`. Its Microsoft Graph permissions are a separate step
  ([below](#entra-provisioning-identity-permissions)).
- `id-{prefix}-portal` (portal host only, ADR-0036): the portal's runtime identity, with **no
  role and no federated credential** from the bootstrap. Its one Azure role, Container Registry
  Repository Reader on the host environment's platform registry, comes from
  [`portal.bicep`](#portal); its Azure DevOps rights from `platform ado bootstrap`. Other
  roles arrive with the features that need them (US10.18). It is itself the OBO client credential
  of the portal registration: a federated identity credential on that **application** (not on the
  identity, so the lock doesn't matter) with the identity's principal ID as subject, created by
  [`entra/portal-registration.bicep`](#portal) (ADR-0040). The portal Container App uses it while
  the lock is in place (Verify in sandbox: PORTAL-1).
- Federated credentials named like their service connection (`sc-platform-provisioning-{env}`,
  `sc-platform-ado`, `sc-platform-entra`), only when `federation` has them.
- Last, the **ReadOnly lock** `lock-{prefix}-identities-readonly` on the RG. Adding a federated
  credential is a write on the identity, and no automation identity can delete a lock, so no
  pipeline can hijack a platform identity (Verify in sandbox: PROV-2).

In the portal host subscription only (`instanceIdentities`), outside the identities RG:

- `rg-{prefix}-entra`, empty: it holds only deployment records: `entra-permissions`, the portal's
  `entra-portal-{env}` and the app records `entra-{slug}-{env}` deployed before ADR-0063 (read until
  each moves with its registration's next deployment, [deployment history](../docs/runbooks/deployment-history.md#entra-records-per-environment)).
- `rg-{prefix}-entra-{env}` for each environment of `entraEnvironments`, empty: the records
  `entra-{slug}-{env}` of that environment's app registrations (ADR-0063; ARM keeps at most 800
  deployments per group). Verified in the sandbox (ENT-14).
- The custom role **Entra Deployment Operator ({prefix})**, defined at the subscription with
  exactly `Microsoft.Resources/deployments/*` and `Microsoft.Resources/subscriptions/resourceGroups/read`
  (no notActions, no dataActions) and `rg-{prefix}-entra` and the environments' Entra records groups as
  its only assignable scopes, assigned to `id-{prefix}-entra-provisioning` at each of them
  (`platform/bootstrap-entra.bicep`). It is not in the
  provisioning identity's role set, so no pipeline can assign it (`check-infra.py` asserts all of
  this). Verify in sandbox: ENT-11. The definition (subscription scope, a resource group as its
  only assignable scope) and its assignment in the same deployment worked on the first create in
  the sandbox; if replication ever delays it, run the deployment again.

Two passes: (1) `federation = {}`: identities, roles, lock; the client IDs (outputs
`provisioningIdentity`, `adoAutomationIdentity`, `entraProvisioningIdentity`) go into the platform
service connections. (2) With issuer and subject (in the portal host subscription including
`entra` for `sc-platform-entra`): **delete the lock first** (it blocks every write in the RG), run
the template again; it re-creates the lock. The same applies to any later re-run, such as the one
that adds `id-{prefix}-portal` to an existing instance (pass the federation the instance already
has, so no federated credential is removed):

```bash
az lock delete --name lock-<prefix>-identities-readonly --resource-group rg-<prefix>-identities-<env>
az deployment sub what-if --name bootstrap-<prefix>-<env> --location <region> --parameters <bootstrap>.bicepparam
az deployment sub create  --name bootstrap-<prefix>-<env> --location <region> --parameters <bootstrap>.bicepparam
```

Outputs: `identitiesResourceGroup`, `provisioningIdentity`, `adoAutomationIdentity`,
`entraProvisioningIdentity` and `portalIdentity` (the last three `null` unless
`instanceIdentities`) as `{name, clientId, principalId}`, `entraResourceGroup` and
`entraEnvironmentResourceGroups` (`{<env>: rg-{prefix}-entra-{env}}`; both `null` unless
`instanceIdentities`), `tenantId`, `subscriptionId`.

## Entra provisioning identity permissions

`platform/entra-permissions.bicep` grants `id-{prefix}-entra-provisioning` its Microsoft Graph
application permissions (ADR-0023): `Application.ReadWrite.OwnedBy`,
`AppRoleAssignment.ReadWrite.All`, `Application.Read.All` and
`DelegatedPermissionGrant.ReadWrite.All`, as app role assignments on the Microsoft Graph service
principal, and nothing else (`check-infra.py` asserts the four, the resource and the principal).

- **Who:** a human of the tenant's identity team with Privileged Role Administrator or Global
  Administrator, never a pipeline. The ARM deployment also needs
  `Microsoft.Resources/deployments/write` on `rg-{prefix}-entra`.
- **When:** once per instance, after bootstrap pass 1 of the portal host environment (it creates
  the identity and `rg-{prefix}-entra`), before the first provisioning run that creates an Entra
  app registration.
- **How:** `instance.sh entra-permissions` ([above](#onboarding-an-instance)), or a `.bicepparam` like
  `platform/examples/contoso-entra-permissions.bicepparam` with
  `entraProvisioningPrincipalId` = the bootstrap output `entraProvisioningIdentity.principalId`
  (the object ID, not the client ID); deployment name `entra-permissions` in `rg-{prefix}-entra`.
  Graph has no what-if: `az deployment group validate`, then `create`. Removing a permission
  later is a manual delete of the app role assignment.
- Verify in sandbox: ENT-1, ENT-11.

## Portal logs and costs

`platform/environment.bicep` gives the portal identity (`portalIdentityPrincipalId`, the object ID
from `instance.yaml` `portal.identityPrincipalId`) exactly three roles:

- **Log Analytics Reader** on the environment's workspace `log-{prefix}-{env}`, for the portal's
  log viewer ([ADR-0026](../docs/adr/0026-app-logs-in-the-portal.md)). The portal filters every
  query to one app on the server. Verified in the sandbox (LOG-3).
- **Cost Management Reader** on the environment's **subscription**, for the Costs tab
  ([ADR-0017](../docs/adr/0017-cost-visibility-and-budgets.md)). The portal runs one Cost
  Management query per subscription, grouped by resource group, and shows each app only its own
  resource group. A role on the app resource groups couldn't run that query. The role is
  read-only: it can't create or change budgets. On an Enterprise Agreement the billing account's
  "AO view charges" setting must be on. Verify in sandbox: COST-11.
- **Reader** on the environment's managed **Front Door profile** `afd-{prefix}-{env}` only (when the
  environment has one), for the apps' custom domains in the portal: validation and certificate
  state, routes, the endpoint host ([ADR-0010](../docs/adr/0010-custom-domains-certificates-and-front-door.md),
  amended 2026-11-01). Not the platform RG. Verify in sandbox: FD-7.

The Data tab needs no role of its own: it reads the app's database server, storage account, their
Azure Monitor metrics and the runtime identity with the Reader on the app resource group that the
landing zone assigns (ADR-0037). Verify in sandbox: PORTAL-15.

The provisioning identity may assign both roles to the portal identity only (a principal-limited
clause of its condition, ADR-0043), so the platform pipeline deploys them. `check-infra.py`
(`check_portal_readers`) checks that the portal identity holds exactly these two, each once, at the
workspace and at the subscription, and none with `''`.

## Platform registry and `kvset` jobs

`platform/environment.bicep` creates the environment's **platform registry** and, once the jobs
image is in it, one **`kvset` job** and one **`dbinit` job per enabled CAE** (ADR-0028, ADR-0030,
ADR-0035). The provisioning pipeline's `entra` stage uses the `kvset` job to write an app's Easy
Auth client secret into the environment vault (`platform provisioning easyauth-secret`); its
`azure_post` stage uses the `dbinit` job to create an app's database principal, a PostgreSQL role
or an Azure SQL user (`platform provisioning dbinit`), after the landing zone's second pass.

- **Platform registry** `cr{prefix}{env}{h6}` in `rg-{prefix}-platform-{env}`, h6 =
  `take(uniqueString(subscriptionId, platformRgName, 'platformregistry'), 6)`. It never equals the
  app registry `cr{prefix}{slugCompact}{env}{h6}` of the same environment, which is longer by the
  slug. Same module as the app registries: Basic, admin user and anonymous pull off, public network
  access on (Basic has no private endpoint), repository-permissions (ABAC) mode, login server with
  a hash suffix (read it from the output, never build it). The kvset and dbinit identities
  `id-{prefix}-kvset-{env}` and `id-{prefix}-dbinit-{env}` get Container Registry Repository Reader on it; in the portal host
  environment the portal identity `id-{prefix}-portal` gets the same role from
  [`portal.bicep`](#portal). No other identity pulls. VNet-based CAEs pull through their egress
  (NAT Gateway, or the hub firewall: `*.azurecr.io` and `*.blob.core.windows.net`). Verify in
  sandbox: JOB-5.
- **`caj-{prefix}-kvset-{ext|hyb}`** in the CAE of that mode: manual trigger, one replica,
  `replicaTimeout` 300 s, no retry, Consumption profile, no ingress, no secrets (`secrets: []`, so a
  re-run also removes a job secret a failed hand-off left behind; Verify in sandbox: JOB-3), only
  the kvset identity, image `{loginServer}/saf-jobs@{digest}`, argument `kvset`, and exactly three
  env vars: `SAF_VAULT_URI` (the `vaultUri` of the environment vault of the CAE's variant: the
  public vault for the managed-network CAE, the private vault for VNet-based CAEs),
  `SAF_VAULT_AUDIENCE` (`https://vault.azure.net` in the public cloud, from `environment()`) and
  `AZURE_CLIENT_ID` (the kvset identity). Secret name, value (`secretRef`) and expiry, or the
  name and `SAF_SECRET_ACTION=delete` (ADR-0060: a soft delete of `easyauth-{slug}`, never a purge),
  are set per execution by `platform provisioning easyauth-secret`, never by the template.
- **Platform Job Secret Writer ({prefix})** (`platform/roles.bicep`): `jobs/read`, `jobs/write`,
  `jobs/start/action`, `jobs/executions/read` and the two job operation reads, nothing else.
  Assigned to `entraProvisioningPrincipalId` on each kvset job and nowhere else. The provisioning
  identity may assign it to the Entra provisioning identity only (ADR-0043), and the Entra
  provisioning identity gets no Key Vault role. `TODO(verify)`: whether setting a job secret also
  needs `userAssignedIdentities/assign/action` on the kvset identity (JOB-3).
- **`caj-{prefix}-dbinit-{ext|hyb}`** in the CAE of that mode: the same job settings, only the
  dbinit identity (the Entra administrator of every app database server in the environment, set
  by the landing zones), argument `dbinit`, and exactly five env vars: `SAF_PG_AUDIENCE`
  (`https://ossrdbms-aad` + `environment().suffixes.sqlServerHostname`), `SAF_PG_HOST_SUFFIX`
  (`postgres.database.azure.com`), `SAF_SQL_HOST_SUFFIX` (`environment().suffixes.sqlServerHostname`
  without its dot), `SAF_DB_ADMIN` (the dbinit identity's name, the PostgreSQL user of the Entra
  administrator) and `AZURE_CLIENT_ID`. Engine, server, database and runtime identity are set per
  execution by `platform provisioning dbinit`. No role assignment on the job: the Azure
  provisioning identity starts it with its Contributor role (ADR-0028, amended 2026-10-31).
  Verify in sandbox: JOB-2.
- Outputs: `platformRegistry` (`{name, loginServer, id}`), `kvsetJobs` and `dbinitJobs`
  (`{externalOnly, externalHybrid}`, job resource IDs, `null` when the mode is off or on pass 1).
  `app/delivery/names.bicep` returns the job names for an app's mode and capacity cell (`kvsetJob`,
  `dbinitJob`, inputs `networkMode` and `cell`, ADR-0053; cell 01 without a suffix, a later cell with
  `-c{cell}`) and, with `vaultGeneration` and `externalOnlyNetwork` too, the environment vault of that
  mode as `landing-zone.bicep` names it (`environmentVault`, ADR-0060), and the CAE of the mode in that
  cell (`managedEnvironment`, the move step's source and target). With `generation` it also names the
  app vault (`appVault`, as `landing-zone-resources.bicep` does): after a failed landing zone,
  provisioning reads whether a soft-deleted vault holds that name (PE009, ADR-0064). `landing-zone.bicep`, `release.bicep`
  and `frontdoor.bicep` take `cell` too (no default; provisioning passes app.yaml's
  `environments.<env>.cell`, delivery the release record's) and name the app's CAE with
  `cellManagedEnvironment` (ADR-0060 amendment 2026-11-16).

A run with an empty digest after pass 2 does not delete existing jobs (incremental deployment)
but would leave them out of `kvsetJobs` and `dbinitJobs`: the platform pipeline always passes the
current digest once the registry exists.

## Platform pipeline

`\platform\platform-{env}` ([ADR-0043](../docs/adr/0043-platform-pipeline.md),
[pipelines/README.md](../pipelines/README.md#platform-pipeline)) deploys `platform/environment.bicep`
with the environment's provisioning identity. It runs on every merge that changes `instance.yaml`
(a core upgrade bumps `coreVersion` there) and by hand. In the portal host environment it also
deploys `platform/portal.bicep` after the environment ([below](#portal), ADR-0043 amendment
2026-11-14). Runbook: [platform environments](../docs/runbooks/platform-environments.md).

1. **Plan** (no approval):
   - names from `platform/pipeline/platform-names.bicep`;
   - the **roles gate**: the three custom roles of this core's `platform/roles.bicep` exist with
     these actions and are assignable in the subscription (`platform environment roles-check`), or
     the run stops here;
   - in the portal host, `identities.entraProvisioningPrincipalId` and
     `portal.identityPrincipalId` against the identities;
   - the **CAE networks** (ADR-0043 amendment 2026-11-15): each CAE of `platform-names.bicep` read
     once and compared with the CAEs of `bicep snapshot` of `platform/pipeline/environment.bicepparam`
     with the run's inputs (`platform environment cae-network`). An existing CAE whose network type or
     infrastructure subnet would change stops the run here, since a CAE's network can't change in place
     ([runbook](../docs/runbooks/change-external-only-network.md)). A new CAE is never refused;
   - the record `platform-{prefix}-{env}` against `az deployment sub validate` (new, changed or up
     to date), and a what-if preview;
   - in the portal host, the same for the portal ([below](#portal)).
2. **Deploy**, only on a change, after the Approval on the environment `platform-{env}`:
   - pass 1 (`platformJobsImageDigest = ''`) when the environment is new;
   - the `saf-jobs` import by the digest of `images/images.json` from `coreImages.registry`
     (`az acr import --force`: a control-plane action, Contributor is enough; `--force` makes a
     re-run idempotent);
   - pass 2 with that digest;
   - then every job of an enabled mode must run it;
   - all of this only when the environment changed; then, in the portal host, the portal when it
     changed.

   `TODO(verify)` PLAT-4: an import without credentials from a registry outside the tenant (as for
   `saf-placeholder`). The registry is in ABAC mode, so reading it back needs a data role; the
   pipeline checks the jobs' image instead.

Prerequisites, all human-run: the bootstrap of every environment subscription with this core
version (the principal-limited role set, `instancePrincipals`), `platform/roles.bicep` with this
core version, `identities.entraProvisioningPrincipalId` in `instance.yaml`, and
`platform ado bootstrap apply --phase connections` then `--phase pipeline`.

**Break-glass**: when the pipeline can't run, a person with Owner on the subscription runs the
same steps with the parameter file and the JSON the pipeline would use (`what-if` first):

```bash
node tools/platform-cli/dist/src/cli.js environment inputs --instance instance.yaml --env <env> \
  --images core/images/images.json --pass 1 --output env.json        # pass 1 only for a new environment
SAF_ENVIRONMENT_JSON="$(cat env.json)" az deployment sub what-if --name platform-<prefix>-<env> \
  --location <region> --parameters core/infra/platform/pipeline/environment.bicepparam
az acr import --name <platformRegistry.name> --resource-group rg-<prefix>-platform-<env> \
  --source <coreImages.registry>/saf-jobs@sha256:<digest> --image saf-jobs:sha256-<digest hex> --force
# then --pass 2 and `az deployment sub create` with the same parameter file
```

## Portal

`platform/portal.bicep` deploys the portal in the portal host environment (`portal.hostEnvironment`,
ADR-0036, ADR-0025, ADR-0038), deployment name `portal-{prefix}-{env}`. Core builds the image `saf-portal`;
the instance imports it by digest into the host environment's platform registry, as for `saf-jobs`.

What it creates, in `rg-{prefix}-portal-{env}`:

- **Network**, peered or connected to nothing: `vnet-{prefix}-portal-{env}` (`portal.network.vnetAddressSpace`)
  with `snet-{prefix}-cae-portal-{env}` (delegated to Container Apps, egress through the NAT Gateway)
  and `snet-{prefix}-pep-portal-{env}` (for the portal-side private endpoints of ADR-0025, which
  provisioning creates, [below](#portal-side-vault-endpoints)), `nsg-{prefix}-{cae|pep}-portal-{env}` (same rules as the spokes),
  `ng-{prefix}-portal-{env}` with one public IP `pip-{prefix}-ng-portal-{env}-01` (the portal's
  stable egress IP, output `egressIps`), and the portal's own `privatelink.vaultcore.azure.net` and
  `privatelink.database.windows.net` zones, each linked to the portal VNet only
  (`link-vnet-{prefix}-portal-{env}`).
- **Database** (ADR-0070, ADR-0038, `modules/data/sql.bicep`, the module of app databases): Azure SQL
  logical server `sql-{prefix}-portal-{env}-{h6}` with the database `portal`. Entra-only (no SQL login,
  `azureADOnlyAuthentication`), TLS 1.2, public network access disabled and no firewall rule; its
  private endpoint `pep-{serverName}` in the portal's private-endpoint subnet registers in the
  portal's sql zone. Its only Entra administrator is `id-{prefix}-portal` (`sid` = its client ID): the
  portal connects as that identity with a managed-identity token, is `dbo` of `portal` and applies its
  own migrations (no `dbinit` job). SKU, maximum size, PITR retention and backup storage redundancy
  come from `database`, resolved like an app database of the host environment's kind (ADR-0011): the
  SKU must be a provisioned Standard one (`S0` to `S12`, never serverless), the size 1-1024 GB and
  `backupRetentionDays` 7-35. Server audit goes to `log-{prefix}-{env}`.
- **CAE** `cae-{prefix}-portal-{env}` in the CAE subnet, external, logs to the host environment's
  `log-{prefix}-{env}` (existing). No app is ever deployed into it.
- **The host environment's private environment vault** (ADR-0025, amended 2026-11-14): when the host
  environment has a VNet-based CAE (`environmentVault: private`, from `portal-inputs`), the portal-side
  private endpoint `pep-{vaultName}-portal` of `kv{prefix}{env}n{h5}` (created by `environment.bicep`
  in the platform RG) in the private-endpoint subnet, with its NIC `nic-pep-{vaultName}-portal` and a
  zone group in the portal's vault zone. The vault is in this subscription, so the connection is
  approved at creation. The portal reads its own secrets there (the SMTP password). The public
  vault `kv{prefix}{env}p{h5}` of a host without a VNet-based CAE gets none: the portal reaches it over
  its public endpoint.
- **Container App** `ca-{prefix}-portal` (pass 2 only): its only identity is `id-{prefix}-portal`,
  which pulls `{platform registry}/saf-portal@{digest}`; external ingress on 8080, HTTPS only, no IP
  restriction (the SPA's files hold no data; every API call needs a token); liveness `/healthz`,
  readiness `/readyz`; one to two replicas; no secrets. Env vars, the contract with the image:
  `PORT` (8080), `AZURE_CLIENT_ID` (the portal identity), `SAF_TENANT_ID` (`tenantId`),
  `SAF_PORTAL_CLIENT_ID` (the portal registration), `SAF_CONFIG_SOURCE` (`ado`),
  `SAF_ADO_ORGANIZATION_URL`, `SAF_ADO_PROJECT`, `SAF_ADO_REPOSITORY`, `SAF_ADO_BRANCH`
  (`scm.azureDevOps` `organizationUrl`, `platformProject`, `platformConfigRepo`,
  `platformConfigDefaultBranch`), `SAF_DATABASE_HOST` (the server's FQDN, which resolves to the
  private endpoint inside the portal VNet; never the `privatelink` name), `SAF_DATABASE_NAME`
  (`portal`; the portal signs in as `AZURE_CLIENT_ID`, the Entra administrator, so there is no user setting),
  `SAF_SMTP_PASSWORD_VAULT_URI` (`https://{vaultName}.vault.azure.net` of the environment vault with
  the SMTP password, only with the role below; otherwise empty, which the image treats as unset).
- Outside the RG: **Container Registry Repository Reader** for `id-{prefix}-portal` on the platform
  registry `cr{prefix}{env}{h6}`, on every pass, so it has propagated before the first pull. With
  SMTP basic auth (`notifications.email.smtp.auth.passwordSecretName`) and only once that secret
  exists in the environment vault (`smtpPasswordSecretExists`), **Key Vault Secrets User** for
  `id-{prefix}-portal` on that one secret, nothing wider (US10.18). A role assignment on a secret
  needs the secret, so the platform pipeline reads its metadata through ARM before the plan (never
  the value); a missing secret is a warning in the plan, and the first run after a person writes it
  adds the role and the setting ([portal-email.md](../docs/runbooks/portal-email.md)).

Outputs: `portalResourceGroupName`, `managedEnvironmentId`, `managedEnvironmentDefaultDomain`,
`portalFqdn` (`ca-{prefix}-portal.{CAE default domain}`, known from pass 1), `egressIps`,
`portalIdentity`, `database` (`serverName`, `fqdn`, `databaseName`, `user`), `network` (VNet,
private-endpoint subnet and vault zone IDs for the portal-side endpoints), `environmentVault`
(`name`, `variant`, `portalEndpointName`, `smtpPasswordSecretName`, `smtpPasswordRole`),
`containerApp` (`null` on pass 1).

Not in this core version: `portal.network.routeTableId`. A hub connection needs the portal VNet
peered to the hub, which the template does not create, so it stops with a `fail()` message when the
value is set. Also not yet: Application Insights. The app vaults' portal-side endpoints are
provisioning's ([below](#portal-side-vault-endpoints)).

**Cost:** the portal database is the `data.azureSql.sizes.S` entry of `instance.yaml` (the platform
pipeline's `database.size`; by default `S0` with 250 GB, ADR-0070), the same as an app's S database, plus its
backup storage and one private endpoint (ADR-0025 lists the endpoint price). It runs whenever the
portal runs. A host with a VNet-based CAE adds one more endpoint, the private environment vault's.

**Who deploys it:** the host environment's platform pipeline `\platform\platform-<env>`
([above](#platform-pipeline), [ADR-0043](../docs/adr/0043-platform-pipeline.md) amendment
2026-11-14), with the host's provisioning identity, only through `platform/pipeline/portal.bicepparam`
and the JSON of `platform environment portal-inputs` (`SAF_PORTAL_JSON`: `tenantId`, `portal.network`,
the `scm.azureDevOps` fields the portal reads, the database from `data.azureSql.sizes.S`, `data.backup`
retention and `data.azureSql.backupStorageRedundancy` of the host's kind, the `saf-portal` digest of `images/images.json`, `portal.clientId`,
the host's `vaultGeneration` and `environmentVault`, the SMTP password secret's name and whether it
exists (`--smtp-secret`, from the ARM read), `productName`, `tags: {}`). No new role: everything
`portal.bicep` declares is within the identity's Contributor role, and its role assignments
(Repository Reader, Key Vault Secrets User) are in `types.builtInRoles`, which the bootstrap's
condition lets it assign.

- **Plan** (in the same stage as the environment's, no approval): the record `portal-{prefix}-{env}`
  against `az deployment sub validate`, and once the Container App is deployed also its image: missing
  or not on the pinned `saf-portal` digest is a change (a change by hand, or a deploy that failed after
  the import). What-if as for the environment. A new portal shows pass 1 only; a new environment
  defers the portal to the next run (the plan says so).
- **`portal.clientId` decides the pass.** Without it the portal gets pass 1 only (no Container App):
  the registration needs the CAE's default domain first. With it the portal gets pass 2. A Container App
  that exists while `portal.clientId` is missing stops the plan.
- **Deploy**, after the environment's part and the same Approval: the portal inputs must equal the
  approved plan's; pass 1 when there is no record; then, with `portal.clientId`, `az acr import
  --force` of `saf-portal` by digest from `coreImages.registry` into the platform registry, pass 2, the
  Container App on that digest and its latest revision ready within 15 minutes (else the run fails;
  the previous revision keeps serving).

A portal upgrade is a `coreVersion` bump: the host's plan says `changed: parameters
portalImageDigest` (and `templateHash` when `portal.bicep` changed), and the deploy imports and runs
pass 2 after the approval. `TODO(verify)` PLAT-7: the import by the provisioning identity (as PLAT-4),
and that `latestReadyRevisionName` follows the readiness probe.

**Operator steps** for a new instance, in this order. `<env>` is `portal.hostEnvironment`; run the
Azure steps in its subscription.

1. **Bootstrap re-run** of the host subscription with `instanceIdentities = true`
   ([above](#platform-identities-bootstrap)): delete the ReadOnly lock first, keep the current
   `federation`. It adds `id-{prefix}-portal` and re-creates the lock.
2. **Azure DevOps**, before pass 2: an organisation administrator adds `id-{prefix}-portal`
   (bootstrap output `portalIdentity`) to the organisation; then the grants phase gives it **Read**
   on the `platform-config` repository and **View project-level information** (Project namespace,
   `GENERIC_READ`) on the platform project. Read on the repository alone is not enough: the sandbox
   answered the refs call with HTTP 404 until the identity could see the project.

   ```bash
   platform ado bootstrap apply --instance <instance.yaml> --org-url https://dev.azure.com/<org> \
     --phase grants --identities <env>=<bootstrap outputs>.json
   ```

   It must come before pass 2: the readiness probe `/readyz` answers 503 until the portal has read
   `platform-config`, so without these grants pass 2 never gets a ready replica, and the deploy fails
   after its 15-minute wait.
3. **The host environment's platform pipeline**, without `portal.clientId` in `instance.yaml`. A new
   environment's first run deploys the environment only; run the pipeline again. That run's plan shows
   the portal as `new` (pass 1: resource group, network, CAE, the portal database with the portal
   identity as Entra administrator, the registry role); approve it on `platform-<env>`. Then read the
   CAE default domain and the portal host name:

   ```bash
   az deployment sub show --name portal-<prefix>-<env> \
     --query "[properties.outputs.managedEnvironmentDefaultDomain.value, properties.outputs.portalFqdn.value]" -o tsv
   ```

4. **Portal registration** `entra/portal-registration.bicep` (deployment `entra-portal-<env>` in
   `rg-<prefix>-entra`, uniqueName `<prefix>-portal-<env>`; its header says who runs it: a Cloud
   Application Administrator or Application Administrator who may deploy into `rg-<prefix>-entra`).
   `instance.sh portal-registration` ([above](#onboarding-an-instance)) reads the domain and the
   principal from Azure. Parameters:
   - `caeDefaultDomain`: the pass-1 output `managedEnvironmentDefaultDomain`; the redirect URI
     becomes `https://{portalFqdn}/`;
   - `tenantId`: `tenantId` of `instance.yaml`, which must be the tenant of the deployment;
   - `portalIdentityPrincipalId`: the bootstrap output `portalIdentity.principalId` (the principal
     ID, not the client ID). It is the subject of the federated identity credential `portal-obo`,
     the portal API's client credential for the on-behalf-of flow (ADR-0040): issuer
     `https://login.microsoftonline.com/{tenantId}/v2.0`, audience `api://AzureADTokenExchange`.

   Running it is the tenant's **admin consent** for the delegated Graph permissions of people and
   group search, `User.Read.All` and `GroupMember.Read.All` (both need an administrator's
   consent): review them before the first run and after any core upgrade that
   changes this template. Its output `clientId` goes into `instance.yaml` `portal.clientId`. Verify in
   sandbox: PORTAL-12 (the federated credential, OBO with it, people search as a user).
5. **A pull request to `instance.yaml`** sets `portal.clientId` (and `portal.apiBaseUrl`, the
   portal's public base URL). Its merge runs the host's platform pipeline: the plan says `changed:
   parameters portalClientId, portalImageDigest` with the Container App in the what-if; approve. The
   deploy imports `saf-portal` and runs pass 2.
6. **Check** the portal on its FQDN: `/healthz` (process up), `/readyz` (`platform-config` read
   with the portal identity, the database reachable and this image's migrations applied, ADR-0038)
   and `/config.json` (tenant, client ID and API scope for the SPA):

   ```bash
   for path in healthz readyz config.json; do curl -fsS "https://<portalFqdn>/$path"; echo; done
   ```

**Break-glass**: when the pipeline can't run, a person with Owner on the host subscription runs the
same steps with the parameter file and the JSON the pipeline would use (`what-if` first), then runs
the pipeline again once it works; it finds the record up to date (runbook
[redeploy the portal out of band](../docs/runbooks/redeploy-portal-out-of-band.md), sandbox check PLAT-10):

```bash
node tools/platform-cli/dist/src/cli.js environment portal-inputs --instance instance.yaml --env <env> \
  --images core/images/images.json --pass 1 --output portal.json     # pass 1: a new portal, or no portal.clientId yet
# with SMTP basic auth add --smtp-secret present once the secret exists in the vault (az resource show
# --resource-group rg-<prefix>-platform-<env> --namespace Microsoft.KeyVault --parent vaults/<vault>
# --resource-type secrets --name <passwordSecretName>), as the pipeline does
SAF_PORTAL_JSON="$(cat portal.json)" az deployment sub what-if --name portal-<prefix>-<env> \
  --location <region> --parameters core/infra/platform/pipeline/portal.bicepparam
az acr import --name <platformRegistry.name> --resource-group rg-<prefix>-platform-<env> \
  --source <coreImages.registry>/saf-portal@sha256:<digest> --image saf-portal:sha256-<digest hex> --force
# then --pass 2 (needs portal.clientId) and `az deployment sub create` with the same parameter file
```

`platform/examples/contoso-portal.bicepparam` is the hand-written equivalent (pass 1 without
`SAF_PORTAL_IMAGE_DIGEST`, pass 2 with it and `SAF_PORTAL_CLIENT_ID`); `check-infra.py` checks that
the pipeline's example input predicts exactly its resources.

`portal.bicep` stops before deploying values the portal API would reject at startup (the container
would exit and crash-loop): `scm.azureDevOps.organizationUrl` must be an https URL without query or
fragment, `platformConfigDefaultBranch` a short branch name (the API's `BRANCH_RE` in
`portal/api/src/settings.ts`). Pass 1 assigns a role in the provisioning identity's role set
(Repository Reader), so a person running it by hand needs Owner, User Access Administrator or that
identity's rights. A run with an empty digest after pass 2 doesn't delete the Container App
(incremental deployment) but leaves it out of the outputs: always pass the current digest once
imported. Verify in sandbox: PORTAL-1 (deployment, image pull with the portal identity from the
ReadOnly-locked identities RG, the portal answering on its FQDN), PORTAL-3 (the Azure DevOps grants),
PORTAL-5 (the database: the managed identity as Entra administrator, token login through the
private endpoint, logins from outside the VNet and with a password refused, migrations applied once
under two replicas), PLAT-7 (the portal through the host's platform pipeline), KV-11 (the private
environment vault's portal-side endpoint), MAIL-5 (the SMTP secret's role and setting).

## Front Door app route

`app/frontdoor.bicep` puts **one app on its own custom domain** in the managed Front Door profile
of its environment ([ADR-0010](../docs/adr/0010-custom-domains-certificates-and-front-door.md),
amended 2026-11-01). It is deployed at resource-group scope into `rg-{prefix}-platform-{env}`,
which holds `afd-{prefix}-{env}`, with the deployment name `fd-{slug}-{env}`. The template checks
both. **Who runs it:** the provisioning pipeline, stage `azure_post_<env>`, with the environment's
Azure provisioning identity `id-{prefix}-provisioning-{env}` (its Contributor role on the
environment subscription covers the platform RG and the RG of a zone in that subscription; no new
role), for every host `apps/{slug}/app.yaml` requests (`environments.<env>.frontDoor.hostName`, with or
without sign-in since 2026-11-02), through `app/provisioning/frontdoor.bicepparam`, before the
app's release step. It deploys only when the record is not up to date and takes over a deployment
of the same name made by hand. A
platform operator with the same rights may still deploy it by hand as break-glass. Delivery never
does.

| Parameter (no defaults) | Value |
|---|---|
| `prefix`, `environmentName`, `slug` | `naming.prefix`, the environment's `name`, the app's slug |
| `networkMode` | `externalOnly` \| `externalHybrid`: the app's mode in that environment. The origin is `ca-{slug}.{default domain of cae-{prefix}-{mode}-{env}}`, the same host as the landing zone's `containerAppFqdn` |
| `cell` | the app's capacity cell there (app.yaml `environments.<env>.cell`, default `01`; ADR-0053): with `networkMode` it names the CAE, `-c{cell}` for a cell other than `01` |
| `hostName` | the app's custom host in that environment, e.g. `hotel-inventory-test.contoso.com`: lowercase, at least three labels (no zone apex), no wildcard |
| `dnsZoneId` | resource ID of the public Azure DNS zone that holds the host, **only when it is in the environment's subscription**: the template writes `_dnsauth.{sub}` (TXT) and `{sub}` (CNAME) there through a module in the zone's RG, both with the metadata `saf-app = {slug}`, `saf-env = {env}` (the platform's mark, [ADR-0052](../docs/adr/0052-app-availability-isolation.md)). `''` for a zone elsewhere or another DNS provider: create both by hand. A zone in another subscription fails (no nested deployment there, lessons-from-v1) |

What it creates, all in the environment's profile: origin group `og-{slug}-{env}` (one origin, no
health probe) with origin `orig-{slug}-{env}` (the Container App's default FQDN as host and host
header, HTTPS with the certificate name check), custom domain `cd-{host with dots as hyphens}`
(Front Door-managed certificate, TLS 1.2 minimum), route `route-{slug}-{env}` on `fde-{prefix}-{env}`
(only the custom domain, `linkToDefaultDomain: Disabled`, `/*`, HTTP redirected to HTTPS, HTTPS to
the origin, no caching, no rule sets). It doesn't write the profile, the endpoint, the WAF policy
or `secp-{prefix}-{env}`, and it never changes the Container App. The release's `frontDoor` input
does: once this deployment has `Succeeded` for the host app.yaml asks for, provisioning passes
`{mode: managed, frontDoorId: <output frontDoorId>, hostNames, backendIpRanges}` in the same run, so
`release.bicep` sets `FRONT_DOOR_ID` and Easy Auth `forwardProxy` Standard (ADR-0010, amended
2026-11-02). `backendIpRanges` holds the `AzureFrontDoor.Backend` IPv4 ranges once Front Door serves
the domain (one `Allow` rule `afd-backend-{n}` each: the ingress answers only Front Door, ADR-0010
amended 2026-11-11); until then it is empty, which means no IP restriction.

**No WAF for the app's domain yet.** A WAF policy can be linked through only one security policy per
profile, and `secp-{prefix}-{env}` already links the environment's, to the endpoint's default host
only. The sandbox refused a second link: "Web Application Firewall Policy is already attached to
AFDX profile." (2026-11-01). The template therefore creates no security policy, and
`check-infra.py` fails if it ever references a WAF policy. How app domains get the WAF is an open
product decision in [ADR-0010](../docs/adr/0010-custom-domains-certificates-and-front-door.md)
(*WAF for app domains*).

Outputs: `customDomainId`, `endpointHostName` (the CNAME target), `validationToken` (the
`_dnsauth` TXT value) and `validationTokenExpiry`, `originHostName`, `dnsRecords`
(`writtenToZone`, `txt` and `cname` as FQDN and value: what to create by hand when
`writtenToZone` is `false`), and `frontDoorId` (the profile's `X-Azure-FDID`, which provisioning
reads from this record for the release). The new output changes the template hash, so every
`fd-{slug}-{env}` is deployed once more by the next provisioning run.

**The portal reads the app domains** with **Reader on the profile only**, which `environment.bicep`
gives the portal identity (`portalIdentityPrincipalId`) inside the profile module: custom domains
(validation and certificate state), routes and the endpoint host. Re-deploy every environment with
a managed profile for it (an operator, until the platform pipeline exists).

**Break-glass by hand (sandbox)**, in full in the runbook
[Put an app behind Front Door on a custom domain](../docs/runbooks/front-door-custom-domain.md):

1. Prerequisites: `environment.bicep` deployed with a `frontDoor` profile for the environment, and
   the app released (its default FQDN answers).
2. A parameter file like `app/examples/hotel-inventory-nonprod.frontdoor.bicepparam`, then:

   ```bash
   az deployment group what-if --resource-group rg-<prefix>-platform-<env> --name fd-<slug>-<env> \
     --parameters fd-<slug>-<env>.bicepparam
   az deployment group create  --resource-group rg-<prefix>-platform-<env> --name fd-<slug>-<env> \
     --parameters fd-<slug>-<env>.bicepparam
   az deployment group show --resource-group rg-<prefix>-platform-<env> --name fd-<slug>-<env> \
     --query properties.outputs.dnsRecords.value
   ```

3. **DNS:** with `writtenToZone: false`, create the TXT `_dnsauth.<host>` with the validation token
   and the CNAME `<host>` to the endpoint host name at the zone's DNS provider.
4. **Wait** for the domain validation (`domainValidationState` `Approved`) and the certificate
   (HTTPS on the host answers with a certificate for it). Front Door does both after the
   deployment; the time is not measured yet (Verify in sandbox: FD-2).
5. **Check:** `https://<host>/` reaches the app, `http://<host>/` redirects to HTTPS, the endpoint
   host name serves no app.

## Portal-side vault endpoints

`app/portal-vault-endpoint.bicep` gives **one app Key Vault of an app in a VNet-based mode** a second
private endpoint, `pep-{vaultName}-portal`, in the portal VNet
([ADR-0025](../docs/adr/0025-portal-network-path-to-app-key-vaults.md)). Owners can then set secret
values there from the portal, which writes on their behalf (OBO) and can't reach a vault with public
network access disabled otherwise. It is deployed at resource-group scope into the portal resource
group `rg-{prefix}-portal-{host}` (host = `portal.hostEnvironment`), deployment name
`pep-portal-{slug}-{env}` (env = the vault's environment); the template checks both.

**Who runs it:** the provisioning pipeline, in the stage `azure_post_<host>`, with the host
environment's Azure provisioning identity `id-{prefix}-provisioning-{host}` (its Contributor on that
subscription covers the endpoint, `subnets/join/action` on the portal's private-endpoint subnet and
the zone group), for every app and every environment it runs in, once that environment's landing
zone is `ok` ([pipelines/README.md](../pipelines/README.md#portal-side-vault-endpoints)). No new role.
It is never run by delivery. By hand only for a repair, with the same parameters
(`app/examples/hotel-inventory-prod.portal-endpoint.bicepparam`).

| Parameter (no defaults) | Value |
|---|---|
| `prefix`, `portalEnvironmentName`, `location` | `naming.prefix`, `portal.hostEnvironment`, its `region` ?? `defaultRegion` (the portal VNet's region) |
| `environmentName`, `slug`, `generation` | the vault's environment, the app's slug and `generation` |
| `vaultSubscriptionId` | the vault environment's `subscriptionId` |
| `networkMode`, `externalOnlyNetwork` | the app's mode there and the environment's External-only variant: managed network fails (no endpoint needed) |
| `managedBy` | `productName` (tag) |

The vault name and ID are computed with `appKeyVault()` from these, as the landing zone names them;
the subnet and zone from the portal's names (`snet-{prefix}-pep-portal-{host}`,
`privatelink.vaultcore.azure.net` in the portal RG). What it creates: the endpoint (NIC
`nic-pep-{vaultName}-portal`, group `vault`, tags `Application`, `Environment`, `ManagedBy`) and its
DNS zone group `default` in the portal's vault zone, nothing else. Outputs: `endpointId`,
`endpointName`, `vaultId`, `vaultName`, `approval`.

**Approval.** A vault in the deployment's subscription gets an automatic connection
(`privateLinkServiceConnections`): the host's provisioning identity holds
`Microsoft.KeyVault/vaults/privateEndpointConnectionsApproval/action` there through Contributor, so
Azure approves it at creation (one subscription for all environments, as in the sandbox). A vault in
another subscription gets a manual request (`manualPrivateLinkServiceConnections`): the host's
identity has no rights there. The provisioning run of the vault's own environment approves it
(`az keyvault private-endpoint-connection approve`, only the connection of `pep-{vaultName}-portal`
in the host's portal RG). Until then the endpoint is `waiting` and the portal keeps that vault
read-only. Verify in sandbox: KV-6.

**Deletion** (ADR-0025, amended 2026-11-14). Provisioning removes an endpoint and its record in the
host's stage, the endpoint only when it is `pep-{vault}-portal` named for that vault and links a vault
in the app's own resource group by naming, the record only when its parameters name the app and
environment (ADR-0052):

- **decommissioning** (ADR-0056, step P of the delete phase's step 1): before the landing zone's
  delete takes the vault in a later run;
- **a new `generation`** renamed the vault: the previous vault's endpoint goes before the new vault's
  endpoint is deployed over the same record (detail `portalEndpointPrevious removed`);
- **the app moved to the managed network**: once its vault has public network access and no other
  private endpoint connection (or is gone), the endpoint and the record go (`portalEndpoint removed`).
  While the vault's own endpoint in its old spoke is still there (the landing zone doesn't delete
  it), the vault's name still points into `privatelink.vaultcore.azure.net`, and without the
  portal-side endpoint's record in the portal's zone the portal VNet could not resolve it: the
  endpoint stays with a warning (`portalEndpoint leftover`) until that endpoint is deleted, and a
  later run (a drift check) removes it. A vault in another subscription, which the host's identity
  can't read, keeps its endpoint with a warning.

**Leftovers deleted by hand:** the endpoint of an app or environment removed from `platform-config`
without a decommissioning (a warning on every run while the endpoint and its record exist; the rest
of its landing zone is left too), and a vault in another subscription that is no longer VNet-based:

```bash
az network private-endpoint delete --resource-group rg-<prefix>-portal-<host> --name pep-<vault>-portal
az deployment group delete --resource-group rg-<prefix>-portal-<host> --name pep-portal-<slug>-<env>
```

Deleting the record too stops the warning. **Cost:** about 6.4 EUR per endpoint per month at list
price (ADR-0025), a shared platform cost in the portal RG, tagged with the app and environment.
Verify in sandbox: KV-12 (the removals).

## Network mode change: prepare pass

[ADR-0060](../docs/adr/0060-network-mode-change-of-an-app.md) decision 4. A Container App can't change
its CAE and a private endpoint can't change its subnet, and one landing-zone deployment can't order
"endpoint first, public access off" against the app's move. So a mode change runs the landing zone
twice; `landing-zone.bicep` takes `modeChange`:

- **`null`**: the steady state. Every resource is what it was before the parameter existed (the data
  modules get `publicNetworkAccess = !vnetBased` and the endpoints of the mode's spoke).
- **`{phase: 'prepare', fromNetworkMode}`**: while the app still runs in the source CAE. Only
  `externalOnly` ↔ `externalHybrid`; `fromNetworkMode` equal to `networkMode` fails.
  - into `externalHybrid` from the managed network (case A): the private endpoints of the target
    spoke, public network access of the data services and the app vault stays on (with the managed
    network's firewall rules);
  - out of `externalHybrid` to the managed network (case A): the steady External-only landing zone
    (no endpoint declared; the source spoke's endpoints stay until the move step removes them);
  - between two VNet-based modes (case B, `externalOnlyNetwork: vnet`): the endpoints stay in the
    source spoke with its DNS zones, public access stays off. `hybridExistingVnetId` names the
    source spoke when the change comes from `externalHybrid`, also with `networkMode: externalOnly`.

  In every case the delivery identity gets App Environment Joiner on the **target** CAE (the source
  CAE's assignment stays, as the deployment is incremental, until the move step deletes it), the
  Easy Auth role follows the target variant's vault, and the outputs (`managedEnvironmentId`,
  `containerAppFqdn`, `environmentKeyVaultName`) name the target. The move step runs the final pass
  with `modeChange: null`.

`platform provisioning inputs --step lz` always writes `modeChange` (`null`, or the prepare request of
`--prepare-from`); `app/provisioning/landing-zone.bicepparam` passes it through. Nothing in the
pipeline sets it yet (batch 2b). `check-infra.py` (item 18) snapshots the prepare pass of both cases
against the steady landing zones.

## Implemented vs. not yet

| Area | State |
|---|---|
| Naming module + tests | implemented (incl. `fail()` guards, max-length matrix, negative cases) |
| External only, `network: managed` (default) | implemented |
| External only, `network: vnet` (isolated spoke, NAT Gateway, PE subnet, DNS zones) | implemented |
| External with internal access (`vnet.create` with spoke→hub peering, or `vnet.existingVnetId`); route table re-asserted | implemented. The hub→spoke peering is the network team's (output `hubPeeringRequest`) |
| Internal only | **rejected** with a `fail()` message (iteration 2); the type accepts the key so `instance.yaml` passes through |
| Environment Key Vaults per variant + PE per spoke | implemented. The portal-side PE of the host's private environment vault, the portal's Secrets User on the SMTP password secret and the setting `SAF_SMTP_PASSWORD_VAULT_URI` come from `portal.bicep` ([above](#portal), ADR-0025 amended 2026-11-14); KV-11, MAIL-5 open |
| Portal-side PE of app vaults in VNet-based modes (`app/portal-vault-endpoint.bicep`) | implemented, deployed and removed by the provisioning pipeline ([above](#portal-side-vault-endpoints)); offline checks in `check-infra.py`, `check-templates.py` and `check-prov-units.sh`; KV-6, KV-12 open |
| Platform registry (`cr{prefix}{env}{h6}`) and `kvset` jobs (`caj-{prefix}-kvset-{mode}`) | implemented (two passes, [above](#platform-registry-and-kvset-jobs)); identities of all three steps, `kvset` Secrets Officer on the env vaults and Repository Reader on the registry; `dbinit` jobs (PostgreSQL and Azure SQL), Repository Reader for the dbinit identity. `recov` job not yet |
| Platform pipeline `\platform\platform-{env}` ([above](#platform-pipeline), ADR-0043): `platform/pipeline/environment.bicepparam`, `platform/pipeline/platform-names.bicep`, the principal-limited role set of the bootstrap | implemented (offline checks); sandbox checks PLAT-1 to PLAT-9 open. The portal (`portal.bicep`) joins the host's pipeline in a later increment |
| Portal RG, VNet, NAT Gateway, vault and sql zones, CAE, database (Azure SQL, ADR-0070) and Container App (`platform/portal.bicep`, two passes) | implemented (W1, database W2, [above](#portal)); hub connection (`portal.network.routeTableId`) rejected |
| Managed Front Door profile + endpoint + WAF + security policy | implemented; deployed in the sandbox (2026-10-28, two Standard profiles); offline checks in `check-infra.py` (SKU and WAF defaults by environment kind, WAF off, no profile, guards) |
| One app on its custom domain in the managed profile (origin group, origin, custom domain with managed certificate, route, DNS records in a same-subscription Azure DNS zone) | implemented (`app/frontdoor.bicep`, [above](#front-door-app-route)), deployed by provisioning for the hosts app.yaml requests, with or without sign-in (the release then goes behind Front Door: `FRONT_DOOR_ID`, `forwardProxy`; both hosts' callbacks registered; 2026-11-02, FD-8 open); offline checks in `check-infra.py`; deployed in the sandbox by hand once (FD-2, 2026-11-01). No WAF for app domains (open decision, ADR-0010). The ingress lock-down, host changes with both hosts on the route, and removal: F3 (US08.06) |
| Landing zone (identities, ACR, KV, App Insights, data, budget, roles, the portal identity's Reader on the app RG) | implemented |
| Network mode change of an app (ADR-0060) | landing zone prepare pass (`modeChange`) and the explicit `publicNetworkAccess` of the data modules implemented, with offline checks in `check-infra.py`; the plan, the move step and the final pass: batch 2b. Until then validation refuses the change |
| Release (Container App, Easy Auth, IP restriction, alerts) | implemented. Its `customDomains` parameter (ACA-bound domains with CAE managed certificates) is always `[]`: custom domains go through Front Door only (ADR-0010, amended 2026-11-12); the parameter and its guard stay until `release.bicep` changes anyway, so the `release` unit's fingerprint doesn't move |
| Platform identities bootstrap (identities RG, provisioning, ADO automation, Entra provisioning and portal identities, constrained RBAC Administrator, ReadOnly lock, `rg-{prefix}-entra` and the environments' `rg-{prefix}-entra-{env}` with Entra Deployment Operator) | implemented; the Entra records groups (ADR-0063) offline-tested, ENT-14 open |
| Graph permissions of the Entra provisioning identity (`entra-permissions.bicep`) | implemented; deployed in the sandbox (the four app role assignments, nothing else); their use in the `entra` stage: ENT-1, ENT-11 |
| Azure Policy baseline | not yet (US03.10) |

## Decisions taken in code

The decisions first made while writing this Bicep are now recorded in the design docs: names in
[ADR-0020](../docs/adr/0020-naming-convention.md) (with `modules/naming/naming.bicep` as the
source of truth), release modes and the bootstrap release in
[ADR-0021](../docs/adr/0021-delivery-permissions-app-deployer-and-pipeline-protection.md) and
[delivery-flow](../docs/architecture/delivery-flow.md), Front Door ingress ranges in
[ADR-0010](../docs/adr/0010-custom-domains-certificates-and-front-door.md), and the budget start
date in [ADR-0017](../docs/adr/0017-cost-visibility-and-budgets.md). Open items:
`TODO(verify)` and `Verify in sandbox` comments in the code, the cross-subscription custom role
definition path (NR-1), and the managed-certificate name function (backlog US08.01).

## Subscription prerequisites

A new subscription may have almost no resource providers registered (the first sandbox had only
`Microsoft.Consumption` and `Microsoft.CostManagement`). These must be registered in every environment
subscription before the first deployment; registration takes about a minute each:

`Microsoft.App`, `Microsoft.ContainerRegistry`, `Microsoft.KeyVault`, `Microsoft.OperationalInsights`,
`Microsoft.Insights`, `Microsoft.AlertsManagement`, `Microsoft.DBforPostgreSQL`, `Microsoft.Sql`,
`Microsoft.Storage`, `Microsoft.Network`, `Microsoft.Cdn`, `Microsoft.ManagedIdentity`,
`Microsoft.Consumption`, `Microsoft.CostManagement`, `Microsoft.DataProtection`.

`instance.sh preflight` ([above](#onboarding-an-instance)) blocks on each one missing. `instance.sh providers`
lists them per subscription, and with `--apply` registers only those (`az provider register --wait`) and reads
each state back; it needs a role with `*/register/action` (Contributor or Owner) on the subscription. The list
is the script's `providers` array. Container Apps allows a number of environments per region and subscription
that depends on the subscription's offer: 50 in the sandbox, 20 on an Azure Sponsorship subscription.
`preflight` reads it.

Some offers also restrict a database engine by region. On the test instance's Azure Sponsorship subscription,
PostgreSQL Flexible Server answered "Provisioning is restricted in this region" in every region tried in Western
Europe, and the portal's first pass failed on its database (then PostgreSQL; since ADR-0070 the portal uses Azure SQL).
`preflight` reads each engine's capabilities in every subscription and region that needs it: Azure SQL for the
portal, and each engine `data` enables. A restricted
engine needs a support request of type *Service and subscription limits (quotas)* for that region.

## Validate locally

```bash
python3 infra/tests/check-naming.py   # naming matrix via `bicep snapshot`, every name vs tests/naming-vectors.json (~1-3 min)
python3 infra/tests/check-infra.py    # lint + build + function limit + example/negative snapshots (~3 min)
                                      # both run in core CI (job infra_tests); after a deliberate naming.bicep change:
                                      # python3 infra/tests/check-naming.py --update-vectors, then review the diff of the vectors
az bicep build --file infra/platform/environment.bicep
az bicep lint  --file infra/app/release.bicep
~/.azure/bin/bicep snapshot infra/platform/examples/contoso-nonprod.bicepparam \
  --subscription-id 00000000-0000-0000-0000-00000000a001 --location westeurope
~/.azure/bin/bicep snapshot infra/app/examples/hotel-inventory-nonprod.frontdoor.bicepparam \
  --subscription-id 00000000-0000-0000-0000-00000000a001 --resource-group rg-contoso-platform-nonprod \
  --deployment-name fd-hotel-inventory-nonprod --location westeurope
```

`bicep snapshot` (Bicep CLI ≥ 0.46, not exposed through `az bicep`) evaluates a deployment
locally with the deployment engine, including `uniqueString` and `fail()`, without Azure
access. Snapshot files (`*.snapshot.json`) are git-ignored.

Lint is clean (zero errors, zero warnings). Suppressions, each with a reason in the code:
`use-recent-api-versions` for `Microsoft.Insights/diagnosticSettings@2021-05-01-preview` (the
newest version with category groups) and `metricAlerts@2018-03-01` (long-standing GA);
`what-if-short-circuiting` for the PostgreSQL Entra admin, whose object ID is only known at
runtime.

Constraints found while building:

- ARM allows at most **64 user-defined functions per template**. Templates import only the
  naming functions they use (aliased `name…`), never `import *`; `check-infra.py` enforces the
  limit (the test template `tests/naming.tests.bicep` imports everything and is never deployed).
- **Types and shared variables are imported selectively too** (`import { hubConfig, builtInRoles }
  from '../modules/types.bicep'`; a name that clashes with a parameter gets an alias, e.g.
  `environmentKind as environmentKindType`). `import *` compiles every exported type and variable
  into the template, so a new, unused export changes the template hash of every importer, which
  change detection turns into needless redeploys and, for Entra registrations, an approval
  (sandbox run 2932). `check-infra.py` rejects `import *` of either module and checks that an
  unused export added to them leaves every compiled entry template unchanged.
- The deployment engine rejects a user-defined function whose (lazily evaluated) arguments
  call the same function again, so the naming module has one length guard per limit.
- A resource `location` can't come from a runtime value (`existing` CAE): `release.bicep`
  takes `location` and fails if it differs from the CAE's region.
