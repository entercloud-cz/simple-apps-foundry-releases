#!/usr/bin/env bash
# fake-az.sh — the `az` of check-prov-scale.sh (ADR-0050): serves the fake Azure state that
# state.mjs wrote ($FAKE_STATE) and records every call, one line "<job>\t<kind>" in $FAKE_CALLS.
# A call it doesn't know fails loudly (so a new per-app read shows up in the test).
set -euo pipefail

state="${FAKE_STATE:?}"
log() { printf '%s\t%s\n' "${FAKE_JOB:-?}" "$1" >> "${FAKE_CALLS:?}"; }

# The value of an option (--name value).
opt() {
  local want="$1" prev=""
  shift
  for a in "$@"; do
    if [ "$prev" = "$want" ]; then printf '%s' "$a"; return 0; fi
    prev="$a"
  done
  return 1
}

case "$1 ${2:-}" in
  "account show") log "account show"; cat "$state/sub"; echo ;;
  "cloud show") log "cloud show"; echo "https://management.azure.com/" ;;
  "config set") log "config set" ;;
  "bicep version") log "bicep version"; bicep --version ;;
  "bicep build") log "bicep build" ;;
  "bicep build-params")
    log "bicep build-params (per app)"
    jq -n '{templateJson: "{}", parametersJson: ({parameters: {registration: {value: {fake: true}}}} | tojson)}'
    ;;
  "group list") log "group list"; cat "$state/groups.json" ;;
  "deployment sub")
    case "$3" in
      list) log "deployment sub list"; cat "$state/lz.json" ;;
      show) log "deployment sub show (per app)"; echo "ERROR: (DeploymentNotFound) not found" >&2; exit 1 ;;
      *) log "UNEXPECTED $*"; exit 1 ;;
    esac
    ;;
  "deployment group")
    rg="$(opt --resource-group "$@")"
    case "$3" in
      list)
        log "deployment group list $rg"
        # ADR-0063: the instance's rg-contoso-entra, an environment's rg-contoso-entra-<env> (no state file:
        # the group doesn't exist), else the platform resource group.
        if [[ "$rg" == *-entra ]]; then cat "$state/entra.json"
        elif [[ "$rg" == *-entra-* ]]; then
          [ -f "$state/entra-${rg##*-entra-}.json" ] || { echo "ERROR: (ResourceGroupNotFound) Resource group '$rg' could not be found." >&2; exit 3; }
          cat "$state/entra-${rg##*-entra-}.json"
        else cat "$state/fd.json"; fi
        ;;
      show)
        name="$(opt --name "$@")"
        log "deployment group show (per app)"
        # An Entra record only in the group whose state lists it (ADR-0063: the plan names the group).
        file="$state/fd.json"
        if [[ "$rg" == *-entra ]]; then file="$state/entra.json"; elif [[ "$rg" == *-entra-* ]]; then file="$state/entra-${rg##*-entra-}.json"; fi
        if [[ "$name" == entra-* ]] && [ -f "$file" ] && jq -e --arg n "$name" 'any(.[]; .name == $n)' "$file" > /dev/null; then
          jq -n --arg n "$name" '{name: $n, properties: {provisioningState: "Succeeded", templateHash: "1", timestamp: "2026-10-01T00:00:00.0000000Z",
            parameters: {registration: {value: {fake: true}}}, outputs: {clientId: {value: "00000000-0000-0000-0000-00000000d001"}}}}'
        else
          echo "ERROR: (DeploymentNotFound) not found" >&2
          exit 1
        fi
        ;;
      *) log "UNEXPECTED $*"; exit 1 ;;
    esac
    ;;
  "rest --method")
    method="$3"
    url="$(opt --url "$@")"
    path="${url%%\?*}"
    path="${path#https://management.azure.com}"
    if [ "$method" = post ] && [[ "$path" == */calculateTemplateHash ]]; then
      log "rest calculateTemplateHash (per app)"
      echo '{"templateHash": "1"}'
      exit 0
    fi
    [ "$method" = get ] || { log "UNEXPECTED $*"; exit 1; }
    n=0
    # shellcheck disable=SC2016 # the literal text $skipToken= of an ARM nextLink
    if [[ "$url" == *'$skipToken='* ]]; then n="${url##*\$skipToken=}"; fi
    # shellcheck disable=SC2001 # capture groups, clearer with sed
    case "$path" in
      */providers/Microsoft.App/containerApps) key=ca; kind="list Container Apps" ;;
      */providers/Microsoft.App/jobs) key="jobs-$(sed 's|.*/rg-contoso-platform-\([a-z0-9]*\)/.*|\1|' <<<"$path")"; kind="list jobs" ;;
      */vaults/*/secrets)
        v="${path%/secrets}"
        # A vault lives in its own environment's platform resource group: a list in another group
        # is what ARM answers with ParentResourceNotFound (sandbox runs 3396 to 3412).
        [[ "$path" == */rg-contoso-platform-"${v##*-}"/providers/* ]] || { log "UNEXPECTED vault in another resource group: $path"; exit 1; }
        key="secrets-${v##*/}"; kind="list vault secrets" ;;
      */[cC]ontainer[aA]pps/*/revisions)
        a="${path%/revisions}"
        # shellcheck disable=SC2001 # a capture group, clearer with sed
        e="$(sed 's|.*/rg-contoso-app-.*-\([a-z0-9]*\)/providers/.*|\1|' <<<"$path")"
        key="rev-${a##*/}-$e"
        kind="list revisions (per app)"
        ;;
      *) log "UNEXPECTED $*"; exit 1 ;;
    esac
    [ "$n" = 0 ] || kind="$kind (next page)"
    log "$kind"
    cat "$state/pages/$key-$n.json"
    ;;
  *) log "UNEXPECTED $*"; echo "fake az: unexpected call: $*" >&2; exit 1 ;;
esac
