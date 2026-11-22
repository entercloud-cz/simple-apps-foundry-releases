// rg-{prefix}-entra content of bootstrap.bicep (resource group scope, portal host environment's
// subscription only): the Entra provisioning identity's only Azure role assignment, the custom
// role Entra Deployment Operator ({prefix}) at this resource group (ADR-0033). Graph Bicep runs as
// an ARM deployment, so the identity needs Microsoft.Resources/deployments/* somewhere; this
// resource group holds nothing but those deployment records (entra-{slug}-{env},
// entra-permissions). The role makes the subscription visible to `az login` too, so the identity
// needs no Reader anywhere else.

@description('Principal (object) ID of the Entra provisioning identity.')
param principalId string

@description('Resource ID of the Entra provisioning identity (seed of the assignment name, known before the identity exists).')
param principalResourceId string

@description('Resource ID of the Entra Deployment Operator role definition (bootstrap.bicep).')
param roleDefinitionId string

resource entraDeploymentOperatorAssignment 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, principalResourceId, roleDefinitionId)
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: 'Entra provisioning identity: ARM deployments of the Entra app registrations (Graph Bicep) in this resource group only (ADR-0033). Its Microsoft Graph permissions come from entra-permissions.bicep.'
  }
}
