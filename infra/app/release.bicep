// Release of an app's Container App, deployed at the app RG with the FIXED deployment name
// releaseDeployment(slug) = release-{slug} (ADR-0021; the name is set by the pipeline).
// This is the only template that defines the Container App.
//
// A PUT replaces the whole Container App, so every landing-zone-owned setting (identities,
// registry, ingress and IP restrictions, custom domains, Easy Auth secret reference) is a
// REQUIRED parameter or derived from the naming module here (lessons-from-v1, naming spike).
//
// Two callers, one template:
//   deployedBy 'delivery'      the app's delivery identity (App Deployer + App Environment
//                              Joiner + Managed Identity Operator). Writes only the
//                              Container App. Reads the CAE, registry and App Insights through
//                              `existing` (read actions in those roles). No module, no
//                              deployment outside this RG, no Key Vault or auth-config access.
//   deployedBy 'provisioning'  the Azure provisioning identity: the bootstrap release right
//                              after the landing zone (placeholder image, so the app never
//                              runs without Easy Auth), and re-applying auth settings or
//                              alerts with the currently deployed digest. Also writes
//                              authConfigs and the Container App metric alerts, which the
//                              delivery identity can't (ADR-0021, US06.06).
// Verify in sandbox: NR-4 (release), NR-8 (auth config survives a delivery PUT), NR-11 (RBAC
// propagation retry in the pipeline).

import {
  actionGroup as nameActionGroup
  appKeyVault as nameAppKeyVault
  applicationInsights as nameApplicationInsights
  cellManagedEnvironment as nameCellManagedEnvironment
  containerApp as nameContainerApp
  containerRegistry as nameContainerRegistry
  easyAuthIdentity as nameEasyAuthIdentity
  easyAuthSecret as nameEasyAuthSecret
  environmentKeyVault as nameEnvironmentKeyVault
  metricAlert as nameMetricAlert
  platformResourceGroup as namePlatformResourceGroup
  registryRepository as nameRegistryRepository
  runtimeIdentity as nameRuntimeIdentity
} from '../modules/naming/naming.bicep'
import {
  externalOnlyNetwork as externalOnlyNetworkType
  platformEnvVarNames
} from '../modules/types.bicep'

// ------------------------------------------------------------------------------------------
// Parameters
// ------------------------------------------------------------------------------------------

@minLength(2)
@maxLength(8)
param prefix string

@minLength(2)
@maxLength(8)
param environmentName string

@minLength(3)
@maxLength(20)
param slug string

@description('App generation (names the registry and app vault).')
@minValue(0)
param generation int

@description('environments[].vaultGeneration (names the environment vault holding the Easy Auth secret).')
@minValue(0)
param vaultGeneration int

@description('Region of the environment (landing-zone output `location`, which is the CAE\'s region). Checked against the CAE at deployment time (lessons-from-v1).')
param location string

@description('The app\'s network mode in this environment.')
param networkMode 'externalOnly' | 'externalHybrid'

@description('The environment\'s External-only variant (environments[].networkModes.externalOnly.network).')
param externalOnlyNetwork externalOnlyNetworkType

@description('The app\'s capacity cell in this environment (app.yaml environments.<env>.cell, default 01; ADR-0053): the Container App runs in the CAE of networkMode in that cell. Provisioning passes app.yaml\'s; delivery copies the release record\'s (01 for a record written before the parameter). Two digits; an invalid id fails in naming.bicep.')
@minLength(2)
@maxLength(2)
param cell string

@description('Who deploys: delivery (revisions) or provisioning (bootstrap, auth config, alerts).')
param deployedBy 'delivery' | 'provisioning'

@description('Image: digest (sha256:...) in the app registry, repository = slug. bootstrapImage (provisioning only) replaces it with a platform placeholder before the first delivery.')
param image {
  digest: string?
  bootstrapImage: string?
}

@description('platform.yaml runtime settings for this environment, defaults resolved.')
param runtime {
  @minValue(1024)
  @maxValue(65535)
  port: int
  size: 'xs' | 's' | 'm' | 'l'
  @minValue(0)
  @maxValue(10)
  minReplicas: int
  @minValue(1)
  @maxValue(10)
  maxReplicas: int
  livenessPath: string
  readinessPath: string
}

@description('platform.yaml env: plain values or references to a secret name.')
param env {
  name: string
  value: string?
  secret: string?
}[]

