#!/usr/bin/env bash
# report.sh — last step of the deployment job `release` of every deploy stage (deploy.yml and
# promote.yml through templates/steps/deployment-finish.yml): tells the portal that this job ran
# (ADR-0037 decision 1). AzureCLI@2 runs it with the job's own service connection sc-{slug}-{env},
# so it acts as the delivery identity id-{prefix}-{slug}-deploy-{env}.
#
#   1. `platform pipeline portal-target`: portal.clientId and portal.apiBaseUrl from instance.yaml
#      (platform-config). Either one missing: the CLI prints one SKIP line, nothing is sent.
#   2. `az account get-access-token --scope api://{clientId}/.default`: an app-only Entra token of
#      the delivery identity for the portal API. It is masked at once (task.setsecret) and written
#      only to a mode-600 header file that curl reads: never to the log, an argument or the
#      environment.
#   3. POST {apiBaseUrl}/api/pipeline/apps/{slug}/environments/{env}/deploy-events with
#      {"runId": Build.BuildId, "attempt": System.JobAttempt, "result": Agent.JobStatus lowercased}.
#      2xx: accepted (the portal answers 202). Network errors, 408, 429 and 5xx (503: portal not
#      ready) are retried 3 times after 10, 30 and 60 s; 400, 401, 403, 404 and any other answer
#      are not. HTTPS only, no redirects followed: the token goes to apiBaseUrl and nowhere else.
#
# The portal trusts nothing here beyond "look at run N": it checks that the token belongs to the
# delivery identity of {slug}/{env} and re-reads the run, its timeline and its artifacts from
# Azure DevOps with its own identity. So this step never fails the run: every problem is a
# warning and the script always exits 0 (EXIT trap). The template adds continueOnError (a failed
# login before the script) and a timeout. No job token and no pipeline OIDC token are used
# (ADR-0037 decision 5); no xtrace.
#
# Env (template constants): SAF_SLUG, SAF_ENV_NAME, SAF_SERVICE_CONNECTION, SAF_JOB_STATUS
# ($(Agent.JobStatus): Succeeded, SucceededWithIssues, Failed or Canceled). Predefined:
# BUILD_BUILDID, SYSTEM_JOBATTEMPT, PIPELINE_WORKSPACE, AGENT_TOOLSDIRECTORY.

set -euo pipefail

hdr=""

report_warn() {
  printf '##vso[task.logissue type=warning]Deploy event not sent to the portal: %s\n' "$*"
}

# The only way out of this script: removes the header file and ends with exit 0, also after an
# unexpected error (set -e), which becomes a warning.
report_exit() {
  local rc=$?
  if [ -n "$hdr" ]; then rm -f "$hdr" || true; fi
  if [ "$rc" -ne 0 ]; then report_warn "unexpected error (status $rc)"; fi
  exit 0
}
trap report_exit EXIT

# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

skip() { # skip <warning>: a warning, then the EXIT trap (exit 0)
  report_warn "$*"
  exit 0
}

for name in SAF_SLUG SAF_ENV_NAME SAF_SERVICE_CONNECTION SAF_JOB_STATUS BUILD_BUILDID SYSTEM_JOBATTEMPT; do
  [ -n "${!name:-}" ] || skip "environment variable $name is not set (template bug)"
done
[[ "$SAF_SLUG" =~ ^[a-z](-?[a-z0-9])+$ ]] || skip "SAF_SLUG has an invalid shape"
[[ "$SAF_ENV_NAME" =~ ^[a-z][a-z0-9]{1,7}$ ]] || skip "SAF_ENV_NAME has an invalid shape"
# The token must be the delivery identity of exactly this app and environment (naming.bicep
# adoServiceConnection; tests/check-templates.py T15 and T30 check the template side).
[ "$SAF_SERVICE_CONNECTION" = "sc-$SAF_SLUG-$SAF_ENV_NAME" ] || skip "the step does not run with sc-$SAF_SLUG-$SAF_ENV_NAME (template bug)"
[[ "$BUILD_BUILDID" =~ ^[1-9][0-9]{0,9}$ ]] || skip "BUILD_BUILDID is not a run id"
[[ "$SYSTEM_JOBATTEMPT" =~ ^[1-9][0-9]{0,4}$ ]] || skip "SYSTEM_JOBATTEMPT is not a number"
result="${SAF_JOB_STATUS,,}"
case "$result" in
  succeeded|succeededwithissues|failed|canceled) ;;
  *) skip "unknown job status" ;;
