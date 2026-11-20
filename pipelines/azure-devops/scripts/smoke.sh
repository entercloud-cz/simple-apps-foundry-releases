#!/usr/bin/env bash
# smoke.sh <resource group> <container app> <expected image> <auth mode> <liveness path> [client ID] [public host]
# Called by deploy.sh inside AzureCLI@2 after the release deployment, and by provisioning after a
# release and after the restart that follows an Easy Auth secret rotation (with the client ID).
# Public host: the app's custom host through Front Door when its ingress is locked to Front Door
# (release frontDoor with backendIpRanges, ADR-0010 amended 2026-11-11); the client ID may then be
# ''. Every probe goes through that host instead of the Container App's default FQDN, which answers
# only Front Door, and a direct request to the default FQDN must be refused (403, the IP rules).
#   1. The Container App's image is exactly <registry>/<repo>@<digest> of this run.
#   2. The latest revision reaches provisioningState Provisioned and healthState Healthy
#      (wakes the app with an HTTPS request first: minReplicas may be 0).
#   3. Through Front Door: a request to the default FQDN answers 403 (the ingress is locked;
#      sandbox 2026-11-11: "RBAC: access denied").
#   4. Authentication behaves as the release record says:
#        required  -> an anonymous request gets 401, or a redirect to the Entra login endpoint of
#                     the cloud (`az cloud show`), following at most 3 redirects within the app's
#                     own /.auth/ paths; with a client ID, that redirect must carry
#                     client_id=<client ID> (Easy Auth runs with the expected registration; a 401
#                     carries none and passes with a note);
#        anonymous -> the liveness path answers 2xx.
#      Through Front Door, connection errors and 502/503/504 are retried for up to 5 minutes (the
#      edge may still be waking a scaled-to-zero app).
# curl here only probes the app (no file is written: --output /dev/null); downloads live in
# install-tool.sh only.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

