#!/usr/bin/env bash
# plan.sh — stage `plan`, job `plan` of the platform pipeline (ADR-0043): AzureCLI@2 with
# sc-platform-provisioning-<env>, reads only, no approval.
#   1. names (infra/platform/pipeline/platform-names.bicep, offline).
#   2. Roles gate: the three custom roles of this core's roles.bicep exist with these actions and are
#      assignable in this subscription (`platform environment roles-check`). Otherwise the run stops
#      here, before the approval: no pipeline writes role definitions, a person deploys roles.bicep.
#   3. Portal host only: identities.entraProvisioningPrincipalId and portal.identityPrincipalId equal
#      the principals of id-{prefix}-entra-provisioning and id-{prefix}-portal. The other
#      environments' identities can't read the host subscription: there they are only shown.
#   4. Each CAE platform-names.bicep lists, read once (`az resource show`), against the CAEs of
#      environment.bicepparam's offline snapshot with these inputs (`platform environment cae-network`,
#      rule E17, ADR-0043 amendment 2026-11-15): an existing CAE whose network type or infrastructure
#      subnet would change stops the run here, before validate and what-if (a CAE's network can't
#      change in place; core runbook docs/runbooks/change-external-only-network.md). A new CAE is never
#      refused. A CAE of a mode instance.yaml no longer enables is reported, never deleted.
#   5. Inputs (pass 2), the record platform-{prefix}-{env}, `az deployment sub validate`,
#      `platform environment compare`: new (no record: pass 1 first) | changed: <reasons> | up-to-date.
#      With a record, also each job of an enabled mode: missing or not on the pinned saf-jobs digest
#      is a change too (the record alone doesn't show it).
#   6. what-if of what the deploy stage would deploy first, when 5 found it new or changed (rule E19):
#      every change as type and resource ID. Up to date, nothing is approved or deployed, so no what-if
#      (ADR-0074).
#   7. Portal host only (ADR-0043 decision 10, rule E16, plan_portal): portal.bicep as
#      portal-{prefix}-{env} through the same steps: inputs (`portal-inputs --pass auto`: pass 2 once
#      portal.clientId is set, else pass 1), the record against `az deployment sub validate`, and with
#      a record and pass 2 the Container App: missing or not on the pinned saf-portal digest is a
#      change too; what-if when new or changed (rule E19). A new environment (pass 1 above) defers the
#      portal to the next run: portal.bicep reads the platform resource group, workspace and registry
#      the deploy creates.
#      With SMTP basic auth, the inputs carry whether the password secret exists in the environment
#      vault (plat_portal_inputs, an ARM read of its metadata); a missing secret is a warning: the
#      portal gets no role on it and no vault setting until a run after it is written (US10.18).
#      The portal's former PostgreSQL database (ADR-0070 decision 6, rule E18): when its server or its
#      zone is still there and the portal gets pass 2, the plan is a change and names the server
#      (formerDatabase); the deploy removes what exists of it once the portal runs a ready revision on
#      Azure SQL.
# Artifact platform_plan: inputs.json (what the deploy stage must find again), cae-network.json (the
# verdict per CAE), plan.json {result, pass, environmentChanged, portal: null | {deployment, result,
# passes, changed, formerDatabase}}, what-if.txt (empty when up to date); in the portal host also
# portal-inputs.json and portal-what-if.txt; changed.txt (true when the environment or the portal isn't
# up to date: decide.sh turns it into the output `changed`, so the deploy stage and its approval run only
# on a change).
# Env: SAF_ENV_NAME, SAF_HOST_ENVIRONMENT, SAF_SERVICE_CONNECTION.

set -euo pipefail
# shellcheck source=plat-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/plat-lib.sh"

