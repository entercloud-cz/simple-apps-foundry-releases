// Naming module (ADR-0020, docs/architecture/overview.md#naming).
//
// Every Azure, Entra and Azure DevOps name the platform creates is computed here, and nowhere
// else (lessons-from-v1: "Names are computed in exactly one place"). Templates import the
// functions they need:
//
//   import { appResourceGroup, containerApp } from '../modules/naming/naming.bicep'
//
// Inputs (all immutable once used):
//   prefix  instance prefix, 2-8, ^[a-z][a-z0-9]{1,7}$
//   env     environment name, 2-8, ^[a-z][a-z0-9]{1,7}$
//   slug    app slug, 3-20, ^[a-z](-?[a-z0-9])+$, not platform/portal, never containing
//           microsoft or windows
//   jobKey  2-6, ^[a-z][a-z0-9]{1,5}$
//   incarnation  app.yaml incarnation, integer >= 0 (ADR-0061): only the Entra registration's uniqueName
//   mode    network mode id: externalOnly | externalHybrid | internalOnly. The network-name
//           functions (virtualNetwork, subnet, networkSecurityGroup, natGateway,
//           natGatewayPublicIp) also take the token `portal` for the portal VNet of the portal
//           host environment (portal.bicep, ADR-0025); every other function rejects it.
//
// Guards: every input is validated and every name is length-checked. A violation calls
// fail(), which the deployment engine evaluates during template validation, so a bad input
// stops the deployment before anything is created (also shown by `bicep snapshot`, see
// infra/tests/check-naming.py). Bicep has no regex; the checks are written with lambdas.
//
// Hashes:
//   h6 = take(uniqueString(subscriptionId, rgName, string(generation)), 6)   app resources
//   h5 = take(uniqueString(subscriptionId, platformRgId, 'envvault', v, string(vaultGeneration)), 5)
//        environment Key Vaults, v = p (public) | n (private)
//   h6 = take(uniqueString(subscriptionId, platformRgName, 'platformregistry'), 6)   platform registry
//   h6 = take(uniqueString(subscriptionId, portalRgName, 'portaldb'), 6)              portal PostgreSQL server
// Hash values are never typed by hand; consumers read names from this module or from
// recorded deployment outputs.

// ------------------------------------------------------------------------------------------
// Character sets and guards (not exported)
// ------------------------------------------------------------------------------------------

func lowerLetters() string => 'abcdefghijklmnopqrstuvwxyz'

func lowerAlnum() string => '${lowerLetters()}0123456789'

func charsOf(value string) string[] => map(range(0, length(value)), i => substring(value, i, 1))

func onlyChars(value string, allowed string) bool => empty(filter(charsOf(value), c => !contains(allowed, c)))

func startsWithLetter(value string) bool => !empty(value) && contains(lowerLetters(), first(value))

func isShortToken(value string, minLength int, maxLength int) bool => length(value) >= minLength && length(value) <= maxLength && startsWithLetter(value) && onlyChars(value, lowerAlnum())

func hasSlugShape(value string) bool => length(value) >= 3 && length(value) <= 20 && startsWithLetter(value) && onlyChars(value, '${lowerAlnum()}-')

func hasSlugHyphens(value string) bool => !endsWith(value, '-') && !contains(value, '--')

func isReservedSlug(value string) bool => contains(['platform', 'portal'], value) || contains(value, 'microsoft') || contains(value, 'windows')

func isSlug(value string) bool => hasSlugShape(value) && hasSlugHyphens(value) && !isReservedSlug(value)

func p(prefix string) string =>
  isShortToken(prefix, 2, 8) ? prefix : fail('naming: invalid instance prefix "${prefix}" (2-8 characters, ^[a-z][a-z0-9]{1,7}$, ADR-0020).')

func e(env string) string =>
  isShortToken(env, 2, 8) ? env : fail('naming: invalid environment name "${env}" (2-8 characters, ^[a-z][a-z0-9]{1,7}$, ADR-0020).')

func s(slug string) string =>
  isSlug(slug)
    ? slug
    : fail('naming: invalid app slug "${slug}" (3-20 characters, ^[a-z](-?[a-z0-9])+$, not platform/portal, no microsoft/windows, ADR-0020).')

func j(jobKey string) string =>
  isShortToken(jobKey, 2, 6) ? jobKey : fail('naming: invalid job key "${jobKey}" (2-6 characters, ^[a-z][a-z0-9]{1,5}$, ADR-0020).')

func gen(generation int) string =>
  generation >= 0 ? string(generation) : fail('naming: generation must be >= 0, got ${generation}.')

func inc(incarnation int) int =>
  incarnation >= 0 ? incarnation : fail('naming: incarnation must be >= 0, got ${incarnation}.')

