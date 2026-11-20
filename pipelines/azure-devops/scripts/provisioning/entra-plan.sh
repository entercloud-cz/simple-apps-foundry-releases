#!/usr/bin/env bash
# entra-plan.sh — the Entra plan, run by AzureCLI@2 with sc-platform-provisioning-<hostEnvironment>
# (Azure provisioning identity of the environment whose subscription holds the Entra groups
# rg-{prefix}-entra-{env} and rg-{prefix}-entra, ADR-0033, ADR-0063). Reads only; no Graph permission. Two phases (SAF_ENTRA_PHASE, ADR-0050), the same
# comparison:
#   plan     stage plan, job decide, after the step decide: the entra units that run and whose
#            landing zone does NOT run in that environment (their entries are the plan's) ->
#            units/entra/ (published with the artifact units);
#   landing  stage entra_plan, job `plan`, after the landing zones (output entraPlan): the entra
#            units that run together with their landing zone (a new app: its outputs come from
#            azure_<env>) -> the artifact entra_plan.
# Where a unit was compared: prov_entra_dir. With nothing to compare in its phase, the script ends
# before any Bicep or Azure call (entra-needed.txt false).
# Per environment (list order), per app of the plan that requires sign-in, runs there and whose
# `entra` runs there (in this phase), when its landing zone is ok (prov_lz_ok: azure_<env> when its lz
# ran there, else plan_<env>), up to PROV_PARALLEL_MAX at the same time (it only reads); the app's entries
# (landing-zone outputs, Easy Auth secret, Front Door) come from that same artifact
# (prov_entry_dir). Every other app is unchanged here (prov_pass):
#   a. names.bicep (bicep snapshot): the environment's records group rg-{prefix}-entra-{env}, the
#      instance's rg-{prefix}-entra, entra-{slug}-{env};
#   b. `inputs --step entra` with the redirect host from the landing-zone outputs
#      (containerAppFqdn) and, for an app on a custom domain through Front Door, its record and the
#      backend ranges of plan_<env> (front_door_state: only the custom host once the ingress is
#      locked, ADR-0010 amended 2026-11-11) -> entra-inputs/{slug}.{env}.json, what the stage
#      `entra` deploys;
#   c. the record entra-{slug}-{env} (`az deployment group show`, none for a new registration;
#      entra_record below, ADR-0063): in the group where the plan of portal.hostEnvironment listed its
#      most recent record (plan.json entraRecords: the environment's group, or the instance's for a
#      record deployed before ADR-0063, which moves with its next deployment), else in the
#      environment's group; without the plan's list, in both, and the more recent counts. Detail
#      entraRecord environment | instance | none;
#   d. prov_entra_expected (parameters from `az bicep build-params`, template hash from ARM's
#      calculateTemplateHash; no preflight, which would call Microsoft Graph) + `compare` -> detail
#      entra up-to-date | deploy. Only an up-to-date record's client ID goes to
#      entra-outputs/{slug}.{env}.json: its template hash and parameters equal the plan's, which a
#      deployment without Microsoft Graph rights can't produce, so a forged record in an Entra
#      group can't hand a release another registration. A `deploy` also says where the stage entra
#      deploys the record: detail entraGroup environment (the environment's records group), or
#      instance while that group doesn't exist yet (plan.json entraGroups, ADR-0063);
#   d2. for a `deploy` with a record (ADR-0033 amended 2026-11-11): `platform provisioning
#      entra-removals` -> what the record's deployment declared and the inputs no longer have:
#      role assignments to delete and app roles to retire, entra-removals/{slug}.{env}.json, and,
#      when a retired role is still enabled, entra-inputs/{slug}.{env}.disable.json (the first of
#      its two deployments). Only what the platform declared is ever listed: an assignment made by
#      hand in the enterprise application is in no record. Each removal is a warning on the run
#      ("will remove ..."), so whoever approves the stage entra (approvals.entraChanges separate)
#      sees it, and with pullRequest the run's log shows what the reviewed pull request removes;
#      detail removeAssignments <n> and removeRoles <n>;
#   e. the Easy Auth secret (ADR-0035, ADR-0041): the entry plan_<env> or azure_<env> wrote
#      (secret/{slug}.{env}.json, checked by prov_secret_entry). Absent -> action new, detail secret write. Present ->
#      `platform provisioning rotation-due` with the vault version's expiry and creation time: due (at
#      most 120 of its 180 days left, expired, or no expiry and at least 60 days old) -> action
#      rotate, detail secret rotate (outside the maintenance window only with at most 14 days
#      left, else detail secret deferred: ADR-0048 section 7, amended 2026-11-11); else detail
#      secret current. At most 60 days left or expired: a
#      warning and detail secretExpiry soon|expired; no expiry: detail secretExpiry unknown (a
#      warning when it is due: the secret was written by hand). A planned action with its kvset job
#      present and on the saf-jobs digest this core pins -> secret-plan/{slug}.{env}.json {state,
#      vault, job, jobReady, secretName, action, created, expires, loaded} (what the stage entra
#      writes); without the job only a warning (detail secret job-missing), with a job on another
#      digest too (detail secret job-outdated: the environment's platform pipeline deploys the
#      pinned one, rule P23, ADR-0043). A rotation with at most 14 days left that such a job can't
#      write fails the app instead (prov_secret_urgent): sign-in would stop when the secret expires.
#   f. the follow-up of a case A network mode change (ADR-0060 decision 8; plan_old_secret below):
#      secret-plan/{slug}.{env}.remove-old.json and detail secretOld remove.
# Network mode change (ADR-0060): with the plan's modeChange, step b's state adds the source CAE's
# host (previousContainerAppFqdn): the registration lists it next to the target's until the move, so
# sign-in keeps working where the app runs now (a move that waits included); the entra unit then
# doesn't finish (prov_unit_finished), and the next run drops it. In case A the secret entry (azure_<env>,
# after the prepare pass) names the target vault, where the secret is absent: action new through the
# target CAE's kvset job (a new password; ADR-0060 decision 5).
# Decommissioning (ADR-0056): an entra unit with action delete is planned here (phase plan: its landing
# zone never runs with it) without any read: detail entra delete, deleted by the stage entra.
# Then entra-needed.txt: true when any registration is `deploy` or `delete` or any secret `write`, `rotate` or `remove` (secretOld)
# (read by entra-decide.sh), so a missing or due secret alone also runs the stage entra (with
# approvals.entraChanges separate, one approval; with pullRequest none, ADR-0051). The decision is
# the same in every run, whatever started it (merge, schedule, manual): the clock and instance.yaml
# decide whether a due rotation is time-based work's turn (prov_in_window).
# Output (units/entra or the artifact entra_plan): status/{slug}.{env}.json, entra-inputs/ (with
# {slug}.{env}.disable.json for a retired role), entra-outputs/, entra-removals/, secret-plan/,
# entra-needed.txt.
# Env: SAF_ENV_NAME (= hostEnvironment), SAF_ENVIRONMENTS_JSON, SAF_SERVICE_CONNECTION, SAF_ENTRA_PHASE.

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_ENVIRONMENTS_JSON SAF_SERVICE_CONNECTION SAF_ENTRA_PHASE
PROV_STAGE=entra_plan
case "$SAF_ENTRA_PHASE" in
  plan) out="$SAF_OUT/units/entra" ;;
  landing) out="$SAF_OUT/entra_plan" ;;
  *) saf_die "SAF_ENTRA_PHASE must be plan or landing" ;;
