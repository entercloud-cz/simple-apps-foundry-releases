#!/usr/bin/env bash
# shellcheck disable=SC2016 # the stage code is passed as text, expanded by the stage's own shell
# check-prov-units.sh — offline tests of the provisioning unit runner and of provisioning by unit
# (scripts/provisioning/prov-lib.sh, ADR-0046, ADR-0048). No Azure, no Azure DevOps: a throwaway
# workspace, fake units that sleep, fail or wait, fake stage artifacts and a fake az.
#
#   1. parallel: 11 units, at most PROV_PARALLEL_MAX at a time and more than one; a failed unit and a
#      waiting one don't stop the others; every status file; each unit's output is one group that no
#      other output interrupts; the summary in start order; exit 1 because one unit failed; faster
#      than one at a time;
#   2. sequential (no prov_parallel): same statuses, the output straight to the log;
#   3. prov_lock: units holding the same lock never overlap;
#   4. the plan's helpers on a fake units.json: prov_unit_runs, prov_planned, prov_entry_dir,
#      prov_lz_ok, prov_post_ok, prov_unit_tag and prov_unit_finished (per unit: an Easy Auth restart
#      to repeat, a planned Entra change not run, a missing kvset job, two redirect hosts behind the
#      managed Front Door, the ingress waiting for its domain, a previous host still on the route, a
#      removal not finished or finished, waiting endpoints and pipelines);
#   5. the decision end to end: scripts/provisioning/decide.sh with the built platform CLI
#      (`platform provisioning plan-units`) on fake plan_<env> artifacts: nothing to do, an untagged
#      unit (and its first date backdated by the stable drift offset), drift after 40 days (ado in
#      every environment), an `unreleased` units.json (fails, no outputs), an environment without
#      its plan; the step's outputs exactly as the stages read them; report.sh on those plans (one
#      line when nothing ran, the units that ran and why, the stages skipped, a failed plan fails);
#      ADR-0049: an outdated unit held (nothing runs, the report says behind), the same unit with
#      the app in the parameter upgrade (it runs), and a rebase (only record_<env> runs);
#   6. custom domain removal and host change (ADR-0010, amended 2026-11-11): front_door_cleanup and
#      fd_delete from azure-post.sh with a fake az (the order of the deletes, the release guard, DNS
#      records only while the CNAME points at the endpoint, manual zones reported, linked domains and
#      foreign IDs left alone; ADR-0052: a custom domain that holds another host, DNS records with
#      another app's mark or without a mark alone are left alone, the nested records of the app's own
#      deployment are deleted; fd_dns_guard refuses a record set that isn't the app's);
#   7. record_tags (record.sh) and prov_tags_restore with a fake az: finished units written, unfinished
#      ones and the retired saf-provisioned deleted by name and value, the others kept, a held unit's
#      rebase written, saf-u-files with them (ADR-0049); the tags written back after a landing-zone
#      deployment, saf-u-files included;
#   8. decommissioning (ADR-0056): prov_unit_action, prov_post_runs without a landing zone's delete,
#      prov_was_retired, removed tags; record_tags writes saf-u-retired after a finished retire,
#      "removed <date>" after a finished delete, deletes an unfinished delete's tag and, after Cancel,
#      saf-u-retired; a landing zone's delete, and an Entra delete where the group is gone, leave nothing to tag;
#   9. release_app's dispatch for a decommissioned app (azure-post.sh, ADR-0056 amendment 2026-11-12):
#      an immediate first run stops the app, then removes its domain; an ado delete needs no
#      ado-outputs; retire-only stops it without the domain; an ordinary retire stops it only; a
#      landing zone that never succeeded (no outputs) doesn't stop it, an active app without outputs fails;
#  10. reading the state (sandbox runs 3396 to 3412): prov_secret_state of a landing-zone record that
#      didn't succeed is absent without a vault read; prov_valid_container_app_id takes the ID as
#      ARM's list writes it (containerapps) and still refuses another subscription or type (the
#      environment's own vaults, which prov_env_vaults used to filter, are named by section 15's
#      prov_mode_vaults now).
#      prov_arm_list tries a transient ARM error (HTTP 429, 5xx) again, at most PROV_ARM_TRIES times,
#      and a refusal (403) at once (sandbox run 3426).
#  11. the deleted phase (ADR-0056 amendment 2026-11-12, deleted detected), decide.sh and report.sh
#      end to end: a decommissioned app with nothing left in Azure is deleted (nothing runs, even
#      outside the window; units/decommission.json says so, the report too); with an Entra record
#      left it is deleting (the registration is deleted, nothing to tag); before deleteAfter it is
#      retired; an active app whose resource group is missing is created (lz new), never deleted;
#      an immediate block on an app with production is deleted at once only with instance.yaml
#      decommission.allowImmediateWithProduction (amendment 2026-11-21; the report names production
#      and the setting), and without it (switched off after the merge) as an ordinary one;
#  12. the service connection after the group (sandbox run 3421, ADR-0056 amendment 2026-11-12):
#      ado_remove (ado.sh) names --landing-zone-gone only for an environment whose lz delete finished
#      in this run and records connection-<env> gone after a success; lz_record_delete (record.sh)
#      deletes lz-{slug}-{env} only when the group is gone and the connection too, else the record
#      stays.
#  13. portal-side endpoint removal (azure-post.sh, ADR-0025 amendment 2026-11-14): an endpoint goes
#      only when it links the app's own vault in its resource group, a record only when it names the
#      app and environment; a vault no longer VNet-based loses its endpoint only with public network
#      access and no other connection (or when gone), never when unreadable or with its spoke endpoint
#      left; a previous generation's endpoint goes before the new deployment; step P removes both.
#  14. the registry image purge (ADR-0059): decide.sh sets registry_<env> of the build environment
#      only (never purged inside the window: true; outside it, purged 3 days ago, or a landing zone
#      without the purge role: false), registry.json protects what the app runs in every
#      environment; report.sh's section Old images; registry.sh purge_app with a fake az and the built
#      CLI: the registry must be in the app's group by naming, only the old build that runs nowhere is
#      deleted (by digest), the tag saf-registry-purge after it, dry run deletes nothing, a foreign
#      registry or a refused delete fails the app without a tag, a repository without images is fine.
#  15. the Easy Auth secret in the vault of the app's mode (ADR-0060): prov_vault_inputs with the built
#      CLI (vaultGeneration, externalOnlyNetwork, schema defaults); prov_names hands them to names.bicep
#      with a mode for env_name only; prov_secret_state reads the record's vault in the steady state
#      and the target vault after a network mode change (absent until re-issued there), never the old;
#      prov_mode_vaults names each vault variant once (plan.sh).
#  16. the move of a network mode change (ADR-0060), release_app and move_step with a fake az: A into
#      hybrid, A out of hybrid, B, a resumed move, a failed precondition (waiting, nothing deleted),
#      no target secret yet (waiting); the order of the steps, the guards (an inherited role, the target
#      CAE's Joiner and a foreign endpoint left alone), lz and release done only at the end; the plan's
#      waitsForWindow (kind prod outside the window): waiting after the prepare pass, nothing else.
#  17. the follow-up of a case A move: plan_old_secret (entra-plan.sh) only for the plan's followUp,
#      remove_old_secret (entra.sh) through the old variant's kvset job with --app-vault, a plan naming
#      the app's current job refused.
#  18. decide.sh and report.sh: a move (outputs, the plan's line, the report's section moved and
#      waiting), the follow-up outside the window, a decommissioned app that never moves; the window
#      rule (product owner, 2026-11-14): kind prod outside the window runs the prepare pass and waits
#      (plan line, report), kind prod inside it moves, kind nonprod moves at once.
#  19. the delete phase frees the slug's names (ADR-0061 section 4): lz_secret_delete (azure.sh) deletes a
#      present Easy Auth secret through the kvset job of the app's mode, in that mode's vault, under the
#      job's lock; an absent secret starts nothing; a kvset job outdated or missing waits; a failed delete
#      fails the unit (delete-lz not reached, the record stays); unregister (entra.sh) deletes the
#      registration by the current app's own uniqueName ({prefix}-{slug}-{env}, --i{n} for incarnation n
#      above 0, from plan/apps.json; never purged from the recycle bin), then the record entra-{slug}-{env}
#      in the environment's records group and in rg-{prefix}-entra (ADR-0063); a uniqueName from
#      names.bicep that isn't the app's own, or a failed delete, keeps the records.
#  20. the Entra records per environment (ADR-0063): plan.sh entra_records over the groups (the most
#      recent record of each name, the environment's group on a tie, only records named for the
#      environment from its group, a missing group: its records stay in rg-{prefix}-entra, a list that
#      fails: null, the records left there counted); entra-plan.sh entra_record and entra_target (the
#      group the plan listed, the environment's for a record it didn't list, both and the newer without
#      the list, a group of neither name refused) and entra.sh register (the record into the group the
#      plan named, by names.bicep; the old record in rg-{prefix}-entra deleted only after a deployment into
#      the environment's group; a failed delete only warns; no group named: nothing deployed).
#  21. failure codes (ADR-0064, US04.10, US04.11): prov_unit writes the code prov_failure set (the last
#      one; PE001 without one or for a malformed value) into a failed status and its error line, none into
#      an ok or waiting one; prov_arm with a fake az and the built CLI: a landing zone that fails with
#      SkuNotAvailable gets PE005 when no soft-deleted vault holds the app vault's name (404), PE009 when
#      one does (the GET of that deleted vault in the inputs' location, the name from names.bicep with the
#      inputs' generation, and an error line naming the runbook and generation), the deployment's own
#      code when the read is refused; a release's failure never asks; report.sh on a failed status and a
#      failed plan: the cell `failed PE009`, the section Failures, failures.json (PE003 for the plan).
# Needs the platform CLI built (cd tools/platform-cli && npm ci && npm run build) for sections 5, 14, 15, 18, 21.
# Usage: bash pipelines/azure-devops/tests/check-prov-units.sh (exit 0 = every check passed).

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
lib="$repo/pipelines/azure-devops/scripts/provisioning/prov-lib.sh"
tmp="$(mktemp -d)"
# KEEP=1 keeps the workspaces for a look at the logs.
trap '[ -n "${KEEP:-}" ] || rm -rf "$tmp"' EXIT
[ -z "${KEEP:-}" ] || printf 'workspaces: %s\n' "$tmp"
failures=0

check() { # check <description> <command...>
  local what="$1"
  shift
  if "$@"; then
    printf 'ok    %s\n' "$what"
  else
    printf 'FAIL  %s\n' "$what"
    failures=$((failures + 1))
  fi
}

# A fresh workspace per case; the stage script is $1 (bash code run after prov-lib.sh is sourced).
run_stage() {
  local code="$2" ws="$tmp/$1"
  mkdir -p "$ws/ws/s/config" "$ws/tools"
  printf 'schemaVersion: 1\n' > "$ws/ws/s/config/instance.yaml"
  set +e
  env -i PATH="$PATH" HOME="$HOME" PIPELINE_WORKSPACE="$ws/ws" AGENT_TOOLSDIRECTORY="$ws/tools" BUILD_BUILDID=42 \
    bash -c "source '$lib'; $code" > "$ws/out.log" 2>&1
  printf '%s' "$?" > "$ws/rc"
  set -e
}

# The fake units: each records its start and end, and how many units run at the same time.
units='
PROV_STAGE=azure_test
out="$SAF_OUT/azure_test"
mkdir -p "$out/status"
unit() {
  local n
  exec {c}>> "$SAF_WORK/count.lock"
  flock "$c"
  n=$(( $(cat "$SAF_WORK/count" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$SAF_WORK/count"
  echo "$n" >> "$SAF_WORK/peaks"
  exec {c}>&-
  echo "unit $1: line 1"
  sleep "0.$(( (RANDOM % 5) + 3 ))"
  echo "unit $1: line 2"
  exec {c}>> "$SAF_WORK/count.lock"
  flock "$c"
  echo $(( $(cat "$SAF_WORK/count") - 1 )) > "$SAF_WORK/count"
  exec {c}>&-
  case "$1" in
    app-c) saf_die "app-c breaks" ;;
    app-e) prov_wait "app-e waits for something" ;;
  esac
  prov_detail landingZone up-to-date
  echo "unit $1: line 3"
}
apps=(app-a app-b app-c app-d app-e app-f app-g app-h app-i app-j app-k)
'

# --- 1. parallel ------------------------------------------------------------------------------
start=$SECONDS
run_stage parallel "$units"'
prov_parallel
for slug in "${apps[@]}"; do
  prov_run_app "$(prov_status_path "$out" "$slug" test)" "$slug" test unit "$slug"
done
prov_finish'
parallel_s=$((SECONDS - start))
p="$tmp/parallel"
peak="$(sort -n "$p/ws/saf-work/peaks" | tail -n 1)"
check "parallel: exit 1 (one unit failed)" test "$(cat "$p/rc")" = 1
check "parallel: at most 6 units at a time, more than one (peak $peak)" test "$peak" -le 6 -a "$peak" -gt 1
statuses="$(for a in app-a app-b app-c app-d app-e app-f app-g app-h app-i app-j app-k; do jq -r .status "$p/ws/saf-out/azure_test/status/$a.test.json"; done | tr '\n' ' ')"
check "parallel: statuses (c failed, e waiting, the others ok)" test "$statuses" = "ok ok failed ok waiting ok ok ok ok ok ok "
check "parallel: a detail reaches the status file" test "$(jq -r .detail.landingZone "$p/ws/saf-out/azure_test/status/app-a.test.json")" = up-to-date
check "parallel: the waiting reason reaches the status file" test "$(jq -r .reason "$p/ws/saf-out/azure_test/status/app-e.test.json")" = "app-e waits for something"
# Every unit's lines lie inside its own group, and groups don't nest or interleave.
grouped() {
  awk '
    /^##\[group\]/ { if (open != "") bad = 1; split($0, a, "]"); split(a[2], b, " "); open = b[1]; groups++; next }
    /^##\[endgroup\]/ { if (open == "") bad = 1; open = ""; next }
    /^unit / { u = $2; sub(":", "", u); if (u != open) bad = 1 }
    END { exit (bad || groups != 11 || open != "") }
  ' "$1"
}
check "parallel: each unit's output is one group, never interleaved" grouped "$p/out.log"
check "parallel: a failed unit is reported as an error, with its failure code (PE001: none set)" grep -q '^##vso\[task.logissue type=error\]app-c in test: failed in azure_test (code PE001); the other apps go on$' "$p/out.log"
summary="$(sed -n 's/^  \(app-[a-k]\) in test: \([a-z]*\)$/\1=\2/p' "$p/out.log" | tr '\n' ' ')"
check "parallel: the summary lists every unit in start order" test "$summary" = "app-a=ok app-b=ok app-c=failed app-d=ok app-e=waiting app-f=ok app-g=ok app-h=ok app-i=ok app-j=ok app-k=ok "
check "parallel: totals" grep -q '^azure_test: 9 ok, 0 unchanged, 1 waiting, 1 failed, 0 skipped' "$p/out.log"

# --- 2. sequential ----------------------------------------------------------------------------
start=$SECONDS
run_stage sequential "$units"'
for slug in "${apps[@]}"; do
  prov_run_app "$(prov_status_path "$out" "$slug" test)" "$slug" test unit "$slug"
done
prov_finish'
sequential_s=$((SECONDS - start))
q="$tmp/sequential"
check "sequential: exit 1, peak 1" test "$(cat "$q/rc")" = 1 -a "$(sort -n "$q/ws/saf-work/peaks" | tail -n 1)" = 1
check "sequential: the same statuses" test "$(for a in app-a app-b app-c app-d app-e app-f app-g app-h app-i app-j app-k; do jq -r .status "$q/ws/saf-out/azure_test/status/$a.test.json"; done | tr '\n' ' ')" = "$statuses"
check "sequential: no groups, the classic headers" test "$(grep -c '^##\[group\]' "$q/out.log" || true)" = 0 -a "$(grep -c '^========== app-' "$q/out.log")" = 11
check "parallel is faster ($parallel_s s against $sequential_s s)" test "$parallel_s" -lt "$sequential_s"

# --- 3. prov_lock -----------------------------------------------------------------------------
run_stage lock '
PROV_STAGE=azure_post_test
out="$SAF_OUT/azure_post_test"
locked() {
  prov_lock frontdoor
  echo "in $1 $(date +%s%N)" >> "$SAF_WORK/spans"
  sleep 0.3
  echo "out $1 $(date +%s%N)" >> "$SAF_WORK/spans"
  prov_unlock
  sleep 0.2
}
prov_parallel
for slug in app-a app-b app-c app-d; do
  prov_run_app "$(prov_status_path "$out" "$slug" test)" "$slug" test locked "$slug"
done
prov_finish'
l="$tmp/lock"
# Sorted by time, the spans alternate in/out: no two units inside the lock at once.
alternate() { sort -k3 -n "$1" | awk '{ if (($1 == "in") == inside) bad = 1; inside = ($1 == "in") } END { exit bad }'; }
check "prov_lock: exit 0, four units" test "$(cat "$l/rc")" = 0 -a "$(wc -l < "$l/ws/saf-work/spans")" = 8
check "prov_lock: never two units inside the same lock" alternate "$l/ws/saf-work/spans"

# --- 4. units: the plan's helpers (ADR-0048) --------------------------------------------------
# A fake plan (units/units.json) and fake stage artifacts: which units run, where an app's entries
# are, whether a unit the plan sent to a stage is ok there, and whether it finished.
tag_a="v0.1.0-rc.3 aaaaaaaaaaaa 20261101"
rec_a="v0.1.0-rc.3 bbbbbbbbbbbb 20261111"
run_stage units '
PROV_STAGE=record_test
mkdir -p "$SAF_IN/units" "$SAF_IN/plan"
jq -n "{checkAllApps: false, apps: [
  {slug: \"app-a\", ok: true, environments: [\"test\"], authMode: \"required\", frontDoorHosts: {}},
  {slug: \"app-b\", ok: true, environments: [\"test\"], authMode: \"anonymous\", frontDoorHosts: {}}]}" > "$SAF_APPS_JSON"
u() { jq -n --argjson run "$1" --arg tag "$2" --arg rec "$3" "{run: \$run, reasons: [], details: [], tag: (if \$tag == \"\" then null else \$tag end), record: (if \$rec == \"\" then null else \$rec end)}"; }
jq -n --argjson lz "$(u true "'"$tag_a"'" "'"$rec_a"'")" --argjson entra "$(u true "" "'"$rec_a"'")" \
  --argjson release "$(u true "'"$tag_a"'" "'"$rec_a"'")" --argjson frontdoor "$(u true "" "'"$rec_a"'")" \
  --argjson pep "$(u true "" "'"$rec_a"'")" --argjson ado "$(u true "" "'"$rec_a"'")" --argjson off "$(u false "bad value" "'"$rec_a"'")" \
  "{schemaVersion: 1, stages: {}, apps: {
    \"app-a\": {environments: {test: {plan: \"ok\", resourceGroup: \"rg-app-a-test\", entraSingleHost: true,
      units: {lz: \$lz, entra: \$entra, release: \$release, frontdoor: \$frontdoor, pep: \$pep, ado: \$ado}}}},
    \"app-b\": {environments: {test: {plan: \"ok\", resourceGroup: \"rg-app-b-test\", entraSingleHost: true,
      units: {lz: \$off, release: \$off, pep: \$off, ado: \$off}}}},
    \"app-c\": {environments: {test: {plan: \"failed\", units: {}}}}}}" > "$SAF_UNITS_JSON"
prov_units_check && echo "check ok"
printf "{\"containerAppFqdn\":{\"value\":\"ca-x.example\"}}" > "$SAF_WORK/obj.json"; printf "true" > "$SAF_WORK/bool.json"
prov_copy_object "$SAF_WORK/obj.json" "$SAF_WORK/copy.json" && echo "copied $(jq -r .containerAppFqdn.value "$SAF_WORK/copy.json")"
prov_copy_object "$SAF_WORK/bool.json" "$SAF_WORK/copy2.json" || echo "refused non-object"
prov_unit_runs app-a test lz && echo "runs a.lz"
prov_unit_runs app-b test lz || echo "not b.lz"
prov_unit_runs app-c test lz || echo "not c.lz"
prov_planned app-b test && echo "planned b"
prov_planned app-c test || echo "not planned c"
echo "entries a=$(prov_entry_dir app-a test | sed "s|$SAF_IN/||") b=$(prov_entry_dir app-b test | sed "s|$SAF_IN/||")"
echo "tags a.lz=[$(prov_unit_tag app-a test lz tag)] a.entra=[$(prov_unit_tag app-a test entra tag)] b.lz=[$(prov_unit_tag app-b test lz tag)] a.lz.record=[$(prov_unit_tag app-a test lz record)]"
st() { mkdir -p "$(dirname "$1")"; jq -n --arg s "$2" --argjson d "${3:-{\}}" --argjson done "${4:-[]}" "{status: \$s, detail: \$d, done: \$done}" > "$1"; }
prov_lz_ok app-a test || echo "lz-ok a=no (azure_test has no status)"
st "$SAF_IN/azure_test/status/app-a.test.json" ok
prov_lz_ok app-a test && echo "lz-ok a=yes"
prov_lz_ok app-b test && echo "lz-ok b=yes (planned, lz not run)"
prov_lz_ok app-c test || echo "lz-ok c=no (not planned)"
prov_post_ok app-a test || echo "post-ok a=no"
st "$SAF_IN/azure_post_test/status/app-a.test.json" waiting "{\"easyAuth\": \"current\"}" "[\"lz\"]"
prov_post_ok app-a test || echo "post-ok a=no (waiting)"
prov_post_ok app-b test && echo "post-ok b=yes (nothing there ran)"
fin() { local u r=""; for u in lz entra release frontdoor pep ado; do if prov_unit_finished app-a test "$u" test; then r+=" $u"; fi; done; echo "finished$1:${r:- none}"; }
fin 1
st "$SAF_IN/azure_post_test/status/app-a.test.json" ok "{\"easyAuth\": \"restarted tag-after-settle\", \"ingress\": \"open\"}" "[\"lz\", \"release\"]"
st "$SAF_IN/entra_plan/status/app-a.test.json" ok "{\"entra\": \"deploy\", \"secret\": \"current\"}"
mkdir -p "$SAF_IN/entra_plan/entra-inputs"
echo "{\"hosts\": [\"ca-app-a.example.io\"]}" > "$SAF_IN/entra_plan/entra-inputs/app-a.test.json"
st "$SAF_IN/azure_post_test/portal/status/app-a.test.json" waiting
st "$SAF_IN/ado/status/app-a.json" ok
st "$SAF_IN/ado_pipelines/status/app-a.json" waiting
fin 2
st "$SAF_IN/azure_post_test/status/app-a.test.json" ok "{\"easyAuth\": \"current\", \"ingress\": \"locked\", \"frontDoorPrevious\": \"old.contoso.com kept\"}" "[\"lz\", \"release\"]"
st "$SAF_IN/entra/status/app-a.test.json" ok
st "$SAF_IN/azure_post_test/portal/status/app-a.test.json" ok
st "$SAF_IN/ado_pipelines/status/app-a.json" ok
echo "{\"hosts\": [\"ca-app-a.example.io\", \"app-a.contoso.com\"]}" > "$SAF_IN/entra_plan/entra-inputs/app-a.test.json"
fin 3
st "$SAF_IN/azure_post_test/status/app-a.test.json" ok "{\"easyAuth\": \"current\", \"ingress\": \"pending-domain\", \"frontDoor\": \"removing\"}" "[\"lz\", \"release\"]"
echo "{\"hosts\": [\"app-a.contoso.com\"]}" > "$SAF_IN/entra_plan/entra-inputs/app-a.test.json"
fin 4
st "$SAF_IN/azure_post_test/status/app-a.test.json" failed "{\"easyAuth\": \"current\", \"frontDoor\": \"removed\"}" "[\"lz\", \"release\"]"
st "$SAF_IN/entra_plan/status/app-a.test.json" ok "{\"entra\": \"up-to-date\", \"secret\": \"job-missing\"}"
fin 5
st "$SAF_IN/entra_plan/status/app-a.test.json" ok "{\"entra\": \"up-to-date\", \"secret\": \"current\"}"
st "$SAF_IN/azure_post_test/status/app-a.test.json" ok "{\"easyAuth\": \"current\", \"ingress\": \"locked\", \"frontDoor\": \"app-a.contoso.com up-to-date\"}" "[\"lz\", \"release\"]"
rm "$SAF_IN/azure_test/status/app-a.test.json"
fin 6'
s="$tmp/units/out.log"
check "units: prov_units_check accepts the plan" grep -qx "check ok" "$s"
check "units: prov_copy_object copies an entry's JSON object (not jq's true) and refuses anything else" \
  test "$(grep -c -x -e "copied ca-x.example" -e "refused non-object" "$s")" = 2
check "units: prov_unit_runs follows the plan (run true only)" test "$(grep -c -x -e "runs a.lz" -e "not b.lz" -e "not c.lz" "$s")" = 3
check "units: prov_planned (plan ok only)" test "$(grep -c -x -e "planned b" -e "not planned c" "$s")" = 2
check "units: an app's entries come from azure_<env> when its lz ran there, else from plan_<env>" grep -qx "entries a=azure_test b=plan_test" "$s"
check "units: prov_unit_tag gives the tag and record as planned, never a malformed value" \
  grep -qxF "tags a.lz=[$tag_a] a.entra=[] b.lz=[] a.lz.record=[$rec_a]" "$s"
check "units: a unit the plan sent to a stage without an ok status there is not ok" \
  test "$(grep -c -x -e "lz-ok a=no (azure_test has no status)" -e "post-ok a=no" -e "post-ok a=no (waiting)" "$s")" = 3
check "units: an app whose unit didn't run there is ok when it was planned" \
  test "$(grep -c -x -e "lz-ok a=yes" -e "lz-ok b=yes (planned, lz not run)" -e "lz-ok c=no (not planned)" -e "post-ok b=yes (nothing there ran)" "$s")" = 4
check "prov_unit_finished: lz needs its second pass (done) and azure ok; nothing else without statuses" grep -qx "finished1: lz" "$s"
check "prov_unit_finished: an Easy Auth restart to repeat after the settle time is finished (the plan repeats it in the window); a planned Entra change not run, a waiting endpoint and pipeline are not" \
  grep -qx "finished2: lz release frontdoor" "$s"
check "prov_unit_finished: a previous host still on the route, two redirect hosts behind the managed Front Door" \
  grep -qx "finished3: lz release pep ado" "$s"
check "prov_unit_finished: the ingress waiting for its domain, a removal not finished" grep -qx "finished4: lz entra pep ado" "$s"
check "prov_unit_finished: a missing kvset job, a domain removed in this run (the next plan drops its host)" \
  grep -qx "finished5: lz release frontdoor pep ado" "$s"
