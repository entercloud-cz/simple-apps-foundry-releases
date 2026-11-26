// Custom role definitions, ONE definition per instance:
//   App Deployer ({prefix})                delivery identity (ADR-0021), per app x environment at
//                                          the app RG
//   App Environment Joiner ({prefix})      delivery identity (ADR-0021), per app x environment at
//                                          the app's CAE
//   Platform Job Secret Writer ({prefix})  Entra provisioning identity (ADR-0035), on each kvset
//                                          platform job and nowhere else (environment.bicep). In
//                                          the provisioning identity's role set for that one
//                                          principal only (bootstrap.bicep condition, ADR-0043).
//
// Run by a HUMAN (Owner or User Access Administrator on every environment subscription), once per
// instance and again when a core version changes the actions, always from the same subscription
// (the portal host environment), with every environment subscription as an assignable scope. No
// pipeline deploys it (ADR-0043): writing role definitions would let an identity widen a role it
// may assign. The platform pipeline only checks, before its approval, that the three definitions
// exist with these actions and scopes (`platform environment roles-check`), and stops if not. The
// definition GUID is derived from tenant and prefix by the naming module, so landing zones compute
// the role ID without a lookup.
//
// No role contains Microsoft.Authorization/*, a delete action, listSecrets or a Key Vault action
// (asserted in infra/tests/check-infra.py).
// Verify in sandbox: NR-1 (definitions), NR-6 (optional actions).

targetScope = 'subscription'

import {
  appDeployerRoleName
  appEnvironmentJoinerRoleName
  customRoleDefinitionGuid
  platformJobSecretWriterRoleName
} from '../modules/naming/naming.bicep'

@description('Instance prefix (instance.yaml naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('Subscription IDs of every environment (instance.yaml environments[].subscriptionId). Must include this deployment\'s subscription.')
@minLength(1)
param environmentSubscriptionIds string[]

var assignableScopes = [for id in environmentSubscriptionIds: '/subscriptions/${id}']

// Actions exactly as ADR-0021 / naming spike A1. The four Microsoft.App/locations/* actions
// are candidates for removal (NR-6).
var appDeployerActions = [
  'Microsoft.Resources/subscriptions/resourceGroups/read'
  'Microsoft.Resources/deployments/read'
  'Microsoft.Resources/deployments/write'
  'Microsoft.Resources/deployments/validate/action'
  'Microsoft.Resources/deployments/whatIf/action'
  'Microsoft.Resources/deployments/cancel/action'
  'Microsoft.Resources/deployments/operations/read'
  'Microsoft.Resources/deployments/operationstatuses/read'
  'Microsoft.App/containerApps/read'
  'Microsoft.App/containerApps/write'
  'Microsoft.App/containerApps/revisions/read'
  'Microsoft.App/containerApps/revisions/replicas/read'
  'Microsoft.App/containerApps/detectors/read'
  'Microsoft.App/jobs/read'
  'Microsoft.App/jobs/write'
  'Microsoft.App/jobs/start/action'
  'Microsoft.App/jobs/executions/read'
  'Microsoft.App/locations/containerappOperationStatuses/read'
  'Microsoft.App/locations/containerappOperationResults/read'
  'Microsoft.App/locations/containerappsjobOperationStatuses/read'
  'Microsoft.App/locations/containerappsjobOperationResults/read'
  'Microsoft.ContainerRegistry/registries/read'
  'Microsoft.Insights/components/read'
]

// No managedEnvironments/managedCertificates/read: custom domains go through Front Door only and
// none is bound at the CAE (ADR-0010, amended 2026-11-12; NR-12 withdrawn).
var appEnvironmentJoinerActions = [
  'Microsoft.App/managedEnvironments/read'
  'Microsoft.App/managedEnvironments/join/action'
]

// Platform Job Secret Writer: set the one-time job secret (jobs/write), start the job, follow
// the execution and the job operations; exactly these actions (check-infra.py). No listSecrets:
// the identity writes the secret, it never reads one back. A PATCH of configuration.secrets on the
// job with its user-assigned identity needs no userAssignedIdentities/assign/action, and the
// operation URLs are readable with the job-scoped assignment (JOB-3, 2026-10-30).
var platformJobSecretWriterActions = [
  'Microsoft.App/jobs/read'
  'Microsoft.App/jobs/write'
  'Microsoft.App/jobs/start/action'
  'Microsoft.App/jobs/executions/read'
  'Microsoft.App/locations/containerappsjobOperationStatuses/read'
  'Microsoft.App/locations/containerappsjobOperationResults/read'
]

resource appDeployer 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: customRoleDefinitionGuid(tenant().tenantId, prefix, 'app-deployer')
  properties: {
    roleName: appDeployerRoleName(prefix)
    description: 'Delivery identity of one app in one environment: deploy Container App / Container Apps Job revisions into the app resource group. No delete, no secrets, no RBAC, no networking, no auth config (ADR-0021).'
    type: 'CustomRole'
    permissions: [
      {
        actions: appDeployerActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: assignableScopes
  }
}

resource appEnvironmentJoiner 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: customRoleDefinitionGuid(tenant().tenantId, prefix, 'app-environment-joiner')
  properties: {
    roleName: appEnvironmentJoinerRoleName(prefix)
    description: 'Lets an app\'s delivery identity create or update a Container App in this Container Apps environment. Read + join only (ADR-0021).'
    type: 'CustomRole'
    permissions: [
      {
        actions: appEnvironmentJoinerActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: assignableScopes
  }
}

resource platformJobSecretWriter 'Microsoft.Authorization/roleDefinitions@2022-04-01' = {
  name: customRoleDefinitionGuid(tenant().tenantId, prefix, 'platform-job-secret-writer')
  properties: {
    roleName: platformJobSecretWriterRoleName(prefix)
    description: 'Entra provisioning identity on one kvset platform job: set the one-time job secret, start the job, read its executions. Assigned only at kvset job scope; not in the provisioning identity\'s role set (ADR-0035).'
    type: 'CustomRole'
    permissions: [
      {
        actions: platformJobSecretWriterActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: assignableScopes
  }
}

output appDeployerRoleDefinitionGuid string = appDeployer.name
output appEnvironmentJoinerRoleDefinitionGuid string = appEnvironmentJoiner.name
output platformJobSecretWriterRoleDefinitionGuid string = platformJobSecretWriter.name