// Length guards, one per limit. The deployment engine's recursion guard rejects a function
// whose arguments (evaluated lazily) call the same function again, even without a real cycle
// (e.g. fit... appResourceGroup(...) ...(... appResourceGroup(...) ..) when appResourceGroup also used fit). So each limit
// has its own guard, and a name built from another name never uses the same guard as that name.

func fit12(name string) string => length(name) <= 12 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 12.')

func fit24(name string) string => length(name) <= 24 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 24.')

func fit31(name string) string => length(name) <= 31 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 31.')

func fit32(name string) string => length(name) <= 32 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 32.')

func fit46(name string) string => length(name) <= 46 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 46.')

func fit50(name string) string => length(name) <= 50 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 50.')

func fit63(name string) string => length(name) <= 63 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 63.')

func fit64(name string) string => length(name) <= 64 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 64.')

func fit80(name string) string => length(name) <= 80 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 80.')

func fit90(name string) string => length(name) <= 90 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 90.')

func fit120(name string) string => length(name) <= 120 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 120.')

func fit127(name string) string => length(name) <= 127 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 127.')

func fit128(name string) string => length(name) <= 128 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 128.')

func fit253(name string) string => length(name) <= 253 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 253.')

func fit256(name string) string => length(name) <= 256 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 256.')

func fit260(name string) string => length(name) <= 260 ? name : fail('naming: "${name}" is ${length(name)} characters, limit 260.')

// ------------------------------------------------------------------------------------------
// Shared building blocks
// ------------------------------------------------------------------------------------------

@export()
@description('Network mode id to its name segment: externalOnly -> ext, externalHybrid -> hyb, internalOnly -> int.')
func modeAbbreviation(mode string) string =>
  mode == 'externalOnly'
    ? 'ext'
    : mode == 'externalHybrid'
        ? 'hyb'
        : mode == 'internalOnly' ? 'int' : fail('naming: unknown network mode "${mode}".')

// Name segment of a platform-created network resource: a network mode's abbreviation, or
// `portal` for the portal VNet (portal.bicep). Not exported: only the network-name functions
// below accept the portal token; CAEs, jobs, peerings and DNS resource groups don't.
func networkSegment(mode string) string => mode == 'portal' ? 'portal' : modeAbbreviation(mode)

@export()
@description('Slug without hyphens (used in names that allow alphanumerics only).')
func slugCompact(slug string) string => replace(s(slug), '-', '')

@export()
@description('h6 hash of globally unique app resource names: take(uniqueString(subscriptionId, rgName, string(generation)), 6).')
func hash6(subscriptionId string, resourceGroupName string, generation int) string =>
  take(uniqueString(subscriptionId, resourceGroupName, gen(generation)), 6)

@export()
@description('Environment vault variant letter: public -> p, private -> n (network-isolated).')
func vaultVariantLetter(variant string) string =>
  variant == 'public' ? 'p' : variant == 'private' ? 'n' : fail('naming: unknown environment vault variant "${variant}".')

@export()
@description('h5 hash of an environment Key Vault: take(uniqueString(subscriptionId, platformRgId, \'envvault\', v, string(vaultGeneration)), 5).')
func hash5EnvironmentVault(subscriptionId string, platformResourceGroupId string, variant string, vaultGeneration int) string =>
  take(uniqueString(subscriptionId, platformResourceGroupId, 'envvault', vaultVariantLetter(variant), gen(vaultGeneration)), 5)

// ------------------------------------------------------------------------------------------
// Platform environment (per environment, per network mode)
// ------------------------------------------------------------------------------------------

@export()
@description('Platform resource group of an environment: rg-{prefix}-platform-{env}.')
func platformResourceGroup(prefix string, env string) string => fit90('rg-${p(prefix)}-platform-${e(env)}')

@export()
@description('Resource group holding the private DNS zones of one VNet-based mode: rg-{prefix}-dns-{mode}-{env}. Zones are kept per VNet and same-named zones must live in different resource groups (network-modes.md). Not in ADR-0020 yet.')
func privateDnsResourceGroup(prefix string, mode string, env string) string =>
  fit90('rg-${p(prefix)}-dns-${modeAbbreviation(mode)}-${e(env)}')

@export()
@description('Log Analytics workspace of an environment: log-{prefix}-{env}.')
func logAnalyticsWorkspace(prefix string, env string) string => fit63('log-${p(prefix)}-${e(env)}')

@export()
@description('Environment action group (platform team): ag-{prefix}-platform-{env}. Not in ADR-0020 yet.')
func platformActionGroup(prefix string, env string) string => fit260('ag-${p(prefix)}-platform-${e(env)}')

@export()
@description('Short name (max 12) of the environment action group: p-{prefix<=5}-{env<=4}.')
func platformActionGroupShortName(prefix string, env string) string => fit12('p-${take(p(prefix), 5)}-${take(e(env), 4)}')

