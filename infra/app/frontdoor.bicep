// One app on its own custom domain through the managed Front Door profile of its environment
// (ADR-0010, amended 2026-11-01).
//
// Scope: the environment's platform RG rg-{prefix}-platform-{env}, which holds the profile
// afd-{prefix}-{env}. Deployment name: frontDoorDeployment(slug, env) = fd-{slug}-{env}, checked
// below. Run by the environment's Azure provisioning identity id-{prefix}-provisioning-{env}: its
// Contributor role on the environment subscription (ADR-0031) covers the platform RG and the RG of a
// DNS zone in the same subscription, so it needs no new role. By hand until the provisioning
// pipeline runs it (infra/README.md). Delivery identities never get Front Door rights (ADR-0021).
//
// Creates, in the profile (modules/frontdoor/app-route.bicep):
//   origin group og-{slug}-{env} and origin orig-{slug}-{env}: the Container App's default FQDN
//     ca-{slug}.{CAE default domain} as origin and origin host header, no health probe;
//   custom domain cd-{host} with a Front Door-managed certificate (TLS 1.2 minimum);
//   route route-{slug}-{env} on the endpoint fde-{prefix}-{env}, serving ONLY the custom domain
//     (never the endpoint's default host), HTTP redirected to HTTPS, HTTPS to the origin, no caching;
//     during a host change also the previous custom domain cd-{retainedHostName}, which exists
//     already and is not changed here (ADR-0010, amended 2026-11-11: the old host keeps working until
//     Front Door serves the new one; then provisioning deploys without it and deletes it).
// No security policy: the environment's WAF policy is linked by secp-{prefix}-{env}, and a WAF
// policy can be linked through only one security policy per profile (verified in the sandbox
// 2026-11-01). The app's custom domain is NOT covered by the WAF yet: open decision, ADR-0010
// (amended 2026-11-01).
// With dnsZoneId (a public Azure DNS zone in this subscription), in the zone's RG
// (modules/frontdoor/dns-records.bicep): TXT _dnsauth.{sub} = validation token, CNAME {sub} =
// endpoint host name, both marked with the metadata saf-app = {slug}, saf-env = {env} (ADR-0052).
// With dnsZoneId = '': output dnsRecords lists both records to create by hand.
//
// It never deletes anything (an incremental deployment): removing a domain, and the previous domain
// after a host change, is provisioning's front_door_cleanup (ADR-0010, amended 2026-11-11).
//
// It never changes the Container App. Locking the app's ingress to Front Door (AzureFrontDoor.Backend
// ranges, FRONT_DOOR_ID, Easy Auth forwardProxy) is release.bicep's frontDoor input (FD-3, FD-1).
// Verify in sandbox: FD-2.

import {
  cellManagedEnvironment as nameCellManagedEnvironment
  containerApp as nameContainerApp
  dnsRelativeRecordName as nameDnsRelativeRecord
  frontDoorCustomDomain as nameFrontDoorCustomDomain
  frontDoorDeployment as nameFrontDoorDeployment
  frontDoorEndpoint as nameFrontDoorEndpoint
  frontDoorOrigin as nameFrontDoorOrigin
  frontDoorOriginGroup as nameFrontDoorOriginGroup
  frontDoorProfile as nameFrontDoorProfile
  frontDoorRoute as nameFrontDoorRoute
  frontDoorValidationRecord as nameFrontDoorValidationRecord
  platformResourceGroup as namePlatformResourceGroup
} from '../modules/naming/naming.bicep'

// ------------------------------------------------------------------------------------------
// Parameters (no defaults: a missing value fails loudly)
// ------------------------------------------------------------------------------------------

@description('Instance prefix (naming.prefix).')
@minLength(2)
@maxLength(8)
param prefix string

@description('environments[].name of the app\'s environment (the profile\'s environment).')
@minLength(2)
@maxLength(8)
param environmentName string

@description('App slug.')
@minLength(3)
@maxLength(20)
param slug string

@description('The app\'s network mode in this environment: its CAE gives the origin host ca-{slug}.{CAE default domain}.')
param networkMode 'externalOnly' | 'externalHybrid'

@description('The app\'s capacity cell in this environment (app.yaml environments.<env>.cell, default 01; ADR-0053): with networkMode it names the CAE whose default domain the origin host has. Two digits; an invalid id fails in naming.bicep.')
@minLength(2)
@maxLength(2)
param cell string

@description('The app\'s custom host name in this environment, e.g. hotel-inventory-test.contoso.com: lowercase, at least three labels, no wildcard, scheme or trailing dot.')
param hostName string

