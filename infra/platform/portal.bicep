// Deploys the portal (ADR-0036, ADR-0025) into the subscription of the portal host environment
// (instance.yaml portal.hostEnvironment), subscription scope, deployment name
// portalDeployment(prefix, env) = portal-{prefix}-{env}. Deployed by the host environment's
// platform pipeline (\platform\platform-{env}, ADR-0043 decision 10, amendment 2026-11-14) with
// that environment's provisioning identity, only through pipeline/portal.bicepparam: plan (record,
// Container App digest, what-if), Approval, then pass 1 for a new portal and, once
// instance.yaml portal.clientId is set, the saf-portal import and pass 2. A person with Owner runs
// the same steps only as break-glass (infra/README.md#portal). The same template is the
// out-of-band redeploy of the portal (US10.19).
//
// Creates, in rg-{prefix}-portal-{env}:
//   network   portal VNet vnet-{prefix}-portal-{env} with a CAE subnet (delegated, NAT Gateway)
//             and a private-endpoint subnet, an NSG on each, the NAT Gateway with one public IP
//             (the portal's stable egress IP), and the portal's own privatelink.vaultcore.azure.net
//             and privatelink.postgres.database.azure.com zones, linked to the portal VNet only
//             (ADR-0025: the portal-side private endpoints of app vaults register in the first;
//             provisioning creates them later, infra/app/portal-vault-endpoint.bicep, one deployment
//             pep-portal-{slug}-{env} per app vault in a VNet-based mode, in this resource group).
//             The VNet is peered or connected to nothing.
//   database  the portal's PostgreSQL Flexible Server pgsql-{prefix}-portal-{env}-{h6} with the
//             database `portal` (ADR-0038, modules/data/postgres.bicep): Entra-only, TLS required,
//             public network access disabled, its private endpoint pep-{serverName} in the portal
//             VNet's private-endpoint subnet; Entra administrator id-{prefix}-portal and no one
//             else (no dbinit job: the portal applies its own migrations); size, PITR retention and
//             geo-redundant backup from `database`; logs to log-{prefix}-{env}.
//   CAE       cae-{prefix}-portal-{env} in the CAE subnet, external ingress, logs to the host
//             environment's workspace log-{prefix}-{env} (rg-{prefix}-platform-{env}, existing)
//   pass 2    the Container App ca-{prefix}-portal (modules/portal/portal-app.bicep), with the
//             env var contract of the image: PORT, AZURE_CLIENT_ID, SAF_TENANT_ID,
//             SAF_PORTAL_CLIENT_ID, SAF_CONFIG_SOURCE, SAF_ADO_ORGANIZATION_URL, SAF_ADO_PROJECT,
//             SAF_ADO_REPOSITORY, SAF_ADO_BRANCH, SAF_DATABASE_HOST, SAF_DATABASE_NAME,
//             SAF_DATABASE_USER, and SAF_SMTP_PASSWORD_VAULT_URI (empty without the SMTP secret's role)
//   vault     (ADR-0025 amendment 2026-11-14) when the host environment has a VNet-based CAE and so
//             its private environment vault kv{prefix}{env}n{h5} (environmentVault 'private'): the
//             portal-side private endpoint pep-{vaultName}-portal in the private-endpoint subnet,
//             registered in the portal's vault zone (the portal reads the SMTP password there; the
//             public environment vault gets none, the portal reaches it over its public endpoint).
//             The vault is environment.bicep's, in this subscription: the provisioning identity's
//             Contributor includes privateEndpointConnectionsApproval/action, so the connection is
//             automatic (approved at creation). Verify in sandbox: KV-11.
// Outside that resource group: Container Registry Repository Reader for id-{prefix}-portal on the
// host environment's platform registry cr{prefix}{env}{h6} (rg-{prefix}-platform-{env}, existing,
// created by environment.bicep), on every pass; and, with SMTP basic auth (smtpPasswordSecretName)
// once the secret exists (smtpPasswordSecretExists, read by the pipeline through ARM), Key Vault
// Secrets User for id-{prefix}-portal on that one secret of the environment vault (US10.18; the
// role is in types.builtInRoles, which the provisioning identity may assign), and the portal's
// setting SAF_SMTP_PASSWORD_VAULT_URI = https://{vaultName}.vault.azure.net (pass 2). A role on a
// secret needs the secret: without it nothing is assigned and the setting stays empty (SMTP with a
// password is "unsupported" in the portal); the plan warns. Verify in sandbox: MAIL-5.
//
// Prerequisites (existing, never created here): bootstrap.bicep of the host environment with
// instanceIdentities (creates id-{prefix}-portal in rg-{prefix}-identities-{env}) and
// environment.bicep pass 1 of the host environment (platform RG, workspace, platform registry).
// Before pass 2 also the Azure DevOps grants of id-{prefix}-portal (`platform ado bootstrap
// --phase grants`): the readiness probe /readyz stays 503 until the portal has read
// platform-config, so pass 2 would get no ready replica (infra/README.md#portal).
//
// Two passes, like environment.bicep (ADR-0035):
//   1. portalImageDigest = '' (portalClientId '' or already known): everything except the
//      Container App. Outputs the CAE default domain and the portal FQDN, which the portal's Entra
//      registration needs as its redirect URI (infra/entra/portal-registration.bicep). The
//      Repository Reader assignment is made here already, so it has propagated before the first
//      image pull (lessons-from-v1: RBAC propagation).
//   2. after `az acr import` of saf-portal by digest into the platform registry: the same
//      parameters with portalImageDigest and portalClientId (the registration's client ID,
//      required then). Creates or updates the Container App.
// A run with an empty digest after pass 2 does not delete the Container App (incremental
// deployment) but leaves it out of the outputs: always pass the current digest once imported.
//
// Not in this core version: portal.network.routeTableId (a hub connection needs the portal VNet
// peered to the hub; the template stops with a fail() message), Application Insights. The app
// vaults' portal-side endpoints are provisioning's (infra/app/portal-vault-endpoint.bicep).
//
// Region: every resource, the CAE and the Container App included, uses `location` (no default),
// so the Container App's region equals its CAE's region by construction (lessons-from-v1).

