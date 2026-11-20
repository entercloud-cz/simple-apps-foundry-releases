// The only parameter file of an instance's bootstrap of one environment subscription (bootstrap.bicep,
// ADR-0031, ADR-0066): deployment bootstrap-{prefix}-{env} at subscription scope, run by a person with
// Owner through infra/platform/instance/instance.sh bootstrap <env> [--pass 2] (what-if by default).
//
// Input: SAF_INSTANCE_JSON, written by `platform instance inputs bootstrap --env <name> --pass 1|2` from
// instance.yaml and the instance's state: outside the portal host the host's bootstrap outputs
// (instancePrincipals), on pass 2 the service connections' issuer and subject read back from Azure
// DevOps (federation). Every value comes from that JSON: the CLI resolves schema defaults and fails on
// missing values, and Bicep type-checks the JSON when this file is compiled (keys it doesn't use are
// ignored). No other --parameters.

using '../bootstrap.bicep'

var instance = json(readEnvironmentVariable('SAF_INSTANCE_JSON'))

param prefix = instance.prefix
param environmentName = instance.environmentName
param location = instance.location
param instanceIdentities = instance.instanceIdentities
param entraEnvironments = instance.entraEnvironments
param federation = instance.federation
param instancePrincipals = instance.instancePrincipals
param managedBy = instance.managedBy
param tags = instance.tags
