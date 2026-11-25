#!/usr/bin/env bash
# entra-decide.sh — the step after the Entra plan (no credentials): stage plan, job decide, step
# entraDecide (SAF_ENTRA_PHASE plan: units/entra) and stage entra_plan, job `plan`, step `decide`
# (landing: entra_plan; ADR-0050). Sets the output
# variable entraNeeded from entra-needed.txt, which entra-plan.sh writes after its loop: true only
# when a registration was planned as `deploy` or an Easy Auth secret as `write` or `rotate`
# (ADR-0035, ADR-0041). A missing or unexpected file means false, so the stage `entra` (and, with
# approvals.entraChanges separate, its approval; ADR-0051) runs only on a planned change (ADR-0033).
# Read as dependencies.plan.outputs['decide.entraDecide.entraNeeded'] and
# dependencies.entra_plan.outputs['plan.decide.entraNeeded'] (the stage entra runs when either is true).

set -euo pipefail

case "${SAF_ENTRA_PHASE:-}" in
  plan) dir=units/entra ;;
  landing) dir=entra_plan ;;
  *) echo "SAF_ENTRA_PHASE must be plan or landing" >&2; exit 1 ;;
esac
file="${PIPELINE_WORKSPACE:?PIPELINE_WORKSPACE is not set}/saf-out/$dir/entra-needed.txt"
needed=false
if [ -f "$file" ] && [ "$(head -c 16 "$file" | tr -d '[:space:]')" = true ]; then
  needed=true
fi
echo "entraNeeded=$needed"
echo "##vso[task.setvariable variable=entraNeeded;isOutput=true]$needed"
