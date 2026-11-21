// Entra app registration of the portal (ADR-0036): ONE registration for the SPA and its API, once
// per instance, in the portal host environment (portal.hostEnvironment). Microsoft Graph Bicep v1.0
// (GA).
//
// Who and when: a HUMAN with Cloud Application Administrator or Application Administrator in the
// tenant (creates the registration, its service principal and its federated credential, assigns
// the two platform groups to it, grants tenant-wide consent for delegated permissions, including
// the admin consent GroupMember.Read.All needs) who may also create deployments in
// rg-{prefix}-entra (Azure: Contributor or Owner there, or the Entra Deployment Operator role),
// until the platform pipeline exists (US03.09). Running it IS the tenant's admin consent for the
// Graph scopes below (ADR-0040) and for Azure Key Vault user_impersonation (ADR-0025): review them
// before the first run and after a core upgrade that changes them. Run after the bootstrap of the portal host environment (portalIdentityPrincipalId
// = its output portalIdentity.principalId) and before portal.bicep pass 2 (parameter portalClientId =
// output clientId here). portalHostName is the portal's public host name (ADR-0071): its own host name
// through Front Door, known from instance.yaml before any portal deployment, or else the Container App's
// address ca-{prefix}-portal.{CAE default domain} (portal.bicep pass 1 output portalFqdn). Deployment name entra-portal-{env}, into
// rg-{prefix}-entra:
//   az deployment group validate -g rg-{prefix}-entra -n entra-portal-{env} -p <file>.bicepparam
//   az deployment group create   -g rg-{prefix}-entra -n entra-portal-{env} -p <file>.bicepparam
// Re-run it when platformAdmins or approvals.platformTeam change: the assignments below are what
// the groups claim lists.
//
// - application: uniqueName {prefix}-portal-{env} (immutable idempotency key; no app can collide,
//   the slug `portal` is reserved), single tenant.
//   - SPA platform only (authorization code with PKCE; no web platform, no implicit grant):
//     https://{portalHostName}/ and, only on a non-prod host environment, localhost URIs for portal
//     development. One public address only: behind Front Door the Container App's own address takes no
//     traffic from browsers (ADR-0071).
//   - API: delegated scope access_as_user (id derived from uniqueName, stable), v2 access tokens
//     (aud = client ID), identifier URI api://{appId}. The appId exists only after the application
//     is created, so the identifier URI is set by a second declaration of the same application
//     (uniqueName) in portal-registration-uri.bicep, which repeats every property.
//   - groupMembershipClaims ApplicationGroup: the groups claim lists only the groups assigned
//     below that the user is in, never all of the user's groups (no overage).
//   - Delegated Microsoft Graph permissions (IDs from the Graph permissions reference,
//     https://learn.microsoft.com/en-us/graph/permissions-reference):
//     - openid, profile and offline_access: the scopes MSAL requests at every sign-in. No
//       User.Read: name, preferred_username and oid come in the ID token with `profile`.
//     - User.Read.All and GroupMember.Read.All (ADR-0040): the portal API's people and group
//       search, on behalf of the signed-in user (OBO), with that user's rights. Both need admin
//       consent (the grant below). User.Read.All, not User.ReadBasic.All: the members-only search
//       filters and reads userType, which the basic profile doesn't include (Graph answers 403,
//       PORTAL-12).
//   - Delegated Azure Key Vault permission user_impersonation (ADR-0025): the portal API writes
//     secret values to app vaults on behalf of the signed-in owner or deputy (OBO). Key Vault RBAC
//     authorizes the user in the token, so the portal can do exactly what that user's own Key Vault
//     role allows (Key Vault Secrets Officer on their app's vault), nothing more; the portal
//     identity holds no data-plane role. OBO can't prompt, so it needs the admin consent below.
//     IDs: the Azure Key Vault application cfa8b339-82a2-471a-a3c9-0fc0be7a4093 (Microsoft Learn,
//     Az.KeyVault Add-AzKeyVaultManagedStorageAccount: its service principal) and its scope
//     user_impersonation f53da476-18e3-4152-8e01-aec403e6edc0, read from that service principal's
//     oauth2PermissionScopes in the sandbox tenant on 2026-10-31 (`az ad sp show --id cfa8b339-…`).
//   - No password and no key credential: the SPA is a public client. The API's client credential
//     for OBO is one federated identity credential `portal-obo` (ADR-0014, ADR-0040): the managed
//     identity id-{prefix}-portal, so the portal holds no secret. As documented in "Configure an
//     application to trust a managed identity"
//     (https://learn.microsoft.com/en-us/entra/workload-id/workload-identity-federation-config-app-trust-managed-identity):
//     issuer https://login.microsoftonline.com/{tenantId}/v2.0 (the identity and the application
//     must be in the same tenant), subject the identity's object (principal) ID, never its client
//     ID, audience api://AzureADTokenExchange (the Microsoft Entra ID global service; the US
//     Government and China clouds use other audiences, not supported by this core version). Wrong
//     values are accepted at creation and fail only at the token exchange. Its name follows that
//     article's Bicep sample, {uniqueName}/{credential name}.
// - service principal with appRoleAssignmentRequired FALSE: every user of the tenant can sign in;
//   what they see comes from the roles (instance.yaml groups, app definitions), checked by the API
//   on every call.
// - appRoleAssignedTo: platformAdmins and approvals.platformTeam on the default role
//   00000000-0000-0000-0000-000000000000 (the application defines no app roles), always on THIS
//   service principal.
// - oauth2PermissionGrants (AllPrincipals), so no user sees a consent prompt: openid profile
//   offline_access User.Read.All GroupMember.Read.All on Microsoft Graph, user_impersonation on
//   Azure Key Vault, and access_as_user on the portal's own API. Nothing else.
//
// Not declarative: removing a group assignment (delete it by hand), removing a scope (isEnabled
// false first, then remove), deleting the registration. Graph resources have no what-if:
// `validate` and the reviewed parameter file are the preview.
// Verify in sandbox: PORTAL-2 (registration, sign-in, groups claim), PORTAL-12 (the federated
// credential created by Graph Bicep with that name format and left alone by the second
// declaration, OBO with it, people and group search as a user), KV-1 (OBO to Key Vault with the
// grant below; the Azure Key Vault service principal exists in the tenant).

