#!/usr/bin/env bash
# preview.sh — job `preview` of stage preview_<env> (promotion environment of kind prod), run by
# AzureCLI@2 with the environment's service connection BEFORE the approval of deploy_<env>.
# Shows the approver what approving would do; changes nothing:
#   1. the release that would be deployed: this run's commit and digest, the image reference in the
#      environment's registry, and the run/commit/image currently deployed (Container App tags);
#      notes when a newer run is already deployed (deploy_<env> would then do nothing);
#   2. the scan gate against today's instance.yaml (`platform pipeline scan-gate`, not enforced
#      here; deploy_<env> enforces it);
#   3. `az deployment group what-if` of release.bicep through release.bicepparam with this run's
#      release manifest and the environment's release record (same inputs as the deployment).
# Output: $(Pipeline.Workspace)/saf-out/preview/{summary.md, whatif.json, verdict.json}, uploaded
# as the run summary and the artifact preview-<env>. What-if differences never fail the job;
# errors do (no release record, invalid inputs, what-if failure).
#
# Env (template constants): SAF_SLUG, SAF_ENV_NAME, SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION,
# SAF_ADO_ENVIRONMENT, SAF_ACTION (deliver | redeploy: the manifest is the earlier run's,
# republished by the `source` stage with source.json). Predefined: BUILD_BUILDID. Restricted logging commands; only fixed text
# and values with a checked shape go to the log and the summary.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_SLUG SAF_ENV_NAME SAF_PROMOTE_FROM SAF_SERVICE_CONNECTION SAF_ADO_ENVIRONMENT BUILD_BUILDID
saf_check_names
[[ "$BUILD_BUILDID" =~ ^[0-9]+$ ]] || saf_die "BUILD_BUILDID is not a number"
[[ "$SAF_PROMOTE_FROM" =~ ^[a-z][a-z0-9]{1,7}$ ]] || saf_die "SAF_PROMOTE_FROM has an invalid shape"

work="$SAF_WORK/preview"
out="$SAF_OUT/preview"
rm -rf "$work"
mkdir -p "$work" "$out"
manifest="$SAF_WS/release-manifest/release-manifest.json"
trivy_json="$SAF_WS/scan/trivy.json"
[ -f "$manifest" ] || saf_die "artifact release-manifest is missing"
[ -f "$trivy_json" ] || saf_die "artifact scan has no trivy.json"
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

# shellcheck source=release-lib.sh
source "$SAF_DELIVERY/scripts/release-lib.sh"

saf_bicep_pin_check
saf_environment

[ "$(jq -r '.slug' "$manifest")" = "$SAF_SLUG" ] || saf_die "the release manifest is for a different app"
digest="$(jq -er '.digest' "$manifest")"
commit="$(jq -er '.commit' "$manifest")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "the release manifest has no valid digest"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || saf_die "the release manifest has no valid commit"
image_run_id="$(jq -r '.runId' "$manifest")"
[[ "$image_run_id" =~ ^[0-9]+$ ]] || saf_die "the release manifest has no valid runId"
action="${SAF_ACTION:-deliver}"
headline=""
case "$action" in
  deliver) ;;
  redeploy)
    source_json="$SAF_WS/release-manifest/source.json"
    [ -f "$source_json" ] || saf_die "source.json is missing next to the release manifest"
    source_path="$(jq -r '.path' "$source_json")"
    case "$source_path" in rollback|promotion) ;; *) saf_die "source.json has no valid path" ;; esac
    headline="Redeploy of run $image_run_id ($commit) to $SAF_ENV_NAME ($source_path)."
    ;;
  *) saf_die "SAF_ACTION must be deliver or redeploy" ;;
esac

# 1. Release record, current state, target registry
saf_release_record
saf_deployed_run
saf_registry
current_image="$(jq -r '.image // ""' "$work/app-current.json" | tr -cd 'a-z0-9.:/@_-')"
new_image="$login_server/$repository@$digest"

