// Test fixture of check-infra.py (ADR-0052, app availability isolation): the fictional app
// `hotelinventory`, a second app in the same Contoso environment as the example
// infra/app/examples/hotel-inventory-nonprod.frontdoor.bicepparam, with confusable inputs: the slug
// without its hyphen (the same compact slug, so registry, vault and storage names differ only by
// the app hash), and the host hotel-inventory.test.contoso.com, which gives the same custom-domain
// name cd-hotel-inventory-test-contoso-com as the example's hotel-inventory-test.contoso.com
// (platform validate app rejects such a pair: check front-door-domain-name).
// check-infra.py snapshots both apps and asserts that their writes outside their own resource
// groups are disjoint. Not an example to copy. Placeholder IDs only.
using '../../app/frontdoor.bicep'

param prefix = 'contoso'
param environmentName = 'nonprod'
param slug = 'hotelinventory'
param networkMode = 'externalOnly'
param cell = '01'
param hostName = 'hotel-inventory.test.contoso.com'
param dnsZoneId = '/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-dns/providers/Microsoft.Network/dnsZones/contoso.com'
param retainedHostName = ''
param retainedDnsZoneId = ''
