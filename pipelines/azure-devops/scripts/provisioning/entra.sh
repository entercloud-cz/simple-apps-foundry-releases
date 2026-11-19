#!/usr/bin/env bash
# entra.sh — stage entra, job `registrations`, run by AzureCLI@2 with sc-platform-entra (Entra
# provisioning identity, ADR-0023, ADR-0033). The stage runs only when an Entra plan planned a
# change; with approvals.entraChanges separate also only after the Approval check on
# sc-platform-entra, with pullRequest (the default) without waiting: the reviewed pull request was
# the approval (ADR-0051).
#
# The Entra plan of an app x environment is in units/entra (compared in stage plan, job decide) or, when
# its landing zone ran in this run too, in the artifact entra_plan (ADR-0050): prov_entra_dir; below,
# "entra_plan" means that plan. A status file in the other place is refused.
# Per app x environment that entra_plan planned (status ok, detail entra deploy and/or secret write
# or rotate):
#   a. names.bicep (bicep snapshot): the environment's records group rg-{prefix}-entra-{env}, the
#      instance's rg-{prefix}-entra (ADR-0063), entra-{slug}-{env}, easyauth-{slug} and the
#      application's uniqueName {prefix}-{slug}-{env}[--i{incarnation}] (app.yaml incarnation, ADR-0061);
#   b0. removed role assignments (entra deploy with entra_plan/entra-removals/{slug}.{env}.json,
#      ADR-0033 amended 2026-11-11): prov_graph_token (Microsoft Graph token, masked, env only),
#      then `platform provisioning entra-reconcile`: it resolves the app's own registration by its
#      uniqueName (names.bicep), lists its service principal's assignments and deletes only the
#      planned ones (the previous deployment declared them, app.yaml no longer lists them; users
#      and groups on this service principal only). Before the deployment: a failure fails the app
#      and keeps the record, so the next run plans the same removal. Detail removedAssignments <n>;
#   b. registration (entra deploy): the inputs entra_plan rendered
#      (entra_plan/entra-inputs/{slug}.{env}.json), which must name this instance, app and
#      environment; `az deployment group create` of entra-{slug}-{env} through
#      app-registration.bicepparam in the group the plan named (detail entraGroup, ADR-0063: the
#      environment's records group rg-{prefix}-entra-{env}, or rg-{prefix}-entra while that doesn't
#      exist yet; both by names.bicep) (Graph Bicep: application, service principal, app roles, role
#      assignments, sign-in consent; prov_arm retries Graph's intermittent errors); its client ID
#      -> entra-outputs/{slug}.{env}.json (the release's authentication.clientId). A retired app
#      role takes two deployments: first entra-inputs/{slug}.{env}.disable.json (the role with
#      isEnabled false, when the record still has it enabled), then the final inputs without it
#      (Graph removes only a disabled role); detail removedRoles <n>. If the second fails, the
#      record holds the disabled role and the next run removes it;
#   b2. the record moved (ADR-0063): after a deployment into the environment's records group, the
#      registration's old record of the same name in rg-{prefix}-entra (deployed before ADR-0063) is
#      deleted (retire_instance_record): a record only, never the registration; detail entraRecord
#      moved. A failure is a warning: the plan reads the newer record;
#   c. Easy Auth secret (secret write or rotate, ADR-0035, ADR-0041): the plan entra_plan wrote
#      (entra_plan/secret-plan/{slug}.{env}.json: vault, kvset job, secret name, action new for an
#      absent secret or rotate for a present one, the vault version's created and expires and the
#      version the app runs with (loaded); checked again), the client ID from step b, or from
#      entra_plan's entra-outputs when the registration is up to date; prov_secret_tokens (Microsoft
#      Graph and ARM tokens, masked, env only), then `platform provisioning easyauth-secret --mode
#      new|rotate`: a new password on the app registration (rotate: the platform's passwords older
#      than the current one removed first, only when the app runs with the current version),
#      handed to the kvset job of the app's CAE as a job secret, written by the job into the
#      environment vault, the job secret removed again. The value lives only in that process: never
#      in this script, a file or the log. Detail secret written | rotated as soon as the vault holds
#      the new password, also when a later part of the step failed. A failure fails this app only;
#      its registration (step b) stays, a new app's release stays `waiting` until a run writes the
#      secret, and a rotated app keeps its current password, which is still valid.
#   d. the follow-up of a case A network mode change (detail secretOld remove, ADR-0060 decision 8):
#      remove_old_secret below, `easyauth-secret --mode remove-old` through the previous variant's
#      kvset job, only for the plan's followUp.
# One app at a time (ADR-0046): an Easy Auth write adds and removes a secret on the kvset job of the
# app's CAE, one job for every app of that CAE, and Graph throttles a burst of application writes;
# the stage only runs for planned changes, so it is short.
# Decommissioning (ADR-0056), detail entra delete in the Entra plan: unregister below (the registration
# by its uniqueName through `platform provisioning entra-delete`, then its record entra-{slug}-{env} in
# the environment's records group and in rg-{prefix}-entra (a record deployed before ADR-0063), all by
# names.bicep); status done delete-entra. The deleted application stays in
# Entra's recycle bin for 30 days with its uniqueName: it isn't purged (that needs
# Application.ReadWrite.All; sandbox run 3589 got 403), and a new app with the slug has a higher
# incarnation, so another uniqueName (ADR-0061). The Easy Auth secret easyauth-{slug} goes later, with
# the landing zone (azure_<env>, lz_secret_delete, ADR-0061).
# Not here: restarting an app whose
# revisions predate the vault's version (azure_post_<env>, decided from state, with the Azure
# provisioning identity: this identity has no Container Apps role).
# Artifact entra: status/{slug}.{env}.json, entra-outputs/{slug}.{env}.json (registrations deployed
# in this run).
# Env: SAF_ENV_NAME (= hostEnvironment), SAF_SERVICE_CONNECTION.

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE=entra
out="$SAF_OUT/$PROV_STAGE"
rm -rf "$out"
mkdir -p "$out/status" "$out/entra-outputs"

