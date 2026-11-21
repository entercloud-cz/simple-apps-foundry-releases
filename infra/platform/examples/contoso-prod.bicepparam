// Fictional Contoso instance, environment `prod`. Unlike config/examples/instance.example.yaml
// (managed network in both environments), this example uses the isolated VNet variant of
// External only, so both variants are exercised (ADR-0003: chosen per environment when the
// environment is deployed). Front Door values are omitted on purpose: the prod-kind defaults
// apply (Premium, WAF prevention, managed rule sets). Placeholder IDs only.
using '../environment.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param environmentKind = 'prod'
param location = 'westeurope'
param vaultGeneration = 0
param hub = {
  vnetId: '/subscriptions/00000000-0000-0000-0000-00000000f001/resourceGroups/rg-network-hub/providers/Microsoft.Network/virtualNetworks/vnet-hub-westeurope'
  firewallPrivateIp: '10.0.1.4'
}
param networkModes = {
  externalOnly: {
    network: 'vnet'
    vnetAddressSpace: '10.30.0.0/23'
    caeSubnetPrefix: '10.30.0.0/25'
    privateEndpointSubnetPrefix: '10.30.1.0/24'
    natGatewayPublicIpCount: 1
  }
  externalHybrid: {
    vnet: {
      create: {
        addressSpace: '10.31.0.0/23'
        useRemoteGateways: false
      }
    }
    caeSubnetPrefix: '10.31.0.0/25'
    privateEndpointSubnetPrefix: '10.31.1.0/24'
    routeTableId: '/subscriptions/00000000-0000-0000-0000-00000000b001/resourceGroups/rg-network-prod/providers/Microsoft.Network/routeTables/rt-to-firewall'
    dnsServers: [
      '10.0.0.4'
      '10.0.0.5'
    ]
    egressBaseline: {
      status: 'active'
      reference: 'CHG-1102'
    }
  }
}
param frontDoor = {
  environment: 'prod'
}
param logRetentionDays = 90
param platformAlertEmails = [
  'platform-team@contoso.com'
]
param managedBy = 'SAF'
param tags = {}
// Pass 2 (ADR-0035): saf-jobs is imported into the platform registry by this digest (placeholder
// here; the real one is in images/images.json). Pass 1 passes ''.
param platformJobsImageDigest = 'sha256:0000000000000000000000000000000000000000000000000000000000000000'
// Bootstrap output entraProvisioningIdentity.principalId of the portal host environment (prod).
param entraProvisioningPrincipalId = '00000000-0000-0000-0000-00000000d101'
// instance.yaml portal.identityPrincipalId: Log Analytics Reader on the workspace for id-contoso-portal
// (ADR-0026); '' = none.
param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'
