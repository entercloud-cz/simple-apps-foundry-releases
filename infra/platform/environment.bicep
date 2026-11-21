// Deploys ONE platform environment (one entry of instance.yaml environments[]) into its
// subscription. Run by the platform pipeline (\platform\platform-{env}, ADR-0043) of
// platform-config with the environment's Azure provisioning identity, deployment name
// platformDeployment(prefix, env), through infra/platform/pipeline/environment.bicepparam only.
// Parameters mirror the instance.yaml entry; `platform environment inputs` resolves schema
// defaults and passes them explicitly (infra/README.md).
//
// Creates:
//   per environment     platform RG, Log Analytics workspace, platform action group,
//                       environment Key Vaults (public and/or private, ADR-0003/ADR-0020),
//                       platform job identities (dbinit, kvset, recov), platform registry
//                       (ADR-0035), managed Front Door profile (frontDoor.mode managed)
//   per enabled CAE     kvset and dbinit jobs caj-{prefix}-{kvset|dbinit}-{mode} (only with
//                       platformJobsImageDigest; the recov job is not built yet)
//   externalOnly managed  workload-profile CAE without VNet (default)
//   externalOnly vnet     isolated spoke (peered to nothing), CAE + PE subnets, NSGs, NAT
//                         Gateway, private DNS zones, CAE in the spoke
//   externalHybrid        spoke peered to the hub (vnet.create) or the network team's spoke
//                         (vnet.existingVnetId); CAE subnet with the re-asserted route table,
//                         PE subnet, NSGs, private DNS zones + links, CAE in the spoke
//   internalOnly          rejected: iteration 2
//
// Portal logs (ADR-0026): Log Analytics Reader for the portal identity on the workspace. Portal
// costs (ADR-0017): Cost Management Reader for the portal identity on this subscription. Both
// (types.platformEnvironmentRoles) and Platform Job Secret Writer are in the provisioning
// identity's role set for their one principal only (bootstrap.bicep condition, ADR-0043).
//
// Region: every resource uses `location` (no default). Container Apps later read their
// region from the CAE (lessons-from-v1).
//
// Two passes for a new environment (ADR-0035, ADR-0043; the platform pipeline runs them):
//   1. platformJobsImageDigest = '': registry, identities and everything else, no platform job;
//   2. after `az acr import` of saf-jobs by digest into the platform registry: the same
//      parameters with the digest; creates the kvset and dbinit jobs and assigns Platform Job
//      Secret Writer to the Entra provisioning identity on each kvset job.
// Once the registry exists, a new digest is imported first and deployed in one pass.

targetScope = 'subscription'

import {
  customRoleDefinitionGuid as nameCustomRoleDefinitionGuid
  diagnosticSetting as nameDiagnosticSetting
  environmentKeyVault as nameEnvironmentKeyVault
  frontDoorEndpoint as nameFrontDoorEndpoint
  frontDoorProfile as nameFrontDoorProfile
  frontDoorSecurityPolicy as nameFrontDoorSecurityPolicy
  frontDoorWafPolicy as nameFrontDoorWafPolicy
  hubPeering as nameHubPeering
  logAnalyticsWorkspace as nameLogAnalyticsWorkspace
  managedEnvironment as nameManagedEnvironment
  natGateway as nameNatGateway
  networkSecurityGroup as nameNetworkSecurityGroup
  platformActionGroup as namePlatformActionGroup
  platformActionGroupShortName as namePlatformActionGroupShortName
  platformContainerRegistry as namePlatformContainerRegistry
  platformJob as namePlatformJob
  platformJobIdentity as namePlatformJobIdentity
  platformResourceGroup as namePlatformResourceGroup
  privateDnsResourceGroup as namePrivateDnsResourceGroup
  privateDnsZone as namePrivateDnsZone
  privateEndpointNic as namePrivateEndpointNic
  spokePrivateEndpoint as nameSpokePrivateEndpoint
  subnet as nameSubnet
  virtualNetwork as nameVirtualNetwork
} from '../modules/naming/naming.bicep'
import {
  builtInRoles
  environmentKind as environmentKindType
  platformEnvironmentRoles
  frontDoorProfileConfig
  hubConfig
  networkModesConfig
} from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (environment-specific values have no defaults: a missing value fails loudly)
// ------------------------------------------------------------------------------------------

