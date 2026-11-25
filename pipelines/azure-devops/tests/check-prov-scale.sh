#!/usr/bin/env bash
# check-prov-scale.sh — offline scale test of the provisioning plan (ADR-0050). No Azure, no Azure
# DevOps: a generated instance of N apps in two environments (the CLI's provisioning fixture, its app
# cloned N times), a fake Azure (tests/scale/state.mjs) served by a fake `az` and `bicep` that record
# every call (tests/scale/fake-az.sh, fake-bicep.sh), and the plan's real scripts in the order the
# stage runs them on one agent: the job plan_nonprod (plan.sh), then the job decide (plan.sh of the
# host prod, decide.sh, entra-plan.sh phase plan, entra-decide.sh).
#
# Cases and what they assert:
#   quiet, N = 14 and N = 300: nothing changed; every output false, entraNeeded false; the calls of
#     each job that are not a next page of a list are the same for 14 and 300 apps (a small constant),
#     and no per-app read happens;
#   change, N = 300: one role assignment added to one app (its entra inputs change in both
#     environments): the plan jobs make exactly the calls of quiet 300; only record_nonprod and
#     record_prod run, entraPlan is false (no stage entra_plan); the Entra comparison in the job decide
#     makes per-app calls for that app only (its two environments);
#   due, N = 300: one app's Easy Auth secret is due for rotation: one revision read per environment
#     for that app only (the exact version its revisions run with), its entra and release run, the
#     comparison plans the rotation (entraNeeded true);
#   purge, N = 300 (ADR-0059): no app's registry was purged yet, inside the window: the plan jobs make
#     exactly the calls of quiet 300 (what each app runs comes from the Container Apps list); decide sets
#     registry_nonprod (the build environment only) and purges 100 apps in this run, 200 deferred;
#   move300, N = 300, outside the window (ADR-0060): one app runs in another mode's CAE than app.yaml
#     names: the plan jobs make exactly the calls of quiet300 (the live CAE comes from the Container
#     Apps list), its lz, entra and release run with the release's action move; and in every case each
#     plan job names its environment vault offline once (one vault variant per environment here);
#   decide.sh (`platform provisioning plan-units`) over 300 apps takes a few seconds at most;
#   the Entra records (ADR-0063): those of nonprod still in the instance's rg-contoso-entra, those of
#     prod in rg-contoso-entra-prod; the host's read lists each Entra group once (three lists, for 14 apps
#     as for 300, rg-contoso-entra-nonprod missing in quiet14), and the comparison reads each record in
#     the group the plan listed it in (change300).
# Prints the call counts per job (the numbers in ADR-0050 and the sandbox check UNIT-7).
# Needs the platform CLI built (cd tools/platform-cli && npm ci && npm run build).
# Usage: bash pipelines/azure-devops/tests/check-prov-scale.sh (exit 0 = every check passed).

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
scripts="$repo/pipelines/azure-devops/scripts/provisioning"
cli="$repo/tools/platform-cli/dist/src/cli.js"
fixture="$repo/tools/platform-cli/test/fixtures/provisioning/config"
tmp="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$tmp"' EXIT
[ -z "${KEEP:-}" ] || printf 'workspaces: %s\n' "$tmp"
failures=0
envs_json='[{"name":"nonprod","kind":"nonprod","promoteFrom":""},{"name":"prod","kind":"prod","promoteFrom":"nonprod"}]'
now="$(date -u +%s)"
window_open='maintenance: {window: {days: [mon, tue, wed, thu, fri, sat, sun], start: "00:00", hours: 24}, registryRetention: {mode: purge}}'
window_closed="maintenance: {window: {days: [mon, tue, wed, thu, fri, sat, sun], start: \"$(date -u -d '+2 hours' +%H):00\", hours: 1}, registryRetention: {mode: purge}}"

if [ ! -f "$cli" ]; then
  printf 'FAIL  the platform CLI is not built (cd tools/platform-cli && npm ci && npm run build)\n'
  exit 1
fi

