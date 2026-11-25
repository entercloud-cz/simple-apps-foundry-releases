// Portal-side private endpoint of ONE app Key Vault (ADR-0025): pep-{vaultName}-portal in the
// private-endpoint subnet of the portal VNet, registered in the portal's own
// privatelink.vaultcore.azure.net zone through a DNS zone group, so the vault's name resolves to
// this endpoint inside the portal VNet (and to the vault's own endpoint inside its spoke).
//
// Scope: the portal resource group rg-{prefix}-portal-{portalEnvironmentName} in the subscription of
// the portal host environment (portal.bicep creates it with the VNet, the subnet and the zone).
// Deployment name: portalEndpointDeployment(slug, env) = pep-portal-{slug}-{env}, checked below.
// Run by the provisioning pipeline in the stage azure_post_{portal host environment}
// (scripts/provisioning/azure-post.sh portal_endpoints) with the host environment's Azure provisioning
// identity: its Contributor on that subscription (ADR-0031) covers the endpoint, subnets/join/action
// and privateDnsZones/join/action. Once per app vault of an app in a VNet-based mode, in every
// environment of the app. Delivery identities never get these rights.
//
// The vault is appKeyVault(prefix, slug, env, vaultSubscriptionId, generation) in
// rg-{prefix}-app-{slug}-{env} of the vault environment's subscription: computed from naming.bicep
// exactly as landing-zone.bicep names it, never taken as an ID, so the endpoint can target only the
// app's own vault.
//
// Approval (ADR-0025):
//   - vault in THIS subscription: automatic connection (privateLinkServiceConnections). The
//     identity's Contributor includes Microsoft.KeyVault/vaults/privateEndpointConnectionsApproval/
//     action on the vault, so Azure approves the connection when it creates the endpoint.
//   - vault in ANOTHER subscription: a manual connection request
//     (manualPrivateLinkServiceConnections), Pending until the provisioning run of the vault's own
//     environment approves it (azure-post.sh). The host's identity has no rights there; an automatic
//     connection would be refused (LinkedAuthorizationFailed).
// Verify in sandbox: KV-6 (both cases; that the zone group registers the address of a manual
// connection once it is approved).
//
// Only for VNet-based modes (externalHybrid, or externalOnly with externalOnlyNetwork vnet): a
// managed-network vault has public network access and no private endpoint anywhere, and the portal
// writes it over its public endpoint; the template refuses such an app.
//
// The shared module modules/privateendpoint/private-endpoint.bicep is not used: it knows only
// automatic connections, and changing it would change the template hash of every landing zone that
// uses it (needless redeploys, AGENTS.md rule 6).

import {
  appKeyVault as nameAppKeyVault
  appResourceGroup as nameAppResourceGroup
  portalEndpointDeployment as namePortalEndpointDeployment
  portalPrivateEndpoint as namePortalPrivateEndpoint
  portalResourceGroup as namePortalResourceGroup
  privateDnsZone as namePrivateDnsZone
  privateEndpointNic as namePrivateEndpointNic
  subnet as nameSubnet
  virtualNetwork as nameVirtualNetwork
} from '../modules/naming/naming.bicep'
import { externalOnlyNetwork as externalOnlyNetworkType } from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (no defaults: a missing value fails loudly)
// ------------------------------------------------------------------------------------------