saf_bicep_pin_check
prov_host_environment sc-platform-entra
prov_units_check
# The Entra plan of the app being processed (set by provision, prov_entra_dir).
plan=""

# Step b0: the role assignments entra_plan planned to remove, before the registration is deployed.
remove_assignments() {
  local app_env="$1" removals unique_name result rc=0
  removals="$plan/entra-removals/$slug.$app_env.json"
  [ -f "$removals" ] || return 0
  jq -e --arg p "$prefix" --arg s "$slug" --arg e "$app_env" \
    '.prefix == $p and .slug == $s and .environmentName == $e' "$removals" > /dev/null \
    || saf_die "the Entra removals of $slug in $app_env name another instance, app or environment"
  [ "$(jq '.assignments | length' "$removals")" -gt 0 ] || return 0
  unique_name="$(prov_name "$names" entraApplicationUniqueName)"
  result="$PROV_DIR/reconcile-result.json"
  saf_info "  Removing the role assignments app.yaml no longer lists from $unique_name"
  prov_graph_token
  saf_cli provisioning entra-reconcile --removals "$removals" --inputs "$plan/entra-inputs/$slug.$app_env.json" --unique-name "$unique_name" --output "$result" || rc=$?
  unset SAF_GRAPH_TOKEN
  [ "$rc" -eq 0 ] || saf_die "removing the role assignments of $slug in $app_env failed (see above); its registration was not deployed, and the next run tries again (core runbook docs/runbooks/review-app-requests.md)"
  prov_detail removedAssignments "$(jq '.removed | length' "$result")"
}

