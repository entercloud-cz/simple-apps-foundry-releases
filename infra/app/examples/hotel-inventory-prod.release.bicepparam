// Release of `hotel-inventory` to Contoso's `prod` (hybrid CAE, behind the managed Front Door
// profile afd-contoso-prod), written out as literal values; delivery deploys it through
// infra/app/delivery/release.bicepparam after approval and import by digest (ADR-0029).
// Placeholder IDs and documentation-range IPs only: provisioning resolves the
// AzureFrontDoor.Backend ranges from the Service Tags API.
using '../release.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param slug = 'hotel-inventory'
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
    host: 'pgsql-contoso-hotel-inventory-prod-gwzpmy.postgres.database.azure.com'
    name: 'hotel_inventory'
    user: 'id-contoso-hotel-inventory-run-prod'
  }
  storageBlobEndpoint: 'https://sthotelinventorygwzpmy.blob.core.windows.net/'
}
param frontDoor = {
  mode: 'managed'
  frontDoorId: '00000000-0000-0000-0000-00000000fd01'
  hostNames: [
    'hotel-inventory.contoso.com'
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
