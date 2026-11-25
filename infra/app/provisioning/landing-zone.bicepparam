// The only parameter file the provisioning pipeline deploys landing-zone.bicep with
// (deployment lz-{slug}-{env}, Azure provisioning identity).
//
// Input: SAF_LZ_JSON, written by `platform provisioning inputs --step lz` from instance.yaml,
// apps/{slug}/app.yaml and the run's state (ADO federation issuer/subject, the Easy Auth secret
// flag carried from the last lz record, the budget start date). Every value comes from that JSON:
// the CLI resolves defaults and fails on missing runtime values, and Bicep type-checks the JSON
// when this file is compiled (keys it doesn't use are ignored). No other --parameters.

using '../landing-zone.bicep'

var lz = json(readEnvironmentVariable('SAF_LZ_JSON'))

param prefix = lz.prefix
param environmentName = lz.environmentName
param environmentKind = lz.environmentKind
param location = lz.location
param slug = lz.slug
param generation = lz.generation
param vaultGeneration = lz.vaultGeneration
param networkMode = lz.networkMode
param cell = lz.cell
param externalOnlyNetwork = lz.externalOnlyNetwork
param hybridExistingVnetId = lz.hybridExistingVnetId
param modeChange = lz.modeChange
param promoteFrom = lz.promoteFrom
param owner = lz.owner
param deputy = lz.deputy
param developers = lz.developers
param data = lz.data
param backupRetentionDays = lz.backupRetentionDays
param postgresGeoRedundantBackup = lz.postgresGeoRedundantBackup
param alertEmails = lz.alertEmails
param postgresCpuCreditAlert = lz.postgresCpuCreditAlert
param budget = lz.budget
param deliveryFederation = lz.deliveryFederation
param easyAuthSecretExists = lz.easyAuthSecretExists
param managedBy = lz.managedBy
param costCenter = lz.costCenter
param portalIdentityPrincipalId = lz.portalIdentityPrincipalId