check "prov_unit_finished: lz not finished without azure_<env>'s status" grep -qx "finished6: entra release frontdoor pep ado" "$s"

# --- 5. the plan's decision and the drift offset, end to end (decide.sh with the built CLI) ------
# decide.sh in a fake workspace: core = this repo's CLI (built: npm run build in tools/platform-cli)
# and a units.json fixture; platform-config = the CLI's provisioning fixture; plan_<env> artifacts
# with facts and tags as plan.sh writes them.
cli_dir="$repo/tools/platform-cli"
if [ ! -f "$cli_dir/dist/src/cli.js" ]; then
  printf 'FAIL  the platform CLI is not built (cd tools/platform-cli && npm ci && npm run build)\n'
  exit 1
fi
# The maintenance window of the fixture instance (ADR-0048 section 7, amended 2026-11-11): open all
# the time by default, so the cases don't depend on when the test runs; `closed` = one hour that
# starts two hours from now on every day (never now).
window_open='maintenance: {window: {days: [mon, tue, wed, thu, fri, sat, sun], start: "00:00", hours: 24}, registryRetention: {mode: purge}}'
window_closed="maintenance: {window: {days: [mon, tue, wed, thu, fri, sat, sun], start: \"$(date -u -d '+2 hours' +%H):00\", hours: 1}, registryRetention: {mode: purge}}"
decide_ws() { # decide_ws <case> [upgrade] [open|closed]: a workspace with core and platform-config
  local ws="$tmp/$1/ws" cfg="$repo/tools/platform-cli/test/fixtures/provisioning/config"
  mkdir -p "$ws/s/core/tools" "$ws/s/core/infra/app" "$ws/in/plan" "$tmp/$1/tools"
  ln -s "$cli_dir" "$ws/s/core/tools/platform-cli"
  ln -s "$repo/pipelines" "$ws/s/core/pipelines"
  cp -r "$cfg" "$ws/s/config"
  if [ "${3:-open}" = closed ]; then
    printf '%s\n' "$window_closed" >> "$ws/s/config/instance.yaml"
  else
    printf '%s\n' "$window_open" >> "$ws/s/config/instance.yaml"
  fi
  node "$cli_dir/dist/src/cli.js" provisioning apps --instance "$ws/s/config/instance.yaml" --apps-dir "$ws/s/config/apps" \
    --scope changed --upgrade "${2:-none}" --output "$ws/in/plan/apps.json" > /dev/null
  node "$cli_dir/dist/src/cli.js" provisioning units --instance "$ws/s/config/instance.yaml" --apps "$ws/in/plan/apps.json" \
    --output "$ws/in/plan/unit-inputs.json" > /dev/null
  jq -n '{schemaVersion: 1, units: ({lz: 1, entra: 2, release: 3, frontdoor: 4, pep: 5, ado: 6}
    | map_values({revision: 1, fingerprint: ("a" * 64), since: "v0.1.0-rc.2"}))}' > "$ws/s/core/infra/app/units.json"
  printf 'minAppVersion: v0.1.0-rc.1\nversions: {}\n' > "$ws/s/core/infra/app/upgrades.yaml"
}
# behind <case> <unit>: core changed <unit> in rc.3 (units.json since), and every environment's tag
# of it was applied by rc.2 (ADR-0049: the unit is outdated).
behind() {
  local ws="$tmp/$1/ws" e
  jq --arg u "$2" '.units[$u].since = "v0.1.0-rc.3"' "$ws/s/core/infra/app/units.json" > "$ws/u.json"
  mv "$ws/u.json" "$ws/s/core/infra/app/units.json"
  for e in nonprod prod; do
    jq --arg u "saf-u-$2" '.tags[$u] |= sub("^v0\\.1\\.0-rc\\.3 "; "v0.1.0-rc.2 ")' "$ws/in/plan_$e/facts/demo.json" > "$ws/f.json"
    mv "$ws/f.json" "$ws/in/plan_$e/facts/demo.json"
  done
}
# plan_env <case> <env> <date> [omit unit]: the artifact plan_<env> of the fixture app `demo`, every
# unit tagged with its i (core v0.1.0-rc.3, checked <date>) except <omit>.
plan_env() {
  local ws="$tmp/$1/ws" env="$2" date="$3" omit="${4:-}" dir
  dir="$ws/in/plan_$env"
  mkdir -p "$dir/status" "$dir/facts"
  if [ "$env" = prod ]; then
    jq -n --arg e "$env" '{schemaVersion: 1, environment: $e, tagsRead: true,
      entraRecords: [{name: "entra-demo-nonprod", state: "Succeeded"}, {name: "entra-demo-prod", state: "Succeeded"}]}' > "$dir/plan.json"
  else
    jq -n --arg e "$env" '{schemaVersion: 1, environment: $e, tagsRead: true}' > "$dir/plan.json"
  fi
  jq -n '{status: "ok"}' > "$dir/status/demo.$env.json"
  jq -n --arg e "$env" --arg d "$date" --arg o "$omit" --slurpfile i "$ws/in/plan/unit-inputs.json" \
    '$i[0].apps.demo as $a | (($a.environments[$e] + {ado: $a.ado}) | to_entries
      | map(select(.key != "frontdoor" and .key != $o) | {key: "saf-u-\(.key)", value: "v0.1.0-rc.3 \(.value[0:12]) \($d)"}) | from_entries) as $tags
    | {resourceGroup: "rg-contoso-app-demo-\($e)", tags: ($tags + {"saf-provisioned": ("f" * 64)}), lzRecord: "ok", federation: true,
       easyAuthInLandingZone: true, secret: {state: "present", created: 1790000000, expires: 1890000000, loaded: 1790000000},
       frontDoorRecord: false, rangesChanged: false, entraDeployment: "entra-demo-\($e)"}' > "$dir/facts/demo.json"
}
run_decide() { # run_decide <case>
  local ws="$tmp/$1/ws"
  set +e
  env -i PATH="$PATH" HOME="$HOME" PIPELINE_WORKSPACE="$ws" AGENT_TOOLSDIRECTORY="$tmp/$1/tools" BUILD_BUILDID=42 \
    SAF_ENVIRONMENTS_JSON='[{"name":"nonprod","kind":"nonprod","promoteFrom":""},{"name":"prod","kind":"prod","promoteFrom":"nonprod"}]' \
    SAF_HOST_ENVIRONMENT=prod bash "$repo/pipelines/azure-devops/scripts/provisioning/decide.sh" > "$tmp/$1/out.log" 2>&1
  printf '%s' "$?" > "$tmp/$1/rc"
  set -e
}
outputs() { grep '^##vso\[task.setvariable' "$tmp/$1/out.log" | sed 's/^##vso\[task.setvariable variable=\([A-Za-z_]*\);isOutput=true\]\(.*\)$/\1=\2/' | tr '\n' ' '; }
today="$(date -u +%Y%m%d)"
recent="$(date -u -d '-3 days' +%Y%m%d)"
old="$(date -u -d '-40 days' +%Y%m%d)"

decide_ws quiet
plan_env quiet nonprod "$recent"
plan_env quiet prod "$recent"
run_decide quiet
check "decide: every unit tagged and recent: exit 0, nothing runs" test "$(cat "$tmp/quiet/rc")" = 0
check "decide: sets exactly the outputs ado, entraPlan, lz_/post_/record_<env>, registry_<build env>, all false" test "$(outputs quiet)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: says so in one line" grep -q "Nothing to do: every unit of every app is recorded and up to date." "$tmp/quiet/out.log"