extension microsoftGraphV1

import {
  entraApplicationDisplayName as nameEntraApplicationDisplayName
  instanceIdentity as nameInstanceIdentity
  portalContainerApp as namePortalContainerApp
  portalEntraApplicationUniqueName as namePortalEntraApplicationUniqueName
  portalManagedEnvironment as namePortalManagedEnvironment
} from '../modules/naming/naming.bicep'
import {
  environmentKind as environmentKindType
} from '../modules/types.bicep'

@minLength(2)
@maxLength(8)
param prefix string

@description('The portal host environment (instance.yaml portal.hostEnvironment).')
@minLength(2)
@maxLength(8)
param environmentName string

@description('Kind of the portal host environment. Localhost redirect URIs are allowed only on nonprod.')
param environmentKind environmentKindType

@description('instance.yaml productName: the display name is "{productName} portal" (plus " ({env})" on a non-prod host).')
@minLength(1)
param productName string

@description('The portal\'s public host name (portal.bicep output portalHostName, ADR-0071): its own host name through Front Door, else ca-{prefix}-portal.{CAE default domain}. Host name only, lowercase, no scheme, port or path.')
@minLength(1)
param portalHostName string

@description('Extra SPA redirect URIs for portal development, e.g. http://localhost:5173/. Only http://localhost:{port}/ URIs, and only when environmentKind is nonprod; [] otherwise.')
param devRedirectUris string[]

@description('instance.yaml platformAdmins.objectId (Entra group).')
param platformAdminsGroupId string

@description('instance.yaml approvals.platformTeam.objectId (Entra group). May equal platformAdminsGroupId.')
param platformTeamGroupId string

@description('Entra tenant ID (instance.yaml tenantId). Must be the tenant of this deployment: the issuer of the portal identity\'s tokens in the federated credential.')
param tenantId string

@description('Principal (object) ID of id-{prefix}-portal (bootstrap output portalIdentity.principalId of the portal host environment), not its client ID: the subject of the OBO federated credential.')
param portalIdentityPrincipalId string

// Microsoft Graph and its delegated permissions (Graph permissions reference): the OIDC scopes MSAL
// requests at sign-in, and the two the portal API uses on behalf of the user (ADR-0040).
var graphAppId = '00000003-0000-0000-c000-000000000000'
var graphScopes = [
  {
    value: 'openid'
    id: '37f7f235-527c-4136-accd-4a02d197296e'
  }
  {
    value: 'profile'
    id: '14dad69e-099b-42c9-810b-d002981feec1'
  }
  {
    value: 'offline_access'
    id: '7427e0e9-2fba-42fe-b0c0-848c9e6a8182'
  }
  {
    value: 'User.Read.All' // people search: profiles including userType (members only); admin consent
    id: 'a154be20-db9c-4678-8ab7-66f6cc099a59'
  }
  {
    value: 'GroupMember.Read.All' // group search: groups and their members the user can see; admin consent
    id: 'bc024368-1153-4739-b217-4326f2e966d0'
  }
]

