#!/usr/bin/env bash
# instance.sh — the human-run steps of onboarding an instance, from instance.yaml (ADR-0066). HUMAN-RUN
# with the person's own `az` login (and, for Azure DevOps, their token), never by a pipeline: these
# steps create the platform identities and grant their rights (ADR-0031).
#
# Every Azure step previews by default (what-if; validate for Microsoft Graph, which has no what-if) and
# deploys only with --apply (core and ado: a plan, then apply). Each subcommand first says which right it needs. Nothing is kept in files:
# the instance's state is read from Azure (deployment outputs) and Azure DevOps (the service connections'
# issuer and subject) into a temporary directory, `platform instance inputs` turns instance.yaml and
# that state into the parameters, and the deployment uses core's parameter file
# infra/platform/instance/<template>.bicepparam (SAF_INSTANCE_JSON).
#
# Usage: instance.sh [--instance <instance.yaml>] [--apply] <subcommand> [arguments]
#   preflight                      read-only checks before anything is deployed; exit 1 on a blocking finding
#   bootstrap <env> [--pass 2] [--remove-lock]
#                                  infra/platform/bootstrap.bicep in <env>'s subscription (the portal host first)
#   roles                          infra/platform/roles.bicep, from the portal host's subscription
#   entra-permissions              infra/platform/entra-permissions.bicep (Microsoft Graph)
#   portal-registration [--dev-redirect-uri <uri>]...
#                                  infra/entra/portal-registration.bicep (Microsoft Graph), after portal pass 1
#   audit-alert [--workspace <id>] [--action-group <id>]...
#                                  infra/platform/entra-audit-alert.bicep, after the host's platform pipeline
#   core [<version>]               the release <version> (default coreVersion) from coreReleases.repository:
#                                  checked (SHA256SUMS, release.json, the mirror tag's commit and files), then the
#                                  plan for the platform project's core; --apply creates it, pushes the tag (never
#                                  forced) and protects it (ADR-0067); exit 2 when core has the tag elsewhere
#   ado <core|connections|pipeline|grants|policies|all>
#                                  platform ado bootstrap plan (apply with --apply); all starts with core
#   sync                           instance.yaml's principal and client IDs from the state (written with --apply)
# The instance file defaults to ./instance.yaml. The platform CLI is `platform` on PATH, else the one of
# this core checkout (node tools/platform-cli/dist/src/cli.js, built with npm ci && npm run build).
# Runbook: docs/runbooks/onboard-instance.md.

set -euo pipefail
shopt -s inherit_errexit

core="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
params="$core/infra/platform/instance"
# Azure DevOps' application ID: the resource of a person's Azure DevOps token.
ado_resource=499b84ac-1321-427f-aa17-267ca6975798
# The notes of the ReadOnly lock as bootstrap-identities.bicep writes them (put back after a failed deployment).
lock_notes='Platform identities: blocks new federated credentials (identity hijack). Delete only to re-run infra/platform/bootstrap.bicep; the template re-creates this lock (ADR-0031).'
# The resource providers every environment subscription needs (infra/README.md, subscription prerequisites).
providers=(Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.OperationalInsights
  Microsoft.Insights Microsoft.AlertsManagement Microsoft.DBforPostgreSQL Microsoft.Sql
  Microsoft.Storage Microsoft.Network Microsoft.Cdn Microsoft.ManagedIdentity
  Microsoft.Consumption Microsoft.CostManagement Microsoft.DataProtection)

usage() {
  sed -n '/^# Usage:/,/^# Runbook:/s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"
}
die() { # usage error
  printf 'instance.sh: %s\n' "$*" >&2
  exit 2
}
fail() {
  printf 'instance.sh: %s\n' "$*" >&2
  exit 1
}
say() { printf '%s\n' "$*"; }
needs() { printf 'Needs: %s\n' "$*"; }

# --- arguments -----------------------------------------------------------------------------------
instance=./instance.yaml
apply=false
pass=1
pass_given=false
remove_lock=false
workspace=""
action_groups=()
dev_uris=()
positional=()
while [ $# -gt 0 ]; do
  case "$1" in
    --instance)
      [ $# -ge 2 ] || die "--instance needs a file."
      instance="$2"
      shift 2
      ;;
    --apply) apply=true; shift ;;
    --pass)
      [ $# -ge 2 ] || die "--pass needs 1 or 2."
      pass="$2"
      pass_given=true
      shift 2
      ;;
    --remove-lock) remove_lock=true; shift ;;
    --workspace)
      [ $# -ge 2 ] || die "--workspace needs a Log Analytics workspace's resource ID."
      workspace="$2"
      shift 2
      ;;
    --action-group)
      [ $# -ge 2 ] || die "--action-group needs an action group's resource ID."
      action_groups+=("$2")
      shift 2
      ;;
    --dev-redirect-uri)
      [ $# -ge 2 ] || die "--dev-redirect-uri needs a URI."
      dev_uris+=("$2")
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) die "unknown option $1 (instance.sh --help)." ;;
    *)
      positional+=("$1")
      shift
      ;;
  esac
done

cmd="${positional[0]:-}"
args_wanted=0
case "$cmd" in
  preflight | roles | entra-permissions | portal-registration | audit-alert | sync) ;;
  bootstrap | ado) args_wanted=1 ;;
  core) args_wanted=optional ;;
  "")
    usage >&2
    exit 2
    ;;
  *) die "unknown subcommand \"$cmd\" (instance.sh --help)." ;;
