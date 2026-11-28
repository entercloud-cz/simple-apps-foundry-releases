// The only parameter file of the Entra provisioning identity's Microsoft Graph application permissions
// (entra-permissions.bicep, ADR-0023, ADR-0033, ADR-0066): deployment entra-permissions in
// rg-{prefix}-entra, run by a person of the tenant's identity team with Privileged Role Administrator or
// Global Administrator through infra/platform/instance/instance.sh entra-permissions (validate by
// default: Graph has no what-if).
//
// Input: SAF_INSTANCE_JSON, written by `platform instance inputs entra-permissions` from the portal host's
// bootstrap outputs (entraProvisioningIdentity.principalId). Every value comes from that JSON, and Bicep
// type-checks it when this file is compiled (keys it doesn't use are ignored). No other --parameters.

using '../entra-permissions.bicep'

var instance = json(readEnvironmentVariable('SAF_INSTANCE_JSON'))

param entraProvisioningPrincipalId = instance.entraProvisioningPrincipalId
