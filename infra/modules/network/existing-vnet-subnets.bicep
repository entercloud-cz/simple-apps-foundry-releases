// The platform's two subnets inside a spoke VNet the customer's network team owns
// (externalHybrid with vnet.existingVnetId). Deployed into that VNet's resource group.
// The network team owns the VNet and its peering; the platform owns only these subnets and
// re-asserts their full state (delegation, NSG, route table) on every deploy
// (lessons-from-v1). The NSGs live in the platform RG and must be in the VNet's subscription
// and region.

@description('Name of the existing spoke VNet (last segment of existingVnetId).')
param vnetName string

@description('CAE subnet: name, prefix, NSG and the network team\'s route table (required).')
param caeSubnet {
  name: string
  addressPrefix: string
  nsgId: string
  routeTableId: string
}

@description('Private-endpoint subnet: name, prefix and NSG.')
param privateEndpointSubnet {
  name: string
  addressPrefix: string
  nsgId: string
}

resource vnet 'Microsoft.Network/virtualNetworks@2025-01-01' existing = {
  name: vnetName
}

resource cae 'Microsoft.Network/virtualNetworks/subnets@2025-01-01' = {
  parent: vnet
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
    routeTable: {
      id: caeSubnet.routeTableId
    }
    privateEndpointNetworkPolicies: 'Disabled'
    defaultOutboundAccess: false
  }
}

resource pep 'Microsoft.Network/virtualNetworks/subnets@2025-01-01' = {
  parent: vnet
  name: privateEndpointSubnet.name
  properties: {
    addressPrefix: privateEndpointSubnet.addressPrefix
    networkSecurityGroup: {
      id: privateEndpointSubnet.nsgId
    }
    privateEndpointNetworkPolicies: 'NetworkSecurityGroupEnabled'
    defaultOutboundAccess: false
  }
  // Subnet writes on one VNet must not run in parallel (AnotherOperationInProgress).
  dependsOn: [
    cae
  ]
}

output caeSubnetId string = cae.id
output privateEndpointSubnetId string = pep.id