{ [ "$#" -ge 5 ] && [ "$#" -le 7 ]; } || { echo "usage: smoke.sh <resource group> <container app> <image> <auth mode> <liveness path> [client ID] [public host]" >&2; exit 2; }
rg="$1"
app="$2"
expected_image="$3"
auth_mode="$4"
liveness="$5"
client_id="${6:-}"
public_host="${7:-}"
case "$auth_mode" in required|anonymous) ;; *) saf_die "unknown authentication mode in the release record" ;; esac
[[ "$liveness" =~ ^/[A-Za-z0-9._~/-]*$ ]] || saf_die "the liveness path has unexpected characters"
[ -z "$client_id" ] || [[ "$client_id" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] || saf_die "the client ID is not a GUID"
[ -z "$public_host" ] || { [[ "$public_host" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$ ]] && [ "${#public_host}" -le 244 ]; } \
  || saf_die "the public host is not a host name"

# Its own folder per call: provisioning runs several apps' smoke tests at the same time (ADR-0046).
mkdir -p "$SAF_WORK"
work="$(mktemp -d "$SAF_WORK/smoke.XXXXXXXX")"
timeout_s=600

az resource show --resource-group "$rg" --name "$app" --resource-type Microsoft.App/containerApps \
  --query '{id: id, image: properties.template.containers[0].image, latest: properties.latestRevisionName, fqdn: properties.configuration.ingress.fqdn}' \
  --output json --only-show-errors > "$work/app.json"
image="$(jq -r '.image // empty' "$work/app.json")"
[ "$image" = "$expected_image" ] || saf_die "the Container App does not run the image of this run"
app_id="$(jq -er '.id' "$work/app.json")"
latest="$(jq -er '.latest' "$work/app.json")"
fqdn="$(jq -er '.fqdn' "$work/app.json")"
[[ "$latest" =~ ^[a-z0-9-]+$ ]] || saf_die "unexpected revision name"
[[ "$fqdn" =~ ^[a-z0-9.-]+$ ]] || saf_die "unexpected ingress FQDN"
url="https://$fqdn$liveness"
# Behind a locked ingress only Front Door reaches the app: probe through the custom host.
host="$fqdn"
if [ -n "$public_host" ]; then
  host="$public_host"
  url="https://$public_host$liveness"
fi

probe() { # probe <url> -> "<http code> <redirect url>"
  curl --proto '=https' --silent --show-error --output /dev/null --max-time 30 \
    --write-out '%{http_code} %{redirect_url}' "$1" 2>/dev/null || printf '000 '
}

# 2. Revision health
saf_info "Waiting for revision $latest"
deadline=$((SECONDS + timeout_s))
while :; do
  probe "$url" >/dev/null
  az resource show --ids "$app_id/revisions/$latest" \
    --query '{provisioning: properties.provisioningState, health: properties.healthState, running: properties.runningState}' \
    --output json --only-show-errors > "$work/revision.json" 2>/dev/null || printf '{}' > "$work/revision.json"
  provisioning="$(jq -r '.provisioning // ""' "$work/revision.json" | tr -cd 'A-Za-z')"
  health="$(jq -r '.health // ""' "$work/revision.json" | tr -cd 'A-Za-z')"
  # A minReplicas 0 revision reaches Healthy after the wake-up request well within the timeout
  # (sandbox, 2026-10-29).
  if [ "$provisioning" = Provisioned ] && [ "$health" = Healthy ]; then
    break
  fi
  [ "$provisioning" != Failed ] || saf_die "revision $latest failed to provision"
  [ "$SECONDS" -lt "$deadline" ] || saf_die "revision $latest is not healthy after $timeout_s s (provisioning: ${provisioning:-unknown}, health: ${health:-unknown})"
  sleep 15
done
saf_info "Revision $latest is provisioned and healthy."

# Through Front Door: a connection error (000) or a gateway error is retried for up to 5 minutes.
transient() { # transient <http code>: true when a retry through Front Door may still succeed
  [ -n "$public_host" ] && [[ "$1" =~ ^(000|502|503|504)$ ]] && [ "$SECONDS" -lt "$fd_deadline" ]
}
fd_deadline=$((SECONDS + 300))

# 3. The ingress is locked: the default FQDN refuses a request from outside Front Door's ranges.
if [ -n "$public_host" ]; then
  read -r code _ <<<"$(probe "https://$fqdn$liveness")"
  [ "$code" = 403 ] || saf_die "the ingress is not locked to Front Door: a direct request to the default host answered $code, expected 403"
  saf_info "The default host refuses requests from outside Front Door (403)."
fi

# 4. Authentication
if [ "$auth_mode" = required ]; then
  login="$(az cloud show --query endpoints.activeDirectory --output tsv --only-show-errors)"
  login="${login%/}"
  [[ "$login" =~ ^https://[a-z0-9.-]+$ ]] || saf_die "unexpected Entra login endpoint for this cloud"
  target="$url"
  hops=0
  while [ "$hops" -lt 4 ]; do
    read -r code location <<<"$(probe "$target")"
    if transient "$code"; then
      saf_info "Front Door answered $code for https://$host; retrying in 15 s."
      sleep 15
      continue
    fi
    hops=$((hops + 1))
    case "$code" in
      401)
        saf_info "Easy Auth answers 401 to anonymous requests.${client_id:+ (No redirect, so the client ID was not checked.)}"
        exit 0
        ;;
      301|302|303|307|308)
        if [[ "$location" == "$login/"* ]]; then
          if [ -n "$client_id" ] && [[ "${location,,}" != *"client_id=${client_id,,}"* ]]; then
            saf_die "the Entra sign-in redirect does not name the app registration's client ID"
          fi
          saf_info "Easy Auth redirects anonymous requests to the Entra sign-in page${client_id:+ of the expected registration}."
          exit 0
        elif [[ "$location" == "https://$host/.auth/"* ]]; then
          target="$location"
          continue
        fi
        saf_die "anonymous request is redirected somewhere other than the Entra sign-in page"
        ;;
      2*)
        saf_die "the app answers anonymous requests although authentication is required (Easy Auth missing)"
        ;;
      *)
        saf_die "unexpected HTTP status $code for an anonymous request"
        ;;
    esac
  done
  saf_die "too many redirects before the Entra sign-in page"
else
  wait_s=180
  [ -z "$public_host" ] || wait_s=300
  deadline=$((SECONDS + wait_s))
  while :; do
    read -r code _ <<<"$(probe "$url")"
    case "$code" in
      2*) saf_info "Liveness path answers $code (anonymous app)."; exit 0 ;;
    esac
    [ "$SECONDS" -lt "$deadline" ] || saf_die "liveness path did not answer 2xx (last status $code)"
    sleep 10
  done
fi