# plan_portal: step 7, the portal's part of the plan (portal host only). Reads the globals of the
# steps above (out, names, pass, env_name); sets portal_plan (JSON) and portal_changed.
plan_portal() {
  local deployment_p rg_p app_p target state result_p preview_p first_p passes_p repo_p digest_p vault_p secret_p
  local former_name former_zone former_state former_p=null host_p
  deployment_p="$(plat_name "$names" portalDeployment)"
  rg_p="$(plat_name "$names" portalResourceGroup)"
  app_p="$(plat_name "$names" portalContainerApp)"
  # The AzureFrontDoor.Backend ranges for the portal's own host name (ADR-0071), published with the plan.
  portal_fd_ranges="$out/fd-ranges.json"
  plat_fd_ranges "$portal_fd_ranges"
  plat_portal_inputs auto "$out/portal-inputs.json"
  target="$(jq -r 'if .portalImageDigest == "" then 1 else 2 end' "$out/portal-inputs.json")"
  saf_info ""
  saf_info "Portal (portal.hostEnvironment): deployment $deployment_p, Container App $app_p in $rg_p."
  host_p="$(jq -r '.frontDoor.hostName' "$out/portal-inputs.json")"
  if [ -n "$host_p" ]; then
    saf_info "  Host name: $host_p through Front Door $(plat_name "$names" frontDoorProfile) ($(jq -r '.frontDoor.backendIpRanges | length' "$out/portal-inputs.json") AzureFrontDoor.Backend ranges); the Container App takes traffic only from Front Door"
    if [ -n "$(jq -r '.frontDoor.dnsZoneId' "$out/portal-inputs.json")" ]; then
      plat_portal_dns_guard "$out/portal-inputs.json"
    else
      saf_warn "The DNS zone of the portal's host name $host_p is not an Azure DNS zone in this subscription: create its CNAME and _dnsauth TXT by hand from the deployment output frontDoor.dnsRecords (docs/runbooks/front-door-custom-domain.md)"
    fi
  else
    saf_info "  Host name: none of its own (the Container App's address, no ingress restriction)"
  fi
  if [ "$target" = 1 ]; then
    saf_warn "instance.yaml has no portal.clientId: the portal gets pass 1 only (network, database, CAE, no Container App). Create the portal registration with the CAE default domain (output managedEnvironmentDefaultDomain of $deployment_p), then set portal.clientId; the next run deploys the Container App"
  fi
  # The environment vault of the portal's own secrets and the SMTP password secret (ADR-0025
  # amendment 2026-11-14, US10.18): the role on a secret needs the secret, so a missing one only warns.
  vault_p="$(jq -r '.environmentVault' "$out/portal-inputs.json")"
  if [ "$vault_p" = private ]; then
    saf_info "  The portal's own secrets: the private environment vault, through its portal-side private endpoint"
  else
    saf_info "  The portal's own secrets: the public environment vault, over its public endpoint"
  fi
  secret_p="$(jq -r '.smtpPasswordSecretName' "$out/portal-inputs.json")"
  if [ -n "$secret_p" ] && [ "$(jq -r '.smtpPasswordSecretExists' "$out/portal-inputs.json")" != true ]; then
    saf_warn "instance.yaml sends email through an SMTP relay with a password, but the secret $secret_p is not in the $vault_p environment vault of $env_name yet: the portal identity gets no Key Vault Secrets User on it and the portal an empty SAF_SMTP_PASSWORD_VAULT_URI, so SMTP stays 'unsupported'. Write the secret (docs/runbooks/portal-email.md), then run this pipeline again"
  elif [ -n "$secret_p" ]; then
    saf_info "  SMTP password secret $secret_p: present; the portal identity reads it with Key Vault Secrets User on that secret only"
  fi
  if [ "$pass" = 1 ]; then
    saf_warn "New environment $env_name: the portal waits for it (portal.bicep reads the platform resource group, workspace and registry this run creates). Run this pipeline again after the deploy: its plan previews the portal"
    portal_plan="$(jq -n --arg d "$deployment_p" '{deployment: $d, result: "waiting: the environment is new", passes: [], changed: false, formerDatabase: null}')"
    portal_changed=false
    return 0
  fi
  repo_p="$(jq -er '.images["saf-portal"].repository' "$SAF_IMAGES_JSON")"
  digest_p="$(plat_portal_digest)"
  state="$(plat_app_state "$rg_p" "$app_p" "$repo_p" "$digest_p")"
  saf_info "  Container App $app_p: $state ($repo_p@$digest_p pinned)"
  if [ "$target" = 1 ] && [ "$state" != missing ]; then
    saf_die "the portal Container App $app_p exists, but instance.yaml has no portal.clientId: set it to the client ID of the portal registration (otherwise the pipeline would deploy pass 1 and stop upgrading the portal)"
  fi
  plat_record "$deployment_p" "$PLAT_DIR/portal-record.json"
  if [ -f "$PLAT_DIR/portal-record.json" ]; then
    first_p="$target"
    passes_p="[$target]"
    preview_p="$out/portal-inputs.json"
    plat_arm validate portal "$preview_p" "$deployment_p" "$PLAT_DIR/portal-validate.json"
    result_p="$(saf_cli environment compare --validate "$PLAT_DIR/portal-validate.json" --record "$PLAT_DIR/portal-record.json")"
    # The Container App, which the record can't show: changed or deleted by hand, or a deploy that
    # failed after the import, leaves it off the pinned saf-portal digest under an up-to-date record.
    if [ "$target" = 2 ] && [ "$state" != current ] && [ "$result_p" = up-to-date ]; then
      result_p="changed: container app $app_p $state"
    fi
  else
    # A new portal starts with pass 1: the registration needs the CAE's domain, and the registry role
    # propagates before the first pull. Pass 2 follows in the deploy stage when portal.clientId is set.
    first_p=1
    passes_p="$(jq -cn --argjson t "$target" 'if $t == 2 then [1, 2] else [1] end')"
    preview_p="$PLAT_DIR/portal-inputs-pass1.json"
    plat_portal_inputs 1 "$preview_p"
    plat_arm validate portal "$preview_p" "$deployment_p" "$PLAT_DIR/portal-validate.json"
    result_p=new
  fi
  # The portal's former PostgreSQL server (ADR-0070 decision 6): removed after a ready pass 2 on Azure SQL.
  former_name="$(plat_name "$names" portalFormerPostgresServer)"
  former_zone="$(plat_name "$names" portalFormerPostgresZone)"
  former_state="$(plat_former_db_read "$rg_p" "$former_name" "$former_zone")"
  if [ "$former_state" = present ] && [ "$target" = 2 ]; then
    former_p="$(jq -cn --arg n "$former_name" '$n')"
    saf_warn "The portal's former PostgreSQL database is still there (portal.bicep before ADR-0070): the server $former_name or the zone $former_zone. The deploy removes what exists of it (the server's private endpoint, the server, the zone and its link) once the portal's latest revision on Azure SQL is ready; no data is moved (the portal starts with an empty database)"
    [ "$result_p" != up-to-date ] || result_p="changed: former PostgreSQL database $former_name to remove"
  elif [ "$former_state" = present ]; then
    saf_warn "The portal's former PostgreSQL database is still there (the server $former_name or the zone $former_zone); it is removed in the run that deploys the Container App (pass 2, once portal.clientId is set)"
  fi
  case "$result_p" in
    up-to-date) portal_changed=false ;;
    new|changed:*) portal_changed=true ;;
    *) saf_die "platform environment compare answered something unexpected for the portal" ;;
  esac
  # The what-if for every change the approvers approve (rule E19); none when the portal is up to date (ADR-0074).
  if [ "$portal_changed" = true ]; then
    plat_arm what-if portal "$preview_p" "$deployment_p" "$PLAT_DIR/portal-what-if.json"
    jq -r '.changes // [] | .[] | select(.changeType != "NoChange" and .changeType != "Ignore") | "\(.changeType)\t\(.resourceId)"' \
      "$PLAT_DIR/portal-what-if.json" > "$out/portal-what-if.txt"
    saf_info "Plan of $deployment_p: $result_p (pass $first_p first). what-if, without NoChange and Ignore:"
    saf_neutralise < "$out/portal-what-if.txt" | sed 's/^/  /'
    if [ "$result_p" = new ] && [ "$target" = 2 ]; then
      saf_warn "New portal: this what-if is pass 1 only. The saf-portal import and pass 2 (the Container App ca-{prefix}-portal on the pinned digest) follow in the deploy stage without a preview; the next run's plan previews the portal in full. A new portal CAE has a new default domain: the portal registration's redirect URI must follow it"
    fi
  else
    : > "$out/portal-what-if.txt"
    saf_info "Plan of $deployment_p: up-to-date, so no what-if (nothing to approve or deploy)."
  fi
  portal_plan="$(jq -n --arg d "$deployment_p" --arg r "$result_p" --argjson p "$passes_p" --argjson c "$portal_changed" \
    --argjson f "$former_p" '{deployment: $d, result: $r, passes: $p, changed: $c, formerDatabase: $f}')"
}

