#!/usr/bin/env bash
# image-digest.sh <image.oci.tar> <layout dir> <digest file>
# Extracts the OCI image layout produced by the build job (only layout paths, no links) and
# writes its manifest digest, as computed by `platform pipeline oci-digest`: exactly one
# linux/amd64 image manifest whose blob hashes to the descriptor digest. Used by the scan job
# (authoritative digest of the scanned image) and the deploy job (re-checks the artifact it
# pushes against the digest in the release manifest).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -eq 3 ] || { echo "usage: image-digest.sh <image.oci.tar> <layout dir> <digest file>" >&2; exit 2; }
tar_file="$1"
layout="$2"
digest_file="$3"

saf_extract_oci "$tar_file" "$layout"
digest="$(saf_cli pipeline oci-digest "$layout")"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "oci-digest returned no sha256 digest"
mkdir -p "$(dirname "$digest_file")"
printf '%s\n' "$digest" > "$digest_file"
saf_info "Image digest: $digest"
