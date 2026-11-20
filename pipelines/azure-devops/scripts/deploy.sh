#!/usr/bin/env bash
# deploy.sh — deployment job `release` of stage deploy_<env>, run by AzureCLI@2 with the app's
# per-environment service connection (sc-{slug}-{env}, workload identity federation, delivery
# identity; ADR-0021). Two actions (SAF_ACTION):
#   deliver   (default) release this run's image: verify -> deploy stages;
#   redeploy  release the image of an EARLIER run (sourceRunId) to one environment: the `source`
#             stage verified that run and republished its release manifest (+ source.json,
#             release-result-<S>, scan) into this run. Build environment: the digest must still be
#             in the registry (no push). Promotion environment: rollback when the digest is in the
#             registry, otherwise import from S's registry (promotion of an earlier build). No
#             newer-run guard: going back is the point (prod: approval on the environment).
# and two modes:
#   push    build environment (SAF_PROMOTE_FROM empty): the image archive of this run is pushed BY
#           DIGEST with oras (stage from templates/stages/deploy.yml);
#   import  promotion environment (SAF_PROMOTE_FROM = S): the image is imported BY DIGEST from S's
#           registry with `az acr import` (templates/stages/promote.yml). Never oras cp / push:
#           the promotion identity has no push right (ACR-7).
#
#   a. az must be logged in to the environment's subscription (instance.yaml), and the
#      environment's promoteFrom must equal SAF_PROMOTE_FROM.
#   b. names.bicep (#1) -> app resource group and release-{slug}; the last release-{slug}
#      deployment's parameters are the release record (platform-owned values).
#   c. Newer-run guard (deliver only): when the Container App's tag saf-run-id names a newer run
#      than this one, nothing is changed (warning, result `skipped-newer-deployed`, exit 0).
#   d. names.bicep (#2, record generation) -> the environment's registry.
#   e. Publishes the image (push or import; tag = commit, or {commit}-{runId} when that tag holds
#      another digest) and checks the registry resolves the digest.
#   f. `platform pipeline release-params` -> release.json (also `run: {id, commit}`, written to the
#      Container App tags); deploys release.bicep with infra/app/delivery/release.bicepparam as
#      the ONLY --parameters (deployedBy = delivery is a literal there). Retries only when
#      `classify-deploy-error` prints exactly `retry` (RBAC propagation), backoff 30/60/120/240 s.
#   g. smoke.sh: revision image == registry/repo@digest, revision healthy, auth behaviour.
#   h. release-result.json + summary.md (artifact release-result-<env>): promotion stages read
#      `result`, `digest`, `registryId`, `loginServer` and `repository` from it.
#
# Env (template constants): SAF_SLUG, SAF_ENV_NAME, SAF_SERVICE_CONNECTION, SAF_ADO_ENVIRONMENT,
# SAF_PROMOTE_FROM (import mode), SAF_ACTION (deliver | redeploy). Predefined: BUILD_BUILDID, PIPELINE_WORKSPACE,
# AGENT_TOOLSDIRECTORY. The step runs with `target.commands: restricted`: only `task.setsecret`
# and `task.logissue` are used. Nothing read from the app (platform.yaml values inside
# release.json, ARM error text) is printed unless neutralised.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_SLUG SAF_ENV_NAME SAF_SERVICE_CONNECTION SAF_ADO_ENVIRONMENT BUILD_BUILDID
saf_check_names
[[ "$BUILD_BUILDID" =~ ^[0-9]+$ ]] || saf_die "BUILD_BUILDID is not a number"
promote_from="${SAF_PROMOTE_FROM:-}"
if [ -n "$promote_from" ]; then
  [[ "$promote_from" =~ ^[a-z][a-z0-9]{1,7}$ ]] || saf_die "SAF_PROMOTE_FROM has an invalid shape"
  [ "$promote_from" != "$SAF_ENV_NAME" ] || saf_die "an environment cannot promote from itself"
  mode=import
else
  mode=push
fi
action="${SAF_ACTION:-deliver}"
case "$action" in deliver|redeploy) ;; *) saf_die "SAF_ACTION must be deliver or redeploy" ;; esac

work="$SAF_WORK/deploy"
out="$SAF_OUT/release-result"
rm -rf "$work"
mkdir -p "$work" "$out"
manifest="$SAF_WS/release-manifest/release-manifest.json"
image_tar="$SAF_WS/image/image.oci.tar"
source_result="$SAF_WS/release-result-$promote_from/release-result.json"
source_json="$SAF_WS/release-manifest/source.json"
[ -f "$manifest" ] || saf_die "artifact release-manifest is missing"
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

# shellcheck source=release-lib.sh
source "$SAF_DELIVERY/scripts/release-lib.sh"