saf_require_env SAF_ENV_NAME SAF_HOST_ENVIRONMENT SAF_SERVICE_CONNECTION
out="$SAF_OUT/platform_plan"
rm -rf "$out"
mkdir -p "$out"
printf 'false\n' > "$out/changed.txt"

plat_env_values
plat_login_check
saf_bicep_pin_check

# 1. Inputs and names.
plat_inputs 2 "$out/inputs.json"
names="$PLAT_DIR/names.json"
plat_names "$out/inputs.json" "$names"
deployment="$(plat_name "$names" platformDeployment)"
platform_rg="$(plat_name "$names" platformResourceGroup)"
saf_info "Platform environment $env_name ($env_kind): deployment $deployment in subscription $subscription."

# 2. Roles gate (fails closed).
bicep build "$plat_roles_template" --stdout > "$PLAT_DIR/roles.json" 2> "$PLAT_DIR/roles.err" \
  || { saf_neutralise < "$PLAT_DIR/roles.err" | tail -n 20; saf_die "bicep build of roles.bicep failed"; }
# TODO(verify): PLAT-6, that the list at a subscription scope also returns the definitions created in
# the portal host subscription with this subscription among their assignable scopes.
az role definition list --custom-role-only true --scope "/subscriptions/$subscription" \
  --output json --only-show-errors > "$PLAT_DIR/role-definitions.json"
