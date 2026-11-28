// Resources of one app landing zone, deployed into the app RG by landing-zone.bicep
// (ADR-0004). Everything except the Container App itself, which release.bicep defines.
// Role assignments inside the RG are created here; those on resources in other RGs (CAE,
// environment vault secret, source registry) by landing-zone.bicep.

import {
  actionGroup as nameActionGroup
  actionGroupShortName as nameActionGroupShortName
  appKeyVault as nameAppKeyVault
  applicationInsights as nameApplicationInsights
  budget as nameBudget
  containerRegistry as nameContainerRegistry
  deliveryFederatedCredential as nameDeliveryFederatedCredential
  deliveryIdentity as nameDeliveryIdentity
  diagnosticSetting as nameDiagnosticSetting
  easyAuthIdentity as nameEasyAuthIdentity
  metricAlert as nameMetricAlert
  postgresDatabase as namePostgresDatabase
  postgresServer as namePostgresServer
  privateEndpoint as namePrivateEndpoint
  privateEndpointNic as namePrivateEndpointNic
  runtimeIdentity as nameRuntimeIdentity
  sqlDatabase as nameSqlDatabase
  sqlServer as nameSqlServer
  storageAccount as nameStorageAccount
} from '../modules/naming/naming.bicep'
import {
  builtInRoles
  environmentKind as environmentKindType
  ownerRef
  principalRef
  registryPurgeRole
} from '../modules/types.bicep'

param prefix string
param environmentName string
param environmentKind environmentKindType
param slug string
param generation int

@description('Region of the app\'s CAE (read from the CAE by landing-zone.bicep).')
param location string

@description('Public network access of the app vault and the data services. Steady state: true for the managed network, false for a VNet-based CAE; true with privateNetwork only in the prepare pass of a mode change (ADR-0060). false needs privateNetwork.')
param publicNetworkAccess bool

@description('Private-endpoint subnet and the spoke\'s DNS zone IDs by service: the app vault and the data services get private endpoints there. Null = none (managed network).')
param privateNetwork {
  subnetId: string
  zoneIds: {
    vault: string
    postgres: string
    sql: string
    blob: string
  }
}?

@description('Environment Log Analytics workspace.')
param workspaceId string

@description('true = build environment (no promoteFrom): the delivery identity pushes; false = promotion environment: it imports.')
param isBuildEnvironment bool

@description('Role definition GUID of App Deployer ({prefix}).')
param appDeployerRoleGuid string

@description('ADR-0059: object ID of the principal that deploys the landing zone (deployer().objectId: the environment\'s provisioning identity); in a build environment it gets Container Registry Repository Contributor on the registry to purge old images.')
param registryPurgerPrincipalId string

param owner ownerRef
param deputy ownerRef
param developers principalRef[]

@description('Data services with sizes and backup settings resolved (see landing-zone.bicep).')
param data object

@description('PITR retention days of the environment kind.')
param backupRetentionDays int

@description('PostgreSQL geo-redundant backup (prod kind).')
param postgresGeoRedundantBackup bool

@description('dbinit platform job identity: Entra administrator of the app database.')
param databaseAdministrator {
  objectId: string
  clientId: string
  name: string
}

param alertEmails string[]
param postgresCpuCreditAlert bool

param budget {
  amount: int
  startDate: string
  notifyAtPercent: int[]
  forecastNotifyAtPercent: int[]
}?

@description('Federated credential of the delivery identity (issuer and subject returned by the ADO stage); null until known.')
param deliveryFederation {
  issuer: string
  subject: string
}?

param tags object

var sub = subscription().subscriptionId
var isProd = environmentKind == 'prod'
var diagName = nameDiagnosticSetting(prefix, environmentName)
var roles = builtInRoles
var hasPostgres = data.?postgres != null
var hasSql = data.?azureSql != null
var hasStorage = data.?storage != null

// ------------------------------------------------------------------------------------------
// Identities
// ------------------------------------------------------------------------------------------

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: nameRuntimeIdentity(prefix, slug, environmentName)
  location: location
  tags: tags
}

