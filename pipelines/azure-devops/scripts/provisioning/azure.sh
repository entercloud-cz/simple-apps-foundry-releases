#!/usr/bin/env bash
# azure.sh — stage azure_<env>, job `landing_zones`, run by AzureCLI@2 with
# sc-platform-provisioning-<env> (Azure provisioning identity of the environment, ADR-0031). The
# stage runs only when the plan runs the unit `lz` of an app in <env> (ADR-0048, output lz_<env>).
#
# Per app of the plan whose `lz` runs in <env> (skipped when its landing zone in <promoteFrom> is not
# ok: azure_<promoteFrom> when its lz ran there, else plan_<promoteFrom>), up to PROV_PARALLEL_MAX
# apps at the same time (ADR-0046); every other app is unchanged here (prov_pass):
#   a. names.bicep (bicep snapshot): app resource group, lz-{slug}-{env};
#   b. the lz record (`az deployment sub show`, none on the first run);
#   c. `platform provisioning state` (no ADO outputs: the federation and the Easy Auth flag are
#      carried from the lz record, so this pass never resets them) and `inputs --step lz`; for an
#      app the plan moves to another network mode (release action move, ADR-0060) with
#      `--prepare-from <the plan's modeChange.from>`: the prepare pass (endpoints in the target
#      spoke or kept in the source one, public access as the source mode needs it, Joiner on the
#      target CAE), never the final one, which azure_post_<env>'s move step deploys once the app
#      has left its source CAE. Its outputs (and the secret entry of f) name the target already;
#      nothing re-applies the release from them before the move;
#   d. `az deployment sub validate` + `platform provisioning compare` against the record;
#   e. `az deployment sub create` through landing-zone.bicepparam only when not up to date; then the
#      unit tags saf-u-* of the plan go back on the app resource group, which the deployment
#      rewrote (prov_tags_restore; a failure there only makes the units run again next time);
#   f. an app that requires sign-in: its Easy Auth secret entry again (prov_write_secret_entry,
#      ADR-0035, ADR-0041), after the landing zone, so the vault is the one it uses now ->
#      secret/{slug}.{env}.json;
#   g. the custom domain's entry again (prov_write_frontdoor_entry, ADR-0010 amended 2026-11-11):
#      the record fd-{slug}-{env} -> frontdoor/{slug}.{env}.json and .domain.json, with the backend
#      ranges plan_<env> resolved (frontdoor/backend-ranges.json of plan_<env>; an app on a custom
#      domain fails without them).
# Decommissioning (ADR-0056), lz with action delete (step 2 of the delete phase, only once its other
# units are recorded removed): lz_delete below; nothing above runs for that app.
# The later stages read an app's entries from here when its lz ran here, else from plan_<env>
# (prov_entry_dir), so this stage writes every entry of the apps it processes.
# Artifact azure_<env> (its folder exists from the job's first step, published with always()):
# status/{slug}.{env}.json, lz-outputs/{slug}.{env}.json (the landing zone's properties.outputs, read
# by ado_resources for the delivery identity and by entra_plan), secret/{slug}.{env}.json (sign-in
# apps), frontdoor/{slug}.{env}.json and .domain.json.
# Env: SAF_ENV_NAME, SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION (template constants).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE="azure_$SAF_ENV_NAME"
out="$SAF_OUT/$PROV_STAGE"
rm -rf "$out"
mkdir -p "$out/status" "$out/lz-outputs" "$out/secret" "$out/frontdoor"

saf_bicep_pin_check
prov_environment
prov_units_check
source_env="${SAF_PROMOTE_FROM:-}"

landing_zone() {
  local mode prepare
  slug="$1"
  app_file="$(prov_app_file "$slug")"
  names="$PROV_DIR/names.json"
  prov_names "$slug" "$names"
  # ADR-0060: a network mode change deploys the prepare pass here; the move step of azure_post_<env>
  # deploys the final one after the app left its source CAE.
  prepare="$(prov_mode_change "$slug" "$env_name" from)"
  if [ -n "$prepare" ]; then saf_info "  Network mode change from $prepare: the landing zone's prepare pass (the app keeps running where it is)"; fi
  prov_lz "$PROV_DIR/lz" "$out/lz-outputs/$slug.$env_name.json" "" "$prepare"
  if [ "$(prov_app_auth "$slug")" = required ]; then
    mode="$(jq -r '.networkMode // ""' "$PROV_DIR/lz/lz.json")"
    prov_write_secret_entry "$out/lz-outputs/$slug.$env_name.json" "$out/secret/$slug.$env_name.json" "$mode"
  fi
  prov_write_frontdoor_entry "$out"
}

