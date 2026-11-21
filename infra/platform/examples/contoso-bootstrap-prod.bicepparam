// Fictional Contoso instance: platform identities bootstrap of the `prod` subscription, which
// hosts the portal (instanceIdentities: provisioning identity, ADO automation identity, Entra
// provisioning identity, rg-contoso-entra and the Entra records groups rg-contoso-entra-nonprod and
// rg-contoso-entra-prod with its Entra Deployment Operator role, portal
// runtime identity id-contoso-portal without role or federated credential).
// Pass 2: issuer and subject as `platform ado bootstrap apply --phase connections` read them
// back from the service connections. Delete the ReadOnly lock lock-contoso-identities-readonly
// before this pass; the template re-creates it. Placeholder IDs only.
using '../bootstrap.bicep'

param prefix = 'contoso'
param environmentName = 'prod'
param location = 'westeurope'
param instanceIdentities = true
// Every environment of the instance: one Entra records group rg-contoso-entra-{env} each (ADR-0063).
param entraEnvironments = [
  'nonprod'
  'prod'
]
param federation = {
  provisioning: {
    issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0'
    subject: '/eid1/c/pub/t/00000000-0000-0000-0000-00000000d001/a/00000000-0000-0000-0000-00000000d002/sc/00000000-0000-0000-0000-00000000d003/00000000-0000-0000-0000-00000000d004'
  }
  adoAutomation: {
    issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0'
    subject: '/eid1/c/pub/t/00000000-0000-0000-0000-00000000d001/a/00000000-0000-0000-0000-00000000d002/sc/00000000-0000-0000-0000-00000000d003/00000000-0000-0000-0000-00000000d005'
  }
  entra: {
    issuer: 'https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0'
    subject: '/eid1/c/pub/t/00000000-0000-0000-0000-00000000d001/a/00000000-0000-0000-0000-00000000d002/sc/00000000-0000-0000-0000-00000000d003/00000000-0000-0000-0000-00000000d006'
  }
}
// Portal host: this deployment creates id-contoso-portal and id-contoso-entra-provisioning and
// limits their roles to its own principals (ADR-0043).
param instancePrincipals = {}
param managedBy = 'SAF'
param tags = {
  CostCenter: 'IT-1234'
}
