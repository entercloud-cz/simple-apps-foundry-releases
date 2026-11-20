#!/usr/bin/env bash
# azure-post.sh — stage azure_post_<env>, job `releases`, run by AzureCLI@2 with
# sc-platform-provisioning-<env> (Azure provisioning identity of the environment, ADR-0031).
#
# The stage runs only when the plan runs a unit of it in <env> (ADR-0048, output post_<env>): the lz
# second pass, frontdoor or release of an app there, or, in the stage of portal.hostEnvironment, the
# pep of an app in any environment (and in another environment with its own subscription, the
# approval of a pep there). Per app whose lz, frontdoor or release runs in <env> (the plan runs
# frontdoor and release together), whose landing zone is ok (prov_lz_ok), whose Azure DevOps
# resources are ok when its ado ran, and that is ok in <promoteFrom> when it runs there too
# (prov_post_ok), up to PROV_PARALLEL_MAX apps at the same time (ADR-0046); every other app is
# unchanged here (prov_pass). Each step below runs only for its unit; the status lists the units
# that finished (done: lz, release), which record_<env> reads. The deployments into resources the
# apps of the environment share run one at a time (prov_lock): Front Door (step 3), the dbinit job of
# a CAE (step 2) and the portal-side endpoints (step 7).
#   1. (lz) Landing zone, second pass: as in azure.sh, but the state takes the app's service
#      connection (issuer, subject) from the `ado` artifact when the app's ado ran in this run (else
#      it is carried from the record), so a new connection's federation is deployed; up to date
#      (nothing deployed) when it did not change; after a deployment the unit tags go back on the
#      app resource group (prov_tags_restore). Without lz, its outputs come from the app's entries
#      (prov_entry_dir).
#   2. (lz) An app with a database (landing-zone output database, PostgreSQL or Azure SQL, ADR-0028):
#      the runtime identity's database principal and rights, by `platform provisioning dbinit`
#      through the dbinit job of the app's CAE. Skipped when the server's tag saf-dbinit already
#      holds the runtime identity's object ID: the tag is set after a successful execution, and a
#      landing-zone deployment rewrites the server's tags. This step follows the run's last
#      landing-zone deployment (a new app's first run deploys it in both passes), so the tag
#      outlasts the run and dbinit runs once per landing-zone change. Before the release, so a
#      re-applied app finds its principal. The job not deployed yet (environment.bicep pass 2), or on
#      another saf-jobs digest than this core pins (rule P23: the environment's platform pipeline
#      deploys it after a core upgrade, ADR-0043) -> `waiting`, the release is not touched. Detail
#      database initialised|up-to-date|job-outdated.
#   3. (frontdoor and release) The app's custom domain through the environment's managed Front Door (ADR-0010, amended
#      2026-11-01 and 2026-11-02), when app.yaml requests one there (environments.<env>.frontDoor.hostName,
#      from plan/apps.json frontDoorHosts): `inputs --step frontdoor`, `az deployment group validate`,
#      `compare` with the record of fd-{slug}-{env} in the environment's platform resource group, and
#      `az deployment group create` through frontdoor.bicepparam only when it is not up to date (a
#      deployment made by hand with the same name is taken over; before it, fd_dns_guard reads the
#      DNS record sets it would PUT and refuses one that isn't this app's, ADR-0052). The run doesn't wait for the
#      domain's validation or certificate (about 20 minutes). With the zone in Azure DNS of this
#      subscription the template writes the _dnsauth TXT and the CNAME; otherwise the log lists both
#      records to create by hand. Detail frontDoor <host> deployed|up-to-date [dns-manual]. A host
#      change (ADR-0010, amended 2026-11-11): `inputs --step frontdoor` reads the record as it was
#      (--fd-record, --fd-domain: whether Front Door serves its host) and keeps the previous host on
#      the route (retainedHostName) until Front Door serves the new one; detail frontDoorPrevious
#      <host> kept (its frontdoor unit is not recorded as finished, so the next run checks again). A record without a
#      request (app.yaml no longer asks for a domain): nothing is deployed, detail frontDoor
#      removing; the release opens the ingress, step 6 removes the domain. Before the release,
#      because the release reads it: the deployment (its parameters hostName, retainedHostName and
#      output frontDoorId) goes to `platform provisioning state` (--fd-record), and the release is put
#      behind Front Door (frontDoor.mode managed: FRONT_DOOR_ID, Easy Auth forwardProxy Standard) in
#      the same run. A failure here leaves the release untouched.
#   4. (release) Release release-{slug} (ADR-0032 decisions 7 and 8, ADR-0033):
#      - records: lz (again, after pass 2), release; the Entra client ID from the artifact `entra`
#        (registration deployed in this run), else the Entra plan (its record; prov_entra_dir:
#        units/entra or entra_plan, ADR-0050), else the release
#        record; whether the Easy Auth secret exists (prov_state); the custom domain's deployment
#        of step 3; `platform provisioning state` with the ADO outputs;
#      - sign-in required but no Entra client ID or no Easy Auth secret -> `waiting`, the release is
#        not touched (never an anonymous release for such an app); a failed Entra step does not
#        stop the release of an app whose client ID is known;
#      - a domain removal of an app with sign-in: `waiting` (release not touched, still locked behind
#        Front Door and reachable there) until the registration lists the default host's redirect
#        URI: this run's Entra plan or deployment (entra-outputs) of hosts with the default host. An
#        ingress is never opened on a host Entra rejects (ADR-0010, amended 2026-11-11);
#      - no release record -> bootstrap: the Container App must not exist yet; saf-placeholder is
#        imported by digest (images/images.json) from instance coreImages.registry into the app
#        registry (tag sha256-<hex>, skipped when it already resolves to the digest); otherwise
#        re-apply with the record's app-owned values (image, runtime, env, secrets, run);
#      - `inputs --step release`, `az deployment group validate`, `compare` with the record;
#        nothing more when up to date;
#      - re-apply: right before deploying, the Container App's saf-run-id tag must equal the
#        record's run.id; if not (a delivery ran in between), read the record and render again
#        once; still different -> `waiting` (delivery is running);
#      - `az deployment group create` through release.bicepparam (deployedBy = provisioning), then
#        scripts/smoke.sh (image, revision health, sign-in behaviour).
#   5. (release) Every app with sign-in whose Easy Auth secret is present (ADR-0041), decided from state, not
#      from what this run did: the vault version's created time (read now, after entra may have
#      written a new version), the Container App's tag saf-easyauth (the version its active
#      revisions are known to run with) and the active revisions with their creation times
#      (prov_easyauth_app). Tag = the version -> nothing (detail easyAuth current). Every active
#      revision created at least PROV_EASYAUTH_SETTLE_S (30 min) after the version (a delivery, a
#      release re-apply, which also drops the tag) -> they started with it: set the tag, no restart
#      (detail easyAuth current). Otherwise restart every active revision (ARM POST
#      .../revisions/<name>/restart, this identity's Contributor) and run scripts/smoke.sh with the
#      registration's client ID (the sign-in redirect must name it). Set the tag only after both
#      succeeded AND the settle time since the version has passed (detail easyAuth restarted); a
#      replica that started sooner may still have the previous value, so a run right after a
#      rotation restarts without tagging (detail easyAuth restarted tag-after-settle; the release unit
#      counts as finished) and the plan's pending restart has the next run inside the maintenance
#      window restart again and tag (ADR-0048 section 7, amended 2026-11-11). A restart that didn't happen (an app skipped, a failed step, a
#      cancelled run) is done by the next run, and until the tag names the version the stage entra
#      removes no password. Not when the release step ended `waiting`. An app that can't be read
#      gets a warning and detail easyAuth unknown (nothing restarted or tagged). The tag is written
#      with `az tag update --operation merge`, like saf-dbinit.
#   6. (frontdoor) A custom domain no longer requested (front_door_cleanup removal, ADR-0010 amended 2026-11-11):
#      only after the release step succeeded in this run with frontDoor.mode none, so the ingress is
#      open again. The previous host of a change (front_door_cleanup change): at the end of step 3,
#      right after the deployment that took it off the route because Front Door serves the new host
#      (the record no longer names it afterwards). `platform provisioning fd-cleanup` compares the record as it was
#      before step 3 with the deployment after it (none: removal) and names what to delete, never a
#      host another app requests; under the Front Door lock, in this order: the route (removal), each
#      custom domain no route links any more and that still holds this app's host (fd_domain_owned:
#      cd-{host} isn't injective, ADR-0052), the origin group (removal), the DNS records the
#      deployment wrote in an Azure DNS zone instance.yaml manages (fd_dns_cleanup: only this app's,
#      by the mark saf-app/saf-env, or a record without the mark next to a CNAME that still points
#      at the endpoint; anything else is left alone with a warning), the nested deployment records
#      appRoute-* and dnsRecords-* of the app's record (fd_nested_cleanup, removal), and last the
#      record fd-{slug}-{env} (removal), so a failure part-way is repeated by the next
#      run. Records in a manual zone: a warning for the DNS team. Detail frontDoor removed,
#      frontDoorPrevious removed. Deletes are ARM DELETEs, each waited for (fd_delete).
#   7. (pep) After every app: the portal-side private endpoints of app vaults (ADR-0025), see
#      portal_endpoints below: deployed in the portal host environment's stage, approved in another
#      environment's stage when its subscription differs from the host's; only for the apps whose
#      pep the plan runs in that environment.
#   M. (release, action move) a network mode change (ADR-0060): step 1 deploys the landing zone's
#      prepare pass again (no dbinit yet); then the move step (move_step, below release_step): the
#      preconditions, the delivery identity's Joiner on the source CAE, the app's delete, the source
#      spoke's endpoints (case B), the final landing zone, dbinit, steps 3 to 5 into the new CAE, the
#      new host by GET, the cleanup (the old secret's role, case A; the endpoints when the app leaves a
#      VNet); done lz and release only then. A failed precondition: `waiting`, the app untouched. In an
#      environment of kind prod outside the maintenance window the move step waits right away (after
#      the prepare pass; product owner, 2026-11-14).
#   Decommissioning (ADR-0056), by the plan's unit actions (prov_unit_action):
#   R. (release, action retire) a decommissioned app is stopped: ARM POST .../containerApps/{ca}/stop on
#      the app's own Container App (by naming), then its runningStatus read until Stopped (at most 10
#      minutes); none there = nothing to stop. No other step runs for it (frozen), except D right
#      after it in an immediate decommissioning's first run (ADR-0056 amendment 2026-11-12). The stop
#      runs even when the app's Azure DevOps stage or its source environment failed in this run (then
#      only the stop: retire-only). Detail release retired | retired-none. Cancel (the plan's retired.remove): before the release's re-apply, a
#      Stopped Container App is started (POST .../start), detail release started.
#   D. (frontdoor, action delete) the custom domain's removal of step 6 without a release: the record
#      fd-{slug}-{env} as it is, `fd-cleanup` (a decommissioned app requests no domain), the same
#      guards and order; none = done. Status done delete-frontdoor.
#   P. (pep, action delete; host's stage) the portal-side endpoint pep-{vault}-portal and its record
#      pep-portal-{slug}-{env}, each only when it proves to be the app's (portal_endpoint_delete through
#      portal_endpoint_remove and portal_endpoint_forget, which step 7 also uses for a previous vault
#      generation and a vault no longer VNet-based).
# Artifact azure_post_<env>: status/{slug}.{env}.json, lz-outputs/{slug}.{env}.json; in the portal
# host environment's stage also portal/status/{slug}.{E}.json for every app and environment E.
# Env: SAF_ENV_NAME, SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION (template constants).

set -euo pipefail
# shellcheck source=prov-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/prov-lib.sh"

saf_require_env SAF_ENV_NAME SAF_SERVICE_CONNECTION
PROV_STAGE="azure_post_$SAF_ENV_NAME"
out="$SAF_OUT/$PROV_STAGE"
rm -rf "$out"
mkdir -p "$out/status" "$out/lz-outputs"

saf_bicep_pin_check
prov_environment
prov_units_check
source_env="${SAF_PROMOTE_FROM:-}"

# Records of the release step: lz (required) and release (optional); the Entra client ID of this
# run (entra-outputs.json, optional); the custom domain's deployment of step 3 (fd-record.json, only
# when app.yaml requests a domain in this environment).
read_records() {
  local dir="$1" f
  prov_record sub "$lz_name" "" "$dir/lz-record.json"
  [ -f "$dir/lz-record.json" ] || saf_die "the landing-zone record $lz_name is missing"
  prov_record group "$release_name" "$rg" "$dir/release-record.json"
  rm -f "$dir/fd-record.json" "$dir/fd-domain.json" "$dir/fd-ranges.json"
  if [ -f "$PROV_DIR/frontdoor/deployment.json" ]; then cp "$PROV_DIR/frontdoor/deployment.json" "$dir/fd-record.json"; fi
  # The ingress lock-down (ADR-0010, amended 2026-11-11): whether Front Door serves the domain now
  # (after step 3), and the backend ranges plan_<env> resolved for the run. An app on a
  # custom domain never gets its release without them.
  prov_fd_domain "$dir/fd-record.json" "$dir/fd-domain.json"
  if [ -n "$(prov_app_front_door "$slug" "$env_name")" ]; then
    f="$(prov_fd_ranges_file "$env_name")"
    [ -f "$f" ] || saf_die "$slug in $env_name is on a custom domain through Front Door, but artifact plan_$env_name has no backend ranges; its release is not touched"
    cp "$f" "$dir/fd-ranges.json"
  fi
  rm -f "$dir/entra-outputs.json"
  for f in "$SAF_IN/entra/entra-outputs/$slug.$env_name.json" "$(prov_entra_dir "$slug" "$env_name")/entra-outputs/$slug.$env_name.json"; do
    if [ -f "$f" ]; then
      cp "$f" "$dir/entra-outputs.json"
      break
    fi
  done
}