saf_cli environment roles-check --names "$names" --roles "$PLAT_DIR/roles.json" \
  --definitions "$PLAT_DIR/role-definitions.json" --subscription "$subscription"

# 3. The principals instance.yaml names, against the identities (portal host only).
if [ "$env_name" = "$SAF_HOST_ENVIRONMENT" ]; then
  ids_rg="$(plat_name "$names" identitiesResourceGroup)"
  for pair in "entraProvisioningPrincipalId:entraProvisioningIdentity:identities.entraProvisioningPrincipalId" \
              "portalIdentityPrincipalId:portalIdentity:portal.identityPrincipalId"; do
    IFS=: read -r key output field <<< "$pair"
    want="$(jq -r --arg k "$key" '.[$k] // ""' "$out/inputs.json")"
    [ -n "$want" ] || continue
    identity="$(plat_name "$names" "$output")"
    got="$(az identity show --resource-group "$ids_rg" --name "$identity" --query principalId --output tsv --only-show-errors)"
    [ "${got,,}" = "${want,,}" ] \
      || saf_die "instance.yaml $field is not the principal of $identity in $ids_rg (the identities bootstrap outputs): fix instance.yaml"
    saf_info "  $field: the principal of $identity"
  done
else
  saf_info "  identities.entraProvisioningPrincipalId and portal.identityPrincipalId are checked by the platform pipeline of $SAF_HOST_ENVIRONMENT (its subscription holds the identities)."
fi

# 4. The CAEs as they are, each read once (platform-names.bicep lists the CAE of every buildable mode,
# enabled or not), against what environment.bicep would deploy with these inputs (its offline
# snapshot). A CAE's network can't change in place, so an existing CAE whose network type or
# infrastructure subnet differs stops the plan here, before validate and what-if, with one error per
# CAE in the run's summary (`platform environment cae-network`, rule E17, US03.03). A new CAE is never
# refused. A CAE of a mode instance.yaml no longer enables stays (nothing is deleted) and is reported.
printf '[]\n' > "$PLAT_DIR/caes.json"
while IFS=$'\t' read -r mode cae; do
  resource="$(plat_cae_read "$platform_rg" "$cae")"
  jq -c --arg m "$mode" --arg n "$cae" --argjson r "$resource" '. + [{mode: $m, name: $n, resource: $r}]' \
    "$PLAT_DIR/caes.json" > "$PLAT_DIR/caes.next.json"
  mv "$PLAT_DIR/caes.next.json" "$PLAT_DIR/caes.json"
done < <(jq -r '.outputs.managedEnvironments[] | [.mode, .name] | @tsv' "$names")
plat_env_snapshot "$out/inputs.json" "$PLAT_DIR/environment-snapshot.json"
if ! saf_cli environment cae-network --names "$names" --snapshot "$PLAT_DIR/environment-snapshot.json" \
    --live "$PLAT_DIR/caes.json" --output "$out/cae-network.json" 2> "$PLAT_DIR/cae-network.err"; then
  while IFS= read -r line; do
    printf '##vso[task.logissue type=error]%s\n' "${line#platform environment cae-network: }"
  done < <(saf_neutralise < "$PLAT_DIR/cae-network.err")
  saf_die "the plan stops before validate and what-if: the CAE network check failed (the errors above). An existing Container Apps environment's network can't change in place: keep it in instance.yaml, or follow the core runbook docs/runbooks/change-external-only-network.md"
fi
while IFS=$'\t' read -r mode cae; do
  printf '##vso[task.logissue type=warning]%s\n' "the CAE $cae ($mode) exists, but instance.yaml no longer enables $mode in $env_name: it is not deleted (its apps keep running); remove it by hand once no app uses it"
