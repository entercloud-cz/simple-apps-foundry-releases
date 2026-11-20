#!/usr/bin/env bash
# validate.sh — stage `validate`, job `plan` of the provisioning pipeline (no credentials).
#   1. `platform provisioning validate-run`: the template's environment list and host environment
#      equal what `platform generate` renders from instance.yaml; core is refs/tags/<coreVersion>;
#      the run is on platform-config's default branch (ADR-0046: whoever may queue the pipeline
#      can't provision an unreviewed branch); core's unit manifest infra/app/units.json exists, is
#      well formed and names released versions only, never `unreleased` (ADR-0048); so do core's
#      upgrade notes infra/app/upgrades.yaml; the parameter upgrade is none, all or up to 50 slugs,
#      each with apps/<slug>/app.yaml (ADR-0049).
#   2. `platform validate instance`, `platform generate --check`.
#   3. `platform provisioning apps` -> plan/apps.json, with checkAllApps (template parameter scope:
#      all, ADR-0046) and upgrade (template parameter upgrade, ADR-0049: the plan runs those apps'
#      outdated units); status/{slug}.json per app (ok | failed, with failure code PE002, ADR-0064).
#   4. `platform provisioning units` -> plan/unit-inputs.json: i of every unit of every valid app
#      (ADR-0048), which the job decide of stage plan compares with the tags saf-u-<unit>.
#   5. The platform CLI this job built from the core checkout -> plan/cli.tgz (dist and its runtime
#      dependencies): every later job installs it from this run's artifact instead of building it
#      again (ADR-0048 section 6; steps/setup.yml).
# Steps 1 and 2 fail the stage (nothing else runs). An invalid app does not: it is `failed` here,
# later stages skip it, and stage `report` fails the run.
# Env: SAF_ENVIRONMENTS_JSON (convertToJson of the template parameter), SAF_HOST_ENVIRONMENT,
# SAF_SCOPE (template parameter scope: changed | all), SAF_UPGRADE (template parameter upgrade),
# SAF_CORE_REF, SAF_SOURCE_BRANCH (Build.SourceBranch).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENVIRONMENTS_JSON SAF_HOST_ENVIRONMENT SAF_SCOPE SAF_UPGRADE SAF_CORE_REF SAF_SOURCE_BRANCH
out="$SAF_OUT/plan"
rm -rf "$out"
mkdir -p "$out/status"

saf_cli provisioning validate-run --instance "$SAF_INSTANCE" \
  --environments-json "$SAF_ENVIRONMENTS_JSON" --host-environment "$SAF_HOST_ENVIRONMENT" --core-ref "$SAF_CORE_REF" \
  --source-branch "$SAF_SOURCE_BRANCH" --units "$SAF_CORE/infra/app/units.json" --upgrades "$SAF_CORE/infra/app/upgrades.yaml" \
  --upgrade "$SAF_UPGRADE" --apps-dir "$SAF_CONFIG/apps"
saf_cli validate instance "$SAF_INSTANCE"
saf_cli generate --config-dir "$SAF_CONFIG" --check

# shellcheck disable=SC2153 # SAF_SCOPE and SAF_UPGRADE are set by the template (checked by saf_require_env above)
saf_cli provisioning apps --instance "$SAF_INSTANCE" --apps-dir "$SAF_CONFIG/apps" --scope "$SAF_SCOPE" --upgrade "$SAF_UPGRADE" \
  --output "$out/apps.json"
jq -e '.apps | type == "array"' "$out/apps.json" >/dev/null || saf_die "platform provisioning apps wrote no apps list"

valid=0
invalid=0
while IFS=$'\t' read -r slug ok; do
  prov_valid_slug "$slug" || saf_die "platform provisioning apps listed an invalid slug"
  if [ "$ok" = true ]; then
    status=ok
    valid=$((valid + 1))
  else
    status=failed
    invalid=$((invalid + 1))
    printf '##vso[task.logissue type=error]%s\n' "apps/$slug/app.yaml is invalid; $slug is skipped in this run (problems below)"
    jq -r --arg s "$slug" '.apps[] | select(.slug == $s) | .problems[]? | "  \(.)"' "$out/apps.json" | saf_neutralise
  fi
  # An invalid definition's failure code is PE002 (ADR-0064).
  jq -n --arg slug "$slug" --arg status "$status" --arg runId "${BUILD_BUILDID:-}" \
    '{schemaVersion: 1, stage: "validate", slug: $slug, environment: null, status: $status,
      reason: (if $status == "ok" then null else "apps/\($slug)/app.yaml is invalid" end),
      code: (if $status == "ok" then null else "PE002" end), runId: $runId, detail: {}}' > "$out/status/$slug.json"
done < <(jq -r '.apps[] | [.slug, (.ok | tostring)] | @tsv' "$out/apps.json")

saf_info "Apps: $valid valid, $invalid invalid."
jq -r '.apps[] | select(.ok == true) | "  \(.slug): sign-in \(.authMode), environments \(.environments | join(", "))"' \
  "$out/apps.json" | saf_neutralise

saf_cli provisioning units --instance "$SAF_INSTANCE" --apps "$out/apps.json" --output "$out/unit-inputs.json" | saf_neutralise

# Step 5: the CLI for the later jobs of this run (built from this core checkout by steps/setup.yml).
# Its build-time dependencies (typescript, @types) and the compiled tests stay behind.
tar -czf "$out/cli.tgz" -C "$SAF_CORE/tools/platform-cli" --exclude=node_modules/typescript --exclude=node_modules/@types \
  --exclude=node_modules/.bin --exclude=dist/test package.json dist node_modules
saf_info "Platform CLI packed for the later jobs: $(du -k "$out/cli.tgz" | cut -f1) KiB."
