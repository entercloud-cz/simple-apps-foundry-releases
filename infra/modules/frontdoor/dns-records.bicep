// DNS records of one app's Front Door custom domain (ADR-0010, amended 2026-11-01), deployed by
// infra/app/frontdoor.bicep into the resource group of a public Azure DNS zone in the same
// subscription:
//
//   TXT   _dnsauth.{sub}  = the custom domain's validation token (domain ownership)
//   CNAME {sub}           = the environment endpoint's host name (traffic)
//
// A PUT replaces a record set, so an existing CNAME {sub} (for example to the Container App) is
// switched to Front Door by this deployment. A zone in another subscription is never written
// through a nested deployment (lessons-from-v1); its records are created by hand.
//
// Both record sets carry the metadata saf-app = {slug} and saf-env = {env} (ADR-0052): the mark that
// the platform wrote them for that app. ARM can't refuse to overwrite a record set it didn't write, so
// provisioning reads the record set before this deployment and stops when it exists without that mark
// or with another app's (a later step in pipelines/, ADR-0052 open findings).
// Verify in sandbox: FD-2, ISO-2.

@description('Zone name: the last segment of the zone\'s resource ID.')
param zoneName string

@description('Slug of the app the records belong to (record set metadata saf-app).')
param appSlug string

@description('Environment of the app (record set metadata saf-env).')
param environmentName string

@description('CNAME record set, relative to the zone (naming.dnsRelativeRecordName of the host).')
param hostRecordName string

@description('TXT record set, relative to the zone (naming.dnsRelativeRecordName of naming.frontDoorValidationRecord).')
param validationRecordName string

@description('The custom domain\'s validationProperties.validationToken.')
param validationToken string

@description('The endpoint\'s host name (CNAME target).')
param endpointHostName string

// One hour, as for every record the platform writes.
var ttl = 3600

// The platform's mark on every record set it writes (ADR-0052). Record set metadata is a string map
// (RecordSetProperties.metadata, DNS API 2018-05-01).
var ownership = {
  'saf-app': appSlug
  'saf-env': environmentName
}

resource zone 'Microsoft.Network/dnsZones@2018-05-01' existing = {
  name: zoneName
}

resource validation 'Microsoft.Network/dnsZones/TXT@2018-05-01' = {
  parent: zone
  name: validationRecordName
  properties: {
    TTL: ttl
    metadata: ownership
    TXTRecords: [
      {
        value: [
          validationToken
        ]
      }
    ]
  }
}

resource cname 'Microsoft.Network/dnsZones/CNAME@2018-05-01' = {
  parent: zone
  name: hostRecordName
  properties: {
    TTL: ttl
    metadata: ownership
    CNAMERecord: {
      cname: endpointHostName
    }
  }
}

output txtRecordId string = validation.id
output cnameRecordId string = cname.id
