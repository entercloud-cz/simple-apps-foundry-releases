// Entra app registration of the fictional Contoso instance's portal, host environment `prod`
// (ADR-0036). Run by a person with Cloud Application Administrator before portal.bicep pass 2:
// deployment entra-portal-prod in rg-contoso-entra, `validate` first (Graph has no what-if).
// portalHostName is the portal's own host name through Front Door (ADR-0071; without one, pass 1's
// output portalFqdn); the group IDs are instance.yaml platformAdmins.objectId and
// approvals.platformTeam.objectId; tenantId is instance.yaml tenantId; portalIdentityPrincipalId is
// the bootstrap output portalIdentity.principalId of the host environment (the subject of the OBO
// federated credential, ADR-0040). Running it grants the tenant's admin consent for the delegated
// Graph scopes, GroupMember.Read.All included. A prod host takes no localhost redirect URIs.
// Placeholder IDs only.
using '../portal-registration.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param environmentKind = 'prod'
param productName = 'SAF'
param portalHostName = 'portal.contoso.com'
param devRedirectUris = []
param platformAdminsGroupId = '00000000-0000-0000-0000-00000000c001'
param platformTeamGroupId = '00000000-0000-0000-0000-00000000c002'
param tenantId = '00000000-0000-0000-0000-000000000001'
param portalIdentityPrincipalId = '00000000-0000-0000-0000-00000000e102'