// Azure Key Vault and its one delegated permission (ADR-0025): secret writes on behalf of the user.
var keyVaultAppId = 'cfa8b339-82a2-471a-a3c9-0fc0be7a4093'
var keyVaultScope = {
  value: 'user_impersonation'
  id: 'f53da476-18e3-4152-8e01-aec403e6edc0' // user_impersonation (see the header)
}

// The OBO client credential: id-{prefix}-portal as federated identity credential (ADR-0040).
var oboCredentialName = 'portal-obo'
var tokenExchangeAudience = 'api://AzureADTokenExchange'
var portalIdentityName = nameInstanceIdentity(prefix, 'portal')

// The default app role: assignment without an app role (the application defines none).
var defaultAppRoleId = '00000000-0000-0000-0000-000000000000'
var apiScopeValue = 'access_as_user'

func isGuid(value string) bool =>
  length(value) == 36 && empty(filter(
    range(0, min(length(value), 36)),
    i => contains([8, 13, 18, 23], i) ? substring(toLower(value), i, 1) != '-' : !contains('0123456789abcdef', substring(toLower(value), i, 1))
  ))

var inputErrors = filter(
  [
    contains(portalHostName, '*') || contains(portalHostName, '/') || contains(portalHostName, ':') || portalHostName != toLower(portalHostName) || length(split(portalHostName, '.')) < 3
      ? 'portalHostName must be a plain lowercase host name with at least three labels: no wildcard, scheme, port or path.'
      : ''
    length(filter(devRedirectUris, u => !startsWith(toLower(u), 'http://localhost:') || !endsWith(u, '/') || contains(u, '*'))) > 0
      ? 'devRedirectUris must be http://localhost:{port}/ URIs.'
      : ''
    !empty(devRedirectUris) && environmentKind != 'nonprod'
      ? 'devRedirectUris are allowed only when the portal host environment is of kind nonprod.'
      : ''
    !isGuid(platformAdminsGroupId) || !isGuid(platformTeamGroupId)
      ? 'platformAdminsGroupId and platformTeamGroupId must be GUIDs (Entra group object IDs).'
      : ''
    !isGuid(tenantId) || toLower(tenantId) != toLower(tenant().tenantId)
      ? 'tenantId "${tenantId}" is not the tenant of this deployment (${tenant().tenantId}).'
      : ''
    !isGuid(portalIdentityPrincipalId)
      ? 'portalIdentityPrincipalId must be a GUID: the principal (object) ID of ${portalIdentityName}.'
      : ''
  ],
  message => !empty(message)
)
// naming.portalEntraApplicationUniqueName (the per-app entraApplicationUniqueName rejects the reserved slug `portal`).
var uniqueName = empty(inputErrors)
  ? namePortalEntraApplicationUniqueName(prefix, environmentName)
  : fail('portal-registration.bicep: ${join(inputErrors, ' ')}')

// Both platform groups, once each (a small instance may use one group for both).
var assignedGroups = union([toLower(platformAdminsGroupId)], [toLower(platformTeamGroupId)])

// Every property of the application except identifierUris, shared with the second declaration.
var settings = {
  displayName: nameEntraApplicationDisplayName('${productName} portal', environmentName, environmentKind)
  // The naming functions also validate prefix and environment name.
  notes: 'Portal of the ${productName} instance ${prefix}: ${namePortalContainerApp(prefix)} in ${namePortalManagedEnvironment(prefix, environmentName)} (ADR-0036). Managed by infra/entra/portal-registration.bicep; change it there.'
  signInAudience: 'AzureADMyOrg'
  groupMembershipClaims: 'ApplicationGroup'
  isFallbackPublicClient: false
  spa: {
    redirectUris: union(['https://${portalHostName}/'], devRedirectUris)
  }
  api: {
    requestedAccessTokenVersion: 2
    oauth2PermissionScopes: [
      {
        id: guid(uniqueName, 'oauth2PermissionScope', apiScopeValue)
        value: apiScopeValue
        type: 'User'
        isEnabled: true
        adminConsentDisplayName: 'Use the portal'
        adminConsentDescription: 'Lets the portal\'s web app call the portal API as the signed-in user.'
        userConsentDisplayName: 'Use the portal'
        userConsentDescription: 'Lets the portal\'s web app call the portal API as you.'
      }
    ]
  }
  requiredResourceAccess: [
    {
      resourceAppId: graphAppId
      resourceAccess: map(graphScopes, s => {
        id: s.id
        type: 'Scope'
      })
    }
    {
      resourceAppId: keyVaultAppId
      resourceAccess: [
        {
          id: keyVaultScope.id
          type: 'Scope'
        }
      ]
    }
  ]
}

