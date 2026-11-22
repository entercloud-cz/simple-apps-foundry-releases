// The only parameter file the provisioning pipeline deploys frontdoor.bicep with: one app on its
// custom domain through the environment's managed Front Door profile (deployment fd-{slug}-{env}
// in rg-{prefix}-platform-{env}, ADR-0010 amended 2026-11-01).
//
// Input: SAF_FRONTDOOR_JSON, written by `platform provisioning inputs --step frontdoor` from
// instance.yaml and apps/{slug}/app.yaml (environments.<env>.frontDoor.hostName; dnsZoneId is the
// zone's azureDnsZoneId when it is an Azure DNS zone of the environment's subscription, else '';
// retainedHostName and retainedDnsZoneId: the previous host during a host change, from the last
// record, ADR-0010 amended 2026-11-11).
// Keys the template doesn't read (dnsZone, dnsProvider: the run's report) change nothing.

using '../frontdoor.bicep'

var frontDoor = json(readEnvironmentVariable('SAF_FRONTDOOR_JSON'))

param prefix = frontDoor.prefix
param environmentName = frontDoor.environmentName
param slug = frontDoor.slug
param networkMode = frontDoor.networkMode
param cell = frontDoor.cell
param hostName = frontDoor.hostName
param dnsZoneId = frontDoor.dnsZoneId
param retainedHostName = frontDoor.retainedHostName
param retainedDnsZoneId = frontDoor.retainedDnsZoneId
