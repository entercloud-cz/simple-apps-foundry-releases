# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154 # globals are shared with the sourcing script (deploy.sh, preview.sh)
# Helpers shared by deploy.sh and preview.sh (both run inside AzureCLI@2 with the environment's
# service connection). Sourced after lib.sh, never executed. Expects these globals from the caller:
#   work           scratch directory of the step
#   SAF_SLUG, SAF_ENV_NAME, SAF_SERVICE_CONNECTION, SAF_ADO_ENVIRONMENT  (template constants)
# and sets: names_param, release_param, subscription, region, prefix, env_promote_from.
# saf_bicep_pin_check is in lib.sh (shared with the provisioning scripts).

set -euo pipefail

names_param="$SAF_CORE/infra/app/delivery/names.bicepparam"
release_param="$SAF_CORE/infra/app/delivery/release.bicepparam"

# Environment from instance.yaml; az must be logged in to its subscription.
saf_environment() {
  local current
  saf_cli pipeline instance-env --instance "$SAF_CONFIG/instance.yaml" --env "$SAF_ENV_NAME" --output "$work/env.json"
  subscription="$(jq -er '.subscriptionId' "$work/env.json")"
  region="$(jq -er '.region' "$work/env.json")"
  prefix="$(jq -er '.prefix' "$work/env.json")"
  env_promote_from="$(jq -r '.promoteFrom // ""' "$work/env.json")"
  if [ "$env_promote_from" != "${SAF_PROMOTE_FROM:-}" ]; then
    saf_die "promoteFrom of $SAF_ENV_NAME in instance.yaml differs from the pipeline's environment list"
  fi
  current="$(az account show --query id --output tsv --only-show-errors)"
  [ "${current,,}" = "${subscription,,}" ] \
    || saf_die "the service connection is logged in to a different subscription than instance.yaml names for $SAF_ENV_NAME"
}

# saf_names <generation: JSON number or null> <output file>: names.bicep evaluated offline with
# `bicep snapshot`; every name comes from naming.bicep (ADR-0020).
saf_names() {
  local snapshot="${names_param%.bicepparam}.snapshot.json"
  rm -f "$snapshot"
  if ! SAF_NAMES_JSON="$(jq -nc --arg p "$prefix" --arg s "$SAF_SLUG" --arg e "$SAF_ENV_NAME" --argjson g "$1" \
        '{prefix: $p, slug: $s, environmentName: $e, generation: $g}')" \
      bicep snapshot "$names_param" --subscription-id "$subscription" --location "$region" > "$work/snapshot.log" 2>&1; then
    saf_neutralise < "$work/snapshot.log" | tail -n 20
    saf_die "bicep snapshot of names.bicepparam failed"
  fi
  mv "$snapshot" "$2"
}

saf_name_of() { # saf_name_of <snapshot file> <output name>
  jq -er --arg n "$2" '.outputs[$n] // empty' "$1"
}

# Names #1 and the release record of the environment. Sets rg, deployment, container_app,
# repository and writes $work/record.json (ARM parameters of the last release-{slug}).
saf_release_record() {
  saf_names null "$work/names.json"
  rg="$(saf_name_of "$work/names.json" appResourceGroup)"
  deployment="$(saf_name_of "$work/names.json" releaseDeployment)"
  container_app="$(saf_name_of "$work/names.json" containerApp)"
  repository="$(saf_name_of "$work/names.json" registryRepository)"
  # The template wires the service connection and environment by name at compile time; they must
  # be the names naming.bicep defines (tests/check-templates.py checks the formats offline too).
  [ "$(saf_name_of "$work/names.json" adoServiceConnection)" = "$SAF_SERVICE_CONNECTION" ] \
    || saf_die "service connection name differs from naming.bicep adoServiceConnection"
  [ "$(saf_name_of "$work/names.json" adoEnvironment)" = "$SAF_ADO_ENVIRONMENT" ] \
    || saf_die "environment name differs from naming.bicep adoEnvironment"

  if ! az deployment group show --resource-group "$rg" --name "$deployment" \
      --query '{parameters: properties.parameters, state: properties.provisioningState}' \
      --output json --only-show-errors > "$work/record-full.json" 2> "$work/record.err"; then
    if grep -Eq 'DeploymentNotFound|ResourceGroupNotFound' "$work/record.err"; then
      saf_die "bootstrap release missing: provisioning must run release.bicep first"
    fi
    saf_neutralise < "$work/record.err" | tail -n 20
    saf_die "could not read the release record $deployment in $rg"
  fi
  jq '.parameters' "$work/record-full.json" > "$work/record.json"
  saf_info "Release record: $deployment in $rg (last state $(jq -r '.state // "unknown"' "$work/record-full.json" | tr -cd 'A-Za-z'))"
}

# Names #2 with the record's generation: the environment's registry. Sets generation, registry,
# login_server, registry_id.
saf_registry() {
  generation="$(jq -er '.generation.value' "$work/record.json")"
  [[ "$generation" =~ ^[0-9]+$ ]] || saf_die "the release record has no valid generation"
  saf_names "$generation" "$work/names-registry.json"
  registry="$(saf_name_of "$work/names-registry.json" containerRegistry)"
  az acr show --name "$registry" --resource-group "$rg" --query '{loginServer: loginServer, id: id}' \
    --output json --only-show-errors > "$work/registry.json"
  login_server="$(jq -er '.loginServer' "$work/registry.json")"
  registry_id="$(jq -er '.id' "$work/registry.json")"
  [[ "$login_server" =~ ^[a-z0-9.-]+$ ]] || saf_die "unexpected login server for $registry"
  [[ "$registry_id" =~ ^/subscriptions/[^/]+/resourceGroups/[^/]+/providers/Microsoft\.ContainerRegistry/registries/[^/]+$ ]] \
    || saf_die "unexpected registry resource id for $registry"
}

# Run id and commit the Container App was last released with (tags written by release.bicep).
# Sets deployed_run (digits or empty) and deployed_commit (40 hex or empty).
saf_deployed_run() {
  az resource show --resource-group "$rg" --name "$container_app" --resource-type Microsoft.App/containerApps \
    --query '{tags: tags, image: properties.template.containers[0].image}' \
    --output json --only-show-errors > "$work/app-current.json"
  deployed_run="$(jq -r '.tags["saf-run-id"] // ""' "$work/app-current.json")"
  deployed_commit="$(jq -r '.tags["saf-commit"] // ""' "$work/app-current.json")"
  [[ "$deployed_run" =~ ^[0-9]{1,18}$ ]] || deployed_run=""
  [[ "$deployed_commit" =~ ^[0-9a-f]{40}$ ]] || deployed_commit=""
}

# True when the Container App already runs a NEWER pipeline run than this one.
saf_newer_run_deployed() {
  [ -n "$deployed_run" ] && (( 10#$deployed_run > 10#$BUILD_BUILDID ))
}
