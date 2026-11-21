// Private endpoint with a DNS zone group, so its address registers in the spoke's private
// DNS zone. Must be in the same region and subscription as its VNet; the target may be
// elsewhere.

@description('Private endpoint name (naming.privateEndpoint / spokePrivateEndpoint / portalPrivateEndpoint).')
param name string

@description('NIC name (naming.privateEndpointNic).')
param nicName string

@description('Azure region (the VNet\'s region).')
param location string

@description('Private-endpoint subnet.')
param subnetId string

@description('Target resource ID.')
param targetResourceId string

@description('Target sub-resource: vault | postgresqlServer | sqlServer | blob.')
param groupId string

@description('Private DNS zone of the spoke for this service.')
param privateDnsZoneId string

param tags object

resource endpoint 'Microsoft.Network/privateEndpoints@2025-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    subnet: {
      id: subnetId
    }
    customNetworkInterfaceName: nicName
    privateLinkServiceConnections: [
      {
        name: name
        properties: {
          privateLinkServiceId: targetResourceId
          groupIds: [
            groupId
          ]
        }
      }
    ]
  }
}

resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-01-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: groupId
        properties: {
          privateDnsZoneId: privateDnsZoneId
        }
      }
    ]
  }
}

output id string = endpoint.id
