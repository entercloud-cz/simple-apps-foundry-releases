// Test fixture of check-infra.py (ADR-0052, app availability isolation): the fictional app
// `hotelinventory`, a second app in the same Contoso environment as the example
// infra/app/examples/hotel-inventory-prod.release.bicepparam, with confusable inputs: the slug
// without its hyphen (the same compact slug, so registry, vault and storage names differ only by
// the app hash).
// check-infra.py snapshots both apps and asserts that their writes outside their own resource
// groups are disjoint. Not an example to copy. Placeholder IDs only.
using '../../app/release.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param slug = 'hotelinventory'
param generation = 0
param vaultGeneration = 0
param location = 'westeurope'
param networkMode = 'externalHybrid'
param cell = '01'
param externalOnlyNetwork = 'vnet'
param deployedBy = 'delivery'
param image = {
  digest: readEnvironmentVariable('SAF_IMAGE_DIGEST', 'sha256:0000000000000000000000000000000000000000000000000000000000000000')
}
param runtime = {
  port: 8080
  size: 'm'
  minReplicas: 1
  maxReplicas: 5
  livenessPath: '/healthz'
  readinessPath: '/readyz'
}
param env = [
  {
    name: 'LOG_LEVEL'
    value: 'info'
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
  runtimeIdentityClientId: '00000000-0000-0000-0000-00000000d102'
  database: {
    host: 'pgsql-contoso-hotelinventory-prod-gwzpmy.postgres.database.azure.com'
    name: 'hotelinventory'
    user: 'id-contoso-hotelinventory-run-prod'
  }
  storageBlobEndpoint: 'https://sthotelinventorygwzpmy.blob.core.windows.net/'
}
param frontDoor = {
  mode: 'managed'
  frontDoorId: '00000000-0000-0000-0000-00000000fd01'
  hostNames: [
    'hotelinventory.contoso.com'
  ]
  backendIpRanges: [
    '192.0.2.0/24'
    '198.51.100.0/24'
  ]
}
param customDomains = []
param authentication = {
  mode: 'required'
  clientId: '00000000-0000-0000-0000-00000000d202'
}
param alertsEnabled = false
param coreVersion = 'v0.1.0'
