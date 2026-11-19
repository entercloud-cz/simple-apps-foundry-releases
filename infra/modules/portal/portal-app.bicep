// The portal's Container App (ADR-0036), in the portal resource group of the portal host
// environment. Deployed by platform/portal.bicep in pass 2 only, once saf-portal is imported by
// digest into the host environment's platform registry.
//
// - Its only identity is the portal runtime identity id-{prefix}-portal (bootstrap.bicep). It
//   pulls the image by digest from the platform registry with that identity (Container Registry
//   Repository Reader, assigned by portal.bicep) and is the identity the API uses for the Azure
//   DevOps token (AZURE_CLIENT_ID). Verify in sandbox: PORTAL-1.
// - External ingress on the image's port, HTTPS only (allowInsecure false), no IP restriction:
//   the SPA's static files are public and hold no data; every API call needs a token
//   (ADR-0036). One replica at least, so the first request doesn't wait for a cold start.
// - No secrets: the portal registration has no client secret (ADR-0036), and the ADO token and
//   the database token (ADR-0038) come from the managed identity.
// - Environment variables: the fixed contract between portal.bicep and the image (portal/,
//   W1). The image itself stays instance-neutral; the SPA reads tenant, client ID and scope
//   from the API (GET /config.json). APPLICATIONINSIGHTS_CONNECTION_STRING is not set in W1.
//   SAF_SMTP_PASSWORD_VAULT_URI has a value only when portal.bicep assigned the SMTP secret's role.

@description('Container App name (naming.portalContainerApp).')
param name string

@description('Azure region: the portal CAE\'s region (the same location parameter portal.bicep creates the CAE with).')
param location string

@description('Resource ID of the portal CAE (cae-{prefix}-portal-{env}).')
param environmentId string

@description('Resource ID of the portal runtime identity id-{prefix}-portal, the app\'s only identity.')
param identityId string

@description('Client ID of the portal runtime identity (AZURE_CLIENT_ID).')
param identityClientId string

@description('Login server of the host environment\'s platform registry, read from the registry (never built by hand).')
param registryLoginServer string

@description('Repository of the portal image in the platform registry (images/images.json).')
param imageRepository string

@description('Digest of the portal image, sha256:<64 hex> (validated by the caller).')
param imageDigest string

@description('Port the image listens on (PORT and the ingress target port).')
param port int

@description('Values of the portal\'s environment variable contract (validated by the caller).')
param settings {
  @description('Entra tenant ID (instance.yaml tenantId): SAF_TENANT_ID.')
  tenantId: string

  @description('Client ID of the portal\'s Entra app registration (portal-registration.bicep): SAF_PORTAL_CLIENT_ID.')
  portalClientId: string

  @description('scm.azureDevOps.organizationUrl: SAF_ADO_ORGANIZATION_URL.')
  adoOrganizationUrl: string

  @description('scm.azureDevOps.platformProject: SAF_ADO_PROJECT.')
  adoProject: string

  @description('scm.azureDevOps.platformConfigRepo: SAF_ADO_REPOSITORY.')
  adoRepository: string

  @description('scm.azureDevOps.platformConfigDefaultBranch: SAF_ADO_BRANCH.')
  adoBranch: string

  @description('FQDN of the portal\'s PostgreSQL server (public name, resolved to the private endpoint inside the portal VNet): SAF_DATABASE_HOST.')
  databaseHost: string

  @description('Database inside it (naming.portalPostgresDatabase): SAF_DATABASE_NAME.')
  databaseName: string

  @description('PostgreSQL user: the Entra administrator id-{prefix}-portal (ADR-0038): SAF_DATABASE_USER.')
  databaseUser: string

  @description('https://{vault}.vault.azure.net of the environment vault that holds the SMTP relay\'s password (ADR-0012, ADR-0025): SAF_SMTP_PASSWORD_VAULT_URI, set only when the portal identity holds Key Vault Secrets User on that secret; empty = not set (SMTP with a password is "unsupported").')
  smtpPasswordVaultUri: string
}

param tags object

var portalEnv = [
  {
    name: 'PORT'
    value: string(port)
  }
  {
    name: 'AZURE_CLIENT_ID'
    value: identityClientId
  }
  {
    name: 'SAF_TENANT_ID'
    value: settings.tenantId
  }
  {
    name: 'SAF_PORTAL_CLIENT_ID'
    value: settings.portalClientId
  }
  {
    // In Azure the portal always reads platform-config through the Azure DevOps REST API with
    // its managed identity (ADR-0036); `dir` (with SAF_CONFIG_DIR) is for local development only.
    name: 'SAF_CONFIG_SOURCE'
    value: 'ado'
  }
  {
    name: 'SAF_ADO_ORGANIZATION_URL'
    value: settings.adoOrganizationUrl
  }
  {
    name: 'SAF_ADO_PROJECT'
    value: settings.adoProject
  }
  {
    name: 'SAF_ADO_REPOSITORY'
    value: settings.adoRepository
  }
  {
    name: 'SAF_ADO_BRANCH'
    value: settings.adoBranch
  }
  {
    name: 'SAF_DATABASE_HOST'
    value: settings.databaseHost
  }
  {
    name: 'SAF_DATABASE_NAME'
    value: settings.databaseName
  }
  {
    name: 'SAF_DATABASE_USER'
    value: settings.databaseUser
  }
  {
    // Always present, empty without the SMTP secret's role: the image treats an empty value as unset
    // (portal/api/src/settings.ts trims it), so the list stays a plain array (no concat) and what-if
    // and the offline checks can read every variable. Verify in sandbox: PLAT-7 (the Container App
    // takes the empty value; the next what-if shows no change for it).
    name: 'SAF_SMTP_PASSWORD_VAULT_URI'
    value: settings.smtpPasswordVaultUri
  }
]

resource portal 'Microsoft.App/containerApps@2025-01-01' = {
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
      activeRevisionsMode: 'Single'
      identitySettings: [
        {
          identity: identityId
          lifecycle: 'All'
        }
      ]
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
      secrets: []
      ingress: {
        external: true
        targetPort: port
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'portal'
          image: '${registryLoginServer}/${imageRepository}@${imageDigest}'
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          env: portalEnv
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/healthz'
                port: port
              }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/readyz'
                port: port
              }
              periodSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: 2
      }
    }
  }
}

output id string = portal.id
output name string = portal.name
output fqdn string = portal.properties.configuration.ingress.fqdn
