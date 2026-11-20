#!/usr/bin/env bash
# check-instance-sh.sh — offline tests of infra/platform/instance/instance.sh (ADR-0066). No Azure, no Azure
# DevOps: a fake `az` that records every call and answers from fake deployments (the state fixtures of
# tools/platform-cli/test/fixtures/instance), a fake `dig`, and a fake `platform` that passes everything
# to the built CLI except `ado bootstrap`, which it records (the token only as set or not) and answers
# with the fixture's connections. config/examples/instance.example.yaml is the instance.
#
#   1. what-if by default, create with --apply: roles (sub scope, host subscription), entra-permissions
#      and portal-registration (validate by default: Graph has no what-if), audit-alert (the workspace's
#      group), bootstrap; the exact az command lines, the core .bicepparam, and SAF_INSTANCE_JSON equal to
#      infra/platform/instance/examples/;
#   2. the state: the host's bootstrap read for another environment's bootstrap, the federation from
#      `platform ado bootstrap plan --phase connections` for pass 2, the portal and platform
#      deployments; a missing deployment fails with what to run first;
#   3. the ReadOnly lock: a what-if never touches it; --apply stops while it exists and prints the
#      removal command; --remove-lock deletes it before the deployment, and puts it back when the
#      deployment fails;
#   4. ado: all runs connections, pipeline, grants, policies and, with approvals.entraChanges pullRequest,
#      connections again (plan, or apply with --apply), with the organisation of instance.yaml and the
#      bootstraps' outputs; the exit code is the last run of each phase; the token never on a command line;
#   5. sync: the registration and the portal deployment read from Azure, instance.yaml written only with --apply,
#      portal.apiBaseUrl only while it is not set;
#   6. preflight: read-only (no write, no deployment), blocking findings exit 1;
#   7. the CLI from the core checkout when `platform` is not on PATH; usage errors exit 2;
#   8. core (ADR-0067): the release from a local releases repository (real git, its https URLs rewritten to
#      local bare repositories by insteadOf in a test git config) and a fake `curl` for the GitHub Release
#      downloads: the checks (SHA256SUMS, release.json, the tag's commit, the commit's files against the
#      list), the plan, --apply (phase core, main and the tag pushed, never forced, phase core again), a tag
#      already at the release's commit, one at another commit (exit 2), coreReleases unset; a `git` wrapper
#      logs each call, so the token is seen to come only through the environment;
#   9. providers: the preview lists the missing providers per subscription and registers nothing; --apply
#      registers only those (--wait) and reports the state read back; a refused or unfinished registration exits 1;
#  10. dns: an existing zone is only read, its NS record set printed for the delegation; a missing zone (and
#      group) is planned, and created only with --apply (--if-none-match); each allowed environment's
#      provisioning identity's role on the zone (ok, or warn with the grant command; never granted); a zone ID
#      that isn't the zone's and a read error block. The fake answers as az does: tsv one value per line, a
#      missing zone or group an error on stderr with exit code 3 and (ResourceNotFound) or (ResourceGroupNotFound);
#  11. plan and status (ADR-0072): plan reads nothing (no az, no curl, no Azure DevOps) and fills in the instance's
#      environments; status only reads: each deployment once (its state, outputs and federation), the providers, the
#      zones and the provisioning identities' roles, `platform ado bootstrap plan` per phase (only those whose
#      bootstraps exist), /readyz of the portal; then `platform instance status` reports the current phase and step and
#      the next one (text or JSON). Not logged in, no token, an invalid instance.yaml: reported, never a failure.
# Needs the platform CLI built (cd tools/platform-cli && npm ci && npm run build), and git.
# Usage: bash infra/tests/check-instance-sh.sh (exit 0 = every check passed).

set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
script="$repo/infra/platform/instance/instance.sh"
cli="$repo/tools/platform-cli/dist/src/cli.js"
state="$repo/tools/platform-cli/test/fixtures/instance"
examples="$repo/infra/platform/instance/examples"
params="$repo/infra/platform/instance"
tmp="$(mktemp -d)"
trap '[ -n "${KEEP:-}" ] || rm -rf "$tmp"' EXIT
[ -z "${KEEP:-}" ] || printf 'workspace: %s\n' "$tmp"
failures=0
PROD=00000000-0000-0000-0000-00000000b001
NONPROD=00000000-0000-0000-0000-00000000a001
IDENTITY_TEAM=/subscriptions/$PROD/resourceGroups/rg-contoso-identity/providers/Microsoft.Insights/actionGroups/ag-contoso-identity-team

if [ ! -f "$cli" ]; then
  printf 'FAIL  the platform CLI is not built (cd tools/platform-cli && npm ci && npm run build)\n'
  exit 1
fi

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