check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@"; then
    printf 'ok    %s\n' "$what"
  else
    printf 'FAIL  %s\n' "$what"
    failures=$((failures + 1))
  fi
}

# workspace <case> <N> [<slug with a role change>] [<slug whose rotation is due>] [open|closed] [purge]
# [<slug that moves>]: the maintenance window (ADR-0048 section 7, amended 2026-11-11) is open all the
# time, so the cases don't depend on when the test runs, or closed (one hour starting two hours from
# now); purge: no registry purged yet (ADR-0059); the app that moves runs in another mode's CAE in
# nonprod than app.yaml names (ADR-0060).
workspace() {
  local c="$1" n="$2" changed="${3:-}" due="${4:-}" window="${5:-open}" purge="${6:-}" move="${7:-}" ws="$tmp/$1/ws" i slug
  mkdir -p "$ws/s/core/tools" "$ws/s/core/infra/app/delivery" "$ws/s/core/infra/entra/provisioning" "$ws/s/core/images" \
    "$ws/in/plan" "$tmp/$c/tools/saf/bin" "$tmp/$c/state"
  ln -s "$repo/tools/platform-cli" "$ws/s/core/tools/platform-cli"
  ln -s "$repo/pipelines" "$ws/s/core/pipelines"
  cp "$repo/images/images.json" "$ws/s/core/images/images.json"
  cp "$repo/infra/app/delivery/names.bicepparam" "$ws/s/core/infra/app/delivery/names.bicepparam"
  jq -n '{schemaVersion: 1, units: ({lz: 1, entra: 2, release: 3, frontdoor: 4, pep: 5, ado: 6}
    | map_values({revision: 1, fingerprint: ("a" * 64), since: "v0.1.0-rc.2"}))}' > "$ws/s/core/infra/app/units.json"
  printf 'minAppVersion: v0.1.0-rc.1\nversions: {}\n' > "$ws/s/core/infra/app/upgrades.yaml"
  # The platform-config of N apps and its inputs, generated once per N and copied into each case.
  if [ ! -d "$tmp/base-$n" ]; then
    mkdir -p "$tmp/base-$n/ws/s/config/apps" "$tmp/base-$n/ws/in/plan"
    cp "$fixture/instance.yaml" "$tmp/base-$n/ws/s/config/instance.yaml"
    printf '%s\n' "$window_open" >> "$tmp/base-$n/ws/s/config/instance.yaml"
    # 300 apps fit one cell (ADR-0053) only with the smallest reservation: 300 x 0.25 = 75 of 80 cores,
    # 300 of the /25 subnet's 570 replicas. This test counts calls; it doesn't model capacity.
    printf 'newApps:\n  capacity:\n    size: xs\n    maxReplicas: 1\n' >> "$tmp/base-$n/ws/s/config/instance.yaml"
    for i in $(seq 1 "$n"); do
      slug="$(printf 'app-%03d' "$i")"
      mkdir -p "$tmp/base-$n/ws/s/config/apps/$slug"
      sed -e "s/^slug: demo$/slug: $slug/" -e "s/^  name: demo$/  name: $slug/" "$fixture/apps/demo/app.yaml" > "$tmp/base-$n/ws/s/config/apps/$slug/app.yaml"
    done
    inputs "base-$n"
  fi
  cp -r "$tmp/base-$n/ws/s/config" "$ws/s/config"
  cp "$tmp/base-$n/ws/in/plan/apps.json" "$tmp/base-$n/ws/in/plan/unit-inputs.json" "$ws/in/plan/"
  if [ "$window" = closed ]; then
    sed -i "s/^maintenance: .*\$/$window_closed/" "$ws/s/config/instance.yaml"
    inputs "$c"
  fi
  node "$repo/pipelines/azure-devops/tests/scale/state.mjs" "$ws/in/plan/apps.json" "$ws/in/plan/unit-inputs.json" \
    "$repo/images/images.json" "$tmp/$c/state" "$now" "$due" "$purge" "$move"
  if [ -n "$changed" ]; then
    # One role assignment more (ADR-0048: it changes the app's entra unit only).
    sed -i 's/^  assignments:$/  assignments:\n    - role: Editor\n      principalType: User\n      objectId: 00000000-0000-0000-0000-00000000e003\n      displayName: Jo Editor/' \
      "$ws/s/config/apps/$changed/app.yaml"
    inputs "$c"
  fi
  install -m 755 "$repo/pipelines/azure-devops/tests/scale/fake-az.sh" "$tmp/$c/tools/saf/bin/az"
  install -m 755 "$repo/pipelines/azure-devops/tests/scale/fake-bicep.sh" "$tmp/$c/tools/saf/bin/bicep"
  : > "$tmp/$c/calls"
}

