# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154 # globals are shared with the sourcing script (env_name, names, ...)
# Helpers of the platform pipeline scripts (scripts/platform/*.sh, ADR-0043). Sourced after
# ../lib.sh, never executed.
#
# The platform pipeline of ONE environment deploys infra/platform/environment.bicep as
# platform-{prefix}-{env} with that environment's Azure provisioning identity
# (sc-platform-provisioning-{env}), only through infra/platform/pipeline/environment.bicepparam with
# the JSON `platform environment inputs` writes. In the portal host environment it also deploys
# infra/platform/portal.bicep as portal-{prefix}-{env}, only through
# infra/platform/pipeline/portal.bicepparam with the JSON `platform environment portal-inputs`
# writes (ADR-0043 decision 10, rule E16). Every name comes from naming.bicep
# (infra/platform/pipeline/platform-names.bicep evaluated offline). Role definitions (roles.bicep), the
# platform identities (bootstrap.bicep) and the portal registration are never deployed here: a
# person does that (rule E11).
#
# Layout as in delivery and provisioning (lib.sh): core -> $(Pipeline.Workspace)/s/core,
# platform-config (self) -> s/config; this stage's artifact is written to
# $(Pipeline.Workspace)/saf-out/<artifact>.

set -euo pipefail
shopt -s inherit_errexit
set +x

# plat_env_guard: these scripts hold the provisioning identity's Azure login. A pipeline variable
# that turns on shell tracing or injects code into the CLI would leak it or run code with it:
# refuse to run with any of these exported (as prov_env_guard, rule P17).
plat_env_guard() {
  local v
  for v in SHELLOPTS BASHOPTS BASH_ENV ENV PS4 BASH_XTRACEFD NODE_OPTIONS; do
    if printenv "$v" > /dev/null; then
      printf '##vso[task.logissue type=error]%s\n' "$v is set in the environment of a platform pipeline step; refusing to run (pipeline variables must not set it)"
      exit 1
    fi
  done
}
plat_env_guard

# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SAF_INSTANCE="$SAF_CONFIG/instance.yaml"
SAF_IMAGES_JSON="$SAF_CORE/images/images.json"
export SAF_INSTANCE SAF_IMAGES_JSON

# The only parameter files the platform pipeline deploys with (tests/check-templates.py rule E05):
# the environment's and, in the portal host only, the portal's (rule E16); and the names (rule E05:
# never built by hand).
plat_env_param="$SAF_CORE/infra/platform/pipeline/environment.bicepparam"
plat_portal_param="$SAF_CORE/infra/platform/pipeline/portal.bicepparam"
plat_names_param="$SAF_CORE/infra/platform/pipeline/platform-names.bicepparam"
# The custom roles core defines (only built here, for the roles gate; a person deploys them).
plat_roles_template="$SAF_CORE/infra/platform/roles.bicep"

PLAT_DIR="$SAF_WORK/platform"
mkdir -p "$PLAT_DIR"

[ -f "$SAF_INSTANCE" ] || saf_die "platform-config has no instance.yaml at its root"

plat_valid_env() { [[ "$1" =~ ^[a-z][a-z0-9]{1,7}$ ]]; }
plat_valid_guid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; }

# plat_env_values: instance.yaml values of SAF_ENV_NAME. Sets env_name, env_kind, subscription,
# region, prefix.
plat_env_values() {
  env_name="$SAF_ENV_NAME"
  plat_valid_env "$env_name" || saf_die "SAF_ENV_NAME has an invalid shape"
  saf_cli pipeline instance-env --instance "$SAF_INSTANCE" --env "$env_name" --output "$PLAT_DIR/env.json"
  subscription="$(jq -er '.subscriptionId' "$PLAT_DIR/env.json")"
  region="$(jq -er '.region' "$PLAT_DIR/env.json")"
  prefix="$(jq -er '.prefix' "$PLAT_DIR/env.json")"
  env_kind="$(jq -er '.kind' "$PLAT_DIR/env.json")"
  plat_valid_guid "$subscription" || saf_die "instance.yaml has no valid subscriptionId for $env_name"
}

# plat_login_check: SAF_SERVICE_CONNECTION is sc-platform-provisioning-<env> and az is logged in to
# the environment's subscription (rule E03). Sets tenant.
plat_login_check() {
  local current
  [ "$SAF_SERVICE_CONNECTION" = "sc-platform-provisioning-$env_name" ] \
    || saf_die "SAF_SERVICE_CONNECTION is not sc-platform-provisioning-$env_name (template bug)"
  current="$(az account show --query id --output tsv --only-show-errors)"
  [ "${current,,}" = "${subscription,,}" ] \
    || saf_die "the service connection is logged in to a different subscription than instance.yaml names for $env_name"
  tenant="$(az account show --query tenantId --output tsv --only-show-errors)"
  plat_valid_guid "$tenant" || saf_die "az account show returned no valid tenant"
}

