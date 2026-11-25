#!/usr/bin/env bash
# plan.sh — stage plan, the job of each environment (plan_<env>; for portal.hostEnvironment its first
# step in the job decide), run by AzureCLI@2 with sc-platform-provisioning-<env> (Azure provisioning
# identity of the environment, ADR-0031). Reads only; deploys nothing (ADR-0048).
#
# The read model (ADR-0050): the state of EVERY app of <env> in a constant number of `az` calls,
# lists instead of one read per app, so a plan with nothing to do costs the same for 10 apps and for
# hundreds. Each list is one `az` call (az pages ARM itself) or, through `az rest`, one call per page
# of an ARM list (prov_arm_list). In this order:
#   1. once, when an app of the plan requests a custom domain through Front Door in <env>: the IPv4
#      prefixes of the AzureFrontDoor.Backend service tag (ADR-0010 amended 2026-11-11, FD-3) ->
#      frontdoor/backend-ranges.json, read by azure_<env>, the Entra plans and azure_post_<env>;
#   2. the saf-* tags of every resource group of the subscription (`az group list`);
#   3. the landing-zone records lz-* at subscription scope (`az deployment sub list`), with their
#      state, parameters and outputs; a Succeeded record listed without parameters or outputs is
#      read on its own (`az deployment sub show`; TODO(verify) UNIT-7: the list returns both);
#   4. the custom domains' records fd-* of the platform resource group (`az deployment group list`)
#      and, for the Front Door profiles they name, the profile's custom domains (ARM list): whether
#      Front Door serves each domain;
#   5. any app in <env>: the Container Apps of the subscription (ARM list): the tag saf-easyauth,
#      systemData.lastModifiedAt, the ingress rules afd-backend-*, runningStatus (a decommissioned app
#      found running is stopped again), the images of the containers and init containers (what the
#      app runs is never purged from its build-environment registry, ADR-0059; before it only apps
#      with sign-in, a custom domain or a decommission block with its group needed the list), and
#      the environmentId and ingress FQDN (the mode the app runs in now and its host there: a network
#      mode change, ADR-0060);
#   6. apps with sign-in: the platform jobs of the platform resource group (ARM list: the kvset job's
#      image against the pinned saf-jobs digest), the environment vault of each mode the environment
#      offers (names.bicep, offline, once per vault variant: at most two `bicep snapshot` per job, never
#      one per app; prov_mode_vaults -> env-vaults.json) and, per such vault (both variants when the
#      environment offers both, so a secret left in the other one after a move is seen, ADR-0060), its
#      secrets (ARM list of Microsoft.KeyVault/vaults/secrets: name and attributes created and
#      exp, metadata only, never a value; works for the private vault too);
#   7. in the job of portal.hostEnvironment only, whose subscription holds the Entra records
#      (ADR-0033): the deployments (`az deployment group list`) of every environment's records group
#      rg-{prefix}-entra-{env} and of the instance's rg-{prefix}-entra, which holds the records deployed
#      before ADR-0063 until each registration's next deployment moves its record (one list per
#      group, whatever the number of apps): a missing record runs entra and release; an unreadable list
#      runs entra; a decommissioned app with none of its records, no group, no landing-zone and no
#      custom-domain record left is deleted (the plan's phase deleted, ADR-0056 amendment 2026-11-12:
#      read here, nobody marks it);
#   8. `platform provisioning plan-facts` turns the lists into every app's facts, status and entries
#      (facts/{slug}.json, status/{slug}.{env}.json, lz-outputs/, secret/, frontdoor/) and names the
#      apps whose Easy Auth restart it can't decide from the lists or whose rotation is due
#      (lazy.json); only for those, the active revisions of the app (ARM list), then plan-facts again.
# Steps 3, 4 and 7 list every deployment of their scope (the subscription, the platform resource
# group, the Entra groups) and keep the records they need: the plan counts each scope's deployment
# history from that list and warns above 600 (ARM keeps 800 per scope; ADR-0052), with no extra call.
# A list that can't be read fails the apps that need it (status failed: none of their units run in
# <env> in this run, report fails the run); the tags failing fails every app of <env>. Names come
# from `platform provisioning plan-names` and plan-facts (naming.bicep's, ported and checked against
# infra/tests/naming-vectors.json): no `bicep snapshot` per app (the environment vaults' names, which
# hold a Bicep hash, are the one snapshot per vault variant of step 6).
# Artifact plan_<env> (its folder exists from the job's first step, steps/setup.yml, and it is
# published with always()): plan.json ({environment, tagsRead, entraRecords?, entraGroups?}), status/,
# facts/, lz-outputs/, secret/, frontdoor/. Exit 1 when an app failed its plan (after writing everything).
# Env: SAF_ENV_NAME, SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION (template constants).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE="plan_$SAF_ENV_NAME"
out="$SAF_OUT/$PROV_STAGE"
bulk="$SAF_WORK/bulk-$SAF_ENV_NAME"
rm -rf "$out" "$bulk"
mkdir -p "$out/status" "$out/facts" "$out/lz-outputs" "$out/secret" "$out/frontdoor" "$bulk/secrets" "$bulk/revisions"

