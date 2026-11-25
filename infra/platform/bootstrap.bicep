// Platform identities bootstrap of ONE environment subscription (ADR-0031), subscription scope.
// Run by a HUMAN with Owner on that subscription, once per environment subscription: what-if
// first, then create (infra/README.md). No pipeline can run it: it creates the identities the
// pipelines log in with, and grants a constrained role-assignment right that only an Owner can
// grant.
//
// Creates:
//   identities RG       rg-{prefix}-identities-{env}
//   every subscription  provisioning identity id-{prefix}-provisioning-{env} with, at this
//                       subscription: Contributor, and Role Based Access Control Administrator
//                       with an ABAC condition that allows role assignment writes and deletes
//                       only for the platform's own roles (types.builtInRoles + the two
//                       delivery roles of roles.bicep), plus three roles limited to one
//                       principal each (ADR-0043: the platform pipeline deploys environment.bicep
//                       with this identity): Log Analytics Reader and Cost Management Reader
//                       (types.platformEnvironmentRoles) only to id-{prefix}-portal, Platform Job
//                       Secret Writer only to id-{prefix}-entra-provisioning, and Container
//                       Registry Repository Contributor (types.registryPurgeRole) only to itself
//                       (ADR-0059: landing zones give it that role on each build-environment
//                       registry, to purge old images). Never Owner, User Access Administrator,
//                       RBAC Administrator itself or Entra Deployment Operator.
//   portal host only    (instanceIdentities = true)
//                       - ADO automation identity id-{prefix}-ado-automation, Reader on the
//                         identities RG only
//                       - Entra provisioning identity id-{prefix}-entra-provisioning (ADR-0023,
//                         ADR-0033) and the empty resource groups its Graph Bicep deployments run
//                         in: the instance's rg-{prefix}-entra (entra-permissions, entra-portal-{env}
//                         and the app records deployed before ADR-0063) and one records group
//                         rg-{prefix}-entra-{env} per environment of entraEnvironments (ADR-0063:
//                         ARM keeps at most 800 deployments per resource group); custom role Entra
//                         Deployment Operator ({prefix}) (Microsoft.Resources/deployments/* and
//                         resource group read, assignable only at these groups), assigned to that
//                         identity at each of them and nowhere else. Not in the provisioning
//                         identity's role set: it can never assign it. Its Microsoft Graph
//                         application permissions are a separate step by the tenant's identity
//                         team (entra-permissions.bicep).
//                       - Portal runtime identity id-{prefix}-portal (ADR-0036), no role and no
//                         federated credential here: its one Azure role (Container Registry
//                         Repository Reader on the host environment's platform registry) is
//                         assigned by portal.bicep, its Azure DevOps Read on platform-config by
//                         `platform ado bootstrap`. Further roles arrive with the features that
//                         need them (US10.18), the OBO federated credential with the first OBO
//                         feature (ADR-0014).
//   with federation     federated credentials named like their service connection
//                       (sc-platform-provisioning-{env}, sc-platform-ado, sc-platform-entra)
//   last                ReadOnly lock lock-{prefix}-identities-readonly on the identities RG
//
// Two passes:
//   1. federation = {}: identities, roles and lock. Their client IDs go into the platform
//      service connections (`platform ado bootstrap apply --phase connections`), which return
//      issuer and subject.
//   2. federation with issuer/subject (provisioning; in the portal host subscription also
//      adoAutomation and entra): DELETE THE LOCK FIRST (it blocks every write in the RG,
//      including the federated credentials); this template re-creates it at the end.
// Any later re-run (e.g. a core version that adds an identity, such as id-{prefix}-portal) is the
// same: delete the lock, run with the current federation, the template re-creates the lock.
// The lock means no automation identity can add a federated credential to a platform identity
// (Contributor cannot delete locks). Verify in sandbox: PROV-2.
// Verify in sandbox: ENT-11 (Entra Deployment Operator is enough for the Graph Bicep deployments).
// A re-run that adds the environments' groups widens the role's assignable scopes, assigns it at each
// new group in the same deployment and keeps its assignment on rg-{prefix}-entra; it succeeded on the
// first create in the sandbox (ENT-14, 2026-11-16).
// A role definition at subscription scope with only a resource group as assignable scope, assigned
// in the same deployment, worked on the first create in the sandbox (2026-10-29); if replication
// ever delays it (RoleDefinitionDoesNotExist), run the deployment again.

targetScope = 'subscription'

