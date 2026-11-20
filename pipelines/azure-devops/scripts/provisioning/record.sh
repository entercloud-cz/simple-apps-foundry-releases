#!/usr/bin/env bash
# record.sh — stage record_<env>, job `tags`, run by AzureCLI@2 with sc-platform-provisioning-<env>
# (Azure provisioning identity of the environment, ADR-0031). Provisioning by unit (ADR-0048
# section 3). The stage runs only when a unit ran in <env> or a rebase is due there (output
# record_<env>).
#
# Per app of the plan in <env> (planned there), up to PROV_PARALLEL_MAX at the same time, on its app
# resource group (by naming, `platform provisioning plan-names --apps`, and only when the plan names
# the same group: never a group from an artifact alone, ADR-0052), for each unit the plan ran there (lz, entra, release, frontdoor,
# pep, and ado, which is recorded in every environment of the app):
#   - finished in this run (prov_unit_finished: the conditions of ADR-0046's recording, split per
#     unit) -> the tag saf-u-<unit> = "<core version> <first 12 hex of i> <UTC date, YYYYMMDD>" as
#     the plan computed it (a unit recorded for the first time gets a date backdated by its stable
#     offset, so the drift checks spread over maintenance.driftCheckDays);
#   - ran and did not finish -> its tag is deleted (with the value the plan read), so the next run
#     processes it again;
#   - did not run -> its tag stays; a held unit with a rebase (ADR-0049 section 3: outdated, its i
#     changed only because this core renders the same files differently) gets the plan's rebased
#     value, the tag's version and date with the new i;
#   - with any unit tag it writes, saf-u-files = the first 12 hex of the app's files hash (app.yaml
#     and instance.yaml without coreVersion, ADR-0049), so the next plan can tell a rebase from a
#     changed setting.
# Decommissioning (ADR-0056): a unit with action delete that finished gets saf-u-<unit> = "removed
# <YYYYMMDD>" (the plan's record); a landing zone's delete leaves no group to tag (no tag is written
# for the app); when the release's retire finished and the group has no saf-u-retired yet,
# saf-u-retired = <YYYYMMDD> (the grace period counts from it); an app active again (Cancel) loses
# saf-u-retired. The landing zone's record lz-{slug}-{env} goes here, last (lz_record_delete): only
# when azure_<env> deleted the group in this run and ado_resources then deleted the app's service
# connection there (detail connection-<env> gone; Azure DevOps refuses it while the delivery
# identity's federated credential exists, which goes with the group; amendment 2026-11-12). While the
# record is left, the next plan resumes the delete, and the app isn't deleted: a connection left in
# Azure DevOps keeps the record.
# The tag saf-provisioned of ADR-0046 (retired) is deleted with the value the plan read. Writes are
# `az tag update --operation merge`, deletes `--operation delete` with name and value; the landing
# zone's own tags stay. Statuses go to the job's scratch folder only (no artifact): a failure fails
# this stage, and the units whose tags it didn't write run again next time (fail safe).
# Verify in sandbox: UNIT-1 (the tag values and the delete by name and value).
# Env: SAF_ENV_NAME, SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION (template constants).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE="record_$SAF_ENV_NAME"
out="$SAF_WORK/$PROV_STAGE"
rm -rf "$out"
mkdir -p "$out/status"

prov_environment
prov_units_check
host="$(prov_portal_host)"