# Step b: the registration of the current app in <env>, its record in the group the plan named
# (<environment | instance>, the Entra plan's detail entraGroup; ADR-0063), by names.bicep.
register() {
  local app_env="$1" target="$2" entra_rg entra_name inputs first removals client_id f
  case "$target" in
    environment) entra_rg="$(prov_name "$names" entraEnvironmentResourceGroup)" ;;
    instance) entra_rg="$(prov_name "$names" entraResourceGroup)" ;;
    *) saf_die "the Entra plan of $slug in $app_env names no resource group for the registration's record (detail entraGroup)" ;;
  esac
  entra_name="$(prov_name "$names" entraDeployment)"
  inputs="$plan/entra-inputs/$slug.$app_env.json"
  first="$plan/entra-inputs/$slug.$app_env.disable.json"
  removals="$plan/entra-removals/$slug.$app_env.json"
  [ -f "$inputs" ] || saf_die "artifact entra_plan has no Entra inputs for $slug in $app_env"
  for f in "$inputs" "$first"; do
    [ -f "$f" ] || continue
    jq -e --arg p "$prefix" --arg s "$slug" --arg e "$app_env" \
      '.prefix == $p and .slug == $s and .environmentName == $e' "$f" > /dev/null \
      || saf_die "the Entra inputs of $slug in $app_env name another instance, app or environment"
  done

  # A retired app role that is still enabled: the first of its two deployments disables it.
  if [ -f "$first" ]; then
    saf_info "  Disabling the app roles app.yaml no longer lists (Graph removes only a disabled role)"
    prov_arm create entra "$first" "$entra_name" "$entra_rg" "$PROV_DIR/deployment-disable.json"
  fi
  prov_arm create entra "$inputs" "$entra_name" "$entra_rg" "$PROV_DIR/deployment.json"
  if [ "$target" = environment ]; then retire_instance_record "$app_env"; fi
  if [ -f "$removals" ] && [ "$(jq '.roles | length' "$removals")" -gt 0 ]; then
    prov_detail removedRoles "$(jq '.roles | length' "$removals")"
  fi
  client_id="$(jq -r '.properties.outputs.clientId.value // ""' "$PROV_DIR/deployment.json")"
  prov_valid_guid "$client_id" || saf_die "the deployment $entra_name returned no valid clientId"
  jq -n --arg c "$client_id" '{clientId: $c}' > "$out/entra-outputs/$slug.$app_env.json"
  prov_detail entra deployed
}

# Step b2 (ADR-0063): after the registration's deployment into its environment's records group
# succeeded, its old record in the instance's rg-{prefix}-entra (deployed before ADR-0063) is deleted:
# the app's own name in the group names.bicep names. A record only: deleting it never touches the
# registration, and the plan reads the newer record. A failure is a warning, not the app's: the next
# deployment tries again, or a person deletes it (core runbook docs/runbooks/deployment-history.md).
retire_instance_record() {
  local app_env="$1" instance_rg entra_name err="$PROV_DIR/retire.err"
  instance_rg="$(prov_name "$names" entraResourceGroup)"
  entra_name="$(prov_name "$names" entraDeployment)"
  az deployment group show --name "$entra_name" --resource-group "$instance_rg" --query name --output tsv --only-show-errors > /dev/null 2>&1 || return 0
  if az deployment group delete --name "$entra_name" --resource-group "$instance_rg" --only-show-errors --output none 2> "$err"; then
    saf_info "  The record $entra_name moved to $(prov_name "$names" entraEnvironmentResourceGroup); its old copy in $instance_rg was deleted"
    prov_detail entraRecord moved
  else
    saf_neutralise < "$err" | tail -n 5
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: could not delete the old record $entra_name in $instance_rg (its registration's record is in $(prov_name "$names" entraEnvironmentResourceGroup) now); the next deployment tries again (core runbook docs/runbooks/deployment-history.md)"
  fi
}

# Step c: the Easy Auth secret of the current app in <env> for the registration <client ID>.
write_secret() {
  local app_env="$1" client_id="$2" secret_name display result mode job_state rc=0
  secret_name="$(prov_name "$names" easyAuthSecret)"
  prov_secret_entry "$plan/secret-plan/$slug.$app_env.json" "$app_env"
  mode="$(jq -r '.action // ""' "$plan/secret-plan/$slug.$app_env.json")"
  case "$secret_state/$mode" in
    absent/new|present/rotate) ;;
    *) saf_die "the Easy Auth secret plan of $slug in $app_env has no valid action for its state" ;;
  esac
  [ "$secret_job_ready" = true ] || saf_die "the Easy Auth secret plan of $slug in $app_env names a kvset job that doesn't exist"
  # Again just before the start (rule P23): the job runs this core's saf-jobs image. After a core
  # upgrade the platform pipeline of the environment deploys it (ADR-0043); until then the app
  # waits, and the next run writes the secret; with at most 14 days left, it fails instead. The state
  # is assigned first: a read error fails the app (errexit doesn't apply inside a test). Platform Job
  # Secret Writer includes jobs/read.
  job_state="$(prov_job_state "$secret_job")"
  if [ "$job_state" != current ]; then
    prov_detail secret "job-$job_state"
    if [ "$mode" = rotate ] && prov_secret_urgent; then
      saf_die "$slug in $app_env: its Easy Auth secret expires within 14 days, and the kvset job ${secret_job##*/} can't rotate it ($job_state): run and approve the platform pipeline of $app_env now (ADR-0043), then provisioning; sign-in stops when the secret expires"
    fi
    prov_wait "$slug in $app_env: the kvset job ${secret_job##*/} is $job_state; the platform pipeline of $app_env deploys it on the saf-jobs image this core pins (ADR-0043), and the next provisioning run writes the Easy Auth secret"
  fi
  jq -e --arg n "$secret_name" '.secretName == $n' "$plan/secret-plan/$slug.$app_env.json" > /dev/null \
    || saf_die "the Easy Auth secret plan of $slug in $app_env names another secret"
  # The credential's name on the app registration: environment and run, nothing secret. A rotation
  # removes only passwords named like this (easyauth-<env>[-run-<id>]).
  display="easyauth-$app_env"
  if [[ "${BUILD_BUILDID:-}" =~ ^[0-9]{1,12}$ ]]; then display+="-run-$BUILD_BUILDID"; fi
  result="$PROV_DIR/secret-result.json"
  if [ "$mode" = rotate ]; then
    saf_info "  Rotating $secret_name in $secret_vault through the kvset job"
  else
    saf_info "  Writing $secret_name to $secret_vault through the kvset job"
  fi
  prov_secret_tokens
  saf_cli provisioning easyauth-secret --mode "$mode" --client-id "$client_id" --job "$secret_job" \
    --secret-name "$secret_name" --vault "$secret_vault" --display-name "$display" \
    --current-created "$secret_created" --current-expires "$secret_expires" --loaded-created "$secret_loaded" \
    --output "$result" || rc=$?
  unset SAF_GRAPH_TOKEN SAF_ARM_TOKEN
  # The CLI logged the job execution, the credential's keyId and expiry, and the predecessors. It
  # writes the result once the vault holds the new password, even when a later part failed.
  if [ -f "$result" ] && jq -e --arg n "$secret_name" --arg v "$secret_vault" --arg m "$mode" \
      '.secretName == $n and .vault == $v and .mode == $m and .written == true' "$result" > /dev/null; then
    if [ "$mode" = rotate ]; then prov_detail secret rotated; else prov_detail secret written; fi
  elif [ "$rc" -eq 0 ]; then
    saf_die "the Easy Auth secret step reported another secret, vault or mode"
  fi
  [ "$rc" -eq 0 ] || saf_die "the Easy Auth secret step of $slug in $app_env failed (see above; core runbook docs/runbooks/easyauth-rotation.md)"
}