@description('platform.yaml secrets: NAMES in the app\'s own Key Vault (never URLs or values).')
param secrets string[]

@description('Landing-zone outputs (landing-zone.bicep) passed through unchanged.')
param landingZone {
  runtimeIdentityClientId: string
  @description('DATABASE_HOST is the public server FQDN (never the privatelink name); user is set for PostgreSQL only (Azure SQL gets no DATABASE_USER).')
  database: {
    host: string
    name: string
    user: string?
  }?
  storageBlobEndpoint: string?
}

@description('Front Door in front of this app: none, managed (environment profile) or external. frontDoorId = expected X-Azure-FDID; hostNames = the app\'s custom hosts on Front Door (Easy Auth accepts browser requests from them); backendIpRanges = IPv4 prefixes of the AzureFrontDoor.Backend service tag, because Container Apps IP restrictions accept CIDR ranges only; empty = no IP restriction (the interim until FD-3, ADR-0010 amended 2026-11-02).')
param frontDoor {
  mode: 'none' | 'managed' | 'external'
  frontDoorId: string?
  hostNames: string[]?
  backendIpRanges: string[]
}

@description('ACA-bound custom domains (not behind Front Door). certificateName = the managed certificate in the CAE; null while it is being issued (binding disabled). Verify in sandbox: NR-12.')
param customDomains {
  name: string
  certificateName: string?
}[]

@description('Easy Auth (ADR-0009): required = Entra sign-in for every request; anonymous = approved public app (ownerChoice), Easy Auth disabled. clientId = the app registration of this app x environment.')
param authentication {
  mode: 'required' | 'anonymous'
  clientId: string?
}

@description('Container App alerts (observability.defaultAlerts); provisioning mode only.')
param alertsEnabled bool

@description('Core version that applies this release (instance.yaml coreVersion of the run, in both pipelines; the template is this version\'s). Written to the Container App tag saf-core: the app version of the release unit (ADR-0049). No default: environment-specific (hard rule 6).')
@minLength(6)
@maxLength(64)
param coreVersion string

@description('Pipeline run whose image this release deploys: the delivery pipeline passes it from the release manifest; provisioning copies it from the deployed Container App or leaves it out. Written to the Container App tags saf-run-id and saf-commit; delivery never replaces a newer run with an older one (ADR-0029).')
param run {
  id: string
  commit: string
}?

// ------------------------------------------------------------------------------------------
// Names and validation
// ------------------------------------------------------------------------------------------

var sub = subscription().subscriptionId
var platformRgName = namePlatformResourceGroup(prefix, environmentName)
var vnetBased = networkMode == 'externalHybrid' || externalOnlyNetwork == 'vnet'
var behindFrontDoor = frontDoor.mode != 'none'
var authRequired = authentication.mode == 'required'
var isProvisioning = deployedBy == 'provisioning'
var kvSuffix = environment().suffixes.keyvaultDns

var appVaultName = nameAppKeyVault(prefix, slug, environmentName, sub, generation)
var envVaultName = nameEnvironmentKeyVault(
  prefix,
  environmentName,
  vnetBased ? 'private' : 'public',
  sub,
  subscriptionResourceId('Microsoft.Resources/resourceGroups', platformRgName),
  vaultGeneration
)

var digits = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']
var developerEnvNames = [for e in env: e.name]
var reservedUsed = filter(developerEnvNames, n => contains(platformEnvVarNames, n))

var inputErrors = filter(
  [
    (image.?digest == null) == (image.?bootstrapImage == null)
      ? 'image needs exactly one of digest or bootstrapImage.'
      : ''
    image.?bootstrapImage != null && !isProvisioning ? 'bootstrapImage is for provisioning only.' : ''
    image.?digest != null && !(startsWith(image.?digest ?? '', 'sha256:') && length(image.?digest ?? '') == 71)
      ? 'image.digest must be sha256:<64 hex>.'
      : ''
    runtime.minReplicas > runtime.maxReplicas ? 'runtime.minReplicas exceeds maxReplicas.' : ''
    !empty(reservedUsed) ? 'env uses platform-reserved names: ${join(reservedUsed, ', ')}.' : ''
    length(filter(env, e => (e.?value == null) == (e.?secret == null))) > 0
      ? 'each env entry needs exactly one of value or secret.'
      : ''
    length(filter(env, e => e.?secret != null && !contains(secrets, e.?secret ?? ''))) > 0
      ? 'env references a secret that is not listed in secrets.'
      : ''
    behindFrontDoor && frontDoor.?frontDoorId == null ? 'frontDoor.frontDoorId is required behind Front Door.' : ''
    behindFrontDoor && !empty(customDomains)
      ? 'no ACA-bound custom domain for an app served through Front Door (ADR-0010).'
      : ''
    authRequired && authentication.?clientId == null ? 'authentication.clientId is required in mode required.' : ''
    !isProvisioning && alertsEnabled ? 'alerts are managed in provisioning mode only.' : ''
    // run.id is digits only: removing every digit must leave nothing.
    run != null && (empty(run.?id ?? '') || !empty(reduce(digits, run.?id ?? '', (rest, d) => replace(rest, d, ''))))
      ? 'run.id must be a pipeline run number.'
      : ''
    run != null && length(run.?commit ?? '') != 40 ? 'run.commit must be a full commit SHA.' : ''
  ],
  message => !empty(message)
)