import {
  customRoleDefinitionGuid as nameCustomRoleDefinitionGuid
  entraDeploymentOperatorRoleName as nameEntraDeploymentOperatorRoleName
  entraEnvironmentResourceGroup as nameEntraEnvironmentResourceGroup
  entraResourceGroup as nameEntraResourceGroup
  identitiesLock as nameIdentitiesLock
  identitiesResourceGroup as nameIdentitiesResourceGroup
  instanceIdentity as nameInstanceIdentity
  instanceServiceConnection as nameInstanceServiceConnection
  provisioningIdentity as nameProvisioningIdentity
  provisioningServiceConnection as nameProvisioningServiceConnection
} from '../modules/naming/naming.bicep'
import {
  builtInRoles
  platformEnvironmentRoles
  registryPurgeRole
} from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (no defaults: a missing value fails loudly)
// ------------------------------------------------------------------------------------------

@description('Instance prefix (naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('environments[].name of the environment this subscription hosts.')
@minLength(2)
@maxLength(8)
param environmentName string

@description('Azure region of the identities RG and identities: environments[].region, else defaultRegion.')
param location string

@description('true only in the portal host environment\'s subscription: also creates the instance identities (id-{prefix}-ado-automation, id-{prefix}-entra-provisioning, id-{prefix}-portal), rg-{prefix}-entra and the Entra records groups of entraEnvironments.')
param instanceIdentities bool

@description('environments[].name of EVERY environment of the instance (instance.yaml, list order) with instanceIdentities: one Entra records group rg-{prefix}-entra-{env} each, where the stage entra deploys entra-{slug}-{env} (ADR-0063); it must include environmentName. [] outside the portal host subscription. A new environment needs a re-run of this bootstrap in the portal host subscription.')
param entraEnvironments string[]

@description('Issuer and subject of the platform service connections, read back from Azure DevOps (pass 2). {} on pass 1. adoAutomation and entra only with instanceIdentities.')
param federation {
  provisioning: federationConfig?
  adoAutomation: federationConfig?
  entra: federationConfig?
}

@description('Principal (object) IDs of the two instance identities whose platform roles carry a principal limit (ADR-0043): id-{prefix}-portal (Log Analytics Reader, Cost Management Reader) and id-{prefix}-entra-provisioning (Platform Job Secret Writer). Outside the portal host subscription: the host bootstrap outputs portalIdentity.principalId and entraProvisioningIdentity.principalId. In the portal host subscription (instanceIdentities = true) pass {}: this deployment creates both identities and uses their principals.')
param instancePrincipals {
  portal: string?
  entraProvisioning: string?
}

@description('Value of the ManagedBy tag (e.g. the instance productName).')
param managedBy string

@description('Additional tags for every resource (e.g. CostCenter).')
param tags object

@description('Issuer and subject of a workload identity federation (an Azure DevOps service connection).')
type federationConfig = {
  issuer: string
  subject: string
}

// ------------------------------------------------------------------------------------------
// Derived values and input validation
// ------------------------------------------------------------------------------------------

var federations = filter([federation.?provisioning, federation.?adoAutomation, federation.?entra], f => f != null)

func isGuid(value string) bool =>
  length(value) == 36 && empty(filter(
    range(0, min(length(value), 36)),
    i => contains([8, 13, 18, 23], i) ? substring(toLower(value), i, 1) != '-' : !contains('0123456789abcdef', substring(toLower(value), i, 1))
  ))

var inputErrors = filter(
  [
    federation.?adoAutomation != null && !instanceIdentities
      ? 'federation.adoAutomation needs instanceIdentities = true (the ADO automation identity exists only in the portal host environment\'s subscription).'
      : ''
    federation.?entra != null && !instanceIdentities
      ? 'federation.entra needs instanceIdentities = true (the Entra provisioning identity exists only in the portal host environment\'s subscription).'
      : ''
    length(filter(federations, f => !startsWith(f!.issuer, 'https://'))) > 0
      ? 'federation issuers must be https:// URLs.'
      : ''
    length(filter(federations, f => empty(trim(f!.subject)))) > 0 ? 'federation subjects must not be empty.' : ''
    instanceIdentities && (instancePrincipals.?portal != null || instancePrincipals.?entraProvisioning != null)
      ? 'instancePrincipals must be {} in the portal host subscription (instanceIdentities = true): this deployment creates id-{prefix}-portal and id-{prefix}-entra-provisioning and uses their principals.'
      : ''
    !instanceIdentities && (!isGuid(instancePrincipals.?portal ?? '') || !isGuid(instancePrincipals.?entraProvisioning ?? ''))
      ? 'instancePrincipals needs portal and entraProvisioning as GUIDs outside the portal host subscription: the host bootstrap outputs portalIdentity.principalId and entraProvisioningIdentity.principalId.'
      : ''
    instanceIdentities && !contains(entraEnvironments, environmentName)
      ? 'entraEnvironments must list every environment of the instance in the portal host subscription (instanceIdentities = true), environmentName included: each gets its Entra records group rg-{prefix}-entra-{env} (ADR-0063).'
      : ''
    !instanceIdentities && !empty(entraEnvironments)
      ? 'entraEnvironments must be [] outside the portal host subscription: the Entra records groups live in the portal host environment\'s subscription (ADR-0063).'
      : ''
    length(union(entraEnvironments, [])) != length(entraEnvironments) ? 'entraEnvironments lists an environment twice.' : ''
  ],
  message => !empty(message)
)

var identitiesRgName = empty(inputErrors)
  ? nameIdentitiesResourceGroup(prefix, environmentName)
  : fail('bootstrap.bicep: ${join(inputErrors, ' ')}')

var provisioningIdentityName = nameProvisioningIdentity(prefix, environmentName)
var adoAutomationIdentityName = nameInstanceIdentity(prefix, 'ado-automation')
var entraProvisioningIdentityName = nameInstanceIdentity(prefix, 'entra-provisioning')
var portalIdentityName = nameInstanceIdentity(prefix, 'portal')
var entraRgName = nameEntraResourceGroup(prefix)
// ADR-0063: one Entra records group per environment, in this (the portal host) subscription.
var entraEnvironmentRgNames = map(entraEnvironments, env => nameEntraEnvironmentResourceGroup(prefix, env))
var entraEnvironmentRgIds = map(entraEnvironmentRgNames, name => subscriptionResourceId('Microsoft.Resources/resourceGroups', name))
var provisioningIdentityId = resourceId(
  subscription().subscriptionId,
  identitiesRgName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  provisioningIdentityName
)
var entraProvisioningIdentityId = resourceId(
  subscription().subscriptionId,
  identitiesRgName,
  'Microsoft.ManagedIdentity/userAssignedIdentities',
  entraProvisioningIdentityName
)

var commonTags = union(tags, {
  Environment: environmentName
  ManagedBy: managedBy
})

// The platform's role set: the ONLY roles the provisioning identity may assign or remove.
// Single source: types.builtInRoles plus the two delivery custom roles (GUIDs as in roles.bicep
// and landing-zone.bicep), for any principal; plus the limited roles below, each for one
// principal only (ADR-0043). Anything else a template assigns fails at deployment (check-infra.py
// asserts every role an infra/app or infra/platform template assigns is in this set).
// Deliberately NOT in this set: Entra Deployment Operator (only bootstrap.bicep assigns it).
var platformRoleGuids = concat(map(items(builtInRoles), role => role.value), [
  nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-deployer')
  nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-environment-joiner')
])
var platformRoleGuidList = join(platformRoleGuids, ', ')

// Limited roles (ADR-0043), assigned by environment.bicep: the portal's two readers only to the
// portal identity, Platform Job Secret Writer (ADR-0035, on each kvset job) only to the Entra
// provisioning identity. In the portal host subscription this deployment creates both identities
// (module outputs, known at deployment time); elsewhere they come from instancePrincipals.
var portalRoleGuidList = join([platformEnvironmentRoles.logAnalyticsReader, platformEnvironmentRoles.costManagementReader], ', ')
var jobSecretWriterRoleGuid = nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'platform-job-secret-writer')
var portalPrincipal = instanceIdentities ? identities.outputs.?portalPrincipalId ?? '' : instancePrincipals.?portal ?? ''
var entraPrincipal = instanceIdentities
  ? identities.outputs.?entraProvisioningPrincipalId ?? ''
  : instancePrincipals.?entraProvisioning ?? ''
