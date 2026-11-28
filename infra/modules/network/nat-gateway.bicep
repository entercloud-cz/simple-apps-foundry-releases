// NAT Gateway with its public IPs (External only, network: vnet). Gives the isolated spoke a
// stable egress IP.

import { natGatewayPublicIp } from '../naming/naming.bicep'

@description('NAT Gateway name (naming.natGateway).')
param name string

@description('Instance prefix, environment and mode, for the public IP names.')
param prefix string
param environmentName string
param mode string

@description('Azure region.')
param location string

@description('Number of public IPs (instance.yaml natGatewayPublicIpCount, 1-16).')
@minValue(1)
@maxValue(16)
param publicIpCount int

param tags object

resource publicIps 'Microsoft.Network/publicIPAddresses@2025-01-01' = [
  for i in range(1, publicIpCount): {
    name: natGatewayPublicIp(prefix, mode, environmentName, i)
    location: location
    tags: tags
    sku: {
      name: 'Standard'
      tier: 'Regional'
    }
    properties: {
      publicIPAllocationMethod: 'Static'
      publicIPAddressVersion: 'IPv4'
    }
  }
]

resource natGateway 'Microsoft.Network/natGateways@2025-01-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: 'Standard'
  }
  properties: {
    idleTimeoutInMinutes: 4
    publicIpAddresses: [for i in range(0, publicIpCount): { id: publicIps[i].id }]
  }
}

output id string = natGateway.id
output publicIpAddresses string[] = [for i in range(0, publicIpCount): publicIps[i].properties.ipAddress]
