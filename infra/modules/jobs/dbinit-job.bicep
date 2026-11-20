// The dbinit platform job of one CAE (ADR-0028), in the environment's platform RG.
//
// - Manual trigger, one replica, no retry, no ingress (jobs have none), no secrets.
// - Its only identity is the dbinit identity id-{prefix}-dbinit-{env}, the Entra administrator of
//   every app database server in the environment (landing zone). It pulls saf-jobs by digest from
//   the platform registry with that identity and creates one app's runtime database role and its
//   grants per execution (images/saf-jobs `dbinit`), PostgreSQL or Azure SQL.
// - The container gets exactly five fixed env vars (the dbinit interface of images/saf-jobs):
//   SAF_PG_AUDIENCE (token resource of Azure Database for PostgreSQL), SAF_PG_HOST_SUFFIX (its
//   server DNS suffix), SAF_SQL_HOST_SUFFIX (Azure SQL's server DNS suffix), SAF_DB_ADMIN (the
//   identity's name, the servers' Entra administrator) and AZURE_CLIENT_ID. SAF_DB_ENGINE,
//   SAF_DB_HOST, SAF_DB_NAME, SAF_PRINCIPAL_NAME, SAF_PRINCIPAL_ID and SAF_PRINCIPAL_CLIENT_ID are
//   set per execution by `platform provisioning dbinit`, never here.
// - Who may start it: the Azure provisioning identity of the environment, through its Contributor
//   role on the subscription (ADR-0028, amended 2026-10-31); no other assignment is made here.
//
// Verify in sandbox: JOB-2 (database principals from the job), MNET-4 (managed network),
// JOB-5 (pull with the job's identity).

@description('Job name (naming.platformJob(prefix, \'dbinit\', mode)).')
param name string

@description('Azure region: the CAE\'s region.')
param location string

@description('Resource ID of the CAE the job runs in.')
param environmentId string

@description('Resource ID of the dbinit identity (naming.platformJobIdentity(prefix, \'dbinit\', env)), the job\'s only identity.')
param identityId string

@description('Name of the dbinit identity: the PostgreSQL user name of the servers\' Entra administrator.')
param identityName string

@description('Client ID of the dbinit identity (AZURE_CLIENT_ID).')
param identityClientId string

@description('Platform registry of the environment (naming.platformContainerRegistry), in this resource group.')
param registryName string

@description('Repository of the jobs image in the platform registry (images/images.json).')
param imageRepository string

@description('Digest of the jobs image, sha256:<64 hex> (validated by the caller).')
param imageDigest string

param tags object

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: registryName
}

// Azure Database for PostgreSQL: the Entra token resource is ossrdbms-aad under the cloud's SQL
// DNS suffix (https://ossrdbms-aad.database.windows.net in the public cloud). environment() has no
// PostgreSQL server suffix, so the server DNS suffix is the public cloud's, like
// naming.privateDnsZone('postgres').
var postgresAudience = 'https://ossrdbms-aad${environment().suffixes.sqlServerHostname}'
var postgresHostSuffix = 'postgres.database.azure.com'
// Azure SQL's server DNS suffix without its leading dot: database.windows.net in the public cloud.
var sqlHostSuffix = substring(environment().suffixes.sqlServerHostname, 1)

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
          name: 'dbinit'
          image: '${registry.properties.loginServer}/${imageRepository}@${imageDigest}'
          args: [
            'dbinit'
          ]
          env: [
            {
              name: 'SAF_PG_AUDIENCE'
              value: postgresAudience
            }
            {
              name: 'SAF_PG_HOST_SUFFIX'
              value: postgresHostSuffix
            }
            {
              name: 'SAF_SQL_HOST_SUFFIX'
              value: sqlHostSuffix
            }
            {
              name: 'SAF_DB_ADMIN'
              value: identityName
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

output id string = job.id
output name string = job.name
