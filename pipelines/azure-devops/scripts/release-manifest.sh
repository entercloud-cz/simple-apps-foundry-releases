#!/usr/bin/env bash
# release-manifest.sh inputs|decide|manifest — verify stage, job `scan` (trusted).
#
#   inputs    `platform pipeline release-inputs`: validates the app's platform.yaml and resolves
#             runtime/env/secrets per build environment -> saf-work/release-inputs.json. It also
#             checks size and maxReplicas against the app's capacity reservation, which
#             delivery.yml carries per environment (ADR-0053): above it fails, before the check's
#             enforceFrom date it warns (the CLI prints the warning; this script adds a fixed-text
#             warning to the run summary).
#   decide    Runs as the step named `decide` and sets two output variables; the CLI prints the
#             only logging commands of this job (`##vso[task.setvariable variable=<name>;
#             isoutput=true]true|false`):
#             - deployBuildEnvironments: `platform pipeline deploy-branch`, true when the
#               triggering app ref matches platform.yaml deploy.branches (build environments);
#             - promote: `platform pipeline promote-branch`, true when the app ref is the app's
#               default branch from platform-config (promotion environments, prod).
#             Stages read them as dependencies.verify.outputs['scan.decide.<name>'].
#   manifest  `platform pipeline release-manifest` -> artifact `release-manifest`
#             (release-manifest.json: digest, commit, ref, verdict, DB age, core/CLI versions and
#             the release inputs). The deploy stages use nothing else from this run.
#
# Env: SAF_SLUG, SAF_ENVIRONMENTS_JSON (inputs); SAF_DEFAULT_BRANCH (decide);
# RESOURCES_REPOSITORIES_APP_REF (decide,
# manifest); RESOURCES_REPOSITORIES_APP_VERSION, RESOURCES_REPOSITORIES_CORE_REF, BUILD_BUILDID
# (manifest). The template maps them explicitly with `env:`; none is a macro in script text.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

work="$SAF_WORK/release"
mkdir -p "$work"
manifest_file="$SAF_APP/platform.yaml"
[ -f "$manifest_file" ] || saf_die "the app repo has no platform.yaml at its root"

case "${1:-}" in
  inputs)
    saf_require_env SAF_SLUG SAF_ENVIRONMENTS_JSON
    saf_check_names
    saf_cli pipeline release-inputs \
      --manifest "$manifest_file" \
      --app-dir "$SAF_APP" \
      --slug "$SAF_SLUG" \
      --environments "$SAF_ENVIRONMENTS_JSON" \
      --instance "$SAF_CONFIG/instance.yaml" \
      --output "$work/release-inputs.json"
    if [ "$(jq '.warnings | length' "$work/release-inputs.json")" != "0" ]; then
      saf_warn "platform.yaml is above the app's capacity reservation (or delivery.yml has none); see the WARNING lines of this step"
    fi
    ;;
  decide)
    saf_require_env RESOURCES_REPOSITORIES_APP_REF SAF_DEFAULT_BRANCH
    [[ "$SAF_DEFAULT_BRANCH" == refs/heads/* ]] || saf_die "SAF_DEFAULT_BRANCH must start with refs/heads/"
    saf_cli pipeline deploy-branch --manifest "$manifest_file" --set-output deployBuildEnvironments
    saf_cli pipeline promote-branch --default-branch "$SAF_DEFAULT_BRANCH" --set-output promote
    ;;
  manifest)
    saf_require_env RESOURCES_REPOSITORIES_APP_REF RESOURCES_REPOSITORIES_APP_VERSION RESOURCES_REPOSITORIES_CORE_REF BUILD_BUILDID
    [[ "$RESOURCES_REPOSITORIES_CORE_REF" == refs/tags/* ]] || saf_die "the core repository must be pinned to a release tag"
    core_version="${RESOURCES_REPOSITORIES_CORE_REF#refs/tags/}"
    out="$SAF_OUT/release-manifest"
    mkdir -p "$out"
    saf_cli pipeline release-manifest \
      --digest "$(cat "$SAF_WORK/image-digest.txt")" \
      --release-inputs "$work/release-inputs.json" \
      --verdict "$SAF_OUT/scan/verdict.json" \
      --trivy-db-metadata "$SAF_WORK/trivy-db/metadata.json" \
      --core-version "$core_version" \
      --output "$out/release-manifest.json"
    jq -r '"Release manifest: \(.slug) \(.digest) (tag \(.tag), run \(.runId))"' "$out/release-manifest.json"
    ;;
  *)
    echo "usage: release-manifest.sh inputs|decide|manifest" >&2
    exit 2
    ;;
esac
