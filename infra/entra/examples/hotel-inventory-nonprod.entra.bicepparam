// Entra app registration of the fictional app `hotel-inventory` in Contoso's `nonprod`
// (managed-network External only, no Front Door). In a real instance the provisioning pipeline's
// entra stage generates this file from apps/hotel-inventory/app.yaml. Placeholder IDs only.
using '../app-registration.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param environmentKind = 'nonprod'
param slug = 'hotel-inventory'
param incarnation = 0
param appTitle = 'Hotel Inventory'
param hosts = [
  'ca-hotel-inventory.happyfield-00000000.westeurope.azurecontainerapps.io'
  'hotel-inventory-test.contoso.com'
]
param appRoles = [
  {
    value: 'Reader'
    displayName: 'Reader'
    description: 'Can view stock levels.'
  }
  {
    value: 'Editor'
    displayName: 'Editor'
    description: 'Can change stock levels.'
  }
  {
    value: 'Admin'
    displayName: 'Admin'
    description: 'Can manage the app.'
  }
]
param roleAssignments = [
  {
    principalId: '00000000-0000-0000-0000-00000000c101'
    role: 'Reader'
  }
  {
    principalId: '00000000-0000-0000-0000-00000000c102'
    role: 'Admin'
  }
]
