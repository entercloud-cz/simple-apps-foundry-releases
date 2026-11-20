// Azure Monitor action group with email receivers (ADR-0012: email first).

@description('Action group name (naming.platformActionGroup or naming.actionGroup).')
param name string

@description('Short name, max 12 characters (naming.*ShortName).')
@maxLength(12)
param shortName string

@description('Email addresses that receive the alerts.')
param emailAddresses string[]

param tags object

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: name
  location: 'global'
  tags: tags
  properties: {
    groupShortName: shortName
    enabled: true
    emailReceivers: [
      for (address, i) in emailAddresses: {
        name: 'email-${i}'
        emailAddress: address
        useCommonAlertSchema: true
      }
    ]
  }
}

output id string = actionGroup.id
