#!/usr/bin/env bash
# fake-bicep.sh — the `bicep` of check-prov-scale.sh: the pinned version, and `snapshot` of
# names.bicepparam with the names the Entra plan reads (naming.bicep's patterns; the real ones are
# checked against infra/tests/naming-vectors.json elsewhere). Records each call like fake-az.sh.
# A snapshot in a plan job (plan_<env>, decide-read) names the environment vaults (prov_mode_vaults,
# ADR-0060: once per vault variant, never per app; the test checks that 14 and 300 apps make the same
# number of them); anywhere else it is a per-app read. The environment vault is the state's
# kv-{prefix}-{env} (what the fake landing-zone records name), so the steady state reads the same vaults.
set -euo pipefail

case "${FAKE_JOB:-?}" in
  plan_* | decide-read) kind=" (environment vault)" ;;
  *) kind=" (per app)" ;;
esac
printf '%s\t%s\n' "${FAKE_JOB:-?}" "bicep ${1:-}$([ "${1:-}" = snapshot ] && echo "$kind")" >> "${FAKE_CALLS:?}"
case "${1:-}" in
  --version) echo "Bicep CLI version ${FAKE_BICEP_VERSION:?} (fake)" ;;
  snapshot)
    param="$2"
    jq -n --argjson n "${SAF_NAMES_JSON:?}" '{outputs: ({
        appResourceGroup: "rg-\($n.prefix)-app-\($n.slug)-\($n.environmentName)",
        entraResourceGroup: "rg-\($n.prefix)-entra",
        entraEnvironmentResourceGroup: "rg-\($n.prefix)-entra-\($n.environmentName)",
        entraDeployment: "entra-\($n.slug)-\($n.environmentName)",
        entraApplicationUniqueName: (if $n.incarnation == null then null elif $n.incarnation == 0 then "\($n.prefix)-\($n.slug)-\($n.environmentName)" else "\($n.prefix)-\($n.slug)-\($n.environmentName)--i\($n.incarnation)" end),
        platformResourceGroup: "rg-\($n.prefix)-platform-\($n.environmentName)",
        easyAuthSecret: "easyauth-\($n.slug)",
        containerApp: "ca-\($n.slug)",
        releaseDeployment: "release-\($n.slug)",
        frontDoorDeployment: "fd-\($n.slug)-\($n.environmentName)",
        provisioningDeployment: "lz-\($n.slug)-\($n.environmentName)"}
      + (if $n.networkMode == null then {} else {
        kvsetJob: "caj-\($n.prefix)-kvset-\(if $n.networkMode == "externalHybrid" then "hyb" else "ext" end)",
        dbinitJob: "caj-\($n.prefix)-dbinit-\(if $n.networkMode == "externalHybrid" then "hyb" else "ext" end)",
        managedEnvironment: "cae-\($n.prefix)-\(if $n.networkMode == "externalHybrid" then "hyb" else "ext" end)-\($n.environmentName)"} end)
      + (if $n.networkMode == null or $n.vaultGeneration == null then {} else {
        environmentVault: "kv-\($n.prefix)-\($n.environmentName)"} end))}' > "${param%.bicepparam}.snapshot.json"
    ;;
  *) echo "fake bicep: unexpected call: $*" >&2; exit 1 ;;
esac
