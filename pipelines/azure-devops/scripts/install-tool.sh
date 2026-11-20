#!/usr/bin/env bash
# install-tool.sh <tool>...  — the ONLY script in the delivery templates that downloads anything
# (ADR-0024; tests/check-templates.py rule T13 enforces it).
#
# For each tool named in tools/tools.json:
#   1. refuses a version on the denylist (Trivy 0.69.4-0.69.6, CVE-2026-33634);
#   2. downloads the pinned URL over HTTPS only (curl --proto '=https', redirects too);
#   3. checks the pinned SHA-256 (sha256sum --check --strict) and fails closed on a mismatch;
#   4. where the tool publishes a Sigstore bundle, verifies it with the pinned cosign
#      (exact certificate identity and OIDC issuer; buildx publishes an SLSA provenance
#      attestation, verified with verify-blob-attestation);
#   5. installs into $(Agent.ToolsDirectory)/saf and links the binary into
#      $(Agent.ToolsDirectory)/saf/bin, then asserts the binary reports the pinned version.
# Callers put saf/bin first on PATH themselves (lib.sh); this script emits no logging commands.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

[ "$#" -ge 1 ] || { echo "usage: install-tool.sh <tool>..." >&2; exit 2; }
command -v jq >/dev/null || saf_die "jq is required on the agent"
command -v sha256sum >/dev/null || saf_die "sha256sum is required on the agent"

field() { # field <tool> <jq path below the tool entry>
  jq -r --arg t "$1" ".tools[\$t]$2 // empty" "$SAF_TOOLS_JSON"
}

download() { # download <https url> <output file>
  curl --fail --proto '=https' --proto-redir '=https' --tlsv1.2 --location \
    --silent --show-error --retry 3 --retry-delay 5 --connect-timeout 20 --max-time 600 \
    --output "$2" "$1"
}

