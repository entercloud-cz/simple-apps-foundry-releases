#!/usr/bin/env bash
# build-image.sh — verify stage, job `build` (UNTRUSTED: executes the app's Dockerfile).
#   1. Resolves build.dockerfile / build.context from platform.yaml with
#      `platform pipeline release-inputs` (both must stay inside the app checkout). The scan job
#      repeats this as the authoritative input of the release manifest.
#   2. Builds ONE linux/amd64 image with the pinned buildx and the pinned BuildKit image (by digest)
#      in a docker-container builder, no provenance/SBOM attestations, with two exports of the
#      same build: an OCI image layout tar, $(Pipeline.Workspace)/saf-out/image/image.oci.tar
#      (artifact `image`, the only thing scanned and pushed), and a Docker archive for step 3.
#   3. `docker load`s the Docker archive as saf/candidate:build for the runtime smoke test
#      (check-app.sh). The hosted agent's Docker can't load the OCI tar ("blobs/json: no such
#      file or directory", sandbox 2026-10-29), so the image is exported twice.
# No Azure credentials exist in this job. The step runs with
# `target: { commands: restricted, settableVariables: none }`, and all build output is neutralised.
# Env: SAF_SLUG, SAF_ENVIRONMENTS_JSON.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_SLUG SAF_ENVIRONMENTS_JSON
saf_check_names
[ -f "$SAF_APP/platform.yaml" ] || saf_die "the app repo has no platform.yaml at its root"
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

work="$SAF_WORK/build"
mkdir -p "$work" "$SAF_OUT/image" "$SAF_OUT/CodeAnalysisLogs"
# The SARIF artifact step runs even when this step fails; leave it something to publish.
trap '[ -n "$(ls -A "$SAF_OUT/CodeAnalysisLogs")" ] || echo "platform check did not run: the image build failed." > "$SAF_OUT/CodeAnalysisLogs/build-failed.txt"' EXIT
saf_cli pipeline release-inputs \
  --manifest "$SAF_APP/platform.yaml" \
  --app-dir "$SAF_APP" \
  --slug "$SAF_SLUG" \
  --environments "$SAF_ENVIRONMENTS_JSON" \
  --instance "$SAF_CONFIG/instance.yaml" \
  --output "$work/release-inputs.json"
dockerfile="$(jq -er '.build.dockerfile' "$work/release-inputs.json")"
context="$(jq -er '.build.context' "$work/release-inputs.json")"

buildkit_image="$(saf_tool_field '.buildkitImage')"
[[ "$buildkit_image" =~ @sha256:[0-9a-f]{64}$ ]] || saf_die "tools.json buildkitImage must be pinned by digest"

docker version --format 'Docker client {{.Client.Version}}, server {{.Server.Version}}'

builder="saf-builder"
buildx rm "$builder" >/dev/null 2>&1 || true
buildx create --name "$builder" --driver docker-container \
  --driver-opt "image=$buildkit_image" --bootstrap 2>&1 | saf_neutralise

tar_file="$SAF_OUT/image/image.oci.tar"
docker_tar="$work/image.docker.tar"
rm -f "$tar_file" "$docker_tar"
buildx build \
  --builder "$builder" \
  --platform linux/amd64 \
  --provenance=false \
  --sbom=false \
  --pull \
  --progress=plain \
  --file "$dockerfile" \
  --output "type=oci,dest=$tar_file,name=saf/candidate:build" \
  --output "type=docker,dest=$docker_tar,name=saf/candidate:build" \
  "$context" 2>&1 | saf_neutralise
[ -s "$tar_file" ] || saf_die "the image build produced no OCI archive"
[ -s "$docker_tar" ] || saf_die "the image build produced no Docker archive"

load_log="$work/docker-load.log"
docker load --input "$docker_tar" > "$load_log" 2>&1 || { saf_neutralise < "$load_log"; saf_die "docker load of the Docker archive failed"; }
saf_neutralise < "$load_log"
if ! docker image inspect saf/candidate:build >/dev/null 2>&1; then
  loaded_id="$(sed -n 's/^Loaded image ID: \(sha256:[0-9a-f]\{64\}\)$/\1/p' "$load_log" | head -n 1)"
  [ -n "$loaded_id" ] || saf_die "docker load did not name the image and printed no image ID (TOOL-4)"
  docker tag "$loaded_id" saf/candidate:build
fi
docker image inspect saf/candidate:build --format 'Loaded saf/candidate:build ({{.Os}}/{{.Architecture}})'
buildx rm "$builder" >/dev/null 2>&1 || true