esac
rm -rf "$out"
mkdir -p "$out/status" "$out/entra-inputs" "$out/entra-outputs" "$out/entra-removals" "$out/secret-plan"
prov_units_check

# entra_phase_runs <slug> <env>: the app's entra runs there and is compared in this phase.
entra_phase_runs() {
  prov_unit_runs "$1" "$2" entra || return 1
  if prov_unit_runs "$1" "$2" lz; then [ "$SAF_ENTRA_PHASE" = landing ]; else [ "$SAF_ENTRA_PHASE" = plan ]; fi
}

envs=()
while IFS= read -r e; do
  prov_valid_env "$e" || saf_die "SAF_ENVIRONMENTS_JSON has an invalid environment name"
  envs+=("$e")
done < <(jq -r '.[].name' <<<"$SAF_ENVIRONMENTS_JSON")

# Nothing to compare in this phase: no Bicep, no Azure call (entra-needed.txt missing = false).
work="$(prov_entra_work "$SAF_ENTRA_PHASE")"
if [ "$work" -eq 0 ]; then
  saf_info "Entra plan ($SAF_ENTRA_PHASE): no entra unit to compare."
  exit 0
fi

saf_bicep_pin_check
prov_host_environment "sc-platform-provisioning-$SAF_ENV_NAME"

