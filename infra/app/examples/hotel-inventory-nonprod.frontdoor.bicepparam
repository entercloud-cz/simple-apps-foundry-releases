// `hotel-inventory` on its own custom domain through Contoso's nonprod Front Door profile
// afd-contoso-nonprod (ADR-0010, amended 2026-11-01). Deploy into rg-contoso-platform-nonprod
// with the deployment name fd-hotel-inventory-nonprod (infra/README.md, runbook
// docs/runbooks/front-door-custom-domain.md).
//
// The zone contoso.com sits in the nonprod subscription here, so the template writes the
// _dnsauth TXT and the CNAME itself. A zone in another subscription (as in
// config/examples/instance.example.yaml) takes dnsZoneId = '' and records created by hand.
// Placeholder IDs only.
using '../frontdoor.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param slug = 'hotel-inventory'
param networkMode = 'externalOnly'
param cell = '01'
param hostName = 'hotel-inventory-test.contoso.com'
param dnsZoneId = '/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-dns/providers/Microsoft.Network/dnsZones/contoso.com'
param retainedHostName = ''
param retainedDnsZoneId = ''