# inputs <case>: plan/apps.json and plan/unit-inputs.json, as stage validate writes them.
inputs() {
  local ws="$tmp/$1/ws"
  node "$cli" provisioning apps --instance "$ws/s/config/instance.yaml" --apps-dir "$ws/s/config/apps" \
    --scope changed --upgrade none --output "$ws/in/plan/apps.json" > /dev/null
  node "$cli" provisioning units --instance "$ws/s/config/instance.yaml" --apps "$ws/in/plan/apps.json" \
    --output "$ws/in/plan/unit-inputs.json" > /dev/null
}

# step <case> <job label> <script> [VAR=value...]: one step of a job, as the agent runs it.
step() {
  local c="$1" job="$2" script="$3" rc=0 start
  shift 3
  start="$(date +%s%N)"
  env -i PATH="$PATH" HOME="$HOME" PIPELINE_WORKSPACE="$tmp/$c/ws" AGENT_TOOLSDIRECTORY="$tmp/$c/tools" BUILD_BUILDID=42 \
    FAKE_STATE="$tmp/$c/state" FAKE_CALLS="$tmp/$c/calls" FAKE_JOB="$job" \
    FAKE_BICEP_VERSION="$(jq -r '.tools.bicep.version' "$repo/pipelines/azure-devops/tools/tools.json")" \
    "$@" bash "$scripts/$script" >> "$tmp/$c/$job.log" 2>&1 || rc=$?
  printf '%s %s\n' "$script" "$rc" >> "$tmp/$c/rcs"
  printf '%s\t%s\n' "$job" "$(( ($(date +%s%N) - start) / 1000000 ))" >> "$tmp/$c/times"
}
ms() { awk -F'\t' -v j="$2" '$1 == j { t += $2 } END { print t + 0 }' "$tmp/$1/times"; } # ms <case> <job>: script time on this machine

# plan <case>: the stage plan on one agent: plan_nonprod, then the job decide.
plan() {
  local c="$1" ws="$tmp/$1/ws" start
  step "$c" plan_nonprod plan.sh SAF_ENV_NAME=nonprod SAF_PROMOTE_FROM= SAF_SERVICE_CONNECTION=sc-platform-provisioning-nonprod
  cp -r "$ws/saf-out/plan_nonprod" "$ws/in/plan_nonprod"
  step "$c" decide-read plan.sh SAF_ENV_NAME=prod SAF_PROMOTE_FROM=nonprod SAF_SERVICE_CONNECTION=sc-platform-provisioning-prod
  start="$(date +%s%N)"
  step "$c" decide decide.sh SAF_ENVIRONMENTS_JSON="$envs_json" SAF_HOST_ENVIRONMENT=prod
  printf '%s\n' "$(( ($(date +%s%N) - start) / 1000000 ))" > "$tmp/$c/decide-ms"
  step "$c" decide-entra entra-plan.sh SAF_ENV_NAME=prod SAF_ENVIRONMENTS_JSON="$envs_json" \
    SAF_SERVICE_CONNECTION=sc-platform-provisioning-prod SAF_ENTRA_PHASE=plan
  step "$c" decide-entra entra-decide.sh SAF_ENTRA_PHASE=plan
}

