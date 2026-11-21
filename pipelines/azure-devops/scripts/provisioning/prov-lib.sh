# shellcheck shell=bash
# shellcheck disable=SC2034,SC2154 # globals are shared with the sourcing script (app_file, names, ...)
# Helpers of the provisioning scripts (scripts/provisioning/*.sh, ADR-0032). Sourced after
# ../lib.sh, never executed.
#
# Layout: as in delivery (lib.sh): core -> $(Pipeline.Workspace)/s/core, platform-config (self)
# -> s/config; artifacts of earlier stages are downloaded to $(Pipeline.Workspace)/in/<artifact>,
# this stage's artifact is written to $(Pipeline.Workspace)/saf-out/<artifact>.
#
# Per-app isolation (ADR-0032 decision 6): prov_run_app runs one unit (one app, or one app x
# environment) in a subshell with errexit on, so any failing command or saf_die ends that unit only,
# and the loop goes on. Its status lands in status/<slug>[.<env>].json of the stage artifact: ok |
# failed | waiting; a failed one with its failure code (ADR-0064: `code`, set by prov_failure, PE001
# when nothing set one). A stage that calls prov_parallel runs up to PROV_PARALLEL_MAX units at the same
# time, each unit's output printed as one group when it ends (ADR-0046). prov_finish waits for every
# unit and exits 1 at the end when any unit failed.
#
# Provisioning by unit (ADR-0048): what provisioning does for an app is split into units (lz, entra,
# release, frontdoor, pep per app x environment; ado per app). Stage `plan` decides which units run
# (units/units.json, `platform provisioning plan-units`); every stage processes exactly the units
# the plan gave it (prov_unit_runs) and counts every other one as unchanged (prov_pass). An app's
# entries (landing-zone outputs, Easy Auth secret, Front Door) come from the stage that processed it,
# else from plan_<env> (prov_entry_dir); a unit the plan sent to a stage with no ok status there is
# not ok (prov_lz_ok, prov_post_ok). Stage record_<env> writes the tags saf-u-<unit> of the units
# that finished (prov_unit_finished), the rebased tags of held units and saf-u-files (ADR-0049).
#
# Untrusted text (app.yaml content such as titles, Azure error text) is printed only by the
# platform CLI (neutralised) or through saf_neutralise. Messages built here contain only slugs and
# environment names, whose shape is checked first.

set -euo pipefail
shopt -s inherit_errexit
set +x

# prov_env_guard: these scripts hold Azure DevOps, Azure and Microsoft Graph tokens and the Easy
# Auth client secret. Pipeline variables become environment variables of every step, so a variable
# that turns on shell tracing or injects code into the CLI (`SHELLOPTS=xtrace`,
# `NODE_OPTIONS=--import=…`) would leak them; refuse to run with any of these exported (P17).
prov_env_guard() {
  local v
  for v in SHELLOPTS BASHOPTS BASH_ENV ENV PS4 BASH_XTRACEFD NODE_OPTIONS; do
    if printenv "$v" > /dev/null; then
      printf '##vso[task.logissue type=error]%s\n' "$v is set in the environment of a provisioning step; refusing to run (pipeline variables must not set it)"
      exit 1
    fi
  done
}
prov_env_guard

# shellcheck source=../lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/../lib.sh"

SAF_IN="$SAF_WS/in"
SAF_INSTANCE="$SAF_CONFIG/instance.yaml"
SAF_APPS_JSON="$SAF_IN/plan/apps.json"
# The run's plan (ADR-0048): stage plan, job decide, artifact `units`.
SAF_UNITS_JSON="$SAF_IN/units/units.json"
SAF_IMAGES_JSON="$SAF_CORE/images/images.json"
export SAF_IN SAF_INSTANCE SAF_APPS_JSON SAF_UNITS_JSON SAF_IMAGES_JSON

# The only parameter files provisioning deploys with (tests/check-templates.py rule P06).
prov_lz_param="$SAF_CORE/infra/app/provisioning/landing-zone.bicepparam"
prov_release_param="$SAF_CORE/infra/app/provisioning/release.bicepparam"
prov_entra_param="$SAF_CORE/infra/entra/provisioning/app-registration.bicepparam"
prov_frontdoor_param="$SAF_CORE/infra/app/provisioning/frontdoor.bicepparam"
prov_portal_endpoint_param="$SAF_CORE/infra/app/provisioning/portal-endpoint.bicepparam"
# Names come from naming.bicep, evaluated offline (same file as delivery, ADR-0020).
prov_names_param="$SAF_CORE/infra/app/delivery/names.bicepparam"

PROV_STAGE="${PROV_STAGE:-provisioning}"
PROV_OK=0
PROV_WAITING=0
PROV_FAILED=0
PROV_SKIPPED=0
PROV_UNCHANGED=0
# Scratch directory of the unit being processed (set by prov_run_app).
PROV_DIR=""

# PROV_PARALLEL_MAX: how many units a stage that calls prov_parallel runs at the same time (ADR-0046).
# A core constant: no template parameter or pipeline variable sets it (hard rule 3); the hosted
# agent (4 vCPUs) and ARM's request limits bound it, not the instance.
PROV_PARALLEL_MAX=6
# Units at a time in this stage: 1 (in order, output straight to the log) until prov_parallel.
PROV_PARALLEL=1
PROV_SEQ=0
# Running units: pid -> "<status file>|<slug>|<env>"; every unit in start order (the summary).
declare -A PROV_RUNNING=()
PROV_UNITS=()
# Stage-wide locks (prov_lock) and the print lock (prov_say, prov_unit_block).
PROV_LOCKS="$SAF_WORK/locks"
mkdir -p "$PROV_LOCKS"

[ -f "$SAF_INSTANCE" ] || saf_die "platform-config has no instance.yaml at its root"

prov_valid_slug() { [[ "$1" =~ ^[a-z](-?[a-z0-9])+$ ]]; }
prov_valid_env() { [[ "$1" =~ ^[a-z][a-z0-9]{1,7}$ ]]; }
# A capacity cell id (ADR-0053): 01 to 99.
prov_valid_cell() { [[ "$1" =~ ^(0[1-9]|[1-9][0-9])$ ]]; }
prov_valid_guid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; }

# ---------------------------------------------------------------------------------------------
# Plan (artifact `plan`, written by validate.sh from `platform provisioning apps`)
# ---------------------------------------------------------------------------------------------

# prov_plan_apps [env]: the slugs of the valid apps (running in env, when given) into PROV_APPS.
prov_plan_apps() {
  local slug
  [ -f "$SAF_APPS_JSON" ] || saf_die "artifact plan has no apps.json"
  jq -e '.apps | type == "array"' "$SAF_APPS_JSON" >/dev/null || saf_die "plan/apps.json has no apps list"
  PROV_APPS=()
  while IFS= read -r slug; do
    prov_valid_slug "$slug" || saf_die "plan/apps.json lists an invalid slug"
    PROV_APPS+=("$slug")
  done < <(jq -r --arg e "${1:-}" \
    '.apps[] | select(.ok == true) | select($e == "" or (((.environments // []) | index($e)) != null)) | .slug' \
    "$SAF_APPS_JSON")
}

# prov_app_envs <slug>: the app's environments (validated names) into PROV_APP_ENVS.
prov_app_envs() {
  local e
  PROV_APP_ENVS=()
  while IFS= read -r e; do
    prov_valid_env "$e" || saf_die "plan/apps.json lists an invalid environment name"
    PROV_APP_ENVS+=("$e")
  done < <(jq -r --arg s "$1" '.apps[] | select(.slug == $s) | .environments[]' "$SAF_APPS_JSON")
  [ "${#PROV_APP_ENVS[@]}" -gt 0 ] || saf_die "plan/apps.json lists no environment for an app"
}

# prov_app_auth <slug>: required | anonymous.
prov_app_network_mode() { # <slug> <env>: environments.<env>.networkMode of app.yaml (plan/apps.json)
  local mode
  mode="$(jq -r --arg s "$1" --arg e "$2" '.apps[] | select(.slug == $s) | (.networkModes // {})[$e] // ""' "$SAF_APPS_JSON")"
  case "$mode" in
    externalOnly|externalHybrid) printf '%s' "$mode" ;;
    *) echo "plan/apps.json has no valid networkMode for this app in this environment" >&2; return 1 ;;
  esac
}

prov_app_auth() {
  local mode
  mode="$(jq -r --arg s "$1" '.apps[] | select(.slug == $s) | .authMode // ""' "$SAF_APPS_JSON")"
  case "$mode" in
    required|anonymous) printf '%s' "$mode" ;;
    *) echo "plan/apps.json has no valid authMode for this app" >&2; return 1 ;;
  esac
}

# prov_app_front_door <slug> <env>: the app's custom host in that environment
# (environments.<env>.frontDoor.hostName, lower-case, ADR-0010), or nothing when it requests none.
prov_app_front_door() {
  local host
  host="$(jq -r --arg s "$1" --arg e "$2" '.apps[] | select(.slug == $s) | .frontDoorHosts[$e] // ""' "$SAF_APPS_JSON")"
  [ -z "$host" ] || prov_valid_host "$host" || { echo "plan/apps.json has no valid custom host for this app" >&2; return 1; }
  printf '%s' "$host"
}

# prov_valid_host <host>: a lower-case host name with at least three labels (app.schema.json).
prov_valid_host() { [[ "$1" =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.){2,}[a-z]{2,63}$ ]] && [ "${#1}" -le 244 ]; }

# prov_app_cell <slug> <env>: app.yaml environments.<env>.cell (ADR-0053) from plan/apps.json, which
# `platform provisioning apps` writes for every environment of the app (01 when app.yaml names none):
# with the network mode, the app's CAE and its kvset and dbinit jobs. Nothing when apps.json doesn't
# list the app (or there is none) or has no cell for env, so names that need one stay null and
# prov_name fails on them rather than name another cell's; an error for a value that isn't 01 to 99.
prov_app_cell() {
  local c
  [ -f "$SAF_APPS_JSON" ] || return 0
  c="$(jq -r --arg s "$1" --arg e "$2" 'first(.apps[] | select(.slug == $s and .ok == true) | (.cells // {})[$e]) // "" | tostring' "$SAF_APPS_JSON")"
  [ -z "$c" ] || prov_valid_cell "$c" || { echo "plan/apps.json has no valid cell for this app in $2" >&2; return 1; }
  printf '%s' "$c"
}

# prov_app_incarnation <slug>: app.yaml incarnation (ADR-0061, default 0) from plan/apps.json, which
# names the app's Entra registration; nothing when apps.json doesn't list the app (or there is none),
# an error when the value isn't an integer >= 0.
prov_app_incarnation() {
  local n
  [ -f "$SAF_APPS_JSON" ] || return 0
  n="$(jq -r --arg s "$1" 'first(.apps[] | select(.slug == $s and .ok == true) | .incarnation) // "" | tostring' "$SAF_APPS_JSON")"
  [ -z "$n" ] || [[ "$n" =~ ^(0|[1-9][0-9]{0,8})$ ]] || { echo "plan/apps.json has no valid incarnation for this app" >&2; return 1; }
  printf '%s' "$n"
}

# prov_app_file <slug>: apps/<slug>/app.yaml in the platform-config checkout.
prov_app_file() {
  local f="$SAF_CONFIG/apps/$1/app.yaml"
  [ -f "$f" ] || { echo "apps/$1/app.yaml is missing" >&2; return 1; }
  printf '%s' "$f"
}

# ---------------------------------------------------------------------------------------------
# Statuses
# ---------------------------------------------------------------------------------------------

# prov_status_path <artifact dir> <slug> [env]
prov_status_path() {
  if [ -n "${3:-}" ]; then
    printf '%s/status/%s.%s.json' "$1" "$2" "$3"
  else
    printf '%s/status/%s.json' "$1" "$2"
  fi
}

# prov_status_ok <status file>: true when the file exists and says ok.
prov_status_ok() {
  [ -f "$1" ] && [ "$(jq -r '.status // ""' "$1" 2>/dev/null)" = ok ]
}

# prov_skip <slug> <why>: the app is not processed in this stage (an upstream status is not ok).
# No status is written; the report shows the upstream one.
prov_skip() {
  PROV_SKIPPED=$((PROV_SKIPPED + 1))
  prov_say "Skipping $1: $2"
}

# prov_pass <slug> <env>: no unit of the app that this stage processes runs in env (the plan,
# ADR-0048): not processed here, and no status is written; the report shows it as unchanged. Counted
# only (prov_finish prints the total): a line per app would be hundreds of lines (ADR-0050).
prov_pass() {
  PROV_UNCHANGED=$((PROV_UNCHANGED + 1))
}

# prov_done <unit>: the current unit of work finished that provisioning unit in this stage
# (azure_post_<env>: lz after its second pass and dbinit, release after its restart check); the status
# file lists it under `done` (read by prov_unit_finished).
# ADR-0056: delete-<unit> when a decommissioned app's unit was deleted (record writes "removed").
prov_done() {
  [[ "$1" =~ ^(lz|release|delete-(lz|entra|frontdoor|pep|ado))$ ]] || saf_die "prov_done: unknown unit"
  printf '%s\n' "$1" >> "$PROV_DIR/done.txt"
}

# prov_detail <key> <value>: a fact about the current app for its status file (e.g. what was
# deployed). Keys and values are fixed words chosen by the scripts.
prov_detail() {
  local file="$PROV_DIR/detail.json"
  [ -f "$file" ] || printf '{}\n' > "$file"
  jq --arg k "$1" --arg v "$2" '. + {($k): $v}' "$file" > "$file.tmp"
  mv "$file.tmp" "$file"
}

# prov_failure <code>: the failure code of the current unit, should it fail (ADR-0064): a stable ID of
# the platform CLI's catalogue (explanations.ts PROVISIONING_FAILURE_IDS, PE001...; a test checks every
# literal code of these scripts against it). The last one set wins; a unit that fails without one gets
# PE001 (unknown: see the log). prov_unit writes it into the failed status file and its error line,
# where the portal and the report read it; never the cloud's error text. A value that isn't a code is
# ignored.
prov_failure() {
  [[ "$1" =~ ^PE[0-9]{3}$ ]] || return 0
  printf '%s\n' "$1" > "$PROV_DIR/failure.txt"
}

