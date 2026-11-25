// Naming test matrix (ADR-0020). Compiles every exported naming function for each input case
// into outputs. infra/tests/check-naming.py evaluates this template locally with
// `bicep snapshot` (no Azure access) and asserts exact names, hash shapes and length limits.
// Not deployed anywhere.

targetScope = 'subscription'

import * as naming from '../modules/naming/naming.bicep'

@description('Input cases: prefix, env, envKind, slug, jobKey, subscriptionId, generation, vaultGeneration, host; scPurpose (optional, default ado) feeds instanceServiceConnection, customRole (optional, default entra-deployment-operator) customRoleDefinitionGuid, networkMode (optional, default portal) the portal network names, caeMode (optional, default externalOnly) caeByMode, dnsZone (optional, default contoso.com) the record names of host in its DNS zone, cell (optional, default 02) the names of a later capacity cell (ADR-0053), incarnation (optional, default 0) the Entra registration\'s uniqueName (ADR-0061).')
param cases {
  prefix: string
  env: string
  envKind: 'prod' | 'nonprod'
  slug: string
  jobKey: string
  subscriptionId: string
  generation: int
  vaultGeneration: int
  host: string
  scPurpose: string?
  customRole: string?
  networkMode: string?
  caeMode: string?
  dnsZone: string?
  cell: string?
  incarnation: int?
}[]

// Placeholder tenant ID seeding the custom role definition GUIDs.
var tenantId = '00000000-0000-0000-0000-000000000001'

