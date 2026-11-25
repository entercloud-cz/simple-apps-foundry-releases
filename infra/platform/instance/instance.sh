#!/usr/bin/env bash
# instance.sh — the human-run steps of onboarding an instance, from instance.yaml (ADR-0066). HUMAN-RUN
# with the person's own `az` login (and, for Azure DevOps, their token), never by a pipeline: these
# steps create the platform identities and grant their rights (ADR-0031).
#
# Every Azure step previews by default (what-if; validate for Microsoft Graph, which has no what-if) and
# deploys only with --apply (core and ado: a plan, then apply); plan and status only read (ADR-0072: the onboarding
# plan, and where the instance stands). Each subcommand first says which right it needs. Nothing is kept in files:
# the instance's state is read from Azure (deployment outputs) and Azure DevOps (the service connections'
# issuer and subject) into a temporary directory, `platform instance inputs` turns instance.yaml and
# that state into the parameters, and the deployment uses core's parameter file
# infra/platform/instance/<template>.bicepparam (SAF_INSTANCE_JSON).
#
# Usage: instance.sh [--instance <instance.yaml>] [--apply] <subcommand> [arguments]
#   preflight                      read-only checks before anything is deployed; exit 1 on a blocking finding
#   providers                      the resource providers each environment subscription lacks; --apply registers
#                                  them (az provider register --wait); exit 1 if a registration fails
#   dns                            each Azure DNS zone of dns.zones: its name servers for the delegation, and whether
#                                  each allowed environment's provisioning identity may write records (read only);
#                                  --apply creates a missing zone (and its resource group), never changes one; exit 1
#                                  if a zone can't be read or created
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
#   ado <projects|core|config|connections|pipeline|grants|policies|all>
#                                  platform ado bootstrap plan (apply with --apply); all starts with projects, core, config
#   sync                           instance.yaml's principal and client IDs from the state (written with --apply)
#   plan [--format text|markdown|json] [--lang en|cs]
#                                  every phase and step of onboarding: who does it, its command, its runbook section
#                                  (ADR-0072); reads nothing (a valid instance file fills in its environments)
#   status [--format text|json] [--lang en|cs] [--workspace <id>]
#                                  where onboarding stands, read only: each step done, next (its exact command),
#                                  waiting (on whom), blocked (by which step) or unknown (why); the current phase and
#                                  step and the next one. --workspace: where audit-alert deployed, if not the default
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
format=""
lang=""
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
    --format)
      [ $# -ge 2 ] || die "--format needs text, markdown or json."
      format="$2"
      shift 2
      ;;
    --lang)
      [ $# -ge 2 ] || die "--lang needs en or cs."
      lang="$2"
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
  preflight | providers | dns | roles | entra-permissions | portal-registration | audit-alert | sync | plan | status) ;;
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
if [ "$cmd" != audit-alert ] && { { [ -n "$workspace" ] && [ "$cmd" != status ]; } || [ "${#action_groups[@]}" -gt 0 ]; }; then die "--workspace and --action-group apply to audit-alert only (--workspace to status too)."; fi
if [ "$cmd" != portal-registration ] && [ "${#dev_uris[@]}" -gt 0 ]; then die "--dev-redirect-uri applies to portal-registration only."; fi
if [ "$cmd" = preflight ] && [ "$apply" = true ]; then die "preflight only reads: it takes no --apply."; fi
if [ "$cmd" != plan ] && [ "$cmd" != status ] && { [ -n "$format" ] || [ -n "$lang" ]; }; then die "--format and --lang apply to plan and status only."; fi
if { [ "$cmd" = plan ] || [ "$cmd" = status ]; } && [ "$apply" = true ]; then die "$cmd only reads: it takes no --apply."; fi
case "$lang" in "" | en | cs) ;; *) die "--lang must be en or cs." ;; esac
case "$cmd:$format" in *: | plan:text | plan:markdown | plan:json | status:text | status:json) ;; *) die "--format must be text, markdown or json (status: text or json)." ;; esac
case "$pass" in 1 | 2) ;; *) die "--pass must be 1 or 2." ;; esac

# --- the CLI and the facts of instance.yaml --------------------------------------------------------
if command -v platform > /dev/null 2>&1; then
  cli=(platform)
else
  cli=(node "$core/tools/platform-cli/dist/src/cli.js")
  [ -f "${cli[1]}" ] || fail "the platform CLI is not built: ( cd $core/tools/platform-cli && npm ci && npm run build ), or put platform on PATH."