# front_door_state <env>: step b's Front Door facts (ADR-0010, amended 2026-11-11) -> fd-state.json
# (`platform provisioning state` with only the custom domain's record, frontdoor/{slug}.{env}.json,
# whether Front Door serves it, frontdoor/{slug}.{env}.domain.json, both from the app's entries
# (prov_entry_dir), and the backend ranges of plan_<env>; each absent = none). The domain served
# for the host app.yaml requests and the ranges resolved -> the registration keeps only the custom
# host's redirect URI, as the release locks its ingress in the same run; else both hosts.
front_door_state() {
  local app_env="$1" record domain ranges entries
  local -a args=(provisioning state --instance "$SAF_INSTANCE" --app "$app_file" --env "$app_env"
    --core-dir "$SAF_CORE" --output "$PROV_DIR/fd-state.json")
  entries="$(prov_entry_dir "$slug" "$app_env")"
  record="$entries/frontdoor/$slug.$app_env.json"
  domain="$entries/frontdoor/$slug.$app_env.domain.json"
  ranges="$(prov_fd_ranges_file "$app_env")"
  if [ -f "$record" ]; then
    args+=(--fd-record "$record")
    if [ -f "$domain" ]; then args+=(--fd-domain "$domain"); fi
  fi
  if [ -f "$ranges" ]; then args+=(--fd-ranges "$ranges"); fi
  saf_cli "${args[@]}" > /dev/null
}

# entra_record <env>: step c (ADR-0063) -> $PROV_DIR/entra-record.json (none: no record) and
# record_group (environment | instance | none). Reads only the app's own name in the two groups
# names.bicep names; a plan that lists the record in any other group fails the app.
record_group=none
entra_record() {
  local host_plan="$SAF_IN/plan_$SAF_ENV_NAME/plan.json" listed record="$PROV_DIR/entra-record.json" other="$PROV_DIR/entra-record-instance.json"
  record_group=none
  listed="$(jq -r --arg n "$entra_name" 'if (.entraRecords | type) == "array" then ([.entraRecords[] | select(.name == $n) | .group][0] // "") else "unknown" end' \
    "$host_plan" 2> /dev/null)" || listed=unknown
  case "$listed" in
    "$entra_rg" | "") prov_record group "$entra_name" "$entra_rg" "$record" ;;
    "$instance_rg")
      prov_record group "$entra_name" "$instance_rg" "$record"
      if [ -f "$record" ]; then record_group=instance; fi
      ;;
    unknown)
      prov_record group "$entra_name" "$entra_rg" "$record"
      prov_record group "$entra_name" "$instance_rg" "$other"
      if [ -f "$other" ] && { [ ! -f "$record" ] \
          || [[ "$(jq -r '.properties.timestamp // ""' "$other")" > "$(jq -r '.properties.timestamp // ""' "$record")" ]]; }; then
        mv "$other" "$record"
        record_group=instance
      fi
      rm -f "$other"
      ;;
    *) saf_die "the plan lists the record $entra_name in another resource group than $entra_rg or $instance_rg" ;;
  esac
  if [ -f "$record" ] && [ "$record_group" = none ]; then record_group=environment; fi
  prov_detail entraRecord "$record_group"
}

# entra_target <env>: where the stage entra deploys the registration's record (ADR-0063): instance while
# the plan found the environment's records group missing (plan.json entraGroups names rg-{prefix}-entra
# for <env>), else environment.
entra_target() {
  local g
  g="$(jq -r --arg e "$1" '.entraGroups[$e] // ""' "$SAF_IN/plan_$SAF_ENV_NAME/plan.json" 2> /dev/null)" || g=""
  if [ "$g" = "$instance_rg" ]; then printf 'instance'; else printf 'environment'; fi
}