prov_environment
prov_plan_apps "$env_name"
saf_info "Plan of $env_name: ${#PROV_APPS[@]} app(s)."
saf_cli provisioning plan-names --instance "$SAF_INSTANCE" --env "$env_name" --apps "$SAF_APPS_JSON" --output "$SAF_WORK/plan-names.json" > /dev/null
platform_rg="$(jq -er '.platformResourceGroup' "$SAF_WORK/plan-names.json")"
[[ "$platform_rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "plan-names gave no valid platform resource group"
sub_path="/subscriptions/$subscription"
API_APPS=2024-03-01
API_VAULT=2023-07-01
API_FD=2025-04-15

# plan_apps_with <jq filter on an apps.json entry>: true when an app of the plan in <env> matches.
plan_apps_with() {
  [ "$(jq -r --arg e "$env_name" "[.apps[] | select(.ok == true and ((.environments // []) | index(\$e)) != null) | select($1)] | length > 0" "$SAF_APPS_JSON")" = true ]
}

# plan_list <label> <output> <az args...>: one az list call -> <output>, or a warning and no file.
plan_list() {
  local label="$1" file="$2" err="$bulk/list.err"
  shift 2
  if az "$@" --output json --only-show-errors > "$file.tmp" 2> "$err" && jq -e 'type == "array"' "$file.tmp" > /dev/null; then
    mv "$file.tmp" "$file"
    saf_info "  $label: $(jq 'length' "$file")"
    return 0
  fi
  rm -f "$file.tmp"
  saf_neutralise < "$err" | tail -n 10
  printf '##vso[task.logissue type=warning]%s\n' "could not list $label in $env_name; the apps that need it fail their plan in this run"
  return 0
}

# Step 1: the Front Door backend ranges (Service Tag Discovery API, within this identity's
# Contributor, ADR-0031). A failure is a warning and no file: every app on a custom domain then fails
# its plan (fails closed, nothing is released with a guessed list). Verify in sandbox: FD-3.
fd_ranges() {
  local file err="$bulk/service-tags.err" raw="$bulk/service-tags.json"
  file="$(prov_fd_ranges_file "$env_name")"
  rm -f "$file"
  # shellcheck disable=SC2016 # a jq expression: $e is jq's variable
  plan_apps_with '((.frontDoorHosts // {})[$e] // "") != ""' || return 0
  [[ "$region" =~ ^[a-z0-9]+$ ]] || saf_die "instance.yaml has no valid region for $env_name"
  mkdir -p "$(dirname "$file")"
  if ! az network list-service-tags --location "$region" --output json --only-show-errors > "$raw" 2> "$err"; then
    saf_neutralise < "$err" | tail -n 10
    printf '##vso[task.logissue type=warning]%s\n' "could not read the service tags in $env_name ($region): the apps on a custom domain through Front Door fail in this run, their releases are not touched"
    return 0
  fi
  if ! saf_cli provisioning fd-ranges --service-tags "$raw" --output "$file"; then
    rm -f "$file"
    printf '##vso[task.logissue type=warning]%s\n' "the AzureFrontDoor.Backend service tag in $env_name gave no usable IPv4 ranges: the apps on a custom domain through Front Door fail in this run, their releases are not touched"
  fi
  rm -f "$raw"
}

# history_count <scope> <list file>: the number of deployments a list returned for a scope ARM keeps
# at most 800 of (ADR-0052: the subscription, the platform resource group and the Entra groups are
# shared by every app; at the limit ARM deletes the oldest records, other apps' included, which the
# plan reads). Above HISTORY_WARN a warning, from the list the plan reads anyway (no extra call).
# TODO(verify) ISO-8: when ARM's automatic deletion starts, and whether it deletes subscription-scope
# deployments too.
HISTORY_WARN=600
history_count() {
  local n
  [ -f "$2" ] || return 0
  n="$(jq 'length' "$2")"
  saf_info "  deployment history of $1: $n"
  if [ "$n" -gt "$HISTORY_WARN" ]; then
    printf '##vso[task.logissue type=warning]%s\n' "$1 holds $n deployments; ARM keeps at most 800 per scope and then deletes the oldest records, other apps' included. Delete stale records there (core runbook docs/runbooks/deployment-history.md)"
  fi
}

# Step 3: the landing-zone records, and the fallback for a record listed without parameters or outputs.
# The list is every deployment at subscription scope (counted, history_count), filtered to lz-* here.
lz_records() {
  local file="$bulk/lz-records.json" name err="$bulk/lz-show.err"
  plan_list "deployments at subscription scope" "$bulk/sub-deployments.json" deployment sub list \
    --query "[].{name: name, properties: {provisioningState: properties.provisioningState, templateHash: properties.templateHash, parameters: properties.parameters, outputs: properties.outputs}}"
  [ -f "$bulk/sub-deployments.json" ] || return 0
  history_count "the subscription of $env_name" "$bulk/sub-deployments.json"
  jq '[.[] | select((.name // "") | startswith("lz-"))]' "$bulk/sub-deployments.json" > "$file"
  saf_info "  landing-zone records (lz-*): $(jq 'length' "$file")"
  while IFS= read -r name; do
    [[ "$name" =~ ^lz-[a-z0-9-]{3,60}$ ]] || continue
    if ! az deployment sub show --name "$name" --query '{name: name, properties: {provisioningState: properties.provisioningState, templateHash: properties.templateHash, parameters: properties.parameters, outputs: properties.outputs}}' \
        --output json --only-show-errors > "$bulk/lz-show.json" 2> "$err"; then
      saf_neutralise < "$err" | tail -n 10
      continue
    fi
    jq --slurpfile r "$bulk/lz-show.json" 'map(if .name == $r[0].name then $r[0] else . end)' "$file" > "$file.tmp"
    mv "$file.tmp" "$file"
  done < <(jq -r '.[] | select(.properties.provisioningState == "Succeeded" and ((.properties.parameters | type) != "object" or (.properties.outputs | type) != "object")) | .name' "$file")
}

# Step 4: the custom domains' records and the Front Door profiles' custom domains.
fd_state() {
  local file="$bulk/fd-records.json" profile ok=true
  plan_list "deployments of $platform_rg" "$bulk/platform-deployments.json" deployment group list --resource-group "$platform_rg" \
    --query "[].{name: name, properties: {provisioningState: properties.provisioningState, templateHash: properties.templateHash, parameters: properties.parameters, outputs: properties.outputs}}"
  [ -f "$bulk/platform-deployments.json" ] || return 0
  history_count "$platform_rg" "$bulk/platform-deployments.json"
  jq '[.[] | select((.name // "") | startswith("fd-"))]' "$bulk/platform-deployments.json" > "$file"
  saf_info "  custom domain records (fd-*): $(jq 'length' "$file")"
  printf '[]\n' > "$bulk/fd-domains.json"
  while IFS= read -r profile; do
    if [[ ! "$profile" =~ ^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-A-Za-z0-9._()]{1,90}/providers/Microsoft\.Cdn/profiles/[-A-Za-z0-9]{1,260}$ ]]; then
      continue
    fi
    if prov_arm_list "$profile/customDomains?api-version=$API_FD" "$bulk/fd-domains-page.json"; then
      jq -s '.[0] + .[1]' "$bulk/fd-domains.json" "$bulk/fd-domains-page.json" > "$bulk/fd-domains.tmp"
      mv "$bulk/fd-domains.tmp" "$bulk/fd-domains.json"
    else
      ok=false
    fi
  done < <(jq -r '[.[] | select(.properties.provisioningState == "Succeeded") | (.properties.outputs.customDomainId.value // "")
      | select(type == "string") | sub("/customDomains/[^/]+$"; "") ] | unique[]' "$file")
  if [ "$ok" != true ]; then
    rm -f "$bulk/fd-domains.json"
    printf '##vso[task.logissue type=warning]%s\n' "could not list the custom domains of the Front Door profile in $env_name; no ingress is locked for the first time in this run"
  fi
}

# decommissioned_with_group: true when a decommissioned app of the plan in <env> still has its resource
# group in the group list of step 2 (by naming, plan-names --apps). A deleted app (ADR-0056 amendment
# 2026-11-12) needs no Container Apps list: there is nothing of it left to stop.
decommissioned_with_group() {
  [ -f "$bulk/groups.json" ] || return 1
  # shellcheck disable=SC2016 # a jq expression: $e, $n and $g are jq's variables
  jq -e --arg e "$env_name" --slurpfile n "$SAF_WORK/plan-names.json" --slurpfile g "$bulk/groups.json" \
    '[$g[0][] | (.name // "" | ascii_downcase)] as $groups
     | any(.apps[] | select(.ok == true and .decommission != null and ((.environments // []) | index($e)) != null);
         ((($n[0].appResourceGroups // {})[.slug] // "") | ascii_downcase) as $rg | $rg != "" and ($groups | index($rg)) != null)' \
    "$SAF_APPS_JSON" > /dev/null
}

# Steps 5 and 6: the Container Apps, the platform jobs and the environment vaults' secrets, only as
# far as the plan's apps need them. The Container Apps for any app: the registry purge (ADR-0059)
# protects what every app runs in every environment, so the plan of each environment reads it.
runtime_state() {
  local vault
  if [ "${#PROV_APPS[@]}" -gt 0 ] || decommissioned_with_group; then
    if prov_arm_list "$sub_path/providers/Microsoft.App/containerApps?api-version=$API_APPS" "$bulk/ca.raw"; then
      jq 'map({id, tags: (.tags // {}), systemData: {lastModifiedAt: .systemData.lastModifiedAt},
          properties: {runningStatus: (.properties.runningStatus // null),
            environmentId: (.properties.environmentId // .properties.managedEnvironmentId // null),
            configuration: {ingress: {fqdn: (.properties.configuration.ingress.fqdn // null), ipSecurityRestrictions: (.properties.configuration.ingress.ipSecurityRestrictions // [])}},
            template: {containers: [(.properties.template.containers // [])[] | {image: (.image // "")}],
              initContainers: [(.properties.template.initContainers // [])[] | {image: (.image // "")}]}}})' \
        "$bulk/ca.raw" > "$bulk/container-apps.json"
      saf_info "  Container Apps: $(jq 'length' "$bulk/container-apps.json")"
    fi
  fi
  plan_apps_with '.authMode == "required"' || return 0
  if prov_arm_list "$sub_path/resourceGroups/$platform_rg/providers/Microsoft.App/jobs?api-version=$API_APPS" "$bulk/jobs.raw"; then
    jq 'map({id, properties: {template: {containers: [{image: (.properties.template.containers[0].image // "")}]}}})' "$bulk/jobs.raw" > "$bulk/jobs.json"
  fi
  # The environment vault of each mode the environment offers (ADR-0060), named offline once per variant.
  # Names that can't be had are a list that can't be read: the apps with sign-in fail their plan.
  if ! ( prov_mode_vaults "$SAF_WORK/plan-names.json" "${PROV_APPS[0]}" "$bulk/env-vaults.json" ); then
    rm -f "$bulk/env-vaults.json"
    printf '##vso[task.logissue type=warning]%s\n' "could not name the environment vaults of $env_name (names.bicep); its apps with sign-in fail their plan in this run"
    return 0
  fi
  while IFS= read -r vault; do
    prov_valid_vault "$vault" || continue
    if prov_arm_list "$sub_path/resourceGroups/$platform_rg/providers/Microsoft.KeyVault/vaults/$vault/secrets?api-version=$API_VAULT" "$bulk/secrets.raw"; then
      jq 'map({name, properties: {attributes: {created: .properties.attributes.created, exp: .properties.attributes.exp}}})' "$bulk/secrets.raw" > "$bulk/secrets/$vault.json"
      saf_info "  secrets in $vault: $(jq 'length' "$bulk/secrets/$vault.json")"
    else
      printf '##vso[task.logissue type=warning]%s\n' "could not list the secrets of the environment vault $vault in $env_name; its apps with sign-in fail their plan in this run"
    fi
  done < <(jq -r '[.[]] | unique[]' "$bulk/env-vaults.json")
}

# entra_list <group> <output>: one `az deployment group list` of an Entra group -> <output>
# ([{name, state, timestamp, group}]); entra_listed = ok | missing (ResourceGroupNotFound: the group
# doesn't exist yet) | failed. The host's provisioning identity (Contributor on the subscription) gets
# ResourceGroupNotFound for a group that doesn't exist, as prov_record assumes (sandbox ENT-14, run 3719).
entra_listed=""
entra_list() {
  local err="$bulk/entra-records.err"
  entra_listed=failed
  if az deployment group list --resource-group "$1" --query '[].{name: name, state: properties.provisioningState, timestamp: properties.timestamp}' \
      --output json --only-show-errors > "$2.raw" 2> "$err" && jq -e 'type == "array"' "$2.raw" > /dev/null; then
    jq --arg g "$1" '[.[] | {name: (.name // "" | tostring), state: (.state // "" | tostring), timestamp: (.timestamp // "" | tostring), group: $g}]' \
      "$2.raw" > "$2"
    entra_listed=ok
  elif grep -q 'ResourceGroupNotFound' "$err"; then
    printf '[]\n' > "$2"
    entra_listed=missing
  else
    saf_neutralise < "$err" | tail -n 10
  fi
  rm -f "$2.raw"
}

# Step 7 (portal.hostEnvironment only; ADR-0033, ADR-0063): the Entra records -> entra-records.json
# ([{name, state, group}]: the most recent record of each name, in whichever group it is, the
# environment's group on a tie; null when a list could not be read) and entra-groups.json ({<env>: the
# group the stage entra deploys a record of <env> into}: the environment's records group, or the
# instance's rg-{prefix}-entra while that group doesn't exist yet: the bootstrap of the portal host
# environment creates it, with entraEnvironments). Only records named for the environment
# (entra-*-{env}) count from an environment's group; the instance's group counts as before. The
# records left in the instance's group are counted: each moves with its registration's next deployment
# (the stage entra deletes the old one after the new one succeeded), so the dual read ends once it holds
# none of them (core runbook docs/runbooks/deployment-history.md).
entra_records() {
  local instance_rg e rg target ok=true legacy
  instance_rg="$(jq -er '.entraResourceGroup' "$SAF_WORK/plan-names.json")"
  [[ "$instance_rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "plan-names gave no valid Entra resource group"
  rm -f "$bulk"/entra-list-*.json
  printf '{}\n' > "$bulk/entra-groups.json"
  while IFS=$'\t' read -r e rg; do
    if ! prov_valid_env "$e" || [[ ! "$rg" =~ ^[-a-z0-9]{1,90}$ ]]; then saf_die "plan-names gave no valid Entra records group"; fi
    entra_list "$rg" "$bulk/entra-list-$e.json"
    target="$rg"
    case "$entra_listed" in
      ok)
        history_count "$rg" "$bulk/entra-list-$e.json"
        jq --arg e "$e" '[.[] | select((.name | startswith("entra-")) and (.name | endswith("-" + $e)))]' "$bulk/entra-list-$e.json" > "$bulk/entra-list.tmp"
        mv "$bulk/entra-list.tmp" "$bulk/entra-list-$e.json"
        ;;
      missing)
        target="$instance_rg"
        printf '##vso[task.logissue type=warning]%s\n' "$rg doesn't exist yet: the Entra registrations of $e keep their records in $instance_rg until the bootstrap of the portal host environment creates it (entraEnvironments, ADR-0063; core CHANGELOG)"
        ;;
      *) ok=false ;;
    esac
    jq --arg e "$e" --arg g "$target" '. + {($e): $g}' "$bulk/entra-groups.json" > "$bulk/entra-groups.tmp"
    mv "$bulk/entra-groups.tmp" "$bulk/entra-groups.json"
  done < <(jq -r '.entraResourceGroups // {} | to_entries[] | [.key, .value] | @tsv' "$SAF_WORK/plan-names.json")
  entra_list "$instance_rg" "$bulk/entra-list-instance.json"
  case "$entra_listed" in
    ok) history_count "$instance_rg" "$bulk/entra-list-instance.json" ;;
    missing) ;;
    *) ok=false ;;
  esac
  if [ "$ok" != true ]; then
    printf '##vso[task.logissue type=warning]%s\n' "could not list the Entra records (the environments' Entra records groups and $instance_rg); the Entra plan checks every app with sign-in in this run"
    printf 'null\n' > "$bulk/entra-records.json"
    return 0
  fi
  jq -s --arg i "$instance_rg" '[.[][]] | group_by(.name)
      | map(sort_by([.timestamp, (if .group == $i then 0 else 1 end)]) | last | {name, state, group})' \
    "$bulk"/entra-list-*.json > "$bulk/entra-records.json"
  legacy="$(jq --arg i "$instance_rg" '[.[] | select(.group == $i and (.name | test("^entra-[a-z](-?[a-z0-9])+-[a-z][a-z0-9]{1,7}$"))
      and (.name | startswith("entra-portal-") | not))] | length' "$bulk/entra-records.json")"
  saf_info "  Entra records: $(jq 'length' "$bulk/entra-records.json"); of apps still in $instance_rg (they move with their registration's next deployment): $legacy"
}

# Step 8: the read model, then the revisions of the apps it names (lazy), then the read model again.
facts() {
  local -a args=(provisioning plan-facts --instance "$SAF_INSTANCE" --apps "$SAF_APPS_JSON" --env "$env_name" --bulk "$bulk"
    --images "$SAF_IMAGES_JSON" --run-id "${BUILD_BUILDID:-}" --output "$out")
  local ranges
  ranges="$(prov_fd_ranges_file "$env_name")"
  if [ -f "$ranges" ]; then args+=(--fd-ranges "$ranges"); fi
  saf_cli "${args[@]}" | saf_neutralise
}

# plan_revisions <slug> <Container App ID>: its active revisions -> revisions/<slug>.json
# ([{name, created}]), or the marker revisions/<slug>.failed (the app fails its plan).
plan_revisions() {
  local slug="$1" id="$2"
  prov_valid_slug "$slug" || saf_die "lazy.json names an invalid slug"
  if ! prov_valid_container_app_id "$id" "$sub_path"; then
    : > "$bulk/revisions/$slug.failed"
    return 0
  fi
  if prov_arm_list "$id/revisions?api-version=$API_APPS" "$bulk/revisions.raw"; then
    jq '[.[] | select(.properties.active == true) | {name, created: .properties.createdTime}]' "$bulk/revisions.raw" > "$bulk/revisions/$slug.json"
  else
    : > "$bulk/revisions/$slug.failed"
  fi
}

fd_ranges
plan_list "resource group tags" "$bulk/groups.json" group list --query '[].{name: name, tags: tags}'
lz_records
fd_state
runtime_state
host_env="$(prov_portal_host)"
if [ "$env_name" = "$host_env" ]; then entra_records; fi
facts
if [ "$(jq '.revisions | length' "$out/lazy.json")" -gt 0 ]; then
  while IFS=$'\t' read -r lazy_slug lazy_id; do
    plan_revisions "$lazy_slug" "$lazy_id"
  done < <(jq -r '.revisions[] | [.slug, .id] | @tsv' "$out/lazy.json")
  facts
fi
rm -f "$out/lazy.json"

tags_read=false
[ ! -f "$bulk/groups.json" ] || tags_read=true
if [ "$env_name" = "$host_env" ]; then
  jq -n --arg e "$env_name" --argjson t "$tags_read" --slurpfile r "$bulk/entra-records.json" --slurpfile g "$bulk/entra-groups.json" \
    '{schemaVersion: 1, environment: $e, tagsRead: $t, entraRecords: $r[0], entraGroups: $g[0]}' > "$out/plan.json"
else
  jq -n --arg e "$env_name" --argjson t "$tags_read" '{schemaVersion: 1, environment: $e, tagsRead: $t}' > "$out/plan.json"
fi
# The warnings and failures plan-facts found (its text is neutralised; slugs and fixed words).
jq -r '.warnings[] | "##vso[task.logissue type=warning]\(.)"' "$bulk/plan-facts.json"
jq -r --arg e "$env_name" '.failed[] | "##vso[task.logissue type=error]\(.slug) in \($e): \(.reason); nothing runs for it there in this run"' "$bulk/plan-facts.json"
if [ "$(jq '.failed | length' "$bulk/plan-facts.json")" -gt 0 ]; then
  printf '##vso[task.logissue type=error]%s\n' "plan_$env_name: $(jq '.failed | length' "$bulk/plan-facts.json") app(s) could not be planned; the other apps went on (statuses in the artifact plan_$env_name)"
  exit 1
fi