# lz_record_delete <slug>: the record lz-{slug}-{env} of a decommissioned app, by naming (plan-names
# --apps), once its group is gone (delete-lz of azure_<env> in this run, and the group is not there)
# and its service connection is (detail connection-<env> gone of ado_resources). Otherwise it stays.
lz_record_delete() {
  local slug="$1" lz_name rg err="$PROV_DIR/lz-record.err"
  lz_name="$(jq -r --arg s "$slug" '.landingZoneRecords[$s] // ""' "$app_names")"
  [[ "$lz_name" =~ ^lz-[a-z0-9-]{3,60}$ ]] || saf_die "naming gives no landing-zone record for $slug in $env_name"
  rg="$(jq -r --arg s "$slug" '.appResourceGroups[$s] // empty' "$app_names")"
  [[ "$rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "naming gives no valid resource group for $slug in $env_name"
  if ! prov_status_done "$(prov_status_path "$SAF_IN/azure_$env_name" "$slug" "$env_name")" delete-lz; then
    saf_info "  $slug in $env_name: its resource group wasn't deleted in this run; the record $lz_name stays"
    return 0
  fi
  if [ "$(jq -r --arg k "connection-$env_name" '.detail[$k] // ""' "$(prov_status_path "$SAF_IN/ado" "$slug")" 2> /dev/null)" != gone ]; then
    saf_info "  $slug in $env_name: its service connection isn't deleted yet; the record $lz_name stays (the next run deletes the connection, then the record)"
    return 0
  fi
  [ "$(az group exists --name "$rg" --only-show-errors)" = false ] || saf_die "the resource group $rg still exists; the record $lz_name stays"
  if az deployment sub show --name "$lz_name" --query name --output tsv --only-show-errors > /dev/null 2> "$err"; then
    az deployment sub delete --name "$lz_name" --only-show-errors --output none
  elif ! grep -Eq 'DeploymentNotFound|NotFound' "$err"; then
    saf_neutralise < "$err" | tail -n 5
    saf_die "could not read the record $lz_name"
  fi
  saf_info "  $slug in $env_name: its service connection and resource group are gone; deleted the record $lz_name"
  prov_detail landingZoneRecord deleted
}

# record_tags <slug>: the tags of the app's units in env_name.
record_tags() {
  local slug="$1" rg u value old rebase files legacy retired finished="" removed="" rebased=""
  local -a writes=() deletes=()
  # ADR-0056: a landing zone deleted in this run (or whose delete didn't finish) gets no tag; its record
  # goes last, after the service connection.
  if prov_unit_runs "$slug" "$env_name" lz && [ "$(prov_unit_action "$slug" "$env_name" lz)" = delete ]; then
    saf_info "  $slug in $env_name: its resource group was being deleted; nothing to record"
    lz_record_delete "$slug"
    prov_detail recorded ""
    return 0
  fi
  # The group by naming (plan-names), never the plan's value alone (ADR-0052): both must agree.
  rg="$(jq -r --arg s "$slug" '.appResourceGroups[$s] // ""' "$app_names")"
  [[ "$rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "naming gives no valid resource group for $slug in $env_name"
  [ "$(jq -r --arg s "$slug" --arg e "$env_name" '.apps[$s].environments[$e].resourceGroup // ""' "$SAF_UNITS_JSON")" = "$rg" ] \
    || saf_die "the plan names another resource group for $slug in $env_name than naming ($rg); no tag is written"
  for u in lz entra release frontdoor pep ado; do
    if ! prov_unit_runs "$slug" "$env_name" "$u"; then
      rebase="$(prov_unit_tag "$slug" "$env_name" "$u" rebase)"
      if [ -n "$rebase" ]; then
        writes+=("saf-u-$u=$rebase")
        rebased+=" $u"
      fi
      continue
    fi
    old="$(prov_unit_tag "$slug" "$env_name" "$u" tag)"
    value="$(prov_unit_tag "$slug" "$env_name" "$u" record)"
    if [ -n "$value" ] && prov_unit_finished "$slug" "$env_name" "$u" "$host"; then
      writes+=("saf-u-$u=$value")
      finished+=" $u"
    else
      if [ -n "$old" ]; then deletes+=("saf-u-$u=$old"); fi
      removed+=" $u"
    fi
  done
  # ADR-0056: the stop's date once the retire finished; removed again when the app is active.
  retired="$(jq -r --arg s "$slug" --arg e "$env_name" '.apps[$s].environments[$e].retired.record // ""' "$SAF_UNITS_JSON")"
  if [[ "$retired" =~ ^[0-9]{8}$ ]] && [[ " $finished " == *" release "* ]]; then writes+=("saf-u-retired=$retired"); fi
  retired="$(jq -r --arg s "$slug" --arg e "$env_name" '.apps[$s].environments[$e].retired | if . != null and .remove == true then (.tag // "") else "" end' "$SAF_UNITS_JSON")"
  if [[ "$retired" =~ ^[0-9]{8}$ ]]; then deletes+=("saf-u-retired=$retired"); fi
  legacy="$(jq -r --arg s "$slug" --arg e "$env_name" '.apps[$s].environments[$e].legacyTag // ""' "$SAF_UNITS_JSON")"
  if [[ "$legacy" =~ ^([0-9a-f]{64}|stale)$ ]]; then deletes+=("saf-provisioned=$legacy"); fi
  files="$(prov_files_tag "$slug" "$env_name" files)"
  if [ "${#writes[@]}" -gt 0 ] && [ -n "$files" ]; then writes+=("saf-u-files=$files"); fi
  if [ "${#writes[@]}" -gt 0 ]; then
    az tag update --resource-id "/subscriptions/$subscription/resourceGroups/$rg" --operation merge \
      --tags "${writes[@]}" --only-show-errors --output none
  fi
  if [ "${#deletes[@]}" -gt 0 ]; then
    az tag update --resource-id "/subscriptions/$subscription/resourceGroups/$rg" --operation delete \
      --tags "${deletes[@]}" --only-show-errors --output none
  fi
  saf_info "  $slug in $env_name: recorded${finished:- nothing}; not finished (runs again next time):${removed:- none}; rebased:${rebased:- none}"
  prov_detail recorded "${finished# }"
  prov_detail again "${removed# }"
  prov_detail rebased "${rebased# }"
}

prov_plan_apps "$env_name"
saf_info "Unit tags in $env_name: ${#PROV_APPS[@]} app(s) of the plan."
# The app resource groups by naming, once for every app (names.ts, checked against naming.bicep).
app_names="$SAF_WORK/record-names.json"
saf_cli provisioning plan-names --instance "$SAF_INSTANCE" --env "$env_name" --apps "$SAF_APPS_JSON" --output "$app_names" > /dev/null
# The apps with a tag to write or delete here (a unit ran, a rebase, the retired tag), in one pass
# over the plan instead of one per app and unit (ADR-0050).
touched=" $(jq -r --arg e "$env_name" '[.apps | to_entries[] | select(.value.environments[$e] as $x | $x != null
    and ((($x.units // {}) | to_entries | any(.value.run == true or .value.rebase != null)) or (($x.legacyTag // "") != "")
      or ($x.retired.remove // false))) | .key] | join(" ")' \
  "$SAF_UNITS_JSON") "
prov_parallel
for slug in "${PROV_APPS[@]}"; do
  if ! prov_planned "$slug" "$env_name"; then
    prov_skip "$slug" "not planned in $env_name"
    continue
  fi
  if [[ "$touched" != *" $slug "* ]]; then
    prov_pass "$slug" "$env_name"
    continue
  fi
  prov_run_app "$(prov_status_path "$out" "$slug" "$env_name")" "$slug" "$env_name" record_tags "$slug"
done
prov_finish
