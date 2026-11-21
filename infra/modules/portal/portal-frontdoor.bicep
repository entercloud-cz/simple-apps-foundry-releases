// The portal on its own host name through the managed Front Door profile of the portal host
// environment (ADR-0071). Deployed by platform/portal.bicep, on every pass that has a host name, into
// the host environment's platform RG rg-{prefix}-platform-{env}, which holds the profile
// afd-{prefix}-{env} and its endpoint fde-{prefix}-{env} (environment.bicep, existing):
//
//   origin group og-portal-{env}, origin orig-portal-{env}: the portal Container App's own address
//     ca-{prefix}-portal.{portal CAE default domain} (known from pass 1) as origin and host header;
//   custom domain cd-{host} with a Front Door-managed certificate (TLS 1.2 minimum);
//   route route-portal-{env} serving ONLY the custom domain, HTTP redirected to HTTPS, no caching.
// The objects are the apps' (modules/frontdoor/app-route.bicep) with the portal's names: `portal` is
// a reserved slug, so no app's og-{slug}-{env}, orig-{slug}-{env} or route-{slug}-{env} is the same,
// and its host's first label is a reserved subdomain (the CLI checks it), so no app gets cd-{host}.
// With dnsZoneId (a public Azure DNS zone in this subscription), in the zone's RG
// (modules/frontdoor/dns-records.bicep): TXT _dnsauth.{sub} and CNAME {sub}, marked saf-app = portal,
// saf-env = {env}; the platform pipeline reads both record sets first and stops when one exists
// without that mark (ADR-0052). With dnsZoneId = '': output dnsRecords lists both, to create by hand.
//
// It never deletes anything (incremental). No security policy: the environment's WAF policy is linked
// by secp-{prefix}-{env} (environment.bicep), as for the apps' domains (ADR-0010, amended 2026-11-01).
// The portal's ingress is locked to Front Door by portal-app.bicep (AzureFrontDoor.Backend ranges, and
// the API's X-Azure-FDID check with SAF_FRONT_DOOR_ID). Verify in sandbox: PORTAL-26.

import {
  dnsRelativeRecordName as nameDnsRelativeRecord
  frontDoorCustomDomain as nameFrontDoorCustomDomain
  frontDoorEndpoint as nameFrontDoorEndpoint
  frontDoorPortalOrigin as nameFrontDoorPortalOrigin
  frontDoorPortalOriginGroup as nameFrontDoorPortalOriginGroup
  frontDoorPortalRoute as nameFrontDoorPortalRoute
  frontDoorProfile as nameFrontDoorProfile
  frontDoorValidationRecord as nameFrontDoorValidationRecord
} from '../naming/naming.bicep'

@description('Instance prefix (naming.prefix).')
param prefix string

@description('portal.hostEnvironment: the profile\'s environment.')
param environmentName string

@description('The portal\'s host name (lowercase, validated by portal.bicep).')
param hostName string

@description('The portal Container App\'s own address ca-{prefix}-portal.{CAE default domain}: origin host and origin host header.')
param originHostName string

@description('\'\' or the resource ID of the public Azure DNS zone in this subscription that holds hostName (validated by portal.bicep).')
param dnsZoneId string

var withZone = !empty(dnsZoneId)
var zoneSegments = split(dnsZoneId, '/')
var zoneResourceGroupName = zoneSegments[?4] ?? ''
var zoneName = toLower(zoneSegments[?8] ?? '')

module route '../frontdoor/app-route.bicep' = {
  params: {
    profileName: nameFrontDoorProfile(prefix, environmentName)
    endpointName: nameFrontDoorEndpoint(prefix, environmentName)
    originGroupName: nameFrontDoorPortalOriginGroup(environmentName)
    originName: nameFrontDoorPortalOrigin(environmentName)
    routeName: nameFrontDoorPortalRoute(environmentName)
    customDomainName: nameFrontDoorCustomDomain(hostName)
    hostName: hostName
    retainedCustomDomainName: ''
    originHostName: originHostName
    dnsZoneId: dnsZoneId
  }
}

module records '../frontdoor/dns-records.bicep' = if (withZone) {
  scope: resourceGroup(zoneResourceGroupName)
  params: {
    zoneName: zoneName
    appSlug: 'portal'
    environmentName: environmentName
    hostRecordName: withZone ? nameDnsRelativeRecord(hostName, zoneName) : ''
    validationRecordName: withZone ? nameDnsRelativeRecord(nameFrontDoorValidationRecord(hostName), zoneName) : ''
    validationToken: route.outputs.validationToken
    endpointHostName: route.outputs.endpointHostName
  }
}

@description('The profile\'s Front Door ID: the X-Azure-FDID of requests through it (SAF_FRONT_DOOR_ID).')
output frontDoorId string = route.outputs.frontDoorId

@description('CNAME target of the portal\'s host name.')
output endpointHostName string = route.outputs.endpointHostName

@description('Without dnsZoneId: the two records to create by hand in the zone that holds hostName; [] with dnsZoneId (written here).')
output dnsRecords object[] = withZone
  ? []
  : [
      {
        type: 'CNAME'
        name: hostName
        value: route.outputs.endpointHostName
      }
      {
        type: 'TXT'
        name: nameFrontDoorValidationRecord(hostName)
        value: route.outputs.validationToken
      }
    ]
