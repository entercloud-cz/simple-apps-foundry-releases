#!/usr/bin/env bash
# decide.sh — stage `plan`, job `plan`, step `decide` of the platform pipeline (ADR-0043; no
# credentials). Sets the output variable `changed` from changed.txt, which plan.sh writes: true only
# when the deployment platform-{prefix}-{env} is new or not up to date. A missing or unexpected file
# means false, so the deploy stage (and its approval) runs only on a planned change.
# Read as dependencies.plan.outputs['plan.decide.changed'].

set -euo pipefail

file="${PIPELINE_WORKSPACE:?PIPELINE_WORKSPACE is not set}/saf-out/platform_plan/changed.txt"
changed=false
if [ -f "$file" ] && [ "$(head -c 16 "$file" | tr -d '[:space:]')" = true ]; then
  changed=true
fi
echo "changed=$changed"
echo "##vso[task.setvariable variable=changed;isOutput=true]$changed"