# lz_delete <slug>: step 2 of a decommissioned app's delete phase (ADR-0056) in env_name. Each delete
# behind its guard (P26, ADR-0052); gone already = done; a failure leaves the rest for the next run:
#   a. the app resource group by naming (names.bicep) must carry the tags Application = <slug> and
#      Environment = <env> the landing zone wrote; a management lock in it (vaulted backup's delete
#      lock, or one made by hand) stops here (waiting: provisioning never removes a lock, the runbook
#      decommission-app.md names the person's step);
#   b. the role assignments the landing zone made outside the group (App Environment Joiner on the
#      CAE, Key Vault Secrets User on its Easy Auth secret, Data Importer on the app's own registry of
#      promoteFrom): only assignments of the identities in the app's group, only at those scopes;
#   c. az group delete (waits; everything in the group, data included, goes, the delivery identity's
#      federated credential with it);
#   d. the Easy Auth secret easyauth-{slug} in the environment vault of the app's network mode, through
#      that CAE's kvset job (lz_secret_delete, ADR-0061 section 4): a new app with the slug would find
#      it and write none of its own. A failure, or a kvset job that isn't ready (waiting), ends the unit
#      before delete-lz, so record_<env> keeps the record and the next run resumes here;
#   e. the nested records of lz-{slug}-{env} in the platform resource group (named by its
#      operations). The record itself stays: record_<env> deletes it once the stage ado_resources of
#      this run deleted the app's service connection there (Azure DevOps refuses that while the
#      federated credential exists; ADR-0056 amendment 2026-11-12). While it is left, the next plan
#      resumes here (the group is gone already) and runs ado again. The landing zone's outputs of the
#      plan are copied to this stage's entries, where ado_resources reads the delivery identity's
#      client ID (the connection's guard).
lz_delete() {
  local rg lz_name locks
  slug="$1"
  names="$PROV_DIR/names.json"
  prov_names "$slug" "$names"
  rg="$(prov_name "$names" appResourceGroup)"
  lz_name="$(prov_name "$names" provisioningDeployment)"
  if [ "$(az group exists --name "$rg" --only-show-errors)" = true ]; then
    az group show --name "$rg" --query tags --output json --only-show-errors > "$PROV_DIR/rg-tags.json"
    # The guard: the group is the app's by naming and by the tags its landing zone wrote.
    if [ "$(jq -r '.Application // ""' "$PROV_DIR/rg-tags.json")" != "$slug" ] || [ "$(jq -r '.Environment // ""' "$PROV_DIR/rg-tags.json")" != "$env_name" ]; then
      saf_die "the resource group $rg doesn't carry the tags Application = $slug and Environment = $env_name; it is left alone (check it by hand)"
    fi
    locks="$(az lock list --resource-group "$rg" --query 'length(@)' --output tsv --only-show-errors)"
    if [ "${locks:-0}" != 0 ]; then
      prov_detail lz locked
      prov_wait "$slug in $env_name: the resource group $rg has $locks management lock(s) (vaulted blob backup's delete lock, or one made by hand); provisioning never removes a lock. Follow docs/runbooks/decommission-app.md (stop protection, remove the lock), then the next run in the maintenance window deletes it"
    fi
    lz_outside_assignments "$rg"
    saf_info "  Deleting the resource group $rg and everything in it (decommissioning)"
    az group delete --name "$rg" --yes --only-show-errors --output none
  else
    saf_info "  The resource group $rg is gone already"
  fi
  lz_secret_delete
  lz_nested_cleanup "$lz_name"
  # The client ID that proves the service connection is the app's (ado_resources reads this stage's entries).
  if [ -f "$SAF_IN/plan_$env_name/lz-outputs/$slug.$env_name.json" ]; then
    prov_copy_object "$SAF_IN/plan_$env_name/lz-outputs/$slug.$env_name.json" "$out/lz-outputs/$slug.$env_name.json" \
      || saf_die "the landing-zone outputs of $slug in $env_name (plan_$env_name) are not a JSON object"
  fi
  prov_detail lz deleted
  prov_done delete-lz
}

