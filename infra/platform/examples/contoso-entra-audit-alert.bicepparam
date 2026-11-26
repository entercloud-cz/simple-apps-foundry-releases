// Fictional Contoso instance: the Tier-0 audit alert on id-contoso-entra-provisioning (ADR-0023,
// ENT-8). Deployed once by Contoso's identity team with the platform team, into the resource group
// of the workspace that receives the tenant's Entra audit log (diagnostic setting, category
// AuditLogs): deployment `entra-audit-alert`, what-if first. The principal ID is the bootstrap output
// entraProvisioningIdentity.principalId. Placeholder IDs only.
using '../entra-audit-alert.bicep'

param prefix = 'contoso'
param location = 'westeurope'
param workspaceResourceId = '/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-contoso-platform-prod/providers/Microsoft.OperationalInsights/workspaces/log-contoso-prod'
param entraProvisioningPrincipalId = '00000000-0000-0000-0000-00000000d101'
param actionGroupIds = [
  '/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-contoso-platform-prod/providers/Microsoft.Insights/actionGroups/ag-contoso-platform-prod'
  '/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-contoso-identity/providers/Microsoft.Insights/actionGroups/ag-contoso-identity-team'
]
param tags = {
  managedBy: 'SAF'
}
