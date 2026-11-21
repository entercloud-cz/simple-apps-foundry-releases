// Input of platform-names.bicep, set by scripts/platform/plat-lib.sh as one JSON value:
//   SAF_PLATFORM_NAMES_JSON={"prefix":"…","environmentName":"…","modes":["externalOnly"|"externalHybrid", …],"vaultGeneration":0}
// Bicep reads and type-checks it when the file is compiled, so a missing variable or a wrong type
// fails before anything is evaluated.
using 'platform-names.bicep'

var input = json(readEnvironmentVariable('SAF_PLATFORM_NAMES_JSON'))

param prefix = input.prefix
param environmentName = input.environmentName
param modes = input.modes
param vaultGeneration = input.vaultGeneration