// ADR-0059: the registry purge role, for the provisioning identity itself only (landing zones assign it
// to their deployer on the app's build-environment registry), never to a delivery or any other identity.
var provisioningPrincipal = identities.outputs.provisioningPrincipalId

// "Constrain roles" and "Constrain roles and principals" (Microsoft Learn,
// delegate-role-assignments-examples): writes are checked on the requested role and principal
// (@Request), deletes on the existing assignment's (@Resource). One clause per action: another
// action, or a platform role, or a limited role for its one principal.
// Verify in sandbox: PLAT-5 (the combined clauses are accepted; a limited role for any other
// principal is refused), REG-1 (the registry purge role for the identity itself).
var rbacWriteClause = '(!(ActionMatches{\'Microsoft.Authorization/roleAssignments/write\'})) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${platformRoleGuidList}}) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${portalRoleGuidList}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${portalPrincipal}}) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${jobSecretWriterRoleGuid}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${entraPrincipal}}) OR (@Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${registryPurgeRole}} AND @Request[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${provisioningPrincipal}})'
var rbacDeleteClause = '(!(ActionMatches{\'Microsoft.Authorization/roleAssignments/delete\'})) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${platformRoleGuidList}}) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${portalRoleGuidList}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${portalPrincipal}}) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${jobSecretWriterRoleGuid}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${entraPrincipal}}) OR (@Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals {${registryPurgeRole}} AND @Resource[Microsoft.Authorization/roleAssignments:PrincipalId] ForAnyOfAnyValues:GuidEquals {${provisioningPrincipal}})'
var rbacAdministratorCondition = '(${rbacWriteClause}) AND (${rbacDeleteClause})'

var contributorRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', builtInRoles.contributor)
// Role Based Access Control Administrator (built-in). Deliberately NOT in types.builtInRoles:
// that list is the set the provisioning identity may assign, and it must never assign this role.
var rbacAdministratorRoleId = subscriptionResourceId(
  'Microsoft.Authorization/roleDefinitions',
  'f58310d9-a9f6-439a-9e8d-f62e7b41a168'
)

// Entra Deployment Operator: exactly what a Graph Bicep deployment and its record need, nothing
// else (asserted in infra/tests/check-infra.py).
var entraDeploymentOperatorActions = [
  'Microsoft.Resources/deployments/*'
  'Microsoft.Resources/subscriptions/resourceGroups/read'
]

// ------------------------------------------------------------------------------------------
// Resources
// ------------------------------------------------------------------------------------------

resource identitiesRg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: identitiesRgName
  location: location
  tags: commonTags
}

module identities 'bootstrap-identities.bicep' = {
  scope: identitiesRg
  params: {
    location: location
    provisioning: {
      identityName: provisioningIdentityName
      federatedCredentialName: nameProvisioningServiceConnection(environmentName)
      federation: federation.?provisioning
    }
    adoAutomation: instanceIdentities
      ? {
          identityName: adoAutomationIdentityName
          federatedCredentialName: nameInstanceServiceConnection('ado')
          federation: federation.?adoAutomation
        }
      : null
    entraProvisioning: instanceIdentities
      ? {
          identityName: entraProvisioningIdentityName
          federatedCredentialName: nameInstanceServiceConnection('entra')
          federation: federation.?entra
        }
      : null
    // No federated credential and no role here (ADR-0036): see the header.
    portalIdentityName: instanceIdentities ? portalIdentityName : null
    readerRoleGuid: builtInRoles.reader
    lockName: nameIdentitiesLock(prefix)
    tags: commonTags
  }
}

resource provisioningContributor 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, provisioningIdentityId, contributorRoleId)
  properties: {
    principalId: identities.outputs.provisioningPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: contributorRoleId
    description: 'Azure provisioning identity of ${environmentName}: platform environment, landing zones and releases in this subscription (ADR-0031). Cannot delete locks.'
  }
}

resource provisioningRbacAdministrator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(subscription().id, provisioningIdentityId, rbacAdministratorRoleId)
  properties: {
    principalId: identities.outputs.provisioningPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: rbacAdministratorRoleId
    description: 'Azure provisioning identity of ${environmentName}: assign and remove the platform\'s own roles only, the portal readers, Platform Job Secret Writer and the registry purge role for their one principal only (ABAC condition, ADR-0031, ADR-0043, ADR-0059). Never Owner, User Access Administrator or RBAC Administrator.'
    condition: rbacAdministratorCondition
    conditionVersion: '2.0'
  }
}

// ------------------------------------------------------------------------------------------
// Entra deployments (portal host only, ADR-0033, ADR-0063): empty resource groups (the instance's
// and one per environment), a custom role assignable only there, assigned only to the Entra
// provisioning identity, at each of them
// ------------------------------------------------------------------------------------------

resource entraRg 'Microsoft.Resources/resourceGroups@2025-04-01' = if (instanceIdentities) {
  name: entraRgName
  location: location
  tags: commonTags
}

// The records of one environment's app registrations (ADR-0063): ARM keeps at most 800 deployments
// per resource group, and rg-{prefix}-entra held one per app and environment.
resource entraEnvironmentRgs 'Microsoft.Resources/resourceGroups@2025-04-01' = [
  for (env, i) in entraEnvironments: if (instanceIdentities) {
    name: entraEnvironmentRgNames[i]
    location: location
    tags: union(commonTags, {
      Environment: env
    })
  }
]