# prov_wait <reason>: ends the current app with status `waiting` (blocked on something outside
# this run; a warning, not a failure). The reason is fixed text plus slug/environment names.
prov_wait() {
  printf '%s\n' "$1" > "$PROV_DIR/waiting.txt"
  printf '##vso[task.logissue type=warning]%s\n' "$1"
  exit 3
}

# prov_say <line>: one line to the log under the print lock, so it never lands inside a unit's group.
prov_say() {
  local fd
  exec {fd}>> "$PROV_LOCKS/print.lock"
  flock "$fd"
  printf '%s\n' "$1"
  exec {fd}>&-
}

# prov_parallel: this stage runs up to PROV_PARALLEL_MAX units at the same time (azure.sh,
# azure-post.sh, entra-plan.sh, record.sh; not the Azure DevOps stages and not entra, ADR-0046). It
# needs bash 5.1 (wait -n -p); an older bash stays sequential.
prov_parallel() {
  if [ "${BASH_VERSINFO[0]}" -gt 5 ] || { [ "${BASH_VERSINFO[0]}" -eq 5 ] && [ "${BASH_VERSINFO[1]}" -ge 1 ]; }; then
    PROV_PARALLEL=$PROV_PARALLEL_MAX
  else
    printf '##vso[task.logissue type=warning]%s\n' "$PROV_STAGE: bash is older than 5.1; one app at a time"
  fi
}

# prov_run_app <status file> <slug> <env or ''> <command> [args...]
# One unit. Sequential (PROV_PARALLEL 1): runs it now, its output straight to the log. Parallel:
# waits until fewer than PROV_PARALLEL units run, then runs it in the background, its output held in
# memory and printed as one group when it ends (prov_unit_block); prov_join waits for them. Never
# stops the loop. Each unit has its own scratch directory PROV_DIR.
prov_run_app() {
  local status_file="$1" slug="$2" env="$3"
  shift 3
  PROV_SEQ=$((PROV_SEQ + 1))
  PROV_DIR="$SAF_WORK/apps/$PROV_SEQ.$slug${env:+.$env}"
  rm -rf "$PROV_DIR"
  mkdir -p "$PROV_DIR" "$(dirname "$status_file")"
  PROV_UNITS+=("$status_file|$slug|$env")
  if [ "$PROV_PARALLEL" -le 1 ]; then
    printf '\n========== %s%s (%s) ==========\n' "$slug" "${env:+ in $env}" "$PROV_STAGE"
    prov_unit "$status_file" "$slug" "$env" "$@"
    prov_tally "$status_file" "$slug" "$env"
    return 0
  fi
  while [ "${#PROV_RUNNING[@]}" -ge "$PROV_PARALLEL" ]; do
    prov_reap
  done
  prov_say "Started: $slug${env:+ in $env}"
  (
    prov_unit "$status_file" "$slug" "$env" "$@" < /dev/null 2>&1 | prov_unit_block "$status_file" "$slug" "$env"
  ) &
  PROV_RUNNING[$!]="$status_file|$slug|$env"
}

# prov_unit <status file> <slug> <env or ''> <command> [args...]: runs the command in a subshell
# with errexit on (exit 0 = ok, 3 = waiting, anything else = failed) and writes the status file.
prov_unit() {
  local status_file="$1" slug="$2" env="$3" rc status reason detail code=""
  shift 3
  set +e
  (
    set -e
    "$@"
  )
  rc=$?
  set -e
  # Exit 3 counts as `waiting` only together with the reason file prov_wait writes.
  [ "$rc" -ne 3 ] || [ -f "$PROV_DIR/waiting.txt" ] || rc=1
  case "$rc" in
    0)
      status=ok
      reason=""
      ;;
    3)
      status=waiting
      reason="$(head -c 500 "$PROV_DIR/waiting.txt" 2>/dev/null || true)"
      ;;
    *)
      status=failed
      # The failure code (ADR-0064): what prov_failure recorded, else PE001.
      code="$(head -n 1 "$PROV_DIR/failure.txt" 2> /dev/null || true)"
      [[ "$code" =~ ^PE[0-9]{3}$ ]] || code=PE001
      reason="failed in $PROV_STAGE (exit $rc, code $code); see the log of that stage"
      printf '##vso[task.logissue type=error]%s\n' "$slug${env:+ in $env}: failed in $PROV_STAGE (code $code); the other apps go on"
      ;;
  esac
  detail="$PROV_DIR/detail.json"
  [ -f "$detail" ] || printf '{}\n' > "$detail"
  touch "$PROV_DIR/done.txt"
  jq -n --arg stage "$PROV_STAGE" --arg slug "$slug" --arg env "$env" --arg status "$status" \
    --arg reason "$reason" --arg code "$code" --arg runId "${BUILD_BUILDID:-}" --slurpfile detail "$detail" --rawfile 'done' "$PROV_DIR/done.txt" \
    '{schemaVersion: 1, stage: $stage, slug: $slug, environment: (if $env == "" then null else $env end),
      status: $status, reason: (if $reason == "" then null else $reason end), code: (if $code == "" then null else $code end),
      runId: $runId, detail: $detail[0], done: ($done | split("\n") | map(select(. != "")) | unique)}' > "$status_file"
  saf_info "$slug${env:+ in $env}: $status"
}

# prov_unit_block <status file> <slug> <env>: reads a background unit's output (stdin) to its end,
# then prints it as one group under the print lock, headed by the unit's status. The output is what
# the unit printed, as a sequential stage prints it: Azure and app text already through
# saf_neutralise or the CLI, and its logging commands (logissue; a token's setsecret, which comes
# before every line of the unit that could show the token). Held in memory only, never in a file.
prov_unit_block() {
  local buf status fd
  buf="$(cat)"
  status="$(jq -r '.status // ""' "$1" 2>/dev/null || true)"
  [[ "$status" =~ ^(ok|waiting|failed)$ ]] || status=failed
  exec {fd}>> "$PROV_LOCKS/print.lock"
  flock "$fd"
  printf '##[group]%s%s (%s): %s\n' "$2" "${3:+ in $3}" "$PROV_STAGE" "$status"
  printf '%s\n' "$buf"
  printf '##[endgroup]\n'
  exec {fd}>&-
}

# prov_tally <status file> <slug> <env>: counts a finished unit (parent shell). A unit without a
# valid status file (killed, or its status write failed) is failed, and gets one.
prov_tally() {
  local status
  status="$(jq -r '.status // ""' "$1" 2>/dev/null || true)"
  case "$status" in
    ok) PROV_OK=$((PROV_OK + 1)) ;;
    waiting) PROV_WAITING=$((PROV_WAITING + 1)) ;;
    failed) PROV_FAILED=$((PROV_FAILED + 1)) ;;
    *)
      PROV_FAILED=$((PROV_FAILED + 1))
      prov_say "##vso[task.logissue type=error]$2${3:+ in $3}: failed in $PROV_STAGE (no status written, code PE001); the other apps go on"
      jq -n --arg stage "$PROV_STAGE" --arg slug "$2" --arg env "$3" --arg runId "${BUILD_BUILDID:-}" \
        '{schemaVersion: 1, stage: $stage, slug: $slug, environment: (if $env == "" then null else $env end),
          status: "failed", reason: "failed in \($stage) (no status written); see the log of that stage", code: "PE001",
          runId: $runId, detail: {}}' > "$1"
      ;;
  esac
}

# prov_reap: waits until one running unit has ended and counts it.
prov_reap() {
  local pid unit f s e
  while :; do
    # wait unsets pid first, and leaves it unset when no child is left.
    pid=""
    wait -n -p pid || true
    pid="${pid:-}"
    if [ -n "$pid" ] && [ -n "${PROV_RUNNING[$pid]+x}" ]; then
      break
    fi
    if [ -z "$pid" ]; then
      # No child left to wait for (exit 127): every unit still listed has ended.
      for pid in "${!PROV_RUNNING[@]}"; do
        unit="${PROV_RUNNING[$pid]}"
        unset "PROV_RUNNING[$pid]"
        IFS='|' read -r f s e <<< "$unit"
        prov_tally "$f" "$s" "$e"
      done
      return 0
    fi
  done
  unit="${PROV_RUNNING[$pid]}"
  unset "PROV_RUNNING[$pid]"
  IFS='|' read -r f s e <<< "$unit"
  prov_tally "$f" "$s" "$e"
}

# prov_join: waits for every running unit (before a stage reads their statuses, and in prov_finish).
prov_join() {
  while [ "${#PROV_RUNNING[@]}" -gt 0 ]; do
    prov_reap
  done
}

# prov_lock <name>: holds the stage-wide lock <name> until prov_unlock or the unit's end (the lock is
# a file descriptor of the unit's process). Around the deployments into a resource that units of the
# stage share (ADR-0046): one Front Door profile (frontdoor), the portal's subnet and DNS zone
# (portal-endpoint), one platform job (dbinit-<job>). One lock at a time, so no deadlock.
prov_lock() {
  [[ "$1" =~ ^[a-z][a-z0-9-]{0,80}$ ]] || saf_die "prov_lock: invalid lock name"
  exec {PROV_LOCK_FD}> "$PROV_LOCKS/$1.lock"
  flock "$PROV_LOCK_FD"
}

prov_unlock() {
  exec {PROV_LOCK_FD}>&-
}

# prov_finish: waits for every unit, prints each unit's status in start order (the plan's order),
# then the totals; exit 1 when any unit failed (after every unit was processed).
prov_finish() {
  local u f s e status
  prov_join
  saf_info ""
  for u in "${PROV_UNITS[@]}"; do
    IFS='|' read -r f s e <<< "$u"
    status="$(jq -r '.status' "$f" 2>/dev/null || printf failed)"
    saf_info "  $s${e:+ in $e}: $status"
  done
  saf_info "$PROV_STAGE: $PROV_OK ok, $PROV_UNCHANGED unchanged, $PROV_WAITING waiting, $PROV_FAILED failed, $PROV_SKIPPED skipped (not ok upstream)."
  if [ "$PROV_FAILED" -gt 0 ]; then
    printf '##vso[task.logissue type=error]%s\n' "$PROV_STAGE: $PROV_FAILED app(s) failed; the other apps went on (statuses in the stage artifact)"
    exit 1
  fi
}

# ---------------------------------------------------------------------------------------------
# Units (ADR-0048): the plan of this run (artifact `units`, job decide of stage plan)
# ---------------------------------------------------------------------------------------------

# prov_units_check: the plan exists and is this run's (schemaVersion 1, the instance's core version).
prov_units_check() {
  [ -f "$SAF_UNITS_JSON" ] || saf_die "artifact units has no units.json (stage plan failed; see its job decide)"
  jq -e '.schemaVersion == 1 and (.apps | type == "object") and (.stages | type == "object")' "$SAF_UNITS_JSON" > /dev/null \
    || saf_die "units/units.json is not a plan of platform provisioning plan-units"
  # The index prov_unit_runs and prov_planned read (ADR-0050): one jq over the plan instead of one
  # per app and unit, which at hundreds of apps cost every stage minutes.
  # ADR-0056: a unit with an action (retire, delete) that runs gets a line "action <s> <e> <u> <action>";
  # ADR-0060: the release's move too.
  jq -r '.apps | to_entries[] | .key as $s | .value.environments | to_entries[] | .key as $e | .value
      | (if .plan == "ok" then "planned \($s) \($e)" else empty end),
        ((.units // {}) | to_entries[] | select(.value.run == true) | "run \($s) \($e) \(.key)"),
        ((.units // {}) | to_entries[] | select(.value.run == true and ((.value.action // "") | test("^(retire|delete|move)$")))
          | "action \($s) \($e) \(.key) \(.value.action)")' \
    "$SAF_UNITS_JSON" > "$SAF_WORK/units.index.tmp"
  mv "$SAF_WORK/units.index.tmp" "$SAF_WORK/units.index"
}

# prov_in_window: the run's time, as the plan took it, is inside instance.yaml maintenance.window
# (units.json maintenance.inWindow; ADR-0048 section 7, amended 2026-11-11). Time-based work the
# plan didn't decide itself waits for it too: a rotation found due while entra runs for another
# reason (entra-plan.sh plan_secret). One time per run, so every stage decides alike.
prov_in_window() {
  [ "$(jq -r '.maintenance.inWindow == true' "$SAF_UNITS_JSON" 2> /dev/null)" = true ]
}

# prov_unit_runs <slug> <env> <unit>: the plan runs that unit of the app in env (ado: in any of its
# environments; the plan copies the app's ado decision into each of them). From the index of
# prov_units_check when it is newer than the plan, else from the plan itself.
prov_unit_runs() {
  if [ "$SAF_WORK/units.index" -nt "$SAF_UNITS_JSON" ]; then
    grep -qxF "run $1 $2 $3" "$SAF_WORK/units.index"
    return
  fi
  [ "$(jq -r --arg s "$1" --arg e "$2" --arg u "$3" '.apps[$s].environments[$e].units[$u].run == true' "$SAF_UNITS_JSON" 2> /dev/null)" = true ]
}

# prov_unit_action <slug> <env> <unit>: what a running unit does (ADR-0056): retire, delete, move
# (ADR-0060, release only), or apply (the default, also for a unit that doesn't run). From the index of
# prov_units_check, else the plan.
prov_unit_action() {
  local a
  if [ "$SAF_WORK/units.index" -nt "$SAF_UNITS_JSON" ]; then
    a="$(awk -v s="$1" -v e="$2" -v u="$3" '$1 == "action" && $2 == s && $3 == e && $4 == u { print $5; exit }' "$SAF_WORK/units.index")"
  else
    a="$(jq -r --arg s "$1" --arg e "$2" --arg u "$3" '.apps[$s].environments[$e].units[$u] | if .run == true then (.action // "") else "" end' "$SAF_UNITS_JSON" 2> /dev/null || true)"
  fi
  case "$a" in
    retire | delete) printf '%s' "$a" ;;
    move) if [ "$3" = release ]; then printf move; else printf apply; fi ;;
    *) printf apply ;;
  esac
}