esac
if [ "$args_wanted" = optional ]; then
  [ "${#positional[@]}" -le 2 ] || die "$cmd takes at most one argument (instance.sh --help)."
else
  [ "${#positional[@]}" -eq $((args_wanted + 1)) ] || die "$cmd takes $args_wanted argument(s) (instance.sh --help)."
fi
if [ "$cmd" != bootstrap ] && { [ "$pass_given" = true ] || [ "$remove_lock" = true ]; }; then die "--pass and --remove-lock apply to bootstrap only."; fi
if [ "$cmd" != audit-alert ] && { [ -n "$workspace" ] || [ "${#action_groups[@]}" -gt 0 ]; }; then die "--workspace and --action-group apply to audit-alert only."; fi
if [ "$cmd" != portal-registration ] && [ "${#dev_uris[@]}" -gt 0 ]; then die "--dev-redirect-uri applies to portal-registration only."; fi
if [ "$cmd" = preflight ] && [ "$apply" = true ]; then die "preflight only reads: it takes no --apply."; fi
case "$pass" in 1 | 2) ;; *) die "--pass must be 1 or 2." ;; esac
[ -f "$instance" ] || fail "no instance file $instance (--instance <file>; the default is ./instance.yaml)."

# --- the CLI and the facts of instance.yaml --------------------------------------------------------
if command -v platform > /dev/null 2>&1; then
  cli=(platform)
else
  cli=(node "$core/tools/platform-cli/dist/src/cli.js")
  [ -f "${cli[1]}" ] || fail "the platform CLI is not built: ( cd $core/tools/platform-cli && npm ci && npm run build ), or put platform on PATH."
fi
platform_cli() { "${cli[@]}" "$@"; }

declare -A fact=()
facts_text="$(platform_cli instance facts --instance "$instance")"
while IFS= read -r line; do
  if [ -n "$line" ]; then fact["${line%%=*}"]="${line#*=}"; fi
done <<< "$facts_text"
fact_of() {
  [ -n "${fact[$1]+set}" ] || fail "internal: platform instance facts has no $1."
  printf '%s' "${fact[$1]}"
}
prefix="$(fact_of prefix)"
tenant="$(fact_of tenantId)"
host="$(fact_of hostEnvironment)"
read -r -a environments <<< "$(fact_of environments)"
host_sub="$(fact_of "env.$host.subscriptionId")"
host_loc="$(fact_of "env.$host.location")"
entra_rg="$(fact_of entraResourceGroup)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- reading the state ----------------------------------------------------------------------------
# A deployment that hasn't succeeded (failed, running, canceled) has no outputs to trust: it counts as absent.
succeeded_outputs="properties.provisioningState=='Succeeded' && properties.outputs"
# outputs_read <deployment> <file> <az exit code>: 0 when <file> holds the outputs; else 1, the file gone.
outputs_read() {
  if [ "$3" -eq 0 ] && grep -q '^{' "$2"; then return 0; fi
  if [ "$3" -eq 0 ]; then printf 'deployment %s has not succeeded, so its outputs are not read\n' "$1" > "$work/az.err"; fi
  rm -f "$2"
  return 1
}
# sub_outputs <subscription> <deployment> <file>: 0 and the outputs in <file> when the deployment succeeded.
sub_outputs() {
  local rc=0
  az deployment sub show --subscription "$1" --name "$2" --query "$succeeded_outputs" --output json > "$3" 2> "$work/az.err" || rc=$?
  outputs_read "$2" "$3" "$rc"
}
# group_outputs <subscription> <resource group> <deployment> <file>
group_outputs() {
  local rc=0
  az deployment group show --subscription "$1" --resource-group "$2" --name "$3" --query "$succeeded_outputs" --output json > "$4" 2> "$work/az.err" || rc=$?
  outputs_read "$3" "$4" "$rc"
}
az_error() { tr -s '\n' ' ' < "$work/az.err" | cut -c1-300; }
# bootstrap_outputs <env>: the file with <env>'s bootstrap outputs (read once), or 1 when there is no bootstrap yet.
bootstrap_outputs() {
  local file="$work/bootstrap-$1.json"
  [ -s "$file" ] || sub_outputs "$(fact_of "env.$1.subscriptionId")" "$(fact_of "env.$1.bootstrapDeployment")" "$file" || return 1
  printf '%s' "$file"
}
host_outputs() {
  bootstrap_outputs "$host" || fail "no bootstrap of the portal host environment $host yet (deployment $(fact_of "env.$host.bootstrapDeployment"), subscription $host_sub: $(az_error)): run instance.sh bootstrap $host --apply first."
}
# identity_args: --identities <env>=<file> for every environment with a bootstrap.
identity_args=()
read_identities() {
  local e file
  identity_args=()
  for e in "${environments[@]}"; do
    if file="$(bootstrap_outputs "$e")"; then
      identity_args+=(--identities "$e=$file")
    else
      say "Note: no bootstrap of $e yet ($(fact_of "env.$e.bootstrapDeployment")): not passed to platform ado bootstrap."
    fi
  done
}
# ado_prepare: the organisation (instance.yaml) and the person's Azure DevOps token (AZURE_DEVOPS_TOKEN, else
# from their az login); the token goes only into the CLI's environment, never onto a command line.
org=""
token=""
ado_prepare() {
  [ "$(fact_of scmProvider)" = azureDevOps ] || fail "instance.yaml scm.provider is not azureDevOps: instance.sh's Azure DevOps steps are for instances on Azure DevOps (ADR-0066)."
  org="$(fact_of organizationUrl)"
  [ -n "$org" ] || fail "instance.yaml has no scm.azureDevOps.organizationUrl."
  if [ -n "${AZURE_DEVOPS_TOKEN:-}" ]; then
    token="$AZURE_DEVOPS_TOKEN"
  else
    token="$(az account get-access-token --resource "$ado_resource" --query accessToken --output tsv)"
  fi
  [ -n "$token" ] || fail "no Azure DevOps token: az login, or export AZURE_DEVOPS_TOKEN."
}
# ado_bootstrap <plan|apply> <phase> [args]: platform ado bootstrap (after ado_prepare); its exit code.
ado_bootstrap() {
  local action="$1" phase="$2"
  shift 2
  AZURE_DEVOPS_TOKEN="$token" platform_cli ado bootstrap "$action" --instance "$instance" --org-url "$org" --phase "$phase" \
    ${identity_args[@]+"${identity_args[@]}"} "$@"
}

