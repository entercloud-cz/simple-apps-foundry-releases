// Fictional Contoso instance: the portal in its host environment `prod`
// (config/examples/instance.example.yaml portal.hostEnvironment), deployed with
// infra/platform/portal.bicep (infra/README.md#portal). Placeholder IDs only. The platform pipeline
// deploys it through infra/platform/pipeline/portal.bicepparam (ADR-0043 decision 10); this
// hand-written file is the reference and break-glass: check-infra.py checks that the pipeline's
// example input (pipeline/examples/contoso-prod.portal.json) predicts exactly its resources.
//
// Pass 1: SAF_PORTAL_IMAGE_DIGEST unset or empty (no Container App); SAF_PORTAL_CLIENT_ID may be
// empty. Pass 2: SAF_PORTAL_IMAGE_DIGEST = the saf-portal digest of images/images.json, imported
// into the platform registry, and SAF_PORTAL_CLIENT_ID = the client ID of the portal registration
// (infra/entra/portal-registration.bicep).
using '../portal.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param environmentKind = 'prod'
param location = 'westeurope'
param tenantId = '00000000-0000-0000-0000-000000000001'
param network = {
  vnetAddressSpace: '10.40.0.0/23'
  caeSubnetPrefix: '10.40.0.0/25'
  privateEndpointSubnetPrefix: '10.40.1.0/24'
  approvalReference: 'CHG-1001'
}
param azureDevOps = {
  organizationUrl: 'https://dev.azure.com/contoso'
  platformProject: 'Platform'
  platformConfigRepo: 'platform-config'
  platformConfigDefaultBranch: 'main'
  appsProject: 'Apps'
  allowedProjects: [
    'Finance'
    'HR'
  ]
}
// The portal database (ADR-0038): data.postgres.sizes.S and data.postgres.version, data.backup of a
// prod host (retentionDaysProd, geoRedundantProd).
param database = {
  size: {
    skuName: 'Standard_B1ms'
    tier: 'Burstable'
    storageGb: 32
    version: '16'
  }
  backupRetentionDays: 35
  geoRedundantBackup: true
}
param portalImageDigest = readEnvironmentVariable('SAF_PORTAL_IMAGE_DIGEST', '')
param portalClientId = readEnvironmentVariable('SAF_PORTAL_CLIENT_ID', '')
// The host `prod` has a VNet-based CAE (externalHybrid): its private environment vault holds the
// portal's own secrets and gets the portal-side endpoint (ADR-0025). Email goes through the shared
// mailbox, so no SMTP password secret.
param vaultGeneration = 0
param environmentVault = 'private'
param smtpPasswordSecretName = ''
param smtpPasswordSecretExists = false
param managedBy = 'SAF'
// As the platform pipeline: no extra tags (Environment and ManagedBy are always set).
param tags = {}
