#!/usr/bin/env bash
# deploy.sh — stage `deploy`, deployment job `deploy` on the environment platform-<env> (its
# Approval, ADR-0043) of the platform pipeline: AzureCLI@2 with sc-platform-provisioning-<env>.
#   1. The inputs again (pass 2); they must equal the approved plan's (artifact platform_plan).
# The environment, when the plan found it changed (plan.json environmentChanged):
#   2. A new environment (no record, or no platform registry yet): pass 1 (no digest, no job).
#   3. saf-jobs by the digest core's images.json pins, from coreImages.registry into the platform
#      registry (`az acr import --force`: a re-run finds the tag there).
#   4. Pass 2: environment.bicep with that digest (the kvset and dbinit jobs, Platform Job Secret
#      Writer for the Entra provisioning identity on each kvset job, the portal's readers).
#   5. Every job of an enabled mode runs that digest; otherwise the run fails.
# Then, in the portal host only, the portal when the plan found it changed (plan.json portal.changed;
# ADR-0043 decision 10, rule E16, deploy_portal):
#   6. The portal inputs again (`portal-inputs --pass auto`, with the SMTP password secret read again);
#      they must equal the approved plan's.
#   7. A new portal (no record): pass 1 (network, database, CAE, the registry role; no Container App).
#   8. With portal.clientId: saf-portal by the digest images.json pins into the platform registry
#      (`az acr import --force`), pass 2 (the Container App), which must then run that digest and get
#      a ready revision (/readyz) within 15 minutes.
# Artifact platform_deploy: result.json {deployment, passes, digest, jobs, portal: null | {deployment,
# passes, digest}}.
# Env: SAF_ENV_NAME, SAF_HOST_ENVIRONMENT, SAF_SERVICE_CONNECTION.

set -euo pipefail
# shellcheck source=plat-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/plat-lib.sh"

# deploy_portal: steps 6 to 8 (portal host only). Reads the globals of the steps above (names,
# registry, platform_rg); sets portal_result (JSON).
deploy_portal() {
  local approved_portal="$SAF_WS/in/platform_plan/portal-inputs.json" inputs_p deployment_p rg_p app_p target
  local source_registry portal_repo portal_digest state
  local -a passes_p=()
  [ -f "$approved_portal" ] || saf_die "artifact platform_plan has no portal-inputs.json"
  inputs_p="$PLAT_DIR/portal-inputs.json"
  plat_portal_inputs auto "$inputs_p"
  jq -e --slurpfile a "$approved_portal" '. == $a[0]' "$inputs_p" > /dev/null \
    || saf_die "the portal inputs differ from the approved plan (instance.yaml or core changed since the plan stage): run the pipeline again"
  target="$(jq -r 'if .portalImageDigest == "" then 1 else 2 end' "$inputs_p")"
  deployment_p="$(plat_name "$names" portalDeployment)"
  rg_p="$(plat_name "$names" portalResourceGroup)"
  app_p="$(plat_name "$names" portalContainerApp)"

  # 7. Pass 1 for a new portal, and the only pass while portal.clientId isn't set.
  plat_record "$deployment_p" "$PLAT_DIR/portal-record.json"
  if [ "$target" = 1 ]; then
    plat_arm create portal "$inputs_p" "$deployment_p" "$PLAT_DIR/portal-pass1.json"
    passes_p+=(1)
  elif [ ! -f "$PLAT_DIR/portal-record.json" ]; then
    plat_portal_inputs 1 "$PLAT_DIR/portal-inputs-pass1.json"
    plat_arm create portal "$PLAT_DIR/portal-inputs-pass1.json" "$deployment_p" "$PLAT_DIR/portal-pass1.json"
    passes_p+=(1)
  fi

  # 8. saf-portal into the platform registry, pass 2, the Container App on the pinned digest and ready.
  # TODO(verify): PLAT-7, the import by the provisioning identity from coreImages.registry (as PLAT-4).
  portal_digest=""
  if [ "$target" = 2 ]; then
    portal_digest="$(plat_portal_digest)"
    portal_repo="$(jq -er '.images["saf-portal"].repository' "$SAF_IMAGES_JSON")"
    [[ "$portal_repo" =~ ^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$ ]] || saf_die "images.json has no valid saf-portal repository"
    source_registry="$(plat_core_images_registry)"
    saf_info "Importing $source_registry/$portal_repo@$portal_digest into $registry"
    if ! az acr import --name "$registry" --resource-group "$platform_rg" --source "$source_registry/$portal_repo@$portal_digest" \
        --image "$portal_repo:sha256-${portal_digest#sha256:}" --force --only-show-errors > "$PLAT_DIR/portal-import.log" 2>&1; then
      saf_neutralise < "$PLAT_DIR/portal-import.log" | tail -n 20
      saf_die "the import of saf-portal into $registry failed"
    fi
    plat_arm create portal "$inputs_p" "$deployment_p" "$PLAT_DIR/portal-pass2.json"
    passes_p+=(2)
    state="$(plat_app_state "$rg_p" "$app_p" "$portal_repo" "$portal_digest")"
    [ "$state" = current ] || saf_die "the portal Container App $app_p does not run $portal_repo@$portal_digest after the deployment ($state)"
    saf_info "  $app_p runs $portal_repo@$portal_digest; waiting for a ready revision (/readyz)"
    plat_app_ready "$rg_p" "$app_p" 15 \
      || saf_die "the portal's latest revision is not ready after 15 minutes: /readyz needs the Azure DevOps grants of id-{prefix}-portal (the grants phase) and the portal database; the previous revision keeps serving"
    saf_info "  $app_p: the latest revision is ready"
  fi
  portal_result="$(jq -n --arg d "$deployment_p" --arg g "$portal_digest" --argjson p "$(printf '%s\n' "${passes_p[@]}" | jq -s .)" \
    '{deployment: $d, passes: $p, digest: $g}')"
  saf_info "Deployed $deployment_p (pass ${passes_p[*]})."
}

