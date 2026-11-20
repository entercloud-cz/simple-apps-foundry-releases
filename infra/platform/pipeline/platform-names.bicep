// Names the platform pipeline (pipelines/azure-devops/scripts/platform/plat-lib.sh, ADR-0043)
// needs. Not deployed: the jobs evaluate it offline with
//   bicep snapshot platform-names.bicepparam --subscription-id <environment subscription> --tenant-id <tenant>
//     --location <region>
// and read `outputs`, so every name comes from naming.bicep (ADR-0020, AGENTS.md rule 6): the
// deployment record, the platform resource group and registry (the saf-jobs import), the kvset and
// dbinit jobs of every enabled CAE (the digest check after the deployment), the three custom
// roles of roles.bicep (the roles gate before the approval; their GUIDs are seeded with tenant and
// prefix) and, read only in the portal host environment, the portal's deployment record, resource
// group and Container App (ADR-0043 decision 10: the portal's compare and its image check) and the
// environment vaults (the SMTP password secret's existence, ADR-0025 amendment 2026-11-14).

targetScope = 'subscription'

import {
  appDeployerRoleName as nameAppDeployerRoleName
  appEnvironmentJoinerRoleName as nameAppEnvironmentJoinerRoleName
  customRoleDefinitionGuid as nameCustomRoleDefinitionGuid
  environmentKeyVault as nameEnvironmentKeyVault
  identitiesResourceGroup as nameIdentitiesResourceGroup
  instanceIdentity as nameInstanceIdentity
  managedEnvironment as nameManagedEnvironment
  platformContainerRegistry as namePlatformContainerRegistry
  platformDeployment as namePlatformDeployment
  platformJob as namePlatformJob
  platformJobSecretWriterRoleName as namePlatformJobSecretWriterRoleName
  platformResourceGroup as namePlatformResourceGroup
  portalContainerApp as namePortalContainerApp
  portalDeployment as namePortalDeployment
  portalResourceGroup as namePortalResourceGroup
} from '../../modules/naming/naming.bicep'

@minLength(2)
@maxLength(8)
param prefix string

@minLength(2)
@maxLength(8)
param environmentName string

@description('Network modes with a CAE in this environment (instance.yaml environments[].networkModes keys; internalOnly is not built).')
param modes ('externalOnly' | 'externalHybrid')[]

@description('environments[].vaultGeneration (seed of the environment vault names, as environment.bicep).')
@minValue(0)
param vaultGeneration int

output platformDeployment string = namePlatformDeployment(prefix, environmentName)
output platformResourceGroup string = namePlatformResourceGroup(prefix, environmentName)
output platformRegistry string = namePlatformContainerRegistry(prefix, environmentName, subscription().subscriptionId)

@description('The CAE of each buildable mode, enabled or not: a CAE of a mode the instance no longer enables is reported, never deleted.')
output managedEnvironments { mode: string, name: string }[] = [
  for mode in ['externalOnly', 'externalHybrid']: {
    mode: mode
    name: nameManagedEnvironment(prefix, mode, environmentName)
  }
]

@description('In the portal host environment: the instance identities whose principals instance.yaml names (identities.entraProvisioningPrincipalId, portal.identityPrincipalId).')
output identitiesResourceGroup string = nameIdentitiesResourceGroup(prefix, environmentName)
output entraProvisioningIdentity string = nameInstanceIdentity(prefix, 'entra-provisioning')
output portalIdentity string = nameInstanceIdentity(prefix, 'portal')

@description('In the portal host environment (portal.bicep, ADR-0043 decision 10): the deployment record portal-{prefix}-{env}, the portal resource group and its Container App.')
output portalDeployment string = namePortalDeployment(prefix, environmentName)
output portalResourceGroup string = namePortalResourceGroup(prefix, environmentName)
output portalContainerApp string = namePortalContainerApp(prefix)

@description('The environment vaults by variant, named as environment.bicep names them (they exist only for the variants the environment has, ADR-0003). In the portal host the plan reads the SMTP password secret\'s metadata in one of them (portal.bicep: Key Vault Secrets User on that secret, ADR-0025 amendment 2026-11-14).')
output environmentVaultPublic string = nameEnvironmentKeyVault(
  prefix,
  environmentName,
  'public',
  subscription().subscriptionId,
  subscriptionResourceId('Microsoft.Resources/resourceGroups', namePlatformResourceGroup(prefix, environmentName)),
  vaultGeneration
)
output environmentVaultPrivate string = nameEnvironmentKeyVault(
  prefix,
  environmentName,
  'private',
  subscription().subscriptionId,
  subscriptionResourceId('Microsoft.Resources/resourceGroups', namePlatformResourceGroup(prefix, environmentName)),
  vaultGeneration
)

@description('kvset and dbinit job per enabled mode, in the platform resource group.')
output jobs { mode: string, kvset: string, dbinit: string }[] = [
  for mode in modes: {
    mode: mode
    kvset: namePlatformJob(prefix, 'kvset', mode)
    dbinit: namePlatformJob(prefix, 'dbinit', mode)
  }
]

@description('The custom roles of roles.bicep: role definition GUID (the definition\'s name) and role name.')
output customRoles { key: string, id: string, roleName: string }[] = [
  {
    key: 'appDeployer'
    id: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-deployer')
    roleName: nameAppDeployerRoleName(prefix)
  }
  {
    key: 'appEnvironmentJoiner'
    id: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'app-environment-joiner')
    roleName: nameAppEnvironmentJoinerRoleName(prefix)
  }
  {
    key: 'platformJobSecretWriter'
    id: nameCustomRoleDefinitionGuid(tenant().tenantId, prefix, 'platform-job-secret-writer')
    roleName: namePlatformJobSecretWriterRoleName(prefix)
  }
]
