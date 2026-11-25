// Test fixture of check-infra.py (ADR-0052, app availability isolation): the fictional app
// `hotelinventory`, a second app in the same Contoso environment as the example
// infra/app/examples/hotel-inventory-nonprod.release.bicepparam, with confusable inputs: the slug
// without its hyphen (the same compact slug, so registry, vault and storage names differ only by
// the app hash).
// check-infra.py snapshots both apps and asserts that their writes outside their own resource
// groups are disjoint. Not an example to copy. Placeholder IDs only.
using '../../app/release.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param slug = 'hotelinventory'
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
    host: 'pgsql-contoso-hotelinventory-nonprod-gtcji7.postgres.database.azure.com'
    name: 'hotelinventory'
    user: 'id-contoso-hotelinventory-run-nonprod'
  }
  storageBlobEndpoint: 'https://sthotelinventorygtcji7.blob.core.windows.net/'
}
param frontDoor = {
  mode: 'none'
  backendIpRanges: []
}
param customDomains = [
  {
    name: 'hotelinventory-test.contoso.com'
    certificateName: 'mc-hotelinventory-test-contoso-com'
  }
]
param authentication = {
  mode: 'required'
  clientId: '00000000-0000-0000-0000-00000000d201'
}
param alertsEnabled = false
param coreVersion = 'v0.1.0'