# plat_inputs <pass 1|2> <output>: `platform environment inputs` (schema defaults resolved, the
# saf-jobs digest of core's images.json on pass 2).
plat_inputs() {
  saf_cli environment inputs --instance "$SAF_INSTANCE" --env "$env_name" --images "$SAF_IMAGES_JSON" \
    --pass "$1" --output "$2"
}

# plat_portal_inputs <pass 1|2|auto> <output>: `platform environment portal-inputs` (the portal host
# only; schema defaults resolved; pass 2 with the saf-portal digest of core's images.json and
# portal.clientId; auto = 2 once portal.clientId is set, else 1). With SMTP basic auth in instance.yaml
# (the output's smtpPasswordSecretName), the secret's metadata in the environment vault the output
# names (environmentVault; names from platform-names.bicep, global `names`) decides
# smtpPasswordSecretExists: only `present` gives the portal identity Key Vault Secrets User on it and
# the portal its vault (ADR-0025 amendment 2026-11-14, US10.18). The deploy job reads it again, so a
# secret written or deleted after the approval fails the comparison with the approved inputs.
plat_portal_inputs() {
  local pass="$1" out="$2" secret vault state
  saf_cli environment portal-inputs --instance "$SAF_INSTANCE" --env "$env_name" --images "$SAF_IMAGES_JSON" \
    --pass "$pass" --smtp-secret absent --output "$out"
  secret="$(jq -r '.smtpPasswordSecretName' "$out")"
  [ -n "$secret" ] || return 0
  case "$(jq -r '.environmentVault' "$out")" in
    private) vault="$(plat_name "$names" environmentVaultPrivate)" ;;
    public) vault="$(plat_name "$names" environmentVaultPublic)" ;;
    *) saf_die "platform environment portal-inputs gave no environmentVault" ;;
  esac
  state="$(plat_secret_state "$vault" "$secret")"
  [ "$state" = present ] || return 0
  saf_cli environment portal-inputs --instance "$SAF_INSTANCE" --env "$env_name" --images "$SAF_IMAGES_JSON" \
    --pass "$pass" --smtp-secret present --output "$out"
}

# plat_secret_state <vault> <secret>: present | absent: whether the secret exists in that environment
# vault (in the environment's platform resource group). An ARM GET of Microsoft.KeyVault/vaults/secrets:
# control plane, metadata only, never the value, with the provisioning identity's Contributor; it
# works for the private vault too (as prov_secret_meta). A vault that doesn't exist yet (a private
# vault this run's environment deployment creates) is absent. Any other read error fails.
# Verify in sandbox: KV-9.
plat_secret_state() {
  local vault="$1" secret="$2" platform_rg err="$PLAT_DIR/secret.err" rc
  [[ "$vault" =~ ^kv[a-z0-9]{1,22}$ ]] || { echo "plat_secret_state: invalid vault name" >&2; return 1; }
  [[ "$secret" =~ ^[0-9A-Za-z-]{1,127}$ ]] || { echo "plat_secret_state: invalid secret name" >&2; return 1; }
  platform_rg="$(plat_name "$names" platformResourceGroup)"
  set +e
  az resource show --resource-group "$platform_rg" --namespace Microsoft.KeyVault --parent "vaults/$vault" \
    --resource-type secrets --name "$secret" --query id --output tsv --only-show-errors > /dev/null 2> "$err"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    printf present
    return 0
  fi
  if grep -Eq 'ResourceNotFound|SecretNotFound|ParentResourceNotFound|ResourceGroupNotFound' "$err"; then
    printf absent
    return 0
  fi
  saf_neutralise < "$err" | tail -n 10 >&2
  echo "could not read the SMTP password secret's metadata in the environment vault" >&2
  return 1
}

# plat_names <inputs> <output>: platform-names.bicep evaluated offline with `bicep snapshot` for the
# environment, its enabled modes (the keys of the inputs' networkModes) and its vaultGeneration.
plat_names() {
  local inputs="$1" out="$2" snapshot="${plat_names_param%.bicepparam}.snapshot.json"
  rm -f "$snapshot"
  if ! SAF_PLATFORM_NAMES_JSON="$(jq -c --arg p "$prefix" --arg e "$env_name" \
        '{prefix: $p, environmentName: $e, modes: (.networkModes | keys | map(select(. == "externalOnly" or . == "externalHybrid"))), vaultGeneration: .vaultGeneration}' "$inputs")" \
      bicep snapshot "$plat_names_param" --subscription-id "$subscription" --tenant-id "$tenant" --location "$region" \
      > "$PLAT_DIR/snapshot.log" 2>&1; then
    saf_neutralise < "$PLAT_DIR/snapshot.log" | tail -n 20
    saf_die "bicep snapshot of platform-names.bicepparam failed"
  fi
  mv "$snapshot" "$out"
}

