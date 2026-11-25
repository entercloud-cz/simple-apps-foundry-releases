// Microsoft Graph application permissions of the Entra provisioning identity
// id-{prefix}-entra-provisioning (ADR-0023, ADR-0033), once per instance. Resource group scope,
// Microsoft Graph Bicep v1.0 (GA).
//
// Who and when: a HUMAN of the tenant's identity team with Privileged Role Administrator or
// Global Administrator (granting Microsoft Graph application permissions needs one of them), never
// a pipeline. Run after bootstrap.bicep pass 1 of the portal host environment (which creates the
// identity and rg-{prefix}-entra) and before the first provisioning run that creates an Entra app
// registration. Deployment name `entra-permissions`, into rg-{prefix}-entra:
//   az deployment group validate -g rg-{prefix}-entra -n entra-permissions -p <file>.bicepparam
//   az deployment group create   -g rg-{prefix}-entra -n entra-permissions -p <file>.bicepparam
// The ARM deployment also needs Microsoft.Resources/deployments/write on rg-{prefix}-entra.
// Graph resources have no what-if: `validate` only, and this file is the reviewed preview.
//
// Input: entraProvisioningPrincipalId = the bootstrap output entraProvisioningIdentity.principalId
// (the identity's object ID, not its client ID).
//
// Grants exactly four application permissions (app role assignments on the Microsoft Graph
// service principal), nothing else (asserted in infra/tests/check-infra.py):
//   Application.ReadWrite.OwnedBy           create the app registrations and service principals;
//                                           it becomes their owner and can change only those
//   AppRoleAssignment.ReadWrite.All         assign the app's groups and people to the app's own
//                                           roles, and remove the assignments app.yaml no longer
//                                           lists (entra-reconcile; Tier-0: mitigations in
//                                           ADR-0023, alert entra-audit-alert.bicep)
//   Application.Read.All                    needed with appRoleAssignedTo (resolve the resource
//                                           service principal and its roles)
//   DelegatedPermissionGrant.ReadWrite.All  the sign-in consent (openid profile email on Microsoft
//                                           Graph) for the app's own service principal
// App role IDs read from the Microsoft Graph service principal of the sandbox tenant (`az ad sp
// show --id 00000003-0000-0000-c000-000000000000`); they are the same in every tenant.
// Removing a permission is not declarative: delete the app role assignment by hand.
// Verify in sandbox: ENT-1 and ENT-11 (these four are enough), ENT-3 (removing assignments needs no
// other), ENT-8 (audit alert, infra/platform/entra-audit-alert.bicep).

extension microsoftGraphV1

@description('Object (principal) ID of id-{prefix}-entra-provisioning: bootstrap.bicep output entraProvisioningIdentity.principalId.')
param entraProvisioningPrincipalId string

var graphAppId = '00000003-0000-0000-c000-000000000000'
var graphAppRoles = [
  {
    permission: 'Application.ReadWrite.OwnedBy'
    id: '18a4783c-866b-4cc7-a460-3d5e5662c884'
  }
  {
    permission: 'AppRoleAssignment.ReadWrite.All'
    id: '06b708a9-e830-4db3-a914-8e69da51d44f'
  }
  {
    permission: 'Application.Read.All'
    id: '9a5d68dd-52b0-4cc2-bd40-abcf44ac3a30'
  }
  {
    permission: 'DelegatedPermissionGrant.ReadWrite.All'
    id: '8e8e4742-1d95-4f68-9d56-6ee75648c72a'
  }
]

// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var principalLower = toLower(entraProvisioningPrincipalId)
var principalIsGuid = length(principalLower) == 36 && empty(filter(
  range(0, min(length(principalLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(principalLower, i, 1) != '-' : !contains('0123456789abcdef', substring(principalLower, i, 1))
))
var principalId = principalIsGuid
  ? entraProvisioningPrincipalId
  : fail('entra-permissions.bicep: entraProvisioningPrincipalId must be a GUID (the object ID of id-{prefix}-entra-provisioning).')

resource graphServicePrincipal 'Microsoft.Graph/servicePrincipals@v1.0' existing = {
  appId: graphAppId
}

resource graphPermissions 'Microsoft.Graph/appRoleAssignedTo@v1.0' = [
  for role in graphAppRoles: {
    appRoleId: role.id
    principalId: principalId
    resourceId: graphServicePrincipal.id
  }
]