targetScope = 'subscription'

import {
  diagnosticSetting as nameDiagnosticSetting
  environmentKeyVault as nameEnvironmentKeyVault
  identitiesResourceGroup as nameIdentitiesResourceGroup
  instanceIdentity as nameInstanceIdentity
  logAnalyticsWorkspace as nameLogAnalyticsWorkspace
  natGateway as nameNatGateway
  networkSecurityGroup as nameNetworkSecurityGroup
  platformContainerRegistry as namePlatformContainerRegistry
  platformResourceGroup as namePlatformResourceGroup
  portalContainerApp as namePortalContainerApp
  portalManagedEnvironment as namePortalManagedEnvironment
  portalPostgresDatabase as namePortalPostgresDatabase
  portalPostgresServer as namePortalPostgresServer
  portalPrivateEndpoint as namePortalPrivateEndpoint
  portalResourceGroup as namePortalResourceGroup
  privateDnsZone as namePrivateDnsZone
  privateEndpointNic as namePrivateEndpointNic
  subnet as nameSubnet
  virtualNetwork as nameVirtualNetwork
} from '../modules/naming/naming.bicep'
import {
  azureDevOpsConfig
  builtInRoles
  environmentKind as environmentKindType
  portalDatabaseConfig
  portalNetworkConfig
} from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (environment-specific values have no defaults: a missing value fails loudly)
// ------------------------------------------------------------------------------------------

