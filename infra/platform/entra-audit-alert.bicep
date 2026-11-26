// Tier-0 audit alert on the Entra provisioning identity id-{prefix}-entra-provisioning (ADR-0023
// mitigation, US06.04, ENT-8), once per instance. Resource group scope: two Azure Monitor log search
// alerts on the Log Analytics workspace that receives the tenant's Entra audit log.
//
// Who and when: the tenant's identity team (who owns the alert, ADR-0023) or the platform team with
// them, after entra-permissions.bicep. Prerequisite outside this template: an Entra diagnostic
// setting that sends the category AuditLogs to `workspaceResourceId` (Entra admin center >
// Monitoring > Diagnostic settings; Security Administrator or Global Administrator). Deployment
// name `entra-audit-alert`, into the resource group that holds the workspace (or any resource group
// next to it; the rules' scope is the workspace):
//   az deployment group what-if -g <rg> -n entra-audit-alert -p <file>.bicepparam
//   az deployment group create  -g <rg> -n entra-audit-alert -p <file>.bicepparam
// The alerts notify `actionGroupIds`: one of the platform team (e.g. ag-{prefix}-platform-{host env})
// and one of the identity team.
//
// The platform's own Graph writes, with which every event below is compared:
//   - app role assignments only to users and groups, on an app's own service principal
//     (app-registration.bicep, check-infra.py), and their removal by `platform provisioning
//     entra-reconcile` (same service principal, users and groups only);
//   - one delegated grant per app: `openid profile email` on Microsoft Graph, AllPrincipals.
// So the identity never assigns an app role to a service principal (no application permission to
// any app, itself included) and never changes another consent. The rules:
//   tier0    (severity 0) any "Add app role assignment to service principal" or "Remove app role
//            assignment from service principal" initiated by this identity: the Tier-0 abuse of
//            AppRoleAssignment.ReadWrite.All (e.g. granting itself or another app a Microsoft Graph
//            application permission). Stricter than "to a non-platform resource": the platform
//            makes no such assignment on any resource.
//   consent  (severity 1) a delegated permission grant added, changed or removed by this identity
//            whose scope is not exactly `openid profile email` (ADR-0023 amendment 2026-10-29).
// Not covered here: user and group assignments by this identity on an app that isn't the
// platform's; the audit event doesn't say which apps the platform owns. Those are limited by the
// template test and the reconcile command's own check (only the app's own service principal,
// resolved by its uniqueName); backlog item in US06.04's status.
//
// Each rule runs every 15 minutes over the last hour and counts events that reached the workspace
// in the last 15 minutes (ingestion_time()), so an event that arrives late is still counted once.
// TODO(verify) ENT-8: the operation names and the fields read below (InitiatedBy.app
// .servicePrincipalId, TargetResources[].modifiedProperties "DelegatedPermissionGrant.Scope") as
// they appear in the AuditLogs table for this identity's own writes; and the delay until an event
// reaches the workspace. Verify in sandbox: ENT-8.

import {
  entraAuditAlert as nameEntraAuditAlert
} from '../modules/naming/naming.bicep'

@minLength(2)
@maxLength(8)
param prefix string

@description('Region of the alert rules: the workspace\'s region.')
param location string

@description('Log Analytics workspace that receives the Entra audit log (diagnostic setting, category AuditLogs).')
param workspaceResourceId string

@description('Object (principal) ID of id-{prefix}-entra-provisioning: bootstrap.bicep output entraProvisioningIdentity.principalId; the audit log names it as InitiatedBy.app.servicePrincipalId.')
param entraProvisioningPrincipalId string

@description('Action groups the alerts notify: the platform team\'s and the identity team\'s.')
@minLength(1)
param actionGroupIds string[]

param tags object

// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var principalLower = toLower(entraProvisioningPrincipalId)
var principalIsGuid = length(principalLower) == 36 && empty(filter(
  range(0, min(length(principalLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(principalLower, i, 1) != '-' : !contains('0123456789abcdef', substring(principalLower, i, 1))
))
var principalId = principalIsGuid
  ? principalLower
  : fail('entra-audit-alert.bicep: entraProvisioningPrincipalId must be a GUID (the object ID of id-{prefix}-entra-provisioning).')
var workspaceOk = contains(toLower(workspaceResourceId), '/providers/microsoft.operationalinsights/workspaces/')
  ? workspaceResourceId
  : fail('entra-audit-alert.bicep: workspaceResourceId must be the resource ID of a Log Analytics workspace.')

// The queries, with the identity's object ID put in for __PRINCIPAL__ (a validated GUID).
var tier0Query = replace('''AuditLogs
| where ingestion_time() > ago(15m)
| where tolower(tostring(InitiatedBy.app.servicePrincipalId)) == "__PRINCIPAL__"
| where OperationName in ("Add app role assignment to service principal", "Remove app role assignment from service principal")
| project TimeGenerated, OperationName, Result, CorrelationId, Target = tostring(TargetResources[0].displayName), TargetId = tostring(TargetResources[0].id)
''', '__PRINCIPAL__', principalId)

var consentQuery = replace('''AuditLogs
| where ingestion_time() > ago(15m)
| where tolower(tostring(InitiatedBy.app.servicePrincipalId)) == "__PRINCIPAL__"
| where OperationName in ("Add delegated permission grant", "Update delegated permission grant", "Remove delegated permission grant")
| mv-apply target = TargetResources on (
    mv-expand property = target.modifiedProperties
    | where tostring(property.displayName) == "DelegatedPermissionGrant.Scope"
    | summarize scope = take_any(trim(@'[\s"]+', tostring(property.newValue)))
  )
| where OperationName != "Add delegated permission grant" or scope != "openid profile email"
| project TimeGenerated, OperationName, Result, CorrelationId, scope, Target = tostring(TargetResources[0].displayName), TargetId = tostring(TargetResources[0].id)
''', '__PRINCIPAL__', principalId)

var rules = [
  {
    check: 'tier0'
    severity: 0
    description: 'The Entra provisioning identity assigned or removed an app role of a service principal (an application permission). The platform never does this (ADR-0023): treat it as a compromise of the identity until explained.'
    query: tier0Query
  }
  {
    check: 'consent'
    severity: 1
    description: 'The Entra provisioning identity changed a delegated permission grant other than adding the sign-in consent (openid profile email). The platform never does this (ADR-0023 amendment 2026-10-29).'
    query: consentQuery
  }
]

resource alerts 'Microsoft.Insights/scheduledQueryRules@2026-03-01' = [
  for r in rules: {
    name: nameEntraAuditAlert(prefix, r.check)
    location: location
    tags: tags
    kind: 'LogAlert'
    properties: {
      displayName: nameEntraAuditAlert(prefix, r.check)
      description: r.description
      severity: r.severity
      enabled: true
      scopes: [
        workspaceOk
      ]
      evaluationFrequency: 'PT15M'
      windowSize: 'PT1H'
      autoMitigate: false
      criteria: {
        allOf: [
          {
            query: r.query
            timeAggregation: 'Count'
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: {
              numberOfEvaluationPeriods: 1
              minFailingPeriodsToAlert: 1
            }
          }
        ]
      }
      actions: {
        actionGroups: actionGroupIds
      }
    }
  }
]

output alertRuleIds string[] = [for (r, i) in rules: alerts[i].id]