esac

work="$SAF_WORK/report"
rm -rf "$work"
mkdir -p "$work"

# 1. Where to report: instance.yaml, validated by the CLI (both values '' when not set).
[ -f "$SAF_CLI" ] || skip "the platform CLI is not built (an earlier step failed)"
command -v node >/dev/null || skip "node is not installed (an earlier step failed)"
[ -f "$SAF_CONFIG/instance.yaml" ] || skip "platform-config has no instance.yaml (an earlier step failed?)"
if ! saf_cli pipeline portal-target --instance "$SAF_CONFIG/instance.yaml" --output "$work/portal.json"; then
  skip "instance.yaml could not be read (see above)"
fi
client_id="$(jq -r '.clientId' "$work/portal.json")"
base_url="$(jq -r '.apiBaseUrl' "$work/portal.json")"
if [ -z "$client_id" ] || [ -z "$base_url" ]; then
  exit 0 # not configured: the CLI printed the SKIP line
fi
[[ "$client_id" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]] \
  || skip "portal.clientId is not a GUID"
[[ "$base_url" =~ ^https://[a-z0-9.-]+(:[0-9]{1,5})?$ ]] || skip "portal.apiBaseUrl is not an https origin"
url="$base_url/api/pipeline/apps/$SAF_SLUG/environments/$SAF_ENV_NAME/deploy-events"

jq -cn --argjson runId "$BUILD_BUILDID" --argjson attempt "$SYSTEM_JOBATTEMPT" --arg result "$result" \
  '{runId: $runId, attempt: $attempt, result: $result}' > "$work/body.json"

# 2. The delivery identity's token for the portal API, masked before anything else.
if ! token="$(az account get-access-token --scope "api://$client_id/.default" --query accessToken --output tsv --only-show-errors 2> "$work/token.err")"; then
  saf_neutralise < "$work/token.err" | tail -n 5
  skip "no token for api://$client_id (does the portal registration expose that identifier URI?)"
fi
[ -n "$token" ] || skip "az returned an empty token for api://$client_id"
printf '##vso[task.setsecret]%s\n' "$token"
hdr="$work/authorization.header"
(umask 077 && printf 'Authorization: Bearer %s\n' "$token" > "$hdr")
unset token

# 3. POST, retried on network errors, 408, 429 and 5xx.
saf_info "Deploy event: run $BUILD_BUILDID, attempt $SYSTEM_JOBATTEMPT, $result -> $url"
delays=(10 30 60)
try=0
while :; do
  try=$((try + 1))
  code="$(curl --proto '=https' --tlsv1.2 --silent --show-error --connect-timeout 10 --max-time 30 \
      --request POST --header @"$hdr" --header 'Content-Type: application/json' \
      --data-binary @"$work/body.json" --output "$work/response" --write-out '%{http_code}' \
      "$url" 2> "$work/curl.err")" || code="000"
  # At most 300 bytes of the answer, every character outside a plain set (newlines, `#`, `%`, `[`)
  # replaced by a space, so it can't become or alter a logging command.
  answer="$(head -c 300 "$work/response" 2>/dev/null | tr -c 'A-Za-z0-9 .,:_()"{}=+-' ' ' || true)"
  case "$code" in
    2[0-9][0-9])
      saf_info "Deploy event accepted by the portal (HTTP $code)."
      exit 0
      ;;
    000|408|429|5[0-9][0-9]) ;;
    400) skip "the portal rejected the request body (HTTP 400) ${answer}" ;;
    401) skip "the portal rejected the token (HTTP 401): check portal.clientId and the portal's tenant ${answer}" ;;
    403) skip "the portal does not accept this delivery identity for $SAF_SLUG in $SAF_ENV_NAME (HTTP 403) ${answer}" ;;
    404) skip "the portal does not know $SAF_SLUG in $SAF_ENV_NAME (HTTP 404) ${answer}" ;;
    *) skip "unexpected answer from the portal (HTTP $code) ${answer}" ;;
  esac
  if [ "$code" = 000 ]; then
    saf_neutralise < "$work/curl.err" | tail -n 3
  fi
  if [ "$try" -gt "${#delays[@]}" ]; then
    skip "the portal did not accept it after $try attempts (last: HTTP $code, 000 = no answer)"
  fi
  saf_info "Attempt $try: HTTP $code (000 = no answer); retry in ${delays[$((try - 1))]} s"
  sleep "${delays[$((try - 1))]}"
done
