// Landing zone of the fictional app `hotel-inventory` in Contoso's `prod` environment
// (External with internal access, promotion environment: images are imported by digest from
// nonprod). Matches infra/platform/examples/contoso-prod.bicepparam (platform-created hybrid
// spoke). Placeholder IDs only.
using '../landing-zone.bicep'

var federationIssuer = readEnvironmentVariable('SAF_DELIVERY_FIC_ISSUER', '')
var federationSubject = readEnvironmentVariable('SAF_DELIVERY_FIC_SUBJECT', '')

param prefix = 'contoso'
param environmentName = 'prod'
param environmentKind = 'prod'
param location = 'westeurope'
param slug = 'hotel-inventory'
param generation = 0
param vaultGeneration = 0
param networkMode = 'externalHybrid'
param cell = '01'
param externalOnlyNetwork = 'vnet'
param hybridExistingVnetId = null
// ADR-0060: null in the steady state; {phase: 'prepare', fromNetworkMode} only during a mode change.
param modeChange = null
param promoteFrom = {
  environmentName: 'nonprod'
  subscriptionId: '00000000-0000-0000-0000-00000000a001'
}
param owner = {
  principalId: '00000000-0000-0000-0000-00000000e001'
  principalType: 'User'
  email: 'jane.owner@contoso.com'
}
param deputy = {
  principalId: '00000000-0000-0000-0000-00000000e002'
  principalType: 'User'
  email: 'john.deputy@contoso.com'
}
param developers = []
param data = {
  postgres: {
    skuName: 'Standard_B2s'
    tier: 'Burstable'
    storageGb: 64
    version: '16'
  }
  storage: {
    redundancy: 'ZRS'
    softDeleteDays: 35
    pointInTimeRestore: true
  }
}
param backupRetentionDays = 35
param postgresGeoRedundantBackup = true
param alertEmails = [
  'jane.owner@contoso.com'
  'john.deputy@contoso.com'
  'platform-team@contoso.com'
]
param postgresCpuCreditAlert = true
param budget = null
param deliveryFederation = empty(federationIssuer)
  ? null
  : {
      issuer: federationIssuer
      subject: federationSubject
    }
param easyAuthSecretExists = bool(readEnvironmentVariable('SAF_EASYAUTH_SECRET_EXISTS', 'false'))
param managedBy = 'SAF'
param costCenter = 'CC-4711'
// instance.yaml portal.identityPrincipalId: Reader on the app RG for id-contoso-portal (ADR-0037); '' = none.
param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'