decide_ws entra
plan_env entra nonprod "$recent" entra
plan_env entra prod "$recent"
run_decide entra
units_entra="$tmp/entra/ws/saf-out/units/units.json"
check "decide: an untagged entra without its landing zone is compared in the plan (no entra_plan), records nonprod only" test "$(outputs entra)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: its reason is new" test "$(jq -r '.apps.demo.environments.nonprod.units.entra.reasons | join(",")' "$units_entra")" = new
offset=$(( 16#$(printf '%s' "demo|nonprod|entra" | sha256sum | cut -c1-8) % 30 ))
want_date="$(date -u -d "-$offset days" +%Y%m%d)"
check "decide: a unit recorded for the first time is backdated by its stable offset ($offset days)" \
  test "$(jq -r '.apps.demo.environments.nonprod.units.entra.record' "$units_entra" | cut -d' ' -f3)" = "$want_date"
check "decide: a unit with a tag is recorded with today's date" \
  test "$(jq -r '.apps.demo.environments.nonprod.units.lz.record' "$units_entra" | cut -d' ' -f3)" = "$today"
check "decide: the retired tag saf-provisioned is handed to record" test "$(jq -r '.apps.demo.environments.prod.legacyTag' "$units_entra")" = "$(printf 'f%.0s' $(seq 64))"

decide_ws drift
plan_env drift nonprod "$recent"
plan_env drift prod "$old"
run_decide drift
check "decide: units last checked 40 days ago run (drift), ado in every environment of the app" test "$(outputs drift)" = \
  "ado=true entraPlan=true lz_nonprod=false post_nonprod=false record_nonprod=true registry_nonprod=false lz_prod=true post_prod=true record_prod=true "
check "decide: the drift reason" test "$(jq -r '[.apps.demo.environments.prod.units[] | select(.run) | .reasons | join(",")] | unique | join(" ")' "$tmp/drift/ws/saf-out/units/units.json")" = drift

decide_ws driftlater none closed
plan_env driftlater nonprod "$recent"
plan_env driftlater prod "$old"
run_decide driftlater
check "decide: outside the maintenance window the drift checks wait: nothing runs" test "$(outputs driftlater)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: ... each unit says what waits" test "$(jq -r '[.apps.demo.environments.prod.units[] | .waits[]] | unique | join(" ")' "$tmp/driftlater/ws/saf-out/units/units.json")" = \
  "drift check (last checked $(date -u -d '-40 days' +%F))"
check "decide: ... and the plan says the run is outside the window" grep -q '^Outside the maintenance window (next ' "$tmp/driftlater/out.log"

decide_ws unreleased
plan_env unreleased nonprod "$recent"
plan_env unreleased prod "$recent"
jq '.units.lz.since = "unreleased"' "$tmp/unreleased/ws/s/core/infra/app/units.json" > "$tmp/unreleased/u.json"
mv "$tmp/unreleased/u.json" "$tmp/unreleased/ws/s/core/infra/app/units.json"
run_decide unreleased
check "decide: a core whose units.json says unreleased fails and sets no output" \
  test "$(cat "$tmp/unreleased/rc")" != 0 -a -z "$(outputs unreleased)"

decide_ws noplan
plan_env noplan nonprod "$recent" lz
run_decide noplan
check "decide: an environment without its plan: its apps are not planned there, the others go on (entra checked: no Entra records read)" test "$(outputs noplan)" = \
  "ado=false entraPlan=true lz_nonprod=true post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: ... and the app is failed there" test "$(jq -r '.apps.demo.environments.prod.plan' "$tmp/noplan/ws/saf-out/units/units.json")" = failed

# ADR-0049: an outdated unit is held; the parameter upgrade runs it; a rebase only re-tags it.
decide_ws held
plan_env held nonprod "$recent"
plan_env held prod "$recent"
behind held release
run_decide held
check "decide: an outdated release is held: nothing runs" test "$(outputs held)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: ... and the unit says held, behind" test "$(jq -c '.apps.demo.environments.prod.units.release | [.run, .held, .reasons, .details]' "$tmp/held/ws/saf-out/units/units.json")" = \
  '[false,true,["held"],["release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2"]]'
decide_ws upgrade demo
plan_env upgrade nonprod "$recent"
plan_env upgrade prod "$recent"
behind upgrade release
run_decide upgrade
check "decide: the app in the parameter upgrade runs its outdated release (and frontdoor would run with it)" test "$(outputs upgrade)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=true record_prod=true "
check "decide: ... with the reasons upgrade and template" test "$(jq -r '.apps.demo.environments.nonprod.units.release.reasons | join(",")' "$tmp/upgrade/ws/saf-out/units/units.json")" = upgrade,template
decide_ws rebase
plan_env rebase nonprod "$recent"
plan_env rebase prod "$recent"
behind rebase release
files12="$(jq -r '.apps.demo.files[0:12]' "$tmp/rebase/ws/in/plan/unit-inputs.json")"
jq --arg f "$files12" '.tags["saf-u-release"] |= sub(" [0-9a-f]{12} "; " 000000000000 ") | .tags["saf-u-files"] = $f' \
  "$tmp/rebase/ws/in/plan_nonprod/facts/demo.json" > "$tmp/rebase/f.json"
mv "$tmp/rebase/f.json" "$tmp/rebase/ws/in/plan_nonprod/facts/demo.json"
run_decide rebase
check "decide: a rebase runs only record_<env> there" test "$(outputs rebase)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
want_i="$(jq -r '.apps.demo.environments.nonprod.release[0:12]' "$tmp/rebase/ws/in/plan/unit-inputs.json")"
check "decide: ... the rebased value keeps the version and the date, with the new i" \
  test "$(jq -r '.apps.demo.environments.nonprod.units.release.rebase' "$tmp/rebase/ws/saf-out/units/units.json")" = "v0.1.0-rc.2 $want_i $recent"
check "decide: ... and the files tag record writes" test "$(jq -r '.apps.demo.environments.nonprod.files' "$tmp/rebase/ws/saf-out/units/units.json")" = "$files12"

# The report of those runs (report.sh, ADR-0048 section 8): one line when nothing ran; else the units
# that ran and why, the stages skipped, the status table; an app not planned fails the run.
run_report() { # run_report <case>
  local ws="$tmp/$1/ws"
  # decide.sh linked in/units to saf-out/units (the job decide reads its own units.json there, ADR-0050).
  [ -e "$ws/in/units" ] || ln -s "$ws/saf-out/units" "$ws/in/units"
  set +e
  env -i PATH="$PATH" HOME="$HOME" PIPELINE_WORKSPACE="$ws" AGENT_TOOLSDIRECTORY="$tmp/$1/tools" BUILD_BUILDID=42 \
    SAF_ENVIRONMENTS_JSON='[{"name":"nonprod","kind":"nonprod","promoteFrom":""},{"name":"prod","kind":"prod","promoteFrom":"nonprod"}]' \
    bash "$repo/pipelines/azure-devops/scripts/provisioning/report.sh" > "$tmp/$1/report.log" 2>&1
  printf '%s' "$?" > "$tmp/$1/report.rc"
  set -e
}
run_report quiet
check "report: nothing to do is one line, and the run passes" \
  test "$(cat "$tmp/quiet/report.rc")" = 0 -a "$(grep -vc '^$' "$tmp/quiet/ws/saf-out/report/summary.md")" = 2
check "report: ... that line" grep -q '^Nothing to do: every unit of every app is recorded and up to date (1 app(s); only validate and plan ran)\.$' "$tmp/quiet/ws/saf-out/report/summary.md"
run_report entra
check "report: the unit that ran, why, and that it runs again (entra_plan didn't finish it here)" \
  grep -qxF '| demo | nonprod | entra (new) | - | entra |' "$tmp/entra/ws/saf-out/report/summary.md"
check "report: the stages skipped" grep -qxF 'Stages skipped (none of their units ran): azure_nonprod, azure_post_nonprod, azure_prod, azure_post_prod, record_prod, ado_resources, ado_pipelines, entra_plan' "$tmp/entra/ws/saf-out/report/summary.md"
check "report: cells of stages where none of the app's units ran are unchanged" \
  grep -qxF '| demo | - | ok | ok | unchanged | unchanged | unchanged | - | unchanged | - | unchanged | unchanged | unchanged | unchanged | unchanged | unchanged |' "$tmp/entra/ws/saf-out/report/summary.md"
run_report noplan
check "report: an app that could not be planned fails the run" test "$(cat "$tmp/noplan/report.rc")" != 0
run_report held
check "report: held units: nothing ran, they are behind (ADR-0049)" \
  grep -qxF 'Nothing to do: every unit of every app is recorded; 2 unit(s) are behind, held for an upgrade (1 app(s)).' "$tmp/held/ws/saf-out/report/summary.md"
check "report: ... one row per environment, what changed and what applied it" \
  grep -qxF '| demo | prod | release (release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2) |' "$tmp/held/ws/saf-out/report/summary.md"
check "report: ... and the run passes" test "$(cat "$tmp/held/report.rc")" = 0
run_report upgrade
check "report: the apps the parameter upgrade named" grep -qxF 'Upgrade requested (parameter upgrade): demo.' "$tmp/upgrade/ws/saf-out/report/summary.md"
check "report: the upgraded unit ran, with its reasons" grep -q '^| demo | nonprod | release (upgrade, template: release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2) |' "$tmp/upgrade/ws/saf-out/report/summary.md"
run_report rebase
check "report: a rebased unit is behind, marked rebased" \
  grep -qxF '| demo | nonprod | release (release changed in v0.1.0-rc.3; applied by v0.1.0-rc.2; rebased) |' "$tmp/rebase/ws/saf-out/report/summary.md"
run_report driftlater
check "report: outside the window, what waits for it, per app and environment (ADR-0048 section 7, amended)" \
  grep -qF "| demo | prod | lz (drift check (last checked $(date -u -d '-40 days' +%F))), entra (drift check" "$tmp/driftlater/ws/saf-out/report/summary.md"
check "report: ... under its heading, and the run passes" \
  test "$(grep -c '^### Waiting for the maintenance window$' "$tmp/driftlater/ws/saf-out/report/summary.md")" = 1 -a "$(cat "$tmp/driftlater/report.rc")" = 0

# --- 6. custom domain removal and the previous host of a change (ADR-0010, amended 2026-11-11) ---
# front_door_cleanup and its helpers, taken from azure-post.sh, with a fake az (ARM GET/DELETE,
# deployment delete, deployment operations) and a fake `platform provisioning fd-cleanup` that copies
# a prepared plan. ADR-0052: only this app's custom domain (its hostName), only DNS records with its
# mark (or without one next to a CNAME that still points at the endpoint), the nested records of its
# own deployment; and fd_dns_guard before a deployment refuses a record set that isn't the app's.
post="$repo/pipelines/azure-devops/scripts/provisioning/azure-post.sh"
read -r -d '' fdcode <<'EOS' || true
PROV_STAGE=azure_post_test
env_name=test
slug=app-a
app_file=/dev/null
subscription=00000000-0000-0000-0000-00000000a001
SAF_APPS_JSON="$SAF_WORK/apps.json"
echo '{"apps": []}' > "$SAF_APPS_JSON"
eval "$(sed -n -e '/^front_door_cleanup() {/,/^}/p' -e '/^FD_API=/p' -e '/^DNS_API=/p' -e '/^fd_delete() {/,/^}/p' \
  -e '/^fd_domain_linked() {/,/^}/p' -e '/^fd_dns_cleanup() {/,/^}/p' -e '/^fd_dns_read() {/,/^}/p' \
  -e '/^fd_dns_owner() {/,/^}/p' -e '/^fd_cname_target() {/,/^}/p' -e '/^fd_domain_owned() {/,/^}/p' \
  -e '/^fd_nested_cleanup() {/,/^}/p' -e '/^fd_dns_guard() {/,/^}/p' -e '/^fd_dns_refuse() {/,/^}/p' \
  -e '/^fd_endpoint_host() {/,/^}/p' "$POST")"
sleep() { :; }
saf_cli() {
  if [ "$2" = fd-dns-guard ]; then cp "$SAF_WORK/guard.json" "${@: -1}"; else cp "$SAF_WORK/plan.json" "${@: -1}"; fi
}
az() {
  local method="" url="" name="" rg=""
  if [ "$1 $2 $3 $4" = "deployment operation group list" ]; then cat "$SAF_WORK/ops.txt" 2> /dev/null; return 0; fi
  if [ "$1 $2 $3" = "deployment group delete" ]; then
    while [ $# -gt 0 ]; do
      case "$1" in --name) name="$2"; shift ;; --resource-group) rg="$2"; shift ;; esac
      shift
    done
    echo "RECORD-DELETE $rg/$name" >> "$SAF_WORK/calls"
    return 0
  fi
  while [ $# -gt 0 ]; do
    case "$1" in --method) method="$2"; shift ;; --url) url="$2"; shift ;; esac
    shift
  done
  url="${url%%\?*}"
  if [ "$method" = delete ]; then
    echo "DELETE ${url##*/}" >> "$SAF_WORK/calls"
    echo "$url" >> "$SAF_WORK/deleted"
    return 0
  fi
  if [[ "$url" == */routes ]]; then cat "$SAF_WORK/routes.json"; return 0; fi
  if grep -qxF "$url" "$SAF_WORK/deleted" 2> /dev/null; then echo "ERROR: (ResourceNotFound) gone" >&2; return 1; fi
  if [[ "$url" == */afdEndpoints/fde-contoso-test ]]; then echo 'fde-contoso-test-abc.z01.azurefd.net'; return 0; fi
  if [[ "$url" == */customDomains/* ]]; then
    if [ -s "$SAF_WORK/cdhost.txt" ]; then cat "$SAF_WORK/cdhost.txt"; else jq -r --arg u "$url" '.domains[] | select(.customDomainId == $u) | .host' "$SAF_WORK/plan.json"; fi
    return 0
  fi
  local f=""
  case "$url" in */CNAME/*) f="$SAF_WORK/cname.json" ;; */TXT/*) f="$SAF_WORK/txt.json" ;; esac
  if [ -n "$f" ]; then
    if [ -s "$f" ]; then cat "$f"; return 0; fi
    echo "ERROR: (NotFound) no record" >&2
    return 1
  fi
  return 0
}
profile="/subscriptions/$subscription/resourceGroups/rg-contoso-platform-test/providers/Microsoft.Cdn/profiles/afd-contoso-test"
zone="/subscriptions/$subscription/resourceGroups/rg-dns/providers/Microsoft.Network/dnsZones/contoso.com"
endpoint_host=fde-contoso-test-abc.z01.azurefd.net
# record <file> <metadata app|-|none> [CNAME target]: a record set as ARM returns it.
record() {
  local meta='null'
  case "$2" in
    none) meta='null' ;;
    -) meta='{"saf-app": "app-a", "saf-env": "test"}' ;;
    *) meta="{\"SAF-APP\": \"$2\", \"saf-env\": \"test\"}" ;;
  esac
  jq -n --argjson m "$meta" --arg t "${3:-}" '{properties: ({metadata: $m} + (if $t == "" then {TXTRecords: [{value: ["x"]}]} else {CNAMERecord: {cname: $t}} end))}' > "$SAF_WORK/$1"
}
plan() { # plan <removeRoute> <dns: zone|manual> <host>
  local dns='null' manual='null'
  if [ "$2" = zone ]; then
    dns="{\"zoneId\": \"$zone\", \"cnameId\": \"$zone/CNAME/${3%%.*}\", \"txtId\": \"$zone/TXT/_dnsauth.${3%%.*}\"}"
  else
    manual="{\"cname\": \"$3\", \"txt\": \"_dnsauth.$3\", \"zone\": \"contoso.com\"}"
  fi
  cat > "$SAF_WORK/plan.json" <<EOF
{"slug": "app-a", "environmentName": "test", "deployment": "fd-app-a-test", "resourceGroup": "rg-contoso-platform-test",
 "profileId": "$profile", "endpointId": "$profile/afdEndpoints/fde-contoso-test", "removeRoute": $1,
 "routeId": "$profile/afdEndpoints/fde-contoso-test/routes/route-app-a-test", "originGroupId": "$profile/originGroups/og-app-a-test",
 "expectedCname": "$endpoint_host",
 "domains": [{"host": "$3", "customDomainId": "$profile/customDomains/cd-${3//./-}", "dns": $dns, "manualDns": $manual}], "skipped": []}
EOF
}
case_run() { # case_run <label> <release mode> <removing host or ''> <removal|change>
  PROV_DIR="$SAF_WORK/$1"
  mkdir -p "$PROV_DIR/frontdoor" "$PROV_DIR/release"
  echo '{}' > "$PROV_DIR/frontdoor/before.json"
  echo '{}' > "$PROV_DIR/frontdoor/deployment.json"
  echo "{\"frontDoor\": {\"mode\": \"$2\"}}" > "$PROV_DIR/release/release.json"
  rm -f "$SAF_WORK/calls" "$SAF_WORK/deleted"
  fd_removing="$3"
  rc=0
  ( set -e; front_door_cleanup "$4" ) > "$PROV_DIR/out.log" 2>&1 || rc=$?
  echo "$1 rc=$rc calls=[$(tr '\n' ' ' < "$SAF_WORK/calls" 2> /dev/null)] detail=$(jq -c . "$PROV_DIR/detail.json" 2> /dev/null)"
}
echo '{"value": [{"properties": {"customDomains": [{"id": "/other"}]}}]}' > "$SAF_WORK/routes.json"
printf '%s\n' "/subscriptions/$subscription/resourceGroups/rg-contoso-platform-test/providers/Microsoft.Resources/deployments/appRoute-abcdefghij123" \
  "/subscriptions/$subscription/resourceGroups/rg-dns/providers/Microsoft.Resources/deployments/dnsRecords-abcdefghij123" \
  "/subscriptions/$subscription/resourceGroups/rg-other/providers/Microsoft.Resources/deployments/dnsRecords-zzzzzzzzzzzzz" \
  "/subscriptions/00000000-0000-0000-0000-00000000ffff/resourceGroups/rg-dns/providers/Microsoft.Resources/deployments/appRoute-abcdefghij123" > "$SAF_WORK/ops.txt"
record cname.json - "$endpoint_host."
record txt.json -
plan true zone app-a.contoso.com
case_run removal none app-a.contoso.com removal
case_run removal-locked managed app-a.contoso.com removal
record cname.json - somewhere-else.example.net
case_run cname-elsewhere none app-a.contoso.com removal
record cname.json app-b "$endpoint_host"
case_run cname-other none app-a.contoso.com removal
: > "$SAF_WORK/cname.json"
case_run cname-gone none app-a.contoso.com removal
record txt.json none
case_run legacy-txt-alone none app-a.contoso.com removal
record cname.json none "$endpoint_host"
case_run legacy none app-a.contoso.com removal
record txt.json -
echo 'app.a.example.com' > "$SAF_WORK/cdhost.txt"
case_run domain-other none app-a.contoso.com removal
grep -h 'holds another host' "$SAF_WORK/domain-other/out.log" | head -n 1
rm -f "$SAF_WORK/cdhost.txt"
plan true manual app-a.contoso.com
case_run manual none app-a.contoso.com removal
grep -h 'DNS by hand' "$SAF_WORK/manual/out.log" | head -n 1
plan false zone old-a.contoso.com
record cname.json - "$endpoint_host"
case_run change managed '' change
case_run not-removing none '' removal
echo "{\"value\": [{\"properties\": {\"customDomains\": [{\"id\": \"${profile^^}/CUSTOMDOMAINS/CD-OLD-A-CONTOSO-COM\"}]}}]}" > "$SAF_WORK/routes.json"
case_run linked managed '' change
grep -h 'a route still serves' "$SAF_WORK/linked/out.log" | head -n 1
PROV_DIR="$SAF_WORK/foreign"
mkdir -p "$PROV_DIR/frontdoor"
rm -f "$SAF_WORK/calls"
rc=0
( set -e; fd_delete "/subscriptions/00000000-0000-0000-0000-00000000ffff/resourceGroups/rg-contoso-platform-test/providers/Microsoft.Cdn/profiles/afd-contoso-test/customDomains/cd-x" "$FD_API" ) > /dev/null 2>&1 || rc=$?
echo "foreign rc=$rc calls=[$(tr '\n' ' ' < "$SAF_WORK/calls" 2> /dev/null)]"
rc=0
( set -e; fd_delete "/subscriptions/$subscription/resourceGroups/rg-app/providers/Microsoft.App/containerApps/ca-app-a" "$FD_API" ) > /dev/null 2>&1 || rc=$?
echo "not-front-door rc=$rc calls=[$(tr '\n' ' ' < "$SAF_WORK/calls" 2> /dev/null)]"
# fd_dns_guard (step 3, before the deployment): <label> -> rc and the detail.
mkdir -p "$SAF_WORK/out/lz-outputs"
out="$SAF_WORK/out"
echo '{"containerAppFqdn": {"value": "ca-app-a.example.io"}}' > "$out/lz-outputs/app-a.test.json"
jq -n --arg z "$zone" --arg p "$profile" '{slug: "app-a", environmentName: "test", host: "app-a.contoso.com", zoneId: $z,
  cnameId: "\($z)/CNAME/app-a", txtId: "\($z)/TXT/_dnsauth.app-a", endpointId: "\($p)/afdEndpoints/fde-contoso-test"}' > "$SAF_WORK/guard.json"
guard() { # guard <label>
  PROV_DIR="$SAF_WORK/g-$1"
  mkdir -p "$PROV_DIR"
  host=app-a.contoso.com
  rc=0
  ( set -e; fd_dns_guard "$PROV_DIR" ) > "$PROV_DIR/out.log" 2>&1 || rc=$?
  echo "guard $1 rc=$rc detail=$(jq -c . "$PROV_DIR/detail.json" 2> /dev/null)"
}
rm -f "$SAF_WORK/deleted"
: > "$SAF_WORK/cname.json"
: > "$SAF_WORK/txt.json"
guard absent
record cname.json - "$endpoint_host"
record txt.json -
guard mine
record cname.json none "$endpoint_host"
record txt.json none
guard legacy-endpoint
record cname.json none ca-app-a.example.io
guard legacy-default-host
record cname.json none portal.contoso.com
guard foreign-cname
grep -h 'never overwrites' "$SAF_WORK/g-foreign-cname/out.log" | head -n 1
record cname.json app-b "$endpoint_host"
guard other-app
: > "$SAF_WORK/cname.json"
guard lone-txt
record txt.json app-b
guard other-txt
jq '.zoneId = ""' "$SAF_WORK/guard.json" > "$SAF_WORK/g.json" && mv "$SAF_WORK/g.json" "$SAF_WORK/guard.json"
guard manual-zone
EOS
run_stage fdclean "POST='$post'
$fdcode"
s="$tmp/fdclean/out.log"
nested='RECORD-DELETE rg-contoso-platform-test/appRoute-abcdefghij123 RECORD-DELETE rg-dns/dnsRecords-abcdefghij123 RECORD-DELETE rg-contoso-platform-test/fd-app-a-test'
check "cleanup: a removal deletes the route, the custom domain, the origin group, the CNAME, the TXT, the nested records of its own deployment, then the record" \
  grep -qxF "removal rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test DELETE app-a DELETE _dnsauth.app-a $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: ... never a nested record in another resource group or subscription" grep -q 'unexpected' "$tmp/fdclean/ws/saf-work/removal/out.log"
check "cleanup: nothing is deleted while the release is still behind Front Door" grep -qx 'removal-locked rc=1 calls=\[\] detail=' "$s"
check "cleanup: a CNAME pointing elsewhere keeps both DNS records" \
  grep -qxF "cname-elsewhere rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: a CNAME with another app's mark keeps both DNS records (mark keys in any case)" \
  grep -qxF "cname-other rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: a CNAME already gone still removes a TXT with this app's mark" \
  grep -qxF "cname-gone rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test DELETE _dnsauth.app-a $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: a TXT without a mark and no CNAME next to it is left alone" \
  grep -qxF "legacy-txt-alone rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: records without a mark (an older core) go when the CNAME points at the endpoint" \
  grep -qxF "legacy rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test DELETE app-a DELETE _dnsauth.app-a $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: a custom domain that holds another host (cd-{host} isn't injective) is left alone" \
  grep -qxF "domain-other rc=0 calls=[DELETE route-app-a-test DELETE og-app-a-test DELETE app-a DELETE _dnsauth.app-a $nested ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: ... with a warning" grep -q 'the custom domain cd-app-a-contoso-com holds another host than app-a.contoso.com now' "$s"
check "cleanup: a manual zone deletes no record and reports both for the DNS team (no zone named: dnsRecords-* left alone)" \
  grep -qxF "manual rc=0 calls=[DELETE route-app-a-test DELETE cd-app-a-contoso-com DELETE og-app-a-test RECORD-DELETE rg-contoso-platform-test/appRoute-abcdefghij123 RECORD-DELETE rg-contoso-platform-test/fd-app-a-test ] detail={\"frontDoor\":\"removed\"}" "$s"
check "cleanup: the DNS team's report names both records" \
  grep -q 'DNS by hand (the DNS team): delete the CNAME app-a.contoso.com and the TXT _dnsauth.app-a.contoso.com in the zone contoso.com' "$s"
check "cleanup: a host change deletes only the previous custom domain and its records, never the route, nested records or the record" \
  grep -qxF 'change rc=0 calls=[DELETE cd-old-a-contoso-com DELETE old-a DELETE _dnsauth.old-a ] detail={"frontDoorPrevious":"removed"}' "$s"
check "cleanup: the removal call does nothing for an app that still requests its domain" grep -qx 'not-removing rc=0 calls=\[\] detail=' "$s"
check "cleanup: a custom domain a route still links is left alone (IDs compared in any case)" \
  grep -qxF 'linked rc=0 calls=[DELETE old-a DELETE _dnsauth.old-a ] detail={"frontDoorPrevious":"removed"}' "$s"
check "fd_delete: refuses an ID in another subscription" grep -qx 'foreign rc=1 calls=\[\]' "$s"
check "fd_delete: refuses anything but a Front Door object or a DNS record set" grep -qx 'not-front-door rc=1 calls=\[\]' "$s"
check "dns guard: absent records, this app's, and records without a mark next to a CNAME to the endpoint or the app's default host pass" \
  test "$(grep -c -x -e 'guard absent rc=0 detail=' -e 'guard mine rc=0 detail=' -e 'guard legacy-endpoint rc=0 detail=' -e 'guard legacy-default-host rc=0 detail=' -e 'guard manual-zone rc=0 detail=' "$s")" = 5
check "dns guard: a CNAME elsewhere without a mark, another app's CNAME or TXT, a TXT without a mark alone: refused (dns-conflict)" \
  test "$(grep -c -x -e 'guard foreign-cname rc=1 detail={"frontDoor":"app-a.contoso.com dns-conflict"}' -e 'guard other-app rc=1 detail={"frontDoor":"app-a.contoso.com dns-conflict"}' \
    -e 'guard lone-txt rc=1 detail={"frontDoor":"app-a.contoso.com dns-conflict"}' -e 'guard other-txt rc=1 detail={"frontDoor":"app-a.contoso.com dns-conflict"}' "$s")" = 4
check "dns guard: the refusal says how to fix it" grep -q 'never overwrites a record set that isn.t this app.s (ADR-0052): delete it, or, when it is this app.s, add the metadata saf-app=app-a and saf-env=test' "$s"
# --- 6b. the stale re-apply race (ADR-0052 open findings): race_check after a re-apply --------------
read -r -d '' racecode <<'EOS' || true
PROV_STAGE=azure_post_test
env_name=test
slug=app-a
subscription=00000000-0000-0000-0000-00000000a001
rg=rg-contoso-app-app-a-test
container_app=ca-app-a
PROV_ARM_HOST=management.azure.com
eval "$(sed -n -e '/^race_check() {/,/^}/p' "$POST")"
az() {
  if [ "$1 $2" = "resource show" ]; then cat "$SAF_WORK/tag.txt"; return 0; fi
  if [ "$1 $2" = "rest --method" ]; then cat "$SAF_WORK/revisions.json"; return 0; fi
  return 1
}
dir="$SAF_WORK/race"
mkdir -p "$dir"
PROV_DIR="$dir"
echo '{"properties": {"parameters": {"run": {"value": {"id": 41}}}}}' > "$dir/release-record.json"
echo '{"properties": {"outputs": {"image": {"value": "cr.example/app-a@sha256:old"}}}}' > "$dir/deployment.json"
run_checked_at="$(date -u +%s)"
recent="$(date -u -d '+5 seconds' +%Y-%m-%dT%H:%M:%S.123Z)"
earlier="$(date -u -d '-1 day' +%Y-%m-%dT%H:%M:%S+00:00)"
rev() { jq -n --arg t "$1" --arg i "$2" '{properties: {createdTime: $t, template: {containers: [{image: $i}]}}}'; }
race() { # race <label>
  rm -f "$dir/detail.json"
  ( set -e; race_check "$dir" ) > "$dir/$1.log" 2>&1
  echo "race $1 rc=$? detail=$(jq -c . "$dir/detail.json" 2> /dev/null)"
}
echo 41 > "$SAF_WORK/tag.txt"
jq -n --argjson a "$(rev "$earlier" cr.example/app-a@sha256:new)" --argjson b "$(rev "$recent" cr.example/app-a@sha256:old)" '{value: [$a, $b]}' > "$SAF_WORK/revisions.json"
race quiet
jq -n --argjson a "$(rev "$recent" cr.example/app-a@sha256:new)" --argjson b "$(rev "$recent" cr.example/app-a@sha256:old)" '{value: [$a, $b]}' > "$SAF_WORK/revisions.json"
race raced
grep -h 'Redeploy the app' "$dir/raced.log" | head -n 1
echo 42 > "$SAF_WORK/tag.txt"
race delivery-after
EOS
run_stage race "POST='$post'
$racecode"
s="$tmp/race/out.log"
check "race_check: only this re-apply's revision since the check: nothing to report" grep -qx 'race quiet rc=0 detail=' "$s"
check "race_check: a revision of another image since the check: a delivery raced, release reapplied-raced (not recorded)" \
  grep -qxF 'race raced rc=0 detail={"release":"reapplied-raced"}' "$s"
check "race_check: ... with a warning that says to redeploy" grep -q "Redeploy the app's latest delivery run now" "$s"
check "race_check: saf-run-id moved on: a delivery deployed after the re-apply, its release stands" grep -qx 'race delivery-after rc=0 detail=' "$s"

# --- 7. record_tags (record.sh) and prov_tags_restore with a fake az (ADR-0048 section 3) --------
record="$repo/pipelines/azure-devops/scripts/provisioning/record.sh"
tag_old="v0.1.0-rc.2 cccccccccccc 20261001"
read -r -d '' reccode <<'EOS' || true
PROV_STAGE=record_test
env_name=test
subscription=00000000-0000-0000-0000-00000000a001
host=test
eval "$(sed -n -e '/^record_tags() {/,/^}/p' "$RECORD")"
az() { printf '%s\n' "$*" >> "$SAF_WORK/az.log"; }
# plan-names --apps: the app resource groups by naming (ADR-0052).
app_names="$SAF_WORK/record-names.json"
echo '{"appResourceGroups": {"app-a": "rg-app-a-test", "app-b": "rg-app-b-test"}}' > "$app_names"
mkdir -p "$SAF_IN/units" "$SAF_IN/plan"
echo '{"checkAllApps": false, "apps": [{"slug": "app-a", "ok": true, "environments": ["test"], "authMode": "anonymous", "frontDoorHosts": {}}]}' > "$SAF_APPS_JSON"
u() { jq -n --argjson run "$1" --arg tag "$2" --arg rec "$3" --arg reb "${4:-}" '{run: $run, reasons: [], details: [], tag: (if $tag == "" then null else $tag end), record: (if $rec == "" then null else $rec end), rebase: (if $reb == "" then null else $reb end)}'; }
jq -n --argjson lz "$(u true "$TAG_A" "$REC_A")" --argjson entra "$(u true "$TAG_OLD" "$REC_A")" --argjson release "$(u false "$TAG_A" "$REC_A")" \
  --argjson frontdoor "$(u false "" "" "$REB")" --argjson pep "$(u true "" "$REC_A")" --arg legacy "$(printf 'f%.0s' $(seq 64))" \
  '{schemaVersion: 1, stages: {}, apps: {"app-a": {environments: {test: {plan: "ok", resourceGroup: "rg-app-a-test", legacyTag: $legacy,
    filesTag: "abcdefabcdef", files: "0123456789ab",
    entraSingleHost: true, units: {lz: $lz, entra: $entra, release: $release, frontdoor: $frontdoor, pep: $pep}}}}}}' > "$SAF_UNITS_JSON"
st() { mkdir -p "$(dirname "$1")"; jq -n --arg s "$2" --argjson done "${3:-[]}" '{status: $s, detail: {}, done: $done}' > "$1"; }
st "$SAF_IN/azure_test/status/app-a.test.json" ok
st "$SAF_IN/azure_post_test/status/app-a.test.json" ok '["lz", "release"]'
PROV_DIR="$SAF_WORK/rec"
mkdir -p "$PROV_DIR"
( set -e; record_tags app-a ) > "$SAF_WORK/rec.log" 2>&1 || echo "record_tags failed"
sed 's/^/AZ /' "$SAF_WORK/az.log"
grep -h 'recorded' "$SAF_WORK/rec.log"
rm -f "$SAF_WORK/az.log"
# A plan that names another group than naming: nothing is written (ADR-0052).
cp "$SAF_UNITS_JSON" "$SAF_WORK/units.keep"
jq '.apps["app-a"].environments.test.resourceGroup = "rg-app-b-test"' "$SAF_WORK/units.keep" > "$SAF_UNITS_JSON"
( set -e; record_tags app-a ) > "$SAF_WORK/rec2.log" 2>&1 || echo "record_tags refused another group"
[ ! -s "$SAF_WORK/az.log" ] || echo "AZ AFTER REFUSAL"
cp "$SAF_WORK/units.keep" "$SAF_UNITS_JSON"
slug=app-a
PROV_DIR="$SAF_WORK/restore"
mkdir -p "$PROV_DIR"
names="$SAF_WORK/names.json"
echo '{"outputs": {"appResourceGroup": "rg-app-a-test"}}' > "$names"
( set -e; prov_tags_restore rg-app-a-test; prov_tags_restore "Bad Name"; prov_tags_restore rg-app-b-test ) > "$SAF_WORK/restore.log" 2>&1 || echo "restore failed"
sed 's/^/RESTORE /' "$SAF_WORK/az.log"
grep -c 'are not written back' "$SAF_WORK/restore.log" | sed 's/^/WARNINGS /'
EOS
reb="v0.1.0-rc.2 dddddddddddd 20261001"
run_stage record "RECORD='$record' TAG_A='$tag_a' REC_A='$rec_a' TAG_OLD='$tag_old' REB='$reb'
$reccode"
s="$tmp/record/out.log"
rgid="/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-a-test"
check "record_tags: a finished unit gets the plan's value, a held one its rebase, saf-u-files with them (merge)" \
  grep -qxF "AZ tag update --resource-id $rgid --operation merge --tags saf-u-lz=$rec_a saf-u-frontdoor=$reb saf-u-files=0123456789ab --only-show-errors --output none" "$s"
check "record_tags: units that ran and didn't finish lose their tag by name and value; the retired saf-provisioned too" \
  grep -qxF "AZ tag update --resource-id $rgid --operation delete --tags saf-u-entra=$tag_old saf-provisioned=$(printf 'f%.0s' $(seq 64)) --only-show-errors --output none" "$s"
check "record_tags: a unit that didn't run keeps its tag, one without a tag isn't deleted" test "$(grep -c '^AZ ' "$s")" = 2
check "record_tags: a plan that names another resource group than naming fails, nothing is written (ADR-0052)" \
  test "$(grep -c -x -e "record_tags refused another group" -e "AZ AFTER REFUSAL" "$s")" = 1 -a "$(grep -c -x "record_tags refused another group" "$s")" = 1
check "record_tags: says what is recorded, what runs again and what is rebased" grep -q "recorded lz; not finished (runs again next time): entra pep; rebased: frontdoor" "$s"
check "prov_tags_restore: writes back the tags as the plan read them, after a landing-zone deployment" \
  grep -qxF "RESTORE tag update --resource-id $rgid --operation merge --tags saf-u-lz=$tag_a saf-u-entra=$tag_old saf-u-release=$tag_a saf-u-files=abcdefabcdef --only-show-errors --output none" "$s"
check "prov_tags_restore: an invalid group name, or another group than the app's by naming (ADR-0052), is a warning, nothing written (fail safe)" \
  test "$(grep -c '^RESTORE ' "$s")" = 1 -a "$(grep -x 'WARNINGS [0-9]*' "$s")" = "WARNINGS 2"

# --- 8. decommissioning (ADR-0056): the plan's actions, record_tags of retire and delete ----------
read -r -d '' decomcode <<'EOS' || true
PROV_STAGE=record_test
env_name=test
subscription=00000000-0000-0000-0000-00000000a001
host=test
eval "$(sed -n -e '/^record_tags() {/,/^}/p' -e '/^lz_record_delete() {/,/^}/p' "$RECORD")"
# The fake az: logs every call; the groups are gone (`group exists` false), a record is there (`show` ok).
az() { printf '%s\n' "$*" >> "$SAF_WORK/az.log"; if [ "$1 $2" = "group exists" ]; then echo false; fi; }
app_names="$SAF_WORK/record-names.json"
echo '{"appResourceGroups": {"app-r": "rg-app-r-test", "app-d": "rg-app-d-test", "app-l": "rg-app-l-test", "app-c": "rg-app-c-test", "app-i": "rg-app-i-test", "app-g": "rg-app-g-test", "app-z": "rg-app-z-test", "app-w": "rg-app-w-test"},
  "landingZoneRecords": {"app-l": "lz-app-l-test", "app-z": "lz-app-z-test", "app-w": "lz-app-w-test"}}' > "$app_names"
mkdir -p "$SAF_IN/units" "$SAF_IN/plan"
echo '{"checkAllApps": false, "apps": []}' > "$SAF_APPS_JSON"
u() { jq -n --argjson run "$1" --arg tag "$2" --arg rec "$3" --arg act "${4:-}" '{run: $run, reasons: [], details: [], tag: (if $tag == "" then null else $tag end), record: (if $rec == "" then null else $rec end), rebase: null} + (if $act == "" then {} else {action: $act} end)'; }
envd() { # envd <rg> <units json> [retired json]
  jq -n --arg rg "$1" --argjson units "$2" --argjson retired "${3:-null}" '{plan: "ok", resourceGroup: $rg, legacyTag: null, filesTag: null, files: "0123456789ab", entraSingleHost: true, units: $units} + (if $retired == null then {} else {retired: $retired} end)'
}
# app-r: retired (release retire ran and finished; the stop's date the first time).
# app-d: delete phase step 1 (entra and pep deleted, frontdoor's delete not finished).
# app-l: delete phase step 2 (lz delete).
# app-c: active again (Cancel): saf-u-retired removed.
# app-i: an immediate decommissioning's first run (amendment 2026-11-12): the stop and step 1 together.
# app-g: its group is gone, an Entra registration was left (deleted, nothing to record: no group).
# app-z: step 2 finished in this run and its service connection is gone: the landing zone's record goes.
# app-w: step 2 finished, but the connection isn't deleted yet: the record stays (the next run resumes).
jq -n \
  --argjson r "$(envd rg-app-r-test "$(jq -n --argjson rel "$(u true "$TAG_A" "$REC_A" retire)" --argjson lz "$(u false "$TAG_A" "")" '{release: $rel, lz: $lz}')" '{"tag": null, "record": "20261112", "remove": false}')" \
  --argjson d "$(envd rg-app-d-test "$(jq -n --argjson e "$(u true "$TAG_A" "removed 20261112" delete)" --argjson p "$(u true "$TAG_A" "removed 20261112" delete)" --argjson f "$(u true "$TAG_A" "removed 20261112" delete)" --argjson lz "$(u false "$TAG_A" "")" '{entra: $e, pep: $p, frontdoor: $f, lz: $lz}')")" \
  --argjson l "$(envd rg-app-l-test "$(jq -n --argjson lz "$(u true "$TAG_A" "" delete)" '{lz: $lz}')")" \
  --argjson c "$(envd rg-app-c-test "$(jq -n --argjson rel "$(u true "$TAG_A" "$REC_A")" '{release: $rel}')" '{"tag": "20261101", "record": null, "remove": true}')" \
  --argjson i "$(envd rg-app-i-test "$(jq -n --argjson rel "$(u true "$TAG_A" "$REC_A" retire)" --argjson e "$(u true "$TAG_A" "removed 20261112" delete)" --argjson f "$(u true "$TAG_A" "removed 20261112" delete)" --argjson lz "$(u false "$TAG_A" "")" '{release: $rel, entra: $e, frontdoor: $f, lz: $lz}')" '{"tag": null, "record": "20261112", "remove": false}')" \
  --argjson g "$(envd rg-app-g-test "$(jq -n --argjson e "$(u true "" "" delete)" --argjson lz "$(u false "" "")" '{entra: $e, lz: $lz}')" '{"tag": null, "record": null, "remove": false}')" \
  --argjson z "$(envd rg-app-z-test "$(jq -n --argjson lz "$(u true "$TAG_A" "" delete)" --argjson a "$(u true "removed 20261101" "removed 20261101" delete)" '{lz: $lz, ado: $a}')")" \
  --argjson w "$(envd rg-app-w-test "$(jq -n --argjson lz "$(u true "$TAG_A" "" delete)" --argjson a "$(u true "removed 20261101" "removed 20261101" delete)" '{lz: $lz, ado: $a}')")" \
  '{schemaVersion: 1, stages: {}, apps: {"app-r": {environments: {test: $r}}, "app-d": {environments: {test: $d}}, "app-l": {environments: {test: $l}}, "app-c": {environments: {test: $c}}, "app-i": {environments: {test: $i}}, "app-g": {environments: {test: $g}},
    "app-z": {environments: {test: $z}}, "app-w": {environments: {test: $w}}}}' > "$SAF_UNITS_JSON"
st() { mkdir -p "$(dirname "$1")"; jq -n --arg s "$2" --argjson done "${3:-[]}" --argjson d "${4:-{\}}" '{status: $s, detail: $d, done: $done}' > "$1"; }
st "$SAF_IN/azure_post_test/status/app-r.test.json" ok '["release"]' '{"release": "retired"}'
st "$SAF_IN/azure_post_test/status/app-c.test.json" ok '["release"]'
st "$SAF_IN/entra/status/app-d.test.json" ok '["delete-entra"]'
st "$SAF_IN/azure_post_test/portal/status/app-d.test.json" ok '["delete-pep"]'
st "$SAF_IN/azure_post_test/status/app-d.test.json" failed '[]'
st "$SAF_IN/azure_post_test/status/app-i.test.json" ok '["release", "delete-frontdoor"]' '{"release": "retired", "frontDoor": "removed"}'
st "$SAF_IN/entra/status/app-i.test.json" ok '["delete-entra"]'
st "$SAF_IN/entra/status/app-g.test.json" ok '["delete-entra"]'
st "$SAF_IN/azure_test/status/app-z.test.json" ok '["delete-lz"]'
st "$SAF_IN/ado/status/app-z.json" ok '["delete-ado"]' '{"connection-test": "gone"}'
st "$SAF_IN/azure_test/status/app-w.test.json" ok '["delete-lz"]'
st "$SAF_IN/ado/status/app-w.json" ok '["delete-ado"]'
# The helpers.
prov_units_check
echo "ACTION $(prov_unit_action app-r test release) $(prov_unit_action app-d test entra) $(prov_unit_action app-l test lz) $(prov_unit_action app-c test release) $(prov_unit_action app-d test lz)"
if prov_post_runs app-l test; then echo "POST lz-delete runs azure_post"; else echo "POST lz-delete not in azure_post"; fi
if prov_was_retired app-c test; then echo "CANCEL app-c"; fi
if prov_was_retired app-r test; then echo "CANCEL app-r"; fi
echo "TAG $(prov_unit_tag app-d test entra record)"
for s in app-r app-d app-l app-c app-i app-g app-z app-w; do
  PROV_DIR="$SAF_WORK/rec-$s"
  mkdir -p "$PROV_DIR"
  ( set -e; record_tags "$s" ) > "$SAF_WORK/rec-$s.log" 2>&1 || echo "record_tags $s failed"
done
sed 's/^/AZ /' "$SAF_WORK/az.log"
grep -h 'resource group was being deleted' "$SAF_WORK"/rec-app-l.log | sed 's/^/SKIP /'
EOS
run_stage decom "RECORD='$record' TAG_A='$tag_a' REC_A='$rec_a'
$decomcode"
s="$tmp/decom/out.log"
check "decommission: prov_unit_action reads retire and delete from the plan, apply otherwise" grep -qxF "ACTION retire delete delete apply apply" "$s"
check "decommission: a landing zone's delete runs in azure_<env> only, not in azure_post_<env>" grep -qxF "POST lz-delete not in azure_post" "$s"
check "decommission: Cancel (retired.remove) is told apart from a retired app" test "$(grep -c '^CANCEL' "$s")" = 1 -a "$(grep -c '^CANCEL app-c$' "$s")" = 1
check "decommission: a removed tag (\"removed YYYYMMDD\") is a value record may write" grep -qxF "TAG removed 20261112" "$s"
check "decommission: a finished retire records the release tag and, the first time, saf-u-retired" \
  grep -qxF "AZ tag update --resource-id /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-r-test --operation merge --tags saf-u-release=$rec_a saf-u-retired=20261112 saf-u-files=0123456789ab --only-show-errors --output none" "$s"
check "decommission: finished deletes record removed; an unfinished one loses its tag (runs again)" \
  grep -qxF "AZ tag update --resource-id /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-d-test --operation merge --tags saf-u-entra=removed 20261112 saf-u-pep=removed 20261112 saf-u-files=0123456789ab --only-show-errors --output none" "$s"
check "decommission: the unfinished Front Door delete loses its tag by name and value" \
  grep -qxF "AZ tag update --resource-id /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-d-test --operation delete --tags saf-u-frontdoor=$tag_a --only-show-errors --output none" "$s"
check "decommission: a landing zone's delete leaves no group to tag; its record stays while the group delete didn't finish here" \
  test "$(grep -c 'app-l-test' "$s")" = 0 -a "$(grep -c '^SKIP' "$s")" = 1
check "decommission (run 3421): the landing zone's record goes last, once the group and the service connection are gone" \
  test "$(grep '^AZ .*app-z-test' "$s" | tr '\n' '|')" = "AZ group exists --name rg-app-z-test --only-show-errors|AZ deployment sub show --name lz-app-z-test --query name --output tsv --only-show-errors|AZ deployment sub delete --name lz-app-z-test --only-show-errors --output none|"
check "decommission (run 3421): while the service connection is left, the landing zone's record stays (no az call)" \
  test "$(grep -c 'app-w-test' "$s")" = 0 -a "$(grep -c 'record_tags app-w failed' "$s")" = 0
check "decommission (immediate): the stop and step 1 of one run are recorded together, saf-u-retired the first time" \
  grep -qxF "AZ tag update --resource-id /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-i-test --operation merge --tags saf-u-entra=removed 20261112 saf-u-release=$rec_a saf-u-frontdoor=removed 20261112 saf-u-retired=20261112 saf-u-files=0123456789ab --only-show-errors --output none" "$s"
check "decommission (deleted detected): an Entra delete where the group is gone writes no tag (no az call), and record_tags doesn't fail" \
  test "$(grep -c 'rg-app-g-test' "$s")" = 0 -a "$(grep -c 'record_tags app-g failed' "$s")" = 0
check "decommission: Cancel deletes saf-u-retired by name and value" \
  grep -qxF "AZ tag update --resource-id /subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-c-test --operation delete --tags saf-u-retired=20261101 --only-show-errors --output none" "$s"

# --- 9. release_app's dispatch for a decommissioned app (ADR-0056 amendment 2026-11-12) -----------
read -r -d '' dispatchcode <<'EOS' || true
PROV_STAGE=azure_post_test
env_name=test
eval "$(sed -n -e '/^release_app() {/,/^}/p' "$POST")"
prov_app_file() { printf '/dev/null'; }
prov_app_auth() { printf required; }
prov_names() { :; }
prov_name() { printf 'x-%s' "$2"; }
prov_entry_dir() { printf '%s' "$SAF_WORK"; }
prov_copy_object() { echo "STEP $slug outputs"; }
saf_info() { echo "INFO $*"; }
retire_step() { echo "STEP $slug retire"; }
decom_frontdoor() { echo "STEP $slug frontdoor-delete"; }
front_door_step() { echo "STEP $slug front-door"; }
release_step() { echo "STEP $slug release"; }
prov_done() { echo "STEP $slug done $1"; }
out="$SAF_WORK/out"
mkdir -p "$SAF_IN/ado/ado-outputs" "$SAF_IN/units" "$SAF_IN/plan"
echo '{"checkAllApps": false, "apps": []}' > "$SAF_APPS_JSON"
u() { jq -n --argjson run "$1" --arg act "${2:-}" '{run: $run, reasons: [], details: [], tag: null, record: null, rebase: null} + (if $act == "" then {} else {action: $act} end)'; }
envd() { jq -n --argjson units "$1" '{plan: "ok", resourceGroup: "rg", legacyTag: null, filesTag: null, files: null, entraSingleHost: true, units: $units}'; }
# app-i: an immediate first run (release retire, frontdoor and ado delete; no ado-outputs).
# app-o: an ordinary retire (release retire, ado apply with its outputs).
# app-f: retire-only (release retire, frontdoor delete, the ado stage failed: no outputs).
# app-n: an active app (release apply) without landing-zone outputs: an error, as always.
# Landing-zone outputs exist for app-o and app-n's sibling only: app-i and app-f never had a landing
# zone that succeeded (sandbox run 3456), and their decommissioning goes on without outputs.
jq -n \
  --argjson i "$(envd "$(jq -n --argjson r "$(u true retire)" --argjson f "$(u true delete)" --argjson a "$(u true delete)" '{release: $r, frontdoor: $f, ado: $a}')")" \
  --argjson o "$(envd "$(jq -n --argjson r "$(u true retire)" --argjson a "$(u true)" '{release: $r, ado: $a}')")" \
  --argjson f "$(envd "$(jq -n --argjson r "$(u true retire)" --argjson fd "$(u true delete)" --argjson a "$(u true)" '{release: $r, frontdoor: $fd, ado: $a}')")" \
  --argjson n "$(envd "$(jq -n --argjson r "$(u true)" '{release: $r}')")" \
  '{schemaVersion: 1, stages: {}, apps: {"app-i": {environments: {test: $i}}, "app-o": {environments: {test: $o}}, "app-f": {environments: {test: $f}}, "app-n": {environments: {test: $n}}}}' > "$SAF_UNITS_JSON"
echo '{}' > "$SAF_IN/ado/ado-outputs/app-o.json"
mkdir -p "$SAF_WORK/lz-outputs"
echo '{}' > "$SAF_WORK/lz-outputs/app-o.test.json"
prov_units_check
( set -e; release_app app-i ) 2>&1 || echo "app-i failed"
( set -e; release_app app-o ) 2>&1 || echo "app-o failed"
( set -e; release_app app-f retire-only ) 2>&1 || echo "app-f failed"
( set -e; release_app app-n ) 2>&1 || echo "app-n failed"
EOS
run_stage dispatch "POST='$post'
$dispatchcode"
s="$tmp/dispatch/out.log"
check "decommission (immediate): the first run stops the app, then removes its domain; an ado delete needs no ado-outputs" \
  test "$(grep '^STEP app-i ' "$s" | tr '\n' '|')" = "STEP app-i retire|STEP app-i done release|STEP app-i frontdoor-delete|"
check "decommission: an ordinary retire only stops the app (its landing-zone outputs carried)" \
  test "$(grep '^STEP app-o ' "$s" | tr '\n' '|')" = "STEP app-o outputs|STEP app-o retire|STEP app-o done release|"
check "decommission: retire-only (the ado stage failed) stops the app, the domain waits" \
  test "$(grep '^STEP app-f ' "$s" | tr '\n' '|')" = "STEP app-f retire|STEP app-f done release|"
check "decommission: a landing zone that never succeeded (no outputs) doesn't stop the decommissioning (run 3456)" \
  test "$(grep -c '^INFO  *app-[if] in test has no landing-zone outputs' "$s")" = 2
check "an active app without landing-zone outputs still fails, and nothing of it runs" \
  test "$(grep -c '^STEP app-n ' "$s"):$(grep -c '^app-n failed$' "$s")" = "0:1"
check "decommission: no decommissioned app of the dispatch fails" test "$(grep -c '^app-[iof] failed$' "$s")" = 0

# --- 10. reading the state: failed landing zone, ARM ID case, vaults per environment, ARM retries --
read -r -d '' readcode <<'EOS' || true
az() { printf '%s\n' "$*" >> "$SAF_WORK/az.log"; }
d="$SAF_WORK/failed"
mkdir -p "$d"
# A landing zone whose deployment failed: no outputs (sandbox run 3396, SkuNotAvailable).
echo '{"name": "lz-app-a-test", "properties": {"provisioningState": "Failed", "outputs": null}}' > "$d/lz-record.json"
printf 'SECRET %s\n' "$(prov_secret_state "$d" 2>&1 || echo error)"
[ ! -s "$SAF_WORK/az.log" ] || echo "AZ CALLED"
# Succeeded, but the app's network mode (plan/apps.json) gives no vault: an error, never a guess (ADR-0060).
echo '{"name": "lz-app-a-test", "properties": {"provisioningState": "Succeeded", "outputs": {}}}' > "$d/lz-record.json"
( slug=app-a env_name=test prov_secret_state "$d" ) > /dev/null 2>&1 && echo "SUCCEEDED WITHOUT VAULT ACCEPTED" || echo "SUCCEEDED WITHOUT VAULT REFUSED"
sub=/subscriptions/00000000-0000-0000-0000-00000000a001
for id in "$sub/resourceGroups/rg-contoso-app-a-test/providers/Microsoft.App/containerapps/ca-app-a" \
          "$sub/resourceGroups/rg-contoso-app-a-test/providers/Microsoft.App/containerApps/ca-app-a" \
          "/subscriptions/00000000-0000-0000-0000-00000000b002/resourceGroups/rg-contoso-app-a-test/providers/Microsoft.App/containerapps/ca-app-a" \
          "$sub/resourceGroups/rg-contoso-app-a-test/providers/Microsoft.App/jobs/ca-app-a" \
          "$sub/resourceGroups/rg-contoso-app-a-test/providers/Microsoft.App/containerapps/ca-app-a/revisions/x"; do
  if prov_valid_container_app_id "$id" "$sub"; then echo "ID ok"; else echo "ID refused"; fi
done
# ARM lists: a transient error (HTTP 500) is tried again; a refusal (403) is not.
PROV_ARM_HOST=management.azure.com PROV_ARM_PAUSE=0
az() {
  printf '%s\n' "$*" >> "$SAF_WORK/arm.log"
  if [ "$(wc -l < "$SAF_WORK/arm.log")" -le "${ARM_FAILS:-0}" ]; then
    echo "ERROR: ${ARM_ERROR:-Internal Server Error}({\"error\":{\"code\":\"X\"}})" >&2
    return 1
  fi
  echo '{"value": [{"id": "a"}, {"id": "b"}]}'
}
: > "$SAF_WORK/arm.log"; ARM_FAILS=2
if prov_arm_list "$sub/providers/Microsoft.App/containerApps?api-version=2024-03-01" "$SAF_WORK/list.json" 2> "$SAF_WORK/list.err"; then
  echo "LIST500 ok $(jq length "$SAF_WORK/list.json") calls $(wc -l < "$SAF_WORK/arm.log")"
else echo "LIST500 failed"; fi
: > "$SAF_WORK/arm.log"; ARM_FAILS=1 ARM_ERROR=Forbidden
if prov_arm_list "$sub/providers/Microsoft.App/containerApps?api-version=2024-03-01" "$SAF_WORK/list.json" 2> /dev/null; then
  echo "LIST403 ok"; else echo "LIST403 failed calls $(wc -l < "$SAF_WORK/arm.log")"; fi
: > "$SAF_WORK/arm.log"; ARM_FAILS=9 ARM_ERROR="Service Unavailable"
if prov_arm_list "$sub/providers/Microsoft.App/containerApps?api-version=2024-03-01" "$SAF_WORK/list.json" 2> /dev/null; then
  echo "LIST503 ok"; else echo "LIST503 failed calls $(wc -l < "$SAF_WORK/arm.log")"; fi
EOS
run_stage reads "$readcode"
s="$tmp/reads/out.log"
check "prov_secret_state: a landing-zone record that didn't succeed is absent (its zone deploys again), without a vault read" \
  test "$(grep '^SECRET ' "$s")" = "SECRET absent" -a "$(grep -c 'AZ CALLED' "$s")" = 0
check "prov_secret_state: a Succeeded record whose app has no network mode to name a vault by fails" grep -qx "SUCCEEDED WITHOUT VAULT REFUSED" "$s"
check "prov_valid_container_app_id: containerapps (ARM's list) and containerApps accepted; another subscription, another type, a child refused" \
  test "$(grep '^ID ' "$s" | tr '\n' '|')" = "ID ok|ID ok|ID refused|ID refused|ID refused|"
check "prov_arm_list: a transient ARM error (HTTP 500) is tried again and the list completes" grep -qx "LIST500 ok 2 calls 3" "$s"
check "prov_arm_list: a refusal (403) is not tried again" grep -qx "LIST403 failed calls 1" "$s"
check "prov_arm_list: a lasting transient error gives up after PROV_ARM_TRIES (4) tries" grep -qx "LIST503 failed calls 4" "$s"

# --- 11. the deleted phase (ADR-0056 amendment 2026-11-12): decide.sh and report.sh end to end -------
# decom_ws <case> <deleteAfter> [open|closed] [immediate-prod|immediate-prod-off]: decide_ws with a
# decommission block on the fixture app (which has prod). immediate-prod: an immediate block
# (requestedOn = deleteAfter) with instance.yaml decommission.allowImmediateWithProduction true
# (ADR-0056 amendment 2026-11-21); immediate-prod-off: the same block without the setting.
decom_ws() {
  local ws="$tmp/$1/ws" cfg="$repo/tools/platform-cli/test/fixtures/provisioning/config"
  mkdir -p "$ws/s/core/tools" "$ws/s/core/infra/app" "$ws/in/plan" "$tmp/$1/tools"
  ln -s "$cli_dir" "$ws/s/core/tools/platform-cli"
  ln -s "$repo/pipelines" "$ws/s/core/pipelines"
  cp -r "$cfg" "$ws/s/config"
  if [ "${3:-open}" = closed ]; then printf '%s\n' "$window_closed" >> "$ws/s/config/instance.yaml"; else printf '%s\n' "$window_open" >> "$ws/s/config/instance.yaml"; fi
  if [ "${4:-}" = immediate-prod ] || [ "${4:-}" = immediate-prod-off ]; then
    [ "$4" = immediate-prod-off ] || printf 'decommission:\n  allowImmediateWithProduction: true\n' >> "$ws/s/config/instance.yaml"
    printf 'decommission:\n  requestedOn: "%s"\n  deleteAfter: "%s"\n  reason: Test app of the platform team.\n  requestedBy:\n    objectId: 00000000-0000-0000-0000-00000000e001\n    displayName: Jane Owner\n  immediate: true\n' \
      "$2" "$2" >> "$ws/s/config/apps/demo/app.yaml"
  elif [ "$2" != none ]; then
    printf 'decommission:\n  requestedOn: "%s"\n  deleteAfter: "%s"\n  reason: Replaced by demo-v2.\n  requestedBy:\n    objectId: 00000000-0000-0000-0000-00000000e001\n    displayName: Jane Owner\n' \
      "$(date -u -d "$2 -30 days" +%F)" "$2" >> "$ws/s/config/apps/demo/app.yaml"
  fi
  node "$cli_dir/dist/src/cli.js" provisioning apps --instance "$ws/s/config/instance.yaml" --apps-dir "$ws/s/config/apps" \
    --scope changed --upgrade none --output "$ws/in/plan/apps.json" > /dev/null
  node "$cli_dir/dist/src/cli.js" provisioning units --instance "$ws/s/config/instance.yaml" --apps "$ws/in/plan/apps.json" \
    --output "$ws/in/plan/unit-inputs.json" > /dev/null
  jq -n '{schemaVersion: 1, units: ({lz: 1, entra: 2, release: 3, frontdoor: 4, pep: 5, ado: 6}
    | map_values({revision: 1, fingerprint: ("a" * 64), since: "v0.1.0-rc.2"}))}' > "$ws/s/core/infra/app/units.json"
  printf 'minAppVersion: v0.1.0-rc.1\nversions: {}\n' > "$ws/s/core/infra/app/upgrades.yaml"
}
# gone_env <case> <env> [entra records json]: plan_<env> as plan.sh writes it when the app's group,
# landing-zone record and custom-domain record are not in the lists (prod, the host, lists the Entra records).
gone_env() {
  local dir="$tmp/$1/ws/in/plan_$2"
  mkdir -p "$dir/status" "$dir/facts"
  if [ "$2" = prod ]; then
    jq -n --arg e "$2" --argjson r "${3:-[]}" '{schemaVersion: 1, environment: $e, tagsRead: true, entraRecords: $r}' > "$dir/plan.json"
  else
    jq -n --arg e "$2" '{schemaVersion: 1, environment: $e, tagsRead: true}' > "$dir/plan.json"
  fi
  jq -n '{status: "ok"}' > "$dir/status/demo.$2.json"
  jq -n --arg e "$2" '{resourceGroup: "rg-contoso-app-demo-\($e)", tags: {}, lzRecord: "absent", federation: false, easyAuthInLandingZone: false,
    secret: null, frontDoorRecord: false, rangesChanged: false, entraDeployment: "entra-demo-\($e)", resourceGroupExists: false, containerAppStopped: null}' > "$dir/facts/demo.json"
}
none_out="ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
past="$(date -u -d '-10 days' +%F)"
ahead="$(date -u -d '+10 days' +%F)"

decom_ws decgone "$past" closed
gone_env decgone nonprod
gone_env decgone prod '[{"name": "entra-other-prod", "state": "Succeeded"}]'
run_decide decgone
dg="$tmp/decgone/ws/saf-out/units"
check "deleted: due, nothing left anywhere, Entra read: nothing runs, even outside the window" test "$(cat "$tmp/decgone/rc")" = 0 -a "$(outputs decgone)" = "$none_out"
check "deleted: units.json says deleted, every environment gone" \
  test "$(jq -c '[.apps.demo.decommission.phase, .apps.demo.environments.nonprod.gone, .apps.demo.environments.prod.gone, .apps.demo.decommission.waits]' "$dg/units.json")" = '["deleted",true,true,[]]'
check "deleted: units/decommission.json, the small file the portal reads, says deleted with the block's dates" \
  test "$(jq -c '[.schemaVersion, .apps.demo.phase, .apps.demo.deleteAfter, (.apps | keys)]' "$dg/decommission.json")" = "[1,\"deleted\",\"$past\",[\"demo\"]]"
run_report decgone
check "report: a deleted app, nobody marks it" \
  grep -qF "| demo | deleted | $(date -u -d "$past -30 days" +%F) | $past | deleted: nothing is left in Azure (read in this run); nothing runs for it, the portal shows it as deleted |" "$tmp/decgone/ws/saf-out/report/summary.md"
check "report: ... and the run passes" test "$(cat "$tmp/decgone/report.rc")" = 0

decom_ws decentra "$past"
gone_env decentra nonprod
gone_env decentra prod '[{"name": "entra-demo-prod", "state": "Failed"}]'
run_decide decentra
de="$tmp/decentra/ws/saf-out/units"
check "deleting, not deleted: an Entra record left (any state) is deleted by its uniqueName; nothing to tag" \
  test "$(jq -c '[.apps.demo.decommission.phase, .apps.demo.environments.prod.units.entra.run, .apps.demo.environments.prod.units.entra.action, .apps.demo.environments.prod.units.entra.record]' "$de/units.json")" = '["deleting",true,"delete",null]'
check "deleting: decommission.json says deleting" test "$(jq -r '.apps.demo.phase' "$de/decommission.json")" = deleting
check "deleting: only record_prod runs besides the Entra comparison of decide (no landing zone, no release)" test "$(outputs decentra)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=false post_prod=false record_prod=true "

decom_ws decearly "$ahead"
gone_env decearly nonprod
gone_env decearly prod '[]'
run_decide decearly
check "retired, not deleted: nothing left, but deleteAfter is ahead (Cancel is still possible)" \
  test "$(jq -r '.apps.demo.phase' "$tmp/decearly/ws/saf-out/units/decommission.json")" = retired -a "$(outputs decearly)" = "$none_out"

# Immediate deletion of an app with production (ADR-0056 amendment 2026-11-21): only while the instance
# allows it (platform development only); then the same first run as without production, at any time.
now_day="$(date -u +%F)"
decom_ws decprodnow "$now_day" closed immediate-prod
plan_env decprodnow nonprod "$recent"
plan_env decprodnow prod "$recent"
run_decide decprodnow
dpn="$tmp/decprodnow/ws/saf-out/units"
check "immediate with production, allowed by the instance: the stop and step 1 outside the window, the groups wait; the plan names production" \
  test "$(jq -c '[.apps.demo.decommission.phase, .apps.demo.decommission.immediate, .apps.demo.decommission.withProduction, .apps.demo.environments.prod.units.release.action, .apps.demo.environments.prod.units.ado.action, .apps.demo.environments.prod.units.entra.action, .apps.demo.environments.prod.units.lz.run]' "$dpn/units.json")" = '["deleting",true,["prod"],"retire","delete","delete",false]'
run_report decprodnow
check "report: an immediate deletion with production says so and names the setting" \
  grep -qF "| demo | deleting (immediate) | $now_day | now, PRODUCTION included (prod; decommission.allowImmediateWithProduction, for platform development only) |" "$tmp/decprodnow/ws/saf-out/report/summary.md"
# The setting off (switched off after the merge): the merged block stays valid, the plan refuses immediate.
decom_ws decprodoff "$now_day" closed immediate-prod-off
plan_env decprodoff nonprod "$recent"
plan_env decprodoff prod "$recent"
run_decide decprodoff
check "immediate with production, the setting off: listed (a merged block stays valid) and planned as an ordinary decommissioning, nothing deleted" \
  test "$(jq -c '[.apps[0].ok, .apps[0].decommission.immediate]' "$tmp/decprodoff/ws/in/plan/apps.json")" = '[true,true]' \
  -a "$(jq -c '[.apps.demo.decommission.phase, .apps.demo.decommission.immediate, ([.apps.demo.environments[].units[] | select(.action == "delete")] | length), (.apps.demo.decommission.waits[0] | test("immediate refused"))]' "$tmp/decprodoff/ws/saf-out/units/units.json")" = '["retired",null,0,true]'
run_report decprodoff
check "report: ... immediate deletion refused, named with the setting" \
  grep -qF "stopped; immediate deletion refused (the app has production and decommission.allowImmediateWithProduction is off): deleted after the grace period" "$tmp/decprodoff/ws/saf-out/report/summary.md"

decom_ws decactive none
gone_env decactive nonprod
plan_env decactive prod "$recent"
run_decide decactive
da="$tmp/decactive/ws/saf-out/units"
check "an active app whose resource group is missing is created (lz new), never deleted" \
  test "$(jq -c '[.apps.demo.decommission, .apps.demo.environments.nonprod.gone, .apps.demo.environments.nonprod.units.lz.run, (.apps.demo.environments.nonprod.units.lz.reasons | index("new") != null)]' "$da/units.json")" = '[null,null,true,true]'
check "... and decommission.json lists no app" test "$(jq -c '.apps' "$da/decommission.json")" = '{}'

# --- 12. the service connection after the group (sandbox run 3421, ADR-0056 amendment 2026-11-12) ----
read -r -d '' adocode <<'EOS' || true
PROV_STAGE=ado_resources
SAF_ADO_PHASE=resources
org_url=https://dev.azure.com/contoso
eval "$(sed -n -e '/^ado_remove() {/,/^}/p' "$ADO")"
prov_app_file() { printf '/dev/null'; }
prov_ado_token() { :; }
prov_done() { echo "DONE $slug $1"; }
saf_cli() { echo "CLI $*"; return "${CLI_RC:-0}"; }
mkdir -p "$SAF_IN/units" "$SAF_IN/plan" "$SAF_IN/plan_nonprod/lz-outputs" "$SAF_IN/azure_prod/lz-outputs"
echo '{"checkAllApps": false, "apps": []}' > "$SAF_APPS_JSON"
u() { jq -n --argjson run "$1" --arg act "${2:-}" '{run: $run, reasons: [], details: [], tag: null, record: null, rebase: null} + (if $act == "" then {} else {action: $act} end)'; }
envd() { jq -n --argjson units "$1" '{plan: "ok", resourceGroup: "rg", legacyTag: null, filesTag: null, files: null, entraSingleHost: true, units: $units}'; }
# app-s: ado delete everywhere; prod's group was deleted in this run (lz delete, done delete-lz), nonprod's is still there.
jq -n \
  --argjson n "$(envd "$(jq -n --argjson a "$(u true delete)" --argjson lz "$(u false)" '{ado: $a, lz: $lz}')")" \
  --argjson p "$(envd "$(jq -n --argjson a "$(u true delete)" --argjson lz "$(u true delete)" '{ado: $a, lz: $lz}')")" \
  '{schemaVersion: 1, stages: {}, apps: {"app-s": {environments: {nonprod: $n, prod: $p}}}}' > "$SAF_UNITS_JSON"
echo '{}' > "$SAF_IN/plan_nonprod/lz-outputs/app-s.nonprod.json"
echo '{}' > "$SAF_IN/azure_prod/lz-outputs/app-s.prod.json"
mkdir -p "$SAF_IN/azure_prod/status"
jq -n '{status: "ok", done: ["delete-lz"]}' > "$SAF_IN/azure_prod/status/app-s.prod.json"
prov_units_check
PROV_APP_ENVS=(nonprod prod)
PROV_DIR="$SAF_WORK/ado-s"
mkdir -p "$PROV_DIR"
( set -e; ado_remove app-s ) 2>&1 || echo "ado_remove failed"
echo "DETAIL $(jq -c . "$PROV_DIR/detail.json")"
PROV_DIR="$SAF_WORK/ado-f"
mkdir -p "$PROV_DIR"
( set -e; CLI_RC=1 ado_remove app-s ) 2>&1 | grep -c 'connection-' | sed 's/^/FAILED-DETAILS /' || true
[ -f "$PROV_DIR/detail.json" ] && echo "FDETAIL $(jq -c . "$PROV_DIR/detail.json")" || echo "FDETAIL none"
EOS
run_stage adoremove "ADO='$repo/pipelines/azure-devops/scripts/provisioning/ado.sh'
$adocode"
s="$tmp/adoremove/out.log"
check "ado_remove: --landing-zone-gone only for the environment whose group was deleted in this run, with both landing zones' outputs" \
  grep -qE "^CLI ado remove apply .* --lz-outputs nonprod=[^ ]*/plan_nonprod/lz-outputs/app-s\.nonprod\.json --lz-outputs prod=[^ ]*/azure_prod/lz-outputs/app-s\.prod\.json --landing-zone-gone prod$" "$s"
check "ado_remove: after a success, connection-<env> gone for that environment only (record_<env> deletes its record then)" \
  grep -qxF 'DETAIL {"connection-prod":"gone","ado":"removed"}' "$s"
check "ado_remove: a failure records no connection as gone" grep -qxF "FDETAIL none" "$s"

# --- 13. portal-side endpoint removal (ADR-0025 amendment 2026-11-14) -------------------------------
# portal_endpoint, portal_endpoint_left, portal_vault_state, portal_endpoint_remove,
# portal_endpoint_forget and portal_endpoint_delete from azure-post.sh with a fake az: an endpoint goes
# only when it links the app's own vault in its resource group (ADR-0052), a record only when it names
# the app and environment; a vault no longer VNet-based loses its endpoint only when it has public
# network access and no other private endpoint connection (or is gone), never when it can't be read;
# a previous generation's endpoint goes before the new deployment; step P removes both.
read -r -d '' pepcode <<'EOS' || true
PROV_STAGE=azure_post_test
env_name=test
subscription=00000000-0000-0000-0000-00000000a001
eval "$(sed -n -e '/^portal_endpoint() {/,/^}/p' -e '/^portal_endpoint_delete() {/,/^}/p' -e '/^portal_endpoint_left() {/,/^}/p' \
  -e '/^portal_vault_state() {/,/^}/p' -e '/^portal_endpoint_remove() {/,/^}/p' -e '/^portal_endpoint_forget() {/,/^}/p' \
  -e '/^portal_endpoint_exists() {/,/^}/p' "$POST")"
app_rg=rg-contoso-app-app-a-test
prov_names() { # prov_names <slug> <output> <env> <mode> <portal env> <vault>
  jq -n --arg s "$1" --arg e "$3" --arg v "${6:-}" '{outputs: {portalResourceGroup: "rg-contoso-portal-test", appResourceGroup: "rg-contoso-app-\($s)-\($e)",
    portalEndpointDeployment: "pep-portal-\($s)-\($e)", portalVaultEndpoint: (if $v == "" then null else "pep-\($v)-portal" end)}}' > "$2"
}
prov_entry_dir() { printf '%s' "$SAF_WORK/entries"; }
prov_app_file() { printf '/dev/null'; }
prov_done() { echo "DONE $1" >> "$SAF_WORK/calls"; }
saf_cli() { cp "$SAF_WORK/pe.json" "${@: -1}"; }
prov_compare() { prov_verdict=changed; }
prov_arm() { # prov_arm <action> <kind> <inputs> <deployment> <rg> <output>
  echo "ARM $1 $4" >> "$SAF_WORK/calls"
  [ "$1" = create ] || return 0
  jq -n --arg sub "$subscription" '{properties: {outputs: {vaultName: {value: "kvappanew0001"},
    endpointId: {value: "/subscriptions/\($sub)/resourceGroups/rg-contoso-portal-test/providers/Microsoft.Network/privateEndpoints/pep-kvappanew0001-portal"}}}}' > "$6"
}
az() {
  local ids="" query="" name="" rg=""
  if [ "$1 $2" = "group exists" ]; then echo true; return 0; fi
  if [ "$1 $2 $3" = "deployment group show" ] || [ "$1 $2 $3" = "deployment group delete" ]; then
    local verb="$3"
    shift 3
    while [ $# -gt 0 ]; do case "$1" in --name) name="$2"; shift ;; --resource-group) rg="$2"; shift ;; esac; shift; done
    if [ "$verb" = delete ]; then echo "RECORD-DELETE $rg/$name" >> "$SAF_WORK/calls"; return 0; fi
    if [ -s "$SAF_WORK/record.json" ]; then cat "$SAF_WORK/record.json"; return 0; fi
    echo "ERROR: (DeploymentNotFound) none" >&2
    return 1
  fi
  if [ "$1 $2 $3" = "network private-endpoint delete" ]; then
    while [ $# -gt 0 ]; do case "$1" in --ids) ids="$2"; shift ;; esac; shift; done
    echo "PE-DELETE ${ids##*/}" >> "$SAF_WORK/calls"
    return 0
  fi
  while [ $# -gt 0 ]; do case "$1" in --ids) ids="$2"; shift ;; --query) query="$2"; shift ;; esac; shift; done
  echo "READ ${ids##*/} ${query%%:*}" >> "$SAF_WORK/reads"
  case "$query" in
    id)
      if grep -qxF "${ids##*/}" "$SAF_WORK/endpoints" 2> /dev/null; then echo "$ids"; return 0; fi
      echo "ERROR: (ResourceNotFound) gone" >&2
      return 1
      ;;
    properties)
      local v="${ids##*/pep-}"
      v="${v%-portal}"
      jq -n --arg t "/subscriptions/$subscription/resourceGroups/${TARGET_RG:-$app_rg}/providers/Microsoft.KeyVault/vaults/$v" \
        '{privateLinkServiceConnections: [{properties: {privateLinkServiceId: $t, privateLinkServiceConnectionState: {status: "Approved"}}}]}'
      ;;
    "{public"*)
      if [ -s "$SAF_WORK/vault.err" ]; then cat "$SAF_WORK/vault.err" >&2; return 1; fi
      cat "$SAF_WORK/vault.json"
      ;;
  esac
}
pe_id() { printf '/subscriptions/%s/resourceGroups/rg-contoso-portal-test/providers/Microsoft.Network/privateEndpoints/pep-%s-portal' "$subscription" "$1"; }
record() { # record <slug> <vault>
  jq -n --arg s "$1" --arg v "$2" --arg id "$(pe_id "$2")" '{properties: {parameters: {slug: {value: $s}, environmentName: {value: "test"}},
    outputs: {vaultName: {value: $v}, endpointId: {value: $id}}}}' > "$SAF_WORK/record.json"
}
vault() { # vault <publicNetworkAccess> <endpoint names...>
  local pna="$1"
  shift
  rm -f "$SAF_WORK/vault.err"
  jq -n --arg p "$pna" --arg sub "$subscription" '{public: $p, endpoints: [$ARGS.positional[] | "/subscriptions/\($sub)/resourceGroups/rg-x/providers/Microsoft.Network/privateEndpoints/\(.)"]}' --args "$@" > "$SAF_WORK/vault.json"
}
# the portal-side endpoint as the vault lists it (same ID, other case)
mine() { pe_id kvappa0001 | tr '[:lower:]' '[:upper:]' | sed 's/^\/SUBSCRIPTIONS/\/subscriptions/'; }
case_run() { # case_run <label> <command...>
  local label="$1"
  shift
  PROV_DIR="$SAF_WORK/$label"
  mkdir -p "$PROV_DIR"
  rm -f "$SAF_WORK/calls" "$SAF_WORK/reads"
  rc=0
  ( set -e; "$@" ) > "$PROV_DIR/out.log" 2>&1 || rc=$?
  echo "$label rc=$rc calls=[$(tr '\n' ' ' < "$SAF_WORK/calls" 2> /dev/null)] reads=$(wc -l < "$SAF_WORK/reads" 2> /dev/null || echo 0) detail=$(jq -c . "$PROV_DIR/detail.json" 2> /dev/null)"
}
mkdir -p "$SAF_WORK/entries/lz-outputs"
echo '{"appKeyVaultName": {"value": "kvappa0001"}, "resourceGroupName": {"value": "rg-contoso-app-app-a-test"}}' > "$SAF_WORK/entries/lz-outputs/app-a.test.json"
printf 'pep-kvappa0001-portal\npep-kvappaold01-portal\n' > "$SAF_WORK/endpoints"
# portal_endpoint_remove and portal_endpoint_forget alone.
case_run remove-mine portal_endpoint_remove app-a test kvappa0001
TARGET_RG=rg-contoso-app-app-b-test case_run remove-foreign portal_endpoint_remove app-a test kvappa0001
case_run remove-gone portal_endpoint_remove app-a test kvappagone1
record app-a kvappa0001
case_run forget-mine portal_endpoint_forget app-a test pep-portal-app-a-test rg-contoso-portal-test
record app-b kvappa0001
case_run forget-other portal_endpoint_forget app-a test pep-portal-app-a-test rg-contoso-portal-test
# portal_endpoint_left: <slug> <env> <vault> <deployment> <portal rg> <vault subscription>, after portal_endpoint
# read the record into $PROV_DIR/record.json.
left() { # left <label>
  mkdir -p "$SAF_WORK/$1"
  if [ -s "$SAF_WORK/record.json" ]; then cp "$SAF_WORK/record.json" "$SAF_WORK/$1/record.json"; fi
  prov_names app-a "$SAF_WORK/$1/names.json" test "" test kvappa0001
  case_run "$1" portal_endpoint_left app-a test kvappa0001 pep-portal-app-a-test rg-contoso-portal-test "$subscription"
}
record app-a kvappa0001
vault Enabled
echo "{\"public\": \"Enabled\", \"endpoints\": [\"$(mine)\"]}" > "$SAF_WORK/vault.json"
left left-free
vault Enabled pep-kvappa0001
left left-spoke-left
vault Disabled
left left-private
echo "ERROR: (AuthorizationFailed) no rights in that subscription" > "$SAF_WORK/vault.err"
left left-unknown
echo "ERROR: (ResourceNotFound) the vault is gone" > "$SAF_WORK/vault.err"
left left-vault-gone
rm -f "$SAF_WORK/vault.err"
printf 'pep-kvappaold01-portal\n' > "$SAF_WORK/endpoints"
left left-record-only
: > "$SAF_WORK/record.json"
left left-no-record
# portal_endpoint: a record of the previous generation's vault; the new vault's endpoint is deployed after it is removed.
printf 'pep-kvappa0001-portal\npep-kvappaold01-portal\n' > "$SAF_WORK/endpoints"
echo '{"appKeyVaultName": {"value": "kvappanew0001"}}' > "$SAF_WORK/entries/lz-outputs/app-a.test.json"
jq -n --arg sub "$subscription" '{vnetBased: true, vaultSubscriptionId: $sub}' > "$SAF_WORK/pe.json"
record app-a kvappaold01
case_run generation portal_endpoint app-a test
# Step P (decommissioning): the endpoint and the record.
echo '{"appKeyVaultName": {"value": "kvappa0001"}}' > "$SAF_WORK/entries/lz-outputs/app-a.test.json"
record app-a kvappa0001
case_run decommission portal_endpoint_delete app-a test
EOS
run_stage pepremove "POST='$post'
$pepcode"
s="$tmp/pepremove/out.log"
check "pep remove: the app's own endpoint, linking its vault in its resource group, is deleted" \
  grep -qxF 'remove-mine rc=0 calls=[PE-DELETE pep-kvappa0001-portal ] reads=2 detail=' "$s"
