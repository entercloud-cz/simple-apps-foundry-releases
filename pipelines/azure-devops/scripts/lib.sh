# shellcheck shell=bash
# Shared helpers for the app delivery scripts (pipelines/azure-devops/scripts/*.sh). Sourced, never
# executed. Every script runs with `set -euo pipefail`.
#
# Layout (contract): every job checks out core to $(Pipeline.Workspace)/s/core, platform-config
# (self) to s/config and the app repo to s/app. Tools are installed by install-tool.sh into
# $(Agent.ToolsDirectory)/saf/bin. Scripts put that directory first on PATH themselves: the
# `##vso[task.prependpath]` command is blocked for steps with `settableVariables: none`.
#
# Untrusted values (branch names, platform.yaml content, docker and Trivy output) never reach a
# script as a `$(...)` macro; they arrive as environment variables or files, and anything printed
# from them goes through saf_neutralise so Azure DevOps never reads it as a logging command.

set -euo pipefail

SAF_WS="${PIPELINE_WORKSPACE:?PIPELINE_WORKSPACE is not set (not running on an Azure Pipelines agent?)}"
SAF_CORE="$SAF_WS/s/core"
SAF_CONFIG="$SAF_WS/s/config"
SAF_APP="$SAF_WS/s/app"
# The delivery templates directory this script belongs to (core checkout at the pinned tag).
SAF_DELIVERY="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SAF_TOOLS_JSON="$SAF_DELIVERY/tools/tools.json"
SAF_CLI="$SAF_CORE/tools/platform-cli/dist/src/cli.js"
SAF_TOOLS_HOME="${AGENT_TOOLSDIRECTORY:?AGENT_TOOLSDIRECTORY is not set}/saf"
SAF_BIN="$SAF_TOOLS_HOME/bin"
# Outputs that become pipeline artifacts live under $(Pipeline.Workspace)/saf-out/<artifact>.
SAF_OUT="$SAF_WS/saf-out"
# Scratch space for one job.
SAF_WORK="$SAF_WS/saf-work"
export SAF_WS SAF_CORE SAF_CONFIG SAF_APP SAF_DELIVERY SAF_TOOLS_JSON SAF_CLI SAF_TOOLS_HOME SAF_BIN SAF_OUT SAF_WORK

case ":$PATH:" in
  *":$SAF_BIN:"*) ;;
  *) PATH="$SAF_BIN:$PATH" ;;
esac
export PATH

mkdir -p "$SAF_BIN" "$SAF_OUT" "$SAF_WORK"

# Rewrites `##` so Azure DevOps never interprets untrusted text as a logging or formatting command
# (same rule as the platform CLI: `##vso[` -> `#<ZWSP>#vso[`).
saf_neutralise() {
  sed -e 's/##/#\xe2\x80\x8b#/g'
}

# Fixed-text error for the run summary, then exit 1. Never pass untrusted text to this function.
saf_die() {
  printf '##vso[task.logissue type=error]%s\n' "$*"
  exit 1
}

# Fixed-text warning for the run summary. Never pass untrusted text to this function.
saf_warn() {
  printf '##vso[task.logissue type=warning]%s\n' "$*"
}

saf_info() {
  printf '%s\n' "$*"
}

# Runs the platform CLI. Its own output is already neutralised (contract).
saf_cli() {
  [ -f "$SAF_CLI" ] || saf_die "platform CLI is not built ($SAF_CLI)"
  node "$SAF_CLI" "$@"
}

# Value from tools.json, e.g. saf_tool_field '.trivyDb.maxAgeHours'.
saf_tool_field() {
  jq -er "$1" "$SAF_TOOLS_JSON"
}

# az must use the pinned, verified bicep (tools.json). AzureCLI@2 runs with its own
# AZURE_CONFIG_DIR, so the setting is made here, inside the task. Used by delivery (deploy.sh,
# preview.sh) and provisioning.
saf_bicep_pin_check() {
  local pin
  pin="$(saf_tool_field '.tools.bicep.version')"
  [ "$(command -v bicep)" = "$SAF_BIN/bicep" ] || saf_die "the pinned bicep is not first on PATH"
  az config set bicep.use_binary_from_path=true bicep.check_version=false --only-show-errors >/dev/null
  bicep --version | grep -Fq "$pin" || saf_die "bicep does not report the pinned version $pin"
  az bicep version --only-show-errors 2>&1 | grep -Fq "$pin" || saf_die "az bicep does not use the pinned bicep $pin"
}

# saf_require_env NAME... : fail when an expected environment variable is missing or empty.
saf_require_env() {
  local name
  for name in "$@"; do
    if [ -z "${!name:-}" ]; then
      saf_die "environment variable $name is not set (template bug)"
    fi
  done
}

# Slug and environment names are checked by `platform pipeline validate-run` in the prepare job;
# scripts re-check the shape before using them in paths or names.
saf_check_names() {
  [[ "${SAF_SLUG:-}" =~ ^[a-z](-?[a-z0-9])+$ ]] || saf_die "SAF_SLUG has an invalid shape"
  if [ -n "${SAF_ENV_NAME:-}" ]; then
    [[ "$SAF_ENV_NAME" =~ ^[a-z][a-z0-9]{1,7}$ ]] || saf_die "SAF_ENV_NAME has an invalid shape"
  fi
}

# saf_extract_oci <image.oci.tar> <empty dir>
# Extracts an OCI image layout tar produced by the (untrusted) build job. Only regular files and
# directories with the OCI layout names are accepted, so the archive can't write outside <dir>
# (no links, no devices, no absolute or `..` paths).
saf_extract_oci() {
  local tar_file="$1" dest="$2" listing line name
  [ -f "$tar_file" ] || saf_die "image archive not found: $tar_file"
  mkdir -p "$dest"
  [ -z "$(ls -A "$dest")" ] || saf_die "OCI extraction target is not empty: $dest"
  listing="$(mktemp)"
  # Member types: the first character of each verbose line (- file, d directory).
  tar --list --verbose --numeric-owner --file "$tar_file" > "$listing"
  while IFS= read -r line; do
    case "${line:0:1}" in
      -|d) ;;
      *) saf_die "image archive contains a link or special file; refusing to extract" ;;
    esac
  done < "$listing"
  # Member names, one per line, checked against the OCI image layout.
  tar --list --file "$tar_file" > "$listing"
  while IFS= read -r name; do
    name="${name#./}"
    name="${name%/}"
    case "$name" in
      ''|oci-layout|index.json|manifest.json|blobs|blobs/sha256) ;;
      blobs/sha256/*)
        [[ "${name#blobs/sha256/}" =~ ^[0-9a-f]{64}$ ]] || saf_die "image archive contains an unexpected blob name"
        ;;
      *) saf_die "image archive contains an unexpected path; only an OCI image layout is accepted" ;;
    esac
  done < "$listing"
  rm -f "$listing"
  tar --extract --no-same-owner --no-same-permissions --file "$tar_file" --directory "$dest"
  if [ ! -f "$dest/oci-layout" ] || [ ! -f "$dest/index.json" ]; then
    saf_die "image archive is not an OCI image layout"
  fi
}