@description('Instance prefix (naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('environments[].name')
@minLength(2)
@maxLength(8)
param environmentName string

@description('environments[].kind')
param environmentKind environmentKindType

@description('Azure region: environments[].region, else defaultRegion (resolved by the pipeline).')
param location string

@description('environments[].vaultGeneration (seed of the environment vault names).')
@minValue(0)
param vaultGeneration int

@description('environments[].networkModes with schema defaults resolved.')
param networkModes networkModesConfig

@description('environments[].hub; required when externalHybrid is enabled, else null.')
param hub hubConfig?

@description('This environment\'s entry of frontDoor.managed.profiles when frontDoor.mode is managed; null otherwise (external mode or not listed).')
param frontDoor frontDoorProfileConfig?

@description('observability.logRetentionDays')
@minValue(30)
@maxValue(730)
param logRetentionDays int

@description('Recipients of platform alerts (notifications.email.platformTeamAddress). May be empty.')
param platformAlertEmails string[]

@description('Value of the ManagedBy tag (e.g. the instance productName).')
param managedBy string

@description('Additional tags for every resource (e.g. CostCenter).')
param tags object

@description('Digest (sha256:<64 hex>) of the saf-jobs image (images/images.json) imported into this environment\'s platform registry. Empty string = pass 1: the registry and identities only, no platform jobs (the image is not imported yet).')
param platformJobsImageDigest string

@description('Object (principal) ID of id-{prefix}-entra-provisioning: bootstrap output entraProvisioningIdentity.principalId of the portal host environment. Gets Platform Job Secret Writer on each kvset job (ADR-0035).')
param entraProvisioningPrincipalId string

@description('Object (principal) ID of the portal identity id-{prefix}-portal (instance.yaml portal.identityPrincipalId, ADR-0037): Log Analytics Reader on this environment\'s workspace, for the portal\'s log viewer (ADR-0026), and Cost Management Reader on this subscription, for the Costs tab (ADR-0017). Empty = no assignments (the portal is not set up yet).')
param portalIdentityPrincipalId string

// ------------------------------------------------------------------------------------------
// Derived settings and input validation
// ------------------------------------------------------------------------------------------

var ext = networkModes.?externalOnly
var hyb = networkModes.?externalHybrid
var extManaged = ext != null && ext.?network == 'managed'
var extVnet = ext != null && ext.?network == 'vnet'
var hybEnabled = hyb != null
var hybCreate = hybEnabled && hyb.?vnet.?create != null
var hybExisting = hybEnabled && hyb.?vnet.?existingVnetId != null

// One vault per network variant, only when a CAE of that variant exists (ADR-0003).
var needsPublicVault = extManaged
var needsPrivateVault = extVnet || hybEnabled

var isProd = environmentKind == 'prod'

var fdSku = frontDoor == null ? 'Standard' : frontDoor.?sku ?? (isProd ? 'Premium' : 'Standard')
var fdWafMode = frontDoor == null ? 'off' : frontDoor.?waf.?mode ?? (isProd ? 'prevention' : 'detection')
var fdManagedRuleSets = frontDoor == null ? false : frontDoor.?waf.?managedRuleSets ?? (fdSku == 'Premium')

// Platform jobs only once the jobs image is in the platform registry (pass 2).
var jobsEnabled = !empty(platformJobsImageDigest)
// sha256:<64 lowercase hex>; ranges are bounded so a short value can't index past its end.
var jobsDigestLength = length(platformJobsImageDigest)
var jobsDigestValid = jobsDigestLength == 71 && startsWith(platformJobsImageDigest, 'sha256:') && empty(filter(
  range(7, max(min(jobsDigestLength, 71) - 7, 0)),
  i => !contains('0123456789abcdef', substring(platformJobsImageDigest, i, 1))
))
// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var entraPrincipalLower = toLower(entraProvisioningPrincipalId)
var entraPrincipalIsGuid = length(entraPrincipalLower) == 36 && empty(filter(
  range(0, min(length(entraPrincipalLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(entraPrincipalLower, i, 1) != '-' : !contains('0123456789abcdef', substring(entraPrincipalLower, i, 1))
))

var portalPrincipalLower = toLower(portalIdentityPrincipalId)
var portalPrincipalIsGuid = length(portalPrincipalLower) == 36 && empty(filter(
  range(0, min(length(portalPrincipalLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(portalPrincipalLower, i, 1) != '-' : !contains('0123456789abcdef', substring(portalPrincipalLower, i, 1))
))

var inputErrors = filter(
  [
    networkModes.?internalOnly != null
      ? 'networkModes.internalOnly is not available in this core version (iteration 2).'
      : ''
    ext == null && !hybEnabled ? 'networkModes must enable externalOnly or externalHybrid.' : ''
    extVnet && (ext.?vnetAddressSpace == null || ext.?caeSubnetPrefix == null || ext.?privateEndpointSubnetPrefix == null || ext.?natGatewayPublicIpCount == null)
      ? 'externalOnly network vnet needs vnetAddressSpace, caeSubnetPrefix, privateEndpointSubnetPrefix and natGatewayPublicIpCount.'
      : ''
    extManaged && (ext.?vnetAddressSpace != null || ext.?caeSubnetPrefix != null || ext.?privateEndpointSubnetPrefix != null || ext.?natGatewayPublicIpCount != null)
      ? 'externalOnly network managed takes no VNet fields.'
      : ''
    hybEnabled && hub == null ? 'externalHybrid needs environments[].hub.' : ''
    hybEnabled && hybCreate == hybExisting
      ? 'externalHybrid.vnet needs exactly one of existingVnetId or create.'
      : ''
    frontDoor != null && frontDoor.?environment != environmentName
      ? 'frontDoor profile belongs to environment "${frontDoor.?environment}", not "${environmentName}".'
      : ''
    fdManagedRuleSets && fdSku != 'Premium' ? 'Front Door managed rule sets need the Premium tier.' : ''
    jobsEnabled && !jobsDigestValid
      ? 'platformJobsImageDigest must be empty (pass 1) or sha256:<64 lowercase hex> (images/images.json).'
      : ''
    !entraPrincipalIsGuid
      ? 'entraProvisioningPrincipalId must be a GUID (the object ID of id-{prefix}-entra-provisioning).'
      : ''
    !empty(portalIdentityPrincipalId) && !portalPrincipalIsGuid
      ? 'portalIdentityPrincipalId must be empty or a GUID (the object ID of id-{prefix}-portal).'
      : ''
  ],
  message => !empty(message)
)

var platformRgName = empty(inputErrors)
  ? namePlatformResourceGroup(prefix, environmentName)
  : fail('environment.bicep: ${join(inputErrors, ' ')}')

var platformRgId = subscriptionResourceId('Microsoft.Resources/resourceGroups', platformRgName)
var sub = subscription().subscriptionId

// Resource IDs are computed from names (never taken from module outputs) so what-if can
// predict every resource on a re-run (backlog US03.05: a re-run without changes is a no-op);
// explicit dependsOn keeps the order.
var nsgCaeExtName = nameNetworkSecurityGroup(prefix, 'cae', 'externalOnly', environmentName)
var nsgPepExtName = nameNetworkSecurityGroup(prefix, 'pep', 'externalOnly', environmentName)
var nsgCaeHybName = nameNetworkSecurityGroup(prefix, 'cae', 'externalHybrid', environmentName)
var nsgPepHybName = nameNetworkSecurityGroup(prefix, 'pep', 'externalHybrid', environmentName)
var natExtName = nameNatGateway(prefix, 'externalOnly', environmentName)
var vnetExtName = nameVirtualNetwork(prefix, 'externalOnly', environmentName)
var vnetHybName = nameVirtualNetwork(prefix, 'externalHybrid', environmentName)
var snetCaeExtName = nameSubnet(prefix, 'cae', 'externalOnly', environmentName)
var snetPepExtName = nameSubnet(prefix, 'pep', 'externalOnly', environmentName)
var snetCaeHybName = nameSubnet(prefix, 'cae', 'externalHybrid', environmentName)
var snetPepHybName = nameSubnet(prefix, 'pep', 'externalHybrid', environmentName)
var dnsRgExtName = namePrivateDnsResourceGroup(prefix, 'externalOnly', environmentName)
var dnsRgHybName = namePrivateDnsResourceGroup(prefix, 'externalHybrid', environmentName)

var vnetExtId = resourceId(sub, platformRgName, 'Microsoft.Network/virtualNetworks', vnetExtName)
var hybExistingVnetId = hyb.?vnet.?existingVnetId ?? ''
// Placeholder keeps the split well-formed when the mode or the existing-VNet option is off.
var hybExistingVnetParts = split(
  hybExisting
    ? hybExistingVnetId
    : '/subscriptions/${sub}/resourceGroups/${platformRgName}/providers/Microsoft.Network/virtualNetworks/none',
  '/'
)
var hybVnetId = hybCreate
  ? resourceId(sub, platformRgName, 'Microsoft.Network/virtualNetworks', vnetHybName)
  : hybExistingVnetId
var vaultZoneExtId = resourceId(sub, dnsRgExtName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))
var vaultZoneHybId = resourceId(sub, dnsRgHybName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))

var commonTags = union(tags, {
  Environment: environmentName
  ManagedBy: managedBy
})

var diagName = nameDiagnosticSetting(prefix, environmentName)
var vaultSoftDeleteDays = isProd ? 90 : 7

var keyVaultSecretsOfficer = builtInRoles.keyVaultSecretsOfficer

var privateDnsServices = [
  'vault'
  'postgres'
  'sql'
  'blob'
]

// ------------------------------------------------------------------------------------------
// Resource groups
// ------------------------------------------------------------------------------------------

resource platformRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: platformRgName
  location: location
  tags: commonTags
}

// Private DNS zones are kept per VNet; same-named zones need separate resource groups.
resource dnsRgExt 'Microsoft.Resources/resourceGroups@2025-04-01' = if (extVnet) {
  name: dnsRgExtName
  location: location
  tags: commonTags
}

resource dnsRgHyb 'Microsoft.Resources/resourceGroups@2025-04-01' = if (hybEnabled) {
  name: dnsRgHybName
  location: location
  tags: commonTags
}

// ------------------------------------------------------------------------------------------
// Monitoring
// ------------------------------------------------------------------------------------------

module workspace '../modules/monitoring/log-analytics.bicep' = {
  scope: platformRg
  params: {
    name: nameLogAnalyticsWorkspace(prefix, environmentName)
    location: location
    retentionInDays: logRetentionDays
    tags: commonTags
    portalPrincipalId: portalIdentityPrincipalId
  }
}

// Portal costs (ADR-0017): one Cost Management Query per subscription, grouped by resource group,
// so the role sits at subscription scope (a role on app resource groups can't run that query).
// Read-only: it can't write budgets. In types.platformEnvironmentRoles, not types.builtInRoles: the
// provisioning identity may assign it to the portal identity only (ADR-0043).
var costManagementReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', platformEnvironmentRoles.costManagementReader)

resource portalCostReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(portalIdentityPrincipalId)) {
  // The portal identity lives in the host environment's subscription: its object ID seeds the name.
  name: guid(subscription().id, portalIdentityPrincipalId, costManagementReaderRoleId)
  properties: {
    principalId: portalIdentityPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: costManagementReaderRoleId
    description: 'Portal: app costs, one Cost Management query per subscription, shown per app resource group (ADR-0017).'
  }
}

module actionGroup '../modules/monitoring/action-group.bicep' = {
  scope: platformRg
  params: {
    name: namePlatformActionGroup(prefix, environmentName)
    shortName: namePlatformActionGroupShortName(prefix, environmentName)
    emailAddresses: platformAlertEmails
    tags: commonTags
  }
}

// ------------------------------------------------------------------------------------------
// External only, network: managed (default) - no VNet, NSG, NAT Gateway or DNS zone
// ------------------------------------------------------------------------------------------

module caeExtManaged '../modules/cae/managed-environment.bicep' = if (extManaged) {
  scope: platformRg
  params: {
    name: nameManagedEnvironment(prefix, 'externalOnly', environmentName)
    location: location
    infrastructureSubnetId: ''
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

// ------------------------------------------------------------------------------------------
// External only, network: vnet - isolated spoke, peered or connected to nothing
// ------------------------------------------------------------------------------------------

module nsgCaeExt '../modules/network/nsg.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: nsgCaeExtName
    location: location
    purpose: 'cae'
    subnetPrefix: ext.?caeSubnetPrefix ?? ''
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

module nsgPepExt '../modules/network/nsg.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: nsgPepExtName
    location: location
    purpose: 'pep'
    subnetPrefix: ext.?privateEndpointSubnetPrefix ?? ''
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

module natExt '../modules/network/nat-gateway.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: natExtName
    prefix: prefix
    environmentName: environmentName
    mode: 'externalOnly'
    location: location
    publicIpCount: ext.?natGatewayPublicIpCount ?? 1
    tags: commonTags
  }
}

module vnetExt '../modules/network/spoke-vnet.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: vnetExtName
    location: location
    addressSpace: ext.?vnetAddressSpace ?? ''
    caeSubnet: {
      name: snetCaeExtName
      addressPrefix: ext.?caeSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgCaeExtName)
    }
    privateEndpointSubnet: {
      name: snetPepExtName
      addressPrefix: ext.?privateEndpointSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgPepExtName)
    }
    natGatewayId: resourceId(sub, platformRgName, 'Microsoft.Network/natGateways', natExtName)
    routeTableId: null
    hubPeering: null
    dnsServers: []
    tags: commonTags
  }
  dependsOn: [
    nsgCaeExt
    nsgPepExt
    natExt
  ]
}

