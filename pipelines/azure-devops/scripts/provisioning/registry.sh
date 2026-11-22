#!/usr/bin/env bash
# registry.sh — stage registry_<env> of a build environment (no promoteFrom), job `purge`, run by
# AzureCLI@2 with sc-platform-provisioning-<env> (Azure provisioning identity of the environment,
# ADR-0031). The registry image purge (ADR-0059). The stage runs only when the plan purges an app here
# (output registry_<env> of plan.decide, units/registry.json of `platform provisioning plan-units
# --registry`): the run is inside the maintenance window, maintenance.registryRetention.mode isn't
# off, and the app's last purge is at least 7 days old (at most 100 apps per environment and run).
#
# Per app the plan purges in <env>, up to PROV_PARALLEL_MAX at the same time:
#   1. the app resource group by naming (`platform provisioning plan-names --apps`; the plan must name
#      the same group) and the registry the landing-zone record names, which must be in that group
#      (az acr show --resource-group): never another app's registry or a platform registry (ADR-0052);
#   2. what the app's Container App runs in <env> right now (az resource show; none when it doesn't
#      exist), protected together with what the plan read in every environment of the app;
#   3. the manifests of the app's repository (naming.bicep registryRepository: the slug) with az acr
#      manifest list-metadata; a repository without an image yet: nothing to purge;
#   4. `platform provisioning registry-purge` decides (pure): it keeps what runs anywhere, the newest
#      maintenance.registryRetention.keepLatest builds, what is younger than its days, untagged and
#      locked manifests and ones with a tag delivery doesn't write; the rest, oldest first, at most
#      200 per run;
#   5. mode purge: az acr manifest delete of each digest it returned (by digest: the manifest and its
#      tags); mode dryRun: nothing is deleted, the list is in the log and the counts in the status;
#   6. only when every delete worked: the tag saf-registry-purge = "<YYYYMMDD> <mode>" (the plan's
#      record) on the app resource group, so the next purge of the app is due 7 days later.
# A failed app keeps its old tag (the next window tries again) and fails this stage at its end, after
# every other app. Nothing of any app's provisioning depends on this stage: it runs after
# azure_post_<env>, and report and record_<env> only wait for it (report lists its statuses).
# A landing-zone deployment rewrites the group's tags and drops saf-registry-purge: the app is then
# purged again in the next window (idempotent).
# Status per app: registry_<env>/status/<slug>.<env>.json, detail purge <mode>, deleted (or wouldDelete)
# <n>, kept <n>, images <n>.
# TODO(verify) REG-3: az acr manifest list-metadata and delete on a registry with the repository-
# permissions mode and a domain name label (login server {name}-{hash}.azurecr.io), the output's
# field names, and the error text of a repository that doesn't exist.
# Env: SAF_ENV_NAME, SAF_PROMOTE_FROM (empty), SAF_SERVICE_CONNECTION (template constants).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE="registry_$SAF_ENV_NAME"
out="$SAF_OUT/$PROV_STAGE"
mkdir -p "$out/status"
registry_plan="$SAF_IN/units/registry.json"

prov_environment
[ -z "$env_promote_from" ] || saf_die "the registry purge runs only in a build environment; $env_name promotes from $env_promote_from (ADR-0059)"
prov_units_check
[ -f "$registry_plan" ] || saf_die "artifact units has no registry.json (stage plan failed; see its job decide)"
jq -e '.schemaVersion == 1 and (.environments | type == "object") and (.retention | type == "object")' "$registry_plan" > /dev/null \
  || saf_die "units/registry.json is not a plan of platform provisioning plan-units --registry"
mode="$(jq -r '.retention.mode // ""' "$registry_plan")"
case "$mode" in
  purge | dryRun) ;;
  *) saf_die "the plan's registry retention is not purge or dryRun; nothing to purge" ;;
esac

# registry_runs <slug>: the plan purges the app's registry in env_name in this run.
registry_runs() {
  [ "$(jq -r --arg s "$1" --arg e "$env_name" '.environments[$e].apps[$s].run == true' "$registry_plan")" = true ]
}

