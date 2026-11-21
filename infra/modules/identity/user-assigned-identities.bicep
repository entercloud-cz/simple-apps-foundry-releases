// A set of user-assigned managed identities in one resource group.

@description('Identity names (naming.*Identity).')
param names string[]

@description('Azure region.')
param location string

param tags object

resource identities 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = [
  for name in names: {
    name: name
    location: location
    tags: tags
  }
]

output ids string[] = [for (name, i) in names: identities[i].id]
output principalIds string[] = [for (name, i) in names: identities[i].properties.principalId]
output clientIds string[] = [for (name, i) in names: identities[i].properties.clientId]