# Bootstrap only: saf-placeholder by digest into the app registry (ADR-0030).
# The source is coreImages.registry, the public core packages (ghcr.io/<org>, ADR-0065): an anonymous
# import by digest, no credential (sandbox check ACR-8, passed 2026-11-18). Signature verification of the
# placeholder before the import (ADR-0030) is not implemented yet (backlog).
import_placeholder() {
  local dir="$1" repo digest registry login image tag current source
  repo="$(jq -er '.images["saf-placeholder"].repository' "$SAF_IMAGES_JSON")"
  digest="$(jq -er '.images["saf-placeholder"].digest' "$SAF_IMAGES_JSON")"
  [[ "$repo" =~ ^[a-z0-9]([a-z0-9._/-]*[a-z0-9])?$ ]] || saf_die "images.json has no valid saf-placeholder repository"
  [[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || saf_die "images.json has no valid saf-placeholder digest"
  registry="$(jq -er '.properties.outputs.registryName.value' "$dir/lz-record.json")"
  login="$(jq -er '.properties.outputs.registryLoginServer.value' "$dir/lz-record.json")"
  [[ "$registry" =~ ^[a-z0-9]{5,50}$ ]] || saf_die "the landing-zone record has no valid registryName"
  image="$(jq -er '.bootstrap.image' "$dir/state.json")"
  [ "$image" = "$login/$repo@$digest" ] || saf_die "state.bootstrap.image is not the pinned saf-placeholder in the app registry"
  tag="sha256-${digest#sha256:}"
  current="$(az acr repository show --name "$registry" --image "$repo:$tag" --query digest --output tsv --only-show-errors 2>/dev/null || true)"
  if [ "$current" = "$digest" ]; then
    saf_info "  $login/$repo:$tag already holds $digest; no import."
    prov_detail placeholder present
    return 0
  fi
  source="$(prov_core_images_registry)"
  saf_info "  Importing $source/$repo@$digest into $login/$repo:$tag"
  if ! az acr import --name "$registry" --resource-group "$rg" --source "$source/$repo@$digest" \
      --image "$repo:$tag" --force --only-show-errors > "$dir/import.log" 2>&1; then
    saf_neutralise < "$dir/import.log" | tail -n 20
    saf_die "az acr import of saf-placeholder failed"
  fi
  prov_detail placeholder imported
}

# A bootstrap must never replace a running app: no release record AND no Container App.
check_no_container_app() {
  local dir="$1" rc
  set +e
  az resource show --resource-group "$rg" --name "$container_app" --resource-type Microsoft.App/containerApps \
    --query id --output tsv --only-show-errors > /dev/null 2> "$dir/app.err"
  rc=$?
  set -e
  [ "$rc" -ne 0 ] || saf_die "$container_app exists but release record $release_name does not; refusing to bootstrap over it"
  grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$dir/app.err" || {
    saf_neutralise < "$dir/app.err" | tail -n 10
    saf_die "could not check whether $container_app exists"
  }
}

# Newer-run guard (ADR-0032 decision 8): sets run_guard to same | moved.
# A missing Container App (e.g. a failed first release) runs nothing a re-apply could replace.
check_run() {
  local dir="$1" tag recorded rc
  recorded="$(jq -r '(.properties.parameters.run.value.id // "") | tostring' "$dir/release-record.json")"
  # When the tag was read: race_check looks for a delivery's revision from then on.
  run_checked_at="$(date -u +%s)"
  set +e
  az resource show --resource-group "$rg" --name "$container_app" --resource-type Microsoft.App/containerApps \
    --query tags --output json --only-show-errors > "$dir/tags.json" 2> "$dir/tags.err"
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    grep -q 'ResourceNotFound' "$dir/tags.err" || {
      saf_neutralise < "$dir/tags.err" | tail -n 10
      saf_die "could not read the tags of $container_app"
    }
    run_guard=same
    return 0
  fi
  tag="$(jq -r '(.["saf-run-id"]? // "") | tostring' "$dir/tags.json")"
  if [ "$tag" = "$recorded" ]; then run_guard=same; else run_guard=moved; fi
}

render_release() {
  local dir="$1" mode="$2"
  saf_cli provisioning inputs --step release --mode "$mode" --instance "$SAF_INSTANCE" --app "$app_file" \
    --env "$env_name" --state "$dir/state.json" --output "$dir/release.json"
  prov_arm validate release "$dir/release.json" "$release_name" "$rg" "$dir/validate.json"
  prov_compare release "$dir/validate.json" "$dir/release-record.json"
}

# ingress_detail <release inputs>: detail ingress (ADR-0010, amended 2026-11-11), read by
# record_<env>: locked (behind Front Door with its backend ranges; the Entra redirect URIs follow),
# pending-domain (behind Front Door, but Front Door doesn't serve the domain yet: open until it does,
# so its release unit is not recorded as finished and the next run locks it) or open (not behind Front Door).
ingress_detail() {
  local mode n
  mode="$(jq -r '.frontDoor.mode // ""' "$1")"
  n="$(jq -r '.frontDoor.backendIpRanges | length' "$1")"
  { [[ "$mode" =~ ^(none|managed|external)$ ]] && [[ "$n" =~ ^[0-9]+$ ]]; } || saf_die "the release inputs of $slug in $env_name have no valid frontDoor"
  if [ "$mode" = none ]; then
    prov_detail ingress open
  elif [ "$n" -gt 0 ]; then
    saf_info "  Ingress: only Front Door ($n AzureFrontDoor.Backend IPv4 ranges)"
    prov_detail ingress locked
  else
    saf_info "  Ingress: open until Front Door serves the custom domain (validation and certificate, about 20 minutes); a later run locks it"
    prov_detail ingress pending-domain
  fi
}

# public_host_of <release inputs>: the custom host when the release locks the ingress to Front Door
# (smoke.sh probes through it, ADR-0010 amended 2026-11-11), else nothing.
public_host_of() {
  jq -r 'if .frontDoor.mode != "none" and (.frontDoor.backendIpRanges | length) > 0 then .frontDoor.hostNames[0] // "" else "" end' "$1"
}

smoke() {
  local dir="$1" app image auth liveness public_host
  app="$(jq -er '.properties.outputs.containerAppName.value' "$dir/deployment.json")"
  image="$(jq -er '.properties.outputs.image.value' "$dir/deployment.json")"
  auth="$(jq -er '.authentication.mode' "$dir/release.json")"
  liveness="$(jq -er '.runtime.livenessPath' "$dir/release.json")"
  public_host="$(public_host_of "$dir/release.json")"
  [ "$app" = "$container_app" ] || saf_die "the release deployed a different Container App than naming.bicep names"
  bash "$SAF_DELIVERY/scripts/smoke.sh" "$rg" "$app" "$image" "$auth" "$liveness" "" "$public_host"
}

# restart_stale: step 5 for the current app, after its release step (ADR-0041).
# Verify in sandbox: ROT-1 (the restarted revision signs in with the new password; scale to zero;
# a tag update on the Container App creates no new revision; a release deployment drops the tag).
restart_stale() {
  local dir="$PROV_DIR/easyauth" vault created app_id tag image liveness client public_host rev count=0
  [ "$auth_mode" = required ] || return 0
  mkdir -p "$dir"
  vault="$(jq -r '.environmentKeyVaultName.value // ""' "$out/lz-outputs/$slug.$env_name.json")"
  prov_valid_vault "$vault" || saf_die "the landing zone of $slug in $env_name has no valid output environmentKeyVaultName"
  prov_secret_meta "$vault" "$dir/secret.json"
  [ "$(jq -r '.state' "$dir/secret.json")" = present ] || return 0
  created="$(jq -r '.created // "none" | tostring' "$dir/secret.json")"
  if [ "$created" = none ]; then
    saf_info "  Easy Auth: the secret's version records no creation time; can't tell what the app runs with"
    prov_detail easyAuth unknown
    return 0
  fi
  app_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.App/containerApps/$container_app"
  prov_easyauth_app "$app_id" "$created" "$dir/app.json"
  [ "$(jq -r '.exists' "$dir/app.json")" = true ] || saf_die "$container_app does not exist after the release step"
  if [ "$(jq -r '.readable' "$dir/app.json")" != true ]; then
    prov_detail easyAuth unknown
    return 0
  fi
  tag="$(jq -r '.tag' "$dir/app.json")"
  # The marker: the active revisions are known to run with this version.
  if [ "$tag" = "$created" ]; then
    saf_info "  Easy Auth: the app runs with the secret's current version (tag saf-easyauth)"
    prov_detail easyAuth current
    return 0
  fi
  if [ "$(jq -r '.allAfter' "$dir/app.json")" = true ]; then
    saf_info "  Easy Auth: every active revision started at least ${PROV_EASYAUTH_SETTLE_S} s after the secret's current version; no restart"
    az tag update --resource-id "$app_id" --operation merge --tags "saf-easyauth=$created" --only-show-errors --output none
    prov_detail easyAuth current
    return 0
  fi
  while IFS= read -r rev; do
    [[ "$rev" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || saf_die "the Container App of $slug in $env_name has an unexpected revision name"
    saf_info "  Restarting revision $rev (it predates the Easy Auth secret's current version)"
    az rest --method post --url "$app_id/revisions/$rev/restart?api-version=2024-03-01" --only-show-errors --output none
    count=$((count + 1))
  done < <(jq -r '.revisions[].name' "$dir/app.json")
  [ "$count" -gt 0 ] || saf_die "the Container App of $slug in $env_name has no active revision to restart"
  image="$(jq -r '.image' "$dir/app.json")"
  client="$(jq -r '.entra.clientId? // ""' "$PROV_DIR/release/state.json")"
  prov_valid_guid "$client" || saf_die "no valid Entra client ID for the sign-in check of $slug in $env_name"
  liveness="$(jq -er '.runtime.livenessPath' "$PROV_DIR/release/release.json")"
  public_host="$(public_host_of "$PROV_DIR/release/release.json")"
  bash "$SAF_DELIVERY/scripts/smoke.sh" "$rg" "$container_app" "$image" required "$liveness" "$client" "$public_host"
  # Only now, and only once the settle time since the version has passed: a restart or probe that
  # failed, or a restart so soon that a replica may still have the previous value, leaves the tag
  # stale, so the next run restarts again (and tags) and the stage entra removes no password.
  if [ "$(date -u +%s)" -ge $((created + PROV_EASYAUTH_SETTLE_S)) ]; then
    az tag update --resource-id "$app_id" --operation merge --tags "saf-easyauth=$created" --only-show-errors --output none
    prov_detail easyAuth restarted
  else
    saf_info "  Easy Auth: restarted less than ${PROV_EASYAUTH_SETTLE_S} s after the secret's version was written; the next run restarts again and sets the tag"
    prov_detail easyAuth "restarted tag-after-settle"
  fi
}

# front_door_step: step 3 for the current app, before its release step, which reads the deployment
# (ADR-0010, amended 2026-11-01 and 2026-11-02).
front_door_step() {
  local dir="$PROV_DIR/frontdoor" host name platform_rg dns_zone manual="" kept
  local -a previous=(--apps "$SAF_APPS_JSON")
  mkdir -p "$dir"
  rm -f "$dir/before.json" "$dir/before-domain.json" "$dir/deployment.json"
  fd_removing=""
  host="$(prov_app_front_door "$slug" "$env_name")"
  name="$(prov_name "$names" frontDoorDeployment)"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  prov_record group "$name" "$platform_rg" "$dir/record.json"
  # The record as it was before this run: front_door_cleanup compares it with what is deployed now.
  if [ -f "$dir/record.json" ]; then cp "$dir/record.json" "$dir/before.json"; fi
  if [ -z "$host" ]; then
    if [ -f "$dir/record.json" ]; then
      fd_removing="$(jq -r '.properties.parameters.hostName.value // ""' "$dir/record.json")"
      prov_valid_host "$fd_removing" || saf_die "the record $name has no valid parameter hostName"
      saf_info "  Custom domain $fd_removing: no longer requested in app.yaml; the release opens the ingress first, then it is removed (step 6)"
      prov_detail frontDoor removing
    fi
    return 0
  fi
  # A host change: whether Front Door serves the previous deployment's host decides what stays on the route.
  if [ -f "$dir/record.json" ]; then
    previous+=(--fd-record "$dir/record.json")
    prov_fd_domain "$dir/record.json" "$dir/before-domain.json"
    if [ -f "$dir/before-domain.json" ]; then previous+=(--fd-domain "$dir/before-domain.json"); fi
  fi
  saf_cli provisioning inputs --step frontdoor --instance "$SAF_INSTANCE" --app "$app_file" --env "$env_name" \
    "${previous[@]}" --output "$dir/frontdoor.json"
  [ "$(jq -r '.hostName' "$dir/frontdoor.json")" = "$host" ] || saf_die "the frontdoor inputs of $slug in $env_name name another host than plan/apps.json"
  dns_zone="$(jq -r '.dnsZoneId' "$dir/frontdoor.json")"
  [ -n "$dns_zone" ] || manual=" dns-manual"
  prov_arm validate frontdoor "$dir/frontdoor.json" "$name" "$platform_rg" "$dir/validate.json"
  prov_compare frontdoor "$dir/validate.json" "$dir/record.json"
  if [ "$prov_verdict" = up-to-date ]; then
    cp "$dir/record.json" "$dir/deployment.json"
    prov_detail frontDoor "$host up-to-date$manual"
  else
    # The DNS record sets this deployment PUTs are read first: never another's (ADR-0052, F7).
    fd_dns_guard "$dir"
    # One Front Door profile per environment: its deployments run one at a time (ADR-0046).
    prov_lock frontdoor
    prov_arm create frontdoor "$dir/frontdoor.json" "$name" "$platform_rg" "$dir/deployment.json"
    prov_unlock
    prov_detail frontDoor "$host deployed$manual"
  fi
  saf_info "  Custom domain https://$host through Front Door (validation and certificate take about 20 minutes after the DNS records exist)"
  kept="$(jq -r '.retainedHostName // ""' "$dir/frontdoor.json")"
  if [ -n "$kept" ]; then
    saf_info "  Previous host https://$kept stays on the route until Front Door serves $host; a later run removes it"
    prov_detail frontDoorPrevious "$kept kept"
  fi
  if [ -n "$manual" ]; then
    # Records to create by hand: the template's output dnsRecords (FQDNs and values, no secret).
    jq -r '.properties.outputs.dnsRecords.value | "  DNS by hand: TXT \(.txt.name) = \(.txt.value)", "  DNS by hand: CNAME \(.cname.name) = \(.cname.value)"' \
      "$dir/deployment.json" | saf_neutralise
  fi
  # A host change whose new host Front Door serves: the previous one is off the route now (step 6).
  front_door_cleanup change
}

# database_entry <lz outputs>: step 2 for the current app, after the second pass of its landing zone.
database_entry() {
  local lz_outputs="$1" host name rg mode job_names platform_rg job job_id engine server_type user ids principal client server server_id marker job_state
  host="$(jq -r '.database.value.host // ""' "$lz_outputs")"
  [ -n "$host" ] || return 0
  # The engine from the server's DNS name (public cloud names, like naming.privateDnsZone).
  if [[ "$host" =~ ^[a-z0-9-]{3,63}\.postgres\.database\.azure\.com$ ]]; then
    engine=postgres
    server_type=Microsoft.DBforPostgreSQL/flexibleServers
  elif [[ "$host" =~ ^[a-z0-9-]{3,63}\.database\.windows\.net$ ]]; then
    engine=azureSql
    server_type=Microsoft.Sql/servers
  else
    saf_die "the landing zone of $slug in $env_name has no valid database host"
  fi
  name="$(jq -r '.database.value.name // ""' "$lz_outputs")"
  rg="$(jq -r '.resourceGroupName.value // ""' "$lz_outputs")"
  [[ "$rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "the landing zone of $slug in $env_name has no valid output resourceGroupName"
  # The server whose tag is written is in the app's resource group by naming, never an output alone (ADR-0052).
  [ "$rg" = "$(prov_name "$names" appResourceGroup)" ] \
    || saf_die "the landing zone of $slug in $env_name names another resource group than the app's by naming; no database principal is written"
  mode="$(jq -r '.networkMode // ""' "$PROV_DIR/lz/lz.json")"
  case "$mode" in
    externalOnly|externalHybrid) ;;
    *) saf_die "the landing-zone inputs of $slug in $env_name have no valid networkMode" ;;
  esac
  job_names="$PROV_DIR/names-$mode.json"
  [ -f "$job_names" ] || prov_names "$slug" "$job_names" "$env_name" "$mode"
  platform_rg="$(prov_name "$job_names" platformResourceGroup)"
  job="$(prov_name "$job_names" dbinitJob)"
  user="$(prov_name "$job_names" runtimeIdentity)"
  job_id="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.App/jobs/$job"
  server="${host%%.*}"
  server_id="/subscriptions/$subscription/resourceGroups/$rg/providers/$server_type/$server"
  ids="$(az identity show --resource-group "$rg" --name "$user" --query '[principalId, clientId]' --output tsv --only-show-errors)"
  principal="$(sed -n 1p <<< "$ids")"
  client="$(sed -n 2p <<< "$ids")"
  if ! prov_valid_guid "$principal" || ! prov_valid_guid "$client"; then
    saf_die "could not read the object and client ID of the runtime identity $user"
  fi
  marker="$(az resource show --ids "$server_id" --query 'tags."saf-dbinit"' --output tsv --only-show-errors)"
  if [ "$marker" = "$principal" ]; then
    saf_info "  Database principal $user on $server: up to date (tag saf-dbinit)"
    prov_detail database up-to-date
    return 0
  fi
  # The job exists and runs this core's saf-jobs image (rule P23): after a core upgrade the platform
  # pipeline of the environment deploys it (ADR-0043); until then the app waits, release untouched.
  job_state="$(prov_job_state "$job_id")"
  case "$job_state" in
    current) ;;
    missing) prov_wait "$slug in $env_name: the dbinit job $job is not deployed yet (environment.bicep pass 2)" ;;
    *)
      prov_detail database job-outdated
      prov_wait "$slug in $env_name: the dbinit job $job doesn't run the saf-jobs image this core pins yet; the platform pipeline of $env_name deploys it (ADR-0043), and the next provisioning run creates the database principal"
      ;;
  esac
  saf_info "  Database principal $user on $server ($engine): through the dbinit job $job"
  # One execution of a platform job at a time (ADR-0046; TODO(verify) PROV-PAR-3: whether parallel
  # executions of one manual Container Apps job are safe would allow dropping the lock).
  prov_lock "dbinit-$job"
  prov_arm_token
  saf_cli provisioning dbinit --job "$job_id" --engine "$engine" --host "$host" --database "$name" --principal-name "$user" --principal-id "$principal" --principal-client-id "$client" --output "$PROV_DIR/dbinit.json"
  unset SAF_ARM_TOKEN
  prov_unlock
  az tag update --resource-id "$server_id" --operation merge --tags "saf-dbinit=$principal" \
    --only-show-errors --output none
  prov_detail database initialised
}

