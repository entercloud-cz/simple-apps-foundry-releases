#!/usr/bin/env bash
# platform-validation.sh — the one step of the instance's \platform\validation pipeline
# (platform-validation.yml, ADR-0040): validates a pull request to platform-config.
# No credentials: no service connection, no Azure DevOps token, no Azure call.
#   1. `platform validate instance` on instance.yaml, with `--base HEAD^1` when the checkout has the
#      parent (the target branch: first parent of the pull request's merge commit; the checkout
#      fetches depth 2): the network of an environment with apps doesn't change (ADR-0027 amendment
#      2026-11-12); warnings (log retention against the lifecycle rule) don't fail it;
#   2. `platform validate app --instance` on every apps/*/app.yaml, with the same `--base HEAD^1`
#      for the immutability checks (slug, generation, database engine); an app.yaml whose slug the
#      pull request moves into apps-deleted/ is a new app (ADR-0061);
#   2a. `platform validate archive` on the archive of deleted apps (apps-deleted/, ADR-0061): every
#      archived definition the pull request adds against the schema, the place of every one, and with
#      `--base HEAD^1` added only by a move from apps/<slug>/ once its delete phase is due, never
#      changed or removed (except an unchanged move back while no app has the slug);
#   2b. for every apps/*/app.yaml the pull request changes, `platform provisioning entra-effect` with
#      the target branch's file (HEAD^1, or none: a new app, or a slug used again) as the base, in a
#      log section (ADR-0051);
#   3. `platform generate --check`: the generated files are up to date.
# Steps 2, 2a and 3 need a valid instance.yaml; otherwise only step 1 runs. Every app is checked even
# when another one fails; the script fails at the end when anything failed. apps-deleted/ is never
# provisioned and never validated as an app (ADR-0061).
# Folder names under apps/ come from the pull request: printed only through saf_neutralise.

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

instance="$SAF_CONFIG/instance.yaml"
if [ ! -f "$instance" ] || [ -L "$instance" ]; then
  saf_die "platform-config has no instance.yaml at its root (or it is a symbolic link)"
fi

failed=0
base=()
if git -C "$SAF_CONFIG" rev-parse --verify --quiet 'HEAD^1^{commit}' > /dev/null; then
  base=(--base 'HEAD^1')
else
  saf_info "The checkout has no parent commit: immutability (slug, generation, database engine, the network of environments with apps) is not checked."
fi

saf_info "== instance.yaml"
if ! saf_cli validate instance "$instance" "${base[@]}"; then
  saf_die "instance.yaml is not valid; fix it first (the app definitions are checked against it)"
fi

apps=0
shopt -s nullglob
for dir in "$SAF_CONFIG"/apps/*/; do
  dir="${dir%/}"
  name="${dir##*/}"
  file="$dir/app.yaml"
  if [ -L "$dir" ] || [ -L "$file" ]; then
    printf '%s\n' "apps/$name or its app.yaml is a symbolic link, which is not allowed." | saf_neutralise
    failed=1
    continue
  fi
  [ -f "$file" ] || continue
  apps=$((apps + 1))
  printf '%s\n' "== apps/$name/app.yaml" | saf_neutralise
  if ! saf_cli validate app "$file" --instance "$instance" "${base[@]}"; then
    failed=1
  fi
done
saf_info "$apps app definition(s) checked."

# 2a. The archive of deleted apps (ADR-0061 section 3).
saf_info "== apps-deleted/ (the archive of deleted apps)"
if ! saf_cli validate archive "$SAF_CONFIG" "${base[@]}"; then
  failed=1
fi

# 2b. The Entra effect of every app.yaml the pull request changes (ADR-0051 section 5): with
# approvals.entraChanges pullRequest the reviewers approve those Entra changes when they approve the
# pull request, so the log names them. Base: the target branch, HEAD^1 (the default branch: the build
# validation runs only on pull requests into it; the checkout's depth 2 holds it, and the credentials
# aren't persisted, so nothing else can be fetched), `git show HEAD^1:<path>`, or none for a new app;
# head: the merge commit's file, or none for a removed app. Offline (`platform provisioning
# entra-effect`, pure: no Azure, no token). Informational: a failure here never fails the run (the
# validation above does). Every changed app is shown; the text from the pull request goes through
# saf_neutralise. A slug used again (ADR-0061: the pull request adds an archived definition under
# apps-deleted/<slug>/) is a new app: base none, as its validation compares nothing either; a
# definition moved back out of the archive has the archived version as its base.
printf '##[section]%s\n' "Entra effect of the changed app definitions (ADR-0051)"
if [ "${#base[@]}" -eq 0 ]; then
  saf_info "The checkout has no parent commit: the Entra effect of the change can't be shown."
else
  effects=0
  mkdir -p "$SAF_WORK"
  while IFS= read -r -d '' path; do
    if [[ ! "$path" =~ ^apps/[a-z0-9-]{1,40}/app\.yaml$ ]]; then
      printf '%s\n' "$path: not an app definition path the platform accepts; no Entra effect shown" | saf_neutralise
      continue
    fi
    effects=$((effects + 1))
    slug="${path#apps/}"
    slug="${slug%/app.yaml}"
    base_file=none
    if [ -f "$SAF_CONFIG/$path" ] && [ -n "$(git -C "$SAF_CONFIG" diff --name-only --diff-filter=A HEAD^1 HEAD -- "apps-deleted/$slug/")" ]; then
      printf '%s\n' "$path: a new app with the slug of a deleted app (its definition moved to apps-deleted/$slug/ in this pull request)" | saf_neutralise
    elif git -C "$SAF_CONFIG" cat-file -e "HEAD^1:$path" 2> /dev/null; then
      base_file="$SAF_WORK/entra-effect-base.yaml"
      git -C "$SAF_CONFIG" show "HEAD^1:$path" > "$base_file"
    else
      # A definition moved back out of the archive (ADR-0061): its base is the archived version.
      moved_back="$(git -C "$SAF_CONFIG" diff --name-only --diff-filter=D HEAD^1 HEAD -- "apps-deleted/$slug/" | tail -n 1)"
      if [ -n "$moved_back" ]; then
        base_file="$SAF_WORK/entra-effect-base.yaml"
        git -C "$SAF_CONFIG" show "HEAD^1:$moved_back" > "$base_file"
      fi
    fi
    head_file=none
    if [ -f "$SAF_CONFIG/$path" ] && [ ! -L "$SAF_CONFIG/$path" ]; then head_file="$SAF_CONFIG/$path"; fi
    if ! saf_cli provisioning entra-effect --base "$base_file" --head "$head_file" --instance "$instance" | saf_neutralise; then
      printf '%s\n' "$path: the Entra effect could not be computed (see the validation of this file above)" | saf_neutralise
    fi
  done < <(git -C "$SAF_CONFIG" diff --name-only -z HEAD^1 HEAD -- 'apps/*/app.yaml')
  saf_info "$effects changed app definition(s); Entra effect shown for each."
fi

saf_info "== generated files"
if ! saf_cli generate --config-dir "$SAF_CONFIG" --check; then
  failed=1
fi

[ "$failed" -eq 0 ] || saf_die "platform-config is not valid; see the problems above"
saf_info "platform-config is valid."
