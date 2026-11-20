#!/usr/bin/env bash
# report.sh — stage `report` of the provisioning pipeline (no credentials). Reads the plan of the run
# (units/units.json, ADR-0048) and the status files of every stage artifact and writes the run
# summary (saf-out/report/summary.md, uploaded by the next step):
#   - a run in which no unit runs: one line ("Nothing to do"), unless an app is invalid or could not
#     be planned;
#   - otherwise the units that ran per app and environment and why (new, template, inputs,
#     dependency with what required it, drift, all), which of them are recorded as finished and
#     which run again next time (prov_unit_finished, what record_<env> writes); the stages the run
#     skipped because none of their units ran; and one table of the status per stage (per
#     environment for the per-environment stages, entra_plan and entra included) of the apps with
#     something to say: a unit that ran or is held, an invalid definition, an environment that
#     could not be planned, or a status other than ok in any stage. Every other app is only counted
#     (ADR-0050: an instance has hundreds of apps; the table shows the ones that matter);
#   - in both cases, the units held for an upgrade per app and environment, "behind (upgrade
#     available)" (ADR-0049 section 2: this core changed their template since they were applied, and
#     the run doesn't upgrade the app), with the ones whose tag was rebased (section 3), and the apps
#     the run's parameter upgrade named;
#   - in both cases, the apps being decommissioned (ADR-0056): phase, dates and the next step, and the
#     apps the plan found deleted (nothing left in Azure; amendment 2026-11-12) with the waits that
#     name what is left where a person must look;
#   - in both cases, the time-based work that waits for the maintenance window (units.json `waits`:
#     drift checks, Easy Auth rotations and restarts, Front Door backend ranges; ADR-0048 section 7,
#     amended 2026-11-11), per app and environment, with the next window's start;
#   - in both cases, when the plan purged or deferred an app's old images (units/registry.json,
#     ADR-0059): per build environment the retention and the counts, and per app purged the result of
#     registry_<env> (images, kept, deleted or wouldDelete in dry-run mode). A failed purge is a
#     warning here: its stage already failed the run, the app keeps its images and its old tag, and
#     the next window tries again; no app's provisioning depends on it;
#   - the network mode changes of the run (units.json modeChange, ADR-0060): per app and environment
#     the change and its case, and the move's result (moved: the new default host and the outage's
#     start and end; waiting with the reason, the app untouched, also a production environment's move
#     that waits for the maintenance window with the window's start; failed: the next run resumes), the
#     follow-up a case A move needs, and the follow-ups of earlier moves (followUp: the stage entra's
#     secretOld deleted|kept).
#   - failure codes (ADR-0064): a failed cell shows its code (`failed PE009`), and the section Failures
#     lists every failed app step with its code, its title and what to do (`platform provisioning
#     failures`, the catalogue's English text). The same list is failures.json ({schemaVersion, runId,
#     failures: [{slug, environment, stage, code}]}: the failed status files of every stage artifact but
#     registry_<env>, and PE003 for an app environment the plan could not plan), published with the
#     summary as the artifact `report`, which the portal reads for the app's page (View builds on
#     \platform, nothing new).
# Exit 1 when any app definition was invalid, any app could not be planned or any app failed in any
# stage; `waiting` apps are warnings. A cell of a stage where none of the app's units ran is
# `unchanged`; `-` means not processed there (an earlier stage is not ok, or no Entra change). The
# Entra columns are n/a for apps without sign-in; the entra_plan column shows the app's Entra plan
# wherever it was made (prov_entra_dir: units/entra or entra_plan); a registration or Easy Auth secret entra_plan
# planned (entra deploy, secret write or rotate) but the stage `entra` did not process (with
# approvals.entraChanges separate: its approval rejected or timed out; with pullRequest: a check of
# sc-platform-entra failed, or the Approval check bootstrap should have removed) is `waiting`. Removals (ADR-0033 amended 2026-11-11): entra_plan
# removeAssignments <n> and removeRoles <n> (planned), entra removedAssignments <n> and removedRoles
# <n> (done). The secret shows as a detail: plan_<env> and azure_<env> secret present|absent,
# entra_plan secret write|rotate|current|deferred (and secretExpiry soon|expired when at most 60 days are
# left, unknown without an expiry), entra secret written|rotated, azure_post_<env> easyAuth
# current|restarted|restarted tag-after-settle|unknown (whether the app runs with the vault's
# version; ADR-0035, ADR-0041), and frontDoor <host> deployed|up-to-date [dns-manual], removing or
# removed, frontDoorPrevious <host> kept|removed (the custom domain through Front Door, its removal and
# a host change, ADR-0010 amended 2026-11-11).
# The columns `portal_endpoint <env>` come from the stage of the portal host environment
# (portal/status/{slug}.{env}.json of azure_post_<host>): portalEndpoint
# deployed|up-to-date|not-needed|waiting|leftover (the vault's portal-side private endpoint,
# ADR-0025).
# Env: SAF_ENVIRONMENTS_JSON (convertToJson of the template parameter).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENVIRONMENTS_JSON
out="$SAF_OUT/report"
# The folder exists from the job's first step (steps/setup.yml `artifact`, its stage.json kept).
mkdir -p "$out"
rm -f "$out/summary.md" "$out/failures.json"
[ -f "$SAF_APPS_JSON" ] || saf_die "artifact plan has no apps.json"
prov_units_check
slugs=()
while IFS= read -r slug; do
  prov_valid_slug "$slug" || saf_die "plan/apps.json lists an invalid slug"
  slugs+=("$slug")