release_app() {
  local retired="" lz_src move_from=""
  slug="$1"
  app_file="$(prov_app_file "$slug")"
  auth_mode="$(prov_app_auth "$slug")"
  names="$PROV_DIR/names.json"
  prov_names "$slug" "$names"
  rg="$(prov_name "$names" appResourceGroup)"
  container_app="$(prov_name "$names" containerApp)"
  lz_name="$(prov_name "$names" provisioningDeployment)"
  release_name="$(prov_name "$names" releaseDeployment)"
  # The federation of the app's service connection when its ado ran in this run (else carried).
  # ADR-0056: an ado delete writes no outputs, and retire-only runs after a failed ado stage; a
  # decommissioned app needs none (no landing-zone pass, no release here).
  ado_outputs=""
  if prov_unit_runs "$slug" "$env_name" ado && [ "$(prov_unit_action "$slug" "$env_name" ado)" != delete ] && [ "${2:-}" != retire-only ]; then
    ado_outputs="$SAF_IN/ado/ado-outputs/$slug.json"
    [ -f "$ado_outputs" ] || saf_die "artifact ado has no ado-outputs for $slug"
  fi

  # ADR-0060: a network mode change (the plan's release action move): the second pass stays the prepare
  # pass, and the move step (M) deploys the final one, then dbinit, once the app has left its source CAE.
  if [ "$(prov_unit_action "$slug" "$env_name" release)" = move ]; then
    move_from="$(prov_mode_change "$slug" "$env_name" from)"
    [ -n "$move_from" ] || saf_die "the plan moves $slug in $env_name but names no source mode"
  fi
  if prov_unit_runs "$slug" "$env_name" lz; then
    # 1. Landing zone, second pass.
    prov_lz "$PROV_DIR/lz" "$out/lz-outputs/$slug.$env_name.json" "$ado_outputs" "$move_from"
    if [ -z "$move_from" ]; then
      # 2. Database principal.
      database_entry "$out/lz-outputs/$slug.$env_name.json"
      prov_done lz
    fi
  else
    lz_src="$(prov_entry_dir "$slug" "$env_name")/lz-outputs/$slug.$env_name.json"
    if [ -f "$lz_src" ]; then
      prov_copy_object "$lz_src" "$out/lz-outputs/$slug.$env_name.json" \
        || saf_die "no landing-zone outputs for $slug in $env_name (plan_$env_name)"
    elif [ "$(prov_unit_action "$slug" "$env_name" release)" = retire ] || [ "$(prov_unit_action "$slug" "$env_name" frontdoor)" = delete ]; then
      # ADR-0056: a decommissioned app whose landing zone never succeeded has no outputs (sandbox run
      # 3456). The stop and the domain's removal go by naming and records, so they run without them.
      saf_info "  $slug in $env_name has no landing-zone outputs (its landing zone never succeeded): decommissioning goes on by naming"
    else
      saf_die "no landing-zone outputs for $slug in $env_name (plan_$env_name)"
    fi
  fi
  # ADR-0056: a decommissioned app is stopped (release retire) or its custom domain removed
  # (frontdoor delete); nothing else of it runs here. An immediate decommissioning (amendment
  # 2026-11-12) does both in its first run: the stop first, then the domain.
  if [ "$(prov_unit_action "$slug" "$env_name" release)" = retire ]; then
    retire_step
    prov_done release
    retired=1
  fi
  if [ "$(prov_unit_action "$slug" "$env_name" frontdoor)" = delete ]; then
    # retire-only: the app's Azure DevOps stage or its source environment failed in this run; only
    # the stop ran, the domain's removal waits for the next run (the unit doesn't finish).
    if [ "${2:-}" = retire-only ]; then return 0; fi
    decom_frontdoor
    return 0
  fi
  [ -z "$retired" ] || return 0
  # The custom domain and the release run together (the plan, ADR-0048), or neither does.
  prov_unit_runs "$slug" "$env_name" release || return 0
  # M. The move of a network mode change (ADR-0060): steps 3 to 6 inside it, after the app's delete.
  if [ -n "$move_from" ]; then
    move_step "$move_from"
    return 0
  fi

  # 3. The custom domain through Front Door.
  front_door_step
  # 4. Release.
  release_step
  # 5. Restart when the active revisions predate the Easy Auth secret's current version.
  restart_stale
  prov_done release

  # 6. Remove a custom domain no longer requested, now that the release has opened the ingress.
  front_door_cleanup removal
}

# entra_lists_default_host <release dir>: this run's Entra registration (entra-outputs: deployed by
# the stage entra, or found up to date by entra_plan, from the plan's inputs) lists the default
# host's redirect URI.
entra_lists_default_host() {
  local fqdn inputs
  inputs="$(prov_entra_dir "$slug" "$env_name")/entra-inputs/$slug.$env_name.json"
  fqdn="$(jq -r '.containerAppFqdn.value // ""' "$out/lz-outputs/$slug.$env_name.json")"
  [ -n "$fqdn" ] && [ -f "$1/entra-outputs.json" ] && [ -f "$inputs" ] \
    && [ "$(jq -r --arg f "${fqdn,,}" '(.hosts // []) | map(ascii_downcase) | index($f) != null' "$inputs")" = true ]
}

