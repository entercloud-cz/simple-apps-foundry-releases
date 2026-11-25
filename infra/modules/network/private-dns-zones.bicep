// Private DNS zones of ONE spoke VNet (network-modes.md: zones are kept per VNet, so a
// resource with endpoints in several VNets resolves to the right address in each). Deployed
// into that mode's DNS resource group (naming.privateDnsResourceGroup), because same-named
// zones of two spokes can't share a resource group.
//
// TODO(verify): hybrid spokes with custom DNS servers (AD DNS) resolve privatelink names only
// if the customer's resolver forwards them to Azure DNS from a VNet linked to these zones.
// Verify in sandbox: NET-4 (isolated spoke), KV-6 (portal path).

import { privateDnsZone, privateDnsZoneLink } from '../naming/naming.bicep'

@description('Spoke VNet the zones are linked to.')
param vnetId string

@description('Services that get a zone: vault, postgres, sql, blob.')
param services string[]

param tags object

var vnetName = last(split(vnetId, '/'))
var zoneNames = [for service in services: privateDnsZone(service)]
var linkName = privateDnsZoneLink(vnetName)

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for (service, i) in services: {
    name: zoneNames[i]
    location: 'global'
    tags: tags
  }
]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (service, i) in services: {
    parent: zones[i]
    name: linkName
    location: 'global'
    tags: tags
    properties: {
      registrationEnabled: false
      virtualNetwork: {
        id: vnetId
      }
    }
  }
]

@description('Zone resource IDs, in the order of services.')
output zoneIds string[] = [for (service, i) in services: zones[i].id]
