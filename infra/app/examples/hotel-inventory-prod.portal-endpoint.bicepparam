// Portal-side private endpoint of the fictional app `hotel-inventory`'s prod vault (ADR-0025):
// prod runs it in External with internal access (VNet-based, public network access disabled), and
// Contoso's portal runs in prod (portal.hostEnvironment), so the endpoint goes into
// rg-contoso-portal-prod with the deployment name pep-portal-hotel-inventory-prod. The vault is in
// the same subscription: the connection is approved automatically. Its nonprod vault is on the
// Azure-managed network and gets no endpoint. The provisioning pipeline deploys this through
// infra/app/provisioning/portal-endpoint.bicepparam; by hand only for a repair (infra/README.md).
// Placeholder IDs only.
using '../portal-vault-endpoint.bicep'

param prefix = 'contoso'
param portalEnvironmentName = 'prod'
param location = 'westeurope'
param environmentName = 'prod'
param slug = 'hotel-inventory'
param generation = 0
param vaultSubscriptionId = '00000000-0000-0000-0000-00000000b001'
param networkMode = 'externalHybrid'
param externalOnlyNetwork = 'managed'
param managedBy = 'SAF'