done < <(jq -r '.caes[] | select(.state == "not-enabled") | [.mode, .name] | @tsv' "$out/cae-network.json")

# 5. Up to date? A new environment (no record) starts with pass 1 (ADR-0035: no job before the
# saf-jobs image is in its platform registry).
plat_record "$deployment" "$PLAT_DIR/record.json"
if [ -f "$PLAT_DIR/record.json" ]; then
  pass=2
  preview="$out/inputs.json"
  plat_arm validate environment "$preview" "$deployment" "$PLAT_DIR/validate.json"
  result="$(saf_cli environment compare --validate "$PLAT_DIR/validate.json" --record "$PLAT_DIR/record.json")"
  # The jobs, which the record can't show: a job changed or deleted by hand, or a deploy that
  # failed after pass 2, leaves a job off the pinned saf-jobs digest under an up-to-date record,
  # and provisioning would wait for it forever (ADR-0043 decision 8). Such a job is a change.
  digest="$(plat_jobs_digest)"
  repo="$(jq -er '.images["saf-jobs"].repository' "$SAF_IMAGES_JSON")"
  job_issues=()
  while IFS=$'\t' read -r kvset dbinit; do
    for job in "$kvset" "$dbinit"; do
      state="$(plat_job_state "$platform_rg" "$job" "$repo" "$digest")"
      saf_info "  job $job: $state ($repo@$digest pinned)"
      [ "$state" = current ] || job_issues+=("job $job $state")
    done
  done < <(jq -r '.outputs.jobs[] | [.kvset, .dbinit] | @tsv' "$names")
  if [ "${#job_issues[@]}" -gt 0 ] && [ "$result" = up-to-date ]; then
    printf -v joined '%s, ' "${job_issues[@]}"
    result="changed: ${joined%, }"
  fi
else
  pass=1
  preview="$PLAT_DIR/inputs-pass1.json"
  plat_inputs 1 "$preview"
  plat_arm validate environment "$preview" "$deployment" "$PLAT_DIR/validate.json"
  result=new
fi
case "$result" in
  up-to-date) env_changed=false ;;
  new|changed:*) env_changed=true ;;
  *) saf_die "platform environment compare answered something unexpected" ;;
esac

# 6. The preview the approvers read (this log and the artifact), for every change they approve: a new or changed
# deployment always gets its what-if (rule E19). Up to date, there is no approval and no deploy, so there is
# nothing to preview and the what-if is skipped (ADR-0074); what-if.txt stays empty.
saf_info ""
if [ "$env_changed" = true ]; then
  plat_arm what-if environment "$preview" "$deployment" "$PLAT_DIR/what-if.json"
  jq -r '.changes // [] | .[] | select(.changeType != "NoChange" and .changeType != "Ignore") | "\(.changeType)\t\(.resourceId)"' \
    "$PLAT_DIR/what-if.json" > "$out/what-if.txt"
  saf_info "Plan of $deployment: $result (pass $pass first). what-if, without NoChange and Ignore:"
  saf_neutralise < "$out/what-if.txt" | sed 's/^/  /'
  if [ "$pass" = 1 ]; then
    printf '##vso[task.logissue type=warning]%s\n' "New environment $env_name: this what-if is pass 1 only. Pass 2 follows in the deploy stage without a preview: the kvset and dbinit jobs on the saf-jobs digest this core pins and their role assignments (ADR-0043); the next run's plan previews the environment in full"
  fi
else
  : > "$out/what-if.txt"
  saf_info "Plan of $deployment: up-to-date, so no what-if (nothing to approve or deploy)."
fi

# 7. The portal, in the portal host only (ADR-0043 decision 10).
portal_plan=null
portal_changed=false
if [ "$env_name" = "$SAF_HOST_ENVIRONMENT" ]; then
  plan_portal
fi

changed=false
if [ "$env_changed" = true ] || [ "$portal_changed" = true ]; then
  changed=true
fi
jq -n --arg r "$result" --argjson p "$pass" --argjson e "$env_changed" --argjson portal "$portal_plan" \
  '{result: $r, pass: $p, environmentChanged: $e, portal: $portal}' > "$out/plan.json"
printf '%s\n' "$changed" > "$out/changed.txt"
if [ "$changed" = true ]; then
  saf_info "The deploy stage runs after the approval on the environment platform-$env_name."
else
  saf_info "Up to date: no deploy stage, no approval."
fi