# --- the fakes ------------------------------------------------------------------------------------
fake="$tmp/fake"
bin_az="$tmp/bin-az"
bin_platform="$tmp/bin-platform"
mkdir -p "$bin_az" "$bin_platform" "$tmp/cwd"
cat > "$bin_az/az" << 'EOF'
#!/usr/bin/env bash
# The fake az: logs the call, answers from $SAF_FAKE.
set -euo pipefail
d="$SAF_FAKE"
printf '%s\n' "$*" >> "$d/az.log"
args=("$@")
opt() { # the value of option $1
  local i
  for ((i = 0; i < ${#args[@]} - 1; i++)); do
    if [ "${args[i]}" = "$1" ]; then
      printf '%s' "${args[i + 1]}"
      return 0
    fi
  done
  return 1
}
flag() { case " ${args[*]} " in *" $1 "*) return 0 ;; esac; return 1; } # flag <flag>: the call has it
unexpected() {
  echo "unexpected az call: ${args[*]}" >> "$d/unexpected.log"
  exit 1
}
# is_registered <subscription> <namespace>: not in SAF_FAKE_UNREGISTERED (<namespace> for every subscription,
# <subscription>:<namespace> for one), or registered since ($d/registered).
is_registered() {
  if grep -qxF "$1 $2" "$d/registered" 2> /dev/null; then return 0; fi
  case " ${SAF_FAKE_UNREGISTERED:-} " in *" $2 "* | *" $1:$2 "*) return 1 ;; esac
  return 0
}
if [ "$1" = rest ]; then
  case "$(opt --url)" in
    */Microsoft.DBforPostgreSQL/locations/*/capabilities*)
      # As Azure answered on the test instance (ONB-1): a restricted subscription gets a reason and no version;
      # --output tsv prints null as None.
      if [[ " ${SAF_FAKE_DB_RESTRICTED:-} " == *" postgres "* ]]; then
        printf 'Provisioning is restricted in this region. Please choose a different region. For exceptions to this rule please open a support request with Issue type of '"'"'Service and subscription limits'"'"'.\t0\n'
      else
        printf 'None\t8\n'
      fi
      ;;
    */Microsoft.Sql/locations/*/capabilities*)
      if [[ " ${SAF_FAKE_DB_RESTRICTED:-} " == *" azureSql "* ]]; then printf 'Disabled\tNone\n'; else printf 'Available\tNone\n'; fi
      ;;
    *)
      # As az prints --output tsv: a flat list (`| [0].[a, b]`) one value per line, a list of rows
      # (`[?…].[a, b]`) one tab-separated line per row. A preflight that reads a flat list gets no limit.
      case "$(opt --query)" in
        *'| [0].['*) printf '%s\n50\n' "${SAF_FAKE_CAES:-3}" ;;
        *) printf '%s\t50\n' "${SAF_FAKE_CAES:-3}" ;;
      esac
      ;;
  esac
  exit 0
fi
case "$1 ${2:-}" in
  "deployment sub" | "deployment group")
    name="$(opt --name)"
    case "$3" in
      show)
        f="$d/deployments/$name.json"
        if [ ! -f "$f" ]; then
          echo "ERROR: (DeploymentNotFound) Deployment '$name' could not be found." >&2
          exit 3
        fi
        q="$(opt --query)"
        if [ "$q" = "properties.provisioningState=='Succeeded' && properties.outputs" ]; then
          # JMESPath's && gives the left side when it is false: a deployment that hasn't succeeded prints false.
          if [ -f "$d/deployments/$name.failed" ]; then echo false; else cat "$f"; fi
        elif [ "$q" = "{state: properties.provisioningState, outputs: properties.outputs, federation: properties.parameters.federation.value}" ]; then
          # instance.sh status: one read of the state, the outputs and a bootstrap's parameter federation.
          node -e 'const fs = require("fs"), [f, failed, fed] = process.argv.slice(1);
const bad = fs.existsSync(failed);
console.log(JSON.stringify({ state: bad ? "Failed" : "Succeeded", outputs: bad ? null : JSON.parse(fs.readFileSync(f, "utf8")), federation: fs.existsSync(fed) ? JSON.parse(fs.readFileSync(fed, "utf8")) : null }, null, 2));' \
            "$f" "$d/deployments/$name.failed" "$d/deployments/$name.federation.json"
        else
          key="${q#properties.outputs.}"
          node -e 'const o = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(o[process.argv[2]].value)' "$f" "${key%.value}"
        fi
        ;;
      what-if | create | validate)
        printf '%s' "${SAF_INSTANCE_JSON:-}" > "$d/inputs-$name-$3.json"
        rc="${SAF_FAKE_DEPLOY_RC:-0}"
        if [ "$3" = what-if ]; then echo "Resource changes: 0 to create."; elif [ "$rc" = 0 ]; then echo Succeeded; fi
        exit "$rc"
        ;;
      *) echo "unexpected az call: $*" >> "$d/unexpected.log"; exit 1 ;;
    esac
    ;;
  "lock show")
    if [ -f "$d/lock" ]; then exit 0; fi
    echo "ERROR: lock not found" >&2
    exit 3
    ;;
  "lock delete") rm -f "$d/lock" ;;
  "lock create") touch "$d/lock" ;;
  "account get-access-token")
    if [ -n "${SAF_FAKE_NOT_LOGGED_IN:-}" ]; then echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; fi
    echo fake-ado-token
    ;;
  "account show")
    if [ -n "${SAF_FAKE_NOT_LOGGED_IN:-}" ]; then echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; fi
    if sub="$(opt --subscription)"; then
      case " ${SAF_FAKE_UNREACHABLE:-} " in *" $sub "*) echo "ERROR: subscription $sub not found" >&2; exit 1 ;; esac
      echo "$sub"
    else
      echo "${SAF_FAKE_TENANT:-00000000-0000-0000-0000-000000000001}"
    fi
    ;;
  "ad signed-in-user") echo 00000000-0000-0000-0000-0000000000aa ;;
  "role assignment")
    [ "${3:-}" = list ] || unexpected
    if pid="$(opt --assignee-object-id)"; then
      # A provisioning identity's assignments ($d/assignments: principal, role, scope) as the subscription's list
      # returns them: at, above or below the subscription only.
      [ "$(opt --query)" = "[].[roleDefinitionName, scope]" ] && [ "$(opt --output)" = tsv ] && flag --all && flag --include-inherited || unexpected
      sub="$(opt --subscription)"
      [ ! -f "$d/assignments" ] || awk -F'\t' -v p="$pid" -v s="/subscriptions/${sub,,}" '$1 == p {
        l = tolower($3); if (l == "/" || index(l, "/providers/microsoft.management/") == 1 || l == s || index(l, s "/") == 1) print $2 "\t" $3 }' "$d/assignments"
    else
      printf '%s\n' "${SAF_FAKE_ROLES:-Owner}"
    fi
    ;;
  "provider list")
    [ "$(opt --query)" = "[?registrationState=='Registered'].namespace" ] && [ "$(opt --output)" = tsv ] || unexpected
    sub="$(opt --subscription)"
    # A flat list in tsv: one namespace per line, the subscription's others too.
    for p in Microsoft.App Microsoft.ContainerRegistry Microsoft.KeyVault Microsoft.OperationalInsights Microsoft.Insights \
      Microsoft.AlertsManagement Microsoft.DBforPostgreSQL Microsoft.Sql Microsoft.Storage Microsoft.Network Microsoft.Cdn \
      Microsoft.ManagedIdentity Microsoft.Consumption Microsoft.CostManagement Microsoft.DataProtection Microsoft.Resources; do
      if is_registered "$sub" "$p"; then echo "$p"; fi
    done
    ;;
  "provider register")
    sub="$(opt --subscription)"
    p="$(opt --namespace)"
    flag --wait || unexpected
    if [ "$p" = "${SAF_FAKE_REGISTER_FAIL:-}" ]; then
      echo "ERROR: (AuthorizationFailed) The client '00000000-0000-0000-0000-0000000000aa' with object id '00000000-0000-0000-0000-0000000000aa' does not have authorization to perform action '$p/register/action' over scope '/subscriptions/$sub' or the scope is invalid. If access was recently granted, please refresh your credentials." >&2
      exit 1
    fi
    # With --wait az prints nothing; SAF_FAKE_REGISTERING stays Registering.
    [ "$p" = "${SAF_FAKE_REGISTERING:-}" ] || echo "$sub $p" >> "$d/registered"
    ;;
  "provider show")
    [ "$(opt --query)" = registrationState ] && [ "$(opt --output)" = tsv ] || unexpected
    sub="$(opt --subscription)"
    p="$(opt --namespace)"
    if is_registered "$sub" "$p"; then echo Registered; elif [ "$p" = "${SAF_FAKE_REGISTERING:-}" ]; then echo Registering; else echo NotRegistered; fi
    ;;
  "group create")
    sub="$(opt --subscription)"
    rg="$(opt --name)"
    opt --location > /dev/null || unexpected
    mkdir -p "$d/dns/${sub,,}/${rg,,}"
    ;;
  "network dns")
    # Azure DNS: $d/dns/<subscription>/<group>/<zone> holds a zone's name servers (names compare without case).
    sub="$(opt --subscription)"
    rg="$(opt --resource-group)"
    zone="$(opt --name)"
    case "${3:-} ${4:-}" in "zone show" | "zone create") ;; *) unexpected ;; esac
    if [ -n "${SAF_FAKE_DNS_ERROR:-}" ]; then
      echo "ERROR: (AuthorizationFailed) The client '00000000-0000-0000-0000-0000000000aa' does not have authorization to perform action 'Microsoft.Network/dnszones/read' over scope '/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.Network/dnszones/$zone' or the scope is invalid." >&2
      exit 1
    fi
    if [ ! -d "$d/dns/${sub,,}/${rg,,}" ]; then
      printf "ERROR: (ResourceGroupNotFound) Resource group '%s' could not be found.\nCode: ResourceGroupNotFound\nMessage: Resource group '%s' could not be found.\n" "$rg" "$rg" >&2
      exit 3
    fi
    f="$d/dns/${sub,,}/${rg,,}/${zone,,}"
    if [ "$4" = show ]; then
      if [ ! -f "$f" ]; then
        m="The Resource 'Microsoft.Network/dnszones/$zone' under resource group '$rg' was not found. For more details please go to https://aka.ms/ARMResourceNotFoundFix"
        printf 'ERROR: (ResourceNotFound) %s\nCode: ResourceNotFound\nMessage: %s\n' "$m" "$m" >&2
        exit 3
      fi
      [ "$(opt --query)" = nameServers ] && [ "$(opt --output)" = tsv ] || unexpected
      cat "$f"
    else
      if [ -f "$f" ] && flag --if-none-match; then
        echo "ERROR: (PreconditionFailed) The Zone $zone exists already and hence cannot be created again." >&2
        exit 1
      fi
      printf 'ns1-03.azure-dns.example.\nns2-03.azure-dns.example.\nns3-03.azure-dns.example.\nns4-03.azure-dns.example.\n' > "$f"
    fi
    ;;
  "policy assignment") printf 'Allowed locations\tDefault\t/providers/Microsoft.Management/managementGroups/root\n' ;;
  "resource show") echo northeurope ;;
  *) echo "unexpected az call: $*" >> "$d/unexpected.log"; exit 1 ;;
esac
EOF
cat > "$bin_az/dig" << 'EOF'
#!/usr/bin/env bash
# The fake dig: dig +short CAA <name>; contoso.com has a CAA set without digicert.com.
printf 'dig %s\n' "$*" >> "$SAF_FAKE/az.log"
if [ "${3:-}" = contoso.com ]; then echo '0 issue "ca.example"'; fi
EOF
cat > "$bin_platform/platform" << 'EOF'
#!/usr/bin/env bash
# The fake platform: the built CLI, except `ado bootstrap` (recorded; connections writes the fixture's output).
set -euo pipefail
printf '%s token=%s\n' "$*" "${AZURE_DEVOPS_TOKEN:+set}" >> "$SAF_FAKE/platform.log"
if [ "${1:-} ${2:-}" = "ado bootstrap" ]; then
  args=("$@")
  phase=""
  output=""
  for ((i = 0; i < ${#args[@]} - 1; i++)); do
    case "${args[i]}" in
      --phase) phase="${args[i + 1]}" ;;
      --output) output="${args[i + 1]}" ;;
    esac
  done
  echo "platform ado bootstrap $3 --phase $phase (fake)"
  printf 'platform ado bootstrap %s --phase %s\n' "$3" "$phase" >> "$SAF_FAKE/git.log"
  rc=0
  if [ "$phase" = core ]; then
    # apply creates the repository (an empty bare one); --output says whether it exists.
    if [ "$3" = apply ] && [ ! -d "$SAF_FAKE/ado/core" ]; then "$SAF_REAL_GIT" init --quiet --bare "$SAF_FAKE/ado/core"; fi
    if [ -n "$output" ] && [ -d "$SAF_FAKE/ado/core" ]; then
      echo '{"core":{"repository":{"id":"00000000-0000-0000-0000-0000000000b2","name":"core"},"tags":[]}}' > "$output"
    elif [ -n "$output" ]; then
      echo '{"core":{"repository":null,"tags":[]}}' > "$output"
    fi
    rc="${SAF_FAKE_CORE_RC:-0}"
  fi
  if [ "$phase" = connections ]; then
    n="$(cat "$SAF_FAKE/connections-runs" 2> /dev/null || echo 0)"
    echo $((n + 1)) > "$SAF_FAKE/connections-runs"
    # A new instance: the first connections run is blocked on the pull request policy (exit 1).
    if [ "$n" = 0 ]; then rc="${SAF_FAKE_FIRST_CONNECTIONS_RC:-1}"; fi
    if [ -n "$output" ]; then cp "$SAF_FAKE/connections.json" "$output"; fi
    echo "Federation for infra/platform/bootstrap.bicep pass 2 (read back from Azure DevOps):"
  fi
  # The rows of a plan and its --output, when a case gives them (instance.sh status).
  if [ -f "$SAF_FAKE/ado-rows/$phase" ]; then cat "$SAF_FAKE/ado-rows/$phase"; fi
  if [ -n "$output" ] && [ -f "$SAF_FAKE/ado-out/$phase.json" ]; then cp "$SAF_FAKE/ado-out/$phase.json" "$output"; fi
  exit "$rc"
fi
exec node "$SAF_CLI" "$@"
EOF
cat > "$bin_az/curl" << 'EOF'
#!/usr/bin/env bash
# The fake curl: the GitHub Release downloads, from $SAF_FAKE/download/<version>/<file>; logs every call.
set -euo pipefail
printf 'curl %s\n' "$*" >> "$SAF_FAKE/curl.log"
args=("$@")
out=""
url=""
flags=""
for ((i = 0; i < ${#args[@]}; i++)); do
  case "${args[i]}" in
    --output)
      out="${args[i + 1]}"
      i=$((i + 1))
      ;;
    --write-out)
      flags="$flags--write-out"
      i=$((i + 1))
      ;;
    --fail | --location) flags="$flags${args[i]}" ;;
    --proto)
      if [ "${args[i + 1]}" = "=https" ]; then flags="$flags--proto"; fi
      i=$((i + 1))
      ;;
    --proto-redir | --max-time) i=$((i + 1)) ;;
    -*) ;;
    *) url="${args[i]}" ;;
  esac
done
# instance.sh status: /readyz of the portal, https only; $SAF_FAKE/readyz holds the HTTP status (none: unreachable).
if [[ $url == */readyz ]]; then
  if [ "$flags" != "--proto--write-out" ]; then
    echo "fake curl: /readyz without --proto =https and --write-out" >&2
    exit 99
  fi
  if [ ! -f "$SAF_FAKE/readyz" ]; then
    echo "curl: (6) Could not resolve host: ${url#https://}" >&2
    exit 6
  fi
  printf '%s' "$(cat "$SAF_FAKE/readyz")"
  exit 0
fi
if [ "$flags" != "--fail--location--proto" ]; then
  echo "fake curl: called without --fail --location --proto =https" >&2
  exit 99
fi
prefix=https://github.com/contoso/simple-apps-foundry-releases/releases/download/
file="$SAF_FAKE/download/${url#"$prefix"}"
if [[ $url != "$prefix"* ]] || [ ! -f "$file" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cp "$file" "$out"
EOF
cat > "$bin_az/git" << 'EOF'
#!/usr/bin/env bash
# The git wrapper: logs the arguments and whether the Azure DevOps token came in the environment, then runs git.
token=no
case "${GIT_CONFIG_VALUE_0:-}" in *fake-ado-token* | *preset*) token=env ;; esac
printf 'git %s header=%s key=%s\n' "$*" "$token" "${GIT_CONFIG_KEY_0:-}" >> "$SAF_FAKE/git.log"
exec "$SAF_REAL_GIT" "$@"
EOF
chmod +x "$bin_az/az" "$bin_az/dig" "$bin_az/curl" "$bin_az/git" "$bin_platform/platform"
base_path="$(dirname "$(command -v node)"):/usr/bin:/bin"
real_git="$(command -v git)"
# A git config of the tests' own: the releases repository and the platform project's core are local bare repositories.
gitconfig="$tmp/gitconfig"
cat > "$gitconfig" << EOF
[init]
	defaultBranch = main