check "pep remove: an endpoint that links a vault in another resource group is left alone, the unit fails" \
  grep -qxF 'remove-foreign rc=1 calls=[] reads=2 detail=' "$s"
check "pep remove: an endpoint already gone is nothing to do" grep -qxF 'remove-gone rc=0 calls=[] reads=1 detail=' "$s"
check "pep forget: the record that names the app and environment is deleted" \
  grep -qxF 'forget-mine rc=0 calls=[RECORD-DELETE rg-contoso-portal-test/pep-portal-app-a-test ] reads=0 detail=' "$s"
check "pep forget: a record that names another app is left alone, the unit fails" grep -qxF 'forget-other rc=1 calls=[] reads=0 detail=' "$s"
check "pep left: public network access and no other connection (the vault lists only this endpoint, in any case): endpoint and record removed" \
  grep -qxF 'left-free rc=0 calls=[PE-DELETE pep-kvappa0001-portal RECORD-DELETE rg-contoso-portal-test/pep-portal-app-a-test ] reads=4 detail={"portalEndpoint":"removed"}' "$s"
check "pep left: the vault's own endpoint in its old spoke is left: the portal-side endpoint stays (DNS), with a warning" \
  grep -qxF 'left-spoke-left rc=0 calls=[] reads=2 detail={"portalEndpoint":"leftover"}' "$s"