plan_registration() {
  local app_env="$2" lz_outputs fqdn entra_rg instance_rg entra_name inputs client_id net_mode previous
  slug="$1"
  # ADR-0056: a decommissioned app's registration is deleted by the stage entra; nothing to compare.
  if [ "$(prov_unit_action "$slug" "$app_env" entra)" = delete ]; then
    saf_info "  $slug in $app_env: its registration is deleted (decommissioning)"
    prov_detail entra delete
    return 0
  fi
  app_file="$(prov_app_file "$slug")"
  names="$PROV_DIR/names.json"
  # With the app's network mode: names.bicep then names the kvset job of its CAE (prov_secret_entry).
  net_mode="$(prov_app_network_mode "$slug" "$app_env")"
  prov_names "$slug" "$names" "$app_env" "$net_mode"
  entra_rg="$(prov_name "$names" entraEnvironmentResourceGroup)"
  instance_rg="$(prov_name "$names" entraResourceGroup)"
  entra_name="$(prov_name "$names" entraDeployment)"

  lz_outputs="$(prov_entry_dir "$slug" "$app_env")/lz-outputs/$slug.$app_env.json"
  [ -f "$lz_outputs" ] || saf_die "no landing-zone outputs for $slug in $app_env (plan_$app_env or azure_$app_env)"
  fqdn="$(jq -r '.containerAppFqdn.value // ""' "$lz_outputs")"
  [ -n "$fqdn" ] || saf_die "the landing zone of $slug in $app_env has no output containerAppFqdn (deployed before it existed)"
  # ADR-0060: during a move the prepare pass's outputs name the target CAE's host; the source CAE's
  # host, where the app runs until its move, stays a redirect host (the next run drops it).
  previous="$(prov_mode_change "$slug" "$app_env" fromHost)"
  if [ -n "$previous" ] && [ "${previous,,}" != "${fqdn,,}" ]; then
    saf_info "  $slug in $app_env: network mode change; the registration keeps the current host $previous next to $fqdn until the move"
  else
    previous=""
  fi
  front_door_state "$app_env"
  jq --arg f "$fqdn" --arg p "$previous" '{containerAppFqdn: $f}
      + (if has("frontDoor") then {frontDoor} else {} end)
      + (if has("frontDoorBackendIpRanges") then {frontDoorBackendIpRanges} else {} end)
      + (if $p == "" then {} else {previousContainerAppFqdn: $p} end)' \
    "$PROV_DIR/fd-state.json" > "$PROV_DIR/state.json"
  inputs="$out/entra-inputs/$slug.$app_env.json"
  saf_cli provisioning inputs --step entra --instance "$SAF_INSTANCE" --app "$app_file" --env "$app_env" \
    --state "$PROV_DIR/state.json" --output "$inputs"

  entra_record "$app_env"

  prov_entra_expected "$inputs" "$PROV_DIR/expected.json"
  prov_compare entra "$PROV_DIR/expected.json" "$PROV_DIR/entra-record.json"
  if [ "$prov_verdict" = up-to-date ]; then
    client_id="$(jq -r '.properties.outputs.clientId.value // ""' "$PROV_DIR/entra-record.json")"
    [[ "$client_id" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]] \
      || saf_die "the record $entra_name has no valid clientId output"
    jq -n --arg c "$client_id" '{clientId: $c}' > "$out/entra-outputs/$slug.$app_env.json"
    prov_detail entra up-to-date
  else
    prov_detail entra deploy
    prov_detail entraGroup "$(entra_target "$app_env")"
    plan_removals "$app_env" "$inputs"
  fi
  plan_secret "$app_env"
  plan_old_secret "$app_env"
}