# Step d (ADR-0060 decision 8): the follow-up of a case A network mode change for the registration
# <client ID>: the plan entra_plan wrote (secret-plan/{slug}.{env}.remove-old.json), checked again: the
# secret is the app's by naming, the job is the kvset job of the OTHER mode's CAE by naming (the old
# variant's, never the app's current one: its PATCH-free delete start names only easyauth-{slug}), the
# vaults have a vault name's shape (the CLI compares the job's SAF_VAULT_URI with --vault). Then
# `platform provisioning easyauth-secret --mode remove-old`: only when --app-vault (where the app runs
# now, from the plan) is another vault, the old job soft-deletes easyauth-{slug} in its vault and the
# predecessors of the current password go (rotate's guards). Detail secretOld deleted | kept (the CLI
# changed nothing: the next run tries again).
remove_old_secret() {
  local app_env="$1" client_id="$2" file secret_name net_mode other_mode other_names job_prefix old_job old_vault app_vault display result rc=0
  file="$plan/secret-plan/$slug.$app_env.remove-old.json"
  [ -f "$file" ] || saf_die "the Entra plan of $slug in $app_env removes the old secret, but has no remove-old plan"
  secret_name="$(prov_name "$names" easyAuthSecret)"
  jq -e --arg n "$secret_name" '.secretName == $n' "$file" > /dev/null || saf_die "the remove-old plan of $slug in $app_env names another secret"
  net_mode="$(prov_app_network_mode "$slug" "$app_env")"
  if [ "$net_mode" = externalOnly ]; then other_mode=externalHybrid; else other_mode=externalOnly; fi
  other_names="$PROV_DIR/names-$other_mode.json"
  # Cell 01's kvset job of the previous variant: every network mode has a cell 01 (ADR-0053), and any of
  # its cells' jobs reaches that variant's vault; the plan names the same job (plan-facts elsewhere).
  prov_names "$slug" "$other_names" "$app_env" "$other_mode" "" "" 01
  saf_cli pipeline instance-env --instance "$SAF_INSTANCE" --env "$app_env" --output "$PROV_DIR/env-old-$app_env.json"
  job_prefix="/subscriptions/$(jq -r '.subscriptionId // ""' "$PROV_DIR/env-old-$app_env.json")/resourceGroups/$(prov_name "$other_names" platformResourceGroup)/providers/Microsoft.App/jobs/"
  old_job="$(jq -r '.job // ""' "$file")"
  # The guard: exactly the old variant's kvset job by naming, in the platform resource group of the app's environment.
  [ "$old_job" = "$job_prefix$(prov_name "$other_names" kvsetJob)" ] \
    || saf_die "the remove-old plan of $slug in $app_env names another job than the kvset job of the previous variant's CAE"
  old_vault="$(jq -r '.vault // ""' "$file")"
  app_vault="$(jq -r '.appVault // "none"' "$file")"
  prov_valid_vault "$old_vault" || saf_die "the remove-old plan of $slug in $app_env has no valid vault"
  [ "$app_vault" = none ] || prov_valid_vault "$app_vault" || saf_die "the remove-old plan of $slug in $app_env has no valid appVault"
  display="easyauth-$app_env"
  if [[ "${BUILD_BUILDID:-}" =~ ^[0-9]{1,12}$ ]]; then display+="-run-$BUILD_BUILDID"; fi
  result="$PROV_DIR/remove-old-result.json"
  saf_info "  Removing $secret_name from $old_vault (the previous network variant) and the passwords before the current one"
  prov_secret_tokens
  saf_cli provisioning easyauth-secret --mode remove-old --client-id "$client_id" --job "$old_job" \
    --secret-name "$secret_name" --vault "$old_vault" --display-name "$display" \
    --current-created "$(jq -r '.created // "none" | tostring' "$file")" --current-expires "$(jq -r '.expires // "none" | tostring' "$file")" \
    --loaded-created "$(jq -r '.loaded // "none" | tostring' "$file")" --app-vault "$app_vault" --output "$result" || rc=$?
  unset SAF_GRAPH_TOKEN SAF_ARM_TOKEN
  [ "$rc" -eq 0 ] || saf_die "removing the previous variant's Easy Auth secret of $slug in $app_env failed (see above); the next run tries again"
  if jq -e '.oldSecret == "deleted"' "$result" > /dev/null 2>&1; then prov_detail secretOld deleted; else prov_detail secretOld kept; fi
}