# --- deploying ------------------------------------------------------------------------------------
show_inputs() {
  say "Parameters (SAF_INSTANCE_JSON, from platform instance inputs $1):"
  say "$2"
}
# deploy_sub <template> <json> <subscription> <deployment> <location>: what-if, or create with --apply.
deploy_sub() {
  local mode=what-if out=()
  if [ "$apply" = true ]; then
    mode=create
    out=(--query properties.provisioningState --output tsv)
  fi
  show_inputs "$1" "$2"
  say "== az deployment sub $mode --name $4 (subscription $3, $5)"
  SAF_INSTANCE_JSON="$2" az deployment sub "$mode" --subscription "$3" --name "$4" --location "$5" \
    --parameters "$params/$1.bicepparam" ${out[@]+"${out[@]}"}
}
# deploy_group <template> <json> <subscription> <resource group> <deployment> <what-if|validate>
deploy_group() {
  local mode="$6" out=()
  if [ "$apply" = true ]; then mode=create; fi
  if [ "$mode" != what-if ]; then out=(--query properties.provisioningState --output tsv); fi
  show_inputs "$1" "$2"
  say "== az deployment group $mode --name $5 (subscription $3, resource group $4)"
  SAF_INSTANCE_JSON="$2" az deployment group "$mode" --subscription "$3" --resource-group "$4" --name "$5" \
    --parameters "$params/$1.bicepparam" ${out[@]+"${out[@]}"}
}
preview_note() {
  if [ "$apply" != true ]; then say "That was the preview. Read it, then run the same command with --apply."; fi
}