@description('Resource ID of the public Azure DNS zone (Microsoft.Network/dnsZones) in THIS subscription that holds hostName: the template writes the _dnsauth TXT and the CNAME there. \'\' = create both by hand (output dnsRecords), also for a zone in another subscription.')
param dnsZoneId string

@description('A host change (ADR-0010, amended 2026-11-11): the previous custom host, whose custom domain cd-{host} already exists and stays on the route until Front Door serves hostName; then provisioning deploys again with \'\' and deletes it. \'\' = none. Its custom domain and DNS records are not touched here.')
param retainedHostName string

@description('The zone the previous deployment wrote retainedHostName\'s records in (its dnsZoneId), or \'\' (records made by hand, or no retained host). Recorded only, so provisioning knows which records it may delete later.')
param retainedDnsZoneId string

// ------------------------------------------------------------------------------------------
// Validation
// ------------------------------------------------------------------------------------------

var platformRgName = namePlatformResourceGroup(prefix, environmentName)
var deploymentName = nameFrontDoorDeployment(slug, environmentName)

// Host: lowercase letters, digits, dots and inner hyphens; at least three labels (a subdomain,
// because the CNAME can't sit at a zone apex); room for the _dnsauth. prefix within 253.
var hostCharacters = 'abcdefghijklmnopqrstuvwxyz0123456789-.'
var hostLabels = split(hostName, '.')
var hostIsPlain = length(hostName) <= 244 && length(hostLabels) >= 3 && empty(filter(
  map(range(0, length(hostName)), i => substring(hostName, i, 1)),
  c => !contains(hostCharacters, c)
)) && empty(filter(hostLabels, l => empty(l) || length(l) > 63 || startsWith(l, '-') || endsWith(l, '-')))

// DNS zone: /subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Network/dnsZones/{zone}
// (segments compared case-insensitively; a private DNS zone can't validate a public domain).
var withZone = !empty(dnsZoneId)
var zoneSegments = split(dnsZoneId, '/')
var zoneSegmentsLower = map(range(0, 9), i => toLower(zoneSegments[?i] ?? ''))
var zoneIdIsPublicZone = length(zoneSegments) == 9 && empty(zoneSegmentsLower[0]) && zoneSegmentsLower[1] == 'subscriptions' && zoneSegmentsLower[3] == 'resourcegroups' && !empty(zoneSegmentsLower[4]) && zoneSegmentsLower[5] == 'providers' && zoneSegmentsLower[6] == 'microsoft.network' && zoneSegmentsLower[7] == 'dnszones' && !empty(zoneSegmentsLower[8])
var zoneSubscriptionId = zoneSegments[?2] ?? ''
var zoneResourceGroupName = zoneSegments[?4] ?? ''
var zoneName = zoneSegmentsLower[8]

// The retained host: the same shape as hostName, never hostName itself; its zone ID only with it.
var retained = !empty(retainedHostName)
var retainedLabels = split(retainedHostName, '.')
var retainedIsPlain = length(retainedHostName) <= 244 && length(retainedLabels) >= 3 && empty(filter(
  map(range(0, length(retainedHostName)), i => substring(retainedHostName, i, 1)),
  c => !contains(hostCharacters, c)
)) && empty(filter(retainedLabels, l => empty(l) || length(l) > 63 || startsWith(l, '-') || endsWith(l, '-')))
var retainedZoneSegments = split(retainedDnsZoneId, '/')
var retainedZoneIsPublicZone = length(retainedZoneSegments) == 9 && empty(retainedZoneSegments[0]) && toLower(retainedZoneSegments[1]) == 'subscriptions' && toLower(retainedZoneSegments[7]) == 'dnszones' && !empty(retainedZoneSegments[8])