# plat_env_snapshot <inputs> <output>: environment.bicepparam evaluated offline with `bicep snapshot`
# for these inputs (SAF_ENVIRONMENT_JSON): what environment.bicep would deploy, without Azure. The plan
# reads the CAEs' infrastructure subnets from its predictedResources (`platform environment
# cae-network`, rule E17).
plat_env_snapshot() {
  local inputs="$1" out="$2" snapshot="${plat_env_param%.bicepparam}.snapshot.json"
  rm -f "$snapshot"
  if ! SAF_ENVIRONMENT_JSON="$(cat "$inputs")" SAF_PORTAL_JSON='' \
      bicep snapshot "$plat_env_param" --subscription-id "$subscription" --tenant-id "$tenant" --location "$region" \
      > "$PLAT_DIR/env-snapshot.log" 2>&1; then
    saf_neutralise < "$PLAT_DIR/env-snapshot.log" | tail -n 20
    saf_die "bicep snapshot of environment.bicepparam failed"
  fi
  mv "$snapshot" "$out"
}

# plat_cae_read <resource group> <cae>: the CAE's resource JSON (`az resource show`, one line), or
# null when it doesn't exist. Any other read error fails, so the plan never takes an unreadable CAE
# for a new one (rule E17).
plat_cae_read() {
  local rg="$1" cae="$2" err="$PLAT_DIR/cae.err" json rc
  set +e
  json="$(az resource show --resource-group "$rg" --name "$cae" --resource-type Microsoft.App/managedEnvironments \
    --output json --only-show-errors 2> "$err")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      printf null
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not read the CAE $cae" >&2
    return 1
  fi
  jq -c . <<< "$json"
}

# plat_name <names file> <output name>
plat_name() {
  jq -er --arg n "$2" '.outputs[$n] // empty' "$1" || { echo "platform-names.bicep has no output $2" >&2; return 1; }
}

# plat_record <deployment> <output>: the deployment record (raw `az deployment sub show`), or no
# output file when there is none.
plat_record() {
  local name="$1" out="$2" err="$PLAT_DIR/record.err" rc
  rm -f "$out"
  set +e
  az deployment sub show --name "$name" --output json --only-show-errors > "$out.tmp" 2> "$err"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    mv "$out.tmp" "$out"
    return 0
  fi
  rm -f "$out.tmp"
  grep -q 'DeploymentNotFound' "$err" && return 0
  saf_neutralise < "$err" | tail -n 20
  saf_die "could not read the deployment record $name"
}

# plat_arm <validate|what-if|create> <environment|portal> <inputs> <deployment name> <output>: every
# `az deployment` of the platform pipeline (rule E05), at subscription scope, only with
# environment.bicepparam (the inputs in SAF_ENVIRONMENT_JSON) or, for the portal host's portal,
# portal.bicepparam (SAF_PORTAL_JSON; rule E16). Each parameter file reads only its own variable, the
# other one stays empty. create retries RBAC propagation delays (classify-deploy-error).
plat_arm() {
  local action="$1" part="$2" inputs="$3" name="$4" out="$5" err="$PLAT_DIR/arm.err" attempt=0 rc verdict
  local param env_json='' portal_json=''
  local -a delays=(30 60 120 240)
  case "$part" in
    environment) param="$plat_env_param"; env_json="$(cat "$inputs")" ;;
    portal) param="$plat_portal_param"; portal_json="$(cat "$inputs")" ;;
    *) saf_die "plat_arm: unknown part $part" ;;
  esac
  while :; do
    attempt=$((attempt + 1))
    [ "$action" != create ] || saf_info "Deploying $name (attempt $attempt)"
    set +e
    case "$action" in
      validate)
        SAF_ENVIRONMENT_JSON="$env_json" SAF_PORTAL_JSON="$portal_json" az deployment sub validate --name "$name" --location "$region" \
          --parameters "$param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      what-if)
        SAF_ENVIRONMENT_JSON="$env_json" SAF_PORTAL_JSON="$portal_json" az deployment sub what-if --name "$name" --location "$region" \
          --parameters "$param" --no-pretty-print --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create)
        SAF_ENVIRONMENT_JSON="$env_json" SAF_PORTAL_JSON="$portal_json" az deployment sub create --name "$name" --location "$region" \
          --parameters "$param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      *) saf_die "plat_arm: unknown action $action" ;;
    esac
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || return 0
    saf_neutralise < "$err" | tail -n 30
    if [ "$action" = create ]; then
      verdict="$(saf_cli pipeline classify-deploy-error --log "$err" || true)"
      if [ "$verdict" = retry ] && [ "$attempt" -le "${#delays[@]}" ]; then
        saf_info "RBAC propagation delay; retrying in ${delays[$((attempt - 1))]} s."
        sleep "${delays[$((attempt - 1))]}"
        continue
      fi
    fi
    saf_die "$action of $name failed"
  done
}

