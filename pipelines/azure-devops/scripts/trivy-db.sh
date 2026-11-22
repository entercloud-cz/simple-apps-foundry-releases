#!/usr/bin/env bash
# trivy-db.sh resolve|install [vuln|java] — Trivy databases for the scan job, content-addressed.
#
#   vuln (default)  the vulnerability DB: tools.json trivyDb, variable SAF_TRIVY_DB_LAYER, cache
#                   saf-cache/trivy-db, files db/{trivy.db,metadata.json} in the Trivy cache dir.
#   java            the Java index DB (only when java-archives.sh found JAR/WAR/EAR/PAR files in
#                   the image; ~1 GB): tools.json trivyJavaDb, variable SAF_TRIVY_JAVA_DB_LAYER,
#                   cache saf-cache/trivy-java-db, files java-db/{trivy-java.db,metadata.json}.
#
#   resolve  Asks the DB repositories from tools.json (mirror first, then GitHub) for the current
#            manifest, fetched BY DIGEST, and picks the single DB layer (layerMediaType). Writes
#            saf-work/<db>/ref.json and sets the job variable named above to sha256:<hex>, which
#            keys the Cache@2 step that follows. Only that variable may be set (step target
#            settableVariables).
#   install  Uses the cached archive when present, otherwise fetches the layer blob BY DIGEST
#            (same repositories, in order). Re-verifies the archive's sha256 against the layer
#            digest after every restore or download (a poisoned cache entry fails closed), stores
#            it in saf-cache/<db>/<hex>.tar.gz (the Cache@2 path), extracts only the two expected
#            files into the Trivy cache dir and rejects a DB older than maxAgeHours
#            (`platform pipeline trivy-db-age`, which reads UpdatedAt from metadata.json).
#
# Trivy never downloads a DB itself: scan.sh runs with --skip-db-update --skip-java-db-update.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

kind="${2:-vuln}"
case "$kind" in
  vuln)
    tools_key=trivyDb; name=trivy-db; db_dir=db; db_file=trivy.db; variable=SAF_TRIVY_DB_LAYER
    label="Trivy DB"
    ;;
  java)
    tools_key=trivyJavaDb; name=trivy-java-db; db_dir=java-db; db_file=trivy-java.db
    variable=SAF_TRIVY_JAVA_DB_LAYER; label="Trivy Java DB"
    ;;
  *) echo "usage: trivy-db.sh resolve|install [vuln|java]" >&2; exit 2 ;;
esac

work="$SAF_WORK/$name"
cache="$SAF_WS/saf-cache/$name"
trivy_cache="$SAF_WORK/trivy-cache"
mkdir -p "$work" "$cache"

media_type="$(saf_tool_field ".$tools_key.layerMediaType")"
mapfile -t repos < <(jq -r --arg k "$tools_key" '.[$k].repositories[]' "$SAF_TOOLS_JSON")
[ "${#repos[@]}" -gt 0 ] || saf_die "tools.json $tools_key.repositories is empty"

# oras keeps no credentials here: anonymous pulls, private registry config file.
oras_cfg="$work/oras-config.json"
[ -f "$oras_cfg" ] || printf '{}\n' > "$oras_cfg"

repo_name() { # strips the tag: mirror.gcr.io/aquasec/trivy-db:2 -> mirror.gcr.io/aquasec/trivy-db
  printf '%s' "${1%:*}"
}

