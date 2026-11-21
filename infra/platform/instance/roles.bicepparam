// The only parameter file of an instance's custom role definitions (roles.bicep, ADR-0021, ADR-0043,
// ADR-0066): deployment roles-{prefix} at subscription scope in the portal host environment's
// subscription, run by a person with Owner or User Access Administrator on every environment
// subscription through infra/platform/instance/instance.sh roles (what-if by default).
//
// Input: SAF_INSTANCE_JSON, written by `platform instance inputs roles` from instance.yaml (every
// environment's subscription, once each). Every value comes from that JSON, and Bicep type-checks it
// when this file is compiled (keys it doesn't use are ignored). No other --parameters.

using '../roles.bicep'

var instance = json(readEnvironmentVariable('SAF_INSTANCE_JSON'))

param prefix = instance.prefix
param environmentSubscriptionIds = instance.environmentSubscriptionIds
