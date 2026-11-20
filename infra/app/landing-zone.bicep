// App landing zone of ONE app in ONE environment (ADR-0004), subscription scope.
// Deployment name: provisioningDeployment(slug, env) = lz-{slug}-{env}, run by the
// provisioning pipeline in platform-config (Azure stage, then the Azure post-step once the
// ADO stage has returned the service connection's issuer/subject and the kvset job has
// written the Easy Auth secret). Parameters come from apps/{slug}/app.yaml plus the
// environment's instance.yaml entry, resolved by the pipeline (infra/README.md).
//
// Creates the app RG WITH its tags (no post-deploy tag step, lessons-from-v1), and in it the
// runtime / delivery / Easy Auth identities, ACR, Key Vault, App Insights, action group,
// optional PostgreSQL or Azure SQL and Storage, budget and the role assignments of
// identity-and-access.md. Outside the RG: App Environment Joiner on the CAE, Key Vault
// Secrets User for the Easy Auth identity on its one secret in the environment vault of the
// app's variant, and (promotion environment) Data Importer on the promoteFrom environment's
// registry. In a build environment the principal that deploys this template, the environment's
// provisioning identity, gets Container Registry Repository Contributor on the app's registry: it
// purges old images in the maintenance window (ADR-0059; output registryPurgeRole).
//
// The Container App itself is defined only by release.bicep (fixed deployment name
// release-{slug}); provisioning runs it once in provisioning mode right after this template.

targetScope = 'subscription'

import {
  appResourceGroup as nameAppResourceGroup
  cellManagedEnvironment as nameCellManagedEnvironment
  containerApp as nameContainerApp
  containerRegistry as nameContainerRegistry
  customRoleDefinitionGuid as nameCustomRoleDefinitionGuid
  deliveryIdentity as nameDeliveryIdentity
  easyAuthIdentity as nameEasyAuthIdentity
  easyAuthSecret as nameEasyAuthSecret
  environmentKeyVault as nameEnvironmentKeyVault
  logAnalyticsWorkspace as nameLogAnalyticsWorkspace
  platformJobIdentity as namePlatformJobIdentity
  platformResourceGroup as namePlatformResourceGroup
  privateDnsResourceGroup as namePrivateDnsResourceGroup
  privateDnsZone as namePrivateDnsZone
  subnet as nameSubnet
  virtualNetwork as nameVirtualNetwork
} from '../modules/naming/naming.bicep'
import {
  builtInRoles
  environmentKind as environmentKindType
  externalOnlyNetwork as externalOnlyNetworkType
  ownerRef
  principalRef
} from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (no defaults for environment-specific values)
// ------------------------------------------------------------------------------------------

@minLength(2)
@maxLength(8)
param prefix string

@minLength(2)
@maxLength(8)
param environmentName string

param environmentKind environmentKindType

@description('App slug (immutable).')
@minLength(3)
@maxLength(20)
param slug string

@description('App generation (apps/{slug}/app.yaml); bumped only to escape a soft-deleted vault name.')
@minValue(0)
param generation int

@description('environments[].vaultGeneration (names the environment vaults).')
@minValue(0)
param vaultGeneration int

@description('Region of the environment (environments[].region or defaultRegion). Used for the resource group only; the resources take their region from the CAE.')
param location string

@description('The app\'s network mode in this environment (approved in the manifest).')
param networkMode 'externalOnly' | 'externalHybrid'

@description('The environment\'s External-only variant (environments[].networkModes.externalOnly.network); ignored for externalHybrid but required, so a missing value fails.')
param externalOnlyNetwork externalOnlyNetworkType

@description('The app\'s capacity cell in this environment (apps/{slug}/app.yaml environments.<env>.cell, default 01; ADR-0053): the CAE of networkMode in that cell, where the app runs and the delivery identity gets App Environment Joiner. Two digits; an invalid id fails in naming.bicep.')
@minLength(2)
@maxLength(2)
param cell string