check "pep left: ... the warning says why and what to do" grep -q 'still has another private endpoint (or public network access is disabled), so its portal-side endpoint in rg-contoso-portal-test stays' "$tmp/pepremove/ws/saf-work/left-spoke-left/out.log"
check "pep left: public network access disabled: stays" grep -qxF 'left-private rc=0 calls=[] reads=2 detail={"portalEndpoint":"leftover"}' "$s"
check "pep left: a vault this identity can't read (another subscription): stays, with a warning" \
  grep -qxF 'left-unknown rc=0 calls=[] reads=2 detail={"portalEndpoint":"leftover"}' "$s"
check "pep left: ... the warning says to delete it by hand" grep -q "but this identity can't read it (another subscription), so its portal-side endpoint in rg-contoso-portal-test stays; delete it by hand" "$tmp/pepremove/ws/saf-work/left-unknown/out.log"
check "pep left: a vault that is gone: endpoint and record removed" \
  grep -qxF 'left-vault-gone rc=0 calls=[PE-DELETE pep-kvappa0001-portal RECORD-DELETE rg-contoso-portal-test/pep-portal-app-a-test ] reads=4 detail={"portalEndpoint":"removed"}' "$s"
check "pep left: a record without its endpoint: the record goes, nothing else" \
  grep -qxF 'left-record-only rc=0 calls=[RECORD-DELETE rg-contoso-portal-test/pep-portal-app-a-test ] reads=1 detail={"portalEndpoint":"not-needed"}' "$s"
check "pep left: no record (the vault never had an endpoint): not needed, no read at all" \
  grep -qxF 'left-no-record rc=0 calls=[] reads=0 detail={"portalEndpoint":"not-needed"}' "$s"
check "pep generation: the previous vault's endpoint is removed before the new vault's endpoint is validated and deployed" \
  grep -qxF 'generation rc=0 calls=[PE-DELETE pep-kvappaold01-portal ARM validate pep-portal-app-a-test ARM create pep-portal-app-a-test ] reads=3 detail={"portalEndpointPrevious":"removed","portalEndpoint":"deployed"}' "$s"
check "pep step P: a decommissioned app's endpoint and record go, and the unit is done" \
  grep -qxF 'decommission rc=0 calls=[PE-DELETE pep-kvappa0001-portal RECORD-DELETE rg-contoso-portal-test/pep-portal-app-a-test DONE delete-pep ] reads=2 detail={"portalEndpoint":"removed"}' "$s"
# --- 14. the registry image purge (ADR-0059): decide's outputs, the report, registry.sh purge_app --
# reg_facts <case>: the purge's facts in both environments, as plan-facts writes them: what demo runs
# (a digest per environment), the registry its landing-zone record names, the purge role (build
# environment only).
reg_facts() {
  local ws="$tmp/$1/ws" e
  for e in nonprod prod; do
    jq --arg e "$e" '. + {images: ["\($e).example.io/demo@sha256:" + (if $e == "nonprod" then "1" else "2" end) * 64],
        registryName: (if $e == "nonprod" then "crcontosodemononprod1a2b3c" else "crcontosodemoprod4d5e6f" end), registryPurgeRole: ($e == "nonprod")}' \
      "$ws/in/plan_$e/facts/demo.json" > "$ws/f.json"
    mv "$ws/f.json" "$ws/in/plan_$e/facts/demo.json"
  done
}
decide_ws regin
plan_env regin nonprod "$recent"
plan_env regin prod "$recent"
reg_facts regin
run_decide regin
reg_plan="$tmp/regin/ws/saf-out/units/registry.json"
check "registry: never purged, inside the window: decide sets registry_nonprod (a build environment only), nothing else runs" test "$(outputs regin)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=true lz_prod=false post_prod=false record_prod=false "
check "registry: ... registry.json purges demo in nonprod with today's record, protecting what it runs in both environments" \
  test "$(jq -c '.environments.nonprod.apps.demo | [.run, .record, .registry, (.protect | length), (.protect[1] | test("^prod[.]example[.]io/demo@sha256:2{64}$"))]' "$reg_plan")" = \
  "[true,\"$today purge\",\"crcontosodemononprod1a2b3c\",2,true]"
check "registry: ... and plans no purge of the promotion environment" test "$(jq -c '.environments | keys' "$reg_plan")" = '["nonprod"]'
check "registry: ... decide prints the plan's line" grep -q '^Registry purge in nonprod (purge, older than 90 days, newest 10 kept): 1 app(s) this run\.$' "$tmp/regin/out.log"
run_report regin
check "report: a purge in this run has its section, the app's row ('-' before the stage ran), and the run passes" \
  test "$(grep -c -x -e '### Old images (registry purge)' -e '| demo | nonprod | - |' "$tmp/regin/ws/saf-out/report/summary.md")" = 2 -a "$(cat "$tmp/regin/report.rc")" = 0
check "report: ... with the retention and the count" grep -qxF 'nonprod: purge, older than 90 days, the newest 10 kept: 1 app(s) in this run.' "$tmp/regin/ws/saf-out/report/summary.md"

decide_ws regout none closed
plan_env regout nonprod "$recent"
plan_env regout prod "$recent"
reg_facts regout
run_decide regout
check "registry: outside the maintenance window a due purge waits (no registry_nonprod)" \
  test "$(outputs regout | grep -o 'registry_nonprod=[a-z]*')" = registry_nonprod=false \
  -a "$(jq -r '.environments.nonprod.waiting' "$tmp/regout/ws/saf-out/units/registry.json")" = 1
run_report regout
check "report: ... and the report has no section for it (nothing purged, nothing deferred)" \
  test "$(grep -c 'Old images' "$tmp/regout/ws/saf-out/report/summary.md")" = 0

decide_ws regrecent
plan_env regrecent nonprod "$recent"
plan_env regrecent prod "$recent"
reg_facts regrecent
jq --arg t "$recent purge" '.tags["saf-registry-purge"] = $t' "$tmp/regrecent/ws/in/plan_nonprod/facts/demo.json" > "$tmp/regrecent/f.json"
mv "$tmp/regrecent/f.json" "$tmp/regrecent/ws/in/plan_nonprod/facts/demo.json"
run_decide regrecent
check "registry: purged 3 days ago: not again before 7 days" \
  test "$(outputs regrecent | grep -o 'registry_nonprod=[a-z]*')" = registry_nonprod=false
decide_ws regnorole
plan_env regnorole nonprod "$recent"
plan_env regnorole prod "$recent"
reg_facts regnorole
jq '.registryPurgeRole = false' "$tmp/regnorole/ws/in/plan_nonprod/facts/demo.json" > "$tmp/regnorole/f.json"
mv "$tmp/regnorole/f.json" "$tmp/regnorole/ws/in/plan_nonprod/facts/demo.json"
run_decide regnorole
check "registry: a landing zone without the purge role (an older core's) is skipped" \
  test "$(outputs regnorole | grep -o 'registry_nonprod=[a-z]*')" = registry_nonprod=false

# purge_app (registry.sh) with a fake az and the built CLI.
registry_sh="$repo/pipelines/azure-devops/scripts/provisioning/registry.sh"
reg_now="$(date -u +%s)"
read -r -d '' regcode <<'EOS' || true
PROV_STAGE=registry_test
env_name=test
subscription=00000000-0000-0000-0000-00000000a001
SAF_CLI="$CLI_JS"
eval "$(sed -n -e '/^purge_app() {/,/^}/p' "$REGISTRY")"
d() { printf 'sha256:%s' "$(printf '%64s' '' | tr ' ' "$1")"; }
az() {
  printf '%s\n' "$*" >> "$SAF_WORK/az.log"
  case "$1 $2" in
    "acr show") echo "/subscriptions/$subscription/resourceGroups/${REG_RG:-rg-app-a-test}/providers/Microsoft.ContainerRegistry/registries/crappa1a2b3c" ;;
    "resource show") echo "[\"cr.example.io/app-a@$(d 2)\"]" ;;
    "acr manifest")
      case "$3" in
        list-metadata)
          if [ -n "${NO_REPO:-}" ]; then echo "ERROR: NAME_UNKNOWN: repository name not known to registry" >&2; return 1; fi
          cat "$SAF_WORK/listing.json" ;;
        delete) if [ "${FAIL_DELETE:-}" = 1 ]; then echo "denied" >&2; return 1; fi ;;
      esac ;;
  esac
}
app_names="$SAF_WORK/registry-names.json"
echo '{"appResourceGroups": {"app-a": "rg-app-a-test"}, "containerApps": {"app-a": "ca-app-a"}, "registryRepositories": {"app-a": "app-a"}}' > "$app_names"
mkdir -p "$SAF_IN/units"
registry_plan="$SAF_IN/units/registry.json"
# The listing: 1 old (deleted), 2 runs here now (the live read), 3 runs elsewhere (the plan), 4 the newest,
# 5 old with a tag delivery doesn't write.
ago() { jq -n --argjson t "$((NOW - $1 * 86400))" '$t | todate'; }
jq -n --arg d1 "$(d 1)" --arg d2 "$(d 2)" --arg d3 "$(d 3)" --arg d4 "$(d 4)" --arg d5 "$(d 5)" \
  --argjson a400 "$(ago 400)" --argjson a300 "$(ago 300)" --argjson a200 "$(ago 200)" --argjson a1 "$(ago 1)" \
  '[{digest: $d1, tags: [("1" * 40)], createdTime: $a400, lastUpdateTime: $a400, changeableAttributes: {deleteEnabled: true}},
    {digest: $d2, tags: [("2" * 40)], createdTime: $a300, lastUpdateTime: $a300, changeableAttributes: {deleteEnabled: true}},
    {digest: $d3, tags: [("3" * 40)], createdTime: $a200, lastUpdateTime: $a200, changeableAttributes: {deleteEnabled: true}},
    {digest: $d4, tags: [("4" * 40)], createdTime: $a1, lastUpdateTime: $a1, changeableAttributes: {deleteEnabled: true}},
    {digest: $d5, tags: ["latest"], createdTime: $a300, lastUpdateTime: $a300, changeableAttributes: {deleteEnabled: true}}]' > "$SAF_WORK/listing.json"
plan() { # plan <mode>
  jq -n --arg m "$1" --argjson now "$NOW" --arg p "cr.example.io/app-a@$(d 3)" \
    '{schemaVersion: 1, now: $now, today: "", inWindow: true, until: "", retention: {mode: $m, days: 90, keepLatest: 1}, everyDays: 7,
      maxApps: 100, maxDeletes: 200, stages: {registry_test: true}, environments: {test: {due: 1, deferred: 0, waiting: 0,
      apps: {"app-a": {run: true, reason: "due", tag: null, record: ("20261114 " + $m), resourceGroup: "rg-app-a-test", registry: "crappa1a2b3c", protect: [$p]}}}}}' > "$registry_plan"
}
case_run() { # case_run <label> <mode>
  mode="$2"
  plan "$2"
  PROV_DIR="$SAF_WORK/purge-$1"
  mkdir -p "$PROV_DIR"
  : > "$SAF_WORK/az.log"
  ( set -e; purge_app app-a ) > "$SAF_WORK/purge-$1.log" 2>&1 || echo "CASE $1 failed"
  sed "s/^/AZ $1 /" "$SAF_WORK/az.log"
  [ ! -f "$PROV_DIR/detail.json" ] || echo "DETAIL $1 $(jq -c . "$PROV_DIR/detail.json")"
}
case_run purge purge
case_run dry dryRun
REG_RG=rg-app-b-test case_run foreign purge
FAIL_DELETE=1 case_run refused purge
NO_REPO=1 case_run norepo purge
EOS
run_stage registry "REGISTRY='$registry_sh' CLI_JS='$cli_dir/dist/src/cli.js' NOW='$reg_now'
$regcode"
s="$tmp/registry/out.log"
rgid="/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-app-a-test"
d1="sha256:$(printf '1%.0s' $(seq 64))"
check "registry.sh purge_app: the registry must be in the app's group by naming; deletes by digest only the old build that runs nowhere" \
  test "$(grep -c '^AZ purge acr manifest delete ' "$s")" = 1 \
  -a "$(grep -c -xF "AZ purge acr manifest delete --registry crappa1a2b3c --name app-a@$d1 --yes --only-show-errors --output none" "$s")" = 1 \
  -a "$(grep -c -xF 'AZ purge acr show --name crappa1a2b3c --resource-group rg-app-a-test --query id --output tsv --only-show-errors' "$s")" = 1
check "registry.sh purge_app: ... then records the purge on the app's group" \
  grep -qxF "AZ purge tag update --resource-id $rgid --operation merge --tags saf-registry-purge=20261114 purge --only-show-errors --output none" "$s"
check "registry.sh purge_app: ... with the counts in its status (kept: the live read, the plan's protected, the newest, another tag)" \
  grep -qxF 'DETAIL purge {"purge":"purge","images":"5","kept":"4","deleted":"1"}' "$s"
check "registry.sh purge_app: dry run deletes nothing, records dryRun" \
  test "$(grep -c '^AZ dry acr manifest delete' "$s")" = 0 \
  -a "$(grep -c -F "AZ dry tag update --resource-id $rgid --operation merge --tags saf-registry-purge=20261114 dryRun" "$s")" = 1 \
  -a "$(grep -c -xF 'DETAIL dry {"purge":"dryRun","images":"5","kept":"4","wouldDelete":"1"}' "$s")" = 1
check "registry.sh purge_app: a registry outside the app's group fails the app: nothing listed, deleted or tagged (ADR-0052)" \
  test "$(grep -c -x 'CASE foreign failed' "$s")" = 1 -a "$(grep -c -E '^AZ foreign (acr manifest|tag update)' "$s")" = 0
check "registry.sh purge_app: a refused delete fails the app and writes no tag (the next window tries again)" \
  test "$(grep -c -x 'CASE refused failed' "$s")" = 1 -a "$(grep -c '^AZ refused tag update' "$s")" = 0
check "registry.sh purge_app: a repository without an image yet: nothing to purge, recorded" \
  test "$(grep -c 'CASE norepo failed' "$s")" = 0 -a "$(grep -c '^AZ norepo acr manifest delete' "$s")" = 0 -a "$(grep -c '^AZ norepo tag update' "$s")" = 1