@export()
@description('Diagnostic setting name used on every platform-created resource: diag-{prefix}-{env}. Not in ADR-0020 yet.')
func diagnosticSetting(prefix string, env string) string => fit260('diag-${p(prefix)}-${e(env)}')

@export()
@description('Container Apps environment of a network mode: cae-{prefix}-{mode}-{env}.')
func managedEnvironment(prefix string, mode string, env string) string =>
  fit32('cae-${p(prefix)}-${modeAbbreviation(mode)}-${e(env)}')

// Capacity cells (ADR-0053): a cell is one CAE of a network mode with its platform jobs and, in a
// VNet-based mode, its CAE subnet. Cell 01 keeps the names above, so no existing resource moves; a
// later cell gets the suffix -c{cell}. Not exported: the cell functions below are.
func cellId(cell string) string =>
  length(cell) == 2 && onlyChars(cell, '0123456789') && cell != '00'
    ? cell
    : fail('naming: invalid cell id "${cell}" (two digits, 01 to 99, ADR-0053).')

func cellSuffix(cell string) string => cellId(cell) == '01' ? '' : '-c${cell}'

@export()
@description('Container Apps environment of a capacity cell (ADR-0053): cell 01 = cae-{prefix}-{mode}-{env} (managedEnvironment), a later cell cae-{prefix}-{mode}-{env}-c{cell}.')
func cellManagedEnvironment(prefix string, mode string, env string, cell string) string =>
  fit32('cae-${p(prefix)}-${modeAbbreviation(mode)}-${e(env)}${cellSuffix(cell)}')

@export()
@description('CAE subnet of a capacity cell in a VNet-based mode (ADR-0053): cell 01 = snet-{prefix}-cae-{mode}-{env} (subnet), a later cell snet-{prefix}-cae-{mode}-{env}-c{cell}. Network modes only, not the portal.')
func cellCaeSubnet(prefix string, mode string, env string, cell string) string =>
  fit80('snet-${p(prefix)}-cae-${modeAbbreviation(mode)}-${e(env)}${cellSuffix(cell)}')

@export()
@description('NSG of a capacity cell\'s CAE subnet (ADR-0053): cell 01 = nsg-{prefix}-cae-{mode}-{env} (networkSecurityGroup), a later cell nsg-{prefix}-cae-{mode}-{env}-c{cell}.')
func cellCaeNetworkSecurityGroup(prefix string, mode string, env string, cell string) string =>
  fit80('nsg-${p(prefix)}-cae-${modeAbbreviation(mode)}-${e(env)}${cellSuffix(cell)}')

@export()
@description('Platform job of a capacity cell (ADR-0053): cell 01 = caj-{prefix}-{step}-{mode} (platformJob), a later cell caj-{prefix}-{step}-{mode}-c{cell}.')
func cellPlatformJob(prefix string, step string, mode string, cell string) string =>
  fit31('caj-${p(prefix)}-${j(step)}-${modeAbbreviation(mode)}${cellSuffix(cell)}')

@export()
@description('Portal Container Apps environment: cae-{prefix}-portal-{env}.')
func portalManagedEnvironment(prefix string, env string) string => fit32('cae-${p(prefix)}-portal-${e(env)}')

@export()
@description('Portal resource group in the portal host environment (portal.bicep, ADR-0036): rg-{prefix}-portal-{env}. Holds the portal VNet, NAT Gateway, its own privatelink.vaultcore.azure.net zone, the portal CAE and Container App, and later the portal-side private endpoints (ADR-0025).')
func portalResourceGroup(prefix string, env string) string => fit90('rg-${p(prefix)}-portal-${e(env)}')

@export()
@description('Portal PostgreSQL Flexible Server (portal.bicep, ADR-0038), in the portal RG: pgsql-{prefix}-portal-{env}-{h6}, h6 = take(uniqueString(subscriptionId, portalRgName, \'portaldb\'), 6). Same pattern as the app servers pgsql-{prefix}-{slug}-{env}-{h6}, never equal to one (the slug `portal` is reserved). Its private endpoint is pep-{serverName} (privateEndpoint), as for app servers: it is the server\'s own endpoint, not a second, portal-side one (pep-{targetName}-portal, ADR-0025).')
func portalPostgresServer(prefix string, env string, subscriptionId string) string =>
  fit63('pgsql-${p(prefix)}-portal-${e(env)}-${take(uniqueString(subscriptionId, portalResourceGroup(prefix, env), 'portaldb'), 6)}')

@export()
@description('Database of the portal inside its PostgreSQL server (ADR-0038): portal.')
func portalPostgresDatabase() string => 'portal'

@export()
@description('Portal Container App (ADR-0036): ca-{prefix}-portal, no environment (like ca-{slug}). Never equal to an app\'s ca-{slug} in the same CAE: apps never run in the portal CAE, and the slug `portal` is reserved.')
func portalContainerApp(prefix string) string => fit31('ca-${p(prefix)}-portal')