@description('externalHybrid with vnet.existingVnetId: that VNet ID. Null when the platform created the spoke or for externalOnly (except during a prepare pass from externalHybrid, where it names the source spoke).')
param hybridExistingVnetId string?

@description('A network mode change of the app in progress (ADR-0060). Null in the steady state. {phase: prepare, fromNetworkMode}: the first of the move\'s two passes, while the app still runs in the CAE of fromNetworkMode; the move step runs the final pass with null. Only externalOnly <-> externalHybrid (iteration 1).')
param modeChange {
  phase: 'prepare'
  fromNetworkMode: 'externalOnly' | 'externalHybrid'
}?

@description('Promotion environment: the environment whose registry images are imported from (environments[].promoteFrom) and its subscription. Null = build environment.')
param promoteFrom {
  environmentName: string
  subscriptionId: string
}?

param owner ownerRef
param deputy ownerRef

@description('Developers with Reader in nonprod (optional, may be empty).')
param developers principalRef[]

@description('Data services approved for this app x environment, sizes resolved from instance.yaml data.*.sizes. Iteration 1: PostgreSQL OR Azure SQL, not both.')
param data {
  postgres: {
    skuName: string
    tier: 'Burstable' | 'GeneralPurpose' | 'MemoryOptimized'
    storageGb: int
    version: string
  }?
  azureSql: {
    skuName: string
    storageGb: int
    backupStorageRedundancy: 'Geo' | 'GeoZone' | 'Zone' | 'Local'
  }?
  storage: {
    redundancy: 'LRS' | 'ZRS' | 'GRS'
    softDeleteDays: int
    pointInTimeRestore: bool
  }?
}

@description('PITR retention of the environment kind (data.backup.retentionDaysProd / retentionDaysNonprod). 7-35: PostgreSQL Flexible Server keeps 7 days at least, and the instance schema requires the same for both kinds.')
@minValue(7)
@maxValue(35)
param backupRetentionDays int

@description('PostgreSQL geo-redundant backup (data.backup.geoRedundantProd in prod, false in nonprod). Creation-time only.')
param postgresGeoRedundantBackup bool

@description('Alert and budget recipients, resolved by kind: owner + deputy, plus the platform team in prod (ADR-0012).')
param alertEmails string[]

@description('data.postgres.cpuCreditAlert')
param postgresCpuCreditAlert bool

@description('Monthly budget (budgets.*, ADR-0017); null = none. startDate is the first day of the month the budget was created, kept stable.')
param budget {
  amount: int
  startDate: string
  notifyAtPercent: int[]
  forecastNotifyAtPercent: int[]
}?

@description('Issuer and subject of the app\'s ADO service connection (returned by the ADO stage). Null on the first Azure stage run.')
param deliveryFederation {
  issuer: string
  subject: string
}?

@description('true once the kvset job has written easyauth-{slug} to the environment vault (Azure post-step).')
param easyAuthSecretExists bool

@description('Value of the ManagedBy tag.')
param managedBy string

@description('CostCenter tag (optional, empty = no tag).')
param costCenter string

@description('Object (principal) ID of the portal identity id-{prefix}-portal (instance.yaml portal.identityPrincipalId, ADR-0037): Reader on the app resource group. Empty = no assignment (the portal is not set up yet).')
param portalIdentityPrincipalId string

// ------------------------------------------------------------------------------------------
// Derived values and validation
// ------------------------------------------------------------------------------------------