# prov_mode_change <slug> <env> <from|to|case|fromHost|resume|waitsForWindow|fromCell|toCell>: a field of
# the plan's network mode change of the app in env (ADR-0060, units.json modeChange), checked: from and to
# externalOnly|externalHybrid (and different), case A|B, fromHost a host name or nothing, resume
# true|false, waitsForWindow the next maintenance window's start (ISO 8601, UTC) or nothing (kind prod
# outside the window: the move step waits; product owner, 2026-11-14), fromCell the capacity cell the
# live app runs in (01 to 99; nothing for a resumed move, the app is gone) and toCell app.yaml's cell
# (ADR-0053; the move places the app in a cell of the target mode, ADR-0060 amendment 2026-11-16).
# Nothing when the plan moves nothing there (the release's action isn't move); an unexpected value fails.
prov_mode_change() {
  local v
  [ "$(prov_unit_action "$1" "$2" release)" = move ] || return 0
  v="$(jq -r --arg s "$1" --arg e "$2" --arg k "$3" '.apps[$s].environments[$e].modeChange[$k] | if . == null then "" else tostring end' "$SAF_UNITS_JSON")"
  case "$3/$v" in
    from/externalOnly | from/externalHybrid | to/externalOnly | to/externalHybrid | case/A | case/B | resume/true | resume/false | fromHost/ | waitsForWindow/ | fromCell/) ;;
    fromCell/* | toCell/*) prov_valid_cell "$v" || { echo "units.json has no valid modeChange.$3 for $1 in $2" >&2; return 1; } ;;
    fromHost/*) prov_valid_host "$v" || { echo "units.json has no valid modeChange.fromHost for $1 in $2" >&2; return 1; } ;;
    waitsForWindow/*) [[ "$v" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{3})?Z$ ]] \
      || { echo "units.json has no valid modeChange.waitsForWindow for $1 in $2" >&2; return 1; } ;;
    *) echo "units.json has no valid modeChange.$3 for $1 in $2" >&2; return 1 ;;
  esac
  if [ "$3" = from ] && [ "$v" = "$(jq -r --arg s "$1" --arg e "$2" '.apps[$s].environments[$e].modeChange.to // ""' "$SAF_UNITS_JSON")" ]; then
    echo "units.json moves $1 in $2 to the mode it comes from" >&2
    return 1
  fi
  printf '%s' "$v"
}

# prov_follow_up <slug> <env>: the plan runs the follow-up of a case A move there (ADR-0060 decision 8,
# units.json followUp remove-old): the entra unit removes the old variant's secret and passwords.
prov_follow_up() {
  prov_unit_runs "$1" "$2" entra \
    && [ "$(jq -r --arg s "$1" --arg e "$2" '.apps[$s].environments[$e].followUp // ""' "$SAF_UNITS_JSON")" = remove-old ]
}

# prov_was_retired <slug> <env>: the app is active again after a decommissioning was cancelled (ADR-0056:
# the plan removes its saf-u-retired); its release starts a stopped Container App first.
prov_was_retired() {
  [ "$(jq -r --arg s "$1" --arg e "$2" '.apps[$s].environments[$e].retired.remove == true' "$SAF_UNITS_JSON" 2> /dev/null)" = true ]
}

# prov_planned <slug> <env>: stage plan read the app's state in env (its job plan_<env> has an ok
# status for it); otherwise none of its units run there in this run.
prov_planned() {
  if [ "$SAF_WORK/units.index" -nt "$SAF_UNITS_JSON" ]; then
    grep -qxF "planned $1 $2" "$SAF_WORK/units.index"
    return
  fi
  [ "$(jq -r --arg s "$1" --arg e "$2" '.apps[$s].environments[$e].plan == "ok"' "$SAF_UNITS_JSON" 2> /dev/null)" = true ]
}

# prov_post_runs <slug> <env>: azure_post_<env> processes the app (its lz second pass, frontdoor or
# release runs there).
# A landing zone's delete (ADR-0056) is azure_<env>'s alone: no second pass.
prov_post_runs() {
  { prov_unit_runs "$1" "$2" lz && [ "$(prov_unit_action "$1" "$2" lz)" != delete ]; } \
    || prov_unit_runs "$1" "$2" frontdoor || prov_unit_runs "$1" "$2" release
}

# prov_copy_object <src> <dst>: copies the JSON object in <src> (an entry of plan_<env> or azure_<env>)
# to <dst>; fails, writing nothing usable, when <src> isn't a JSON object. (`jq -e 'type == "object"'`
# would write `true` instead of the object.)
prov_copy_object() {
  jq -e 'if type == "object" then . else false end' "$1" > "$2"
}

# prov_entry_dir <slug> <env>: where the app's entries in env are (lz-outputs/, secret/,
# frontdoor/): the artifact of azure_<env> when its lz ran there, else plan_<env>'s.
prov_entry_dir() {
  if prov_unit_runs "$1" "$2" lz; then
    printf '%s/azure_%s' "$SAF_IN" "$2"
  else
    printf '%s/plan_%s' "$SAF_IN" "$2"
  fi
}

# prov_entra_dir <slug> <env>: where the Entra plan of the app in env is (ADR-0050): the artifact
# entra_plan when its lz ran there too (compared after the landing zone), else units/entra (compared in
# the job decide of stage plan). Status files, entra-inputs/, entra-outputs/, entra-removals/ and
# secret-plan/ of the app are read from there only.
prov_entra_dir() {
  if prov_unit_runs "$1" "$2" lz; then
    printf '%s/entra_plan' "$SAF_IN"
  else
    printf '%s/units/entra' "$SAF_IN"
  fi
}

# prov_entra_work <plan|landing>: how many entra units the plan runs that the Entra plan of that phase
# compares (landing: together with their lz; plan: without it). From the index of prov_units_check.
prov_entra_work() {
  local n
  n="$(awk -v p="$1" '$1 == "run" { k = $2 " " $3; if ($4 == "entra") e[k] = 1; if ($4 == "lz") l[k] = 1 }
    END { n = 0; for (k in e) if ((k in l) == (p == "landing")) n++; print n }' "$SAF_WORK/units.index")"
  [[ "$n" =~ ^[0-9]+$ ]] || saf_die "prov_entra_work: the unit index is unreadable"
  printf '%s' "$n"
}

# prov_lz_ok <slug> <env>: the app's landing zone in env is ok for the stages after it: azure_<env>
# finished it when the plan sent its lz there (no status = not ok, never guessed), else plan_<env>
# read its record.
prov_lz_ok() {
  if prov_unit_runs "$1" "$2" lz; then
    prov_status_ok "$(prov_status_path "$SAF_IN/azure_$2" "$1" "$2")"
  else
    prov_planned "$1" "$2"
  fi
}

# prov_post_ok <slug> <env>: the same for azure_post_<env> (second pass, custom domain, release).
prov_post_ok() {
  if prov_post_runs "$1" "$2"; then
    prov_status_ok "$(prov_status_path "$SAF_IN/azure_post_$2" "$1" "$2")"
  else
    prov_planned "$1" "$2"
  fi
}

# prov_unit_tag <slug> <env> <unit> <tag|record|rebase>: the tag as the plan read it, the value
# record_<env> writes when the unit finishes, or the rebased value it writes for a held unit whose
# rendering alone changed (ADR-0049 section 3); nothing when there is none. Checked: saf-u-<unit>
# values have the shape "<version> <12 hex> <YYYYMMDD>" (anything else is never written back or
# deleted by value).
prov_unit_tag() {
  local v
  v="$(jq -r --arg s "$1" --arg e "$2" --arg u "$3" --arg k "$4" '.apps[$s].environments[$e].units[$u][$k] // ""' "$SAF_UNITS_JSON")"
  if [ -n "$v" ] && [[ ! "$v" =~ ^v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\ [0-9a-f]{12}\ [0-9]{8}$ ]] && [[ ! "$v" =~ ^removed\ [0-9]{8}$ ]]; then
    return 0
  fi
  printf '%s' "$v"
}

# prov_files_tag <slug> <env> <files|filesTag>: the tag saf-u-files (ADR-0049 section 3) that
# record_<env> writes with the unit tags (files), or as the plan read it (filesTag); 12 hex, or
# nothing.
prov_files_tag() {
  local v
  v="$(jq -r --arg s "$1" --arg e "$2" --arg k "$3" '.apps[$s].environments[$e][$k] // ""' "$SAF_UNITS_JSON")"
  if [[ "$v" =~ ^[0-9a-f]{12}$ ]]; then printf '%s' "$v"; fi
}

# prov_tags_restore <resource group>: a landing-zone deployment rewrites the tags of the app resource
# group (lz-{slug}-{env} creates it with its tags), so right after one the job writes the tags
# saf-u-* (saf-u-files included, ADR-0049) back as the plan read them (ADR-0048 section 3). A
# failure is a warning: the units then count as untagged and run again next time, which is fail
# safe. Globals: slug, env_name.
prov_tags_restore() {
  local rg="$1" u v files err="$PROV_DIR/tags-restore.err"
  local -a tags=()
  if [[ ! "$rg" =~ ^[-a-z0-9]{1,90}$ ]]; then
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the landing zone has no valid output resourceGroupName; its unit tags are not written back (its units run again in the next run)"
    return 0
  fi
  # The group the tags go on is the app's by naming (names.bicep), never an output alone (ADR-0052).
  if [ "$rg" != "$(prov_name "$names" appResourceGroup)" ]; then
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the landing zone's output resourceGroupName is not the app's resource group by naming; its unit tags are not written back (its units run again in the next run)"
    return 0
  fi
  for u in lz entra release frontdoor pep ado; do
    v="$(prov_unit_tag "$slug" "$env_name" "$u" tag)"
    [ -z "$v" ] || tags+=("saf-u-$u=$v")
  done
  files="$(prov_files_tag "$slug" "$env_name" filesTag)"
  [ -z "$files" ] || tags+=("saf-u-files=$files")
  [ "${#tags[@]}" -gt 0 ] || return 0
  if ! az tag update --resource-id "/subscriptions/$subscription/resourceGroups/$rg" --operation merge \
      --tags "${tags[@]}" --only-show-errors --output none 2> "$err"; then
    saf_neutralise < "$err" | tail -n 10
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not write back the unit tags after its landing-zone deployment; its units run again in the next run"
    return 0
  fi
  saf_info "  Unit tags written back after the landing-zone deployment (${#tags[@]})"
}

# prov_status_done <status file> <unit>: the status lists the unit under `done`.
prov_status_done() {
  [ -f "$1" ] && [ "$(jq -r --arg u "$2" '(.done // []) | index($u) != null' "$1" 2> /dev/null)" = true ]
}

# prov_unit_finished <slug> <env> <unit> <host>: the unit ran in this run and finished in env (reads
# this run's artifacts; ADR-0048 section 3, the conditions of ADR-0046 split per unit). <host> is
# portal.hostEnvironment. Never fails: anything unreadable is not finished.
#   lz         azure_<env> ok, and azure_post_<env> did its second pass and dbinit (done lz; in a
#              network mode change only after the move step's final pass and dbinit, ADR-0060, and
#              release only at the move step's end)
#   frontdoor  azure_post_<env> done release (its custom domain step runs right before it), no
#              previous host of a change still on the route, no removal left unfinished
#   release    azure_post_<env> done release, the Easy Auth state read (not unknown), no delivery
#              raced the re-apply (release reapplied-raced), the ingress not waiting for Front Door
#              to serve the domain. A restart to repeat after the settle time
#              (restarted tag-after-settle) counts as finished: the plan's pending-restart dependency
#              repeats it, in the maintenance window (ADR-0048 section 7, amended 2026-11-11), so a
#              daytime run of another app never restarts this one
#   entra      its Entra plan (prov_entra_dir: units/entra, or entra_plan when its lz ran too) ok
#              without a missing or outdated kvset job; the stage entra ok when it
#              planned a change; no custom domain removed in this run (the next plan drops its
#              host); with the managed Front Door the registration has one redirect host (the end
#              state: the default host, or only the custom one once the ingress is locked); a
#              follow-up's remove-old (secretOld remove, ADR-0060) needs the stage entra ok; never in a
#              run whose network mode change kept the source CAE's host as a second one (ADR-0060)
#   pep        the portal-side endpoint ok (azure_post_<host>/portal)
#   ado        ado_resources and ado_pipelines ok
prov_unit_finished() {
  local slug="$1" e="$2" unit="$3" host="$4" post plan
  post="$(prov_status_path "$SAF_IN/azure_post_$e" "$slug" "$e")"
  # ADR-0056: a delete finished when the stage that ran it lists delete-<unit> (ado: both ADO stages ok).
  if [ "$(prov_unit_action "$slug" "$e" "$unit")" = delete ]; then
    case "$unit" in
      frontdoor) prov_status_done "$post" delete-frontdoor ;;
      pep) prov_status_done "$(prov_status_path "$SAF_IN/azure_post_$host/portal" "$slug" "$e")" delete-pep ;;
      entra) prov_status_done "$(prov_status_path "$SAF_IN/entra" "$slug" "$e")" delete-entra ;;
      ado) prov_status_done "$(prov_status_path "$SAF_IN/ado" "$slug")" delete-ado && prov_status_ok "$(prov_status_path "$SAF_IN/ado_pipelines" "$slug")" ;;
      lz) prov_status_done "$(prov_status_path "$SAF_IN/azure_$e" "$slug" "$e")" delete-lz ;;
      *) return 1 ;;
    esac
    return
  fi
  case "$unit" in
    lz)
      prov_status_ok "$(prov_status_path "$SAF_IN/azure_$e" "$slug" "$e")" && prov_status_done "$post" lz
      ;;
    frontdoor)
      prov_status_done "$post" release && [[ "$(jq -r '.detail.frontDoorPrevious // ""' "$post" 2> /dev/null)" != *" kept" ]] \
        && [ "$(jq -r '.detail.frontDoor // ""' "$post" 2> /dev/null)" != removing ]
      ;;
    release)
      prov_status_done "$post" release \
        && [ "$(jq -r '.detail.easyAuth // ""' "$post" 2> /dev/null)" != unknown ] \
        && [ "$(jq -r '.detail.release // ""' "$post" 2> /dev/null)" != reapplied-raced ] \
        && [ "$(jq -r '.detail.ingress // ""' "$post" 2> /dev/null)" != pending-domain ]
      ;;
    entra)
      plan="$(prov_status_path "$(prov_entra_dir "$slug" "$e")" "$slug" "$e")"
      prov_status_ok "$plan" || return 1
      [[ ! "$(jq -r '.detail.secret // ""' "$plan")" =~ ^job-(missing|outdated)$ ]] || return 1
      if [ "$(jq -r '.detail.entra == "deploy" or .detail.secret == "write" or .detail.secret == "rotate" or .detail.secretOld == "remove"' "$plan")" = true ]; then
        prov_status_ok "$(prov_status_path "$SAF_IN/entra" "$slug" "$e")" || return 1
      fi
      [ "$(jq -r '.detail.frontDoor // ""' "$post" 2> /dev/null)" != removed ] || return 1
      # ADR-0060: a registration that keeps the source CAE's host for a move is not the end state; the
      # next run drops it (or keeps it while the move waits).
      [ -z "$(prov_mode_change "$slug" "$e" fromHost 2> /dev/null)" ] || return 1
      if [ "$(jq -r --arg s "$slug" --arg e "$e" '.apps[$s].environments[$e].entraSingleHost == true' "$SAF_UNITS_JSON")" = true ]; then
        [ "$(jq -r '(.hosts // []) | length' "$(prov_entra_dir "$slug" "$e")/entra-inputs/$slug.$e.json" 2> /dev/null || echo 0)" = 1 ] || return 1
      fi
      ;;
    pep)
      prov_status_ok "$(prov_status_path "$SAF_IN/azure_post_$host/portal" "$slug" "$e")"
      ;;
    ado)
      prov_status_ok "$(prov_status_path "$SAF_IN/ado" "$slug")" && prov_status_ok "$(prov_status_path "$SAF_IN/ado_pipelines" "$slug")"
      ;;
    *) return 1 ;;
  esac
}

# prov_fd_ranges_file <env>: the AzureFrontDoor.Backend IPv4 prefixes that the job plan_<env> resolved
# (`platform provisioning fd-ranges` output, ADR-0010 amended 2026-11-11), read in every run: written
# by that job, read from its artifact by the later stages. No file = not resolved in this run.
prov_fd_ranges_file() {
  if [ "$PROV_STAGE" = "plan_$1" ]; then
    printf '%s/plan_%s/frontdoor/backend-ranges.json' "$SAF_OUT" "$1"
  else
    printf '%s/plan_%s/frontdoor/backend-ranges.json' "$SAF_IN" "$1"
  fi
}

# prov_fd_domain <fd record> <output>: whether Front Door serves the app's custom domain (ADR-0010,
# amended 2026-11-11): {domainValidationState, deploymentStatus} of the customDomains resource the
# record's output customDomainId names (ARM read, this identity's Contributor) -> <output>, for
# `platform provisioning state --fd-domain`. Only for a Succeeded record; no output when it can't be
# read (counts as not serving: the ingress isn't locked for the first time, a locked one stays).
prov_fd_domain() {
  local record="$1" out="$2" id
  rm -f "$out"
  [ -f "$record" ] || return 0
  [ "$(jq -r '.properties.provisioningState // ""' "$record")" = Succeeded ] || return 0
  id="$(jq -r '.properties.outputs.customDomainId.value // ""' "$record")"
  if [[ ! "$id" =~ ^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-A-Za-z0-9._()]{1,90}/providers/Microsoft\.Cdn/profiles/[-A-Za-z0-9]{1,260}/customDomains/[-A-Za-z0-9]{1,260}$ ]]; then
    printf '##vso[task.logissue type=warning]%s\n' "the record of the custom domain of $slug in $env_name has no valid output customDomainId; its ingress is not locked for the first time in this run"
    return 0
  fi
  if ! az resource show --ids "$id" --query '{domainValidationState: properties.domainValidationState, deploymentStatus: properties.deploymentStatus}' \
      --output json --only-show-errors > "$out.tmp" 2> "$PROV_DIR/fd-domain.err"; then
    saf_neutralise < "$PROV_DIR/fd-domain.err" | tail -n 10
    printf '##vso[task.logissue type=warning]%s\n' "could not read the custom domain of $slug in $env_name; its ingress is not locked for the first time in this run"
    rm -f "$out.tmp"
    return 0
  fi
  mv "$out.tmp" "$out"
  saf_info "  Front Door custom domain: validation $(jq -r '.domainValidationState // "unknown"' "$out" | saf_neutralise), deployment $(jq -r '.deploymentStatus // "unknown"' "$out" | saf_neutralise)"
}

# ---------------------------------------------------------------------------------------------
# Azure (AzureCLI@2 with sc-platform-provisioning-<env>)
# ---------------------------------------------------------------------------------------------

# prov_env_values: instance.yaml values of SAF_ENV_NAME. Sets env_name, env_kind, subscription,
# region, prefix, env_promote_from.
prov_env_values() {
  env_name="$SAF_ENV_NAME"
  prov_valid_env "$env_name" || saf_die "SAF_ENV_NAME has an invalid shape"
  saf_cli pipeline instance-env --instance "$SAF_INSTANCE" --env "$env_name" --output "$SAF_WORK/env.json"
  subscription="$(jq -er '.subscriptionId' "$SAF_WORK/env.json")"
  region="$(jq -er '.region' "$SAF_WORK/env.json")"
  prefix="$(jq -er '.prefix' "$SAF_WORK/env.json")"
  env_kind="$(jq -er '.kind' "$SAF_WORK/env.json")"
  env_promote_from="$(jq -r '.promoteFrom // ""' "$SAF_WORK/env.json")"
}

# prov_login_check <service connection>: SAF_SERVICE_CONNECTION is that connection, and az is
# logged in to the subscription of env_name.
prov_login_check() {
  local current
  [ "$SAF_SERVICE_CONNECTION" = "$1" ] \
    || saf_die "SAF_SERVICE_CONNECTION is not $1 (template bug)"
  current="$(az account show --query id --output tsv --only-show-errors)"
  [ "${current,,}" = "${subscription,,}" ] \
    || saf_die "the service connection is logged in to a different subscription than instance.yaml names for $env_name"
}

# prov_environment: the Azure stages of one environment (sc-platform-provisioning-<env>);
# SAF_PROMOTE_FROM must equal the environment's promoteFrom.
prov_environment() {
  prov_env_values
  [ "$env_promote_from" = "${SAF_PROMOTE_FROM:-}" ] \
    || saf_die "promoteFrom of $env_name in instance.yaml differs from the pipeline's environment list"
  prov_login_check "sc-platform-provisioning-$env_name"
}

# prov_portal_host: instance.yaml portal.hostEnvironment (validated environment name), read with the
# CLI's validated instance loader.
prov_portal_host() {
  local host
  host="$(node -e '
    import(process.argv[1]).then((m) => {
      const h = m.loadInstanceFile(process.argv[2]).portal?.hostEnvironment;
      process.stdout.write(typeof h === "string" ? h : "");
    }).catch(() => process.exit(1));' \
    "$SAF_CORE/tools/platform-cli/dist/src/provisioning/model.js" "$SAF_INSTANCE")"
  prov_valid_env "$host" || { echo "instance.yaml has no valid portal.hostEnvironment" >&2; return 1; }
  printf '%s' "$host"
}

# prov_host_environment <service connection>: the Entra stages (ADR-0033). SAF_ENV_NAME must be
# instance.yaml portal.hostEnvironment, whose subscription holds the Entra groups (rg-{prefix}-entra-{env},
# rg-{prefix}-entra; ADR-0063).
prov_host_environment() {
  local host
  prov_env_values
  host="$(prov_portal_host)"
  [ "$host" = "$env_name" ] || saf_die "SAF_ENV_NAME is not instance.yaml portal.hostEnvironment"
  prov_login_check "$1"
}

# prov_vault_inputs <env>: {vaultGeneration, externalOnlyNetwork} of env in instance.yaml, schema
# defaults applied (the CLI's environmentVaultInputs, the same values `inputs --step lz` hands the
# landing zone): what names.bicep needs to name the environment vault of a mode (ADR-0060). Read with
# the CLI's validated instance loader once per environment and stage (SAF_WORK; atomic, units run in
# parallel).
prov_vault_inputs() {
  local env="$1" file="$SAF_WORK/vault-inputs-$1.json" tmp
  prov_valid_env "$env" || { echo "prov_vault_inputs: invalid environment" >&2; return 1; }
  if [ ! -f "$file" ]; then
    tmp="$(mktemp "$file.XXXXXXXX")"
    node -e '
      import(process.argv[1]).then((m) => {
        const inst = m.loadInstanceFile(process.argv[2]);
        process.stdout.write(JSON.stringify(m.environmentVaultInputs(m.instanceEnv(inst, process.argv[3]))));
      }).catch(() => process.exit(1));' \
      "$SAF_CORE/tools/platform-cli/dist/src/provisioning/model.js" "$SAF_INSTANCE" "$env" > "$tmp" \
      || { rm -f "$tmp"; echo "could not read the environment vault inputs of $env from instance.yaml" >&2; return 1; }
    jq -e '(.vaultGeneration | type == "number" and . >= 0 and . == floor) and (.externalOnlyNetwork == "managed" or .externalOnlyNetwork == "vnet")' \
      "$tmp" > /dev/null || { rm -f "$tmp"; echo "instance.yaml gave no valid environment vault inputs for $env" >&2; return 1; }
    mv -f "$tmp" "$file"
  fi
  jq -c . "$file"
}

# prov_names <slug> <output> [env] [network mode] [portal env] [vault] [cell]: names.bicep evaluated offline
# with `bicep snapshot` (generation null: resource group, deployments, Container App) for env (default
# env_name). With a network mode (externalOnly | externalHybrid) and a capacity cell (ADR-0053), also
# the CAE of that mode and cell and its kvset and dbinit jobs (outputs managedEnvironment, kvsetJob,
# dbinitJob). The cell: the argument (01 to 99), `none` for none (those three stay null: a caller that
# needs only the vault), or by default the app's own cell in env (prov_app_cell). With the mode and,
# when env is env_name, the environment
# vault of that mode as the landing zone names it (environmentVault, with prov_vault_inputs; ADR-0060;
# its name depends on the subscription, and the snapshot runs with env_name's); the key networkMode is
# passed only with a mode, vaultGeneration and externalOnlyNetwork only for env_name. With
# portal.hostEnvironment, also the portal resource group (portalResourceGroup); with the app vault's
# name, its portal-side endpoint (portalVaultEndpoint; ADR-0025). With the app's incarnation from
# plan/apps.json (prov_app_incarnation, ADR-0061), also the Entra application's uniqueName
# (entraApplicationUniqueName; null for a slug apps.json doesn't list, so prov_name fails on it rather
# than name another incarnation's registration). With a generation (an integer, app.yaml's from the
# landing-zone inputs), also the app vault (appVault; prov_vault_clash, ADR-0064) and the registry;
# without, generation is null. Every name comes from naming.bicep.
# `bicep snapshot` writes <file>.snapshot.json next to its parameter file, so each call snapshots its
# own copy of names.bicepparam in the same folder (its `using` path stays valid): units running at
# the same time never share the output file (ADR-0046).
prov_names() {
  local param snapshot mode="${4:-}" host="${5:-}" vault="${6:-}" cell="${7:-}" generation="${8:-}" vault_inputs='{}' incarnation
  [ -z "$generation" ] || [[ "$generation" =~ ^(0|[1-9][0-9]{0,8})$ ]] || saf_die "prov_names: invalid generation"
  case "$mode" in
    ''|externalOnly|externalHybrid) ;;
    *) saf_die "prov_names: invalid network mode" ;;
  esac
  if [ -z "$mode" ] || [ "$cell" = none ]; then
    cell=""
  elif [ -z "$cell" ]; then
    cell="$(prov_app_cell "$1" "${3:-$env_name}")" || saf_die "prov_names: no valid cell"
  fi
  [ -z "$cell" ] || prov_valid_cell "$cell" || saf_die "prov_names: invalid cell"
  [ -z "$host" ] || prov_valid_env "$host" || saf_die "prov_names: invalid portal environment"
  [ -z "$vault" ] || prov_valid_vault "$vault" || saf_die "prov_names: invalid vault name"
  incarnation="$(prov_app_incarnation "$1")" || saf_die "prov_names: no valid incarnation"
  if [ -n "$mode" ] && [ "${3:-$env_name}" = "$env_name" ]; then
    vault_inputs="$(prov_vault_inputs "$env_name")" || saf_die "prov_names: no environment vault inputs"
  fi
  param="$(mktemp --suffix=.bicepparam "${prov_names_param%.bicepparam}.XXXXXXXX")"
  snapshot="${param%.bicepparam}.snapshot.json"
  cp "$prov_names_param" "$param"
  if ! SAF_NAMES_JSON="$(jq -nc --arg p "$prefix" --arg s "$1" --arg e "${3:-$env_name}" --arg m "$mode" --arg h "$host" --arg v "$vault" \
        --argjson vi "$vault_inputs" --arg i "$incarnation" --arg c "$cell" --arg g "$generation" \
        '{prefix: $p, slug: $s, environmentName: $e, generation: (if $g == "" then null else ($g | tonumber) end)} + (if $m == "" then {} else {networkMode: $m} + $vi end)
          + (if $c == "" then {} else {cell: $c} end)
          + (if $h == "" then {} else {portalEnvironmentName: $h} end) + (if $v == "" then {} else {vaultName: $v} end)
          + (if $i == "" then {} else {incarnation: ($i | tonumber)} end)')" \
      bicep snapshot "$param" --subscription-id "$subscription" --location "$region" > "$PROV_DIR/snapshot.log" 2>&1; then
    rm -f "$param" "$snapshot"
    saf_neutralise < "$PROV_DIR/snapshot.log" | tail -n 20
    saf_die "bicep snapshot of names.bicepparam failed"
  fi
  rm -f "$param"
  mv "$snapshot" "$2"
}

# prov_name <names file> <output name>
prov_name() {
  jq -er --arg n "$2" '.outputs[$n] // empty' "$1" || { echo "names.bicep has no output $2" >&2; return 1; }
}

# prov_record <sub|group> <deployment> <resource group or ''> <output>: the deployment record
# (raw `az deployment ... show`), or no output file when there is none.
prov_record() {
  local scope="$1" name="$2" rg="$3" out="$4" err="$PROV_DIR/record.err" rc
  rm -f "$out"
  set +e
  if [ "$scope" = sub ]; then
    az deployment sub show --name "$name" --output json --only-show-errors > "$out.tmp" 2> "$err"
  else
    az deployment group show --resource-group "$rg" --name "$name" --output json --only-show-errors > "$out.tmp" 2> "$err"
  fi
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    mv "$out.tmp" "$out"
    return 0
  fi
  rm -f "$out.tmp"
  if grep -Eq 'DeploymentNotFound|ResourceGroupNotFound' "$err"; then
    return 0
  fi
  saf_neutralise < "$err" | tail -n 20
  saf_die "could not read the deployment record $name"
}

# prov_arm_get <url> <output> <stderr file>: one GET through `az rest`, tried again when ARM answers with
# throttling or a transient server error (HTTP 429, 500, 502, 503, 504: `az rest` writes the status
# text before the body, e.g. "Internal Server Error({...})"), at most PROV_ARM_TRIES times with a
# growing pause of PROV_ARM_PAUSE seconds per try. Any other error ends it at once. Sandbox run 3426:
# one HTTP 500 on the Container Apps list left nine apps of an environment unplanned.
PROV_ARM_TRIES="${PROV_ARM_TRIES:-4}"
PROV_ARM_PAUSE="${PROV_ARM_PAUSE:-5}"
prov_arm_get() {
  local url="$1" out="$2" err="$3" try=1
  while :; do
    if az rest --method get --url "$url" --output json --only-show-errors > "$out" 2> "$err"; then
      return 0
    fi
    if [ "$try" -ge "$PROV_ARM_TRIES" ] \
        || ! grep -Eq '(Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)\(' "$err"; then
      return 1
    fi
    echo "  ARM answered with a transient error ($(grep -Eo '(Too Many Requests|Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout)' "$err" | head -n 1)); trying again in $((PROV_ARM_PAUSE * try)) s" >&2
    sleep $((PROV_ARM_PAUSE * try))
    try=$((try + 1))
  done
}

# prov_arm_list <ARM path?api-version=...> <output>: every item of an ARM list (`value` of each page,
# following nextLink) -> <output> (a JSON array). One `az rest` GET per page: the plan's lists
# (ADR-0050). A next page must stay on this cloud's ARM endpoint and under the same path; at most
# PROV_ARM_PAGES pages. On any failure: no output, the error through saf_neutralise, return 1.
# TODO(verify) UNIT-7: the page sizes of the lists the plan reads (Container Apps, jobs, vault secrets,
# custom domains, revisions), which set the number of calls per list.
PROV_ARM_PAGES=200
PROV_ARM_HOST=""
prov_arm_list() {
  local url="$1" out="$2" path page="$2.page" err="$2.err" n=0 arm
  rm -f "$out"
  [[ "$url" =~ ^/subscriptions/[0-9a-fA-F-]{36}/[-A-Za-z0-9._()/]+\?api-version=[0-9]{4}-[0-9]{2}-[0-9]{2}(-preview)?$ ]] \
    || { echo "prov_arm_list: invalid ARM path" >&2; return 1; }
  path="${url%%\?*}"
  if [ -z "$PROV_ARM_HOST" ]; then
    arm="$(az cloud show --query endpoints.resourceManager --output tsv --only-show-errors 2> "$err")" \
      || { saf_neutralise < "$err" | tail -n 10; return 1; }
    arm="${arm#https://}"
    PROV_ARM_HOST="${arm%%/*}"
  fi
  printf '[]\n' > "$out.tmp"
  while [ -n "$url" ]; do
    n=$((n + 1))
    if [ "$n" -gt "$PROV_ARM_PAGES" ]; then
      echo "the list $path has more than $PROV_ARM_PAGES pages" >&2
      rm -f "$out.tmp" "$page"
      return 1
    fi
    if ! prov_arm_get "$url" "$page" "$err" \
        || ! jq -e '(.value // []) | type == "array"' "$page" > /dev/null 2>&1; then
      saf_neutralise < "$err" | tail -n 10
      rm -f "$out.tmp" "$page"
      return 1
    fi
    jq -s '.[0] + (.[1].value // [])' "$out.tmp" "$page" > "$out.next"
    mv "$out.next" "$out.tmp"
    url="$(jq -r '.nextLink // ""' "$page")"
    if [ -n "$url" ] && { [[ ! "${url,,}" =~ ^https://${PROV_ARM_HOST,,}(:443)?/ ]] || [[ "${url,,}" != *"${path,,}?"* ]]; }; then
      echo "the list $path names an unexpected next page" >&2
      rm -f "$out.tmp" "$page"
      return 1
    fi
  done
  rm -f "$page"
  mv "$out.tmp" "$out"
}

# prov_valid_vault <name>: the shape of a Key Vault name.
prov_valid_vault() { [[ "$1" =~ ^[A-Za-z][A-Za-z0-9-]{1,22}[A-Za-z0-9]$ ]]; }

# prov_valid_container_app_id <ID> <subscription path>: whether <ID> is a Container App's ARM ID in
# that subscription (/subscriptions/<id>). Case-insensitive, as ARM resource IDs are: ARM's list of
# Container Apps answers .../providers/Microsoft.App/containerapps/... (lowercase "apps") where
# templates write containerApps (sandbox runs 3396 to 3412: the plan refused the ID it had read and
# an app failed its plan every run). The caller still uses the ID as ARM gave it.
prov_valid_container_app_id() {
  local id="${1,,}"
  [[ "$id" =~ ^/subscriptions/[0-9a-f-]{36}/resourcegroups/[-a-z0-9._()]{1,90}/providers/microsoft\.app/containerapps/[a-z0-9-]{2,32}$ ]] \
    && [[ "$id" == "${2,,}/"* ]]
}

# prov_mode_vaults <plan-names file> <any app slug of the plan> <output>: the environment vault of each
# network mode env_name offers (ADR-0060) -> <output> { <mode>: <vault> }. names.bicep (prov_names:
# `bicep snapshot`, offline, no Azure call) once per vault variant `plan-names` lists (vaultVariants: at
# most two per environment, never one per app), with a mode of that variant and any app slug of the
# plan (a vault's name doesn't depend on the app). The vaults are the environment's own, named with its
# subscription and platform resource group: environments that share a subscription never list each
# other's (sandbox runs 3396 to 3412). Globals: env_name, prefix, subscription, region.
prov_mode_vaults() {
  local plan_names="$1" any="$2" out="$3" variant mode modes vault m
  local PROV_DIR="$SAF_WORK/mode-vaults"
  prov_valid_slug "$any" || saf_die "prov_mode_vaults: invalid slug"
  rm -rf "$PROV_DIR"
  mkdir -p "$PROV_DIR"
  printf '{}\n' > "$out.tmp"
  while IFS=$'\t' read -r variant mode modes; do
    [[ "$variant" =~ ^(public|private)$ ]] || saf_die "plan-names lists an invalid vault variant"
    case "$mode" in
      externalOnly | externalHybrid) ;;
      *) saf_die "plan-names lists an invalid network mode" ;;
    esac
    prov_names "$any" "$PROV_DIR/names-$variant.json" "$env_name" "$mode" "" "" none
    vault="$(jq -r '.outputs.environmentVault // ""' "$PROV_DIR/names-$variant.json")"
    prov_valid_vault "$vault" || saf_die "names.bicep names no environment vault for $mode in $env_name"
    for m in $modes; do
      case "$m" in
        externalOnly | externalHybrid) ;;
        *) saf_die "plan-names lists an invalid network mode" ;;
      esac
      jq --arg m "$m" --arg v "$vault" '. + {($m): $v}' "$out.tmp" > "$out.next"
      mv "$out.next" "$out.tmp"
    done
  done < <(jq -r '(.vaultVariants // [])[] | [.variant, .mode, ((.modes // []) | join(" "))] | @tsv' "$plan_names")
  mv "$out.tmp" "$out"
}

# prov_secret_state <dir>: present | absent: whether the Easy Auth secret easyauth-{slug} exists in
# the environment vault of the app's network mode in app.yaml (names.bicep output environmentVault,
# named as the landing zone names it: the vault this run's landing zone uses). In the steady state
# that is the vault the lz record names (output environmentKeyVaultName); after a network mode change
# to the other vault variant, or a new vaultGeneration, the record still names the old vault, whose
# secret is no use to the app in its new mode (ADR-0060; `provisioning state` then doesn't carry the
# record's flag either). Absent without a record, and absent for a record whose provisioningState
# isn't Succeeded: the landing zone deploys again in this run (compare treats it as not up to date),
# and the second pass reads the secret again. A first pass without the secret only leaves out the
# Easy Auth identity's role on it, which the second pass deploys (an incremental deployment removes
# no role). Sandbox runs 3396 to 3412: a landing zone that failed once (SkuNotAvailable) then failed
# here in every run, before its deployment was tried again. Globals: slug, env_name.
prov_secret_state() {
  local dir="$1" vault mode vault_names
  if [ ! -f "$dir/lz-record.json" ]; then
    printf absent
    return 0
  fi
  if [ "$(jq -r '.properties.provisioningState // ""' "$dir/lz-record.json")" != Succeeded ]; then
    printf absent
    return 0
  fi
  mode="$(prov_app_network_mode "$slug" "$env_name")" || return 1
  vault_names="$PROV_DIR/names-$mode.json"
  [ -f "$vault_names" ] || prov_names "$slug" "$vault_names" "$env_name" "$mode"
  vault="$(jq -r '.outputs.environmentVault // ""' "$vault_names")"
  prov_valid_vault "$vault" \
    || { echo "names.bicep names no environment vault for $slug in $env_name ($mode)" >&2; return 1; }
  prov_secret_exists "$vault"
}

# jq definition `epoch`: epoch seconds between 2000 and 2100 from a number or an RFC 3339 string in
# UTC (Key Vault attributes, revision createdTime); anything else null.
PROV_JQ_EPOCH='def epoch: if type == "number" and . > 946684800 and . < 4102444800 then floor
  elif type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|\\+00:00)$")
    then (sub("\\.[0-9]+"; "") | sub("\\+00:00$"; "Z") | fromdateiso8601)
  else null end;'

# prov_secret_meta <vault> <output>: the Easy Auth secret easyauth-{slug} in that environment vault (in
# the environment's platform resource group) -> {state: present|absent, created, expires}. An ARM GET
# of Microsoft.KeyVault/vaults/secrets: control plane, metadata only, never the value, and it works for
# the private vault too. created and expires are the current version's attributes created and exp in
# epoch seconds (null when absent or not recorded; exp is the password's end, set by the kvset job,
# ADR-0035), which entra_plan reads for the rotation (ADR-0041). Globals: names.
# Verify in sandbox: KV-9 (also that ARM shows the current version's created and exp).
prov_secret_meta() {
  local vault="$1" out="$2" platform_rg secret err="$PROV_DIR/secret.err" raw="$PROV_DIR/secret-meta.raw" rc
  prov_valid_vault "$vault" || { echo "prov_secret_meta: invalid vault name" >&2; return 1; }
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  secret="$(prov_name "$names" easyAuthSecret)"
  set +e
  az resource show --resource-group "$platform_rg" --namespace Microsoft.KeyVault --parent "vaults/$vault" \
    --resource-type secrets --name "$secret" \
    --query '{created: properties.attributes.created, expires: properties.attributes.exp}' \
    --output json --only-show-errors > "$raw" 2> "$err"
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    jq "$PROV_JQ_EPOCH"' {state: "present", created: (.created | epoch), expires: (.expires | epoch)}' "$raw" > "$out"
    return 0
  fi
  if grep -Eq 'ResourceNotFound|SecretNotFound' "$err"; then
    jq -n '{state: "absent", created: null, expires: null}' > "$out"
    return 0
  fi
  saf_neutralise < "$err" | tail -n 10 >&2
  echo "could not read the Easy Auth secret's metadata in the environment vault" >&2
  return 1
}

# prov_secret_exists <vault>: present | absent (prov_secret_meta). Globals: names.
prov_secret_exists() {
  prov_secret_meta "$1" "$PROV_DIR/secret-meta.json"
  jq -r '.state' "$PROV_DIR/secret-meta.json"
}

# PROV_EASYAUTH_SETTLE_S: how long after a new version of an app's Easy Auth secret a starting replica
# is assumed to get it (ADR-0041). Container Apps refreshes a versionless Key Vault reference
# periodically, so a replica that starts sooner may still get the previous value. A revision counts
# as started with a version only when it was created at least this long after it, and azure_post sets
# the tag saf-easyauth after a restart only once this long has passed since the version was written.
# Verify in sandbox: ENT-7, ROT-1 (the refresh interval, documented as up to 30 minutes; whether a new
# revision or a restarted replica gets the new value sooner).
PROV_EASYAUTH_SETTLE_S=1800

# prov_easyauth_app <Container App ID> <vault version created | none> <output>: what the app's
# active revisions run with (ADR-0041) -> {exists, readable, tag, image, revisions: [{name, created}],
# allAfter}. tag is the Container App's tag saf-easyauth (the created time of the secret version its
# revisions are known to run with, written by azure_post; a release deployment replaces the app's tags
# and drops it); revisions are the active ones (properties.active, every page through nextLink) with
# createdTime in epoch seconds; allAfter is true when there is at least one and every one was created
# at least PROV_EASYAUTH_SETTLE_S after the version (it started with that version or a newer one).
# No app -> {exists: false, readable: true}. A read that fails (a transient error, an unexpected
# answer) -> a warning and {exists: true, readable: false}: the caller treats the app as not known to
# run with the version (no password is removed, nothing is restarted or tagged), never as failed.
# Verify in sandbox: ROT-1 (a revision created after the settle time reads the new version).
prov_easyauth_app() {
  local app_id="$1" created="$2" out="$3" err="$PROV_DIR/easyauth-app.err" page="$PROV_DIR/revisions-page.json"
  local list="$PROV_DIR/revisions.json" url arm host n=0 rc
  set +e
  az resource show --ids "$app_id" --query '{tag: tags."saf-easyauth", image: properties.template.containers[0].image}' \
    --output json --only-show-errors > "$PROV_DIR/easyauth-app.raw" 2> "$err"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      jq -n '{exists: false, readable: true}' > "$out"
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10
    prov_easyauth_unreadable "$out" "the Container App could not be read"
    return 0
  fi
  if ! arm="$(az cloud show --query endpoints.resourceManager --output tsv --only-show-errors 2> "$err")"; then
    saf_neutralise < "$err" | tail -n 10
    prov_easyauth_unreadable "$out" "az cloud show failed"
    return 0
  fi
  host="${arm#https://}"
  host="${host%%/*}"
  printf '[]\n' > "$list"
  url="$app_id/revisions?api-version=2024-03-01"
  while [ -n "$url" ]; do
    n=$((n + 1))
    if [ "$n" -gt 20 ]; then
      prov_easyauth_unreadable "$out" "the revision list has more than 20 pages"
      return 0
    fi
    if ! az rest --method get --url "$url" --output json --only-show-errors > "$page" 2> "$err"; then
      saf_neutralise < "$err" | tail -n 10
      prov_easyauth_unreadable "$out" "the revision list could not be read"
      return 0
    fi
    jq -s "$PROV_JQ_EPOCH"' .[0] + [.[1].value[]? | select(.properties.active == true)
      | {name: .name, created: (.properties.createdTime | epoch)}]' "$list" "$page" > "$list.tmp"
    mv "$list.tmp" "$list"
    url="$(jq -r '.nextLink // ""' "$page")"
    # A next page stays on this cloud's ARM endpoint and on this app's revisions.
    if [ -n "$url" ] && { [[ ! "${url,,}" =~ ^https://${host,,}(:443)?/ ]] || [[ "${url,,}" != *"${app_id,,}/revisions?"* ]]; }; then
      prov_easyauth_unreadable "$out" "the revision list names an unexpected next page"
      return 0
    fi
  done
  jq --slurpfile r "$list" --arg c "$created" --argjson m "$PROV_EASYAUTH_SETTLE_S" \
    '{exists: true, readable: true, tag: ((.tag // "") | tostring), image: (.image // ""), revisions: $r[0],
      allAfter: ($c != "none" and ($r[0] | length) > 0 and all($r[0][]; .created != null and .created >= ($c | tonumber) + $m))}' \
    "$PROV_DIR/easyauth-app.raw" > "$out"
}

# prov_easyauth_unreadable <output> <why>: prov_easyauth_app could not read the app (a warning; why is
# fixed text).
prov_easyauth_unreadable() {
  printf '##vso[task.logissue type=warning]%s\n' "$slug in ${env_name:-?}: Easy Auth: $2; the app counts as not known to run with its secret's current version (no password removed, no restart) until a run can read it"
  jq -n '{exists: true, readable: false}' > "$1"
}

# prov_easyauth_loaded <prov_easyauth_app output> <vault version created | none>: the created time of
# the secret version the app's active revisions are known to run with, or none: the version's own when
# every active revision started at least PROV_EASYAUTH_SETTLE_S after it, else the tag saf-easyauth
# when it holds epoch seconds; none when the app couldn't be read.
prov_easyauth_loaded() {
  local loaded
  loaded="$(jq -r --arg c "$2" 'if .exists != true or .readable != true then "none"
    elif .allAfter == true then $c
    elif (.tag | test("^[0-9]{9,10}$")) then .tag
    else "none" end' "$1")"
  [[ "$loaded" =~ ^([0-9]{9,10}|none)$ ]] || { echo "prov_easyauth_loaded: unexpected value" >&2; return 1; }
  printf '%s' "$loaded"
}

# prov_secret_entry <entry file> <env>: reads and checks the Easy Auth secret entry of the current
# app in env (ADR-0035, ADR-0041; written by azure_<env> as secret/{slug}.{env}.json: {state, vault,
# job, jobReady, created, expires, loaded}). state present | absent; vault a Key Vault name; job a
# Container Apps job in the platform resource group of env (names.bicep) in env's subscription
# (instance.yaml); created, expires and loaded (the version the app runs with, prov_easyauth_loaded)
# epoch seconds or null (always null when absent). Sets secret_state, secret_vault, secret_job,
# secret_job_ready, secret_created, secret_expires and secret_loaded (epoch seconds or none).
# Globals: slug, names (names.bicep of env).
prov_secret_entry() {
  local file="$1" env="$2" sub job_prefix kvset
  [ -f "$file" ] || saf_die "no Easy Auth secret entry for $slug in $env"
  secret_state="$(jq -r '.state // ""' "$file")"
  secret_vault="$(jq -r '.vault // ""' "$file")"
  secret_job="$(jq -r '.job // ""' "$file")"
  secret_job_ready="$(jq -r 'if (.jobReady | type) == "boolean" then .jobReady else "" end' "$file")"
  secret_created="$(jq -r 'if (.created | type) == "number" then (.created | floor | tostring) elif .created == null then "none" else "" end' "$file")"
  secret_expires="$(jq -r 'if (.expires | type) == "number" then (.expires | floor | tostring) elif .expires == null then "none" else "" end' "$file")"
  secret_loaded="$(jq -r 'if (.loaded | type) == "number" then (.loaded | floor | tostring) elif .loaded == null then "none" else "" end' "$file")"
  case "$secret_state" in
    present|absent) ;;
    *) saf_die "the Easy Auth secret entry of $slug in $env has no valid state" ;;
  esac
  case "$secret_job_ready" in
    true|false) ;;
    *) saf_die "the Easy Auth secret entry of $slug in $env has no valid jobReady" ;;
  esac
  if [[ ! "$secret_created" =~ ^([0-9]{9,10}|none)$ ]] || [[ ! "$secret_expires" =~ ^([0-9]{9,10}|none)$ ]] \
      || [[ ! "$secret_loaded" =~ ^([0-9]{9,10}|none)$ ]]; then
    saf_die "the Easy Auth secret entry of $slug in $env has no valid created, expires or loaded"
  fi
  if [ "$secret_state" = absent ] && [ "$secret_created$secret_expires$secret_loaded" != nonenonenone ]; then
    saf_die "the Easy Auth secret entry of $slug in $env has times for an absent secret"
  fi
  prov_valid_vault "$secret_vault" || saf_die "the Easy Auth secret entry of $slug in $env has no valid vault"
  saf_cli pipeline instance-env --instance "$SAF_INSTANCE" --env "$env" --output "$PROV_DIR/env-$env.json"
  sub="$(jq -r '.subscriptionId // ""' "$PROV_DIR/env-$env.json")"
  prov_valid_guid "$sub" || saf_die "instance.yaml has no valid subscriptionId for $env"
  job_prefix="/subscriptions/$sub/resourceGroups/$(prov_name "$names" platformResourceGroup)/providers/Microsoft.App/jobs/"
  if [[ "$secret_job" != "$job_prefix"* ]] || [[ ! "${secret_job#"$job_prefix"}" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]]; then
    saf_die "the Easy Auth secret entry of $slug in $env names no Container Apps job in the platform resource group of $env"
  fi
  # Exactly the kvset job of the app's CAE by naming (names.bicep with the app's network mode from
  # app.yaml), never a job the entry names alone: its PATCH replaces the job's whole secret list
  # (ADR-0052).
  kvset="$(jq -r '.outputs.kvsetJob // ""' "$names")"
  [[ "$kvset" =~ ^[a-z][a-z0-9-]{0,30}[a-z0-9]$ ]] || saf_die "names.bicep names no kvset job for $slug in $env (prov_names without the app's network mode)"
  [ "$secret_job" = "$job_prefix$kvset" ] \
    || saf_die "the Easy Auth secret entry of $slug in $env names another job than the kvset job of the app's CAE ($kvset)"
}

# prov_write_secret_entry <lz outputs> <output> <network mode>: the Easy Auth secret entry of the
# current app (ADR-0035, ADR-0041) -> {state: present|absent, vault, job, jobReady, jobState, created,
# expires, loaded}: whether easyauth-{slug} exists in the environment vault of the app's network mode
# (names.bicep environmentVault, ADR-0060; it must equal the landing zone's output
# environmentKeyVaultName, which this stage just deployed), with its current version's created and
# exp (ARM GET, metadata only, epoch seconds); for a present secret, the version the app's active
# revisions are known to run with (prov_easyauth_loaded); the ARM ID of the kvset job of the app's CAE (subscription from
# instance.yaml, platformResourceGroup and kvsetJob from names.bicep with the app's network mode),
# whether that job exists and runs the saf-jobs digest core pins (jobState missing|outdated|current,
# rule P23; jobReady = current). Detail secret present|absent. Written by plan_<env> for every app
# with sign-in and a landing zone, and again by azure_<env> after it deployed one (the vault may
# change). Globals: slug, env_name, subscription, names.
prov_write_secret_entry() {
  local lz_outputs="$1" file="$2" mode="$3" vault job_names platform_rg job job_id job_state state ready created loaded=none app_id
  local meta="$PROV_DIR/secret-meta.json"
  case "$mode" in
    externalOnly|externalHybrid) ;;
    *) saf_die "the landing zone of $slug in $env_name has no valid networkMode" ;;
  esac
  job_names="$PROV_DIR/names-$mode.json"
  [ -f "$job_names" ] || prov_names "$slug" "$job_names" "$env_name" "$mode"
  vault="$(jq -r '.outputs.environmentVault // ""' "$job_names")"
  prov_valid_vault "$vault" || saf_die "names.bicep names no environment vault for $slug in $env_name ($mode)"
  # The landing zone of this mode uses the same vault, or names.bicep and landing-zone.bicep drifted.
  [ "$vault" = "$(jq -r '.environmentKeyVaultName.value // ""' "$lz_outputs")" ] \
    || saf_die "the landing zone of $slug in $env_name uses another environment vault than names.bicep names for $mode"
  platform_rg="$(prov_name "$job_names" platformResourceGroup)"
  job="$(prov_name "$job_names" kvsetJob)"
  job_id="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.App/jobs/$job"
  prov_secret_meta "$vault" "$meta"
  state="$(jq -r '.state' "$meta")"
  # A missing secret and a rotation are written by that job: entra_plan plans either only once the
  # job exists (pass 2 of environment.bicep) and runs the saf-jobs digest this core pins (rule P23,
  # ADR-0043), so no approval is asked for a write that can't happen.
  job_state="$(prov_job_state "$job_id")"
  ready=false
  [ "$job_state" != current ] || ready=true
  if [ "$state" = present ]; then
    created="$(jq -r '.created // "none" | tostring' "$meta")"
    app_id="/subscriptions/$subscription/resourceGroups/$(prov_name "$names" appResourceGroup)/providers/Microsoft.App/containerApps/$(prov_name "$names" containerApp)"
    prov_easyauth_app "$app_id" "$created" "$PROV_DIR/easyauth-app.json"
    loaded="$(prov_easyauth_loaded "$PROV_DIR/easyauth-app.json" "$created")"
  fi
  mkdir -p "$(dirname "$file")"
  jq -n --arg s "$state" --arg v "$vault" --arg j "$job_id" --argjson r "$ready" --arg js "$job_state" --slurpfile m "$meta" --arg l "$loaded" \
    '{state: $s, vault: $v, job: $j, jobReady: $r, jobState: $js, created: $m[0].created, expires: $m[0].expires,
      loaded: (if $l == "none" then null else ($l | tonumber) end)}' > "$file"
  saf_info "  Easy Auth secret in $vault: $state${created:+ (version created $created, the app runs with: $loaded)}"
  prov_detail secret "$state"
}

# prov_write_frontdoor_entry <artifact dir>: an app that requests a custom domain through Front Door in
# env_name, or whose record fd-{slug}-{env} still exists (a removal not finished, ADR-0010 amended
# 2026-11-11): the backend ranges of plan_<env> must exist for a requested domain (else the app fails:
# nothing is released with a guessed list); the record as it is now -> frontdoor/{slug}.{env}.json and,
# for a Succeeded record, whether Front Door serves the domain (prov_fd_domain) ->
# frontdoor/{slug}.{env}.domain.json. From them entra_plan decides the redirect URIs. Sets
# prov_fd_record_exists (true|false). Globals: slug, env_name, names.
prov_write_frontdoor_entry() {
  local out="$1" host name platform_rg
  prov_fd_record_exists=false
  host="$(prov_app_front_door "$slug" "$env_name")"
  if [ -n "$host" ]; then
    [ -f "$(prov_fd_ranges_file "$env_name")" ] \
      || saf_die "$slug in $env_name is on a custom domain through Front Door, but the AzureFrontDoor.Backend ranges could not be resolved in this run (warning in plan_$env_name); nothing is released with a guessed list"
  fi
  mkdir -p "$out/frontdoor"
  rm -f "$out/frontdoor/$slug.$env_name.json" "$out/frontdoor/$slug.$env_name.domain.json"
  name="$(prov_name "$names" frontDoorDeployment)"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  prov_record group "$name" "$platform_rg" "$PROV_DIR/fd-record.json"
  if [ -f "$PROV_DIR/fd-record.json" ]; then
    prov_fd_record_exists=true
    cp "$PROV_DIR/fd-record.json" "$out/frontdoor/$slug.$env_name.json"
    if [ -n "$host" ]; then
      saf_info "  Front Door: $name $(jq -r '.properties.provisioningState // "unknown"' "$PROV_DIR/fd-record.json" | saf_neutralise); backend ranges resolved"
    else
      saf_info "  Front Door: $name exists, but app.yaml requests no custom domain in $env_name: azure_post_$env_name opens the ingress, then removes it"
    fi
    prov_fd_domain "$PROV_DIR/fd-record.json" "$PROV_DIR/fd-domain.json"
    if [ -f "$PROV_DIR/fd-domain.json" ]; then cp "$PROV_DIR/fd-domain.json" "$out/frontdoor/$slug.$env_name.domain.json"; fi
  elif [ -n "$host" ]; then
    saf_info "  Front Door: no $name yet (azure_post_$env_name deploys it); backend ranges resolved"
  fi
}

# prov_job_state <ARM id>: missing | outdated | current: whether a platform job (the kvset or dbinit
# job of environment.bicep pass 2, ADR-0035, ADR-0028) exists, and whether it runs the saf-jobs
# digest this core pins in images/images.json. A job on another digest belongs to another core
# version: after a core upgrade the provisioning pipeline and the environment's platform pipeline
# run at the same time, and this core's job interface may differ from the old image's, so the step
# that would start the job waits (rule P23) until the platform pipeline has deployed the pinned
# digest (ADR-0043).
prov_job_state() {
  local id="$1" err="$PROV_DIR/job.err" image digest rc
  digest="$(jq -er '.images["saf-jobs"].digest' "$SAF_IMAGES_JSON")" \
    || { echo "images.json has no saf-jobs digest" >&2; return 1; }
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || { echo "images.json has no valid saf-jobs digest" >&2; return 1; }
  set +e
  image="$(az resource show --ids "$id" --query 'properties.template.containers[0].image' --output tsv \
    --only-show-errors 2> "$err")"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      printf missing
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not read the platform job" >&2
    return 1
  fi
  if [[ "$image" == *"@$digest" ]]; then printf current; else printf outdated; fi
}

# prov_secret_urgent: true when the Easy Auth secret of the current secret entry (prov_secret_entry)
# expires within 14 days or has expired. Its rotation can't wait for a later run then, so a kvset
# job that can't write it (missing, or not on this core's saf-jobs image) fails the app instead of
# leaving it `waiting`: sign-in stops when the secret expires (ADR-0043).
prov_secret_urgent() {
  [[ "$secret_expires" =~ ^[0-9]+$ ]] && [ $((secret_expires - $(date -u +%s))) -lt $((14 * 86400)) ]
}

# prov_state <dir> [ado outputs file]: `platform provisioning state` from the files in <dir>
# (lz-record.json, release-record.json, fd-record.json, fd-domain.json, fd-ranges.json,
# entra-outputs.json; absent = none). For an app that requires sign-in, also whether its Easy Auth secret exists (prov_secret_state).
prov_state() {
  local dir="$1" ado="${2:-}" secret
  local -a args=(provisioning state --instance "$SAF_INSTANCE" --app "$app_file" --env "$env_name"
    --core-dir "$SAF_CORE" --today "$(date -u +%F)" --output "$dir/state.json")
  if [ -f "$dir/lz-record.json" ]; then args+=(--lz-record "$dir/lz-record.json"); fi
  if [ -f "$dir/release-record.json" ]; then args+=(--release-record "$dir/release-record.json"); fi
  if [ -f "$dir/fd-record.json" ]; then
    args+=(--fd-record "$dir/fd-record.json")
    if [ -f "$dir/fd-domain.json" ]; then args+=(--fd-domain "$dir/fd-domain.json"); fi
  fi
  if [ -f "$dir/fd-ranges.json" ]; then args+=(--fd-ranges "$dir/fd-ranges.json"); fi
  if [ -f "$dir/entra-outputs.json" ]; then args+=(--entra-outputs "$dir/entra-outputs.json"); fi
  if [ -n "$ado" ]; then args+=(--ado-outputs "$ado"); fi
  if [ "$(prov_app_auth "$slug")" = required ]; then
    secret="$(prov_secret_state "$dir")"
    args+=(--easy-auth-secret "$secret")
  fi
  saf_cli "${args[@]}"
}

# prov_arm <validate|create> <lz|release|entra|frontdoor|portal-endpoint> <inputs json> <deployment> <location | resource group> <output>
# The only `az deployment ... validate|create` calls of provisioning: the landing zone at
# subscription scope through landing-zone.bicepparam (SAF_LZ_JSON), the release in the app
# resource group through release.bicepparam (SAF_RELEASE_JSON), the Entra registration in
# rg-{prefix}-entra-{env} (or rg-{prefix}-entra, ADR-0063) through app-registration.bicepparam (SAF_ENTRA_JSON), the app's custom domain
# through Front Door in the environment's platform resource group through frontdoor.bicepparam
# (SAF_FRONTDOOR_JSON, ADR-0010 amended 2026-11-01), the portal-side private endpoint of an app
# vault in the portal resource group through portal-endpoint.bicepparam (SAF_PORTAL_ENDPOINT_JSON,
# ADR-0025). No other parameters.
# The Entra registration has no validate: its preflight calls Microsoft Graph (prov_entra_expected).
# create retries only when `classify-deploy-error` prints exactly `retry` (RBAC propagation), and an
# Entra registration also on Graph's transient errors right after it creates objects, at most three
# times: Authorization_RequestDenied at service principal creation (ADR-0023), and
# Request_ResourceNotFound / Directory_ObjectNotFound while a new service principal replicates
# (sandbox run 2901: role assignment and sign-in consent of a new registration). The same codes
# also mean "not owner" (ENT-2) or a principal that doesn't exist, which no retry fixes; the bound
# keeps that short.
# A failure that ends here gets its failure code (ADR-0064): `platform provisioning failure-code`
# reads the error log (only error codes seen in the sandbox or documented by Microsoft are mapped; PE001
# otherwise), and a landing zone's failure also asks whether a soft-deleted vault holds the app vault's
# name (prov_vault_clash: PE009, US04.11).
prov_arm() {
  local action="$1" kind="$2" inputs="$3" name="$4" where="$5" out="$6" err="$PROV_DIR/arm.err"
  local attempt=0 rc verdict wait_s code stale_tried=0
  local -a delays=(30 60 120 240) graph_delays=(30 60 120)
  while :; do
    attempt=$((attempt + 1))
    [ "$action" = validate ] || saf_info "Deploying $name (attempt $attempt)"
    set +e
    case "$action/$kind" in
      validate/lz)
        SAF_LZ_JSON="$(cat "$inputs")" az deployment sub validate --name "$name" --location "$where" \
          --parameters "$prov_lz_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create/lz)
        SAF_LZ_JSON="$(cat "$inputs")" az deployment sub create --name "$name" --location "$where" \
          --parameters "$prov_lz_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      validate/release)
        SAF_RELEASE_JSON="$(cat "$inputs")" az deployment group validate --resource-group "$where" --name "$name" \
          --parameters "$prov_release_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create/release)
        SAF_RELEASE_JSON="$(cat "$inputs")" az deployment group create --resource-group "$where" --name "$name" \
          --parameters "$prov_release_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create/entra)
        SAF_ENTRA_JSON="$(cat "$inputs")" az deployment group create --resource-group "$where" --name "$name" \
          --parameters "$prov_entra_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      validate/frontdoor)
        SAF_FRONTDOOR_JSON="$(cat "$inputs")" az deployment group validate --resource-group "$where" --name "$name" \
          --parameters "$prov_frontdoor_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create/frontdoor)
        SAF_FRONTDOOR_JSON="$(cat "$inputs")" az deployment group create --resource-group "$where" --name "$name" \
          --parameters "$prov_frontdoor_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      validate/portal-endpoint)
        SAF_PORTAL_ENDPOINT_JSON="$(cat "$inputs")" az deployment group validate --resource-group "$where" --name "$name" \
          --parameters "$prov_portal_endpoint_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      create/portal-endpoint)
        SAF_PORTAL_ENDPOINT_JSON="$(cat "$inputs")" az deployment group create --resource-group "$where" --name "$name" \
          --parameters "$prov_portal_endpoint_param" --only-show-errors --output json > "$out" 2> "$err"
        ;;
      *) saf_die "prov_arm: unknown action $action/$kind" ;;
    esac
    rc=$?
    set -e
    [ "$rc" -ne 0 ] || return 0
    saf_neutralise < "$err" | tail -n 30
    if [ "$action" = create ]; then
      verdict="$(saf_cli pipeline classify-deploy-error --log "$err" || true)"
      if [ "$verdict" = retry ] && [ "$attempt" -le "${#delays[@]}" ]; then
        # Up to 20 s of jitter: units of a parallel stage that hit the same delay don't retry in step.
        wait_s=$((delays[attempt - 1] + RANDOM % 21))
        saf_info "RBAC propagation delay or a concurrent operation on a shared resource; retrying in $wait_s s."
        sleep "$wait_s"
        continue
      fi
      if [ "$kind" = entra ] && grep -q -E 'Authorization_RequestDenied|Request_ResourceNotFound|Directory_ObjectNotFound' "$err" \
          && [ "$attempt" -le "${#graph_delays[@]}" ]; then
        saf_info "Microsoft Graph refused the request or doesn't see a new object yet; retrying in ${graph_delays[$((attempt - 1))]} s."
        sleep "${graph_delays[$((attempt - 1))]}"
        continue
      fi
    fi
    code="$(saf_cli provisioning failure-code --log "$err" --kind "$kind" 2> /dev/null | head -n 1 || true)"
    # PE010 after the app's resource group was deleted by hand: the deleted identities' role assignments
    # outside the group block the re-created ones. Removed by proof from this app's own record, then
    # one more deployment (ADR-0064 amendment 2026-11-17).
    if [ "$action/$kind" = create/lz ] && [ "$code" = PE010 ] && [ "$stale_tried" = 0 ]; then
      stale_tried=1
      if prov_lz_stale_assignments "$name"; then
        saf_info "Removed the role assignments of the app's deleted identities; deploying again in ${PROV_STALE_WAIT_S:-30} s."
        sleep "${PROV_STALE_WAIT_S:-30}"
        continue
      fi
    fi
    prov_failure "$code"
    if [ "$kind" = lz ]; then prov_vault_clash "$inputs" "$where"; fi
    saf_die "$action of $name failed"
  done
}

# prov_vault_clash <lz inputs> <location>: after the current app's landing zone failed (prov_arm), does a
# soft-deleted vault hold the name of the app vault (US04.11, ADR-0064)? A deleted vault keeps its name
# for its retention period (7 to 90 days), so the landing zone can't create the vault again. The name:
# names.bicep appVault with the inputs' generation (prov_names, offline); then one GET of the deleted vault
# in that location ("Vaults - Get Deleted", Microsoft.KeyVault/locations/deletedVaults/read, which the
# provisioning identity's Contributor holds; Verify in sandbox: NR-10). 200 naming that vault: failure
# code PE009, and the error line tells the platform team what to do (docs/runbooks/key-vault-name-clash.md:
# recover, purge, or raise generation in apps/<slug>/app.yaml). Not found, or the read failed: nothing
# (the deployment's own code stays); this check never fails the unit by itself. Globals: slug, env_name,
# subscription.
prov_vault_clash() {
  local inputs="$1" location="$2" generation vault url
  local names_g="$PROV_DIR/names-vault.json" out="$PROV_DIR/deleted-vault.json" err="$PROV_DIR/deleted-vault.err"
  generation="$(jq -r '.generation // "" | tostring' "$inputs" 2> /dev/null || true)"
  [[ "$generation" =~ ^(0|[1-9][0-9]{0,8})$ ]] && [[ "$location" =~ ^[a-z0-9]+$ ]] || return 0
  ( prov_names "$slug" "$names_g" "$env_name" "" "" "" "" "$generation" ) > /dev/null 2>&1 || {
    saf_info "  Could not name the app vault; whether a deleted vault holds its name is not checked"
    return 0
  }
  vault="$(prov_name "$names_g" appVault 2> /dev/null || true)"
  prov_valid_vault "$vault" || return 0
  url="/subscriptions/$subscription/providers/Microsoft.KeyVault/locations/$location/deletedVaults/$vault?api-version=2023-07-01"
  if ! prov_arm_get "$url" "$out" "$err"; then
    # Not found: no deleted vault holds the name. Anything else: no conclusion, said so.
    grep -Eq 'NotFound|Not Found' "$err" || saf_info "  Could not read whether a deleted vault holds the name $vault"
    return 0
  fi
  jq -e --arg n "$vault" '(.name // "" | ascii_downcase) == ($n | ascii_downcase)' "$out" > /dev/null 2>&1 || return 0
  prov_failure PE009
  # TODO(verify) NR-10: the property names of a deleted vault as ARM returns them (documented: deletionDate,
  # scheduledPurgeDate, purgeProtectionEnabled).
  saf_info "  The vault name $vault is held by a soft-deleted vault: $(jq -r 'def date: if . == null then "unknown" else tostring | gsub("[^0-9TZ:.-]"; "") end;
    (.properties // {}) as $p
    | "deleted \($p.deletionDate | date), purged after \($p.scheduledPurgeDate | date), purge protection "
      + (if $p.purgeProtectionEnabled == true then "true" elif $p.purgeProtectionEnabled == false then "false" else "unknown" end)' "$out")"
  printf '##vso[task.logissue type=error]%s\n' "$slug in $env_name: the name of its vault $vault is held by a soft-deleted vault (code PE009). Recover or purge that vault, or raise generation in apps/$slug/app.yaml when the app is gone in every environment: docs/runbooks/key-vault-name-clash.md"
}

# prov_entra_expected <inputs json> <output>: what a deployment of app-registration.bicepparam with
# these inputs records, in the shape of `az deployment ... validate` output for prov_compare,
# without a preflight. A Graph Bicep preflight calls Microsoft Graph, which the plan's identity
# may not (ADR-0033, ENT-12). The parameters come from `az bicep build-params`; the template hash
# from ARM's calculateTemplateHash (the same hash a deployment records). The template's parameters
# have no defaults, so the built parameters are all of them.
prov_entra_expected() {
  local inputs="$1" out="$2" built="$PROV_DIR/entra-built.json" err="$PROV_DIR/arm.err"
  if ! SAF_ENTRA_JSON="$(cat "$inputs")" az bicep build-params --file "$prov_entra_param" --stdout \
      --only-show-errors > "$built" 2> "$err"; then
    saf_neutralise < "$err" | tail -n 30
    saf_die "bicep build-params of app-registration.bicepparam failed"
  fi
  jq -r '.templateJson' "$built" > "$PROV_DIR/entra-template.json"
  if ! az rest --method post --url "/providers/Microsoft.Resources/calculateTemplateHash?api-version=2021-04-01" \
      --body "@$PROV_DIR/entra-template.json" --only-show-errors --output json > "$PROV_DIR/entra-hash.json" 2> "$err"; then
    saf_neutralise < "$err" | tail -n 30
    saf_die "calculateTemplateHash of app-registration.bicep failed"
  fi
  jq -n --slurpfile h "$PROV_DIR/entra-hash.json" --slurpfile b "$built" \
    '{properties: {templateHash: $h[0].templateHash, parameters: ($b[0].parametersJson | fromjson | .parameters)}}' > "$out"
}

# prov_compare <lz|release|entra|frontdoor|portal-endpoint> <validate output> <record file (may not exist)>: sets prov_verdict to
# up-to-date | new | changed: <reasons> (ADR-0032 decision 5; rules in the CLI).
prov_compare() {
  local -a args=(provisioning compare --kind "$1" --validate "$2")
  if [ -f "$3" ]; then args+=(--record "$3"); fi
  prov_verdict="$(saf_cli "${args[@]}" | head -n 1)"
  case "$prov_verdict" in
    up-to-date|new|changed:*) ;;
    *) saf_die "unexpected output of platform provisioning compare" ;;
  esac
  saf_info "  $1 record: $prov_verdict" | saf_neutralise
}

# prov_lz <dir> <lz outputs file> [ado outputs file] [prepare-from mode]: landing zone lz-{slug}-{env} of
# the current app (globals: slug, app_file, names). Without ado outputs the federation is carried from
# the lz record (first pass); with them it is the app's service connection (second pass). With a
# prepare-from mode (ADR-0060, the plan's modeChange.from), the prepare pass of a network mode change
# (`inputs --step lz --prepare-from`: modeChange {phase: prepare}); without, modeChange is null (the
# steady state, and the final pass of a move). Deploys only when the record is not up to date; writes
# the landing-zone outputs (properties.outputs). After a deployment, the unit tags of the plan go back
# on the app resource group (prov_tags_restore).
prov_lz() {
  local dir="$1" outputs="$2" ado="${3:-}" prepare="${4:-}" name location
  local -a step=(--step lz)
  case "$prepare" in
    '') ;;
    externalOnly | externalHybrid) step+=(--prepare-from "$prepare") ;;
    *) saf_die "prov_lz: invalid prepare-from mode" ;;
  esac
  mkdir -p "$dir" "$(dirname "$outputs")"
  name="$(prov_name "$names" provisioningDeployment)"
  prov_record sub "$name" "" "$dir/lz-record.json"
  prov_state "$dir" "$ado"
  saf_cli provisioning inputs "${step[@]}" --instance "$SAF_INSTANCE" --app "$app_file" --env "$env_name" \
    --state "$dir/state.json" --output "$dir/lz.json"
  location="$(jq -er '.location' "$dir/lz.json")"
  [[ "$location" =~ ^[a-z0-9]+$ ]] || saf_die "the landing-zone inputs have no valid location"
  prov_arm validate lz "$dir/lz.json" "$name" "$location" "$dir/validate.json"
  prov_compare lz "$dir/validate.json" "$dir/lz-record.json"
  if [ "$prov_verdict" = up-to-date ]; then
    jq -e '.properties.outputs' "$dir/lz-record.json" > "$outputs"
    prov_detail landingZone up-to-date
  else
    prov_arm create lz "$dir/lz.json" "$name" "$location" "$dir/deployment.json"
    jq -e '.properties.outputs' "$dir/deployment.json" > "$outputs"
    prov_detail landingZone deployed
    prov_tags_restore "$(jq -r '.resourceGroupName.value // ""' "$outputs")"
  fi
}

# prov_lz_stale_assignments <lz deployment>: the clean-up of PE010 (runbook
# app-resource-group-deleted.md, ADR-0064 amendment 2026-11-17). Deleting an app's resource group by hand
# deletes its identities but not their role assignments on shared resources, and the identities the landing
# zone creates again can't take them over: an assignment's name is guid(scope, the identity's resource ID,
# role), the same for the new identity, and ARM refuses to change its principal
# (RoleAssignmentUpdateNotPermitted). Which assignments go comes from this app's own record only (ADR-0052:
# an ID from the app's own record): the failed nested deployments of <lz deployment> (joinerOnCae-,
# easyAuthOnSecret-, importerOnSourceRegistry-), and in them the role assignments whose operation failed
# with RoleAssignmentUpdateNotPermitted. Each one is deleted only when
#   - its scope is one the landing zone writes outside the group (as lz_outside_assignments of azure.sh): the
#     CAE in the environment's platform resource group, the app's Easy Auth secret in an environment vault,
#     the app's own registry in its group of another environment; and
#   - its principal is none of the identities in the app's group now (the ones the landing zone just made),
#     so it belonged to a deleted one: an identity's resource ID has one principal while it exists.
# Nothing else is read or written. Returns 0 when it deleted at least one (prov_arm deploys once more).
prov_lz_stale_assignments() {
  local lz_name="$1" rg platform_rg own_prefix nested nsub nrg nname id scope principal deleted=1 err="$PROV_DIR/stale.err"
  rg="$(prov_name "$names" appResourceGroup)" || return 1
  platform_rg="$(prov_name "$names" platformResourceGroup)" || return 1
  own_prefix="${rg%-"$env_name"}-"
  # The app's identities now: their principals are never touched.
  az identity list --resource-group "$rg" --query '[].principalId' --output tsv --only-show-errors > "$PROV_DIR/stale-principals.txt" 2> "$err" || return 1
  grep -Eiq '^[0-9a-f]{8}-([0-9a-f]{4}-){3}[0-9a-f]{12}$' "$PROV_DIR/stale-principals.txt" || return 1
  az deployment operation sub list --name "$lz_name" --output json --only-show-errors > "$PROV_DIR/stale-ops.json" 2> "$err" || return 1
  jq -r '.[]? | select(.properties.provisioningState == "Failed" and .properties.targetResource.resourceType == "Microsoft.Resources/deployments") | .properties.targetResource.id // empty' \
    "$PROV_DIR/stale-ops.json" > "$PROV_DIR/stale-nested.txt" || return 1
  while IFS= read -r nested; do
    [[ "${nested,,}" =~ ^/subscriptions/([0-9a-f-]{36})/resourcegroups/([a-z0-9._()-]{1,90})/providers/microsoft\.resources/deployments/(joineroncae|easyauthonsecret|importeronsourceregistry)-[a-z0-9]{13}$ ]] || continue
    nsub="${BASH_REMATCH[1]}"
    nrg="${BASH_REMATCH[2]}"
    nname="${nested##*/}"
    az deployment operation group list --subscription "$nsub" --resource-group "$nrg" --name "$nname" --output json --only-show-errors > "$PROV_DIR/stale-nested-ops.json" 2> "$err" || continue
    jq -r '.[]? | select(.properties.provisioningState == "Failed" and .properties.targetResource.resourceType == "Microsoft.Authorization/roleAssignments"
        and ((.properties.statusMessage // {}) | tostring | test("RoleAssignmentUpdateNotPermitted"))) | .properties.targetResource.id // empty' \
      "$PROV_DIR/stale-nested-ops.json" > "$PROV_DIR/stale-ids.txt" || continue
    while IFS= read -r id; do
      [[ "${id,,}" =~ ^(/subscriptions/[0-9a-f-]{36}/resourcegroups/[a-z0-9._()-]{1,90}/providers/.+)/providers/microsoft\.authorization/roleassignments/[0-9a-f-]{36}$ ]] || continue
      scope="${BASH_REMATCH[1]}"
      # The guard: only the scopes the landing zone writes outside its group (ADR-0052 item 2).
      if ! [[ "$scope" =~ ^/subscriptions/${subscription,,}/resourcegroups/${platform_rg,,}/providers/microsoft\.app/managedenvironments/[a-z0-9-]{1,60}$ ]] \
          && ! [[ "$scope" =~ ^/subscriptions/${subscription,,}/resourcegroups/${platform_rg,,}/providers/microsoft\.keyvault/vaults/[a-z0-9-]{3,24}/secrets/easyauth-${slug}$ ]] \
          && ! [[ "$scope" =~ ^/subscriptions/[0-9a-f-]{36}/resourcegroups/${own_prefix,,}[a-z0-9]{2,8}/providers/microsoft\.containerregistry/registries/[a-z0-9]{5,50}$ ]]; then
        printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the role assignment ${id##*/} the landing zone couldn't write is at a scope it doesn't write outside its group; it is left alone (check it by hand)"
        continue
      fi
      principal="$(az rest --method get --url "$id?api-version=2022-04-01" --query properties.principalId --output tsv --only-show-errors 2> "$err")" || continue
      prov_valid_guid "$principal" || continue
      # The guard: a principal of the app's identities now is never removed.
      if grep -qixF "$principal" "$PROV_DIR/stale-principals.txt"; then continue; fi
      saf_info "  Removing the role assignment ${id##*/}: it belonged to an identity of $slug that was deleted with its resource group"
      if az role assignment delete --ids "$id" --only-show-errors --output none 2> "$err"; then
        deleted=0
      else
        saf_neutralise < "$err" | tail -n 5
      fi
    done < "$PROV_DIR/stale-ids.txt"
  done < "$PROV_DIR/stale-nested.txt"
  return "$deleted"
}

# prov_core_images_registry: coreImages.registry of instance.yaml (the public core packages, ghcr.io/<owner>,
# or the instance's mirror; ADR-0030, ADR-0065), read with the CLI's validated instance loader.
prov_core_images_registry() {
  local registry
  registry="$(node -e '
    import(process.argv[1]).then((m) => {
      const r = m.loadInstanceFile(process.argv[2]).coreImages?.registry;
      process.stdout.write(typeof r === "string" ? r : "");
    }).catch(() => process.exit(1));' \
    "$SAF_CORE/tools/platform-cli/dist/src/provisioning/model.js" "$SAF_INSTANCE")"
  [[ "$registry" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] \
    || { echo "instance.yaml has no valid coreImages.registry" >&2; return 1; }
  printf '%s' "$registry"
}

# ---------------------------------------------------------------------------------------------
# Azure DevOps (AzureCLI@2 with sc-platform-ado)
# ---------------------------------------------------------------------------------------------

# prov_ado_token: the ADO automation identity's Entra token for Azure DevOps into
# AZURE_DEVOPS_TOKEN (masked first). Called per app, so a long loop never runs on an expired token.
prov_ado_token() {
  local token
  token="$(az account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "no Azure DevOps token for the service connection identity"
  echo "##vso[task.setsecret]$token"
  AZURE_DEVOPS_TOKEN="$token"
  export AZURE_DEVOPS_TOKEN
}

# ---------------------------------------------------------------------------------------------
# Microsoft Graph and Azure Resource Manager tokens (AzureCLI@2 with sc-platform-entra, stage entra)
# ---------------------------------------------------------------------------------------------

# prov_secret_tokens: the Entra provisioning identity's tokens for `platform provisioning
# easyauth-secret` (ADR-0035, ADR-0041): SAF_GRAPH_TOKEN (Microsoft Graph: the app's password
# credentials, addPassword, removePassword) and
# SAF_ARM_TOKEN (Azure Resource Manager: the kvset job). Each is masked with task.setsecret before it
# is stored, then exported: never an argument, never a file. Resources and endpoints come from the
# cloud az is logged in to (az cloud show), so a sovereign cloud gets its own; SAF_GRAPH_ENDPOINT
# and SAF_ARM_ENDPOINT are https://<host> without a trailing slash. Called per app right before
# the step (a long loop never runs on an expired token); the caller unsets the tokens after it.
# TODO(verify): `az account get-access-token` for Microsoft Graph and for resourceManager with the
# AzureCLI@2 workload identity federation login of sc-platform-entra, late in a long job (JOB-4).
prov_secret_tokens() {
  local cloud="$PROV_DIR/cloud.json" graph arm token
  az cloud show --query '{graph: endpoints.microsoftGraphResourceId, arm: endpoints.resourceManager}' \
    --output json --only-show-errors > "$cloud"
  graph="$(jq -r '.graph // ""' "$cloud")"
  arm="$(jq -r '.arm // ""' "$cloud")"
  [[ "$graph" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || saf_die "az cloud show names no valid Microsoft Graph endpoint"
  [[ "$arm" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || saf_die "az cloud show names no valid Azure Resource Manager endpoint"
  token="$(az account get-access-token --resource "$graph" --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "no Microsoft Graph token for the service connection identity"
  echo "##vso[task.setsecret]$token"
  SAF_GRAPH_TOKEN="$token"
  token="$(az account get-access-token --resource "$arm" --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "no Azure Resource Manager token for the service connection identity"
  echo "##vso[task.setsecret]$token"
  SAF_ARM_TOKEN="$token"
  SAF_GRAPH_ENDPOINT="${graph%/}"
  SAF_ARM_ENDPOINT="${arm%/}"
  export SAF_GRAPH_TOKEN SAF_ARM_TOKEN SAF_GRAPH_ENDPOINT SAF_ARM_ENDPOINT
}

# prov_graph_token: the Entra provisioning identity's Microsoft Graph token (masked) and endpoint, in
# SAF_GRAPH_TOKEN / SAF_GRAPH_ENDPOINT, for `platform provisioning entra-reconcile` in entra.sh
# (stage entra, ADR-0033 amended 2026-11-11, P24): the environment only, never an argument; the
# caller unsets SAF_GRAPH_TOKEN right after the command. No ARM token: the reconcile only calls Graph.
prov_graph_token() {
  local cloud="$PROV_DIR/cloud-graph.json" graph token
  az cloud show --query '{graph: endpoints.microsoftGraphResourceId}' --output json --only-show-errors > "$cloud"
  graph="$(jq -r '.graph // ""' "$cloud")"
  [[ "$graph" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || saf_die "az cloud show names no valid Microsoft Graph endpoint"
  token="$(az account get-access-token --resource "$graph" --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "no Microsoft Graph token for the service connection identity"
  echo "##vso[task.setsecret]$token"
  SAF_GRAPH_TOKEN="$token"
  SAF_GRAPH_ENDPOINT="${graph%/}"
  export SAF_GRAPH_TOKEN SAF_GRAPH_ENDPOINT
}

# prov_arm_token: the Azure provisioning identity's ARM token (masked) and endpoint, in
# SAF_ARM_TOKEN / SAF_ARM_ENDPOINT, for `platform provisioning dbinit` in azure-post.sh (stage
# azure_post, ADR-0028, P18):
# the environment only, never an argument; the caller unsets SAF_ARM_TOKEN right after the command.
prov_arm_token() {
  local cloud="$PROV_DIR/cloud-arm.json" arm token
  az cloud show --query '{arm: endpoints.resourceManager}' --output json --only-show-errors > "$cloud"
  arm="$(jq -r '.arm // ""' "$cloud")"
  [[ "$arm" =~ ^https://[A-Za-z0-9.-]+/?$ ]] || saf_die "az cloud show names no valid Azure Resource Manager endpoint"
  token="$(az account get-access-token --resource "$arm" --query accessToken --output tsv --only-show-errors)"
  [ -n "$token" ] || saf_die "no Azure Resource Manager token for the service connection identity"
  echo "##vso[task.setsecret]$token"
  SAF_ARM_TOKEN="$token"
  SAF_ARM_ENDPOINT="${arm%/}"
  export SAF_ARM_TOKEN SAF_ARM_ENDPOINT
}

# prov_org_url: the organization this run belongs to (System.CollectionUri); `platform ado` checks
# it against instance.yaml scm.azureDevOps.organizationUrl.
prov_org_url() {
  local url="${SYSTEM_COLLECTIONURI:-}"
  url="${url%/}"
  [[ "$url" =~ ^https://[A-Za-z0-9.-]+(/[A-Za-z0-9._~%-]+)*$ ]] || { echo "SYSTEM_COLLECTIONURI is not set or invalid" >&2; return 1; }
  printf '%s' "$url"
}
