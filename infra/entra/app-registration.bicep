// Entra app registration of one app x environment for Easy Auth (ADR-0009). Deployed by the
// Entra provisioning identity in the isolated `entra` stage (ADR-0023), deployment name
// entraDeployment(slug, env). Microsoft Graph Bicep v1.0 (GA).
//
// - application: uniqueName {prefix}-{slug}-{env}, with --i{incarnation} above incarnation 0 (immutable
//   idempotency key; ADR-0061: a new app with a deleted app's slug gets its own), single tenant,
//   redirect URIs only for the hosts the app is served on (never wildcards), ID tokens for Easy
//   Auth, app roles with ids derived from uniqueName + role value, delegated openid/profile/email
//   (what Easy Auth requests at sign-in; no Graph calls), no identifierUris.
// - service principal with appRoleAssignmentRequired, so only assigned principals sign in.
// - appRoleAssignedTo: every assignment targets THIS app's service principal (ADR-0023
//   mitigation; checked by infra/tests/check-infra.py).
// - oauth2PermissionGrant: tenant-wide consent (AllPrincipals) for exactly `openid profile email`
//   on Microsoft Graph, for THIS app's service principal only, so users can sign in without an
//   admin consent click (sandbox, 2026-10-29; ADR-0023 amendment, checked by check-infra.py).
//
// Not declarative (done by the stage around this template): the client secret (kvset job),
// deleting apps, removing assignments (`platform provisioning entra-reconcile` deletes the ones the
// previous deployment declared and app.yaml no longer lists, ADR-0033 amended 2026-11-11). A role
// dropped from app.yaml takes two deployments: first with isEnabled false (Graph refuses to remove
// an enabled app role), then without it; the entra stage runs both. Graph resources have no
// what-if: the reviewed manifest diff and the plan's "remove" lines are the preview.
// Verify in sandbox: ENT-1 to ENT-4.

extension microsoftGraphV1

import {
  entraApplicationDisplayName as nameEntraApplicationDisplayName
  entraApplicationUniqueName as nameEntraApplicationUniqueName
} from '../modules/naming/naming.bicep'
import {
  environmentKind as environmentKindType
} from '../modules/types.bicep'

@minLength(2)
@maxLength(8)
param prefix string

@minLength(2)
@maxLength(8)
param environmentName string

param environmentKind environmentKindType

@minLength(3)
@maxLength(20)
param slug string

@description('app.yaml incarnation (ADR-0061): 0 for the first app with the slug, higher for a new app with a deleted app\'s slug. Fixed for the app\'s whole life; it seeds only the uniqueName. No default: the pipeline always passes it.')
@minValue(0)
param incarnation int

@description('App title from the manifest (display name; non-prod environments get a suffix).')
@minLength(1)
param appTitle string

@description('Hosts the app is served on: the default FQDN and ACA-bound custom domains, or only the Front Door host (ADR-0009). Host names only, no scheme or path.')
@minLength(1)
param hosts string[]

@description('App roles defined in the portal (authentication.defaultAppRoles unless the app overrides them); a role app.yaml dropped is passed once with isEnabled false before it is removed.')
@minLength(1)
param appRoles {
  @description('Role claim value, e.g. Reader.')
  value: string
  displayName: string
  description: string
  @description('false only for a role being retired (first of its two deployments); default true.')
  isEnabled: bool?
}[]

@description('Principals per role: Entra groups and individual users chosen in the portal.')
param roleAssignments {
  principalId: string
  role: string
}[]

// Microsoft Graph and the delegated OIDC scopes Easy Auth requests at sign-in.
var graphAppId = '00000003-0000-0000-c000-000000000000'
var signInScopeNames = 'openid profile email'
var signInScopes = [
  '37f7f235-527c-4136-accd-4a02d197296e' // openid
  '14dad69e-099b-42c9-810b-d002981feec1' // profile
  '64a6cdd6-aab1-4aaf-94b8-3cc8405e90d0' // email
]

var roleValues = map(appRoles, r => r.value)
var disabledRoleValues = map(filter(appRoles, r => !(r.?isEnabled ?? true)), r => r.value)
var inputErrors = filter(
  [
    length(filter(hosts, h => contains(h, '*') || contains(h, '/') || contains(h, ':'))) > 0
      ? 'hosts must be plain host names: no wildcard, scheme, port or path.'
      : ''
    length(union(roleValues, [])) != length(roleValues) ? 'appRoles values must be unique.' : ''
    length(filter(roleAssignments, a => !contains(roleValues, a.role))) > 0
      ? 'roleAssignments references a role that is not in appRoles.'
      : ''
    length(filter(roleAssignments, a => contains(disabledRoleValues, a.role))) > 0
      ? 'roleAssignments references a disabled role.'
      : ''
  ],
  message => !empty(message)
)
var uniqueName = empty(inputErrors)
  ? nameEntraApplicationUniqueName(prefix, slug, environmentName, incarnation)
  : fail('app-registration.bicep: ${join(inputErrors, ' ')}')

resource application 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: uniqueName
  displayName: nameEntraApplicationDisplayName(appTitle, environmentName, environmentKind)
  signInAudience: 'AzureADMyOrg'
  web: {
    redirectUris: [for h in hosts: 'https://${toLower(h)}/.auth/login/aad/callback']
    implicitGrantSettings: {
      enableIdTokenIssuance: true
    }
  }
  appRoles: [
    for r in appRoles: {
      id: guid(uniqueName, 'appRole', r.value)
      value: r.value
      displayName: r.displayName
      description: r.description
      // 'User' lets the role be assigned to users and to groups (Microsoft Graph: "to users and groups
      // (by setting to ["User"])"); the portal's wizard and app.yaml assign it to either.
      allowedMemberTypes: [
        'User'
      ]
      isEnabled: r.?isEnabled ?? true
    }
  ]
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: [
        for id in signInScopes: {
          id: id
          type: 'Scope'
        }
      ]
    }
  ]
}

resource servicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: application.appId
  appRoleAssignmentRequired: true
}

// Consent for the sign-in scopes, granted once for all users. Nothing else is ever granted here:
// no other scope, no other resource, no other client (ADR-0023).
resource graphServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: graphAppId
}

resource signInConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: servicePrincipal.id
  consentType: 'AllPrincipals'
  resourceId: graphServicePrincipal.id
  scope: signInScopeNames
}

resource assignments 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [
  for a in roleAssignments: {
    appRoleId: guid(uniqueName, 'appRole', a.role)
    principalId: a.principalId
    resourceId: servicePrincipal.id
  }
]

@description('Client ID for release.bicep authentication.clientId.')
output clientId string = application.appId
output applicationObjectId string = application.id
output servicePrincipalId string = servicePrincipal.id