fi
platform_cli() { "${cli[@]}" "$@"; }
# report_args: --format and --lang for plan and status.
report_args=()
if [ -n "$format" ]; then report_args+=(--format "$format"); fi
if [ -n "$lang" ]; then report_args+=(--lang "$lang"); fi

# plan (ADR-0072) reads nothing; a valid instance file fills in the host and the environments.
if [ "$cmd" = plan ]; then
  plan_args=()
  if [ -f "$instance" ] && platform_cli validate instance "$instance" > /dev/null 2>&1; then plan_args+=(--instance "$instance"); fi
  platform_cli instance plan ${plan_args[@]+"${plan_args[@]}"} ${report_args[@]+"${report_args[@]}"}
  exit
fi
[ -f "$instance" ] || fail "no instance file $instance (--instance <file>; the default is ./instance.yaml)."

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

declare -A fact=()
facts_rc=0
facts_text="$(platform_cli instance facts --instance "$instance" 2> "$work/facts.err")" || facts_rc=$?
if [ "$facts_rc" -ne 0 ]; then
  # status: an invalid instance.yaml is step B01, every other step waits for it.
  if [ "$cmd" = status ]; then
    platform_cli instance status --instance "$instance" ${report_args[@]+"${report_args[@]}"}
    exit
  fi
  cat "$work/facts.err" >&2
  exit "$facts_rc"
fi
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

# --- findings (preflight, providers, dns) ---------------------------------------------------------
blocking=0
warnings=0
planned=0
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
# plan: what --apply would do (a preview's line).
plan() {
  printf 'plan   %s\n' "$*"
  planned=$((planned + 1))
}
preflight_summary() {
  say "preflight: $blocking blocking, $warnings warning(s)."
  [ "$blocking" -eq 0 ] || exit 1
}
# fix_summary <subcommand>: exit 1 on a blocking finding. A preview with work to do exits 0, as the what-if and the
# ado plans do.
fix_summary() {
  if [ "$apply" = true ]; then
    say "$1: $blocking blocking, $warnings warning(s)."
  else
    say "$1: $planned to do with --apply, $blocking blocking, $warnings warning(s)."
  fi
  if [ "$planned" -gt 0 ]; then preview_note; fi
  [ "$blocking" -eq 0 ] || exit 1
}
# envs_of <subscription>: the environments in <subscription>, each after a space.
envs_of() {
  local e in_sub=""
  for e in "${environments[@]}"; do
    if [ "$(fact_of "env.$e.subscriptionId")" = "$1" ]; then in_sub="$in_sub $e"; fi
  done
  printf '%s' "$in_sub"
}
# registered_providers <subscription>: the namespaces registered there, one per line (az's error in az.err).
registered_providers() {
  az provider list --subscription "$1" --query "[?registrationState=='Registered'].namespace" --output tsv 2> "$work/az.err"
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
# db_region_check <postgres|azureSql> <subscription> <region>: whether the subscription may create that database engine
# in the region. A subscription can be restricted from one (the test instance's Azure Sponsorship subscription: no
# PostgreSQL Flexible Server, "Provisioning is restricted in this region", ONB-1); the portal's own database is
# Azure SQL (ADR-0070). Rows, not a flat list, so --output tsv prints one line (null as None).
db_region_check() {
  local engine="$1" sub="$2" loc="$3" out reason n status
  case "$engine" in
    postgres)
      out="$(az rest --method get --url "https://management.azure.com/subscriptions/$sub/providers/Microsoft.DBforPostgreSQL/locations/$loc/capabilities?api-version=2024-08-01" \
        --query "value[0:1].[reason, length(supportedServerVersions || \`[]\`)]" --output tsv 2> /dev/null || true)"
      IFS=$'\t' read -r reason n <<< "$out" || true
      if [[ ${n:-} =~ ^[0-9]+$ ]] && [ "$n" -gt 0 ] && [ "${reason:-None}" = None ]; then
        ok "PostgreSQL Flexible Server can be created in $loc ($sub)."
      elif [[ ${n:-} =~ ^[0-9]+$ ]]; then
        block "PostgreSQL Flexible Server can't be created in $loc ($sub): ${reason:-no server version offered}. Ask for region access: a support request of type Service and subscription limits (quotas), PostgreSQL Flexible Server, region $loc (docs/runbooks/onboard-instance.md, step 2)."
      else
        warn "could not read the PostgreSQL capabilities in $loc ($sub)."
      fi
      ;;
    azureSql)
      # Verify in sandbox: ONB-1 (the answer of a subscription restricted from Azure SQL in a region).
      out="$(az rest --method get --url "https://management.azure.com/subscriptions/$sub/providers/Microsoft.Sql/locations/$loc/capabilities?api-version=2023-08-01" \
        --query '[[status, reason]]' --output tsv 2> /dev/null || true)"
      IFS=$'\t' read -r status reason <<< "$out" || true
      [ "${reason:-}" != None ] || reason=""
      if [ "${status:-}" = Available ] || [ "${status:-}" = Default ]; then
        ok "Azure SQL can be created in $loc ($sub)."
      elif [ -n "${status:-}" ]; then
        block "Azure SQL can't be created in $loc ($sub): status $status${reason:+, $reason}. Ask for region access: a support request of type Service and subscription limits (quotas), SQL Database, region $loc (docs/runbooks/onboard-instance.md, step 2)."
      else
        warn "could not read the Azure SQL capabilities in $loc ($sub)."
      fi
      ;;
  esac
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
    envs="$(envs_of "$sub")"
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
    registered="$(registered_providers "$sub" || true)"
    missing=0
    for p in "${providers[@]}"; do
      if ! grep -qixF -- "$p" <<< "$registered"; then
        block "resource provider $p is not registered in $sub: instance.sh providers --apply (or az provider register --subscription $sub --namespace $p)"
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
    # The usages API (ManagedEnvironmentCount per subscription and region; read on the test instance,
    # ONB-1). A list of rows, not `| [0]`: --output tsv prints a flat list one value per line, a row
    # tab-separated on one line, which `read` needs.
    usage="$(az rest --method get --url "https://management.azure.com/subscriptions/$sub/providers/Microsoft.App/locations/$rest/usages?api-version=2025-01-01" \
      --query "value[?name.value=='ManagedEnvironmentCount'].[currentValue, limit]" --output tsv 2> /dev/null || true)"
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
  for key in "${!fact[@]}"; do
    [[ $key == databases.* ]] || continue
    n="${fact[$key]}"
    key="${key#databases.}"
    sub="${key%%.*}"
    rest="${key#*.}"
    [[ $unreachable != *" $sub "* ]] || continue
    for p in $n; do db_region_check "$p" "$sub" "$rest"; done
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

