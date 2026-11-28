#!/usr/bin/env bash
# ado.sh — stages ado_resources and ado_pipelines, run by AzureCLI@2 with sc-platform-ado (ADO
# automation identity, ADR-0022/ADR-0031). The Azure DevOps token is that identity's Entra token
# for Azure DevOps (resource 499b84ac-1321-427f-aa17-267ca6975798), masked with task.setsecret and
# handed to `platform ado apply` as AZURE_DEVOPS_TOKEN; the job token is never used.
#
# One app at a time (ADR-0046: the identity's Azure DevOps token and the shared objects of the
# project stay sequential; the stages are short). Both stages run only when the plan runs the unit
# `ado` of an app (ADR-0048, output ado), and process exactly those apps; every other app is
# unchanged here (prov_pass).
#   SAF_ADO_PHASE=resources  per app whose landing zone is ok in every environment it runs in
#       (azure_<env> when its lz ran there, else plan_<env>; prov_lz_ok), with the landing-zone
#       outputs from there (prov_entry_dir):
#       platform ado apply --phase resources --lz-outputs <env>=<file>... --templates <core>/templates
#       (the app repository first, ADR-0039: created and seeded with the starter rendered from this
#       core checkout, or the onboarding pull request of a bring-your-own one; then service
#       connections with the delivery identities, environments, checks, repo rights). Artifact
#       `ado`: status/{slug}.json, ado-outputs/{slug}.json (issuer and subject read back from ADO).
#   SAF_ADO_PHASE=pipelines  per app that is `ok` in ado_resources and in every environment it runs
#       in (azure_post_<env> when it processed the app there, else plan_<env>: its release exists
#       everywhere; prov_post_ok): platform ado apply --phase pipelines
#       (\apps\delivery-{slug}, permissions). Artifact `ado_pipelines`. Exit 3 of the CLI (only
#       rows that wait for a person: Azure DevOps refused to authorise the delivery pipeline on the
#       app repository, ADR-0039 H3) makes the app `waiting`, not failed.
# Decommissioning (ADR-0056): a retired app's ado runs as above (`ado apply --phase pipelines` disables
# its delivery pipeline); with action delete, phase resources runs `platform ado remove apply` (the
# pipeline, service connections and environments, each only when it proves to be the app's; a
# service connection only in an environment whose group is gone, --landing-zone-gone, else it waits;
# the app's repository, starter, bring-your-own or unmanaged, renamed {name}-deleted-{requestedOn}
# (-i{incarnation} above 0, -2 … -9 while the name is taken) so its name is free again, ADR-0061, and
# a starter with decommission.repository delete renamed, then deleted; a refused rename only reports),
# status
# done delete-ado, and phase pipelines has nothing left to do (status ok).
# The organization is this run's (System.CollectionUri); the CLI checks it against instance.yaml.
# Env: SAF_ADO_PHASE, SAF_SERVICE_CONNECTION (template constants); SYSTEM_COLLECTIONURI (predefined).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ADO_PHASE SAF_SERVICE_CONNECTION
case "$SAF_ADO_PHASE" in
  resources) artifact=ado ;;
  pipelines) artifact=ado_pipelines ;;
  *) saf_die "SAF_ADO_PHASE must be resources or pipelines" ;;
esac
[ "$SAF_SERVICE_CONNECTION" = sc-platform-ado ] || saf_die "SAF_SERVICE_CONNECTION is not sc-platform-ado (template bug)"
PROV_STAGE="ado_$SAF_ADO_PHASE"
out="$SAF_OUT/$artifact"
rm -rf "$out"
mkdir -p "$out/status" "$out/ado-outputs"
prov_units_check
org_url="$(prov_org_url)"