# calls <case> <job> [all|first|perapp]: the number of calls of that job: all of them, the ones that
# are not a next page of a list, or the per-app ones.
calls() {
  local f="$tmp/$1/calls"
  case "${3:-all}" in
    all) awk -F'\t' -v j="$2" '$1 == j' "$f" | wc -l ;;
    first) awk -F'\t' -v j="$2" '$1 == j && $2 !~ /next page/' "$f" | wc -l ;;
    perapp) awk -F'\t' -v j="$2" '$1 == j && $2 ~ /per app/' "$f" | wc -l ;;
  esac
}
outputs() { # outputs <case>: the step outputs of the job decide, as the stages read them
  cat "$tmp/$1/decide.log" "$tmp/$1/decide-entra.log" | grep '^##vso\[task.setvariable' \
    | sed 's/^##vso\[task.setvariable variable=\([A-Za-z_]*\);isOutput=true\]\(.*\)$/\1=\2/' | tr '\n' ' '
}
rcs_ok() { ! grep -qv ' 0$' "$tmp/$1/rcs"; }
unexpected() { ! grep -q 'UNEXPECTED' "$tmp/$1/calls"; }
table() { # table <case>: the calls of each job by kind
  awk -F'\t' '{ n[$1 "\t" $2]++ } END { for (k in n) print n[k] "\t" k }' "$tmp/$1/calls" | sort -t$'\t' -k2,2 -k3,3
}

for c in quiet14:14 quiet300:300 change300:300:app-007 due300:300::app-012 later300:300::app-012:closed purge300:300::::purge move300:300:::closed::app-021; do
  IFS=: read -r name n changed due window purge move <<<"$c"
  workspace "$name" "$n" "$changed" "$due" "${window:-open}" "$purge" "$move"
  # quiet14: rg-contoso-entra-nonprod doesn't exist yet (ADR-0063: the host bootstrap wasn't run again).
  if [ "$name" = quiet14 ]; then rm "$tmp/$name/state/entra-nonprod.json"; fi
  # later300 also has one more deployment at subscription scope than the 600 lz-* records (ADR-0052).
  if [ "$name" = later300 ]; then
    jq '. + [{name: "platform-nonprod", properties: {provisioningState: "Succeeded"}}]' "$tmp/$name/state/lz.json" > "$tmp/$name/state/lz.tmp"
    mv "$tmp/$name/state/lz.tmp" "$tmp/$name/state/lz.json"
  fi
  plan "$name"
done

quiet_out="ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=false entraNeeded=false "
for c in quiet14 quiet300; do
  check "$c: every script exits 0, no unexpected az call" eval "rcs_ok $c && unexpected $c"
  check "$c: nothing runs (every output false, entraNeeded false)" test "$(outputs "$c")" = "$quiet_out"
  check "$c: no per-app read in any job" test "$(awk -F'\t' '$2 ~ /per app/' "$tmp/$c/calls" | wc -l)" = 0
done
for j in plan_nonprod decide-read decide-entra; do
  check "quiet: $j makes the same calls for 14 and 300 apps, next pages aside ($(calls quiet14 "$j" first) and $(calls quiet300 "$j" first))" \
    test "$(calls quiet14 "$j" first)" = "$(calls quiet300 "$j" first)"
done
check "quiet: the Entra comparison makes no call when nothing is to compare" test "$(calls quiet300 decide-entra)" = 0
# ADR-0063: one list per Entra group (rg-contoso-entra, rg-contoso-entra-nonprod, rg-contoso-entra-prod), whatever the apps.
for c in quiet14 quiet300; do
  check "$c: the host's read lists each Entra group once" \
    test "$(awk -F'\t' '$1 == "decide-read" && $2 ~ /^deployment group list rg-contoso-entra(-nonprod|-prod)?$/' "$tmp/$c/calls" | sort | uniq -c | awk '{print $1}' | tr '\n' ' ')" = "1 1 1 "
done
check "quiet14: a missing Entra records group keeps its environment's records in rg-contoso-entra (plan.json entraGroups), with a warning" \
  test "$(jq -c '.entraGroups' "$tmp/quiet14/ws/saf-out/plan_prod/plan.json")" = '{"nonprod":"rg-contoso-entra","prod":"rg-contoso-entra-prod"}' \
  -a "$(grep -c "rg-contoso-entra-nonprod doesn't exist yet" "$tmp/quiet14/decide-read.log")" = 1