saf_require_env SAF_ENV_NAME SAF_HOST_ENVIRONMENT SAF_SERVICE_CONNECTION
out="$SAF_OUT/platform_deploy"
rm -rf "$out"
mkdir -p "$out"
approved="$SAF_WS/in/platform_plan/inputs.json"
[ -f "$approved" ] || saf_die "artifact platform_plan has no inputs.json"
plan="$SAF_WS/in/platform_plan/plan.json"
[ -f "$plan" ] || saf_die "artifact platform_plan has no plan.json"
env_changed="$(jq -r '.environmentChanged' "$plan")"
portal_changed="$(jq -r '.portal.changed // false' "$plan")"
[[ "$env_changed" =~ ^(true|false)$ && "$portal_changed" =~ ^(true|false)$ ]] \
  || saf_die "plan.json has no valid environmentChanged and portal.changed"

plat_env_values
plat_login_check
saf_bicep_pin_check

# 1. What was approved is what is deployed.
plat_inputs 2 "$PLAT_DIR/inputs.json"
jq -e --slurpfile a "$approved" '. == $a[0]' "$PLAT_DIR/inputs.json" > /dev/null \
  || saf_die "the inputs differ from the approved plan (instance.yaml or core changed since the plan stage): run the pipeline again"
names="$PLAT_DIR/names.json"
plat_names "$PLAT_DIR/inputs.json" "$names"
deployment="$(plat_name "$names" platformDeployment)"
platform_rg="$(plat_name "$names" platformResourceGroup)"
registry="$(plat_name "$names" platformRegistry)"
[[ "$registry" =~ ^[a-z0-9]{5,50}$ ]] || saf_die "platform-names.bicep returned no valid platform registry name"

passes=()
digest=""
jobs_json="$PLAT_DIR/jobs.json"
printf '[]\n' > "$jobs_json"
if [ "$env_changed" = true ]; then
  # 2. Pass 1 for a new environment.
  plat_record "$deployment" "$PLAT_DIR/record.json"
  if [ ! -f "$PLAT_DIR/record.json" ] || ! az resource show --resource-group "$platform_rg" --name "$registry" \
      --resource-type Microsoft.ContainerRegistry/registries --query id --output tsv --only-show-errors > /dev/null 2>&1; then
    plat_inputs 1 "$PLAT_DIR/inputs-pass1.json"
    plat_arm create environment "$PLAT_DIR/inputs-pass1.json" "$deployment" "$PLAT_DIR/pass1.json"
    passes+=(1)
  fi

  # 3. saf-jobs into the platform registry. TODO(verify): PLAT-4, the import by the provisioning
  # identity (Contributor) from coreImages.registry, as for saf-placeholder (azure-post.sh).
  digest="$(plat_jobs_digest)"
  repo="$(jq -er '.images["saf-jobs"].repository' "$SAF_IMAGES_JSON")"
  [[ "$repo" =~ ^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$ ]] || saf_die "images.json has no valid saf-jobs repository"
  source_registry="$(plat_core_images_registry)"
  saf_info "Importing $source_registry/$repo@$digest into $registry"
  if ! az acr import --name "$registry" --resource-group "$platform_rg" --source "$source_registry/$repo@$digest" \
      --image "$repo:sha256-${digest#sha256:}" --force --only-show-errors > "$PLAT_DIR/import.log" 2>&1; then
    saf_neutralise < "$PLAT_DIR/import.log" | tail -n 20
    saf_die "the import of saf-jobs into $registry failed"
  fi

  # 4. Pass 2.
  plat_arm create environment "$PLAT_DIR/inputs.json" "$deployment" "$PLAT_DIR/pass2.json"
  passes+=(2)

  # 5. The jobs run the pinned digest.
  while IFS=$'\t' read -r kvset dbinit; do
    for job in "$kvset" "$dbinit"; do
      state="$(plat_job_state "$platform_rg" "$job" "$repo" "$digest")"
      [ "$state" = current ] || saf_die "the job $job does not run $repo@$digest after the deployment ($state)"
      jq --arg j "$job" '. + [$j]' "$jobs_json" > "$jobs_json.tmp" && mv "$jobs_json.tmp" "$jobs_json"
      saf_info "  $job runs $repo@$digest"
    done
  done < <(jq -r '.outputs.jobs[] | [.kvset, .dbinit] | @tsv' "$names")
  saf_info "Deployed $deployment (pass ${passes[*]})."
else
  saf_info "Platform environment $deployment: up to date in the plan, not deployed."
fi

# 6-8. The portal (portal host only).
portal_result=null
if [ "$portal_changed" = true ]; then
  [ "$env_name" = "$SAF_HOST_ENVIRONMENT" ] || saf_die "the plan has a portal change, but $env_name is not the portal host (template bug)"
  deploy_portal
fi

jq -n --arg d "$deployment" --arg g "$digest" --argjson p "$(printf '%s\n' "${passes[@]}" | jq -s .)" \
  --slurpfile j "$jobs_json" --argjson portal "$portal_result" \
  '{deployment: $d, passes: $p, digest: $g, jobs: $j[0], portal: $portal}' > "$out/result.json"
