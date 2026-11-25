#!/usr/bin/env bash
# prepare.sh — verify stage, job `prepare` (trusted: no app code is checked out or run).
#   1. `platform pipeline validate-run`: the template parameters (SAF_PARAMS_JSON) match the
#      instance.yaml of platform-config, and the core ref is the pinned release tag.
#   2. Writes the artifact `platform-inputs`: secrets-allowlist.json, the platform-owned secret
#      scan allowlist for this app (platform-config apps/{slug}/secrets-allowlist.json, or an
#      empty one). The untrusted build job reads it from the artifact, never from the app repo.
# Env: SAF_PARAMS_JSON, SAF_SLUG, RESOURCES_REPOSITORIES_CORE_REF.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_PARAMS_JSON SAF_SLUG RESOURCES_REPOSITORIES_CORE_REF
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

saf_cli pipeline validate-run --instance "$SAF_CONFIG/instance.yaml"
saf_check_names

out="$SAF_OUT/platform-inputs"
mkdir -p "$out"
src="$SAF_CONFIG/apps/$SAF_SLUG/secrets-allowlist.json"
if [ -f "$src" ]; then
  jq -e 'type == "object" and (.entries | type == "array")' "$src" >/dev/null \
    || saf_die "apps/$SAF_SLUG/secrets-allowlist.json in platform-config is not a valid allowlist"
  cp "$src" "$out/secrets-allowlist.json"
  saf_info "Secret scan allowlist: apps/$SAF_SLUG/secrets-allowlist.json from platform-config."
else
  printf '{"version":1,"entries":[]}\n' > "$out/secrets-allowlist.json"
  saf_info "Secret scan allowlist: none in platform-config, using an empty one."
fi