[advice]
	detachedHead = false
[url "$fake/github/"]
	insteadOf = https://github.com/
[url "$fake/ado/"]
	insteadOf = https://dev.azure.com/contoso/Platform/_git/
EOF
# fgit: git for the fixtures, with that config and a fixed author.
fgit() {
  GIT_CONFIG_GLOBAL="$gitconfig" GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@example.com \
    GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@example.com "$real_git" "$@"
}

# reset [deployment...]: an empty fake Azure with these deployments (bootstrap-contoso-prod, ...).
reset() {
  # The unexpected calls of every case, for the last check.
  if [ -f "$fake/unexpected.log" ]; then cat "$fake/unexpected.log" >> "$tmp/unexpected.all"; fi
  rm -rf "$fake"
  mkdir -p "$fake/deployments"
  cp "$state/connections.json" "$fake/connections.json"
  local d
  for d in "$@"; do
    case "$d" in
      bootstrap-contoso-prod) cp "$state/bootstrap-prod.outputs.json" "$fake/deployments/$d.json" ;;
      bootstrap-contoso-nonprod) cp "$state/bootstrap-nonprod.outputs.json" "$fake/deployments/$d.json" ;;
      portal-contoso-prod) cp "$state/portal-prod.outputs.json" "$fake/deployments/$d.json" ;;
      entra-portal-prod) cp "$state/entra-portal-prod.outputs.json" "$fake/deployments/$d.json" ;;
      platform-contoso-prod | platform-contoso-nonprod) cp "$state/platform-prod.outputs.json" "$fake/deployments/$d.json" ;;
      roles-contoso | entra-permissions | entra-audit-alert) echo '{}' > "$fake/deployments/$d.json" ;;
      lock) touch "$fake/lock" ;;
    esac
  done
  : > "$fake/az.log"
  : > "$fake/platform.log"
  : > "$fake/git.log"
  : > "$fake/curl.log"
  cp "$repo/config/examples/instance.example.yaml" "$tmp/cwd/instance.yaml"
}
ALL=(bootstrap-contoso-prod bootstrap-contoso-nonprod portal-contoso-prod entra-portal-prod platform-contoso-prod)
# in_cwd <PATH> <instance.sh args...>: the script in $tmp/cwd (./instance.yaml) with the fakes.
in_cwd() {
  local path="$1" token=()
  shift
  [ -z "${TEST_ADO_TOKEN:-}" ] || token=("AZURE_DEVOPS_TOKEN=$TEST_ADO_TOKEN")
  (cd "$tmp/cwd" && env -u AZURE_DEVOPS_TOKEN -u GIT_CONFIG_COUNT ${token[@]+"${token[@]}"} PATH="$path" SAF_FAKE="$fake" SAF_CLI="$cli" \
    SAF_REAL_GIT="$real_git" GIT_CONFIG_GLOBAL="$gitconfig" GIT_CONFIG_NOSYSTEM=1 bash "$script" "$@")
}
# run <case> <instance.sh args...>: env from the caller (SAF_FAKE_*, PATH_MODE, TEST_ADO_TOKEN: the person's
# AZURE_DEVOPS_TOKEN; the caller's own never reaches the script). stdout and stderr in <case>.out, or with
# STDOUT_ONLY=1 stderr in <case>.err (the JSON of status).
run() {
  local c="$1" path="$bin_platform:$bin_az:$base_path"
  shift
  [ "${PATH_MODE:-}" != no-platform ] || path="$bin_az:$base_path"
  set +e
  if [ -n "${STDOUT_ONLY:-}" ]; then
    in_cwd "$path" "$@" > "$tmp/$c.out" 2> "$tmp/$c.err"
  else
    in_cwd "$path" "$@" > "$tmp/$c.out" 2>&1
  fi
  printf '%s' "$?" > "$tmp/$c.rc"
  set -e
}
rc_is() { [ "$(cat "$tmp/$1.rc")" = "$2" ]; }
out_has() { grep -qF -- "$2" "$tmp/$1.out"; }
az_has() { grep -qxF -- "$1" "$fake/az.log"; }
az_lacks() { ! grep -qE -- "$1" "$fake/az.log"; }
json_equal() { # json_equal <file> <file>
  node -e 'const fs = require("fs"), u = require("util"); process.exit(u.isDeepStrictEqual(JSON.parse(fs.readFileSync(process.argv[1], "utf8")), JSON.parse(fs.readFileSync(process.argv[2], "utf8"))) ? 0 : 1)' "$1" "$2"
}
# order <regex>...: the az calls matching each regex come in this order (the first match of each).
order() {
  local prev=0 n re
  for re in "$@"; do
    n="$(grep -nE -- "$re" "$fake/az.log" | head -n 1 | cut -d: -f1)"
    if [ -z "$n" ] || [ "$n" -le "$prev" ]; then return 1; fi
    prev="$n"
  done
}
# The outputs of a deployment only when it succeeded (az.log holds the arguments joined by spaces).
succeeded_q="properties.provisioningState=='Succeeded' && properties.outputs"
show_host="deployment sub show --subscription $PROD --name bootstrap-contoso-prod --query $succeeded_q --output json"

# --- 1. what-if by default, create with --apply ---------------------------------------------------
reset
run roles roles
check "roles: what-if in the host's subscription with core's roles.bicepparam" \
  az_has "deployment sub what-if --subscription $PROD --name roles-contoso --location westeurope --parameters $params/roles.bicepparam"
check "roles: SAF_INSTANCE_JSON is examples/contoso.roles.json" json_equal "$fake/inputs-roles-contoso-what-if.json" "$examples/contoso.roles.json"
check "roles: says which right it needs, exit 0" \
  test "$(out_has roles 'Needs: Owner or User Access Administrator on every environment subscription' && echo y)$(cat "$tmp/roles.rc")" = y0
check "roles: no create without --apply" az_lacks ' create '
reset
run roles-apply --apply roles
check "roles --apply: create, its state only" \
  az_has "deployment sub create --subscription $PROD --name roles-contoso --location westeurope --parameters $params/roles.bicepparam --query properties.provisioningState --output tsv"

reset bootstrap-contoso-prod
run perm entra-permissions
check "entra-permissions: the host's bootstrap read from Azure" az_has "$show_host"
check "entra-permissions: validate (Graph has no what-if) in rg-contoso-entra" \
  az_has "deployment group validate --subscription $PROD --resource-group rg-contoso-entra --name entra-permissions --parameters $params/entra-permissions.bicepparam --query properties.provisioningState --output tsv"
check "entra-permissions: SAF_INSTANCE_JSON is the example" json_equal "$fake/inputs-entra-permissions-validate.json" "$examples/contoso.entra-permissions.json"
check "entra-permissions: needs Privileged Role Administrator" out_has perm "Needs: Privileged Role Administrator or Global Administrator in tenant 00000000-0000-0000-0000-000000000001"
run perm-apply --apply entra-permissions
check "entra-permissions --apply: create" \
  az_has "deployment group create --subscription $PROD --resource-group rg-contoso-entra --name entra-permissions --parameters $params/entra-permissions.bicepparam --query properties.provisioningState --output tsv"
reset bootstrap-contoso-prod
touch "$fake/deployments/bootstrap-contoso-prod.failed"
run perm-failed entra-permissions
check "entra-permissions: a host bootstrap that hasn't succeeded counts as absent, exit 1, nothing deployed" \
  test "$(out_has perm-failed 'deployment bootstrap-contoso-prod has not succeeded' && az_lacks 'validate|what-if|create' && echo y)$(cat "$tmp/perm-failed.rc")" = y1

reset bootstrap-contoso-prod portal-contoso-prod
run reg portal-registration
check "portal-registration: the portal's deployment read from Azure" \
  az_has "deployment sub show --subscription $PROD --name portal-contoso-prod --query $succeeded_q --output json"
check "portal-registration: validate entra-portal-prod in rg-contoso-entra with core's file" \
  az_has "deployment group validate --subscription $PROD --resource-group rg-contoso-entra --name entra-portal-prod --parameters $params/portal-registration.bicepparam --query properties.provisioningState --output tsv"
check "portal-registration: SAF_INSTANCE_JSON is the example" json_equal "$fake/inputs-entra-portal-prod-validate.json" "$examples/contoso-prod.portal-registration.json"
check "portal-registration: says it is the tenant's admin consent" out_has reg "Running it is the tenant's admin consent"
# ADR-0071: the portal's own host name (portal.contoso.com by default) is the redirect URI, so the registration
# needs no portal deployment; without a host name of its own it needs pass 1's Container App address.
reset bootstrap-contoso-prod
run reg-early portal-registration
check "portal-registration before portal pass 1, own host name: noted, validated with the same input" \
  test "$(out_has reg-early 'Note: no portal deployment portal-contoso-prod yet' && echo y)$(cat "$tmp/reg-early.rc")" = y0
check "portal-registration before portal pass 1: SAF_INSTANCE_JSON is the example" \
  json_equal "$fake/inputs-entra-portal-prod-validate.json" "$examples/contoso-prod.portal-registration.json"
reset bootstrap-contoso-prod
sed -i '/^  hostEnvironment: prod/a\  hostName: ""' "$tmp/cwd/instance.yaml"
run reg-none portal-registration
check "portal-registration without a host name of its own or portal pass 1: exit 1, what to run first, nothing deployed" \
  test "$(out_has reg-none 'needs the Container App'"'"'s address: --portal-outputs <file>, the outputs of portal-contoso-prod' && echo y)$(cat "$tmp/reg-none.rc")" = y1
check "portal-registration without portal pass 1: no validate" az_lacks 'validate'

reset bootstrap-contoso-prod platform-contoso-prod
run alert audit-alert --action-group "$IDENTITY_TEAM"
check "audit-alert: what-if next to the host's platform workspace" \
  az_has "deployment group what-if --subscription $PROD --resource-group rg-contoso-platform-prod --name entra-audit-alert --parameters $params/entra-audit-alert.bicepparam"