@description('Instance prefix (naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('portal.hostEnvironment: the environment whose subscription hosts the portal.')
@minLength(2)
@maxLength(8)
param environmentName string

@description('portal.hostEnvironment\'s environments[].kind (backup settings of the portal database).')
param environmentKind environmentKindType

@description('Azure region: the host environment\'s region, else defaultRegion (resolved by the pipeline).')
param location string

@description('Entra tenant ID (instance.yaml tenantId). Must be the tenant of the deployment; the portal validates tokens against it (SAF_TENANT_ID).')
param tenantId string

@description('portal.network: VNet address space, CAE and private-endpoint subnet prefixes (routeTableId is rejected in this core version).')
param network portalNetworkConfig

@description('scm.azureDevOps with platformConfigDefaultBranch resolved: where the portal reads platform-config.')
param azureDevOps azureDevOpsConfig

@description('The portal database (ADR-0038), resolved for the host environment like an app database: data.postgres size and version, data.backup retention and geo-redundancy of its kind.')
param database portalDatabaseConfig

@description('Digest (sha256:<64 hex>) of the saf-portal image (images/images.json) imported into the host environment\'s platform registry. Empty string = pass 1: no Container App (the image is not imported yet).')
param portalImageDigest string

@description('Client ID of the portal\'s Entra app registration (infra/entra/portal-registration.bicep output). Required with portalImageDigest (pass 2); may be empty in pass 1.')
param portalClientId string

@description('portal.hostEnvironment\'s environments[].vaultGeneration (seed of its environment vault names, as environment.bicep).')
@minValue(0)
param vaultGeneration int

@description('The host environment\'s environment vault that holds the portal\'s own secrets (ADR-0025): private (kv{prefix}{env}n{h5}) when the host environment has a VNet-based CAE, which then gets the portal-side private endpoint; else public (kv{prefix}{env}p{h5}), reached over its public endpoint.')
param environmentVault 'private' | 'public'

@description('notifications.email.smtp.auth.passwordSecretName with provider smtp and auth mode basic; empty otherwise (no SMTP password).')
param smtpPasswordSecretName string

@description('true when that secret exists in environmentVault (read by the pipeline through ARM before the deployment): only then the portal identity gets Key Vault Secrets User on it and the setting SAF_SMTP_PASSWORD_VAULT_URI. A role on a secret needs the secret.')
param smtpPasswordSecretExists bool

@description('Value of the ManagedBy tag (e.g. the instance productName).')
param managedBy string

@description('Additional tags for every resource (e.g. CostCenter).')
param tags object

// ------------------------------------------------------------------------------------------
// Derived settings and input validation
// ------------------------------------------------------------------------------------------

// Container App only once the portal image is in the platform registry (pass 2).
var appEnabled = !empty(portalImageDigest)
// sha256:<64 lowercase hex>; ranges are bounded so a short value can't index past its end.
var digestLength = length(portalImageDigest)
var digestValid = digestLength == 71 && startsWith(portalImageDigest, 'sha256:') && empty(filter(
  range(7, max(min(digestLength, 71) - 7, 0)),
  i => !contains('0123456789abcdef', substring(portalImageDigest, i, 1))
))
// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var clientIdLower = toLower(portalClientId)
var clientIdIsGuid = length(clientIdLower) == 36 && empty(filter(
  range(0, min(length(clientIdLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(clientIdLower, i, 1) != '-' : !contains('0123456789abcdef', substring(clientIdLower, i, 1))
))

// The portal API checks its settings at startup and exits on a bad value (portal/api/src/settings.ts),
// so the container would crash-loop: the same checks stop the deployment here instead.
// SAF_ADO_ORGANIZATION_URL: an https URL without query or fragment.
var adoOrgUrl = azureDevOps.organizationUrl
var adoOrgUrlValid = startsWith(adoOrgUrl, 'https://') && length(adoOrgUrl) > 8 && !startsWith(adoOrgUrl, 'https:///') && empty(filter(
  ['?', '#', ' '],
  c => contains(adoOrgUrl, c)
))
// SAF_ADO_BRANCH: the API's BRANCH_RE ^(?!refs/)(?!.*\.\.)[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$, i.e. not refs/...,
// no "..", segments of letters, digits, ".", "_" and "-" separated by single slashes.
var adoBranch = azureDevOps.platformConfigDefaultBranch
var adoBranchChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-/'
var adoBranchShapeValid = !empty(adoBranch) && !startsWith(adoBranch, 'refs/') && !startsWith(adoBranch, '/') && !endsWith(adoBranch, '/')
var adoBranchValid = adoBranchShapeValid && empty(filter(['..', '//'], s => contains(adoBranch, s))) && empty(filter(
  range(0, length(adoBranch)),
  i => !contains(adoBranchChars, substring(adoBranch, i, 1))
))

// A Key Vault secret name: 1-127 letters, digits and hyphens (instance.schema.json passwordSecretName).
var kvObjectNameChars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'
var smtpSecretNameValid = empty(smtpPasswordSecretName) || (length(smtpPasswordSecretName) <= 127 && empty(filter(
  range(0, min(length(smtpPasswordSecretName), 127)),
  i => !contains(kvObjectNameChars, substring(smtpPasswordSecretName, i, 1))
)))

var inputErrors = filter(
  [
    toLower(tenantId) != toLower(tenant().tenantId)
      ? 'tenantId "${tenantId}" is not the tenant of this deployment (${tenant().tenantId}).'
      : ''
    network.?routeTableId != null
      ? 'portal.network.routeTableId is not available in this core version: a hub connection needs the portal VNet peered to the hub, which portal.bicep does not create yet (ADR-0025). Remove it; the portal egresses through its NAT Gateway.'
      : ''
    appEnabled && !digestValid
      ? 'portalImageDigest must be empty (pass 1) or sha256:<64 lowercase hex> (images/images.json).'
      : ''
    appEnabled && !clientIdIsGuid
      ? 'portalClientId must be the client ID (a GUID) of the portal\'s Entra app registration when portalImageDigest is set (pass 2).'
      : ''
    !appEnabled && !empty(portalClientId) && !clientIdIsGuid
      ? 'portalClientId must be empty or the client ID (a GUID) of the portal\'s Entra app registration.'
      : ''
    !adoOrgUrlValid
      ? 'azureDevOps.organizationUrl must be an https:// URL without query or fragment (the portal API rejects anything else).'
      : ''
    database.backupRetentionDays < 7 || database.backupRetentionDays > 35
      ? 'database.backupRetentionDays must be 7-35 (PostgreSQL Flexible Server PITR retention), got ${database.backupRetentionDays}.'
      : ''
    database.geoRedundantBackup && environmentKind != 'prod'
      ? 'database.geoRedundantBackup is for a prod host only (data.backup.geoRedundantProd).'
      : ''
    !adoBranchValid
      ? 'azureDevOps.platformConfigDefaultBranch must be a short branch name (no refs/heads/, no "..", segments of letters, digits, ".", "_" and "-" separated by "/"), as the portal API requires.'
      : ''
    !smtpSecretNameValid
      ? 'smtpPasswordSecretName must be empty or a Key Vault secret name (1-127 letters, digits and hyphens), as instance.yaml notifications.email.smtp.auth.passwordSecretName.'
      : ''
    smtpPasswordSecretExists && empty(smtpPasswordSecretName)
      ? 'smtpPasswordSecretExists needs smtpPasswordSecretName (SMTP basic auth).'
      : ''
  ],
  message => !empty(message)
)

var portalRgName = empty(inputErrors)
  ? namePortalResourceGroup(prefix, environmentName)
  : fail('portal.bicep: ${join(inputErrors, ' ')}')

var sub = subscription().subscriptionId
var platformRgName = namePlatformResourceGroup(prefix, environmentName)
var identitiesRgName = nameIdentitiesResourceGroup(prefix, environmentName)

// The environment vault of the portal's own secrets (ADR-0025), named as environment.bicep names it.
var envVaultName = nameEnvironmentKeyVault(
  prefix,
  environmentName,
  environmentVault,
  sub,
  subscriptionResourceId('Microsoft.Resources/resourceGroups', platformRgName),
  vaultGeneration
)
// The private vault only: the public one is reached over its public endpoint.
var envVaultEndpointEnabled = environmentVault == 'private'
var envVaultEndpointName = namePortalPrivateEndpoint(envVaultName)
// The portal's right to read the SMTP password, and the setting that names its vault, only once the
// secret exists (a role assignment on a secret needs the secret).
var smtpPasswordRole = !empty(smtpPasswordSecretName) && smtpPasswordSecretExists

// Resource IDs are computed from names (never taken from module outputs) so what-if can predict
// every resource on a re-run; explicit dependsOn keeps the order.
var vnetName = nameVirtualNetwork(prefix, 'portal', environmentName)
var snetCaeName = nameSubnet(prefix, 'cae', 'portal', environmentName)
var snetPepName = nameSubnet(prefix, 'pep', 'portal', environmentName)
var nsgCaeName = nameNetworkSecurityGroup(prefix, 'cae', 'portal', environmentName)
var nsgPepName = nameNetworkSecurityGroup(prefix, 'pep', 'portal', environmentName)
var natName = nameNatGateway(prefix, 'portal', environmentName)
var vnetId = resourceId(sub, portalRgName, 'Microsoft.Network/virtualNetworks', vnetName)
var portalIdentityName = nameInstanceIdentity(prefix, 'portal')
var containerAppName = namePortalContainerApp(prefix)

var commonTags = union(tags, {
  Environment: environmentName
  ManagedBy: managedBy
})

var diagName = nameDiagnosticSetting(prefix, environmentName)

// Port of the saf-portal image (PORT and the ingress target port, ADR-0036).
var portalPort = 8080
// Repository of the portal image (images/images.json saf-portal.repository), imported by digest.
var portalRepository = 'saf-portal'

// ------------------------------------------------------------------------------------------
// Existing resources of the host environment (bootstrap.bicep, environment.bicep pass 1)
// ------------------------------------------------------------------------------------------

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' existing = {
  scope: resourceGroup(platformRgName)
  name: nameLogAnalyticsWorkspace(prefix, environmentName)
}

resource platformRegistry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  scope: resourceGroup(platformRgName)
  name: namePlatformContainerRegistry(prefix, environmentName, sub)
}

// In the identities RG, which carries the ReadOnly lock of bootstrap.bicep. Assigning the
// identity to the Container App is a write on the Container App plus a permission check on the
// identity (userAssignedIdentities/assign/action), which the lock is expected not to block.
// Verify in sandbox: PORTAL-1.
resource portalIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  scope: resourceGroup(identitiesRgName)
  name: portalIdentityName
}

// ------------------------------------------------------------------------------------------
// Portal resource group and network (ADR-0025)
// ------------------------------------------------------------------------------------------

resource portalRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: portalRgName
  location: location
  tags: commonTags
}

