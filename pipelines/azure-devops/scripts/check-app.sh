#!/usr/bin/env bash
# check-app.sh — verify stage, job `build` (UNTRUSTED: runs next to the app's code and image).
# `platform check --strict` on the app checkout against the image build-image.sh loaded
# (saf/candidate:build): manifest, Dockerfile rules, secret scan with the platform-owned allowlist
# from the `platform-inputs` artifact, forbidden files, docs, agent files and the runtime smoke
# test. SARIF goes to the artifact CodeAnalysisLogs-build.
# The step runs with `target: { commands: restricted, settableVariables: none }`.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

allowlist="$SAF_WS/platform-inputs/secrets-allowlist.json"
[ -f "$allowlist" ] || saf_die "artifact platform-inputs is missing secrets-allowlist.json"
docker image inspect saf/candidate:build >/dev/null 2>&1 || saf_die "image saf/candidate:build is not loaded"

mkdir -p "$SAF_OUT/CodeAnalysisLogs"
saf_cli check "$SAF_APP" --strict \
  --image saf/candidate:build \
  --allowlist "$allowlist" \
  --format sarif --output "$SAF_OUT/CodeAnalysisLogs/platform-check.sarif"