# 2. Scan gate (informational here)
saf_cli pipeline scan-gate --trivy "$trivy_json" --instance "$SAF_CONFIG/instance.yaml" --output "$out/verdict.json"

# 3. What-if with exactly the deployment's inputs.
# TODO(verify): what-if through release.bicepparam (SAF_RELEASE_JSON) as the prod delivery
# identity (App Deployer has deployments/whatIf/action) and the JSON shape of
# --result-format FullResourcePayloads --no-pretty-print (changes[].changeType/resourceId/delta).
# The image digest is not in the prod registry yet; what-if is expected not to check it.
saf_cli pipeline release-params --record "$work/record.json" --manifest "$manifest" --env "$work/env.json" --output "$work/release.json"
if ! SAF_RELEASE_JSON="$(cat "$work/release.json")" az deployment group what-if \
    --resource-group "$rg" \
    --name "$deployment" \
    --parameters "$release_param" \
    --result-format FullResourcePayloads \
    --no-pretty-print \
    --only-show-errors --output json > "$out/whatif.json" 2> "$work/whatif.err"; then
  saf_neutralise < "$work/whatif.err" | tail -n 30
  saf_die "what-if of the release failed"
fi

# Summary (Markdown for the run's Extensions tab). Only names, change types and property paths
# from what-if, never property values: env values from platform.yaml stay out of the summary.
# jq's `c` keeps a conservative character set, so no Markdown or HTML can be injected.
jq_c='def c: tostring | gsub("[^A-Za-z0-9 ._:/@()\\[\\]-]"; "");'
gate_line="$(jq -r "$jq_c"' if .pass == null then "not decided (provider \(.provider | c))"
  elif .pass then "passes" else "BLOCKS: \(.blocking | length) finding(s)" end' "$out/verdict.json")"
counts="$(jq -r "$jq_c"' .counts | "CRITICAL \(.CRITICAL | c), HIGH \(.HIGH | c), MEDIUM \(.MEDIUM | c), LOW \(.LOW | c), UNKNOWN \(.UNKNOWN | c)"' "$out/verdict.json")"
# shellcheck disable=SC2016 # backticks are Markdown code spans, not command substitution
{
  printf '## Preview: %s to %s\n\n' "$SAF_SLUG" "$SAF_ENV_NAME"
  if [ -n "$headline" ]; then
    printf '**%s**\n\n' "$headline"
  fi
  if [ "$action" = deliver ] && saf_newer_run_deployed; then
    printf '> **Run %s, newer than this run, is already deployed.** Approving changes nothing: the deploy stage will skip.\n\n' "$deployed_run"
  fi
  printf '| | To deploy | Deployed now |\n|---|---|---|\n'
  printf '| Run | %s | %s |\n' "$image_run_id" "${deployed_run:-unknown}"
  printf '| Commit | `%s` | `%s` |\n' "$commit" "${deployed_commit:-unknown}"
  printf '| Image | `%s` | `%s` |\n\n' "$new_image" "${current_image:-unknown}"
  printf 'Promoted from **%s**. Scan gate with today'"'"'s instance settings: **%s** (%s).\n\n' "$SAF_PROMOTE_FROM" "$gate_line" "$counts"
  printf '### What-if\n\n| Change | Resource |\n|---|---|\n'
  jq -r "$jq_c"' .changes[]? | "| \(.changeType | c) | \(.resourceId | split("/") | .[-2:] | join("/") | c) |"' "$out/whatif.json"
  printf '\nChanged properties:\n\n'
  jq -r "$jq_c"' [.changes[]? | select(.changeType == "Modify") | .delta[]? | ..
         | objects | select(has("path") and has("propertyChangeType"))
         | "- \(.path | c) (\(.propertyChangeType | c))"] | .[:50][]' "$out/whatif.json"
} > "$out/summary.md"

saf_info "Preview written: $(jq -r "$jq_c"' [.changes[]?.changeType] | group_by(.) | map("\(.[0] | c) \(length)") | join(", ")' "$out/whatif.json")."