var sub = subscription().subscriptionId
var vnetBased = networkMode == 'externalHybrid' || externalOnlyNetwork == 'vnet'
// ADR-0060 decision 4, the prepare pass of a mode change (fromNetworkMode = networkMode in the
// steady state). The app still runs in the source CAE, so data services and the app vault keep a
// path from both CAEs:
//   case A into externalHybrid (from the managed network): endpoints in the target spoke, public
//     access stays on;
//   case A out of externalHybrid (to the managed network): the steady target state (public access
//     on, no endpoints declared; the source spoke's endpoints stay until the move step removes them);
//   case B (both VNet-based): the endpoints stay in the source spoke (a private endpoint can't change
//     its subnet, NMC-3) and public access stays off.
// The delivery identity's Joiner follows networkMode and cell (target CAE); the source CAE's stays until
// the move step deletes it (incremental deployment). The Easy Auth secret role follows the target vault.
var fromNetworkMode = modeChange.?fromNetworkMode ?? networkMode
var fromVnetBased = fromNetworkMode == 'externalHybrid' || externalOnlyNetwork == 'vnet'
var publicNetworkAccess = !vnetBased || (modeChange != null && !fromVnetBased)
// The spoke whose PE subnet and private DNS zones the endpoints use: the source mode's in case B.
var modeForNames = modeChange != null && vnetBased && fromVnetBased ? fromNetworkMode : networkMode
var platformRgName = namePlatformResourceGroup(prefix, environmentName)
var platformRgId = subscriptionResourceId('Microsoft.Resources/resourceGroups', platformRgName)
var caeName = nameCellManagedEnvironment(prefix, networkMode, environmentName, cell)
var envVaultName = nameEnvironmentKeyVault(
  prefix,
  environmentName,
  vnetBased ? 'private' : 'public',
  sub,
  platformRgId,
  vaultGeneration
)

// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var portalPrincipalLower = toLower(portalIdentityPrincipalId)
var portalPrincipalIsGuid = length(portalPrincipalLower) == 36 && empty(filter(
  range(0, min(length(portalPrincipalLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(portalPrincipalLower, i, 1) != '-' : !contains('0123456789abcdef', substring(portalPrincipalLower, i, 1))
))

var inputErrors = filter(
  [
    data.?postgres != null && data.?azureSql != null
      ? 'Iteration 1 allows one relational database per app: PostgreSQL or Azure SQL, not both.'
      : ''
    networkMode == 'externalOnly' && hybridExistingVnetId != null && fromNetworkMode != 'externalHybrid'
      ? 'hybridExistingVnetId applies to externalHybrid only.'
      : ''
    modeChange != null && fromNetworkMode == networkMode
      ? 'modeChange.fromNetworkMode must differ from networkMode (a prepare pass belongs to a change of mode; null is the steady state).'
      : ''
    promoteFrom != null && promoteFrom.?environmentName == environmentName
      ? 'promoteFrom must name another environment.'
      : ''
    // Both are mandatory (identity-and-access.md); the same principal twice would also give
    // two role assignments with the same name.
    owner.principalId == deputy.principalId
      ? 'owner and deputy must be different principals.'
      : ''
    length(union(map(developers, d => d.principalId), [])) != length(developers)
      ? 'developers must not list the same principal twice.'
      : ''
    !empty(portalIdentityPrincipalId) && !portalPrincipalIsGuid
      ? 'portalIdentityPrincipalId must be empty or a GUID (the object ID of id-{prefix}-portal).'
      : ''
  ],
  message => !empty(message)
)

var appRgName = empty(inputErrors)
  ? nameAppResourceGroup(prefix, slug, environmentName)
  : fail('landing-zone.bicep: ${join(inputErrors, ' ')}')

// VNet-based variants: the spoke's PE subnet and the mode's private DNS zones (computed from
// names; created by environment.bicep). Null = no private endpoints declared.
var spokeVnetId = modeForNames == 'externalHybrid' && hybridExistingVnetId != null
  ? hybridExistingVnetId!
  : resourceId(sub, platformRgName, 'Microsoft.Network/virtualNetworks', nameVirtualNetwork(prefix, modeForNames, environmentName))
var dnsRgName = namePrivateDnsResourceGroup(prefix, modeForNames, environmentName)
var privateNetwork = vnetBased
  ? {
      subnetId: '${spokeVnetId}/subnets/${nameSubnet(prefix, 'pep', modeForNames, environmentName)}'
      zoneIds: {
        vault: resourceId(sub, dnsRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))
        postgres: resourceId(sub, dnsRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('postgres'))
        sql: resourceId(sub, dnsRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('sql'))
        blob: resourceId(sub, dnsRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('blob'))
      }
    }
  : null

var tags = union(
  {
    Application: slug
    Owner: owner.email
    DeputyOwner: deputy.email
    Environment: environmentName
    ManagedBy: managedBy
  },
  empty(costCenter) ? {} : { CostCenter: costCenter }
)

// ------------------------------------------------------------------------------------------
// Platform resources this landing zone builds on (created by environment.bicep / roles.bicep)
// ------------------------------------------------------------------------------------------

resource platformRg 'Microsoft.Resources/resourceGroups@2025-04-01' existing = {
  name: platformRgName
}

// The CAE decides the region (lessons-from-v1: a Container App's region must equal its
// environment's region; lookup explicitly scoped to the platform RG).
resource cae 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  scope: platformRg
  name: caeName
}

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  scope: platformRg
  name: nameLogAnalyticsWorkspace(prefix, environmentName)
}