# unregister <env>: the registration of the current app (ADR-0056) and then its records; gone = done. A
# failed delete keeps the record, so the plan doesn't read the app deleted and the next run tries again.
# The uniqueName is the current app's own (its incarnation, ADR-0061): never an earlier app's with the slug.
# The records: in the environment's records group and in rg-{prefix}-entra (one deployed before ADR-0063),
# both groups and the name by names.bicep.
unregister() {
  local app_env="$1" entra_rg entra_name unique_name expected incarnation result rc=0
  entra_name="$(prov_name "$names" entraDeployment)"
  unique_name="$(prov_name "$names" entraApplicationUniqueName)"
  incarnation="$(prov_app_incarnation "$slug")" || saf_die "plan/apps.json has no valid incarnation for $slug"
  [ -n "$incarnation" ] || saf_die "plan/apps.json has no incarnation for $slug"
  expected="$prefix-$slug-$app_env"
  [ "$incarnation" = 0 ] || expected+="--i$incarnation"
  [ "$unique_name" = "$expected" ] || saf_die "names.bicep gives another uniqueName than {prefix}-{slug}-{env}[--i{incarnation}] for $slug in $app_env"
  result="$PROV_DIR/entra-delete.json"
  saf_info "  Deleting the registration $unique_name (decommissioning; Entra keeps it 30 days in its recycle bin)"
  prov_graph_token
  saf_cli provisioning entra-delete --unique-name "$unique_name" --output "$result" || rc=$?
  unset SAF_GRAPH_TOKEN
  [ "$rc" -eq 0 ] || saf_die "deleting the registration of $slug in $app_env failed (see above); its record stays, and the next run tries again"
  jq -e --arg n "$unique_name" '.uniqueName == $n' "$result" > /dev/null || saf_die "entra-delete reported another application"
  for entra_rg in "$(prov_name "$names" entraEnvironmentResourceGroup)" "$(prov_name "$names" entraResourceGroup)"; do
    if az deployment group show --name "$entra_name" --resource-group "$entra_rg" --query name --output tsv --only-show-errors > /dev/null 2>&1; then
      az deployment group delete --name "$entra_name" --resource-group "$entra_rg" --only-show-errors --output none
    fi
  done
  prov_detail entra deleted
  prov_done delete-entra
}