# --- preflight ------------------------------------------------------------------------------------
blocking=0
warnings=0
ok() { printf 'ok     %s\n' "$*"; }
info() { printf 'info   %s\n' "$*"; }
warn() {
  printf 'warn   %s\n' "$*"
  warnings=$((warnings + 1))
}
block() {
  printf 'BLOCK  %s\n' "$*"
  blocking=$((blocking + 1))
}
preflight_summary() {
  say "preflight: $blocking blocking, $warnings warning(s)."
  [ "$blocking" -eq 0 ] || exit 1
}
# caa_check <zone>: the CAA set that applies to hosts in <zone> (the zone's own, else the closest parent's).
caa_check() {
  local name="$1" records
  while [[ $name == *.* ]]; do
    records="$(dig +short CAA "$name" 2> /dev/null || true)"
    if [ -n "$records" ]; then
      if grep -Eiq '^[0-9]+ issue "digicert\.com[";]' <<< "$records"; then
        ok "CAA of $1 (at $name) allows digicert.com."
      else
        warn "CAA of $1 (at $name) doesn't allow digicert.com, which issued Front Door's managed certificates in the sandbox: the DNS team adds 0 issue \"digicert.com\" to that set (docs/runbooks/custom-domain-certificates.md, CAA records)."
      fi
      return 0
    fi
    name="${name#*.}"
  done
  ok "no CAA record for $1 or above: nothing to do."
}
cmd_preflight() {
  needs "read access only (Reader on each environment subscription); nothing is changed."
  local login caller sub subs=() zones=() envs roles registered p missing policies key rest n usage current limit zone mode scope unreachable=" "
  login="$(az account show --query tenantId --output tsv 2> /dev/null || true)"
  if [ -z "$login" ]; then
    block "not logged in to Azure: az login --tenant $tenant"
    preflight_summary
  fi
  if [ "${login,,}" != "$tenant" ]; then
    block "logged in to tenant $login, but instance.yaml tenantId is $tenant: az login --tenant $tenant"
    preflight_summary
  fi
  ok "logged in to the instance's tenant $tenant."
  caller="$(az ad signed-in-user show --query id --output tsv 2> /dev/null || true)"
  [ -n "$caller" ] || warn "the login is not a user (or Microsoft Graph can't be read): your roles are not checked."
  read -r -a subs <<< "$(fact_of subscriptions)"
  read -r -a zones <<< "$(fact_of dnsZones)"
  for sub in "${subs[@]}"; do
    envs=""
    for p in "${environments[@]}"; do
      if [ "$(fact_of "env.$p.subscriptionId")" = "$sub" ]; then envs="$envs $p"; fi
    done
    if ! az account show --subscription "$sub" --query id --output tsv > /dev/null 2>&1; then
      block "subscription $sub (environments:$envs) is not reachable with this login."
      unreachable="$unreachable$sub "
      continue
    fi
    ok "subscription $sub (environments:$envs) is reachable."
    if [ -n "$caller" ]; then
      # At the subscription and above, also through groups (an eligible PIM role shows only once active).
      # Verify in sandbox: ONB-1 (--include-groups with --assignee and --all).
      if roles="$(az role assignment list --subscription "$sub" --assignee "$caller" --all --include-inherited --include-groups \
        --query "[?scope=='/subscriptions/$sub' || scope=='/' || starts_with(scope, '/providers/Microsoft.Management')].roleDefinitionName" --output tsv 2> /dev/null)"; then
        info "your roles on $sub: $(sort -u <<< "$roles" | paste -sd, - | sed 's/,/, /g')"
        if grep -qx Owner <<< "$roles"; then
          ok "Owner on $sub: the bootstrap and the roles can be deployed."
        else
          warn "no active Owner on $sub: the bootstrap and roles.bicep need it (activate an eligible role first, or ask the subscription owners)."
        fi
      else
        warn "could not list your role assignments on $sub."
      fi
    fi
    registered="$(az provider list --subscription "$sub" --query "[?registrationState=='Registered'].namespace" --output tsv 2> /dev/null || true)"
    missing=0
    for p in "${providers[@]}"; do
      if ! grep -qix "$p" <<< "$registered"; then
        block "resource provider $p is not registered in $sub: az provider register --subscription $sub --namespace $p"
        missing=$((missing + 1))
      fi
    done
    [ "$missing" -gt 0 ] || ok "the ${#providers[@]} resource providers are registered in $sub."
    policies="$(az policy assignment list --subscription "$sub" --disable-scope-strict-match \
      --query "[].[displayName, enforcementMode, scope]" --output tsv 2> /dev/null || true)"
    if [ -n "$policies" ]; then
      info "policy assignments on $sub (read them: a Deny on public network access, regions or resource types blocks a deployment):"
      while IFS=$'\t' read -r p mode scope; do info "  $p ($mode, $scope)"; done <<< "$policies"
    else
      info "no policy assignments on $sub."
    fi
  done
  for key in "${!fact[@]}"; do
    [[ $key == managedEnvironments.* ]] || continue
    n="${fact[$key]}"
    key="${key#managedEnvironments.}"
    sub="${key%%.*}"
    rest="${key#*.}"
    [[ $unreachable != *" $sub "* ]] || continue
    # The usages API the sandbox's preflight read (ManagedEnvironmentCount, 50 per subscription and region,
    # ISO-3). Verify in sandbox: ONB-1.
    usage="$(az rest --method get --url "https://management.azure.com/subscriptions/$sub/providers/Microsoft.App/locations/$rest/usages?api-version=2025-01-01" \
      --query "value[?name.value=='ManagedEnvironmentCount'] | [0].[currentValue, limit]" --output tsv 2> /dev/null || true)"
    read -r current limit <<< "$usage" || true
    if [[ ${current:-} =~ ^[0-9]+$ ]] && [[ ${limit:-} =~ ^[0-9]+$ ]]; then
      if [ $((limit - current)) -ge "$n" ]; then
        ok "Container Apps environments in $rest ($sub): $current of $limit used; this instance needs up to $n."
      else
        warn "Container Apps environments in $rest ($sub): $current of $limit used, and this instance needs up to $n (fewer if some are its own already): ask for a quota increase."
      fi
    else
      warn "could not read the Container Apps quota (ManagedEnvironmentCount) in $rest ($sub)."
    fi
    current=""
    limit=""
  done
  if [ "${#zones[@]}" -eq 0 ]; then
    info "no dns.zones: no CAA record to check."
  elif command -v dig > /dev/null 2>&1; then
    for zone in "${zones[@]}"; do caa_check "$zone"; done
  else
    warn "dig is not installed: check the CAA records of ${zones[*]} by hand (dig +short CAA <zone>)."
  fi
  preflight_summary
}