var containerAppName = empty(inputErrors)
  ? nameContainerApp(slug)
  : fail('release.bicep: ${join(inputErrors, ' ')}')

// ------------------------------------------------------------------------------------------
// Landing-zone and platform resources, read only (cross-RG `existing`, no module)
// ------------------------------------------------------------------------------------------

resource cae 'Microsoft.App/managedEnvironments@2025-01-01' existing = {
  scope: resourceGroup(platformRgName)
  name: nameCellManagedEnvironment(prefix, networkMode, environmentName, cell)
}

resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' existing = {
  name: nameContainerRegistry(prefix, slug, environmentName, sub, generation)
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: nameApplicationInsights(slug, environmentName)
}

resource runtimeIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: nameRuntimeIdentity(prefix, slug, environmentName)
}

resource easyAuthIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2024-11-30' existing = {
  name: nameEasyAuthIdentity(prefix, slug, environmentName)
}

// ------------------------------------------------------------------------------------------
// Container App
// ------------------------------------------------------------------------------------------

var sizes = {
  xs: {
    cpu: json('0.25')
    memory: '0.5Gi'
  }
  s: {
    cpu: json('0.5')
    memory: '1Gi'
  }
  m: {
    cpu: json('1.0')
    memory: '2Gi'
  }
  l: {
    cpu: json('2.0')
    memory: '4Gi'
  }
}

var imageReference = image.?bootstrapImage ?? '${registry.properties.loginServer}/${nameRegistryRepository(slug)}@${image.?digest ?? ''}'

// Secrets: Key Vault references BY NAME into the app's own vault (lessons-from-v1), resolved
// by the runtime identity; plus the Easy Auth client secret from the environment vault of the
// app's variant, resolved by the Easy Auth identity.
var easyAuthSecretName = 'microsoft-provider-authentication-secret'
var appSecrets = [
  for name in secrets: {
    name: name
    keyVaultUrl: 'https://${appVaultName}${kvSuffix}/secrets/${name}'
    identity: runtimeIdentity.id
  }
]
var authSecrets = authRequired
  ? [
      {
        name: easyAuthSecretName
        keyVaultUrl: 'https://${envVaultName}${kvSuffix}/secrets/${nameEasyAuthSecret(slug)}'
        identity: easyAuthIdentity.id
      }
    ]
  : []

// Platform-injected variables (binding contract, reserved in platform.yaml, documented in
// docs/architecture/data-services.md). A variable that doesn't apply is not set at all.
// CONTAINER_APP_NAME is set by Container Apps itself.
var platformEnv = concat(
  [
    {
      name: 'PORT'
      value: string(runtime.port)
    }
    {
      name: 'AZURE_CLIENT_ID'
      value: landingZone.runtimeIdentityClientId
    }
    {
      name: 'APPLICATIONINSIGHTS_CONNECTION_STRING'
      value: appInsights.properties.ConnectionString
    }
  ],
  landingZone.?database == null
    ? []
    : [
        {
          name: 'DATABASE_HOST'
          value: landingZone.?database.?host ?? ''
        }
        {
          name: 'DATABASE_NAME'
          value: landingZone.?database.?name ?? ''
        }
      ],
  landingZone.?database.?user == null
    ? []
    : [
        {
          name: 'DATABASE_USER'
          value: landingZone.?database.?user ?? ''
        }
      ],
  landingZone.?storageBlobEndpoint == null
    ? []
    : [
        {
          name: 'STORAGE_BLOB_ENDPOINT'
          value: landingZone.?storageBlobEndpoint ?? ''
        }
      ],
  behindFrontDoor
    ? [
        {
          name: 'FRONT_DOOR_ID'
          value: frontDoor.?frontDoorId ?? ''
        }
      ]
    : []
)
var developerEnv = [
  for e in env: e.?secret == null
    ? {
        name: e.name
        value: e.?value ?? ''
      }
    : {
        name: e.name
        secretRef: e.?secret ?? ''
      }
]