install_one() {
  local tool="$1" version url sha archive binary marker tmp file bundle
  version="$(field "$tool" .version)"
  url="$(field "$tool" .url)"
  sha="$(field "$tool" .sha256)"
  archive="$(field "$tool" .archive)"
  binary="$(field "$tool" .binary)"
  archive="${archive:-none}"

  if [ -z "$version" ] || [ -z "$url" ] || [ -z "$sha" ] || [ -z "$binary" ]; then
    saf_die "tools.json: $tool needs version, url, sha256 and binary"
  fi
  [[ "$url" == https://* ]] || saf_die "tools.json: $tool url must be https"
  [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || saf_die "tools.json: $tool sha256 must be 64 lowercase hex characters"
  [[ "$binary" != /* && "$binary" != *..* ]] || saf_die "tools.json: $tool binary must be a relative path"
  if jq -e --arg t "$tool" --arg v "$version" '(.denylist[$t] // []) | index($v)' "$SAF_TOOLS_JSON" >/dev/null; then
    saf_die "tools.json: $tool $version is on the denylist (compromised release); refusing to install"
  fi

  marker="$SAF_TOOLS_HOME/.installed/$tool-$version-$sha"
  if [ -f "$marker" ]; then
    saf_info "$tool $version already installed and verified."
    return 0
  fi

  if [ -n "$(field "$tool" .sigstore.bundleUrl)" ]; then
    [ "$tool" != cosign ] || saf_die "tools.json: cosign is verified by checksum only, not by itself"
    install_one cosign
  fi

  tmp="$(mktemp -d)"
  file="$tmp/download"
  saf_info "Downloading $tool $version"
  download "$url" "$file" || saf_die "download of $tool failed"
  printf '%s  %s\n' "$sha" "$file" | sha256sum --check --strict - \
    || saf_die "SHA-256 mismatch for $tool $version: the download does not match the pin in tools.json"

  if [ -n "$(field "$tool" .sigstore.bundleUrl)" ]; then
    verify_sigstore "$tool" "$file" "$tmp/bundle.sigstore.json"
  fi

  local root="$SAF_TOOLS_HOME/opt/$tool-$version"
  rm -rf "$root"
  mkdir -p "$root"
  case "$archive" in
    tar.gz)
      tar --extract --gzip --no-same-owner --file "$file" --directory "$root"
      ;;
    none)
      install -m 0755 "$file" "$root/$binary"
      ;;
    *) saf_die "tools.json: $tool archive must be tar.gz or none" ;;
  esac
  [ -f "$root/$binary" ] || saf_die "$tool: $binary not found after installation"
  chmod 0755 "$root/$binary"
  ln -sfn "$root/$binary" "$SAF_BIN/$(basename "$binary")"
  local link
  while IFS= read -r link; do
    [ -n "$link" ] || continue
    [[ "$link" != /* && "$link" != *..* ]] || saf_die "tools.json: $tool links must be relative paths"
    [ -e "$root/$link" ] || saf_die "$tool: $link not found after installation"
    ln -sfn "$root/$link" "$SAF_BIN/$(basename "$link")"
  done < <(jq -r --arg t "$tool" '.tools[$t].links // [] | .[]' "$SAF_TOOLS_JSON")

  # The installed binary must report the pinned version.
  local -a version_args=()
  mapfile -t version_args < <(jq -r --arg t "$tool" '.tools[$t].versionArgs // ["--version"] | .[]' "$SAF_TOOLS_JSON")
  local reported
  reported="$("$SAF_BIN/$(basename "$binary")" "${version_args[@]}" 2>&1 | head -n 20 || true)"
  grep -Fq -- "$version" <<<"$reported" \
    || saf_die "$tool does not report version $version after installation"

  rm -rf "$tmp"
  mkdir -p "$(dirname "$marker")"
  : > "$marker"
  saf_info "$tool $version installed (sha256 verified$( [ -n "$(field "$tool" .sigstore.bundleUrl)" ] && printf ', Sigstore bundle verified'))."
}

verify_sigstore() { # verify_sigstore <tool> <file> <bundle path>
  local tool="$1" file="$2" bundle="$3" bundle_url identity identity_re issuer att_type repo ref
  bundle_url="$(field "$tool" .sigstore.bundleUrl)"
  identity="$(field "$tool" .sigstore.certificateIdentity)"
  identity_re="$(field "$tool" .sigstore.certificateIdentityRegexp)"
  issuer="$(field "$tool" .sigstore.certificateOidcIssuer)"
  att_type="$(field "$tool" .sigstore.attestationType)"
  repo="$(field "$tool" .sigstore.githubWorkflowRepository)"
  ref="$(field "$tool" .sigstore.githubWorkflowRef)"
  [[ "$bundle_url" == https://* ]] || saf_die "tools.json: $tool sigstore.bundleUrl must be https"
  [ -n "$issuer" ] || saf_die "tools.json: $tool sigstore.certificateOidcIssuer is required"
  if [ -n "$identity" ] && [ -n "$identity_re" ]; then
    saf_die "tools.json: $tool sigstore sets both certificateIdentity and certificateIdentityRegexp"
  fi
  [ -n "$identity" ] || [ -n "$identity_re" ] \
    || saf_die "tools.json: $tool sigstore needs certificateIdentity or certificateIdentityRegexp"

  download "$bundle_url" "$bundle" || saf_die "download of the $tool Sigstore bundle failed"

  local -a args=(--bundle "$bundle" --certificate-oidc-issuer "$issuer")
  if [ -n "$identity" ]; then
    args+=(--certificate-identity "$identity")
  else
    args+=(--certificate-identity-regexp "$identity_re")
  fi
  [ -z "$repo" ] || args+=(--certificate-github-workflow-repository "$repo")
  [ -z "$ref" ] || args+=(--certificate-github-workflow-ref "$ref")

  # cosign fetches the Sigstore trust root (TUF) and keeps it under $HOME/.sigstore.
  if [ -n "$att_type" ]; then
    cosign verify-blob-attestation "${args[@]}" --type "$att_type" "$file" \
      || saf_die "Sigstore attestation of $tool does not verify; refusing to install"
  else
    cosign verify-blob "${args[@]}" "$file" \
      || saf_die "Sigstore signature of $tool does not verify; refusing to install"
  fi
}

for t in "$@"; do
  [ -n "$(field "$t" .version)" ] || saf_die "tools.json has no tool named $t"
  install_one "$t"
done