done < <(jq -r '.apps[].slug' "$SAF_APPS_JSON")

envs=()
while IFS= read -r e; do
  prov_valid_env "$e" || saf_die "SAF_ENVIRONMENTS_JSON has an invalid environment name"
  envs+=("$e")
done < <(jq -r '.[].name' <<<"$SAF_ENVIRONMENTS_JSON")
host="$(prov_portal_host)"

# Columns: "<artifact dir>|<header>|<env or empty>|<sign-in only: entra>|<units of the stage>"
columns=("plan|validate|||")
for e in "${envs[@]}"; do columns+=("plan_$e|plan $e|$e||"); done
for e in "${envs[@]}"; do columns+=("azure_$e|azure_$e|$e||lz"); done
columns+=("ado|ado_resources|||ado")
for e in "${envs[@]}"; do columns+=("entra_plan|entra_plan $e|$e|entra|entra"); done
for e in "${envs[@]}"; do columns+=("entra|entra $e|$e|entra|entra"); done
for e in "${envs[@]}"; do columns+=("azure_post_$e|azure_post_$e|$e||lz frontdoor release"); done
for e in "${envs[@]}"; do columns+=("azure_post_$host/portal|portal_endpoint $e|$e||pep"); done
columns+=("ado_pipelines|ado_pipelines|||ado")

# cell <status file> -> "status" or "status (detail)"; "-" when there is none. A failed one with its
# failure code: "failed PE009" (PE001 for a status file without one, ADR-0064).
cell() {
  local status detail code
  if [ ! -f "$1" ]; then
    printf -- '-'
    return 0
  fi
  status="$(jq -r '.status // ""' "$1" | tr -cd 'a-z-')"
  detail="$(jq -r '[.detail // {} | to_entries[] | "\(.key) \(.value)"] | join(", ")' "$1" | tr -cd 'A-Za-z0-9., -')"
  case "$status" in
    ok|waiting) ;;
    failed)
      code="$(jq -r '.code // "" | tostring' "$1" | tr -cd 'A-Z0-9')"
      [[ "$code" =~ ^PE[0-9]{3}$ ]] || code=PE001
      status="failed $code"
      ;;
    *) status=unknown ;;
  esac
  if [ -n "$detail" ]; then printf '%s (%s)' "$status" "$detail"; else printf '%s' "$status"; fi
}

# planned <Entra plan status file>: its Entra plan planned a registration or a secret for the stage entra.
planned() {
  [ -f "$1" ] && [ "$(jq -r 'select(.status == "ok") | .detail.entra == "deploy" or .detail.secret == "write" or .detail.secret == "rotate" or .detail.secretOld == "remove"' "$1")" = true ]
}