# Result fields known so far; write_result fills release-result.json from them.
tag=""
image_ref=""
revision=""
fqdn=""
auth_mode=""
registry_id=""
login_server=""
repository=""

write_result() { # write_result <result>
  jq -n \
    --arg slug "$SAF_SLUG" --arg env "$SAF_ENV_NAME" --arg runId "$BUILD_BUILDID" \
    --arg commit "$commit" --arg digest "$digest" --arg image "$image_ref" --arg tag "$tag" \
    --arg revision "$revision" --arg fqdn "$fqdn" --arg auth "$auth_mode" \
    --arg registryId "$registry_id" --arg loginServer "$login_server" --arg repository "$repository" \
    --arg mode "$mode" --arg promotedFrom "$promote_from" --arg result "$1" \
    --arg action "$action" --arg imageRunId "${image_run_id:-}" \
    --arg deployedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    'def n: if . == "" then null else . end;
     {schemaVersion: 1, slug: $slug, environment: $env, runId: $runId, commit: $commit,
      digest: $digest, image: ($image | n), tag: ($tag | n), revision: ($revision | n),
      fqdn: ($fqdn | n), authentication: ($auth | n), registryId: ($registryId | n),
      loginServer: ($loginServer | n), repository: ($repository | n), mode: $mode,
      promotedFrom: ($promotedFrom | n), action: $action, imageRunId: ($imageRunId | n),
      deployedAt: $deployedAt, result: $result}' \
    > "$out/release-result.json"
  cp "$manifest" "$out/release-manifest.json"
}

write_summary() { # write_summary <headline>
  # shellcheck disable=SC2016 # backticks are Markdown code spans, not command substitution
  {
    printf '## %s: %s\n\n%s\n\n' "$SAF_ENV_NAME" "$SAF_SLUG" "$1"
    printf '| | |\n|---|---|\n'
    printf '| Run | %s |\n' "$BUILD_BUILDID"
    if [ "$action" = redeploy ]; then printf '| Image from run | %s (%s) |\n' "$image_run_id" "$source_path"; fi
    printf '| Commit | `%s` |\n' "$commit"
    printf '| Digest | `%s` |\n' "$digest"
    if [ -n "$image_ref" ]; then printf '| Image | `%s` (tag `%s`) |\n' "$image_ref" "$tag"; fi
    if [ -n "$promote_from" ]; then printf '| Promoted from | %s |\n' "$promote_from"; fi
    if [ -n "$revision" ]; then printf '| Revision | `%s` |\n' "$revision"; fi
    if [ -n "$fqdn" ]; then printf '| URL | https://%s |\n' "$fqdn"; fi
    if [ -n "$auth_mode" ]; then printf '| Sign-in | %s |\n' "$auth_mode"; fi
  } > "$out/summary.md"
}

# ---------------------------------------------------------------------------------------------
# Tools, environment, release manifest
# ---------------------------------------------------------------------------------------------
saf_bicep_pin_check
command -v oras >/dev/null || saf_die "oras is not installed"
saf_environment

[ "$(jq -r '.schemaVersion' "$manifest")" = 1 ] || saf_die "unsupported release manifest version"
[ "$(jq -r '.slug' "$manifest")" = "$SAF_SLUG" ] || saf_die "the release manifest is for a different app"
digest="$(jq -er '.digest' "$manifest")"
commit="$(jq -er '.commit' "$manifest")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "the release manifest has no valid digest"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || saf_die "the release manifest has no valid commit"
image_run_id="$(jq -r '.runId' "$manifest")"
[[ "$image_run_id" =~ ^[0-9]+$ ]] || saf_die "the release manifest has no valid runId"
source_path=""

if [ "$action" = redeploy ]; then
  # The `source` stage verified the earlier run (platform pipeline verify-source-run) and
  # republished its release manifest with source.json next to it.
  [ -f "$source_json" ] || saf_die "source.json is missing next to the release manifest"
  [ "$(jq -r '.runId | tostring' "$source_json")" = "$image_run_id" ] \
    || saf_die "source.json names a different run than the release manifest"
  [ "$(jq -r '.commit' "$source_json")" = "$commit" ] \
    || saf_die "source.json names a different commit than the release manifest"
  source_path="$(jq -r '.path' "$source_json")"
  case "$source_path" in rollback|promotion) ;; *) saf_die "source.json has no valid path" ;; esac
  saf_info "Redeploy of run $image_run_id ($commit) to $SAF_ENV_NAME ($source_path)"
elif [ "$mode" = push ]; then
  # The archive must still be the scanned image (artifacts are immutable; defence in depth).
  [ -f "$image_tar" ] || saf_die "artifact image is missing"
  layout="$work/layout"
  bash "$SAF_DELIVERY/scripts/image-digest.sh" "$image_tar" "$layout" "$work/digest.txt"
  [ "$(cat "$work/digest.txt")" = "$digest" ] || saf_die "the image archive does not match the digest in the release manifest"
