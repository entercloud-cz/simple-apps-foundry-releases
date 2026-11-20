// Input of names.bicep, set by deploy.sh / prov-lib.sh as one JSON value:
//   SAF_NAMES_JSON={"prefix":"…","slug":"…","environmentName":"…","generation":null|<int>
//                   [,"networkMode":"externalOnly"|"externalHybrid"][,"cell":"01".."99"]
//                   [,"portalEnvironmentName":"…"][,"vaultName":"…"]
//                   [,"vaultGeneration":<int>][,"externalOnlyNetwork":"managed"|"vnet"]
//                   [,"incarnation":<int>]}
// Bicep reads and type-checks it when the file is compiled, so a missing variable or a wrong
// type fails before anything is evaluated. networkMode, cell, portalEnvironmentName, vaultName,
// vaultGeneration, externalOnlyNetwork and incarnation are optional (null when absent; provisioning
// only; incarnation is app.yaml's, ADR-0061, and names the Entra application's uniqueName).
using 'names.bicep'

var input = union({ networkMode: null, cell: null, portalEnvironmentName: null, vaultName: null, vaultGeneration: null, externalOnlyNetwork: null, incarnation: null }, json(readEnvironmentVariable('SAF_NAMES_JSON')))

param prefix = input.prefix
param slug = input.slug
param environmentName = input.environmentName
param generation = input.generation
param networkMode = input.networkMode
param cell = input.cell
param portalEnvironmentName = input.portalEnvironmentName
param vaultName = input.vaultName
param vaultGeneration = input.vaultGeneration
param externalOnlyNetwork = input.externalOnlyNetwork
param incarnation = input.incarnation
