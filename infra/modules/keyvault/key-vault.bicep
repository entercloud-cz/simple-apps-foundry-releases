// Key Vault in RBAC mode (no access policies), used for the environment vaults (public /
// private, ADR-0003) and for app vaults (ADR-0004). Network access follows the variant:
//   public  = public network access enabled, default action Allow, no IP rules, RBAC only
//   private = public network access disabled; private endpoints are added by the caller
// (an app vault keeps public access next to its new endpoint in the prepare pass of a network
// mode change, ADR-0060).
// Soft delete is always on. Purge protection can't be switched off again once enabled, so it
// is set only where the caller asks for it (prod kind).

@description('Vault name (naming.environmentKeyVault or naming.appKeyVault).')
param name string

@description('Azure region.')
param location string

@description('true = public endpoint (managed-network variant), false = private endpoints only (VNet-based variants).')
param publicNetworkAccess bool

@description('Purge protection (on in prod-kind environments, lessons-from-v1). Can never be disabled afterwards.')
param enablePurgeProtection bool

@description('Soft-delete retention in days (7-90). Fixed once the vault exists.')
@minValue(7)
@maxValue(90)
param softDeleteRetentionInDays int

@description('Log Analytics workspace for AuditEvent logs.')
param workspaceId string

@description('Diagnostic setting name (naming.diagnosticSetting).')
param diagnosticSettingName string

param tags object

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' = {
  name: name
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: {
      family: 'A'
      name: 'standard'
    }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: softDeleteRetentionInDays
    // The API rejects enablePurgeProtection: false, so "off" is expressed as null.
    enablePurgeProtection: enablePurgeProtection ? true : null
    enabledForDeployment: false
    enabledForDiskEncryption: false
    enabledForTemplateDeployment: false
    publicNetworkAccess: publicNetworkAccess ? 'Enabled' : 'Disabled'
    networkAcls: {
      defaultAction: publicNetworkAccess ? 'Allow' : 'Deny'
      bypass: 'None'
      ipRules: []
      virtualNetworkRules: []
    }
  }
}

// 2021-05-01-preview is the newest diagnosticSettings version with workspace/category groups.
#disable-next-line use-recent-api-versions
resource diagnostics 'Microsoft.Insights/diagnosticSettings@2021-05-01-preview' = {
  name: diagnosticSettingName
  scope: vault
  properties: {
    workspaceId: workspaceId
    logs: [
      {
        category: 'AuditEvent'
        enabled: true
      }
    ]
  }
}

output id string = vault.id
output name string = vault.name
output uri string = vault.properties.vaultUri
