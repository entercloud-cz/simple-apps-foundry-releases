// The only parameter file of the portal's Entra app registration (infra/entra/portal-registration.bicep,
// ADR-0036, ADR-0040, ADR-0066): deployment entra-portal-{env} in rg-{prefix}-entra, env =
// portal.hostEnvironment, run by a person with Cloud Application Administrator or Application
// Administrator through infra/platform/instance/instance.sh portal-registration (validate by default:
// Graph has no what-if). Running it is the tenant's admin consent for the portal's delegated permissions.
//
// Input: SAF_INSTANCE_JSON, written by `platform instance inputs portal-registration` from instance.yaml,
// the portal host's bootstrap outputs (portalIdentity.principalId) and the outputs of portal pass 1
// (portal-{prefix}-{env}: managedEnvironmentDefaultDomain). Every value comes from that JSON, and Bicep
// type-checks it when this file is compiled (keys it doesn't use are ignored). No other --parameters.

using '../../entra/portal-registration.bicep'

var instance = json(readEnvironmentVariable('SAF_INSTANCE_JSON'))

param prefix = instance.prefix
param environmentName = instance.environmentName
param environmentKind = instance.environmentKind
param productName = instance.productName
param portalHostName = instance.portalHostName
param devRedirectUris = instance.devRedirectUris
param platformAdminsGroupId = instance.platformAdminsGroupId
param platformTeamGroupId = instance.platformTeamGroupId
param tenantId = instance.tenantId
param portalIdentityPrincipalId = instance.portalIdentityPrincipalId