# --- 15. the Easy Auth secret in the vault of the app's mode (ADR-0060) ------------------------------
# prov_vault_inputs reads the environment's vault inputs with the built CLI (schema defaults applied);
# prov_names hands them to names.bicep with a mode, for env_name only (a fake bicep records the input);
# prov_secret_state reads the vault names.bicep names for the mode app.yaml asks for: in the steady
# state the record's vault, after a network mode change the target vault, never the record's old one.
read -r -d '' vaultcode <<'EOS' || true
mkdir -p "$SAF_CORE/tools" "$SAF_CORE/infra/app/delivery" "$SAF_IN/plan"
ln -s "$CLI_DIR" "$SAF_CORE/tools/platform-cli"
cp "$FIXTURE/instance.yaml" "$SAF_INSTANCE"
: > "$SAF_CORE/infra/app/delivery/names.bicepparam"
PROV_DIR="$SAF_WORK/unit"
mkdir -p "$PROV_DIR"
slug=app-a env_name=nonprod prefix=contoso subscription=00000000-0000-0000-0000-00000000a001 region=westeurope
printf 'VI nonprod %s\n' "$(prov_vault_inputs nonprod)"
printf 'VI prod %s\n' "$(prov_vault_inputs prod)"
( prov_vault_inputs nope ) > /dev/null 2>&1 && echo "VI unknown accepted" || echo "VI unknown refused"
# The fake bicep: the input it got, and environmentVault as names.bicep derives it (variant, generation).
bicep() {
  printf 'BICEP %s\n' "$SAF_NAMES_JSON" >> "$SAF_WORK/bicep.log"
  jq -n --argjson n "$SAF_NAMES_JSON" '{outputs: {platformResourceGroup: "rg-contoso-platform-\($n.environmentName)",
    easyAuthSecret: "easyauth-\($n.slug)",
    kvsetJob: (if $n.networkMode == null then null else "caj-contoso-kvset-\(if $n.networkMode == "externalHybrid" then "hyb" else "ext" end)" end),
    environmentVault: (if $n.vaultGeneration == null then null
      else "kvcontoso\($n.environmentName)\(if $n.networkMode == "externalHybrid" or $n.externalOnlyNetwork == "vnet" then "n" else "p" end)g\($n.vaultGeneration)xx" end)}}' \
    > "${2%.bicepparam}.snapshot.json"
}
prov_names app-a "$SAF_WORK/n-own.json" nonprod externalHybrid
prov_names app-a "$SAF_WORK/n-other.json" prod externalHybrid
prov_names app-a "$SAF_WORK/n-none.json" nonprod
printf 'NAMES own %s\n' "$(jq -r '.outputs.environmentVault // "null"' "$SAF_WORK/n-own.json")"
printf 'NAMES other %s\n' "$(jq -r '.outputs.environmentVault // "null"' "$SAF_WORK/n-other.json")"
printf 'NAMES none %s\n' "$(jq -r '.outputs.environmentVault // "null"' "$SAF_WORK/n-none.json")"
sed 's/^/NAMESIN /' "$SAF_WORK/bicep.log"
names="$SAF_WORK/n-none.json"
az() { # az resource show ... --parent vaults/<vault> ...: the vault read, and which vaults hold the secret
  local parent=""
  while [ $# -gt 0 ]; do case "$1" in --parent) parent="$2"; shift ;; esac; shift; done
  echo "READ ${parent#vaults/}" >> "$SAF_WORK/vault-reads"
  if grep -qxF "${parent#vaults/}" "$SAF_WORK/holding"; then echo '{"created": 1763100000, "expires": 1794636000}'; return 0; fi
  echo "ERROR: (SecretNotFound) none" >&2
  return 1
}
d="$SAF_WORK/state"
mkdir -p "$d"
# The record: externalOnly on the managed network, its vault holds the secret.
echo '{"name": "lz-app-a-nonprod", "properties": {"provisioningState": "Succeeded", "outputs": {"environmentKeyVaultName": {"value": "kvcontosononprodpg0xx"}}}}' > "$d/lz-record.json"
echo kvcontosononprodpg0xx > "$SAF_WORK/holding"
state_case() { # state_case <label> <mode in app.yaml>
  jq -n --arg m "$2" '{apps: [{slug: "app-a", ok: true, environments: ["nonprod"], networkModes: {nonprod: $m}, authMode: "required"}]}' > "$SAF_APPS_JSON"
  rm -f "$PROV_DIR"/names-*.json
  : > "$SAF_WORK/vault-reads"
  printf 'STATE %s %s %s\n' "$1" "$(prov_secret_state "$d" 2> /dev/null || echo error)" "$(tr '\n' ' ' < "$SAF_WORK/vault-reads")"
}
state_case steady externalOnly
state_case moved externalHybrid
echo kvcontosononprodng0xx >> "$SAF_WORK/holding"
state_case reissued externalHybrid
# prov_mode_vaults (plan.sh, ADR-0060): one names.bicep per vault variant plan-names lists, every mode mapped.
: > "$SAF_WORK/bicep.log"
jq -n '{vaultVariants: [{variant: "public", mode: "externalOnly", modes: ["externalOnly"]}, {variant: "private", mode: "externalHybrid", modes: ["externalHybrid"]}]}' > "$SAF_WORK/plan-names.json"
prov_mode_vaults "$SAF_WORK/plan-names.json" app-a "$SAF_WORK/env-vaults.json"
printf 'MODEVAULTS %s %s\n' "$(jq -c . "$SAF_WORK/env-vaults.json")" "$(wc -l < "$SAF_WORK/bicep.log")"
: > "$SAF_WORK/bicep.log"
jq -n '{vaultVariants: [{variant: "private", mode: "externalOnly", modes: ["externalOnly", "externalHybrid"]}]}' > "$SAF_WORK/plan-names.json"
prov_mode_vaults "$SAF_WORK/plan-names.json" app-a "$SAF_WORK/env-vaults.json"
printf 'MODEVAULTS %s %s\n' "$(jq -c . "$SAF_WORK/env-vaults.json")" "$(wc -l < "$SAF_WORK/bicep.log")"
EOS
run_stage vaults "CLI_DIR='$cli_dir' FIXTURE='$repo/tools/platform-cli/test/fixtures/provisioning/config'
$vaultcode"
s="$tmp/vaults/out.log"
check "prov_vault_inputs: vaultGeneration and externalOnlyNetwork of the environment, schema defaults applied (ADR-0060)" \
  test "$(grep '^VI ' "$s" | tr '\n' '|')" = 'VI nonprod {"vaultGeneration":0,"externalOnlyNetwork":"managed"}|VI prod {"vaultGeneration":0,"externalOnlyNetwork":"vnet"}|VI unknown refused|'
check "prov_names: the vault inputs go to names.bicep with a mode for env_name only (another environment's subscription differs)" \
  test "$(grep '^NAMESIN ' "$s" | tr '\n' '|')" = 'NAMESIN BICEP {"prefix":"contoso","slug":"app-a","environmentName":"nonprod","generation":null,"networkMode":"externalHybrid","vaultGeneration":0,"externalOnlyNetwork":"managed"}|NAMESIN BICEP {"prefix":"contoso","slug":"app-a","environmentName":"prod","generation":null,"networkMode":"externalHybrid"}|NAMESIN BICEP {"prefix":"contoso","slug":"app-a","environmentName":"nonprod","generation":null}|' \
  -a "$(grep '^NAMES ' "$s" | tr '\n' '|')" = 'NAMES own kvcontosononprodng0xx|NAMES other null|NAMES none null|'
check "prov_secret_state: the steady state reads the vault the record names (the same name, one read)" \
  grep -qxF "STATE steady present READ kvcontosononprodpg0xx " "$s"
check "prov_secret_state: after a network mode change it reads the target vault, never the record's old one" \
  grep -qxF "STATE moved absent READ kvcontosononprodng0xx " "$s"
check "prov_secret_state: a secret re-issued in the target vault is present" \
  grep -qxF "STATE reissued present READ kvcontosononprodng0xx " "$s"
check "prov_mode_vaults: both variants named once each, every mode to its vault (the plan lists both, ADR-0060)" \
  grep -qxF 'MODEVAULTS {"externalOnly":"kvcontosononprodpg0xx","externalHybrid":"kvcontosononprodng0xx"} 2' "$s"
check "prov_mode_vaults: one variant used by two modes is named once, both modes map to it" \
  grep -qxF 'MODEVAULTS {"externalOnly":"kvcontosononprodpg0xx","externalHybrid":"kvcontosononprodpg0xx"} 1' "$s"

# --- 16. the move of a network mode change (ADR-0060): release_app and move_step with a fake az ------
# The functions of azure-post.sh as they are; the landing zone, dbinit, the custom domain, the release
# and the restart check stubbed (each writes an OP line), a fake az that keeps the Container App, the
# role assignments and the private endpoints in files and logs every mutation as an OP line too.
# Scenarios: A into hybrid, A out of hybrid, B, a resumed move (the app gone), a failed precondition
# (another image than the record: waiting, nothing deleted), and a delivery identity's role that is
# inherited or elsewhere and an endpoint linking a resource outside the group (left alone). Capacity
# cells (ADR-0053, ADR-0060 amendment 2026-11-16): a move from cell 02 into cell 01 of the target mode
# (the source CAE's Joiner in cell 02 goes, cell 01's of the same mode stays), a resumed move into cell
# 02, and a plan naming another target cell than app.yaml (refused before anything is deleted).
read -r -d '' movecode <<'EOS' || true
PROV_STAGE=azure_post_test
env_name=test prefix=contoso subscription=00000000-0000-0000-0000-00000000a001
SUB="/subscriptions/$subscription"
CA_API=2024-03-01
for f in release_app ca_status move_app_read move_joiner_delete move_app_delete move_endpoints move_secret_role move_step; do
  eval "$(sed -n -e "/^$f() {/,/^}/p" "$POST")"
done
out="$SAF_WORK/out"
mkdir -p "$out/lz-outputs" "$SAF_IN/units" "$SAF_IN/plan" "$SAF_WORK/state"
OPS="$SAF_WORK/ops"
prov_app_file() { printf '/dev/null'; }
prov_names() { # <slug> <file> [env] [mode] [portal env] [vault] [cell]: names.bicep's names as the fake knows them
  local abbr="" mode="${4:-}" cell="${7:-}"
  case "$mode" in externalOnly) abbr=ext ;; externalHybrid) abbr=hyb ;; esac
  # As prov_names: no cell argument = the app's cell (apps.json), `none` = no cell (no CAE named).
  if [ -z "$cell" ]; then cell="$(prov_app_cell "$1" "${3:-$env_name}")"; elif [ "$cell" = none ]; then cell=""; fi
  echo "NAMES ${4:-} ${cell:-none}" >> "$SAF_WORK/names.log"
  jq -n --arg s "$1" --arg e "${3:-$env_name}" --arg a "$abbr" --arg c "$cell" '{outputs: ({appResourceGroup: "rg-contoso-app-\($s)-\($e)", containerApp: "ca-\($s)",
      provisioningDeployment: "lz-\($s)-\($e)", releaseDeployment: "release-\($s)", platformResourceGroup: "rg-contoso-platform-\($e)",
      deliveryIdentity: "id-contoso-\($s)-deploy-\($e)", easyAuthSecret: "easyauth-\($s)"}
    + (if $a == "" then {} else {environmentVault: "kvcontoso\($e)\(if $a == "hyb" then "n" else "p" end)abcde"} end)
    + (if $a == "" or $c == "" then {} else {managedEnvironment: "cae-contoso-\($a)-\($e)\(if $c == "01" then "" else "-c\($c)" end)"} end))}' > "$2"
}
read_records() { if [ -f "$SAF_WORK/state/record.json" ]; then cp "$SAF_WORK/state/record.json" "$1/release-record.json"; else rm -f "$1/release-record.json"; fi; }
prov_state() { jq -n --arg c "$(cat "$SAF_WORK/state/client")" --argjson x "$(cat "$SAF_WORK/state/secret")" '{entra: (if $c == "" then null else {clientId: $c} end), easyAuthSecretExists: $x}' > "$1/state.json"; }
prov_lz() { echo "OP lz ${4:-final}" >> "$OPS"; echo '{}' > "$2"; }
database_entry() { echo "OP dbinit" >> "$OPS"; }
front_door_step() { echo "OP frontdoor" >> "$OPS"; }
release_step() { # the release into the target CAE: the app exists there now
  echo "OP release" >> "$OPS"
  jq -n --arg e "$NEW_CAE" '{environmentId: $e, image: "cr.example/x@sha256:new", runId: "7", fqdn: "ca-app.newdomain.example.io"}' > "$SAF_WORK/state/app.json"
}
restart_stale() { echo "OP restart-check" >> "$OPS"; }
front_door_cleanup() { echo "OP frontdoor-cleanup $1" >> "$OPS"; }
sleep() { :; }
opt() { local want="$1" prev=""; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return 0; fi; prev="$a"; done; return 1; }
az() {
  local id q
  case "$1 $2" in
    "resource show")
      id="$(opt --ids "$@")"
      q="$(opt --query "$@")"
      if [[ "$id" == */containerApps/* ]]; then
        [ -f "$SAF_WORK/state/app.json" ] || { echo "ERROR: (ResourceNotFound) not found" >&2; return 1; }
        case "$q" in
          properties.runningStatus) echo Running ;;
          properties.configuration.ingress.fqdn) jq -r .fqdn "$SAF_WORK/state/app.json" ;;
          *) jq '{environmentId, image, runId}' "$SAF_WORK/state/app.json" ;;
        esac
      elif [[ "$id" == */managedEnvironments/* ]]; then
        printf '%s/subnets/snet-cae\n' "$TARGET_VNET"
      else return 1; fi
      ;;
    "resource delete") echo "OP delete-app ${3:-} $(opt --ids "$@")" >> "$OPS"; rm -f "$SAF_WORK/state/app.json" ;;
    "identity show") echo 00000000-0000-0000-0000-0000000000d1 ;;
    "identity list") printf '%s\n' 00000000-0000-0000-0000-0000000000d1 00000000-0000-0000-0000-0000000000e1 ;;
    "role assignment")
      case "$3" in
        list) # every assignment of the principal at the scope or above it (the fake shows inherited ones too)
          jq --arg p "$(opt --assignee "$@")" --arg s "$(opt --scope "$@")" '[.[] | . as $r | select($r.principal == $p and ($s | ascii_downcase | startswith($r.scope | ascii_downcase))) | {id, scope}]' "$SAF_WORK/state/roles.json" ;;
        delete) echo "OP delete-role $(opt --ids "$@")" >> "$OPS" ;;
      esac
      ;;
    "network private-endpoint")
      case "$3" in
        list) cat "$SAF_WORK/state/endpoints.json" ;;
        delete) echo "OP delete-endpoint $(opt --ids "$@" | sed 's|.*/||')" >> "$OPS" ;;
      esac
      ;;
    *) echo "OP unexpected az $*" >> "$OPS"; return 1 ;;
  esac
}
# CAE <abbr> [cell]: the CAE's ID by naming, a cell other than 01 with -c{cell} (ADR-0053).
CAE() { printf '%s/resourceGroups/rg-contoso-platform-test/providers/Microsoft.App/managedEnvironments/cae-contoso-%s-test%s' "$SUB" "$1" "$([ "${2:-01}" = 01 ] || printf -- '-c%s' "$2")"; }
# scenario <slug> <from> <to> <case> <live CAE abbr|none> <image digest of the live app> [<waitsForWindow>]:
# units.json, apps.json and the state. FROM_CELL and TO_CELL (default 01): the plan's cells; APP_CELL
# (default TO_CELL): app.yaml's cell in apps.json.
scenario() {
  local slug="$1" from="$2" to="$3" case_="$4" live="$5" image="$6" window="${7:-}" rg="rg-contoso-app-$1-test" vault fc="${FROM_CELL:-01}" tc="${TO_CELL:-01}"
  jq -n --arg s "$slug" --arg f "$from" --arg t "$to" --arg c "$case_" --argjson r "$([ "$live" = none ] && echo true || echo false)" --arg w "$window" --arg fc "$fc" --arg tc "$tc" \
    '{schemaVersion: 1, stages: {}, apps: {($s): {environments: {test: {plan: "ok", resourceGroup: "rg", entraSingleHost: true,
      modeChange: {from: $f, to: $t, case: $c, fromHost: (if $r then null else "ca-old.example.io" end), resume: $r, waitsForWindow: (if $w == "" then null else $w end),
        fromCell: (if $r then null else $fc end), toCell: $tc},
      units: {lz: {run: true, reasons: ["dependency"], details: []}, release: {run: true, reasons: ["dependency"], details: [], action: "move"}}}}}}}' > "$SAF_UNITS_JSON"
  jq -n --arg s "$slug" --arg t "$to" --arg ac "${APP_CELL:-$tc}" '{checkAllApps: false, apps: [{slug: $s, ok: true, environments: ["test"], authMode: "required", networkModes: {test: $t}, cells: {test: $ac}}]}' > "$SAF_APPS_JSON"
  prov_units_check
  if [ "$live" = none ]; then rm -f "$SAF_WORK/state/app.json"; else
    jq -n --arg e "$(CAE "$live" "$fc")" --arg i "cr.example/x@$image" '{environmentId: $e, image: $i, runId: "7", fqdn: "ca-old.example.io"}' > "$SAF_WORK/state/app.json"
  fi
  NEW_CAE="$(CAE "$([ "$to" = externalHybrid ] && echo hyb || echo ext)" "$tc")"
  TARGET_VNET="$SUB/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-contoso-$([ "$to" = externalHybrid ] && echo hyb || echo ext)-test"
  jq -n --arg d "sha256:$(printf 'a%.0s' $(seq 64))" '{properties: {parameters: {image: {value: {digest: $d}}, run: {value: {id: 7}}}}}' > "$SAF_WORK/state/record.json"
  echo 00000000-0000-0000-0000-0000000000c1 > "$SAF_WORK/state/client"
  echo true > "$SAF_WORK/state/secret"
  vault="kvcontosotest$([ "$from" = externalHybrid ] && echo n || echo p)abcde"
  # The delivery identity's Joiner on the source CAE, one on the target CAE (new), one inherited from
  # the subscription; the Easy Auth identity's Secrets User on the old secret and on the new one. With a
  # source cell other than 01, also a Joiner on cell 01's CAE of the source mode (never the move's).
  jq -n --arg old "$(CAE "$([ "$from" = externalHybrid ] && echo hyb || echo ext)" "$fc")" --arg new "$NEW_CAE" --arg sub "$SUB" \
    --arg sib "$(CAE "$([ "$from" = externalHybrid ] && echo hyb || echo ext)")" --arg fc "$fc" \
    --arg sec "$SUB/resourceGroups/rg-contoso-platform-test/providers/Microsoft.KeyVault/vaults/$vault/secrets/easyauth-$slug" \
    --arg nsec "$SUB/resourceGroups/rg-contoso-platform-test/providers/Microsoft.KeyVault/vaults/kvcontosotestzabcde/secrets/easyauth-$slug" \
    '[{principal: "00000000-0000-0000-0000-0000000000d1", id: "\($old)/providers/Microsoft.Authorization/roleAssignments/joiner-old", scope: $old},
      {principal: "00000000-0000-0000-0000-0000000000d1", id: "\($new)/providers/Microsoft.Authorization/roleAssignments/joiner-new", scope: $new},
      {principal: "00000000-0000-0000-0000-0000000000d1", id: "\($sub)/providers/Microsoft.Authorization/roleAssignments/inherited", scope: $sub},
      {principal: "00000000-0000-0000-0000-0000000000e1", id: "\($sec)/providers/Microsoft.Authorization/roleAssignments/secret-old", scope: $sec},
      {principal: "00000000-0000-0000-0000-0000000000e1", id: "\($nsec)/providers/Microsoft.Authorization/roleAssignments/secret-new", scope: $nsec}]
      + (if $fc == "01" then [] else [{principal: "00000000-0000-0000-0000-0000000000d1", id: "\($sib)/providers/Microsoft.Authorization/roleAssignments/joiner-cell01", scope: $sib}] end)' > "$SAF_WORK/state/roles.json"
  # The app's endpoints: its vault's in the source spoke, its database's in the target spoke, and one in
  # its group that links a resource elsewhere (never the app's to delete).
  jq -n --arg rg "$SUB/resourceGroups/$rg" --arg tv "$TARGET_VNET" --arg sv "$SUB/resourceGroups/rg-net/providers/Microsoft.Network/virtualNetworks/vnet-source" --arg sub "$SUB" \
    '[{id: "\($rg)/providers/Microsoft.Network/privateEndpoints/pep-vault", subnet: "\($sv)/subnets/snet-pe", auto: ["\($rg)/providers/Microsoft.KeyVault/vaults/kvapp"], manual: null},
      {id: "\($rg)/providers/Microsoft.Network/privateEndpoints/pep-db", subnet: "\($tv)/subnets/snet-pe", auto: ["\($rg)/providers/Microsoft.Sql/servers/sqlapp"], manual: null},
      {id: "\($rg)/providers/Microsoft.Network/privateEndpoints/pep-foreign", subnet: "\($sv)/subnets/snet-pe", auto: null, manual: ["\($sub)/resourceGroups/rg-other/providers/Microsoft.Sql/servers/x"]}]' > "$SAF_WORK/state/endpoints.json"
  : > "$OPS"
}
run_move() { # run_move <slug>: release_app as a unit, then its OP lines and status on one line
  prov_run_app "$out/status/$1.test.json" "$1" test release_app "$1" > "$SAF_WORK/unit-$1.log" 2>&1
  printf 'MOVE %s %s|%s|%s\n' "$1" "$(jq -r .status "$out/status/$1.test.json")" "$(sed 's|/subscriptions/[^ ]*/||' "$OPS" | tr '\n' ';')" \
    "$(jq -c '.detail | {move, moveCase, moveHost} + {outage: ((.moveOutage // "") | split(" ") | length)}' "$out/status/$1.test.json")"
  printf 'DONE %s %s\n' "$1" "$(jq -c '.done' "$out/status/$1.test.json")"
}
AOK="sha256:$(printf 'a%.0s' $(seq 64))"
scenario ain externalOnly externalHybrid A ext "$AOK";        run_move ain
scenario aout externalHybrid externalOnly A hyb "$AOK";       run_move aout
scenario bmove externalOnly externalHybrid B ext "$AOK";      run_move bmove
scenario resumed externalOnly externalHybrid B none "$AOK";   run_move resumed
scenario waits externalOnly externalHybrid A ext "sha256:$(printf 'b%.0s' $(seq 64))"; run_move waits
printf 'WAITREASON %s\n' "$(jq -r .reason "$out/status/waits.test.json")"
scenario nosecret externalOnly externalHybrid A ext "$AOK"; echo false > "$SAF_WORK/state/secret"; run_move nosecret
# Kind prod outside the maintenance window (product owner, 2026-11-14): the plan's waitsForWindow.
scenario prodwait externalOnly externalHybrid A ext "$AOK" 2026-11-16T20:00:00.000Z; run_move prodwait
printf 'WINDOWREASON %s\n' "$(jq -r .reason "$out/status/prodwait.test.json")"
# Capacity cells (ADR-0053): from cell 02 of External only into cell 01 of the hybrid mode.
: > "$SAF_WORK/names.log"
FROM_CELL=02 TO_CELL=01 scenario cellmove externalOnly externalHybrid A ext "$AOK"; run_move cellmove
printf 'CELLNAMES %s\n' "$(grep -E '^NAMES (externalOnly|externalHybrid) ' "$SAF_WORK/names.log" | tr '\n' '|')"
TO_CELL=02 scenario cellresume externalOnly externalHybrid B none "$AOK"; run_move cellresume
FROM_CELL=02 TO_CELL=02 APP_CELL=01 scenario cellwrong externalOnly externalHybrid A ext "$AOK"; run_move cellwrong
printf 'CELLWRONG %s\n' "$(grep -c 'another capacity cell than app.yaml names' "$SAF_WORK/unit-cellwrong.log")"
EOS
run_stage move "POST='$post'
$movecode"
s="$tmp/move/out.log"
check "move (kind prod outside the window): after the prepare pass it waits for the window; nothing deleted, no precondition read" \
  grep -qxF 'MOVE prodwait waiting|OP lz externalOnly;|{"move":"waiting-window","moveCase":"A","moveHost":null,"outage":0}' "$s"
check "move: ... the reason names the next window's start" \
  grep -qxF 'WINDOWREASON prodwait in test: waits for the maintenance window (2026-11-16T20:00:00.000Z): a production environment moves only inside it; the prepare pass and the Entra step ran, the app is untouched' "$s"
check "move (A into hybrid): prepare pass, the source CAE's Joiner, the app's delete, final landing zone, dbinit, domain, release, the old secret's role; no endpoint deleted" \
  grep -qxF 'MOVE ain ok|OP lz externalOnly;OP delete-role joiner-old;OP delete-app --ids ca-ain;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP delete-role secret-old;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"A","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move: lz and release are done only at the end (record_<env> records them then)" grep -qxF 'DONE ain ["lz","release"]' "$s"
check "move (A out of hybrid): ... and every endpoint of the app's own resources goes after the release (the app left the VNet); a foreign one stays" \
  grep -qxF 'MOVE aout ok|OP lz externalHybrid;OP delete-role joiner-old;OP delete-app --ids ca-aout;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP delete-role secret-old;OP delete-endpoint pep-vault;OP delete-endpoint pep-db;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"A","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move (B): the endpoints outside the target spoke go after the app's delete, before the final landing zone; no secret role changes (one vault)" \
  grep -qxF 'MOVE bmove ok|OP lz externalOnly;OP delete-role joiner-old;OP delete-app --ids ca-bmove;OP delete-endpoint pep-vault;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"B","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move (resumed): the app gone, no Joiner or app delete, on from the endpoints (d)" \
  grep -qxF 'MOVE resumed ok|OP lz externalOnly;OP delete-endpoint pep-vault;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"B","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move: a precondition fails (another image than the record): waiting, only the prepare pass ran, nothing deleted" \
  grep -qxF 'MOVE waits waiting|OP lz externalOnly;|{"move":"waiting-image","moveCase":"A","moveHost":null,"outage":0}' "$s"
check "move: ... the reason says the app is untouched" grep -q '^WAITREASON .*the move waits and the app is untouched$' "$s"
check "move: no target secret yet (case A): waiting for sign-in, nothing deleted" \
  grep -qxF 'MOVE nosecret waiting|OP lz externalOnly;|{"move":"waiting-sign-in","moveCase":"A","moveHost":null,"outage":0}' "$s"
check "move: the inherited role and the target CAE's Joiner are never deleted" test "$(grep -c 'joiner-new\|inherited\|secret-new' "$s")" = 0
check "move (cell 02 into cell 01, ADR-0053): the Joiner on the source CAE of cell 02 goes, the app is created again in the target cell" \
  grep -qxF 'MOVE cellmove ok|OP lz externalOnly;OP delete-role joiner-old;OP delete-app --ids ca-cellmove;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP delete-role secret-old;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"A","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move (cells): the source CAE named in the live app's cell, the target in app.yaml's" \
  grep -qxF 'CELLNAMES NAMES externalOnly 02|NAMES externalHybrid 01|' "$s"
check "move (cells): cell 01's Joiner of the source mode is never deleted" test "$(grep -c 'joiner-cell01' "$s")" = 0
check "move (resumed into cell 02): no source cell, on from the endpoints into the target cell" \
  grep -qxF 'MOVE cellresume ok|OP lz externalOnly;OP delete-endpoint pep-vault;OP lz final;OP dbinit;OP frontdoor;OP release;OP restart-check;OP frontdoor-cleanup removal;|{"move":"moved","moveCase":"B","moveHost":"ca-app.newdomain.example.io","outage":2}' "$s"
check "move (cells): a plan naming another target cell than app.yaml fails before anything is deleted" \
  grep -qxF 'MOVE cellwrong failed|OP lz externalOnly;|{"move":null,"moveCase":null,"moveHost":null,"outage":0}' "$s"
check "move (cells): ... and says why" grep -qxF 'CELLWRONG 1' "$s"
check "move: no unexpected az call" test "$(grep -c 'unexpected az' "$s")" = 0

