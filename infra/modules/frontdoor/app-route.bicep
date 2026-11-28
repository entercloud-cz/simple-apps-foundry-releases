// One app on its own custom domain in the managed Front Door profile of its environment
// (ADR-0010, amended 2026-11-01). Deployed into the environment's platform RG, which holds the
// profile (profile.bicep), by infra/app/frontdoor.bicep:
//
//   origin group  og-{slug}-{env}     one origin, no health probe, no session affinity
//   origin        orig-{slug}-{env}   the Container App's default FQDN as host and host header,
//                                     HTTPS 443 with certificate name check
//   custom domain cd-{host}           Front Door-managed certificate, minimum TLS 1.2, validated
//                                     with the _dnsauth TXT record
//   route         route-{slug}-{env}  on the environment endpoint, serving ONLY the custom domain
//                                     (linkToDefaultDomain Disabled), /*, HTTP redirected to
//                                     HTTPS, forwarded over HTTPS, no caching, no rule sets; during
//                                     a host change also the previous custom domain, which this
//                                     module only references (retainedCustomDomainName)
//
// No security policy and no reference to the environment's WAF policy: a WAF policy can be linked
// through only one security policy per profile, and secp-{prefix}-{env} already links it (sandbox,
// 2026-11-01: "Web Application Firewall Policy is already attached to AFDX profile."). The app's
// custom domain is not covered by the WAF yet; how it will be is an open decision (ADR-0010,
// amended 2026-11-01). DNS records are not written here (dns-records.bicep, in the zone's RG).
// Verify in sandbox: FD-2 (route, domain validation, certificate issuance), FD-1 (forwardProxy).

@description('Profile name (naming.frontDoorProfile), in this RG.')
param profileName string

@description('Endpoint name (naming.frontDoorEndpoint).')
param endpointName string

@description('Origin group name (naming.frontDoorOriginGroup).')
param originGroupName string

@description('Origin name (naming.frontDoorOrigin).')
param originName string

@description('Route name (naming.frontDoorRoute).')
param routeName string

@description('Custom domain resource name (naming.frontDoorCustomDomain).')
param customDomainName string

@description('The custom host name (lowercase, validated by the caller).')
param hostName string

@description('Name (naming.frontDoorCustomDomain) of an existing custom domain of this app that the route keeps serving until Front Door serves hostName (a host change, ADR-0010 amended 2026-11-11); \'\' = none. It is not created or changed here.')
param retainedCustomDomainName string

@description('The Container App\'s default FQDN: origin host and origin host header.')
param originHostName string

@description('Resource ID of the public Azure DNS zone that holds the host, or \'\' (records created by hand).')
param dnsZoneId string

resource profile 'Microsoft.Cdn/profiles@2025-04-15' existing = {
  name: profileName
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2025-04-15' existing = {
  parent: profile
  name: endpointName
}

// A single origin: Microsoft recommends disabling health probes for it (Learn, "Health probes"),
// so healthProbeSettings is left out. The load-balancing values are Front Door's defaults.
resource originGroup 'Microsoft.Cdn/profiles/originGroups@2025-04-15' = {
  parent: profile
  name: originGroupName
  properties: {
    loadBalancingSettings: {
      sampleSize: 4
      successfulSamplesRequired: 3
      additionalLatencyInMilliseconds: 50
    }
    sessionAffinityState: 'Disabled'
  }
}

resource origin 'Microsoft.Cdn/profiles/originGroups/origins@2025-04-15' = {
  parent: originGroup
  name: originName
  properties: {
    hostName: originHostName
    originHostHeader: originHostName
    httpPort: 80
    httpsPort: 443
    priority: 1
    weight: 1000
    enabledState: 'Enabled'
    enforceCertificateNameCheck: true
  }
}

// Front Door-managed certificate. Validation: TXT _dnsauth.{host} = validationToken; then the
// certificate is issued. TODO(verify): validation and issuance time, the issuing CA (CAA
// records) and whether issuance needs the CNAME in place. Verify in sandbox: FD-2.
resource customDomain 'Microsoft.Cdn/profiles/customDomains@2025-04-15' = {
  parent: profile
  name: customDomainName
  properties: {
    hostName: hostName
    tlsSettings: {
      certificateType: 'ManagedCertificate'
      minimumTlsVersion: 'TLS12'
    }
    azureDnsZone: empty(dnsZoneId)
      ? null
      : {
          id: dnsZoneId
        }
  }
}

// No cacheConfiguration: caching is off for the whole app, so /.auth/* is never cached (ADR-0010).
resource route 'Microsoft.Cdn/profiles/afdEndpoints/routes@2025-04-15' = {
  parent: endpoint
  name: routeName
  properties: {
    customDomains: concat(
      [
        {
          id: customDomain.id
        }
      ],
      empty(retainedCustomDomainName)
        ? []
        : [
            {
              id: resourceId('Microsoft.Cdn/profiles/customDomains', profileName, retainedCustomDomainName)
            }
          ]
    )
    originGroup: {
      id: originGroup.id
    }
    ruleSets: []
    supportedProtocols: [
      'Http'
      'Https'
    ]
    patternsToMatch: [
      '/*'
    ]
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Disabled'
    httpsRedirect: 'Enabled'
    enabledState: 'Enabled'
  }
  // The origin group must not be empty when the route is created.
  dependsOn: [
    origin
  ]
}

output customDomainId string = customDomain.id
@description('The _dnsauth TXT value. TODO(verify): whether it stays set on a re-deploy after validation (FD-2).')
output validationToken string = customDomain.properties.validationProperties.validationToken
output validationTokenExpiry string = customDomain.properties.validationProperties.expirationDate
@description('CNAME target of the custom host.')
output endpointHostName string = endpoint.properties.hostName
output routeId string = route.id
@description('The profile\'s Front Door ID: the X-Azure-FDID value of requests that came through this profile.')
output frontDoorId string = profile.properties.frontDoorId
