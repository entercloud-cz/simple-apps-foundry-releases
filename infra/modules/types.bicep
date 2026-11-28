// Shared user-defined types. The shapes mirror config/schema/instance.schema.json so the
// provisioning and platform pipelines in platform-config can pass instance.yaml values
// through unchanged (after resolving schema defaults, see infra/README.md).
// Import selectively (`import { hubConfig, builtInRoles } from ...`), never `import *`: every exported
// definition an importer pulls in is part of its compiled template and hash (AGENTS.md rule 6).

@export()
@description('environments[].kind. Code branches on the kind, never on environment names (AGENTS.md rule 5).')
type environmentKind = 'prod' | 'nonprod'

@export()
@description('Network mode id (ADR-0003). internalOnly is accepted by the schema but not implemented in iteration 1.')
type networkMode = 'externalOnly' | 'externalHybrid' | 'internalOnly'

@export()
@description('Network variant of External only (ADR-0003): managed (Azure-managed network, default) or vnet (isolated VNet).')
type externalOnlyNetwork = 'managed' | 'vnet'

@export()
@description('environments[].hub (instance.schema.json $defs/hub).')
type hubConfig = {
  @description('Resource ID of the customer hub VNet.')
  vnetId: string

  @description('Firewall private IP (next hop of the network team\'s route table; informational here).')
  firewallPrivateIp: string
}

@export()
@description('environments[].networkModes.externalOnly (instance.schema.json $defs/externalOnlyMode), defaults resolved.')
type externalOnlyConfig = {
  network: externalOnlyNetwork
  vnetAddressSpace: string?
  caeSubnetPrefix: string?
  privateEndpointSubnetPrefix: string?
  natGatewayPublicIpCount: int?
}

@export()
@description('environments[].networkModes.externalHybrid (instance.schema.json $defs/connectedMode), defaults resolved.')
type connectedModeConfig = {
  @description('Exactly one of existingVnetId (network team owns the spoke and its peering) or create (platform creates the spoke and peers it to the hub).')
  vnet: {
    existingVnetId: string?
    create: {
      addressSpace: string
      useRemoteGateways: bool
    }?
  }
  caeSubnetPrefix: string
  privateEndpointSubnetPrefix: string

  @description('Network team\'s route table (UDR 0.0.0.0/0 -> firewall). Re-asserted on every deploy (lessons-from-v1).')
  routeTableId: string

  @description('Custom DNS servers of a platform-created spoke; empty = Azure-provided DNS.')
  dnsServers: string[]

  @description('Informational, shown in the portal.')
  egressAllowListProcess: string?

  @description('Standing egress baseline status; provisioning refuses new hybrid apps until active (not evaluated by Bicep).')
  egressBaseline: {
    status: 'notRequested' | 'requested' | 'active'
    reference: string?
  }?
}

@export()
@description('environments[].networkModes (instance.schema.json).')
type networkModesConfig = {
  externalOnly: externalOnlyConfig?
  externalHybrid: connectedModeConfig?

  @description('Iteration 2. Accepted so instance.yaml can be passed through, rejected by environment.bicep.')
  internalOnly: object?
}

@export()
@description('The environment\'s entry in frontDoor.managed.profiles (instance.schema.json $defs/frontDoorProfile). Omitted values take the default of the environment kind.')
type frontDoorProfileConfig = {
  environment: string
  sku: ('Standard' | 'Premium')?
  waf: {
    mode: ('off' | 'detection' | 'prevention')?
    managedRuleSets: bool?
  }?
}

@export()
@description('portal.network (instance.schema.json): the portal VNet of the portal host environment (ADR-0025).')
type portalNetworkConfig = {
  vnetAddressSpace: string
  caeSubnetPrefix: string
  privateEndpointSubnetPrefix: string

  @description('Hub connection for internal destinations. Rejected by portal.bicep in this core version: it needs the portal VNet peered to the hub, which portal.bicep does not create yet.')
  routeTableId: string?

  @description('Informational: network team approval of the portal VNet.')
  approvalReference: string?
}

@export()
@description('scm.azureDevOps (instance.schema.json $defs/scm), defaults resolved (platformConfigDefaultBranch: main).')
type azureDevOpsConfig = {
  organizationUrl: string
  platformProject: string
  platformConfigRepo: string
  platformConfigDefaultBranch: string

  @description('Not used by portal.bicep; accepted so instance.yaml can be passed through.')
  appsProject: string?

  @description('Not used by portal.bicep; accepted so instance.yaml can be passed through.')
  allowedProjects: string[]?
}

