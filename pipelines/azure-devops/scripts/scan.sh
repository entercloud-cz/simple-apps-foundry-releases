#!/usr/bin/env bash
# scan.sh <oci layout dir> — verify stage, job `scan` (trusted; never runs app code).
# Scans the OCI image layout that image-digest.sh extracted from the build job's archive and
# verified (exactly one linux/amd64 manifest, digest checked) ONCE with the pinned Trivy and the DB prepared by
# trivy-db.sh, then derives SARIF and a CycloneDX SBOM with `trivy convert`, and evaluates the
# instance gate with `platform pipeline scan-gate`. Outputs go to the artifact `scan`:
#   trivy.json, trivy.sarif, sbom.cdx.json, verdict.json.
#
# Isolation (ADR-0024, TOOL-2): Trivy runs from a fresh `mktemp -d` working directory with a
# scrubbed environment (`env -i` + an allowlist), the platform-owned --config and --ignorefile,
# and with every update and network lookup switched off. Nothing from the app repo (.trivyignore,
# trivy.yaml, TRIVY_* variables) can reach it.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -eq 1 ] || { echo "usage: scan.sh <oci layout dir>" >&2; exit 2; }
# Trivy reads an OCI image layout as a directory (--input <dir>); a tar must be a docker archive.
layout="$(realpath "$1")"
if [ ! -f "$layout/index.json" ] || [ ! -f "$layout/oci-layout" ]; then
  saf_die "not an OCI image layout directory"
fi
[ -f "$SAF_CONFIG/instance.yaml" ] || saf_die "platform-config has no instance.yaml at its root"

trivy_bin="$(command -v trivy)" || saf_die "trivy is not installed (install-tool.sh trivy)"
trivy_cache="$SAF_WORK/trivy-cache"
[ -f "$trivy_cache/db/trivy.db" ] || saf_die "the Trivy DB is not prepared (trivy-db.sh install)"
config="$SAF_DELIVERY/tools/trivy.yaml"
ignorefile="$SAF_DELIVERY/tools/trivyignore.yaml"

out="$SAF_OUT/scan"
mkdir -p "$out"

clean="$(mktemp -d)"
mkdir -p "$clean/home" "$clean/tmp"
cd "$clean"

# Scrubbed environment: only what Trivy needs to run offline.
run_trivy() {
  env -i \
    HOME="$clean/home" \
    TMPDIR="$clean/tmp" \
    PATH="/usr/bin:/bin" \
    LANG=C.UTF-8 \
    "$trivy_bin" "$@"
}

saf_info "Scanning the image with $(run_trivy --version | head -n 1)"
log="$SAF_WORK/trivy.log"
if ! run_trivy image \
    --input "$layout" \
    --cache-dir "$trivy_cache" \
    --config "$config" \
    --ignorefile "$ignorefile" \
    --skip-db-update \
    --skip-java-db-update \
    --skip-version-check \
    --disable-telemetry \
    --offline-scan \
    --no-progress \
    --scanners vuln \
    --exit-code 0 \
    --timeout 20m \
    --format json \
    --output "$out/trivy.json" > "$log" 2>&1; then
  saf_neutralise < "$log" | tail -n 40
  if grep -q "skip-java-db-update' cannot be specified on the first run" "$log"; then
    saf_die "Trivy found Java archives that java-archives.sh did not detect, and no Java DB is installed"
  fi
  saf_die "Trivy could not scan the image"
fi
saf_neutralise < "$log" | tail -n 20
# Java: Trivy 0.76.1 stops with FATAL "'--skip-java-db-update' cannot be specified on the first
# run" for an image with a JAR when no Java DB is in the cache (reproduced locally 2026-10-29).
# So the scan job runs java-archives.sh first and, only for images with Java archives, installs
# the Java DB into <cache>/java-db (trivy-db.sh install java). With it, a log4j-core 2.14.1 JAR
# is reported (CVE-2021-44228, local test). Images without Java archives scan as before.

run_trivy convert --format sarif --output "$out/trivy.sarif" "$out/trivy.json" > "$log" 2>&1 \
  || { saf_neutralise < "$log" | tail -n 20; saf_die "trivy convert to SARIF failed"; }
run_trivy convert --format cyclonedx --output "$out/sbom.cdx.json" "$out/trivy.json" > "$log" 2>&1 \
  || { saf_neutralise < "$log" | tail -n 20; saf_die "trivy convert to CycloneDX failed"; }

cd "$SAF_WS"
rm -rf "$clean"

saf_cli pipeline scan-gate \
  --trivy "$out/trivy.json" \
  --instance "$SAF_CONFIG/instance.yaml" \
  --output "$out/verdict.json"