resource deliveryIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: nameDeliveryIdentity(prefix, slug, environmentName)
  location: location
  tags: tags
}

resource easyAuthIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: nameEasyAuthIdentity(prefix, slug, environmentName)
  location: location
  tags: tags
}

// Workload identity federation for the app's service connection (ADR-0005). The issuer and
// subject come from the ADO stage (creationMode Manual), never computed.
resource deliveryFederatedCredential 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (deliveryFederation != null) {
  parent: deliveryIdentity
  name: nameDeliveryFederatedCredential(slug, environmentName)
  properties: {
    issuer: deliveryFederation.?issuer ?? ''
    subject: deliveryFederation.?subject ?? ''
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// ------------------------------------------------------------------------------------------
// Registry, Key Vault, Application Insights
// ------------------------------------------------------------------------------------------

module registry '../modules/registry/container-registry.bicep' = {
  params: {
    name: nameContainerRegistry(prefix, slug, environmentName, sub, generation)
    location: location
    tags: tags
  }
}

var appVaultName = nameAppKeyVault(prefix, slug, environmentName, sub, generation)

module appVault '../modules/keyvault/key-vault.bicep' = {
  params: {
    name: appVaultName
    location: location
    publicNetworkAccess: publicNetworkAccess
    enablePurgeProtection: isProd
    // Short retention outside prod reduces name clashes on re-creation (lessons-from-v1);
    // generation handles the rest (ADR-0020).
    softDeleteRetentionInDays: isProd ? 90 : 7
    workspaceId: workspaceId
    diagnosticSettingName: diagName
    tags: tags
  }
}

// VNet-based (and a mode change's prepare pass into one, ADR-0060): private endpoint in the spoke.
// The portal-side endpoint pep-{vaultName}-portal (ADR-0025) is a separate deployment in the portal
// resource group (portal-vault-endpoint.bicep, run by the provisioning stage azure_post of the
// portal host environment). Verify in sandbox: KV-6.
module appVaultEndpoint '../modules/privateendpoint/private-endpoint.bicep' = if (privateNetwork != null) {
  params: {
    name: namePrivateEndpoint(appVaultName, '')
    nicName: namePrivateEndpointNic(namePrivateEndpoint(appVaultName, ''))
    location: location
    subnetId: privateNetwork.?subnetId ?? ''
    targetResourceId: appVault.outputs.id
    groupId: 'vault'
    privateDnsZoneId: privateNetwork.?zoneIds.vault ?? ''
    tags: tags
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: nameApplicationInsights(slug, environmentName)
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspaceId
    IngestionMode: 'LogAnalytics'
    // TODO(verify): DisableLocalAuth true would require Entra-authenticated ingestion from
    // the app's OpenTelemetry setup (template skill `observability`); off until decided.
    DisableLocalAuth: false
  }
}

// ------------------------------------------------------------------------------------------
// Data services (optional; iteration 1: at most one relational database per app)
// ------------------------------------------------------------------------------------------

module postgres '../modules/data/postgres.bicep' = if (hasPostgres) {
  params: {
    name: namePostgresServer(prefix, slug, environmentName, sub, generation)
    databaseName: namePostgresDatabase(slug)
    location: location
    size: {
      skuName: data.?postgres.?skuName ?? ''
      tier: data.?postgres.?tier ?? 'Burstable'
      storageSizeGB: data.?postgres.?storageGb ?? 32
      version: data.?postgres.?version ?? ''
    }
    backupRetentionDays: backupRetentionDays
    geoRedundantBackup: postgresGeoRedundantBackup
    publicNetworkAccess: publicNetworkAccess
    privateEndpointTarget: privateNetwork != null
      ? {
          subnetId: privateNetwork.?subnetId ?? ''
          privateDnsZoneId: privateNetwork.?zoneIds.postgres ?? ''
        }
      : null
    administrator: {
      objectId: databaseAdministrator.objectId
      name: databaseAdministrator.name
    }
    workspaceId: workspaceId
    diagnosticSettingName: diagName
    tags: tags
  }
}

module sql '../modules/data/sql.bicep' = if (hasSql) {
  params: {
    name: nameSqlServer(prefix, slug, environmentName, sub, generation)
    databaseName: nameSqlDatabase(slug)
    location: location
    size: {
      skuName: data.?azureSql.?skuName ?? ''
      storageGB: data.?azureSql.?storageGb ?? 250
    }
    backupRetentionDays: backupRetentionDays
    backupStorageRedundancy: data.?azureSql.?backupStorageRedundancy ?? 'Geo'
    publicNetworkAccess: publicNetworkAccess
    privateEndpointTarget: privateNetwork != null
      ? {
          subnetId: privateNetwork.?subnetId ?? ''
          privateDnsZoneId: privateNetwork.?zoneIds.sql ?? ''
        }
      : null
    administrator: {
      // TODO(verify): SQL-1 decides whether the SID of a managed identity admin is its
      // client (application) ID or its object ID.
      sid: databaseAdministrator.clientId
      name: databaseAdministrator.name
    }
    workspaceId: workspaceId
    diagnosticSettingName: diagName
    tags: tags
  }
}

module storage '../modules/data/storage.bicep' = if (hasStorage) {
  params: {
    name: nameStorageAccount(prefix, slug, environmentName, sub, generation)
    location: location
    redundancy: data.?storage.?redundancy ?? 'LRS'
    softDeleteDays: data.?storage.?softDeleteDays ?? 7
    pointInTimeRestore: data.?storage.?pointInTimeRestore ?? true
    publicNetworkAccess: publicNetworkAccess
    privateEndpointTarget: privateNetwork != null
      ? {
          subnetId: privateNetwork.?subnetId ?? ''
          privateDnsZoneId: privateNetwork.?zoneIds.blob ?? ''
        }
      : null
    workspaceId: workspaceId
    diagnosticSettingName: diagName
    tags: tags
  }
}

// ------------------------------------------------------------------------------------------
// Alerts and budget (ADR-0012, ADR-0017). Container App alerts are created by release.bicep in
// provisioning mode, because the Container App doesn't exist before its first release.
// ------------------------------------------------------------------------------------------

module actionGroup '../modules/monitoring/action-group.bicep' = {
  params: {
    name: nameActionGroup(slug, environmentName)
    shortName: nameActionGroupShortName(slug, environmentName)
    emailAddresses: alertEmails
    tags: tags
  }
}

// Burstable PostgreSQL: low CPU credits (ADR-0011). Verify in sandbox: PG-5 (metric name and
// threshold).
// 2018-03-01 is the long-standing GA version of metricAlerts; the linter also lists 2026-01-01.
#disable-next-line use-recent-api-versions
resource postgresCpuCredits 'Microsoft.Insights/metricAlerts@2018-03-01' = if (hasPostgres && postgresCpuCreditAlert && data.?postgres.?tier == 'Burstable') {
  name: nameMetricAlert(slug, 'pgcredits', environmentName)
  location: 'global'
  tags: tags
  properties: {
    description: 'PostgreSQL Burstable server is running low on CPU credits; consider size L (ADR-0011).'
    severity: 2
    enabled: true
    scopes: [
      resourceId('Microsoft.DBforPostgreSQL/flexibleServers', namePostgresServer(prefix, slug, environmentName, sub, generation))
    ]
    evaluationFrequency: 'PT15M'
    windowSize: 'PT1H'
    criteria: {
      'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
      allOf: [
        {
          criterionType: 'StaticThresholdCriterion'
          name: 'cpu-credits-remaining'
          metricName: 'cpu_credits_remaining'
          operator: 'LessThan'
          threshold: 30
          timeAggregation: 'Average'
        }
      ]
    }
    actions: [
      {
        actionGroupId: actionGroup.outputs.id
      }
    ]
  }
  dependsOn: [
    postgres
  ]
}

var budgetNotifications = budget == null
  ? {}
  : union(
      toObject(
        budget!.notifyAtPercent,
        p => 'actual-${p}',
        p => {
          enabled: true
          operator: 'GreaterThanOrEqualTo'
          threshold: p
          thresholdType: 'Actual'
          contactEmails: alertEmails
        }
      ),
      toObject(
        budget!.forecastNotifyAtPercent,
        p => 'forecast-${p}',
        p => {
          enabled: true
          operator: 'GreaterThanOrEqualTo'
          threshold: p
          thresholdType: 'Forecasted'
          contactEmails: alertEmails
        }
      )
    )

resource appBudget 'Microsoft.Consumption/budgets@2026-06-01' = if (budget != null) {
  name: nameBudget(slug, environmentName)
  properties: {
    category: 'Cost'
    amount: budget.?amount ?? 0
    timeGrain: 'Monthly'
    timePeriod: {
      startDate: budget.?startDate ?? ''
    }
    notifications: budgetNotifications
  }
}

// ------------------------------------------------------------------------------------------
// Role assignments inside the app RG (identity-and-access.md)
// ------------------------------------------------------------------------------------------

resource existingRegistry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: nameContainerRegistry(prefix, slug, environmentName, sub, generation)
}

resource existingVault 'Microsoft.KeyVault/vaults@2025-05-01' existing = {
  name: appVaultName
}

resource existingStorage 'Microsoft.Storage/storageAccounts@2025-01-01' existing = if (hasStorage) {
  name: nameStorageAccount(prefix, slug, environmentName, sub, generation)
}

// Delivery row 1: App Deployer ({prefix}) on the app RG.
resource deliveryAppDeployer 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(resourceGroup().id, deliveryIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', appDeployerRoleGuid))
  properties: {
    principalId: deliveryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', appDeployerRoleGuid)
    description: 'Delivery identity: deploy revisions (ADR-0021 row 1).'
  }
}

// Delivery row 3: Managed Identity Operator on the runtime and Easy Auth UAMIs only (never
// the RG). Verify in sandbox: NR-5 (whether the Easy Auth one is needed).
resource deliveryOperatorOnRuntime 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(runtimeIdentity.id, deliveryIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.managedIdentityOperator))
  scope: runtimeIdentity
  properties: {
    principalId: deliveryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.managedIdentityOperator)
    description: 'Delivery identity: attach the runtime identity (ADR-0021 row 3).'
  }
}