# moves: the network mode changes of this run and the follow-ups of earlier ones (ADR-0060), one row
# each: the change and its case; the result from azure_post_<env> (moved: the new default host and the
# outage, read by GET after the move; waiting: why, the app untouched; failed: the next run resumes) or
# from the stage entra (the follow-up: the previous variant's Easy Auth secret and passwords).
iso() { if [[ "$1" =~ ^[0-9]{9,10}$ ]]; then date -u -d "@$1" +%FT%TZ; else printf 'unknown (resumed)'; fi; }
move_count="$(jq -r '[.apps[].environments[] | select(.modeChange != null or .followUp != null)] | length' "$SAF_UNITS_JSON")"
[[ "$move_count" =~ ^[0-9]+$ ]] || move_count=0
moves() {
  local slug e from to case_ resume follow file status detail host outage result
  printf '\n### Network mode changes\n\n| App | Environment | Change | Result |\n|---|---|---|---|\n'
  while IFS=$'\t' read -r slug e from to case_ resume follow; do
    if ! prov_valid_slug "$slug" || ! prov_valid_env "$e"; then continue; fi
    if [ -n "$from" ]; then
      file="$(prov_status_path "$SAF_IN/azure_post_$e" "$slug" "$e")"
      status="$(jq -r '.status // ""' "$file" 2> /dev/null || true)"
      detail="$(jq -r '.detail.move // ""' "$file" 2> /dev/null || true)"
      case "$status/$detail" in
        ok/moved)
          host="$(jq -r '.detail.moveHost // ""' "$file" | tr -cd 'a-z0-9.-')"
          read -r -a outage <<< "$(jq -r '.detail.moveOutage // ""' "$file")"
          result="moved; new default host ${host:-unknown}; outage from $(iso "${outage[0]:-}") to $(iso "${outage[1]:-}")"
          if [ "$case_" = A ] && [ "$(jq -r --arg s "$slug" '.apps[] | select(.slug == $s) | .authMode // ""' "$SAF_APPS_JSON")" = required ]; then
            result+="; follow-up: the next provisioning run (any) removes the Easy Auth secret and passwords of the previous variant"
          fi
          ;;
        waiting/waiting-window)
          result="waits for the maintenance window ($(jq -r --arg s "$slug" --arg e "$e" '.apps[$s].environments[$e].modeChange.waitsForWindow // "unknown"' "$SAF_UNITS_JSON" | tr -cd '0-9TZ:.-')): a production environment moves only inside it; the prepare pass and the Entra step ran, the app is untouched"
          ;;
        waiting/*) result="waiting, the app untouched: $(jq -r '.reason // ""' "$file" | tr -cd 'A-Za-z0-9.,:;()_ -')" ;;
        failed/*) result="failed (see the log of azure_post_$e); the next run resumes the move (docs/runbooks/network-mode-change.md)" ;;
        *) result="not reached (an earlier stage is not ok)" ;;
      esac
      printf '| %s | %s | %s to %s (case %s%s) | %s |\n' "$slug" "$e" "$from" "$to" "$case_" "$([ "$resume" = true ] && printf ', resumed')" "$result" \
        | tr -cd 'A-Za-z0-9.,:;()_| \n-'
    fi
    if [ "$follow" = remove-old ]; then
      file="$(prov_status_path "$SAF_IN/entra" "$slug" "$e")"
      case "$(jq -r '"\(.status // "")/\(.detail.secretOld // "")"' "$file" 2> /dev/null || true)" in
        ok/deleted) result="removed" ;;
        ok/kept) result="nothing removed yet (the app was not seen in the new variant); a later run tries again" ;;
        failed/*) result="failed (see the log of the stage entra); the next run tries again" ;;
        *) result="not run (see the Entra plan: the previous variant's kvset job, or the entra stage)" ;;
      esac
      printf '| %s | %s | follow-up: the Easy Auth secret and passwords of the previous variant | %s |\n' "$slug" "$e" "$result" \
        | tr -cd 'A-Za-z0-9.,:;()_| \n-'
    fi
  done < <(jq -r --argjson envs "$(printf '%s\n' "${envs[@]}" | jq -R . | jq -s .)" '.apps | to_entries[] | .key as $s | .value.environments as $x
    | $envs[] | . as $e | ($x[$e] // {}) | select(.modeChange != null or .followUp != null)
    | (.modeChange // {}) as $m | ((($m.fromCell // "01") != "01") or (($m.toCell // "01") != "01")) as $cells
    | [$s, $e,
       (($m.from // "") + (if $cells and ($m.from // "") != "" and $m.fromCell != null then " cell \($m.fromCell)" else "" end)),
       (($m.to // "") + (if $cells and ($m.to // "") != "" then " cell \($m.toCell // "01")" else "" end)),
       ($m.case // ""), (($m.resume // false) | tostring), (.followUp // "")] | @tsv' "$SAF_UNITS_JSON" | head -n 200)
}

# runs_any <slug> <env or ''> <units...>: the plan runs one of the units of the app (in env; with no
# env, in any environment of the app: the app-wide stages).
runs_any() {
  local slug="$1" env="$2" u e
  shift 2
  for u in "$@"; do
    if [ -n "$env" ]; then
      if prov_unit_runs "$slug" "$env" "$u"; then return 0; fi
    else
      for e in "${envs[@]}"; do
        if prov_unit_runs "$slug" "$e" "$u"; then return 0; fi
      done
    fi
  done
  return 1
}

failed=0
waiting=0
not_planned=0
any_run="$(jq -r '[.apps[].environments[].units[]? | select(.run == true)] | length > 0' "$SAF_UNITS_JSON")"
held_count="$(jq -r '[.apps[].environments[].units[]? | select(.held == true)] | length' "$SAF_UNITS_JSON")"
[[ "$held_count" =~ ^[0-9]+$ ]] || held_count=0
invalid="$(jq -r '[.apps[] | select(.ok != true)] | length' "$SAF_APPS_JSON")"
not_planned="$(jq -r '[.apps[].environments[] | select(.plan == "failed")] | length' "$SAF_UNITS_JSON")"
[[ "$not_planned" =~ ^[0-9]+$ ]] || not_planned=0

# The apps with something to say (ADR-0050): invalid, not planned somewhere, a unit that ran or is
# held, or a status other than ok in any stage artifact. One pass over the files, not one per app.
listed=" "
while IFS= read -r slug; do
  if prov_valid_slug "$slug" && [[ "$listed" != *" $slug "* ]]; then listed+="$slug "; fi
done < <(
  jq -r '.apps[] | select(.ok != true) | .slug' "$SAF_APPS_JSON"
  jq -r '.apps | to_entries[] | select([.value.environments[] | (.plan == "failed"), ((.units // {})[] | (.run == true or .held == true))] | any) | .key' "$SAF_UNITS_JSON"
  find "$SAF_IN" -path '*/status/*.json' -not -path "$SAF_IN/registry_*" -type f -print0 | xargs -0 -r jq -r 'select(.status != "ok") | .slug // empty' 2> /dev/null || true
)
quiet_apps=0
for slug in "${slugs[@]}"; do
  [[ "$listed" == *" $slug "* ]] || quiet_apps=$((quiet_apps + 1))
done

# failures.json (ADR-0064): every failed app step with its failure code, in one pass over the status
# files (ADR-0050): every stage artifact but registry_<env> (a failed purge is a warning, below), and
# PE003 for an app environment the plan could not plan. Only checked shapes: slugs, environment and
# stage names, codes; never a reason or other text. At most 5000 entries.
{
  find "$SAF_IN" -path '*/status/*.json' -not -path "$SAF_IN/registry_*" -type f -print0 \
    | xargs -0 -r jq -c 'select(.status == "failed") | {slug, environment, stage, code: (.code // "PE001")}' 2> /dev/null || true
  jq -c '.apps | to_entries[] | .key as $s | .value.environments | to_entries[] | select(.value.plan == "failed")
    | {slug: $s, environment: .key, stage: "plan_\(.key)", code: "PE003"}' "$SAF_UNITS_JSON"
} | jq -s --arg run "${BUILD_BUILDID:-}" '
  def name($re): type == "string" and test($re);
  {schemaVersion: 1, runId: $run,
   failures: (map(select((.slug | name("^[a-z](-?[a-z0-9])+$")) and (.environment == null or (.environment | name("^[a-z][a-z0-9]{1,7}$")))
       and (.stage | name("^[a-z][a-z0-9_]{1,40}$"))) | .code = (if (.code | name("^PE[0-9]{3}$")) then .code else "PE001" end))
     | unique_by([.slug, .environment // "", .stage]) | .[:5000])}' > "$out/failures.json"
failure_count="$(jq '.failures | length' "$out/failures.json")"
[[ "$failure_count" =~ ^[0-9]+$ ]] || failure_count=0

# behind: the units held for their upgrade (ADR-0049), one row per app and environment.
behind() {
  printf '\n### Behind (upgrade available)\n\n'
  printf '%s\n' "$held_count unit(s) are held for an upgrade: this core changed their template since they were applied. They run when the app is upgraded (the portal, or the parameter upgrade of this pipeline)."
  printf '\n| App | Environment | Behind (changed in; applied by) |\n|---|---|---|\n'
  # One row per app and environment with a held unit, in one pass (apps in plan order, environments in list order).
  jq -r --argjson envs "$(printf '%s\n' "${envs[@]}" | jq -R . | jq -s .)" '.apps | to_entries[] | .key as $s | .value.environments as $x
    | $envs[] | . as $e | (($x[$e].units // {}) | to_entries | map(select(.value.held == true) | "\(.key) (\(.value.details | join("; ")))") | join(", ")) as $c
    | select($c != "") | "| \($s) | \($e) | \($c) |"' "$SAF_UNITS_JSON" | tr -cd 'A-Za-z0-9.,:;()_| \n-'
}

# window_waits: the time-based work that waits for the maintenance window (ADR-0048 section 7,
# amended 2026-11-11), one row per app and environment, at most 100 rows.
waits_count="$(jq -r '[.apps[].environments[].units[]? | select(((.waits // []) | length) > 0)] | length' "$SAF_UNITS_JSON")"
[[ "$waits_count" =~ ^[0-9]+$ ]] || waits_count=0
window_waits() {
  local next_start rows
  next_start="$(jq -r '.maintenance.until // ""' "$SAF_UNITS_JSON" | tr -cd '0-9TZ:.-')"
  printf '\n### Waiting for the maintenance window\n\n'
  printf '%s\n' "$waits_count unit(s) have time-based work that waits for the next maintenance window (starts ${next_start:-unknown}, UTC): drift checks, Easy Auth rotations and the restarts after them, re-applies for changed Front Door backend ranges. A rotation with at most 14 days left runs in any run."
  printf '\n| App | Environment | Waits |\n|---|---|---|\n'
  rows="$(jq -r --argjson envs "$(printf '%s\n' "${envs[@]}" | jq -R . | jq -s .)" '.apps | to_entries[] | .key as $s | .value.environments as $x
    | $envs[] | . as $e | (($x[$e].units // {}) | to_entries | map(select(((.value.waits // []) | length) > 0) | "\(.key) (\(.value.waits | join("; ")))") | join(", ")) as $c
    | select($c != "") | "| \($s) | \($e) | \($c) |"' "$SAF_UNITS_JSON" | tr -cd 'A-Za-z0-9.,:;()_| \n-')"
  printf '%s\n' "$rows" | head -n 100
  if [ "$(printf '%s\n' "$rows" | wc -l)" -gt 100 ]; then
    printf '\n... and %s more row(s) (units/units.json, field waits).\n' "$(($(printf '%s\n' "$rows" | wc -l) - 100))"
  fi
}

# decommissioned: the apps being decommissioned (ADR-0056), one row each: the phase and what comes next.
decom_count="$(jq -r '[.apps[] | select(.decommission != null)] | length' "$SAF_UNITS_JSON")"
[[ "$decom_count" =~ ^[0-9]+$ ]] || decom_count=0
decommissioned() {
  printf '\n### Decommissioning\n\n| App | Phase | Requested | Deleted on or after | Next |\n|---|---|---|---|---|\n'
  jq -r '.apps | to_entries[] | select(.value.decommission != null) | .key as $s | .value.decommission as $d
    | "| \($s) | \($d.phase)\(if $d.immediate == true then " (immediate)" else "" end) | \($d.requestedOn) | \(if $d.immediate == true then "now (no production)" else ($d.dueOn // $d.deleteAfter) end) | \(
        if $d.phase == "deleted" then "deleted: nothing is left in Azure (read in this run); nothing runs for it, the portal shows it as deleted"
        elif $d.phase == "deleting" and any(($d.waits // [])[]; test("is left|not read")) then "delete phase; " + ([($d.waits // [])[] | select(test("is left|not read")) | sub("^decommission: "; "")] | join("; "))
        elif $d.phase == "deleting" and $d.immediate == true then "immediate deletion: the stop and step 1 (Azure DevOps, Entra, Front Door, portal endpoint) first, the resource groups in the next run (the portal queues it)"
        elif $d.phase == "deleting" then "delete phase: step 1 (Azure DevOps, Entra, Front Door, portal endpoint) in this run, the resource groups in a later one"
        elif any(($d.waits // [])[]; test("immediate refused")) then "stopped; immediate deletion refused (the app has production): deleted after the grace period"
        elif (($d.waits // []) | length) > 0 then "stopped; the delete phase waits for the maintenance window"
        else "stopped (or stopping in this run); Cancel is possible until the delete phase starts" end) |"' "$SAF_UNITS_JSON" \
    | tr -cd 'A-Za-z0-9.,:;()_| \n-' | head -n 100
}

# registry_purge: the registry image purge of the build environments (ADR-0059), when the plan
# purged or deferred an app: the retention, the counts and one row per app purged in this run.
registry_plan="$SAF_IN/units/registry.json"
registry_failed=0
registry_active=false
if [ -f "$registry_plan" ] && [ "$(jq -r '[.environments[] | (.due // 0) + (.deferred // 0)] | add // 0 | . > 0' "$registry_plan")" = true ]; then
  registry_active=true
fi
registry_purge() {
  local e slug file
  printf '\n### Old images (registry purge)\n\n'
  jq -r '.retention as $r | .environments | to_entries[] | select(((.value.due // 0) + (.value.deferred // 0)) > 0)
    | "\(.key): \($r.mode), older than \($r.days) days, the newest \($r.keepLatest) kept: \(.value.due) app(s) in this run\(if (.value.deferred // 0) > 0 then ", \(.value.deferred) deferred to the next window" else "" end)."' \
    "$registry_plan" | tr -cd 'A-Za-z0-9.,:;()_ \n-'
  printf '\n| App | Environment | Result |\n|---|---|---|\n'
  while IFS=$'\t' read -r e slug; do
    if ! prov_valid_env "$e" || ! prov_valid_slug "$slug"; then continue; fi
    file="$(prov_status_path "$SAF_IN/registry_$e" "$slug" "$e")"
    case "$(cell "$file")" in
      failed*) registry_failed=$((registry_failed + 1)) ;;
    esac
    printf '| %s | %s | %s |\n' "$slug" "$e" "$(cell "$file")"
  done < <(jq -r '.environments | to_entries[] | .key as $e | .value.apps // {} | to_entries[] | select(.value.run == true) | [$e, .key] | @tsv' "$registry_plan" | head -n 300)
  # shellcheck disable=SC2016 # backticks are Markdown code spans
  printf '\n`-`: the stage did not run or did not reach the app. `wouldDelete`: dry-run mode (maintenance.registryRetention.mode), nothing was deleted. Kept: what runs in any environment of the app, its newest builds, what is younger than the retention, untagged or locked images and ones with a tag the delivery pipeline does not write.\n'
}

{
  printf '## Provisioning\n\n'
  upgrade="$(jq -r 'if (.upgrade.all // false) then "all apps" else ((.upgrade.apps // []) | join(", ")) end' "$SAF_UNITS_JSON" | tr -cd 'a-z0-9, -')"
  if [ -n "$upgrade" ]; then printf 'Upgrade requested (parameter upgrade): %s.\n\n' "$upgrade"; fi
  if [ "$any_run" != true ] && [ "$invalid" = 0 ] && [ "$not_planned" = 0 ]; then
    if [ "$held_count" = 0 ]; then
      printf 'Nothing to do: every unit of every app is recorded and up to date (%s app(s); only validate and plan ran).\n' "${#slugs[@]}"
    else
      printf 'Nothing to do: every unit of every app is recorded; %s unit(s) are behind, held for an upgrade (%s app(s)).\n' "$held_count" "${#slugs[@]}"
      behind
    fi
    if [ "$waits_count" != 0 ]; then window_waits; fi
    if [ "$decom_count" != 0 ]; then decommissioned; fi
    if [ "$registry_active" = true ]; then registry_purge; fi
    if [ "$move_count" != 0 ]; then moves; fi
  else
    printf '### Units that ran\n\n| App | Environment | Ran (why) | Recorded | Again next run |\n|---|---|---|---|---|\n'
    # The app x environment pairs with a unit that ran, in one pass (environments in list order).
    while IFS=$'\t' read -r slug e ran; do
      if ! prov_valid_slug "$slug" || ! prov_valid_env "$e"; then continue; fi
      ran="$(printf '%s' "$ran" | tr -cd 'A-Za-z0-9.,:;()_ -')"
      [ -n "$ran" ] || continue
      done_units=""
      again=""
      for u in lz entra release frontdoor pep ado; do
        prov_unit_runs "$slug" "$e" "$u" || continue
        if [ -n "$(prov_unit_tag "$slug" "$e" "$u" record)" ] && prov_unit_finished "$slug" "$e" "$u" "$host"; then
          done_units+=" $u"
        else
          again+=" $u"
        fi
      done
      done_units="${done_units# }"
      again="${again# }"
      printf '| %s | %s | %s | %s | %s |\n' "$slug" "$e" "$ran" "${done_units:--}" "${again:--}"
    done < <(jq -r --argjson envs "$(printf '%s\n' "${envs[@]}" | jq -R . | jq -s .)" '.apps | to_entries[] | .key as $s | .value.environments as $x
      | $envs[] | . as $e | (($x[$e].units // {}) | to_entries
        | map(select(.value.run == true) | "\(.key) (\(.value.reasons | join(", "))\(if (.value.details | length) > 0 then ": " + (.value.details | join("; ")) else "" end))")
        | join("; ")) as $r | select($r != "") | [$s, $e, $r] | @tsv' "$SAF_UNITS_JSON")
    skipped="$(jq -r '.stages | to_entries | map(select(.value != true) | .key
      | if . == "ado" then "ado_resources, ado_pipelines" elif . == "entraPlan" then "entra_plan"
        elif startswith("lz_") then "azure_" + ltrimstr("lz_") elif startswith("post_") then "azure_post_" + ltrimstr("post_")
        else . end) | join(", ")' "$SAF_UNITS_JSON" | tr -cd 'a-z0-9_, ')"
    printf '\nStages skipped (none of their units ran): %s\n' "${skipped:-none}"
    if [ "$move_count" != 0 ]; then moves; fi
    if [ "$held_count" != 0 ]; then behind; fi
    if [ "$waits_count" != 0 ]; then window_waits; fi
    if [ "$decom_count" != 0 ]; then decommissioned; fi
    if [ "$registry_active" = true ]; then registry_purge; fi
    # ADR-0064: the failed app steps with their codes and what to do (the catalogue's English text).
    if [ "$failure_count" -gt 0 ]; then
      saf_cli provisioning failures --input "$out/failures.json" \
        || printf '\n### Failures\n\n%s app step(s) failed; their codes are in failures.json (artifact report).\n' "$failure_count"
    fi
    printf '\n'

    printf '### Status per app\n\n'
    header="| App |"
    rule="|---|"
    for c in "${columns[@]}"; do
      IFS='|' read -r _ head _ _ _ <<<"$c"
      header+=" $head |"
      rule+="---|"
    done
    printf '%s\n%s\n' "$header" "$rule"
    for slug in "${slugs[@]}"; do
      [[ "$listed" == *" $slug "* ]] || continue
      app_envs=" $(jq -r --arg s "$slug" '.apps[] | select(.slug == $s) | (.environments // []) | join(" ")' "$SAF_APPS_JSON") "
      auth="$(jq -r --arg s "$slug" '.apps[] | select(.slug == $s) | .authMode // ""' "$SAF_APPS_JSON")"
      ok="$(jq -r --arg s "$slug" '.apps[] | select(.slug == $s) | .ok == true' "$SAF_APPS_JSON")"
      row="| $slug |"
      for c in "${columns[@]}"; do
        IFS='|' read -r dir _ env only units <<<"$c"
        if { [ -n "$env" ] && [[ "$app_envs" != *" $env "* ]]; } || { [ "$only" = entra ] && [ "$auth" != required ]; }; then
          row+=" n/a |"
          continue
        fi
        file="$(prov_status_path "$SAF_IN/$dir" "$slug" "$env")"
        value="$(cell "$file")"
        if [ "$dir" = entra_plan ] && [ "$ok" = true ]; then
          value="$(cell "$(prov_status_path "$(prov_entra_dir "$slug" "$env")" "$slug" "$env")")"
        fi
        if [ "$dir" = entra ] && [ "$value" = - ] && planned "$(prov_status_path "$(prov_entra_dir "$slug" "$env")" "$slug" "$env")"; then
          value="waiting (entra not run)"
        fi
        # shellcheck disable=SC2086 # units is a list of fixed unit names
        if [ "$value" = - ] && [ -n "$units" ] && [ "$ok" = true ] && ! runs_any "$slug" "$env" $units; then
          value=unchanged
        fi
        case "$value" in
          failed*) failed=$((failed + 1)) ;;
          waiting*) waiting=$((waiting + 1)) ;;
        esac
        row+=" $value |"
      done
      printf '%s\n' "$row"
    done
    if [ "$quiet_apps" -gt 0 ]; then
      printf '\n%s other app(s) have nothing to report: every unit of theirs is recorded and up to date.\n' "$quiet_apps"
    fi
    # shellcheck disable=SC2016 # backticks are Markdown code spans
    printf '\n`Ran (why)`: new = no record of the unit yet (a new app or environment, or it did not finish last time), template = core changed the unit since it was applied and this run applies the new template (with the reason that lets it: upgrade = the app is in the parameter upgrade, minAppVersion = applied by a version this core no longer manages, requires = another unit'"'"'s upgrade needs it, or new, inputs, dependency), inputs = a setting it uses changed, dependency = another change needs it, drift = its regular check (maintenance.driftCheckDays), all = this run checks all apps. `Recorded`: finished, the next runs skip it until something changes. `unchanged`: none of the app'"'"'s units of that stage ran. `-`: not processed in that stage (an earlier stage is not ok, or no Entra change). `failed PE0nn`: failed, with its failure code (section Failures). `waiting`: blocked on something this run does not create or an Entra change that was not approved (see the warnings). `secret`: the Easy Auth client secret in the environment vault (absent, write = planned, written = by this run; rotate = due and planned, rotated = by this run, current = not due, deferred = due, waits for the maintenance window; `secretExpiry` soon or expired = rotations were missed). `easyAuth`: the app runs with the secret'"'"'s current version (current), was restarted to read it (restarted; tag-after-settle = the version is under 30 minutes old, the next run in the maintenance window restarts again and tags), or could not be read (unknown). `removeAssignments`, `removeRoles`: role assignments and app roles app.yaml no longer lists, planned for removal (`removedAssignments`, `removedRoles`: removed by this run). `frontDoor`: the custom domain through Front Door (deployed = by this run, up-to-date; dns-manual = create the TXT and CNAME listed in the azure_post log by hand; removing = app.yaml asks for no domain any more: the ingress opens first, then it is removed; removed = by this run, the app answers on its default host; records of a manual zone are listed in the warnings for the DNS team). `frontDoorPrevious`: a changed host (kept = the old host keeps working until Front Door serves the new one; removed = by this run). The domain answers about 20 minutes after its DNS records exist. `portalEndpoint`: the vault'"'"'s private endpoint in the portal network, so owners can set secrets in the portal (deployed, up-to-date; not-needed = the vault is on the Azure-managed network; waiting = the portal isn'"'"'t deployed or the vault'"'"'s environment hasn'"'"'t approved it yet; leftover = an endpoint no longer needed, delete it by hand).\n'
  fi
} > "$out/summary.md"

saf_neutralise < "$out/summary.md"
# A failed registry purge (ADR-0059): its stage failed the run already; here only a warning.
if [ "$registry_failed" -gt 0 ]; then
  printf '##vso[task.logissue type=warning]%s\n' "$registry_failed registry purge(s) failed: those apps keep their images and their last purge's tag, and the next maintenance window tries again (see the section Old images)"
fi
if [ "$waiting" -gt 0 ]; then
  printf '##vso[task.logissue type=warning]%s\n' "$waiting app step(s) are waiting (see the table)"
fi
if [ "$not_planned" -gt 0 ]; then
  printf '##vso[task.logissue type=error]%s\n' "$not_planned app environment(s) could not be planned: none of their units ran (see the jobs plan_<env> of stage plan)"
fi
if [ "$failed" -gt 0 ] || [ "$not_planned" -gt 0 ]; then
  saf_die "$failed app step(s) failed or app definition(s) are invalid, $not_planned app environment(s) not planned (see the table)"
fi
saf_info "Every app is ok or waiting."
