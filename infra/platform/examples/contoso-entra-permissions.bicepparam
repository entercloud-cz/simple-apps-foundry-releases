// Fictional Contoso instance: Microsoft Graph application permissions of
// id-contoso-entra-provisioning. Run once by Contoso's identity team (Privileged Role
// Administrator or Global Administrator) after bootstrap pass 1 of the portal host environment
// `prod`: deployment `entra-permissions` in rg-contoso-entra, `validate` first (Graph has no
// what-if). The principal ID is the bootstrap output entraProvisioningIdentity.principalId.
// Placeholder IDs only.
using '../entra-permissions.bicep'

param entraProvisioningPrincipalId = '00000000-0000-0000-0000-00000000d101'
