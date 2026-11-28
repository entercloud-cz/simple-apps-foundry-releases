// The only parameter file the app delivery pipeline deploys release.bicep with
// (pipelines/azure-devops/scripts/deploy.sh, deployment release-{slug}, delivery identity).
//
// Input: SAF_RELEASE_JSON, written by `platform pipeline release-params` from
//   - the last release-{slug} deployment record: every platform-owned value (generation,
//     vaultGeneration, location, networkMode, cell, externalOnlyNetwork, landingZone, frontDoor,
//     customDomains, authentication), set by provisioning and only copied by delivery (a record
//     written before release.bicep had cell gives 01, the only cell then, ADR-0053);
//   - the run's verified release manifest: image digest, the run (id, commit) for the Container
//     App tags, and runtime/env/secrets resolved from platform.yaml;
//   - coreVersion: the core this run runs (instance.yaml, through `platform pipeline instance-env`;
//     never the manifest's build version), written to the Container App's tag saf-core (ADR-0049).
// Bicep reads and type-checks the JSON when this file is compiled; keys it doesn't use are
// ignored. deployedBy and alertsEnabled are literals here, so no input can turn a delivery run
// into a provisioning run (ADR-0021, ADR-0029). The pipeline passes no other --parameters.

using '../release.bicep'

var release = json(readEnvironmentVariable('SAF_RELEASE_JSON'))

param deployedBy = 'delivery'
param alertsEnabled = false

param prefix = release.prefix
param environmentName = release.environmentName
param slug = release.slug
param generation = release.generation
param vaultGeneration = release.vaultGeneration
param location = release.location
param networkMode = release.networkMode
param cell = release.cell
param externalOnlyNetwork = release.externalOnlyNetwork
param image = {
  digest: release.image.digest
}
param runtime = release.runtime
param env = release.env
param secrets = release.secrets
param landingZone = release.landingZone
param frontDoor = release.frontDoor
param customDomains = release.customDomains
param authentication = release.authentication
param run = release.run
param coreVersion = release.coreVersion
