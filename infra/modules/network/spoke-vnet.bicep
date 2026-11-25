// Platform-created spoke VNet of a VNet-based mode, with its two subnets defined INLINE.
//
// Subnets and the hub peering are part of the VNet PUT on purpose: a VNet redeploy that omits
// them would try to remove them, and a subnet update replaces its properties wholesale. So the
// complete desired state (delegation, NSG, NAT Gateway, route table) is re-asserted on every
// deploy (lessons-from-v1: "The subnet's route table must be re-asserted on every deploy").
//
//   externalOnly (network: vnet): isolated, peered or connected to nothing; CAE subnet egress
//                                 through the NAT Gateway; no route table, no hub.
//   externalHybrid (vnet.create): peered to the customer hub; CAE subnet uses the network
//                                 team's route table (UDR -> firewall); custom DNS servers.

@description('VNet name (naming.virtualNetwork).')
param name string

@description('Azure region.')
param location string

@description('VNet address space (CIDR).')
param addressSpace string

@description('CAE subnet: name, prefix and NSG. Delegated to Microsoft.App/environments.')
param caeSubnet {
  name: string
  addressPrefix: string
  nsgId: string
}

@description('Private-endpoint subnet: name, prefix and NSG.')
param privateEndpointSubnet {
  name: string
  addressPrefix: string
  nsgId: string
}

@description('NAT Gateway of the CAE subnet (External only, vnet). Null for hybrid.')
param natGatewayId string?

@description('Network team\'s route table of the CAE subnet (hybrid). Null for External only. Required for hybrid (no default).')
param routeTableId string?

@description('Hub peering (hybrid with vnet.create). Null = peered to nothing (External only).')
param hubPeering {
  name: string
  remoteVirtualNetworkId: string
  useRemoteGateways: bool
}?

@description('Custom DNS servers; empty = Azure-provided DNS.')
param dnsServers string[]

param tags object

resource vnet 'Microsoft.Network/virtualNetworks@2025-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    addressSpace: {
      addressPrefixes: [
        addressSpace
      ]
    }
    dhcpOptions: {
      dnsServers: dnsServers
    }
    subnets: [
      {
        name: caeSubnet.name
        properties: {
          addressPrefix: caeSubnet.addressPrefix
          delegations: [
            {
              name: 'Microsoft.App.environments'
              properties: {
                serviceName: 'Microsoft.App/environments'
              }
            }
          ]
          networkSecurityGroup: {
            id: caeSubnet.nsgId
          }
          natGateway: natGatewayId == null ? null : { id: natGatewayId! }
          routeTable: routeTableId == null ? null : { id: routeTableId! }
          privateEndpointNetworkPolicies: 'Disabled'
          defaultOutboundAccess: false
        }
      }
      {
        name: privateEndpointSubnet.name
        properties: {
          addressPrefix: privateEndpointSubnet.addressPrefix
          networkSecurityGroup: {
            id: privateEndpointSubnet.nsgId
          }
          // NSG applies to private endpoints; UDRs don't override their /32 routes.
          privateEndpointNetworkPolicies: 'NetworkSecurityGroupEnabled'
          defaultOutboundAccess: false
        }
      }
    ]
    // Only the spoke side is created here. The hub side (hub -> spoke) belongs to the network
    // team, which owns the hub. TODO(verify): whether the platform should also create the hub
    // side when the provisioning identity has rights on the hub (NET-4 setup only covers
    // unpeered spokes).
    virtualNetworkPeerings: hubPeering == null
      ? []
      : [
          {
            name: hubPeering!.name
            properties: {
              remoteVirtualNetwork: {
                id: hubPeering!.remoteVirtualNetworkId
              }
              allowVirtualNetworkAccess: true
              allowForwardedTraffic: true
              allowGatewayTransit: false
              useRemoteGateways: hubPeering!.useRemoteGateways
            }
          }
        ]
  }
}

output id string = vnet.id
output caeSubnetId string = resourceId('Microsoft.Network/virtualNetworks/subnets', vnet.name, caeSubnet.name)
output privateEndpointSubnetId string = resourceId(
  'Microsoft.Network/virtualNetworks/subnets',
  vnet.name,
  privateEndpointSubnet.name
)