check "audit-alert: SAF_INSTANCE_JSON is the example" json_equal "$fake/inputs-entra-audit-alert-what-if.json" "$examples/contoso.entra-audit-alert.json"
other_ws=/subscriptions/$NONPROD/resourceGroups/rg-identity-logs/providers/Microsoft.OperationalInsights/workspaces/log-identity
run alert-ws audit-alert --workspace "$other_ws"
check "audit-alert --workspace: its region read, the deployment in its group and subscription" \
  test "$(az_has "resource show --ids $other_ws --query location --output tsv" && az_has "deployment group what-if --subscription $NONPROD --resource-group rg-identity-logs --name entra-audit-alert --parameters $params/entra-audit-alert.bicepparam" && echo y)" = y
check "audit-alert without --action-group: says the identity team's is missing" out_has alert-ws "add the identity team's with --action-group"

# --- 2. bootstrap and its state -------------------------------------------------------------------
reset bootstrap-contoso-prod
run np1 bootstrap nonprod
check "bootstrap nonprod: the host's outputs read, what-if in nonprod's subscription" \
  test "$(az_has "$show_host" && az_has "deployment sub what-if --subscription $NONPROD --name bootstrap-contoso-nonprod --location westeurope --parameters $params/bootstrap.bicepparam" && echo y)" = y
check "bootstrap nonprod: SAF_INSTANCE_JSON is examples/contoso-nonprod.bootstrap.json" json_equal "$fake/inputs-bootstrap-contoso-nonprod-what-if.json" "$examples/contoso-nonprod.bootstrap.json"
check "bootstrap nonprod: needs Owner, the lock untouched by a what-if" \
  test "$(out_has np1 "Needs: Owner of subscription $NONPROD (environment nonprod)" && az_lacks '^lock ' && echo y)" = y
reset
run np-nohost bootstrap nonprod
check "bootstrap nonprod before the host: exit 1, bootstrap the host first, nothing deployed" \
  test "$(out_has np-nohost 'run instance.sh bootstrap prod --apply first' && az_lacks 'what-if' && echo y)$(cat "$tmp/np-nohost.rc")" = y1

reset "${ALL[@]}"
run p2 bootstrap prod --pass 2
check "bootstrap pass 2: the federation read by platform ado bootstrap plan --phase connections, with every bootstrap and the token" \
  grep -qE "^ado bootstrap plan --instance \./instance\.yaml --org-url https://dev\.azure\.com/contoso --phase connections --identities nonprod=[^ ]+/bootstrap-nonprod\.json --identities prod=[^ ]+/bootstrap-prod\.json --output [^ ]+/connections\.json token=set$" "$fake/platform.log"
check "bootstrap pass 2: SAF_INSTANCE_JSON is examples/contoso-prod.bootstrap.json (exit 1 of the plan is no failure)" \
  test "$(json_equal "$fake/inputs-bootstrap-contoso-prod-what-if.json" "$examples/contoso-prod.bootstrap.json" && echo y)$(cat "$tmp/p2.rc")" = y0
check "bootstrap pass 2: prints the federation, gets the token from az" \
  test "$(out_has p2 'Federation for infra/platform/bootstrap.bicep pass 2' && az_has 'account get-access-token --resource 499b84ac-1321-427f-aa17-267ca6975798 --query accessToken --output tsv' && echo y)" = y
check "the token never on a command line" test "$(grep -c fake-ado-token "$fake/platform.log" "$fake/az.log" | grep -vc ':0$')" = 0

# --- 3. the ReadOnly lock -------------------------------------------------------------------------
lock_show="lock show --subscription $PROD --resource-group rg-contoso-identities-prod --name lock-contoso-identities-readonly --output none"
reset "${ALL[@]}" lock
run lock-stop --apply bootstrap prod --pass 2
check "pass 2 --apply with the lock: exit 1, the removal command printed" \
  test "$(out_has lock-stop "  az lock delete --subscription $PROD --resource-group rg-contoso-identities-prod --name lock-contoso-identities-readonly" && echo y)$(cat "$tmp/lock-stop.rc")" = y1
check "pass 2 --apply with the lock: read, not deleted, nothing deployed" \
  test "$(az_has "$lock_show" && az_lacks 'lock delete|deployment sub create' && test -f "$fake/lock" && echo y)" = y
no_ado() { ! grep -q '^ado bootstrap' "$fake/platform.log"; }
check "pass 2 --apply with the lock: stops before reading Azure DevOps" no_ado
reset "${ALL[@]}" lock
run lock-p1 --apply bootstrap prod
check "pass 1 --apply on a bootstrapped environment: stops, says a re-run takes --pass 2" \
  test "$(out_has lock-p1 'a re-run takes --pass 2' && echo y)$(cat "$tmp/lock-p1.rc")" = y1
reset "${ALL[@]}" lock
run lock-rm --apply bootstrap prod --pass 2 --remove-lock
check "--remove-lock: lock deleted, then the deployment; exit 0" \
  test "$(order '^lock show' '^lock delete --subscription '"$PROD"' --resource-group rg-contoso-identities-prod --name lock-contoso-identities-readonly$' '^deployment sub create --subscription '"$PROD"' --name bootstrap-contoso-prod ' && echo y)$(cat "$tmp/lock-rm.rc")" = y0
check "--remove-lock: the script doesn't put the lock back after a success (the template does)" az_lacks '^lock create'
reset "${ALL[@]}" lock
SAF_FAKE_DEPLOY_RC=1 run lock-fail --apply bootstrap prod --pass 2 --remove-lock
check "--remove-lock and a failed deployment: the lock is put back, exit 1" \
  test "$(order '^lock delete' '^deployment sub create' '^lock create --subscription '"$PROD"' --resource-group rg-contoso-identities-prod --name lock-contoso-identities-readonly --lock-type ReadOnly --notes ' && test -f "$fake/lock" && echo y)$(cat "$tmp/lock-fail.rc")" = y1
reset bootstrap-contoso-prod
run fresh --apply bootstrap prod
check "a new environment (no lock): create, no lock delete" \
  test "$(az_has "deployment sub create --subscription $PROD --name bootstrap-contoso-prod --location westeurope --parameters $params/bootstrap.bicepparam --query properties.provisioningState --output tsv" && az_lacks 'lock delete' && echo y)$(cat "$tmp/fresh.rc")" = y0

# --- 4. ado ---------------------------------------------------------------------------------------
ado_phases() { sed -nE 's/^ado bootstrap (plan|apply) .*--phase ([a-z]+) .*/\1 \2/p' "$fake/platform.log" | paste -sd, -; }
reset "${ALL[@]}"
run ado-all ado all
check "ado all (pullRequest): projects, core, config, connections, pipeline, grants, policies, connections; plans" \
  test "$(ado_phases)" = "plan projects,plan core,plan config,plan connections,plan pipeline,plan grants,plan policies,plan connections"
check "ado all: phase core never pushes (no git or curl call)" test "$(grep -c '^git ' "$fake/git.log")$(grep -c . "$fake/curl.log")" = 00
check "ado all: the organisation and both bootstraps, the token set" \
  grep -qE "^ado bootstrap plan --instance \./instance\.yaml --org-url https://dev\.azure\.com/contoso --phase grants --identities nonprod=[^ ]+ --identities prod=[^ ]+ token=set$" "$fake/platform.log"
check "ado all: the blocked first connections is superseded by the second (exit 0)" rc_is ado-all 0
reset "${ALL[@]}"
sed -i 's/^  entraChanges: pullRequest$/  entraChanges: separate/' "$tmp/cwd/instance.yaml"
SAF_FAKE_FIRST_CONNECTIONS_RC=1 run ado-sep --apply ado all
check "ado all --apply (separate): seven phases applied, connections once; its exit 1 is the result" \
  test "$(ado_phases)$(cat "$tmp/ado-sep.rc")" = "apply projects,apply core,apply config,apply connections,apply pipeline,apply grants,apply policies1"
reset
run ado-projects --apply ado projects
check "ado projects --apply before any bootstrap: the one phase, no identities, no bootstrap read, Create new projects named" \
  test "$(ado_phases)$(grep -c -- '--identities' "$fake/platform.log")$(grep -c 'deployment sub show' "$fake/az.log")$(out_has ado-projects 'Needs: Create new projects in the Azure DevOps organisation' && echo y)$(cat "$tmp/ado-projects.rc")" = "apply projects00y0"
reset
run ado-config ado config
check "ado config before any bootstrap: the one phase, no identities, no bootstrap read" \
  test "$(ado_phases)$(grep -c -- '--identities' "$fake/platform.log")$(grep -c 'deployment sub show' "$fake/az.log")$(cat "$tmp/ado-config.rc")" = "plan config000"
reset bootstrap-contoso-prod
TEST_ADO_TOKEN=preset run ado-one --apply ado grants
check "ado grants --apply: one phase; a missing bootstrap is noted, not passed" \
  test "$(ado_phases),$(out_has ado-one 'Note: no bootstrap of nonprod yet' && echo y)" = "apply grants,y"
check "ado with AZURE_DEVOPS_TOKEN set: no token from az" az_lacks 'get-access-token'

# --- 5. sync --------------------------------------------------------------------------------------
reset bootstrap-contoso-prod entra-portal-prod
sed -i 's/00000000-0000-0000-0000-00000000e101/00000000-0000-0000-0000-00000000e999/' "$tmp/cwd/instance.yaml"
run sync sync
check "sync: the registration read from Azure, platform instance sync without --write" \
  test "$(az_has "deployment group show --subscription $PROD --resource-group rg-contoso-entra --name entra-portal-prod --query $succeeded_q --output json" && grep -qE '^instance sync --instance \./instance\.yaml --outputs prod=[^ ]+ --registration [^ ]+ token=$' "$fake/platform.log" && echo y)" = y
check "sync: instance.yaml unchanged without --apply" grep -q 'clientId: 00000000-0000-0000-0000-00000000e999' "$tmp/cwd/instance.yaml"
check "sync without a portal deployment: noted, no --portal-outputs" \
  test "$(out_has sync 'Note: no portal deployment yet (portal-contoso-prod): portal.apiBaseUrl stays as it is.' && echo y)$(grep -c -- '--portal-outputs' "$fake/platform.log")" = y0
run sync-apply --apply sync
check "sync --apply: portal.clientId written, instance.yaml as the example again" cmp -s "$tmp/cwd/instance.yaml" "$repo/config/examples/instance.example.yaml"
reset bootstrap-contoso-prod entra-portal-prod portal-contoso-prod
sed -i '/^  apiBaseUrl: /d' "$tmp/cwd/instance.yaml"
run sync-url --apply sync
check "sync --apply with the portal deployment: portal.apiBaseUrl from its portalUrl" \
  test "$(az_has "deployment sub show --subscription $PROD --name portal-contoso-prod --query $succeeded_q --output json" \
    && grep -qE '^instance sync --instance \./instance\.yaml --outputs prod=[^ ]+ --registration [^ ]+ --portal-outputs [^ ]+ --write token=$' "$fake/platform.log" \
    && grep -c '^  apiBaseUrl: https://portal\.contoso\.com$' "$tmp/cwd/instance.yaml")" = 1