resource entraDeploymentOperator 'Microsoft.Authorization/roleDefinitions@2022-04-01' = if (instanceIdentities) {
  name: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'entra-deployment-operator')
  // The environments' groups must exist before they can be assignable scopes.
  dependsOn: [
    entraEnvironmentRgs
  ]
  properties: {
    roleName: nameEntraDeploymentOperatorRoleName(prefix)
    description: 'Entra provisioning identity: ARM deployments of the Entra app registrations (Graph Bicep) in ${entraRgName} and the environments\' Entra records groups ${join(entraEnvironmentRgNames, ', ')} only. Assignable only there (ADR-0033, ADR-0063).'
    type: 'CustomRole'
    permissions: [
      {
        actions: entraDeploymentOperatorActions
        notActions: []
        dataActions: []
        notDataActions: []
      }
    ]
    assignableScopes: concat([entraRg.id], entraEnvironmentRgIds)
  }
}

module entraRoles 'bootstrap-entra.bicep' = if (instanceIdentities) {
  scope: entraRg
  params: {
    principalId: identities.outputs.?entraProvisioningPrincipalId ?? ''
    principalResourceId: entraProvisioningIdentityId
    roleDefinitionId: entraDeploymentOperator.id
  }
}

// The same role at each environment's records group (ADR-0063). The nested deployment's name never
// starts with entra-, so the plan never reads it as an app's record entra-{slug}-{env}.
module entraEnvironmentRoles 'bootstrap-entra.bicep' = [
  for (env, i) in entraEnvironments: if (instanceIdentities) {
    name: 'bootstrap-entra-operator-${env}'
    scope: entraEnvironmentRgs[i]
    params: {
      principalId: identities.outputs.?entraProvisioningPrincipalId ?? ''
      principalResourceId: entraProvisioningIdentityId
      roleDefinitionId: entraDeploymentOperator.id
    }
  }
]

// ------------------------------------------------------------------------------------------
// Outputs: client IDs go into the platform service connections (platform ado bootstrap)
// ------------------------------------------------------------------------------------------

@description('Platform identity: name, client ID (service connection) and principal (object) ID.')
type identityInfo = {
  name: string
  clientId: string
  principalId: string
}

output identitiesResourceGroup string = identitiesRg.name

output provisioningIdentity identityInfo = {
  name: provisioningIdentityName
  clientId: identities.outputs.provisioningClientId
  principalId: identities.outputs.provisioningPrincipalId
}

@description('Null unless instanceIdentities.')
output adoAutomationIdentity identityInfo? = instanceIdentities
  ? {
      name: adoAutomationIdentityName
      clientId: identities.outputs.?adoAutomationClientId ?? ''
      principalId: identities.outputs.?adoAutomationPrincipalId ?? ''
    }
  : null

@description('Null unless instanceIdentities. Its principalId is the input of entra-permissions.bicep (Microsoft Graph application permissions, granted by the identity team).')
output entraProvisioningIdentity identityInfo? = instanceIdentities
  ? {
      name: entraProvisioningIdentityName
      clientId: identities.outputs.?entraProvisioningClientId ?? ''
      principalId: identities.outputs.?entraProvisioningPrincipalId ?? ''
    }
  : null

@description('Null unless instanceIdentities. The portal runtime identity (portal.bicep, ADR-0036): an organisation administrator adds it to Azure DevOps by this principal before `platform ado bootstrap` grants it Read on platform-config.')
output portalIdentity identityInfo? = instanceIdentities
  ? {
      name: portalIdentityName
      clientId: identities.outputs.?portalClientId ?? ''
      principalId: identities.outputs.?portalPrincipalId ?? ''
    }
  : null

@description('The instance\'s resource group of Entra deployments (entra-permissions, entra-portal-{env}, the app records deployed before ADR-0063); null unless instanceIdentities.')
output entraResourceGroup string? = instanceIdentities ? entraRgName : null

@description('The Entra records group of each environment, { <env>: rg-{prefix}-entra-{env} } (ADR-0063); null unless instanceIdentities.')
output entraEnvironmentResourceGroups object? = instanceIdentities
  ? toObject(range(0, length(entraEnvironments)), i => entraEnvironments[i], i => entraEnvironmentRgNames[i])
  : null

output tenantId string = tenant().tenantId
output subscriptionId string = subscription().subscriptionId
