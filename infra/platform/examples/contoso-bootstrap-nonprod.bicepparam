// Fictional Contoso instance: platform identities bootstrap of the `nonprod` subscription,
// pass 1 (no federation yet). Not the portal host, so only the provisioning identity.
// Run by a human with Owner (what-if first, infra/README.md). Placeholder IDs only.
using '../bootstrap.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param location = 'westeurope'
param instanceIdentities = false
// Not the portal host: the Entra records groups live in the host subscription (ADR-0063).
param entraEnvironments = []
param federation = {}
// The host (prod) bootstrap outputs portalIdentity.principalId and
// entraProvisioningIdentity.principalId (ADR-0043: the limited roles go to these principals only).
param instancePrincipals = {
  portal: '00000000-0000-0000-0000-00000000e102'
  entraProvisioning: '00000000-0000-0000-0000-00000000d101'
}
param managedBy = 'SAF'
param tags = {
  CostCenter: 'IT-1234'
}