# front_door_cleanup removal|change: step 6 for the current app (ADR-0010, amended 2026-11-11).
#   removal: called last by release_app, so only after its release step succeeded in this run
#     (release_step exits the unit otherwise), and only with the release's frontDoor.mode none;
#   change: called by front_door_step right after the deployment that no longer keeps the previous
#     host on the route (it keeps it until Front Door serves the new one), before the release: the
#     record no longer names that host after this deployment, so a later step that waits or fails
#     must not leave it behind, and the app stays reachable on the served new host.
front_door_cleanup() {
  local what="$1" dir="$PROV_DIR/frontdoor" plan="$PROV_DIR/frontdoor/cleanup.json" n i host cd remove_route endpoint
  local -a after=()
  [ -f "$dir/before.json" ] || return 0
  if [ "$what" = removal ]; then
    [ -n "${fd_removing:-}" ] || return 0
    [ "$(jq -r '.frontDoor.mode // ""' "$PROV_DIR/release/release.json")" = none ] \
      || saf_die "the release of $slug in $env_name is still behind Front Door; its custom domain is not removed"
  elif [ "$what" = decommission ]; then
    # ADR-0056: the stopped app's domain goes without a release; only in its delete phase.
    [ -n "${fd_removing:-}" ] || return 0
    [ "$(prov_unit_action "$slug" "$env_name" frontdoor)" = delete ] \
      || saf_die "the custom domain of $slug in $env_name is removed without a release only in its delete phase"
  else
    if [ "$what" != change ] || [ -n "${fd_removing:-}" ]; then saf_die "the Front Door cleanup takes removal or change (a change never while a domain is removed)"; fi
    [ -f "$dir/deployment.json" ] || return 0
    after=(--after "$dir/deployment.json")
  fi
  saf_cli provisioning fd-cleanup --instance "$SAF_INSTANCE" --app "$app_file" --env "$env_name" --apps "$SAF_APPS_JSON" \
    --before "$dir/before.json" "${after[@]}" --output "$plan"
  while IFS= read -r host; do
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the custom domain $host of its previous deployment is requested by another app now; it is left alone"
  done < <(jq -r '.skipped[].host' "$plan")
  remove_route="$(jq -r '.removeRoute' "$plan")"
  n="$(jq '.domains | length' "$plan")"
  [ "$remove_route" = true ] || [ "$n" -gt 0 ] || return 0
  endpoint="$(jq -r '.endpointId' "$plan")"
  # One Front Door profile per environment: its changes run one at a time (ADR-0046).
  prov_lock frontdoor
  if [ "$remove_route" = true ]; then
    saf_info "  Removing the route of $slug from Front Door"
    fd_delete "$(jq -r '.routeId' "$plan")" "$FD_API"
  fi
  for ((i = 0; i < n; i++)); do
    host="$(jq -r ".domains[$i].host" "$plan")"
    cd="$(jq -r ".domains[$i].customDomainId" "$plan")"
    if fd_domain_linked "$endpoint" "$cd"; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: a route still serves the custom domain $host; it is left alone (check the profile by hand)"
      continue
    fi
    # cd-{host} isn't injective (ADR-0052, F3): only a domain that still holds this app's host.
    if ! fd_domain_owned "$cd" "$host"; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the custom domain ${cd##*/} holds another host than $host now (another app's); it is left alone"
      continue
    fi
    saf_info "  Removing the custom domain $host from Front Door"
    fd_delete "$cd" "$FD_API"
  done
  if [ "$remove_route" = true ]; then
    fd_delete "$(jq -r '.originGroupId' "$plan")" "$FD_API"
  fi
  for ((i = 0; i < n; i++)); do
    fd_dns_cleanup "$plan" "$i"
  done
  if [ "$remove_route" = true ]; then
    # The nested records of fd-{slug}-{env} first: their IDs come from its operations.
    fd_nested_cleanup "$plan"
    az deployment group delete --name "$(jq -r '.deployment' "$plan")" --resource-group "$(jq -r '.resourceGroup' "$plan")" \
      --only-show-errors --output none
    if [ "$what" = decommission ]; then
      saf_info "  Custom domain $fd_removing removed (decommissioning)"
    else
      saf_info "  Custom domain $fd_removing removed; the app answers on its default host"
    fi
    prov_detail frontDoor removed
  else
    prov_detail frontDoorPrevious removed
  fi
  prov_unlock
}

# FD_API: the Microsoft.Cdn API version of infra/modules/frontdoor/app-route.bicep.
FD_API=2025-04-15

# fd_delete <resource ID> <api-version>: an ARM DELETE, then a GET every 10 s until it answers
# NotFound (Front Door deletes run asynchronously; az rest doesn't wait), at most 15 minutes. Only a
# route, custom domain or origin group of a Front Door profile, or a CNAME or TXT record set of a DNS
# zone, in this environment's subscription. Gone already = done.
# Verify in sandbox: FD-10 (the DELETE answers 202 or 200, then the GET 404).
fd_delete() {
  local id="$1" api="$2" err="$PROV_DIR/frontdoor/delete.err" i
  [[ "${id,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/[-a-z0-9._()]{1,90}/providers/(microsoft\.cdn/profiles/[-a-z0-9]{1,260}/(customdomains|origingroups|afdendpoints/[-a-z0-9]{1,46}/routes)/[-a-z0-9]{1,260}|microsoft\.network/dnszones/[a-z0-9.-]{1,253}/(cname|txt)/[a-z0-9._-]{1,253})$ ]] \
    || saf_die "fd_delete: not a Front Door object or DNS record set of $env_name"
  [[ "$api" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] || saf_die "fd_delete: invalid api-version"
  if ! az rest --method delete --url "$id?api-version=$api" --only-show-errors --output none 2> "$err"; then
    if grep -Eq 'NotFound' "$err"; then return 0; fi
    saf_neutralise < "$err" | tail -n 10
    saf_die "could not delete ${id##*/} (Front Door cleanup of $slug in $env_name); the next run tries again"
  fi
  for ((i = 0; i < 90; i++)); do
    if ! az rest --method get --url "$id?api-version=$api" --only-show-errors --output none 2> "$err"; then
      if grep -Eq 'NotFound' "$err"; then return 0; fi
      saf_neutralise < "$err" | tail -n 10
      saf_die "could not check whether ${id##*/} is deleted"
    fi
    sleep 10
  done
  saf_die "${id##*/} still exists 15 minutes after its delete (Front Door cleanup of $slug in $env_name); the next run tries again"
}

# fd_domain_linked <endpoint ID> <custom domain ID>: a route of the environment's endpoint still
# links the custom domain (true = leave it alone).
# TODO(verify): the case of customDomains[].id in a route's ARM answer (compared case-insensitively).
fd_domain_linked() {
  local endpoint="$1" cd="$2"
  az rest --method get --url "$endpoint/routes?api-version=$FD_API" --only-show-errors --output json > "$PROV_DIR/frontdoor/routes.json"
  [ "$(jq -r --arg d "${cd,,}" '[.value[]? | (.properties.customDomains // [])[] | (.id // "") | ascii_downcase] | index($d) != null' "$PROV_DIR/frontdoor/routes.json")" = true ]
}

# DNS_API: the Microsoft.Network/dnsZones API version of infra/modules/frontdoor/dns-records.bicep.
DNS_API=2018-05-01

# fd_dns_read <record set ID> <output>: the record set (ARM GET, the whole object with its metadata)
# -> <output>, or no output when it doesn't exist. Any other error fails the app.
fd_dns_read() {
  local id="$1" file="$2" err="$2.err"
  rm -f "$file"
  if az rest --method get --url "$id?api-version=$DNS_API" --output json --only-show-errors > "$file.tmp" 2> "$err"; then
    mv "$file.tmp" "$file"
    return 0
  fi
  rm -f "$file.tmp"
  grep -Eq 'NotFound' "$err" && return 0
  saf_neutralise < "$err" | tail -n 10
  saf_die "could not read the DNS record set ${id##*/} of $slug in $env_name"
}

# fd_dns_owner <record set file>: whose the record set is, by the platform's mark (ADR-0052: the
# metadata saf-app and saf-env that dns-records.bicep writes; keys in any case): mine (this app in
# this environment), other (another app or environment) or unmarked (no mark: written by hand, or by
# a core before the mark).
fd_dns_owner() {
  jq -r --arg s "$slug" --arg e "$env_name" '((.properties.metadata // {}) | with_entries(.key |= ascii_downcase)) as $m
    | if ($m["saf-app"] // null) == null and ($m["saf-env"] // null) == null then "unmarked"
      elif $m["saf-app"] == $s and $m["saf-env"] == $e then "mine" else "other" end' "$1"
}

# fd_cname_target <record set file>: the CNAME's target, lower case, without the final dot.
fd_cname_target() {
  local t
  t="$(jq -r '.properties.CNAMERecord.cname // ""' "$1")"
  t="${t%.}"
  printf '%s' "${t,,}"
}

# fd_endpoint_host <endpoint ID>: the host of the environment's Front Door endpoint (ARM GET).
fd_endpoint_host() {
  local h
  h="$(az rest --method get --url "$1?api-version=$FD_API" --query properties.hostName --output tsv --only-show-errors)" \
    || saf_die "could not read the Front Door endpoint of $env_name"
  printf '%s' "${h,,}"
}

# fd_dns_guard <dir>: step 3's DNS guard (ADR-0052, finding F7), right before the deployment that
# PUTs the record sets of the app's custom domain in an Azure DNS zone: a PUT replaces a record set,
# whoever made it. Each record set the template writes (`platform provisioning fd-dns-guard`: the
# CNAME {host} and the TXT _dnsauth.{host}) is read first; the deployment is refused (the app fails,
# nothing is written; detail frontDoor <host> dns-conflict) when one exists that isn't this app's:
#   - the metadata saf-app/saf-env of another app or environment;
#   - no metadata (by hand, or by a core before the mark): a CNAME is this app's only when it points
#     at this environment's Front Door endpoint, or at the app's own default host (an app moving onto
#     Front Door); the TXT only next to a CNAME of this app.
# Absent record sets are fine. Records by hand (zoneId ""): nothing to read. The window between this
# read and the PUT stays (ARM has no conditional PUT for a nested deployment's record sets).
fd_dns_guard() {
  local dir="$1" guard="$1/dns-guard.json" owner target fqdn endpoint cname_ours=false
  saf_cli provisioning fd-dns-guard --instance "$SAF_INSTANCE" --app "$app_file" --env "$env_name" --output "$guard" > /dev/null
  [ -n "$(jq -r '.zoneId' "$guard")" ] || return 0
  fd_dns_read "$(jq -r '.cnameId' "$guard")" "$dir/dns-cname.json"
  fd_dns_read "$(jq -r '.txtId' "$guard")" "$dir/dns-txt.json"
  if [ -f "$dir/dns-cname.json" ]; then
    owner="$(fd_dns_owner "$dir/dns-cname.json")"
    case "$owner" in
      mine) cname_ours=true ;;
      unmarked)
        target="$(fd_cname_target "$dir/dns-cname.json")"
        endpoint="$(fd_endpoint_host "$(jq -r '.endpointId' "$guard")")"
        fqdn="$(jq -r '.containerAppFqdn.value // ""' "$out/lz-outputs/$slug.$env_name.json")"
        if [ -n "$target" ] && { [ "$target" = "$endpoint" ] || [ "$target" = "${fqdn,,}" ]; }; then
          cname_ours=true
        else
          fd_dns_refuse CNAME "exists without the platform's mark and points elsewhere (not at the Front Door endpoint of $env_name or the app's default host)"
        fi
        ;;
      *) fd_dns_refuse CNAME "belongs to another app or environment (metadata saf-app/saf-env)" ;;
    esac
  fi
  if [ -f "$dir/dns-txt.json" ]; then
    owner="$(fd_dns_owner "$dir/dns-txt.json")"
    case "$owner" in
      mine) ;;
      unmarked)
        [ "$cname_ours" = true ] || fd_dns_refuse "_dnsauth TXT" "exists without the platform's mark, and no CNAME of this app is next to it"
        ;;
      *) fd_dns_refuse "_dnsauth TXT" "belongs to another app or environment (metadata saf-app/saf-env)" ;;
    esac
  fi
  saf_info "  DNS records of $host: absent or this app's; the deployment may write them"
}

# fd_dns_refuse <record> <why>: fd_dns_guard's refusal.
fd_dns_refuse() {
  prov_detail frontDoor "$host dns-conflict"
  saf_die "$slug in $env_name: the DNS $1 record of $host $2. The platform never overwrites a record set that isn't this app's (ADR-0052): delete it, or, when it is this app's, add the metadata saf-app=$slug and saf-env=$env_name (core runbook docs/runbooks/front-door-custom-domain.md)"
}

# fd_domain_owned <custom domain ID> <host>: the custom domain still holds this app's previous host
# (properties.hostName), or is gone already. cd-{host} isn't injective (ADR-0052, F3): another app's
# host can give the same name, and then its domain is left alone (return 1).
fd_domain_owned() {
  local id="$1" want="$2" err="$PROV_DIR/frontdoor/domain.err" got
  if ! got="$(az rest --method get --url "$id?api-version=$FD_API" --query properties.hostName --output tsv --only-show-errors 2> "$err")"; then
    grep -Eq 'NotFound' "$err" && return 0
    saf_neutralise < "$err" | tail -n 10
    saf_die "could not read the custom domain ${id##*/} of $slug in $env_name"
  fi
  [ "${got,,}" = "${want,,}" ]
}

# fd_dns_cleanup <plan> <index>: the DNS records of one removed custom domain (ADR-0052: only this
# app's). In a zone the platform manages and wrote them in:
#   - the CNAME, when it still points at the environment's endpoint (a record someone pointed
#     elsewhere is not the platform's any more) and carries this app's mark or none (written before
#     the mark); one with another app's mark, or pointing elsewhere, leaves both records with a
#     warning;
#   - then the _dnsauth TXT: with this app's mark; without a mark only next to such a CNAME (a legacy
#     record is deleted only when the CNAME's target is this app's endpoint host); otherwise a warning.
# Records by hand (a manual zone, or one instance.yaml doesn't manage): a warning for the DNS team.
fd_dns_cleanup() {
  local plan="$1" i="$2" host cname_id txt_id expected manual owner dir="$PROV_DIR/frontdoor" legacy_ok=false
  host="$(jq -r ".domains[$i].host" "$plan")"
  if [ "$(jq -r ".domains[$i].dns != null" "$plan")" != true ]; then
    # Records by hand (a manual zone, or a zone instance.yaml doesn't manage): FQDNs, no secret.
    manual="$(jq -r ".domains[$i].manualDns | \"delete the CNAME \(.cname) and the TXT \(.txt)\" + (if .zone == \"\" then \"\" else \" in the zone \" + .zone end)" "$plan" | saf_neutralise)"
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: Front Door no longer serves $host. DNS by hand (the DNS team): $manual"
    return 0
  fi
  cname_id="$(jq -r ".domains[$i].dns.cnameId" "$plan")"
  txt_id="$(jq -r ".domains[$i].dns.txtId" "$plan")"
  expected="$(jq -r '.expectedCname' "$plan")"
  fd_dns_read "$cname_id" "$dir/cname.json"
  if [ -f "$dir/cname.json" ]; then
    owner="$(fd_dns_owner "$dir/cname.json")"
    if [ "$owner" = other ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the CNAME $host carries another app's mark (saf-app/saf-env); it and its _dnsauth TXT are left alone"
      return 0
    fi
    if [ "$(fd_cname_target "$dir/cname.json")" != "${expected,,}" ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the CNAME $host no longer points at the Front Door endpoint; it and its _dnsauth TXT are left alone"
      return 0
    fi
    legacy_ok=true
    fd_delete "$cname_id" "$DNS_API"
  fi
  fd_dns_read "$txt_id" "$dir/txt.json"
  if [ -f "$dir/txt.json" ]; then
    owner="$(fd_dns_owner "$dir/txt.json")"
    if [ "$owner" = mine ] || { [ "$owner" = unmarked ] && [ "$legacy_ok" = true ]; }; then
      fd_delete "$txt_id" "$DNS_API"
    else
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the _dnsauth TXT of $host is not this app's (another app's mark, or no mark and no CNAME of this app next to it); it is left alone"
      return 0
    fi
  fi
  saf_info "  Removed the DNS records of $host (CNAME and _dnsauth TXT)"
}