@export()
@description('Spoke VNet of a VNet-based mode (platform-created): vnet-{prefix}-{mode}-{env}; mode `portal` = the portal VNet vnet-{prefix}-portal-{env} (portal.bicep).')
func virtualNetwork(prefix string, mode string, env string) string =>
  fit64('vnet-${p(prefix)}-${networkSegment(mode)}-${e(env)}')

@export()
@description('Subnet: snet-{prefix}-{purpose}-{mode}-{env}, purpose = cae | pep; mode `portal` for the portal VNet.')
func subnet(prefix string, purpose string, mode string, env string) string =>
  contains(['cae', 'pep'], purpose)
    ? fit80('snet-${p(prefix)}-${purpose}-${networkSegment(mode)}-${e(env)}')
    : fail('naming: subnet purpose must be cae or pep, got "${purpose}".')

@export()
@description('NSG of a subnet: nsg-{prefix}-{purpose}-{mode}-{env}, purpose = cae | pep; mode `portal` for the portal VNet.')
func networkSecurityGroup(prefix string, purpose string, mode string, env string) string =>
  contains(['cae', 'pep'], purpose)
    ? fit80('nsg-${p(prefix)}-${purpose}-${networkSegment(mode)}-${e(env)}')
    : fail('naming: NSG purpose must be cae or pep, got "${purpose}".')

@export()
@description('NAT Gateway (External only, network vnet; the portal VNet with mode `portal`): ng-{prefix}-{mode}-{env}.')
func natGateway(prefix string, mode string, env string) string => fit80('ng-${p(prefix)}-${networkSegment(mode)}-${e(env)}')

@export()
@description('Public IP of a NAT Gateway: pip-{prefix}-ng-{mode}-{env}-{nn}, nn = 01..16; mode `portal` for the portal NAT Gateway.')
func natGatewayPublicIp(prefix string, mode string, env string, ordinal int) string =>
  ordinal >= 1 && ordinal <= 16
    ? fit80('pip-${p(prefix)}-ng-${networkSegment(mode)}-${e(env)}-${padLeft(string(ordinal), 2, '0')}')
    : fail('naming: NAT public IP ordinal must be 1-16, got ${ordinal}.')

@export()
@description('Spoke-to-hub peering (externalHybrid with vnet.create): peer-{prefix}-{mode}-{env}-to-hub.')
func hubPeering(prefix string, mode string, env string) string =>
  fit80('peer-${p(prefix)}-${modeAbbreviation(mode)}-${e(env)}-to-hub')

@export()
@description('Private DNS zone link of a spoke VNet: link-{vnetName}.')
func privateDnsZoneLink(vnetName string) string => fit80('link-${vnetName}')

@export()
@description('Private DNS zone of a private-endpoint service: vault | postgres | sql | blob (Azure-dictated names, public cloud; suffixes from environment() where it has them).')
func privateDnsZone(service string) string =>
  service == 'vault'
    ? 'privatelink.vaultcore.azure.net'
    : service == 'postgres'
        ? 'privatelink.postgres.database.azure.com'
        : service == 'sql'
            ? 'privatelink${environment().suffixes.sqlServerHostname}'
            : service == 'blob' ? 'privatelink.blob.${environment().suffixes.storage}' : fail('naming: unknown private DNS zone service "${service}".')

@export()
@description('Environment Key Vault: kv{prefix}{env}{v}{h5}, v = p (public, managed network) | n (private, VNet-based). Pass the platform RG resource ID (/subscriptions/{sub}/resourceGroups/{rg}).')
func environmentKeyVault(prefix string, env string, variant string, subscriptionId string, platformResourceGroupId string, vaultGeneration int) string =>
  fit24(
    'kv${p(prefix)}${e(env)}${vaultVariantLetter(variant)}${hash5EnvironmentVault(subscriptionId, platformResourceGroupId, variant, vaultGeneration)}'
  )

@export()
@description('Platform container registry of an environment (ADR-0035), in its platform RG: cr{prefix}{env}{h6}, h6 = take(uniqueString(subscriptionId, platformRgName, \'platformregistry\'), 6). Never equal to an app registry of the same prefix and environment (cr{prefix}{slugCompact}{env}{h6} is longer by the slug). Never build the login server from it; read properties.loginServer.')
func platformContainerRegistry(prefix string, env string, subscriptionId string) string =>
  fit50('cr${p(prefix)}${e(env)}${take(uniqueString(subscriptionId, platformResourceGroup(prefix, env), 'platformregistry'), 6)}')

@export()
@description('Platform job: caj-{prefix}-{step}-{mode}, step = dbinit | kvset | recov (job-key rule).')
func platformJob(prefix string, step string, mode string) string => fit31('caj-${p(prefix)}-${j(step)}-${modeAbbreviation(mode)}')

