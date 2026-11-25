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
// The portal database (ADR-0070): data.azureSql.sizes.S (a provisioned Standard SKU), data.backup
// retentionDaysProd and data.azureSql.backupStorageRedundancy.prod of a prod host.
param database = {
  size: {
    skuName: 'S0'
    storageGb: 250
  }
  backupRetentionDays: 35
  backupStorageRedundancy: 'Geo'
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
// The portal's own host name (ADR-0071): portal.{the default zone contoso.com}, through the managed Front
// Door profile afd-contoso-prod. The zone is in another subscription, so its two records are made by hand
// (output frontDoor.dnsRecords). The ranges stand in for the AzureFrontDoor.Backend IPv4 prefixes (RFC 5737).
param frontDoor = {
  hostName: 'portal.contoso.com'
  dnsZoneId: ''
  backendIpRanges: [
    '192.0.2.0/24'
    '198.51.100.0/24'
  ]
}
param managedBy = 'SAF'
// As the platform pipeline: no extra tags (Environment and ManagedBy are always set).
param tags = {}
