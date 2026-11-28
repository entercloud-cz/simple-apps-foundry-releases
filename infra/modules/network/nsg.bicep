// Network security group of a platform-created subnet. The rules are the complete desired
// state: a redeploy removes rules added out of band.

@description('NSG name (naming.networkSecurityGroup).')
param name string

@description('Azure region (must equal the VNet region).')
param location string

@description('Address prefix of the subnet this NSG protects (destination of the inbound rules).')
param subnetPrefix string

@description('cae = Container Apps environment subnet (external ingress on 80/443); pep = private-endpoint subnet (default rules only: VNet inbound allowed, internet inbound denied).')
@allowed([
  'cae'
  'pep'
])
param purpose string

@description('Log Analytics workspace for NSG event logs.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

// External CAEs in a custom VNet receive client traffic through the environment's public load
// balancer, so the CAE subnet must admit TCP 80/443 from the internet (Microsoft Learn,
// "Securing a virtual network in Azure Container Apps"; AzureLoadBalancer is covered by the
// default rule). Outbound stays on the default rules: egress is shaped by the NAT Gateway
// (External only, vnet) or the network team's UDR to the firewall (hybrid).
// TODO(verify): exact inbound/outbound rule set for workload-profile CAEs. Verify in sandbox: NET-1.
var caeRules = [
  {
    name: 'allow-https-inbound'
    properties: {
      priority: 100
      direction: 'Inbound'
      access: 'Allow'
      protocol: 'Tcp'
      sourceAddressPrefix: 'Internet'
      sourcePortRange: '*'
      destinationAddressPrefix: subnetPrefix
      destinationPortRanges: [
        '80'
        '443'
      ]
    }
  }
]

resource nsg 'Microsoft.Network/networkSecurityGroups@2025-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    securityRules: purpose == 'cae' ? caeRules : []
  }
}

// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: nsg
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        categoryGroup: 'allLogs'
        enabled: true
      }
    ]
  }
}

output id string = nsg.id