# --- bootstrap ------------------------------------------------------------------------------------
cmd_bootstrap() {
  local env="${positional[1]}" sub loc dep rg lock json locked=false removed=false file args=()
  [ -n "${fact[env.$env.subscriptionId]+set}" ] || fail "instance.yaml has no environment $env (environments: ${environments[*]})."
  sub="$(fact_of "env.$env.subscriptionId")"
  loc="$(fact_of "env.$env.location")"
  dep="$(fact_of "env.$env.bootstrapDeployment")"
  rg="$(fact_of "env.$env.identitiesResourceGroup")"
  lock="$(fact_of identitiesLock)"
  needs "Owner of subscription $sub (environment $env): the bootstrap creates the platform identities and grants their roles (ADR-0031)."
  # The ReadOnly lock blocks every write in the identities group: checked first, removed only right before the deployment.
  if [ "$apply" = true ] && az lock show --subscription "$sub" --resource-group "$rg" --name "$lock" --output none > /dev/null 2>&1; then
    locked=true
    if [ "$remove_lock" != true ]; then
      say "The ReadOnly lock $lock is on $rg: it blocks every write there, so this deployment would fail."
      if [ "$pass" = 1 ]; then say "This environment is bootstrapped already: a re-run takes --pass 2, so its federated credentials stay."; fi
      say "Removing it is your decision. Remove it, or run again with --remove-lock; the deployment puts it back:"
      say "  az lock delete --subscription $sub --resource-group $rg --name $lock"
      exit 1
    fi
  elif [ "$remove_lock" = true ] && [ "$apply" != true ]; then
    say "Note: --remove-lock does nothing without --apply (a what-if runs with the lock in place)."
  fi
  if [ "$env" != "$host" ]; then
    file="$(host_outputs)"
    args+=(--outputs "$host=$file")
  elif [ "$pass" = 1 ]; then
    say "The portal host $host goes first: the other environments' bootstraps take its identities' principals."
  fi
  if [ "$pass" = 2 ]; then
    # The service connections' issuer and subject, read back from Azure DevOps by a plan (it changes nothing).
    say "Reading the service connections' federation from Azure DevOps (platform ado bootstrap plan --phase connections) ..."
    read_identities
    ado_prepare
    local rc=0
    ado_bootstrap plan connections --output "$work/connections.json" > "$work/connections.log" 2>&1 || rc=$?
    if [ ! -s "$work/connections.json" ]; then
      cat "$work/connections.log" >&2
      fail "platform ado bootstrap plan --phase connections read no federation (exit $rc)."
    fi
    sed -n '/^Federation for/,$p' "$work/connections.log"
    args+=(--federation "$work/connections.json")
  fi
  json="$(platform_cli instance inputs bootstrap --instance "$instance" --env "$env" --pass "$pass" ${args[@]+"${args[@]}"})"
  if [ "$locked" = true ]; then
    say "Removing the ReadOnly lock $lock from $rg (--remove-lock); the deployment puts it back at its end."
    az lock delete --subscription "$sub" --resource-group "$rg" --name "$lock"
    removed=true
  fi
  if ! deploy_sub bootstrap "$json" "$sub" "$dep" "$loc"; then
    if [ "$removed" = true ]; then
      say "The deployment failed: putting the ReadOnly lock $lock back on $rg."
      az lock create --subscription "$sub" --resource-group "$rg" --name "$lock" --lock-type ReadOnly --notes "$lock_notes" --output none ||
        say "Could not put the lock back: az lock create --subscription $sub --resource-group $rg --name $lock --lock-type ReadOnly (do it now)."
    fi
    exit 1
  fi
  preview_note
  if [ "$apply" = true ] && [ "$pass" = 1 ]; then
    say "Next: the other environments' bootstraps, instance.sh sync, then instance.sh ado connections (pass 2 needs the connections)."
  fi
}

# --- roles, Graph permissions, portal registration, audit alert -----------------------------------
cmd_roles() {
  local json
  needs "Owner or User Access Administrator on every environment subscription ($(fact_of subscriptions)); deployed from the portal host's subscription $host_sub."
  json="$(platform_cli instance inputs roles --instance "$instance")"
  deploy_sub roles "$json" "$host_sub" "$(fact_of rolesDeployment)" "$host_loc"
  preview_note
}
cmd_entra_permissions() {
  local json file
  needs "Privileged Role Administrator or Global Administrator in tenant $tenant (Microsoft Graph application permissions, the identity team), and the right to deploy into $entra_rg."
  file="$(host_outputs)"
  json="$(platform_cli instance inputs entra-permissions --instance "$instance" --outputs "$host=$file")"
  deploy_group entra-permissions "$json" "$host_sub" "$entra_rg" "$(fact_of entraPermissionsDeployment)" validate
  preview_note
}
cmd_portal_registration() {
  local json file dep args=() uri
  dep="$(fact_of portalDeployment)"
  needs "Cloud Application Administrator or Application Administrator in tenant $tenant, and the right to deploy into $entra_rg. Running it is the tenant's admin consent for the portal's delegated permissions: review them first (infra/entra/portal-registration.bicep)."
  file="$(host_outputs)"
  sub_outputs "$host_sub" "$dep" "$work/portal.json" ||
    fail "no portal deployment $dep yet (subscription $host_sub: $(az_error)): run the platform pipeline of $host until it deploys the portal's pass 1 (onboarding step 8)."
  for uri in ${dev_uris[@]+"${dev_uris[@]}"}; do args+=(--dev-redirect-uri "$uri"); done
  json="$(platform_cli instance inputs portal-registration --instance "$instance" --outputs "$host=$file" --portal-outputs "$work/portal.json" ${args[@]+"${args[@]}"})"
  deploy_group portal-registration "$json" "$host_sub" "$entra_rg" "$(fact_of registrationDeployment)" validate
  preview_note
  if [ "$apply" = true ]; then say "Next: instance.sh sync --apply (portal.clientId), in a pull request to platform-config."; fi
}
cmd_audit_alert() {
  local json file dep ws ws_loc ws_sub ws_rg args=() group
  dep="$(fact_of platformDeployment)"
  needs "the tenant's identity team with the platform team: Contributor (or Monitoring Contributor and deployment rights) on the workspace's resource group, read on the workspace; an Entra diagnostic setting that sends AuditLogs to the workspace (Security Administrator)."
  file="$(host_outputs)"
  sub_outputs "$host_sub" "$dep" "$work/platform.json" ||
    fail "no platform deployment $dep yet (subscription $host_sub: $(az_error)): run the platform pipeline of $host first (onboarding step 7)."
  if [ -n "$workspace" ]; then
    ws="$workspace"
    ws_loc="$(az resource show --ids "$ws" --query location --output tsv)"
    args+=(--workspace "$ws" --workspace-location "$ws_loc")
  else
    ws="$(az deployment sub show --subscription "$host_sub" --name "$dep" --query properties.outputs.logAnalyticsWorkspaceId.value --output tsv)"
  fi
  [[ $ws =~ ^/subscriptions/([^/]+)/resource[Gg]roups/([^/]+)/ ]] || fail "the workspace $ws is not a resource ID."
  ws_sub="${BASH_REMATCH[1]}"
  ws_rg="${BASH_REMATCH[2]}"
  for group in ${action_groups[@]+"${action_groups[@]}"}; do args+=(--action-group "$group"); done
  if [ "${#action_groups[@]}" -eq 0 ]; then
    say "Note: the alerts notify only the platform team's action group; add the identity team's with --action-group <id> (they own the alert, ADR-0023)."
  fi
  json="$(platform_cli instance inputs entra-audit-alert --instance "$instance" --outputs "$host=$file" --platform-outputs "$work/platform.json" ${args[@]+"${args[@]}"})"
  deploy_group entra-audit-alert "$json" "$ws_sub" "$ws_rg" "$(fact_of auditAlertDeployment)" what-if
  preview_note
}

