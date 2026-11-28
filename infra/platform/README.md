# infra/platform: the instance and its environments

Templates deployed once per instance or per environment, not per app. Who runs each one matters, because some hold
roles no pipeline may hold:

| Template | Run by | ADR |
|---|---|---|
| `roles.bicep` | a person with Owner, once per instance | [0021](../../docs/adr/0021-delivery-permissions-app-deployer-and-pipeline-protection.md), [0035](../../docs/adr/0035-kvset-job-and-automated-easy-auth-secret.md) |
| `bootstrap.bicep` (+ `bootstrap-identities.bicep`, `bootstrap-entra.bicep`) | a person with Owner, in each environment subscription; delete the identities lock, `what-if`, then `create` | [0031](../../docs/adr/0031-platform-identities-and-instance-bootstrap.md) |
| `entra-permissions.bicep` | the tenant's identity team, once | [0023](../../docs/adr/0023-dedicated-entra-provisioning-identity.md) |
| `entra-audit-alert.bicep` | the tenant's identity team (or the platform team with them), once, after `entra-permissions.bicep` | [0023](../../docs/adr/0023-dedicated-entra-provisioning-identity.md) |
| `environment.bicep` | the platform pipeline `\platform\platform-{env}` through `pipeline/environment.bicepparam` | [0043](../../docs/adr/0043-platform-pipeline.md) |
| `portal.bicep` | the portal host's platform pipeline through `pipeline/portal.bicepparam` | [0036](../../docs/adr/0036-portal-image-built-by-core-deployed-by-the-instance.md), [0043](../../docs/adr/0043-platform-pipeline.md) |

`pipeline/` holds the platform pipeline's only parameter files and `platform-names.bicep` (names evaluated
offline). `examples/` holds fictional Contoso parameter files with placeholder GUIDs.

The steps, the parameters and what each run needs are in [../README.md](../README.md): Platform identities
bootstrap, Entra provisioning identity permissions, Platform pipeline, Portal. Instance onboarding:
[onboard-instance](../../docs/runbooks/onboard-instance.md). Never run `az deployment ... create` against a real
subscription from an agent session unless asked; `what-if` is the safe default.