# fd_nested_cleanup <plan>: the nested deployment records of this app's fd-{slug}-{env}, before the
# record itself is deleted (ADR-0052: deployment history, 800 per scope, is shared by every app of the
# platform resource group and of the zone's resource group). Their IDs come from the operations of
# the app's own record, so only its own nested records are named: appRoute-<13> in the platform
# resource group, dnsRecords-<13> in the resource group of a zone the plan names, both in this
# environment's subscription; anything else is left alone. A failure is a warning: history only.
# TODO(verify) ISO-8: the operations list names the nested deployments with their resource group.
fd_nested_cleanup() {
  local plan="$1" rg deployment zone_rgs id parts nested_rg name kind err="$PROV_DIR/frontdoor/nested.err"
  rg="$(jq -r '.resourceGroup' "$plan")"
  deployment="$(jq -r '.deployment' "$plan")"
  zone_rgs=" $(jq -r '[.domains[].dns.zoneId // empty | split("/")[4] | ascii_downcase] | unique | join(" ")' "$plan") "
  if ! az deployment operation group list --resource-group "$rg" --name "$deployment" \
      --query "[?properties.targetResource.resourceType=='Microsoft.Resources/deployments'].properties.targetResource.id" \
      --output tsv --only-show-errors > "$PROV_DIR/frontdoor/nested.txt" 2> "$err"; then
    saf_neutralise < "$err" | tail -n 10
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not list the nested deployments of $deployment; their records stay in the deployment history"
    return 0
  fi
  while IFS= read -r id; do
    [ -n "$id" ] || continue
    if [[ ! "${id,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/[-a-z0-9._()]{1,90}/providers/microsoft\.resources/deployments/(approute|dnsrecords)-[a-z0-9]{13}$ ]]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: $deployment names an unexpected nested deployment; it is left alone"
      continue
    fi
    kind="${BASH_REMATCH[1]}"
    IFS=/ read -r -a parts <<< "$id"
    nested_rg="${parts[4]}"
    name="${id##*/}"
    if { [ "$kind" = approute ] && [ "${nested_rg,,}" != "${rg,,}" ]; } \
        || { [ "$kind" = dnsrecords ] && [[ "$zone_rgs" != *" ${nested_rg,,} "* ]]; }; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the nested deployment $name of $deployment is in an unexpected resource group; it is left alone"
      continue
    fi
    if az deployment group delete --name "$name" --resource-group "$nested_rg" --only-show-errors --output none 2> "$err"; then
      saf_info "  Removed the nested deployment record $name"
    else
      saf_neutralise < "$err" | tail -n 5
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not delete the nested deployment record $name; it stays in the deployment history"
    fi
  done < "$PROV_DIR/frontdoor/nested.txt"
}

# CA_API: the Microsoft.App API version of the Container App stop and start (ADR-0056).
CA_API=2024-03-01

# ca_status <app id>: the Container App's runningStatus (one word), or "absent". Any other error
# fails the app.
ca_status() {
  local id="$1" err="$PROV_DIR/ca-status.err" status
  if ! status="$(az resource show --ids "$id" --api-version "$CA_API" --query properties.runningStatus --output tsv --only-show-errors 2> "$err")"; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
      printf absent
      return 0
    fi
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not read the Container App of $slug in $env_name" >&2
    return 1
  fi
  [[ "$status" =~ ^[A-Za-z]{1,40}$ ]] || status=unknown
  printf '%s' "$status"
}

# retire_step: step R for the current app (ADR-0056): stop its own Container App, by naming.
# TODO(verify) DECOM-2: the stop scales to zero and serves nothing; runningStatus reads Stopped.
retire_step() {
  local app_id status i
  [ "$rg" = "$(prov_name "$names" appResourceGroup)" ] || saf_die "the resource group of $slug in $env_name is not the app's by naming"
  app_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.App/containerApps/$container_app"
  status="$(ca_status "$app_id")"
  if [ "$status" = absent ]; then
    saf_info "  $slug in $env_name has no Container App: nothing to stop (decommissioning)"
    prov_detail release retired-none
    return 0
  fi
  if [ "${status,,}" != stopped ]; then
    saf_info "  Stopping $container_app (decommissioning; nothing is deleted)"
    az rest --method post --url "$app_id/stop?api-version=$CA_API" --only-show-errors --output none
    for ((i = 0; i < 60; i++)); do
      status="$(ca_status "$app_id")"
      [ "${status,,}" != stopped ] || break
      sleep 10
    done
    [ "${status,,}" = stopped ] || saf_die "$container_app is still $status 10 minutes after its stop; the next run tries again"
  fi
  saf_info "  $slug in $env_name is stopped (decommissioning)"
  prov_detail release retired
}

# start_step: Cancel (ADR-0056), before the release's re-apply: a Stopped Container App of the app
# (by naming) is started. TODO(verify) DECOM-11: start brings the latest revision back.
start_step() {
  local app_id status
  [ "$rg" = "$(prov_name "$names" appResourceGroup)" ] || saf_die "the resource group of $slug in $env_name is not the app's by naming"
  app_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.App/containerApps/$container_app"
  status="$(ca_status "$app_id")"
  [ "${status,,}" = stopped ] || return 0
  saf_info "  Starting $container_app again (decommissioning cancelled)"
  az rest --method post --url "$app_id/start?api-version=$CA_API" --only-show-errors --output none
  prov_detail release started
}

# decom_frontdoor: step D for the current app (ADR-0056): its custom domain removed in the delete
# phase, with step 6's guards, without a release (the app is stopped).
decom_frontdoor() {
  local dir="$PROV_DIR/frontdoor" name platform_rg
  mkdir -p "$dir"
  rm -f "$dir/before.json" "$dir/deployment.json"
  fd_removing=""
  name="$(prov_name "$names" frontDoorDeployment)"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  prov_record group "$name" "$platform_rg" "$dir/record.json"
  if [ -f "$dir/record.json" ]; then
    cp "$dir/record.json" "$dir/before.json"
    fd_removing="$(jq -r '.properties.parameters.hostName.value // ""' "$dir/record.json")"
    prov_valid_host "$fd_removing" || saf_die "the record $name has no valid parameter hostName"
    front_door_cleanup decommission
  else
    saf_info "  $slug in $env_name has no custom domain record: nothing to remove"
  fi
  prov_detail frontDoor removed
  prov_done delete-frontdoor
}

# release_step: step 4 for the current app.
release_step() {
  local dir mode attempt
  dir="$PROV_DIR/release"
  mkdir -p "$dir"
  read_records "$dir"
  prov_state "$dir" "$ado_outputs"
  if [ "$auth_mode" = required ]; then
    if [ -z "$(jq -r '.entra.clientId? // ""' "$dir/state.json")" ] \
        || [ "$(jq -r '.easyAuthSecretExists' "$dir/state.json")" != true ]; then
      prov_detail release waiting-sign-in
      prov_wait "$slug in $env_name requires sign-in but has no Entra registration or Easy Auth secret yet; its release is not touched"
    fi
  fi
  # A removal opens the ingress: for an app with sign-in only once Entra knows the default host again.
  if [ -n "${fd_removing:-}" ] && [ "$auth_mode" = required ] && ! entra_lists_default_host "$dir"; then
    prov_detail release waiting-entra
    prov_wait "$slug in $env_name: its custom domain $fd_removing is being removed, but its Entra registration doesn't list the default host's redirect URI yet (approve this run's entra stage); the release stays behind Front Door until it does"
  fi
  if [ -f "$dir/release-record.json" ]; then
    mode=reapply
    # ADR-0056, Cancel: the app the decommissioning stopped starts before its re-apply.
    if prov_was_retired "$slug" "$env_name"; then start_step; fi
  else
    mode=bootstrap
    check_no_container_app "$dir"
    import_placeholder "$dir"
  fi
  saf_info "  release mode: $mode"

  attempt=1
  while :; do
    render_release "$dir" "$mode"
    ingress_detail "$dir/release.json"
    if [ "$prov_verdict" = up-to-date ]; then
      prov_detail release up-to-date
      return 0
    fi
    [ "$mode" = reapply ] || break
    check_run "$dir"
    [ "$run_guard" = moved ] || break
    if [ "$attempt" -ge 2 ]; then
      prov_detail release waiting-delivery
      prov_wait "$slug in $env_name: the Container App runs another delivery run than the release record names (a delivery is deploying); the next run re-applies"
    fi
    attempt=2
    saf_info "  a delivery deployed $slug in $env_name after its record was read; reading the record again"
    read_records "$dir"
    [ -f "$dir/release-record.json" ] || saf_die "the release record $release_name disappeared"
    prov_state "$dir" "$ado_outputs"
  done

  prov_arm create release "$dir/release.json" "$release_name" "$rg" "$dir/deployment.json"
  if [ "$mode" = bootstrap ]; then prov_detail release bootstrap-deployed; else prov_detail release reapplied; fi
  if [ "$mode" = reapply ]; then race_check "$dir"; fi
  smoke "$dir"
}

# race_check <dir>: the stale re-apply race (ADR-0052 open findings; ADR-0032 decision 8). check_run
# read the Container App's saf-run-id right before the create, but a delivery can still deploy between
# that read and the PUT, and the re-apply then puts the older release back. ARM offers no conditional
# PUT for a deployment (no If-Match on Microsoft.Resources/deployments), so this narrows the race and
# makes it visible instead; right after the create:
#   - saf-run-id no longer the record's run.id: a delivery deployed after this re-apply, its release
#     stands; nothing to do;
#   - else a revision created since the check (2 minutes of margin for clock skew) with another image
#     than this re-apply deployed: a delivery deployed in between. A warning (redeploy the app's
#     latest delivery run; the release record now names the older run, so no provisioning run can
#     restore it) and detail release reapplied-raced, which record_<env> doesn't record as finished.
# A list that can't be read is a warning only. TODO(verify) ISO-1: a delivery's deployment and this
# re-apply racing (whether ARM refuses a second deployment of the same name while one runs).
race_check() {
  local dir="$1" app_id recorded tag image raced
  app_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.App/containerApps/$container_app"
  recorded="$(jq -r '(.properties.parameters.run.value.id // "") | tostring' "$dir/release-record.json")"
  if ! tag="$(az resource show --ids "$app_id" --query 'tags."saf-run-id"' --output tsv --only-show-errors 2> "$dir/race.err")"; then
    saf_neutralise < "$dir/race.err" | tail -n 5
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not read the Container App after the re-apply; a delivery deployed in between would go unnoticed"
    return 0
  fi
  if [ "$tag" != "$recorded" ]; then
    saf_info "  A delivery deployed $slug in $env_name right after this re-apply; its release stands"
    return 0
  fi
  image="$(jq -r '.properties.outputs.image.value // ""' "$dir/deployment.json")"
  if ! prov_arm_list "$app_id/revisions?api-version=2024-03-01" "$dir/race-revisions.json"; then
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not list the revisions after the re-apply; a delivery deployed in between would go unnoticed"
    return 0
  fi
  raced="$(jq -r --argjson t "$((run_checked_at - 120))" --arg i "$image" "$PROV_JQ_EPOCH"' [.[] | select(((.properties.createdTime // "") | epoch) >= $t)
      | select((.properties.template.containers[0].image // "") != $i)] | length' "$dir/race-revisions.json")"
  [[ "$raced" =~ ^[0-9]+$ ]] || raced=0
  if [ "$raced" -gt 0 ]; then
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: a delivery deployed while provisioning re-applied the release, and the re-apply put the older release back. Redeploy the app's latest delivery run now (portal: Deploys; or queue its pipeline with that run as the source)"
    prov_detail release reapplied-raced
  fi
}

# ---------------------------------------------------------------------------------------------
# M. The move of a network mode change (ADR-0060 decision 6): a release with the plan's action move
# (prov_unit_action, units.json modeChange {from, to, case, fromCell, toCell}). A short outage, no second
# app: the app is deleted in its source CAE and created again in the target CAE with the release record's
# values. The CAEs in their capacity cells (ADR-0053, ADR-0060 amendment 2026-11-16): the source in the
# cell the live app runs in (fromCell), the target in app.yaml's (toCell), which the landing zone and the
# release name too; the target mode's cell needn't have the source's number.
# Before it, azure_<env> deployed the landing zone's prepare pass (and this stage's step 1 again), and
# the stage entra re-issued the Easy Auth secret in the target vault (case A). In this order:
#   0. an environment of kind prod outside the maintenance window (the plan's modeChange.waitsForWindow,
#      product owner 2026-11-14): `waiting` (detail move waiting-window, the next window's start in the
#      reason) and nothing below runs; kind nonprod, a run inside the window, or a resumed move go on;
#   a. preconditions, read before anything changes: the Container App (move_app_read) runs in the
#      source CAE by naming, its image is the release record's digest and its tag saf-run-id the
#      record's run (as check_run), the Entra client ID and the target vault's Easy Auth secret exist
#      (prov_state); otherwise `waiting` (detail move waiting-<what>) and the app is untouched. Gone
#      already, or in the target CAE: a resumed move (an earlier run deleted it, or it never ran
#      there), which skips b and c and needs only the client ID and the secret;
#   b. the delivery identity's App Environment Joiner on the source CAE (move_joiner_delete): a delivery
#      started now fails cleanly instead of creating the app there again. Verify in sandbox: NMC-4;
#   c. ca-{slug} deleted, and read until it is gone (at most 10 minutes; move_app_delete). The outage
#      starts;
#   d. case B: the app's private endpoints outside the target spoke's VNet (move_endpoints: they can't
#      change subnet, NMC-3);
#   e. the final landing zone (prov_lz without prepare: modeChange null): public access off (case A
#      into hybrid) or the endpoints in the target spoke (case B);
#   f. dbinit through the target CAE's job (database_entry; idempotent), then the lz unit is done;
#   g. the custom domain (step 3: the origin follows the new default host), the release re-applied
#      with the record's values into the new CAE (step 4, its smoke test), the Easy Auth restart check
#      (step 5), then the new default host read with a GET (NMC-1: the PUT's answer echoes the old
#      host) -> detail moveHost; the outage ends;
#   h. cleanup: case A, the Easy Auth identity's Key Vault Secrets User on the old variant's secret
#      (move_secret_role); case A out of hybrid, every private endpoint of the app's resources
#      (move_endpoints: the app left the VNet; the portal-side endpoint then goes in the host's step 7).
#      No transitional firewall rule exists to remove: the platform changes none (ADR-0003, amended
#      2026-11-12); the network team removes what it opened;
#   i. detail move moved (moveOutage <start> <end>, epoch seconds), done lz and release: record_<env>
#      records them only now. A failure part-way fails the app; the next run resumes: the app gone and
#      the landing-zone record naming the target (its prepare pass) or the source mode -> the plan's
#      modeChange resume, from d; after e, the plain lz and release units (not recorded) finish it.
# Every delete is the app's own object by naming, each behind its guard (check-templates.py P26, P28).
# ---------------------------------------------------------------------------------------------

# move_app_read <app id> <output>: {exists, environmentId, image, runId} of the app's Container App now.
move_app_read() {
  local id="$1" out="$2" err="$PROV_DIR/move-app.err"
  if az resource show --ids "$id" --api-version "$CA_API" --only-show-errors --output json \
      --query '{environmentId: (properties.environmentId || properties.managedEnvironmentId), image: properties.template.containers[0].image, runId: tags."saf-run-id"}' \
      > "$out.tmp" 2> "$err"; then
    jq '{exists: true, environmentId: (.environmentId // ""), image: (.image // ""), runId: ((.runId // "") | tostring)}' "$out.tmp" > "$out"
    rm -f "$out.tmp"
    return 0
  fi
  rm -f "$out.tmp"
  if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
    jq -n '{exists: false, environmentId: "", image: "", runId: ""}' > "$out"
    return 0
  fi
  saf_neutralise < "$err" | tail -n 10
  saf_die "could not read the Container App of $slug in $env_name before its move; it is left alone"
}

# move_joiner_delete <source CAE id>: step b. The delivery identity is the app's by naming
# (deliveryIdentity of names.bicep, read in the app's resource group); only its assignments at exactly
# the source CAE go, nothing inherited, nobody else's.
move_joiner_delete() {
  local cae="$1" principal id scope
  [[ "${cae,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/[-a-z0-9]{1,90}/providers/microsoft\.app/managedenvironments/cae-[a-z0-9-]{1,28}$ ]] \
    || saf_die "move_joiner_delete: not a CAE of this subscription"
  principal="$(az identity show --resource-group "$rg" --name "$(prov_name "$names" deliveryIdentity)" --query principalId --output tsv --only-show-errors)"
  prov_valid_guid "$principal" || saf_die "could not read the delivery identity of $slug in $env_name"
  az role assignment list --assignee "$principal" --scope "$cae" --query '[].{id: id, scope: scope}' --output json --only-show-errors > "$PROV_DIR/move/joiner.json"
  while IFS=$'\t' read -r id scope; do
    [ -n "$id" ] || continue
    if [ "${scope,,}" != "${cae,,}" ] || [[ "${id,,}" != "${cae,,}/providers/microsoft.authorization/roleassignments/"* ]]; then continue; fi
    saf_info "  Removing the delivery identity's role on the source CAE (${id##*/}): a delivery started now fails instead of creating the app there again"
    az role assignment delete --ids "$id" --only-show-errors --output none
  done < <(jq -r '.[] | [(.id // "" | tostring), (.scope // "" | tostring)] | @tsv' "$PROV_DIR/move/joiner.json")
}

# move_app_delete <app id>: step c. The app's own Container App by naming; then read until it is gone.
move_app_delete() {
  local id="$1" status i
  [ "${id,,}" = "/subscriptions/${subscription,,}/resourcegroups/${rg,,}/providers/microsoft.app/containerapps/${container_app,,}" ] \
    || saf_die "move_app_delete: not the app's Container App by naming"
  saf_info "  Deleting $container_app in its source environment (network mode change; the outage starts)"
  az resource delete --ids "$id" --api-version "$CA_API" --only-show-errors --output none
  for ((i = 0; i < 60; i++)); do
    status="$(ca_status "$id")"
    [ "$status" != absent ] || return 0
    sleep 10
  done
  saf_die "$container_app is still there 10 minutes after its delete; the next run resumes the move"
}

# move_endpoints <VNet ID to keep | ''>: steps d and h. The private endpoints in the app's resource group
# (by naming) whose every connection targets a resource of that group, except the ones in a subnet of
# the VNet to keep ('' = none kept). The portal-side endpoint is in the portal resource group, never here.
move_endpoints() {
  local keep="${1,,}" id subnet targets n=0
  az network private-endpoint list --resource-group "$rg" --only-show-errors --output json \
    --query '[].{id: id, subnet: subnet.id, auto: privateLinkServiceConnections[].privateLinkServiceId, manual: manualPrivateLinkServiceConnections[].privateLinkServiceId}' \
    > "$PROV_DIR/move/endpoints.json"
  while IFS=$'\t' read -r id subnet targets; do
    [[ "${id,,}" =~ ^/subscriptions/${subscription,,}/resourcegroups/${rg,,}/providers/microsoft\.network/privateendpoints/[a-z0-9.-]{1,80}$ ]] || continue
    # The guard: an endpoint of the app's own resources (every target in its group), nothing shared.
    [ -n "$targets" ] || continue
    if [ -n "$(tr ' ' '\n' <<< "${targets,,}" | grep -v "^/subscriptions/${subscription,,}/resourcegroups/${rg,,}/providers/" || true)" ]; then
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: the private endpoint ${id##*/} in its resource group links a resource outside it; it is left alone"
      continue
    fi
    if [ -n "$keep" ] && [[ "${subnet,,}" == "$keep/subnets/"* ]]; then continue; fi
    saf_info "  Removing the private endpoint ${id##*/} (network mode change)"
    az network private-endpoint delete --ids "$id" --only-show-errors --output none
    n=$((n + 1))
  done < <(jq -r '.[] | [(.id // "" | tostring), (.subnet // "" | tostring),
      ([(.auto // [])[], (.manual // [])[]] | map(tostring) | join(" "))] | @tsv' "$PROV_DIR/move/endpoints.json")
  saf_info "  Private endpoints removed: $n"
}

# move_secret_role <old vault>: step h, case A. The role assignments of the identities in the app's
# resource group (the ownership proof, as lz_outside_assignments) at exactly the app's Easy Auth secret
# in the old variant's environment vault (names.bicep), the Easy Auth identity's Key Vault Secrets User.
move_secret_role() {
  local vault="$1" platform_rg scope principal id at
  prov_valid_vault "$vault" || saf_die "move_secret_role: invalid vault name"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  scope="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.KeyVault/vaults/$vault/secrets/$(prov_name "$names" easyAuthSecret)"
  az identity list --resource-group "$rg" --query '[].principalId' --output tsv --only-show-errors > "$PROV_DIR/move/principals.txt"
  while IFS= read -r principal; do
    prov_valid_guid "$principal" || continue
    az role assignment list --assignee "$principal" --scope "$scope" --query '[].{id: id, scope: scope}' --output json --only-show-errors > "$PROV_DIR/move/secret-roles.json"
    while IFS=$'\t' read -r id at; do
      if [ -z "$id" ] || [ "${at,,}" != "${scope,,}" ]; then continue; fi
      saf_info "  Removing the role assignment ${id##*/} on the previous variant's Easy Auth secret"
      az role assignment delete --ids "$id" --only-show-errors --output none
    done < <(jq -r '.[] | [(.id // "" | tostring), (.scope // "" | tostring)] | @tsv' "$PROV_DIR/move/secret-roles.json")
  done < "$PROV_DIR/move/principals.txt"
}

# move_step <from>: step M for the current app (see above). The CAEs by naming (names.bicep) with their
# capacity cells (ADR-0053): the source in the cell the live app runs in (the plan's fromCell), the target
# in app.yaml's cell (toCell), which the landing zone and the release use too; a resumed move has no
# source cell (the app was gone when the plan read it), so an app found anywhere but the target is left
# alone.
move_step() {
  local from="$1" to case_ dir="$PROV_DIR/move" platform_rg app_id old_cae="" new_cae live phase start=none end client secret digest recorded target_vnet fqdn window from_cell to_cell
  mkdir -p "$dir"
  to="$(prov_app_network_mode "$slug" "$env_name")"
  [ "$to" = "$(prov_mode_change "$slug" "$env_name" to)" ] || saf_die "the plan moves $slug in $env_name to another mode than app.yaml names"
  case_="$(prov_mode_change "$slug" "$env_name" case)"
  from_cell="$(prov_mode_change "$slug" "$env_name" fromCell)"
  to_cell="$(prov_mode_change "$slug" "$env_name" toCell)"
  [ "$to_cell" = "$(prov_app_cell "$slug" "$env_name")" ] || saf_die "the plan moves $slug in $env_name into another capacity cell than app.yaml names"
  [ "$rg" = "$(prov_name "$names" appResourceGroup)" ] || saf_die "the resource group of $slug in $env_name is not the app's by naming"
  prov_names "$slug" "$dir/names-from.json" "$env_name" "$from" "" "" "${from_cell:-none}"
  prov_names "$slug" "$dir/names-to.json" "$env_name" "$to" "" "" "$to_cell"
  platform_rg="$(prov_name "$names" platformResourceGroup)"
  app_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.App/containerApps/$container_app"
  if [ -n "$from_cell" ]; then
    old_cae="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.App/managedEnvironments/$(prov_name "$dir/names-from.json" managedEnvironment)"
  fi
  new_cae="/subscriptions/$subscription/resourceGroups/$platform_rg/providers/Microsoft.App/managedEnvironments/$(prov_name "$dir/names-to.json" managedEnvironment)"
  saf_info "  Network mode change: $from${from_cell:+ (cell $from_cell)} to $to (cell $to_cell, case $case_)"
  prov_detail moveCase "$case_"
  # Kind prod (product owner, 2026-11-14): the disruptive part only inside the maintenance window; the
  # prepare pass and the Entra step ran already. The plan decided it once for the run (its --now).
  window="$(prov_mode_change "$slug" "$env_name" waitsForWindow)"
  if [ -n "$window" ]; then
    prov_detail move waiting-window
    prov_wait "$slug in $env_name: waits for the maintenance window ($window): a production environment moves only inside it; the prepare pass and the Entra step ran, the app is untouched"
  fi

  # a. Preconditions: where the app is, its image and run against the record, sign-in ready.
  move_app_read "$app_id" "$dir/app.json"
  live="$(jq -r '.environmentId' "$dir/app.json")"
  if [ "$(jq -r '.exists' "$dir/app.json")" != true ] || [ "${live,,}" = "${new_cae,,}" ]; then
    phase=resume
    saf_info "  The app is not in its source environment any more: the move resumes after the delete"
  elif [ -n "$old_cae" ] && [ "${live,,}" = "${old_cae,,}" ]; then
    phase=full
  else
    saf_die "$container_app runs in another environment than the source or target CAE of its move; it is left alone (check it by hand)"
  fi
  read_records "$dir"
  prov_state "$dir" "$ado_outputs"
  if [ "$phase" = full ]; then
    if [ ! -f "$dir/release-record.json" ]; then
      prov_detail move waiting-record
      prov_wait "$slug in $env_name: its Container App has no release record to re-create it from; the move waits and the app is untouched"
    fi
    digest="$(jq -r '.properties.parameters.image.value.digest // ""' "$dir/release-record.json")"
    recorded="$(jq -r '(.properties.parameters.run.value.id // "") | tostring' "$dir/release-record.json")"
    if [[ ! "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || [[ "$(jq -r '.image' "$dir/app.json")" != *"@$digest" ]]; then
      prov_detail move waiting-image
      prov_wait "$slug in $env_name: the app runs another image than its release record names (a delivery is deploying, or the record is older); the move waits and the app is untouched"
    fi
    if [ "$(jq -r '.runId' "$dir/app.json")" != "$recorded" ]; then
      prov_detail move waiting-delivery
      prov_wait "$slug in $env_name: the app runs another delivery run than its release record names; the move waits and the app is untouched"
    fi
  fi
  if [ "$auth_mode" = required ]; then
    client="$(jq -r '.entra.clientId? // ""' "$dir/state.json")"
    secret="$(jq -r '.easyAuthSecretExists' "$dir/state.json")"
    if [ -z "$client" ] || [ "$secret" != true ]; then
      prov_detail move waiting-sign-in
      prov_wait "$slug in $env_name: its Entra registration or its Easy Auth secret in the target vault is missing (approve this run's entra stage); the move waits and the app is untouched"
    fi
  fi

  if [ "$phase" = full ]; then
    # b. No delivery into the source CAE any more.
    move_joiner_delete "$old_cae"
    # c. The outage starts.
    start="$(date -u +%s)"
    move_app_delete "$app_id"
  fi
  # d. Case B: the endpoints in the source spoke can't move (NMC-3).
  if [ "$case_" = B ]; then
    target_vnet="$(az resource show --ids "$new_cae" --api-version "$CA_API" --query properties.vnetConfiguration.infrastructureSubnetId --output tsv --only-show-errors)"
    target_vnet="${target_vnet%/subnets/*}"
    [[ "${target_vnet,,}" =~ ^/subscriptions/[0-9a-f-]{36}/resourcegroups/[-a-z0-9._()]{1,90}/providers/microsoft\.network/virtualnetworks/[-a-z0-9._]{1,64}$ ]] \
      || saf_die "the target CAE of $slug in $env_name has no VNet to keep its endpoints in"
    move_endpoints "$target_vnet"
  fi
  # e. The final landing zone; f. dbinit through the target CAE's job.
  prov_lz "$PROV_DIR/lz" "$out/lz-outputs/$slug.$env_name.json" "$ado_outputs"
  database_entry "$out/lz-outputs/$slug.$env_name.json"
  prov_done lz
  # g. The custom domain, the release into the new CAE, the Easy Auth check; the new host by GET.
  front_door_step
  release_step
  restart_stale
  fqdn="$(az resource show --ids "$app_id" --api-version "$CA_API" --query properties.configuration.ingress.fqdn --output tsv --only-show-errors)"
  [[ "${fqdn,,}" =~ ^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]] || saf_die "could not read the new default host of $slug in $env_name"
  end="$(date -u +%s)"
  saf_info "  $slug in $env_name answers on https://${fqdn,,} (network mode $to)"
  prov_detail moveHost "${fqdn,,}"
  # h. Cleanup.
  if [ "$case_" = A ]; then
    move_secret_role "$(prov_name "$dir/names-from.json" environmentVault)"
    if [ "$from" = externalHybrid ]; then move_endpoints ""; fi
  fi
  # i. Done: record_<env> records lz and release only now.
  prov_detail moveOutage "$start $end"
  prov_detail move moved
  prov_done release
  # 6. A custom domain no longer requested goes, as after any release.
  front_door_cleanup removal
}

# ---------------------------------------------------------------------------------------------
# 7. Portal-side private endpoints of app vaults (ADR-0025), after the releases of this stage.
#
# In the stage of the portal host environment (portal.hostEnvironment): for every app of the plan
# and every environment it runs in whose pep the plan runs there and whose landing zone is ok
# (prov_lz_ok; every azure_<env> ran before this stage, so every vault exists; the vault's name from
# the app's entries, prov_entry_dir), one unit (prov_run_app, status portal/status/{slug}.{env}.json
# of this stage's artifact):
#   - `inputs --step portal-endpoint`, the record pep-portal-{slug}-{env} in the portal resource group;
#   - a record that names another vault than the landing zone reports (a new generation): the
#     previous vault's endpoint is removed first (portal_endpoint_remove; the portal uses only the
#     current vault), detail portalEndpointPrevious removed (ADR-0025 amendment 2026-11-14);
#   - not VNet-based (the app moved to the managed network): no endpoint needed; one still there and
#     its record are removed once the vault has public network access and no other private endpoint
#     connection (portal_endpoint_left; detail portalEndpoint removed), else kept with a warning
#     (portalEndpoint leftover: while the vault's own endpoint in its old spoke is left, its name
#     still points into privatelink.vaultcore.azure.net, so the portal VNet resolves it only through
#     this endpoint); none -> portalEndpoint not-needed;
#   - no portal resource group rg-{prefix}-portal-{host} yet -> `waiting` (portal.bicep first; the
#     group, not its deployment record, which deployment-history cleanup may remove);
#   - validate, compare with the record, deploy through portal-endpoint.bicepparam unless up to date;
#     the template's vault must be the one the landing zone reports;
#   - the connection state: Approved -> ok (portalEndpoint deployed|up-to-date); Pending -> `waiting`
#     (a vault in another subscription: its environment's run approves it); anything else -> failed.
# Every removal (also step P of a decommissioning) goes through portal_endpoint_remove and
# portal_endpoint_forget, each only for this app's names (ADR-0052). Then one scan of the portal
# resource group: endpoint records of an app or environment that is gone without a decommissioning
# -> warning (delete by hand: the rest of its landing zone is left too). In every other environment
# with its own subscription: the Pending connection of the portal-side endpoint on each app vault of
# this stage is approved (a failure is a warning; the host's status stays `waiting`).
# Verify in sandbox: KV-6, KV-12.
# ---------------------------------------------------------------------------------------------

portal_endpoints() {
  local host e rc
  host="$(prov_portal_host)"
  if [ "$env_name" != "$host" ]; then
    portal_endpoint_approvals "$host"
    return 0
  fi
  prov_plan_apps
  saf_info ""
  saf_info "Portal-side endpoints of app vaults: ${#PROV_APPS[@]} app(s)."
  for slug in "${PROV_APPS[@]}"; do
    prov_app_envs "$slug"
    for e in "${PROV_APP_ENVS[@]}"; do
      if ! prov_unit_runs "$slug" "$e" pep; then
        prov_pass "$slug" "$e"
        continue
      fi
      if ! prov_lz_ok "$slug" "$e"; then
        prov_skip "$slug" "its landing zone in $e is not ok (portal-side endpoint)"
        continue
      fi
      if [ "$(prov_unit_action "$slug" "$e" pep)" = delete ]; then
        prov_run_app "$(prov_status_path "$out/portal" "$slug" "$e")" "$slug" "$e" portal_endpoint_delete "$slug" "$e"
        continue
      fi
      prov_run_app "$(prov_status_path "$out/portal" "$slug" "$e")" "$slug" "$e" portal_endpoint "$slug" "$e"
    done
  done
  prov_join
  [ "${#PROV_APPS[@]}" -gt 0 ] || return 0
  PROV_DIR="$SAF_WORK/portal-scan"
  rm -rf "$PROV_DIR"
  mkdir -p "$PROV_DIR"
  set +e
  (
    set -e
    portal_endpoints_left
  )
  rc=$?
  set -e
  [ "$rc" -eq 0 ] || printf '##vso[task.logissue type=warning]%s\n' "could not check the portal resource group for left-over portal-side endpoints (exit $rc); see the log"
}

# portal_endpoint <slug> <env>: one unit of the host stage.
portal_endpoint() {
  local slug="$1" e="$2" dir="$PROV_DIR" app_file lz_outputs vault portal_rg deployment previous new state verdict
  app_file="$(prov_app_file "$slug")"
  lz_outputs="$(prov_entry_dir "$slug" "$e")/lz-outputs/$slug.$e.json"
  [ -f "$lz_outputs" ] || saf_die "no landing-zone outputs for $slug in $e (plan_$e or azure_$e)"
  vault="$(jq -r '.appKeyVaultName.value // ""' "$lz_outputs")"
  prov_valid_vault "$vault" || saf_die "the landing zone of $slug in $e has no valid output appKeyVaultName"
  prov_names "$slug" "$dir/names.json" "$e" "" "$env_name" "$vault"
  portal_rg="$(prov_name "$dir/names.json" portalResourceGroup)"
  deployment="$(prov_name "$dir/names.json" portalEndpointDeployment)"
  saf_cli provisioning inputs --step portal-endpoint --instance "$SAF_INSTANCE" --app "$app_file" --env "$e" --output "$dir/pe.json"
  prov_record group "$deployment" "$portal_rg" "$dir/record.json"
  # A new generation renamed the vault: the previous vault's endpoint goes (the portal uses only the
  # current vault); the next deployment writes the record over.
  previous="$(jq -r '.properties.outputs.vaultName.value // ""' "$dir/record.json" 2> /dev/null || true)"
  if [ -n "$previous" ] && [ "${previous,,}" != "${vault,,}" ]; then
    prov_valid_vault "$previous" || saf_die "the record $deployment in $portal_rg has no valid output vaultName"
    portal_endpoint_remove "$slug" "$e" "$previous"
    prov_detail portalEndpointPrevious removed
  fi
  if [ "$(jq -r '.vnetBased' "$dir/pe.json")" != true ]; then
    portal_endpoint_left "$slug" "$e" "$vault" "$deployment" "$portal_rg" "$(jq -r '.vaultSubscriptionId' "$dir/pe.json")"
    return 0
  fi
  if [ "$(az group exists --name "$portal_rg" --only-show-errors)" != true ]; then
    prov_detail portalEndpoint waiting
    prov_wait "$slug in $e: the portal is not deployed yet ($portal_rg, infra/platform/portal.bicep); its vault gets the portal-side endpoint once it is"
  fi
  prov_arm validate portal-endpoint "$dir/pe.json" "$deployment" "$portal_rg" "$dir/validate.json"
  prov_compare portal-endpoint "$dir/validate.json" "$dir/record.json"
  verdict="$prov_verdict"
  if [ "$verdict" = up-to-date ]; then
    jq -e '.properties.outputs' "$dir/record.json" > "$dir/outputs.json"
  else
    # The portal's subnet and DNS zone are shared: one endpoint deployment at a time (ADR-0046).
    prov_lock portal-endpoint
    prov_arm create portal-endpoint "$dir/pe.json" "$deployment" "$portal_rg" "$dir/deployment.json"
    prov_unlock
    jq -e '.properties.outputs' "$dir/deployment.json" > "$dir/outputs.json"
  fi
  [ "$(jq -r '.vaultName.value // ""' "$dir/outputs.json")" = "$vault" ] \
    || saf_die "the portal-side endpoint of $slug in $e targets another vault than its landing zone reports"
  new="$(jq -r '.endpointId.value // ""' "$dir/outputs.json")"
  [[ "$new" =~ ^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-a-zA-Z0-9]{1,90}/providers/Microsoft\.Network/privateEndpoints/[a-z0-9-]{1,64}$ ]] \
    || saf_die "the portal-side endpoint deployment of $slug in $e has no valid output endpointId"
  # The one connection, automatic or a manual request (portal-vault-endpoint.bicep).
  az resource show --ids "$new" --query properties --output json --only-show-errors > "$dir/endpoint.json"
  state="$(jq -r '[(.privateLinkServiceConnections // [])[], (.manualPrivateLinkServiceConnections // [])[]] | first
    | .properties.privateLinkServiceConnectionState.status // ""' "$dir/endpoint.json")"
  [[ "$state" =~ ^[A-Za-z]{0,20}$ ]] || state=unexpected
  case "$state" in
    Approved)
      saf_info "  $slug in $e: portal-side endpoint approved ($verdict)"
      if [ "$verdict" = up-to-date ]; then prov_detail portalEndpoint up-to-date; else prov_detail portalEndpoint deployed; fi
      ;;
    Pending)
      prov_detail portalEndpoint waiting
      prov_wait "$slug in $e: the portal-side endpoint of its vault waits for approval on the vault; the provisioning run of $e approves it (ADR-0025)"
      ;;
    *)
      saf_die "the portal-side endpoint of $slug in $e has the connection state ${state:-none}, not Approved; see infra/README.md"
      ;;
  esac
}

# portal_endpoint_delete <slug> <env>: step P (ADR-0056): the portal-side endpoint of a decommissioned
# app's vault, and its record, in the portal resource group, before the landing zone's delete (step 2)
# deletes the vault. Through portal_endpoint_remove and portal_endpoint_forget (their guards). Gone
# already = done.
portal_endpoint_delete() {
  local slug="$1" e="$2" dir="$PROV_DIR" lz_outputs vault portal_rg deployment
  lz_outputs="$(prov_entry_dir "$slug" "$e")/lz-outputs/$slug.$e.json"
  if [ ! -f "$lz_outputs" ]; then
    saf_info "  $slug in $e: no landing-zone outputs, so no vault and no portal-side endpoint to remove"
    prov_detail portalEndpoint removed
    prov_done delete-pep
    return 0
  fi
  vault="$(jq -r '.appKeyVaultName.value // ""' "$lz_outputs")"
  prov_valid_vault "$vault" || saf_die "the landing zone of $slug in $e has no valid output appKeyVaultName"
  prov_names "$slug" "$dir/names.json" "$e" "" "$env_name" "$vault"
  portal_rg="$(prov_name "$dir/names.json" portalResourceGroup)"
  deployment="$(prov_name "$dir/names.json" portalEndpointDeployment)"
  portal_endpoint_remove "$slug" "$e" "$vault"
  portal_endpoint_forget "$slug" "$e" "$deployment" "$portal_rg"
  prov_detail portalEndpoint removed
  prov_done delete-pep
}

# portal_endpoint_left <slug> <env> <vault> <deployment> <portal rg> <vault subscription>: the app's
# vault is no longer VNet-based (ADR-0025 amendment 2026-11-14). Its portal-side endpoint and the
# record go only when portal_vault_state says `free`. While the vault keeps another private endpoint
# connection (its own endpoint in the old spoke, which the landing zone's incremental deployment
# leaves) its public name still points into privatelink.vaultcore.azure.net, and the portal VNet,
# whose zone then has no record for it, could not resolve it at all; a vault this identity can't read
# (another subscription) is kept too. Both: a warning and detail portalEndpoint leftover.
portal_endpoint_left() {
  local slug="$1" e="$2" vault="$3" deployment="$4" portal_rg="$5" vault_sub="$6" dir="$PROV_DIR" endpoint_id vault_id exists state
  prov_valid_guid "$vault_sub" || saf_die "the portal-endpoint inputs of $slug in $e have no valid vaultSubscriptionId"
  # No record (portal_endpoint read it into $dir/record.json): the vault never had one; no call.
  exists=false
  if [ -f "$dir/record.json" ]; then
    endpoint_id="/subscriptions/$subscription/resourceGroups/$portal_rg/providers/Microsoft.Network/privateEndpoints/$(prov_name "$dir/names.json" portalVaultEndpoint)"
    exists="$(portal_endpoint_exists "$endpoint_id")"
  fi
  if [ "$exists" != true ]; then
    saf_info "  $slug in $e: managed-network vault, no portal-side endpoint (the portal uses its public endpoint)"
    portal_endpoint_forget "$slug" "$e" "$deployment" "$portal_rg"
    prov_detail portalEndpoint not-needed
    return 0
  fi
  vault_id="/subscriptions/$vault_sub/resourceGroups/$(prov_name "$dir/names.json" appResourceGroup)/providers/Microsoft.KeyVault/vaults/$vault"
  state="$(portal_vault_state "$vault_id" "$endpoint_id")"
  case "$state" in
    free)
      portal_endpoint_remove "$slug" "$e" "$vault"
      portal_endpoint_forget "$slug" "$e" "$deployment" "$portal_rg"
      saf_info "  $slug in $e: managed-network vault; its portal-side endpoint was removed (the portal uses its public endpoint)"
      prov_detail portalEndpoint removed
      ;;
    held)
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $e: its vault is no longer VNet-based, but it still has another private endpoint (or public network access is disabled), so its portal-side endpoint in $portal_rg stays: without it the portal VNet could not resolve the vault. Remove the vault's other endpoint; a later run removes this one (infra/README.md)"
      prov_detail portalEndpoint leftover
      ;;
    *)
      printf '##vso[task.logissue type=warning]%s\n' "$slug in $e: its vault is no longer VNet-based, but this identity can't read it (another subscription), so its portal-side endpoint in $portal_rg stays; delete it by hand once the vault has no other private endpoint (infra/README.md)"
      prov_detail portalEndpoint leftover
      ;;
  esac
}

# portal_vault_state <vault ID> <endpoint ID>: free | held | unknown, for a vault that is no longer
# VNet-based: free = it is gone, or it has public network access and no private endpoint connection
# but <endpoint ID>'s; held = another connection is left, or public network access isn't enabled;
# unknown = it can't be read (another subscription, where this identity has no rights, or any other
# error): the endpoint stays. Verify in sandbox: KV-12.
portal_vault_state() {
  local vault_id="$1" endpoint_id="$2" err="$PROV_DIR/vault.err"
  if ! az resource show --ids "$vault_id" --only-show-errors --output json \
      --query '{public: properties.publicNetworkAccess, endpoints: properties.privateEndpointConnections[].properties.privateEndpoint.id}' \
      > "$PROV_DIR/vault.json" 2> "$err"; then
    if grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then printf free; else printf unknown; fi
    return 0
  fi
  jq -r --arg pe "${endpoint_id,,}" 'if ((.public // "") | ascii_downcase) != "enabled" then "held"
    elif ([(.endpoints // [])[] | select(((. // "") | ascii_downcase) != $pe)] | length) > 0 then "held"
    else "free" end' "$PROV_DIR/vault.json"
}

# portal_endpoint_remove <slug> <env> <vault>: deletes the portal-side endpoint of the app's vault
# <vault> (its current one or a previous generation's) in the portal resource group, shared by every
# app (ADR-0052): only the endpoint named portalVaultEndpoint of names.bicep for that vault, and only
# when its connection targets that vault in the app's resource group by naming; anything else stops
# the unit and is left alone. Gone already = nothing. Under the portal endpoints' lock. Callers:
# portal_endpoint_delete (decommissioning), portal_endpoint (a previous generation) and
# portal_endpoint_left (no longer VNet-based).
portal_endpoint_remove() {
  local slug="$1" e="$2" vault="$3" dir="$PROV_DIR" names_file endpoint_id vault_id exists target
  prov_valid_vault "$vault" || saf_die "portal_endpoint_remove: invalid vault name"
  names_file="$dir/names-remove.json"
  prov_names "$slug" "$names_file" "$e" "" "$env_name" "$vault"
  endpoint_id="/subscriptions/$subscription/resourceGroups/$(prov_name "$names_file" portalResourceGroup)/providers/Microsoft.Network/privateEndpoints/$(prov_name "$names_file" portalVaultEndpoint)"
  vault_id="/resourceGroups/$(prov_name "$names_file" appResourceGroup)/providers/Microsoft.KeyVault/vaults/$vault"
  # A read error fails the unit (assigned first), so a record is never forgotten while its endpoint stays.
  exists="$(portal_endpoint_exists "$endpoint_id")"
  [ "$exists" = true ] || return 0
  az resource show --ids "$endpoint_id" --query properties --output json --only-show-errors > "$dir/endpoint-remove.json"
  target="$(jq -r '[(.privateLinkServiceConnections // [])[], (.manualPrivateLinkServiceConnections // [])[]] | first | .properties.privateLinkServiceId // ""' "$dir/endpoint-remove.json")"
  # The guard: the endpoint links this app's vault (its group by naming), nothing else.
  if [[ "${target,,}" != /subscriptions/*"${vault_id,,}" ]]; then
    saf_die "the portal-side endpoint ${endpoint_id##*/} links another resource than the vault $vault of $slug in $e; it is left alone (check it by hand)"
  fi
  saf_info "  Removing the portal-side endpoint ${endpoint_id##*/} of $slug in $e"
  prov_lock portal-endpoint
  az network private-endpoint delete --ids "$endpoint_id" --only-show-errors --output none
  prov_unlock
}

# portal_endpoint_forget <slug> <env> <deployment> <portal rg>: deletes the record
# pep-portal-{slug}-{env} in the portal resource group, only when its parameters name this app and
# environment (ADR-0052). None = nothing. Callers: portal_endpoint_delete, portal_endpoint_left.
portal_endpoint_forget() {
  local slug="$1" e="$2" deployment="$3" portal_rg="$4" dir="$PROV_DIR"
  prov_record group "$deployment" "$portal_rg" "$dir/record-forget.json"
  [ -f "$dir/record-forget.json" ] || return 0
  jq -e --arg s "$slug" --arg e "$e" '.properties.parameters.slug.value == $s and .properties.parameters.environmentName.value == $e' "$dir/record-forget.json" > /dev/null \
    || saf_die "the record $deployment in $portal_rg names another app or environment; it is left alone"
  az deployment group delete --name "$deployment" --resource-group "$portal_rg" --only-show-errors --output none
}

# portal_endpoint_exists <endpoint ID>: true | false.
portal_endpoint_exists() {
  local id="$1" err="$PROV_DIR/endpoint.err"
  [[ "$id" =~ ^/subscriptions/[0-9a-fA-F-]{36}/resourceGroups/[-a-zA-Z0-9]{1,90}/providers/Microsoft\.Network/privateEndpoints/[a-z0-9-]{1,64}$ ]] \
    || { echo "not a private endpoint ID" >&2; return 1; }
  if az resource show --ids "$id" --query id --output tsv --only-show-errors > /dev/null 2> "$err"; then
    printf true
  elif grep -Eq 'ResourceNotFound|ResourceGroupNotFound' "$err"; then
    printf false
  else
    saf_neutralise < "$err" | tail -n 10 >&2
    echo "could not check whether a portal-side endpoint exists" >&2
    return 1
  fi
}

# portal_endpoints_left: endpoint records in the portal resource group of an app or environment the
# plan no longer has (removed from platform-config, or no longer running there, without a
# decommissioning: the rest of its landing zone is left too, so a person looks at it) whose endpoint
# still exists -> warning. Apps with an invalid app.yaml this run are left alone. Records only from
# portal-vault-endpoint.bicep (they carry the parameter vaultSubscriptionId).
# TODO(verify): `az deployment group list` returns the parameters and outputs of each record.
portal_endpoints_left() {
  local dir="$PROV_DIR" portal_rg err="$PROV_DIR/list.err" slug e id
  # The portal names don't depend on the app: names.bicep with any app of the plan.
  prov_names "${PROV_APPS[0]}" "$dir/names.json" "$env_name" "" "$env_name"
  portal_rg="$(prov_name "$dir/names.json" portalResourceGroup)"
  if ! az deployment group list --resource-group "$portal_rg" --only-show-errors --output json \
      --query '[?properties.parameters.vaultSubscriptionId].{slug: properties.parameters.slug.value, env: properties.parameters.environmentName.value, id: properties.outputs.endpointId.value}' \
      > "$dir/records.json" 2> "$err"; then
    grep -q ResourceGroupNotFound "$err" && return 0
    saf_neutralise < "$err" | tail -n 10
    return 1
  fi
  while IFS=$'\t' read -r slug e id; do
    if ! prov_valid_slug "$slug" || ! prov_valid_env "$e"; then
      printf '##vso[task.logissue type=warning]%s\n' "a portal-side endpoint record in $portal_rg has no valid slug or environment; check it by hand"
      continue
    fi
    if [ -z "$id" ] || [ "$(portal_endpoint_exists "$id")" != true ]; then
      continue
    fi
    printf '##vso[task.logissue type=warning]%s\n' "$slug in $e: the app or environment is gone, but its portal-side endpoint in $portal_rg is still there; delete it by hand (infra/README.md)"
  done < <(jq -r --slurpfile plan "$SAF_APPS_JSON" '.[] | . as $r
      | select(($plan[0].apps | map(select(.slug == $r.slug)) | length) == 0
          or ($plan[0].apps | map(select(.slug == $r.slug and .ok == true and (((.environments // []) | index($r.env)) == null))) | length) > 0)
      | [(.slug // "" | tostring), (.env // "" | tostring), (.id // "" | tostring)] | @tsv' "$dir/records.json")
}

# portal_endpoint_approvals <host>: another environment than the host. Its vaults are in another
# subscription than the portal only when this environment's subscription differs from the host's;
# then the host's identity could only request the connection, and this environment's identity
# (Contributor on its subscription, ADR-0031) approves it. Per app whose pep the plan runs in this
# environment and whose landing zone is ok there (prov_lz_ok); a failure is a warning.
portal_endpoint_approvals() {
  local host="$1" host_sub rc
  PROV_DIR="$SAF_WORK/portal-approvals"
  rm -rf "$PROV_DIR"
  mkdir -p "$PROV_DIR"
  saf_cli pipeline instance-env --instance "$SAF_INSTANCE" --env "$host" --output "$PROV_DIR/host.json"
  host_sub="$(jq -r '.subscriptionId // ""' "$PROV_DIR/host.json")"
  prov_valid_guid "$host_sub" || saf_die "instance.yaml has no valid subscriptionId for $host"
  if [ "${host_sub,,}" = "${subscription,,}" ]; then
    saf_info "Portal-side endpoints: $env_name shares the portal's subscription; its connections are approved when they are created."
    return 0
  fi
  for slug in "${PROV_APPS[@]}"; do
    prov_unit_runs "$slug" "$env_name" pep || continue
    prov_lz_ok "$slug" "$env_name" || continue
    set +e
    (
      set -e
      portal_endpoint_approve "$slug" "$host" "$host_sub"
    )
    rc=$?
    set -e
    [ "$rc" -eq 0 ] || printf '##vso[task.logissue type=warning]%s\n' "$slug in $env_name: could not approve the portal-side endpoint of its vault (exit $rc); the next run tries again"
  done
}

# portal_endpoint_approve <slug> <host> <host subscription>: approve the Pending connection of
# pep-{vault}-portal (in the host's portal resource group) on the app vault, if there is one.
# Verify in sandbox: KV-6 (`az keyvault private-endpoint-connection approve` with the connection ID).
portal_endpoint_approve() {
  local slug="$1" host="$2" host_sub="$3" lz_outputs vault rg vault_id expected conn
  lz_outputs="$(prov_entry_dir "$slug" "$env_name")/lz-outputs/$slug.$env_name.json"
  vault="$(jq -r '.appKeyVaultName.value // ""' "$lz_outputs")"
  rg="$(jq -r '.resourceGroupName.value // ""' "$lz_outputs")"
  prov_valid_vault "$vault" || saf_die "the landing zone of $slug in $env_name has no valid output appKeyVaultName"
  [[ "$rg" =~ ^[-a-z0-9]{1,90}$ ]] || saf_die "the landing zone of $slug in $env_name has no valid output resourceGroupName"
  prov_names "$slug" "$PROV_DIR/names-$slug.json" "$env_name" "" "$host" "$vault"
  # The vault approved on is in the app's resource group by naming, never an output alone (ADR-0052).
  [ "$rg" = "$(prov_name "$PROV_DIR/names-$slug.json" appResourceGroup)" ] \
    || saf_die "the landing zone of $slug in $env_name names another resource group than the app's by naming; its vault is not touched"
  expected="/subscriptions/$host_sub/resourceGroups/$(prov_name "$PROV_DIR/names-$slug.json" portalResourceGroup)/providers/Microsoft.Network/privateEndpoints/$(prov_name "$PROV_DIR/names-$slug.json" portalVaultEndpoint)"
  vault_id="/subscriptions/$subscription/resourceGroups/$rg/providers/Microsoft.KeyVault/vaults/$vault"
  az resource show --ids "$vault_id" --query 'properties.privateEndpointConnections' --output json --only-show-errors > "$PROV_DIR/connections.json"
  conn="$(jq -r --arg pe "${expected,,}" '[.[]? | select(((.properties.privateEndpoint.id // "") | ascii_downcase) == $pe)
      | select(.properties.privateLinkServiceConnectionState.status == "Pending") | .id] | first // ""' "$PROV_DIR/connections.json")"
  [ -n "$conn" ] || return 0
  if [[ "${conn,,}" != "${vault_id,,}/privateendpointconnections/"* ]] || [[ ! "${conn##*/}" =~ ^[A-Za-z0-9._-]{1,128}$ ]]; then
    saf_die "the vault of $slug in $env_name lists a connection with an unexpected ID"
  fi
  az keyvault private-endpoint-connection approve --id "$conn" \
    --description "Portal-side endpoint of the portal in $host (ADR-0025), approved by the provisioning of $env_name" \
    --only-show-errors --output none
  saf_info "  $slug in $env_name: approved the portal-side endpoint of its vault"
}

prov_plan_apps "$env_name"
saf_info "Releases in $env_name: ${#PROV_APPS[@]} app(s)."
prov_parallel
for slug in "${PROV_APPS[@]}"; do
  if ! prov_post_runs "$slug" "$env_name"; then
    prov_pass "$slug" "$env_name"
    continue
  fi
  if ! prov_lz_ok "$slug" "$env_name"; then
    prov_skip "$slug" "its landing zone in $env_name is not ok"
    continue
  fi
  # ADR-0056: the stop of a decommissioned app (release retire) never waits for Azure DevOps or for
  # another environment; when either isn't ok, only the stop runs (retire-only).
  stop_only=""
  if prov_unit_runs "$slug" "$env_name" ado && ! prov_status_ok "$(prov_status_path "$SAF_IN/ado" "$slug")"; then
    if [ "$(prov_unit_action "$slug" "$env_name" release)" != retire ]; then
      prov_skip "$slug" "its Azure DevOps resources are not ok"
      continue
    fi
    stop_only=retire-only
  fi
  if [ -n "$source_env" ]; then
    prov_app_envs "$slug"
    if [[ " ${PROV_APP_ENVS[*]} " == *" $source_env "* ]] && ! prov_post_ok "$slug" "$source_env"; then
      if [ "$(prov_unit_action "$slug" "$env_name" release)" != retire ]; then
        prov_skip "$slug" "it is not ok in $source_env"
        continue
      fi
      stop_only=retire-only
    fi
  fi
  prov_run_app "$(prov_status_path "$out" "$slug" "$env_name")" "$slug" "$env_name" release_app "$slug" ${stop_only:+"$stop_only"}
done
# The approvals of portal-side endpoints read the landing-zone outputs the releases wrote.
prov_join
portal_endpoints
prov_finish
