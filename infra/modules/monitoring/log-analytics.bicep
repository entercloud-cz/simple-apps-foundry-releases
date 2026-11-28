// Log Analytics workspace of one platform environment (ADR-0012): CAEs, App Insights and the
// diagnostic settings of every platform-created resource send their data here.

import {
  platformEnvironmentRoles
} from '../types.bicep'

@description('Workspace name (naming.logAnalyticsWorkspace).')
param name string

@description('Azure region of the environment.')
param location string

@description('Retention in days (instance.yaml observability.logRetentionDays).')
@minValue(30)
@maxValue(730)
param retentionInDays int

param tags object

@description('Object (principal) ID of the portal identity id-{prefix}-portal: Log Analytics Reader on this workspace for the portal\'s log viewer (ADR-0026). Empty = no assignment (the portal is not set up yet).')
param portalPrincipalId string

resource workspace 'Microsoft.OperationalInsights/workspaces@2025-02-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    features: {
      // Access to app rows goes through the portal log viewer (ADR-0026); resource-context
      // RBAC stays on so App Insights in an app RG remains readable with Reader there.
      enableLogAccessUsingOnlyResourcePermissions: true
    }
    publicNetworkAccessForIngestion: 'Enabled'
    publicNetworkAccessForQuery: 'Enabled'
  }
}

// Log Analytics Reader (built-in). In types.platformEnvironmentRoles, not types.builtInRoles: the
// provisioning identity may assign it to the portal identity only (bootstrap.bicep condition,
// ADR-0043), and does so only here. The portal filters every query to one app on the server
// (ADR-0026).
var logAnalyticsReaderRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', platformEnvironmentRoles.logAnalyticsReader)

resource portalReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (!empty(portalPrincipalId)) {
  // The portal identity lives in the host environment's subscription: its object ID seeds the name.
  name: guid(workspace.id, portalPrincipalId, logAnalyticsReaderRoleId)
  scope: workspace
  properties: {
    principalId: portalPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: logAnalyticsReaderRoleId
    description: 'Portal: app logs, each query filtered to one app by the portal (ADR-0026).'
  }
}

output id string = workspace.id
output name string = workspace.name
output customerId string = workspace.properties.customerId
