// Identities resource group content of bootstrap.bicep (resource group scope): the platform's
// user-assigned identities (provisioning; in the portal host environment's subscription also ADO
// automation, Entra provisioning and the portal runtime identity), their federated credentials,
// Reader for the ADO automation identity on this resource group, and the ReadOnly lock, which is
// created LAST (after every identity, federated credential and role assignment of this module).
//
// The lock is what keeps automation from hijacking a platform identity: adding a federated
// credential is a write on the identity, which a ReadOnly lock blocks, and no automation identity
// can delete a lock (Contributor excludes Microsoft.Authorization/*/Delete; RBAC Administrator has
// no lock action). Verify in sandbox: PROV-2.

@description('Azure region of the identities (bootstrap.bicep location).')
param location string

@description('Provisioning identity of this environment: identity name, federated credential name (= its service connection name) and the service connection\'s issuer/subject (null on pass 1).')
param provisioning identitySpec

@description('ADO automation identity (portal host environment\'s subscription only); null elsewhere.')
param adoAutomation identitySpec?

@description('Entra provisioning identity (portal host environment\'s subscription only); null elsewhere.')
param entraProvisioning identitySpec?

@description('Name of the portal runtime identity id-{prefix}-portal (portal host environment\'s subscription only); null elsewhere.')
param portalIdentityName string?

@description('Reader role definition GUID (types.builtInRoles.reader).')
param readerRoleGuid string

@description('Name of the ReadOnly lock on this resource group (naming.identitiesLock).')
param lockName string

param tags object

type identitySpec = {
  identityName: string
  federatedCredentialName: string
  federation: {
    issuer: string
    subject: string
  }?
}

var readerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', readerRoleGuid)
var hasAdoAutomation = adoAutomation != null
var hasEntraProvisioning = entraProvisioning != null
var hasPortal = portalIdentityName != null

// ------------------------------------------------------------------------------------------
// Provisioning identity (every environment subscription)
// ------------------------------------------------------------------------------------------

resource provisioningIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = {
  name: provisioning.identityName
  location: location
  tags: tags
}

// Workload identity federation for sc-platform-provisioning-{env}; issuer and subject are read
// back from the service connection (`platform ado bootstrap apply --phase connections`).
resource provisioningFic 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (provisioning.?federation != null) {
  parent: provisioningIdentity
  name: provisioning.federatedCredentialName
  properties: {
    issuer: provisioning.?federation.?issuer ?? ''
    subject: provisioning.?federation.?subject ?? ''
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// ------------------------------------------------------------------------------------------
// ADO automation identity (portal host environment's subscription only, ADR-0031)
// ------------------------------------------------------------------------------------------

resource adoAutomationIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (hasAdoAutomation) {
  name: adoAutomation.?identityName ?? ''
  location: location
  tags: tags
}

resource adoAutomationFic 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (hasAdoAutomation && adoAutomation.?federation != null) {
  parent: adoAutomationIdentity
  name: adoAutomation.?federatedCredentialName ?? ''
  properties: {
    issuer: adoAutomation.?federation.?issuer ?? ''
    subject: adoAutomation.?federation.?subject ?? ''
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// Its only Azure role: Reader on this resource group, so `az login` in AzureCLI@2 finds a
// subscription. TODO(verify): G10, whether it can be dropped.
resource adoAutomationReader 'Microsoft.Authorization/roleAssignments@2022-04-01' = if (hasAdoAutomation) {
  name: guid(resourceGroup().id, adoAutomationIdentity.id, readerRoleId)
  properties: {
    principalId: adoAutomationIdentity!.properties.principalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: readerRoleId
    description: 'ADO automation identity: Reader on its identities resource group only, so the Azure CLI login finds a subscription (ADR-0031). Its rights are in Azure DevOps.'
  }
}

// ------------------------------------------------------------------------------------------
// Entra provisioning identity (portal host environment's subscription only, ADR-0023, ADR-0033)
// ------------------------------------------------------------------------------------------

// Microsoft Graph application permissions (entra-permissions.bicep, the identity team) and one
// Azure role, Entra Deployment Operator on rg-{prefix}-entra (bootstrap.bicep). No role here: the
// role on rg-{prefix}-entra already lets `az login` find the subscription.
resource entraProvisioningIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (hasEntraProvisioning) {
  name: entraProvisioning.?identityName ?? ''
  location: location
  tags: tags
}

// Workload identity federation for sc-platform-entra, the only service connection that may use
// this identity (pass 2).
resource entraProvisioningFic 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2024-11-30' = if (hasEntraProvisioning && entraProvisioning.?federation != null) {
  parent: entraProvisioningIdentity
  name: entraProvisioning.?federatedCredentialName ?? ''
  properties: {
    issuer: entraProvisioning.?federation.?issuer ?? ''
    subject: entraProvisioning.?federation.?subject ?? ''
    audiences: [
      'api://AzureADTokenExchange'
    ]
  }
}

// ------------------------------------------------------------------------------------------
// Portal runtime identity (portal host environment's subscription only, ADR-0036)
// ------------------------------------------------------------------------------------------

// No role and no federated credential here. portal.bicep assigns its one Azure role (Container
// Registry Repository Reader on the host environment's platform registry); `platform ado
// bootstrap` grants its Azure DevOps rights. Further roles come with the features that need them
// (US10.18), as a later re-run of bootstrap (lock deleted first). Its OBO federated credential
// (ADR-0040) is not here: it lives on the portal's Entra application
// (infra/entra/portal-registration.bicep), with this identity's principal ID as subject, so it
// needs no write on the identity. The portal Container App (another resource
// group) uses it while the lock is in place. Assigning it is a write on the Container App plus a
// permission check on the identity (userAssignedIdentities/assign/action), which the ReadOnly
// lock is expected not to block. Verify in sandbox: PORTAL-1.
resource portalIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' = if (hasPortal) {
  name: portalIdentityName ?? ''
  location: location
  tags: tags
}

// ------------------------------------------------------------------------------------------
// ReadOnly lock: last. Re-running bootstrap (pass 2) needs a human to delete it first.
// ------------------------------------------------------------------------------------------

resource identitiesLock 'Microsoft.Authorization/locks@2020-05-01' = {
  name: lockName
  properties: {
    level: 'ReadOnly'
    notes: 'Platform identities: blocks new federated credentials (identity hijack). Delete only to re-run infra/platform/bootstrap.bicep; the template re-creates this lock (ADR-0031).'
  }
  dependsOn: [
    provisioningIdentity
    provisioningFic
    adoAutomationIdentity
    adoAutomationFic
    adoAutomationReader
    entraProvisioningIdentity
    entraProvisioningFic
    portalIdentity
  ]
}

output provisioningClientId string = provisioningIdentity.properties.clientId
output provisioningPrincipalId string = provisioningIdentity.properties.principalId
output adoAutomationClientId string? = hasAdoAutomation ? adoAutomationIdentity!.properties.clientId : null
output adoAutomationPrincipalId string? = hasAdoAutomation ? adoAutomationIdentity!.properties.principalId : null
output entraProvisioningClientId string? = hasEntraProvisioning ? entraProvisioningIdentity!.properties.clientId : null
output entraProvisioningPrincipalId string? = hasEntraProvisioning ? entraProvisioningIdentity!.properties.principalId : null
output portalClientId string? = hasPortal ? portalIdentity!.properties.clientId : null
output portalPrincipalId string? = hasPortal ? portalIdentity!.properties.principalId : null
