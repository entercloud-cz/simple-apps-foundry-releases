// Test fixture of check-infra.py (ADR-0052, app availability isolation): the fictional app
// `hotelinventory`, a second app in the same Contoso environment as the example
// infra/app/examples/hotel-inventory-prod.portal-endpoint.bicepparam, with confusable inputs: the slug
// without its hyphen (the same compact slug, so registry, vault and storage names differ only by
// the app hash).
// check-infra.py snapshots both apps and asserts that their writes outside their own resource
// groups are disjoint. Not an example to copy. Placeholder IDs only.
using '../../app/portal-vault-endpoint.bicep'

param prefix = 'contoso'
param portalEnvironmentName = 'prod'
param location = 'westeurope'
param environmentName = 'prod'
param slug = 'hotelinventory'
param generation = 0
param vaultSubscriptionId = '00000000-0000-0000-0000-00000000b001'
param networkMode = 'externalHybrid'
param externalOnlyNetwork = 'managed'
param managedBy = 'SAF'