@export()
@description('Azure SQL size resolved from instance.yaml data.azureSql: sizes.{S|M|L} (sku -> skuName, storageGb).')
type sqlSizeConfig = {
  skuName: string
  storageGb: int
}

@export()
@description('The portal\'s own host name through the managed Front Door profile of its host environment (ADR-0071), resolved by `platform environment portal-inputs`.')
type portalFrontDoorConfig = {
  @description('portal.hostName, else portal.{the default DNS zone the host environment may use} when the host environment has a managed Front Door profile; \'\' = none: the portal stays on its Container App\'s own address, without an ingress restriction.')
  hostName: string

  @description('Resource ID of the public Azure DNS zone in the host environment\'s subscription that holds hostName (the template writes its CNAME and _dnsauth TXT there); \'\' = the records are created by hand (output frontDoor.dnsRecords).')
  dnsZoneId: string

  @description('IPv4 prefixes of the AzureFrontDoor.Backend service tag, resolved by the platform pipeline\'s run: the portal\'s only allowed ingress sources with a hostName (Container Apps takes CIDR ranges only). Required with a hostName in pass 2.')
  backendIpRanges: string[]
}

@export()
@description('The portal database (ADR-0070), resolved for the portal host environment like an app database (ADR-0011).')
type portalDatabaseConfig = {
  @description('data.azureSql.sizes entry S: a provisioned Standard SKU (S0 by default), never serverless.')
  size: sqlSizeConfig

  @description('PITR retention of the host environment\'s kind: data.backup.retentionDaysProd or retentionDaysNonprod; 7-35.')
  backupRetentionDays: int

  @description('data.azureSql.backupStorageRedundancy of the host environment\'s kind (always explicit: the Azure default is Geo).')
  backupStorageRedundancy: 'Geo' | 'GeoZone' | 'Zone' | 'Local'
}

@export()
@description('A principal that gets a human role on an app (owner, deputy, developer).')
type principalRef = {
  @description('Entra object ID.')
  principalId: string
  principalType: 'User' | 'Group'
}

@export()
@description('Built-in role definition GUIDs used by the platform (Microsoft Learn, built-in roles reference).')
var builtInRoles = {
  contributor: 'b24988ac-6180-42a0-ab88-20f7382dd24c'
  reader: 'acdd72a7-3385-48ef-bd42-f606fba81ae7'
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  keyVaultSecretsOfficer: 'b86a8fe4-44ce-4948-aee5-eccb2c155cd7'
  managedIdentityOperator: 'f1a07417-d97a-45cb-824c-7a7467783830'
  containerRegistryRepositoryReader: 'b93aa761-3e63-49ed-ac28-beffa264f7ac'
  containerRegistryRepositoryWriter: '2a1e307c-b015-4ebd-883e-5b7698a07328'
  containerRegistryDataImporterAndDataReader: '577a9874-89fd-4f24-9dbd-b5034d0ad23a'
  storageBlobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
}

@export()
@description('Built-in roles environment.bicep assigns to the portal identity only (ADR-0043): Log Analytics Reader on the environment workspace (ADR-0026) and Cost Management Reader on the subscription (ADR-0017). The provisioning identity may assign them to that one principal (bootstrap.bicep condition), so they are not in builtInRoles, which it may assign to anyone.')
var platformEnvironmentRoles = {
  logAnalyticsReader: '73c42c96-874c-492b-b04d-ab87d138a893'
  costManagementReader: '72fafb9e-0641-4937-9268-a91bfd8191a3'
}

@export()
@description('Built-in role Container Registry Repository Contributor (read and delete in the repository-permissions mode): landing-zone.bicep assigns it on the app\'s build-environment registry to the principal that deploys the landing zone, the environment\'s provisioning identity, which purges old images (ADR-0059). The provisioning identity may assign it to itself only (bootstrap.bicep condition), so it is not in builtInRoles. Verify in sandbox: REG-1.')
var registryPurgeRole = '2efddaa5-3f1f-4df3-97df-af3f13818f4c'

@export()
@description('An app owner or deputy: Entra object ID, principal type and email (alerts, budget, Owner/DeputyOwner tags).')
type ownerRef = {
  principalId: string
  principalType: 'User' | 'Group'
  email: string
}

@export()
@description('Environment variable names the platform injects into every app (reserved in platform.yaml).')
var platformEnvVarNames = [
  'PORT'
  'AZURE_CLIENT_ID'
  'APPLICATIONINSIGHTS_CONNECTION_STRING'
  'DATABASE_HOST'
  'DATABASE_NAME'
  'DATABASE_USER'
  'STORAGE_BLOB_ENDPOINT'
  'FRONT_DOOR_ID'
  'CONTAINER_APP_NAME'
]