@export()
@description('Identity of a platform job step: id-{prefix}-{step}-{env}.')
func platformJobIdentity(prefix string, step string, env string) string => fit128('id-${p(prefix)}-${j(step)}-${e(env)}')

@export()
@description('Azure provisioning identity of an environment: id-{prefix}-provisioning-{env}.')
func provisioningIdentity(prefix string, env string) string => fit128('id-${p(prefix)}-provisioning-${e(env)}')

@export()
@description('Instance-wide platform identities: purpose = entra-provisioning | ado-automation | portal.')
func instanceIdentity(prefix string, purpose string) string =>
  contains(['entra-provisioning', 'ado-automation', 'portal'], purpose)
    ? fit128('id-${p(prefix)}-${purpose}')
    : fail('naming: unknown instance identity purpose "${purpose}".')

@export()
@description('Resource group of the platform identities in an environment subscription (bootstrap.bicep, ADR-0031): rg-{prefix}-identities-{env}.')
func identitiesResourceGroup(prefix string, env string) string => fit90('rg-${p(prefix)}-identities-${e(env)}')

@export()
@description('ReadOnly lock on the identities resource group (bootstrap.bicep): lock-{prefix}-identities-readonly.')
func identitiesLock(prefix string) string => fit90('lock-${p(prefix)}-identities-readonly')

@export()
@description('The instance\'s resource group of Entra deployments in the portal host environment\'s subscription (bootstrap.bicep): rg-{prefix}-entra. Holds no resources, only deployment records: entra-permissions, entra-portal-{env} and the app records entra-{slug}-{env} deployed before ADR-0063 (read until each moves to its environment\'s group, entraEnvironmentResourceGroup). Not in ADR-0020 yet.')
func entraResourceGroup(prefix string) string => fit90('rg-${p(prefix)}-entra')

@export()
@description('Resource group of one environment\'s Entra deployment records in the portal host environment\'s subscription (bootstrap.bicep, ADR-0063): rg-{prefix}-entra-{env}. Holds no resources, only the records entra-{slug}-{env} of that environment\'s app registrations. Never equal to rg-{prefix}-entra (one segment more) or to an app or platform resource group (their second segment is app, platform, portal, identities or dns).')
func entraEnvironmentResourceGroup(prefix string, env string) string => fit90('rg-${p(prefix)}-entra-${e(env)}')

@export()
@description('Log search alert on the Entra audit log for the Entra provisioning identity (entra-audit-alert.bicep, ADR-0023): alert-{prefix}-entra-{check}, check = tier0 | consent. Not in ADR-0020 yet.')
func entraAuditAlert(prefix string, check string) string =>
  contains(['tier0', 'consent'], check)
    ? fit260('alert-${p(prefix)}-entra-${check}')
    : fail('naming: unknown Entra audit check "${check}".')

@export()
@description('Backup vault (opt-in vaulted blob backup): bvault-{prefix}-{env}.')
func backupVault(prefix string, env string) string => fit50('bvault-${p(prefix)}-${e(env)}')

// ------------------------------------------------------------------------------------------
// Front Door (managed mode, one profile per environment)
// ------------------------------------------------------------------------------------------

@export()
@description('Front Door profile: afd-{prefix}-{env}.')
func frontDoorProfile(prefix string, env string) string => fit260('afd-${p(prefix)}-${e(env)}')

@export()
@description('Front Door endpoint: fde-{prefix}-{env}. The host name Azure generates is read from the resource.')
func frontDoorEndpoint(prefix string, env string) string => fit46('fde-${p(prefix)}-${e(env)}')

@export()
@description('Front Door WAF policy: waf{prefix}{env} (alphanumeric only).')
func frontDoorWafPolicy(prefix string, env string) string => fit128('waf${p(prefix)}${e(env)}')

@export()
@description('Front Door security policy binding the WAF policy to the endpoint: secp-{prefix}-{env}.')
func frontDoorSecurityPolicy(prefix string, env string) string => fit260('secp-${p(prefix)}-${e(env)}')

@export()
@description('Front Door origin group of an app: og-{slug}-{env}.')
func frontDoorOriginGroup(slug string, env string) string => fit90('og-${s(slug)}-${e(env)}')

@export()
@description('Front Door origin of an app: orig-{slug}-{env}.')
func frontDoorOrigin(slug string, env string) string => fit90('orig-${s(slug)}-${e(env)}')

@export()
@description('Front Door route of an app: route-{slug}-{env}.')
func frontDoorRoute(slug string, env string) string => fit90('route-${s(slug)}-${e(env)}')

@export()
@description('Front Door custom domain: cd-{host with dots replaced by hyphens}.')
func frontDoorCustomDomain(hostName string) string => fit260('cd-${replace(toLower(hostName), '.', '-')}')

