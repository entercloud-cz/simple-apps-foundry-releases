// Storage account (Blob) of one app x environment (ADR-0011, data-services.md).
// Entra-only: shared key disabled (no account keys, no SAS), no public blob access, OAuth by
// default, TLS 1.2. Blob protection in every environment: soft delete (blobs + containers),
// versioning, change feed and point-in-time restore (PITR = soft delete - 1 day), plus a
// lifecycle rule that deletes old versions.
//   managed network : public endpoint, default action Allow, no IP rules
//   VNet-based      : public network access disabled + blob private endpoint
//   prepare pass    : both, while an app moves between network modes (ADR-0060): public
//                     access is an explicit input, not derived from the endpoint
// Verify in sandbox: BLOB-1 (protection), MNET-2.

import { privateEndpoint, privateEndpointNic } from '../naming/naming.bicep'

@description('Account name (naming.storageAccount).')
param name string

@description('Azure region.')
param location string

@description('Redundancy of the environment kind (data.storage.prodRedundancy / nonprodRedundancy).')
@allowed([
  'LRS'
  'ZRS'
  'GRS'
])
param redundancy string

@description('Blob and container soft delete in days (35 prod, 7 nonprod). PITR uses one day less.')
@minValue(2)
@maxValue(365)
param softDeleteDays int

@description('Point-in-time restore for block blobs (data.storage.protection.pointInTimeRestore).')
param pointInTimeRestore bool

@description('Public network access: true for the managed-network variant, false with a private endpoint (VNet-based); true together with privateEndpointTarget only in the prepare pass of a network mode change (ADR-0060). false needs privateEndpointTarget.')
param publicNetworkAccess bool

@description('VNet-based variant: private-endpoint subnet and the spoke\'s privatelink.blob zone. Null = managed-network variant.')
param privateEndpointTarget {
  subnetId: string
  privateDnsZoneId: string
}?

@description('Log Analytics workspace for blob read/write/delete logs.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

// Explicit, not derived from the endpoint (ADR-0060): a mode change's prepare pass creates the
// endpoint while public access stays on. Without an endpoint, public access must be on.
var publicAccess = publicNetworkAccess || privateEndpointTarget != null
  ? publicNetworkAccess
  : fail('storage.bicep: publicNetworkAccess false needs privateEndpointTarget (nothing could reach the account).')

resource account 'Microsoft.Storage/storageAccounts@2025-01-01' = {
  name: name
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: {
    name: 'Standard_${redundancy}'
  }
  properties: {
    accessTier: 'Hot'
    allowSharedKeyAccess: false
    allowBlobPublicAccess: false
    defaultToOAuthAuthentication: true
    allowCrossTenantReplication: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    publicNetworkAccess: publicAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: publicAccess ? 'Allow' : 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

resource blobService 'Microsoft.Storage/storageAccounts/blobServices@2025-01-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
    containerDeleteRetentionPolicy: {
      enabled: true
      days: softDeleteDays
    }
    isVersioningEnabled: true
    changeFeed: {
      enabled: true
    }
    restorePolicy: {
      enabled: pointInTimeRestore
      days: pointInTimeRestore ? softDeleteDays - 1 : null
    }
  }
}

// Old versions are deleted after the soft-delete window, which is longer than the PITR window.
resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2025-01-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'delete-old-versions'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: {
              blobTypes: [
                'blockBlob'
              ]
            }
            actions: {
              version: {
                delete: {
                  daysAfterCreationGreaterThan: softDeleteDays
                }
              }
            }
          }
        }
      ]
    }
  }
  dependsOn: [
    blobService
  ]
}

// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: blobService
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'StorageRead'
        enabled: true
      }
      {
        category: 'StorageWrite'
        enabled: true
      }
      {
        category: 'StorageDelete'
        enabled: true
      }
    ]
  }
}

module endpoint '../privateendpoint/private-endpoint.bicep' = if (privateEndpointTarget != null) {
  params: {
    name: privateEndpoint(account.name, 'blob')
    nicName: privateEndpointNic(privateEndpoint(account.name, 'blob'))
    location: location
    subnetId: privateEndpointTarget!.subnetId
    targetResourceId: account.id
    groupId: 'blob'
    privateDnsZoneId: privateEndpointTarget!.privateDnsZoneId
    tags: tags
  }
}

output id string = account.id
output name string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