# lz_secret_delete: step d (ADR-0061 section 4) for the current app. The secret easyauth-{slug} in the
# environment vault of the app's network mode in app.yaml (names.bicep environmentVault, as ADR-0060
# decision 9 reads it): absent (an ARM GET of its metadata) = done, without a job execution. Otherwise
# the kvset job of that mode's CAE (by naming) must exist and run this core's saf-jobs image (rule
# P23; else the app waits), and `platform provisioning easyauth-delete` starts its delete action
# (SAF_SECRET_ACTION delete, ADR-0060: a soft delete, never a purge; absent = done) with this
# identity's ARM token (Contributor, ADR-0031, as for the dbinit job). One execution of the job at a
# time (prov_lock). A failure fails the unit: delete-lz isn't done, so record_<env> keeps
# lz-{slug}-{env}, the plan doesn't read the app deleted, and the next run tries again. Runs after
# step b (the Easy Auth identity's role on the secret is gone first). Verify in sandbox: DECOM-23.
lz_secret_delete() {
  local mode mode_names vault secret platform_rg job job_id job_state result="$PROV_DIR/secret-delete.json" rc=0
  mode="$(prov_app_network_mode "$slug" "$env_name")" || saf_die "plan/apps.json has no network mode for $slug in $env_name; its Easy Auth secret can't be found"
  mode_names="$PROV_DIR/names-$mode.json"
  prov_names "$slug" "$mode_names" "$env_name" "$mode"
  vault="$(prov_name "$mode_names" environmentVault)"
  prov_valid_vault "$vault" || saf_die "names.bicep names no environment vault for $slug in $env_name ($mode)"
  secret="$(prov_name "$mode_names" easyAuthSecret)"
  [ "$secret" = "easyauth-$slug" ] || saf_die "names.bicep names another Easy Auth secret than easyauth-$slug"
  prov_secret_meta "$vault" "$PROV_DIR/secret-meta.json" || saf_die "could not read whether $secret is in $vault"
  if [ "$(jq -r '.state' "$PROV_DIR/secret-meta.json")" != present ]; then
    saf_info "  The Easy Auth secret $secret is not in $vault"
    prov_detail easyAuthSecret absent
    return 0
  fi
  platform_rg="$(prov_name "$mode_names" platformResourceGroup)"
  job="$(prov_name "$mode_names" kvsetJob)"
  job_id="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.App/jobs/$job"
  job_state="$(prov_job_state "$job_id")"
  case "$job_state" in
    current) ;;
    missing)
      prov_detail easyAuthSecret job-missing
      prov_wait "$slug in $env_name: the kvset job $job is not deployed (environment.bicep pass 2); the Easy Auth secret $secret and the landing-zone record stay until a run can delete the secret"
      ;;
    *)
      prov_detail easyAuthSecret job-outdated
      prov_wait "$slug in $env_name: the kvset job $job doesn't run the saf-jobs image this core pins yet; the platform pipeline of $env_name deploys it (ADR-0043), and the next provisioning run deletes the Easy Auth secret $secret"
      ;;
  esac
  saf_info "  Deleting the Easy Auth secret $secret from $vault through the kvset job $job (decommissioning)"
  prov_lock "kvset-$job"
  prov_arm_token
  saf_cli provisioning easyauth-delete --job "$job_id" --vault "$vault" --secret-name "$secret" --output "$result" || rc=$?
  unset SAF_ARM_TOKEN
  prov_unlock
  [ "$rc" -eq 0 ] || saf_die "deleting the Easy Auth secret of $slug in $env_name failed (see above); its landing-zone record stays, and the next run tries again"
  jq -e --arg n "$secret" --arg v "$vault" '.secretName == $n and .vault == $v and .secret == "deleted"' "$result" > /dev/null \
    || saf_die "easyauth-delete reported another secret or vault"
  prov_detail easyAuthSecret deleted
}