@export()
@description('Front Door domain validation TXT record of a custom domain (name dictated by Front Door): _dnsauth.{host}.')
func frontDoorValidationRecord(hostName string) string => fit253('_dnsauth.${toLower(hostName)}')

@export()
@description('Record set name relative to its public DNS zone: the FQDN without .{zone}. Fails when the FQDN is not below the zone; the zone apex is not supported (a CNAME can\'t sit there).')
func dnsRelativeRecordName(fqdn string, zoneName string) string =>
  endsWith(toLower(fqdn), '.${toLower(zoneName)}') && length(fqdn) > length(zoneName) + 1
    ? substring(toLower(fqdn), 0, length(fqdn) - length(zoneName) - 1)
    : fail('naming: "${fqdn}" is not below the DNS zone "${zoneName}" (records at the zone apex are not supported).')

// ------------------------------------------------------------------------------------------
// App landing zone (per app x environment)
// ------------------------------------------------------------------------------------------

@export()
@description('App resource group: rg-{prefix}-app-{slug}-{env}.')
func appResourceGroup(prefix string, slug string, env string) string => fit90('rg-${p(prefix)}-app-${s(slug)}-${e(env)}')

@export()
@description('Container App: ca-{slug} (no environment, ADR-0020).')
func containerApp(slug string) string => fit31('ca-${s(slug)}')

@export()
@description('Container Apps Job of an app: caj-{slug}-{jobKey}.')
func containerAppJob(slug string, jobKey string) string => fit31('caj-${s(slug)}-${j(jobKey)}')

@export()
@description('Runtime identity: id-{prefix}-{slug}-run-{env}.')
func runtimeIdentity(prefix string, slug string, env string) string => fit128('id-${p(prefix)}-${s(slug)}-run-${e(env)}')

@export()
@description('Delivery identity: id-{prefix}-{slug}-deploy-{env}.')
func deliveryIdentity(prefix string, slug string, env string) string => fit128('id-${p(prefix)}-${s(slug)}-deploy-${e(env)}')

@export()
@description('Easy Auth identity: id-{prefix}-{slug}-auth-{env}.')
func easyAuthIdentity(prefix string, slug string, env string) string => fit128('id-${p(prefix)}-${s(slug)}-auth-${e(env)}')

@export()
@description('Federated credential of the delivery identity (ADO service connection): fic-ado-{slug}-{env}.')
func deliveryFederatedCredential(slug string, env string) string => fit120('fic-ado-${s(slug)}-${e(env)}')

@export()
@description('App container registry: cr{prefix}{slugCompact}{env}{h6}. Never build the login server from it; read properties.loginServer.')
func containerRegistry(prefix string, slug string, env string, subscriptionId string, generation int) string =>
  fit50(
    'cr${p(prefix)}${slugCompact(slug)}${e(env)}${hash6(subscriptionId, appResourceGroup(prefix, slug, env), generation)}'
  )

@export()
@description('App Key Vault: kv{take(slugCompact,16)}{h6}.')
func appKeyVault(prefix string, slug string, env string, subscriptionId string, generation int) string =>
  fit24('kv${take(slugCompact(slug), 16)}${hash6(subscriptionId, appResourceGroup(prefix, slug, env), generation)}')

@export()
@description('App storage account: st{take(slugCompact,16)}{h6}.')
func storageAccount(prefix string, slug string, env string, subscriptionId string, generation int) string =>
  fit24('st${take(slugCompact(slug), 16)}${hash6(subscriptionId, appResourceGroup(prefix, slug, env), generation)}')

@export()
@description('PostgreSQL Flexible Server: pgsql-{prefix}-{slug}-{env}-{h6}.')
func postgresServer(prefix string, slug string, env string, subscriptionId string, generation int) string =>
  fit63(
    'pgsql-${p(prefix)}-${s(slug)}-${e(env)}-${hash6(subscriptionId, appResourceGroup(prefix, slug, env), generation)}'
  )

@export()
@description('Database name inside the app PostgreSQL server: the slug with hyphens replaced by underscores (not in ADR-0020 yet).')
func postgresDatabase(slug string) string => fit63(replace(s(slug), '-', '_'))

@export()
@description('Azure SQL logical server: sql-{prefix}-{slug}-{env}-{h6}.')
func sqlServer(prefix string, slug string, env string, subscriptionId string, generation int) string =>
  fit63(
    'sql-${p(prefix)}-${s(slug)}-${e(env)}-${hash6(subscriptionId, appResourceGroup(prefix, slug, env), generation)}'
  )

@export()
@description('Azure SQL database: sqldb-{slug}.')
func sqlDatabase(slug string) string => fit128('sqldb-${s(slug)}')

