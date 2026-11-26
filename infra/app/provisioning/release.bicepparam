// The only parameter file the provisioning pipeline deploys release.bicep with (deployment
// release-{slug}: the bootstrap release before the first delivery, and re-applies that change
// platform-owned values such as sign-in or the landing-zone outputs).
//
// Input: SAF_RELEASE_JSON, written by `platform provisioning inputs --step release
// --mode bootstrap|reapply`:
//   - platform-owned values from instance.yaml, apps/{slug}/app.yaml and the run's state
//     (landing-zone outputs, the Entra client ID);
//   - app-owned values (image, runtime, env, secrets, run) from the last release-{slug} record on
//     a re-apply, or the bootstrap image and runtime on a bootstrap;
//   - coreVersion (instance.yaml), written to the Container App's tag saf-core (ADR-0049).
// deployedBy is a literal here, so this file always deploys in provisioning mode (it writes the
// Easy Auth configuration and the alerts); delivery has its own file with deployedBy 'delivery'.

using '../release.bicep'

var release = json(readEnvironmentVariable('SAF_RELEASE_JSON'))

param deployedBy = 'provisioning'

param prefix = release.prefix
param environmentName = release.environmentName
param slug = release.slug
param generation = release.generation
param vaultGeneration = release.vaultGeneration
param location = release.location
param networkMode = release.networkMode
param cell = release.cell
param externalOnlyNetwork = release.externalOnlyNetwork
param image = release.image
param runtime = release.runtime
param env = release.env
param secrets = release.secrets
param landingZone = release.landingZone
param frontDoor = release.frontDoor
param customDomains = release.customDomains
param authentication = release.authentication
param alertsEnabled = release.alertsEnabled
param run = release.run
param coreVersion = release.coreVersion