# lz_outside_assignments <rg>: step b. The principals of the user-assigned identities in the app's
# group (the ownership proof), then each one's role assignments at a scope outside the group: the
# environment's CAE, the app's Easy Auth secret in an environment vault, or the app's own resource
# group of another environment; any other scope is left alone with a warning.
lz_outside_assignments() {
  local rg="$1" principal id scope platform_rg own_prefix
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  own_prefix="${rg%-"$env_name"}-"
  az identity list --resource-group "$rg" --query '[].principalId' --output tsv --only-show-errors > "$PROV_DIR/principals.txt"
  while IFS= read -r principal; do
    prov_valid_guid "$principal" || continue
    az role assignment list --assignee "$principal" --all --query '[].{id: id, scope: scope}' --output json --only-show-errors > "$PROV_DIR/assignments.json"
    while IFS=$'\t' read -r id scope; do
      [ -n "$id" ] || continue
      case "${scope,,}" in
        "/subscriptions/${subscription,,}/resourcegroups/${rg,,}" | "/subscriptions/${subscription,,}/resourcegroups/${rg,,}/"*) continue ;;
      esac
      # The guard: only the scopes the landing zone writes outside its group (ADR-0052 item 2).
      if [[ "${scope,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/${platform_rg,,}/providers/microsoft\.app/managedenvironments/[a-z0-9-]{1,60}$ ]] \
          || [[ "${scope,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/${platform_rg,,}/providers/microsoft\.keyvault/vaults/[a-z0-9-]{3,24}/secrets/easyauth-${slug}$ ]] \
          || [[ "${scope,,}" =~ ^/subscriptions/[0-9a-f-]{36}/resourcegroups/${own_prefix,,}[a-z0-9]{2,8}(/.*)?$ ]]; then
        saf_info "  Removing the role assignment ${id##*/} of an identity of $slug outside its group"
        az role assignment delete --ids "$id" --only-show-errors --output none
      else
        printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: an identity of the app holds a role at a scope the landing zone doesn't write; it is left alone (check it by hand)"
      fi
    done < <(jq -r '.[] | [(.id // "" | tostring), (.scope // "" | tostring)] | @tsv' "$PROV_DIR/assignments.json")
  done < "$PROV_DIR/principals.txt"
}

# lz_nested_cleanup <lz deployment>: step d's nested records, named by the operations of the app's own
# record lz-{slug}-{env}: joinerOnCae-<13> and easyAuthOnSecret-<13> in the environment's platform
# resource group; anything else is left alone. History only: a failure is a warning (ADR-0052).
# TODO(verify) ISO-8: the operations list names the nested deployments with their resource group.
lz_nested_cleanup() {
  local lz_name="$1" platform_rg id name err="$PROV_DIR/lz-nested.err"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  if ! az deployment operation sub list --name "$lz_name" \
      --query "[?properties.targetResource.resourceType=='Microsoft.Resources/deployments'].properties.targetResource.id" \
      --output tsv --only-show-errors > "$PROV_DIR/lz-nested.txt" 2> "$err"; then
    grep -Eq 'DeploymentNotFound|NotFound' "$err" && return 0
    saf_neutralise < "$err" | tail -n 5
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not list the nested deployments of $lz_name; their records stay in the deployment history"
    return 0
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    [[ "${id,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/${platform_rg,,}/providers/microsoft\.resources/deployments/(joineroncae|easyauthonsecret)-[a-z0-9]{13}$ ]] || continue
    name="${id##*/}"
    if az deployment group delete --name "$name" --resource-group "$platform_rg" --only-show-errors --output none 2> "$err"; then
      saf_info "  Removed the nested deployment record $name"
    else
      saf_neutralise < "$err" | tail -n 5
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not delete the nested deployment record $name; it stays in the deployment history"
    fi
  done < "$PROV_DIR/lz-nested.txt"
}

prov_plan_apps "$env_name"
saf_info "Landing zones in $env_name: ${#PROV_APPS[@]} app(s) of the plan."
prov_parallel
for slug in "${PROV_APPS[@]}"; do
  if ! prov_unit_runs "$slug" "$env_name" lz; then
    prov_pass "$slug" "$env_name"
    continue
  fi
  if [ "$(prov_unit_action "$slug" "$env_name" lz)" = delete ]; then
    prov_run_app "$(prov_status_path "$out" "$slug" "$env_name")" "$slug" "$env_name" lz_delete "$slug"
    continue
  fi
  if [ -n "$source_env" ]; then
    prov_app_envs "$slug"
    if [[ " ${PROV_APP_ENVS[*]} " == *" $source_env "* ]] && ! prov_lz_ok "$slug" "$source_env"; then
      prov_skip "$slug" "its landing zone in $source_env is not ok"
      continue
    fi
  fi
  prov_run_app "$(prov_status_path "$out" "$slug" "$env_name")" "$slug" "$env_name" landing_zone "$slug"
done
prov_finish