else
  # Where deploy_<source> put this run's image.
  [ -f "$source_result" ] || saf_die "artifact release-result-$promote_from is missing"
  source_state="$(jq -r '.result // ""' "$source_result" | tr -cd 'a-z-')"
  if [ "$source_state" != succeeded ]; then
    printf '##vso[task.logissue type=warning]%s\n' "deploy_$promote_from did not publish this run's image (result: ${source_state:-unknown}); nothing to promote to $SAF_ENV_NAME"
    write_result "skipped-source-not-deployed"
    write_summary "Nothing promoted: $promote_from did not release this run (${source_state:-unknown})."
    exit 0
  fi
  [ "$(jq -r '.digest' "$source_result")" = "$digest" ] \
    || saf_die "release-result-$promote_from names a different digest than the release manifest"
  source_registry_id="$(jq -er '.registryId' "$source_result")"
  source_repository="$(jq -er '.repository' "$source_result")"
  [[ "$source_registry_id" =~ ^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.ContainerRegistry/registries/[^/]+$ ]] \
    || saf_die "release-result-$promote_from has no valid registryId"
  [[ "$source_repository" =~ ^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$ ]] \
    || saf_die "release-result-$promote_from has no valid repository"
fi

# ---------------------------------------------------------------------------------------------
# Release record, newer-run guard, registry
# ---------------------------------------------------------------------------------------------
saf_release_record
if [ "$action" = deliver ] && [ "$mode" = import ] && [ "$source_repository" != "$repository" ]; then
  saf_die "the source repository differs from this environment's repository"
fi

saf_deployed_run
# Newer-run guard: deliver only. A redeploy deliberately goes back to an earlier run.
if [ "$action" = deliver ] && saf_newer_run_deployed; then
  printf '##vso[task.logissue type=warning]%s\n' "run $deployed_run (newer) is already deployed to $SAF_ENV_NAME; nothing to do"
  write_result "skipped-newer-deployed"
  write_summary "Nothing deployed: run $deployed_run, newer than this run, is already deployed to $SAF_ENV_NAME."
  exit 0
fi

saf_registry

# ---------------------------------------------------------------------------------------------
# Publish the image by digest
# ---------------------------------------------------------------------------------------------
auth="$work/oras-auth.json"
printf '{}\n' > "$auth"
chmod 600 "$auth"
trap 'rm -f "$auth"' EXIT

registry_login() {
  local token
  token="$(az acr login --name "$registry" --expose-token --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "az acr login returned no token"
  echo "##vso[task.setsecret]$token"
  oras login --registry-config "$auth" --username 00000000-0000-0000-0000-000000000000 --password-stdin "$login_server" <<<"$token" >/dev/null
}

# resolve_digest <reference>: prints the digest, or nothing when the reference does not exist.
resolve_digest() {
  local found
  if found="$(oras resolve --registry-config "$auth" "$1" 2> "$work/resolve.err")"; then
    printf '%s' "$found"
  elif ! grep -qi 'not found' "$work/resolve.err"; then
    saf_neutralise < "$work/resolve.err" | tail -n 10
    saf_die "could not resolve a reference in $login_server"
  fi
}

# Tag rule: the commit, or {commit}-{runId} when the commit tag already holds another digest. The
# run is the one that built the image (this run for deliver, the source run for a redeploy).
choose_tag() {
  local existing
  existing="$(resolve_digest "$login_server/$repository:$commit")"
  if [ -n "$existing" ] && [ "$existing" != "$digest" ]; then
    printf '%s-%s' "$commit" "$image_run_id"
  else
    printf '%s' "$commit"
  fi
}

publish_push() {
  tag="$(choose_tag)"
  saf_info "Pushing $digest to $login_server/$repository:$tag"
  oras cp --from-oci-layout --to-registry-config "$auth" "$layout@$digest" "$login_server/$repository:$tag" 2>&1 | saf_neutralise
}

publish_import() {
  if [ "$(resolve_digest "$login_server/$repository@$digest")" = "$digest" ]; then
    saf_info "$login_server/$repository@$digest is already in the registry; no import needed."
    tag=""
    return 0
  fi
  tag="$(choose_tag)"
  saf_info "Importing $digest from $promote_from into $login_server/$repository:$tag"
  # Source by resource ID (may be another subscription): the promotion identity holds Container
  # Registry Data Importer and Data Reader on the source registry (landing zone; ACR-4 to ACR-7).
  if ! az acr import \
      --name "$registry" \
      --resource-group "$rg" \
      --source "$repository@$digest" \
      --registry "$source_registry_id" \
      --image "$repository:$tag" \
      --only-show-errors > "$work/import.log" 2>&1; then
    saf_neutralise < "$work/import.log" | tail -n 20
    saf_die "az acr import from $promote_from failed"
  fi
}