# ado_remove <slug>: the delete phase (ADR-0056); with the landing-zone outputs of every environment
# that still has one (the delivery identities prove the service connections are the app's). A service
# connection is deleted only in an environment whose resource group is gone (its lz delete finished in
# azure_<env> of this run: --landing-zone-gone); elsewhere it waits, because Azure DevOps refuses to
# delete it while the delivery identity's federated credential exists (sandbox run 3421, ADR-0056
# amendment 2026-11-12). After a success, detail connection-<env> gone for those environments:
# record_<env> deletes the landing zone's record only then.
ado_remove() {
  local slug="$1" e f rc=0
  local -a args gone=()
  app_file="$(prov_app_file "$slug")"
  if [ "$SAF_ADO_PHASE" = pipelines ]; then
    saf_info "  $slug: its Azure DevOps objects were removed in ado_resources (decommissioning)"
    prov_detail ado removed
    return 0
  fi
  args=(ado remove apply --instance "$SAF_INSTANCE" --app "$app_file" --org-url "$org_url")
  for e in "${PROV_APP_ENVS[@]}"; do
    f="$(prov_entry_dir "$slug" "$e")/lz-outputs/$slug.$e.json"
    if [ -f "$f" ]; then args+=(--lz-outputs "$e=$f"); fi
    if [ "$(prov_unit_action "$slug" "$e" lz)" = delete ] && prov_status_done "$(prov_status_path "$SAF_IN/azure_$e" "$slug" "$e")" delete-lz; then
      args+=(--landing-zone-gone "$e")
      gone+=("$e")
    fi
  done
  prov_ado_token
  saf_cli "${args[@]}" || rc=$?
  [ "$rc" -eq 0 ] || saf_die "removing the Azure DevOps objects of $slug failed or was refused (see the rows above); the next run tries again"
  for e in "${gone[@]}"; do prov_detail "connection-$e" gone; done
  prov_detail ado removed
  prov_done delete-ado
}

ado_apply() {
  local slug="$1" e rc
  local -a args
  app_file="$(prov_app_file "$slug")"
  args=(ado apply --instance "$SAF_INSTANCE" --app "$app_file" --phase "$SAF_ADO_PHASE" --org-url "$org_url"
    --output "$out/ado-outputs/$slug.json")
  if [ "$SAF_ADO_PHASE" = resources ]; then
    for e in "${PROV_APP_ENVS[@]}"; do
      args+=(--lz-outputs "$e=$(prov_entry_dir "$slug" "$e")/lz-outputs/$slug.$e.json")
    done
    args+=(--templates "$SAF_CORE/templates")
  fi
  prov_ado_token
  rc=0
  saf_cli "${args[@]}" || rc=$?
  if [ "$rc" -eq 3 ]; then
    prov_detail ado waiting
    prov_wait "$slug: a project administrator must authorise its delivery pipeline on its repository (ADR-0039 H3, see the log of $PROV_STAGE)"
  fi
  [ "$rc" -eq 0 ] || return "$rc"
  prov_detail ado "$SAF_ADO_PHASE"
}

prov_plan_apps ""
saf_info "Azure DevOps $SAF_ADO_PHASE: ${#PROV_APPS[@]} valid app(s)."
for slug in "${PROV_APPS[@]}"; do
  prov_app_envs "$slug"
  if ! prov_unit_runs "$slug" "${PROV_APP_ENVS[0]}" ado; then
    prov_pass "$slug" "every environment"
    continue
  fi
  blocked=""
  if [ "$SAF_ADO_PHASE" = pipelines ] && ! prov_status_ok "$(prov_status_path "$SAF_IN/ado" "$slug")"; then
    blocked="its Azure DevOps resources are not ok"
  fi
  for e in "${PROV_APP_ENVS[@]}"; do
    [ -z "$blocked" ] || break
    if [ "$SAF_ADO_PHASE" = resources ]; then
      prov_lz_ok "$slug" "$e" || blocked="its landing zone in $e is not ok"
    else
      prov_post_ok "$slug" "$e" || blocked="its release in $e is not ok"
    fi
  done
  if [ -n "$blocked" ]; then
    prov_skip "$slug" "$blocked"
    continue
  fi
  if [ "$(prov_unit_action "$slug" "${PROV_APP_ENVS[0]}" ado)" = delete ]; then
    prov_run_app "$(prov_status_path "$out" "$slug")" "$slug" "" ado_remove "$slug"
    continue
  fi
  prov_run_app "$(prov_status_path "$out" "$slug")" "$slug" "" ado_apply "$slug"
done
prov_finish
