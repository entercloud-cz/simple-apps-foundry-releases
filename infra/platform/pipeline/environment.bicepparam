// The only parameter file the platform pipeline (\platform\platform-{env}, ADR-0043) deploys
// environment.bicep with (deployment platform-{prefix}-{env}, Azure provisioning identity of the
// environment).
//
// Input: SAF_ENVIRONMENT_JSON, written by `platform environment inputs --pass 1|2` from
// instance.yaml and core's images/images.json (pass 1: platformJobsImageDigest ''). Every value
// comes from that JSON: the CLI resolves schema defaults and fails on missing values, and Bicep
// type-checks the JSON when this file is compiled (keys it doesn't use are ignored). No other
// --parameters.

using '../environment.bicep'

var env = json(readEnvironmentVariable('SAF_ENVIRONMENT_JSON'))

param prefix = env.prefix
param environmentName = env.environmentName
param environmentKind = env.environmentKind
param location = env.location
param vaultGeneration = env.vaultGeneration
param networkModes = env.networkModes
param hub = env.hub
param frontDoor = env.frontDoor
param logRetentionDays = env.logRetentionDays
param platformAlertEmails = env.platformAlertEmails
param managedBy = env.managedBy
param tags = env.tags
param platformJobsImageDigest = env.platformJobsImageDigest
param entraProvisioningPrincipalId = env.entraProvisioningPrincipalId
param portalIdentityPrincipalId = env.portalIdentityPrincipalId
