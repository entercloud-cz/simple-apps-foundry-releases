// Azure SQL logical server + one database of one app x environment (ADR-0011,
// data-services.md). Entra-only authentication from creation (no SQL login), TLS 1.2,
// provisioned Standard SKUs, backup storage redundancy always set explicitly
// (Local in nonprod, Geo in prod; the Azure default is Geo).
//   managed network : public endpoint with only the "Allow Azure services" rule (0.0.0.0)
//   VNet-based      : public network access disabled + private endpoint
//   prepare pass    : both, while an app moves between network modes (ADR-0060): public
//                     access is an explicit input, not derived from the endpoint
// The provisioning identity needs SQL Security Manager or Contributor to set Entra-only.
// Verify in sandbox: SQL-1 (exact Bicep), SQL-2 (roles), SQL-3 (private endpoint), MNET-2.

import { privateEndpoint, privateEndpointNic } from '../naming/naming.bicep'

@description('Server name (naming.sqlServer).')
param name string

@description('Database name (naming.sqlDatabase).')
param databaseName string

@description('Azure region.')
param location string

@description('Resolved size (instance.yaml data.azureSql.sizes): SKU name (S0, S2, S4) and max size.')
param size {
  skuName: string
  storageGB: int
}

@description('PITR retention: 35 days prod, 7 nonprod.')
@minValue(1)
@maxValue(35)
param backupRetentionDays int

@description('Backup storage redundancy (data.azureSql.backupStorageRedundancy of the environment kind).')
@allowed([
  'Geo'
  'GeoZone'
  'Zone'
  'Local'
])
param backupStorageRedundancy string

@description('Public network access: true for the managed-network variant, false with a private endpoint (VNet-based); true together with privateEndpointTarget only in the prepare pass of a network mode change (ADR-0060). false needs privateEndpointTarget.')
param publicNetworkAccess bool

@description('VNet-based variant: private-endpoint subnet and the spoke\'s privatelink.database zone. Null = managed-network variant.')
param privateEndpointTarget {
  subnetId: string
  privateDnsZoneId: string
}?

@description('Entra administrator: the dbinit platform job identity.')
param administrator {
  @description('Value of the server administrator SID. TODO(verify): client (application) ID vs object ID for a managed identity (SQL-1).')
  sid: string
  name: string
}

@description('Log Analytics workspace for SQL audit events.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

// Explicit, not derived from the endpoint (ADR-0060): a mode change's prepare pass creates the
// endpoint while public access stays on. Without an endpoint, public access must be on.
var publicAccess = publicNetworkAccess || privateEndpointTarget != null
  ? publicNetworkAccess
  : fail('sql.bicep: publicNetworkAccess false needs privateEndpointTarget (nothing could reach the server).')

resource server 'Microsoft.Sql/servers@2025-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    version: '12.0'
    minimalTlsVersion: '1.2'
    publicNetworkAccess: publicAccess ? 'Enabled' : 'Disabled'
    restrictOutboundNetworkAccess: 'Disabled'
    administrators: {
      administratorType: 'ActiveDirectory'
      principalType: 'Application'
      login: administrator.name
      sid: administrator.sid
      tenantId: tenant().tenantId
      azureADOnlyAuthentication: true
    }
  }
}

// Idempotent re-runs: the server-level flag above applies at creation only.
resource entraOnly 'Microsoft.Sql/servers/azureADOnlyAuthentications@2025-01-01' = {
  parent: server
  name: 'Default'
  properties: {
    azureADOnlyAuthentication: true
  }
}

resource database 'Microsoft.Sql/servers/databases@2025-01-01' = {
  parent: server
  name: databaseName
  location: location
  tags: tags
  sku: {
    name: size.skuName
    tier: 'Standard'
  }
  properties: {
    maxSizeBytes: size.storageGB * 1024 * 1024 * 1024
    requestedBackupStorageRedundancy: backupStorageRedundancy
    zoneRedundant: false
  }
}

resource shortTermRetention 'Microsoft.Sql/servers/databases/backupShortTermRetentionPolicies@2025-01-01' = {
  parent: database
  name: 'default'
  properties: {
    retentionDays: backupRetentionDays
  }
}

// With public access only (managed network, or a mode change's prepare pass while the app still
// runs there): "Allow Azure services and resources to access this server".
resource allowAzureServices 'Microsoft.Sql/servers/firewallRules@2025-01-01' = if (publicAccess) {
  parent: server
  name: 'AllowAllWindowsAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

// Server audit to the environment workspace (data-services.md: access to public endpoints
// must be reviewable). Audit events of the server land in the master database's
// diagnostic setting.
resource auditing 'Microsoft.Sql/servers/auditingSettings@2025-01-01' = {
  parent: server
  name: 'default'
  properties: {
    state: 'Enabled'
    isAzureMonitorTargetEnabled: true
  }
}

resource master 'Microsoft.Sql/servers/databases@2025-01-01' existing = {
  parent: server
  name: 'master'
}

// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: master
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'SQLSecurityAuditEvents'
        enabled: true
      }
    ]
  }
  dependsOn: [
    auditing
  ]
}

module endpoint '../privateendpoint/private-endpoint.bicep' = if (privateEndpointTarget != null) {
  params: {
    name: privateEndpoint(server.name, '')
    nicName: privateEndpointNic(privateEndpoint(server.name, ''))
    location: location
    subnetId: privateEndpointTarget!.subnetId
    targetResourceId: server.id
    groupId: 'sqlServer'
    privateDnsZoneId: privateEndpointTarget!.privateDnsZoneId
    tags: tags
  }
}

output id string = server.id
output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
