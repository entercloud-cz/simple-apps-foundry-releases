// The only parameter file the provisioning pipeline deploys app-registration.bicep with
// (deployment entra-{slug}-{env}, Entra provisioning identity, Microsoft Graph Bicep).
//
// Input: SAF_ENTRA_JSON, written by `platform provisioning inputs --step entra` from
// apps/{slug}/app.yaml (title, incarnation, roles, assignments), instance.yaml and the run's state (the
// Container App's default host name, a landing-zone value). No other --parameters.

using '../app-registration.bicep'

var entra = json(readEnvironmentVariable('SAF_ENTRA_JSON'))

param prefix = entra.prefix
param environmentName = entra.environmentName
param environmentKind = entra.environmentKind
param slug = entra.slug
param incarnation = entra.incarnation
param appTitle = entra.appTitle
param hosts = entra.hosts
param appRoles = entra.appRoles
param roleAssignments = entra.roleAssignments