@export()
@description('Private endpoint: pep-{targetName}[-{groupId}]. Pass groupId only for targets with several sub-resources (storage: blob); Key Vault, PostgreSQL and SQL endpoints use pep-{targetName}, because pep-{pgsqlName}-postgresqlServer would exceed 64 characters.')
func privateEndpoint(targetName string, groupId string) string =>
  fit64(empty(groupId) ? 'pep-${targetName}' : 'pep-${targetName}-${groupId}')

@export()
@description('Private endpoint of a shared environment resource in one VNet-based spoke: pep-{targetName}-{mode}. The private environment vault has one endpoint per spoke in the same RG. Not in ADR-0020 yet.')
func spokePrivateEndpoint(targetName string, mode string) string => fit64('pep-${targetName}-${modeAbbreviation(mode)}')

@export()
@description('Portal-side private endpoint of an app vault (ADR-0025): pep-{targetName}-portal.')
func portalPrivateEndpoint(targetName string) string => fit64('pep-${targetName}-portal')

@export()
@description('Network interface of a private endpoint: nic-{privateEndpointName}.')
func privateEndpointNic(privateEndpointName string) string => fit80('nic-${privateEndpointName}')

@export()
@description('Application Insights: appi-{slug}-{env}.')
func applicationInsights(slug string, env string) string => fit260('appi-${s(slug)}-${e(env)}')

@export()
@description('App action group: ag-{slug}-{env}.')
func actionGroup(slug string, env string) string => fit260('ag-${s(slug)}-${e(env)}')

@export()
@description('Short name (max 12) of the app action group: {take(slugCompact,7)}-{take(env,4)}.')
func actionGroupShortName(slug string, env string) string => fit12('${take(slugCompact(slug), 7)}-${take(e(env), 4)}')

@export()
@description('Metric alert of an app: alert-{slug}-{alertKey}-{env}, alertKey = restarts | http5xx | latency | replicas | pgcredits. Not in ADR-0020 yet.')
func metricAlert(slug string, alertKey string, env string) string =>
  contains(['restarts', 'http5xx', 'latency', 'replicas', 'pgcredits'], alertKey)
    ? fit260('alert-${s(slug)}-${alertKey}-${e(env)}')
    : fail('naming: unknown alert key "${alertKey}".')

@export()
@description('App budget (RG scope): budget-{slug}-{env}.')
func budget(slug string, env string) string => fit63('budget-${s(slug)}-${e(env)}')

@export()
@description('ACR repository of an app: the slug.')
func registryRepository(slug string) string => s(slug)

@export()
@description('Name of the Easy Auth client secret in the environment Key Vault: easyauth-{slug}.')
func easyAuthSecret(slug string) string => fit127('easyauth-${s(slug)}')

// ------------------------------------------------------------------------------------------
// Deployments, Entra, Azure DevOps
// ------------------------------------------------------------------------------------------

@export()
@description('Subscription-scope provisioning deployment of a landing zone: lz-{slug}-{env}.')
func provisioningDeployment(slug string, env string) string => fit64('lz-${s(slug)}-${e(env)}')

@export()
@description('Release deployment at the app RG (fixed name): release-{slug}.')
func releaseDeployment(slug string) string => fit64('release-${s(slug)}')

@export()
@description('Front Door deployment of one app (infra/app/frontdoor.bicep, ADR-0010 amended 2026-11-01), in the environment\'s platform RG: fd-{slug}-{env}.')
func frontDoorDeployment(slug string, env string) string => fit64('fd-${s(slug)}-${e(env)}')

@export()
@description('Entra app registration deployment (Graph Bicep, entra stage): entra-{slug}-{env}. Not in ADR-0020 yet.')
func entraDeployment(slug string, env string) string => fit64('entra-${s(slug)}-${e(env)}')

@export()
@description('Platform environment deployment (subscription scope): platform-{prefix}-{env}. Not in ADR-0020 yet.')
func platformDeployment(prefix string, env string) string => fit64('platform-${p(prefix)}-${e(env)}')

@export()
@description('Portal deployment (portal.bicep, subscription scope of the portal host environment): portal-{prefix}-{env}.')
func portalDeployment(prefix string, env string) string => fit64('portal-${p(prefix)}-${e(env)}')

@export()
@description('Deployment of the portal-side private endpoint of one app vault (infra/app/portal-vault-endpoint.bicep, ADR-0025), in the portal resource group of the portal host environment: pep-portal-{slug}-{env}, env = the vault\'s environment. Never equal to portal-{prefix}-{env} (portalDeployment) or another app\'s (slugs and environment names are checked tokens).')
func portalEndpointDeployment(slug string, env string) string => fit64('pep-portal-${s(slug)}-${e(env)}')

