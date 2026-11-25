#!/usr/bin/env bash
# java-archives.sh <oci layout dir> — verify stage, job `scan` (trusted; reads the image as data).
# Decides whether the scan needs Trivy's Java index DB (~1 GB): lists the file names in every
# layer of the image (`tar --list`, never extracting anything) and looks for Java archives
# (*.jar, *.war, *.ear, *.par, any case: the extensions Trivy's JAR analyzer reads). A layer with
# an unknown media type counts as "Java present" (fail safe: the DB is fetched).
# Sets the job variable SAF_SCAN_JAVA=true|false (the step's only settable variable) and prints
# only a count, never file names from the image.
#
# Why: Trivy 0.76.1 stops with FATAL "'--skip-java-db-update' cannot be specified on the first
# run" when an image contains a JAR and no Java DB is in the cache, and scan.sh must keep
# --skip-java-db-update (Trivy never downloads anything itself). Fetching the Java DB for every
# image would add ~1 GB per scan.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -eq 1 ] || { echo "usage: java-archives.sh <oci layout dir>" >&2; exit 2; }
layout="$1"
[ -f "$layout/index.json" ] || saf_die "not an OCI image layout directory"

blob() { # blob <sha256:hex> -> path inside the layout (shape checked)
  [[ "$1" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "unexpected digest in the image layout"
  printf '%s/blobs/sha256/%s' "$layout" "${1#sha256:}"
}

# oci-digest (image-digest.sh) already checked: exactly one image manifest, blobs hash correctly.
manifest="$(blob "$(jq -er '.manifests[0].digest' "$layout/index.json")")"
found=0
layers=0
while IFS=$'\t' read -r media digest; do
  layers=$((layers + 1))
  file="$(blob "$digest")"
  [ -f "$file" ] || saf_die "a layer blob is missing from the image layout"
  case "$media" in
    application/vnd.oci.image.layer.v1.tar+gzip|application/vnd.docker.image.rootfs.diff.tar.gzip)
      list=(tar --list --gzip --file "$file") ;;
    application/vnd.oci.image.layer.v1.tar+zstd)
      list=(tar --list --zstd --file "$file") ;;
    application/vnd.oci.image.layer.v1.tar|application/vnd.docker.image.rootfs.diff.tar)
      list=(tar --list --file "$file") ;;
    *)
      saf_info "Layer $layers has an unknown media type; assuming it contains Java archives."
      found=$((found + 1))
      continue ;;
  esac
  names="$SAF_WORK/java-archives.list"
  if ! timeout 600 "${list[@]}" > "$names" 2>/dev/null; then
    saf_info "Layer $layers could not be listed; assuming it contains Java archives."
    found=$((found + 1))
    continue
  fi
  count="$(grep -Eic '\.(jar|war|ear|par)$' "$names" || true)"
  found=$((found + ${count:-0}))
done < <(jq -r '.layers[] | [.mediaType, .digest] | @tsv' "$manifest")
rm -f "$SAF_WORK/java-archives.list"

if [ "$found" -gt 0 ]; then
  saf_info "Java archives in the image: $found (in $layers layer(s)); the Trivy Java DB is needed."
  echo "##vso[task.setvariable variable=SAF_SCAN_JAVA]true"
else
  saf_info "No Java archives in the image ($layers layer(s)); the Trivy Java DB is not needed."
  echo "##vso[task.setvariable variable=SAF_SCAN_JAVA]false"
fi