reset bootstrap-contoso-prod entra-portal-prod portal-contoso-prod
sed -i 's|^  apiBaseUrl: .*|  apiBaseUrl: https://saf.contoso.org|' "$tmp/cwd/instance.yaml"
run sync-kept --apply sync
check "sync --apply keeps another apiBaseUrl set by hand" \
  test "$(out_has sync-kept "kept https://saf.contoso.org (set by hand; the portal's own host name is https://portal.contoso.com)" && grep -c '^  apiBaseUrl: https://saf.contoso.org$' "$tmp/cwd/instance.yaml")" = 1

# --- 6. preflight ---------------------------------------------------------------------------------
reset
run pre preflight
check "preflight: exit 0 when nothing blocks" rc_is pre 0
check "preflight: tenant, subscriptions, Owner, providers, policies, quota" \
  test "$(out_has pre 'ok     logged in to the instance'"'"'s tenant' && out_has pre "ok     subscription $NONPROD (environments: nonprod) is reachable." \
    && out_has pre "ok     Owner on $PROD" && out_has pre "ok     the 15 resource providers are registered in $PROD." \
    && out_has pre 'info     Allowed locations (Default' && out_has pre "ok     Container Apps environments in westeurope ($PROD): 3 of 50 used; this instance needs up to 3." && echo y)" = y
check "preflight: CAA of every dns.zones zone, a set without digicert.com warned" \
  test "$(out_has pre 'warn   CAA of contoso.com (at contoso.com) doesn'"'"'t allow digicert.com' && out_has pre 'ok     no CAA record for contoso.eu or above' && echo y)" = y
check "preflight: PostgreSQL and Azure SQL allowed in each subscription and region" \
  test "$(out_has pre "ok     PostgreSQL Flexible Server can be created in westeurope ($PROD)." && out_has pre "ok     Azure SQL can be created in westeurope ($NONPROD)." && echo y)" = y
check "preflight: read-only (no create, delete, register, lock, what-if or validate)" az_lacks 'create|delete|register|^lock |what-if|validate'
reset
SAF_FAKE_DB_RESTRICTED="postgres azureSql" run pre-db preflight
check "preflight: a subscription restricted from PostgreSQL or Azure SQL in a region blocks, with the support request; exit 1" \
  test "$(out_has pre-db "BLOCK  PostgreSQL Flexible Server can't be created in westeurope ($PROD): Provisioning is restricted in this region." \
    && out_has pre-db "Ask for region access: a support request of type Service and subscription limits (quotas), PostgreSQL Flexible Server, region westeurope" \
    && out_has pre-db "BLOCK  Azure SQL can't be created in westeurope ($NONPROD): status Disabled." && echo y)$(cat "$tmp/pre-db.rc")" = y1
reset
SAF_FAKE_TENANT=00000000-0000-0000-0000-000000000002 run pre-tenant preflight
check "preflight: another tenant blocks (exit 1)" \
  test "$(out_has pre-tenant 'BLOCK  logged in to tenant 00000000-0000-0000-0000-000000000002' && echo y)$(cat "$tmp/pre-tenant.rc")" = y1
reset
SAF_FAKE_UNREGISTERED=Microsoft.Cdn SAF_FAKE_ROLES=Reader SAF_FAKE_UNREACHABLE=$NONPROD SAF_FAKE_CAES=49 run pre-block preflight
check "preflight: an unregistered provider blocks, naming instance.sh providers --apply and the az command" \
  out_has pre-block "BLOCK  resource provider Microsoft.Cdn is not registered in $PROD: instance.sh providers --apply (or az provider register --subscription $PROD --namespace Microsoft.Cdn)"
check "preflight: an unreachable subscription blocks; no Owner and a tight quota warn; exit 1" \
  test "$(out_has pre-block "BLOCK  subscription $NONPROD (environments: nonprod) is not reachable" && out_has pre-block "warn   no active Owner on $PROD" \
    && out_has pre-block 'warn   Container Apps environments in westeurope' && echo y)$(cat "$tmp/pre-block.rc")" = y1

# --- 7. the CLI fallback and usage ----------------------------------------------------------------
reset
PATH_MODE=no-platform run fallback roles
check "without platform on PATH: the core checkout's CLI" \
  test "$(az_has "deployment sub what-if --subscription $PROD --name roles-contoso --location westeurope --parameters $params/roles.bicepparam" && echo y)$(cat "$tmp/fallback.rc")" = y0
check "without platform on PATH: the fake platform was not called" test ! -s "$fake/platform.log"
reset
run u1 nope
run u2 roles --pass 2
run u3 bootstrap
run u4 --apply preflight
run u5 ado everything
run u6 --instance missing.yaml roles
check "usage: unknown subcommand, an option of another subcommand, a missing argument, preflight --apply, a bad phase: exit 2" \
  test "$(cat "$tmp/u1.rc")$(cat "$tmp/u2.rc")$(cat "$tmp/u3.rc")$(cat "$tmp/u4.rc")$(cat "$tmp/u5.rc")" = 22222
check "a missing instance file: exit 1" test "$(cat "$tmp/u6.rc")" = 1
check "no az call outside the fake's list" test ! -s "$fake/unexpected.log"

# --- 8. core: the release from the releases repository (ADR-0067) ---------------------------------
CORE_URL=https://dev.azure.com/contoso/Platform/_git/core
RELEASES=https://github.com/contoso/simple-apps-foundry-releases
release_commit=""
release_main=""
# make_release <version> [extra-file|changed-file|wrong-mirror]: the releases repository (bare, in $fake/github) with
# main (its README) and the tag <version> at a mirror commit without a parent, and the release's downloads.
make_release() {
  local v="$1" variant="${2:-}" src="$tmp/release-src" dl="$fake/download/$1" tree mirror
  rm -rf "$src"
  fgit init --quiet "$src"
  printf '# Releases\n' > "$src/README.md"
  fgit -C "$src" add README.md
  fgit -C "$src" commit --quiet -m README
  release_main="$(fgit -C "$src" rev-parse HEAD)"
  fgit -C "$src" checkout --quiet --orphan mirror
  fgit -C "$src" rm --quiet -r --cached .
  rm "$src/README.md"
  mkdir -p "$src/pipelines/azure-devops/scripts" "$src/infra/app" "$src/tools/platform-cli" "$dl"
  printf 'stages: []\n' > "$src/pipelines/azure-devops/app-delivery.yml"
  printf '#!/usr/bin/env bash\necho run\n' > "$src/pipelines/azure-devops/scripts/run.sh"
  chmod +x "$src/pipelines/azure-devops/scripts/run.sh"
  printf 'param x string\n' > "$src/infra/app/release.bicep"
  printf '{ "version": "%s" }\n' "${v#v}" > "$src/tools/platform-cli/package.json"
  (cd "$src" && find . -type f -not -path './.git/*' | sed 's#^\./##' | LC_ALL=C sort | while IFS= read -r f; do sha256sum "$f"; done) > "$dl/saf-core-$v-pipelines.sha256"
  case "$variant" in
    extra-file) printf 'not listed\n' > "$src/infra/extra.txt" ;;
    changed-file) printf 'param y string\n' > "$src/infra/app/release.bicep" ;;
  esac
  fgit -C "$src" add -A
  fgit -C "$src" commit --quiet -m "SAF core $v"
  release_commit="$(fgit -C "$src" rev-parse HEAD)"
  tree="$(fgit -C "$src" rev-parse 'HEAD^{tree}')"
  fgit -C "$src" tag "$v"
  mirror="$release_commit"
  if [ "$variant" = wrong-mirror ]; then mirror="$release_main"; fi
  mkdir -p "$fake/github/contoso"
  fgit clone --quiet --bare "$src" "$fake/github/contoso/simple-apps-foundry-releases.git"
  printf '{\n  "formatVersion": 2,\n  "version": "%s",\n  "commit": "%s",\n  "mirror": { "commit": "%s", "tree": "%s" }\n}\n' \
    "$v" "$(printf 'c%.0s' {1..40})" "$mirror" "$tree" > "$dl/release.json"
  (cd "$dl" && sha256sum release.json "saf-core-$v-pipelines.sha256" && printf '%s  simple-apps-foundry-platform-cli-%s.tgz\n' "$(printf '0%.0s' {1..64})" "${v#v}") > "$dl/SHA256SUMS"
}
core_ref() { fgit -C "$fake/ado/core" rev-parse --verify --quiet "$1" 2> /dev/null || true; }
git_pushes() { grep -E '^git .* push ' "$fake/git.log" || true; }
# pushes_between_applies: exactly two pushes, after the first apply of phase core and before the second.
pushes_between_applies() {
  local first second
  first="$(grep -n '^platform ado bootstrap apply --phase core$' "$fake/git.log" | sed -n 1p | cut -d: -f1)"
  second="$(grep -n '^platform ado bootstrap apply --phase core$' "$fake/git.log" | sed -n 2p | cut -d: -f1)"
  [ -n "$first" ] && [ -n "$second" ] || return 1
  awk -v a="$first" -v b="$second" '/^git .* push / { if (NR < a || NR > b) bad = 1; n++ } END { exit (bad || n != 2) }' "$fake/git.log"
}

reset
make_release v0.1.0
run core-plan core
check "core: release.json, SHA256SUMS and the list downloaded from the GitHub Release of coreVersion, with --fail --location --proto =https" \
  test "$(grep -cE "^curl --fail --location --proto =https .* $RELEASES/releases/download/v0\.1\.0/(release\.json|SHA256SUMS|saf-core-v0\.1\.0-pipelines\.sha256)$" "$fake/curl.log")" = 3
check "core: the tag fetched anonymously (no token, no credential helper)" \
  grep -qE "^git -c credential.helper= -C [^ ]+/releases.git fetch --quiet --no-tags $RELEASES.git \+refs/tags/v0.1.0:refs/tags/v0.1.0 header=no key=$" "$fake/git.log"
check "core plan: the checks pass, then the plan of phase core and what would be pushed; exit 0" \
  test "$(out_has core-plan "ok     release.json and saf-core-v0.1.0-pipelines.sha256 match SHA256SUMS." && out_has core-plan "ok     the mirror commit's 4 files are exactly the pipelines list" \
    && out_has core-plan "Plan: create the repository core, then push $RELEASES's main as refs/heads/main (fast-forward only) and the mirror commit $release_commit as refs/tags/v0.1.0" \
    && out_has core-plan "Needs: Azure DevOps Project Administrator of the platform project Platform" && echo y)$(cat "$tmp/core-plan.rc")" = y0