output names object[] = map(cases, c => {
  input: c
  platform: {
    platformResourceGroup: naming.platformResourceGroup(c.prefix, c.env)
    privateDnsResourceGroupExt: naming.privateDnsResourceGroup(c.prefix, 'externalOnly', c.env)
    privateDnsResourceGroupHyb: naming.privateDnsResourceGroup(c.prefix, 'externalHybrid', c.env)
    logAnalyticsWorkspace: naming.logAnalyticsWorkspace(c.prefix, c.env)
    platformActionGroup: naming.platformActionGroup(c.prefix, c.env)
    platformActionGroupShortName: naming.platformActionGroupShortName(c.prefix, c.env)
    diagnosticSetting: naming.diagnosticSetting(c.prefix, c.env)
    caeExt: naming.managedEnvironment(c.prefix, 'externalOnly', c.env)
    caeHyb: naming.managedEnvironment(c.prefix, 'externalHybrid', c.env)
    caeInt: naming.managedEnvironment(c.prefix, 'internalOnly', c.env)
    caePortal: naming.portalManagedEnvironment(c.prefix, c.env)
    caeByMode: naming.managedEnvironment(c.prefix, c.?caeMode ?? 'externalOnly', c.env)
    portalResourceGroup: naming.portalResourceGroup(c.prefix, c.env)
    portalContainerApp: naming.portalContainerApp(c.prefix)
    portalPostgresServer: naming.portalPostgresServer(c.prefix, c.env, c.subscriptionId)
    portalPostgresDatabase: naming.portalPostgresDatabase()
    pepPortalPostgres: naming.privateEndpoint(naming.portalPostgresServer(c.prefix, c.env, c.subscriptionId), '')
    portalSqlServer: naming.portalSqlServer(c.prefix, c.env, c.subscriptionId)
    portalSqlDatabase: naming.portalSqlDatabase()
    pepPortalSql: naming.privateEndpoint(naming.portalSqlServer(c.prefix, c.env, c.subscriptionId), '')
    vnetPortal: naming.virtualNetwork(c.prefix, c.?networkMode ?? 'portal', c.env)
    snetCaePortal: naming.subnet(c.prefix, 'cae', c.?networkMode ?? 'portal', c.env)
    snetPepPortal: naming.subnet(c.prefix, 'pep', c.?networkMode ?? 'portal', c.env)
    nsgCaePortal: naming.networkSecurityGroup(c.prefix, 'cae', c.?networkMode ?? 'portal', c.env)
    nsgPepPortal: naming.networkSecurityGroup(c.prefix, 'pep', c.?networkMode ?? 'portal', c.env)
    natGatewayPortal: naming.natGateway(c.prefix, c.?networkMode ?? 'portal', c.env)
    natPublicIpPortal01: naming.natGatewayPublicIp(c.prefix, c.?networkMode ?? 'portal', c.env, 1)
    dnsZoneLinkPortal: naming.privateDnsZoneLink(naming.virtualNetwork(c.prefix, c.?networkMode ?? 'portal', c.env))
    vnetExt: naming.virtualNetwork(c.prefix, 'externalOnly', c.env)
    vnetHyb: naming.virtualNetwork(c.prefix, 'externalHybrid', c.env)
    snetCaeExt: naming.subnet(c.prefix, 'cae', 'externalOnly', c.env)
    snetPepHyb: naming.subnet(c.prefix, 'pep', 'externalHybrid', c.env)
    nsgCaeHyb: naming.networkSecurityGroup(c.prefix, 'cae', 'externalHybrid', c.env)
    nsgPepExt: naming.networkSecurityGroup(c.prefix, 'pep', 'externalOnly', c.env)
    natGatewayExt: naming.natGateway(c.prefix, 'externalOnly', c.env)
    natPublicIp01: naming.natGatewayPublicIp(c.prefix, 'externalOnly', c.env, 1)
    natPublicIp16: naming.natGatewayPublicIp(c.prefix, 'externalOnly', c.env, 16)
    hubPeeringHyb: naming.hubPeering(c.prefix, 'externalHybrid', c.env)
    dnsZoneLinkHyb: naming.privateDnsZoneLink(naming.virtualNetwork(c.prefix, 'externalHybrid', c.env))
    envVaultPublic: naming.environmentKeyVault(
      c.prefix,
      c.env,
      'public',
      c.subscriptionId,
      '/subscriptions/${c.subscriptionId}/resourceGroups/${naming.platformResourceGroup(c.prefix, c.env)}',
      c.vaultGeneration
    )
    envVaultPrivate: naming.environmentKeyVault(
      c.prefix,
      c.env,
      'private',
      c.subscriptionId,
      '/subscriptions/${c.subscriptionId}/resourceGroups/${naming.platformResourceGroup(c.prefix, c.env)}',
      c.vaultGeneration
    )
    envVaultPrivateNextGeneration: naming.environmentKeyVault(
      c.prefix,
      c.env,
      'private',
      c.subscriptionId,
      '/subscriptions/${c.subscriptionId}/resourceGroups/${naming.platformResourceGroup(c.prefix, c.env)}',
      c.vaultGeneration + 1
    )
    envVaultPrivatePepHyb: naming.spokePrivateEndpoint(
      naming.environmentKeyVault(
        c.prefix,
        c.env,
        'private',
        c.subscriptionId,
        '/subscriptions/${c.subscriptionId}/resourceGroups/${naming.platformResourceGroup(c.prefix, c.env)}',
        c.vaultGeneration
      ),
      'externalHybrid'
    )
    platformRegistry: naming.platformContainerRegistry(c.prefix, c.env, c.subscriptionId)
    platformJobDbinitExt: naming.platformJob(c.prefix, 'dbinit', 'externalOnly')
    platformJobKvsetExt: naming.platformJob(c.prefix, 'kvset', 'externalOnly')
    platformJobKvsetHyb: naming.platformJob(c.prefix, 'kvset', 'externalHybrid')
    caeExtCell01: naming.cellManagedEnvironment(c.prefix, 'externalOnly', c.env, '01')
    caeExtCell: naming.cellManagedEnvironment(c.prefix, 'externalOnly', c.env, c.?cell ?? '02')
    caeHybCell: naming.cellManagedEnvironment(c.prefix, 'externalHybrid', c.env, c.?cell ?? '02')
    snetCaeExtCell01: naming.cellCaeSubnet(c.prefix, 'externalOnly', c.env, '01')
    snetCaeHybCell: naming.cellCaeSubnet(c.prefix, 'externalHybrid', c.env, c.?cell ?? '02')
    nsgCaeHybCell01: naming.cellCaeNetworkSecurityGroup(c.prefix, 'externalHybrid', c.env, '01')
    nsgCaeHybCell: naming.cellCaeNetworkSecurityGroup(c.prefix, 'externalHybrid', c.env, c.?cell ?? '02')
    platformJobKvsetExtCell01: naming.cellPlatformJob(c.prefix, 'kvset', 'externalOnly', '01')
    platformJobKvsetExtCell: naming.cellPlatformJob(c.prefix, 'kvset', 'externalOnly', c.?cell ?? '02')
    platformJobDbinitHybCell: naming.cellPlatformJob(c.prefix, 'dbinit', 'externalHybrid', c.?cell ?? '02')
    platformJobIdentityRecov: naming.platformJobIdentity(c.prefix, 'recov', c.env)
    provisioningIdentity: naming.provisioningIdentity(c.prefix, c.env)
    entraProvisioningIdentity: naming.instanceIdentity(c.prefix, 'entra-provisioning')
    adoAutomationIdentity: naming.instanceIdentity(c.prefix, 'ado-automation')
    portalIdentity: naming.instanceIdentity(c.prefix, 'portal')
    identitiesResourceGroup: naming.identitiesResourceGroup(c.prefix, c.env)
    identitiesLock: naming.identitiesLock(c.prefix)
    entraResourceGroup: naming.entraResourceGroup(c.prefix)
    entraEnvironmentResourceGroup: naming.entraEnvironmentResourceGroup(c.prefix, c.env)
    entraAuditAlertTier0: naming.entraAuditAlert(c.prefix, 'tier0')
    entraAuditAlertConsent: naming.entraAuditAlert(c.prefix, 'consent')
    provisioningServiceConnection: naming.provisioningServiceConnection(c.env)
    instanceServiceConnection: naming.instanceServiceConnection(c.?scPurpose ?? 'ado')
    entraServiceConnection: naming.instanceServiceConnection('entra')
    backupVault: naming.backupVault(c.prefix, c.env)
    frontDoorProfile: naming.frontDoorProfile(c.prefix, c.env)
    frontDoorEndpoint: naming.frontDoorEndpoint(c.prefix, c.env)
    frontDoorWafPolicy: naming.frontDoorWafPolicy(c.prefix, c.env)
    frontDoorSecurityPolicy: naming.frontDoorSecurityPolicy(c.prefix, c.env)
    frontDoorPortalOriginGroup: naming.frontDoorPortalOriginGroup(c.env)
    frontDoorPortalOrigin: naming.frontDoorPortalOrigin(c.env)
    frontDoorPortalRoute: naming.frontDoorPortalRoute(c.env)
    platformDeployment: naming.platformDeployment(c.prefix, c.env)
    portalDeployment: naming.portalDeployment(c.prefix, c.env)
    appDeployerRoleName: naming.appDeployerRoleName(c.prefix)
    appEnvironmentJoinerRoleName: naming.appEnvironmentJoinerRoleName(c.prefix)
    entraDeploymentOperatorRoleName: naming.entraDeploymentOperatorRoleName(c.prefix)
    platformJobSecretWriterRoleName: naming.platformJobSecretWriterRoleName(c.prefix)
    customRoleAppDeployer: naming.customRoleDefinitionGuid(tenantId, c.prefix, 'app-deployer')
    customRoleAppEnvironmentJoiner: naming.customRoleDefinitionGuid(tenantId, c.prefix, 'app-environment-joiner')
    customRoleEntraDeploymentOperator: naming.customRoleDefinitionGuid(tenantId, c.prefix, c.?customRole ?? 'entra-deployment-operator')
    customRolePlatformJobSecretWriter: naming.customRoleDefinitionGuid(tenantId, c.prefix, 'platform-job-secret-writer')
  }
  app: {
    appResourceGroup: naming.appResourceGroup(c.prefix, c.slug, c.env)
    slugCompact: naming.slugCompact(c.slug)
    hash6: naming.hash6(c.subscriptionId, naming.appResourceGroup(c.prefix, c.slug, c.env), c.generation)
    containerApp: naming.containerApp(c.slug)
    containerAppJob: naming.containerAppJob(c.slug, c.jobKey)
    runtimeIdentity: naming.runtimeIdentity(c.prefix, c.slug, c.env)
    deliveryIdentity: naming.deliveryIdentity(c.prefix, c.slug, c.env)
    easyAuthIdentity: naming.easyAuthIdentity(c.prefix, c.slug, c.env)
    deliveryFederatedCredential: naming.deliveryFederatedCredential(c.slug, c.env)
    containerRegistry: naming.containerRegistry(c.prefix, c.slug, c.env, c.subscriptionId, c.generation)
    appKeyVault: naming.appKeyVault(c.prefix, c.slug, c.env, c.subscriptionId, c.generation)
    appKeyVaultNextGeneration: naming.appKeyVault(c.prefix, c.slug, c.env, c.subscriptionId, c.generation + 1)
    storageAccount: naming.storageAccount(c.prefix, c.slug, c.env, c.subscriptionId, c.generation)
    postgresServer: naming.postgresServer(c.prefix, c.slug, c.env, c.subscriptionId, c.generation)
    postgresDatabase: naming.postgresDatabase(c.slug)
    sqlServer: naming.sqlServer(c.prefix, c.slug, c.env, c.subscriptionId, c.generation)
    sqlDatabase: naming.sqlDatabase(c.slug)
    pepPostgres: naming.privateEndpoint(naming.postgresServer(c.prefix, c.slug, c.env, c.subscriptionId, c.generation), '')
    pepVault: naming.privateEndpoint(naming.appKeyVault(c.prefix, c.slug, c.env, c.subscriptionId, c.generation), '')
    pepSql: naming.privateEndpoint(naming.sqlServer(c.prefix, c.slug, c.env, c.subscriptionId, c.generation), '')
    pepVaultPortal: naming.portalPrivateEndpoint(naming.appKeyVault(c.prefix, c.slug, c.env, c.subscriptionId, c.generation))
    pepStorageBlob: naming.privateEndpoint(naming.storageAccount(c.prefix, c.slug, c.env, c.subscriptionId, c.generation), 'blob')
    pepStorageBlobNic: naming.privateEndpointNic(naming.privateEndpoint(naming.storageAccount(c.prefix, c.slug, c.env, c.subscriptionId, c.generation), 'blob'))
    applicationInsights: naming.applicationInsights(c.slug, c.env)
    actionGroup: naming.actionGroup(c.slug, c.env)
    actionGroupShortName: naming.actionGroupShortName(c.slug, c.env)
    metricAlertRestarts: naming.metricAlert(c.slug, 'restarts', c.env)
    metricAlertPgCredits: naming.metricAlert(c.slug, 'pgcredits', c.env)
    budget: naming.budget(c.slug, c.env)
    registryRepository: naming.registryRepository(c.slug)
    easyAuthSecret: naming.easyAuthSecret(c.slug)
    frontDoorOriginGroup: naming.frontDoorOriginGroup(c.slug, c.env)
    frontDoorOrigin: naming.frontDoorOrigin(c.slug, c.env)
    frontDoorRoute: naming.frontDoorRoute(c.slug, c.env)
    frontDoorCustomDomain: naming.frontDoorCustomDomain(c.host)
    frontDoorValidationRecord: naming.frontDoorValidationRecord(c.host)
    dnsHostRecord: naming.dnsRelativeRecordName(c.host, c.?dnsZone ?? 'contoso.com')
    dnsValidationRecord: naming.dnsRelativeRecordName(naming.frontDoorValidationRecord(c.host), c.?dnsZone ?? 'contoso.com')
    provisioningDeployment: naming.provisioningDeployment(c.slug, c.env)
    releaseDeployment: naming.releaseDeployment(c.slug)
    frontDoorDeployment: naming.frontDoorDeployment(c.slug, c.env)
    entraDeployment: naming.entraDeployment(c.slug, c.env)
    entraApplicationUniqueName: naming.entraApplicationUniqueName(c.prefix, c.slug, c.env, c.?incarnation ?? 0)
    portalEntraApplicationUniqueName: naming.portalEntraApplicationUniqueName(c.prefix, c.env)
    portalCliEntraApplicationUniqueName: naming.portalCliEntraApplicationUniqueName(c.prefix, c.env)
    portalEntraDeployment: naming.portalEntraDeployment(c.env)
    portalEndpointDeployment: naming.portalEndpointDeployment(c.slug, c.env)
    entraApplicationDisplayName: naming.entraApplicationDisplayName('Hotel Inventory', c.env, c.envKind)
    adoServiceConnection: naming.adoServiceConnection(c.slug, c.env)
    adoEnvironment: naming.adoEnvironment(c.slug, c.env)
    adoDeliveryPipeline: naming.adoDeliveryPipeline(c.slug)
    adoPlatformPipeline: naming.adoPlatformPipeline(c.env)
    adoPlatformEnvironment: naming.adoPlatformEnvironment(c.env)
  }
})