check "quiet300: every record found, in its group: nonprod's still in rg-contoso-entra, prod's in rg-contoso-entra-prod" \
  test "$(jq -c '[.entraRecords[] | select(.name | startswith("entra-app-")) | .group] | group_by(.) | map([.[0], length])' "$tmp/quiet300/ws/saf-out/plan_prod/plan.json")" = '[["rg-contoso-entra",300],["rg-contoso-entra-prod",300]]' \
  -a "$(grep -c 'of apps still in rg-contoso-entra (they move with their registration.s next deployment): 300$' "$tmp/quiet300/decide-read.log")" = 1

check "change300: every script exits 0, no unexpected az call" eval "rcs_ok change300 && unexpected change300"
for j in plan_nonprod decide-read; do
  check "change300: $j makes exactly the calls of quiet300 ($(calls change300 "$j"))" test "$(calls change300 "$j")" = "$(calls quiet300 "$j")"
done
check "change300: only record_nonprod and record_prod run, no stage entra_plan" test "$(outputs change300)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=true entraNeeded=false "
check "change300: the Entra comparison reads per app for app-007 in its two environments only (2 x 4: names, record, parameters, template hash)" \
  test "$(calls change300 decide-entra perapp)" = 8
check "change300: ... and compares exactly those two" test "$(find "$tmp/change300/ws/saf-out/units/entra/status" -name '*.json' | sort | xargs -n1 basename | tr '\n' ' ')" = "app-007.nonprod.json app-007.prod.json "
check "change300: ... each record read in the group the plan listed it in: nonprod's still in rg-contoso-entra, prod's in its records group (ADR-0063)" \
  test "$(jq -r '.detail.entraRecord' "$tmp/change300/ws/saf-out/units/entra/status/app-007.nonprod.json" "$tmp/change300/ws/saf-out/units/entra/status/app-007.prod.json" | tr '\n' ' ')" = \
  'instance environment '

check "due300: every script exits 0, no unexpected az call" eval "rcs_ok due300 && unexpected due300"
for j in plan_nonprod decide-read; do
  check "due300: $j reads the revisions of app-012 only (no tag, rotation due) (one more call than quiet300)" \
    test "$(calls due300 "$j" perapp)" = 1 -a "$(calls due300 "$j")" = "$(( $(calls quiet300 "$j") + 1 ))"
done
check "due300: app-012's entra and release run in both environments, the rotation is planned" test "$(outputs due300)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=true record_prod=true entraNeeded=true "
check "due300: ... with the exact version its revisions run with" \
  test "$(jq -r '.loaded == .created and .loaded != null' "$tmp/due300/ws/saf-out/plan_nonprod/secret/app-012.nonprod.json")" = true
check "due300: ... a secret entry without an exact read hands no version to the rotation" \
  test "$(jq -r '.loaded' "$tmp/due300/ws/saf-out/plan_nonprod/secret/app-014.nonprod.json")" = null
check "later300: every script exits 0, no unexpected az call" eval "rcs_ok later300 && unexpected later300"
check "later300: outside the maintenance window app-012's rotation waits: nothing runs" test "$(outputs later300)" = "$quiet_out"
check "later300: ... its entra and release say what waits for the window, in both environments" \
  test "$(jq -r '[.apps["app-012"].environments[] | .units | (.entra.waits + .release.waits)[]] | join(",")' "$tmp/later300/ws/saf-out/units/units.json")" = \
  "Easy Auth rotation,Easy Auth rotation,Easy Auth rotation,Easy Auth rotation"
check "deployment history: 600 deployments at subscription scope (quiet300) are counted without a warning" \
  test "$(grep -c 'deployment history of the subscription of nonprod: 600$' "$tmp/quiet300/plan_nonprod.log")" = 1 -a "$(grep -c 'deployments; ARM keeps at most 800' "$tmp/quiet300/plan_nonprod.log")" = 0