# Step f (ADR-0060 decision 8): the follow-up of a case A move. The plan's followUp remove-old (the
# secret is left in the other variant's vault while the app runs in app.yaml's, plan-facts
# secretElsewhere) -> secret-plan/{slug}.{env}.remove-old.json {secretName, vault (the old variant's),
# job (its kvset job), appVault (the vault of the CAE the app runs in now, from the plan: this
# identity can't read Container Apps), created, expires, loaded (the version in the vault the app runs
# with)} and detail secretOld remove, which the stage entra runs as `easyauth-secret --mode remove-old`.
# Any run, not only in the maintenance window: cleanup of an approved change. The old variant's job
# missing or on another saf-jobs digest: a warning and detail secretOld job-missing|job-outdated (the
# next run tries again; the old secret opens nothing, the app uses the new one).
plan_old_secret() {
  local app_env="$1" entry job_state
  prov_follow_up "$slug" "$app_env" || return 0
  entry="$(prov_entry_dir "$slug" "$app_env")/secret/$slug.$app_env.json"
  if [ "$(jq -r '(.elsewhere | type) == "object"' "$entry")" != true ]; then
    prov_detail secretOld none
    return 0
  fi
  if [ "$(jq -r '.elsewhere.jobReady == true' "$entry")" != true ]; then
    job_state="$(jq -r '.elsewhere.jobState // ""' "$entry")"
    [ "$job_state" = outdated ] || job_state=missing
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: the Easy Auth secret of the previous network variant is left, but that variant's kvset job is $job_state; the next provisioning run removes it"
    prov_detail secretOld "job-$job_state"
    return 0
  fi
  jq --arg n "$(prov_name "$names" easyAuthSecret)" \
    '{secretName: $n, vault: .elsewhere.vault, job: .elsewhere.job, appVault: (.appVault // "none"), created, expires, loaded}' \
    "$entry" > "$out/secret-plan/$slug.$app_env.remove-old.json"
  saf_info "  $slug in $app_env: the Easy Auth secret of the previous network variant is left in $(jq -r '.elsewhere.vault' "$entry" | saf_neutralise); the stage entra removes it and its passwords"
  prov_detail secretOld remove
}