@description('Instance prefix (naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('portal.hostEnvironment: the environment whose subscription holds the portal resource group (this deployment\'s scope).')
@minLength(2)
@maxLength(8)
param portalEnvironmentName string

@description('Region of the portal VNet: the portal host environment\'s region, else defaultRegion (as portal.bicep). A private endpoint must be in its VNet\'s region.')
param location string

@description('environments[].name of the vault: the app\'s environment (any environment of the instance, the host included).')
@minLength(2)
@maxLength(8)
param environmentName string

@description('App slug.')
@minLength(3)
@maxLength(20)
param slug string

@description('App generation (apps/{slug}/app.yaml): part of the vault name, as in landing-zone.bicep.')
@minValue(0)
param generation int

@description('Subscription of the vault\'s environment (environments[].subscriptionId).')
param vaultSubscriptionId string

@description('The app\'s network mode in the vault\'s environment.')
param networkMode 'externalOnly' | 'externalHybrid'

@description('The vault environment\'s External-only variant (environments[].networkModes.externalOnly.network); ignored for externalHybrid but required, so a missing value fails.')
param externalOnlyNetwork externalOnlyNetworkType

@description('Value of the ManagedBy tag.')
param managedBy string

// ------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------

var portalRgName = namePortalResourceGroup(prefix, portalEnvironmentName)
var deploymentName = namePortalEndpointDeployment(slug, environmentName)
var vnetBased = networkMode == 'externalHybrid' || externalOnlyNetwork == 'vnet'

// A GUID: 36 characters, hex digits, hyphens at 8, 13, 18 and 23.
var vaultSubscriptionLower = toLower(vaultSubscriptionId)
var vaultSubscriptionIsGuid = length(vaultSubscriptionLower) == 36 && empty(filter(
  range(0, min(length(vaultSubscriptionLower), 36)),
  i => contains([8, 13, 18, 23], i) ? substring(vaultSubscriptionLower, i, 1) != '-' : !contains('0123456789abcdef', substring(vaultSubscriptionLower, i, 1))
))

var inputErrors = filter(
  [
    toLower(resourceGroup().name) != portalRgName
      ? 'deploy into the portal resource group ${portalRgName}, not ${resourceGroup().name}.'
      : ''
    deployment().name != deploymentName ? 'the deployment name must be ${deploymentName}, not ${deployment().name}.' : ''
    !vaultSubscriptionIsGuid ? 'vaultSubscriptionId must be a subscription ID (a GUID).' : ''
    !vnetBased
      ? '${slug} runs on the Azure-managed network in ${environmentName}: its vault has public network access and no private endpoint, and the portal reaches it over the public endpoint (ADR-0025). No portal-side endpoint.'
      : ''
  ],
  message => !empty(message)
)

var valid = empty(inputErrors)
// Same subscription: the creator approves its own connection (automatic). Otherwise: a request.
var automatic = vaultSubscriptionLower == toLower(subscription().subscriptionId)

var vaultName = valid
  ? nameAppKeyVault(prefix, slug, environmentName, vaultSubscriptionLower, generation)
  : fail('portal-vault-endpoint.bicep: ${join(inputErrors, ' ')}')
var vaultId = resourceId(
  vaultSubscriptionLower,
  nameAppResourceGroup(prefix, slug, environmentName),
  'Microsoft.KeyVault/vaults',
  vaultName
)
var endpointName = namePortalPrivateEndpoint(vaultName)

// The portal network (portal.bicep, existing): computed from names like there, never passed in.
var subnetId = resourceId(
  'Microsoft.Network/virtualNetworks/subnets',
  nameVirtualNetwork(prefix, 'portal', portalEnvironmentName),
  nameSubnet(prefix, 'pep', 'portal', portalEnvironmentName)
)
var vaultZoneId = resourceId('Microsoft.Network/privateDnsZones', namePrivateDnsZone('vault'))

var connection = {
  name: endpointName
  properties: {
    privateLinkServiceId: vaultId
    groupIds: [
      'vault'
    ]
    // Shown on the vault's connection, to whoever approves a request.
    requestMessage: 'Portal-side endpoint of ${slug} in ${environmentName} (${portalRgName}, ADR-0025).'
  }
}

// ------------------------------------------------------------------------------------------
// The endpoint and its DNS registration
// ------------------------------------------------------------------------------------------

resource endpoint 'Microsoft.Network/privateEndpoints@2025-01-01' = {
  name: endpointName
  location: location
  tags: {
    Application: slug
    Environment: environmentName
    ManagedBy: managedBy
  }
  properties: {
    subnet: {
      id: subnetId
    }
    customNetworkInterfaceName: namePrivateEndpointNic(endpointName)
    privateLinkServiceConnections: automatic ? [connection] : []
    manualPrivateLinkServiceConnections: automatic ? [] : [connection]
  }
}

// The portal's zone only (portal.bicep, linked to the portal VNet alone), never a spoke zone.
resource zoneGroup 'Microsoft.Network/privateEndpoints/privateDnsZoneGroups@2025-01-01' = {
  parent: endpoint
  name: 'default'
  properties: {
    privateDnsZoneConfigs: [
      {
        name: 'vault'
        properties: {
          privateDnsZoneId: vaultZoneId
        }
      }
    ]
  }
}

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------

@description('The portal-side endpoint (its connection state tells whether the vault approved it).')
output endpointId string = endpoint.id
output endpointName string = endpoint.name

@description('The app vault it connects to.')
output vaultId string = vaultId
output vaultName string = vaultName

@description('automatic: approved at creation (vault in this subscription); manual: a request the vault\'s own environment approves.')
output approval string = automatic ? 'automatic' : 'manual'