# --- resource providers ---------------------------------------------------------------------------
cmd_providers() {
  local sub subs=() envs registered p state missing=()
  read -r -a subs <<< "$(fact_of subscriptions)"
  needs "the preview reads (Reader); --apply needs a role with */register/action (Contributor or Owner) on each environment subscription: ${subs[*]}."
  for sub in "${subs[@]}"; do
    envs="$(envs_of "$sub")"
    if ! registered="$(registered_providers "$sub")"; then
      block "could not read the resource providers of $sub (environments:$envs): $(az_error)"
      continue
    fi
    missing=()
    for p in "${providers[@]}"; do
      grep -qixF -- "$p" <<< "$registered" || missing+=("$p")
    done
    if [ "${#missing[@]}" -eq 0 ]; then
      ok "the ${#providers[@]} resource providers are registered in $sub (environments:$envs)."
      continue
    fi
    for p in ${missing[@]+"${missing[@]}"}; do
      if [ "$apply" != true ]; then
        plan "register the resource provider $p in $sub (environments:$envs)."
        continue
      fi
      say "== az provider register --subscription $sub --namespace $p --wait"
      if ! az provider register --subscription "$sub" --namespace "$p" --wait 2> "$work/az.err"; then
        block "could not register $p in $sub: $(az_error)"
        continue
      fi
      state="$(az provider show --subscription "$sub" --namespace "$p" --query registrationState --output tsv 2> "$work/az.err")" ||
        state="unreadable ($(az_error))"
      if [ "$state" = Registered ]; then
        ok "$p is Registered in $sub."
      else
        block "$p is $state in $sub after az provider register --wait: run instance.sh providers --apply again in a few minutes."
      fi
    done
  done
  fix_summary providers
}