resolve() {
  local repo manifest_digest layer
  for repo in "${repos[@]}"; do
    saf_info "Resolving the $label in $repo"
    if ! manifest_digest="$(oras resolve --registry-config "$oras_cfg" "$repo" 2>"$work/resolve.err")"; then
      saf_neutralise < "$work/resolve.err" | tail -n 5
      continue
    fi
    [[ "$manifest_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || continue
    # Fetch the manifest by digest, so its content is verified against the digest.
    if ! oras manifest fetch --registry-config "$oras_cfg" --output "$work/manifest.json" \
        "$(repo_name "$repo")@$manifest_digest" 2>"$work/resolve.err"; then
      saf_neutralise < "$work/resolve.err" | tail -n 5
      continue
    fi
    layer="$(jq -r --arg mt "$media_type" '[.layers[] | select(.mediaType == $mt)] | if length == 1 then .[0].digest else empty end' "$work/manifest.json")"
    if [[ ! "$layer" =~ ^sha256:[0-9a-f]{64}$ ]]; then
      saf_info "No single $label layer in $repo; trying the next repository."
      continue
    fi
    jq -n --arg repo "$repo" --arg manifest "$manifest_digest" --arg layer "$layer" \
      --argjson manifestJson "$(cat "$work/manifest.json")" \
      '{repository: $repo, manifestDigest: $manifest, layerDigest: $layer, created: ($manifestJson.annotations["org.opencontainers.image.created"] // null)}' \
      > "$work/ref.json"
    saf_info "$label layer $layer from $repo"
    echo "##vso[task.setvariable variable=$variable]$layer"
    return 0
  done
  saf_die "the $label could not be resolved from any repository in tools.json"
}

verify_blob() { # verify_blob <file> <hex>
  [ -f "$1" ] && printf '%s  %s\n' "$2" "$1" | sha256sum --check --strict --status -
}

install() {
  local layer hex blob repo tmp
  [ -f "$work/ref.json" ] || saf_die "run 'trivy-db.sh resolve $kind' first"
  layer="$(jq -er '.layerDigest' "$work/ref.json")"
  [[ "$layer" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "invalid DB layer digest in ref.json"
  hex="${layer#sha256:}"
  blob="$cache/$hex.tar.gz"

  # Keep only the archive for this digest in the cached directory.
  find "$cache" -mindepth 1 -maxdepth 1 ! -name "$hex.tar.gz" -exec rm -rf {} +

  if verify_blob "$blob" "$hex"; then
    saf_info "$label restored from the pipeline cache and re-verified ($layer)."
  else
    rm -f "$blob"
    tmp="$work/db.tar.gz.part"
    for repo in "$(jq -r '.repository' "$work/ref.json")" "${repos[@]}"; do
      rm -f "$tmp"
      saf_info "Fetching the $label blob $layer from $(repo_name "$repo")"
      if oras blob fetch --registry-config "$oras_cfg" --output "$tmp" "$(repo_name "$repo")@$layer" 2>"$work/fetch.err" \
          && verify_blob "$tmp" "$hex"; then
        mv "$tmp" "$blob"
        break
      fi
      saf_neutralise < "$work/fetch.err" | tail -n 5
    done
    verify_blob "$blob" "$hex" || saf_die "the $label blob could not be fetched and verified from any repository"
    saf_info "$label fetched and verified ($layer)."
  fi

  # Extract only the two expected regular files.
  rm -rf "${trivy_cache:?}/$db_dir"
  mkdir -p "$trivy_cache/$db_dir"
  local entry
  while IFS= read -r entry; do
    case "${entry#./}" in
      "$db_file"|metadata.json) ;;
      *) saf_die "the $label archive contains an unexpected entry" ;;
    esac
  done < <(tar --list --gzip --file "$blob")
  if tar --list --verbose --gzip --file "$blob" | grep -qv '^-'; then
    saf_die "the $label archive contains a non-regular file"
  fi
  tar --extract --gzip --no-same-owner --no-same-permissions --file "$blob" --directory "$trivy_cache/$db_dir"
  if [ ! -f "$trivy_cache/$db_dir/$db_file" ] || [ ! -f "$trivy_cache/$db_dir/metadata.json" ]; then
    saf_die "the $label archive lacks $db_file or metadata.json"
  fi

  saf_cli pipeline trivy-db-age \
    --metadata "$trivy_cache/$db_dir/metadata.json" \
    --max-age-hours "$(saf_tool_field ".$tools_key.maxAgeHours")"
  cp "$trivy_cache/$db_dir/metadata.json" "$work/metadata.json"
}

case "${1:-}" in
  resolve) resolve ;;
  install) install ;;
  *) echo "usage: trivy-db.sh resolve|install [vuln|java]" >&2; exit 2 ;;
esac