resource deliveryOperatorOnEasyAuth 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(easyAuthIdentity.id, deliveryIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.managedIdentityOperator))
  scope: easyAuthIdentity
  properties: {
    principalId: deliveryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.managedIdentityOperator)
    description: 'Delivery identity: attach the Easy Auth identity (ADR-0021 row 3).'
  }
}

// Delivery rows 4 / 5: push in the build environment, import in a promotion environment.
var deliveryRegistryRole = isBuildEnvironment
  ? roles.containerRegistryRepositoryWriter
  : roles.containerRegistryDataImporterAndDataReader

resource deliveryOnRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingRegistry.id, deliveryIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', deliveryRegistryRole))
  scope: existingRegistry
  properties: {
    principalId: deliveryIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', deliveryRegistryRole)
    description: isBuildEnvironment
      ? 'Delivery identity: push images (ADR-0021 row 4).'
      : 'Delivery identity: import images by digest (ADR-0021 row 5).'
  }
  dependsOn: [
    registry
  ]
}

// ADR-0059: the provisioning identity of a build environment (the deployer of this landing zone)
// deletes old images that run nowhere, in the maintenance window. Repository Contributor is the
// narrowest built-in role with delete in the repository-permissions mode; its write adds nothing
// to the identity's Contributor (importImage). Never the delivery identity. Verify in sandbox:
// REG-1, REG-2.
resource purgerOnRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (isBuildEnvironment) {
  name: guid(existingRegistry.id, registryPurgerPrincipalId, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', registryPurgeRole))
  scope: existingRegistry
  properties: {
    principalId: registryPurgerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', registryPurgeRole)
    description: 'Provisioning identity: delete old images that run nowhere, in the maintenance window (ADR-0059).'
  }
  dependsOn: [
    registry
  ]
}

// Runtime: pull from its own registry (repository-permissions mode), read its own vault.
resource runtimeOnRegistry 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingRegistry.id, runtimeIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.containerRegistryRepositoryReader))
  scope: existingRegistry
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.containerRegistryRepositoryReader)
    description: 'Runtime identity: pull images. Verify in sandbox: ACR-3.'
  }
  dependsOn: [
    registry
  ]
}

