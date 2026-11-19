#!/usr/bin/env bash
# source-run.sh validate|verify|check — stage `source`, job `resolve` (action redeploy only; trusted, core
# code only, no app checkout, no Azure credentials). ADR-0029 items 5 and 6.
#
#   validate `platform pipeline validate-run` (the redeploy run has no prepare job): SAF_PARAMS_JSON
#           (the five template parameters) against instance.yaml, core ref = release tag.
#   verify  `platform pipeline verify-source-run`: the earlier run sourceRunId is a completed run
#           of THIS pipeline whose scan job succeeded and which either deployed the target
#           environment T (path `rollback`) or deployed T's source environment S from the default
#           branch (path `promotion`); for T of kind prod its app ref must be the default branch.
#           The CLI reads the Azure DevOps REST API with the job token (SYSTEM_ACCESSTOKEN, mapped
#           into this step only) and writes saf-work/source/source.json {runId, commit, appRef, path}.
#   check   After the template downloaded that run's artifacts (DownloadPipelineArtifact@2,
#           buildType specific) into $(Pipeline.Workspace)/source-run/<artifact>: the release
#           manifest must name the same run and commit as source.json, with a digest. Stages them
#           under saf-out/<artifact> so the template republishes them under the same names in
#           THIS run (release-manifest + source.json, release-result-<S>, scan): the preview and
#           deploy stages then read only this run's artifacts, exactly as for deliver.
#
# Env: SAF_PARAMS_JSON, RESOURCES_REPOSITORIES_CORE_REF (validate); SAF_SLUG, SAF_SOURCE_RUN_ID, SAF_TARGET, SAF_TARGET_KIND, SAF_PROMOTE_FROM ('' for a build
# environment), SAF_DEFAULT_BRANCH (template constants); SYSTEM_ACCESSTOKEN (verify only);
# SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECTID, SYSTEM_DEFINITIONID (predefined).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_SOURCE_RUN_ID SAF_TARGET SAF_TARGET_KIND SAF_DEFAULT_BRANCH
[[ "$SAF_SOURCE_RUN_ID" =~ ^[1-9][0-9]*$ ]] || saf_die "sourceRunId must be a positive run id"
[[ "$SAF_TARGET" =~ ^[a-z][a-z0-9]{1,7}$ ]] || saf_die "targetEnvironment has an invalid shape"
case "$SAF_TARGET_KIND" in prod|nonprod) ;; *) saf_die "the target kind must be prod or nonprod" ;; esac
[[ "$SAF_DEFAULT_BRANCH" == refs/heads/* ]] || saf_die "SAF_DEFAULT_BRANCH must start with refs/heads/"
promote_from="${SAF_PROMOTE_FROM:-}"
if [ -n "$promote_from" ]; then
  [[ "$promote_from" =~ ^[a-z][a-z0-9]{1,7}$ ]] || saf_die "SAF_PROMOTE_FROM has an invalid shape"
fi

work="$SAF_WORK/source"
mkdir -p "$work"
downloaded="$SAF_WS/source-run"

case "${1:-}" in
  validate)
    saf_require_env SAF_PARAMS_JSON RESOURCES_REPOSITORIES_CORE_REF
    [ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"
    saf_cli pipeline validate-run --instance "$SAF_CONFIG/instance.yaml"
    ;;
  verify)
    saf_require_env SYSTEM_ACCESSTOKEN
    # --promote-from is always passed; empty for a build environment.
    saf_cli pipeline verify-source-run --run-id "$SAF_SOURCE_RUN_ID" --target "$SAF_TARGET" \
      --promote-from "$promote_from" --default-branch "$SAF_DEFAULT_BRANCH" \
      --target-kind "$SAF_TARGET_KIND" --output "$work/source.json"
    ;;
  check)
    source_json="$work/source.json"
    manifest="$downloaded/release-manifest/release-manifest.json"
    [ -f "$source_json" ] || saf_die "run 'source-run.sh verify' first"
    [ -f "$manifest" ] || saf_die "run $SAF_SOURCE_RUN_ID has no release-manifest artifact"
    [ "$(jq -r '.runId | tostring' "$source_json")" = "$SAF_SOURCE_RUN_ID" ] \
      || saf_die "source.json names a different run"
    [ "$(jq -r '.runId | tostring' "$manifest")" = "$SAF_SOURCE_RUN_ID" ] \
      || saf_die "the release manifest of run $SAF_SOURCE_RUN_ID names a different run (a redeploy run can't be a source; name the run that built the image)"
    commit="$(jq -er '.commit' "$manifest")"
    [[ "$commit" =~ ^[0-9a-f]{40}$ ]] || saf_die "the release manifest has no valid commit"
    [ "$(jq -r '.commit' "$source_json")" = "$commit" ] \
      || saf_die "the release manifest and the run's app commit differ"
    [ "$(jq -r '.slug' "$manifest")" = "$SAF_SLUG" ] || saf_die "the release manifest is for a different app"
    [[ "$(jq -r '.digest' "$manifest")" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "the release manifest has no valid digest"
    path="$(jq -r '.path' "$source_json")"
    case "$path" in rollback|promotion) ;; *) saf_die "source.json has no valid path" ;; esac

    rm -rf "$SAF_OUT/release-manifest"
    mkdir -p "$SAF_OUT/release-manifest"
    cp "$manifest" "$SAF_OUT/release-manifest/release-manifest.json"
    cp "$source_json" "$SAF_OUT/release-manifest/source.json"
    if [ -n "$promote_from" ]; then
      [ -f "$downloaded/release-result-$promote_from/release-result.json" ] \
        || saf_die "run $SAF_SOURCE_RUN_ID has no release-result-$promote_from artifact"
      rm -rf "$SAF_OUT/release-result-$promote_from"
      cp -R "$downloaded/release-result-$promote_from" "$SAF_OUT/release-result-$promote_from"
    fi
    if [ "$SAF_TARGET_KIND" = prod ]; then
      [ -f "$downloaded/scan/trivy.json" ] || saf_die "run $SAF_SOURCE_RUN_ID has no scan artifact"
      rm -rf "$SAF_OUT/scan"
      cp -R "$downloaded/scan" "$SAF_OUT/scan"
    fi
    saf_info "Source run $SAF_SOURCE_RUN_ID: commit $commit, path $path; artifacts republished in this run."
    ;;
  *)
    echo "usage: source-run.sh validate|verify|check" >&2
    exit 2
    ;;
esac
