// Names the app delivery pipeline (pipelines/azure-devops/scripts/deploy.sh) and the provisioning
// pipeline (scripts/provisioning/prov-lib.sh) need. Not deployed: the jobs evaluate it offline with
//   bicep snapshot names.bicepparam --subscription-id <environment subscription> --location <region>
// and reads `outputs`, so delivery takes every name from naming.bicep too (ADR-0020, AGENTS.md
// rule 6). Called twice: without generation (resource group and release record), then with the
// generation from the release record (registry). Provisioning also reads the environment's Entra
// records group rg-{prefix}-entra-{env} and the instance's rg-{prefix}-entra (the records deployed
// before ADR-0063, read until each moves), the Entra application's uniqueName (with the app's
// incarnation, ADR-0061; null without it) and, for the Easy Auth secret check and hand-off,
// the platform resource group, the secret name and (with networkMode) the kvset job of the app's
// CAE: its ARM ID is /subscriptions/{environment subscription}/resourceGroups/
// {platformResourceGroup}/providers/Microsoft.App/jobs/{kvsetJob} (ADR-0035). For the portal-side
// private endpoint of the app vault (ADR-0025): the deployment pep-portal-{slug}-{env} and, with
// portalEnvironmentName (portal.hostEnvironment), the portal resource group; with vaultName, the
// endpoint's name pep-{vaultName}-portal. With networkMode, vaultGeneration and (for externalOnly)
// externalOnlyNetwork, the environment vault of that mode, named as landing-zone.bicep names it: the
// vault the app's Easy Auth secret belongs in for the mode app.yaml asks for, which differs from the
// landing-zone record's after a network mode change (ADR-0060). With networkMode and cell (the
// capacity cell, ADR-0053), the CAE of that mode and cell and its kvset and dbinit jobs: cell 01 keeps
// the names without a suffix (managedEnvironment, platformJob), a later cell gets -c{cell}; provisioning
// names the app's cell from app.yaml, and the source CAE of a move from the cell the live app runs in.
// With generation, also the app vault as the landing zone names it (appVault): after a failed landing
// zone, provisioning asks whether a soft-deleted vault holds that name (ADR-0064, US04.11).

targetScope = 'subscription'

import {
  adoEnvironment as nameAdoEnvironment
  adoServiceConnection as nameAdoServiceConnection
  appKeyVault as nameAppKeyVault
  appResourceGroup as nameAppResourceGroup
  cellManagedEnvironment as nameCellManagedEnvironment
  cellPlatformJob as nameCellPlatformJob
  containerApp as nameContainerApp
  containerRegistry as nameContainerRegistry
  deliveryIdentity as nameDeliveryIdentity
  easyAuthSecret as nameEasyAuthSecret
  entraApplicationUniqueName as nameEntraApplicationUniqueName
  environmentKeyVault as nameEnvironmentKeyVault
  entraDeployment as nameEntraDeployment
  entraEnvironmentResourceGroup as nameEntraEnvironmentResourceGroup
  entraResourceGroup as nameEntraResourceGroup
  frontDoorDeployment as nameFrontDoorDeployment
  platformResourceGroup as namePlatformResourceGroup
  portalEndpointDeployment as namePortalEndpointDeployment
  portalPrivateEndpoint as namePortalPrivateEndpoint
  portalResourceGroup as namePortalResourceGroup
  provisioningDeployment as nameProvisioningDeployment
  registryRepository as nameRegistryRepository
  releaseDeployment as nameReleaseDeployment
  runtimeIdentity as nameRuntimeIdentity
} from '../../modules/naming/naming.bicep'

@minLength(2)
@maxLength(8)
param prefix string

@minLength(3)
@maxLength(20)
param slug string

@minLength(2)
@maxLength(8)
param environmentName string

@description('App generation from the release record; null when only the resource group is needed.')
@minValue(0)
param generation int?

@description('app.yaml incarnation (ADR-0061, schema default 0 applied); null when the Entra uniqueName is not needed.')
@minValue(0)
param incarnation int?

@description('The app\'s network mode in this environment (apps/{slug}/app.yaml); null when the kvset job is not needed.')
param networkMode ('externalOnly' | 'externalHybrid')?

@description('The capacity cell (two digits, ADR-0053) whose CAE and jobs the outputs managedEnvironment, kvsetJob and dbinitJob name, with networkMode; null when they are not needed (they are null then).')
@minLength(2)
@maxLength(2)
param cell string?

@description('portal.hostEnvironment: the environment whose subscription holds the portal resource group; null when the portal names are not needed.')
@minLength(2)
@maxLength(8)
param portalEnvironmentName string?

@description('The app vault\'s name (landing-zone output appKeyVaultName); null when its portal-side endpoint name is not needed.')
@minLength(3)
@maxLength(24)
param vaultName string?

@description('environments[].vaultGeneration (instance.yaml, schema default applied); null when the environment vault is not needed.')
@minValue(0)
param vaultGeneration int?

@description('environments[].networkModes.externalOnly.network (instance.yaml, schema default applied); null when the environment vault is not needed or the environment has no externalOnly.')
param externalOnlyNetwork ('managed' | 'vnet')?