resource runtimeOnVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(existingVault.id, runtimeIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser))
  scope: existingVault
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsUser)
    description: 'Runtime identity: read the app secrets.'
  }
  dependsOn: [
    appVault
  ]
}

resource runtimeOnStorage 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (hasStorage) {
  name: guid(existingStorage.id, runtimeIdentity.id, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor))
  scope: existingStorage
  properties: {
    principalId: runtimeIdentity.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.storageBlobDataContributor)
    description: 'Runtime identity: read and write blobs (Entra only, no keys).'
  }
  dependsOn: [
    storage
  ]
}

// Humans: owner and deputy Contributor (nonprod) or Reader (prod) on the RG, plus Key Vault
// Secrets Officer on the app vault in every environment (portal OBO writes need it).
// Developers: optional Reader in nonprod only.
var ownerPrincipals = [
  owner
  deputy
]
var ownerRgRole = isProd ? roles.reader : roles.contributor

resource ownersOnRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for o in ownerPrincipals: {
    name: guid(resourceGroup().id, o.principalId, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', ownerRgRole))
    properties: {
      principalId: o.principalId
      principalType: o.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', ownerRgRole)
      description: 'App owner or deputy (identity-and-access.md, human roles).'
    }
  }
]

resource ownersOnVault 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for o in ownerPrincipals: {
    name: guid(existingVault.id, o.principalId, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer))
    scope: existingVault
    properties: {
      principalId: o.principalId
      principalType: o.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.keyVaultSecretsOfficer)
      description: 'App owner or deputy: set secret values (portal OBO).'
    }
    dependsOn: [
      appVault
    ]
  }
]