var inputErrors = filter(
  [
    toLower(resourceGroup().name) != platformRgName
      ? 'deploy into the environment\'s platform resource group ${platformRgName}, not ${resourceGroup().name}.'
      : ''
    deployment().name != deploymentName ? 'the deployment name must be ${deploymentName}, not ${deployment().name}.' : ''
    !hostIsPlain
      ? 'hostName "${hostName}" must be a lowercase host name with at least three labels (a-z, 0-9, inner hyphens), no wildcard, scheme or trailing dot, at most 244 characters.'
      : ''
    withZone && !zoneIdIsPublicZone
      ? 'dnsZoneId must be \'\' or the resource ID of a public Azure DNS zone (/subscriptions/{id}/resourceGroups/{rg}/providers/Microsoft.Network/dnsZones/{zone}).'
      : ''
    withZone && zoneIdIsPublicZone && toLower(zoneSubscriptionId) != toLower(subscription().subscriptionId)
      ? 'dnsZoneId is in subscription ${zoneSubscriptionId}, not in this deployment\'s: pass \'\' and create the records by hand (no nested deployment into another subscription, lessons-from-v1).'
      : ''
    withZone && zoneIdIsPublicZone && !endsWith(hostName, '.${zoneName}')
      ? 'hostName "${hostName}" is not below the DNS zone "${zoneName}" (records at the zone apex are not supported).'
      : ''
    retained && !retainedIsPlain
      ? 'retainedHostName "${retainedHostName}" must be \'\' or a lowercase host name with at least three labels.'
      : ''
    retained && retainedHostName == hostName ? 'retainedHostName must differ from hostName.' : ''
    !retained && !empty(retainedDnsZoneId) ? 'retainedDnsZoneId must be \'\' without a retainedHostName.' : ''
    !empty(retainedDnsZoneId) && !retainedZoneIsPublicZone
      ? 'retainedDnsZoneId must be \'\' or the resource ID of a public Azure DNS zone.'
      : ''
  ],
  message => !empty(message)
)

var valid = empty(inputErrors)
var routeName = valid ? nameFrontDoorRoute(slug, environmentName) : fail('frontdoor.bicep: ${join(inputErrors, ' ')}')

// ------------------------------------------------------------------------------------------
// Origin: the app's default FQDN in its CAE (same as the landing-zone output containerAppFqdn)
// ------------------------------------------------------------------------------------------

resource cae 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  name: nameCellManagedEnvironment(prefix, networkMode, environmentName, cell)
}

var originHostName = '${nameContainerApp(slug)}.${cae.properties.defaultDomain}'

// ------------------------------------------------------------------------------------------
// Front Door objects of the app, in the environment's profile
// ------------------------------------------------------------------------------------------

module appRoute '../modules/frontdoor/app-route.bicep' = {
  params: {
    profileName: nameFrontDoorProfile(prefix, environmentName)
    endpointName: nameFrontDoorEndpoint(prefix, environmentName)
    originGroupName: nameFrontDoorOriginGroup(slug, environmentName)
    originName: nameFrontDoorOrigin(slug, environmentName)
    routeName: routeName
    customDomainName: nameFrontDoorCustomDomain(hostName)
    hostName: hostName
    retainedCustomDomainName: retained ? nameFrontDoorCustomDomain(retainedHostName) : ''
    originHostName: originHostName
    dnsZoneId: dnsZoneId
  }
}

// ------------------------------------------------------------------------------------------
// DNS records in a public Azure DNS zone of this subscription (optional)
// ------------------------------------------------------------------------------------------

module dnsRecords '../modules/frontdoor/dns-records.bicep' = if (valid && withZone) {
  scope: resourceGroup(zoneResourceGroupName)
  params: {
    zoneName: zoneName
    appSlug: slug
    environmentName: environmentName
    hostRecordName: nameDnsRelativeRecord(hostName, zoneName)
    validationRecordName: nameDnsRelativeRecord(nameFrontDoorValidationRecord(hostName), zoneName)
    validationToken: appRoute.outputs.validationToken
    endpointHostName: appRoute.outputs.endpointHostName
  }
}

// ------------------------------------------------------------------------------------------
// Outputs
// ------------------------------------------------------------------------------------------

@description('Resource ID of the custom domain (its domainValidationState shows validation progress).')
output customDomainId string = appRoute.outputs.customDomainId

@description('The environment endpoint\'s host name: the CNAME target of the custom host.')
output endpointHostName string = appRoute.outputs.endpointHostName

@description('Value of the TXT record _dnsauth.{host} that validates the custom domain.')
output validationToken string = appRoute.outputs.validationToken

@description('When the validation token expires (a new one is issued on request).')
output validationTokenExpiry string = appRoute.outputs.validationTokenExpiry

@description('Origin host and origin host header: the Container App\'s default FQDN.')
output originHostName string = originHostName

@description('The environment profile\'s Front Door ID (X-Azure-FDID). Provisioning reads it from this record to put the release behind Front Door (FRONT_DOOR_ID, Easy Auth forwardProxy; ADR-0010, amended 2026-11-02).')
output frontDoorId string = appRoute.outputs.frontDoorId

@description('DNS records of the custom domain (FQDNs). writtenToZone = true: this deployment wrote them in dnsZoneId; false: create them by hand.')
output dnsRecords object = {
  writtenToZone: withZone
  txt: {
    name: nameFrontDoorValidationRecord(hostName)
    value: appRoute.outputs.validationToken
  }
  cname: {
    name: hostName
    value: appRoute.outputs.endpointHostName
  }
}
