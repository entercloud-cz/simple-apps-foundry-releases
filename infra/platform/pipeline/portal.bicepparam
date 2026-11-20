// The only parameter file the platform pipeline of the portal host environment
// (\platform\platform-{portal.hostEnvironment}, ADR-0043 decision 10) deploys portal.bicep with
// (deployment portal-{prefix}-{env}, Azure provisioning identity of the host environment).
//
// Input: SAF_PORTAL_JSON, written by `platform environment portal-inputs --pass 1|2|auto` from
// instance.yaml and core's images/images.json (pass 1: portalImageDigest '' and portalClientId '',
// no Container App; pass 2: the saf-portal digest and portal.clientId) and, with SMTP basic auth,
// `--smtp-secret present|absent` (whether the password secret exists in the environment vault, read
// by the pipeline through ARM: smtpPasswordSecretExists). Every value comes from that
// JSON: the CLI resolves schema defaults and fails on missing values, and Bicep type-checks the JSON
// when this file is compiled (keys it doesn't use are ignored). No other --parameters.

using '../portal.bicep'

var portal = json(readEnvironmentVariable('SAF_PORTAL_JSON'))

param prefix = portal.prefix
param environmentName = portal.environmentName
param location = portal.location
param tenantId = portal.tenantId
param network = portal.network
param azureDevOps = portal.azureDevOps
param database = portal.database
param portalImageDigest = portal.portalImageDigest
param portalClientId = portal.portalClientId
param vaultGeneration = portal.vaultGeneration
param environmentVault = portal.environmentVault
param smtpPasswordSecretName = portal.smtpPasswordSecretName
param smtpPasswordSecretExists = portal.smtpPasswordSecretExists
param managedBy = portal.managedBy
param tags = portal.tags