check "core plan: platform ado bootstrap plan --phase core only, nothing created or pushed" \
  test "$(ado_phases)|$(git_pushes)|$([ -d "$fake/ado/core" ] || echo none)" = "plan core||none"
run core-apply --apply core
check "core --apply: phase core applied, main and the tag pushed, phase core applied again; exit 0" \
  test "$(ado_phases)$(cat "$tmp/core-apply.rc")" = "plan core,plan core,apply core,apply core0"
check "core --apply: core's tag is the mirror commit, its main the releases repository's main" \
  test "$(core_ref refs/tags/v0.1.0) $(core_ref refs/heads/main)" = "$release_commit $release_main"
check "core --apply: the two pushes between the two applies of phase core" pushes_between_applies
check "core --apply: main fast-forward only and the tag, never forced" \
  test "$(git_pushes | sed -E 's/ header=.*//; s#^git -C [^ ]+ push --quiet ##' | paste -sd '|' -)" = "$CORE_URL refs/heads/main:refs/heads/main|$CORE_URL $release_commit:refs/tags/v0.1.0"
check "core --apply: the token only in the environment, as an extra header for the organisation's URLs (two pushes, one ls-remote)" \
  test "$(grep -c "$CORE_URL.* header=env key=http.https://dev.azure.com/contoso/.extraheader$" "$fake/git.log") $(grep -c 'fake-ado-token' "$fake/git.log" "$fake/platform.log" "$fake/curl.log" | grep -vc ':0$')" = "3 0"
check "core --apply: the releases repository never gets the token" \
  test -z "$(grep "$RELEASES" "$fake/git.log" | grep -v 'header=no key=$' || true)"
check "core --apply: says the tag is protected" out_has core-apply "core has refs/tags/v0.1.0 at $release_commit, protected."
: > "$fake/git.log"
: > "$fake/platform.log"
run core-again --apply core
check "core again: the tag at the release's commit, nothing to push; the protection applied again; exit 0" \
  test "$(out_has core-again 'nothing to push' && echo y)|$(git_pushes)|$(ado_phases)|$(cat "$tmp/core-again.rc")" = "y||plan core,apply core|0"
run core-again-plan core
check "core again without --apply: a plan only, exit 0" test "$(ado_phases)|$(cat "$tmp/core-again-plan.rc")" = "plan core,apply core,plan core|0"

reset
make_release v0.1.0
fgit init --quiet --bare "$fake/ado/core"
fgit -C "$tmp/release-src" push --quiet "$fake/ado/core" "main:refs/tags/v0.1.0"
run core-moved --apply core
check "core: the tag at another commit is an incident: exit 2, nothing pushed or applied" \
  test "$(out_has core-moved "core has the tag v0.1.0 at $release_main, not at the release's mirror commit $release_commit." && out_has core-moved 'A moved or foreign tag is an incident' && echo y)|$(git_pushes)|$(ado_phases)|$(cat "$tmp/core-moved.rc")" = "y||plan core|2"
check "core: the foreign tag stays as it is" test "$(core_ref refs/tags/v0.1.0)" = "$release_main"

reset
make_release v0.1.0
fgit init --quiet --bare "$fake/ado/core"
fgit -C "$tmp/release-src" push --quiet "$fake/ado/core" "mirror:refs/heads/main"
run core-own-main --apply core
check "core with a main of its own (an older instance): main stays (never forced), the tag is pushed; exit 0" \
  test "$(out_has core-own-main "Note: core's main ($release_commit) is not an ancestor" && echo y)|$(core_ref refs/heads/main)|$(core_ref refs/tags/v0.1.0)|$(cat "$tmp/core-own-main.rc")" = "y|$release_commit|$release_commit|0"

reset
make_release v0.1.0
printf 'tampered\n' >> "$fake/download/v0.1.0/saf-core-v0.1.0-pipelines.sha256"
run core-sum core
check "core: a download that fails SHA256SUMS: exit 1 before Azure DevOps and git" \
  test "$(out_has core-sum "the download of v0.1.0 doesn't match its SHA256SUMS" && echo y)|$(grep -c '^ado bootstrap' "$fake/platform.log")|$(grep -c '^git ' "$fake/git.log")|$(cat "$tmp/core-sum.rc")" = "y|0|0|1"

reset
make_release v0.1.0 extra-file
run core-extra core
check "core: a file in the mirror commit outside the pipelines list: exit 1, nothing read from Azure DevOps" \
  test "$(out_has core-extra 'the mirror commit of v0.1.0 has files outside the pipelines list (infra/extra.txt)' && echo y)|$(grep -c '^ado bootstrap' "$fake/platform.log")|$(cat "$tmp/core-extra.rc")" = "y|0|1"
reset
make_release v0.1.0 changed-file
run core-changed core
check "core: a file of the mirror commit that differs from its list entry: exit 1" \
  test "$(out_has core-changed "the mirror commit of v0.1.0 doesn't match its pipelines list" && echo y)|$(cat "$tmp/core-changed.rc")" = "y|1"
reset
make_release v0.1.0 wrong-mirror
run core-wrong core
check "core: the tag not at release.json's mirror commit: exit 1" \
  test "$(out_has core-wrong "the tag v0.1.0 of $RELEASES is at $release_commit, but release.json's mirror.commit is $release_main" && echo y)|$(cat "$tmp/core-wrong.rc")" = "y|1"

reset
make_release v0.2.0-rc.1
run core-version core v0.2.0-rc.1
check "core <version>: that release instead of coreVersion" \
  test "$(grep -c "download/v0.2.0-rc.1/" "$fake/curl.log")|$(out_has core-version 'as refs/tags/v0.2.0-rc.1' && echo y)|$(cat "$tmp/core-version.rc")" = "3|y|0"
run core-missing core v0.3.0
check "core: a version without a GitHub Release: exit 1, with the question" \
  test "$(out_has core-missing 'could not download release.json of v0.3.0' && echo y)|$(cat "$tmp/core-missing.rc")" = "y|1"
run core-bad core 0.2.0
run core-two core v0.1.0 v0.2.0
check "core: not a version, or two: exit 2" test "$(cat "$tmp/core-bad.rc")$(cat "$tmp/core-two.rc")" = 22

reset
sed -i '/^coreReleases:/,/^  repository:/d' "$tmp/cwd/instance.yaml"
run core-unset core
check "core without coreReleases.repository: exit 1, what to set, nothing downloaded" \
  test "$(out_has core-unset 'instance.yaml has no coreReleases.repository' && echo y)|$(grep -c . "$fake/curl.log")|$(cat "$tmp/core-unset.rc")" = "y|0|1"

# --- 9. providers ---------------------------------------------------------------------------------
missing_providers="Microsoft.Cdn $NONPROD:Microsoft.App"
reset
SAF_FAKE_UNREGISTERED="$missing_providers" run prov providers
check "providers: says which right it needs" \
  out_has prov 'Needs: the preview reads (Reader); --apply needs a role with */register/action (Contributor or Owner) on each environment subscription'
check "providers: one plan line per missing provider and subscription; one list per subscription; exit 0" \
  test "$(grep -c '^plan ' "$tmp/prov.out")|$(grep -c '^provider list ' "$fake/az.log")|$(out_has prov "plan   register the resource provider Microsoft.App in $NONPROD (environments: nonprod)." \
    && out_has prov "plan   register the resource provider Microsoft.Cdn in $NONPROD (environments: nonprod)." \
    && out_has prov "plan   register the resource provider Microsoft.Cdn in $PROD (environments: prod)." && echo y)|$(cat "$tmp/prov.rc")" = "3|2|y|0"
check "providers: the preview registers nothing" az_lacks '^provider (register|show)'
SAF_FAKE_UNREGISTERED="$missing_providers" run prov-apply --apply providers
check "providers --apply: only the missing ones registered, with --wait" \
  test "$(grep '^provider register ' "$fake/az.log" | paste -sd '|' -)" = "provider register --subscription $NONPROD --namespace Microsoft.App --wait|provider register --subscription $NONPROD --namespace Microsoft.Cdn --wait|provider register --subscription $PROD --namespace Microsoft.Cdn --wait"
check "providers --apply: each state read back and reported; exit 0" \
  test "$(az_has "provider show --subscription $PROD --namespace Microsoft.Cdn --query registrationState --output tsv" \
    && out_has prov-apply "ok     Microsoft.App is Registered in $NONPROD." && out_has prov-apply "ok     Microsoft.Cdn is Registered in $PROD." && echo y)$(cat "$tmp/prov-apply.rc")" = y0
: > "$fake/az.log"
SAF_FAKE_UNREGISTERED="$missing_providers" run prov-after providers
check "providers afterwards: nothing missing in either subscription, nothing registered, exit 0" \
  test "$(out_has prov-after "ok     the 15 resource providers are registered in $NONPROD (environments: nonprod)." \
    && out_has prov-after "ok     the 15 resource providers are registered in $PROD (environments: prod)." && az_lacks '^provider register' && echo y)$(cat "$tmp/prov-after.rc")" = y0
reset
SAF_FAKE_UNREGISTERED="Microsoft.App Microsoft.Cdn" SAF_FAKE_REGISTER_FAIL=Microsoft.Cdn SAF_FAKE_REGISTERING=Microsoft.App run prov-fail --apply providers
check "providers --apply: a refused registration and one still Registering block, the others go on; exit 1" \
  test "$(out_has prov-fail "BLOCK  could not register Microsoft.Cdn in $PROD: ERROR: (AuthorizationFailed)" \
    && out_has prov-fail "BLOCK  Microsoft.App is Registering in $NONPROD after az provider register --wait" && echo y)|$(grep -c '^provider register ' "$fake/az.log")|$(cat "$tmp/prov-fail.rc")" = "y|4|1"

# --- 10. dns --------------------------------------------------------------------------------------
DNS_SUB=00000000-0000-0000-0000-00000000d001
ZONE_ID=/subscriptions/$DNS_SUB/resourceGroups/rg-dns/providers/Microsoft.Network/dnszones/contoso.com
PROD_PID=00000000-0000-0000-0000-00000000f012
NONPROD_PID=00000000-0000-0000-0000-00000000f002
# dns_zone: the resource group rg-dns and the zone contoso.com exist (dns_group: the group only).
dns_group() { mkdir -p "$fake/dns/$DNS_SUB/rg-dns"; }
dns_zone() {
  dns_group
  printf 'ns1-01.azure-dns.example.\nns2-01.azure-dns.example.\nns3-01.azure-dns.example.\nns4-01.azure-dns.example.\n' > "$fake/dns/$DNS_SUB/rg-dns/contoso.com"
}
assign() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$fake/assignments"; } # assign <principal> <role> <scope>
last_dns_call() { grep '^network dns ' "$fake/az.log" | tail -n 1 | cut -d' ' -f1-4; }

