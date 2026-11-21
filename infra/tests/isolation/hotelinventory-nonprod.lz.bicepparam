// Test fixture of check-infra.py (ADR-0052, app availability isolation): the fictional app
// `hotelinventory`, a second app in the same Contoso environment as the example
// infra/app/examples/hotel-inventory-nonprod.lz.bicepparam, with confusable inputs: the slug
// without its hyphen (the same compact slug, so registry, vault and storage names differ only by
// the app hash).
// check-infra.py snapshots both apps and asserts that their writes outside their own resource
// groups are disjoint. Not an example to copy. Placeholder IDs only.
using '../../app/landing-zone.bicep'

var federationIssuer = readEnvironmentVariable('SAF_DELIVERY_FIC_ISSUER', '')
var federationSubject = readEnvironmentVariable('SAF_DELIVERY_FIC_SUBJECT', '')

param prefix = 'contoso'
param environmentName = 'nonprod'
param environmentKind = 'nonprod'
param location = 'westeurope'
param slug = 'hotelinventory'
param generation = 0
param vaultGeneration = 0
param networkMode = 'externalOnly'
param cell = '01'
param externalOnlyNetwork = 'managed'
param hybridExistingVnetId = null
// ADR-0060: null in the steady state; {phase: 'prepare', fromNetworkMode} only during a mode change.
param modeChange = null
param promoteFrom = null
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
param developers = [
  {
    principalId: '00000000-0000-0000-0000-00000000e003'
    principalType: 'Group'
  }
]
param data = {
  postgres: {
    skuName: 'Standard_B1ms'
    tier: 'Burstable'
    storageGb: 32
    version: '16'
  }
  storage: {
    redundancy: 'LRS'
    softDeleteDays: 7
    pointInTimeRestore: true
  }
}
param backupRetentionDays = 7
param postgresGeoRedundantBackup = false
param alertEmails = [
  'jane.owner@contoso.com'
  'john.deputy@contoso.com'
]
param postgresCpuCreditAlert = true
param budget = {
  amount: 50
  startDate: '2026-11-01'
  notifyAtPercent: [
    80
    100
  ]
  forecastNotifyAtPercent: [
    100
  ]
}
param deliveryFederation = empty(federationIssuer)
  ? null
  : {
      issuer: federationIssuer
      subject: federationSubject
    }
param easyAuthSecretExists = bool(readEnvironmentVariable('SAF_EASYAUTH_SECRET_EXISTS', 'false'))
param managedBy = 'SAF'
param costCenter = ''
// instance.yaml portal.identityPrincipalId: Reader on the app RG for id-contoso-portal (ADR-0037); '' = none.
param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'
