// The kvset platform job of one CAE (ADR-0028, ADR-0035), in the environment's platform RG.
//
// - Manual trigger, one replica, no retry, no ingress (jobs have none), no secrets at deploy
//   time. `secrets: []` is explicit, so a re-deployment also removes a job secret a failed
//   hand-off left behind. Verify in sandbox: JOB-3 (a PUT with an empty list removes them).
// - Its only identity is the kvset identity id-{prefix}-kvset-{env}. It pulls saf-jobs by
//   digest from the platform registry with that identity and writes one secret to the vault
//   this module is given, the environment vault of the CAE's variant (public for the
//   managed-network CAE, private for VNet-based CAEs; the caller pairs them).
// - The container gets exactly three fixed env vars (the kvset interface of images/saf-jobs):
//   SAF_VAULT_URI (the vault's properties.vaultUri), SAF_VAULT_AUDIENCE (Key Vault resource of
//   this cloud, from environment().suffixes.keyvaultDns) and AZURE_CLIENT_ID (kvset identity).
//   SAF_SECRET_NAME / SAF_SECRET_VALUE (secretRef) / SAF_SECRET_EXPIRES, or SAF_SECRET_NAME and
//   SAF_SECRET_ACTION=delete (ADR-0060), are set per execution by `platform provisioning
//   easyauth-secret`, never here.
// - Platform Job Secret Writer ({prefix}) for the Entra provisioning identity on this job and
//   nowhere else. The provisioning identity may assign that role to the Entra provisioning
//   identity only (bootstrap.bicep condition, ADR-0043), so the platform pipeline deploys it.
//
// Verify in sandbox: JOB-3 (secret hand-off), JOB-5 (pull with the kvset identity).

@description('Job name (naming.platformJob(prefix, \'kvset\', mode)).')
param name string

@description('Azure region: the CAE\'s region.')
param location string

@description('Resource ID of the CAE the job runs in.')
param environmentId string

@description('Resource ID of the kvset identity (naming.platformJobIdentity(prefix, \'kvset\', env)), the job\'s only identity.')
param identityId string

@description('Client ID of the kvset identity (AZURE_CLIENT_ID).')
param identityClientId string

@description('Platform registry of the environment (naming.platformContainerRegistry), in this resource group.')
param registryName string

@description('Repository of the jobs image in the platform registry (images/images.json).')
param imageRepository string

@description('Digest of the jobs image, sha256:<64 hex> (validated by the caller).')
param imageDigest string

@description('Environment vault of the CAE\'s variant, in this resource group: the only vault the job writes.')
param vaultName string

@description('Object ID of the Entra provisioning identity: Platform Job Secret Writer on this job only.')
param entraProvisioningPrincipalId string

@description('Role definition GUID of Platform Job Secret Writer ({prefix}) (naming.customRoleDefinitionGuid).')
param writerRoleDefinitionGuid string

param tags object

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

resource vault 'Microsoft.KeyVault/vaults@2025-05-01' existing = {
  name: vaultName
}

// Key Vault token audience of this cloud: https://vault.azure.net in the public cloud.
var keyVaultDns = environment().suffixes.keyvaultDns
var vaultAudience = 'https://${startsWith(keyVaultDns, '.') ? substring(keyVaultDns, 1) : keyVaultDns}'

resource job 'Microsoft.App/jobs@2025-01-01' = {
  name: name
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      manualTriggerConfig: {
        parallelism: 1
        replicaCompletionCount: 1
      }
      replicaTimeout: 300
      replicaRetryLimit: 0
      registries: [
        {
          server: registry.properties.loginServer
          identity: identityId
        }
      ]
      secrets: []
    }
    template: {
      containers: [
        {
          name: 'kvset'
          image: '${registry.properties.loginServer}/${imageRepository}@${imageDigest}'
          args: [
            'kvset'
          ]
          env: [
            {
              name: 'SAF_VAULT_URI'
              value: vault.properties.vaultUri
            }
            {
              name: 'SAF_VAULT_AUDIENCE'
              value: vaultAudience
            }
            {
              name: 'AZURE_CLIENT_ID'
              value: identityClientId
            }
          ]
          resources: {
            cpu: json('0.25')
            memory: '0.5Gi'
          }
        }
      ]
    }
  }
}

var writerRoleId = subscriptionResourceId('Microsoft.Authorization/roleDefinitions', writerRoleDefinitionGuid)

// The Entra provisioning identity lives in the portal host environment's subscription; its
// object ID (not a resource ID) seeds the assignment name.
resource entraOnJob 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(job.id, entraProvisioningPrincipalId, writerRoleId)
  scope: job
  properties: {
    principalId: entraProvisioningPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: writerRoleId
    description: 'Entra provisioning identity: hands one Easy Auth client secret at a time to this kvset job (ADR-0035). This job only.'
  }
}

output id string = job.id
output name string = job.name
