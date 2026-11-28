#!/usr/bin/env bash
# validate.sh — stage `validate`, job `validate` of the platform pipeline (ADR-0043; no credentials).
#   1. `platform environment validate-run`: the template's environment and hostEnvironment equal what
#      `platform generate` renders from instance.yaml; core is refs/tags/<coreVersion>.
#   2. `platform validate instance`, `platform generate --check`.
#   3. `platform environment inputs` (pass 2): every value environment.bicepparam needs resolves
#      (identities.entraProvisioningPrincipalId included), before any Azure call.
#   4. Portal host only: `platform environment portal-inputs --pass auto`: every value
#      portal.bicepparam needs resolves (ADR-0043 decision 10; portal.network.routeTableId fails).
# Any problem fails the stage, and then nothing else runs.
# Env: SAF_ENV_NAME, SAF_HOST_ENVIRONMENT, SAF_CORE_REF.

set -euo pipefail
# shellcheck source=plat-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/plat-lib.sh"

saf_require_env SAF_ENV_NAME SAF_HOST_ENVIRONMENT SAF_CORE_REF
plat_valid_env "$SAF_ENV_NAME" || saf_die "SAF_ENV_NAME has an invalid shape"

saf_cli environment validate-run --instance "$SAF_INSTANCE" --environment "$SAF_ENV_NAME" \
  --host-environment "$SAF_HOST_ENVIRONMENT" --core-ref "$SAF_CORE_REF"
saf_cli validate instance "$SAF_INSTANCE"
saf_cli generate --config-dir "$SAF_CONFIG" --check
saf_cli environment inputs --instance "$SAF_INSTANCE" --env "$SAF_ENV_NAME" --images "$SAF_IMAGES_JSON" \
  --pass 2 --output "$PLAT_DIR/inputs.json"
if [ "$SAF_ENV_NAME" = "$SAF_HOST_ENVIRONMENT" ]; then
  saf_cli environment portal-inputs --instance "$SAF_INSTANCE" --env "$SAF_ENV_NAME" --images "$SAF_IMAGES_JSON" \
    --pass auto --output "$PLAT_DIR/portal-inputs.json"
fi