# Redeploy: the image of the earlier run is already in this registry (rollback), or, for a
# promotion environment, still in the source environment's registry (promotion of an earlier
# build). Never a push: the image archive of that run is not available here.
publish_redeploy() {
  if [ "$(resolve_digest "$login_server/$repository@$digest")" = "$digest" ]; then
    saf_info "$login_server/$repository@$digest is in the registry; redeploying it."
    tag=""
    return 0
  fi
  if [ "$mode" = push ]; then
    saf_die "the image of run $image_run_id is no longer in the registry"
  fi
  [ -f "$source_result" ] || saf_die "the image of run $image_run_id is not in the registry and release-result-$promote_from is missing"
  [ "$(jq -r '.result // ""' "$source_result")" = succeeded ] \
    || saf_die "the image of run $image_run_id is not in the registry and $promote_from did not release it"
  [ "$(jq -r '.digest' "$source_result")" = "$digest" ] \
    || saf_die "release-result-$promote_from names a different digest than the release manifest"
  source_registry_id="$(jq -er '.registryId' "$source_result")"
  source_repository="$(jq -er '.repository' "$source_result")"
  [[ "$source_registry_id" =~ ^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.ContainerRegistry/registries/[^/]+$ ]] \
    || saf_die "release-result-$promote_from has no valid registryId"
  [ "$source_repository" = "$repository" ] || saf_die "the source repository differs from this environment's repository"
  publish_import
}

registry_login
if [ "$action" = redeploy ]; then
  publish_redeploy
elif [ "$mode" = push ]; then
  publish_push
else
  publish_import
fi
[ "$(resolve_digest "$login_server/$repository@$digest")" = "$digest" ] \
  || saf_die "the registry does not resolve the image digest"
image_ref="$login_server/$repository@$digest"

# ---------------------------------------------------------------------------------------------
# Release deployment: release.bicepparam is the only parameter source
# ---------------------------------------------------------------------------------------------
saf_cli pipeline release-params --record "$work/record.json" --manifest "$manifest" --env "$work/env.json" --output "$work/release.json"

delays=(30 60 120 240)
attempt=0
while :; do
  attempt=$((attempt + 1))
  saf_info "Deploying $deployment (attempt $attempt)"
  if SAF_RELEASE_JSON="$(cat "$work/release.json")" az deployment group create \
      --resource-group "$rg" \
      --name "$deployment" \
      --parameters "$release_param" \
      --only-show-errors --output json > "$work/deployment.json" 2> "$work/deployment.err"; then
    break
  fi
  saf_neutralise < "$work/deployment.err" | tail -n 30
  verdict="$(saf_cli pipeline classify-deploy-error --log "$work/deployment.err" || true)"
  if [ "$verdict" = retry ] && [ "$attempt" -le "${#delays[@]}" ]; then
    saf_info "RBAC propagation delay; retrying in ${delays[$((attempt - 1))]} s."
    sleep "${delays[$((attempt - 1))]}"
    continue
  fi
  saf_die "the release deployment failed"
done
revision="$(jq -r '.properties.outputs.latestRevisionName.value // empty' "$work/deployment.json" | tr -cd 'a-z0-9-')"
fqdn="$(jq -r '.properties.outputs.fqdn.value // empty' "$work/deployment.json" | tr -cd 'a-z0-9.-')"

# ---------------------------------------------------------------------------------------------
# Smoke test, result
# ---------------------------------------------------------------------------------------------
auth_mode="$(jq -er '.authentication.value.mode' "$work/record.json")"
liveness="$(jq -er '.runtime.livenessPath' "$work/release.json")"
# Behind a locked ingress (frontDoor with ranges, copied from the record) only Front Door reaches the
# app: the smoke test probes through its custom host (ADR-0010, amended 2026-11-11).
public_host="$(jq -r 'if .frontDoor.mode != "none" and (.frontDoor.backendIpRanges | length) > 0 then .frontDoor.hostNames[0] // "" else "" end' "$work/release.json")"
bash "$SAF_DELIVERY/scripts/smoke.sh" "$rg" "$container_app" "$image_ref" "$auth_mode" "$liveness" "" "$public_host"

write_result "succeeded"
if [ "$action" = redeploy ]; then
  write_summary "Redeploy of run $image_run_id ($commit) to $SAF_ENV_NAME ($source_path)."
else
  write_summary "Released."
fi
saf_info "Released $image_ref to $SAF_ENV_NAME ($revision)."