# plat_core_images_registry: coreImages.registry of instance.yaml (the source of the saf-jobs import).
plat_core_images_registry() {
  local registry
  registry="$(node -e '
    import(process.argv[1]).then((m) => {
      const r = m.loadInstanceFile(process.argv[2]).coreImages?.registry;
      process.stdout.write(typeof r === "string" ? r : "");
    }).catch(() => process.exit(1));' \
    "$SAF_CORE/tools/platform-cli/dist/src/provisioning/model.js" "$SAF_INSTANCE")"
  [[ "$registry" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] \
    || { echo "instance.yaml has no valid coreImages.registry" >&2; return 1; }
  printf '%s' "$registry"
}

# plat_jobs_digest: the saf-jobs digest core's images.json pins.
plat_jobs_digest() {
  local digest
  digest="$(jq -er '.images["saf-jobs"].digest' "$SAF_IMAGES_JSON")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "images.json has no valid saf-jobs digest" >&2; return 1; }
  printf '%s' "$digest"
}

# plat_job_state <resource group> <job> <repository> <digest>: missing | outdated | current, as
# prov_job_state: whether the job exists and runs <repository>@<digest>. Any other read error fails.
plat_job_state() {
  local rg="$1" job="$2" repo="$3" digest="$4" err="$PLAT_DIR/job.err" image rc
  set +e
  image="$(az resource show --resource-group "$rg" --name "$job" --resource-type Microsoft.App/jobs \
    --query 'properties.template.containers[0].image' --output tsv --only-show-errors 2> "$err")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      printf missing
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not read the platform job $job" >&2
    return 1
  fi
  if [[ "$image" == *"/$repo@$digest" ]]; then printf current; else printf outdated; fi
}

# plat_portal_digest: the saf-portal digest core's images.json pins (the portal host only, rule E16).
plat_portal_digest() {
  local digest
  digest="$(jq -er '.images["saf-portal"].digest' "$SAF_IMAGES_JSON")"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "images.json has no valid saf-portal digest" >&2; return 1; }
  printf '%s' "$digest"
}

# plat_app_state <resource group> <container app> <repository> <digest>: missing | outdated | current,
# as plat_job_state, for the portal's Container App (rule E16): whether it exists and runs
# <repository>@<digest>. Any other read error fails.
plat_app_state() {
  local rg="$1" app="$2" repo="$3" digest="$4" err="$PLAT_DIR/app.err" image rc
  set +e
  image="$(az resource show --resource-group "$rg" --name "$app" --resource-type Microsoft.App/containerApps \
    --query 'properties.template.containers[0].image' --output tsv --only-show-errors 2> "$err")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      printf missing
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not read the Container App $app" >&2
    return 1
  fi
  if [[ "$image" == *"/$repo@$digest" ]]; then printf current; else printf outdated; fi
}

# plat_app_ready <resource group> <container app> <minutes>: waits until the app's latest revision is
# also its latest ready revision (for the portal: its readiness probe /readyz answers), polling every
# 30 s; returns 1 when that doesn't happen in time. TODO(verify): PLAT-7, that latestReadyRevisionName
# follows the readiness probe (a revision that never gets ready leaves it on the previous one).
plat_app_ready() {
  local rg="$1" app="$2" minutes="$3" waited=0 latest ready
  while :; do
    latest="$(az resource show --resource-group "$rg" --name "$app" --resource-type Microsoft.App/containerApps \
      --query 'properties.latestRevisionName' --output tsv --only-show-errors)"
    ready="$(az resource show --resource-group "$rg" --name "$app" --resource-type Microsoft.App/containerApps \
      --query 'properties.latestReadyRevisionName' --output tsv --only-show-errors)"
    if [ -n "$latest" ] && [ "$latest" = "$ready" ]; then
      return 0
    fi
    [ "$waited" -lt $((minutes * 60)) ] || return 1
    sleep 30
    waited=$((waited + 30))
  done
}