module dnsExt '../modules/network/private-dns-zones.bicep' = if (extVnet) {
  scope: dnsRgExt
  params: {
    vnetId: vnetExtId
    services: privateDnsServices
    tags: commonTags
  }
  dependsOn: [
    vnetExt
  ]
}

module caeExtVnet '../modules/cae/managed-environment.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: nameManagedEnvironment(prefix, 'externalOnly', environmentName)
    location: location
    infrastructureSubnetId: '${vnetExtId}/subnets/${snetCaeExtName}'
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
  dependsOn: [
    vnetExt
  ]
}

// ------------------------------------------------------------------------------------------
// External with internal access - spoke connected to the customer hub
// ------------------------------------------------------------------------------------------

module nsgCaeHyb '../modules/network/nsg.bicep' = if (hybEnabled) {
  scope: platformRg
  params: {
    name: nsgCaeHybName
    location: location
    purpose: 'cae'
    subnetPrefix: hyb.?caeSubnetPrefix ?? ''
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

module nsgPepHyb '../modules/network/nsg.bicep' = if (hybEnabled) {
  scope: platformRg
  params: {
    name: nsgPepHybName
    location: location
    purpose: 'pep'
    subnetPrefix: hyb.?privateEndpointSubnetPrefix ?? ''
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

// vnet.create: the platform owns the spoke and its spoke->hub peering. The hub side belongs
// to the network team (output hubPeeringRequest).
module vnetHybCreated '../modules/network/spoke-vnet.bicep' = if (hybCreate) {
  scope: platformRg
  params: {
    name: vnetHybName
    location: location
    addressSpace: hyb.?vnet.?create.?addressSpace ?? ''
    caeSubnet: {
      name: snetCaeHybName
      addressPrefix: hyb.?caeSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgCaeHybName)
    }
    privateEndpointSubnet: {
      name: snetPepHybName
      addressPrefix: hyb.?privateEndpointSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgPepHybName)
    }
    natGatewayId: null
    // Required and re-asserted on every deploy (lessons-from-v1). TODO(verify): with a UDR
    // 0.0.0.0/0 to the firewall, inbound internet traffic of an external CAE must not return
    // asymmetrically through the firewall (network team's route table). Verify in sandbox: FW-1.
    routeTableId: hyb.?routeTableId
    hubPeering: {
      name: nameHubPeering(prefix, 'externalHybrid', environmentName)
      remoteVirtualNetworkId: hub.?vnetId ?? ''
      useRemoteGateways: hyb.?vnet.?create.?useRemoteGateways ?? false
    }
    dnsServers: hyb.?dnsServers ?? []
    tags: commonTags
  }
  dependsOn: [
    nsgCaeHyb
    nsgPepHyb
  ]
}

// vnet.existingVnetId: the network team owns the spoke and its peering; the platform owns its
// two subnets inside it. TODO(verify): the existing VNet must be in this environment's
// subscription and region (NSGs and private endpoints can't cross either).
module subnetsHybExisting '../modules/network/existing-vnet-subnets.bicep' = if (hybExisting) {
  scope: resourceGroup(hybExistingVnetParts[2], hybExistingVnetParts[4])
  params: {
    vnetName: last(hybExistingVnetParts)
    caeSubnet: {
      name: snetCaeHybName
      addressPrefix: hyb.?caeSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgCaeHybName)
      // Required and re-asserted on every deploy (lessons-from-v1).
      routeTableId: hyb.?routeTableId ?? ''
    }
    privateEndpointSubnet: {
      name: snetPepHybName
      addressPrefix: hyb.?privateEndpointSubnetPrefix ?? ''
      nsgId: resourceId(sub, platformRgName, 'Microsoft.Network/networkSecurityGroups', nsgPepHybName)
    }
  }
  dependsOn: [
    nsgCaeHyb
    nsgPepHyb
  ]
}

module dnsHyb '../modules/network/private-dns-zones.bicep' = if (hybEnabled) {
  scope: dnsRgHyb
  params: {
    vnetId: hybVnetId
    services: privateDnsServices
    tags: commonTags
  }
  dependsOn: [
    vnetHybCreated
    subnetsHybExisting
  ]
}

module caeHyb '../modules/cae/managed-environment.bicep' = if (hybEnabled) {
  scope: platformRg
  params: {
    name: nameManagedEnvironment(prefix, 'externalHybrid', environmentName)
    location: location
    infrastructureSubnetId: '${hybVnetId}/subnets/${snetCaeHybName}'
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
  dependsOn: [
    vnetHybCreated
    subnetsHybExisting
  ]
}

// ------------------------------------------------------------------------------------------
// Environment Key Vaults (one per network variant, ADR-0003 / ADR-0020)
// ------------------------------------------------------------------------------------------

var publicVaultName = nameEnvironmentKeyVault(prefix, environmentName, 'public', sub, platformRgId, vaultGeneration)
var privateVaultName = nameEnvironmentKeyVault(prefix, environmentName, 'private', sub, platformRgId, vaultGeneration)
var privateVaultId = resourceId(sub, platformRgName, 'Microsoft.KeyVault/vaults', privateVaultName)

module vaultPublic '../modules/keyvault/key-vault.bicep' = if (needsPublicVault) {
  scope: platformRg
  params: {
    name: publicVaultName
    location: location
    publicNetworkAccess: true
    enablePurgeProtection: isProd
    softDeleteRetentionInDays: vaultSoftDeleteDays
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

module vaultPrivate '../modules/keyvault/key-vault.bicep' = if (needsPrivateVault) {
  scope: platformRg
  params: {
    name: privateVaultName
    location: location
    publicNetworkAccess: false
    enablePurgeProtection: isProd
    softDeleteRetentionInDays: vaultSoftDeleteDays
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

// One private endpoint of the private vault in each VNet-based spoke. The portal-side
// endpoint (host environment only, ADR-0025) belongs to the portal network, not built yet.
// Verify in sandbox: NET-4, KV-8.
module vaultPrivatePepExt '../modules/privateendpoint/private-endpoint.bicep' = if (extVnet) {
  scope: platformRg
  params: {
    name: nameSpokePrivateEndpoint(privateVaultName, 'externalOnly')
    nicName: namePrivateEndpointNic(nameSpokePrivateEndpoint(privateVaultName, 'externalOnly'))
    location: location
    subnetId: '${vnetExtId}/subnets/${snetPepExtName}'
    targetResourceId: privateVaultId
    groupId: 'vault'
    privateDnsZoneId: vaultZoneExtId
    tags: commonTags
  }
  dependsOn: [
    vaultPrivate
    vnetExt
    dnsExt
  ]
}

module vaultPrivatePepHyb '../modules/privateendpoint/private-endpoint.bicep' = if (hybEnabled) {
  scope: platformRg
  params: {
    name: nameSpokePrivateEndpoint(privateVaultName, 'externalHybrid')
    nicName: namePrivateEndpointNic(nameSpokePrivateEndpoint(privateVaultName, 'externalHybrid'))
    location: location
    subnetId: '${hybVnetId}/subnets/${snetPepHybName}'
    targetResourceId: privateVaultId
    groupId: 'vault'
    privateDnsZoneId: vaultZoneHybId
    tags: commonTags
  }
  dependsOn: [
    vaultPrivate
    vnetHybCreated
    subnetsHybExisting
    dnsHyb
  ]
}

// ------------------------------------------------------------------------------------------
// Platform job identities (ADR-0028). The identities exist from pass 1, so landing zones can
// make dbinit the Entra administrator of app databases, and kvset gets its vault and registry
// roles before its jobs exist. Jobs: kvset and dbinit (below); recov is not built yet.
// ------------------------------------------------------------------------------------------

var platformJobSteps = [
  'dbinit'
  'kvset'
  'recov'
]
var kvsetIndex = indexOf(platformJobSteps, 'kvset')
var kvsetIdentityId = resourceId(
  sub,
  platformRgName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  namePlatformJobIdentity(prefix, 'kvset', environmentName)
)
var dbinitIndex = indexOf(platformJobSteps, 'dbinit')
var dbinitIdentityName = namePlatformJobIdentity(prefix, 'dbinit', environmentName)
var dbinitIdentityId = resourceId(sub, platformRgName, 'Microsoft.ManagedIdentity/userAssignedIdentities', dbinitIdentityName)

module jobIdentities '../modules/identity/user-assigned-identities.bicep' = {
  scope: platformRg
  params: {
    names: [for step in platformJobSteps: namePlatformJobIdentity(prefix, step, environmentName)]
    location: location
    tags: commonTags
  }
}

// kvset: Key Vault Secrets Officer on the environment vaults only.
module kvsetOnPublicVault '../modules/rbac/role-assignments.bicep' = if (needsPublicVault) {
  scope: platformRg
  params: {
    target: {
      kind: 'keyVault'
      name: publicVaultName
    }
    principalId: jobIdentities.outputs.principalIds[kvsetIndex]
    principalResourceId: kvsetIdentityId
    roleDefinitionGuid: keyVaultSecretsOfficer
    assignmentDescription: 'kvset platform job writes Easy Auth and environment secrets (ADR-0028).'
  }
  dependsOn: [
    vaultPublic
  ]
}

module kvsetOnPrivateVault '../modules/rbac/role-assignments.bicep' = if (needsPrivateVault) {
  scope: platformRg
  params: {
    target: {
      kind: 'keyVault'
      name: privateVaultName
    }
    principalId: jobIdentities.outputs.principalIds[kvsetIndex]
    principalResourceId: kvsetIdentityId
    roleDefinitionGuid: keyVaultSecretsOfficer
    assignmentDescription: 'kvset platform job writes Easy Auth and environment secrets (ADR-0028).'
  }
  dependsOn: [
    vaultPrivate
  ]
}

// ------------------------------------------------------------------------------------------
// Platform registry and kvset jobs (ADR-0030, ADR-0035)
// ------------------------------------------------------------------------------------------

// Same module as the app registries: Basic, no admin user, no anonymous pull, public network
// access (Basic has no private endpoint), repository-permissions (ABAC) mode, login server with a
// hash suffix. VNet-based CAEs pull through their egress (NAT Gateway, or the hub firewall with
// *.azurecr.io and *.blob.core.windows.net). The NAT Gateway path is verified (JOB-5, kvset and
// dbinit jobs in the isolated VNet variant); the hub firewall path is FW-1.
var platformRegistryName = namePlatformContainerRegistry(prefix, environmentName, sub)

// Repository of the jobs image (images/images.json saf-jobs.repository), imported by digest.
var platformJobsRepository = 'saf-jobs'

module platformRegistry '../modules/registry/container-registry.bicep' = {
  scope: platformRg
  params: {
    name: platformRegistryName
    location: location
    tags: commonTags
  }
}

// kvset: pull rights on the platform registry. In the portal host environment the portal identity
// pulls from it too; portal.bicep assigns that role (ADR-0036). In the repository-permissions mode
// AcrPull is not honoured; Repository Reader without a repository condition acts like plain RBAC
// on the registry (as for app registries).
module kvsetOnPlatformRegistry '../modules/rbac/role-assignments.bicep' = {
  scope: platformRg
  params: {
    target: {
      kind: 'containerRegistry'
      name: platformRegistryName
    }
    principalId: jobIdentities.outputs.principalIds[kvsetIndex]
    principalResourceId: kvsetIdentityId
    roleDefinitionGuid: builtInRoles.containerRegistryRepositoryReader
    assignmentDescription: 'kvset platform job pulls the saf-jobs image from the platform registry (ADR-0035).'
  }
  dependsOn: [
    platformRegistry
  ]
}

// dbinit: the same pull rights. Its administrator role on app database servers comes from each
// landing zone (the servers' Entra administrator), not from here.
module dbinitOnPlatformRegistry '../modules/rbac/role-assignments.bicep' = {
  scope: platformRg
  params: {
    target: {
      kind: 'containerRegistry'
      name: platformRegistryName
    }
    principalId: jobIdentities.outputs.principalIds[dbinitIndex]
    principalResourceId: dbinitIdentityId
    roleDefinitionGuid: builtInRoles.containerRegistryRepositoryReader
    assignmentDescription: 'dbinit platform job pulls the saf-jobs image from the platform registry (ADR-0028).'
  }
  dependsOn: [
    platformRegistry
  ]
}

// One kvset job per enabled CAE, writing the environment vault of the CAE's variant only:
// managed-network CAE -> public vault, VNet-based CAE -> private vault (ADR-0028). Platform Job
// Secret Writer for the Entra provisioning identity on each job and nowhere else (ADR-0035).
var jobSecretWriterRoleGuid = nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'platform-job-secret-writer')

module kvsetJobExt '../modules/jobs/kvset-job.bicep' = if (jobsEnabled && ext != null) {
  scope: platformRg
  params: {
    name: namePlatformJob(prefix, 'kvset', 'externalOnly')
    location: location
    environmentId: resourceId(
      sub,
      platformRgName,
      'Microsoft.App/managedEnvironments',
      nameManagedEnvironment(prefix, 'externalOnly', environmentName)
    )
    identityId: kvsetIdentityId
    identityClientId: jobIdentities.outputs.clientIds[kvsetIndex]
    registryName: platformRegistryName
    imageRepository: platformJobsRepository
    imageDigest: platformJobsImageDigest
    vaultName: extManaged ? publicVaultName : privateVaultName
    entraProvisioningPrincipalId: entraProvisioningPrincipalId
    writerRoleDefinitionGuid: jobSecretWriterRoleGuid
    tags: commonTags
  }
  dependsOn: [
    caeExtManaged
    caeExtVnet
    vaultPublic
    vaultPrivate
    kvsetOnPlatformRegistry
  ]
}

module kvsetJobHyb '../modules/jobs/kvset-job.bicep' = if (jobsEnabled && hybEnabled) {
  scope: platformRg
  params: {
    name: namePlatformJob(prefix, 'kvset', 'externalHybrid')
    location: location
    environmentId: resourceId(
      sub,
      platformRgName,
      'Microsoft.App/managedEnvironments',
      nameManagedEnvironment(prefix, 'externalHybrid', environmentName)
    )
    identityId: kvsetIdentityId
    identityClientId: jobIdentities.outputs.clientIds[kvsetIndex]
    registryName: platformRegistryName
    imageRepository: platformJobsRepository
    imageDigest: platformJobsImageDigest
    vaultName: privateVaultName
    entraProvisioningPrincipalId: entraProvisioningPrincipalId
    writerRoleDefinitionGuid: jobSecretWriterRoleGuid
    tags: commonTags
  }
  dependsOn: [
    caeHyb
    vaultPrivate
    kvsetOnPlatformRegistry
  ]
}

// One dbinit job per enabled CAE (ADR-0028): it reaches the database servers of the apps in that
// CAE, over their public endpoint (managed network) or their private endpoint (VNet-based). The
// Azure provisioning identity starts it with its Contributor role; no job-scoped assignment.
module dbinitJobExt '../modules/jobs/dbinit-job.bicep' = if (jobsEnabled && ext != null) {
  scope: platformRg
  params: {
    name: namePlatformJob(prefix, 'dbinit', 'externalOnly')
    location: location
    environmentId: resourceId(
      sub,
      platformRgName,
      'Microsoft.App/managedEnvironments',
      nameManagedEnvironment(prefix, 'externalOnly', environmentName)
    )
    identityId: dbinitIdentityId
    identityName: dbinitIdentityName
    identityClientId: jobIdentities.outputs.clientIds[dbinitIndex]
    registryName: platformRegistryName
    imageRepository: platformJobsRepository
    imageDigest: platformJobsImageDigest
    tags: commonTags
  }
  dependsOn: [
    caeExtManaged
    caeExtVnet
    dbinitOnPlatformRegistry
  ]
}

module dbinitJobHyb '../modules/jobs/dbinit-job.bicep' = if (jobsEnabled && hybEnabled) {
  scope: platformRg
  params: {
    name: namePlatformJob(prefix, 'dbinit', 'externalHybrid')
    location: location
    environmentId: resourceId(
      sub,
      platformRgName,
      'Microsoft.App/managedEnvironments',
      nameManagedEnvironment(prefix, 'externalHybrid', environmentName)
    )
    identityId: dbinitIdentityId
    identityName: dbinitIdentityName
    identityClientId: jobIdentities.outputs.clientIds[dbinitIndex]
    registryName: platformRegistryName
    imageRepository: platformJobsRepository
    imageDigest: platformJobsImageDigest
    tags: commonTags
  }
  dependsOn: [
    caeHyb
    dbinitOnPlatformRegistry
  ]
}

// ------------------------------------------------------------------------------------------
// Managed Front Door profile of this environment (ADR-0010)
// ------------------------------------------------------------------------------------------

module frontDoorProfile '../modules/frontdoor/profile.bicep' = if (frontDoor != null) {
  scope: platformRg
  params: {
    profileName: nameFrontDoorProfile(prefix, environmentName)
    endpointName: nameFrontDoorEndpoint(prefix, environmentName)
    wafPolicyName: nameFrontDoorWafPolicy(prefix, environmentName)
    securityPolicyName: nameFrontDoorSecurityPolicy(prefix, environmentName)
    sku: fdSku
    wafMode: fdWafMode
    managedRuleSets: fdManagedRuleSets
    workspaceId: workspace.outputs.id
    diagnosticSettingName: diagName
    tags: commonTags
    // Reader on the profile only, for the custom domains in the portal (ADR-0010, amended 2026-11-01).
    portalPrincipalId: portalIdentityPrincipalId
  }
}

// ------------------------------------------------------------------------------------------
// Outputs (recorded by the platform pipeline; landing zones recompute names via naming)
// ------------------------------------------------------------------------------------------

output platformResourceGroupName string = platformRg.name
output logAnalyticsWorkspaceId string = workspace.outputs.id
output platformActionGroupId string = actionGroup.outputs.id

@description('CAE resource IDs keyed by network mode (null = mode not enabled).')
output managedEnvironmentIds object = {
  externalOnly: extManaged ? caeExtManaged!.outputs.id : (extVnet ? caeExtVnet!.outputs.id : null)
  externalHybrid: hybEnabled ? caeHyb!.outputs.id : null
}

@description('Environment vault names by variant (null when the environment has no CAE of that variant).')
output environmentKeyVaults object = {
  public: needsPublicVault ? vaultPublic!.outputs.name : null
  private: needsPrivateVault ? vaultPrivate!.outputs.name : null
}

@description('NAT Gateway egress IPs of the isolated External-only spoke (empty otherwise).')
output externalOnlyEgressIps string[] = extVnet ? natExt!.outputs.publicIpAddresses : []

@description('Platform job identities: name, principal ID and client ID per step.')
output platformJobIdentities object = toObject(
  range(0, length(platformJobSteps)),
  i => platformJobSteps[i],
  i => {
    name: namePlatformJobIdentity(prefix, platformJobSteps[i], environmentName)
    principalId: jobIdentities.outputs.principalIds[i]
    clientId: jobIdentities.outputs.clientIds[i]
  }
)

@description('Platform registry (ADR-0035): saf-jobs is imported into it by digest between pass 1 and pass 2. Read the login server from here, never build it.')
output platformRegistry object = {
  name: platformRegistry.outputs.name
  loginServer: platformRegistry.outputs.loginServer
  id: platformRegistry.outputs.id
}

@description('kvset job resource IDs keyed by network mode (null = mode not enabled, or pass 1 without platformJobsImageDigest).')
output kvsetJobs object = {
  externalOnly: jobsEnabled && ext != null ? kvsetJobExt!.outputs.id : null
  externalHybrid: jobsEnabled && hybEnabled ? kvsetJobHyb!.outputs.id : null
}

@description('dbinit job per network-mode CAE (null before pass 2, or without that CAE).')
output dbinitJobs object = {
  externalOnly: jobsEnabled && ext != null ? dbinitJobExt!.outputs.id : null
  externalHybrid: jobsEnabled && hybEnabled ? dbinitJobHyb!.outputs.id : null
}

@description('Managed Front Door: profile ID, expected X-Azure-FDID and endpoint host (null when not managed here).')
output frontDoor object? = frontDoor == null
  ? null
  : {
      profileId: frontDoorProfile!.outputs.profileId
      frontDoorId: frontDoorProfile!.outputs.frontDoorId
      endpointHostName: frontDoorProfile!.outputs.endpointHostName
      sku: fdSku
      wafMode: fdWafMode
    }

@description('Hub-side peering the network team must create (externalHybrid with vnet.create).')
output hubPeeringRequest object? = hybCreate
  ? {
      spokeVnetId: hybVnetId
      hubVnetId: hub.?vnetId
    }
  : null