// Behind Front Door: allow only the AzureFrontDoor.Backend ranges (all rules must share one
// action; Container Apps takes IPv4 CIDR ranges only, no service tags). Provisioning resolves
// them once per stage and passes them once Front Door serves the app's domain (ADR-0010, amended
// 2026-11-11); before that the list is empty: no IP restriction, and the app's X-Azure-FDID check
// (FRONT_DOOR_ID) is the guard. The sandbox took 157 rules (FD-3, 2026-11-11); Learn documents
// no maximum. TODO(verify): the limit. Verify in sandbox: FD-3. (Comments only: a change of the
// compiled template would change its hash and re-apply every release.)
var ipRestrictions = behindFrontDoor
  ? map(range(0, length(frontDoor.backendIpRanges)), i => {
      name: 'afd-backend-${i}'
      description: 'AzureFrontDoor.Backend'
      ipAddressRange: frontDoor.backendIpRanges[i]
      action: 'Allow'
    })
  : []

resource containerApp 'Microsoft.App/containerApps@2025-01-01' = {
  name: containerAppName
  location: location
  // The group's tags, the core version that applied the release (saf-core, ADR-0049) and the run
  // whose image it deploys. Tags written after a deployment (saf-easyauth) are written again by the
  // pipeline that owns them; a PUT replaces the whole set.
  tags: union(resourceGroup().tags, { 'saf-core': coreVersion }, run == null ? {} : { 'saf-run-id': run.?id, 'saf-commit': run.?commit })
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: union(
      {
        '${runtimeIdentity.id}': {}
      },
      authRequired ? { '${easyAuthIdentity.id}': {} } : {}
    )
  }
  properties: {
    // A Container App's region must equal its environment's region (lessons-from-v1). Bicep
    // can't take a resource location from a runtime value, so the CAE's region is checked here.
    environmentId: toLower(replace(cae.location, ' ', '')) == toLower(replace(location, ' ', ''))
      ? cae.id
      : fail('release.bicep: location "${location}" differs from the region of ${cae.name} ("${cae.location}").')
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      // The Easy Auth identity is usable only by the platform (Key Vault reference), never by
      // app code. Verify in sandbox: ENT-6.
      identitySettings: concat(
        [
          {
            identity: runtimeIdentity.id
            lifecycle: 'All'
          }
        ],
        authRequired
          ? [
              {
                identity: easyAuthIdentity.id
                lifecycle: 'None'
              }
            ]
          : []
      )
      registries: [
        {
          server: registry.properties.loginServer
          identity: runtimeIdentity.id
        }
      ]
      secrets: concat(appSecrets, authSecrets)
      ingress: {
        external: true
        targetPort: runtime.port
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
        ipSecurityRestrictions: ipRestrictions
        customDomains: [
          for d in customDomains: {
            name: d.name
            bindingType: d.?certificateName == null ? 'Disabled' : 'SniEnabled'
            certificateId: d.?certificateName == null
              ? null
              : resourceId(
                  sub,
                  platformRgName,
                  'Microsoft.App/managedEnvironments/managedCertificates',
                  nameCellManagedEnvironment(prefix, networkMode, environmentName, cell),
                  d.?certificateName ?? ''
                )
          }
        ]
      }
    }
    template: {
      containers: [
        {
          name: 'app'
          image: imageReference
          resources: sizes[runtime.size]
          env: concat(platformEnv, developerEnv)
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: runtime.livenessPath
                port: runtime.port
              }
              periodSeconds: 10
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: {
                path: runtime.readinessPath
                port: runtime.port
              }
              periodSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: runtime.minReplicas
        maxReplicas: runtime.maxReplicas
      }
    }
  }
}

// ------------------------------------------------------------------------------------------
// Easy Auth (provisioning mode only; the delivery identity has no authConfigs/write)
// ------------------------------------------------------------------------------------------