# --- 17. the follow-up of a case A move (ADR-0060 decision 8): entra-plan.sh plan_old_secret and ------
# entra.sh remove_old_secret, with the plan's followUp; a stubbed CLI records the command line.
read -r -d '' followcode <<'EOS' || true
PROV_STAGE=entra
env_name=prod prefix=contoso subscription=00000000-0000-0000-0000-00000000a001
eval "$(sed -n -e '/^plan_old_secret() {/,/^}/p' "$PLAN")"
eval "$(sed -n -e '/^remove_old_secret() {/,/^}/p' "$ENTRA")"
mkdir -p "$SAF_IN/units" "$SAF_IN/plan" "$SAF_IN/plan_nonprod/secret" "$SAF_WORK/out/secret-plan" "$SAF_WORK/out/status"
out="$SAF_WORK/out"
prov_names() {
  local abbr=""
  case "${4:-}" in externalOnly) abbr=ext ;; externalHybrid) abbr=hyb ;; esac
  jq -n --arg s "$1" --arg e "${3:-$env_name}" --arg a "$abbr" '{outputs: {platformResourceGroup: "rg-contoso-platform-\($e)", easyAuthSecret: "easyauth-\($s)", kvsetJob: (if $a == "" then null else "caj-contoso-kvset-\($a)" end)}}' > "$2"
}
saf_cli() {
  case "$1 $2" in
    "pipeline instance-env") jq -n '{subscriptionId: "00000000-0000-0000-0000-00000000a001"}' > "$(opt --output "$@")" ;;
    "provisioning easyauth-secret") printf 'CLI %s\n' "$*"; jq -n '{oldSecret: "deleted"}' > "$(opt --output "$@")" ;;
  esac
}
opt() { local want="$1" prev=""; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return 0; fi; prev="$a"; done; return 1; }
prov_secret_tokens() { echo TOKENS; }
JOBS="/subscriptions/00000000-0000-0000-0000-00000000a001/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.App/jobs"
# The app runs in nonprod's hybrid CAE now; easyauth-demo is still in the public vault.
jq -n '{checkAllApps: false, apps: [{slug: "demo", ok: true, environments: ["nonprod"], authMode: "required", networkModes: {nonprod: "externalHybrid"}}]}' > "$SAF_APPS_JSON"
jq -n --arg j "$JOBS" '{state: "present", vault: "kvcontosononprodnabcde", job: "\($j)/caj-contoso-kvset-hyb", jobReady: true, jobState: "current",
  created: 1790000000, expires: 1805552000, loaded: 1790000000, appVault: "kvcontosononprodnabcde",
  elsewhere: {vault: "kvcontosononprodpabcde", job: "\($j)/caj-contoso-kvset-ext", jobReady: true, jobState: "current"}}' > "$SAF_IN/plan_nonprod/secret/demo.nonprod.json"
plan_case() { # plan_case <followUp or ''>: plan_old_secret as a unit
  jq -n --arg f "$1" '{schemaVersion: 1, stages: {}, apps: {demo: {environments: {nonprod: ({plan: "ok", units: {entra: {run: true, reasons: ["dependency"], details: []}}}
    + (if $f == "" then {} else {followUp: $f} end))}}}}' > "$SAF_UNITS_JSON"
  prov_units_check
  rm -f "$out/secret-plan/demo.nonprod.remove-old.json"
  names="$SAF_WORK/names.json"
  prov_names demo "$names" nonprod externalHybrid
  slug=demo
  prov_run_app "$out/status/demo.nonprod.json" demo nonprod plan_old_secret nonprod > /dev/null 2>&1
  printf 'PLANOLD %s %s %s\n' "${1:-none}" "$(jq -r '.detail.secretOld // "-"' "$out/status/demo.nonprod.json")" \
    "$([ -f "$out/secret-plan/demo.nonprod.remove-old.json" ] && jq -c '[.vault, .job, .appVault, .secretName]' "$out/secret-plan/demo.nonprod.remove-old.json" | sed 's|/subscriptions/[^"]*/||g' || echo none)"
}
plan_case ""
plan_case remove-old
# remove_old_secret: the plan entra_plan wrote, the old variant's job by naming; a job of the app's own CAE is refused.
plan="$out"
slug=demo
names="$SAF_WORK/names.json"
PROV_DIR="$SAF_WORK/unit"
mkdir -p "$PROV_DIR"
( remove_old_secret nonprod 00000000-0000-0000-0000-0000000000c1 ) 2>&1 | sed 's|/subscriptions/[^ ]*/||g' | grep '^CLI ' || echo "REMOVE failed"
jq --arg j "$JOBS/caj-contoso-kvset-hyb" '.job = $j' "$out/secret-plan/demo.nonprod.remove-old.json" > "$SAF_WORK/x.json"
mv "$SAF_WORK/x.json" "$out/secret-plan/demo.nonprod.remove-old.json"
( remove_old_secret nonprod 00000000-0000-0000-0000-0000000000c1 ) > /dev/null 2>&1 && echo "OWNJOB accepted" || echo "OWNJOB refused"
EOS
run_stage follow "PLAN='$repo/pipelines/azure-devops/scripts/provisioning/entra-plan.sh' ENTRA='$repo/pipelines/azure-devops/scripts/provisioning/entra.sh'
$followcode"
s="$tmp/follow/out.log"
check "follow-up: without the plan's followUp nothing is planned" grep -qxF 'PLANOLD none - none' "$s"
check "follow-up: with it, the old variant's vault and kvset job, the vault the app runs with now (from the plan), the app's secret" \
  grep -qxF 'PLANOLD remove-old remove ["kvcontosononprodpabcde","caj-contoso-kvset-ext","kvcontosononprodnabcde","easyauth-demo"]' "$s"
check "follow-up: the stage entra runs easyauth-secret --mode remove-old through the old variant's job with --app-vault" \
  grep -q '^CLI provisioning easyauth-secret --mode remove-old --client-id 00000000-0000-0000-0000-0000000000c1 --job caj-contoso-kvset-ext --secret-name easyauth-demo --vault kvcontosononprodpabcde .*--app-vault kvcontosononprodnabcde ' "$s"
check "follow-up: a plan naming the app's current CAE's job is refused (P26 guard)" grep -qxF 'OWNJOB refused' "$s"

# --- 18. the plan and the report of a move end to end (decide.sh, report.sh), and a decommissioned app --
decide_ws movede
plan_env movede nonprod "$recent"
plan_env movede prod "$recent"
jq '. + {containerAppMode: "externalHybrid", liveFqdn: "ca-demo.old.example.io", lzNetworkMode: "externalOnly", lzPrepareFrom: null}' \
  "$tmp/movede/ws/in/plan_nonprod/facts/demo.json" > "$tmp/movede/f.json"
mv "$tmp/movede/f.json" "$tmp/movede/ws/in/plan_nonprod/facts/demo.json"
run_decide movede
check "decide: a move in nonprod runs its lz, entra (with its landing zone) and release; nothing in prod" test "$(outputs movede)" = \
  "ado=false entraPlan=true lz_nonprod=true post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: ... the plan prints the move with its case" grep -q '^move     demo in nonprod: externalHybrid to externalOnly (case A' "$tmp/movede/out.log"
mkdir -p "$tmp/movede/ws/in/azure_post_nonprod/status"
jq -n '{status: "ok", slug: "demo", environment: "nonprod", reason: null, detail: {move: "moved", moveCase: "A", moveHost: "ca-demo.new.example.io", moveOutage: "1790000000 1790000060"}, done: ["lz", "release"]}' \
  > "$tmp/movede/ws/in/azure_post_nonprod/status/demo.nonprod.json"
run_report movede
check "report: the moves section: the change, its case, the new default host, the outage and the follow-up" \
  grep -qF '| demo | nonprod | externalHybrid to externalOnly (case A) | moved; new default host ca-demo.new.example.io; outage from 2026-09-21T14:13:20Z to 2026-09-21T14:14:20Z; follow-up: the next provisioning run (any) removes the Easy Auth secret and passwords of the previous variant |' "$tmp/movede/ws/saf-out/report/summary.md"
jq '.status = "waiting" | .reason = "demo in nonprod: the app runs another image than its release record names; the move waits and the app is untouched" | .detail = {move: "waiting-image", moveCase: "A"} | .done = []' \
  "$tmp/movede/ws/in/azure_post_nonprod/status/demo.nonprod.json" > "$tmp/movede/s.json"
mv "$tmp/movede/s.json" "$tmp/movede/ws/in/azure_post_nonprod/status/demo.nonprod.json"
run_report movede
check "report: a waiting move says why, and that the app is untouched (the run passes with a warning)" \
  grep -qF '| demo | nonprod | externalHybrid to externalOnly (case A) | waiting, the app untouched: demo in nonprod: the app runs another image than its release record names; the move waits and the app is untouched |' "$tmp/movede/ws/saf-out/report/summary.md"
decide_ws followde none closed
plan_env followde nonprod "$recent"
plan_env followde prod "$recent"
jq '. + {containerAppMode: "externalOnly", secretElsewhere: true}' "$tmp/followde/ws/in/plan_nonprod/facts/demo.json" > "$tmp/followde/f.json"
mv "$tmp/followde/f.json" "$tmp/followde/ws/in/plan_nonprod/facts/demo.json"
run_decide followde
check "decide: the follow-up runs entra in nonprod outside the window too (compared in the plan, no entra_plan)" test "$(outputs followde)" = \
  "ado=false entraPlan=false lz_nonprod=false post_nonprod=false record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "
check "decide: ... followUp remove-old in units.json" test "$(jq -r '.apps.demo.environments.nonprod.followUp' "$tmp/followde/ws/saf-out/units/units.json")" = remove-old
decom_ws decmove "$ahead"
plan_env decmove nonprod "$recent"
plan_env decmove prod "$recent"
jq '. + {containerAppMode: "externalHybrid", liveFqdn: "ca-demo.old.example.io"}' "$tmp/decmove/ws/in/plan_nonprod/facts/demo.json" > "$tmp/decmove/f.json"
mv "$tmp/decmove/f.json" "$tmp/decmove/ws/in/plan_nonprod/facts/demo.json"
run_decide decmove
check "decide: a decommissioned app never moves (its release retires, no modeChange)" \
  test "$(jq -c '.apps.demo.environments.nonprod | [.modeChange, .units.release.action]' "$tmp/decmove/ws/saf-out/units/units.json")" = '[null,"retire"]'
# The window rule (product owner, 2026-11-14): kind prod moves only inside the maintenance window, its prepare
# pass and Entra step run at once; kind nonprod moves at once. move_ws <case> <env> [open|closed].
move_ws() {
  decide_ws "$1" none "${3:-open}"
  plan_env "$1" nonprod "$recent"
  plan_env "$1" prod "$recent"
  jq '. + {containerAppMode: "externalHybrid", liveFqdn: "ca-demo.old.example.io", lzNetworkMode: "externalOnly", lzPrepareFrom: null}' \
    "$tmp/$1/ws/in/plan_$2/facts/demo.json" > "$tmp/$1/f.json"
  mv "$tmp/$1/f.json" "$tmp/$1/ws/in/plan_$2/facts/demo.json"
  run_decide "$1"
}
move_ws prodout prod closed
check "window: kind prod outside the window still runs the prepare pass (lz), Entra (with its landing zone) and the release, which waits" test "$(outputs prodout)" = \
  "ado=false entraPlan=true lz_nonprod=false post_nonprod=false record_nonprod=false registry_nonprod=false lz_prod=true post_prod=true record_prod=true "
check "window: ... units.json has waitsForWindow, the next window's start (maintenance.until)" \
  test "$(jq -r '(.apps.demo.environments.prod.modeChange.waitsForWindow == .maintenance.until) and (.maintenance.until | test("^[0-9]{4}-"))' "$tmp/prodout/ws/saf-out/units/units.json")" = true
check "window: ... and the plan says the move waits for the maintenance window" \
  grep -q '^move     demo in prod: externalHybrid to externalOnly (case B: .*waits for the maintenance window (.*): a production environment; the prepare pass and the Entra step run now, the app is untouched$' "$tmp/prodout/out.log"
mkdir -p "$tmp/prodout/ws/in/azure_post_prod/status"
jq -n '{status: "waiting", slug: "demo", environment: "prod", reason: "demo in prod: waits for the maintenance window", detail: {move: "waiting-window", moveCase: "B"}, done: []}' \
  > "$tmp/prodout/ws/in/azure_post_prod/status/demo.prod.json"
run_report prodout
until_iso="$(jq -r '.maintenance.until' "$tmp/prodout/ws/saf-out/units/units.json")"
check "window: the report says the production move waits for the window, with its start, and that the app is untouched" \
  grep -qF "| demo | prod | externalHybrid to externalOnly (case B) | waits for the maintenance window ($until_iso): a production environment moves only inside it; the prepare pass and the Entra step ran, the app is untouched |" "$tmp/prodout/ws/saf-out/report/summary.md"
move_ws prodin prod open
check "window: kind prod inside the window moves (no waitsForWindow)" \
  test "$(jq -c '.apps.demo.environments.prod | [.modeChange.case, .modeChange.waitsForWindow, .units.release.action]' "$tmp/prodin/ws/saf-out/units/units.json")" = '["B",null,"move"]'
move_ws npout nonprod closed
check "window: kind nonprod moves at once, outside the window too" \
  test "$(jq -c '.apps.demo.environments.nonprod | [.modeChange.case, .modeChange.waitsForWindow, .units.release.action]' "$tmp/npout/ws/saf-out/units/units.json")" = '["A",null,"move"]' \
  -a "$(outputs npout)" = "ado=false entraPlan=true lz_nonprod=true post_nonprod=true record_nonprod=true registry_nonprod=false lz_prod=false post_prod=false record_prod=false "

# --- 19. the delete phase frees the slug's names (ADR-0061 section 4): azure.sh lz_secret_delete and ----
# entra.sh unregister with a fake az and a stubbed CLI that records the command line.
read -r -d '' freecode <<'EOS' || true
PROV_STAGE=azure_nonprod
env_name=nonprod prefix=contoso subscription=00000000-0000-0000-0000-00000000a001
eval "$(sed -n -e '/^lz_secret_delete() {/,/^}/p' "$AZURE")"
eval "$(sed -n -e '/^unregister() {/,/^}/p' "$ENTRA")"
eval "$(sed -n -e '/^app_groups() {/,/^}/p' "$ENTRA")"
eval "$(sed -n -e '/^plan_app_groups() {/,/^}/p' "$ENTRAPLAN")"
SAF_INSTANCE=/cfg/instance.yaml app_file=/cfg/apps/demo/app.yaml
out="$SAF_WORK/out"
mkdir -p "$out/status" "$SAF_IN/plan"
apps_json() { # apps_json <incarnation>: plan/apps.json with demo of that incarnation (ADR-0061)
  jq -n --argjson i "$1" '{checkAllApps: false, apps: [{slug: "demo", ok: true, environments: ["nonprod"], authMode: "required", networkModes: {nonprod: "externalHybrid"}, incarnation: $i}]}' > "$SAF_APPS_JSON"
}
apps_json 0
# names.bicep's uniqueName for incarnation NAMES_INC (default 0).
prov_names() {
  local abbr=""
  case "${4:-}" in externalOnly) abbr=ext ;; externalHybrid) abbr=hyb ;; esac
  jq -n --arg s "$1" --arg e "${3:-$env_name}" --arg a "$abbr" --arg i "${NAMES_INC:-0}" '{outputs: {platformResourceGroup: "rg-contoso-platform-\($e)", easyAuthSecret: "easyauth-\($s)",
    kvsetJob: (if $a == "" then null else "caj-contoso-kvset-\($a)" end), environmentVault: (if $a == "" then null else "kvcontoso\($e)\($a)1" end),
    entraResourceGroup: "rg-contoso-entra", entraEnvironmentResourceGroup: "rg-contoso-entra-\($e)", entraDeployment: "entra-\($s)-\($e)",
    entraApplicationUniqueName: ("contoso-\($s)-\($e)" + (if $i == "0" then "" else "--i\($i)" end))}}' > "$2"
}
opt() { local want="$1" prev=""; shift; for a in "$@"; do if [ "$prev" = "$want" ]; then printf '%s' "$a"; return 0; fi; prev="$a"; done; return 1; }
prov_secret_meta() { echo "META $1"; jq -n --arg s "$SECRET" '{state: $s, created: null, expires: null}' > "$2"; }
prov_job_state() { printf '%s' "$JOB_STATE"; }
prov_lock() { echo "LOCK $1"; }
prov_unlock() { echo "UNLOCK"; }
prov_arm_token() { echo "ARMTOKEN"; }
prov_graph_token() { echo "GRAPHTOKEN"; }
az() { echo "AZ $*"; }
saf_cli() {
  printf 'CLI %s\n' "$*"
  [ "$CLI_RC" = 0 ] || return 1
  case "$1 $2" in
    "provisioning easyauth-delete") jq -n --arg n "$(opt --secret-name "$@")" --arg v "$(opt --vault "$@")" '{secretName: $n, vault: $v, secret: "deleted"}' > "$(opt --output "$@")" ;;
    "provisioning entra-delete") jq -n --arg n "$(opt --unique-name "$@")" '{uniqueName: $n, application: "deleted", servicePrincipal: "deleted"}' > "$(opt --output "$@")" ;;
    "provisioning app-groups") jq -n '{groups: [], deleted: [], keptFor: []}' > "$(opt --output "$@")" ;;
  esac
}
names="$SAF_WORK/names.json"
prov_names demo "$names" nonprod
unit_case() { # unit_case <case> <function> [args]: one unit; its status, detail and the calls it made
  prov_run_app "$out/status/$1.json" demo nonprod "${@:2}" > "$SAF_WORK/$1.log" 2>&1
  printf 'STATUS %s %s %s %s\n' "$1" "$(jq -r '.status' "$out/status/$1.json")" "$(jq -c '.detail' "$out/status/$1.json")" "$(jq -c '.done' "$out/status/$1.json")"
  sed -e 's|/subscriptions/[^ ]*/||g' -e 's|--output [^ ]*|--output <f>|g' "$SAF_WORK/$1.log" | grep -E '^(CLI|LOCK|UNLOCK|ARMTOKEN|GRAPHTOKEN|META|AZ)( |$)' | sed "s/^/$1: /"
}
SECRET=present JOB_STATE=current CLI_RC=0
unit_case present lz_secret_delete
SECRET=absent
unit_case absent lz_secret_delete
SECRET=present JOB_STATE=outdated
unit_case outdated lz_secret_delete
JOB_STATE=missing
unit_case missing lz_secret_delete
JOB_STATE=current CLI_RC=1
unit_case clifail lz_secret_delete
CLI_RC=0
unit_case del0 unregister nonprod
apps_json 2
NAMES_INC=2 prov_names demo "$names" nonprod
unit_case del2 unregister nonprod
# names.bicep without the incarnation apps.json says: the first app's registration, refused.
prov_names demo "$names" nonprod
unit_case mismatch unregister nonprod || true # no call to list: grep finds nothing
apps_json 0
CLI_RC=1
unit_case entrafail unregister nonprod
CLI_RC=0
# ADR-0077: the app groups after the registration; and when the plan has the stage keep them.
unit_case groups app_groups nonprod
inputs="$SAF_WORK/entra-inputs.json"
pag() { # pag <case> <with app groups: yes|no> <verdict> <reasons JSON>: plan_app_groups' decision as the detail
  if [ "$2" = yes ]; then jq -n '{appGroups: {roles: ["Reader"]}}' > "$inputs"; else jq -n '{}' > "$inputs"; fi
  jq -n --argjson r "$4" '{apps: {demo: {environments: {nonprod: {units: {entra: {run: true, reasons: $r}}}}}}}' > "$SAF_WORK/units.json"
  SAF_UNITS_JSON="$SAF_WORK/units.json" unit_case "$1" plan_app_groups nonprod "$inputs" "$3" || true # no call: grep finds nothing
}
slug=demo
pag gdeploy yes deploy '[]'
pag gdrift yes up-to-date '["drift"]'
pag ginputs yes up-to-date '["inputs"]'
pag gnew yes up-to-date '["new"]'
pag gdropped no up-to-date '["inputs"]'
pag gplain no deploy '["template"]'
EOS
run_stage freenames "AZURE='$repo/pipelines/azure-devops/scripts/provisioning/azure.sh' ENTRA='$repo/pipelines/azure-devops/scripts/provisioning/entra.sh' ENTRAPLAN='$repo/pipelines/azure-devops/scripts/provisioning/entra-plan.sh'
$freecode"
s="$tmp/freenames/out.log"
check "free names: a present secret is deleted through the kvset job of the app's mode, in that mode's vault, under the job's lock" \
  test "$(grep '^present: ' "$s" | tr '\n' '|')" = "present: META kvcontosononprodhyb1|present: LOCK kvset-caj-contoso-kvset-hyb|present: ARMTOKEN|present: CLI provisioning easyauth-delete --job caj-contoso-kvset-hyb --vault kvcontosononprodhyb1 --secret-name easyauth-demo --output <f>|present: UNLOCK|"
check "free names: ... ok, detail easyAuthSecret deleted" grep -qxF 'STATUS present ok {"easyAuthSecret":"deleted"} []' "$s"
check "free names: an absent secret is done without a job start" \
  test "$(grep -c '^absent: \(CLI\|LOCK\|ARMTOKEN\)' "$s")" = 0 -a "$(grep -c '^STATUS absent ok {"easyAuthSecret":"absent"} \[\]$' "$s")" = 1
check "free names: a kvset job not on this core's image, or missing, waits (no start; delete-lz isn't reached, the record stays)" \
  test "$(grep -c '^STATUS outdated waiting {"easyAuthSecret":"job-outdated"} \[\]$' "$s")" = 1 -a "$(grep -c '^STATUS missing waiting {"easyAuthSecret":"job-missing"} \[\]$' "$s")" = 1 \
  -a "$(grep -c '^\(outdated\|missing\): \(CLI\|LOCK\|ARMTOKEN\)' "$s")" = 0
check "free names: a failed delete fails the unit" grep -qxF 'STATUS clifail failed {} []' "$s"
check "free names: the app groups of the kind (ADR-0077), the registration by the app's own uniqueName (incarnation 0: {prefix}-{slug}-{env}), then its records in its environment's group and in rg-{prefix}-entra (ADR-0063)" \
  test "$(grep '^del0: \(CLI\|AZ deployment group delete\)' "$s" | tr '\n' '|')" = "del0: CLI provisioning app-groups --instance /cfg/instance.yaml --app /cfg/apps/demo/app.yaml --env nonprod --delete --output <f>|del0: CLI provisioning entra-delete --unique-name contoso-demo-nonprod --output <f>|del0: AZ deployment group delete --name entra-demo-nonprod --resource-group rg-contoso-entra-nonprod --only-show-errors --output <f>|del0: AZ deployment group delete --name entra-demo-nonprod --resource-group rg-contoso-entra --only-show-errors --output <f>|" \
  -a "$(grep -c '^STATUS del0 ok {"entra":"deleted"} \["delete-entra"\]$' "$s")" = 1
check "free names: a later incarnation deletes its own registration ({prefix}-{slug}-{env}--i2), then its record" \
  test "$(grep -c -xF 'del2: CLI provisioning entra-delete --unique-name contoso-demo-nonprod--i2 --output <f>' "$s")" = 1 \
  -a "$(grep -c '^STATUS del2 ok {"entra":"deleted"} \["delete-entra"\]$' "$s")" = 1
check "app groups (ADR-0077): app-groups after the registration with the app's own files and its registration's uniqueName, under one Graph token" \
  test "$(grep '^groups: ' "$s" | tr '\n' '|')" = "groups: GRAPHTOKEN|groups: CLI provisioning app-groups --instance /cfg/instance.yaml --app /cfg/apps/demo/app.yaml --env nonprod --unique-name contoso-demo-nonprod --output <f>|" \
  -a "$(grep -c '^STATUS groups ok {"appGroups":"synced"} \[\]$' "$s")" = 1
check "app groups (ADR-0077): the plan keeps them on a deploy or a change, not for a drift check alone; an app without them only on an inputs change" \
  test "$(grep -c '^STATUS \(gdeploy\|ginputs\|gnew\|gdropped\) ok {"appGroups":"sync"} \[\]$' "$s")" = 4 \
  -a "$(grep -c '^STATUS \(gdrift\|gplain\) ok {} \[\]$' "$s")" = 2
check "free names: a uniqueName that isn't the app's own incarnation's deletes nothing; a failed delete keeps the record" \
  test "$(grep -c '^mismatch: \(CLI\|GRAPHTOKEN\|AZ\)' "$s")" = 0 -a "$(grep -c '^entrafail: AZ deployment group delete' "$s")" = 0 \
  -a "$(grep -c '^STATUS \(mismatch\|entrafail\) failed {} \[\]$' "$s")" = 2

# --- 20. the Entra records per environment (ADR-0063): plan.sh entra_records, entra-plan.sh -----------
# entra_record and entra_target, entra.sh register with a fake az.
read -r -d '' recordscode <<'EOS' || true
PROV_STAGE=plan_prod
env_name=prod prefix=contoso
HISTORY_WARN=600
eval "$(sed -n -e '/^history_count() {/,/^}/p' -e '/^entra_list() {/,/^}/p' -e '/^entra_records() {/,/^}/p' "$PLANSH")"
bulk="$SAF_WORK/bulk"
mkdir -p "$bulk"
jq -n '{entraResourceGroup: "rg-contoso-entra", entraResourceGroups: {nonprod: "rg-contoso-entra-nonprod", prod: "rg-contoso-entra-prod"}}' > "$SAF_WORK/plan-names.json"
# The fake ARM: each group's deployments from $SAF_WORK/groups/<group>.json; no file: ResourceGroupNotFound;
# FAIL_GROUP: another error.
mkdir -p "$SAF_WORK/groups"
az() {
  local rg="" prev=""
  for a in "$@"; do if [ "$prev" = --resource-group ]; then rg="$a"; fi; prev="$a"; done
  printf 'AZ %s %s\n' "$1 $2 $3" "$rg" >> "$SAF_WORK/az.log"
  if [ "$rg" = "${FAIL_GROUP:-}" ]; then echo "ERROR: (AuthorizationFailed) no" >&2; return 1; fi
  [ -f "$SAF_WORK/groups/$rg.json" ] || { echo "ERROR: (ResourceGroupNotFound) Resource group '$rg' could not be found." >&2; return 3; }
  cat "$SAF_WORK/groups/$rg.json"
}
rec() { jq -n --arg n "$1" --arg s "$2" --arg t "$3" '{name: $n, state: $s, timestamp: $t}'; }
# nonprod: demo moved (a newer record than its old one in rg-contoso-entra), tie on another app, a nested
# deployment of the bootstrap and a record named for another environment (neither counts from this group).
jq -s . <(rec entra-demo-nonprod Succeeded 2026-11-15T10:00:00.0000000Z) <(rec entra-tie-nonprod Failed 2026-11-01T00:00:00.0000000Z) \
  <(rec bootstrap-entra-operator-nonprod Succeeded 2026-11-14T00:00:00.0000000Z) <(rec entra-stray-prod Succeeded 2026-11-15T00:00:00.0000000Z) > "$SAF_WORK/groups/rg-contoso-entra-nonprod.json"
# rg-contoso-entra-prod doesn't exist yet (the bootstrap wasn't run again); rg-contoso-entra holds the old records.
jq -s . <(rec entra-demo-nonprod Succeeded 2026-10-01T10:00:00.0000000Z) <(rec entra-tie-nonprod Succeeded 2026-11-01T00:00:00.0000000Z) \
  <(rec entra-demo-prod Succeeded 2026-10-01T10:00:00.0000000Z) <(rec entra-old-nonprod Succeeded 2026-09-01T00:00:00.0000000Z) \
  <(rec entra-permissions Succeeded 2026-08-01T00:00:00.0000000Z) <(rec entra-portal-prod Succeeded 2026-08-02T00:00:00.0000000Z) > "$SAF_WORK/groups/rg-contoso-entra.json"
