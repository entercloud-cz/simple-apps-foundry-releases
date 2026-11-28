// Module of portal-registration.bicep only (ADR-0036): the second declaration of the portal's
// application, the same uniqueName, with identifierUris api://{appId}. An application cannot
// reference its own appId, which exists only after the first declaration has created it.
//
// Every other property is passed in unchanged from the first declaration (`settings`), so both
// declarations describe the same application and a re-run changes nothing. That includes
// requiredResourceAccess with the delegated Graph scopes of OBO (ADR-0040) and Azure Key Vault
// user_impersonation (ADR-0025). The OBO federated
// identity credential is not an application property but its own Graph object: it is declared
// once, as a child of the first declaration, after this module (Verify in sandbox: PORTAL-12, the
// credential survives this declaration).
// TODO(verify) PORTAL-2: that Graph Bicep updates the existing application by uniqueName here,
// and that oauth2PermissionScopes are accepted before identifierUris exist (first creation).

extension microsoftGraphV1

@description('uniqueName of the application created by portal-registration.bicep.')
param uniqueName string

@description('appId (client ID) of that application.')
param appId string

@description('Every property of the application except identifierUris (portal-registration.bicep var settings).')
param settings object

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
  identifierUris: [
    'api://${appId}'
  ]
}

output identifierUri string = application.identifierUris[0]