resource developersOnRg 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for d in (isProd ? [] : developers): {
    name: guid(resourceGroup().id, d.principalId, subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader))
    properties: {
      principalId: d.principalId
      principalType: d.principalType
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.reader)
      description: 'App developer (nonprod only).'
    }
  }
]

// ------------------------------------------------------------------------------------------
// Outputs consumed by landing-zone.bicep, the provisioning pipeline and release.bicep
// ------------------------------------------------------------------------------------------

output runtimeIdentityId string = runtimeIdentity.id
output runtimeIdentityPrincipalId string = runtimeIdentity.properties.principalId
output runtimeIdentityClientId string = runtimeIdentity.properties.clientId
output runtimeIdentityName string = runtimeIdentity.name
output deliveryIdentityId string = deliveryIdentity.id
output deliveryIdentityPrincipalId string = deliveryIdentity.properties.principalId
output deliveryIdentityClientId string = deliveryIdentity.properties.clientId
output easyAuthIdentityId string = easyAuthIdentity.id
output easyAuthIdentityPrincipalId string = easyAuthIdentity.properties.principalId
output registryName string = registry.outputs.name
output registryLoginServer string = registry.outputs.loginServer
output appKeyVaultName string = appVault.outputs.name
output applicationInsightsName string = appInsights.name

@description('Relational database info for DATABASE_HOST (public server FQDN, never the privatelink name) / DATABASE_NAME / DATABASE_USER (PostgreSQL only: the runtime identity\'s database role). Null without a database.')
output database object? = hasPostgres
  ? {
      host: postgres!.outputs.fqdn
      name: namePostgresDatabase(slug)
      user: runtimeIdentity.name
    }
  : hasSql
      ? {
          host: sql!.outputs.fqdn
          name: nameSqlDatabase(slug)
        }
      : null

@description('STORAGE_BLOB_ENDPOINT (null without storage).')
output storageBlobEndpoint string? = hasStorage ? storage!.outputs.blobEndpoint : null
