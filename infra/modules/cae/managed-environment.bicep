// Container Apps environment of one network mode (ADR-0003): always a workload-profile
// environment with only the Consumption profile (never the legacy Consumption-only type).
//
//   infrastructureSubnetId empty  -> Azure-managed network (External only, network: managed).
//                                    The network type can't be changed after creation; a
//                                    redeploy that adds a subnet is rejected. Verify in sandbox: MNET-1.
//   infrastructureSubnetId set    -> custom VNet (External only vnet, External with internal
//                                    access). External ingress (internal: false) in both.
//
// Logs: appLogsConfiguration 'azure-monitor' + a diagnostic setting into the environment
// workspace with resource-specific tables (ContainerAppConsoleLogs, ContainerAppSystemLogs,
// ADR-0012/ADR-0026). Verify in sandbox: LOG-4.

@description('CAE name (naming.managedEnvironment).')
param name string

@description('Azure region of the environment. Container Apps read their region from here.')
param location string

@description('Delegated CAE subnet; empty string = Azure-managed network.')
param infrastructureSubnetId string

@description('Environment Log Analytics workspace.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

resource environment 'Microsoft.App/managedEnvironments@2025-01-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'azure-monitor'
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
    vnetConfiguration: empty(infrastructureSubnetId)
      ? null
      : {
          infrastructureSubnetId: infrastructureSubnetId
          internal: false
        }
    zoneRedundant: false
  }
}

// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: environment
  properties: {
    workspaceId: workspaceId
    logAnalyticsDestinationType: 'Dedicated'
    logs: [
      {
        category: 'ContainerAppConsoleLogs'
        enabled: true
      }
      {
        category: 'ContainerAppSystemLogs'
        enabled: true
      }
    ]
  }
}

output id string = environment.id
output name string = environment.name
output defaultDomain string = environment.properties.defaultDomain
output staticIp string = environment.properties.staticIp