# --- DNS zones ------------------------------------------------------------------------------------
# zone_read <subscription> <resource group> <zone>: 0 and the zone's name servers in zone_ns when it exists; else 1
# and zone_state: "group" (no such resource group), "zone" (no such zone in the group) or "error" (az.err). Only
# ARM's not-found codes count as missing: any other error creates nothing. Verify in sandbox: ONB-1 (the codes).
zone_ns=()
zone_state=""
zone_read() {
  local servers rc=0
  zone_ns=()
  servers="$(az network dns zone show --subscription "$1" --resource-group "$2" --name "$3" --query nameServers --output tsv 2> "$work/az.err")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    read -r -d '' -a zone_ns <<< "$servers" || true
    zone_state=ok
    return 0
  fi
  if grep -q '(ResourceGroupNotFound)' "$work/az.err"; then
    zone_state=group
  elif grep -q '(ResourceNotFound)' "$work/az.err"; then
    zone_state=zone
  else
    zone_state=error
  fi
  return 1
}
# delegation <zone>: the NS record set the parent zone's owner adds for <zone> (from zone_ns).
delegation() {
  if [ "${#zone_ns[@]}" -eq 0 ]; then
    warn "Azure returned no name servers for $1: read them in the portal (the zone's overview) before asking for the delegation."
    return 0
  fi
  info "the delegation of $1: the owner of its parent zone ${1#*.} adds this NS record set (for a registered domain, its registrar takes these name servers):"
  say "         ${1%%.*} NS ${zone_ns[*]}"
  say "         $1. NS ${zone_ns[*]}"
}
# zone_role_of <zone id> <zone subscription> <principal ID>: "<role> on <scope>" of the principal's first DNS Zone
# Contributor, Contributor or Owner on the zone or above (nothing when it holds none); 1 when its role assignments
# can't be listed (the error in az.err).
zone_role_of() {
  local id="$1" rows role scope s
  rows="$(az role assignment list --subscription "$2" --assignee-object-id "$3" --all --include-inherited --fill-principal-name false \
    --query "[].[roleDefinitionName, scope]" --output tsv 2> "$work/az.err")" || return 1
  # The zone or above: its own ID, a path prefix of it (group, subscription), a management group, or the root
  # (the subscription's list returns assignments at, above or below it). Verify in sandbox: ONB-1.
  while IFS=$'\t' read -r role scope; do
    case "$role" in "DNS Zone Contributor" | Contributor | Owner) ;; *) continue ;; esac
    s="${scope,,}"
    s="${s%/}"
    if [ -z "$s" ] || [ "$s" = "${id,,}" ] || [[ ${id,,} == "$s"/* ]] || [[ $s == /providers/microsoft.management/managementgroups/* ]]; then
      printf '%s on %s' "$role" "$scope"
      return 0
    fi
  done <<< "$rows"
}
# zone_roles <zone> <zone id> <zone subscription> <env>...: whether each environment's provisioning identity holds
# DNS Zone Contributor, Contributor or Owner on the zone or above (it writes the app records). Read only: the grant is
# the DNS team's step (onboarding step 2).
zone_roles() {
  local zone="$1" id="$2" zsub="$3" e file pid name found
  shift 3
  for e in "$@"; do
    if ! file="$(bootstrap_outputs "$e")"; then
      info "no bootstrap of $e yet ($(fact_of "env.$e.bootstrapDeployment")): its provisioning identity's role on $zone is checked once it exists."
      continue
    fi
    read -r pid name <<< "$(node -e '
const v = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).provisioningIdentity;
const s = (x) => (typeof x === "string" && /^[0-9A-Za-z.-]+$/.test(x) ? x : "-");
process.stdout.write(s(v && v.value && v.value.principalId) + " " + s(v && v.value && v.value.name) + "\n");' "$file")"
    if ! [[ $pid =~ ^[0-9a-fA-F-]{36}$ ]]; then
      warn "the bootstrap of $e has no provisioning identity's principal ID: its role on $zone is not checked."
      continue
    fi
    if ! found="$(zone_role_of "$id" "$zsub" "$pid")"; then
      warn "could not list the role assignments of $name ($e) for $zone: $(az_error)"
      continue
    fi
    if [ -n "$found" ]; then
      ok "$name ($e) holds $found: it may write records in $zone."
    else
      warn "$name ($e) holds no DNS Zone Contributor, Contributor or Owner on $zone or above; the DNS team grants it (onboarding step 2): az role assignment create --role \"DNS Zone Contributor\" --assignee-object-id $pid --assignee-principal-type ServicePrincipal --scope $id"
    fi
  done
}
cmd_dns() {
  local zones=() zone id zsub zrg envs=()
  read -r -a zones <<< "$(fact_of azureDnsZones)"
  needs "read access to each Azure DNS zone of dns.zones and to its role assignments; --apply needs Contributor on the zone's resource group (on its subscription when the group is created too). It grants no role: DNS Zone Contributor on a zone is the DNS team's step."
  if [ "${#zones[@]}" -eq 0 ]; then
    ok "dns.zones has no Azure DNS zone (provider: azureDns): nothing to do."
  fi
  for zone in ${zones[@]+"${zones[@]}"}; do
    id="$(fact_of "dnsZone.$zone.id")"
    zsub="$(fact_of "dnsZone.$zone.subscriptionId")"
    zrg="$(fact_of "dnsZone.$zone.resourceGroup")"
    read -r -a envs <<< "$(fact_of "dnsZone.$zone.allowedEnvironments")"
    say "== $zone ($id)"
    if [ -z "$zsub" ] || [ -z "$zrg" ]; then
      block "the azureDnsZoneId of $zone is not the resource ID of a DNS zone named $zone (/subscriptions/<id>/resourceGroups/<group>/providers/Microsoft.Network/dnszones/$zone): correct instance.yaml."
      continue
    fi
    if zone_read "$zsub" "$zrg" "$zone"; then
      ok "the zone $zone exists (resource group $zrg, subscription $zsub)."
    elif [ "$zone_state" = error ]; then
      block "could not read the zone $zone: $(az_error)"
      continue
    elif [ "$apply" != true ]; then
      if [ "$zone_state" = group ]; then
        plan "create the resource group $zrg in subscription $zsub ($host_loc, the portal host's region), then the DNS zone $zone in it (DNS zones are global)."
      else
        plan "create the DNS zone $zone in the resource group $zrg (subscription $zsub; DNS zones are global)."
      fi
      info "the name servers for the delegation and the provisioning identities' roles on $zone follow once it exists."
      continue
    else
      if [ "$zone_state" = group ]; then
        say "== az group create --subscription $zsub --name $zrg --location $host_loc"
        if ! az group create --subscription "$zsub" --name "$zrg" --location "$host_loc" --output none 2> "$work/az.err"; then
          block "could not create the resource group $zrg in $zsub: $(az_error)"
          continue
        fi
      fi
      # --if-none-match: never overwrite a zone created meanwhile.
      say "== az network dns zone create --subscription $zsub --resource-group $zrg --name $zone --if-none-match"
      if ! az network dns zone create --subscription "$zsub" --resource-group "$zrg" --name "$zone" --if-none-match --output none 2> "$work/az.err"; then
        block "could not create the zone $zone in $zrg: $(az_error)"
        continue
      fi
      if ! zone_read "$zsub" "$zrg" "$zone"; then
        block "the zone $zone can't be read after its creation: $(az_error)"
        continue
      fi
      ok "created the zone $zone (resource group $zrg, subscription $zsub)."
    fi
    delegation "$zone"
    zone_roles "$zone" "$id" "$zsub" ${envs[@]+"${envs[@]}"}
  done
  fix_summary dns
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
  needs "Cloud Application Administrator or Application Administrator in tenant $tenant, and the right to deploy into $entra_rg. Running it is the tenant's admin consent for the portal's delegated permissions and the platform CLI's (apps.read, ADR-0075): review them first (infra/entra/portal-registration.bicep)."
  file="$(host_outputs)"
  # The redirect URI is the portal's own host name (ADR-0071), known from instance.yaml; only a portal without
  # one needs pass 1's Container App address, and the CLI says so when the deployment is missing.
  if sub_outputs "$host_sub" "$dep" "$work/portal.json"; then
    args+=(--portal-outputs "$work/portal.json")
  else
    say "Note: no portal deployment $dep yet: the redirect URI comes from the portal's own host name in $instance."
  fi
  for uri in ${dev_uris[@]+"${dev_uris[@]}"}; do args+=(--dev-redirect-uri "$uri"); done
  json="$(platform_cli instance inputs portal-registration --instance "$instance" --outputs "$host=$file" ${args[@]+"${args[@]}"})"
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
    projects | core | config | connections | pipeline | grants | policies) phases=("$phase") ;;
    all)
      # projects first: the platform and apps projects every other phase reads (ADR-0069). Then core: its
      # repository and the tag protection (ADR-0067); it never pushes (instance.sh core does). Then config:
      # platform-config, seeded only while it has no commit (ADR-0069).
      phases=(projects core config connections pipeline grants policies)
      # ADR-0051: with pullRequest the connections run again once the policies exist (the Approval check goes).
      if [ "$(fact_of entraChanges)" = pullRequest ]; then phases+=(connections); fi
      ;;
    *) die "ado takes a phase: projects, core, config, connections, pipeline, grants, policies or all." ;;
  esac
  if [ "$apply" = true ]; then action=apply; fi
  local creator="Create new projects in the Azure DevOps organisation (Project Collection Administrators have it), with your own token"
  local admin="Azure DevOps Project Administrator of the platform project, with your own token (Edit policies for policies; before grants an organisation administrator adds id-$prefix-portal to the organisation, and id-$prefix-ado-automation too unless you may add users there)"
  case "$phase" in
    projects) needs "$creator." ;;
    all) needs "$creator; then $admin." ;;
    *) needs "$admin." ;;
  esac
  # The phases projects and config run before any bootstrap (onboarding step 3) and read no identity.
  if [ "$phase" = projects ] || [ "$phase" = config ]; then identity_args=(); else read_identities; fi
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
  local file dep portal args=()
  dep="$(fact_of registrationDeployment)"
  portal="$(fact_of portalDeployment)"
  needs "read access to the deployments $(fact_of "env.$host.bootstrapDeployment"), $dep and $portal; with --apply it writes $instance (commit it in a pull request)."
  file="$(host_outputs)"
  args+=(--outputs "$host=$file")
  if group_outputs "$host_sub" "$entra_rg" "$dep" "$work/registration.json"; then
    args+=(--registration "$work/registration.json")
  else
    say "Note: no portal registration yet ($dep in $entra_rg): portal.clientId stays as it is."
  fi
  if sub_outputs "$host_sub" "$portal" "$work/portal.json"; then
    args+=(--portal-outputs "$work/portal.json")
  else
    say "Note: no portal deployment yet ($portal): portal.apiBaseUrl stays as it is."
  fi
  if [ "$apply" = true ]; then args+=(--write); fi
  platform_cli instance sync --instance "$instance" "${args[@]}"
}

# --- status (ADR-0072) ----------------------------------------------------------------------------
# Read only: what the steps of `platform instance plan` depend on goes into a state directory, each deployment read
# once, and `platform instance status` evaluates it. A read that fails (no login, no right, no token) is written as
# such: that step is unknown, never a failure of this command. Nothing is kept after it ends.
st=""
status_query='{state: properties.provisioningState, outputs: properties.outputs, federation: properties.parameters.federation.value}'
# st_deployment <sub|group> <subscription> <resource group or -> <name>: one read of a deployment: its state, outputs
# and the parameter federation (a bootstrap's), .absent when it doesn't exist, else .error.
st_deployment() {
  local out="$st/deployments/$4" rc=0 args=()
  if [ "$1" = group ]; then args=(--resource-group "$3"); fi
  az deployment "$1" show --subscription "$2" ${args[@]+"${args[@]}"} --name "$4" --query "$status_query" --output json > "$out.json" 2> "$work/az.err" || rc=$?
  if [ "$rc" -eq 0 ] && grep -q '^{' "$out.json"; then return 0; fi
  rm -f "$out.json"
  if grep -Eq 'DeploymentNotFound|ResourceGroupNotFound' "$work/az.err"; then
    : > "$out.absent"
  elif [ "$rc" -eq 0 ]; then
    printf 'the answer is not a JSON object\n' > "$out.error"
  else
    az_error > "$out.error"
  fi
}
# st_outputs <deployment>: a file with the outputs of a deployment read as succeeded; 1 when it didn't succeed.
st_outputs() {
  local f="$st/deployments/$1.json" out="$work/outputs-$1.json"
  [ -f "$f" ] || return 1
  node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!j || j.state !== "Succeeded" || !j.outputs || typeof j.outputs !== "object") process.exit(1);
fs.writeFileSync(process.argv[2], JSON.stringify(j.outputs));' "$f" "$out" || return 1
  printf '%s' "$out"
}
# output_value <outputs file> <name[.key]>: a string output (one token of printable ASCII), or nothing.
output_value() {
  node -e '
const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const [name, key] = process.argv[2].split(".");
let v = o[name] && typeof o[name] === "object" && "value" in o[name] ? o[name].value : o[name];
if (key) v = v && typeof v === "object" ? v[key] : undefined;
if (typeof v === "string" && /^[\x21-\x7e]+$/.test(v)) process.stdout.write(v);' "$1" "$2"
}
status_azure() {
  local sub subs=() registered p e zone zones=() zid zsub zrg envs=() file pid found ws
  read -r -a subs <<< "$(fact_of subscriptions)"
  for sub in "${subs[@]}"; do
    if registered="$(registered_providers "$sub")"; then
      : > "$st/providers/$sub.missing"
      for p in "${providers[@]}"; do
        grep -qixF -- "$p" <<< "$registered" || printf '%s\n' "$p" >> "$st/providers/$sub.missing"
      done
    else
      az_error > "$st/providers/$sub.error"
    fi
  done
  for e in "${environments[@]}"; do
    st_deployment sub "$(fact_of "env.$e.subscriptionId")" - "$(fact_of "env.$e.bootstrapDeployment")"
    st_deployment sub "$(fact_of "env.$e.subscriptionId")" - "$(fact_of "env.$e.platformDeployment")"
  done
  st_deployment sub "$host_sub" - "$(fact_of rolesDeployment)"
  st_deployment sub "$host_sub" - "$(fact_of portalDeployment)"
  st_deployment group "$host_sub" "$entra_rg" "$(fact_of entraPermissionsDeployment)"
  st_deployment group "$host_sub" "$entra_rg" "$(fact_of registrationDeployment)"
  # The audit alert next to its workspace: --workspace, else the host's platform workspace (as audit-alert deploys it).
  ws="$workspace"
  if [ -z "$ws" ] && file="$(st_outputs "$(fact_of platformDeployment)")"; then ws="$(output_value "$file" logAnalyticsWorkspaceId)" || ws=""; fi
  if [[ $ws =~ ^/subscriptions/([^/]+)/resource[Gg]roups/([^/]+)/ ]]; then
    printf '%s\n' "$ws" > "$st/audit-alert-workspace"
    st_deployment group "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}" "$(fact_of auditAlertDeployment)"
  fi
  # The Azure DNS zones (as dns reads them) and each allowed environment's provisioning identity's role on them.
  read -r -a zones <<< "$(fact_of azureDnsZones)"
  for zone in ${zones[@]+"${zones[@]}"}; do
    zid="$(fact_of "dnsZone.$zone.id")"
    zsub="$(fact_of "dnsZone.$zone.subscriptionId")"
    zrg="$(fact_of "dnsZone.$zone.resourceGroup")"
    # An azureDnsZoneId that isn't the zone's: platform instance status says so.
    if [ -z "$zsub" ] || [ -z "$zrg" ]; then continue; fi
    if zone_read "$zsub" "$zrg" "$zone"; then
      : > "$st/dns/$zone.exists"
    elif [ "$zone_state" = error ]; then
      az_error > "$st/dns/$zone.error"
    else
      : > "$st/dns/$zone.absent"
    fi
    mkdir -p "$st/dnsroles/$zone"
    read -r -a envs <<< "$(fact_of "dnsZone.$zone.allowedEnvironments")"
    for e in ${envs[@]+"${envs[@]}"}; do
      [ -n "${fact[env.$e.bootstrapDeployment]+set}" ] || continue
      file="$(st_outputs "$(fact_of "env.$e.bootstrapDeployment")")" || continue
      pid="$(output_value "$file" provisioningIdentity.principalId)" || pid=""
      [[ $pid =~ ^[0-9a-fA-F-]{36}$ ]] || continue
      if ! found="$(zone_role_of "$zid" "$zsub" "$pid")"; then
        az_error > "$st/dnsroles/$zone/$e.error"
      elif [ -n "$found" ]; then
        printf '%s\n' "$found" > "$st/dnsroles/$zone/$e.ok"
      else
        printf '%s\n' "$pid" > "$st/dnsroles/$zone/$e.missing"
      fi
    done
  done
}
# status_ado: `platform ado bootstrap plan` of each phase (it only reads), with the bootstraps' outputs it needs.
status_ado() {
  local e p file all=true host_file="" rc
  if [ "$(fact_of scmProvider)" != azureDevOps ] || [ -z "$(fact_of organizationUrl)" ]; then
    printf 'instance.yaml scm is not an Azure DevOps organisation\n' > "$st/ado/token.error"
    return 0
  fi
  org="$(fact_of organizationUrl)"
  if [ -n "${AZURE_DEVOPS_TOKEN:-}" ]; then
    token="$AZURE_DEVOPS_TOKEN"
  else
    token="$(az account get-access-token --resource "$ado_resource" --query accessToken --output tsv 2> /dev/null || true)"
  fi
  if [ -z "$token" ]; then
    printf 'az login, or export AZURE_DEVOPS_TOKEN\n' > "$st/ado/token.error"
    return 0
  fi
  local ids=()
  for e in "${environments[@]}"; do
    if file="$(st_outputs "$(fact_of "env.$e.bootstrapDeployment")")"; then
      ids+=(--identities "$e=$file")
      if [ "$e" = "$host" ]; then host_file="$file"; fi
    else
      all=false
    fi
  done
  for p in projects core config connections pipeline grants policies; do
    identity_args=()
    case "$p" in
      projects | core | config) ;;
      connections)
        if [ "$all" != true ]; then
          printf 'not every environment has a bootstrap yet\n' > "$st/ado/$p.skipped"
          continue
        fi
        identity_args=("${ids[@]}")
        ;;
      *)
        if [ -z "$host_file" ]; then
          printf 'the portal host %s has no bootstrap yet\n' "$host" > "$st/ado/$p.skipped"
          continue
        fi
        if [ "${#ids[@]}" -gt 0 ]; then identity_args=("${ids[@]}"); fi
        ;;
    esac
    rc=0
    ado_bootstrap plan "$p" --output "$st/ado/$p.json" > "$st/ado/$p.log" 2>&1 || rc=$?
    printf '%s\n' "$rc" > "$st/ado/$p.rc"
  done
}
# status_portal: /readyz at portal.apiBaseUrl, else at https:// and the portal deployment's portalFqdn.
status_portal() {
  local url file fqdn code rc=0
  url="$(fact_of portalApiBaseUrl)"
  if [ -z "$url" ] && file="$(st_outputs "$(fact_of portalDeployment)")"; then
    fqdn="$(output_value "$file" portalFqdn)" || fqdn=""
    if [ -n "$fqdn" ]; then url="https://$fqdn"; fi
  fi
  [ -n "$url" ] || return 0
  url="${url%/}"
  printf '%s\n' "$url" > "$st/portal/url"
  code="$(curl --silent --show-error --proto '=https' --max-time 20 --output /dev/null --write-out '%{http_code}' "$url/readyz" 2> "$work/curl.err")" || rc=$?
  if [ "$rc" -eq 0 ]; then
    printf '%s\n' "$code" > "$st/portal/readyz"
  else
    tr -s '\n' ' ' < "$work/curl.err" | cut -c1-300 > "$st/portal/readyz.error"
  fi
}
cmd_status() {
  local login
  st="$work/state"
  mkdir -p "$st/deployments" "$st/providers" "$st/dns" "$st/dnsroles" "$st/ado" "$st/portal"
  {
    needs "read access only: Reader on each environment subscription and its DNS zones, and an Azure DevOps token (yours); nothing is changed."
    say "Reading Azure, Azure DevOps (platform ado bootstrap plan of each phase) and the portal: a minute or two ..."
  } >&2
  login="$(az account show --query tenantId --output tsv 2> /dev/null || true)"
  if [ -z "$login" ]; then
    printf 'not-logged-in\n' > "$st/azure"
  elif [ "${login,,}" != "$tenant" ]; then
    printf 'other-tenant %s\n' "$login" > "$st/azure"
  else
    printf 'ok\n' > "$st/azure"
    status_azure
  fi
  status_ado
  status_portal
  platform_cli instance status --instance "$instance" --state "$st" ${report_args[@]+"${report_args[@]}"}
}

case "$cmd" in
  preflight) cmd_preflight ;;
  providers) cmd_providers ;;
  dns) cmd_dns ;;
  core) cmd_core ;;
  bootstrap) cmd_bootstrap ;;
  roles) cmd_roles ;;
  entra-permissions) cmd_entra_permissions ;;
  portal-registration) cmd_portal_registration ;;
  audit-alert) cmd_audit_alert ;;
  ado) cmd_ado ;;
  sync) cmd_sync ;;
  status) cmd_status ;;
esac
