#!/usr/bin/env bash
# decide.sh — stage plan, job decide, step `decide` (no service connection, no Azure or ADO call;
# ADR-0048, ADR-0050). After every job plan_<env> and the job's own read of portal.hostEnvironment
# (plan.sh, its first step: saf-out/plan_<host>, linked as in/plan_<host> where every reader looks):
#   1. `platform provisioning plan-units`: every unit of every app runs or not, and why (rules 1-6 of
#      ADR-0048 section 4, rule 2 as ADR-0049 amends it), from this run's files only: plan/apps.json
#      and plan/unit-inputs.json (stage validate), the artifacts plan_<env> (tags and facts read
#      from Azure), core's infra/app/units.json and infra/app/upgrades.yaml and the run's time
#      (--now, its UTC date --today): drift checks, Easy Auth rotations and restarts and the Front
#      Door backend ranges only inside instance.yaml maintenance.window, an urgent rotation (at
#      most 14 days left) at any time (ADR-0048 section 7, amended 2026-11-11) ->
#      units/units.json, which every later stage reads, and units/decommission.json, the phase of
#      every decommissioned app (deleted: nothing left in Azure, read by the jobs plan_<env>), which
#      the portal reads to show an app as deleted (ADR-0056 amendment 2026-11-12);
#      With --registry, the same call writes units/registry.json: the registry image purge of each
#      build environment (ADR-0059: inside the window, maintenance.registryRetention, what every app
#      runs in every environment, the apps due);
#   2. the outputs of this step, exactly lz_<env>, post_<env> and record_<env> for every environment,
#      ado and entraPlan (true | false), from units.json `stages`, and registry_<env> for every build
#      environment (no promoteFrom) from registry.json `stages`: the conditions of the stages after
#      it (a stage runs only when one of its units runs). A plan that can't be made sets none and
#      fails the step: no stage after it runs, report fails the run. entraPlan is true only for an
#      entra unit that runs together with its landing zone (stage entra_plan, after azure_<env>);
#      every other entra unit is compared by the job's next step (entra-plan.sh, phase plan), which
#      reads units.json as in/units (linked here).
# What started the run plays no part (rule P19): a merge, the maintenance run and a manual run at
# the same time decide alike (the clock and instance.yaml decide what is time-based work's turn); scope all (ADR-0046) and upgrade (ADR-0049) reach the CLI only through plan/apps.json.
# Read as dependencies.plan.outputs['decide.decide.<name>'].
# Env: SAF_ENVIRONMENTS_JSON (convertToJson of the template parameter), SAF_HOST_ENVIRONMENT.

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENVIRONMENTS_JSON SAF_HOST_ENVIRONMENT
prov_valid_env "$SAF_HOST_ENVIRONMENT" || saf_die "SAF_HOST_ENVIRONMENT has an invalid shape"
out="$SAF_OUT/units"
rm -rf "$out"
mkdir -p "$out" "$SAF_IN"
# This job's own artifacts, where the readers of the other environments' plans and of units.json look.
host_plan="$SAF_OUT/plan_$SAF_HOST_ENVIRONMENT"
if [ ! -e "$SAF_IN/plan_$SAF_HOST_ENVIRONMENT" ] && [ -d "$host_plan" ]; then ln -s "$host_plan" "$SAF_IN/plan_$SAF_HOST_ENVIRONMENT"; fi
if [ ! -e "$SAF_IN/units" ]; then ln -s "$out" "$SAF_IN/units"; fi

envs=()
builds=" "
while IFS=$'\t' read -r e from; do
  prov_valid_env "$e" || saf_die "SAF_ENVIRONMENTS_JSON has an invalid environment name"
  envs+=("$e")
  if [ -z "$from" ]; then builds+="$e "; fi
done < <(jq -r '.[] | [.name, (.promoteFrom // "")] | @tsv' <<<"$SAF_ENVIRONMENTS_JSON")

# The run's time, read once: the maintenance window (time-based work only inside it, ADR-0048
# section 7, amended 2026-11-11), the rotation check and the dates of the tags all use it.
now="$(date -u +%s)"
today="$(date -u -d "@$now" +%F)"
args=(provisioning plan-units --instance "$SAF_INSTANCE" --apps "$SAF_APPS_JSON" --inputs "$SAF_IN/plan/unit-inputs.json"
  --manifest "$SAF_CORE/infra/app/units.json" --upgrades "$SAF_CORE/infra/app/upgrades.yaml" --now "$now" --today "$today" --output "$out/units.json"
  --decommission "$out/decommission.json" --registry "$out/registry.json")
for e in "${envs[@]}"; do
  args+=(--plan "$e=$SAF_IN/plan_$e")
done
saf_cli "${args[@]}" | saf_neutralise

# The outputs: every name is checked against the environment list, every value is true or false.
names=(ado entraPlan)
for e in "${envs[@]}"; do
  names+=("lz_$e" "post_$e" "record_$e")
  if [[ "$builds" == *" $e "* ]]; then names+=("registry_$e"); fi
done
values=()
for name in "${names[@]}"; do
  [[ "$name" =~ ^(ado|entraPlan|(lz|post|record|registry)_[a-z][a-z0-9]{1,7})$ ]] || saf_die "invalid output name"
  plan_file="$out/units.json"
  if [[ "$name" == registry_* ]]; then plan_file="$out/registry.json"; fi
  value="$(jq -r --arg n "$name" '.stages[$n] | if type == "boolean" then tostring else "" end' "$plan_file")"
  [[ "$value" =~ ^(true|false)$ ]] || saf_die "the plan has no stage output $name"
  values+=("$value")
done
# Only once every output is known: all of them, or none.
for i in "${!names[@]}"; do
  name="${names[$i]}"
  value="${values[$i]}"
  echo "$name=$value"
  echo "##vso[task.setvariable variable=$name;isOutput=true]$value"
done
