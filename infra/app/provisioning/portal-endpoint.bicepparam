// The only parameter file the provisioning pipeline deploys portal-vault-endpoint.bicep with
// (deployment pep-portal-{slug}-{env} in the portal resource group, stage azure_post of the portal
// host environment, its Azure provisioning identity; ADR-0025).
//
// Input: SAF_PORTAL_ENDPOINT_JSON, written by `platform provisioning inputs --step portal-endpoint`
// from instance.yaml and apps/{slug}/app.yaml (portal.hostEnvironment and its region, the vault
// environment's subscription, the app's generation and network mode). Every value comes from that
// JSON; keys it doesn't use (vnetBased, read by the pipeline) are ignored. No other --parameters.

using '../portal-vault-endpoint.bicep'

var pe = json(readEnvironmentVariable('SAF_PORTAL_ENDPOINT_JSON'))

param prefix = pe.prefix
param portalEnvironmentName = pe.portalEnvironmentName
param location = pe.location
param environmentName = pe.environmentName
param slug = pe.slug
param generation = pe.generation
param vaultSubscriptionId = pe.vaultSubscriptionId
param networkMode = pe.networkMode
param externalOnlyNetwork = pe.externalOnlyNetwork
param managedBy = pe.managedBy