resource application 'Microsoft.Graph/applications@v1.0' = {
  uniqueName: uniqueName
  displayName: settings.displayName
  notes: settings.notes
  signInAudience: settings.signInAudience
  groupMembershipClaims: settings.groupMembershipClaims
  isFallbackPublicClient: settings.isFallbackPublicClient
  spa: settings.spa
  api: settings.api
  requiredResourceAccess: settings.requiredResourceAccess

  // The OBO client credential: tokens of id-{prefix}-portal for api://AzureADTokenExchange are the
  // client assertion of this application. A separate Graph object, so the second declaration
  // (portal-registration-uri.bicep) doesn't repeat it; created after it, not concurrently.
  resource oboCredential 'federatedIdentityCredentials@v1.0' = {
    name: '${uniqueName}/${oboCredentialName}'
    description: 'OBO client credential of the portal API: the managed identity ${portalIdentityName} (ADR-0040). Managed by infra/entra/portal-registration.bicep.'
    issuer: '${environment().authentication.loginEndpoint}${toLower(tenantId)}/v2.0'
    // The object (principal) ID, matched case-sensitively with the token's sub claim (Learn); the
    // bootstrap outputs it in lower case. Verify in sandbox: PORTAL-12.
    subject: toLower(portalIdentityPrincipalId)
    audiences: [
      tokenExchangeAudience
    ]
    dependsOn: [
      identifierUri
    ]
  }
}

// identifierUris api://{appId}: the same application again, now that its appId is known.
module identifierUri 'portal-registration-uri.bicep' = {
  name: '${deployment().name}-uri'
  params: {
    uniqueName: uniqueName
    appId: application.appId
    settings: settings
  }
}

resource servicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' = {
  appId: application.appId
  appRoleAssignmentRequired: false
}

resource graphServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: graphAppId
}

// Consent for the Graph scopes, Key Vault user_impersonation and the portal's own API scope, granted
// once for all users: the tenant's admin consent for GroupMember.Read.All (ADR-0040) and for Key
// Vault (ADR-0025). Nothing else is ever granted here: no other scope, no other resource, no other
// client.
resource graphConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: servicePrincipal.id
  consentType: 'AllPrincipals'
  resourceId: graphServicePrincipal.id
  scope: join(map(graphScopes, s => s.value), ' ')
}

resource keyVaultServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: keyVaultAppId
}

// Lets the portal act at Key Vault with each user's own Key Vault rights (OBO), never its own: an
// owner or deputy writes their app's secrets, anyone else is refused by Key Vault RBAC.
resource keyVaultConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: servicePrincipal.id
  consentType: 'AllPrincipals'
  resourceId: keyVaultServicePrincipal.id
  scope: keyVaultScope.value
}

// TODO(verify) PORTAL-2: whether a client calling its own API needs this grant at all (harmless
// if it does not).
resource apiConsent 'Microsoft.Graph/oauth2PermissionGrants@v1.0' = {
  clientId: servicePrincipal.id
  consentType: 'AllPrincipals'
  resourceId: servicePrincipal.id
  scope: apiScopeValue
}

resource groupAssignments 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [
  for groupId in assignedGroups: {
    appRoleId: defaultAppRoleId
    principalId: groupId
    resourceId: servicePrincipal.id
  }
]

@description('Client ID of the registration: portal.bicep parameter portalClientId (SAF_PORTAL_CLIENT_ID), the API audience.')
output clientId string = application.appId
output applicationObjectId string = application.id
output servicePrincipalId string = servicePrincipal.id
@description('The scope the SPA requests: api://{clientId}/access_as_user.')
output apiScope string = '${identifierUri.outputs.identifierUri}/${apiScopeValue}'