entra_records > "$SAF_WORK/records.log" 2>&1
echo "RECORDS $(jq -c 'sort_by(.name) | map([.name, .state, .group])' "$bulk/entra-records.json")"
echo "GROUPS $(jq -c . "$bulk/entra-groups.json")"
echo "MISSING $(grep -c "rg-contoso-entra-prod doesn't exist yet: the Entra registrations of prod keep their records in rg-contoso-entra" "$SAF_WORK/records.log" || true)"
echo "LEGACY $(grep -o 'of apps still in rg-contoso-entra (they move with their registration.s next deployment): [0-9]*' "$SAF_WORK/records.log" || true)"
echo "LISTS $(wc -l < "$SAF_WORK/az.log")"
FAIL_GROUP=rg-contoso-entra entra_records > /dev/null 2>&1
echo "FAILED $(cat "$bulk/entra-records.json")"

# entra-plan.sh: where the record is read, and where a deployment goes.
eval "$(sed -n -e '/^entra_record() {/,/^}/p' -e '/^entra_target() {/,/^}/p' "$ENTRAPLAN")"
SAF_ENV_NAME=prod
mkdir -p "$SAF_IN/plan_prod"
PROV_DIR="$SAF_WORK/unit"
mkdir -p "$PROV_DIR"
prov_detail() { printf 'DETAIL %s %s\n' "$1" "$2"; }
prov_record() { # the fake record of <name> in <group>: from $SAF_WORK/groups (Succeeded ones), with its timestamp
  rm -f "$4"
  printf 'READ %s\n' "$3" >> "$SAF_WORK/reads.log"
  [ -f "$SAF_WORK/groups/$3.json" ] || return 0
  if jq -e --arg n "$2" 'map(select(.name == $n)) | if length == 0 then false else (first | {name, properties: {timestamp}}) end' \
      "$SAF_WORK/groups/$3.json" > "$4.tmp" 2> /dev/null; then mv "$4.tmp" "$4"; else rm -f "$4.tmp"; fi
}
entra_rg=rg-contoso-entra-nonprod instance_rg=rg-contoso-entra
cp "$bulk/entra-groups.json" "$SAF_WORK/g.json"
read_case() { # read_case <label> <record name> <plan.json entraRecords>
  entra_name="$2"
  jq -n --argjson r "$3" --slurpfile g "$SAF_WORK/g.json" '{schemaVersion: 1, environment: "prod", tagsRead: true, entraRecords: $r, entraGroups: $g[0]}' > "$SAF_IN/plan_prod/plan.json"
  : > "$SAF_WORK/reads.log"
  ( entra_record nonprod; printf 'READ_FROM %s %s %s\n' "$1" "$(tr '\n' ',' < "$SAF_WORK/reads.log")" "$(jq -r '.properties.timestamp // "none"' "$PROV_DIR/entra-record.json" 2> /dev/null || echo none)" ) 2>&1 || true
}
read_case env entra-demo-nonprod '[{"name": "entra-demo-nonprod", "state": "Succeeded", "group": "rg-contoso-entra-nonprod"}]'
read_case instance entra-old-nonprod '[{"name": "entra-old-nonprod", "state": "Succeeded", "group": "rg-contoso-entra"}]'
read_case unlisted entra-new-nonprod '[]'
read_case unknown entra-demo-nonprod 'null'
echo "FOREIGN $(read_case foreign entra-demo-nonprod '[{"name": "entra-demo-nonprod", "state": "Succeeded", "group": "rg-other"}]' | grep -c 'in another resource group than' || true)"
echo "TARGET nonprod=$(entra_target nonprod) prod=$(entra_target prod)"

# entra.sh register: the record into the group the plan named; the old one moves after it.
eval "$(sed -n -e '/^register() {/,/^}/p' -e '/^retire_instance_record() {/,/^}/p' "$ENTRA")"
slug=demo
names="$SAF_WORK/names.json"
jq -n '{outputs: {entraResourceGroup: "rg-contoso-entra", entraEnvironmentResourceGroup: "rg-contoso-entra-nonprod", entraDeployment: "entra-demo-nonprod"}}' > "$names"
plan="$SAF_WORK/plan"
out="$SAF_WORK/out"
mkdir -p "$plan/entra-inputs" "$out/entra-outputs"
jq -n '{prefix: "contoso", slug: "demo", environmentName: "nonprod"}' > "$plan/entra-inputs/demo.nonprod.json"
# The fakes record their calls in order (a show's output goes to /dev/null in entra.sh).
prov_arm() { printf 'ARM %s %s %s\n' "$1" "$4" "$5" >> "$SAF_WORK/reg.calls"; [ "${ARM_RC:-0}" = 0 ] || exit 1; jq -n '{properties: {outputs: {clientId: {value: "00000000-0000-0000-0000-0000000000c1"}}}}' > "$6"; }
az() { printf 'AZ %s\n' "$*" >> "$SAF_WORK/reg.calls"; case "$3" in show) [ "${OLD:-yes}" = yes ] ;; delete) [ "${DELETE_RC:-0}" = 0 ] || { echo "ERROR: (Conflict) no" >&2; return 1; } ;; esac; }
reg_case() { # reg_case <label> <target>
  local rc=0
  : > "$SAF_WORK/reg.calls"
  ( register nonprod "$2" ) > "$SAF_WORK/reg-$1.log" 2>&1 || rc=$?
  sed "s/^/$1: /" "$SAF_WORK/reg.calls"
  sed -n -e 's/^DETAIL entraRecord /DETAIL entraRecord /p' -e 's/^##vso\[task.logissue type=warning\]/WARN /p' "$SAF_WORK/reg-$1.log" | sed "s/^/$1: /"
  echo "$1: rc $rc"
}
reg_case env environment
reg_case inst instance
OLD=no reg_case nolegacy environment
DELETE_RC=1 reg_case delfail environment
ARM_RC=1 reg_case armfail environment
reg_case none ""
EOS
run_stage records "PLANSH='$repo/pipelines/azure-devops/scripts/provisioning/plan.sh' ENTRAPLAN='$repo/pipelines/azure-devops/scripts/provisioning/entra-plan.sh' ENTRA='$repo/pipelines/azure-devops/scripts/provisioning/entra.sh'
$recordscode"
s="$tmp/records/out.log"
check "Entra records: the most recent record of each name, in whichever group; the environment's group on a tie; only records named for the environment from its group" \
  grep -qxF 'RECORDS [["entra-demo-nonprod","Succeeded","rg-contoso-entra-nonprod"],["entra-demo-prod","Succeeded","rg-contoso-entra"],["entra-old-nonprod","Succeeded","rg-contoso-entra"],["entra-permissions","Succeeded","rg-contoso-entra"],["entra-portal-prod","Succeeded","rg-contoso-entra"],["entra-tie-nonprod","Failed","rg-contoso-entra-nonprod"]]' "$s"
check "Entra records: a missing environment group keeps its records in rg-{prefix}-entra, with a warning" \
  test "$(grep '^GROUPS ' "$s")" = 'GROUPS {"nonprod":"rg-contoso-entra-nonprod","prod":"rg-contoso-entra"}' -a "$(grep '^MISSING ' "$s")" = "MISSING 1"
check "Entra records: the apps' records left in rg-{prefix}-entra are counted (not entra-permissions, not the portal's)" grep -qxF 'LEGACY of apps still in rg-contoso-entra (they move with their registration'"'"'s next deployment): 2' "$s"
check "Entra records: one list per group (two environments and the instance's group)" grep -qxF 'LISTS 3' "$s"
check "Entra records: a list that fails (not a missing group) makes the records unknown (null)" grep -qxF 'FAILED null' "$s"
check "entra_record: read where the plan listed it (the environment's group)" \
  test "$(grep '^READ_FROM env ' "$s")" = 'READ_FROM env READ rg-contoso-entra-nonprod, 2026-11-15T10:00:00.0000000Z' -a "$(grep -c '^DETAIL entraRecord environment$' "$s")" -ge 1
check "entra_record: a record from before ADR-0063 is read in rg-{prefix}-entra (detail entraRecord instance)" \
  test "$(grep '^READ_FROM instance ' "$s")" = 'READ_FROM instance READ rg-contoso-entra, 2026-09-01T00:00:00.0000000Z' -a "$(grep -c '^DETAIL entraRecord instance$' "$s")" -ge 1
check "entra_record: a record the plan didn't list is read in the environment's group only (a new registration: none)" \
  test "$(grep '^READ_FROM unlisted ' "$s")" = 'READ_FROM unlisted READ rg-contoso-entra-nonprod, none'
check "entra_record: without the plan's list both groups are read and the newer record counts" \
  test "$(grep '^READ_FROM unknown ' "$s")" = 'READ_FROM unknown READ rg-contoso-entra-nonprod,READ rg-contoso-entra, 2026-11-15T10:00:00.0000000Z'
check "entra_record: a plan that lists the record in a group of neither name fails the app" grep -qxF 'FOREIGN 1' "$s"
check "entra_target: the environment's group, rg-{prefix}-entra while that group doesn't exist" grep -qxF 'TARGET nonprod=environment prod=instance' "$s"
check "register: into the environment's group, then the old record in rg-{prefix}-entra is deleted (detail entraRecord moved)" \
  test "$(grep '^env: ' "$s" | tr '\n' '|')" = 'env: ARM create entra-demo-nonprod rg-contoso-entra-nonprod|env: AZ deployment group show --name entra-demo-nonprod --resource-group rg-contoso-entra --query name --output tsv --only-show-errors|env: AZ deployment group delete --name entra-demo-nonprod --resource-group rg-contoso-entra --only-show-errors --output none|env: DETAIL entraRecord moved|env: rc 0|'
check "register: into rg-{prefix}-entra while the environment's group doesn't exist; nothing deleted" \
  test "$(grep '^inst: ' "$s" | tr '\n' '|')" = 'inst: ARM create entra-demo-nonprod rg-contoso-entra|inst: rc 0|'
check "register: no old record, nothing deleted; a failed delete only warns" \
  test "$(grep -c '^nolegacy: AZ deployment group delete' "$s")" = 0 -a "$(grep -c '^nolegacy: rc 0$' "$s")" = 1 \
  -a "$(grep -c '^delfail: WARN demo in nonprod: could not delete the old record entra-demo-nonprod in rg-contoso-entra' "$s")" = 1 -a "$(grep -c '^delfail: rc 0$' "$s")" = 1
check "register: a failed deployment deletes no old record; a plan naming no group deploys nothing" \
  test "$(grep -c '^armfail: AZ' "$s")" = 0 -a "$(grep -c '^armfail: rc 1$' "$s")" = 1 -a "$(grep -c '^none: \(ARM\|AZ\)' "$s")" = 0 -a "$(grep -c '^none: rc 1$' "$s")" = 1
# --- 21. failure codes (ADR-0064): prov_unit, prov_arm and prov_vault_clash, the report -------------
read -r -d '' failcode <<'EOS' || true
mkdir -p "$SAF_CORE/tools"
ln -s "$CLI_DIR" "$SAF_CORE/tools/platform-cli"
PROV_STAGE=azure_test
out="$SAF_OUT/azure_test"
mkdir -p "$out/status"
coded() { prov_failure PE006; prov_failure PE005; saf_die "breaks with a code"; }
garbage() { prov_failure 'PE5; rm -rf /'; saf_die "breaks with a malformed code"; }
waits() { prov_failure PE005; prov_wait "waits for something"; }
fine() { prov_failure PE005; }
for c in coded garbage waits fine; do
  prov_run_app "$(prov_status_path "$out" "$c" test)" "$c" test "$c"
done
for c in coded garbage waits fine; do
  printf 'STATUS %s %s %s|%s\n' "$c" "$(jq -r .status "$out/status/$c.test.json")" "$(jq -r '.code // "null"' "$out/status/$c.test.json")" "$(jq -r .reason "$out/status/$c.test.json")"
done
# prov_arm: a fake az (the deployment fails with SkuNotAvailable; the deleted vault per DELETED) and a
# fake prov_names (names.bicep's appVault, with the generation it was given).
slug=demo env_name=test subscription=00000000-0000-0000-0000-00000000a001
prov_names() { printf 'NAMES %s\n' "$*" >> "$SAF_WORK/names.log"; jq -n --arg g "${8:-}" '{outputs: {appVault: (if $g == "" then null else "kvdemo\($g)abcdef" end)}}' > "$2"; }
az() {
  printf 'AZ %s\n' "$*" >> "$SAF_WORK/az.log"
  case "$*" in
    "deployment sub create"* | "deployment group create"*)
      echo 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","details":[{"code":"ResourceDeploymentFailure","details":[{"code":"SkuNotAvailable","message":"Specified SKU is not available in location."}]}]}}' >&2
      return 1 ;;
    "rest --method get --url /subscriptions/"*"/providers/Microsoft.KeyVault/locations/westeurope/deletedVaults/kvdemo2abcdef?api-version="*)
      case "$DELETED" in
        held) echo '{"name": "kvdemo2abcdef", "type": "Microsoft.KeyVault/deletedVaults", "properties": {"deletionDate": "2026-11-01T10:00:00Z", "scheduledPurgeDate": "2027-01-30T10:00:00Z", "purgeProtectionEnabled": true}}' ;;
        refused) echo 'ERROR: Forbidden({"error":{"code":"AuthorizationFailed","message":"x"}})' >&2; return 1 ;;
        *) echo 'ERROR: Not Found({"error":{"code":"ResourceNotFound","message":"x"}})' >&2; return 1 ;;
      esac ;;
    *) echo "unexpected az call" >&2; return 1 ;;
  esac
}
printf '{"generation": 2, "location": "westeurope"}\n' > "$SAF_WORK/lz.json"
arm_case() { # arm_case <case> <kind> <DELETED>: the case is the app's slug
  slug="$1"
  DELETED="$3" prov_run_app "$(prov_status_path "$out" "$1" test)" "$1" test prov_arm create "$2" "$SAF_WORK/lz.json" "lz-demo-test" westeurope "$SAF_WORK/out-$1.json"
  printf 'ARM %s %s %s\n' "$1" "$(jq -r .status "$out/status/$1.test.json")" "$(jq -r '.code // "null"' "$out/status/$1.test.json")"
}
arm_case lzfree lz free
arm_case lzheld lz held
arm_case lzrefused lz refused
: > "$SAF_WORK/az.log"
arm_case release release held
printf 'RELEASE-ASKED %s\n' "$(grep -c deletedVaults "$SAF_WORK/az.log" || true)"
EOS
run_stage failcodes "CLI_DIR='$cli_dir'
$failcode"
s="$tmp/failcodes/out.log"
check "failure codes: a failed unit's status has the last code prov_failure set, also in its reason" \
  grep -qxF 'STATUS coded failed PE005|failed in azure_test (exit 1, code PE005); see the log of that stage' "$s"
check "failure codes: ... and its error line names it" grep -q '^##vso\[task.logissue type=error\]coded in test: failed in azure_test (code PE005); the other apps go on$' "$s"
check "failure codes: a malformed code is ignored (PE001)" grep -qxF 'STATUS garbage failed PE001|failed in azure_test (exit 1, code PE001); see the log of that stage' "$s"
check "failure codes: a waiting or ok unit has none" \
  test "$(grep -c -x -e 'STATUS waits waiting null|waits for something' -e 'STATUS fine ok null|null' "$s")" = 2
check "failure codes: a landing zone failing with SkuNotAvailable is PE005 when no deleted vault holds the name (404)" grep -qxF 'ARM lzfree failed PE005' "$s"
check "failure codes: ... PE009 when a soft-deleted vault holds it (US04.11)" grep -qxF 'ARM lzheld failed PE009' "$s"
check "failure codes: ... with an error line for the platform team: generation, the runbook" \
  grep -qF '##vso[task.logissue type=error]lzheld in test: the name of its vault kvdemo2abcdef is held by a soft-deleted vault (code PE009). Recover or purge that vault, or raise generation in apps/lzheld/app.yaml when the app is gone in every environment: docs/runbooks/key-vault-name-clash.md' "$s"
check "failure codes: ... and the deleted vault's dates" grep -qF 'The vault name kvdemo2abcdef is held by a soft-deleted vault: deleted 2026-11-01T10:00:00Z, purged after 2027-01-30T10:00:00Z, purge protection true' "$s"
check "failure codes: the vault is named with the inputs' generation (names.bicep appVault)" \
  test "$(grep -c '^NAMES lz[a-z]* .*names-vault.json test     2$' "$tmp/failcodes/ws/saf-work/names.log")" = 3
check "failure codes: a refused read of the deleted vault keeps the deployment's code, and says so" \
  test "$(grep -c -x 'ARM lzrefused failed PE005' "$s")" = 1 -a "$(grep -c 'Could not read whether a deleted vault holds the name kvdemo2abcdef' "$s")" = 1
check "failure codes: a release's failure doesn't ask about deleted vaults" \
  test "$(grep -c -x -e 'ARM release failed PE005' -e 'RELEASE-ASKED 0' "$s")" = 2

# The report: a failed landing zone with PE009 and an app environment the plan could not plan.
decide_ws failrep
plan_env failrep nonprod "$recent" lz
plan_env failrep prod "$recent"
run_decide failrep
mkdir -p "$tmp/failrep/ws/in/azure_nonprod/status"
jq -n '{schemaVersion: 1, stage: "azure_nonprod", slug: "demo", environment: "nonprod", status: "failed",
  reason: "failed in azure_nonprod (exit 1, code PE009); see the log of that stage", code: "PE009", detail: {}, done: []}' \
  > "$tmp/failrep/ws/in/azure_nonprod/status/demo.nonprod.json"
jq '.apps.demo.environments.prod.plan = "failed"' "$tmp/failrep/ws/saf-out/units/units.json" > "$tmp/failrep/u.json"
mv "$tmp/failrep/u.json" "$tmp/failrep/ws/saf-out/units/units.json"
run_report failrep
fr="$tmp/failrep/ws/saf-out/report"
check "report: a failed cell shows its code, and the run fails" \
  test "$(grep -c '| failed PE009 |' "$fr/summary.md")" = 1 -a "$(cat "$tmp/failrep/report.rc")" = 1
check "report: the section Failures lists the step, its code and title, and what to do" \
  test "$(grep -c -x -e '### Failures' -e "| demo | nonprod | azure_nonprod | PE009 | The name of the app's vault is still held by a deleted vault |" -e '| demo | prod | plan_prod | PE003 | The platform couldn'"'"'t read the app'"'"'s current state |' "$fr/summary.md")" = 3 \
  -a "$(grep -c '^- \*\*PE009\*\* .*Runbook: docs/runbooks/key-vault-name-clash.md\.$' "$fr/summary.md")" = 1
check "report: failures.json for the portal (artifact report): the failed step and the plan's PE003" \
  test "$(jq -c '[.failures[] | [.slug, .environment, .stage, .code]] | sort' "$fr/failures.json")" = '[["demo","nonprod","azure_nonprod","PE009"],["demo","prod","plan_prod","PE003"]]' \
  -a "$(jq -r '.runId' "$fr/failures.json")" = 42
check "report: a run without failures has an empty list and no section" \
  test "$(jq -c '.failures' "$tmp/quiet/ws/saf-out/report/failures.json")" = '[]' -a "$(grep -c 'Failures' "$tmp/quiet/ws/saf-out/report/summary.md")" = 0

# --- 22. PE010's clean-up (ADR-0064 amendment 2026-11-17): prov_arm and prov_lz_stale_assignments ----
read -r -d '' stale <<'EOS' || true
mkdir -p "$SAF_CORE/tools"
ln -s "$CLI_DIR" "$SAF_CORE/tools/platform-cli"
PROV_STAGE=azure_test
out="$SAF_OUT/azure_test"
mkdir -p "$out/status"
PROV_STALE_WAIT_S=0
slug=demo env_name=nonprod subscription=00000000-0000-0000-0000-00000000a001
names="$SAF_WORK/names.json"
jq -n '{outputs: {appResourceGroup: "rg-contoso-app-demo-nonprod", platformResourceGroup: "rg-contoso-platform-nonprod"}}' > "$names"
prov_names() { jq -n '{outputs: {appVault: null}}' > "$2"; }
SUB=/subscriptions/00000000-0000-0000-0000-00000000a001
CAE=$SUB/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.App/managedEnvironments/cae-contoso-ext-nonprod
RA=$CAE/providers/Microsoft.Authorization/roleAssignments/11111111-1111-1111-1111-111111111111
OTHER=$SUB/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.KeyVault/vaults/kvcontosonp/secrets/easyauth-other/providers/Microsoft.Authorization/roleAssignments/22222222-2222-2222-2222-222222222222
az() {
  printf 'AZ %s\n' "$*" >> "$SAF_WORK/az.log"
  case "$*" in
    "deployment sub create"*)
      n=$(( $(cat "$SAF_WORK/creates" 2>/dev/null || echo 0) + 1 ))
      echo "$n" > "$SAF_WORK/creates"
      if [ "$n" -le "${FAILS:-1}" ]; then
        echo 'ERROR: {"status":"Failed","error":{"code":"DeploymentFailed","details":[{"code":"ResourceDeploymentFailure","details":[{"code":"RoleAssignmentUpdateNotPermitted","message":"Tenant ID, application ID, principal ID, and scope are not allowed to be updated."}]}]}}' >&2
        return 1
      fi
      echo '{"properties": {"outputs": {}}}' ;;
    "identity list --resource-group rg-contoso-app-demo-nonprod "*) printf '%s\n' "${CURRENT-33333333-3333-3333-3333-333333333333}" ;;
    "deployment operation sub list --name lz-demo-nonprod "*)
      jq -n --arg sub "$SUB" '[
        {properties: {provisioningState: "Failed", targetResource: {resourceType: "Microsoft.Resources/deployments", id: "\($sub)/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.Resources/deployments/joinerOnCae-abcdefghijklm"}}},
        {properties: {provisioningState: "Failed", targetResource: {resourceType: "Microsoft.Resources/deployments", id: "\($sub)/resourceGroups/rg-other/providers/Microsoft.Resources/deployments/something-abcdefghijklm"}}},
        {properties: {provisioningState: "Succeeded", targetResource: {resourceType: "Microsoft.Resources/deployments", id: "\($sub)/resourceGroups/rg-contoso-platform-nonprod/providers/Microsoft.Resources/deployments/easyAuthOnSecret-abcdefghijklm"}}}]' ;;
    "deployment operation group list --subscription 00000000-0000-0000-0000-00000000a001 --resource-group rg-contoso-platform-nonprod --name joinerOnCae-abcdefghijklm "*)
      jq -n --arg ra "$RA" --arg other "$OTHER" '[
        {properties: {provisioningState: "Failed", targetResource: {resourceType: "Microsoft.Authorization/roleAssignments", id: $ra}, statusMessage: {status: "Failed", error: {code: "RoleAssignmentUpdateNotPermitted", message: "x"}}}},
        {properties: {provisioningState: "Failed", targetResource: {resourceType: "Microsoft.Authorization/roleAssignments", id: $other}, statusMessage: {error: {code: "RoleAssignmentUpdateNotPermitted"}}}},
        {properties: {provisioningState: "Failed", targetResource: {resourceType: "Microsoft.Authorization/roleAssignments", id: ($ra | sub("1111-111111111111$"; "1111-111111111112"))}, statusMessage: {error: {code: "AuthorizationFailed"}}}}]' ;;
    "rest --method get --url $RA?api-version=2022-04-01 "*) printf '%s\n' "${HOLDER:-44444444-4444-4444-4444-444444444444}" ;;
    "rest --method get --url $OTHER?api-version="*) echo 44444444-4444-4444-4444-444444444444 ;;
    "role assignment delete --ids $RA "*) ;;
    *) echo "unexpected az call" >&2; return 1 ;;
  esac
}
printf '{"location": "westeurope"}\n' > "$SAF_WORK/lz.json"
stale_case() { # stale_case <case>; env FAILS, CURRENT, HOLDER
  : > "$SAF_WORK/az.log"
  rm -f "$SAF_WORK/creates"
  prov_run_app "$(prov_status_path "$out" "$1" nonprod)" "$1" nonprod prov_arm create lz "$SAF_WORK/lz.json" lz-demo-nonprod westeurope "$SAF_WORK/out-$1.json"
  printf 'CASE %s %s %s creates=%s deletes=%s others=%s\n' "$1" "$(jq -r .status "$out/status/$1.nonprod.json")" "$(jq -r '.code // "null"' "$out/status/$1.nonprod.json")" \
    "$(cat "$SAF_WORK/creates")" "$(grep -c '^AZ role assignment delete' "$SAF_WORK/az.log" || true)" "$(grep -c "^AZ role assignment delete --ids $OTHER" "$SAF_WORK/az.log" || true)"
}
stale_case stale
HOLDER=33333333-3333-3333-3333-333333333333 stale_case live
CURRENT= stale_case noidentity
FAILS=2 stale_case twice
EOS
run_stage stale "CLI_DIR='$cli_dir'
$stale"
s="$tmp/stale/out.log"
check "PE010 clean-up: the deleted identity's assignment the app's own record named is removed, then one more deployment succeeds" \
  grep -qxF 'CASE stale ok null creates=2 deletes=1 others=0' "$s"
check "PE010 clean-up: ... and it says so; a named assignment at a scope the landing zone doesn't write is left, with a warning" \
  test "$(grep -c 'Removing the role assignment 11111111-1111-1111-1111-111111111111: it belonged to an identity of stale that was deleted with its resource group' "$s")" = 1 \
  -a "$(grep -c "the role assignment 22222222-2222-2222-2222-222222222222 the landing zone couldn't write is at a scope it doesn't write outside its group" "$s")" -ge 1
check "PE010 clean-up: an assignment that an identity of the app holds now is never removed (PE010 stays)" grep -qxF 'CASE live failed PE010 creates=1 deletes=0 others=0' "$s"
check "PE010 clean-up: without the app's identities nothing is removed" grep -qxF 'CASE noidentity failed PE010 creates=1 deletes=0 others=0' "$s"
check "PE010 clean-up: only once per deployment: a second PE010 fails the unit" grep -qxF 'CASE twice failed PE010 creates=2 deletes=1 others=0' "$s"
check "PE010 clean-up: no az call outside the fake's list" test "$(grep -c 'unexpected az call' "$s")" = 0

if [ "$failures" -gt 0 ]; then
  printf 'check-prov-units: %s failure(s)\n' "$failures"
  exit 1
fi
printf 'check-prov-units: all checks passed (11 units: %s s in parallel, %s s one at a time)\n' "$parallel_s" "$sequential_s"