resource dbinitIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: platformRg
  name: namePlatformJobIdentity(prefix, 'dbinit', environmentName)
}

// ------------------------------------------------------------------------------------------
// App resource group and its resources
// ------------------------------------------------------------------------------------------

resource appRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: appRgName
  location: location
  tags: tags
}

module resources 'landing-zone-resources.bicep' = {
  scope: appRg
  params: {
    prefix: prefix
    environmentName: environmentName
    environmentKind: environmentKind
    slug: slug
    generation: generation
    location: cae.location
    publicNetworkAccess: publicNetworkAccess
    privateNetwork: privateNetwork
    workspaceId: workspace.id
    isBuildEnvironment: promoteFrom == null
    appDeployerRoleGuid: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-deployer')
    // ADR-0059: the deploying principal (in the pipeline the environment's provisioning identity,
    // which may assign this role to itself only, bootstrap.bicep) purges old images in a build
    // environment. Verify in sandbox: REG-2.
    registryPurgerPrincipalId: deployer().objectId
    owner: owner
    deputy: deputy
    developers: developers
    data: data
    backupRetentionDays: backupRetentionDays
    postgresGeoRedundantBackup: postgresGeoRedundantBackup
    // The admin's object ID names the PostgreSQL administrators child resource; it is only
    // known at runtime, which limits what-if for that one child.
    #disable-next-line what-if-short-circuiting
    databaseAdministrator: {
      objectId: dbinitIdentity.properties.principalId
      clientId: dbinitIdentity.properties.clientId
      name: dbinitIdentity.name
    }
    alertEmails: alertEmails
    postgresCpuCreditAlert: postgresCpuCreditAlert
    budget: budget
    deliveryFederation: deliveryFederation
    tags: tags
  }
}

var deliveryIdentityId = resourceId(
  sub,
  appRgName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  nameDeliveryIdentity(prefix, slug, environmentName)
)
var easyAuthIdentityId = resourceId(
  sub,
  appRgName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  nameEasyAuthIdentity(prefix, slug, environmentName)
)

// Delivery row 2: App Environment Joiner ({prefix}) on the app's CAE. Moves with the mode.
// Never granted on the portal CAE.
module joinerOnCae '../modules/rbac/role-assignments.bicep' = {
  scope: platformRg
  params: {
    target: {
      kind: 'managedEnvironment'
      name: caeName
    }
    principalId: resources.outputs.deliveryIdentityPrincipalId
    principalResourceId: deliveryIdentityId
    roleDefinitionGuid: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-environment-joiner')
    assignmentDescription: 'Delivery identity of ${slug}: create/update its Container App in this CAE (ADR-0021 row 2).'
  }
}