resource authConfig 'Microsoft.App/containerApps/authConfigs@2025-01-01' = if (isProvisioning) {
  parent: containerApp
  name: 'current'
  properties: {
    platform: {
      enabled: authRequired
    }
    globalValidation: {
      unauthenticatedClientAction: 'RedirectToLoginPage'
      redirectToProvider: 'azureactivedirectory'
    }
    identityProviders: {
      azureActiveDirectory: {
        enabled: authRequired
        registration: {
          clientId: authentication.?clientId ?? ''
          clientSecretSettingName: easyAuthSecretName
          openIdIssuer: '${environment().authentication.loginEndpoint}${tenant().tenantId}/v2.0'
        }
      }
    }
    // Easy Auth refuses a signed-in browser's POST, PUT or DELETE whose Origin isn't the app's own
    // host with 403.60 "Cross-site request forgery detected", and behind Front Door it compares
    // with the Container App's host, not the forwarded one. The custom hosts are trusted here
    // (sandbox, hotel-inventory, 2026-11-02). Verify in sandbox: FD-9.
    login: {
      allowedExternalRedirectUrls: map(behindFrontDoor ? frontDoor.?hostNames ?? [] : [], h => 'https://${h}')
    }
    httpSettings: {
      requireHttps: true
      // Behind Front Door the public host comes from X-Forwarded-Host. Verify in sandbox: FD-1.
      forwardProxy: {
        convention: behindFrontDoor ? 'Standard' : 'NoProxy'
      }
    }
  }
}

// ------------------------------------------------------------------------------------------
// Container App alerts (ADR-0012; provisioning mode only)
// TODO(verify): metric names and thresholds (RestartCount, Requests/statusCodeCategory,
// ResponseTime, Replicas) against the Container Apps metrics reference in the sandbox.
// ------------------------------------------------------------------------------------------

resource actionGroup 'Microsoft.Insights/actionGroups@2023-01-01' existing = {
  name: nameActionGroup(slug, environmentName)
}

var alertDefinitions = [
  {
    key: 'restarts'
    description: 'Container restarts or crash loop.'
    metricName: 'RestartCount'
    operator: 'GreaterThan'
    threshold: 3
    aggregation: 'Total'
    dimensions: []
    enabled: true
  }
  {
    key: 'http5xx'
    description: 'HTTP 5xx responses.'
    metricName: 'Requests'
    operator: 'GreaterThan'
    threshold: 10
    aggregation: 'Total'
    dimensions: [
      {
        name: 'statusCodeCategory'
        operator: 'Include'
        values: [
          '5xx'
        ]
      }
    ]
    enabled: true
  }
  {
    key: 'latency'
    description: 'Average response time above 2 s.'
    metricName: 'ResponseTime'
    operator: 'GreaterThan'
    threshold: 2000
    aggregation: 'Average'
    dimensions: []
    enabled: true
  }
  {
    key: 'replicas'
    description: 'No running replica although minReplicas >= 1.'
    metricName: 'Replicas'
    operator: 'LessThan'
    threshold: 1
    aggregation: 'Maximum'
    dimensions: []
    enabled: runtime.minReplicas >= 1
  }
]

// 2018-03-01 is the long-standing GA version of metricAlerts; the linter also lists 2026-01-01.
#disable-next-line use-recent-api-versions
resource alerts 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for a in alertDefinitions: if (isProvisioning && alertsEnabled && a.enabled) {
    name: nameMetricAlert(slug, a.key, environmentName)
    location: 'global'
    tags: resourceGroup().tags
    properties: {
      description: a.description
      severity: 2
      enabled: true
      scopes: [
        containerApp.id
      ]
      evaluationFrequency: 'PT5M'
      windowSize: 'PT15M'
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            criterionType: 'StaticThresholdCriterion'
            name: a.key
            metricName: a.metricName
            operator: a.operator
            threshold: a.threshold
            timeAggregation: a.aggregation
            dimensions: a.dimensions
          }
        ]
      }
      actions: [
        {
          actionGroupId: actionGroup.id
        }
      ]
    }
  }
]

// ------------------------------------------------------------------------------------------
// Outputs (smoke test, portal deploy event)
// ------------------------------------------------------------------------------------------

output containerAppName string = containerApp.name
output fqdn string = containerApp.properties.configuration.ingress.fqdn
output latestRevisionName string = containerApp.properties.latestRevisionName
output image string = imageReference