provision() {
  local app_env="$2" planned outputs client_id net_mode
  slug="$1"
  app_file="$(prov_app_file "$slug")"
  [ "$(prov_app_auth "$slug")" = required ] || saf_die "$slug does not require sign-in"
  prov_app_envs "$slug"
  [[ " ${PROV_APP_ENVS[*]} " == *" $app_env "* ]] || saf_die "$slug does not run in $app_env"
  names="$PROV_DIR/names.json"
  # With the app's network mode: names.bicep then names the kvset job of its CAE (prov_secret_entry).
  net_mode="$(prov_app_network_mode "$slug" "$app_env")"
  prov_names "$slug" "$names" "$app_env" "$net_mode"
  plan="$(prov_entra_dir "$slug" "$app_env")"
  planned="$(prov_status_path "$plan" "$slug" "$app_env")"
  if [ "$(jq -r '.detail.entra // ""' "$planned")" = delete ]; then
    [ "$(prov_unit_action "$slug" "$app_env" entra)" = delete ] || saf_die "the Entra plan of $slug in $app_env deletes, but the plan doesn't"
    unregister "$app_env"
    return 0
  fi

  if [ "$(jq -r '.detail.entra // ""' "$planned")" = deploy ]; then
    remove_assignments "$app_env"
    register "$app_env" "$(jq -r '.detail.entraGroup // ""' "$planned")"
    outputs="$out/entra-outputs/$slug.$app_env.json"
  else
    # Up to date: the client ID of its record, read by entra_plan.
    outputs="$plan/entra-outputs/$slug.$app_env.json"
    [ -f "$outputs" ] || saf_die "artifact entra_plan has no client ID for the registration of $slug in $app_env"
    prov_detail entra up-to-date
  fi
  if [[ "$(jq -r '.detail.secret // ""' "$planned")" =~ ^(write|rotate)$ ]]; then
    client_id="$(jq -r '.clientId // ""' "$outputs")"
    prov_valid_guid "$client_id" || saf_die "no valid client ID for the registration of $slug in $app_env"
    write_secret "$app_env" "$client_id"
  fi
  # ADR-0060: the follow-up of a case A move, only as the plan's followUp.
  if [ "$(jq -r '.detail.secretOld // ""' "$planned")" = remove ]; then
    prov_follow_up "$slug" "$app_env" || saf_die "the Entra plan of $slug in $app_env removes the old secret, but the plan has no follow-up"
    client_id="$(jq -r '.clientId // ""' "$outputs")"
    prov_valid_guid "$client_id" || saf_die "no valid client ID for the registration of $slug in $app_env"
    remove_old_secret "$app_env" "$client_id"
  fi
}

# The apps to process: status ok and detail entra deploy or secret write|rotate in their Entra plan
# (units/entra or entra_plan, each app in the one prov_entra_dir names).
targets=()
for f in "$SAF_IN"/units/entra/status/*.json "$SAF_IN"/entra_plan/status/*.json; do
  [ -e "$f" ] || continue
  [ "$(jq -r 'select(.status == "ok") | .detail.entra == "deploy" or .detail.entra == "delete" or .detail.secret == "write" or .detail.secret == "rotate" or .detail.secretOld == "remove"' "$f")" = true ] || continue
  slug="$(jq -r '.slug // ""' "$f")"
  e="$(jq -r '.environment // ""' "$f")"
  if ! prov_valid_slug "$slug" || ! prov_valid_env "$e"; then
    saf_die "an Entra plan has a status file with an invalid slug or environment"
  fi
  [ "$f" = "$(prov_status_path "$(prov_entra_dir "$slug" "$e")" "$slug" "$e")" ] \
    || saf_die "an Entra plan has a status file under another app's name, or in the other plan's artifact"
  targets+=("$slug.$e")
done
saf_info "Entra registrations to deploy or Easy Auth secrets to write or rotate: ${#targets[@]}."
for t in "${targets[@]}"; do
  slug="${t%%.*}"
  e="${t#*.}"
  prov_run_app "$(prov_status_path "$out" "$slug" "$e")" "$slug" "$e" provision "$slug" "$e"
done
prov_finish