reset bootstrap-contoso-prod bootstrap-contoso-nonprod
dns_zone
assign "$PROD_PID" "DNS Zone Contributor" "$ZONE_ID"
assign "$NONPROD_PID" Contributor "/subscriptions/$NONPROD"
assign "$NONPROD_PID" Reader "/subscriptions/$DNS_SUB/resourceGroups/rg-dns"
assign "$NONPROD_PID" "DNS Zone Contributor" "/subscriptions/$DNS_SUB/resourceGroups/rg-dns/providers/Microsoft.Network/dnszones/contoso.co"
run dns dns
check "dns: says which right it needs, and that it grants no role" \
  test "$(out_has dns 'Needs: read access to each Azure DNS zone of dns.zones' && out_has dns "It grants no role: DNS Zone Contributor on a zone is the DNS team's step." && echo y)" = y
check "dns: the zone read by its ID's subscription, group and name; ok" \
  test "$(az_has "network dns zone show --subscription $DNS_SUB --resource-group rg-dns --name contoso.com --query nameServers --output tsv" \
    && out_has dns "ok     the zone contoso.com exists (resource group rg-dns, subscription $DNS_SUB)." && echo y)" = y
check "dns: the NS record set for the delegation, relative to the parent zone and as an FQDN" \
  test "$(out_has dns 'info   the delegation of contoso.com: the owner of its parent zone com adds this NS record set' \
    && out_has dns '         contoso NS ns1-01.azure-dns.example. ns2-01.azure-dns.example. ns3-01.azure-dns.example. ns4-01.azure-dns.example.' \
    && out_has dns '         contoso.com. NS ns1-01.azure-dns.example. ns2-01.azure-dns.example. ns3-01.azure-dns.example. ns4-01.azure-dns.example.' && echo y)" = y
check "dns: each allowed environment's provisioning identity's roles listed in the zone's subscription" \
  test "$(az_has "role assignment list --subscription $DNS_SUB --assignee-object-id $PROD_PID --all --include-inherited --fill-principal-name false --query [].[roleDefinitionName, scope] --output tsv" \
    && az_has "role assignment list --subscription $DNS_SUB --assignee-object-id $NONPROD_PID --all --include-inherited --fill-principal-name false --query [].[roleDefinitionName, scope] --output tsv" && echo y)" = y
check "dns: DNS Zone Contributor on the zone is ok" \
  out_has dns "ok     id-contoso-provisioning-prod (prod) holds DNS Zone Contributor on $ZONE_ID: it may write records in contoso.com."
check "dns: a role in another subscription, a weaker role, or one on a zone whose ID is a string prefix: warn with the grant command; exit 0" \
  test "$(out_has dns "warn   id-contoso-provisioning-nonprod (nonprod) holds no DNS Zone Contributor, Contributor or Owner on contoso.com or above; the DNS team grants it (onboarding step 2): az role assignment create --role \"DNS Zone Contributor\" --assignee-object-id $NONPROD_PID --assignee-principal-type ServicePrincipal --scope $ZONE_ID" \
    && echo y)$(cat "$tmp/dns.rc")" = y0
check "dns: an existing zone only read; no role granted; the manual zone not read" az_lacks 'create|delete|update|contoso\.eu'
: > "$fake/assignments"
assign "$PROD_PID" Contributor "/subscriptions/00000000-0000-0000-0000-00000000D001/resourceGroups/RG-DNS"
assign "$NONPROD_PID" Owner /providers/Microsoft.Management/managementGroups/contoso
run dns-above --apply dns
check "dns --apply on an existing zone: only read; a role on its group (any case) or a management group is ok; exit 0" \
  test "$(az_lacks 'create|delete|update' && out_has dns-above "ok     id-contoso-provisioning-prod (prod) holds Contributor on /subscriptions/00000000-0000-0000-0000-00000000D001/resourceGroups/RG-DNS:" \
    && out_has dns-above 'ok     id-contoso-provisioning-nonprod (nonprod) holds Owner on /providers/Microsoft.Management/managementGroups/contoso:' && echo y)$(cat "$tmp/dns-above.rc")" = y0

reset bootstrap-contoso-prod
dns_group
run dns-nozone dns
check "dns without the zone: the preview plans the zone only, creates nothing, lists no role; exit 0" \
  test "$(out_has dns-nozone "plan   create the DNS zone contoso.com in the resource group rg-dns (subscription $DNS_SUB; DNS zones are global)." \
    && az_lacks 'create|^role ' && echo y)$(cat "$tmp/dns-nozone.rc")" = y0
run dns-nozone-apply --apply dns
check "dns --apply without the zone: the zone created (--if-none-match), not the group, then read back" \
  test "$(az_has "network dns zone create --subscription $DNS_SUB --resource-group rg-dns --name contoso.com --if-none-match --output none" \
    && az_lacks '^group create' && echo y)|$(last_dns_call)" = "y|network dns zone show"
check "dns --apply without the zone: says so, prints its NS records, checks the roles; exit 0" \
  test "$(out_has dns-nozone-apply "ok     created the zone contoso.com (resource group rg-dns, subscription $DNS_SUB)." \
    && out_has dns-nozone-apply '         contoso.com. NS ns1-03.azure-dns.example. ns2-03.azure-dns.example. ns3-03.azure-dns.example. ns4-03.azure-dns.example.' \
    && out_has dns-nozone-apply 'warn   id-contoso-provisioning-prod (prod) holds no DNS Zone Contributor' \
    && out_has dns-nozone-apply 'info   no bootstrap of nonprod yet (bootstrap-contoso-nonprod)' && echo y)$(cat "$tmp/dns-nozone-apply.rc")" = y0

reset
run dns-norg dns
check "dns without the group: the preview plans the group in the portal host's region, then the zone; creates nothing; exit 0" \
  test "$(out_has dns-norg "plan   create the resource group rg-dns in subscription $DNS_SUB (westeurope, the portal host's region), then the DNS zone contoso.com in it (DNS zones are global)." \
    && az_lacks 'create' && echo y)$(cat "$tmp/dns-norg.rc")" = y0
run dns-norg-apply --apply dns
check "dns --apply without the group: the group, then the zone; no bootstrap, so no role listed; exit 0" \
  test "$(order "^group create --subscription $DNS_SUB --name rg-dns --location westeurope --output none\$" \
    "^network dns zone create --subscription $DNS_SUB --resource-group rg-dns --name contoso.com --if-none-match --output none\$" \
    && az_lacks '^role ' && echo y)$(cat "$tmp/dns-norg-apply.rc")" = y0
: > "$fake/az.log"
run dns-again --apply dns
check "dns --apply again: the zone it created is only read; exit 0" test "$(az_lacks 'create' && echo y)$(cat "$tmp/dns-again.rc")" = y0

reset
SAF_FAKE_DNS_ERROR=1 run dns-err --apply dns
check "dns: a read error other than not found blocks and creates nothing; exit 1" \
  test "$(out_has dns-err 'BLOCK  could not read the zone contoso.com: ERROR: (AuthorizationFailed)' && az_lacks 'create' && echo y)$(cat "$tmp/dns-err.rc")" = y1
reset
dns_zone
sed -i 's#/dnszones/contoso\.com$#/dnszones/contoso.org#' "$tmp/cwd/instance.yaml"
run dns-badid --apply dns
check "dns: an azureDnsZoneId that isn't the zone's blocks, nothing read or created; exit 1" \
  test "$(out_has dns-badid 'BLOCK  the azureDnsZoneId of contoso.com is not the resource ID of a DNS zone named contoso.com' \
    && az_lacks '^network |^group ' && echo y)$(cat "$tmp/dns-badid.rc")" = y1
reset
sed -i 's/^      provider: azureDns$/      provider: manual/' "$tmp/cwd/instance.yaml"
run dns-none dns
check "dns without an Azure DNS zone: ok, nothing read; exit 0" \
  test "$(out_has dns-none 'ok     dns.zones has no Azure DNS zone (provider: azureDns): nothing to do.' && az_lacks '^network ' && echo y)$(cat "$tmp/dns-none.rc")" = y0

# --- 11. plan and status (ADR-0072) ---------------------------------------------------------------
reset
run plan plan
check "plan: every phase and step, the instance's host filled in; exit 0" \
  test "$(out_has plan 'Phase base: Base deployment' && out_has plan 'Phase setup: Initial platform configuration' && out_has plan '  B01  Write the decisions into instance.yaml' \
    && out_has plan '       $ instance.sh bootstrap prod' && out_has plan '       $ instance.sh bootstrap nonprod --pass 2' && out_has plan '  S01  ' && echo y)$(cat "$tmp/plan.rc")" = y0
check "plan: reads nothing (no az, curl or Azure DevOps call)" \
  test "$(grep -c . "$fake/az.log")$(grep -c . "$fake/curl.log")$(grep -c '^ado ' "$fake/platform.log")" = 000
run plan-md plan --format markdown
check "plan --format markdown: the runbook's checklist" \
  test "$(out_has plan-md '- [ ] **B01** Write the decisions into instance.yaml and validate it' && out_has plan-md '[step 4](#4-identities-azure-side)' && echo y)$(cat "$tmp/plan-md.rc")" = y0
STDOUT_ONLY=1 run plan-json plan --format json --lang cs
check "plan --format json: the definition, both titles" \
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); process.exit(j.formatVersion === 1 && j.steps.length > 30 && j.steps[0].id === "B01" && j.steps[0].title.cs && j.phases.map((p) => p.id).join() === "base,setup" ? 0 : 1)' "$tmp/plan-json.out"
run plan-cs plan --lang cs
check "plan --lang cs: the Czech titles" out_has plan-cs 'Fáze base: Základní nasazení'
rm "$tmp/cwd/instance.yaml"
run plan-none plan
check "plan without an instance file: the generic plan (<host>); exit 0" \
  test "$(out_has plan-none '       $ instance.sh bootstrap <host>' && echo y)$(cat "$tmp/plan-none.rc")" = y0
reset
run plan-apply --apply plan
run status-apply --apply status
run plan-format-roles --format json roles
run status-bad-lang status --lang de
check "usage: plan or status with --apply, --format for another subcommand: exit 2; a bad --lang: exit 2" \
  test "$(cat "$tmp/plan-apply.rc")$(cat "$tmp/status-apply.rc")$(cat "$tmp/plan-format-roles.rc")$(cat "$tmp/status-bad-lang.rc")" = 2222