# --- Azure DevOps ---------------------------------------------------------------------------------
cmd_ado() {
  local phase="${positional[1]}" action=plan phases=() p rc worst=0
  declare -A last=()
  case "$phase" in
    core | connections | pipeline | grants | policies) phases=("$phase") ;;
    all)
      # core first: its repository and the tag protection (ADR-0067); it never pushes (instance.sh core does).
      phases=(core connections pipeline grants policies)
      # ADR-0051: with pullRequest the connections run again once the policies exist (the Approval check goes).
      if [ "$(fact_of entraChanges)" = pullRequest ]; then phases+=(connections); fi
      ;;
    *) die "ado takes a phase: core, connections, pipeline, grants, policies or all." ;;
  esac
  if [ "$apply" = true ]; then action=apply; fi
  needs "Azure DevOps Project Administrator of the platform project, with your own token (Edit policies for policies; before grants an organisation administrator adds id-$prefix-portal to the organisation, and id-$prefix-ado-automation too unless you may add users there)."
  read_identities
  ado_prepare
  for p in "${phases[@]}"; do
    say "== platform ado bootstrap $action --phase $p"
    rc=0
    ado_bootstrap "$action" "$p" || rc=$?
    [ "$rc" -lt 2 ] || fail "platform ado bootstrap $action --phase $p failed (exit $rc)."
    last[$p]=$rc
  done
  for p in "${!last[@]}"; do [ "${last[$p]}" -le "$worst" ] || worst="${last[$p]}"; done
  if [ "$action" = plan ]; then say "That was the plan. Read it, then run the same command with --apply."; fi
  exit "$worst"
}

# --- core (ADR-0067) ------------------------------------------------------------------------------
# git_ado <args>: git with the person's Azure DevOps token as an HTTP header for the organisation's URLs only, from
# the environment (never on a command line), without prompting.
git_ado() {
  GIT_TERMINAL_PROMPT=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="http.${org%/}/.extraheader" \
    GIT_CONFIG_VALUE_0="AUTHORIZATION: bearer $token" git "$@"
}
# git_anon <args>: git without credentials (no helper, no prompt): the releases repository is public.
git_anon() {
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= "$@"
}
git_error() { tr -s '\n' ' ' < "$work/git.err" | cut -c1-300; }
# core_plan_print: the rows of the last platform ado bootstrap plan --phase core.
core_plan_print() { sed '/^Federation for/,$d' "$work/core-plan.log"; }
cmd_core() {
  local version repository url rel dir list f n fields manifest_version mirror_commit tag_commit outside missing
  local have_repo core_tag core_peeled core_main rc=0
  version="${positional[1]:-$(fact_of coreVersion)}"
  [[ $version =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-rc\.(0|[1-9][0-9]*))?$ ]] ||
    die "\"$version\" is not a core release (vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-rc.N)."
  needs "Azure DevOps Project Administrator of the platform project $(fact_of platformProject), with your own token: only Project Administrators may create tags in its repository core (ADR-0067). The download from the releases repository is anonymous."
  repository="$(fact_of coreReleasesRepository)"
  [ -n "$repository" ] || fail "instance.yaml has no coreReleases.repository: set it to the public releases repository (https://github.com/<owner>/<repository>, ADR-0067), in a pull request to platform-config."
  ado_prepare
  url="$(fact_of coreRepositoryUrl)"
  rel="$work/release"
  dir="$work/releases.git"
  list="saf-core-$version-pipelines.sha256"
  mkdir -p "$rel"

  # 1. Anonymous download from the GitHub Release; each file must pass SHA256SUMS (its own line, listed once).
  say "== The release $version of $repository (anonymous)"
  for f in release.json SHA256SUMS "$list"; do
    curl --fail --location --proto '=https' --proto-redir '=https' --silent --show-error --max-time 300 \
      --output "$rel/$f" "$repository/releases/download/$version/$f" 2> "$work/curl.err" ||
      fail "could not download $f of $version ($repository/releases/tag/$version: $(tr -s '\n' ' ' < "$work/curl.err" | cut -c1-200)). Is $version released there?"
  done
  : > "$rel/check.sha256"
  for f in release.json "$list"; do
    n="$(awk -v f="$f" 'NF == 2 && $2 == f' "$rel/SHA256SUMS" | wc -l)"
    [ "$n" -eq 1 ] || fail "SHA256SUMS of $version lists $f $n times, not once: do not use this release."
    awk -v f="$f" 'NF == 2 && $2 == f' "$rel/SHA256SUMS" >> "$rel/check.sha256"
  done
  (cd "$rel" && sha256sum --check --strict --quiet check.sha256) > "$work/sum.err" 2>&1 ||
    fail "the download of $version doesn't match its SHA256SUMS ($(tr -s '\n' ' ' < "$work/sum.err" | cut -c1-200)): do not use it."
  ok "release.json and $list match SHA256SUMS."

  # 2. release.json names the version and the mirror commit.
  fields="$(node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const s = (v) => (typeof v === "string" && /^[0-9A-Za-z.-]+$/.test(v) ? v : "-");