module nsgCae '../modules/network/nsg.bicep' = {
  scope: portalRg
  params: {
    name: nsgCaeName
    location: location
    purpose: 'cae'
    subnetPrefix: network.caeSubnetPrefix
    workspaceId: workspace.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

module nsgPep '../modules/network/nsg.bicep' = {
  scope: portalRg
  params: {
    name: nsgPepName
    location: location
    purpose: 'pep'
    subnetPrefix: network.privateEndpointSubnetPrefix
    workspaceId: workspace.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
}

// The portal's stable egress IP: Microsoft Graph, Azure DevOps, Azure Resource Manager, and the
// address an SMTP relay allow-lists (ADR-0012, ADR-0025).
module nat '../modules/network/nat-gateway.bicep' = {
  scope: portalRg
  params: {
    name: natName
    prefix: prefix
    environmentName: environmentName
    mode: 'portal'
    location: location
    publicIpCount: 1
    tags: commonTags
  }
}

// Peered or connected to nothing (ADR-0025): no route table, no hub peering, Azure-provided DNS.
// Subnets are inline and re-asserted on every deploy (lessons-from-v1).
module vnet '../modules/network/spoke-vnet.bicep' = {
  scope: portalRg
  params: {
    name: vnetName
    location: location
    addressSpace: network.vnetAddressSpace
    caeSubnet: {
      name: snetCaeName
      addressPrefix: network.caeSubnetPrefix
      nsgId: resourceId(sub, portalRgName, 'Microsoft.Network/networkSecurityGroups', nsgCaeName)
    }
    privateEndpointSubnet: {
      name: snetPepName
      addressPrefix: network.privateEndpointSubnetPrefix
      nsgId: resourceId(sub, portalRgName, 'Microsoft.Network/networkSecurityGroups', nsgPepName)
    }
    natGatewayId: resourceId(sub, portalRgName, 'Microsoft.Network/natGateways', natName)
    routeTableId: null
    hubPeering: null
    dnsServers: []
    tags: commonTags
  }
  dependsOn: [
    nsgCae
    nsgPep
    nat
  ]
}

// The portal's own privatelink.vaultcore.azure.net and privatelink.postgres.database.azure.com
// zones, linked to the portal VNet only. They live in the portal RG, apart from the spokes' zones
// (rg-{prefix}-dns-{mode}-{env}), so the same vault name resolves to the portal-side endpoint here
// and to the spoke endpoint in the spoke (ADR-0025). Verify in sandbox: KV-6, PORTAL-5.
module dns '../modules/network/private-dns-zones.bicep' = {
  scope: portalRg
  params: {
    vnetId: vnetId
    services: [
      'vault'
      'postgres'
    ]
    tags: commonTags
  }
  dependsOn: [
    vnet
  ]
}

module cae '../modules/cae/managed-environment.bicep' = {
  scope: portalRg
  params: {
    name: namePortalManagedEnvironment(prefix, environmentName)
    location: location
    infrastructureSubnetId: '${vnetId}/subnets/${snetCaeName}'
    workspaceId: workspace.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
  dependsOn: [
    vnet
  ]
}

// ------------------------------------------------------------------------------------------
// Portal database (ADR-0038)
// ------------------------------------------------------------------------------------------

// Entra-only, public network access disabled, its private endpoint in the portal VNet's
// private-endpoint subnet with a DNS zone group into the portal's postgres zone. The Entra
// administrator is the portal identity and no one else: the portal connects as
// id-{prefix}-portal with a managed-identity token and applies its own migrations (no dbinit job).
// Verify in sandbox: PORTAL-5.
module postgres '../modules/data/postgres.bicep' = {
  scope: portalRg
  params: {
    name: namePortalPostgresServer(prefix, environmentName, sub)
    databaseName: namePortalPostgresDatabase()
    location: location
    size: {
      skuName: database.size.skuName
      tier: database.size.tier
      storageSizeGB: database.size.storageGb
      version: database.size.version
    }
    backupRetentionDays: database.backupRetentionDays
    geoRedundantBackup: database.geoRedundantBackup
    publicNetworkAccess: false
    privateEndpointTarget: {
      subnetId: '${vnetId}/subnets/${snetPepName}'
      privateDnsZoneId: resourceId(sub, portalRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('postgres'))
    }
    // The admin's object ID names the PostgreSQL administrators child resource; it is only known
    // at runtime, which limits what-if for that one child (as for app servers).
    #disable-next-line what-if-short-circuiting
    administrator: {
      objectId: portalIdentity.properties.principalId
      name: portalIdentityName
    }
    workspaceId: workspace.id
    diagnosticSettingName: diagName
    tags: commonTags
  }
  dependsOn: [
    vnet
    dns
  ]
}

// ------------------------------------------------------------------------------------------
// The host environment's private environment vault (ADR-0025 amendment 2026-11-14)
// ------------------------------------------------------------------------------------------

// The portal-side private endpoint of the private environment vault (environment.bicep, existing in
// the platform RG of this subscription), in the portal's private-endpoint subnet with a DNS zone group
// into the portal's vault zone: inside the portal VNet the vault's name resolves to this endpoint.
// Automatic connection: the deploying identity's Contributor on this subscription includes
// privateEndpointConnectionsApproval/action. The vault is created by the environment's deployment,
// which the platform pipeline runs before this one. Verify in sandbox: KV-11.
module envVaultEndpoint '../modules/privateendpoint/private-endpoint.bicep' = if (envVaultEndpointEnabled) {
  scope: portalRg
  params: {
    name: envVaultEndpointName
    nicName: namePrivateEndpointNic(envVaultEndpointName)
    location: location
    subnetId: '${vnetId}/subnets/${snetPepName}'
    targetResourceId: resourceId(sub, platformRgName, 'Microsoft.KeyVault/vaults', envVaultName)
    groupId: 'vault'
    privateDnsZoneId: resourceId(sub, portalRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))
    tags: commonTags
  }
  dependsOn: [
    vnet
    dns
  ]
}

// US10.18: Key Vault Secrets User for the portal identity on the one SMTP password secret, nothing
// wider (the portal never writes environment vaults and has no data-plane role on app vaults). In
// types.builtInRoles, which the provisioning identity may assign (bootstrap.bicep condition).
// Verify in sandbox: MAIL-5.
module portalOnSmtpSecret '../modules/rbac/role-assignments.bicep' = if (smtpPasswordRole) {
  scope: resourceGroup(platformRgName)
  params: {
    target: {
      kind: 'keyVaultSecret'
      name: envVaultName
      secretName: smtpPasswordSecretName
    }
    principalId: portalIdentity.properties.principalId
    principalResourceId: portalIdentity.id
    roleDefinitionGuid: builtInRoles.keyVaultSecretsUser
    assignmentDescription: 'Portal runtime identity reads the SMTP relay\'s password, this one secret only (ADR-0012, US10.18).'
  }
}

// ------------------------------------------------------------------------------------------
// Pull rights: Repository Reader on the platform registry (ADR-0036)
// ------------------------------------------------------------------------------------------

// The registry is in the repository-permissions (ABAC) mode, where AcrPull is not honoured;
// Repository Reader without a repository condition acts like plain RBAC on the registry (as for
// the kvset identity in environment.bicep). On every pass, so it has propagated before pass 2.
module portalOnPlatformRegistry '../modules/rbac/role-assignments.bicep' = {
  scope: resourceGroup(platformRgName)
  params: {
    target: {
      kind: 'containerRegistry'
      name: platformRegistry.name
    }
    principalId: portalIdentity.properties.principalId
    principalResourceId: portalIdentity.id
    roleDefinitionGuid: builtInRoles.containerRegistryRepositoryReader
    assignmentDescription: 'Portal runtime identity pulls the saf-portal image from the platform registry (ADR-0036).'
  }
}

// ------------------------------------------------------------------------------------------
// The portal Container App (pass 2)
// ------------------------------------------------------------------------------------------

module portalApp '../modules/portal/portal-app.bicep' = if (appEnabled) {
  scope: portalRg
  params: {
    name: containerAppName
    location: location
    environmentId: cae.outputs.id
    identityId: portalIdentity.id
    identityClientId: portalIdentity.properties.clientId
    registryLoginServer: platformRegistry.properties.loginServer
    imageRepository: portalRepository
    imageDigest: portalImageDigest
    port: portalPort
    settings: {
      tenantId: tenantId
      portalClientId: portalClientId
      adoOrganizationUrl: azureDevOps.organizationUrl
      adoProject: azureDevOps.platformProject
      adoRepository: azureDevOps.platformConfigRepo
      adoBranch: azureDevOps.platformConfigDefaultBranch
      // The server's public FQDN, never the privatelink name: inside the portal VNet it resolves
      // to the private endpoint through the portal's postgres zone, and it is the name the
      // server's TLS certificate carries (as DATABASE_HOST of app releases).
      databaseHost: postgres.outputs.fqdn
      databaseName: namePortalPostgresDatabase()
      // The Entra administrator's principal name is its PostgreSQL user name.
      databaseUser: portalIdentityName
      // Only with the role on the secret (and, for the private vault, its portal-side endpoint in this
      // deployment): the portal then reads the SMTP password there (ADR-0012). The address isn't a secret.
      smtpPasswordVaultUri: smtpPasswordRole ? 'https://${envVaultName}${environment().suffixes.keyvaultDns}' : ''
    }
    tags: commonTags
  }
  dependsOn: [
    portalOnPlatformRegistry
    envVaultEndpoint
    portalOnSmtpSecret
  ]
}

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------

output portalResourceGroupName string = portalRg.name
output managedEnvironmentId string = cae.outputs.id
output managedEnvironmentDefaultDomain string = cae.outputs.defaultDomain

@description('Portal host name, ca-{prefix}-portal.{CAE default domain}: known from pass 1, before the Container App exists. The redirect URI of the portal registration is https://{portalFqdn}/.')
output portalFqdn string = '${containerAppName}.${cae.outputs.defaultDomain}'

@description('NAT Gateway egress IPs of the portal (SMTP relay allow-listing, ADR-0012).')
output egressIps string[] = nat.outputs.publicIpAddresses

@description('Portal runtime identity (bootstrap.bicep): name, client ID, principal ID.')
output portalIdentity object = {
  name: portalIdentityName
  clientId: portalIdentity.properties.clientId
  principalId: portalIdentity.properties.principalId
}

@description('Portal database (ADR-0038): server name and FQDN (SAF_DATABASE_HOST), database name, user (the Entra administrator id-{prefix}-portal).')
output database object = {
  serverName: postgres.outputs.name
  fqdn: postgres.outputs.fqdn
  databaseName: namePortalPostgresDatabase()
  user: portalIdentityName
}

@description('Portal network for the portal-side private endpoints (ADR-0025): VNet, private-endpoint subnet and the portal\'s vault zone.')
output network object = {
  vnetId: vnetId
  privateEndpointSubnetId: '${vnetId}/subnets/${snetPepName}'
  vaultPrivateDnsZoneId: resourceId(sub, portalRgName, 'Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))
}

@description('The environment vault of the portal\'s own secrets (ADR-0025): its name and variant, its portal-side endpoint (private vault only), and the SMTP password secret with whether the portal identity got Key Vault Secrets User on it (only once it exists).')
output environmentVault object = {
  name: envVaultName
  variant: environmentVault
  portalEndpointName: envVaultEndpointEnabled ? envVaultEndpointName : null
  smtpPasswordSecretName: empty(smtpPasswordSecretName) ? null : smtpPasswordSecretName
  smtpPasswordRole: smtpPasswordRole
}

@description('The portal Container App (null in pass 1, without portalImageDigest).')
output containerApp object? = appEnabled
  ? {
      id: portalApp!.outputs.id
      name: portalApp!.outputs.name
      fqdn: portalApp!.outputs.fqdn
    }
  : null
