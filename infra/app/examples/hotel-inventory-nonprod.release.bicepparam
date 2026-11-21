// Release of `hotel-inventory` to Contoso's `nonprod` (deployment name release-hotel-inventory),
// written out as literal values. The delivery pipeline deploys the same template through
// infra/app/delivery/release.bicepparam: runtime settings from platform.yaml, the digest from the
// verified release manifest, every platform-owned value copied from the last release-{slug}
// deployment record (ADR-0029). Placeholder IDs only.
using '../release.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param slug = 'hotel-inventory'
param generation = 0
param vaultGeneration = 0
param location = 'westeurope'
param networkMode = 'externalOnly'
param cell = '01'
param externalOnlyNetwork = 'managed'
param deployedBy = 'delivery'
param image = {
  digest: readEnvironmentVariable('SAF_IMAGE_DIGEST', 'sha256:0000000000000000000000000000000000000000000000000000000000000000')
}
param runtime = {
  port: 8080
  size: 's'
  minReplicas: 0
  maxReplicas: 3
  livenessPath: '/healthz'
  readinessPath: '/readyz'
}
param env = [
  {
    name: 'LOG_LEVEL'
    value: 'debug'
  }
  {
    name: 'PMS_API_KEY'
    secret: 'pms-api-key'
  }
]
param secrets = [
  'pms-api-key'
]
param landingZone = {
  runtimeIdentityClientId: '00000000-0000-0000-0000-00000000d101'
  database: {
    host: 'pgsql-contoso-hotel-inventory-nonprod-gtcji7.postgres.database.azure.com'
    name: 'hotel_inventory'
    user: 'id-contoso-hotel-inventory-run-nonprod'
  }
  storageBlobEndpoint: 'https://sthotelinventorygtcji7.blob.core.windows.net/'
}
param frontDoor = {
  mode: 'none'
  backendIpRanges: []
}
param customDomains = [
  {
    name: 'hotel-inventory-test.contoso.com'
    certificateName: 'mc-hotel-inventory-test-contoso-com'
  }
]
param authentication = {
  mode: 'required'
  clientId: '00000000-0000-0000-0000-00000000d201'
}
param alertsEnabled = false
param coreVersion = 'v0.1.0'
