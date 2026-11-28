// Azure Database for PostgreSQL Flexible Server of one app x environment (ADR-0011,
// data-services.md). Entra-only from creation (no administrator login or password), TLS
// required, always public access mode (never VNet integration):
//   managed network : public endpoint with only the "allow Azure services" rule (0.0.0.0)
//   VNet-based      : public network access disabled; the caller adds a private endpoint
//   prepare pass    : both, while an app moves between network modes (ADR-0060): public
//                     access is an explicit input, not derived from the endpoint
// Creation-time choices (geo-redundant backup, auth, network mode) can't be changed later.
// The Entra administrator is the environment's dbinit platform job identity (ADR-0028), which
// creates the runtime principal and grants; for the portal's own server (portal.bicep, ADR-0038)
// it is the portal identity, which applies the portal's migrations itself.
// Verify in sandbox: PG-1 (exact Bicep), PG-3 (immutability), PG-4 (geo-restore), MNET-2.

import { privateEndpoint, privateEndpointNic } from '../naming/naming.bicep'

@description('Server name (naming.postgresServer).')
param name string

@description('Database name (naming.postgresDatabase).')
param databaseName string

@description('Azure region (must support geo-redundant backup when geoRedundantBackup is true).')
param location string

@description('Resolved size: SKU name, tier, storage and major version.')
param size {
  skuName: string
  tier: 'Burstable' | 'GeneralPurpose' | 'MemoryOptimized'
  storageSizeGB: int
  version: string
}

@description('PITR retention: 35 days prod, 7 nonprod (instance.yaml data.backup).')
@minValue(7)
@maxValue(35)
param backupRetentionDays int

@description('Geo-redundant backup (prod default). Set at creation only.')
param geoRedundantBackup bool

@description('Public network access: true for the managed-network variant, false with a private endpoint (VNet-based); true together with privateEndpointTarget only in the prepare pass of a network mode change (ADR-0060). false needs privateEndpointTarget.')
param publicNetworkAccess bool

@description('VNet-based variant: private-endpoint subnet and the spoke\'s privatelink.postgres zone. Null = managed-network variant (public endpoint + allow-Azure-services rule).')
param privateEndpointTarget {
  subnetId: string
  privateDnsZoneId: string
}?

@description('Entra administrator: the dbinit platform job identity (app servers) or the portal identity (the portal\'s server, ADR-0038).')
param administrator {
  objectId: string
  name: string
}

@description('Log Analytics workspace for server logs.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

// Explicit, not derived from the endpoint (ADR-0060): a mode change's prepare pass creates the
// endpoint while public access stays on. Without an endpoint, public access must be on.
var publicAccess = publicNetworkAccess || privateEndpointTarget != null
  ? publicNetworkAccess
  : fail('postgres.bicep: publicNetworkAccess false needs privateEndpointTarget (nothing could reach the server).')

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2025-08-01' = {
  name: name
  location: location
  tags: tags
  sku: {
    name: size.skuName
    tier: size.tier
  }
  properties: {
    version: size.version
    authConfig: {
      activeDirectoryAuth: 'Enabled'
      passwordAuth: 'Disabled'
      tenantId: tenant().tenantId
    }
    storage: {
      storageSizeGB: size.storageSizeGB
      autoGrow: 'Enabled'
    }
    backup: {
      backupRetentionDays: backupRetentionDays
      geoRedundantBackup: geoRedundantBackup ? 'Enabled' : 'Disabled'
    }
    highAvailability: {
      mode: 'Disabled'
    }
    network: {
      publicNetworkAccess: publicAccess ? 'Enabled' : 'Disabled'
    }
  }
}

// The Entra admin must exist before any principal is created (data-services.md).
resource entraAdmin 'Microsoft.DBforPostgreSQL/flexibleServers/administrators@2025-08-01' = {
  parent: server
  name: administrator.objectId
  properties: {
    principalType: 'ServicePrincipal'
    principalName: administrator.name
    tenantId: tenant().tenantId
  }
}

resource secureTransport 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2025-08-01' = {
  parent: server
  name: 'require_secure_transport'
  properties: {
    value: 'ON'
    source: 'user-override'
  }
  dependsOn: [
    entraAdmin
  ]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2025-08-01' = {
  parent: server
  name: databaseName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
  dependsOn: [
    secureTransport
  ]
}

// With public access only (managed network, or a mode change's prepare pass while the app still
// runs there): "Allow public access from any Azure service" (0.0.0.0-0.0.0.0).
// Never 0.0.0.0-255.255.255.255.
resource allowAzureServices 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2025-08-01' = if (publicAccess) {
  parent: server
  name: 'AllowAllAzureServicesAndResourcesWithinAzureIps'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
  dependsOn: [
    database
  ]
}

// TODO(verify): whether PostgreSQLLogs is the right category for access review (PG-1).
// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: server
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'PostgreSQLLogs'
        enabled: true
      }
    ]
  }
}

module endpoint '../privateendpoint/private-endpoint.bicep' = if (privateEndpointTarget != null) {
  params: {
    name: privateEndpoint(server.name, '')
    nicName: privateEndpointNic(privateEndpoint(server.name, ''))
    location: location
    subnetId: privateEndpointTarget!.subnetId
    targetResourceId: server.id
    groupId: 'postgresqlServer'
    privateDnsZoneId: privateEndpointTarget!.privateDnsZoneId
    tags: tags
  }
  dependsOn: [
    database
  ]
}

output id string = server.id
output name string = server.name
output fqdn string = server.properties.fullyQualifiedDomainName