// As landing-zone.bicep: a VNet-based mode uses the private environment vault, the managed network the public one.
var envVaultVariant = networkMode == 'externalHybrid' || externalOnlyNetwork == 'vnet' ? 'private' : 'public'
var envVaultKnown = networkMode != null && vaultGeneration != null && (networkMode == 'externalHybrid' || externalOnlyNetwork != null)

output appResourceGroup string = nameAppResourceGroup(prefix, slug, environmentName)
output releaseDeployment string = nameReleaseDeployment(slug)
output containerApp string = nameContainerApp(slug)
output provisioningDeployment string = nameProvisioningDeployment(slug, environmentName)
output entraDeployment string = nameEntraDeployment(slug, environmentName)
@description('uniqueName of the app\'s Entra application: the stage entra resolves the registration whose assignments it removes, or that decommissioning deletes, by it (ADR-0033 amended 2026-11-11, ADR-0056); {prefix}-{slug}-{env}, with --i{incarnation} above incarnation 0 (ADR-0061). Null without incarnation, so a caller that needs it can\'t get another app\'s registration by leaving it out.')
output entraApplicationUniqueName string? = incarnation == null
  ? null
  : nameEntraApplicationUniqueName(prefix, slug, environmentName, incarnation!)
output registryRepository string = nameRegistryRepository(slug)
output adoEnvironment string = nameAdoEnvironment(slug, environmentName)
output adoServiceConnection string = nameAdoServiceConnection(slug, environmentName)
output deliveryIdentity string = nameDeliveryIdentity(prefix, slug, environmentName)
@description('Runtime identity of the app (the database principal dbinit creates, ADR-0028).')
output runtimeIdentity string = nameRuntimeIdentity(prefix, slug, environmentName)
@description('The instance\'s Entra deployments group rg-{prefix}-entra (portal host subscription): the app records deployed before ADR-0063 stay there until the registration\'s next deployment moves them to entraEnvironmentResourceGroup.')
output entraResourceGroup string = nameEntraResourceGroup(prefix)
@description('The environment\'s Entra records group rg-{prefix}-entra-{env} (portal host subscription, ADR-0063): where the stage entra deploys entra-{slug}-{env}.')
output entraEnvironmentResourceGroup string = nameEntraEnvironmentResourceGroup(prefix, environmentName)
output platformResourceGroup string = namePlatformResourceGroup(prefix, environmentName)
output easyAuthSecret string = nameEasyAuthSecret(slug)
@description('Deployment of the app\'s custom domain through Front Door (frontdoor.bicep, in platformResourceGroup).')
output frontDoorDeployment string = nameFrontDoorDeployment(slug, environmentName)
@description('kvset platform job of the CAE of networkMode in cell (in platformResourceGroup), null without networkMode or cell.')
output kvsetJob string? = networkMode == null || cell == null ? null : nameCellPlatformJob(prefix, 'kvset', networkMode!, cell!)
@description('dbinit platform job of the CAE of networkMode in cell (in platformResourceGroup), null without networkMode or cell.')
output dbinitJob string? = networkMode == null || cell == null ? null : nameCellPlatformJob(prefix, 'dbinit', networkMode!, cell!)
@description('The CAE of networkMode in cell (in platformResourceGroup), null without networkMode or cell: the move of a network mode change compares the live app\'s environment with it and deletes the delivery identity\'s Joiner on the source one (ADR-0060, ADR-0053).')
output managedEnvironment string? = networkMode == null || cell == null ? null : nameCellManagedEnvironment(prefix, networkMode!, environmentName, cell!)
output containerRegistry string? = generation == null
  ? null
  : nameContainerRegistry(prefix, slug, environmentName, subscription().subscriptionId, generation ?? 0)
@description('The app vault, as landing-zone-resources.bicep names it (output appKeyVaultName); null without generation. Provisioning reads whether a soft-deleted vault holds this name after a failed landing zone (ADR-0064, US04.11).')
output appVault string? = generation == null
  ? null
  : nameAppKeyVault(prefix, slug, environmentName, subscription().subscriptionId, generation ?? 0)
@description('Deployment of the app vault\'s portal-side private endpoint in the portal resource group (ADR-0025).')
output portalEndpointDeployment string = namePortalEndpointDeployment(slug, environmentName)
@description('Portal resource group rg-{prefix}-portal-{portalEnvironmentName}, null without portalEnvironmentName.')
output portalResourceGroup string? = portalEnvironmentName == null ? null : namePortalResourceGroup(prefix, portalEnvironmentName!)
@description('The app vault\'s portal-side private endpoint pep-{vaultName}-portal, null without vaultName.')
output portalVaultEndpoint string? = vaultName == null ? null : namePortalPrivateEndpoint(vaultName!)
@description('The environment vault of networkMode (in platformResourceGroup), as landing-zone.bicep names it (output environmentKeyVaultName): where provisioning reads the Easy Auth secret for the mode app.yaml asks for (ADR-0060). Null without networkMode and vaultGeneration, and for externalOnly without externalOnlyNetwork.')
output environmentVault string? = envVaultKnown
  ? nameEnvironmentKeyVault(
      prefix,
      environmentName,
      envVaultVariant,
      subscription().subscriptionId,
      subscriptionResourceId('Microsoft.Resources/resourceGroups', namePlatformResourceGroup(prefix, environmentName)),
      vaultGeneration ?? 0
    )
  : null