# ado_rows <phase> <row>...: the rows the fake plan of a phase prints; ado_out <phase> <json>: its --output.
ado_rows() {
  local phase="$1"
  shift
  mkdir -p "$fake/ado-rows"
  printf '%s\n' "$@" > "$fake/ado-rows/$phase"
}
ado_out() {
  mkdir -p "$fake/ado-out"
  printf '%s\n' "$2" > "$fake/ado-out/$1.json"
}
status_reads_only() { az_lacks 'create|delete|update|register|^lock |what-if|validate' && ! grep -q '^ado bootstrap apply' "$fake/platform.log"; }
reads_once() { # reads_once <deployment>: one `az deployment ... show` of it
  test "$(grep -cE "^deployment (sub|group) show .*--name $1 " "$fake/az.log")" = 1
}
json_field() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(process.argv[2].split(".").reduce((v, k) => (v == null ? v : v[k]), j))' "$tmp/$1.out" "$2"; }
step_status() { node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(j.steps.find((s) => s.id === process.argv[2]).status)' "$tmp/$1.out" "$2"; }

reset
ado_rows projects 'create  project             Platform' 'create  project             Apps'
run st-new status
check "status of a new instance: the current step B02 (the security team), the next one B08 (dns --apply); exit 0" \
  test "$(out_has st-new "Onboarding of contoso (core v0.1.0): phase base, step B02" && out_has st-new 'Next: B08 Create the Azure DNS zones and have them delegated' \
    && out_has st-new '           $ instance.sh dns --apply' && echo y)$(cat "$tmp/st-new.rc")" = y0
check "status of a new instance: projects to create, the later phases skipped (no bootstrap), later steps blocked" \
  test "$(out_has st-new 'next     B09  Create the Azure DevOps projects' && out_has st-new 'blocked  B13  Bootstrap every other environment (pass 1) (waits for B12)' && echo y)|$(sed -nE 's/^ado bootstrap (plan|apply) .*--phase ([a-z]+) .*/\1 \2/p' "$fake/platform.log" | paste -sd, -)" = "y|plan projects,plan core,plan config"
check "status: only reads; each deployment once; the token only in the environment" \
  test "$(status_reads_only && reads_once bootstrap-contoso-prod && reads_once portal-contoso-prod && reads_once entra-portal-prod && reads_once roles-contoso && echo y)$(grep -c fake-ado-token "$fake/platform.log" "$fake/az.log" | grep -vc ':0$')" = y0
check "status: platform instance status with the state it read" grep -qE '^instance status --instance \./instance\.yaml --state [^ ]+ token=$' "$fake/platform.log"
check "status: no az call outside the fake's list" test ! -s "$fake/unexpected.log"

reset
SAF_FAKE_NOT_LOGGED_IN=1 STDOUT_ONLY=1 run st-nologin status --format json
check "status not logged in: B03 next with az login, Azure DevOps unknown (no token), nothing deployed; exit 0" \
  test "$(json_field st-nologin nextStep)|$(step_status st-nologin B03)|$(step_status st-nologin B09)|$(cat "$tmp/st-nologin.rc")|$(grep -c '^deployment' "$fake/az.log")" = "B03|next|unknown|0|0"
check "status not logged in: the reason says how" \
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = j.steps.find((x) => x.id === "B03"); process.exit(s.commands[0].run === "az login --tenant 00000000-0000-0000-0000-000000000001" && /no Azure DevOps token/.test(j.steps.find((x) => x.id === "B09").reason) ? 0 : 1)' "$tmp/st-nologin.out"

# A deployed instance: every deployment, the zone and its roles, every plan ok, the portal ready.
reset "${ALL[@]}" platform-contoso-nonprod roles-contoso entra-permissions entra-audit-alert
node -e 'const fs = require("fs"); const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const env of ["prod", "nonprod"]) fs.writeFileSync(process.argv[2] + "/deployments/bootstrap-contoso-" + env + ".federation.json", JSON.stringify(c.federation[env]));' "$state/connections.json" "$fake"
# Pass 2 of the portal: its Container App.
node -e 'const fs = require("fs"), f = process.argv[1], o = JSON.parse(fs.readFileSync(f, "utf8"));
o.containerApp = { type: "Object", value: { name: "ca-contoso-portal" } };
fs.writeFileSync(f, JSON.stringify(o));' "$fake/deployments/portal-contoso-prod.json"
dns_zone
assign "$PROD_PID" "DNS Zone Contributor" "$ZONE_ID"
assign "$NONPROD_PID" "DNS Zone Contributor" "$ZONE_ID"
for p in projects core grants policies; do ado_rows "$p" "ok      project             Platform"; done
ado_rows config 'ok      repository          Platform/platform-config (00000000-0000-0000-0000-0000000000c3)' \
  'ok      seed                Platform/platform-config: refs/heads/main (instance.yaml on refs/heads/main equals instance.yaml)'
ado_rows connections 'ok      endpoint            sc-platform-entra'
ado_rows pipeline 'ok      pipeline            \platform\provisioning'
ado_out core '{"core":{"repository":{"id":"00000000-0000-0000-0000-0000000000b2","name":"core"},"tags":["v0.1.0"]}}'
ado_out pipeline '{"pipeline":{"id":1},"validationPipeline":{"id":2},"platformPipelines":{"nonprod":{"id":3},"prod":{"id":4}}}'
printf '200' > "$fake/readyz"
STDOUT_ONLY=1 run st-done status --format json
check "status of a deployed instance: every base step done but the first app (B32 next); setup done; exit 0" \
  test "$(json_field st-done currentStep)|$(json_field st-done nextStep)|$(json_field st-done currentPhase)|$(step_status st-done S01)|$(step_status st-done B19)|$(cat "$tmp/st-done.rc")" = "B32|B32|base|done|done|0"
check "status of a deployed instance: the confirmed steps count as done once a step after them is" \
  test "$(step_status st-done B02)$(step_status st-done B06)$(step_status st-done B07)$(step_status st-done B17)" = donedonedonedone
check "status: /readyz on portal.apiBaseUrl, https only" grep -qE '^curl --silent --show-error --proto =https --max-time 20 --output /dev/null --write-out %\{http_code\} https://portal\.contoso\.com/readyz$' "$fake/curl.log"
check "status: every phase planned with the bootstraps, the audit alert next to the host's workspace; only reads" \
  test "$(sed -nE 's/^ado bootstrap (plan|apply) .*--phase ([a-z]+) .*/\1 \2/p' "$fake/platform.log" | paste -sd, -)|$(az_has "deployment group show --subscription $PROD --resource-group rg-contoso-platform-prod --name entra-audit-alert --query {state: properties.provisioningState, outputs: properties.outputs, federation: properties.parameters.federation.value} --output json" && status_reads_only && reads_once bootstrap-contoso-nonprod && reads_once platform-contoso-nonprod && echo y)" \
    = "plan projects,plan core,plan config,plan connections,plan pipeline,plan grants,plan policies|y"
mkdir -p "$tmp/cwd/apps/hotel-inventory"
: > "$tmp/cwd/apps/hotel-inventory/app.yaml"
run st-complete status
check "status with a first app: every step done" \
  test "$(out_has st-complete 'Onboarding of contoso (core v0.1.0): every step is done.' && echo y)$(cat "$tmp/st-complete.rc")" = y0
rm -rf "$tmp/cwd/apps"
check "status never writes instance.yaml" cmp -s "$tmp/cwd/instance.yaml" "$repo/config/examples/instance.example.yaml"

# Changes since: a stale pass 2, a failed portal, a missing role, the portal not ready, a pull request not merged.
printf '{"provisioning":{"issuer":"https://login.microsoftonline.com/00000000-0000-0000-0000-000000000001/v2.0","subject":"old"}}\n' > "$fake/deployments/bootstrap-contoso-nonprod.federation.json"
: > "$fake/assignments"
assign "$PROD_PID" "DNS Zone Contributor" "$ZONE_ID"
printf '503' > "$fake/readyz"
ado_rows config 'ok      repository          Platform/platform-config (00000000-0000-0000-0000-0000000000c3)' \
  'warn    seed                Platform/platform-config: refs/heads/main (instance.yaml on refs/heads/main differs from instance.yaml: change it through a pull request (this phase never pushes to a repository with commits))'
STDOUT_ONLY=1 run st-drift status --format json
check "status: pass 2 with another federation than the connections now: B19 next for nonprod" \
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = j.steps.find((x) => x.id === "B19");
process.exit(s.status === "next" && s.commands.map((c) => c.run).join("|") === "instance.sh bootstrap nonprod --pass 2|instance.sh bootstrap nonprod --pass 2 --apply --remove-lock" ? 0 : 1)' "$tmp/st-drift.out"
check "status: a missing DNS role is next, with the DNS team's grant command" \
  node -e 'const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const s = j.steps.find((x) => x.id === "B14");
const want = "az role assignment create --role \"DNS Zone Contributor\" --assignee-object-id " + process.argv[2] + " --assignee-principal-type ServicePrincipal --scope " + process.argv[3];
process.exit(s.status === "next" && s.commands.some((c) => c.run === want) ? 0 : 1)' "$tmp/st-drift.out" "$NONPROD_PID" "$ZONE_ID"
check "status: instance.yaml not on the default branch: B15 waits for the pull request; /readyz 503: B31 next, S01 waits for it" \
  test "$(step_status st-drift B15)|$(step_status st-drift B31)|$(step_status st-drift S01)" = "waiting|next|blocked"
check "status: the portal's own host name (ADR-0071): B27, the pass 1 before the registration, is not needed" \
  test "$(step_status st-drift B27)" = "done"
touch "$fake/deployments/portal-contoso-prod.failed"
sed -i '/^  hostEnvironment: prod/a\  hostName: ""' "$tmp/cwd/instance.yaml"
STDOUT_ONLY=1 run st-failed status --format json
check "status: a portal without a host name of its own and a failed portal deployment: B27 next (run it again); the first next step is still B14" \
  test "$(step_status st-failed B27)|$(json_field st-failed nextStep)" = "next|B14"

reset bootstrap-contoso-prod platform-contoso-prod
run st-ws status --workspace "$other_ws"
check "status --workspace: the audit alert read in that workspace's group" \
  az_has "deployment group show --subscription $NONPROD --resource-group rg-identity-logs --name entra-audit-alert --query {state: properties.provisioningState, outputs: properties.outputs, federation: properties.parameters.federation.value} --output json"

reset
sed -i 's/^  prefix: contoso /  prefix: Contoso-X /' "$tmp/cwd/instance.yaml"
run st-invalid status
check "status with an invalid instance.yaml: B01 next with the problem, nothing read; exit 0" \
  test "$(out_has st-invalid 'Onboarding (instance.yaml is not valid)' && out_has st-invalid 'next     B01' && echo y)|$(grep -c . "$fake/az.log")|$(cat "$tmp/st-invalid.rc")" = "y|0|0"

reset
check "no az call outside the fake's list, in any case" test ! -s "$tmp/unexpected.all"

if [ "$failures" -gt 0 ]; then
  printf 'check-instance-sh: %s failure(s)\n' "$failures"
  exit 1
fi
printf 'check-instance-sh: all checks passed\n'