# Step d2: what the platform assigned or defined (the record's parameters) and the inputs no longer
# have. No record (a new registration): nothing. The CLI checks every principal (GUID) and role
# value, so the warnings below carry only those.
plan_removals() {
  local app_env="$1" inputs="$2" removals="$PROV_DIR/removals.json" assignments roles line
  [ -f "$PROV_DIR/entra-record.json" ] || return 0
  saf_cli provisioning entra-removals --inputs "$inputs" --record "$PROV_DIR/entra-record.json" \
    --output "$removals" --disable-output "$out/entra-inputs/$slug.$app_env.disable.json"
  assignments="$(jq '.assignments | length' "$removals")"
  roles="$(jq '.roles | length' "$removals")"
  if [ "$assignments" -eq 0 ] && [ "$roles" -eq 0 ]; then
    return 0
  fi
  cp "$removals" "$out/entra-removals/$slug.$app_env.json"
  while IFS= read -r line; do
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: will remove $line (no longer in app.yaml; the stage entra removes it, after its approval when approvals.entraChanges is separate)"
  done < <(jq -r '(.assignments[] | "the role \(.role) from the user or group \(.principalId)"),
      (.roles[] | "the app role \(.value)" + (if .enabledInRecord then " (disabled first, then removed)" else "" end))' "$removals")
  if [ "$assignments" -gt 0 ]; then prov_detail removeAssignments "$assignments"; fi
  if [ "$roles" -gt 0 ]; then prov_detail removeRoles "$roles"; fi
}

# Step e: the Easy Auth secret of the current app in <env>.
plan_secret() {
  local app_env="$1" action verdict days job_state
  prov_secret_entry "$(prov_entry_dir "$slug" "$app_env")/secret/$slug.$app_env.json" "$app_env"
  if [ "$secret_state" = absent ]; then
    action=new
  else
    read -r verdict days <<< "$(saf_cli provisioning rotation-due --expires "$secret_expires" --created "$secret_created" --now "$(date -u +%s)")"
    if [[ ! "$verdict" =~ ^(due|current)$ ]] || [[ ! "$days" =~ ^(-?[0-9]{1,6}|none)$ ]]; then
      saf_die "unexpected output of the rotation check (platform provisioning)"
    fi
    if [ "$days" = none ]; then
      if [ "$verdict" = due ]; then
        printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: its Easy Auth secret records no expiry (written by hand?) and is at least 60 days old, or its age is unknown; it is rotated now"
      fi
      prov_detail secretExpiry unknown
    elif [ "$days" -lt 0 ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: its Easy Auth secret expired ${days#-} day(s) ago (rotations were missed); sign-in fails until the rotation of this run (core runbook docs/runbooks/easyauth-rotation.md)"
      prov_detail secretExpiry expired
    elif [ "$days" -le 60 ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: its Easy Auth secret expires in $days day(s) (rotations were missed: this run rotates it when inside the maintenance window or with at most 14 days left, after the approval of its entra stage when approvals.entraChanges is separate; core runbook docs/runbooks/easyauth-rotation.md)"
      prov_detail secretExpiry soon
    fi
    if [ "$verdict" = current ]; then
      prov_detail secret current
      return 0
    fi
    # A rotation is time-based work: outside the maintenance window it waits, unless at most 14
    # days are left (ADR-0048 section 7, amended 2026-11-11). The plan ran this entra unit for
    # another reason (a changed input, a new environment), not for the rotation.
    if ! prov_in_window && ! prov_secret_urgent; then
      saf_info "  $slug in $app_env: its Easy Auth secret is due for rotation; it waits for the maintenance window"
      prov_detail secret deferred
      return 0
    fi
    action=rotate
  fi
  if [ "$secret_job_ready" != true ]; then
    job_state="$(jq -r '.jobState // ""' "$(prov_entry_dir "$slug" "$app_env")/secret/$slug.$app_env.json")"
    # At most 14 days left: the rotation can't wait for the job, so the app fails (visible) instead.
    if [ "$action" = rotate ] && prov_secret_urgent; then
      prov_detail secret "job-${job_state:-missing}"
      saf_die "$slug in $app_env: its Easy Auth secret expires within 14 days, and the kvset job ${secret_job##*/} can't rotate it (${job_state:-missing}): run and approve the platform pipeline of $app_env now (ADR-0043), then provisioning; sign-in stops when the secret expires"
    fi
    # Otherwise a warning only: the app stays ok, so its registration is still deployed when planned.
    if [ "$job_state" = outdated ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: its Easy Auth secret needs a write ($action), but the kvset job ${secret_job##*/} doesn't run the saf-jobs image this core pins yet: the platform pipeline of $app_env deploys it (ADR-0043); the next provisioning run writes the secret"
      prov_detail secret job-outdated
    else
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $app_env: its Easy Auth secret needs a write ($action), but the kvset job ${secret_job##*/} doesn't exist yet (environment.bicep pass 2, ADR-0035)"
      prov_detail secret job-missing
    fi
    return 0
  fi
  jq -n --arg s "$secret_state" --arg v "$secret_vault" --arg j "$secret_job" --arg n "$(prov_name "$names" easyAuthSecret)" \
    --arg a "$action" --arg c "$secret_created" --arg x "$secret_expires" --arg l "$secret_loaded" \
    'def epoch_or_null: if . == "none" then null else tonumber end;
     {state: $s, vault: $v, job: $j, jobReady: true, secretName: $n, action: $a,
      created: ($c | epoch_or_null), expires: ($x | epoch_or_null), loaded: ($l | epoch_or_null)}' \
    > "$out/secret-plan/$slug.$app_env.json"
  if [ "$action" = new ]; then prov_detail secret write; else prov_detail secret rotate; fi
}

# Restore the Microsoft Graph extension once, before the units run at the same time: parallel
# `az bicep build-params` calls that each restore it race on the shared cache, and one of them
# then fails with BCP190 (run 3116).
az bicep build --file "$SAF_CORE/infra/entra/app-registration.bicep" --stdout >/dev/null \
  || saf_die "bicep could not restore the Microsoft Graph extension of app-registration.bicep"

prov_parallel
for e in "${envs[@]}"; do
  prov_plan_apps "$e"
  for slug in "${PROV_APPS[@]}"; do
    [ "$(prov_app_auth "$slug")" = required ] || continue
    if ! entra_phase_runs "$slug" "$e"; then
      prov_pass "$slug" "$e"
      continue
    fi
    if ! prov_lz_ok "$slug" "$e"; then
      prov_skip "$slug" "its landing zone in $e is not ok"
      continue
    fi
    prov_run_app "$(prov_status_path "$out" "$slug" "$e")" "$slug" "$e" plan_registration "$slug" "$e"
  done
done
prov_join

# Only registrations and secrets that were planned without an error are deployed, written or rotated.
needed=false
for f in "$out"/status/*.json; do
  [ -e "$f" ] || continue
  if [ "$(jq -r 'select(.status == "ok") | .detail.entra == "deploy" or .detail.entra == "delete" or .detail.secret == "write" or .detail.secret == "rotate" or .detail.secretOld == "remove"' "$f")" = true ]; then
    needed=true
  fi
done
printf '%s\n' "$needed" > "$out/entra-needed.txt"
saf_info "Entra registrations to deploy or Easy Auth secrets to write or rotate: $needed"
prov_finish
