// The only parameter file of the Tier-0 audit alert on the Entra provisioning identity
// (entra-audit-alert.bicep, ADR-0023, ADR-0066): deployment entra-audit-alert in the workspace's resource
// group, run by the tenant's identity team with the platform team through
// infra/platform/instance/instance.sh audit-alert (what-if by default).
//
// Input: SAF_INSTANCE_JSON, written by `platform instance inputs entra-audit-alert` from instance.yaml, the
// portal host's bootstrap outputs (entraProvisioningIdentity.principalId) and its platform deployment
// (platform-{prefix}-{env}: the workspace, unless another one receives the tenant's audit log, and the
// platform team's action group; the identity team's action group is added to it). Every value comes from
// that JSON, and Bicep type-checks it when this file is compiled (keys it doesn't use are ignored). No
// other --parameters.

using '../entra-audit-alert.bicep'

var instance = json(readEnvironmentVariable('SAF_INSTANCE_JSON'))

param prefix = instance.prefix
param location = instance.location
param workspaceResourceId = instance.workspaceResourceId
param entraProvisioningPrincipalId = instance.entraProvisioningPrincipalId
param actionGroupIds = instance.actionGroupIds
param tags = instance.tags
