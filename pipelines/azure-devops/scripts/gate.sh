#!/usr/bin/env bash
# gate.sh — stage deploy_<env> of a PROMOTION environment of kind prod, before AzureCLI@2 (no
# Azure credentials are used here).
# Re-evaluates this run's Trivy findings (artifact `scan`) against TODAY's instance.yaml
# `scanning` settings with `platform pipeline scan-gate --enforce`: exit 1 when a blocking
# finding remains (blockProdPromotionOn, onlyWithAvailableFix) and when the provider is defender
# (the Defender gate is not supported by this core release; fail closed). The verdict is kept in
# the artifact release-result-<env> as gate-verdict.json.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

trivy_json="$SAF_WS/scan/trivy.json"
[ -f "$trivy_json" ] || saf_die "artifact scan has no trivy.json"
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

out="$SAF_OUT/release-result"
mkdir -p "$out"
saf_cli pipeline scan-gate \
  --trivy "$trivy_json" \
  --instance "$SAF_CONFIG/instance.yaml" \
  --output "$out/gate-verdict.json" \
  --enforce