// Easy Auth identity: Key Vault Secrets User on its one secret in the environment vault of the
// app's variant (public vault for managed network, private vault for VNet-based CAEs).
// The secret must exist first (kvset job), so this runs in the Azure post-step.
// Verify in sandbox: ENT-6, KV-8.
module easyAuthOnSecret '../modules/rbac/role-assignments.bicep' = if (easyAuthSecretExists) {
  scope: platformRg
  params: {
    target: {
      kind: 'keyVaultSecret'
      name: envVaultName
      secretName: nameEasyAuthSecret(slug)
    }
    principalId: resources.outputs.easyAuthIdentityPrincipalId
    principalResourceId: easyAuthIdentityId
    roleDefinitionGuid: builtInRoles.keyVaultSecretsUser
    assignmentDescription: 'Easy Auth identity of ${slug}: read its client secret (ADR-0009).'
  }
}

// Delivery row 6 (promotion environment): Data Importer and Data Reader on the promoteFrom
// environment's registry, in that environment's subscription. The provisioning identity needs
// RBAC write there. Verify in sandbox: ACR-4, ACR-5.
module importerOnSourceRegistry '../modules/rbac/role-assignments.bicep' = if (promoteFrom != null) {
  scope: resourceGroup(
    promoteFrom.?subscriptionId ?? sub,
    nameAppResourceGroup(prefix, slug, promoteFrom.?environmentName ?? environmentName)
  )
  params: {
    target: {
      kind: 'containerRegistry'
      name: nameContainerRegistry(
        prefix,
        slug,
        promoteFrom.?environmentName ?? environmentName,
        promoteFrom.?subscriptionId ?? sub,
        generation
      )
    }
    principalId: resources.outputs.deliveryIdentityPrincipalId
    principalResourceId: deliveryIdentityId
    roleDefinitionGuid: builtInRoles.containerRegistryDataImporterAndDataReader
    assignmentDescription: 'Delivery identity of ${slug} in ${environmentName}: import images by digest (ADR-0021 row 6).'
  }
}

// The portal identity (ADR-0037): Reader on the app resource group, so the portal can read the
// app's resources and deployment records (and later the inventory, US10.14). Reader is in the
// provisioning identity's role set (types.builtInRoles). The identity lives in the portal host
// environment's subscription, so its object ID seeds the assignment name.
module portalReaderOnAppRg '../modules/rbac/role-assignments.bicep' = if (!empty(portalIdentityPrincipalId)) {
  scope: appRg
  params: {
    target: {
      kind: 'resourceGroup'
      name: appRgName
    }
    principalId: portalIdentityPrincipalId
    principalResourceId: portalIdentityPrincipalId
    roleDefinitionGuid: builtInRoles.reader
    assignmentDescription: 'Portal identity: read ${slug} in ${environmentName} (ADR-0037).'
  }
}

// ------------------------------------------------------------------------------------------
// Outputs: recorded by the provisioning pipeline and passed to release.bicep
// ------------------------------------------------------------------------------------------

output resourceGroupName string = appRg.name
output location string = cae.location
output managedEnvironmentId string = cae.id
output runtimeIdentityClientId string = resources.outputs.runtimeIdentityClientId
output deliveryIdentityClientId string = resources.outputs.deliveryIdentityClientId
output deliveryIdentityPrincipalId string = resources.outputs.deliveryIdentityPrincipalId
output registryName string = resources.outputs.registryName
output registryLoginServer string = resources.outputs.registryLoginServer

@description('ADR-0059: true in a build environment, where the deploying provisioning identity holds Container Registry Repository Contributor on the registry; the provisioning plan purges old images only where a landing-zone record says so.')
output registryPurgeRole bool = promoteFrom == null
output appKeyVaultName string = resources.outputs.appKeyVaultName
output environmentKeyVaultName string = envVaultName

@description('Passed to release.bicep landingZone.database: host (public FQDN), name, user (PostgreSQL only). Null without a database.')
output database object? = resources.outputs.?database

@description('STORAGE_BLOB_ENDPOINT for release.bicep (null without storage).')
output storageBlobEndpoint string? = resources.outputs.?storageBlobEndpoint

@description('Default host name of the app\'s Container App ({containerApp}.{CAE default domain}); the provisioning smoke test calls it. Known before the release exists.')
output containerAppFqdn string = '${nameContainerApp(slug)}.${cae.properties.defaultDomain}'