process.stdout.write(s(j.version) + " " + s(j.mirror && j.mirror.commit) + "\n");' "$rel/release.json" 2> /dev/null)" ||
    fail "release.json of $version is not JSON: do not use this release."
  read -r manifest_version mirror_commit <<< "$fields"
  [ "$manifest_version" = "$version" ] || fail "release.json names the version $manifest_version, not $version: do not use this release."
  [[ $mirror_commit =~ ^[0-9a-f]{40}$ ]] ||
    fail "release.json of $version has no mirror commit (mirror.commit): a release before ADR-0067 has no mirror tag, so it can't be taken with instance.sh core."
  ok "release.json is $version; its mirror commit is $mirror_commit."

  # 3. The tag from the releases repository (anonymous): at release.json's mirror commit.
  git -c init.defaultBranch=main init --quiet --bare "$dir"
  git_anon -C "$dir" fetch --quiet --no-tags "$repository.git" "+refs/tags/$version:refs/tags/$version" 2> "$work/git.err" ||
    fail "could not fetch the tag $version from $repository.git ($(git_error))."
  tag_commit="$(git -C "$dir" rev-parse --verify --quiet "refs/tags/$version^{commit}")" || fail "the tag $version of $repository is not a commit."
  [ "$tag_commit" = "$mirror_commit" ] ||
    fail "the tag $version of $repository is at $tag_commit, but release.json's mirror.commit is $mirror_commit: do not use this release (tell the core maintainers)."
  ok "the tag $version of $repository is at the mirror commit."

  # 4. The commit's files: regular files only, exactly the pipelines list, each with its SHA-256 (a checkout of it,
  # raw: no attribute of the person's git or of the tree converts or leaves out a file).
  git -C "$dir" ls-tree -r --full-tree "$tag_commit" > "$work/tree.txt"
  if grep -qvE $'^100(644|755) blob [0-9a-f]{40}\t' "$work/tree.txt"; then
    fail "the mirror commit of $version holds something that isn't a regular file (a symlink or a submodule): do not use it."
  fi
  cut -f2- "$work/tree.txt" | LC_ALL=C sort > "$work/paths.commit"
  cut -c67- "$rel/$list" | LC_ALL=C sort > "$work/paths.list"
  outside="$(LC_ALL=C comm -23 "$work/paths.commit" "$work/paths.list" | head -n 5 | paste -sd ' ' -)"
  [ -z "$outside" ] || fail "the mirror commit of $version has files outside the pipelines list ($outside): do not use it."
  missing="$(LC_ALL=C comm -13 "$work/paths.commit" "$work/paths.list" | head -n 5 | paste -sd ' ' -)"
  [ -z "$missing" ] || fail "the mirror commit of $version lacks files of the pipelines list ($missing): do not use it."
  mkdir -p "$work/tree" "$dir/info"
  printf '* -text !eol -filter -ident -export-ignore -export-subst !working-tree-encoding\n' > "$dir/info/attributes"
  git -C "$dir" -c core.autocrlf=false archive --format=tar "$tag_commit" | tar -x -C "$work/tree"
  (cd "$work/tree" && sha256sum --check --strict --quiet "$rel/$list") > "$work/sum.err" 2>&1 ||
    fail "the mirror commit of $version doesn't match its pipelines list ($(tr -s '\n' ' ' < "$work/sum.err" | cut -c1-200)): do not use it."
  ok "the mirror commit's $(wc -l < "$work/paths.list") files are exactly the pipelines list, each with its SHA-256."

  # 5. The platform project's core: missing, without the tag, with it at the mirror commit, or (an incident) elsewhere.
  say "== The platform project's core ($url)"
  ado_bootstrap plan core --output "$work/core-plan.json" > "$work/core-plan.log" 2>&1 || rc=$?
  if [ ! -s "$work/core-plan.json" ]; then
    cat "$work/core-plan.log" >&2
    fail "platform ado bootstrap plan --phase core read nothing (exit $rc)."
  fi
  have_repo="$(node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.stdout.write(j.core && j.core.repository ? "yes" : "no")' "$work/core-plan.json")"
  core_tag=""
  core_main=""
  if [ "$have_repo" = yes ]; then
    git_ado ls-remote "$url" > "$work/core-refs.txt" 2> "$work/git.err" || fail "could not read $url ($(git_error))."
    core_peeled="$(awk -v r="refs/tags/$version^{}" '$2 == r { print $1 }' "$work/core-refs.txt")"
    core_tag="${core_peeled:-$(awk -v r="refs/tags/$version" '$2 == r { print $1 }' "$work/core-refs.txt")}"
    core_main="$(awk '$2 == "refs/heads/main" { print $1 }' "$work/core-refs.txt")"
  fi
  if [ -n "$core_tag" ] && [ "$core_tag" != "$mirror_commit" ]; then
    say "core has the tag $version at $core_tag, not at the release's mirror commit $mirror_commit."
    say "A moved or foreign tag is an incident: nothing was pushed or changed. Find out who pushed it (the repository's"
    say "pushes and its audit log), and run no pipeline on $version until it is resolved."
    exit 2
  fi
  if [ -n "$core_tag" ]; then
    say "core has the tag $version at the release's mirror commit: nothing to push."
    if [ "$apply" != true ]; then
      core_plan_print
      exit "$rc"
    fi
    say "== platform ado bootstrap apply --phase core (the tag protection)"
    rc=0
    ado_bootstrap apply core || rc=$?
    exit "$rc"
  fi
  say "Plan: $([ "$have_repo" = yes ] || printf 'create the repository core, then ')push $repository's main as refs/heads/main (fast-forward only) and the mirror commit $mirror_commit as refs/tags/$version, never forced, then deny Force push on the tag."
  if [ "$apply" != true ]; then
    core_plan_print
    say "That was the plan. Read it, then run the same command with --apply."
    exit "$rc"
  fi

  # --apply: the repository and Create tag first, then main and the tag, then the tag's own protection.
  say "== platform ado bootstrap apply --phase core (the repository, Create tag)"
  rc=0
  ado_bootstrap apply core || rc=$?
  [ "$rc" -eq 0 ] || fail "platform ado bootstrap apply --phase core failed (exit $rc): nothing pushed. Fix the rows above, then run instance.sh core --apply again."
  # The whole history of main: a shallow one can't be pushed into an empty repository.
  git_anon -C "$dir" fetch --quiet --no-tags "$repository.git" "+refs/heads/main:refs/heads/main" 2> "$work/git.err" ||
    fail "could not fetch main from $repository.git ($(git_error)): nothing pushed."
  if git_ado -C "$dir" push --quiet "$url" "refs/heads/main:refs/heads/main" 2> "$work/git.err"; then
    ok "core's main is $repository's main."
  elif [ -n "$core_main" ]; then
    say "Note: core's main ($core_main) is not an ancestor of $repository's main, so it stays as it is (never forced): the repository has its default branch already."
  else
    fail "could not push main to $url ($(git_error)): nothing else pushed."
  fi
  git_ado -C "$dir" push --quiet "$url" "$mirror_commit:refs/tags/$version" 2> "$work/git.err" ||
    fail "could not push the tag $version to $url ($(git_error)). If someone pushed it meanwhile, run instance.sh core again: it compares the tag."
  ok "pushed the tag $version ($mirror_commit) to core."
  say "== platform ado bootstrap apply --phase core (Force push denied on the new tag)"
  rc=0
  ado_bootstrap apply core || rc=$?
  [ "$rc" -eq 0 ] || fail "the tag $version is pushed but its protection failed (exit $rc): run instance.sh ado core --apply now."
  git_ado ls-remote "$url" "refs/tags/$version" > "$work/core-refs.txt" 2> "$work/git.err" || fail "could not read $url again ($(git_error))."
  [ "$(awk -v r="refs/tags/$version" '$2 == r { print $1 }' "$work/core-refs.txt")" = "$mirror_commit" ] ||
    fail "core's tag $version is not the mirror commit after the push: treat it as an incident."
  say "core has refs/tags/$version at $mirror_commit, protected. Give Azure DevOps a minute before you rely on the deny (ADO-23)."
  say "Next: the coreVersion pull request and the platform pipelines (docs/runbooks/upgrade-instance-core.md)."
}

# --- sync -----------------------------------------------------------------------------------------
cmd_sync() {
  local file dep args=()
  dep="$(fact_of registrationDeployment)"
  needs "read access to the deployments $(fact_of "env.$host.bootstrapDeployment") and $dep; with --apply it writes $instance (commit it in a pull request)."
  file="$(host_outputs)"
  args+=(--outputs "$host=$file")
  if group_outputs "$host_sub" "$entra_rg" "$dep" "$work/registration.json"; then
    args+=(--registration "$work/registration.json")
  else
    say "Note: no portal registration yet ($dep in $entra_rg): portal.clientId stays as it is."
  fi
  if [ "$apply" = true ]; then args+=(--write); fi
  platform_cli instance sync --instance "$instance" "${args[@]}"
}

case "$cmd" in
  preflight) cmd_preflight ;;
  core) cmd_core ;;
  bootstrap) cmd_bootstrap ;;
  roles) cmd_roles ;;
  entra-permissions) cmd_entra_permissions ;;
  portal-registration) cmd_portal_registration ;;
  audit-alert) cmd_audit_alert ;;
  ado) cmd_ado ;;
  sync) cmd_sync ;;
esac