@export()
@description('Entra app registration uniqueName (immutable in Entra, and kept by a deleted application for 30 days): {prefix}-{slug}-{env} for incarnation 0 (app.yaml incarnation, ADR-0061), {prefix}-{slug}-{env}--i{incarnation} above it, so a new app with a deleted app\'s slug gets its own registration. Injective: prefix and env have no hyphen and a slug never contains --.')
func entraApplicationUniqueName(prefix string, slug string, env string, incarnation int) string =>
  inc(incarnation) == 0 ? '${p(prefix)}-${s(slug)}-${e(env)}' : '${p(prefix)}-${s(slug)}-${e(env)}--i${inc(incarnation)}'

@export()
@description('Entra app registration uniqueName of the portal (portal-registration.bicep, ADR-0036): {prefix}-portal-{env}, env = portal.hostEnvironment. Never equal to an app\'s {prefix}-{slug}-{env}: the slug `portal` is reserved and environment names have no hyphen.')
func portalEntraApplicationUniqueName(prefix string, env string) string => '${p(prefix)}-portal-${e(env)}'

@export()
@description('Deployment of the portal registration (portal-registration.bicep) in rg-{prefix}-entra: entra-portal-{env}. Never equal to an app\'s entra-{slug}-{env} (reserved slug, no hyphen in environment names).')
func portalEntraDeployment(env string) string => fit64('entra-portal-${e(env)}')

@export()
@description('Entra app registration display name: app title, plus " ({env})" on non-prod-kind environments.')
func entraApplicationDisplayName(appTitle string, env string, environmentKind string) string =>
  fit256(environmentKind == 'prod' ? appTitle : '${appTitle} (${e(env)})')

@export()
@description('Azure DevOps service connection of an app environment: sc-{slug}-{env}.')
func adoServiceConnection(slug string, env string) string => 'sc-${s(slug)}-${e(env)}'

@export()
@description('Platform service connection of an environment\'s provisioning identity: sc-platform-provisioning-{env}. Also the name of that identity\'s federated credential.')
func provisioningServiceConnection(env string) string => fit120('sc-platform-provisioning-${e(env)}')

@export()
@description('Platform service connection of an instance identity: purpose = ado | entra -> sc-platform-ado | sc-platform-entra. Also the name of that identity\'s federated credential.')
func instanceServiceConnection(purpose string) string =>
  contains(['ado', 'entra'], purpose)
    ? 'sc-platform-${purpose}'
    : fail('naming: unknown instance service connection purpose "${purpose}".')

@export()
@description('Azure DevOps environment of an app: {slug}-{env}.')
func adoEnvironment(slug string, env string) string => '${s(slug)}-${e(env)}'

@export()
@description('Azure DevOps delivery pipeline (folder \\apps): delivery-{slug}.')
func adoDeliveryPipeline(slug string) string => 'delivery-${s(slug)}'

@export()
@description('Azure DevOps platform pipeline of an environment (folder \\platform, ADR-0043): platform-{env}.')
func adoPlatformPipeline(env string) string => 'platform-${e(env)}'

@export()
@description('Azure DevOps environment carrying the Approval of an environment\'s platform pipeline (ADR-0043): platform-{env}. Never equal to an app\'s {slug}-{env}: the slug `platform` is reserved and environment names have no hyphen.')
func adoPlatformEnvironment(env string) string => 'platform-${e(env)}'

// ------------------------------------------------------------------------------------------
// Custom role definitions (ADR-0021; Entra Deployment Operator: ADR-0033; Platform Job Secret
// Writer: ADR-0035), one definition per instance
// ------------------------------------------------------------------------------------------

@export()
@description('Role name of the App Deployer custom role: App Deployer ({prefix}).')
func appDeployerRoleName(prefix string) string => 'App Deployer (${p(prefix)})'

@export()
@description('Role name of the App Environment Joiner custom role: App Environment Joiner ({prefix}).')
func appEnvironmentJoinerRoleName(prefix string) string => 'App Environment Joiner (${p(prefix)})'

@export()
@description('Role name of the Entra Deployment Operator custom role (bootstrap.bicep, assignable only at rg-{prefix}-entra): Entra Deployment Operator ({prefix}).')
func entraDeploymentOperatorRoleName(prefix string) string => 'Entra Deployment Operator (${p(prefix)})'

@export()
@description('Role name of the Platform Job Secret Writer custom role (roles.bicep, assigned only to the Entra provisioning identity on each kvset job): Platform Job Secret Writer ({prefix}).')
func platformJobSecretWriterRoleName(prefix string) string => 'Platform Job Secret Writer (${p(prefix)})'

@export()
@description('Deterministic GUID (role definition name) of a custom role, seeded with tenant and prefix: role = app-deployer | app-environment-joiner | entra-deployment-operator | platform-job-secret-writer.')
func customRoleDefinitionGuid(tenantId string, prefix string, role string) string =>
  contains(['app-deployer', 'app-environment-joiner', 'entra-deployment-operator', 'platform-job-secret-writer'], role)
    ? guid(tenantId, p(prefix), 'saf-custom-role', role)
    : fail('naming: unknown custom role "${role}".')
