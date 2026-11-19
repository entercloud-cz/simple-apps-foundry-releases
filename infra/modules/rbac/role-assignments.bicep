// Role assignments on resources outside the module that created the principal: the CAE
// (App Environment Joiner), an environment vault (kvset job) or one secret in it (Easy Auth
// identity), the promoteFrom environment's registry (Data Importer), a platform registry
// (Repository Reader), or the resource group itself (the portal identity's Reader on an app RG,
// ADR-0037). Deployed into the resource group that holds the target. Assignment names are
// guid(target, principal resource ID, role) so they're known before the principal exists and stay
// stable across re-runs.

@description('Target: CAE, environment vault (secret), container registry, or the resource group the module is deployed to.')
param target {
  kind: 'managedEnvironment' | 'keyVault' | 'keyVaultSecret' | 'containerRegistry' | 'resourceGroup'
  @description('CAE / vault / registry name; for resourceGroup the name of the module\'s resource group.')
  name: string
  @description('Secret name (keyVaultSecret only).')
  secretName: string?
}

@description('Principal (object) ID.')
param principalId string

@description('Resource ID of the principal\'s identity (seed of the assignment name); its object ID when the identity lives in another subscription and only that is passed in.')
param principalResourceId string

@description('Role definition GUID (built-in or custom).')
param roleDefinitionGuid string

@description('Shown in the portal next to the assignment.')
param assignmentDescription string

var roleDefinitionId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roleDefinitionGuid)

// A resourceGroup target must be the resource group the module runs in.
var rgTargetValid = target.kind != 'resourceGroup' || toLower(target.name) == toLower(resourceGroup().name)

resource cae 'Microsoft.App/managedEnvironments@2025-01-01' existing = if (target.kind == 'managedEnvironment') {
  name: target.name
}

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' existing = if (target.kind == 'keyVault' || target.kind == 'keyVaultSecret') {
  name: target.name
}

resource secret 'Microsoft.KeyVault/vaults/secrets@2025-05-01' existing = if (target.kind == 'keyVaultSecret') {
  parent: vault
  name: target.?secretName ?? ''
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = if (target.kind == 'containerRegistry') {
  name: target.name
}

resource onCae 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (target.kind == 'managedEnvironment') {
  name: guid(cae.id, principalResourceId, roleDefinitionId)
  scope: cae
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: assignmentDescription
  }
}

resource onVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (target.kind == 'keyVault') {
  name: guid(vault.id, principalResourceId, roleDefinitionId)
  scope: vault
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: assignmentDescription
  }
}

resource onSecret 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (target.kind == 'keyVaultSecret') {
  name: guid(secret.id, principalResourceId, roleDefinitionId)
  scope: secret
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: assignmentDescription
  }
}

resource onResourceGroup 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (target.kind == 'resourceGroup') {
  name: rgTargetValid
    ? guid(resourceGroup().id, principalResourceId, roleDefinitionId)
    : fail('role-assignments.bicep: target ${target.name} is not this resource group (${resourceGroup().name}).')
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: assignmentDescription
  }
}

resource onRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (target.kind == 'containerRegistry') {
  name: guid(registry.id, principalResourceId, roleDefinitionId)
  scope: registry
  properties: {
    principalId: principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: roleDefinitionId
    description: assignmentDescription
  }
}