check "deployment history: 601 (later300) warn, from the list the plan reads anyway (no extra call)" \
  test "$(grep -c 'the subscription of nonprod holds 601 deployments; ARM keeps at most 800' "$tmp/later300/plan_nonprod.log")" = 1 -a "$(calls later300 plan_nonprod first)" = "$(calls due300 plan_nonprod first)"
check "purge300: every script exits 0, no unexpected az call" eval "rcs_ok purge300 && unexpected purge300"
for j in plan_nonprod decide-read; do
  check "purge300: $j makes exactly the calls of quiet300 ($(calls purge300 "$j")): what the apps run comes from the lists" \
    test "$(calls purge300 "$j")" = "$(calls quiet300 "$j")"
done
check "purge300: no registry purged yet, inside the window: only registry_nonprod runs (the build environment)" test "$(outputs purge300)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=true lz_prod=false post_prod=false record_prod=false entraNeeded=false "
check "purge300: ... 100 apps in this run, 200 deferred to the next windows, none in prod (ADR-0059)" \
  test "$(jq -c '[.environments.nonprod.due, .environments.nonprod.deferred, (.environments | keys)]' "$tmp/purge300/ws/saf-out/units/registry.json")" = '[100,200,["nonprod"]]'
check "decide.sh over 300 apps takes at most 10 s ($(cat "$tmp/quiet300/decide-ms") ms)" test "$(cat "$tmp/quiet300/decide-ms")" -le 10000
# ADR-0060: the environment vaults are named offline, once per vault variant (one in each environment
# here), never per app; a move is detected from the lists the plan reads anyway.
for j in plan_nonprod decide-read; do
  check "quiet: $j names its environment vault once (bicep snapshot), for 14 apps as for 300" \
    test "$(awk -F'\t' -v j="$j" '$1 == j && $2 == "bicep snapshot (environment vault)"' "$tmp/quiet14/calls" | wc -l)" = 1 \
      -a "$(awk -F'\t' -v j="$j" '$1 == j && $2 == "bicep snapshot (environment vault)"' "$tmp/quiet300/calls" | wc -l)" = 1
done
check "move300: every script exits 0, no unexpected az call" eval "rcs_ok move300 && unexpected move300"
for j in plan_nonprod decide-read; do
  check "move300: $j makes exactly the calls of quiet300 ($(calls move300 "$j")): the move comes from the Container Apps list" \
    test "$(calls move300 "$j")" = "$(calls quiet300 "$j")"
done
check "move300: app-021 moves in nonprod outside the maintenance window (an approved change): lz, entra (with its landing zone) and release" \
  test "$(outputs move300)" = "ado=false entraPlan=true lz_nonprod=true post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false entraNeeded=false "
check "move300: ... from the hybrid CAE, case A, the live host kept for Entra, release action move (kind nonprod: no wait for the window), cell 01 to cell 01 (ADR-0053)" \
  test "$(jq -c '.apps["app-021"].environments.nonprod | [.modeChange, .units.release.action]' "$tmp/move300/ws/saf-out/units/units.json")" = \
  '[{"from":"externalHybrid","to":"externalOnly","case":"A","fromHost":"ca-app-021.nonprod.example.io","resume":false,"waitsForWindow":null,"fromCell":"01","toCell":"01"},"move"]'

for c in quiet14 quiet300 change300 due300 later300 purge300 move300; do
  printf '\n%s: calls per job (all / not a next page / per app), script time here without Azure\n' "$c"
  for j in plan_nonprod decide-read decide decide-entra; do
    printf '  %-13s %3s / %3s / %3s   %6s ms\n' "$j" "$(calls "$c" "$j")" "$(calls "$c" "$j" first)" "$(calls "$c" "$j" perapp)" "$(ms "$c" "$j")"
  done
  [ -z "${VERBOSE:-}" ] || table "$c" | sed 's/^/    /'
done

if [ "$failures" -gt 0 ]; then
  printf 'check-prov-scale: %s failure(s)\n' "$failures"
  exit 1
fi
printf 'check-prov-scale: all checks passed\n'