# purge_app <slug>: steps 1 to 6 above for one app.
purge_app() {
  local slug="$1" rg registry repo container_app record digest n kept err="$PROV_DIR/purge.err" deleted=0 failed=0
  # 1. The group by naming (plan-names), never the plan's value alone (ADR-0052): both must agree.
  rg="$(jq -r --arg s "$slug" '.appResourceGroups[$s] // ""' "$app_names")"
  [[ "$rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "naming gives no valid resource group for $slug in $env_name"
  [ "$(jq -r --arg s "$slug" --arg e "$env_name" '.environments[$e].apps[$s].resourceGroup // ""' "$registry_plan")" = "$rg" ] \
    || saf_die "the plan names another resource group for $slug in $env_name than naming ($rg); nothing is purged"
  registry="$(jq -r --arg s "$slug" --arg e "$env_name" '.environments[$e].apps[$s].registry // ""' "$registry_plan")"
  [[ "$registry" =~ ^[a-z0-9]{5,50}$ ]] || saf_die "the plan names no valid registry for $slug in $env_name"
  repo="$(jq -r --arg s "$slug" '.registryRepositories[$s] // ""' "$app_names")"
  [ "$repo" = "$slug" ] || saf_die "naming gives no repository for $slug"
  container_app="$(jq -r --arg s "$slug" '.containerApps[$s] // ""' "$app_names")"
  [[ "$container_app" =~ ^ca-[a-z0-9-]{3,28}$ ]] || saf_die "naming gives no Container App for $slug"
  if ! az acr show --name "$registry" --resource-group "$rg" --query id --output tsv --only-show-errors > "$PROV_DIR/registry-id.txt" 2> "$err"; then
    saf_neutralise < "$err" | tail -n 5
    saf_die "the registry $registry is not in $rg; nothing is purged"
  fi
  [ "$(tr '[:upper:]' '[:lower:]' < "$PROV_DIR/registry-id.txt")" = "/subscriptions/${subscription,,}/resourcegroups/$rg/providers/microsoft.containerregistry/registries/$registry" ] \
    || saf_die "the registry $registry is not the app's own in $rg; nothing is purged"

  # 2. What the app runs here now (the plan read every environment of the app a few minutes ago).
  if az resource show --resource-group "$rg" --name "$container_app" --resource-type Microsoft.App/containerApps \
      --query '[properties.template.containers[].image, properties.template.initContainers[].image][]' \
      --output json --only-show-errors > "$PROV_DIR/live.json" 2> "$err"; then
    jq -e 'type == "array" or . == null' "$PROV_DIR/live.json" > /dev/null || saf_die "could not read the images $container_app runs"
  elif grep -Eq 'ResourceNotFound|was not found' "$err"; then
    printf '[]\n' > "$PROV_DIR/live.json"
  else
    saf_neutralise < "$err" | tail -n 5
    saf_die "could not read what $slug runs in $env_name now; nothing is purged"
  fi

  # 3. The manifests of the app's repository.
  if ! az acr manifest list-metadata --registry "$registry" --name "$repo" --output json --only-show-errors > "$PROV_DIR/manifests.json" 2> "$err"; then
    if grep -Eqi 'NAME_UNKNOWN|repository .*not found' "$err"; then
      saf_info "  $slug in $env_name: the repository $repo has no image yet; nothing to purge"
      printf '[]\n' > "$PROV_DIR/manifests.json"
    else
      saf_neutralise < "$err" | tail -n 5
      saf_die "could not list the images of $repo in $registry"
    fi
  fi

  # 4. The decision (pure, core code).
  saf_cli provisioning registry-purge --plan "$registry_plan" --env "$env_name" --slug "$slug" \
    --manifests "$PROV_DIR/manifests.json" --live "$PROV_DIR/live.json" --output "$PROV_DIR/decision.json" | saf_neutralise
  n="$(jq '.delete | length' "$PROV_DIR/decision.json")"
  kept="$(jq '[.kept[]] | add // 0' "$PROV_DIR/decision.json")"
  [[ "$n" =~ ^[0-9]+$ && "$kept" =~ ^[0-9]+$ ]] || saf_die "the purge decision for $slug has no counts"
  prov_detail purge "$mode"
  prov_detail images "$(jq '.total' "$PROV_DIR/decision.json" | tr -cd '0-9')"
  prov_detail kept "$kept"

  # 5. The deletes, by digest (mode purge only).
  if [ "$mode" = dryRun ]; then
    prov_detail wouldDelete "$n"
  else
    while IFS= read -r digest; do
      [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "the purge decision names an invalid digest"
      if az acr manifest delete --registry "$registry" --name "$repo@$digest" --yes --only-show-errors --output none 2> "$err"; then
        deleted=$((deleted + 1))
      else
        saf_neutralise < "$err" | tail -n 3
        failed=$((failed + 1))
      fi
    done < <(jq -r '.delete[].digest' "$PROV_DIR/decision.json")
    prov_detail deleted "$deleted"
    saf_info "  $slug in $env_name: deleted $deleted of $n old image(s) from $registry"
    [ "$failed" -eq 0 ] || saf_die "$failed of $n old image(s) could not be deleted from $registry; the next window tries again"
  fi

  # 6. The purge's record on the app's group (by naming, checked above).
  record="$(jq -r --arg s "$slug" --arg e "$env_name" '.environments[$e].apps[$s].record // ""' "$registry_plan")"
  [[ "$record" =~ ^[0-9]{8}\ (purge|dryRun)$ ]] || saf_die "the plan has no record for $slug in $env_name"
  az tag update --resource-id "/subscriptions/$subscription/resourceGroups/$rg" --operation merge \
    --tags "saf-registry-purge=$record" --only-show-errors --output none
}

prov_plan_apps "$env_name"
# The app resource groups, Container Apps and repositories by naming, once for every app (names.ts,
# checked against naming.bicep).
app_names="$SAF_WORK/registry-names.json"
saf_cli provisioning plan-names --instance "$SAF_INSTANCE" --env "$env_name" --apps "$SAF_APPS_JSON" --output "$app_names" > /dev/null
saf_info "Registry purge in $env_name ($mode, older than $(jq -r '.retention.days' "$registry_plan" | tr -cd '0-9') days, newest $(jq -r '.retention.keepLatest' "$registry_plan" | tr -cd '0-9') kept): ${#PROV_APPS[@]} app(s) of the plan."
prov_parallel
for slug in "${PROV_APPS[@]}"; do
  if ! registry_runs "$slug"; then
    prov_pass "$slug" "$env_name"
    continue
  fi
  prov_run_app "$(prov_status_path "$out" "$slug" "$env_name")" "$slug" "$env_name" purge_app "$slug"
done
prov_finish
