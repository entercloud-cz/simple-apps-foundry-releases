#!/usr/bin/env python3
"""Policy tests for the app delivery, provisioning, platform-config validation and platform
environment templates (ADR-0006, ADR-0021, ADR-0024, ADR-0032, ADR-0040, ADR-0043).

Offline: reads pipelines/azure-devops/** and infra/modules/naming/naming.bicep, nothing else.
Needs Python 3.10+ and PyYAML (python3-yaml on Ubuntu; the core-ci job installs it if missing).

Every template reachable from app-delivery.yml or app-provisioning.yml (following relative
`template:` references) and every script under scripts/ is checked against the rules below. The
generic rules T01, T03-T05, T08-T11, T13, T16-T18 and T22 apply to every template tree; T02, T06,
T07, T12, T14, T15, T19-T21 and T23-T31 are delivery rules, P01-P28 provisioning rules, V01-V06
validation rules and E01-E17 platform pipeline rules. The environment lists in
tests/scenarios/*.json are also expanded the way Azure Pipelines compiles templates (a subset of
the template expression language: if/elseif/else, each, template includes with parameters,
the functions the templates use), and the expanded stage graph is checked (T23-T25, T28-T30). Then each
negative fixture in tests/fixtures/*.json is applied to an in-memory copy (find/replace patches
on one or more files) and the rule it names must fire, so a rule that silently stops working
fails the test too.

Rules:
  T01 YAML parses; no duplicate keys; no anchors/aliases (Azure Pipelines rejects them).
  T02 app-delivery.yml declares exactly five parameters: `app` and `environments` (object, no
      default), `action` (string, default deliver, values deliver|redeploy), `targetEnvironment`
      (string, default none) and `sourceRunId` (number, default 0); no `variables`, `resources`,
      `trigger`, `pool` at the root.
  T03 no template reachable from app-delivery.yml has a boolean, step/job/deployment/stage(List)
      parameter.
  T04 every stage has `isSkippable: false`.
  T05 `template:` references are relative paths inside this repo (no `@app`, `@self`, any `@`),
      and no `extends:` below the entry point.
  T06 verify stage: no azureSubscription / service connection input, no `environment`, no
      deployment job, no variable group, no AzureCLI task, no System.AccessToken; only
      source-run.sh and retain.sh mention SYSTEM_ACCESSTOKEN, and verify runs neither.
  T07 build job: every step (including included step templates) has
      `target.commands: restricted` and `target.settableVariables: none`.
  T08 script text (bash/script/inlineScript/arguments) contains no `$(Build.Source...)`,
      `$(Build.SourceVersionMessage)`, `$(System.PullRequest...)`, `$(Build.RequestedFor...)`,
      `$(resources....)` macro and no `${{ parameters... }}` expression: untrusted and
      parameter values reach scripts through `env:` only.
  T09 only built-in tasks from the allowlist; only checkout/download/bash/task/template steps.
  T10 no `continueOnError` anywhere, except `continueOnError: true` on the deploy-event step
      (AzureCLI@2 running scripts/report.sh in templates/steps/deployment-finish.yml, T30); no step
      sets `enabled`.
  T11 deployment jobs: runOnce, and the first step of the deploy hook is `download: none`.
  T12 deploy.sh: exactly one `az deployment group create`; every `--parameters` of any script is
      "$release_param" (= infra/app/delivery/release.bicepparam); no --template-file; no other
      script creates deployments (preview.sh only runs what-if).
  T13 downloads: curl/wget only in install-tool.sh (smoke.sh may probe the app with curl
      `--output /dev/null`; report.sh may make its one POST: HTTPS only, the token header from a
      file, a time limit, no redirects, no insecure TLS); `oras blob fetch|pull|cp` only by digest (`@`); npm only as
      `npm ci --ignore-scripts` or `npm run build`; no `docker pull`. java-archives.sh only lists
      layer contents (never extracts); the scan job runs it before the Java DB steps, and every
      Java DB step (resolve, Cache@2, install) is conditional on SAF_SCAN_JAVA.
  T14 tools/tools.json: required tools present; version, https url, sha256, binary; archive
      tar.gz|none; Sigstore entries complete; trivy signature-verified and not on the denylist;
      BuildKit image by digest; Trivy DB and Trivy Java DB settings.
  T15 service connection `sc-{slug}-{env}` and environment `{slug}-{env}` in the deploy, promote
      and preview templates and steps/deployment-finish.yml have the formats of naming.bicep
      adoServiceConnection / adoEnvironment.
  T16 every stage and job has `pool: {name: Azure Pipelines, vmImage: ubuntu-24.04}`.
  T17 no root or stage `variables`; no variable group anywhere.
  T18 checkouts: path s/core | s/config | s/app; fetchDepth 1, submodules false, lfs false,
      persistCredentials false; deployment jobs never check out the app.
  T19 app-delivery.yml carries the compile-time guards (empty slug, defaultBranch, kind, prod
      without promoteFrom, promote from itself, promoteFrom not in the list).
  T20 (expanded scenarios) conditions: deliver build stages `deployBuildEnvironments`, deliver
      preview/promotion stages `promote`, every redeploy stage `succeeded()`; every deploy stage
      has `lockBehavior: runLatest`.
  T22 no step of a deployment job (step templates included) sets `target.settableVariables`:
      Azure Pipelines can't load such a pipeline (seen 2026-10-29, both `none` and a list).
  T21 every script starts with a bash shebang (or `# shellcheck shell=bash`) and
      `set -euo pipefail`.
  T23 scenarios (tests/scenarios/*.json): the expanded stage list is the expected one; valid
      lists give a closed, acyclic graph with the dependsOn per environment (deliver: verify,
      deploy_<source>, preview for kind prod; redeploy: only `source`, the target's preview and
      deploy stages); invalid parameters fail compilation with the expected guard.
  T24 preview stages (expanded): one normal job `preview`, no environment, AzureCLI@2 with
      sc-{slug}-{env} and useGlobalConfig false running exactly
      $(Pipeline.Workspace)/s/core/pipelines/azure-devops/scripts/preview.sh, SAF_PROMOTE_FROM = the
      source environment.
  T25 deploy stages (expanded): one deployment job `release` on {slug}-{env}, AzureCLI@2 with
      sc-{slug}-{env} and useGlobalConfig false running exactly
      $(Pipeline.Workspace)/s/core/pipelines/azure-devops/scripts/deploy.sh (the core checkout). Build environments: image artifact, no
      SAF_PROMOTE_FROM. Promotion environments: SAF_PROMOTE_FROM = source, release-result-<source>,
      no image artifact; kind prod also downloads `scan` and runs scripts/gate.sh before AzureCLI.
  T26 deploy.sh import mode: publish_import() calls `az acr import` and never oras cp/push or
      docker push; `oras cp` only in publish_push(); publish_redeploy() never pushes; the
      newer-run guard (saf-run-id, skipped-newer-deployed) runs before the image is published.
  T27 System.AccessToken is mapped only in the jobs `resolve` (stage source) and `retain`.
  T28 (expanded) every deploy stage has exactly the jobs `release` (deployment) and `retain`
      (normal job after release, condition succeeded()): retain has no service connection, no app
      checkout, no artifact download, runs scripts/retain.sh for this run (deliver) or the source
      run (redeploy) with 365 days for prod and 90 for nonprod.
  T29 (expanded) the redeploy stage `source`: no dependsOn, one normal job `resolve` without an
      environment or Azure task, validates the run, verifies the source run, downloads from that
      run only (buildType specific, pipelineId = sourceRunId) release-manifest, release-result-<S>
      for a promotion target and scan for a prod target, and republishes them. buildType specific
      appears nowhere else.
  T30 deploy events for the portal (ADR-0037). Templates: scripts/report.sh runs only in the last
      step of templates/steps/deployment-finish.yml (parameters exactly `app` and `environment`,
      objects), an AzureCLI@2 step; no other template (provisioning included) names it. Expanded:
      every deploy stage's deployment job `release` ends with exactly that step and no other job
      (verify, preview, source, retain) has one; it runs exactly
      $(Pipeline.Workspace)/s/core/pipelines/azure-devops/scripts/report.sh (the core checkout,
      never s/config), uses sc-{slug}-{env}, the same connection as the job's deploy.sh step (also
      as SAF_SERVICE_CONNECTION), useGlobalConfig false, env exactly SAF_SLUG, SAF_ENV_NAME,
      SAF_SERVICE_CONNECTION and SAF_JOB_STATUS = $(Agent.JobStatus), condition
      succeededOrFailed(), continueOnError true, timeoutInMinutes 1-10, commands restricted, no
      job token. Script: exits only through `trap report_exit EXIT`, whose last line is `exit 0`;
      no saf_die and no `exit` other than `exit 0`; the one `get-access-token` of any delivery
      script, with --scope "api://$client_id/.default"; the token is masked (task.setsecret) before
      its only other use, the mode-600 header file, and never exported (export, declare -x,
      set -a); no pipeline OIDC token, no xtrace; the URL path and body of the contract.
  T31 capacity reservation (ADR-0053): data for release-inputs, never a switch. No delivery
      template names `capacity` (the reservation reaches the CLI only inside
      SAF_ENVIRONMENTS_JSON, rendered by `platform generate`); scripts/release-manifest.sh warns
      about it only with `saf_warn` and fixed text, and lib.sh saf_warn prints exactly one
      `##vso[task.logissue type=warning]` line.

Provisioning (app-provisioning.yml and templates/provisioning/, scripts/provisioning/):
  P01 app-provisioning.yml declares exactly four parameters, `environments` (object),
      `hostEnvironment` (string), `scope` (string, values exactly changed and all; ADR-0046) and
      `upgrade` (string, no values list: none, all or slugs, checked by validate-run; ADR-0049),
      none with a default; no root variables, resources, trigger, pr, pool, schedules, jobs, steps,
      extends.
  P02 compile-time guards: empty list, empty name, kind, promote from itself, duplicate names,
      promoteFrom not in the list or not listed earlier, hostEnvironment not in the list.
  P03 service connections: at most one per job; validate and report none; azure_*, azure_post_*
      and registry_* only sc-platform-provisioning-${{ parameters.environment.name }}, entra_plan and
      the job decide of stage plan only sc-platform-provisioning-${{ parameters.hostEnvironment }}
      (ADR-0050), entra only sc-platform-entra, ADO
      stages only sc-platform-ado (formats from naming.bicep provisioningServiceConnection /
      instanceServiceConnection('ado' | 'entra')); SAF_SERVICE_CONNECTION equals the step's
      connection; the sc-platform-entra literal appears in no other template or script (comments
      aside) than templates/provisioning/stages/entra.yml and scripts/provisioning/entra.sh.
  P04 no System.AccessToken in provisioning templates or scripts; the ADO token only from
      prov_ado_token() (az account get-access-token for Azure DevOps, task.setsecret, then
      AZURE_DEVOPS_TOKEN); `get-access-token` only in prov-lib.sh, in prov_ado_token() (exactly
      once), prov_secret_tokens() (P17) and prov_arm_token() (exactly once, P18).
  P05 job variables: saf.coreRef ($[ resources.repositories.core.ref ]) of validate.plan; in every
      other job only saf.result.<artifact> = $[ stageDependencies.<stage>.<job>.result ] (read by the
      conditional downloads of steps/download.yml; which ones exactly: P25), nothing else.
  P06 az deployment only `sub|group validate|create` (plus show, and `operation sub|group list`, which
      read a record's operations; and the one `group delete` of a removed
      custom domain's record fd-{slug}-{env} in azure-post.sh front_door_cleanup(), P20; and the one of the
      Entra record left in rg-{prefix}-entra after a move, in entra.sh retire_instance_record(), ADR-0063),
      only in prov-lib.sh prov_arm(),
      one case arm per action and kind (validate and create for lz, release, frontdoor and
      portal-endpoint, create only for entra): lz at subscription scope with exactly --parameters
      "$prov_lz_param", release, entra, frontdoor and portal-endpoint at resource group scope with
      exactly "$prov_release_param" / "$prov_entra_param" / "$prov_frontdoor_param" /
      "$prov_portal_endpoint_param" (infra/app/provisioning/*.bicepparam,
      infra/entra/provisioning/app-registration.bicepparam), each defined once; no template files,
      extra parameters or what-if; exactly one sub create and four group creates (release, entra,
      frontdoor, portal-endpoint). The Entra plan has no preflight (it calls Microsoft Graph,
      ADR-0033): `az bicep build-params` only in prov_entra_expected(), exactly once, with --file
      "$prov_entra_param", next to exactly one calculateTemplateHash POST.
  P07 every provisioning step sets target commands: restricted and settableVariables: none; only
      the report job's fixed summary upload step runs with commands: any, and only three steps set
      variables: `decide` of entra_plan.plan and `entraDecide` of plan.decide exactly [entraNeeded],
      and `decide` of plan.decide exactly [ado, entraPlan, and lz_, post_, record_ of each
      environment, registry_ of each build environment] (ADR-0048, ADR-0050, ADR-0059).
  P08 provisioning jobs are normal jobs without an ADO environment.
  P09 provisioning checks out only core and self.
  P10 lockBehavior runLatest exactly on the stages that use a service connection (entra_plan and
      entra included).
  P11 tools only through steps/setup.yml, at most node and bicep; bicep in every job that runs a
      script using Bicep (prov_names, prov_arm, az deployment: azure.sh, azure-post.sh, entra-plan.sh,
      entra.sh; plan.sh names apps through `platform provisioning plan-names`/plan-facts, ADR-0050),
      and these scripts run saf_bicep_pin_check before the app loop.
  P12 per-app isolation: prov_unit() (run by prov_run_app()) runs each unit in a subshell with
      errexit on; azure.sh, azure-post.sh, ado.sh, record.sh and registry.sh (for slug in PROV_APPS), entra-plan.sh
      (for slug in PROV_APPS, per environment) and entra.sh (for t in targets, after the loop that
      builds the targets) call it only inside their app loop; no loop that calls it contains
      exit/saf_die/return; the scripts end with prov_finish.
  P13 (tests/scenarios/provisioning/*.json, expanded) stage list, dependsOn (validate; plan after
      validate; every later stage after validate and plan (ADR-0048), entra after validate, plan and
      entra_plan; azure_<E> after azure_<S>; ado_resources and entra_plan after all azure_*;
      azure_post_<E> after azure_<E>, ado_resources, entra_plan, entra and azure_post_<S>, the portal
      host's also after every azure_<E> (it reads them all, P21); ado_pipelines after ado_resources
      and all azure_post_*; registry_<B> of each build environment B (no promoteFrom, ADR-0059) after
      azure_post_<B>; report after all but record_*; record_<E> after what report depends on,
      beside report, ADR-0046), the condition and(not(canceled()), eq(dependencies.validate.result,
      'Succeeded')) on plan and report, and that plus eq(dependencies.plan.outputs
      ['decide.decide.<output>'], 'true') on azure_<E> (lz_<E>), ado_resources and ado_pipelines
      (ado), entra_plan (entraPlan), azure_post_<E> (post_<E>), record_<E> (record_<E>) and
      registry_<B> (registry_<B>); entra
      needs plan's output decide.entraDecide.entraNeeded or entra_plan's plan.decide.entraNeeded =
      'true' instead (ADR-0050); list order; invalid parameters fail with the expected guard.
  P14 (expanded) one normal job per stage after plan running its script once (AzureCLI@2 with the
      expected connection and scriptPath exactly $(Pipeline.Workspace)/s/core/pipelines/azure-devops/
      scripts/provisioning/<script>, SAF_ENV_NAME / SAF_PROMOTE_FROM / SAF_ADO_PHASE), exactly the
      expected artifact downloads (`plan` of every job but validate's, through steps/setup.yml, with
      the platform CLI; `units`; plan_<E> where the entries of E are read; the portal host's
      azure_post_<host> also plan_<E> and azure_<E> of every environment, P21; this run only) of which
      exactly the artifacts of stages that may be skipped are conditional (P25), and publish (from
      $(Pipeline.Workspace)/saf-out/<artifact>): validate with succeeded(); every job whose artifact
      a later job reads when it may have failed (plan_<E>, decide (units and plan_<host>), azure_<E>,
      ado_resources, entra_plan, entra, azure_post_<E>, ado_pipelines, registry_<B>) with always(), and
      report's `report` (summary.md and failures.json, read by the portal, ADR-0064) with always(); all
      these start
      with the fixed step of steps/setup.yml that creates their artifact folders with the marker
      stage.json (SAF_ARTIFACT = the artifact, SAF_ALSO_ARTIFACT = the job decide's second one or
      empty, no condition), so their artifacts exist even when the job fails
      before its script; no other job has it. Validate builds the platform CLI (steps/platform-cli.yml,
      cli: build); every other job installs it from this run's artifact `plan` (ADR-0048 section 6).
  P15 provisioning scripts print .err/.log output and app.yaml problems only through
      saf_neutralise and never `cat` a file to the log.
  P16 Entra isolation (expanded): stage entra has one normal job `registrations` without an
      environment whose only service connection step is AzureCLI@2 with sc-platform-entra running
      scripts/provisioning/entra.sh from the core checkout (no other provisioning script, no ADO or System.AccessToken in
      any env); entra_plan.plan's step `decide` and plan.decide's step `entraDecide` run
      scripts/provisioning/entra-decide.sh after the AzureCLI step of entra-plan.sh (SAF_ENTRA_PHASE
      landing, plan) with condition always() and SAF_ENTRA_PHASE the same; entra-decide.sh sets only
      entraNeeded=true|false; entra-plan.sh, entra.sh and entra-decide.sh never call (directly or
      through prov-lib.sh) prov_ado_token.
  P17 Easy Auth secret hand-off (ADR-0035, ADR-0041): `easyauth-secret` appears in no template and
      no script but scripts/provisioning/entra.sh, which calls `saf_cli provisioning easyauth-secret`
      exactly once, inside a function (so per app, in prov_run_app), with exactly the options --mode,
      --client-id, --job, --secret-name, --vault, --display-name, --current-created,
      --current-expires, --loaded-created and --output, right after prov_secret_tokens
      and right before `unset SAF_GRAPH_TOKEN SAF_ARM_TOKEN`; prov_secret_tokens is called nowhere
      else. prov_secret_tokens() (prov-lib.sh) takes the resources from `az cloud show` and, for
      Graph ("$graph") and ARM ("$arm") in turn, runs az account get-access-token, masks the token
      with task.setsecret, then stores it in SAF_GRAPH_TOKEN / SAF_ARM_TOKEN; $token is used in no
      other line (no file, no argument). SAF_GRAPH_TOKEN and SAF_ARM_TOKEN are assigned only there,
      never expanded by a script and never named by a template. No xtrace (set -x, set -o xtrace,
      bash -x, BASH_XTRACEFD) in scripts/lib.sh or any provisioning script; no provisioning step
      sets SHELLOPTS, BASHOPTS, BASH_ENV, ENV, PS4 or BASH_XTRACEFD, and the AzureCLI@2 step of
      stage entra passes exactly SAF_ENV_NAME and SAF_SERVICE_CONNECTION. Pipeline variables reach
      every step's environment too, so prov-lib.sh runs `set +x` and then prov_env_guard (exit 1 when
      any of those or NODE_OPTIONS is exported) before it sources lib.sh. SAF_ARM_TOKEN may also be
      assigned in prov_arm_token() (P18).
  P18 platform job hand-offs with the ARM token (ADR-0028, ADR-0061): `provisioning dbinit` appears in
      no template and no script but scripts/provisioning/azure-post.sh, which calls `saf_cli
      provisioning dbinit` exactly once, inside database_entry(), with exactly the options --job,
      --engine, --host, --database, --principal-name, --principal-id, --principal-client-id and
      --output and no token, right after prov_arm_token and right before `unset SAF_ARM_TOKEN`;
      likewise `provisioning easyauth-delete` (the Easy Auth secret's delete with the landing zone's,
      ADR-0061) only in scripts/provisioning/azure.sh, exactly once, inside lz_secret_delete(), with
      exactly --job, --vault, --secret-name and --output; prov_arm_token is called exactly once in
      each of the two scripts, right before its call, and nowhere else. prov_arm_token() (prov-lib.sh)
      takes the resource from `az cloud show`, runs az account get-access-token --resource "$arm"
      once, masks the token with task.setsecret, then stores it in SAF_ARM_TOKEN; $token is used in
      no other line.
  P19 Easy Auth secret rotation (ADR-0041): no script (delivery or provisioning) changes app
      registration credentials itself (az ad app|sp credential, addPassword, removePassword, a
      Microsoft Graph URL, /v1.0/ or /beta/applications) or reads what started the run
      (BUILD_REASON, BUILD_CRONSCHEDULE_*, BUILD_REQUESTEDFOR*), and no delivery or provisioning
      template names Build.Reason, Build.CronSchedule.* or Build.RequestedFor*, so a scheduled,
      manual or merge run decides the same way; `rotation-due` runs only in
      scripts/provisioning/entra-plan.sh, exactly once, inside plan_secret(), as `saf_cli
      provisioning rotation-due --expires "$secret_expires" --created "$secret_created" --now
      "$(date -u +%s)"`; a revision restart (a /restart URL segment, az containerapp revision
      restart, invoke-action restart) appears only in scripts/provisioning/azure-post.sh, exactly
      once (az rest --method post --url "$app_id/revisions/$rev/restart?api-version=…"), inside
      restart_stale(), after `if [ "$tag" = "$created" ]; then … return 0 … fi` (the marker
      comparison), and the last `az tag update … saf-easyauth=$created` there follows the
      restart and the sign-in probe (smoke.sh with "$client"), with no tag write in between, and
      is the first line of `if [ "$(date -u +%s)" -ge $((created + PROV_EASYAUTH_SETTLE_S)) ];
      then`; prov-lib.sh defines PROV_EASYAUTH_SETTLE_S=1800 once (no script sets it), and
      prov_easyauth_app counts a revision as started with a version only when created at least
      that long after it; az rest calls without a literal GET method (--method get, --method=get,
      quoted or not) count as writes and appear only for calculateTemplateHash (P06) and that
      restart.
  P20 custom domain through Front Door (ADR-0010, amended 2026-11-01 and 2026-11-02): `inputs
      --step frontdoor` and `prov_arm validate|create frontdoor` appear in no template and no script
      but scripts/provisioning/azure-post.sh, each exactly once, inside front_door_step(), with the
      validate before `prov_compare frontdoor` and the create after it, only when the verdict is not
      up-to-date; release_app() calls front_door_step exactly once, after database_entry and right
      before release_step (the release reads the deployment, then restart_stale). Removal and the
      previous host of a change (ADR-0010, amended 2026-11-11): Front Door objects and DNS records are
      deleted only by fd_delete() in azure-post.sh (exactly one az rest DELETE there, after checking
      the ID is a route, custom domain, origin group or CNAME/TXT record set in this environment's
      subscription; no az afd|cdn|network dns|network front-door … delete, az resource delete or other
      az rest DELETE anywhere), and fd_delete is called only by front_door_cleanup() and
      fd_dns_cleanup(); release_app() calls `front_door_cleanup removal` last (after release_step), and
      front_door_step() ends with `front_door_cleanup change` (after the deployment that took a host
      change's previous host off the route); front_door_cleanup() returns for a removal unless the
      domain is no longer requested (fd_removing) and checks that the release's frontDoor.mode is none before the
      Front Door lock, then deletes the route, each custom domain no route links (fd_domain_linked),
      the origin group and last the record fd-{slug}-{env} (the only `az deployment group delete`,
      P06).
  P21 portal-side private endpoints of app vaults (ADR-0025): `provisioning inputs --step
      portal-endpoint` and `prov_arm validate|create portal-endpoint` appear in no template and no
      script but scripts/provisioning/azure-post.sh, each exactly once and inside portal_endpoint()
      (a per-app unit, prov_run_app); portal_endpoints() returns to the approvals before its first
      prov_run_app unless the stage is the portal host's (`if [ "$env_name" != "$host" ]; then`),
      and azure-post.sh calls it exactly once, at the top level after the release loop and before
      its final prov_finish; approving a private endpoint connection (`private-endpoint-connection
      approve`) appears only in azure-post.sh, exactly once, inside portal_endpoint_approve(); no
      provisioning script deletes or rejects a private endpoint or a connection (`private-endpoint
      delete`, `private-endpoint-connection delete|reject`, `az resource delete`, `az group delete`)
      outside DECOMMISSION_EXCEPTIONS and PORTAL_ENDPOINT_REMOVALS (ADR-0025 amendment 2026-11-14): a
      portal-side endpoint is deleted only in portal_endpoint_remove() and its record only in
      portal_endpoint_forget(), each called only from portal_endpoint_delete() (decommissioning),
      portal_endpoint() (a previous vault generation) and portal_endpoint_left() (a vault no longer
      VNet-based), which portal_endpoint() calls only after its vnetBased check and which removes only
      in the `free)` arm of portal_vault_state (the vault has no other connection). The azure_post_*
      template takes `environments` and `hostEnvironment` (P14 checks the host's extra downloads).
  P22 parallel units and targeted runs (ADR-0046): prov-lib.sh assigns PROV_PARALLEL_MAX once, to a
      literal from 2 to 8, and PROV_PARALLEL only to 1 and, inside prov_parallel(), to
      $PROV_PARALLEL_MAX; no other script or template names either. prov_parallel is called by exactly
      azure.sh, azure-post.sh, entra-plan.sh and record.sh (top level, before the app loop; plan.sh
      reads lists, ADR-0050, and has no app loop), never by
      ado.sh or entra.sh. A background job (`&` ending a command) and `wait` appear only in prov-lib.sh:
      exactly one `) &`, inside prov_run_app(), and `wait -n -p pid` only in prov_reap(); prov_finish()
      starts with prov_join; azure-post.sh calls prov_join between its release loop and
      portal_endpoints, portal_endpoints() calls it before portal_endpoints_left, entra-plan.sh before
      it writes entra-needed.txt. The deployments into shared resources hold a stage-wide lock:
      `prov_arm create frontdoor` and `prov_arm create portal-endpoint` directly between `prov_lock
      frontdoor|portal-endpoint` and `prov_unlock`, the dbinit hand-off (P18) directly between
      `prov_lock "dbinit-$job"` and `prov_unlock`, and azure.sh's Easy Auth secret delete hand-off
      (P18, ADR-0061) directly between `prov_lock "kvset-$job"` and `prov_unlock`. prov_names() snapshots its own mktemp copy of
      names.bicepparam (never "$prov_names_param" itself). The scope: `parameters.scope` is used only
      to pass it from app-provisioning.yml to validate.yml and there only as SAF_SCOPE of the validate
      step, which also maps SAF_SOURCE_BRANCH: $(Build.SourceBranch); validate.sh passes
      `--source-branch "$SAF_SOURCE_BRANCH"` to validate-run and `--scope "$SAF_SCOPE"` to apps;
      no provisioning script reads `checkAllApps` (the CLI's plan-units does: it only widens the run).
      The upgrade (ADR-0049) likewise: `parameters.upgrade` is used only to pass it from
      app-provisioning.yml to validate.yml and there only as SAF_UPGRADE of the validate step;
      SAF_UPGRADE is named by no script but validate.sh, which passes `--upgrade "$SAF_UPGRADE"` to
      validate-run (with --upgrades "$SAF_CORE/infra/app/upgrades.yaml" and --apps-dir) and to apps;
      decide.sh passes --upgrades "$SAF_CORE/infra/app/upgrades.yaml" to plan-units; `.upgrade` (the
      parsed parameter) is read by no script but report.sh, which only shows it, from the plan.
      Provisioning by unit (ADR-0048): the plan (SAF_UNITS_JSON) is read only in prov-lib.sh (the
      helpers prov_units_check, prov_unit_runs, prov_planned, prov_entry_dir, prov_entra_dir,
      prov_entra_work, prov_lz_ok, prov_post_ok, prov_unit_tag, prov_unit_finished), record.sh and
      report.sh; every stage script after plan
      runs prov_units_check before its app loop and filters its apps with prov_unit_runs; the unit
      tags saf-u-<unit> and saf-u-files are written only by prov-lib.sh prov_tags_restore() (after a
      landing-zone deployment, the values the plan read) and record.sh record_tags() (the plan's
      record value of a finished unit, its rebase value of a held one, and saf-u-files with them,
      ADR-0049), and the retired tag saf-provisioned is named only by record.sh, which deletes it.
  P23 platform jobs on this core's image (ADR-0043): prov-lib.sh prov_job_state() answers missing |
      outdated | current against the saf-jobs digest of "$SAF_IMAGES_JSON"; no script checks a job
      by existence alone (prov_job_exists), and no script reads prov_job_state inside a test
      (errexit doesn't apply there); prov-lib.sh prov_write_secret_entry() sets jobReady only for
      a current kvset job;
      entra.sh write_secret assigns prov_job_state of the kvset job and waits (prov_wait) unless
      it is current, before prov_secret_tokens, but fails (saf_die) a rotation with at most 14
      days left (prov-lib.sh prov_secret_urgent); entra-plan.sh plan_secret fails such a rotation
      too while the kvset job isn't ready; azure-post.sh database_entry checks the dbinit job, and
      azure.sh lz_secret_delete the kvset job (ADR-0061), with `case "$job_state" in current) ;;` and
      waits for missing and any other state, before prov_arm_token.
  P24 removal of what Graph Bicep doesn't delete (ADR-0033, amended 2026-11-11): `entra-reconcile`
      appears in no template and no script but scripts/provisioning/entra.sh, which calls `saf_cli
      provisioning entra-reconcile` exactly once, inside remove_assignments(), with exactly the
      options --removals, --inputs, --unique-name and --output and no token, right after
      prov_graph_token and right before `unset SAF_GRAPH_TOKEN`; prov_graph_token is called nowhere
      else. prov_graph_token() (prov-lib.sh) takes the resource from `az cloud show`, runs az account
      get-access-token --resource "$graph" once, masks the token with task.setsecret, then stores it
      in SAF_GRAPH_TOKEN; $token is used in no other line. provision() calls remove_assignments
      before register (a failed removal keeps the record, so the next run plans it again).
      `entra-removals` appears only in scripts/provisioning/entra-plan.sh, exactly once, inside
      plan_removals(), with --record "$PROV_DIR/entra-record.json" (removals come only from the
      record of the platform's own deployment); plan_registration() calls plan_removals only in the
      branch after `prov_detail entra deploy`.
  P25 stage plan and the conditions of the stages after it (ADR-0048, ADR-0050), expanded: stage plan
      has one normal job plan_<E> per environment except hostEnvironment (only
      sc-platform-provisioning-<E>, tools node only, AzureCLI@2 running scripts/provisioning/plan.sh
      from the core checkout with SAF_ENV_NAME, SAF_PROMOTE_FROM and SAF_SERVICE_CONNECTION,
      downloading only `plan`, its artifact folder created first and published with always()) and,
      last, one job `decide` with only sc-platform-provisioning-<host>, after every plan_<E> with
      condition not(canceled()), downloading `plan` and every other plan_<E> unconditionally, whose
      steps are in this order: AzureCLI@2 running plan.sh for the host (SAF_ENV_NAME host, its
      SAF_PROMOTE_FROM, SAF_SERVICE_CONNECTION); `decide` (bash, scripts/provisioning/decide.sh,
      condition succeededOrFailed(), env SAF_ENVIRONMENTS_JSON and SAF_HOST_ENVIRONMENT) setting exactly
      ado, entraPlan, lz_<E>, post_<E> and record_<E> of each environment and registry_<B> of each build
      environment (ADR-0059); AzureCLI@2 running
      entra-plan.sh with SAF_ENTRA_PHASE plan (condition succeededOrFailed()); `entraDecide` (P16);
      publishing plan_<host> and `units` with always(); decide.sh sets
      them with one setvariable line, names checked against ^(ado|entraPlan|(lz|post|record|registry)_<env>)$
      and values true|false, all of them only after every value is known. Every conditional download
      (steps/download.yml optional) is exactly and(succeeded(), in(variables['saf.result.<artifact>'],
      'Succeeded', 'SucceededWithIssues', 'Failed')), its job maps exactly saf.result.<artifact> =
      $[ stageDependencies.<stage>.<job>.result ] for each such artifact and nothing else, and the
      stage depends directly on <stage>; a stage that may be skipped (azure_<E>, ado_resources,
      entra_plan, entra, azure_post_<E>, ado_pipelines, registry_<B>) is never downloaded unconditionally by a
      stage that may run without it.
  P27 decommissioning (ADR-0056): the deletes of the delete phase run only in their functions, only for
      a unit whose plan action is delete (prov_unit_action), and the stop and start of a decommissioned
      app only for release's retire and the plan's Cancel (retired.remove); the exceptions P06, P19,
      P20, P21, P22 and P24 make for them are listed in DECOMMISSION_EXCEPTIONS; the steps of the
      landing zone's delete (lz_outside_assignments, lz_secret_delete of ADR-0061, lz_nested_cleanup)
      are defined in azure.sh and called only from lz_delete()
  P26 script mutations (ADR-0052): every mutating call in scripts/**/*.sh (az … create|update|delete|
      import|restart|start|stop|approve|reject|purge|set|add|remove, az tag update, az rest without a
      literal GET method, and the platform subcommands that write: provisioning easyauth-secret|
      easyauth-delete|entra-reconcile|entra-delete|dbinit, ado apply|bootstrap|remove, pipeline
      retention-lease), keyed by file, enclosing
      function (with the case arm of a dispatcher such as prov_arm `create/frontdoor`) and the
      normalised command, has an entry in SCRIPT_MUTATIONS with its target pattern, scope (app,
      shared, platform, agent, read) and reason; an entry no call matches fails; an entry in a shared
      scope needs guards, each a predicate that must precede every guarded call in the named function
      (or be present there): the DNS guard before the custom domain's deployment, the custom domain's
      host and the DNS records' mark before their delete, the nested records' IDs, the kvset job by
      naming, the dbinit job by naming and its lock, the Entra inputs naming the app and its record's
      group by names.bicep (ADR-0063: the environment's records group or rg-{prefix}-entra), the old
      Entra record's delete only after the deployment into the environment's group, the portal
      endpoint lock; tag writes on resource groups by naming. The registry purge (registry.sh, ADR-0059)
      deletes manifests of the app's own repository only in a registry it found in the app's resource
      group by naming, and writes its tag on that group. The move of a network mode change (ADR-0060)
      deletes the delivery identity's role only at the source CAE (the identity by naming in the app's
      group, the scope exact), the app's own Container App by naming, the app's own private endpoints
      (in its group, every target in its group), the app's identities' role only at its Easy Auth secret
      in the old vault; the follow-up's remove-old starts only the previous variant's kvset job by naming.
      The delete phase frees the slug's names (ADR-0061): entra-delete gets the current app's own
      uniqueName ({prefix}-{slug}-{env}, with --i{incarnation} above incarnation 0) and the recycle bin
      is never purged (a later app with the slug has its own uniqueName); the landing zone's delete
      starts only the kvset job of the app's mode by naming, for exactly easyauth-{slug} in that mode's
      environment vault by naming, under its lock.
  P28 network mode change (ADR-0060): the move step runs only for a release whose plan action is move
      (release_app), waits first when the plan says the move waits for the maintenance window (kind
      prod outside it, product owner 2026-11-14), its destructive helpers only from move_step and only after every precondition
      (prov_wait) and, for the Joiner and the app's delete, only in the full phase (the app in its source
      CAE), the app's delete after the Joiner's; the follow-up's remove-old runs only for the plan's
      followUp (prov_follow_up) in entra.sh, and entra-plan.sh plans it only there too; the exceptions
      P21 makes for the move's deletes are listed in MOVE_EXCEPTIONS.

Platform pipeline (platform-environment.yml and templates/platform/, scripts/platform/, ADR-0043);
the generic rules T03, T04, T08-T11, T13, T16-T18 and T22 apply too:
  E01 platform-environment.yml declares exactly two parameters, `environment` and `hostEnvironment`
      (strings, no defaults); no root variables, resources, trigger, pr, pool, schedules, jobs,
      steps, extends or lockBehavior.
  E02 compile-time guards: an empty environment, an empty hostEnvironment.
  E03 service connections: validate none, plan and deploy exactly
      sc-platform-provisioning-${{ parameters.environment }}; SAF_SERVICE_CONNECTION equals the
      step's connection; no other stage; sc-platform-ado and sc-platform-entra are named nowhere.
  E04 no System.AccessToken, AZURE_DEVOPS_TOKEN or get-access-token in the templates or scripts.
  E05 az deployment only in plat-lib.sh plat_arm(), with exactly the case arms validate, what-if and
      create, each one `az deployment sub <action>` with exactly --parameters "$param", which
      plat_arm sets only in its part arms `environment)` = "$plat_env_param"
      (infra/platform/pipeline/environment.bicepparam) and `portal)` = "$plat_portal_param"
      (infra/platform/pipeline/portal.bicepparam), each assigned once in plat-lib.sh; outside it only
      the record read (az deployment sub show) in plat-lib.sh; no template files or extra
      parameters; plat_arm validate and what-if only in plan.sh, create only in deploy.sh, each with
      the part environment or portal; every plat_name output exists in
      infra/platform/pipeline/platform-names.bicep.
  E06 exactly one deployment job: `deploy` of stage deploy, on the environment
      platform-${{ parameters.environment }} (its Approval), first step `download: none`; no
      other job names an environment; stage deploy runs only when plan.decide.changed is 'true'
      (and validate and plan succeeded); stage plan only after validate succeeded.
  E07 every step sets target.commands: restricted; normal job steps settableVariables: none, except
      the one step `decide` of plan.plan with [changed]; deployment job steps no settableVariables (T22).
  E08 az acr import exactly twice, both in deploy.sh with --force: saf-jobs from
      "$source_registry/$repo@$digest", the digest from plat_jobs_digest() (images.json
      saf-jobs.digest), and saf-portal from "$source_registry/$portal_repo@$portal_digest" in
      deploy_portal(), the digest from plat_portal_digest() (images.json saf-portal.digest); no push,
      build or registry login.
  E09 checkouts only core and self.
  E10 tools only through provisioning/steps/setup.yml or steps/deployment-setup.yml, at most node
      and bicep.
  E11 never names bootstrap.bicep, entra-permissions.bicep or portal-registration.bicep; no role
      definition or assignment writes, locks, az ad, az rest, federated credentials, Key Vault or
      tags; roles.bicep only as plat_roles_template, built (`bicep build ... --stdout`) in plan.sh.
  E12 (tests/scenarios/platform/*.json, expanded) stages validate -> plan -> deploy with exactly
      those dependsOn and locks on plan and deploy; validate runs validate.sh without a connection;
      plan one normal job, AzureCLI@2 with sc-platform-provisioning-<env> running
      scripts/platform/plan.sh from the core checkout with exactly SAF_ENV_NAME,
      SAF_HOST_ENVIRONMENT and SAF_SERVICE_CONNECTION, publishing platform_plan; deploy one
      deployment job on platform-<env> running scripts/platform/deploy.sh with the same three env
      vars, downloading exactly platform_plan from this run; invalid parameters fail with the
      expected guard.
  E13 nothing reads what started the run (Build.Reason, Build.CronSchedule, Build.RequestedFor).
  E14 no deploy events (report.sh, deployment-finish.yml) or summary uploads; only decide.sh sets a
      variable, exactly `changed`.
  E15 the jobs, not only the record: plat-lib.sh plat_job_state() answers missing | outdated |
      current against "/$repo@$digest"; plan.sh, with a record, assigns it for every job of
      platform-names.bicep's output jobs and turns an up-to-date result with a job that isn't
      current into `changed: ...`; deploy.sh fails unless every job is current after pass 2; no
      script reads plat_job_state inside a test.
  E16 the portal only in its host (ADR-0043 decision 10): every plat_arm call with the part portal,
      every plat_portal_inputs and the saf-portal import are in plan.sh plan_portal() or deploy.sh
      deploy_portal(), each called exactly once, at the top level, right after the guard
      `if [ "$env_name" = "$SAF_HOST_ENVIRONMENT" ]` (deploy.sh: inside `if [ "$portal_changed" =
      true ]`); validate.sh runs `portal-inputs --pass auto` only under the same host guard; the
      Container App, not only the record: plat-lib.sh plat_app_state() answers missing | outdated |
      current against "/$repo@$digest"; plan_portal() assigns it, turns an up-to-date result of pass
      2 with an app that isn't current into `changed: ...` and stops when the app exists without
      portal.clientId; deploy_portal() checks the approved portal inputs first and fails unless the
      app is current after pass 2 and plat_app_ready answers.
  E17 a CAE's network is fixed once it exists (ADR-0043 amendment 2026-11-15, US03.03): plat-lib.sh
      plat_cae_read() reads a CAE with `az resource show --resource-type
      Microsoft.App/managedEnvironments`, answers null only on ResourceNotFound and fails on any other
      error; plat_env_snapshot() runs `bicep snapshot "$plat_env_param"` with the run's inputs; plan.sh,
      at the top level, assigns plat_cae_read for every CAE of platform-names.bicep's output
      managedEnvironments (never inside a test), snapshots the inputs and runs `if ! saf_cli
      environment cae-network` on both, with a saf_die in its body, before its first `plat_arm validate
      environment`, `plat_arm what-if environment` and plan_portal.

Pull request validation of platform-config (platform-validation.yml, ADR-0040); the generic rules
T03, T04, T08-T10, T13, T16 and T17 apply too:
  V01 platform-validation.yml declares no parameters and no root variables, resources, trigger,
      pr, pool, schedules, jobs, steps, extends or lockBehavior; exactly one stage `validate` with
      one normal job `validate`.
  V02 no credentials: no task at all (so no AzureCLI or other service connection task), no service
      connection input or key anywhere, no environment or deployment job, no System.AccessToken in
      the templates or scripts/platform-validation.sh, and the script makes no Azure (`az`) call,
      gets no token and names no AZURE_DEVOPS_TOKEN.
  V03 every step sets `target: { commands: restricted, settableVariables: none }`; no `condition`
      on the stage, job or any step; no job variables.
  V04 checkouts: exactly core (path s/core, fetchDepth 1) then self (path s/config, fetchDepth 2:
      the merge commit and its parents, for `--base HEAD^1`), both fetchTags, submodules, lfs and
      persistCredentials false.
  V05 the job's steps are exactly: the two checkouts, steps/install-tools.yml with tools [node],
      steps/platform-cli.yml, and one bash step running scripts/platform-validation.sh from the core
      checkout. The script runs `validate instance`, `validate app ... --instance` in a loop over
      apps/*/ that never stops early (exit, saf_die, return), `validate archive "$SAF_CONFIG"` with
      the same base (the archive of deleted apps, ADR-0061), `generate --config-dir "$SAF_CONFIG"
      --check`, prints folder names only through saf_neutralise and fails at the end on any problem.
  V06 the Entra effect (ADR-0051 section 5): for every apps/*/app.yaml the pull request changes (`git
      diff --name-only -z HEAD^1 HEAD`), one `saf_cli provisioning entra-effect --base "$base_file"
      --head "$head_file" --instance "$instance" | saf_neutralise`, the base the target branch's file
      (`git show "HEAD^1:$path"`) or none; nothing in that loop stops the run; paths printed only
      through saf_neutralise; no git fetch, pull or remote (no credentials; V04's depth 2 holds
      HEAD^1); a log section of its own.

Usage: python3 pipelines/azure-devops/tests/check-templates.py            exit 0 = all checks passed
       python3 pipelines/azure-devops/tests/check-templates.py --expand <scenario.json | params.json>
           prints the expanded `stages:` of app-delivery.yml for those parameters (e.g. to send to
           the Azure DevOps Preview API as yamlOverride with the pipeline's own resources); of
           app-provisioning.yml when the file names it as "entry" or has no `app` parameter
           (tests/scenarios/provisioning/*.json); of platform-environment.yml when the file names it
           or has an `environment` parameter (tests/scenarios/platform/*.json).
"""

from __future__ import annotations

import copy
import functools
import json
import re
import sys
from pathlib import Path
from typing import NamedTuple

try:
    import yaml
except ImportError:  # pragma: no cover
    sys.exit("check-templates: PyYAML is required (apt-get install python3-yaml)")

HERE = Path(__file__).resolve().parent
DELIVERY = HERE.parent                      # pipelines/azure-devops
REPO = DELIVERY.parents[1]
ENTRY = "app-delivery.yml"
NAMING = REPO / "infra" / "modules" / "naming" / "naming.bicep"
NAMES = REPO / "infra" / "app" / "delivery" / "names.bicep"

VM_IMAGE = "ubuntu-24.04"
# The hosted pool by name: a pipeline created through the REST API by an identity that can't see the
# project's agent queues has no default queue, and vmImage alone then fails ("No pool was specified").
POOL_NAME = "Azure Pipelines"
ALLOWED_TASKS = {"AzureCLI@2", "DownloadPipelineArtifact@2", "PublishPipelineArtifact@1", "Cache@2"}
ALLOWED_STEP_KINDS = {"checkout", "download", "bash", "task", "template"}
FORBIDDEN_PARAM_TYPES = {"boolean", "step", "steplist", "job", "joblist", "deployment",
                         "deploymentlist", "stage", "stagelist"}
REQUIRED_TOOLS = {"node", "bicep", "trivy", "cosign", "oras", "buildx"}
CHECKOUT_PATHS = {"core": "s/core", "self": "s/config", "app": "s/app"}
FORBIDDEN_MACROS = re.compile(
    r"\$\((?:Build\.Source[A-Za-z.]*|Build\.RequestedFor[A-Za-z.]*|System\.PullRequest[A-Za-z.]*"
    r"|resources\.[^)]*)\)|\$\{\{\s*parameters", re.IGNORECASE)
DEPLOY_CONDITION = ("and(succeeded(), eq(dependencies.verify.outputs"
                    "['scan.decide.deployBuildEnvironments'], 'true'))")
PROMOTE_CONDITION = ("and(succeeded(), eq(dependencies.verify.outputs"
                     "['scan.decide.promote'], 'true'))")
REDEPLOY_CONDITION = "succeeded()"
TOKEN_SCRIPTS = {"scripts/source-run.sh", "scripts/retain.sh"}
# AzureCLI@2 steps run scripts from the core checkout at the pinned tag, never from platform-config
# (s/config) or anywhere else: scriptPath must be exactly this prefix + scripts/<name>.
CORE_SCRIPTS = "$(Pipeline.Workspace)/s/core/pipelines/azure-devops/"
# Deploy events for the portal (ADR-0037, T30).
REPORT_SCRIPT = "scripts/report.sh"
REPORT_TEMPLATE = "templates/steps/deployment-finish.yml"
REPORT_ENV = {"SAF_SLUG", "SAF_ENV_NAME", "SAF_SERVICE_CONNECTION", "SAF_JOB_STATUS"}
REPORT_CONDITION = "succeededOrFailed()"
REPORT_URL = 'url="$base_url/api/pipeline/apps/$SAF_SLUG/environments/$SAF_ENV_NAME/deploy-events"'
REPORT_BODY = "'{runId: $runId, attempt: $attempt, result: $result}'"
# The only lines of report.sh that may expand $token (in this order: check, mask, header file).
REPORT_TOKEN_LINES = [
    '[ -n "$token" ] || skip "az returned an empty token for api://$client_id"',
    "printf '##vso[task.setsecret]%s\\n' \"$token\"",
    "(umask 077 && printf 'Authorization: Bearer %s\\n' \"$token\" > \"$hdr\")",
]
ENTRY_PARAMS = {
    "app": {"type": "object"},
    "environments": {"type": "object"},
    "action": {"type": "string", "default": "deliver", "values": ["deliver", "redeploy"]},
    "targetEnvironment": {"type": "string", "default": "none"},
    "sourceRunId": {"type": "number", "default": "0"},
}
GUARDS = [
    "parameters.app.slug is empty",
    "parameters.app.defaultBranch must start with refs/heads/",
    "an environment kind is not prod or nonprod",
    "a prod environment must set promoteFrom",
    "an environment cannot promote from itself",
    "promoteFrom must name an environment of the list",
    "action deliver takes targetEnvironment none and sourceRunId 0",
    "action redeploy needs targetEnvironment to name an environment of the list",
    "action redeploy needs sourceRunId > 0",
]
ALL_RULES = ({f"T{n:02d}" for n in range(1, 32)} | {f"P{n:02d}" for n in range(1, 29)} | {f"V{n:02d}" for n in range(1, 7)}
             | {f"E{n:02d}" for n in range(1, 18)})

# Platform pipeline (platform-environment.yml, ADR-0043).
PLAT_ENTRY = "platform-environment.yml"
PLAT_SCRIPTS = "scripts/platform/"
PLAT_NAMES = REPO / "infra" / "platform" / "pipeline" / "platform-names.bicep"
PLAT_ENTRY_PARAMS = [{"name": "environment", "type": "string"}, {"name": "hostEnvironment", "type": "string"}]
PLAT_GUARDS = ["parameters.environment is empty", "parameters.hostEnvironment is empty"]
PLAT_CONNECTION = "sc-platform-provisioning-${{ parameters.environment }}"
PLAT_PLAN_CONDITION = "and(not(canceled()), eq(dependencies.validate.result, 'Succeeded'))"
PLAT_DEPLOY_CONDITION = ("and(not(canceled()), eq(dependencies.validate.result, 'Succeeded'), eq(dependencies.plan.result, 'Succeeded'), "
                         "eq(dependencies.plan.outputs['plan.decide.changed'], 'true'))")
PLAT_ENV_PARAM_DEF = 'plat_env_param="$SAF_CORE/infra/platform/pipeline/environment.bicepparam"'
PLAT_PORTAL_PARAM_DEF = 'plat_portal_param="$SAF_CORE/infra/platform/pipeline/portal.bicepparam"'
# plat_arm's part arms: the only assignments of the parameter file it deploys with (E05).
PLAT_ARM_PARTS = {
    "environment": 'environment) param="$plat_env_param"; env_json="$(cat "$inputs")" ;;',
    "portal": 'portal) param="$plat_portal_param"; portal_json="$(cat "$inputs")" ;;',
}
# The portal's guard (E16): only the host environment's pipeline plans and deploys the portal.
PLAT_HOST_GUARD = 'if [ "$env_name" = "$SAF_HOST_ENVIRONMENT" ]; then'
PLAT_ROLES_DEF = 'plat_roles_template="$SAF_CORE/infra/platform/roles.bicep"'
PLAT_TOOLS = {"node", "bicep"}
# Human-only templates (bootstrap: platform identities, entra-permissions: Graph, portal-registration:
# consent) and writes a platform pipeline never makes (role definitions and assignments, locks, Entra,
# federated credentials, vault secrets).
PLAT_HUMAN_TEMPLATES = re.compile(r"bootstrap(-identities|-entra)?\.bicep|entra-permissions\.bicep|portal-registration\.bicep|bootstrap\.sh")
PLAT_FORBIDDEN_AZ = re.compile(r"\baz\s+(role\s+(definition|assignment)\s+(create|update|delete)\b|lock\b|ad\b|rest\b|"
                               r"identity\s+federated-credential\b|keyvault\b|tag\b)")

# Pull request validation of platform-config (platform-validation.yml, ADR-0040).
VAL_ENTRY = "platform-validation.yml"
VAL_SCRIPT = "scripts/platform-validation.sh"
VAL_RUN = 'bash "$PIPELINE_WORKSPACE/s/core/pipelines/azure-devops/scripts/platform-validation.sh"'
VAL_CHECKOUTS = [
    {"checkout": "core", "path": "s/core", "fetchDepth": "1"},
    {"checkout": "self", "path": "s/config", "fetchDepth": "2"},
]
VAL_SCRIPT_CALLS = [
    'saf_cli validate instance "$instance" "${base[@]}"',
    'saf_cli validate app "$file" --instance "$instance" "${base[@]}"',
    'saf_cli generate --config-dir "$SAF_CONFIG" --check',
    'saf_cli validate archive "$SAF_CONFIG" "${base[@]}"',
]

# Provisioning (app-provisioning.yml, ADR-0032).
PROV_ENTRY = "app-provisioning.yml"
PROV_SCRIPTS = "scripts/provisioning/"
PROV_ENTRY_PARAMS = [{"name": "environments", "type": "object"}, {"name": "hostEnvironment", "type": "string"},
                     {"name": "scope", "type": "string", "values": ["changed", "all"]},
                     {"name": "upgrade", "type": "string"}]
# Per script: the app loop that calls prov_run_app (loop variable, array).
PROV_LOOP_SCRIPTS = {"azure.sh": ("slug", "PROV_APPS"), "azure-post.sh": ("slug", "PROV_APPS"),
                     "ado.sh": ("slug", "PROV_APPS"), "entra-plan.sh": ("slug", "PROV_APPS"),
                     "entra.sh": ("t", "targets"), "record.sh": ("slug", "PROV_APPS"),
                     "registry.sh": ("slug", "PROV_APPS")}
# Parallel units (ADR-0046, P22): the scripts that run their units at the same time, and those that don't.
PROV_PARALLEL_SCRIPTS = ("azure.sh", "azure-post.sh", "entra-plan.sh", "record.sh", "registry.sh")
PROV_SEQUENTIAL_SCRIPTS = ("ado.sh", "entra.sh")
RECORD_TEMPLATE = "templates/provisioning/stages/record.yml"
# The registry image purge of a build environment (ADR-0059).
REGISTRY_TEMPLATE = "templates/provisioning/stages/registry.yml"
# Scripts that use Bicep (names.bicep snapshot, deployments): their jobs install the pinned bicep.
PROV_BICEP_SCRIPTS = ("azure.sh", "azure-post.sh", "entra-plan.sh", "entra.sh")
PROV_BICEP_USE = re.compile(r"\b(prov_names|prov_arm|prov_lz)\b|(^|[\s;|&(])bicep\s|\baz\s+deployment\s+\S+\s+(validate|create)\b", re.M)
PROV_TOOLS = {"node", "bicep"}
ADO_RESOURCE = "499b84ac-1321-427f-aa17-267ca6975798"   # Azure DevOps (Entra resource ID)
PROV_CONDITION = "and(not(canceled()), eq(dependencies.validate.result, 'Succeeded'))"
# Stage `entra` (ADR-0033): only when an Entra plan planned a change, so a run without one never reaches
# sc-platform-entra (nor, with approvals.entraChanges separate, its Approval check; ADR-0051): the
# job decide of stage plan (units whose landing zone doesn't run) or stage entra_plan (ADR-0050).
ENTRA_CONDITION = ("and(not(canceled()), eq(dependencies.validate.result, 'Succeeded'), "
                   "or(eq(dependencies.plan.outputs['decide.entraDecide.entraNeeded'], 'true'), "
                   "eq(dependencies.entra_plan.outputs['plan.decide.entraNeeded'], 'true')))")
# The artifact of a stage that may be skipped is downloaded only when its job ran (steps/download.yml
# optional, ADR-0048): the job maps saf.result.<artifact> to that job's result (P25).
OPTIONAL_DOWNLOAD_CONDITION = ("and(succeeded(), in(variables['saf.result.{a}'], "
                               "'Succeeded', 'SucceededWithIssues', 'Failed'))")
VALIDATE_JOB_VARIABLES = [{"name": "saf.coreRef", "value": "$[ resources.repositories.core.ref ]"}]
RESULT_VARIABLE = re.compile(r"saf\.result\.[A-Za-z0-9_${}. ]+")
RESULT_VALUE = re.compile(r"\$\[ stageDependencies\.[A-Za-z0-9_${}. ]+\.[a-z_]+\.result \]")


def artifact_job(artifact: str) -> tuple[str, str] | None:
    """(stage, job) that publishes an artifact a later stage may download conditionally."""
    fixed = {"ado": ("ado_resources", "resources"), "ado_pipelines": ("ado_pipelines", "pipelines"),
             "entra_plan": ("entra_plan", "plan"), "entra": ("entra", "registrations")}
    if artifact in fixed:
        return fixed[artifact]
    if artifact.startswith("registry_"):
        return artifact, "purge"
    if artifact.startswith("azure_post_"):
        return artifact, "releases"
    if artifact.startswith("azure_"):
        return artifact, "landing_zones"
    return None


# Stage plan (ADR-0048, P25).
PLAN_TEMPLATE = "templates/provisioning/stages/plan.yml"
PLAN_DECIDE_SETTABLE = ["ado", "entraPlan", {"${{ each env in parameters.environments }}": [
    "lz_${{ env.name }}", "post_${{ env.name }}", "record_${{ env.name }}",
    {"${{ if eq(format('{0}', env.promoteFrom), '') }}": ["registry_${{ env.name }}"]}]}]
PLAN_OUTPUT_CONDITION = ("and(not(canceled()), eq(dependencies.validate.result, 'Succeeded'), "
                         "eq(dependencies.plan.outputs['decide.decide.{o}'], 'true'))")
DECIDE_SETVARIABLE = 'echo "##vso[task.setvariable variable=$name;isOutput=true]$value"'
DECIDE_NAME_CHECK = "^(ado|entraPlan|(lz|post|record|registry)_[a-z][a-z0-9]{1,7})$"
MARKER_SCRIPT = ('set -euo pipefail for a in "$SAF_ARTIFACT" ${SAF_ALSO_ARTIFACT:+"$SAF_ALSO_ARTIFACT"}; do '
                 '[[ "$a" =~ ^[a-z][a-z0-9_]{1,40}$ ]] || { echo "SAF_ARTIFACT has an invalid shape" >&2; exit 1; } '
                 'out="$PIPELINE_WORKSPACE/saf-out/$a" mkdir -p "$out" jq -n --arg s "$a" --arg r "$BUILD_BUILDID" '
                 '\'{stage: $s, runId: $r}\' > "$out/stage.json" done')
ENTRA_PLAN_TEMPLATE = "templates/provisioning/stages/entra-plan.yml"
ENTRA_TEMPLATE = "templates/provisioning/stages/entra.yml"
ENTRA_SCRIPTS = ("entra-plan.sh", "entra.sh", "entra-decide.sh")
# The per-app readers of prov-lib.sh that plan.sh no longer calls (ADR-0050, P25): it reads lists.
PLAN_PER_APP = ("prov_names", "prov_record", "prov_write_secret_entry", "prov_write_frontdoor_entry", "prov_easyauth_app",
                "prov_job_state", "prov_secret_meta", "prov_secret_exists", "prov_fd_domain", "prov_run_app", "prov_parallel")
# Jobs whose artifact a later job may read after they failed: created first, published with always().
def marker_jobs(names: list[str]) -> dict[str, str]:
    """stage (or plan job) -> artifact, for every job that starts with the marker step."""
    out = {"entra_plan": "entra_plan", "entra": "entra", "ado_resources": "ado", "ado_pipelines": "ado_pipelines",
           "decide": "units", "report": "report"}
    for e in names:
        out[f"azure_{e}"] = f"azure_{e}"
        out[f"azure_post_{e}"] = f"azure_post_{e}"
        out[f"plan_{e}"] = f"plan_{e}"
        out[f"registry_{e}"] = f"registry_{e}"
    return out
# Easy Auth secret hand-off (ADR-0035, ADR-0041, P17).
SECRET_SCRIPT = "entra.sh"
SECRET_OPTIONS = ["--mode", "--client-id", "--job", "--secret-name", "--vault", "--display-name",
                  "--current-created", "--current-expires", "--loaded-created", "--output"]
# The functions of entra.sh that call easyauth-secret, with their options (ADR-0060: remove-old adds --app-vault).
SECRET_CALLS = {"write_secret": SECRET_OPTIONS, "remove_old_secret": SECRET_OPTIONS + ["--app-vault"]}
# Easy Auth secret rotation (ADR-0041, P19): the restart when the revisions predate the secret's
# version, and what no script does.
RESTART_SCRIPT = "azure-post.sh"
RESTART_FUNCTION = "restart_stale"
# A revision restart in any form: a /restart URL segment (also in a URL built from variables),
# az containerapp revision restart, az resource invoke-action restart.
REVISION_RESTART = re.compile(r"/restart\b|\bcontainerapp\s+revision\s+restart\b|\binvoke-action\b[^\n]*\brestart\b")
# az rest calls: anything without a literal GET method (--method get, --method=get, -m "get", any case)
# counts as a write, which only the template hash (P06) and the restart may be.
AZ_REST = re.compile(r"\baz\s+rest\b", re.IGNORECASE)
# The only az rest DELETE (P19, P20): fd_delete() in azure-post.sh, on the ID it checked.
FD_DELETE_CALL = re.compile(r'if ! az rest --method delete --url "\$id\?api-version=\$api" --only-show-errors --output none 2> "\$err"; then')
AZ_REST_GET = re.compile(r"(--method|-m)(\s+|=)([\"']?)get\3(\s|$)", re.IGNORECASE)
# The settle time of a new Easy Auth secret version (ADR-0041): defined once in prov-lib.sh.
SETTLE = 'PROV_EASYAUTH_SETTLE_S=1800'
GRAPH_CREDENTIALS = re.compile(r"\baz\s+ad\s+(app|sp)\s+credential\b|\b(add|remove)Password\b|graph\.microsoft\.com"
                               r"|/(v1\.0|beta)/applications\b", re.IGNORECASE)
# What started a run: nothing may decide on it (a scheduled, manual or merge run decides the same way).
RUN_ORIGIN = re.compile(r"BUILD_REASON|Build\.Reason|BUILD_CRONSCHEDULE|Build\.CronSchedule|BUILD_REQUESTEDFOR"
                        r"|Build\.RequestedFor", re.IGNORECASE)
SECRET_TOKENS = {"graph": "SAF_GRAPH_TOKEN", "arm": "SAF_ARM_TOKEN"}
# Portal-side private endpoints of app vaults (ADR-0025, P21).
PORTAL_ENDPOINT_SCRIPT = "azure-post.sh"
PORTAL_ENDPOINT_HOST_GUARD = 'if [ "$env_name" != "$host" ]; then'
# ADR-0056: the calls of decommissioning that P06 (deployment records), P19 (az rest), P21 (deletes of a
# private endpoint or a resource group) would refuse, each allowed only in its function (P27 checks
# that each function runs only for its unit's action delete or retire). (file, function, exact line).
DECOMMISSION_EXCEPTIONS: tuple[tuple[str, str, str], ...] = (
    ("azure.sh", "lz_delete", 'az group delete --name "$rg" --yes --only-show-errors --output none'),
    # The landing zone's record goes last, in record_<env>, after the service connection (ADR-0056 amendment 2026-11-12).
    ("record.sh", "lz_record_delete", 'az deployment sub delete --name "$lz_name" --only-show-errors --output none'),
    ("azure.sh", "lz_nested_cleanup", 'if ! az deployment operation sub list --name "$lz_name" '),
    ("azure.sh", "lz_nested_cleanup", 'if az deployment group delete --name "$name" --resource-group "$platform_rg" --only-show-errors --output none 2> "$err"; then'),
    ("azure-post.sh", "retire_step", 'az rest --method post --url "$app_id/stop?api-version=$CA_API" --only-show-errors --output none'),
    ("azure-post.sh", "start_step", 'az rest --method post --url "$app_id/start?api-version=$CA_API" --only-show-errors --output none'),
    ("entra.sh", "unregister", 'az deployment group delete --name "$entra_name" --resource-group "$entra_rg" --only-show-errors --output none'),
)
# P27: each function above, and the delete steps of the other units, is reached only through the plan's
# action (the caller tests prov_unit_action ... = delete|retire, or prov_was_retired, before calling it).
DECOMMISSION_DISPATCH: tuple[tuple[str, str, str, str], ...] = (
    ("azure.sh", "<top>", r'if \[ "\$\(prov_unit_action "\$slug" "\$env_name" lz\)" = delete \]; then', r"\blz_delete\b"),
    ("azure-post.sh", "portal_endpoints", r'if \[ "\$\(prov_unit_action "\$slug" "\$e" pep\)" = delete \]; then', r"\bportal_endpoint_delete\b"),
    ("azure-post.sh", "release_app", r'if \[ "\$\(prov_unit_action "\$slug" "\$env_name" release\)" = retire \]; then', r"^\s*retire_step$"),
    ("azure-post.sh", "release_app", r'if \[ "\$\(prov_unit_action "\$slug" "\$env_name" frontdoor\)" = delete \]; then', r"^\s*decom_frontdoor$"),
    ("azure-post.sh", "release_step", r'if prov_was_retired "\$slug" "\$env_name"; then start_step; fi', r"\bstart_step\b"),
    ("entra.sh", "provision", r'\[ "\$\(prov_unit_action "\$slug" "\$app_env" entra\)" = delete \] \|\| saf_die', r"^\s*unregister "),
    ("entra-plan.sh", "plan_registration", r'if \[ "\$\(prov_unit_action "\$slug" "\$app_env" entra\)" = delete \]; then', r"prov_detail entra delete"),
    ("ado.sh", "<top>", r'if \[ "\$\(prov_unit_action "\$slug" "\$\{PROV_APP_ENVS\[0\]\}" ado\)" = delete \]; then', r"\bado_remove\b"),
    ("record.sh", "record_tags", r'if prov_unit_runs "\$slug" "\$env_name" lz && \[ "\$\(prov_unit_action "\$slug" "\$env_name" lz\)" = delete \]; then', r"^\s*lz_record_delete "),
)
# P27: the steps of the landing zone's delete are defined in azure.sh and called only from lz_delete()
# (reached only through the plan's action delete, above); ADR-0061 adds the Easy Auth secret's delete.
DECOMMISSION_CALLERS: dict[tuple[str, str], str] = {
    ("azure.sh", "lz_outside_assignments"): "lz_delete",
    ("azure.sh", "lz_secret_delete"): "lz_delete",
    ("azure.sh", "lz_nested_cleanup"): "lz_delete",
}


# ADR-0060: the deletes of the move of a network mode change that P20 (az resource delete) and P21 (a private
# endpoint's delete) would refuse, each allowed only in its function (P28 checks how they are reached).
MOVE_EXCEPTIONS: tuple[tuple[str, str, str], ...] = (
    ("azure-post.sh", "move_app_delete", 'az resource delete --ids "$id" --api-version "$CA_API" --only-show-errors --output none'),
    ("azure-post.sh", "move_endpoints", 'az network private-endpoint delete --ids "$id" --only-show-errors --output none'),
)
# P28: the move step only for the plan's action move; its destructive helpers only from it, after the
# preconditions; the follow-up's remove-old only for the plan's followUp.
MOVE_DISPATCH: tuple[tuple[str, str, str, str], ...] = (
    ("azure-post.sh", "release_app", r'if \[ "\$\(prov_unit_action "\$slug" "\$env_name" release\)" = move \]; then', r'^\s*move_from="\$\(prov_mode_change '),
    ("azure-post.sh", "release_app", r'if \[ -n "\$move_from" \]; then', r'^\s*move_step "\$move_from"$'),
    ("entra.sh", "provision", r'prov_follow_up "\$slug" "\$app_env" \|\| saf_die', r'^\s*remove_old_secret '),
    ("entra-plan.sh", "plan_old_secret", r'^\s*prov_follow_up "\$slug" "\$app_env" \|\| return 0$', r'remove-old\.json"$'),
)
MOVE_CALLERS = {"move_step": "release_app", "move_joiner_delete": "move_step", "move_app_delete": "move_step",
                "move_endpoints": "move_step", "move_secret_role": "move_step"}


def move_exception(name: str, code: str, line: str) -> bool:
    """The line starts with one of MOVE_EXCEPTIONS, inside its function (ADR-0060)."""
    for base, func, text in MOVE_EXCEPTIONS:
        if name == PROV_SCRIPTS + base and line.strip().startswith(text) and line in logical_lines(shell_functions(code).get(func, "")):
            return True
    return False


def decommission_exception(name: str, code: str, line: str) -> bool:
    """The line starts with one of DECOMMISSION_EXCEPTIONS or PORTAL_ENDPOINT_REMOVALS, inside its
    function (ADR-0056, ADR-0025 amendment 2026-11-14)."""
    for base, func, text in DECOMMISSION_EXCEPTIONS + PORTAL_ENDPOINT_REMOVALS:
        if name == PROV_SCRIPTS + base and line.strip().startswith(text) and line in logical_lines(shell_functions(code).get(func, "")):
            return True
    return False


# ADR-0063: the one Entra record the stage entra deletes outside decommissioning: the app's record left in
# the instance's rg-{prefix}-entra after its registration's deployment into the environment's records group
# (P06 allows exactly this line, in retire_instance_record() of entra.sh only).
ENTRA_RETIRE_DELETE = 'if az deployment group delete --name "$entra_name" --resource-group "$instance_rg" --only-show-errors --output none 2> "$err"; then'


def ENTRA_RETIRE_LINES(name: str, code: str) -> list[str]:  # noqa: N802 (a table-like helper next to the constant)
    """The logical lines of retire_instance_record() in entra.sh (nothing for any other script)."""
    if name != PROV_SCRIPTS + "entra.sh":
        return []
    return logical_lines(shell_functions(code).get("retire_instance_record", ""))


# ADR-0025 amendment 2026-11-14: the portal-side endpoint of an app vault and its record are removed only
# here (P06 and P21 refuse these calls anywhere else; P26 holds their guards), and these two functions
# are called only from PORTAL_ENDPOINT_REMOVAL_CALLERS (P21).
PORTAL_ENDPOINT_REMOVALS: tuple[tuple[str, str, str], ...] = (
    ("azure-post.sh", "portal_endpoint_remove", 'az network private-endpoint delete --ids "$endpoint_id" --only-show-errors --output none'),
    ("azure-post.sh", "portal_endpoint_forget", 'az deployment group delete --name "$deployment" --resource-group "$portal_rg" --only-show-errors --output none'),
)
PORTAL_ENDPOINT_REMOVAL_CALLERS = {
    "portal_endpoint_remove": ["portal_endpoint", "portal_endpoint_delete", "portal_endpoint_left"],
    "portal_endpoint_forget": ["portal_endpoint_delete", "portal_endpoint_left"],
    "portal_endpoint_left": ["portal_endpoint"],
}


PORTAL_ENDPOINT_FORBIDDEN = re.compile(r"\bprivate-endpoint\s+delete\b|\bprivate-endpoint-connection\s+(delete|reject)\b"
                                       r"|\baz\s+resource\s+delete\b|\baz\s+group\s+delete\b")
# dbinit hand-off (ADR-0028, P18).
DBINIT_SCRIPT = "azure-post.sh"
DBINIT_OPTIONS = ["--job", "--engine", "--host", "--database", "--principal-name", "--principal-id", "--principal-client-id", "--output"]
# The platform job starts that get the Azure provisioning identity's ARM token (P18): (script, command,
# exactly these options, the function it runs in). ADR-0061: the Easy Auth secret's delete with the
# landing zone's delete.
EASYAUTH_DELETE_OPTIONS = ["--job", "--vault", "--secret-name", "--output"]
ARM_TOKEN_HANDOFFS: tuple[tuple[str, str, list[str], str], ...] = (
    (DBINIT_SCRIPT, "dbinit", DBINIT_OPTIONS, "database_entry"),
    ("azure.sh", "easyauth-delete", EASYAUTH_DELETE_OPTIONS, "lz_secret_delete"),
)
# Exported variables prov_env_guard (prov-lib.sh) refuses: tracing or code injection through pipeline variables.
ENV_GUARD = {"SHELLOPTS", "BASHOPTS", "BASH_ENV", "ENV", "PS4", "BASH_XTRACEFD", "NODE_OPTIONS"}
XTRACE = re.compile(r"\bset\s+-[A-Za-z]*x|\bset\s+-o\s+xtrace\b|\bxtrace\b|BASH_XTRACEFD|\bbash\s+(-[A-Za-z]*x|.*-o\s+xtrace)")
SHELL_ENV = {"SHELLOPTS", "BASHOPTS", "BASH_ENV", "ENV", "PS4", "BASH_XTRACEFD"}
PROV_GUARDS = [
    "parameters.environments lists no environment",
    "an environment has no name",
    "an environment kind is not prod or nonprod",
    "an environment cannot promote from itself",
    "environment names must be unique",
    "promoteFrom must name an environment of the list",
    "promoteFrom must name an environment listed earlier",
    "hostEnvironment must name an environment of the list",
]
SC_INPUTS = {"azuresubscription", "connectedservicename", "connectedservicenamearm",
             "azureresourcemanagerconnection", "serviceconnection", "endpoint"}
# The only step that may run with `commands: any` (report job): it prints this fixed line only.
SUMMARY_UPLOAD = ('set -euo pipefail summary="$PIPELINE_WORKSPACE/saf-out/report/summary.md" '
                  'if [ -f "$summary" ]; then echo "##vso[task.uploadsummary]$summary" fi')


# ---------------------------------------------------------------------------------------------
# YAML loading: every scalar stays a string (Azure Pipelines semantics, no YAML 1.1 booleans),
# duplicate keys and anchors/aliases are errors.
# ---------------------------------------------------------------------------------------------
class StrictLoader(yaml.BaseLoader):
    pass


def _construct_mapping(loader: StrictLoader, node: yaml.MappingNode, deep: bool = False) -> dict:
    mapping: dict = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                None, None, f"duplicate key {key!r}", key_node.start_mark)
        mapping[key] = loader.construct_object(value_node, deep=deep)
    return mapping


StrictLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _construct_mapping)


@functools.lru_cache(maxsize=None)
def load_yaml(text: str, name: str) -> tuple[object, list[str]]:
    """Cached: the same text is parsed once per process (fixtures patch only a few files). The
    returned tree is shared and must not be modified (Checker and Expander only read it)."""
    errors: list[str] = []
    try:
        for event in yaml.parse(text, Loader=StrictLoader):
            if isinstance(event, yaml.AliasEvent) or getattr(event, "anchor", None):
                errors.append(f"T01 {name}: YAML anchors/aliases are not supported by Azure Pipelines")
                break
        return yaml.load(text, Loader=StrictLoader), errors
    except yaml.YAMLError as exc:
        return None, errors + [f"T01 {name}: {exc}".replace("\n", " ")]


# ---------------------------------------------------------------------------------------------
# Tree helpers
# ---------------------------------------------------------------------------------------------
def is_expr_key(key: object) -> bool:
    return isinstance(key, str) and key.strip().startswith("${{")


def flatten(items: object) -> list:
    """Flattens a YAML sequence, descending into `${{ if/each }}` insertions."""
    out: list = []
    if not isinstance(items, list):
        return out
    for item in items:
        if isinstance(item, dict) and len(item) == 1 and is_expr_key(next(iter(item))):
            out.extend(flatten(next(iter(item.values()))))
        else:
            out.append(item)
    return out


def walk(node: object):
    """Yields every (key, value) pair of every mapping in the tree."""
    if isinstance(node, dict):
        for key, value in node.items():
            yield key, value
            yield from walk(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk(item)


def step_kind(step: dict) -> str:
    for kind in ("checkout", "download", "bash", "script", "pwsh", "powershell", "task", "template",
                 "publish", "downloadBuild", "getPackage", "reviewApp"):
        if kind in step:
            return kind
    return "?"


def mentions_report(node: object) -> bool:
    return "report.sh" in json.dumps(node)


def is_report_step(step: dict) -> bool:
    """The deploy-event step: AzureCLI@2 running scripts/report.sh (T30)."""
    inputs = step.get("inputs") if isinstance(step.get("inputs"), dict) else {}
    return step.get("task") == "AzureCLI@2" and inputs.get("scriptPath") == CORE_SCRIPTS + REPORT_SCRIPT


def walk_dicts(node: object):
    """Yields every mapping in the tree."""
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk_dicts(value)
    elif isinstance(node, list):
        for item in node:
            yield from walk_dicts(item)


def script_texts(step: dict) -> list[str]:
    texts = [step.get(k) for k in ("bash", "script", "pwsh", "powershell")]
    inputs = step.get("inputs") if isinstance(step.get("inputs"), dict) else {}
    texts += [inputs.get(k) for k in ("script", "inlineScript", "arguments", "scriptArguments")]
    return [t for t in texts if isinstance(t, str)]


class Repo:
    """In-memory copy of pipelines/azure-devops (+ naming.bicep), so fixtures can patch it."""

    def __init__(self, files: dict[str, str]):
        self.files = files

    @classmethod
    def from_disk(cls) -> "Repo":
        files = {}
        for path in DELIVERY.rglob("*"):
            rel = path.relative_to(DELIVERY).as_posix()
            if path.is_file() and not rel.startswith("tests/") and path.suffix in {".yml", ".yaml", ".sh", ".json"}:
                files[rel] = path.read_text(encoding="utf-8")
        files["@naming.bicep"] = NAMING.read_text(encoding="utf-8")
        files["@names.bicep"] = NAMES.read_text(encoding="utf-8")
        for path in sorted((HERE / "scenarios").glob("*.json")):
            files[f"@scenarios/{path.name}"] = path.read_text(encoding="utf-8")
        for path in sorted((HERE / "scenarios" / "provisioning").glob("*.json")):
            files[f"@prov-scenarios/{path.name}"] = path.read_text(encoding="utf-8")
        for path in sorted((HERE / "scenarios" / "platform").glob("*.json")):
            files[f"@plat-scenarios/{path.name}"] = path.read_text(encoding="utf-8")
        files["@platform-names.bicep"] = PLAT_NAMES.read_text(encoding="utf-8")
        return cls(files)

    def patched(self, patches: list[dict]) -> "Repo":
        files = dict(self.files)
        for patch in patches:
            name = patch["file"]
            if name not in files:
                raise KeyError(f"fixture patches unknown file {name}")
            text = files[name]
            if "find" in patch:
                if patch["find"] not in text:
                    raise KeyError(f"fixture text not found in {name}: {patch['find'][:60]!r}")
                text = text.replace(patch["find"], patch["replace"], patch.get("count", 1))
            if "append" in patch:
                text += patch["append"]
            files[name] = text
        return Repo(files)


# ---------------------------------------------------------------------------------------------
# Checks
# ---------------------------------------------------------------------------------------------
class Checker:
    def __init__(self, repo: Repo):
        self.repo = repo
        self.failures: list[str] = []
        self.docs: dict[str, object] = {}       # reachable from app-delivery.yml
        self.pdocs: dict[str, object] = {}      # reachable from app-provisioning.yml
        self.vdocs: dict[str, object] = {}      # reachable from platform-validation.yml
        self.edocs: dict[str, object] = {}      # reachable from platform-environment.yml

    def fail(self, rule: str, msg: str) -> None:
        self.failures.append(f"{rule} {msg}")

    # -- loading -------------------------------------------------------------------------------
    def load_reachable(self, entry: str = ENTRY) -> dict[str, object]:
        """Every template reachable from `entry` (relative `template:` references)."""
        docs: dict[str, object] = {}
        pending = [entry]
        while pending:
            rel = pending.pop()
            if rel in docs:
                continue
            if rel not in self.repo.files:
                self.fail("T05", f"{rel}: referenced template does not exist")
                continue
            doc, errors = load_yaml(self.repo.files[rel], rel)
            self.failures.extend(e for e in errors if e not in self.failures)
            docs[rel] = doc
            if doc is None:
                continue
            for key, value in walk(doc):
                if key == "template" and isinstance(value, str):
                    if "@" in value:
                        self.fail("T05", f"{rel}: template {value!r} references another repository")
                        continue
                    if rel != entry and value.startswith("/"):
                        self.fail("T05", f"{rel}: template {value!r} must be a relative path")
                        continue
                    pending.append(self.resolve(rel, value))
                if key == "extends" and rel != entry:
                    self.fail("T05", f"{rel}: `extends` below the entry point")
            if rel == entry and isinstance(doc, dict) and "extends" in doc:
                self.fail("T05", f"{rel}: the entry point must not extend another template")
        return docs

    def steps_of(self, steps: object, rel: str) -> list[tuple[str, dict]]:
        """Steps with step templates expanded: [(file, step)]."""
        out: list[tuple[str, dict]] = []
        for step in flatten(steps):
            if not isinstance(step, dict):
                continue
            if "template" in step and isinstance(step["template"], str) and "@" not in step["template"]:
                target = self.resolve(rel, step["template"])
                doc = self.docs.get(target, self.pdocs.get(target, self.vdocs.get(target, self.edocs.get(target))))
                if isinstance(doc, dict):
                    out.extend(self.steps_of(doc.get("steps"), target))
                continue
            out.append((rel, step))
        return out

    @staticmethod
    def resolve(rel: str, ref: str) -> str:
        parts: list[str] = []
        for part in (Path(rel).parent.as_posix() + "/" + ref).split("/"):
            if part == "..":
                if parts:
                    parts.pop()
            elif part not in ("", "."):
                parts.append(part)
        return "/".join(parts)

    def stages(self, docs: dict[str, object] | None = None) -> list[tuple[str, dict]]:
        out: list[tuple[str, dict]] = []
        for rel, doc in (self.docs if docs is None else docs).items():
            if isinstance(doc, dict):
                for st in flatten(doc.get("stages")):
                    if isinstance(st, dict) and "stage" in st:
                        out.append((rel, st))
        return out

    @staticmethod
    def jobs_of(stage: dict) -> list[dict]:
        return [j for j in flatten(stage.get("jobs")) if isinstance(j, dict)]

    @staticmethod
    def job_steps(job: dict) -> object:
        if "deployment" in job:
            strategy = job.get("strategy") or {}
            run_once = strategy.get("runOnce") or {}
            return (run_once.get("deploy") or {}).get("steps")
        return job.get("steps")

    # -- rules -----------------------------------------------------------------------------------
    def run(self) -> list[str]:
        self.docs = self.load_reachable(ENTRY)
        self.pdocs = self.load_reachable(PROV_ENTRY)
        self.vdocs = self.load_reachable(VAL_ENTRY)
        self.edocs = self.load_reachable(PLAT_ENTRY)
        entry = self.docs.get(ENTRY)
        if not isinstance(entry, dict):
            self.fail("T01", f"{ENTRY} did not load")
            return self.failures
        self.t02_entry(entry)
        self.t03_param_types()
        stages = self.stages()
        all_jobs = [(rel, st, job) for rel, st in stages for job in self.jobs_of(st)]
        all_steps = [(srel, st, job, step) for rel, st, job in all_jobs
                     for srel, step in self.steps_of(self.job_steps(job), rel)]
        self.t04_t16_t17_t20_stages(stages)
        self.t06_verify(stages)
        self.t07_build(stages)
        self.t08_t09_t10_steps(all_steps)
        self.t10_anywhere()
        self.t11_deployments(all_jobs)
        self.t12_deploy_script()
        self.t13_downloads()
        self.t13_java_db()
        self.t14_tools()
        self.t15_naming()
        self.t18_checkouts(all_steps)
        self.t19_guards()
        self.t21_scripts()
        self.t23_t25_scenarios()
        self.t26_import_mode()
        self.t27_token(stages)
        self.t29_specific_downloads()
        self.t30_report(all_steps)
        self.t31_capacity()
        self.run_provisioning()
        self.run_validation()
        self.run_platform()
        return self.failures

    def t02_entry(self, entry: dict) -> None:
        params = entry.get("parameters")
        if not isinstance(params, list):
            self.fail("T02", f"{ENTRY}: parameters must be a list")
            return
        names = [p.get("name") for p in params if isinstance(p, dict)]
        if names != list(ENTRY_PARAMS) or len(params) != len(ENTRY_PARAMS):
            self.fail("T02", f"{ENTRY}: parameters must be exactly {list(ENTRY_PARAMS)} (got {names})")
        for p in params:
            if not isinstance(p, dict) or p.get("name") not in ENTRY_PARAMS:
                continue
            want = ENTRY_PARAMS[p["name"]]
            got = {k: v for k, v in p.items() if k != "name" and k != "displayName"}
            if got != want:
                self.fail("T02", f"{ENTRY}: parameter {p['name']} must be exactly {want} (got {got})")
        for key in ("variables", "resources", "trigger", "pr", "pool", "schedules", "jobs", "steps"):
            if key in entry:
                self.fail("T02", f"{ENTRY}: no root `{key}` in the entry point")

    def t03_param_types(self, docs: dict[str, object] | None = None) -> None:
        for rel, doc in (self.docs if docs is None else docs).items():
            if not isinstance(doc, dict):
                continue
            for p in doc.get("parameters") or []:
                if isinstance(p, dict) and str(p.get("type", "string")).lower() in FORBIDDEN_PARAM_TYPES:
                    self.fail("T03", f"{rel}: parameter {p.get('name')} has forbidden type {p.get('type')}")
                if not isinstance(p, dict):
                    self.fail("T03", f"{rel}: parameters must be declared as typed entries")

    def t04_t16_t17_t20_stages(self, stages: list[tuple[str, dict]], docs: dict[str, object] | None = None) -> None:
        docs = self.docs if docs is None else docs
        for rel, doc in docs.items():
            if isinstance(doc, dict) and "variables" in doc:
                self.fail("T17", f"{rel}: no root variables")
        for key, value in ((k, v) for doc in docs.values() for k, v in walk(doc)):
            if key == "group" or (key == "variables" and isinstance(value, list)
                                  and any(isinstance(v, dict) and "group" in v for v in value)):
                self.fail("T17", "variable groups are not allowed")
        for rel, st in stages:
            name = st.get("stage")
            if st.get("isSkippable") != "false":
                self.fail("T04", f"{rel}: stage {name} must set isSkippable: false")
            if st.get("pool") != {"name": POOL_NAME, "vmImage": VM_IMAGE}:
                self.fail("T16", f"{rel}: stage {name} must use pool {POOL_NAME} with vmImage {VM_IMAGE}")
            if "variables" in st:
                self.fail("T17", f"{rel}: stage {name} must not define variables")
            for job in self.jobs_of(st):
                jname = job.get("job") or job.get("deployment")
                if job.get("pool") != {"name": POOL_NAME, "vmImage": VM_IMAGE}:
                    self.fail("T16", f"{rel}: job {jname} must use pool {POOL_NAME} with vmImage {VM_IMAGE}")

    def t06_verify(self, stages: list[tuple[str, dict]]) -> None:
        verify = [(rel, st) for rel, st in stages if st.get("stage") == "verify"]
        if len(verify) != 1:
            self.fail("T06", "exactly one stage named verify expected")
            return
        rel, st = verify[0]
        text_blobs = [json.dumps(st)]
        for job in self.jobs_of(st):
            jname = job.get("job") or job.get("deployment")
            if "deployment" in job or "environment" in job:
                self.fail("T06", f"{rel}: verify job {jname} must not be a deployment or use an environment")
            for srel, step in self.steps_of(self.job_steps(job), rel):
                text_blobs.append(json.dumps(step))
                task = str(step.get("task", ""))
                if task.lower().startswith("azurecli") or task.lower().startswith("azurepowershell"):
                    self.fail("T06", f"{srel}: verify job {jname} must not run {task}")
                inputs = step.get("inputs") if isinstance(step.get("inputs"), dict) else {}
                for k in inputs:
                    if k.lower() in {"azuresubscription", "connectedservicename", "connectedservicenamearm",
                                     "azureresourcemanagerconnection", "serviceconnection", "endpoint"}:
                        self.fail("T06", f"{srel}: verify job {jname} uses a service connection input ({k})")
        blob = " ".join(text_blobs)
        if re.search(r"system\.accesstoken|system_accesstoken", blob, re.IGNORECASE):
            self.fail("T06", f"{rel}: the verify stage must not use System.AccessToken")
        for script in TOKEN_SCRIPTS:
            if Path(script).name in blob:
                self.fail("T06", f"{rel}: the verify stage must not run {script}")
        for name, text in self.repo.files.items():
            if name.endswith(".sh") and name not in TOKEN_SCRIPTS \
                    and re.search(r"system\.accesstoken|SYSTEM_ACCESSTOKEN", text, re.IGNORECASE):
                self.fail("T06", f"scripts: {name} must not use System.AccessToken")

    def t07_build(self, stages: list[tuple[str, dict]]) -> None:
        found = False
        for rel, st in stages:
            if st.get("stage") != "verify":
                continue
            for job in self.jobs_of(st):
                if job.get("job") != "build":
                    continue
                found = True
                for srel, step in self.steps_of(job.get("steps"), rel):
                    target = step.get("target")
                    label = step.get("displayName") or step_kind(step)
                    if not (isinstance(target, dict) and target.get("commands") == "restricted"
                            and target.get("settableVariables") == "none"):
                        self.fail("T07", f"{srel}: build step {label!r} must set target commands: restricted, settableVariables: none")
        if not found:
            self.fail("T07", "verify stage has no build job")

    def t08_t09_t10_steps(self, all_steps: list) -> None:
        for srel, st, job, step in all_steps:
            kind = step_kind(step)
            label = step.get("displayName") or kind
            if kind not in ALLOWED_STEP_KINDS:
                self.fail("T09", f"{srel}: step {label!r} has type {kind}; only {sorted(ALLOWED_STEP_KINDS)}")
            if kind == "task" and step.get("task") not in ALLOWED_TASKS:
                self.fail("T09", f"{srel}: task {step.get('task')} is not on the allowlist {sorted(ALLOWED_TASKS)}")
            for text in script_texts(step):
                m = FORBIDDEN_MACROS.search(text)
                if m:
                    self.fail("T08", f"{srel}: step {label!r} has {m.group(0)!r} in script text; map it through env:")

    def t10_anywhere(self, docs: dict[str, object] | None = None) -> None:
        for rel, doc in (self.docs if docs is None else docs).items():
            for node in walk_dicts(doc):
                if "enabled" in node:
                    self.fail("T10", f"{rel}: `enabled` is not allowed (it switches a step off)")
                if "continueOnError" not in node:
                    continue
                # The deploy event can't fail the run (ADR-0037, T30); nothing else may continue on error.
                if rel == REPORT_TEMPLATE and is_report_step(node) and node.get("continueOnError") == "true":
                    continue
                self.fail("T10", f"{rel}: continueOnError is not allowed (only on the deploy-event step)")

    def t11_deployments(self, all_jobs: list) -> None:
        for rel, st, job in all_jobs:
            if "deployment" not in job:
                continue
            strategy = job.get("strategy") or {}
            if set(strategy) != {"runOnce"}:
                self.fail("T11", f"{rel}: deployment {job.get('deployment')} must use strategy runOnce only")
            steps = flatten(self.job_steps(job))
            if not steps or not isinstance(steps[0], dict) or steps[0].get("download") != "none":
                self.fail("T11", f"{rel}: deployment {job.get('deployment')} must start with `- download: none`")
            for srel, step in self.steps_of(self.job_steps(job), rel):
                target = step.get("target")
                if isinstance(target, dict) and "settableVariables" in target:
                    label = step.get("displayName") or step_kind(step)
                    self.fail("T22", f"{srel}: step {label!r} of deployment {job.get('deployment')} sets "
                                     "target.settableVariables, which Azure Pipelines rejects in deployment jobs")

    def t12_deploy_script(self) -> None:
        deploy = self.repo.files.get("scripts/deploy.sh", "")
        code = strip_comments(deploy)
        creates = len(re.findall(r"az\s+deployment\s+group\s+create\b", code))
        if creates != 1:
            self.fail("T12", f"deploy.sh must call `az deployment group create` exactly once (found {creates})")
        defined = any('release_param="$SAF_CORE/infra/app/delivery/release.bicepparam"' in strip_comments(t)
                      for n, t in self.repo.files.items() if n.endswith(".sh"))
        if not defined:
            self.fail("T12", "release_param must be $SAF_CORE/infra/app/delivery/release.bicepparam")
        for name, text in self.repo.files.items():
            # Provisioning and platform scripts deploy through their own parameter files (rules P06, E05).
            if not name.endswith(".sh") or name.startswith(PROV_SCRIPTS) or name.startswith(PLAT_SCRIPTS):
                continue
            code = strip_comments(text)
            params = re.findall(r"--parameters\s+(\S+)", code)
            if any(p != '"$release_param"' for p in params):
                self.fail("T12", f"{name}: only --parameters \"$release_param\" is allowed; found {params}")
            for line in logical_lines(code):
                if re.search(r"az\s+deployment\s", line) and re.search(r"--template-(file|uri|spec)|\s-p\s|--parameter\s|-f\s", line):
                    self.fail("T12", f"{name}: no template or extra parameters for az deployment")
            if name != "scripts/deploy.sh" and re.search(r"az\s+deployment\s+\S+\s+create", code):
                self.fail("T12", f"{name} must not create deployments")
            if name != "scripts/preview.sh" and re.search(r"az\s+deployment\s+\S+\s+what-if", code):
                self.fail("T12", f"{name}: what-if belongs to preview.sh")

    def t13_downloads(self) -> None:
        report = [l for l in logical_lines(strip_comments(self.repo.files.get(REPORT_SCRIPT, "")))
                  if re.search(r"(^|[\s;|&(])curl\b", l)]
        if len(report) != 1:
            self.fail("T13", f"{REPORT_SCRIPT}: exactly one curl call (the deploy-event POST); found {len(report)}")
        for name, text in self.repo.files.items():
            if not name.endswith(".sh"):
                continue
            code = strip_comments(text)
            for line in logical_lines(code):
                if re.search(r"(^|[\s;|&(])wget\b", line) and name != "scripts/install-tool.sh":
                    self.fail("T13", f"{name}: wget outside install-tool.sh")
                if re.search(r"(^|[\s;|&(])curl\b", line) and name != "scripts/install-tool.sh":
                    if name == REPORT_SCRIPT:
                        problems = report_curl_problems(line)
                        if problems:
                            self.fail("T13", f"{name}: the deploy-event POST {', '.join(problems)}")
                    elif name != "scripts/smoke.sh" or "--output /dev/null" not in line:
                        self.fail("T13", f"{name}: curl outside install-tool.sh (smoke.sh may only probe with --output /dev/null)")
                m = re.search(r"\boras\s+(blob\s+fetch|pull|cp)\b(.*)", line)
                if m and "@" not in m.group(2):
                    self.fail("T13", f"{name}: `oras {m.group(1)}` must reference a digest (@sha256)")
                if re.search(r"\bdocker\s+pull\b", line):
                    self.fail("T13", f"{name}: docker pull is not allowed (images are pinned by digest in tools.json)")
        for rel, doc in {**self.docs, **self.pdocs, **self.vdocs, **self.edocs}.items():
            for key, value in walk(doc):
                if key in ("bash", "script") and isinstance(value, str):
                    for line in logical_lines(value):
                        if re.search(r"(^|[\s;|&(])(curl|wget)\b", line):
                            self.fail("T13", f"{rel}: inline curl/wget; downloads go through install-tool.sh")
                        m = re.search(r"\bnpm\s+(\S+)(.*)", line)
                        if m and not (m.group(1) == "ci" and "--ignore-scripts" in m.group(2)) and not (m.group(1) == "run" and m.group(2).split()[:1] == ["build"]):
                            self.fail("T13", f"{rel}: npm {m.group(1)} is not allowed (npm ci --ignore-scripts, npm run build)")

    def t13_java_db(self) -> None:
        script = strip_comments(self.repo.files.get("scripts/java-archives.sh", ""))
        if not script:
            self.fail("T13", "scripts/java-archives.sh is missing")
        for line in logical_lines(script):
            if re.search(r"\btar\b", line) and (re.search(r"--extract|--get|\s-[a-zA-Z]*x", line)):
                self.fail("T13", "java-archives.sh must only list layer contents, never extract")
        if script and "--list" not in script:
            self.fail("T13", "java-archives.sh must list layer contents with tar --list")
        verify = self.docs.get("templates/stages/verify.yml")
        scan = None
        if isinstance(verify, dict):
            for st in flatten(verify.get("stages")):
                for job in self.jobs_of(st) if isinstance(st, dict) else []:
                    if job.get("job") == "scan":
                        scan = job
        if scan is None:
            self.fail("T13", "verify stage has no scan job")
            return
        steps = [st for _, st in self.steps_of(scan.get("steps"), "templates/stages/verify.yml")]
        detect = [i for i, st in enumerate(steps) if "scripts/java-archives.sh" in str(st.get("bash", ""))]
        java = [i for i, st in enumerate(steps)
                if re.search(r"trivy-db\.sh\"? (resolve|install) java", str(st.get("bash", "")))
                or "saf-trivy-java-db" in str((st.get("inputs") or {}).get("key", ""))]
        if len(detect) != 1 or len(java) != 3:
            self.fail("T13", "the scan job must run java-archives.sh once and have the Java DB resolve, Cache@2 and install steps")
            return
        for i in java:
            cond = " ".join(str(steps[i].get("condition", "")).split())
            if i < detect[0] or cond != "and(succeeded(), eq(variables['SAF_SCAN_JAVA'], 'true'))":
                self.fail("T13", "Java DB steps must follow java-archives.sh and run only when SAF_SCAN_JAVA is true")

    def t14_tools(self) -> None:
        text = self.repo.files.get("tools/tools.json")
        if text is None:
            self.fail("T14", "tools/tools.json missing")
            return
        try:
            data = json.loads(text)
        except json.JSONDecodeError as exc:
            self.fail("T14", f"tools.json does not parse: {exc}")
            return
        tools = data.get("tools") or {}
        missing = REQUIRED_TOOLS - set(tools)
        if missing:
            self.fail("T14", f"tools.json lacks {sorted(missing)}")
        deny = data.get("denylist") or {}
        for name, t in tools.items():
            if not isinstance(t, dict):
                self.fail("T14", f"tools.json {name} is not an object")
                continue
            if not re.fullmatch(r"\d+\.\d+\.\d+", str(t.get("version", ""))):
                self.fail("T14", f"tools.json {name}: version must be an exact x.y.z")
            if not str(t.get("url", "")).startswith("https://"):
                self.fail("T14", f"tools.json {name}: url must be https")
            if not re.fullmatch(r"[0-9a-f]{64}", str(t.get("sha256", ""))):
                self.fail("T14", f"tools.json {name}: sha256 must be 64 lowercase hex characters")
            if not t.get("binary") or str(t.get("binary")).startswith("/") or ".." in str(t.get("binary")):
                self.fail("T14", f"tools.json {name}: binary must be a relative path")
            if t.get("archive", "none") not in ("tar.gz", "none"):
                self.fail("T14", f"tools.json {name}: archive must be tar.gz or none")
            if str(t.get("version")) not in str(t.get("url")):
                self.fail("T14", f"tools.json {name}: url does not contain the pinned version")
            if str(t.get("version")) in [str(v) for v in deny.get(name, [])]:
                self.fail("T14", f"tools.json {name}: version {t.get('version')} is on the denylist")
            sig = t.get("sigstore")
            if sig is not None:
                ids = [k for k in ("certificateIdentity", "certificateIdentityRegexp") if sig.get(k)]
                if not str(sig.get("bundleUrl", "")).startswith("https://") or len(ids) != 1 \
                        or not str(sig.get("certificateOidcIssuer", "")).startswith("https://"):
                    self.fail("T14", f"tools.json {name}: sigstore needs https bundleUrl, one certificate identity and an https issuer")
        if "sigstore" not in (tools.get("trivy") or {}):
            self.fail("T14", "tools.json: trivy must be verified with its Sigstore bundle")
        if "sigstore" in (tools.get("cosign") or {}):
            self.fail("T14", "tools.json: cosign cannot verify itself; pin it by checksum only")
        if set(deny.get("trivy", [])) < {"0.69.4", "0.69.5", "0.69.6"}:
            self.fail("T14", "tools.json: the denylist must keep trivy 0.69.4, 0.69.5 and 0.69.6")
        if not re.fullmatch(r"[a-z0-9./-]+:[A-Za-z0-9._-]+@sha256:[0-9a-f]{64}", str(data.get("buildkitImage", ""))):
            self.fail("T14", "tools.json: buildkitImage must be name:tag@sha256:<digest>")
        for key, repo_part in (("trivyDb", "trivy-db"), ("trivyJavaDb", "trivy-java-db")):
            db = data.get(key) or {}
            if not db.get("repositories") or not isinstance(db.get("maxAgeHours"), int) or db.get("maxAgeHours") <= 0 \
                    or not db.get("layerMediaType") \
                    or not all(repo_part in str(r) and ":" in str(r).rsplit("/", 1)[-1] for r in db.get("repositories") or []):
                self.fail("T14", f"tools.json: {key} needs {repo_part} repositories (with tag), layerMediaType and a positive maxAgeHours")

    def t15_naming(self) -> None:
        naming = self.repo.files.get("@naming.bicep", "")
        formats = {}
        for fn in ("adoServiceConnection", "adoEnvironment"):
            m = re.search(rf"func {fn}\(slug string, env string\) string => '([^']*)'", naming)
            if not m:
                self.fail("T15", f"naming.bicep has no {fn}(slug, env)")
                continue
            formats[fn] = re.sub(r"\$\{s\(slug\)\}", "{slug}", re.sub(r"\$\{e\(env\)\}", "{env}", m.group(1)))
        docs = [self.docs.get(f"templates/stages/{n}.yml") for n in ("deploy", "promote", "preview")]
        docs.append(self.docs.get(REPORT_TEMPLATE))
        if not all(isinstance(d, dict) for d in docs):
            self.fail("T15", f"templates/stages/deploy.yml, promote.yml, preview.yml and {REPORT_TEMPLATE} must be reachable")
            return
        norm = lambda s: re.sub(r"\$\{\{\s*parameters\.environment\.name\s*\}\}", "{env}",
                                re.sub(r"\$\{\{\s*parameters\.app\.slug\s*\}\}", "{slug}", str(s)))
        envs, conns = set(), set()
        for key, value in walk(docs):
            # `environment: ${{ parameters.environment }}` passes the object to a step template.
            if key == "environment" and isinstance(value, str) \
                    and not re.fullmatch(r"\$\{\{\s*parameters\.environment\s*\}\}", value):
                envs.add(norm(value))
            if key == "azureSubscription":
                conns.add(norm(value))
            if key == "SAF_SERVICE_CONNECTION":
                conns.add(norm(value))
            if key == "SAF_ADO_ENVIRONMENT":
                envs.add(norm(value))
        if "adoServiceConnection" in formats and conns != {formats["adoServiceConnection"]}:
            self.fail("T15", f"service connection {sorted(conns)} != naming.bicep {formats['adoServiceConnection']}")
        if "adoEnvironment" in formats and envs != {formats["adoEnvironment"]}:
            self.fail("T15", f"environment {sorted(envs)} != naming.bicep {formats['adoEnvironment']}")

    def t18_checkouts(self, all_steps: list) -> None:
        for srel, st, job, step in all_steps:
            if "checkout" not in step:
                continue
            repo = step.get("checkout")
            if repo not in CHECKOUT_PATHS:
                self.fail("T18", f"{srel}: checkout of {repo!r}; only core, self and app")
                continue
            expected = {"path": CHECKOUT_PATHS[repo], "fetchDepth": "1", "submodules": "false",
                        "lfs": "false", "persistCredentials": "false"}
            for key, want in expected.items():
                if step.get(key) != want:
                    self.fail("T18", f"{srel}: checkout {repo} must set {key}: {want}")
            if repo == "app" and "deployment" in job:
                self.fail("T18", f"{srel}: deployment jobs must not check out the app repo")

    def t19_guards(self) -> None:
        # Comments may quote a guard message; only YAML lines count.
        text = "\n".join(l for l in self.repo.files.get(ENTRY, "").splitlines() if not l.lstrip().startswith("#"))
        for guard in GUARDS:
            if guard not in text:
                self.fail("T19", f"{ENTRY}: compile-time guard missing: {guard!r}")

    def t21_scripts(self) -> None:
        for name, text in self.repo.files.items():
            if not name.endswith(".sh"):
                continue
            head = text.splitlines()[:3]
            if not head or not (head[0] == "#!/usr/bin/env bash" or "# shellcheck shell=bash" in head):
                self.fail("T21", f"{name}: must be a bash script")
            if not re.search(r"^set -euo pipefail$", text, re.M):
                self.fail("T21", f"{name}: must `set -euo pipefail`")


    # -- expanded scenarios ----------------------------------------------------------------------
    def t23_t25_scenarios(self) -> None:
        scenarios = {n: t for n, t in self.repo.files.items() if n.startswith("@scenarios/")}
        if not scenarios:
            self.fail("T23", "no scenarios in tests/scenarios/")
        for name, text in sorted(scenarios.items()):
            spec = json.loads(text)
            label = name.split("/", 1)[1]
            stages, errors = Expander(self.repo).pipeline(spec["parameters"])
            expect = spec["expect"]
            if "errors" in expect:
                for want in expect["errors"]:
                    if not any(want in e for e in errors):
                        self.fail("T23", f"{label}: expected the compile error {want!r}; got {errors or 'none'}")
                continue
            if errors:
                self.fail("T23", f"{label}: unexpected compile errors {errors}")
                continue
            names = [st.get("stage") for st in stages]
            if names != expect["stages"]:
                self.fail("T23", f"{label}: stages {names} != expected {expect['stages']}")
            self.scenario_graph(label, spec["parameters"], stages)

    def scenario_graph(self, label: str, params: dict, stages: list[dict]) -> None:
        by_name = {st.get("stage"): st for st in stages}
        if len(by_name) != len(stages):
            self.fail("T23", f"{label}: duplicate stage names")
        deps: dict[str, list[str]] = {}
        for st in stages:
            d = st.get("dependsOn", [])
            deps[st["stage"]] = [d] if isinstance(d, str) else [x for x in (d or [])]
            for x in deps[st["stage"]]:
                if x not in by_name:
                    self.fail("T23", f"{label}: stage {st['stage']} depends on missing stage {x}")
        seen: dict[str, int] = {}
        def visit(n: str) -> bool:
            if seen.get(n) == 1:
                return False
            if seen.get(n) == 2:
                return True
            seen[n] = 1
            ok = all(visit(x) for x in deps.get(n, []) if x in by_name)
            seen[n] = 2
            return ok
        if not all(visit(n) for n in by_name):
            self.fail("T23", f"{label}: the stage graph has a cycle")
        root = "source" if params.get("action", "deliver") == "redeploy" else "verify"
        if root not in by_name or deps.get(root) not in ([], None):
            self.fail("T23", f"{label}: stage {root} must exist and depend on nothing")
        redeploy = root == "source"
        target = params.get("targetEnvironment", "none")
        for st in stages:
            for job in self.jobs_of(st):
                name = job.get("deployment") or job.get("job")
                if not (str(st.get("stage")).startswith("deploy_") and job.get("deployment") == "release") \
                        and mentions_report(self.job_steps(job)):
                    self.fail("T30", f"{label}: {st.get('stage')}/{name} must not report deploy events (deployment job `release` only)")
        cond = lambda st: " ".join(str(st.get("condition", "")).split())
        slug = params["app"]["slug"]
        for env in params["environments"]:
            e, kind, src = env["name"], env["kind"], env.get("promoteFrom", "")
            deploy = by_name.get(f"deploy_{e}")
            preview = by_name.get(f"preview_{e}")
            if redeploy and e != target:
                if deploy is not None or preview is not None:
                    self.fail("T23", f"{label}: a redeploy to {target} must not have stages for {e}")
                continue
            if deploy is None:
                self.fail("T23", f"{label}: no stage deploy_{e}")
                continue
            if deploy.get("lockBehavior") != "runLatest":
                self.fail("T20", f"{label}: deploy_{e} must set lockBehavior runLatest")
            needs_preview = src != "" and kind == "prod"
            if needs_preview and preview is None:
                self.fail("T23", f"{label}: prod environment {e} needs a preview stage")
            if not needs_preview and preview is not None:
                self.fail("T23", f"{label}: {e} must not have a preview stage (prod promotion environments only)")
            if redeploy:
                want_deploy = {"source"} | ({f"preview_{e}"} if needs_preview else set())
                want_preview, want_cond_deploy, want_cond_preview = {"source"}, REDEPLOY_CONDITION, REDEPLOY_CONDITION
            elif src == "":
                want_deploy, want_preview = {"verify"}, set()
                want_cond_deploy = want_cond_preview = DEPLOY_CONDITION
            else:
                want_deploy = {"verify", f"deploy_{src}"} | ({f"preview_{e}"} if needs_preview else set())
                want_preview = {"verify", f"deploy_{src}"}
                want_cond_deploy = want_cond_preview = PROMOTE_CONDITION
            if set(deps[f"deploy_{e}"]) != want_deploy:
                self.fail("T23", f"{label}: deploy_{e} must depend on {sorted(want_deploy)} (got {deps[f'deploy_{e}']})")
            if cond(deploy) != want_cond_deploy:
                self.fail("T20", f"{label}: deploy_{e} must use the condition {want_cond_deploy}")
            if preview is not None and needs_preview:
                if set(deps[f"preview_{e}"]) != want_preview:
                    self.fail("T23", f"{label}: preview_{e} must depend on {sorted(want_preview)}")
                if cond(preview) != want_cond_preview:
                    self.fail("T20", f"{label}: preview_{e} must use the condition {want_cond_preview}")
                self.scenario_preview(label, slug, e, src, preview, params)
            self.scenario_deploy(label, slug, e, kind, src, deploy, params)
            self.scenario_report(label, slug, e, deploy)
            self.scenario_retain(label, e, kind, deploy, params)
        if redeploy and "source" in by_name:
            self.scenario_source(label, params, by_name["source"])

    @staticmethod
    def stage_steps(stage: dict) -> tuple[list[dict], list[dict]]:
        jobs = [j for j in stage.get("jobs") or [] if isinstance(j, dict)]
        steps: list[dict] = []
        for job in jobs:
            s = Checker.job_steps(job)
            steps.extend(x for x in (s or []) if isinstance(x, dict))
        return jobs, steps

    @staticmethod
    def downloads(steps: list[dict]) -> set[str]:
        return {str((st.get("inputs") or {}).get("artifactName")) for st in steps
                if st.get("task") == "DownloadPipelineArtifact@2"}

    def azure_cli(self, label: str, rule: str, stage: dict, steps: list[dict], slug: str, env: str, script: str) -> tuple[int, dict]:
        # The deploy-event step (T30) is checked on its own.
        cli = [(i, st) for i, st in enumerate(steps) if str(st.get("task", "")).startswith("AzureCLI") and not is_report_step(st)]
        if len(cli) != 1:
            self.fail(rule, f"{label}: {stage.get('stage')} must have exactly one AzureCLI@2 step")
            return -1, {}
        i, st = cli[0]
        inputs, envmap = st.get("inputs") or {}, st.get("env") or {}
        if inputs.get("azureSubscription") != f"sc-{slug}-{env}" or envmap.get("SAF_SERVICE_CONNECTION") != f"sc-{slug}-{env}":
            self.fail(rule, f"{label}: {stage.get('stage')} must use the service connection sc-{slug}-{env}")
        if inputs.get("scriptPath") != f"{CORE_SCRIPTS}scripts/{script}":
            self.fail(rule, f"{label}: {stage.get('stage')} must run {CORE_SCRIPTS}scripts/{script} (the core checkout)")
        if inputs.get("useGlobalConfig") != "false":
            self.fail(rule, f"{label}: {stage.get('stage')} must set useGlobalConfig: false (the login stays in the step)")
        if envmap.get("SAF_ENV_NAME") != env:
            self.fail(rule, f"{label}: {stage.get('stage')} must pass SAF_ENV_NAME {env}")
        return i, envmap

    def scenario_preview(self, label: str, slug: str, env: str, src: str, stage: dict, params: dict) -> None:
        jobs, steps = self.stage_steps(stage)
        if len(jobs) != 1 or jobs[0].get("job") != "preview" or "deployment" in jobs[0] or "environment" in jobs[0]:
            self.fail("T24", f"{label}: preview_{env} must have exactly one normal job `preview` without an environment")
        _, envmap = self.azure_cli(label, "T24", stage, steps, slug, env, "preview.sh")
        if envmap and envmap.get("SAF_PROMOTE_FROM") != src:
            self.fail("T24", f"{label}: preview_{env} must pass SAF_PROMOTE_FROM {src}")
        if envmap and envmap.get("SAF_ACTION") != params.get("action", "deliver"):
            self.fail("T24", f"{label}: preview_{env} must pass SAF_ACTION {params.get('action', 'deliver')}")
        if not {"release-manifest", "scan"} <= self.downloads(steps):
            self.fail("T24", f"{label}: preview_{env} must download release-manifest and scan")

    def scenario_deploy(self, label: str, slug: str, env: str, kind: str, src: str, stage: dict, params: dict) -> None:
        jobs = [j for j in stage.get("jobs") or [] if isinstance(j, dict)]
        names = [j.get("deployment") or j.get("job") for j in jobs]
        release = [j for j in jobs if j.get("deployment") == "release"]
        if names != ["release", "retain"] or len(release) != 1 or release[0].get("environment") != f"{slug}-{env}":
            self.fail("T25", f"{label}: deploy_{env} must have the deployment job `release` on {slug}-{env}, then job `retain` (got {names})")
            if not release:
                return
        steps = [x for x in (self.job_steps(release[0]) or []) if isinstance(x, dict)]
        index, envmap = self.azure_cli(label, "T25", stage, steps, slug, env, "deploy.sh")
        action = params.get("action", "deliver")
        if envmap and envmap.get("SAF_ACTION") != action:
            self.fail("T25", f"{label}: deploy_{env} must pass SAF_ACTION {action}")
        got = self.downloads(steps)
        if src == "":
            if envmap.get("SAF_PROMOTE_FROM") not in (None, ""):
                self.fail("T25", f"{label}: deploy_{env} (build) must not set SAF_PROMOTE_FROM")
            want = {"release-manifest", "image"} if action == "deliver" else {"release-manifest"}
            if got != want:
                self.fail("T25", f"{label}: deploy_{env} (build, {action}) must download exactly {sorted(want)} (got {sorted(got)})")
            return
        if envmap.get("SAF_PROMOTE_FROM") != src:
            self.fail("T25", f"{label}: deploy_{env} must pass SAF_PROMOTE_FROM {src}")
        if not {"release-manifest", f"release-result-{src}"} <= got or "image" in got:
            self.fail("T25", f"{label}: deploy_{env} must download release-manifest and release-result-{src}, never image")
        if kind == "prod":
            gate = [i for i, st in enumerate(steps) if "scripts/gate.sh" in str(st.get("bash", ""))]
            if "scan" not in got or not gate or index < 0 or min(gate) > index:
                self.fail("T25", f"{label}: deploy_{env} (prod) must download scan and run scripts/gate.sh before AzureCLI")

    def scenario_report(self, label: str, slug: str, env: str, stage: dict) -> None:
        release = [j for j in stage.get("jobs") or [] if isinstance(j, dict) and j.get("deployment") == "release"]
        if len(release) != 1:
            return  # T25 reports it
        steps = [x for x in (self.job_steps(release[0]) or []) if isinstance(x, dict)]
        reports = [st for st in steps if mentions_report(st)]
        where = f"{label}: deploy_{env}/release"
        if len(reports) != 1 or not is_report_step(reports[0]) or steps[-1] is not reports[0]:
            self.fail("T30", f"{where} must end with exactly one deploy-event step (AzureCLI@2, scripts/report.sh)")
            return
        st = reports[0]
        inputs, envmap = st.get("inputs") or {}, st.get("env") or {}
        sc = f"sc-{slug}-{env}"
        deploy = [x for x in steps if str((x.get("inputs") or {}).get("scriptPath", "")).endswith("/scripts/deploy.sh")]
        if inputs.get("azureSubscription") != sc or envmap.get("SAF_SERVICE_CONNECTION") != sc \
                or any((d.get("inputs") or {}).get("azureSubscription") != sc for d in deploy):
            self.fail("T30", f"{where}: the deploy event must use the job's own service connection {sc}")
        if set(envmap) != REPORT_ENV or envmap.get("SAF_SLUG") != slug or envmap.get("SAF_ENV_NAME") != env \
                or envmap.get("SAF_JOB_STATUS") != "$(Agent.JobStatus)":
            self.fail("T30", f"{where}: the deploy event's env must be exactly {sorted(REPORT_ENV)} "
                             f"(SAF_JOB_STATUS = $(Agent.JobStatus)); got {sorted(envmap)}")
        if " ".join(str(st.get("condition", "")).split()) != REPORT_CONDITION:
            self.fail("T30", f"{where}: the deploy event must run with condition {REPORT_CONDITION}")
        if st.get("continueOnError") != "true":
            self.fail("T30", f"{where}: the deploy event must set continueOnError: true (it never fails the job)")
        timeout = str(st.get("timeoutInMinutes", ""))
        if not timeout.isdigit() or not 1 <= int(timeout) <= 10:
            self.fail("T30", f"{where}: the deploy event needs timeoutInMinutes 1-10")
        if st.get("target") != {"commands": "restricted"}:
            self.fail("T30", f"{where}: the deploy event must run with target commands: restricted only")
        if inputs.get("scriptLocation") != "scriptPath" or inputs.get("addSpnToEnvironment") != "false" \
                or any(k in inputs for k in ("inlineScript", "arguments", "scriptArguments")):
            self.fail("T30", f"{where}: the deploy event runs scripts/report.sh by path, without arguments or SPN variables")
        if inputs.get("useGlobalConfig") != "false":
            self.fail("T30", f"{where}: the deploy event must set useGlobalConfig: false (the login stays in the step)")
        if re.search(r"system\.accesstoken|system_accesstoken|oidc", json.dumps(st), re.IGNORECASE):
            self.fail("T30", f"{where}: the deploy event must not use the job token or the pipeline OIDC token")

    def scenario_retain(self, label: str, env: str, kind: str, stage: dict, params: dict) -> None:
        jobs = [j for j in stage.get("jobs") or [] if isinstance(j, dict) and j.get("job") == "retain"]
        if len(jobs) != 1:
            self.fail("T28", f"{label}: deploy_{env} must have one job `retain`")
            return
        job = jobs[0]
        if job.get("dependsOn") != "release" or job.get("condition") != "succeeded()" or "environment" in job:
            self.fail("T28", f"{label}: retain in deploy_{env} must depend on release with condition succeeded() and no environment")
        steps = [x for x in (self.job_steps(job) or []) if isinstance(x, dict)]
        for st in steps:
            task = str(st.get("task", ""))
            if task.startswith("AzureCLI") or "azureSubscription" in (st.get("inputs") or {}):
                self.fail("T28", f"{label}: retain in deploy_{env} must not use a service connection")
            if "download" in st or task.startswith("DownloadPipelineArtifact"):
                self.fail("T28", f"{label}: retain in deploy_{env} must not download artifacts")
            if st.get("checkout") == "app":
                self.fail("T28", f"{label}: retain in deploy_{env} must not check out the app")
        lease = [st for st in steps if "scripts/retain.sh" in str(st.get("bash", ""))]
        if len(lease) != 1:
            self.fail("T28", f"{label}: retain in deploy_{env} must run scripts/retain.sh once")
            return
        envmap = lease[0].get("env") or {}
        run = to_str(params.get("sourceRunId")) if params.get("action") == "redeploy" else "$(Build.BuildId)"
        days = "365" if kind == "prod" else "90"
        if to_str(envmap.get("SAF_RETAIN_RUN_ID")) != run or to_str(envmap.get("SAF_RETAIN_DAYS")) != days \
                or envmap.get("SAF_ENV_NAME") != env:
            self.fail("T28", f"{label}: retain in deploy_{env} must lease run {run} for {days} days "
                             f"(got {envmap.get('SAF_RETAIN_RUN_ID')}, {envmap.get('SAF_RETAIN_DAYS')})")

    def scenario_source(self, label: str, params: dict, stage: dict) -> None:
        target = next(e for e in params["environments"] if e["name"] == params["targetEnvironment"])
        src, kind, run = target.get("promoteFrom", ""), target["kind"], to_str(params["sourceRunId"])
        jobs = [j for j in stage.get("jobs") or [] if isinstance(j, dict)]
        if [j.get("job") for j in jobs] != ["resolve"] or any("environment" in j or "deployment" in j for j in jobs):
            self.fail("T29", f"{label}: stage source must have exactly one normal job `resolve` without an environment")
            return
        steps = [x for x in (self.job_steps(jobs[0]) or []) if isinstance(x, dict)]
        scripts = " ".join(str(st.get("bash", "")) for st in steps)
        for sub in ("validate", "verify", "check"):
            if f"scripts/source-run.sh\" {sub}" not in scripts:
                self.fail("T29", f"{label}: stage source must run source-run.sh {sub}")
        for st in steps:
            task = str(st.get("task", ""))
            if task.startswith("AzureCLI") or "azureSubscription" in (st.get("inputs") or {}):
                self.fail("T29", f"{label}: stage source must not use a service connection")
            if st.get("checkout") == "app":
                self.fail("T29", f"{label}: stage source must not check out the app")
        downloads = [st.get("inputs") or {} for st in steps if st.get("task") == "DownloadPipelineArtifact@2"]
        want = {"release-manifest"} | ({f"release-result-{src}"} if src else set()) | ({"scan"} if kind == "prod" else set())
        if {d.get("artifactName") for d in downloads} != want:
            self.fail("T29", f"{label}: stage source must download exactly {sorted(want)} from run {run}")
        for d in downloads:
            if d.get("buildType") != "specific" or d.get("buildVersionToDownload") != "specific" \
                    or to_str(d.get("pipelineId")) != run or d.get("definition") != "$(System.DefinitionId)" \
                    or d.get("project") != "$(System.TeamProjectId)":
                self.fail("T29", f"{label}: stage source downloads must name run {run} of this pipeline (buildType specific)")
        published = {(st.get("inputs") or {}).get("artifact") for st in steps if st.get("task") == "PublishPipelineArtifact@1"}
        if published != want:
            self.fail("T29", f"{label}: stage source must republish exactly {sorted(want)}")

    def t27_token(self, stages: list[tuple[str, dict]]) -> None:
        for rel, st in stages:
            for job in self.jobs_of(st):
                jname = job.get("job") or job.get("deployment")
                allowed = (rel == "templates/stages/source.yml" and jname == "resolve") or jname == "retain"
                for srel, step in self.steps_of(self.job_steps(job), rel):
                    if re.search(r"system\.accesstoken|system_accesstoken", json.dumps(step), re.IGNORECASE) and not allowed:
                        self.fail("T27", f"{srel}: job {jname} must not map System.AccessToken (only source.resolve and retain)")

    def t29_specific_downloads(self) -> None:
        for rel, doc in self.docs.items():
            for key, value in walk(doc):
                if key == "buildType" and value != "current" and rel != "templates/stages/source.yml":
                    self.fail("T29", f"{rel}: DownloadPipelineArtifact buildType {value} only in stage source")

    def t31_capacity(self) -> None:
        for rel in self.docs:
            if re.search(r"\bcapacity\b", strip_comments(self.repo.files.get(rel, ""))):
                self.fail("T31", f"{rel}: the capacity reservation is data for release-inputs (SAF_ENVIRONMENTS_JSON), never a template expression")
        code = strip_comments(self.repo.files.get("scripts/release-manifest.sh", ""))
        warns = [l.strip() for l in logical_lines(code) if re.search(r"\bsaf_warn\b", l)]
        if not warns or any(not re.fullmatch(r'saf_warn "[^"$`\\]*"', w) for w in warns):
            self.fail("T31", f"scripts/release-manifest.sh: the capacity warning is `saf_warn` with fixed text (no $, backtick or backslash); got {warns}")
        body = shell_functions(strip_comments(self.repo.files.get("scripts/lib.sh", ""))).get("saf_warn", "")
        if [l.strip() for l in body.splitlines() if l.strip()] != ["printf '##vso[task.logissue type=warning]%s\\n' \"$*\""]:
            self.fail("T31", "scripts/lib.sh: saf_warn must print exactly one `##vso[task.logissue type=warning]%s` line")

    def t30_report(self, all_steps: list) -> None:
        # Templates: the step lives in deployment-finish.yml only, as its last, unconditional step.
        for srel, st, job, step in all_steps:
            if mentions_report(step) and (srel != REPORT_TEMPLATE or not is_report_step(step) or "deployment" not in job):
                self.fail("T30", f"{srel}: scripts/report.sh runs only in the deployment jobs, from {REPORT_TEMPLATE}, "
                                 f"as AzureCLI@2 with scriptPath {CORE_SCRIPTS}{REPORT_SCRIPT}")
        for rel, doc in {**self.docs, **self.pdocs, **self.vdocs}.items():
            if rel != REPORT_TEMPLATE and REPORT_SCRIPT in strip_comments(self.repo.files.get(rel, "")):
                self.fail("T30", f"{rel}: only {REPORT_TEMPLATE} may run {REPORT_SCRIPT}")
        finish = self.docs.get(REPORT_TEMPLATE)
        if not isinstance(finish, dict):
            self.fail("T30", f"{REPORT_TEMPLATE} must be reachable")
        else:
            params = [(p.get("name"), p.get("type")) for p in finish.get("parameters") or [] if isinstance(p, dict)]
            if params != [("app", "object"), ("environment", "object")]:
                self.fail("T30", f"{REPORT_TEMPLATE}: parameters must be exactly app and environment (objects); got {params}")
            raw = finish.get("steps")
            last = raw[-1] if isinstance(raw, list) and raw else None
            if not isinstance(last, dict) or not is_report_step(last):
                self.fail("T30", f"{REPORT_TEMPLATE}: the deploy-event step must be the last step, outside any ${{{{ if }}}}")
        # Script.
        text = self.repo.files.get(REPORT_SCRIPT)
        if text is None:
            self.fail("T30", f"{REPORT_SCRIPT} is missing")
            return
        code = strip_comments(text)
        if not re.search(r"^trap report_exit EXIT$", code, re.M):
            self.fail("T30", f"{REPORT_SCRIPT}: must set `trap report_exit EXIT` (always exit 0)")
        body = shell_functions(code).get("report_exit", "")
        if [l.strip() for l in body.splitlines() if l.strip()][-1:] != ["exit 0"]:
            self.fail("T30", f"{REPORT_SCRIPT}: report_exit() must end with `exit 0`")
        if re.search(r"\bsaf_die\b", code) or any(x != "0" for x in re.findall(r"\bexit\b[ \t]*([^\s;)]*)", code)):
            self.fail("T30", f"{REPORT_SCRIPT}: no saf_die and no exit other than `exit 0`: the deploy event never fails the job")
        if re.search(r"oidc", code, re.IGNORECASE) or XTRACE.search(code):
            self.fail("T30", f"{REPORT_SCRIPT}: no pipeline OIDC token and no xtrace")
        for name, other in self.repo.files.items():
            if name.endswith(".sh") and not name.startswith(PROV_SCRIPTS) and name != REPORT_SCRIPT \
                    and "get-access-token" in strip_comments(other):
                self.fail("T30", f"{name}: get-access-token only in {REPORT_SCRIPT} (delivery scripts)")
        gets = [l for l in logical_lines(code) if "get-access-token" in l]
        if len(gets) != 1 or '--scope "api://$client_id/.default"' not in gets[0] or not re.match(r"^\s*if ! token=\"\$\(az account get-access-token ", gets[0]):
            self.fail("T30", f"{REPORT_SCRIPT}: exactly one `token=$(az account get-access-token --scope \"api://$client_id/.default\" ...)`")
        exports = [l.strip() for l in logical_lines(code)
                   if re.search(r"\b(export|declare\s+-[A-Za-z]*x|typeset\s+-[A-Za-z]*x|readonly\s+-[A-Za-z]*x)\b.*\btoken\b", l, re.IGNORECASE)
                   or re.search(r"\bset\s+(-[A-Za-z]*a\b|-o\s+allexport\b)|\bset\s+-o\s+allexport", l)]
        if exports:
            self.fail("T30", f"{REPORT_SCRIPT}: the token must never be exported to child processes; got {exports}")
        uses = [l.strip() for l in logical_lines(code) if re.search(r"\$\{?token\b", l) and "get-access-token" not in l]
        if uses != REPORT_TOKEN_LINES:
            self.fail("T30", f"{REPORT_SCRIPT}: the token may only be checked, masked and then written to the header file; got {uses}")
        if REPORT_URL not in code or REPORT_BODY not in code:
            self.fail("T30", f"{REPORT_SCRIPT}: URL and body must be the contract's (deploy-events, runId/attempt/result)")

    def t26_import_mode(self) -> None:
        code = strip_comments(self.repo.files.get("scripts/deploy.sh", ""))
        def body(fn: str) -> str | None:
            m = re.search(rf"^{fn}\(\)\s*\{{\n(.*?)^\}}", code, re.M | re.S)
            return m.group(1) if m else None
        imp, push = body("publish_import"), body("publish_push")
        if imp is None or push is None:
            self.fail("T26", "deploy.sh must define publish_push() and publish_import()")
            return
        if not re.search(r"\baz\s+acr\s+import\b", imp):
            self.fail("T26", "publish_import() must use az acr import")
        if re.search(r"\boras\s+(cp|copy|push)\b|\bdocker\s+push\b", imp):
            self.fail("T26", "publish_import() must never push (oras cp/push, docker push)")
        redo = body("publish_redeploy")
        if redo is None or re.search(r"\boras\s+(cp|copy|push)\b|\bdocker\s+push\b|\bpublish_push\b", redo):
            self.fail("T26", "deploy.sh must define publish_redeploy(), which never pushes")
        outside = code.replace(push, "")
        if re.search(r"\boras\s+(cp|copy|push)\b|\bdocker\s+push\b", outside):
            self.fail("T26", "oras cp/push is only allowed inside publish_push()")
        guard = code.find("saf_newer_run_deployed")
        calls = [m.start() for m in re.finditer(r"^\s+publish_(push|import|redeploy)\s*$", code, re.M)]
        publish = min(calls, default=-1)
        lib = strip_comments(self.repo.files.get("scripts/release-lib.sh", ""))
        if guard < 0 or publish < 0 or guard > publish or "skipped-newer-deployed" not in code \
                or "saf-run-id" not in lib:
            self.fail("T26", "deploy.sh must run the newer-run guard (saf-run-id, skipped-newer-deployed) before publishing")

    # =============================================================================================
    # Provisioning templates (app-provisioning.yml, ADR-0032): rules P01-P19, plus the generic
    # T rules that apply to any template tree (T01, T03-T05, T08-T10, T13, T16-T18).
    # =============================================================================================
    def run_provisioning(self) -> None:
        entry = self.pdocs.get(PROV_ENTRY)
        if not isinstance(entry, dict):
            self.fail("P01", f"{PROV_ENTRY} did not load")
            return
        stages = self.stages(self.pdocs)
        all_jobs = [(rel, st, job) for rel, st in stages for job in self.jobs_of(st)]
        all_steps = [(srel, st, job, step) for rel, st, job in all_jobs
                     for srel, step in self.steps_of(self.job_steps(job), rel)]
        # Generic rules over the provisioning tree.
        self.t03_param_types(self.pdocs)
        self.t04_t16_t17_t20_stages(stages, self.pdocs)
        self.t08_t09_t10_steps(all_steps)
        self.t10_anywhere(self.pdocs)
        self.t11_deployments(all_jobs)
        self.t18_checkouts(all_steps)
        # Provisioning rules.
        self.p01_entry(entry)
        self.p02_guards()
        self.p03_connections(all_jobs)
        self.p04_token()
        self.p05_variables(all_jobs)
        self.p06_deployments()
        self.p07_targets(all_steps)
        self.p08_jobs(all_jobs)
        self.p09_checkouts(all_steps)
        self.p10_locks(stages)
        self.p11_tools()
        self.p12_loop()
        self.p13_p14_scenarios()
        self.p15_neutralise()
        self.p16_entra_scripts()
        self.p17_secret(all_steps)
        self.p18_dbinit()
        self.p19_rotation()
        self.p20_front_door()
        self.p21_portal_endpoints()
        self.p22_parallel_scope()
        self.p23_job_image()
        self.p24_reconcile()
        self.p25_plan_scripts()
        self.p26_script_mutations()
        self.p27_decommission()
        self.p28_mode_change()

    def prov_scripts(self) -> dict[str, str]:
        return {n: t for n, t in self.repo.files.items() if n.startswith(PROV_SCRIPTS) and n.endswith(".sh")}

    # -- P28: the move of a network mode change only through the plan (ADR-0060) -------------------
    def p28_mode_change(self) -> None:
        post_name = PROV_SCRIPTS + "azure-post.sh"
        for base, func, text in MOVE_EXCEPTIONS:
            body = logical_lines(shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + base, ""))).get(func, ""))
            if not any(l.strip().startswith(text) for l in body):
                self.fail("P28", f"{base}: {func}() no longer has `{text[:70]}`; update MOVE_EXCEPTIONS")
        for base, func, guard, call in MOVE_DISPATCH:
            lines = logical_lines(shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + base, ""))).get(func, ""))
            g = [i for i, l in enumerate(lines) if re.search(guard, l)]
            c = [i for i, l in enumerate(lines) if re.search(call, l)]
            if not g or not c or any(not any(x < y for x in g) for y in c):
                self.fail("P28", f"{base} {func}(): /{call}/ runs only after the plan's check /{guard}/ (ADR-0060)")
        post = strip_comments(self.repo.files.get(post_name, ""))
        fns = shell_functions(post)
        top = post
        for b in fns.values():
            top = top.replace(b, "")
        for target, allowed in MOVE_CALLERS.items():
            callers = sorted({f for f, b in fns.items() if f != target and re.search(rf"(^|[\s;(]){target}(\s|;|$)", b, re.M)})
            if re.search(rf"(^|[\s;(]){target}(\s|;|$)", top, re.M):
                callers.append("<top>")
            if target not in fns or callers != [allowed]:
                self.fail("P28", f"azure-post.sh: {target}() is defined and called only from {allowed}() (got {callers})")
            for name, code in self.prov_scripts().items():
                if name != post_name and re.search(rf"(^|[\s;(]){target}(\s|;|$)", strip_comments(code), re.M):
                    self.fail("P28", f"{name}: {target}() belongs to azure-post.sh")
        # In move_step: every precondition (prov_wait) before the first destructive call; the Joiner and
        # the app's delete only in the full phase, the Joiner's first.
        step = logical_lines(fns.get("move_step", ""))
        at = lambda rx: [i for i, l in enumerate(step) if re.search(rx, l)]  # noqa: E731
        waits = at(r"^\s*prov_wait ")
        destructive = at(r"^\s*(move_joiner_delete|move_app_delete|move_endpoints|move_secret_role|prov_lz) ")
        joiner, delete, full = at(r"^\s*move_joiner_delete "), at(r"^\s*move_app_delete "), at(r'^\s*if \[ "\$phase" = full \]; then$')
        if not waits or not destructive or max(waits) > min(destructive):
            self.fail("P28", "azure-post.sh move_step(): every precondition (prov_wait) comes before the first delete or deployment")
        # Kind prod outside the maintenance window (product owner, 2026-11-14): the plan's waitsForWindow
        # makes the step wait before anything else.
        window = at(r'^\s*window="\$\(prov_mode_change "\$slug" "\$env_name" waitsForWindow\)"$')
        test = at(r'^\s*if \[ -n "\$window" \]; then$')
        if len(window) != 1 or len(test) != 1 or not window[0] < test[0] \
                or not any(re.match(r"^\s*prov_wait ", l) for l in step[test[0] + 1:test[0] + 3]) \
                or (destructive and test[0] > min(destructive)):
            self.fail("P28", "azure-post.sh move_step(): the plan's waitsForWindow (kind prod outside the maintenance window) "
                             "makes it wait (prov_wait) before the first delete or deployment")
        if len(joiner) != 1 or len(delete) != 1 or not joiner[0] < delete[0] or not full \
                or not any(f < joiner[0] and not any(re.match(r"^\s*fi$", l) for l in step[f:delete[0]]) for f in full):
            self.fail("P28", "azure-post.sh move_step(): the Joiner's delete, then the app's delete, both inside "
                             "`if [ \"$phase\" = full ]; then` (the app runs in its source CAE)")

    # -- P27: decommissioning only through the plan's action (ADR-0056) --------------------------
    def p27_decommission(self) -> None:
        for base, func, text in DECOMMISSION_EXCEPTIONS:
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + base, ""))
            body = logical_lines(shell_functions(code).get(func, ""))
            if not any(l.strip().startswith(text) for l in body):
                self.fail("P27", f"{base}: {func}() no longer has `{text[:70]}`; remove its DECOMMISSION_EXCEPTIONS entry")
        for base, func, guard, call in DECOMMISSION_DISPATCH:
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + base, ""))
            fns = shell_functions(code)
            if func == "<top>":
                top = code
                for b in fns.values():
                    top = top.replace(b, "")
                lines = logical_lines(top)
            else:
                lines = logical_lines(fns.get(func, ""))
            lines = [l for l in lines if not re.match(r"^\s*\w+\(\)\s*\{", l)]
            g = [i for i, l in enumerate(lines) if re.search(guard, l)]
            c = [i for i, l in enumerate(lines) if re.search(call, l)]
            if not g or not c or any(not any(x <= y for x in g) for y in c):
                self.fail("P27", f"{base} {func}(): /{call}/ runs only after the plan's action check /{guard}/ (ADR-0056)")
            # The decommission functions are called nowhere else.
            target = re.sub(r"[^a-z_]", "", call.split("\\b")[1]) if "\\b" in call else ""
            if target and target in fns:
                callers = [f for f, b in fns.items() if f != target and re.search(rf"(^|[\s;(]){target}(\s|;|$)", b, re.M)]
                top = code
                for b in fns.values():
                    top = top.replace(b, "")
                if func == "<top>":
                    callers += ["<top>"] if re.search(rf"(^|[\s;(]){target}(\s|;|$)", top, re.M) else []
                if sorted(set(callers)) != [func]:
                    self.fail("P27", f"{base}: {target}() is called only from {func}() (got {sorted(set(callers))})")
        for (base, target), allowed in DECOMMISSION_CALLERS.items():
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + base, ""))
            fns = shell_functions(code)
            top = code
            for b in fns.values():
                top = top.replace(b, "")
            call = rf"(^|[\s;(]){target}(\s|;|$)"
            callers = sorted({f for f, b in fns.items() if f != target and re.search(call, b, re.M)})
            if re.search(call, top, re.M):
                callers.append("<top>")
            if target not in fns or callers != [allowed]:
                self.fail("P27", f"{base}: {target}() is defined and called only from {allowed}() (got {callers})")
            for name, text in self.prov_scripts().items():
                if name != PROV_SCRIPTS + base and re.search(call, strip_comments(text), re.M):
                    self.fail("P27", f"{name}: {target}() belongs to {base}")

    # -- P26: the script mutation allow-list (ADR-0052) ------------------------------------------
    def p26_script_mutations(self) -> None:
        found: dict[tuple[str, str, str], str] = {}
        for name, text in sorted(self.repo.files.items()):
            if name.startswith("scripts/") and name.endswith(".sh"):
                for func, cmd, line in script_mutations(text):
                    found.setdefault((name, func, cmd), line.strip())
        for (name, func, cmd), line in found.items():
            if (name, func, cmd) not in SCRIPT_MUTATIONS:
                self.fail("P26", f"{name}: `{cmd}` in {func}() is not on the mutation allow-list (SCRIPT_MUTATIONS: target, "
                                 f"scope, reason, and for a shared scope its guards): {line[:100]!r}")
        bodies: dict[str, dict[str, list[str]]] = {}
        for key, entry in SCRIPT_MUTATIONS.items():
            name, func, cmd = key
            if key not in found:
                self.fail("P26", f"allow-list entry {name} {func}() `{cmd}` matches no call any more: remove it")
            if not entry.target.strip() or not entry.reason.strip() or entry.scope not in MUTATION_SCOPES:
                self.fail("P26", f"allow-list entry {name} {func}() `{cmd}` needs a target, a reason and a scope of {sorted(MUTATION_SCOPES)}")
            if entry.scope == "shared" and not entry.guards:
                self.fail("P26", f"allow-list entry {name} {func}() `{cmd}` writes in a shared scope: it needs its guard predicate")
            for g in entry.guards:
                if g.file not in bodies:
                    code = strip_comments(self.repo.files.get(g.file, ""))
                    fns = {f: logical_lines(b) for f, b in shell_functions(code).items()}
                    top = code
                    for b in shell_functions(code).values():
                        top = top.replace(b, "")
                    fns["<top>"] = logical_lines(top)
                    bodies[g.file] = fns
                lines = bodies[g.file].get(g.function)
                if lines is None:
                    self.fail("P26", f"{g.file}: {g.function}() is gone; the guard of `{cmd}` ({name} {func}()) can't hold")
                    continue
                before = [i for i, l in enumerate(lines) if re.search(g.before, l)]
                if not g.call:
                    if not before:
                        self.fail("P26", f"{g.file} {g.function}(): the guard of `{cmd}` ({name} {func}()) is missing: /{g.before}/")
                    continue
                calls = [i for i, l in enumerate(lines) if re.search(g.call, l)]
                if not calls:
                    self.fail("P26", f"{g.file} {g.function}(): no call /{g.call}/ to guard for `{cmd}` ({name} {func}())")
                for c in calls:
                    if not any(b < c for b in before):
                        self.fail("P26", f"{g.file} {g.function}(): /{g.call}/ runs without its guard /{g.before}/ before it "
                                         f"(`{cmd}`, ADR-0052)")

    def p01_entry(self, entry: dict) -> None:
        params = entry.get("parameters")
        got = [{k: v for k, v in p.items() if k != "displayName"} for p in params or [] if isinstance(p, dict)]
        if not isinstance(params, list) or got != PROV_ENTRY_PARAMS or len(params) != len(PROV_ENTRY_PARAMS):
            self.fail("P01", f"{PROV_ENTRY}: parameters must be exactly [environments: object, hostEnvironment: string, "
                             f"scope: string with values changed|all, upgrade: string], no defaults (got {got})")
        for key in ("variables", "resources", "trigger", "pr", "pool", "schedules", "jobs", "steps", "extends", "lockBehavior"):
            if key in entry:
                self.fail("P01", f"{PROV_ENTRY}: no root `{key}` in the entry point")

    def p02_guards(self) -> None:
        text = "\n".join(l for l in self.repo.files.get(PROV_ENTRY, "").splitlines() if not l.lstrip().startswith("#"))
        for guard in PROV_GUARDS:
            if guard not in text:
                self.fail("P02", f"{PROV_ENTRY}: compile-time guard missing: {guard!r}")

    def prov_connection_formats(self) -> tuple[str | None, str | None, str | None]:
        """(sc-platform-provisioning-{env}, sc-platform-ado, sc-platform-entra) from naming.bicep."""
        naming = self.repo.files.get("@naming.bicep", "")
        m = re.search(r"func provisioningServiceConnection\(env string\) string =>[^\n]*'(sc-[^']*)'", naming)
        prov_fmt = m.group(1).replace("${e(env)}", "{env}") if m else None
        m = re.search(r"func instanceServiceConnection\(purpose string\) string =>(.*?)\n\n", naming, re.S)
        purpose_fmt = {}
        for purpose in ("ado", "entra"):
            purpose_fmt[purpose] = None
            if m and re.search(rf"\[[^\]]*'{purpose}'[^\]]*\]", m.group(1)):
                lit = re.search(r"'(sc-[^']*\$\{purpose\}[^']*)'", m.group(1))
                purpose_fmt[purpose] = lit.group(1).replace("${purpose}", purpose) if lit else None
        return prov_fmt, purpose_fmt["ado"], purpose_fmt["entra"]

    def p03_connections(self, all_jobs: list) -> None:
        prov_fmt, ado_fmt, entra_fmt = self.prov_connection_formats()
        if prov_fmt is None:
            self.fail("P03", "naming.bicep has no provisioningServiceConnection(env) with a literal name")
        if ado_fmt is None:
            self.fail("P03", "naming.bicep has no instanceServiceConnection(purpose) accepting 'ado'")
        if entra_fmt is None:
            self.fail("P03", "naming.bicep has no instanceServiceConnection(purpose) accepting 'entra'")
        norm = lambda s: re.sub(r"\$\{\{\s*parameters\.hostEnvironment\s*\}\}", "{host}",
                                re.sub(r"\$\{\{\s*(parameters\.environment|env)\.name\s*\}\}", "{env}", str(s)))
        expected = {
            PLAN_TEMPLATE: {prov_fmt},
            "templates/provisioning/stages/azure.yml": {prov_fmt},
            "templates/provisioning/stages/azure-post.yml": {prov_fmt},
            RECORD_TEMPLATE: {prov_fmt},
            REGISTRY_TEMPLATE: {prov_fmt},
            ENTRA_PLAN_TEMPLATE: {prov_fmt.replace("{env}", "{host}") if prov_fmt else None},
            ENTRA_TEMPLATE: {entra_fmt},
            "templates/provisioning/stages/ado.yml": {ado_fmt},
        }
        for rel, st, job in all_jobs:
            jname = job.get("job") or job.get("deployment")
            conns: set[str] = set()
            for srel, step in self.steps_of(self.job_steps(job), rel):
                inputs = step.get("inputs") if isinstance(step.get("inputs"), dict) else {}
                for k, v in inputs.items():
                    if k.lower() in SC_INPUTS:
                        conns.add(norm(v))
                envmap = step.get("env") if isinstance(step.get("env"), dict) else {}
                if "azureSubscription" in inputs and norm(envmap.get("SAF_SERVICE_CONNECTION")) != norm(inputs["azureSubscription"]):
                    self.fail("P03", f"{srel}: job {jname}: SAF_SERVICE_CONNECTION must equal the step's azureSubscription")
            if len(conns) > 1:
                self.fail("P03", f"{rel}: job {jname} uses more than one service connection {sorted(conns)}")
            want = expected.get(rel, set())
            # Stage plan: the plan_<env> jobs read with their environment's connection, decide with the
            # host's (its own read, then the Entra comparison; ADR-0050).
            if rel == PLAN_TEMPLATE and jname == "decide":
                want = {prov_fmt.replace("{env}", "{host}") if prov_fmt else None}
            if conns and conns != want:
                self.fail("P03", f"{rel}: job {jname} may only use {sorted(x for x in want if x) or 'no service connection'} (got {sorted(conns)})")
            if rel in expected and want and not conns:
                self.fail("P03", f"{rel}: job {jname} must run its script with the service connection {sorted(x for x in want if x)}")
        # The Entra connection (Microsoft Graph permissions) is named only where stage entra uses it.
        if entra_fmt:
            allowed = {ENTRA_TEMPLATE, PROV_SCRIPTS + "entra.sh"}
            for name, text in self.repo.files.items():
                if name.startswith("@") or name in allowed:
                    continue
                if name.endswith((".yml", ".yaml")):
                    doc, errors = load_yaml(text, name)
                    blob = text if errors or doc is None else json.dumps(doc)
                elif name.endswith(".sh"):
                    blob = strip_comments(text)
                else:
                    blob = text
                if entra_fmt in blob:
                    self.fail("P03", f"{name}: {entra_fmt} is used only by stage entra "
                                     f"({ENTRA_TEMPLATE}, {PROV_SCRIPTS}entra.sh)")

    def p04_token(self) -> None:
        blobs = [(rel, json.dumps(doc)) for rel, doc in self.pdocs.items()]
        blobs += list(self.prov_scripts().items())
        for name, text in blobs:
            if re.search(r"system\.accesstoken|system_accesstoken", strip_comments(text) if name.endswith(".sh") else text, re.IGNORECASE):
                self.fail("P04", f"{name}: provisioning never uses System.AccessToken")
        lib = strip_comments(self.repo.files.get(PROV_SCRIPTS + "prov-lib.sh", ""))
        body = re.search(r"^prov_ado_token\(\)\s*\{\n(.*?)^\}", lib, re.M | re.S)
        if not body:
            self.fail("P04", "prov-lib.sh must define prov_ado_token()")
            return
        code = body.group(1)
        get = code.find(f"az account get-access-token --resource {ADO_RESOURCE}")
        secret = code.find("##vso[task.setsecret]$token")
        export = code.find("AZURE_DEVOPS_TOKEN=")
        if get < 0 or secret < 0 or export < 0 or not get < secret < export:
            self.fail("P04", "prov_ado_token() must get the token for Azure DevOps with az account get-access-token, "
                             "mask it with task.setsecret, then set AZURE_DEVOPS_TOKEN")
        for name, text in self.prov_scripts().items():
            code = strip_comments(text)
            if name != PROV_SCRIPTS + "prov-lib.sh" and re.search(r"AZURE_DEVOPS_TOKEN=|get-access-token", code):
                self.fail("P04", f"{name}: the ADO token is obtained only by prov_ado_token()")
        # prov-lib.sh: one ADO token call (prov_ado_token); the Graph and ARM tokens of the Easy Auth
        # secret step only in prov_secret_tokens (P17).
        bodies = shell_functions(lib)
        ado = bodies.get("prov_ado_token", "").count("get-access-token")
        secret = bodies.get("prov_secret_tokens", "").count("get-access-token")
        arm = bodies.get("prov_arm_token", "").count("get-access-token")
        graph = bodies.get("prov_graph_token", "").count("get-access-token")
        if ado != 1 or arm != 1 or graph != 1 or lib.count("get-access-token") != ado + secret + arm + graph:
            self.fail("P04", "prov-lib.sh: get-access-token only in prov_ado_token() (exactly once), "
                             "prov_secret_tokens(), prov_arm_token() and prov_graph_token() (exactly once each)")

    def p05_variables(self, all_jobs: list) -> None:
        validate = ("templates/provisioning/stages/validate.yml", "plan")
        seen = False
        for rel, st, job in all_jobs:
            key = (rel, job.get("job"))
            if key == validate:
                seen = True
                if job.get("variables") != VALIDATE_JOB_VARIABLES:
                    self.fail("P05", f"{rel}: job plan must map exactly {VALIDATE_JOB_VARIABLES}")
                continue
            # Elsewhere only the results of the jobs whose artifacts are optional (exactly which: P25).
            # A job may also add them through a `${{ if }}` key (checked expanded by P25).
            blocks = [job.get("variables")] + [v.get("variables") for k, v in job.items() if is_expr_key(k) and isinstance(v, dict)]
            for block in blocks:
                if block is None:
                    continue
                for v in flatten(block) if isinstance(block, list) else [block]:
                    if not (isinstance(v, dict) and set(v) == {"name", "value"} and RESULT_VARIABLE.fullmatch(str(v["name"]))
                            and RESULT_VALUE.fullmatch(str(v["value"]))):
                        self.fail("P05", f"{rel}: job {key[1]}: provisioning job variables are only saf.coreRef "
                                         "($[ resources.repositories.core.ref ]) of validate.plan and saf.result.<artifact> "
                                         "($[ stageDependencies.<stage>.<job>.result ]) elsewhere")
        if not seen:
            self.fail("P05", f"{validate[0]}: job plan must map exactly {VALIDATE_JOB_VARIABLES}")

    def p06_deployments(self) -> None:
        defs = {"prov_lz_param": "$SAF_CORE/infra/app/provisioning/landing-zone.bicepparam",
                "prov_release_param": "$SAF_CORE/infra/app/provisioning/release.bicepparam",
                "prov_entra_param": "$SAF_CORE/infra/entra/provisioning/app-registration.bicepparam",
                "prov_frontdoor_param": "$SAF_CORE/infra/app/provisioning/frontdoor.bicepparam",
                "prov_portal_endpoint_param": "$SAF_CORE/infra/app/provisioning/portal-endpoint.bicepparam"}
        # Kind (prov_arm's second argument) -> scope and parameter file.
        kinds = {"lz": ("sub", '"$prov_lz_param"'), "release": ("group", '"$prov_release_param"'),
                 "entra": ("group", '"$prov_entra_param"'), "frontdoor": ("group", '"$prov_frontdoor_param"'),
                 "portal-endpoint": ("group", '"$prov_portal_endpoint_param"')}
        lib_name = PROV_SCRIPTS + "prov-lib.sh"
        lib = strip_comments(self.repo.files.get(lib_name, ""))
        for var, path in defs.items():
            if f'{var}="{path}"' not in lib:
                self.fail("P06", f"prov-lib.sh must define {var}=\"{path}\"")
            assigned = sum(len(re.findall(rf"(^|[\s;(]){var}=", strip_comments(text), re.M))
                           for text in self.prov_scripts().values())
            if assigned != 1:
                self.fail("P06", f"{var} must be assigned exactly once, in prov-lib.sh (found {assigned})")
        body = re.search(r"^prov_arm\(\)\s*\{\n(.*?)^\}", lib, re.M | re.S)
        arm = body.group(1) if body else ""
        if not body:
            self.fail("P06", "prov-lib.sh must define prov_arm()")
        creates = {"sub": 0, "group": 0}
        for name, text in self.prov_scripts().items():
            code = strip_comments(text)
            outside = code.replace(arm, "") if name == lib_name and arm else code
            for line in logical_lines(code):
                m = re.search(r"\baz\s+deployment\s+(\S+)\s+(\S+)", line)
                if not m:
                    continue
                scope, action = m.group(1), m.group(2)
                if action in ("show", "list"):
                    continue
                # Reading a record's operations (the nested records of a decommissioned landing zone, PE010's
                # clean-up of prov_lz_stale_assignments): a read, never a write.
                if scope == "operation" and re.search(r"\baz\s+deployment\s+operation\s+(sub|group)\s+list\b", line):
                    continue
                # The one record provisioning deletes: fd-{slug}-{env} of a removed custom domain (P20).
                if (scope, action) == ("group", "delete") and name == PROV_SCRIPTS + "azure-post.sh" \
                        and line in logical_lines(shell_functions(code).get("front_door_cleanup", "")) \
                        and re.search(r'--name "\$\(jq -r \'\.deployment\' "\$plan"\)" --resource-group "\$\(jq -r \'\.resourceGroup\' "\$plan"\)"', line):
                    continue
                # ... and its nested records appRoute-*/dnsRecords-* (ADR-0052: deployment history), named
                # by the operations of that record, inside fd_nested_cleanup() only (P26 checks the guard).
                nested = logical_lines(shell_functions(code).get("fd_nested_cleanup", "")) if name == PROV_SCRIPTS + "azure-post.sh" else []
                if line in nested and (
                        ((scope, action) == ("group", "delete")
                         and 'az deployment group delete --name "$name" --resource-group "$nested_rg" --only-show-errors --output none' in line)
                        or ((scope, action) == ("operation", "group") and re.search(r"\baz deployment operation group list\b", line))):
                    continue
                # ... and the Entra record left in rg-{prefix}-entra after the registration's deployment into
                # its environment's records group (ADR-0063), inside retire_instance_record() only (P26
                # checks its guards: the app's own name and the group from names.bicep, after that deployment).
                if line in ENTRA_RETIRE_LINES(name, code) and (scope, action) == ("group", "delete") \
                        and ENTRA_RETIRE_DELETE in line:
                    continue
                if decommission_exception(name, code, line):
                    continue
                if scope not in ("sub", "group") or action not in ("validate", "create"):
                    self.fail("P06", f"{name}: `az deployment {scope} {action}` is not allowed (only sub|group validate|create)")
                    continue
                allowed = ['"$prov_lz_param"'] if scope == "sub" else ['"$prov_release_param"', '"$prov_entra_param"',
                                                                        '"$prov_frontdoor_param"', '"$prov_portal_endpoint_param"']
                params = re.findall(r"--parameters\s+(\S+)", line)
                if len(params) != 1 or params[0] not in allowed:
                    self.fail("P06", f"{name}: az deployment {scope} {action} must pass exactly one --parameters of "
                                     f"{allowed} (got {params})")
                if re.search(r"--template-(file|uri|spec)|\s-p\s|--parameter\s|\s-f\s|--query-string|--rollback-on-error|--what-if", line):
                    self.fail("P06", f"{name}: no template, extra parameters or what-if for az deployment")
                if action == "create":
                    creates[scope] += 1
            if any(re.search(r"\baz\s+deployment\s+\S+\s+(validate|create)\b", l) for l in logical_lines(outside)):
                self.fail("P06", f"{name}: deployments run only in prov-lib.sh prov_arm()")
        if creates != {"sub": 1, "group": 4}:
            self.fail("P06", "exactly one az deployment sub create and four group creates (release, entra, frontdoor, "
                             f"portal-endpoint) in the provisioning scripts (got {creates})")
        # prov_arm: one case arm per action and kind, each with its own scope and parameter file. The
        # Entra registration has no validate arm: its preflight calls Microsoft Graph (ADR-0033).
        arms = re.findall(r"^\s*(\w+)/([\w-]+)\)\n(.*?)^\s*;;", arm, re.M | re.S)
        want_arms = sorted([("create", k) for k in kinds] + [("validate", k) for k in kinds if k != "entra"])
        if sorted((a, k) for a, k, _ in arms) != want_arms:
            self.fail("P06", f"prov_arm() must have exactly the case arms {[f'{a}/{k}' for a, k in want_arms]} "
                             f"(got {sorted(f'{a}/{k}' for a, k, _ in arms)})")
        # The Entra plan: parameters from bicep build-params, template hash from ARM, in one function.
        expected = re.search(r"^prov_entra_expected\(\)\s*\{\n(.*?)^\}", lib, re.M | re.S)
        exp = expected.group(1) if expected else ""
        builds = [l for l in logical_lines(exp) if re.search(r"\baz\s+bicep\s+build-params\b", l)]
        if len(builds) != 1 or not re.search(r'--file\s+"\$prov_entra_param"(\s|$)', builds[0]) \
                or re.search(r"--outfile|--no-restore|\s-f\s", builds[0]):
            self.fail("P06", 'prov_entra_expected() must run exactly one `az bicep build-params --file "$prov_entra_param" --stdout`')
        hashes = [l for l in logical_lines(exp) if re.search(r"\baz\s+rest\b", l)]
        if len(hashes) != 1 or "/providers/Microsoft.Resources/calculateTemplateHash?" not in hashes[0] \
                or not re.search(r"--method\s+post\b", hashes[0]):
            self.fail("P06", "prov_entra_expected() must make exactly one az rest POST, to calculateTemplateHash")
        for name, text in self.prov_scripts().items():
            code = strip_comments(text)
            outside = code.replace(exp, "") if name == lib_name and exp else code
            if any(re.search(r"\baz\s+bicep\s+build-params\b", l) for l in logical_lines(outside)):
                self.fail("P06", f"{name}: az bicep build-params runs only in prov-lib.sh prov_entra_expected()")
        for action, kind, text in arms:
            calls = [re.search(r"\baz\s+deployment\s+(\S+)\s+(\S+).*?--parameters\s+(\S+)", l)
                     for l in logical_lines(text) if re.search(r"\baz\s+deployment\s", l)]
            scope, param = kinds.get(kind, (None, None))
            if len(calls) != 1 or calls[0] is None or (calls[0].group(1), calls[0].group(2), calls[0].group(3)) != (scope, action, param):
                self.fail("P06", f"prov_arm() {action}/{kind} must run exactly `az deployment {scope} {action}` "
                                 f"with --parameters {param}")
        # Deployment and resource names come from naming.bicep through names.bicep outputs.
        outputs = set(re.findall(r"^output\s+(\w+)\s", self.repo.files.get("@names.bicep", ""), re.M))
        for name, text in self.prov_scripts().items():
            for out in sorted(set(re.findall(r'prov_name\s+"\$\w+"\s+(\w+)', strip_comments(text)))):
                if out not in outputs:
                    self.fail("P06", f"{name}: infra/app/delivery/names.bicep has no output {out}")

    def p07_targets(self, all_steps: list) -> None:
        decides = 0
        plan_decides = 0
        plan_entra = 0
        for srel, st, job, step in all_steps:
            target = step.get("target")
            label = step.get("displayName") or step_kind(step)
            if not isinstance(target, dict) or "settableVariables" not in target:
                self.fail("P07", f"{srel}: step {label!r} must set target.settableVariables: none")
                continue
            if target.get("settableVariables") != "none":
                # The exceptions: entra_plan's `decide` sets its output entraNeeded (stage entra's condition)
                # and plan.decide's `decide` the outputs of the plan (the conditions of every later stage).
                if srel == ENTRA_PLAN_TEMPLATE and st.get("stage") == "entra_plan" and job.get("job") == "plan" \
                        and step.get("name") == "decide" and target.get("settableVariables") == ["entraNeeded"] \
                        and target.get("commands") == "restricted":
                    decides += 1
                    continue
                if srel == PLAN_TEMPLATE and st.get("stage") == "plan" and job.get("job") == "decide" \
                        and step.get("name") == "decide" and target.get("settableVariables") == PLAN_DECIDE_SETTABLE \
                        and target.get("commands") == "restricted":
                    plan_decides += 1
                    continue
                if srel == PLAN_TEMPLATE and st.get("stage") == "plan" and job.get("job") == "decide" \
                        and step.get("name") == "entraDecide" and target.get("settableVariables") == ["entraNeeded"] \
                        and target.get("commands") == "restricted":
                    plan_entra += 1
                    continue
                self.fail("P07", f"{srel}: step {label!r} must set target.settableVariables: none (only the steps "
                                 "decide of entra_plan.plan and entraDecide of plan.decide set [entraNeeded] and the step "
                                 "decide of plan.decide the plan's outputs, with commands: restricted)")
                continue
            if target.get("commands") == "restricted":
                continue
            fixed = " ".join(str(step.get("bash", "")).split())
            if not (job.get("job") == "report" and target.get("commands") == "any" and fixed == SUMMARY_UPLOAD):
                self.fail("P07", f"{srel}: step {label!r} must set target.commands: restricted "
                                 "(only the report job's fixed summary upload may use any)")
        if decides != 1:
            self.fail("P07", f"exactly one step `decide` of entra_plan.plan may set a variable, entraNeeded (found {decides})")
        if plan_decides != 1:
            self.fail("P07", f"exactly one step `decide` of plan.decide may set the plan's outputs {PLAN_DECIDE_SETTABLE} "
                             f"(found {plan_decides})")
        if plan_entra != 1:
            self.fail("P07", f"exactly one step `entraDecide` of plan.decide may set a variable, entraNeeded (found {plan_entra})")

    def p08_jobs(self, all_jobs: list) -> None:
        for rel, st, job in all_jobs:
            jname = job.get("job") or job.get("deployment")
            if "deployment" in job or "environment" in job or "job" not in job:
                self.fail("P08", f"{rel}: provisioning job {jname} must be a normal job without an environment "
                                 "(the checks sit on the service connections)")

    def p09_checkouts(self, all_steps: list) -> None:
        for srel, st, job, step in all_steps:
            if "checkout" in step and step.get("checkout") not in ("core", "self"):
                self.fail("P09", f"{srel}: provisioning checks out only core and self (got {step.get('checkout')!r})")

    def p10_locks(self, stages: list[tuple[str, dict]]) -> None:
        for rel, st in stages:
            uses = any("azureSubscription" in (step.get("inputs") or {})
                       for job in self.jobs_of(st) for _, step in self.steps_of(self.job_steps(job), rel))
            if uses and st.get("lockBehavior") != "runLatest":
                self.fail("P10", f"{rel}: stage {st.get('stage')} uses a service connection and must set lockBehavior: runLatest")
            if not uses and "lockBehavior" in st:
                self.fail("P10", f"{rel}: stage {st.get('stage')} has no service connection and no lock")

    @staticmethod
    def prov_scripts_run(steps: list[dict]) -> set[str]:
        """Names of the scripts/provisioning/*.sh a list of steps runs (scriptPath or bash)."""
        names: set[str] = set()
        for st in steps:
            for text in [str((st.get("inputs") or {}).get("scriptPath", ""))] + script_texts(st):
                names.update(re.findall(r"scripts/provisioning/([\w.-]+\.sh)", text))
        return names

    def p11_tools(self) -> None:
        for rel, doc in self.pdocs.items():
            for key, value in walk(doc):
                if key == "template" and isinstance(value, str) and value.endswith("install-tools.yml") \
                        and rel != "templates/provisioning/steps/setup.yml":
                    self.fail("P11", f"{rel}: provisioning installs tools only through steps/setup.yml")
        for rel, st in self.stages(self.pdocs):
            for job in self.jobs_of(st):
                runs = self.prov_scripts_run([s for _, s in self.steps_of(self.job_steps(job), rel)])
                for item in flatten(self.job_steps(job)):
                    if not isinstance(item, dict) or not str(item.get("template", "")).endswith("setup.yml"):
                        continue
                    tools = (item.get("parameters") or {}).get("tools")
                    if not isinstance(tools, list) or not set(tools) <= PROV_TOOLS:
                        self.fail("P11", f"{rel}: job {job.get('job')} may install only {sorted(PROV_TOOLS)} (got {tools})")
                    elif runs & set(PROV_BICEP_SCRIPTS) and "bicep" not in tools:
                        self.fail("P11", f"{rel}: job {job.get('job')} runs {sorted(runs & set(PROV_BICEP_SCRIPTS))}, "
                                         "which use Bicep, and must install the pinned bicep")
        for name, text in self.prov_scripts().items():
            base = name[len(PROV_SCRIPTS):]
            if base != "prov-lib.sh" and base not in PROV_BICEP_SCRIPTS and PROV_BICEP_USE.search(strip_comments(text)):
                self.fail("P11", f"{name} uses Bicep (prov_names, prov_arm, az deployment); add it to PROV_BICEP_SCRIPTS "
                                 "so its job installs the pinned bicep and it runs saf_bicep_pin_check")
        for name in PROV_BICEP_SCRIPTS:
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + name, ""))
            pin, loop = code.find("\nsaf_bicep_pin_check\n"), code.find("prov_run_app")
            if pin < 0 or loop < 0 or pin > loop:
                self.fail("P11", f"{name} must run saf_bicep_pin_check (pinned bicep for az) before the app loop")

    def p12_loop(self) -> None:
        lib = strip_comments(self.repo.files.get(PROV_SCRIPTS + "prov-lib.sh", ""))
        body = re.search(r"^prov_unit\(\)\s*\{\n(.*?)^\}", lib, re.M | re.S)
        if not body or not re.search(r"set \+e\n\s*\(\n\s*set -e\n\s*\"\$@\"\n\s*\)\n\s*rc=\$\?\n\s*set -e\n", body.group(1)):
            self.fail("P12", "prov_unit() must run the unit's command in a subshell with errexit on "
                             "(set +e; ( set -e; \"$@\" ); rc=$?; set -e)")
        runner = shell_functions(lib).get("prov_run_app", "")
        if len(re.findall(r"(^|[\s;(])prov_unit\s", runner)) != 2:
            self.fail("P12", "prov_run_app() runs every unit through prov_unit() (once in order, once in the background)")
        # `for <var> in "${<array>[@]}"; do ... done`, the `done` at the indentation of its `for`.
        loop_re = re.compile(r'([ \t]*)for (\w+) in "\$\{(\w+)\[@\]\}"; do\n(.*?)^\1done\n', re.M | re.S)
        call_re = re.compile(r"(^|[\s;])prov_run_app\s", re.M)
        for name, (var, array) in PROV_LOOP_SCRIPTS.items():
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + name, ""))
            loops = [m for m in (loop_re.match(code, s.start()) for s in re.finditer(r"^[ \t]*for ", code, re.M)) if m]
            # Every loop around a prov_run_app call: the app loop and any loop enclosing it (entra-plan.sh:
            # per environment). Loops that call no app (entra.sh: building the targets) may stop the script.
            around = [m for m in loops if call_re.search(m.group(4))]
            app = [m for m in around if (m.group(2), m.group(3)) == (var, array)]
            last = [l for l in code.splitlines() if l.strip()][-1:] or [""]
            if not app or last[0].strip() != "prov_finish":
                self.fail("P12", f"{name}: the app loop (for {var} in \"${{{array}[@]}}\") must call prov_run_app per app "
                                 "and the script must end with prov_finish")
                continue
            calls = [c.start() for c in call_re.finditer(code)]
            if any(not any(m.start(4) <= c < m.end(4) for m in app) for c in calls):
                self.fail("P12", f"{name}: prov_run_app is called only inside the app loop")
            for m in around:
                if re.search(r"(^|[\s;])(exit|saf_die|return)\b", m.group(4)):
                    self.fail("P12", f"{name}: nothing in the app loop (for {m.group(2)} in ${{{m.group(3)}[@]}}) may stop "
                                     "it (exit, saf_die, return); failures stay inside prov_run_app")

    def p15_neutralise(self) -> None:
        for name, text in self.prov_scripts().items():
            for line in logical_lines(strip_comments(text)):
                reads_log = re.search(r'(<\s*|(?<!\$\()\b(cat|tail|head)\b[^|;&)]*\s)"[^"]*(\.(err|log)|\$\{?(err|log)\}?)"', line)
                if reads_log and "saf_neutralise" not in line:
                    self.fail("P15", f"{name}: Azure or tool output (.err/.log) is printed only through saf_neutralise")
                if re.search(r"(^|[;|&]\s*)cat\s", line.strip()) and "$(cat" not in line:
                    self.fail("P15", f"{name}: no raw `cat` to the log; print through the CLI or saf_neutralise")
                if re.search(r"\.problems", line) and "saf_neutralise" not in line:
                    self.fail("P15", f"{name}: app.yaml problems are printed only through saf_neutralise")

    # -- expanded provisioning scenarios -----------------------------------------------------
    def p13_p14_scenarios(self) -> None:
        scenarios = {n: t for n, t in self.repo.files.items() if n.startswith("@prov-scenarios/")}
        if not scenarios:
            self.fail("P13", "no scenarios in tests/scenarios/provisioning/")
        for name, text in sorted(scenarios.items()):
            spec = json.loads(text)
            label = "provisioning/" + name.split("/", 1)[1]
            stages, errors = Expander(self.repo).pipeline(spec["parameters"], PROV_ENTRY)
            expect = spec["expect"]
            if "errors" in expect:
                for want in expect["errors"]:
                    if not any(want in e for e in errors):
                        self.fail("P13", f"{label}: expected the compile error {want!r}; got {errors or 'none'}")
                continue
            if errors:
                self.fail("P13", f"{label}: unexpected compile errors {errors}")
                continue
            names = [st.get("stage") for st in stages]
            if names != expect["stages"]:
                self.fail("P13", f"{label}: stages {names} != expected {expect['stages']}")
            self.prov_graph(label, spec["parameters"], stages)

    def prov_graph(self, label: str, params: dict, stages: list[dict]) -> None:
        envs, host = params["environments"], to_str(params.get("hostEnvironment"))
        by_name = {st.get("stage"): st for st in stages}
        if len(by_name) != len(stages):
            self.fail("P13", f"{label}: duplicate stage names")
        deps = {st["stage"]: set([st["dependsOn"]] if isinstance(st.get("dependsOn"), str) else st.get("dependsOn") or [])
                for st in stages}
        names = [e["name"] for e in envs]
        src = {e["name"]: e.get("promoteFrom", "") for e in envs}
        vp = {"validate", "plan"}
        want = {"validate": set(), "plan": {"validate"}}
        for e in names:
            want[f"azure_{e}"] = vp | ({f"azure_{src[e]}"} if src[e] else set())
        want["ado_resources"] = vp | {f"azure_{e}" for e in names}
        want["entra_plan"] = vp | {f"azure_{e}" for e in names}
        want["entra"] = {"validate", "plan", "entra_plan"}
        for e in names:
            want[f"azure_post_{e}"] = vp | {f"azure_{e}", "ado_resources", "entra_plan", "entra"} | \
                ({f"azure_post_{src[e]}"} if src[e] else set()) | ({f"azure_{x}" for x in names} if e == host else set())
        want["ado_pipelines"] = vp | {"ado_resources"} | {f"azure_post_{e}" for e in names}
        # The registry image purge of each build environment, after its releases (ADR-0059).
        builds = [e for e in names if not src[e]]
        for e in builds:
            want[f"registry_{e}"] = vp | {f"azure_post_{e}"}
        want["report"] = set(want) - {"report"}
        for e in names:
            want[f"record_{e}"] = set(want["report"])
        # The condition of each stage: its output of plan.decide (ADR-0048), entra entra_plan's.
        outputs = {"ado_resources": "ado", "ado_pipelines": "ado", "entra_plan": "entraPlan"}
        for e in names:
            outputs.update({f"azure_{e}": f"lz_{e}", f"azure_post_{e}": f"post_{e}", f"record_{e}": f"record_{e}"})
        for e in builds:
            outputs[f"registry_{e}"] = f"registry_{e}"
        for stage, need in want.items():
            if stage not in by_name:
                self.fail("P13", f"{label}: no stage {stage}")
                continue
            if deps[stage] != need:
                self.fail("P13", f"{label}: {stage} must depend on {sorted(need)} (got {sorted(deps[stage])})")
            st = by_name[stage]
            cond = " ".join(str(st.get("condition", "")).split())
            want_cond = ENTRA_CONDITION if stage == "entra" else \
                PLAN_OUTPUT_CONDITION.format(o=outputs[stage]) if stage in outputs else PROV_CONDITION
            if stage != "validate" and cond != want_cond:
                self.fail("P13", f"{label}: {stage} must use the condition {want_cond}")
            uses_sc = stage not in ("validate", "report")
            if uses_sc != (st.get("lockBehavior") == "runLatest"):
                self.fail("P10", f"{label}: {stage}: lockBehavior runLatest exactly on the stages with a service connection")
        # Order: a stage appears after everything it depends on.
        pos = {st.get("stage"): i for i, st in enumerate(stages)}
        for stage, need in deps.items():
            if any(pos.get(d, len(stages)) > pos[stage] for d in need):
                self.fail("P13", f"{label}: {stage} is listed before a stage it depends on")
        markers = marker_jobs(names)
        pe = lambda xs: {f"plan_{x}" for x in xs}  # noqa: E731
        for e in names:
            self.prov_stage_jobs(label, by_name.get(f"azure_{e}"), f"sc-platform-provisioning-{e}", "azure.sh",
                                 {"plan", "units"} | pe([e]), {f"azure_{src[e]}"} if src[e] else set(), f"azure_{e}",
                                 {"SAF_ENV_NAME": e, "SAF_PROMOTE_FROM": src[e]}, markers)
            others = [x for x in names if x != e] if e == host else []
            self.prov_stage_jobs(label, by_name.get(f"azure_post_{e}"), f"sc-platform-provisioning-{e}", "azure-post.sh",
                                 {"plan", "units"} | pe([e] + others),
                                 {f"azure_{e}", "ado", "entra_plan", "entra"} | ({f"azure_post_{src[e]}"} if src[e] else set())
                                 # The portal host: every environment's landing zones (P21).
                                 | {f"azure_{x}" for x in others},
                                 f"azure_post_{e}", {"SAF_ENV_NAME": e, "SAF_PROMOTE_FROM": src[e]}, markers)
        self.prov_stage_jobs(label, by_name.get("ado_resources"), "sc-platform-ado", "ado.sh",
                             {"plan", "units"} | pe(names), {f"azure_{e}" for e in names}, "ado", {"SAF_ADO_PHASE": "resources"}, markers)
        self.prov_stage_jobs(label, by_name.get("entra_plan"), f"sc-platform-provisioning-{host}", "entra-plan.sh",
                             {"plan", "units"} | pe(names), {f"azure_{e}" for e in names}, "entra_plan",
                             {"SAF_ENV_NAME": host, "SAF_ENTRA_PHASE": "landing"}, markers)
        self.prov_stage_jobs(label, by_name.get("entra"), "sc-platform-entra", "entra.sh",
                             {"plan", "units"}, {"entra_plan"}, "entra", {"SAF_ENV_NAME": host}, markers)
        self.prov_stage_jobs(label, by_name.get("ado_pipelines"), "sc-platform-ado", "ado.sh",
                             {"plan", "units", "ado"}, {f"azure_post_{e}" for e in names}, "ado_pipelines",
                             {"SAF_ADO_PHASE": "pipelines"}, markers)
        self.prov_stage_jobs(label, by_name.get("validate"), None, "validate.sh", set(), set(), "plan", {}, markers)
        for e in names:
            self.prov_stage_jobs(label, by_name.get(f"record_{e}"), f"sc-platform-provisioning-{e}", "record.sh",
                                 {"plan", "units"},
                                 {f"azure_{e}", "ado", "entra_plan", "entra", f"azure_post_{e}", "ado_pipelines"}
                                 | ({f"azure_post_{host}"} if e != host else set()),
                                 None, {"SAF_ENV_NAME": e, "SAF_PROMOTE_FROM": src[e]}, markers)
        for e in builds:
            self.prov_stage_jobs(label, by_name.get(f"registry_{e}"), f"sc-platform-provisioning-{e}", "registry.sh",
                                 {"plan", "units"}, set(), f"registry_{e}", {"SAF_ENV_NAME": e, "SAF_PROMOTE_FROM": ""}, markers)
        for e in names:
            if src[e] and f"registry_{e}" in by_name:
                self.fail("P13", f"{label}: registry_{e}: a promotion environment holds promoted images only and is never purged (ADR-0059)")
        self.prov_stage_jobs(label, by_name.get("report"), None, "report.sh", {"plan", "units"} | pe(names),
                             {"ado", "entra_plan", "entra", "ado_pipelines"}
                             | {f"azure_{e}" for e in names} | {f"azure_post_{e}" for e in names}
                             | {f"registry_{e}" for e in builds},
                             "report", {}, markers)
        self.p25_plan_stage(label, by_name.get("plan"), envs, host, markers)
        self.p16_entra_stages(label, host, by_name)

    def prov_stage_jobs(self, label: str, stage: dict | None, conn: str | None, script: str,
                        downloads: set[str], optional: set[str], artifact: str | None, envs: dict[str, str],
                        markers: dict[str, str]) -> None:
        if stage is None:
            return
        name = stage.get("stage")
        jobs, steps = self.stage_steps(stage)
        if len(jobs) != 1 or "job" not in jobs[0]:
            self.fail("P14", f"{label}: {name} must have exactly one normal job")
            return
        conns = {str(v) for st in steps for k, v in (st.get("inputs") or {}).items() if k.lower() in SC_INPUTS}
        if conns != ({conn} if conn else set()):
            self.fail("P14", f"{label}: {name} must use {conn or 'no service connection'} (got {sorted(conns)})")
        runner = [st for st in steps if str((st.get("inputs") or {}).get("scriptPath", "")).endswith(f"/scripts/provisioning/{script}")
                  or f"scripts/provisioning/{script}\"" in str(st.get("bash", ""))]
        if len(runner) != 1:
            self.fail("P14", f"{label}: {name} must run scripts/provisioning/{script} exactly once")
        else:
            st = runner[0]
            if conn and (st.get("task") != "AzureCLI@2" or (st.get("inputs") or {}).get("azureSubscription") != conn
                         or (st.get("inputs") or {}).get("scriptPath") != f"{CORE_SCRIPTS}scripts/provisioning/{script}"):
                self.fail("P14", f"{label}: {name} must run {CORE_SCRIPTS}scripts/provisioning/{script} (the core checkout) with AzureCLI@2 and {conn}")
            envmap = st.get("env") or {}
            for k, v in envs.items():
                if to_str(envmap.get(k)) != v:
                    self.fail("P14", f"{label}: {name} must pass {k}={v!r} (got {envmap.get(k)!r})")
        self.prov_job_artifacts(label, stage, jobs[0], steps, downloads, optional, artifact, markers.get(name))

    def prov_job_artifacts(self, label: str, stage: dict, job: dict, steps: list[dict], downloads: set[str],
                           optional: set[str], artifact: str | None, marker_artifact: str | None,
                           also: str | None = None) -> None:
        """P14 downloads, publish, marker and the CLI of one expanded job; P25 its conditional downloads."""
        name = job.get("job") if stage.get("stage") == "plan" else stage.get("stage")
        if self.downloads(steps) != downloads | optional:
            self.fail("P14", f"{label}: {name} must download exactly {sorted(downloads | optional)} (got {sorted(self.downloads(steps))})")
        for st in steps:
            if st.get("task") != "DownloadPipelineArtifact@2":
                continue
            if (st.get("inputs") or {}).get("buildType") != "current":
                self.fail("P14", f"{label}: {name} downloads only from this run")
            a = str((st.get("inputs") or {}).get("artifactName"))
            cond = " ".join(str(st.get("condition", "")).split())
            if a in optional:
                if cond != OPTIONAL_DOWNLOAD_CONDITION.format(a=a):
                    self.fail("P25", f"{label}: {name} must download {a} with the condition {OPTIONAL_DOWNLOAD_CONDITION.format(a=a)}")
            elif "condition" in st:
                self.fail("P25", f"{label}: {name}: {a} is always there when {name} runs, so its download is unconditional (got {cond!r})")
        # P25: the job maps exactly the results its conditional downloads read, and the stage depends on them.
        want_vars = []
        for a in sorted(optional):
            sj = artifact_job(a)
            if sj is None:
                self.fail("P25", f"{label}: {name}: {a} is not the artifact of a stage that may be skipped")
                continue
            want_vars.append({"name": f"saf.result.{a}", "value": f"$[ stageDependencies.{sj[0]}.{sj[1]}.result ]"})
            deps = stage.get("dependsOn")
            deps = [deps] if isinstance(deps, str) else deps or []
            if stage.get("stage") != "plan" and sj[0] not in deps:
                self.fail("P25", f"{label}: {name} downloads {a} only when {sj[0]} ran, so it must depend on {sj[0]} directly")
        got_vars = sorted((v for v in flatten(job.get("variables") or []) if isinstance(v, dict) and str(v.get("name", "")).startswith("saf.result.")),
                          key=lambda v: str(v.get("name")))
        if got_vars != sorted(want_vars, key=lambda v: v["name"]):
            self.fail("P25", f"{label}: {name} must map exactly {[v['name'] for v in want_vars]} to their jobs' results "
                             f"(got {[(v.get('name'), v.get('value')) for v in got_vars]})")
        # The platform CLI: built by validate, installed from this run's artifact `plan` everywhere else.
        texts = " ".join(" ".join(script_texts(st)) for st in steps)
        builds = "npm run build" in texts
        installs = "cli.tgz" in texts and "tar -xzf" in texts
        if (name == "validate") != builds or (name != "validate") != installs:
            self.fail("P14", f"{label}: {name}: only validate builds the platform CLI; every other job installs it from this run's "
                             "artifact plan (steps/setup.yml cli)")
        published = [st for st in steps if st.get("task") == "PublishPipelineArtifact@1"]
        got = [(st.get("inputs") or {}).get("artifact") for st in published]
        want_pub = ({artifact} if artifact else set()) | ({also} if also else set())
        if sorted(str(x) for x in got) != sorted(want_pub):
            self.fail("P14", f"{label}: {name} must publish {sorted(want_pub) or 'nothing'} (got {sorted(str(x) for x in got if x)})")
        for st in published:
            a = (st.get("inputs") or {}).get("artifact")
            if (st.get("inputs") or {}).get("targetPath") != f"$(Pipeline.Workspace)/saf-out/{a}":
                self.fail("P14", f"{label}: {name} publishes $(Pipeline.Workspace)/saf-out/<artifact>")
        # Artifact folder created up front (steps/setup.yml `artifact`): every job whose artifact a later
        # job may read after it failed.
        marker = [i for i, st in enumerate(steps)
                  if "SAF_ARTIFACT" in (st.get("env") or {}) or "stage.json" in " ".join(script_texts(st))]
        if marker_artifact:
            st = steps[marker[0]] if len(marker) == 1 else {}
            if marker != [0] or " ".join(str(st.get("bash", "")).split()) != MARKER_SCRIPT \
                    or st.get("env") != {"SAF_ARTIFACT": marker_artifact, "SAF_ALSO_ARTIFACT": also or ""} or "condition" in st \
                    or st.get("target") != {"commands": "restricted", "settableVariables": "none"}:
                self.fail("P14", f"{label}: {name} must start with the fixed step of steps/setup.yml that creates "
                                 f"saf-out/{marker_artifact} with stage.json (artifact: {marker_artifact})")
        elif marker:
            self.fail("P14", f"{label}: only the jobs whose artifact a later job may read after a failure create their "
                             f"artifact folder up front; {name} publishes none or is validate")
        for st in published:
            # Statuses must survive a failed app (the stage then fails at its end); validate only on success.
            want = "succeeded()" if name == "validate" else "always()"
            if " ".join(str(st.get("condition", "succeeded()")).split()) != want:
                self.fail("P14", f"{label}: {name} must publish its artifact with condition {want}")

    # -- Stage plan (ADR-0048) ---------------------------------------------------------------
    def p25_plan_stage(self, label: str, stage: dict | None, envs: list[dict], host: str, markers: dict[str, str]) -> None:
        if stage is None:
            return
        names = [e["name"] for e in envs]
        others = [e for e in names if e != host]
        src = {e["name"]: e.get("promoteFrom", "") for e in envs}
        jobs = [j for j in stage.get("jobs") or [] if isinstance(j, dict)]
        if [j.get("job") for j in jobs] != [f"plan_{e}" for e in others] + ["decide"] \
                or any("deployment" in j or "environment" in j for j in jobs):
            self.fail("P25", f"{label}: plan must have exactly the normal jobs {[f'plan_{e}' for e in others] + ['decide']} "
                             f"(got {[j.get('job') or j.get('deployment') for j in jobs]})")
            return
        for job in jobs:
            steps = [x for x in self.job_steps(job) or [] if isinstance(x, dict)]
            jname = job["job"]
            conns = {str(v) for st in steps for k, v in (st.get("inputs") or {}).items() if k.lower() in SC_INPUTS}
            if jname == "decide":
                conn = f"sc-platform-provisioning-{host}"
                deps = job.get("dependsOn")
                deps = [deps] if isinstance(deps, str) else deps or []
                if conns != {conn} or sorted(deps) != sorted(f"plan_{e}" for e in others) \
                        or " ".join(str(job.get("condition", "")).split()) != "not(canceled())":
                    self.fail("P25", f"{label}: plan.decide uses only {conn} and runs after every other plan_<env> "
                                     "with condition not(canceled())")
                order = []
                for st in steps:
                    inputs, envmap = st.get("inputs") or {}, st.get("env") or {}
                    cond = " ".join(str(st.get("condition", "")).split())
                    if st.get("task") == "AzureCLI@2":
                        path = inputs.get("scriptPath")
                        env_ = {k: to_str(v) for k, v in envmap.items()}
                        if path == f"{CORE_SCRIPTS}scripts/provisioning/plan.sh" and inputs.get("azureSubscription") == conn \
                                and env_ == {"SAF_ENV_NAME": host, "SAF_PROMOTE_FROM": src[host], "SAF_SERVICE_CONNECTION": conn} \
                                and "condition" not in st:
                            order.append("read")
                        elif path == f"{CORE_SCRIPTS}scripts/provisioning/entra-plan.sh" and inputs.get("azureSubscription") == conn \
                                and env_.get("SAF_ENV_NAME") == host and env_.get("SAF_ENTRA_PHASE") == "plan" \
                                and env_.get("SAF_SERVICE_CONNECTION") == conn and set(env_) == {"SAF_ENV_NAME", "SAF_ENVIRONMENTS_JSON", "SAF_SERVICE_CONNECTION", "SAF_ENTRA_PHASE"} \
                                and cond == "succeededOrFailed()":
                            order.append("entra")
                        else:
                            order.append("other")
                    elif st.get("name") == "decide":
                        got = (st.get("target") or {}).get("settableVariables")
                        want = sorted(["ado", "entraPlan"] + [f"{o}_{e}" for e in names for o in ("lz", "post", "record")]
                                      + [f"registry_{e}" for e in names if not src[e]])
                        if "task" in st or cond != "succeededOrFailed()" \
                                or 'scripts/provisioning/decide.sh"' not in str(st.get("bash", "")) \
                                or set(envmap) != {"SAF_ENVIRONMENTS_JSON", "SAF_HOST_ENVIRONMENT"} \
                                or to_str(envmap.get("SAF_HOST_ENVIRONMENT")) != host \
                                or not isinstance(got, list) or sorted(got) != want:
                            self.fail("P25", f"{label}: plan.decide's step `decide` runs scripts/provisioning/decide.sh after its own "
                                             f"read (condition succeededOrFailed(), env SAF_ENVIRONMENTS_JSON and SAF_HOST_ENVIRONMENT) "
                                             f"and may set exactly {want} (got {got})")
                        order.append("decide")
                    elif st.get("name") == "entraDecide":
                        order.append("entraDecide")
                if [o for o in order if o != "other"] != ["read", "decide", "entra", "entraDecide"] or "other" in order:
                    self.fail("P25", f"{label}: plan.decide runs, in this order, plan.sh for {host} (AzureCLI@2, {conn}), the "
                                     "step decide, entra-plan.sh with SAF_ENTRA_PHASE plan (AzureCLI@2, condition "
                                     f"succeededOrFailed()) and the step entraDecide (got {order})")
                self.prov_job_artifacts(label, stage, job, steps, {"plan"} | {f"plan_{e}" for e in others}, set(), "units",
                                        markers.get("decide"), also=f"plan_{host}")
                continue
            env = jname[len("plan_"):]
            conn = f"sc-platform-provisioning-{env}"
            cli = [st for st in steps if st.get("task") == "AzureCLI@2"]
            st = cli[0] if len(cli) == 1 else {}
            inputs, envmap = st.get("inputs") or {}, st.get("env") or {}
            if conns != {conn} or len(cli) != 1 or inputs.get("azureSubscription") != conn \
                    or inputs.get("scriptPath") != f"{CORE_SCRIPTS}scripts/provisioning/plan.sh" \
                    or {k: to_str(v) for k, v in envmap.items()} != {"SAF_ENV_NAME": env, "SAF_PROMOTE_FROM": src[env], "SAF_SERVICE_CONNECTION": conn}:
                self.fail("P25", f"{label}: plan.{jname} runs {CORE_SCRIPTS}scripts/provisioning/plan.sh with AzureCLI@2 and "
                                 f"{conn} only, env exactly SAF_ENV_NAME, SAF_PROMOTE_FROM and SAF_SERVICE_CONNECTION")
            self.prov_job_artifacts(label, stage, job, steps, {"plan"}, set(), f"plan_{env}", markers.get(jname))

    def p25_plan_scripts(self) -> None:
        code = strip_comments(self.repo.files.get(PROV_SCRIPTS + "decide.sh", ""))
        commands = [l.strip() for l in code.splitlines() if "##vso[" in l]
        if commands != [DECIDE_SETVARIABLE] or f'[[ "$name" =~ {DECIDE_NAME_CHECK} ]]' not in code \
                or '[[ "$value" =~ ^(true|false)$ ]]' not in code or "names=(ado entraPlan)" not in code \
                or 'names+=("lz_$e" "post_$e" "record_$e")' not in code \
                or 'if [[ "$builds" == *" $e "* ]]; then names+=("registry_$e"); fi' not in code \
                or code.find(DECIDE_SETVARIABLE) < code.find('[[ "$value" =~ ^(true|false)$ ]]'):
            self.fail("P25", "decide.sh sets only the plan's outputs (ado, entraPlan, lz_/post_/record_<env>, registry_<build env>), true or false, "
                             f"with one setvariable line after every value is checked (got {commands})")
        if "provisioning plan-units" not in code:
            self.fail("P25", "decide.sh decides with `platform provisioning plan-units`")
        if not re.search(r'args=\(provisioning plan-units [^)]*--registry "\$out/registry\.json"\)', code):
            self.fail("P25", "decide.sh has plan-units write units/registry.json (--registry, ADR-0059) with the same time as the units")
        # The read model (ADR-0050): plan.sh reads lists, never one record or resource per app.
        plan = strip_comments(self.repo.files.get(PROV_SCRIPTS + "plan.sh", ""))
        per_app = sorted(f for f in PLAN_PER_APP if re.search(rf"\b{f}\b", plan))
        if per_app or "provisioning plan-facts" not in plan or "prov_run_app" in plan \
                or re.search(r"\baz\s+(deployment\s+(sub|group)\s+show|resource\s+show|keyvault|containerapp)\b", plan.replace('az deployment sub show --name "$name"', "")):
            self.fail("P25", "plan.sh reads the state of every app in lists and turns them into facts with `platform provisioning "
                             f"plan-facts`; no per-app read (got {per_app or 'a per-app az call'}); the only per-app reads are a "
                             "landing-zone record listed without parameters and the revisions of the apps lazy.json names")
        if plan.count("prov_arm_list ") < 5 or 'prov_arm_list "$id/revisions?api-version=$API_APPS"' not in plan:
            self.fail("P25", "plan.sh reads the ARM lists through prov_arm_list (paged, nextLink checked), the revisions only "
                             "for the apps plan-facts names")

    # -- Entra isolation (ADR-0033) ----------------------------------------------------------
    def p16_entra_stages(self, label: str, host: str, by_name: dict) -> None:
        entra_conn = self.prov_connection_formats()[2] or "sc-platform-entra"
        stage = by_name.get("entra")
        if stage is not None:
            jobs, steps = self.stage_steps(stage)
            if [j.get("job") for j in jobs] != ["registrations"] or any("environment" in j or "deployment" in j for j in jobs):
                self.fail("P16", f"{label}: entra must have exactly one normal job `registrations` without an environment")
            sc_steps = [st for st in steps if any(k.lower() in SC_INPUTS for k in (st.get("inputs") or {}))]
            cli = [st for st in sc_steps if st.get("task") == "AzureCLI@2"]
            if len(sc_steps) != 1 or len(cli) != 1 \
                    or (cli[0].get("inputs") or {}).get("azureSubscription") != entra_conn \
                    or (cli[0].get("inputs") or {}).get("scriptPath") != f"{CORE_SCRIPTS}scripts/provisioning/entra.sh" \
                    or (cli[0].get("env") or {}).get("SAF_SERVICE_CONNECTION") != entra_conn:
                self.fail("P16", f"{label}: entra's only service connection step is AzureCLI@2 with {entra_conn} "
                                 f"running {CORE_SCRIPTS}scripts/provisioning/entra.sh (the core checkout)")
            runs = self.prov_scripts_run(steps)
            if runs != {"entra.sh"}:
                self.fail("P16", f"{label}: entra runs scripts/provisioning/entra.sh only (got {sorted(runs)})")
            for st in steps:
                envmap = st.get("env") if isinstance(st.get("env"), dict) else {}
                blob = json.dumps(envmap)
                if re.search(r"system\.accesstoken|system_accesstoken|azure_devops|AZURE_DEVOPS", blob, re.IGNORECASE):
                    self.fail("P16", f"{label}: entra gets no Azure DevOps token (step {st.get('displayName')!r})")
        plan = by_name.get("entra_plan")
        if plan is not None:
            _, steps = self.stage_steps(plan)
            decide = [i for i, st in enumerate(steps) if st.get("name") == "decide"]
            cli = [i for i, st in enumerate(steps) if st.get("task") == "AzureCLI@2"]
            st = steps[decide[0]] if len(decide) == 1 else {}
            if len(decide) != 1 or len(cli) != 1 or decide[0] < cli[0] or "task" in st or "inputs" in st \
                    or "scripts/provisioning/entra-decide.sh\"" not in str(st.get("bash", "")) \
                    or " ".join(str(st.get("condition", "")).split()) != "always()" \
                    or (st.get("env") or {}) != {"SAF_ENTRA_PHASE": "landing"} \
                    or ((steps[cli[0]].get("env") or {}).get("SAF_ENTRA_PHASE")) != "landing":
                self.fail("P16", f"{label}: entra_plan's step `decide` runs scripts/provisioning/entra-decide.sh after "
                                 "the AzureCLI step with condition always(), both with SAF_ENTRA_PHASE landing")
        plan_stage = by_name.get("plan")
        if plan_stage is not None:
            jobs = [j for j in plan_stage.get("jobs") or [] if isinstance(j, dict) and j.get("job") == "decide"]
            steps = [x for x in self.job_steps(jobs[0]) or [] if isinstance(x, dict)] if len(jobs) == 1 else []
            ed = [i for i, st in enumerate(steps) if st.get("name") == "entraDecide"]
            ep = [i for i, st in enumerate(steps) if str((st.get("inputs") or {}).get("scriptPath", "")).endswith("/entra-plan.sh")]
            st = steps[ed[0]] if len(ed) == 1 else {}
            if len(ed) != 1 or len(ep) != 1 or ed[0] < ep[0] or "task" in st or "inputs" in st \
                    or "scripts/provisioning/entra-decide.sh\"" not in str(st.get("bash", "")) \
                    or " ".join(str(st.get("condition", "")).split()) != "always()" \
                    or (st.get("env") or {}) != {"SAF_ENTRA_PHASE": "plan"}:
                self.fail("P16", f"{label}: plan.decide's step `entraDecide` runs scripts/provisioning/entra-decide.sh after "
                                 "entra-plan.sh with condition always() and SAF_ENTRA_PHASE plan")

    def p16_entra_scripts(self) -> None:
        lib = strip_comments(self.repo.files.get(PROV_SCRIPTS + "prov-lib.sh", ""))
        bodies = shell_functions(lib)
        # prov_ado_token and every prov-lib.sh function that calls it, directly or not.
        token = {"prov_ado_token"}
        while True:
            more = {f for f, b in bodies.items() if f not in token and any(re.search(rf"\b{x}\b", b) for x in token)}
            if not more:
                break
            token |= more
        for name in ENTRA_SCRIPTS:
            code = strip_comments(self.repo.files.get(PROV_SCRIPTS + name, ""))
            if not code:
                self.fail("P16", f"{PROV_SCRIPTS}{name} is missing")
                continue
            used = sorted(f for f in token if re.search(rf"\b{f}\b", code))
            if used or re.search(r"AZURE_DEVOPS|SYSTEM_ACCESSTOKEN", code, re.IGNORECASE):
                self.fail("P16", f"{name}: the Entra stages never get an Azure DevOps token (uses {used or 'AZURE_DEVOPS_*'})")
        code = strip_comments(self.repo.files.get(PROV_SCRIPTS + "entra-decide.sh", ""))
        commands = [l.strip() for l in code.splitlines() if "##vso[" in l]
        values = set(re.findall(r"^\s*needed=(\S*)", code, re.M))
        if commands != ['echo "##vso[task.setvariable variable=entraNeeded;isOutput=true]$needed"'] \
                or not values or not values <= {"true", "false"}:
            self.fail("P16", "entra-decide.sh sets only the output entraNeeded, to true or false, and runs no other "
                             f"logging command (got {commands}, needed={sorted(values)})")


    # -- Easy Auth secret hand-off (ADR-0035) -------------------------------------------------
    def p17_secret(self, all_steps: list) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        entra_name = PROV_SCRIPTS + SECRET_SCRIPT
        lib_name = PROV_SCRIPTS + "prov-lib.sh"
        # Only entra.sh hands a secret to the kvset job; no template runs the command.
        for name, text in self.repo.files.items():
            if name.startswith("@") or name == entra_name:
                continue
            code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
            if "easyauth-secret" in code:
                self.fail("P17", f"{name}: `platform provisioning easyauth-secret` runs only in {entra_name}")
        entra = scripts.get(entra_name, "")
        lines = logical_lines(entra)
        calls = [i for i, l in enumerate(lines) if "easyauth-secret" in l]
        # Two calls (ADR-0060): the write or rotation in write_secret(), the follow-up's remove-old in
        # remove_old_secret() (with --app-vault, the vault the app runs with now, from the plan).
        fns = {f: logical_lines(b) for f, b in shell_functions(entra).items()}
        homes = {f: [l for l in body if "easyauth-secret" in l] for f, body in fns.items()}
        if len(calls) != 2 or any(not re.match(r"^\s*saf_cli provisioning easyauth-secret\s", lines[c]) for c in calls) \
                or [len(homes.get(f, [])) for f in SECRET_CALLS] != [1] * len(SECRET_CALLS):
            self.fail("P17", f"{entra_name}: exactly two `saf_cli provisioning easyauth-secret` calls, one in each of "
                             f"{sorted(SECRET_CALLS)} (got {len(calls)})")
        else:
            for c in calls:
                line = lines[c]
                func = next(f for f in SECRET_CALLS if line in homes[f])
                opts = re.findall(r"\s(--[\w-]+)", line)
                if sorted(opts) != sorted(SECRET_CALLS[func]) or re.search(r"token", line, re.IGNORECASE) \
                        or (func == "remove_old_secret") != ("--mode remove-old " in line):
                    self.fail("P17", f"{entra_name}: easyauth-secret in {func}() takes exactly {SECRET_CALLS[func]} and no token "
                                     f"(tokens reach it through the environment only; --mode remove-old only there; got {opts})")
                prev = lines[c - 1] if c > 0 else ""
                after = lines[c + 1] if c + 1 < len(lines) else ""
                if not re.fullmatch(r"\s*prov_secret_tokens\s*", prev) \
                        or not re.fullmatch(r"\s*unset SAF_GRAPH_TOKEN SAF_ARM_TOKEN\s*", after):
                    self.fail("P17", f"{entra_name}: prov_secret_tokens right before easyauth-secret and "
                                     "`unset SAF_GRAPH_TOKEN SAF_ARM_TOKEN` right after it")
        if len(re.findall(r"\bprov_secret_tokens\b", entra)) != len(SECRET_CALLS):
            self.fail("P17", f"{entra_name}: prov_secret_tokens is called exactly once per easyauth-secret call")
        lib = scripts.get(lib_name, "")
        bodies = shell_functions(lib)
        for name, code in scripts.items():
            if name == lib_name:
                code = "".join(b for f, b in bodies.items() if f != "prov_secret_tokens")
            if name != entra_name and re.search(r"\bprov_secret_tokens\b", code):
                self.fail("P17", f"{name}: prov_secret_tokens is called only by {entra_name}")
        # prov_secret_tokens(): az cloud show, then per token get -> setsecret -> store; $token nowhere else.
        body = bodies.get("prov_secret_tokens")
        if body is None:
            self.fail("P17", "prov-lib.sh must define prov_secret_tokens()")
        else:
            blines = logical_lines(body)
            if not any(re.search(r"\baz cloud show\b", l) for l in blines):
                self.fail("P17", "prov_secret_tokens() takes the Graph and ARM resources from `az cloud show`")
            pos = 0
            for res, var in SECRET_TOKENS.items():
                get = next((i for i, l in enumerate(blines) if i >= pos and re.fullmatch(
                    rf'\s*token="\$\(az account get-access-token --resource "\${res}" --query accessToken '
                    r'--output tsv --only-show-errors\)"', l)), -1)
                mask = next((i for i, l in enumerate(blines) if i > get >= 0
                             and l.strip() == 'echo "##vso[task.setsecret]$token"'), -1)
                store = next((i for i, l in enumerate(blines) if i > mask >= 0 and l.strip() == f'{var}="$token"'), -1)
                if get < 0 or not get < mask < store or any(re.search(r"\btoken=", l) for l in blines[get + 1:store]):
                    self.fail("P17", f"prov_secret_tokens() must get the {res} token with az account get-access-token "
                                     f'--resource "${res}", mask it with task.setsecret, then store it in {var}')
                pos = max(store, pos)
            allowed = ('echo "##vso[task.setsecret]$token"', '[ -n "$token" ] || saf_die ') + \
                tuple(f'{v}="$token"' for v in SECRET_TOKENS.values())
            for l in blines:
                if re.search(r"\$\{?token\b", l) and not any(l.strip() == a or (a.endswith(" ") and l.strip().startswith(a))
                                                             for a in allowed):
                    self.fail("P17", f"prov_secret_tokens(): the token goes only to task.setsecret and its variable "
                                     f"(got {l.strip()[:80]!r})")
        # The token variables: assigned only in prov_secret_tokens (and SAF_ARM_TOKEN in
        # prov_arm_token, P18, SAF_GRAPH_TOKEN in prov_graph_token, P24), never expanded, never in a
        # template.
        other = {"SAF_ARM_TOKEN": ("prov_arm_token", bodies.get("prov_arm_token", "")),
                 "SAF_GRAPH_TOKEN": ("prov_graph_token", bodies.get("prov_graph_token", ""))}
        for name, code in scripts.items():
            outside = code.replace(body, "") if name == lib_name and body else code
            for var in SECRET_TOKENS.values():
                fname, fbody = other[var]
                rest = outside.replace(fbody, "") if name == lib_name and fbody else outside
                if re.search(rf"(^|[\s;(]){var}=", rest, re.M):
                    self.fail("P17", f"{name}: {var} is set only by prov_secret_tokens() and {fname}()")
                if re.search(rf"\$(\{{[#!]?)?{var}\b", code):
                    self.fail("P17", f"{name}: {var} is never expanded (no argument, file or log)")
        for rel, doc in self.pdocs.items():
            if re.search(r"SAF_(GRAPH|ARM)_TOKEN", json.dumps(doc)):
                self.fail("P17", f"{rel}: templates never pass SAF_GRAPH_TOKEN or SAF_ARM_TOKEN")
        # prov-lib.sh refuses tracing and code injection through pipeline variables before anything
        # else: `set +x`, then prov_env_guard (exactly ENV_GUARD, printenv, exit 1), then lib.sh.
        lib = scripts.get(lib_name, "")
        guard = shell_functions(lib).get("prov_env_guard", "")
        listed = re.search(r"\bfor\s+v\s+in\s+([A-Z0-9_ ]+);", guard)
        if not guard or not listed or set(listed.group(1).split()) != ENV_GUARD \
                or "printenv" not in guard or "exit 1" not in guard:
            self.fail("P17", f"{lib_name}: prov_env_guard must refuse (printenv, exit 1) exactly {sorted(ENV_GUARD)}")
        top = [l.strip() for l in lib.splitlines()]
        at = lambda pred: next((i for i, l in enumerate(top) if pred(l)), -1)
        i_setx, i_call = at(lambda l: l == "set +x"), at(lambda l: l == "prov_env_guard")
        i_src = at(lambda l: l.startswith("source ") and "lib.sh" in l)
        if not 0 <= i_setx < i_call < i_src:
            self.fail("P17", f"{lib_name}: `set +x`, then a top-level `prov_env_guard`, before sourcing lib.sh")
        # No xtrace in the scripts that handle tokens (lib.sh, every provisioning script); the guard's
        # own list names BASH_XTRACEFD.
        for name, code in scripts.items():
            if name == lib_name and guard:
                code = code.replace(guard, "")
            if (name == "scripts/lib.sh" or name.startswith(PROV_SCRIPTS)) and XTRACE.search(code):
                self.fail("P17", f"{name}: no xtrace (set -x, set -o xtrace, bash -x, BASH_XTRACEFD)")
        for srel, st, job, step in all_steps:
            envmap = step.get("env") if isinstance(step.get("env"), dict) else {}
            bad = sorted(SHELL_ENV & set(envmap))
            if bad:
                self.fail("P17", f"{srel}: step {step.get('displayName')!r} must not set {bad} (bash options, xtrace)")
            if srel == ENTRA_TEMPLATE and step.get("task") == "AzureCLI@2" \
                    and set(envmap) != {"SAF_ENV_NAME", "SAF_SERVICE_CONNECTION"}:
                self.fail("P17", f"{srel}: the AzureCLI@2 step of stage entra passes exactly SAF_ENV_NAME and "
                                 f"SAF_SERVICE_CONNECTION (got {sorted(envmap)})")


    # -- platform job hand-offs with the ARM token: dbinit (ADR-0028), the Easy Auth secret's delete (ADR-0061)
    def p18_dbinit(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        lib_name = PROV_SCRIPTS + "prov-lib.sh"
        homes = {PROV_SCRIPTS + script for script, _, _, _ in ARM_TOKEN_HANDOFFS}
        for script, command, options, function in ARM_TOKEN_HANDOFFS:
            home = PROV_SCRIPTS + script
            pattern = rf"provisioning\s+{re.escape(command)}\b"
            # Only its script starts the job; no template runs the command.
            for name, text in self.repo.files.items():
                if name.startswith("@") or name == home:
                    continue
                code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
                if re.search(pattern, code):
                    self.fail("P18", f"{name}: `platform provisioning {command}` runs only in {home}")
            code = scripts.get(home, "")
            lines = logical_lines(code)
            calls = [i for i, l in enumerate(lines) if re.search(pattern, l)]
            if len(calls) != 1 or not re.match(rf"^\s*saf_cli provisioning {re.escape(command)}\s", lines[calls[0]]):
                self.fail("P18", f"{home}: exactly one `saf_cli provisioning {command}` call (got {len(calls)})")
            else:
                line = lines[calls[0]]
                opts = re.findall(r"\s(--[\w-]+)", line)
                if sorted(opts) != sorted(options) or re.search(r"token", line, re.IGNORECASE):
                    self.fail("P18", f"{home}: {command} takes exactly {options} and no token "
                                     f"(the token reaches it through the environment only; got {opts})")
                if not re.search(pattern, shell_functions(code).get(function, "")):
                    self.fail("P18", f"{home}: {command} runs inside {function}() (per app, in prov_run_app)")
                prev = lines[calls[0] - 1] if calls[0] > 0 else ""
                after = lines[calls[0] + 1] if calls[0] + 1 < len(lines) else ""
                if not re.fullmatch(r"\s*prov_arm_token\s*", prev) or not re.fullmatch(r"\s*unset SAF_ARM_TOKEN\s*", after):
                    self.fail("P18", f"{home}: prov_arm_token right before {command} and `unset SAF_ARM_TOKEN` right after it")
            if len(re.findall(r"\bprov_arm_token\b", code)) != 1:
                self.fail("P18", f"{home}: prov_arm_token is called exactly once, for {command}")
        lib = scripts.get(lib_name, "")
        bodies = shell_functions(lib)
        for name, code in scripts.items():
            if name == lib_name:
                code = "".join(b for f, b in bodies.items() if f != "prov_arm_token")
            if name not in homes and re.search(r"\bprov_arm_token\b", code):
                self.fail("P18", f"{name}: prov_arm_token is called only by {sorted(homes)}")
        # prov_arm_token(): az cloud show, then get -> setsecret -> store; $token nowhere else.
        body = bodies.get("prov_arm_token")
        if body is None:
            self.fail("P18", "prov-lib.sh must define prov_arm_token()")
            return
        blines = logical_lines(body)
        if not any(re.search(r"\baz cloud show\b", l) for l in blines):
            self.fail("P18", "prov_arm_token() takes the ARM resource from `az cloud show`")
        get = next((i for i, l in enumerate(blines) if re.fullmatch(
            r'\s*token="\$\(az account get-access-token --resource "\$arm" --query accessToken '
            r'--output tsv --only-show-errors\)"', l)), -1)
        mask = next((i for i, l in enumerate(blines) if i > get >= 0 and l.strip() == 'echo "##vso[task.setsecret]$token"'), -1)
        store = next((i for i, l in enumerate(blines) if i > mask >= 0 and l.strip() == 'SAF_ARM_TOKEN="$token"'), -1)
        if get < 0 or not get < mask < store:
            self.fail("P18", 'prov_arm_token() must get the token with az account get-access-token --resource "$arm", '
                             "mask it with task.setsecret, then store it in SAF_ARM_TOKEN")
        allowed = ('echo "##vso[task.setsecret]$token"', '[ -n "$token" ] || saf_die ', 'SAF_ARM_TOKEN="$token"')
        for l in blines:
            if re.search(r"\$\{?token\b", l) and not any(l.strip() == a or (a.endswith(" ") and l.strip().startswith(a)) for a in allowed):
                self.fail("P18", f"prov_arm_token(): the token goes only to task.setsecret and SAF_ARM_TOKEN (got {l.strip()[:80]!r})")


    # -- Removal of what Graph Bicep doesn't delete (ADR-0033, amended 2026-11-11) ---------------
    def p24_reconcile(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        entra_name = PROV_SCRIPTS + "entra.sh"
        plan_name = PROV_SCRIPTS + "entra-plan.sh"
        lib_name = PROV_SCRIPTS + "prov-lib.sh"
        for name, text in self.repo.files.items():
            if name.startswith("@"):
                continue
            code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
            if name != entra_name and re.search(r"provisioning\s+entra-reconcile\b", code):
                self.fail("P24", f"{name}: `platform provisioning entra-reconcile` runs only in {entra_name}")
            if name != plan_name and re.search(r"provisioning\s+entra-removals\b", code):
                self.fail("P24", f"{name}: `platform provisioning entra-removals` runs only in {plan_name}")
        entra = scripts.get(entra_name, "")
        ebodies = shell_functions(entra)
        lines = logical_lines(entra)
        calls = [i for i, l in enumerate(lines) if re.search(r"provisioning\s+entra-reconcile\b", l)]
        if len(calls) != 1 or not re.match(r"^\s*saf_cli provisioning entra-reconcile\s", lines[calls[0]]):
            self.fail("P24", f"{entra_name}: exactly one `saf_cli provisioning entra-reconcile` call (got {len(calls)})")
        else:
            line = lines[calls[0]]
            opts = re.findall(r"\s(--[\w-]+)", line)
            if sorted(opts) != sorted(["--removals", "--inputs", "--unique-name", "--output"]) or re.search(r"token", line, re.IGNORECASE):
                self.fail("P24", f"{entra_name}: entra-reconcile takes exactly --removals, --inputs, --unique-name and "
                                 f"--output and no token (got {opts})")
            if "entra-reconcile" not in ebodies.get("remove_assignments", ""):
                self.fail("P24", f"{entra_name}: entra-reconcile runs inside remove_assignments()")
            prev = lines[calls[0] - 1] if calls[0] > 0 else ""
            after = lines[calls[0] + 1] if calls[0] + 1 < len(lines) else ""
            if not re.fullmatch(r"\s*prov_graph_token\s*", prev) or not re.fullmatch(r"\s*unset SAF_GRAPH_TOKEN\s*", after):
                self.fail("P24", f"{entra_name}: prov_graph_token right before entra-reconcile and `unset SAF_GRAPH_TOKEN` right after it")
        if len(re.findall(r"\bprov_graph_token\b", entra)) != 2 or len(re.findall(r"\bprov_graph_token\b", ebodies.get("unregister", ""))) != 1:
            self.fail("P24", f"{entra_name}: prov_graph_token is called exactly twice, for entra-reconcile and in unregister() for "
                             "entra-delete (ADR-0056)")
        provision = ebodies.get("provision", "")
        i_remove = provision.find("remove_assignments ")
        m_register = re.search(r"(?<![\w-])register ", provision)
        i_register = m_register.start() if m_register else -1
        if i_remove < 0 or not i_remove < i_register:
            self.fail("P24", f"{entra_name}: provision() calls remove_assignments before register")
        lib = scripts.get(lib_name, "")
        bodies = shell_functions(lib)
        for name, code in scripts.items():
            if name == lib_name:
                code = "".join(b for f, b in bodies.items() if f != "prov_graph_token")
            if name != entra_name and re.search(r"\bprov_graph_token\b", code):
                self.fail("P24", f"{name}: prov_graph_token is called only by {entra_name}")
        body = bodies.get("prov_graph_token")
        if body is None:
            self.fail("P24", "prov-lib.sh must define prov_graph_token()")
        else:
            blines = logical_lines(body)
            if not any(re.search(r"\baz cloud show\b", l) for l in blines):
                self.fail("P24", "prov_graph_token() takes the Graph resource from `az cloud show`")
            get = next((i for i, l in enumerate(blines) if re.fullmatch(
                r'\s*token="\$\(az account get-access-token --resource "\$graph" --query accessToken '
                r'--output tsv --only-show-errors\)"', l)), -1)
            mask = next((i for i, l in enumerate(blines) if i > get >= 0 and l.strip() == 'echo "##vso[task.setsecret]$token"'), -1)
            store = next((i for i, l in enumerate(blines) if i > mask >= 0 and l.strip() == 'SAF_GRAPH_TOKEN="$token"'), -1)
            if get < 0 or not get < mask < store:
                self.fail("P24", 'prov_graph_token() must get the token with az account get-access-token --resource "$graph", '
                                 "mask it with task.setsecret, then store it in SAF_GRAPH_TOKEN")
            allowed = ('echo "##vso[task.setsecret]$token"', '[ -n "$token" ] || saf_die ', 'SAF_GRAPH_TOKEN="$token"')
            for l in blines:
                if re.search(r"\$\{?token\b", l) and not any(l.strip() == a or (a.endswith(" ") and l.strip().startswith(a)) for a in allowed):
                    self.fail("P24", f"prov_graph_token(): the token goes only to task.setsecret and SAF_GRAPH_TOKEN (got {l.strip()[:80]!r})")
        # The plan: removals only from the record of the platform's own deployment, only for a deploy.
        plan = scripts.get(plan_name, "")
        pbodies = shell_functions(plan)
        plines = logical_lines(plan)
        pcalls = [l for l in plines if re.search(r"provisioning\s+entra-removals\b", l)]
        if len(pcalls) != 1 or not re.match(r"^\s*saf_cli provisioning entra-removals\s", pcalls[0]) \
                or '--record "$PROV_DIR/entra-record.json"' not in pcalls[0] \
                or not re.search(r"provisioning\s+entra-removals\b", pbodies.get("plan_removals", "")):
            self.fail("P24", f"{plan_name}: exactly one `saf_cli provisioning entra-removals` call, inside plan_removals(), "
                             'with --record "$PROV_DIR/entra-record.json"')
        reg = pbodies.get("plan_registration", "")
        i_deploy, i_call = reg.find("prov_detail entra deploy"), reg.find("plan_removals ")
        if reg.count("plan_removals ") != 1 or i_deploy < 0 or not i_deploy < i_call:
            self.fail("P24", f"{plan_name}: plan_registration() calls plan_removals once, after `prov_detail entra deploy`")


    # -- Custom domain through Front Door (ADR-0010, amended 2026-11-01 and 2026-11-02) -------------
    def p20_front_door(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        azure_name = PROV_SCRIPTS + "azure-post.sh"
        step = re.compile(r"--step\s+frontdoor\b|\bprov_arm\s+(validate|create)\s+frontdoor\b")
        # Only azure-post.sh renders and deploys the custom domain; no template does.
        for name, text in self.repo.files.items():
            if name.startswith("@") or name == azure_name:
                continue
            code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
            if step.search(code):
                self.fail("P20", f"{name}: the custom domain (inputs --step frontdoor, prov_arm … frontdoor) runs only in {azure_name}")
        # Front Door objects and DNS records are deleted only by fd_delete() in azure-post.sh (ADR-0010,
        # amended 2026-11-11): no az afd/network dns/resource delete, no other az rest DELETE.
        azure = scripts.get(azure_name, "")
        bodies = shell_functions(azure)
        fd_delete_lines = logical_lines(bodies.get("fd_delete", ""))
        for name, code in scripts.items():
            for l in logical_lines(code):
                if re.search(r"\baz\s+(afd|cdn|network\s+dns|network\s+front-door)\b.*\bdelete\b", l) \
                        or (re.search(r"\baz\s+(resource|rest)\b", l) and re.search(r"\bdelete\b", l, re.I)
                            and not (name == azure_name and l in fd_delete_lines and FD_DELETE_CALL.fullmatch(l.strip()))
                            and not move_exception(name, code, l)):
                    self.fail("P20", f"{name}: Front Door objects and DNS records are deleted only by fd_delete() in "
                                     f"{azure_name} (got {l.strip()[:80]!r})")
        self.p20_cleanup(azure_name, azure, bodies)
        body = bodies.get("front_door_step")
        if body is None:
            self.fail("P20", f"{azure_name} must define front_door_step()")
            return
        outside = "".join(b for f, b in bodies.items() if f != "front_door_step")
        top = "\n".join(l for l in azure.splitlines() if not re.match(r"^\w+\(\)\s*\{", l))
        for f, b in bodies.items():
            top = top.replace(b, "")
        if step.search(outside) or step.search(top):
            self.fail("P20", f"{azure_name}: the custom domain runs only inside front_door_step()")
        lines = logical_lines(body)
        find = lambda pattern: [i for i, l in enumerate(lines) if re.search(pattern, l)]  # noqa: E731
        inputs = find(r"--step\s+frontdoor\b")
        validate = find(r"^\s*prov_arm\s+validate\s+frontdoor\s")
        compare = find(r"^\s*prov_compare\s+frontdoor\s")
        create = find(r"^\s*prov_arm\s+create\s+frontdoor\s")
        if not (len(inputs) == len(validate) == len(compare) == len(create) == 1):
            self.fail("P20", "front_door_step() renders the inputs, validates, compares and creates exactly once each "
                             f"(got {len(inputs)}, {len(validate)}, {len(compare)}, {len(create)})")
        elif not inputs[0] < validate[0] < compare[0] < create[0]:
            self.fail("P20", "front_door_step(): inputs, then validate, then compare, then create")
        else:
            guard = find(r'if\s+\[\s+"\$prov_verdict"\s+=\s+up-to-date\s+\]')
            if len(guard) != 1 or not compare[0] < guard[0] < create[0] or not any(
                    re.match(r"^\s*else\s*$", l) for l in lines[guard[0]:create[0]]):
                self.fail("P20", "front_door_step(): the create runs only when the verdict is not up-to-date "
                                 '(if [ "$prov_verdict" = up-to-date ]; then … else … create)')
        # Before the release, which reads the deployment (--fd-record) to put the app behind Front Door; in
        # the move of a network mode change (ADR-0060) the same order, after the app's delete and dbinit.
        for caller in ("release_app", "move_step"):
            release = logical_lines(bodies.get(caller, ""))
            at = lambda name: [i for i, l in enumerate(release) if re.fullmatch(rf"\s*{name}\b.*", l)]  # noqa: E731
            calls, database, rel, restart = at("front_door_step"), at("database_entry"), at("release_step"), at("restart_stale")
            real = [i for i, l in enumerate(release) if l.strip()]
            if (len(calls) != 1 or len(database) != 1 or len(rel) != 1 or len(restart) != 1
                    or not database[0] < calls[0] < rel[0] < restart[0] or real[real.index(calls[0]) + 1] != rel[0]):
                self.fail("P20", f"{caller}() calls front_door_step exactly once, after database_entry and right "
                                 "before release_step (then restart_stale)")
        if len(re.findall(r"\bfront_door_step\b", azure)) != 3:
            self.fail("P20", f"{azure_name}: front_door_step is defined once and called only by release_app() and move_step()")

    def p20_cleanup(self, azure_name: str, azure: str, bodies: dict[str, str]) -> None:
        """The removal of a custom domain (ADR-0010, amended 2026-11-11): after the release, in order."""
        for caller in ("release_app", "move_step"):
            release = logical_lines(bodies.get(caller, ""))
            real = [l.strip() for l in release if l.strip()]
            if "front_door_cleanup removal" not in real or real.index("front_door_cleanup removal") != len(real) - 1 \
                    or "release_step" not in real or real.index("release_step") > real.index("front_door_cleanup removal"):
                self.fail("P20", f"{caller}() calls `front_door_cleanup removal` last, after release_step (a domain is "
                                 "removed only after the release of this run succeeded)")
        # A host change: the previous host, right after the deployment that took it off the route.
        step = [l.strip() for l in logical_lines(bodies.get("front_door_step", "")) if l.strip()]
        create = [i for i, l in enumerate(step) if re.match(r"prov_arm\s+create\s+frontdoor\s", l)]
        if not step or step[-1] != "front_door_cleanup change" or not create or create[0] > len(step) - 1:
            self.fail("P20", "front_door_step() ends with `front_door_cleanup change`, after the deployment")
        if len(re.findall(r"\bfront_door_cleanup\b", azure)) != 5 or "front_door_cleanup decommission" not in bodies.get("decom_frontdoor", ""):
            self.fail("P20", f"{azure_name}: front_door_cleanup is defined once and called only by release_app() and "
                             "move_step() (removal), front_door_step() (change) and decom_frontdoor() (decommission, ADR-0056)")
        # fd_delete: one DELETE, after the ID check, called only by the cleanup functions.
        fdl = logical_lines(bodies.get("fd_delete", ""))
        check = next((i for i, l in enumerate(fdl) if re.search(r'^\s*\[\[ "\$\{id,,\}" =~ \^/subscriptions/\$\{subscription,,\}/', l)), -1)
        call = [i for i, l in enumerate(fdl) if FD_DELETE_CALL.fullmatch(l.strip())]
        if len(call) != 1 or check < 0 or not check < call[0]:
            self.fail("P20", "fd_delete() runs exactly one az rest DELETE, after checking the ID is in this environment's subscription")
        for f, b in bodies.items():
            if f not in ("front_door_cleanup", "fd_dns_cleanup", "fd_delete") and re.search(r"\bfd_delete\b", b):
                self.fail("P20", f"{azure_name}: {f}() calls fd_delete; only front_door_cleanup and fd_dns_cleanup do")
        # front_door_cleanup: a removal only with the release's frontDoor.mode none; the route before the
        # custom domains, the origin group after them, the record last.
        cl = logical_lines(bodies.get("front_door_cleanup", ""))
        at = lambda pattern: [i for i, l in enumerate(cl) if re.search(pattern, l)]  # noqa: E731
        removal = at(r'^\s*if \[ "\$what" = removal \]; then$')
        if len(removal) != 1 or not any(re.search(r'^\s*\[ -n "\$\{fd_removing:-\}" \] \|\| return 0$', l) for l in cl[removal[0]:removal[0] + 3]):
            self.fail("P20", "front_door_cleanup(): a removal only for a domain no longer requested (fd_removing)")
        guard, route, domains, og = at(r"\.frontDoor\.mode // \"\"' \"\$PROV_DIR/release/release\.json\"\)\" = none"), \
            at(r"fd_delete \"\$\(jq -r '\.routeId'"), at(r'fd_delete "\$cd"'), at(r"fd_delete \"\$\(jq -r '\.originGroupId'")
        linked, record, lock = at(r"\bfd_domain_linked\b"), at(r"\baz deployment group delete\b"), at(r"^\s*prov_lock frontdoor\s*$")
        if not (len(guard) == len(route) == len(domains) == len(og) == len(record) == len(linked) == len(lock) == 1):
            self.fail("P20", "front_door_cleanup(): one release guard, lock, route, linked check, domain, origin group and record delete each")
        elif not (guard[0] < lock[0] < route[0] < linked[0] < domains[0] < og[0] < record[0]):
            self.fail("P20", "front_door_cleanup(): the release guard, the lock, then the route, the custom domains (each "
                             "unlinked), the origin group and last the record fd-{slug}-{env}")

    # -- Easy Auth secret rotation (ADR-0041) ---------------------------------------------------
    def p19_rotation(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        post_name = PROV_SCRIPTS + RESTART_SCRIPT
        plan_name = PROV_SCRIPTS + "entra-plan.sh"
        for name, code in scripts.items():
            lines = logical_lines(code)
            # Passwords are touched only by the CLI (easyauth-secret, stage entra), never by a script.
            if GRAPH_CREDENTIALS.search(code):
                self.fail("P19", f"{name}: app registration credentials are changed only by `platform provisioning "
                                 "easyauth-secret` (no az ad app|sp credential, addPassword, removePassword or Graph URL)")
            # The plan decides the same way whatever started the run (merge, schedule, manual).
            if RUN_ORIGIN.search(code):
                self.fail("P19", f"{name}: no script reads what started the run (BUILD_REASON, BUILD_CRONSCHEDULE_*, "
                                 "BUILD_REQUESTEDFOR*)")
            if name != post_name and any(REVISION_RESTART.search(l) for l in lines):
                self.fail("P19", f"{name}: a revision is restarted only by {post_name} ({RESTART_FUNCTION})")
            fd_delete = logical_lines(shell_functions(code).get("fd_delete", "")) if name == post_name else []
            for l in lines:
                if AZ_REST.search(l) and not AZ_REST_GET.search(l) \
                        and "/providers/Microsoft.Resources/calculateTemplateHash?" not in l \
                        and not (name == post_name and REVISION_RESTART.search(l)) \
                        and not (l in fd_delete and FD_DELETE_CALL.fullmatch(l.strip())) \
                        and not decommission_exception(name, code, l):
                    self.fail("P19", f"{name}: az rest writes only the template hash (P06), the revision restart and "
                                     f"the Front Door cleanup's DELETE in fd_delete() (P20) (got {l.strip()[:80]!r})")
            if name != plan_name and re.search(r"\brotation-due\b", code):
                self.fail("P19", f"{name}: `platform provisioning rotation-due` runs only in {plan_name}")
        for docs in (self.pdocs, self.docs):
            for rel, doc in docs.items():
                if RUN_ORIGIN.search(json.dumps(doc)):
                    self.fail("P19", f"{rel}: templates never pass or test what started the run (Build.Reason, "
                                     "Build.CronSchedule.*, Build.RequestedFor*)")
        # azure-post.sh restarts only inside restart_stale(), exactly once (one POST per active
        # revision, in a loop), after the marker comparison (tag saf-easyauth = the vault version's
        # created) has returned for an app that runs with the version, and sets the marker only
        # after the restart and the sign-in probe.
        post = scripts.get(post_name, "")
        restarts = [l for l in logical_lines(post) if REVISION_RESTART.search(l)]
        body = shell_functions(post).get(RESTART_FUNCTION, "")
        blines = logical_lines(body)
        at = lambda pattern: next((i for i, l in enumerate(blines) if re.search(pattern, l)), -1)
        restart = at(r'az rest --method post --url "\$app_id/revisions/\$rev/restart\?api-version=[0-9-]+"')
        if len(restarts) != 1 or restart < 0:
            self.fail("P19", f"{post_name}: exactly one revision restart (az rest --method post "
                             f'--url "$app_id/revisions/$rev/restart?api-version=…"), inside {RESTART_FUNCTION}()')
        guard = at(r'^\s*if \[ "\$tag" = "\$created" \]; then$')
        fi = next((i for i in range(guard + 1, len(blines)) if blines[i].strip() == "fi"), -1) if guard >= 0 else -1
        if guard < 0 or fi < 0 or not (restart < 0 or fi < restart) \
                or not any(blines[i].strip() == "return 0" for i in range(guard + 1, fi)):
            self.fail("P19", f'{post_name}: {RESTART_FUNCTION}() returns when the tag saf-easyauth equals the vault '
                             'version\'s created (`if [ "$tag" = "$created" ]; then`, before the restart)')
        smoke = at(r'smoke\.sh" [^\n]*"\$client"( "\$public_host")?$')
        tags = [i for i, l in enumerate(blines) if re.search(r'az tag update --resource-id "\$app_id" --operation merge '
                                                             r'--tags "saf-easyauth=\$created"', l)]
        if smoke < 0 or not tags or not (restart < smoke < tags[-1]) or any(restart < i < smoke for i in tags):
            self.fail("P19", f"{post_name}: {RESTART_FUNCTION}() sets the tag saf-easyauth after the restart only once "
                             "the sign-in probe (smoke.sh with the client ID) passed")
        # ... and only once the settle time since the version has passed: the last tag write is the
        # first line of `if [ "$(date -u +%s)" -ge $((created + PROV_EASYAUTH_SETTLE_S)) ]; then`.
        settled = at(r'^\s*if \[ "\$\(date -u \+%s\)" -ge \$\(\(created \+ PROV_EASYAUTH_SETTLE_S\)\) \]; then$')
        if settled < 0 or not tags or tags[-1] != settled + 1 or not (smoke < settled):
            self.fail("P19", f"{post_name}: {RESTART_FUNCTION}() writes the tag after a restart only when "
                             'PROV_EASYAUTH_SETTLE_S has passed since the version (`if [ "$(date -u +%s)" -ge '
                             '$((created + PROV_EASYAUTH_SETTLE_S)) ]; then`, right before the tag write)')
        # The settle time is one core constant (30 minutes), and a revision counts as started with a
        # version only when created at least that long after it (prov_easyauth_app, both stages).
        lib = scripts.get(PROV_SCRIPTS + "prov-lib.sh", "")
        app_body = shell_functions(lib).get("prov_easyauth_app", "")
        if [l.strip() for l in lib.splitlines() if l.strip().startswith("PROV_EASYAUTH_SETTLE_S=")] != [SETTLE] \
                or any(re.search(r"(^|[\s;(])PROV_EASYAUTH_SETTLE_S=", c, re.M) for n, c in scripts.items()
                       if n != PROV_SCRIPTS + "prov-lib.sh"):
            self.fail("P19", f"prov-lib.sh defines the settle time once, {SETTLE} (ADR-0041); no script sets it")
        if '--argjson m "$PROV_EASYAUTH_SETTLE_S"' not in app_body or ".created >= ($c | tonumber) + $m" not in app_body:
            self.fail("P19", "prov_easyauth_app() counts a revision as started with a version only when it was created "
                             "at least PROV_EASYAUTH_SETTLE_S after it (.created >= ($c | tonumber) + $m)")
        # entra-plan.sh decides a rotation with the CLI, once, inside plan_secret().
        plan = scripts.get(plan_name, "")
        calls = [l for l in logical_lines(plan) if re.search(r"\brotation-due\b", l)]
        if len(calls) != 1 or "rotation-due" not in shell_functions(plan).get("plan_secret", "") \
                or not re.search(r'saf_cli provisioning rotation-due --expires "\$secret_expires" --created "\$secret_created" '
                                 r'--now "\$\(date -u \+%s\)"', calls[0]):
            self.fail("P19", f'{plan_name}: plan_secret() runs `saf_cli provisioning rotation-due --expires "$secret_expires" '
                             '--created "$secret_created" --now "$(date -u +%s)"` exactly once')


    # -- pull request validation of platform-config (V rules) ------------------------------------
    # -- provisioning waits for this core's jobs image (ADR-0043) -------------------------------
    def p23_job_image(self) -> None:
        lib = strip_comments(self.repo.files.get(PROV_SCRIPTS + "prov-lib.sh", ""))
        body = shell_functions(lib).get("prov_job_state", "")
        if not body or '.images["saf-jobs"].digest' not in body or '"$SAF_IMAGES_JSON"' not in body \
                or "printf missing" not in body or "printf current" not in body or "printf outdated" not in body:
            self.fail("P23", "prov-lib.sh must define prov_job_state(): missing | outdated | current, against the saf-jobs "
                             "digest of \"$SAF_IMAGES_JSON\" (images.json)")
        urgent = shell_functions(lib).get("prov_secret_urgent", "")
        if '"$secret_expires"' not in urgent or "14 * 86400" not in urgent:
            self.fail("P23", "prov-lib.sh must define prov_secret_urgent(): the secret entry's expiry within 14 days")
        for name, text in self.prov_scripts().items():
            code = strip_comments(text)
            if re.search(r"\bprov_job_exists\b", code):
                self.fail("P23", f"{name}: a platform job is checked with prov_job_state (existence alone isn't enough)")
            # errexit doesn't apply inside a test: a read error there would pass as "not current".
            if re.search(r"\[\[?[^\]\n]*\$\(prov_job_state\b", code):
                self.fail("P23", f"{name}: assign prov_job_state to a variable first, never inside a test (a read error must fail)")
        # The kvset job: entra.sh checks it right before the tokens, and waits unless current; with at
        # most 14 days left (prov_secret_urgent) a rotation fails instead.
        entra = shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + "entra.sh", ""))).get("write_secret", "")
        state = re.search(r'job_state="\$\(prov_job_state "\$secret_job"\)"\n\s*if \[ "\$job_state" != current \]; then\n(.*?)\n  fi\n', entra, re.S)
        tokens = entra.find("prov_secret_tokens")
        body = state.group(1) if state else ""
        if not state or "prov_wait" not in body or tokens < 0 or state.start() > tokens \
                or not re.search(r'if \[ "\$mode" = rotate \] && prov_secret_urgent; then\n\s*saf_die ', body) \
                or body.find("prov_secret_urgent") > body.find("prov_wait"):
            self.fail("P23", "entra.sh write_secret: `job_state=\"$(prov_job_state \"$secret_job\")\"`, then `if [ \"$job_state\" != current ]; then` "
                             "saf_die for an urgent rotation (prov_secret_urgent), else prov_wait, before prov_secret_tokens "
                             "(the kvset job runs this core's saf-jobs image)")
        # entra_plan: a rotation with at most 14 days left that the kvset job can't write fails the app.
        plan = shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + "entra-plan.sh", ""))).get("plan_secret", "")
        ready = re.search(r'if \[ "\$secret_job_ready" != true \]; then\n(.*?)\n  fi\n', plan, re.S)
        if not ready or not re.search(r'if \[ "\$action" = rotate \] && prov_secret_urgent; then\n(\s*prov_detail [^\n]*\n)?\s*saf_die ', ready.group(1)):
            self.fail("P23", "entra-plan.sh plan_secret: without a ready kvset job, an urgent rotation (prov_secret_urgent) fails the app (saf_die)")
        # The secret entry (plan.sh and azure.sh through prov-lib.sh): jobReady is true only for a current job.
        entry = shell_functions(lib).get("prov_write_secret_entry", "")
        if 'job_state="$(prov_job_state "$job_id")"' not in entry or '[ "$job_state" != current ] || ready=true' not in entry:
            self.fail("P23", "prov-lib.sh prov_write_secret_entry(): the secret entry's jobReady is true only when prov_job_state is current")
        # The dbinit job: azure-post.sh checks it before the token, and waits unless current.
        post = shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + "azure-post.sh", ""))).get("database_entry", "")
        check = post.find('job_state="$(prov_job_state "$job_id")"')
        case = re.search(r'case "\$job_state" in\n\s*current\) ;;\n(.*?)\n\s*esac', post, re.S)
        token = post.find("prov_arm_token")
        if check < 0 or not case or case.group(1).count("prov_wait") != 2 or token < 0 or not check < case.start() < token:
            self.fail("P23", "azure-post.sh database_entry: prov_job_state of the dbinit job, `case \"$job_state\" in current) ;;` "
                             "and prov_wait for missing and any other state, before prov_arm_token")
        # ADR-0061: the kvset job that deletes the Easy Auth secret with the landing zone, likewise.
        lz = shell_functions(strip_comments(self.repo.files.get(PROV_SCRIPTS + "azure.sh", ""))).get("lz_secret_delete", "")
        check = lz.find('job_state="$(prov_job_state "$job_id")"')
        case = re.search(r'case "\$job_state" in\n\s*current\) ;;\n(.*?)\n\s*esac', lz, re.S)
        token = lz.find("prov_arm_token")
        if check < 0 or not case or case.group(1).count("prov_wait") != 2 or token < 0 or not check < case.start() < token:
            self.fail("P23", "azure.sh lz_secret_delete: prov_job_state of the kvset job, `case \"$job_state\" in current) ;;` "
                             "and prov_wait for missing and any other state, before prov_arm_token")

    # -- platform pipeline (ADR-0043) -----------------------------------------------------------
    def plat_scripts(self) -> dict[str, str]:
        return {n: t for n, t in self.repo.files.items() if n.startswith(PLAT_SCRIPTS) and n.endswith(".sh")}

    def run_platform(self) -> None:
        entry = self.edocs.get(PLAT_ENTRY)
        if not isinstance(entry, dict):
            self.fail("E01", f"{PLAT_ENTRY} did not load")
            return
        stages = self.stages(self.edocs)
        all_jobs = [(rel, st, job) for rel, st in stages for job in self.jobs_of(st)]
        all_steps = [(srel, st, job, step) for rel, st, job in all_jobs
                     for srel, step in self.steps_of(self.job_steps(job), rel)]
        # Generic rules over the platform tree.
        self.t03_param_types(self.edocs)
        self.t04_t16_t17_t20_stages(stages, self.edocs)
        self.t08_t09_t10_steps(all_steps)
        self.t10_anywhere(self.edocs)
        self.t11_deployments(all_jobs)
        self.t18_checkouts(all_steps)
        # Platform rules.
        self.e01_entry(entry)
        self.e02_guards()
        self.e03_connections(all_jobs)
        self.e04_tokens()
        self.e05_deployments()
        self.e06_deployment_job(stages, all_jobs)
        self.e07_targets(all_steps)
        self.e08_import()
        self.e09_checkouts(all_steps)
        self.e10_tools()
        self.e11_human_only()
        self.e12_scenarios()
        self.e13_run_origin()
        self.e14_no_side_channels(all_steps)
        self.e15_jobs()
        self.e16_portal()
        self.e17_cae_network()

    def plat_blobs(self) -> list[tuple[str, str]]:
        """(name, text) of every platform template (as loaded JSON, comments dropped) and script (comments stripped)."""
        blobs = [(rel, json.dumps(doc)) for rel, doc in self.edocs.items()]
        blobs += [(n, strip_comments(t)) for n, t in self.plat_scripts().items()]
        return blobs

    def e01_entry(self, entry: dict) -> None:
        params = entry.get("parameters")
        got = [{k: v for k, v in p.items() if k != "displayName"} for p in params or [] if isinstance(p, dict)]
        if not isinstance(params, list) or got != PLAT_ENTRY_PARAMS or len(params) != len(PLAT_ENTRY_PARAMS):
            self.fail("E01", f"{PLAT_ENTRY}: parameters must be exactly [environment: string, hostEnvironment: string], "
                             f"no defaults (got {got})")
        for key in ("variables", "resources", "trigger", "pr", "pool", "schedules", "jobs", "steps", "extends", "lockBehavior"):
            if key in entry:
                self.fail("E01", f"{PLAT_ENTRY}: no root `{key}` in the entry point")

    def e02_guards(self) -> None:
        text = "\n".join(l for l in self.repo.files.get(PLAT_ENTRY, "").splitlines() if not l.lstrip().startswith("#"))
        for guard in PLAT_GUARDS:
            if guard not in text:
                self.fail("E02", f"{PLAT_ENTRY}: compile-time guard missing: {guard!r}")

    def e03_connections(self, all_jobs: list) -> None:
        want = {"validate": set(), "plan": {PLAT_CONNECTION}, "deploy": {PLAT_CONNECTION}}
        for rel, st, job in all_jobs:
            jname = job.get("job") or job.get("deployment")
            conns: set[str] = set()
            for srel, step in self.steps_of(self.job_steps(job), rel):
                inputs = step.get("inputs") if isinstance(step.get("inputs"), dict) else {}
                for k, v in inputs.items():
                    if k.lower() in SC_INPUTS:
                        conns.add(" ".join(str(v).split()))
                envmap = step.get("env") if isinstance(step.get("env"), dict) else {}
                if "azureSubscription" in inputs and envmap.get("SAF_SERVICE_CONNECTION") != inputs["azureSubscription"]:
                    self.fail("E03", f"{srel}: job {jname}: SAF_SERVICE_CONNECTION must equal the step's azureSubscription")
            stage = st.get("stage")
            if stage not in want:
                self.fail("E03", f"{rel}: unexpected stage {stage} (validate, plan, deploy)")
                continue
            if conns != want[stage]:
                self.fail("E03", f"{rel}: job {jname} of stage {stage} must use {sorted(want[stage]) or 'no service connection'} (got {sorted(conns)})")
        for name, blob in self.plat_blobs():
            if re.search(r"sc-platform-(ado|entra)\b", blob):
                self.fail("E03", f"{name}: the platform pipeline uses only the provisioning connection of its environment")

    def e04_tokens(self) -> None:
        for name, blob in self.plat_blobs():
            if re.search(r"system\.accesstoken|system_accesstoken|AZURE_DEVOPS_TOKEN|get-access-token", blob, re.IGNORECASE):
                self.fail("E04", f"{name}: no System.AccessToken, Azure DevOps token or access token in the platform pipeline")

    def e05_deployments(self) -> None:
        lib_name = PLAT_SCRIPTS + "plat-lib.sh"
        lib = strip_comments(self.repo.files.get(lib_name, ""))
        for var, definition in (("plat_env_param", PLAT_ENV_PARAM_DEF), ("plat_portal_param", PLAT_PORTAL_PARAM_DEF)):
            if definition not in lib:
                self.fail("E05", f"plat-lib.sh must define {definition}")
            assigned = sum(len(re.findall(rf"(^|[\s;(]){var}=", strip_comments(t), re.M)) for t in self.plat_scripts().values())
            if assigned != 1:
                self.fail("E05", f"{var} must be assigned exactly once, in plat-lib.sh (found {assigned})")
        arm = shell_functions(lib).get("plat_arm", "")
        if not arm:
            self.fail("E05", "plat-lib.sh must define plat_arm()")
        # The parameter file: set only in the part arms, from the two definitions.
        part_lines = [l.strip() for l in logical_lines(arm) if re.match(r"^\s*(environment|portal)\)", l)]
        if sorted(part_lines) != sorted(PLAT_ARM_PARTS.values()):
            self.fail("E05", f"plat_arm() sets its parameter file only in the part arms {sorted(PLAT_ARM_PARTS.values())} (got {part_lines})")
        if len(re.findall(r"(^|[\s;(])param=", arm, re.M)) != len(PLAT_ARM_PARTS):
            self.fail("E05", "plat_arm() assigns param only in its two part arms")
        arms = re.findall(r"^\s*([\w-]+)\)\n(.*?)^\s*;;", arm, re.M | re.S)
        if sorted(a for a, _ in arms) != ["create", "validate", "what-if"]:
            self.fail("E05", f"plat_arm() must have exactly the case arms create, validate, what-if (got {sorted(a for a, _ in arms)})")
        for action, text in arms:
            calls = [l for l in logical_lines(text) if re.search(r"\baz\s+deployment\s", l)]
            if len(calls) != 1 or not re.search(rf"\baz\s+deployment\s+sub\s+{re.escape(action)}\b", calls[0]) \
                    or re.findall(r"--parameters\s+(\S+)", calls[0]) != ['"$param"']:
                self.fail("E05", f"plat_arm() {action} must run exactly `az deployment sub {action}` with --parameters \"$param\"")
        for name, text in self.plat_scripts().items():
            code = strip_comments(text)
            outside = code.replace(arm, "") if name == lib_name and arm else code
            for line in logical_lines(code):
                if re.search(r"--template-(file|uri|spec)|\s-p\s|--parameter\s|\s-f\s|--rollback-on-error", line) and re.search(r"\baz\s+deployment\s", line):
                    self.fail("E05", f"{name}: no template or extra parameters for az deployment")
            for line in logical_lines(outside):
                if re.search(r"--parameters\b", line):
                    self.fail("E05", f"{name}: --parameters only in plat_arm() (\"$param\", one of the two parameter files)")
                m = re.search(r"\baz\s+deployment\s+(\S+)\s+(\S+)", line)
                if m and not (m.group(1) == "sub" and m.group(2) == "show" and name == lib_name):
                    self.fail("E05", f"{name}: `az deployment {m.group(1)} {m.group(2)}` runs only in plat-lib.sh plat_arm() "
                                     "(and the record read, az deployment sub show, in plat_record)")
            for action, part in re.findall(r"\bplat_arm\s+([\w-]+)(?:\s+([\w-]+))?", code):
                where = {"validate": "plan.sh", "what-if": "plan.sh", "create": "deploy.sh"}.get(action)
                if where is None or name != PLAT_SCRIPTS + where:
                    self.fail("E05", f"{name}: plat_arm {action} belongs to {where or 'nothing'} (what-if and validate in the plan, create in the deploy job)")
                if part not in PLAT_ARM_PARTS:
                    self.fail("E05", f"{name}: plat_arm {action} names its part, environment or portal (got {part or 'none'})")
        outputs = set(re.findall(r"^output\s+(\w+)\s", self.repo.files.get("@platform-names.bicep", ""), re.M))
        for name, text in self.plat_scripts().items():
            for out in sorted(set(re.findall(r'plat_name\s+"\$\w+"\s+"?([\w$]+)"?', strip_comments(text)))):
                if not out.startswith("$") and out not in outputs:
                    self.fail("E05", f"{name}: infra/platform/pipeline/platform-names.bicep has no output {out}")

    def e06_deployment_job(self, stages: list, all_jobs: list) -> None:
        deployments = [(rel, st, job) for rel, st, job in all_jobs if "deployment" in job]
        if len(deployments) != 1:
            self.fail("E06", f"the platform pipeline has exactly one deployment job (got {len(deployments)})")
        for rel, st, job in deployments:
            if st.get("stage") != "deploy" or job.get("deployment") != "deploy" \
                    or job.get("environment") != "platform-${{ parameters.environment }}":
                self.fail("E06", f"{rel}: the deployment job is `deploy` of stage deploy, on the environment platform-${{{{ parameters.environment }}}}")
            steps = flatten(self.job_steps(job))
            if not steps or not isinstance(steps[0], dict) or steps[0].get("download") != "none":
                self.fail("E06", f"{rel}: the deployment job's first step is `download: none`")
        for rel, st, job in all_jobs:
            if "deployment" not in job and "environment" in job:
                self.fail("E06", f"{rel}: job {job.get('job')} must not name an environment")
        conds = {st.get("stage"): " ".join(str(st.get("condition", "")).split()) for _, st in stages}
        if conds.get("deploy") != PLAT_DEPLOY_CONDITION:
            self.fail("E06", f"stage deploy must run only on a planned change: condition {PLAT_DEPLOY_CONDITION}")
        if conds.get("plan") != PLAT_PLAN_CONDITION:
            self.fail("E06", f"stage plan must use the condition {PLAT_PLAN_CONDITION}")

    def e07_targets(self, all_steps: list) -> None:
        decides = 0
        for srel, st, job, step in all_steps:
            target = step.get("target")
            label = step.get("displayName") or step_kind(step)
            if step.get("download") == "none":
                continue  # not a step that runs: it only stops the deployment job's automatic downloads
            if not isinstance(target, dict) or target.get("commands") != "restricted":
                self.fail("E07", f"{srel}: step {label!r} must set target.commands: restricted")
                continue
            if "deployment" in job:
                continue  # rule T22: no settableVariables in a deployment job
            if target.get("settableVariables") == "none":
                continue
            if st.get("stage") == "plan" and job.get("job") == "plan" and step.get("name") == "decide" \
                    and target.get("settableVariables") == ["changed"]:
                decides += 1
                continue
            self.fail("E07", f"{srel}: step {label!r} must set target.settableVariables: none (only the step decide of "
                             "plan.plan sets [changed])")
        if decides != 1:
            self.fail("E07", f"exactly one step `decide` of plan.plan may set a variable, changed (found {decides})")

    def e08_import(self) -> None:
        imports = []
        for name, text in self.plat_scripts().items():
            for line in logical_lines(strip_comments(text)):
                if re.search(r"\baz\s+acr\s+import\b", line):
                    imports.append((name, line))
                if re.search(r"\b(oras\s+(push|cp)|docker\s+(push|tag)|az\s+acr\s+(build|run|login))\b", line):
                    self.fail("E08", f"{name}: the platform pipeline only imports saf-jobs by digest (no push, build or login)")
        if len(imports) != 2 or any(n != PLAT_SCRIPTS + "deploy.sh" for n, _ in imports):
            self.fail("E08", f"az acr import runs exactly twice, in deploy.sh: saf-jobs and saf-portal (got {[n for n, _ in imports]})")
            return
        deploy = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "deploy.sh", ""))
        portal_fn = shell_functions(deploy).get("deploy_portal", "")
        jobs = [l for _, l in imports if '--source "$source_registry/$repo@$digest"' in l]
        portal = [l for _, l in imports if '--source "$source_registry/$portal_repo@$portal_digest"' in l]
        if len(jobs) != 1 or "--force" not in jobs[0] or 'digest="$(plat_jobs_digest)"' not in deploy \
                or any(jobs[0].strip() in l for l in logical_lines(portal_fn)):
            self.fail("E08", "deploy.sh imports saf-jobs with --force from \"$source_registry/$repo@$digest\", digest from plat_jobs_digest (images.json)")
        if len(portal) != 1 or "--force" not in portal[0] or 'portal_digest="$(plat_portal_digest)"' not in portal_fn \
                or not any(portal[0].strip() in l for l in logical_lines(portal_fn)):
            self.fail("E08", "deploy.sh deploy_portal() imports saf-portal with --force from \"$source_registry/$portal_repo@$portal_digest\", "
                             "digest from plat_portal_digest (images.json)")
        fns = shell_functions(strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plat-lib.sh", "")))
        for fn, image in (("plat_jobs_digest", "saf-jobs"), ("plat_portal_digest", "saf-portal")):
            body = fns.get(fn, "")
            if f'.images["{image}"].digest' not in body or '"$SAF_IMAGES_JSON"' not in body:
                self.fail("E08", f"{fn}() reads images.json {image}.digest")

    def e09_checkouts(self, all_steps: list) -> None:
        for srel, st, job, step in all_steps:
            if "checkout" in step and step.get("checkout") not in ("core", "self"):
                self.fail("E09", f"{srel}: the platform pipeline checks out only core and self (got {step.get('checkout')!r})")

    def e10_tools(self) -> None:
        allowed = {"../../provisioning/steps/setup.yml", "../../steps/deployment-setup.yml"}
        for rel, doc in self.edocs.items():
            if not rel.startswith("templates/platform/"):
                continue
            for node in walk_dicts(doc):
                ref = node.get("template")
                if not isinstance(ref, str):
                    continue
                if ref.endswith("install-tools.yml") or (ref.endswith(("setup.yml",)) and ref not in allowed):
                    self.fail("E10", f"{rel}: tools only through provisioning/steps/setup.yml or steps/deployment-setup.yml")
                if ref in allowed:
                    tools = set((node.get("parameters") or {}).get("tools") or [])
                    if not tools <= PLAT_TOOLS:
                        self.fail("E10", f"{rel}: the platform pipeline installs at most {sorted(PLAT_TOOLS)} (got {sorted(tools)})")

    def e11_human_only(self) -> None:
        for name, blob in self.plat_blobs():
            if PLAT_HUMAN_TEMPLATES.search(blob):
                self.fail("E11", f"{name}: bootstrap, entra-permissions and the portal registration are run by a person only")
            if not name.endswith(".sh"):
                continue
            for line in logical_lines(blob):
                if PLAT_FORBIDDEN_AZ.search(line):
                    self.fail("E11", f"{name}: no role definition or assignment writes, locks, Entra, az rest, federated credentials, vaults or tags")
                if "roles.bicep" in line or "$plat_roles_template" in line:
                    ok = (name == PLAT_SCRIPTS + "plat-lib.sh" and line.strip() == PLAT_ROLES_DEF) or \
                         (name == PLAT_SCRIPTS + "plan.sh" and re.match(r'bicep build "\$plat_roles_template" --stdout\b', line.strip()))
                    if not ok:
                        self.fail("E11", f"{name}: roles.bicep is only built (plan.sh, the roles gate), never deployed")

    def e12_scenarios(self) -> None:
        scenarios = {n: t for n, t in self.repo.files.items() if n.startswith("@plat-scenarios/")}
        if not scenarios:
            self.fail("E12", "no scenarios in tests/scenarios/platform/")
        for name, text in sorted(scenarios.items()):
            spec = json.loads(text)
            label = "platform/" + name.split("/", 1)[1]
            stages, errors = Expander(self.repo).pipeline(spec["parameters"], PLAT_ENTRY)
            expect = spec["expect"]
            if "errors" in expect:
                for want in expect["errors"]:
                    if not any(want in e for e in errors):
                        self.fail("E12", f"{label}: expected the compile error {want!r}; got {errors or 'none'}")
                continue
            if errors:
                self.fail("E12", f"{label}: unexpected compile errors {errors}")
                continue
            self.plat_graph(label, spec["parameters"], stages)

    def plat_graph(self, label: str, params: dict, stages: list[dict]) -> None:
        env, host = to_str(params.get("environment")), to_str(params.get("hostEnvironment"))
        conn = f"sc-platform-provisioning-{env}"
        names = [st.get("stage") for st in stages]
        if names != ["validate", "plan", "deploy"]:
            self.fail("E12", f"{label}: stages {names} != ['validate', 'plan', 'deploy']")
            return
        by = {st["stage"]: st for st in stages}
        deps = {s: set([st["dependsOn"]] if isinstance(st.get("dependsOn"), str) else st.get("dependsOn") or []) for s, st in by.items()}
        if deps != {"validate": set(), "plan": {"validate"}, "deploy": {"validate", "plan"}}:
            self.fail("E12", f"{label}: dependsOn {deps}")
        for s in ("plan", "deploy"):
            if by[s].get("lockBehavior") != "runLatest":
                self.fail("E12", f"{label}: {s} uses the service connection and must set lockBehavior: runLatest")
        if "lockBehavior" in by["validate"]:
            self.fail("E12", f"{label}: validate has no service connection and no lock")

        def runs(steps: list[dict], script: str) -> list[dict]:
            return [st for st in steps if str((st.get("inputs") or {}).get("scriptPath", "")).endswith(f"/scripts/platform/{script}")
                    or f"scripts/platform/{script}\"" in str(st.get("bash", ""))]

        _, vsteps = self.stage_steps(by["validate"])
        v = runs(vsteps, "validate.sh")
        if len(v) != 1 or any((st.get("inputs") or {}).get("azureSubscription") for st in vsteps) \
                or to_str((v[0].get("env") or {}).get("SAF_ENV_NAME")) != env or to_str((v[0].get("env") or {}).get("SAF_HOST_ENVIRONMENT")) != host:
            self.fail("E12", f"{label}: validate runs scripts/platform/validate.sh once, without a service connection, for {env} (host {host})")
        pjobs, psteps = self.stage_steps(by["plan"])
        p = runs(psteps, "plan.sh")
        if len(pjobs) != 1 or "job" not in pjobs[0] or len(p) != 1 or p[0].get("task") != "AzureCLI@2" \
                or (p[0].get("inputs") or {}).get("azureSubscription") != conn \
                or (p[0].get("inputs") or {}).get("scriptPath") != f"{CORE_SCRIPTS}scripts/platform/plan.sh" \
                or (p[0].get("inputs") or {}).get("useGlobalConfig") != "false" \
                or {k: to_str(v) for k, v in (p[0].get("env") or {}).items()} != {"SAF_ENV_NAME": env, "SAF_HOST_ENVIRONMENT": host, "SAF_SERVICE_CONNECTION": conn}:
            self.fail("E12", f"{label}: plan is one normal job running {CORE_SCRIPTS}scripts/platform/plan.sh with AzureCLI@2 and {conn}")
        if self.downloads(psteps) or {(st.get("inputs") or {}).get("artifact") for st in psteps if st.get("task") == "PublishPipelineArtifact@1"} != {"platform_plan"}:
            self.fail("E12", f"{label}: plan downloads nothing and publishes platform_plan")
        djobs, dsteps = self.stage_steps(by["deploy"])
        d = runs(dsteps, "deploy.sh")
        if len(djobs) != 1 or djobs[0].get("environment") != f"platform-{env}" or len(d) != 1 or d[0].get("task") != "AzureCLI@2" \
                or (d[0].get("inputs") or {}).get("azureSubscription") != conn \
                or (d[0].get("inputs") or {}).get("scriptPath") != f"{CORE_SCRIPTS}scripts/platform/deploy.sh" \
                or (d[0].get("inputs") or {}).get("useGlobalConfig") != "false" \
                or {k: to_str(v) for k, v in (d[0].get("env") or {}).items()} != {"SAF_ENV_NAME": env, "SAF_HOST_ENVIRONMENT": host, "SAF_SERVICE_CONNECTION": conn}:
            self.fail("E12", f"{label}: deploy is one deployment job on platform-{env} running {CORE_SCRIPTS}scripts/platform/deploy.sh with AzureCLI@2 "
                             f"and {conn}, env SAF_ENV_NAME, SAF_HOST_ENVIRONMENT and SAF_SERVICE_CONNECTION")
        if self.downloads(dsteps) != {"platform_plan"} or any((st.get("inputs") or {}).get("buildType") != "current" for st in dsteps if st.get("task") == "DownloadPipelineArtifact@2"):
            self.fail("E12", f"{label}: deploy downloads exactly platform_plan, from this run")

    def e13_run_origin(self) -> None:
        for name, blob in self.plat_blobs():
            if RUN_ORIGIN.search(blob):
                self.fail("E13", f"{name}: the platform pipeline decides the same way whatever started the run (no Build.Reason, "
                                 "Build.CronSchedule, Build.RequestedFor)")

    def e14_no_side_channels(self, all_steps: list) -> None:
        for name, blob in self.plat_blobs():
            if "report.sh" in blob or "deployment-finish.yml" in blob or "task.uploadsummary" in blob:
                self.fail("E14", f"{name}: no deploy events or summary uploads in the platform pipeline")
            if name.endswith(".sh") and name != PLAT_SCRIPTS + "decide.sh" and re.search(r"task\.setvariable|task\.prependpath", blob):
                self.fail("E14", f"{name}: only decide.sh sets a variable (changed)")
        decide = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "decide.sh", ""))
        if re.findall(r"task\.setvariable variable=(\w+)", decide) != ["changed"]:
            self.fail("E14", "decide.sh sets exactly the output changed")

    def e15_jobs(self) -> None:
        lib = shell_functions(strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plat-lib.sh", ""))).get("plat_job_state", "")
        if not lib or '"/$repo@$digest"' not in lib or "printf missing" not in lib or "printf current" not in lib \
                or "printf outdated" not in lib:
            self.fail("E15", "plat-lib.sh must define plat_job_state(): missing | outdated | current against \"/$repo@$digest\"")
        call = 'state="$(plat_job_state "$platform_rg" "$job" "$repo" "$digest")"'
        loop = "done < <(jq -r '.outputs.jobs[] | [.kvset, .dbinit] | @tsv' \"$names\")"
        for name, text in self.plat_scripts().items():
            if re.search(r"\[\[?[^\]\n]*\$\(plat_job_state\b", strip_comments(text)):
                self.fail("E15", f"{name}: assign plat_job_state to a variable first, never inside a test (a read error must fail)")
        plan = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plan.sh", ""))
        record = re.search(r'if \[ -f "\$PLAT_DIR/record\.json" \]; then\n(.*?)\nelse\n', plan, re.S)
        body = record.group(1) if record else ""
        if call not in body or loop not in body or '[ "$state" = current ] || job_issues+=' not in body \
                or not re.search(r'\[ "\$result" = up-to-date \]; then\n[^\n]*\n\s*result="changed: ', body):
            self.fail("E15", "plan.sh: with a record, every job (platform-names output jobs) through plat_job_state; one not current "
                             "turns up-to-date into changed")
        deploy = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "deploy.sh", ""))
        if call not in deploy or loop not in deploy or not re.search(r'\[ "\$state" = current \] \|\| saf_die ', deploy):
            self.fail("E15", "deploy.sh: after pass 2, every job (platform-names output jobs) is current (plat_job_state), or the run fails")

    def e16_portal(self) -> None:
        """The portal only in its host's pipeline, and its Container App checked, not only its record."""
        lib = shell_functions(strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plat-lib.sh", ""))).get("plat_app_state", "")
        if not lib or "Microsoft.App/containerApps" not in lib or '"/$repo@$digest"' not in lib or "printf missing" not in lib \
                or "printf current" not in lib or "printf outdated" not in lib:
            self.fail("E16", "plat-lib.sh must define plat_app_state(): the Container App, missing | outdated | current against \"/$repo@$digest\"")
        portal_call = re.compile(r"\bplat_arm\s+[\w-]+\s+portal\b|\bplat_portal_inputs\b|\$portal_repo@\$portal_digest")
        for name, text in self.plat_scripts().items():
            code = strip_comments(text)
            if re.search(r"\[\[?[^\]\n]*\$\(plat_app_state\b", code):
                self.fail("E16", f"{name}: assign plat_app_state to a variable first, never inside a test (a read error must fail)")
            fns = shell_functions(code)
            allowed = {PLAT_SCRIPTS + "plan.sh": "plan_portal", PLAT_SCRIPTS + "deploy.sh": "deploy_portal",
                       PLAT_SCRIPTS + "plat-lib.sh": "plat_portal_inputs"}.get(name)
            outside = code.replace(fns.get(allowed, ""), "") if allowed and fns.get(allowed) else code
            for line in logical_lines(outside):
                if portal_call.search(line) and not re.match(r"^plat_portal_inputs\(\)\s*\{", line):
                    self.fail("E16", f"{name}: the portal is planned and deployed only in plan.sh plan_portal() and deploy.sh deploy_portal(): {line.strip()[:90]!r}")

        def top_lines(code: str) -> list[str]:
            top = code
            for body in shell_functions(code).values():
                top = top.replace(body, "")
            return [l.strip() for l in logical_lines(top)]

        plan = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plan.sh", ""))
        top = top_lines(plan)
        calls = [i for i, l in enumerate(top) if l == "plan_portal"]
        if len(calls) != 1 or calls[0] == 0 or top[calls[0] - 1] != PLAT_HOST_GUARD:
            self.fail("E16", f"plan.sh calls plan_portal exactly once, right after `{PLAT_HOST_GUARD}`")
        body = shell_functions(plan).get("plan_portal", "")
        if 'digest_p="$(plat_portal_digest)"' not in body or 'state="$(plat_app_state "$rg_p" "$app_p" "$repo_p" "$digest_p")"' not in body \
                or not re.search(r'if \[ "\$target" = 2 \] && \[ "\$state" != current \] && \[ "\$result_p" = up-to-date \]; then\n\s*result_p="changed: ', body) \
                or not re.search(r'if \[ "\$target" = 1 \] && \[ "\$state" != missing \]; then\n\s*saf_die ', body):
            self.fail("E16", "plan.sh plan_portal(): the Container App through plat_app_state on the pinned saf-portal digest; one not current turns an "
                             "up-to-date pass 2 into changed, and an existing app without portal.clientId stops the plan")
        deploy = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "deploy.sh", ""))
        top = top_lines(deploy)
        calls = [i for i, l in enumerate(top) if l == "deploy_portal"]
        if len(calls) != 1 or calls[0] < 2 or top[calls[0] - 2] != 'if [ "$portal_changed" = true ]; then' \
                or not top[calls[0] - 1].startswith('[ "$env_name" = "$SAF_HOST_ENVIRONMENT" ] || saf_die '):
            self.fail("E16", "deploy.sh calls deploy_portal exactly once, inside `if [ \"$portal_changed\" = true ]` right after the host check "
                             "`[ \"$env_name\" = \"$SAF_HOST_ENVIRONMENT\" ] || saf_die`")
        lines = [l.strip() for l in logical_lines(shell_functions(deploy).get("deploy_portal", ""))]
        approved = [i for i, l in enumerate(lines) if l.startswith("jq -e --slurpfile a \"$approved_portal\" '. == $a[0]'") and "|| saf_die" in l]
        writes = [i for i, l in enumerate(lines) if re.match(r"(if ! )?(plat_arm create |az acr import )", l)]
        if not approved or not writes or min(writes) < approved[0]:
            self.fail("E16", "deploy.sh deploy_portal(): the portal inputs must equal the approved plan's before any import or deployment")
        if 'state="$(plat_app_state "$rg_p" "$app_p" "$portal_repo" "$portal_digest")"' not in lines \
                or not any(l.startswith('[ "$state" = current ] || saf_die ') for l in lines) \
                or not any(re.match(r'plat_app_ready "\$rg_p" "\$app_p" \d+\s+\|\|\s+saf_die ', l) for l in lines):
            self.fail("E16", "deploy.sh deploy_portal(): after pass 2 the Container App runs the pinned saf-portal digest (plat_app_state) and "
                             "gets a ready revision (plat_app_ready), or the run fails")
        validate = top_lines(strip_comments(self.repo.files.get(PLAT_SCRIPTS + "validate.sh", "")))
        uses = [i for i, l in enumerate(validate) if "portal-inputs" in l]
        if len(uses) != 1 or uses[0] == 0 or validate[uses[0] - 1] != 'if [ "$SAF_ENV_NAME" = "$SAF_HOST_ENVIRONMENT" ]; then':
            self.fail("E16", "validate.sh runs `platform environment portal-inputs` once, only in the portal host")

    def e17_cae_network(self) -> None:
        """A CAE's network is fixed once it exists (US03.03): every CAE read, the stop before validate and what-if."""
        lib = shell_functions(strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plat-lib.sh", "")))
        read = lib.get("plat_cae_read", "")
        if not read or "--resource-type Microsoft.App/managedEnvironments" not in read \
                or not re.search(r"grep -Eq '[^']*ResourceNotFound[^']*' \"\$err\"; then\n\s*printf null\n\s*return 0\n", read) \
                or not re.search(r"\n\s*return 1\n\s*fi\n", read):
            self.fail("E17", "plat-lib.sh must define plat_cae_read(): the CAE through az resource show, null only when it isn't found, "
                             "any other read error fails")
        snap = lib.get("plat_env_snapshot", "")
        if not snap or 'bicep snapshot "$plat_env_param"' not in snap or 'SAF_ENVIRONMENT_JSON="$(cat "$inputs")"' not in snap:
            self.fail("E17", "plat-lib.sh must define plat_env_snapshot(): bicep snapshot of environment.bicepparam with the run's inputs")
        for name, text in self.plat_scripts().items():
            if re.search(r"\[\[?[^\]\n]*\$\(plat_cae_read\b", strip_comments(text)):
                self.fail("E17", f"{name}: assign plat_cae_read to a variable first, never inside a test (a read error must fail)")
        plan = strip_comments(self.repo.files.get(PLAT_SCRIPTS + "plan.sh", ""))
        top = plan
        for body in shell_functions(plan).values():
            top = top.replace(body, "")
        lines = [l.strip() for l in logical_lines(top)]
        read_at = [i for i, l in enumerate(lines) if l == 'resource="$(plat_cae_read "$platform_rg" "$cae")"']
        loop_at = [i for i, l in enumerate(lines) if l == "done < <(jq -r '.outputs.managedEnvironments[] | [.mode, .name] | @tsv' \"$names\")"]
        if len(read_at) != 1 or not any(i > read_at[0] for i in loop_at):
            self.fail("E17", "plan.sh reads every CAE of platform-names.bicep's output managedEnvironments through plat_cae_read, at the top level")
        snap_at = [i for i, l in enumerate(lines) if l.startswith('plat_env_snapshot "$out/inputs.json" ')]
        check_at = [i for i, l in enumerate(lines) if re.match(r"if ! saf_cli environment cae-network\s", l)]
        if len(check_at) != 1 or '--names "$names"' not in lines[check_at[0]] or '--live "$PLAT_DIR/caes.json"' not in lines[check_at[0]] \
                or not snap_at or snap_at[0] > check_at[0] or (read_at and read_at[0] > check_at[0]):
            self.fail("E17", "plan.sh runs `if ! saf_cli environment cae-network` once, after reading the CAEs and snapshotting the inputs")
            return
        end = next((i for i in range(check_at[0] + 1, len(lines)) if lines[i] == "fi"), len(lines))
        if not any(l.startswith("saf_die ") for l in lines[check_at[0] + 1:end]):
            self.fail("E17", "plan.sh: a refused CAE network stops the plan (saf_die inside `if ! saf_cli environment cae-network`)")
        later = [i for i, l in enumerate(lines)
                 if l.startswith(("plat_arm validate environment ", "plat_arm what-if environment ")) or l == "plan_portal"]
        if not later or min(later) < check_at[0]:
            self.fail("E17", "plan.sh checks the CAE networks before its first validate, what-if and the portal's plan")

    def run_validation(self) -> None:
        entry = self.vdocs.get(VAL_ENTRY)
        if not isinstance(entry, dict):
            self.fail("V01", f"{VAL_ENTRY} did not load")
            return
        stages = self.stages(self.vdocs)
        all_jobs = [(rel, st, job) for rel, st in stages for job in self.jobs_of(st)]
        all_steps = [(srel, st, job, step) for rel, st, job in all_jobs
                     for srel, step in self.steps_of(self.job_steps(job), rel)]
        # Generic rules over the validation tree.
        self.t03_param_types(self.vdocs)
        self.t04_t16_t17_t20_stages(stages, self.vdocs)
        self.t08_t09_t10_steps(all_steps)
        self.t10_anywhere(self.vdocs)
        # Validation rules.
        self.v01_entry(entry, stages, all_jobs)
        self.v02_credentials(all_jobs, all_steps)
        self.v03_targets(stages, all_jobs, all_steps)
        self.v04_checkouts(all_steps)
        self.v05_steps(all_jobs)
        self.v06_entra_effect()

    def v01_entry(self, entry: dict, stages: list, all_jobs: list) -> None:
        for key in ("parameters", "variables", "resources", "trigger", "pr", "pool", "schedules", "jobs",
                    "steps", "extends", "lockBehavior"):
            if key in entry:
                self.fail("V01", f"{VAL_ENTRY}: no root `{key}` (the pipeline takes no parameters; nothing can be switched off)")
        if [st.get("stage") for _, st in stages] != ["validate"]:
            self.fail("V01", f"{VAL_ENTRY}: exactly one stage `validate` (got {[st.get('stage') for _, st in stages]})")
        if [job.get("job") for _, _, job in all_jobs] != ["validate"]:
            self.fail("V01", f"{VAL_ENTRY}: exactly one normal job `validate`")

    def v02_credentials(self, all_jobs: list, all_steps: list) -> None:
        for rel, st, job in all_jobs:
            if "deployment" in job or "environment" in job or "job" not in job:
                self.fail("V02", f"{rel}: the validation job is a normal job without an environment")
        for srel, st, job, step in all_steps:
            label = step.get("displayName") or step_kind(step)
            if "task" in step:
                self.fail("V02", f"{srel}: step {label!r} runs task {step.get('task')}; the validation pipeline runs no task "
                                 "(no service connection, no Azure or Azure DevOps credentials)")
        for rel, doc in self.vdocs.items():
            for key, value in walk(doc):
                if isinstance(key, str) and (key.lower() in SC_INPUTS or key == "environment"):
                    self.fail("V02", f"{rel}: `{key}` is not allowed (no service connection, no environment)")
            text = strip_comments(self.repo.files.get(rel, ""))
            if re.search(r"system\.accesstoken|system_accesstoken", text, re.IGNORECASE):
                self.fail("V02", f"{rel}: System.AccessToken is not allowed in the validation pipeline")
        script = strip_comments(self.repo.files.get(VAL_SCRIPT, ""))
        if re.search(r"system\.accesstoken|system_accesstoken|AZURE_DEVOPS_TOKEN|get-access-token", script, re.IGNORECASE):
            self.fail("V02", f"{VAL_SCRIPT}: no token (System.AccessToken, AZURE_DEVOPS_TOKEN, get-access-token)")
        if any(re.search(r"(^|[\s;|&(])az\s", line) for line in logical_lines(script)):
            self.fail("V02", f"{VAL_SCRIPT}: no Azure CLI call")

    def v03_targets(self, stages: list, all_jobs: list, all_steps: list) -> None:
        for rel, st in stages:
            if "condition" in st:
                self.fail("V03", f"{rel}: stage {st.get('stage')} must have no condition")
        for rel, st, job in all_jobs:
            if "condition" in job or "variables" in job:
                self.fail("V03", f"{rel}: job {job.get('job')} must have no condition and no variables")
        for srel, st, job, step in all_steps:
            label = step.get("displayName") or step_kind(step)
            target = step.get("target")
            if not (isinstance(target, dict) and target.get("commands") == "restricted"
                    and target.get("settableVariables") == "none"):
                self.fail("V03", f"{srel}: step {label!r} must set target commands: restricted, settableVariables: none")
            if "condition" in step:
                self.fail("V03", f"{srel}: step {label!r} must have no condition (nothing may be skipped)")

    def v04_checkouts(self, all_steps: list) -> None:
        got = [step for _, _, _, step in all_steps if "checkout" in step]
        if [s.get("checkout") for s in got] != [c["checkout"] for c in VAL_CHECKOUTS]:
            self.fail("V04", f"{VAL_ENTRY}: checkouts must be exactly core then self (got {[s.get('checkout') for s in got]})")
            return
        for step, want in zip(got, VAL_CHECKOUTS):
            expected = {**want, "fetchTags": "false", "submodules": "false", "lfs": "false", "persistCredentials": "false"}
            for key, value in expected.items():
                if step.get(key) != value:
                    self.fail("V04", f"{VAL_ENTRY}: checkout {want['checkout']} must set {key}: {value}")

    def v05_steps(self, all_jobs: list) -> None:
        for rel, st, job in all_jobs:
            steps = [x for x in flatten(job.get("steps")) if isinstance(x, dict)]
            kinds = [step_kind(x) for x in steps]
            if kinds != ["checkout", "checkout", "template", "template", "bash"]:
                self.fail("V05", f"{rel}: the job's steps must be the two checkouts, install-tools.yml, platform-cli.yml and "
                                 f"one bash step (got {kinds})")
                continue
            tools, cli, run = steps[2], steps[3], steps[4]
            if tools.get("template") != "templates/steps/install-tools.yml" or (tools.get("parameters") or {}).get("tools") != ["node"]:
                self.fail("V05", f"{rel}: tools come only from templates/steps/install-tools.yml with tools [node]")
            if cli.get("template") != "templates/steps/platform-cli.yml" or "parameters" in cli:
                self.fail("V05", f"{rel}: the CLI is built by templates/steps/platform-cli.yml from the core checkout")
            if " ".join(str(run.get("bash", "")).split()) != VAL_RUN or set(run) - {"bash", "displayName", "target"}:
                self.fail("V05", f"{rel}: the last step runs exactly {VAL_RUN} (no env, no other keys)")
        script = strip_comments(self.repo.files.get(VAL_SCRIPT, ""))
        if not script:
            self.fail("V05", f"{VAL_SCRIPT} is missing")
            return
        for call in VAL_SCRIPT_CALLS:
            if call not in script:
                self.fail("V05", f"{VAL_SCRIPT} must run `{call}`")
        loop = re.search(r'^for dir in "\$SAF_CONFIG"/apps/\*/; do\n(.*?)^done\n', script, re.M | re.S)
        if not loop or VAL_SCRIPT_CALLS[1] not in loop.group(1):
            self.fail("V05", f"{VAL_SCRIPT}: every app is validated in the loop `for dir in \"$SAF_CONFIG\"/apps/*/`")
        elif re.search(r"(^|[\s;])(exit|saf_die|return|break)\b", loop.group(1)):
            self.fail("V05", f"{VAL_SCRIPT}: nothing in the app loop may stop it (exit, saf_die, return, break)")
        for line in logical_lines(script):
            if re.search(r"\$\{?(name|dir|file)\b", line) and re.search(r"(^|[\s;|&(])(printf|echo|saf_info)\b", line) \
                    and "saf_neutralise" not in line:
                self.fail("V05", f"{VAL_SCRIPT}: folder names from the pull request are printed only through saf_neutralise")
        last = [l for l in script.splitlines() if l.strip()]
        if not any('[ "$failed" -eq 0 ] || saf_die' in l for l in last[-3:]):
            self.fail("V05", f"{VAL_SCRIPT} must fail at the end when anything failed ([ \"$failed\" -eq 0 ] || saf_die ...)")

    def v06_entra_effect(self) -> None:
        """The Entra effect of every changed app.yaml (ADR-0051 section 5), offline, base = the target branch."""
        script = strip_comments(self.repo.files.get(VAL_SCRIPT, ""))
        loop = re.search(r"^  while IFS= read -r -d '' path; do\n(.*?)^  done < <\(git -C \"\$SAF_CONFIG\" diff --name-only -z "
                         r"HEAD\^1 HEAD -- 'apps/\*/app\.yaml'\)$", script, re.M | re.S)
        if not loop:
            self.fail("V06", f"{VAL_SCRIPT}: the Entra effect loops over the app definitions the pull request changes "
                             "(`while IFS= read -r -d '' path; do ... done < <(git -C \"$SAF_CONFIG\" diff --name-only -z HEAD^1 HEAD -- 'apps/*/app.yaml')`)")
            return
        body = loop.group(1)
        if 'git -C "$SAF_CONFIG" show "HEAD^1:$path" > "$base_file"' not in body or "base_file=none" not in body:
            self.fail("V06", f"{VAL_SCRIPT}: the base is the target branch's file (`git show \"HEAD^1:$path\"`), or none for a new app")
        if body.count("provisioning entra-effect") != 1 or script.count("provisioning entra-effect") != 1 or \
                'saf_cli provisioning entra-effect --base "$base_file" --head "$head_file" --instance "$instance" | saf_neutralise' not in body:
            self.fail("V06", f"{VAL_SCRIPT}: one `saf_cli provisioning entra-effect --base \"$base_file\" --head \"$head_file\" "
                             "--instance \"$instance\" | saf_neutralise` per changed app, in the loop")
        if re.search(r"(^|[\s;])(exit|saf_die|return|break)\b", body):
            self.fail("V06", f"{VAL_SCRIPT}: nothing in the Entra effect loop may stop the run (it is informational)")
        for line in logical_lines(body):
            if "$path" in line and re.search(r"(^|[\s;|&(])(printf|echo|saf_info)\b", line) and "saf_neutralise" not in line:
                self.fail("V06", f"{VAL_SCRIPT}: paths from the pull request are printed only through saf_neutralise")
        # Offline: the checkout persists no credentials, so nothing is fetched (depth 2 holds HEAD^1, V04).
        if re.search(r"\bgit\b[^\n]*\b(fetch|pull|ls-remote|remote)\b", script):
            self.fail("V06", f"{VAL_SCRIPT}: no git fetch, pull or remote call (no credentials; HEAD^1 is in the checkout)")
        if "##[section]" not in script:
            self.fail("V06", f"{VAL_SCRIPT}: the Entra effect has its own section of the log (##[section])")

    # -- Portal-side private endpoints of app vaults (ADR-0025) -------------------------------
    def p21_portal_endpoints(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        post_name = PROV_SCRIPTS + PORTAL_ENDPOINT_SCRIPT
        post = scripts.get(post_name, "")
        bodies = shell_functions(post)
        step_re = re.compile(r"--step\s+portal-endpoint\b")
        arm_re = re.compile(r"\bprov_arm\s+(validate|create)\s+portal-endpoint\b")
        approve_re = re.compile(r"\bprivate-endpoint-connection\s+approve\b")
        # Nowhere else: no other script, no template.
        for name, text in self.repo.files.items():
            if name.startswith("@") or name == post_name:
                continue
            code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
            if step_re.search(code) or arm_re.search(code):
                self.fail("P21", f"{name}: the portal-side endpoint is rendered and deployed only in {post_name}")
            if approve_re.search(code):
                self.fail("P21", f"{name}: private endpoint connections are approved only in {post_name}")
        unit = bodies.get("portal_endpoint", "")
        for what, rx, want in (("inputs --step portal-endpoint", step_re, 1), ("prov_arm validate portal-endpoint",
                               re.compile(r"\bprov_arm\s+validate\s+portal-endpoint\b"), 1),
                               ("prov_arm create portal-endpoint", re.compile(r"\bprov_arm\s+create\s+portal-endpoint\b"), 1)):
            if len(rx.findall(post)) != want or len(rx.findall(unit)) != want:
                self.fail("P21", f"{post_name}: exactly one `{what}`, inside portal_endpoint() (a prov_run_app unit)")
        if len(approve_re.findall(post)) != 1 or len(approve_re.findall(bodies.get("portal_endpoint_approve", ""))) != 1:
            self.fail("P21", f"{post_name}: exactly one `private-endpoint-connection approve`, inside portal_endpoint_approve()")
        entry = bodies.get("portal_endpoints", "")
        guard = entry.find(PORTAL_ENDPOINT_HOST_GUARD)
        first_unit = entry.find("prov_run_app")
        if guard < 0 or first_unit < 0 or guard > first_unit:
            self.fail("P21", f"{post_name}: portal_endpoints() must leave non-host stages ({PORTAL_ENDPOINT_HOST_GUARD!r}) "
                             "before its first prov_run_app")
        # One top-level call after the release loop (its `done` at column 0) and before the final prov_finish.
        lines = [l for l in post.splitlines() if l.strip()]
        calls = [i for i, l in enumerate(lines) if re.search(r"(^|[\s;&|(])portal_endpoints(\s|;|$)", l)]
        loop_end = max((i for i, l in enumerate(lines) if l == "done"), default=-1)
        if len(calls) != 1 or lines[calls[0]] != "portal_endpoints" or not loop_end < calls[0] < len(lines) - 1 \
                or lines[-1] != "prov_finish":
            self.fail("P21", f"{post_name}: portal_endpoints is called exactly once, at the top level after the release "
                             "loop and before the final prov_finish")
        for name, code in scripts.items():
            if not name.startswith(PROV_SCRIPTS):
                continue
            for line in logical_lines(code):
                if PORTAL_ENDPOINT_FORBIDDEN.search(line) and not decommission_exception(name, code, line) and not move_exception(name, code, line):
                    self.fail("P21", f"{name}: provisioning deletes or rejects a private endpoint or connection only in "
                                     f"DECOMMISSION_EXCEPTIONS, PORTAL_ENDPOINT_REMOVALS and MOVE_EXCEPTIONS: {line.strip()[:80]}")
        # ADR-0025 amendment 2026-11-14: each removal function exists with its one call, and is reached
        # only from its callers; the endpoint of a vault no longer VNet-based goes only when the vault
        # holds no other connection (portal_vault_state free), after portal_endpoint()'s vnetBased check.
        for base, func, text in PORTAL_ENDPOINT_REMOVALS:
            body = logical_lines(shell_functions(scripts.get(PROV_SCRIPTS + base, "")).get(func, ""))
            if not any(l.strip().startswith(text) for l in body):
                self.fail("P21", f"{base}: {func}() no longer has `{text[:70]}`; update PORTAL_ENDPOINT_REMOVALS")
        for target, allowed in PORTAL_ENDPOINT_REMOVAL_CALLERS.items():
            callers = sorted({f for f, b in bodies.items() if f != target and re.search(rf"(^|[\s;(]){target}(\s|;|$)", b, re.M)})
            top = post
            for b in bodies.values():
                top = top.replace(b, "")
            if re.search(rf"(^|[\s;(]){target}(\s|;|$)", top, re.M):
                callers.append("<top>")
            if not callers or not set(callers) <= set(allowed):
                self.fail("P21", f"{post_name}: {target}() is called only from {allowed} (got {callers})")
            for name, code in scripts.items():
                if name != post_name and re.search(rf"(^|[\s;(]){target}(\s|;|$)", code, re.M):
                    self.fail("P21", f"{name}: {target}() belongs to {post_name}")
        unit_lines = [l.strip() for l in logical_lines(unit)]
        vnet_check = [i for i, l in enumerate(unit_lines) if l.startswith("if [ \"$(jq -r '.vnetBased' \"$dir/pe.json\")\" != true ]; then")]
        left_calls = [i for i, l in enumerate(unit_lines) if re.match(r"portal_endpoint_left\b", l)]
        if len(vnet_check) != 1 or len(left_calls) != 1 or left_calls[0] != vnet_check[0] + 1:
            self.fail("P21", f"{post_name}: portal_endpoint() calls portal_endpoint_left once, right inside its vnetBased check")
        left = [l.strip() for l in logical_lines(bodies.get("portal_endpoint_left", ""))]
        state = [i for i, l in enumerate(left) if l.startswith('state="$(portal_vault_state "$vault_id" "$endpoint_id")"')]
        free = [i for i, l in enumerate(left) if l == "free)"]
        removes = [i for i, l in enumerate(left) if re.match(r"portal_endpoint_remove\b", l)]
        arm_end = next((i for i, l in enumerate(left) if free and i > free[0] and l == ";;"), -1)
        if len(state) != 1 or len(free) != 1 or len(removes) != 1 or not state[0] < free[0] < removes[0] < arm_end:
            self.fail("P21", f"{post_name}: portal_endpoint_left() removes the endpoint only in the `free)` arm of portal_vault_state")
        vault_state = bodies.get("portal_vault_state", "")
        if '"held"' not in vault_state or 'printf unknown' not in vault_state or "ascii_downcase) != \"enabled\"" not in vault_state:
            self.fail("P21", f"{post_name}: portal_vault_state() answers held for a vault with public network access not enabled or "
                             "another connection, and unknown when it can't read it")

    def p22_parallel_scope(self) -> None:
        scripts = {n: strip_comments(t) for n, t in self.repo.files.items() if n.endswith(".sh")}
        lib_name = PROV_SCRIPTS + "prov-lib.sh"
        lib = scripts.get(lib_name, "")
        fns = shell_functions(lib)
        # The bound: one literal in prov-lib.sh; PROV_PARALLEL set only to 1 and in prov_parallel().
        maxes = re.findall(r"^PROV_PARALLEL_MAX=(\S*)$", lib, re.M)
        if len(maxes) != 1 or not re.fullmatch(r"[2-8]", maxes[0]):
            self.fail("P22", f"{lib_name} assigns PROV_PARALLEL_MAX exactly once, to a literal from 2 to 8 (got {maxes})")
        sets = [l.strip() for l in lib.splitlines() if re.search(r"(^|[\s;(])PROV_PARALLEL=", l)]
        if sets != ["PROV_PARALLEL=1", "PROV_PARALLEL=$PROV_PARALLEL_MAX"] \
                or "PROV_PARALLEL=$PROV_PARALLEL_MAX" not in fns.get("prov_parallel", ""):
            self.fail("P22", f"{lib_name}: PROV_PARALLEL is set only to 1 and, in prov_parallel(), to $PROV_PARALLEL_MAX")
        for name, text in self.repo.files.items():
            if name.startswith("@") or name == lib_name:
                continue
            code = scripts.get(name, "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#")))
            if re.search(r"\bPROV_PARALLEL(_MAX)?\b", code):
                self.fail("P22", f"{name}: only {lib_name} names PROV_PARALLEL and PROV_PARALLEL_MAX (a core constant)")
        # Which stages run their units in parallel.
        for base in PROV_PARALLEL_SCRIPTS + PROV_SEQUENTIAL_SCRIPTS:
            code = scripts.get(PROV_SCRIPTS + base, "")
            calls = [m.start() for m in re.finditer(r"^prov_parallel$", code, re.M)]
            loop = next((m.start() for m in re.finditer(r"^for ", code, re.M)), -1)
            if base in PROV_PARALLEL_SCRIPTS and (len(calls) != 1 or loop < 0 or calls[0] > loop):
                self.fail("P22", f"{base} calls prov_parallel once, at the top level, before its app loop")
            if base in PROV_SEQUENTIAL_SCRIPTS and re.search(r"\bprov_parallel\b", code):
                self.fail("P22", f"{base} runs one app at a time (ADR-0046): no prov_parallel")
        # Background jobs and wait only in the runner.
        bg = re.compile(r"(?<![&|>])&\s*$", re.M)
        for name, code in scripts.items():
            if not name.startswith(PROV_SCRIPTS) and name != "scripts/smoke.sh":
                continue
            if name != lib_name and (bg.search(code) or re.search(r"(^|[\s;(])wait(\s|$)", code, re.M)):
                self.fail("P22", f"{name}: background jobs and wait only in {lib_name} (prov_run_app, prov_reap)")
        if len(bg.findall(lib)) != 1 or not re.search(r"^  \) &$", fns.get("prov_run_app", ""), re.M):
            self.fail("P22", f"{lib_name}: exactly one background job, the `( prov_unit … ) &` of prov_run_app()")
        waits = [l.strip() for l in lib.splitlines() if re.search(r"(^|[\s;(])wait(\s|$)", l)]
        if waits != ["wait -n -p pid || true"] or "wait -n -p pid" not in fns.get("prov_reap", ""):
            self.fail("P22", f"{lib_name}: `wait -n -p pid` only in prov_reap() (got {waits})")
        finish = [l.strip() for l in fns.get("prov_finish", "").splitlines() if l.strip() and not l.strip().startswith("local ")]
        if not finish or finish[0] != "prov_join":
            self.fail("P22", f"{lib_name}: prov_finish() starts with prov_join (every unit has ended before the totals)")
        post = scripts.get(PROV_SCRIPTS + "azure-post.sh", "")
        if not re.search(r"^done\n(#[^\n]*\n)*prov_join\nportal_endpoints\nprov_finish\n?$", post, re.M):
            self.fail("P22", "azure-post.sh: prov_join between the release loop and portal_endpoints")
        pe = shell_functions(post).get("portal_endpoints", "")
        if not re.search(r"\n  done\n  prov_join\n", pe) or pe.find("prov_join") > pe.find("portal_endpoints_left"):
            self.fail("P22", "azure-post.sh: portal_endpoints() calls prov_join after its loop, before portal_endpoints_left")
        plan = scripts.get(PROV_SCRIPTS + "entra-plan.sh", "")
        if not re.search(r"^done\nprov_join\n", plan, re.M) or plan.find("prov_join") > plan.find("entra-needed.txt\"\n"):
            self.fail("P22", "entra-plan.sh: prov_join after its loops, before it writes entra-needed.txt")
        # Shared resources: one deployment at a time.
        for what, lock in (("prov_arm create frontdoor", "prov_lock frontdoor"), ("prov_arm create portal-endpoint", "prov_lock portal-endpoint")):
            lines = [l.strip() for l in post.splitlines()]
            idx = [i for i, l in enumerate(lines) if l.startswith(what + " ")]
            if len(idx) != 1 or lines[idx[0] - 1] != lock or lines[idx[0] + 1] != "prov_unlock":
                self.fail("P22", f"azure-post.sh: `{what}` directly between `{lock}` and `prov_unlock`")
        lines = [l.strip() for l in post.splitlines()]
        token = [i for i, l in enumerate(lines) if l == "prov_arm_token"]
        if len(token) != 1 or lines[token[0] - 1] != 'prov_lock "dbinit-$job"' or lines[token[0] + 3] != "prov_unlock":
            self.fail("P22", 'azure-post.sh: the dbinit hand-off directly between `prov_lock "dbinit-$job"` and `prov_unlock`')
        # ADR-0061: the Easy Auth secret's delete through the kvset job, one execution at a time.
        lines = [l.strip() for l in logical_lines(scripts.get(PROV_SCRIPTS + "azure.sh", ""))]
        token = [i for i, l in enumerate(lines) if l == "prov_arm_token"]
        if len(token) != 1 or lines[token[0] - 1] != 'prov_lock "kvset-$job"' or token[0] + 3 >= len(lines) or lines[token[0] + 3] != "prov_unlock":
            self.fail("P22", 'azure.sh: the Easy Auth secret\'s delete hand-off directly between `prov_lock "kvset-$job"` and `prov_unlock`')
        names_fn = fns.get("prov_names", "")
        if '"$prov_names_param"' in names_fn.replace('cp "$prov_names_param"', "") \
                or not re.search(r'param="\$\(mktemp --suffix=\.bicepparam "\$\{prov_names_param%\.bicepparam\}\.X+"\)"', names_fn) \
                or 'bicep snapshot "$param"' not in names_fn:
            self.fail("P22", f"{lib_name}: prov_names() snapshots its own mktemp copy of names.bicepparam")
        # The scope only widens the run.
        for rel, text in self.repo.files.items():
            if not rel.endswith((".yml", ".yaml")) or rel.startswith("@"):
                continue
            uses = [l.strip() for l in text.splitlines() if "parameters.scope" in l and not l.lstrip().startswith("#")]
            want = {PROV_ENTRY: ["scope: ${{ parameters.scope }}"],
                    "templates/provisioning/stages/validate.yml": ["SAF_SCOPE: ${{ parameters.scope }}"]}.get(rel, [])
            if uses != want:
                self.fail("P22", f"{rel}: parameters.scope is only passed to validate.yml and mapped to SAF_SCOPE there (got {uses})")
        # The upgrade (ADR-0049) only widens the run too, and reaches validate.sh only.
        for rel, text in self.repo.files.items():
            if not rel.endswith((".yml", ".yaml")) or rel.startswith("@"):
                continue
            uses = [l.strip() for l in text.splitlines() if "parameters.upgrade" in l and not l.lstrip().startswith("#")]
            want = {PROV_ENTRY: ["upgrade: ${{ parameters.upgrade }}"],
                    "templates/provisioning/stages/validate.yml": ["SAF_UPGRADE: ${{ parameters.upgrade }}"]}.get(rel, [])
            if uses != want:
                self.fail("P22", f"{rel}: parameters.upgrade is only passed to validate.yml and mapped to SAF_UPGRADE there (got {uses})")
        venv = [l.strip() for l in self.repo.files.get("templates/provisioning/stages/validate.yml", "").splitlines()
                if l.strip().startswith(("SAF_SCOPE:", "SAF_UPGRADE:", "SAF_SOURCE_BRANCH:"))]
        if sorted(venv) != ["SAF_SCOPE: ${{ parameters.scope }}", "SAF_SOURCE_BRANCH: $(Build.SourceBranch)", "SAF_UPGRADE: ${{ parameters.upgrade }}"]:
            self.fail("P22", "validate.yml: the validate step maps SAF_SOURCE_BRANCH: $(Build.SourceBranch) beside SAF_SCOPE and SAF_UPGRADE")
        val = re.sub(r"\\\n\s*", " ", scripts.get(PROV_SCRIPTS + "validate.sh", ""))
        if not re.search(r"provisioning validate-run [^\n]*--source-branch \"\$SAF_SOURCE_BRANCH\"", val) \
                or not re.search(r"provisioning apps [^\n]*--scope \"\$SAF_SCOPE\"", val):
            self.fail("P22", "validate.sh passes --source-branch \"$SAF_SOURCE_BRANCH\" to validate-run and --scope \"$SAF_SCOPE\" to apps")
        if not re.search(r"provisioning validate-run [^\n]*--upgrades \"\$SAF_CORE/infra/app/upgrades\.yaml\" [^\n]*--upgrade \"\$SAF_UPGRADE\" --apps-dir \"\$SAF_CONFIG/apps\"", val) \
                or not re.search(r"provisioning apps [^\n]*--upgrade \"\$SAF_UPGRADE\"", val):
            self.fail("P22", "validate.sh passes --upgrades \"$SAF_CORE/infra/app/upgrades.yaml\", --upgrade \"$SAF_UPGRADE\" and "
                             "--apps-dir \"$SAF_CONFIG/apps\" to validate-run and --upgrade \"$SAF_UPGRADE\" to apps")
        dec = scripts.get(PROV_SCRIPTS + "decide.sh", "")
        if not re.search(r"args=\(provisioning plan-units [^)]*--upgrades \"\$SAF_CORE/infra/app/upgrades\.yaml\"", dec):
            self.fail("P22", "decide.sh passes --upgrades \"$SAF_CORE/infra/app/upgrades.yaml\" to plan-units")
        for name, code in scripts.items():
            base = name[len(PROV_SCRIPTS):] if name.startswith(PROV_SCRIPTS) else None
            if "SAF_UPGRADE" in code and base != "validate.sh":
                self.fail("P22", f"{name}: SAF_UPGRADE reaches validate.sh only (the plan reads the parameter from plan/apps.json)")
            if base is not None and base != "report.sh" and re.search(r"\.upgrade\b", code):
                self.fail("P22", f"{name}: no provisioning script reads the parameter upgrade (.upgrade); the plan does, report.sh shows it")
        # Provisioning by unit (ADR-0048): the plan decides, the stages filter, record writes the tags.
        unit_helpers = ("prov_units_check", "prov_unit_runs", "prov_planned", "prov_post_runs", "prov_entry_dir",
                        "prov_entra_dir", "prov_entra_work", "prov_lz_ok", "prov_post_ok", "prov_unit_tag",
                        "prov_tags_restore", "prov_unit_finished")
        for helper in unit_helpers:
            if helper not in fns:
                self.fail("P22", f"{lib_name} must define {helper}()")
        for name, code in scripts.items():
            if not name.startswith(PROV_SCRIPTS):
                continue
            base = name[len(PROV_SCRIPTS):]
            if "checkAllApps" in code:
                self.fail("P22", f"{name}: no provisioning script reads checkAllApps (the plan does: it only widens the run)")
            if "SAF_UNITS_JSON" in code and base not in ("prov-lib.sh", "record.sh", "report.sh"):
                self.fail("P22", f"{name}: the plan (SAF_UNITS_JSON) is read through the prov-lib.sh helpers")
            for line in logical_lines(code):
                if re.search(r"saf-u-\$|saf-u-[a-z]+=", line) and not (
                        (base == "prov-lib.sh" and line.strip() in ('[ -z "$v" ] || tags+=("saf-u-$u=$v")', '[ -z "$files" ] || tags+=("saf-u-files=$files")'))
                        or (base == "record.sh" and line.strip() in ('writes+=("saf-u-$u=$value")', 'if [ -n "$old" ]; then deletes+=("saf-u-$u=$old"); fi',
                                                                     'writes+=("saf-u-$u=$rebase")',
                                                                     'if [[ "$retired" =~ ^[0-9]{8}$ ]] && [[ " $finished " == *" release "* ]]; then writes+=("saf-u-retired=$retired"); fi',
                                                                     'if [[ "$retired" =~ ^[0-9]{8}$ ]]; then deletes+=("saf-u-retired=$retired"); fi',
                                                                     'if [ "${#writes[@]}" -gt 0 ] && [ -n "$files" ]; then writes+=("saf-u-files=$files"); fi'))):
                    self.fail("P22", f"{name}: the tags saf-u-<unit> and saf-u-files are written only by prov_tags_restore() (prov-lib.sh) "
                                     f"and record_tags() (record.sh): {line.strip()[:80]}")
                if "saf-provisioned" in line and not (base == "record.sh" and "deletes+=(\"saf-provisioned=$legacy\")" in line):
                    self.fail("P22", f"{name}: the retired tag saf-provisioned is only deleted, by record.sh")
            if base in ("azure.sh", "ado.sh", "entra-plan.sh", "entra.sh", "azure-post.sh", "record.sh", "report.sh"):
                check, loop = code.find("\nprov_units_check\n"), code.find("\nfor slug in ")
                if check < 0 or (loop >= 0 and check > loop):
                    self.fail("P22", f"{name}: prov_units_check at the top level before the app loop")
            if base in ("azure.sh", "ado.sh", "entra-plan.sh", "azure-post.sh", "record.sh") and "prov_unit_runs" not in code:
                self.fail("P22", f"{name}: the stage processes exactly the units the plan gives it (prov_unit_runs)")
        restore = fns.get("prov_tags_restore", "")
        if "--operation merge" not in restore or "prov_unit_tag" not in restore or 'prov_files_tag "$slug" "$env_name" filesTag' not in restore:
            self.fail("P22", f"{lib_name}: prov_tags_restore() merges the tags the plan read (prov_unit_tag ... tag, prov_files_tag ... filesTag)")
        lz = fns.get("prov_lz", "")
        if not re.search(r'prov_arm create lz [^\n]*\n(\s+[^\n]*\n){0,2}\s+prov_tags_restore ', lz):
            self.fail("P22", f"{lib_name}: prov_lz() writes the unit tags back right after a landing-zone deployment (prov_tags_restore)")
        record = shell_functions(scripts.get(PROV_SCRIPTS + "record.sh", "")).get("record_tags", "")
        if not re.search(r"prov_unit_tag [^\n]* record\)", record) or "prov_unit_finished" not in record \
                or "--operation merge" not in record or "--operation delete" not in record \
                or not re.search(r"prov_unit_tag [^\n]* rebase\)", record) or 'prov_files_tag "$slug" "$env_name" files)' not in record:
            self.fail("P22", "record.sh record_tags(): a finished unit gets the plan's record value (prov_unit_finished), "
                             "one that ran and didn't finish loses its tag (--operation delete), a held one its rebase value, "
                             "and saf-u-files the plan's files value (ADR-0049)")


# ---------------------------------------------------------------------------------------------
# Template expansion (subset of the Azure Pipelines template expression language), used to
# expand the scenarios. Unsupported syntax raises TemplateError, which fails the scenario.
# ---------------------------------------------------------------------------------------------
class TemplateError(Exception):
    pass


class Star(list):
    """Result of `x.*`: property access maps over the items (filtered arrays)."""


TOKEN = re.compile(r"\s*(?:(?P<str>'(?:[^']|'')*')|(?P<num>-?\d+(?:\.\d+)?)"
                   r"|(?P<id>[A-Za-z_][A-Za-z0-9_-]*)|(?P<op>[.\[\](),*]))")
EXPR = re.compile(r"\$\{\{(.*?)\}\}", re.S)
WHOLE = re.compile(r"^\s*\$\{\{((?:(?!\}\}).)*)\}\}\s*$", re.S)


def parse_expr(text: str):
    tokens, pos, text = [], 0, text.strip()
    while pos < len(text):
        m = TOKEN.match(text, pos)
        if not m or m.end() == pos:
            raise TemplateError(f"cannot parse expression {text!r}")
        tokens.append((m.lastgroup, m.group(m.lastgroup)))
        pos = m.end()
    i = 0

    def peek():
        return tokens[i] if i < len(tokens) else (None, None)

    def take(val=None):
        nonlocal i
        tok = peek()
        if tok[0] is None or (val is not None and tok[1] != val):
            raise TemplateError(f"expected {val!r} in {text!r}")
        i += 1
        return tok

    def expr():
        kind, val = take()
        if kind == "str":
            node = ("lit", val[1:-1].replace("''", "'"))
        elif kind == "num":
            node = ("lit", val)
        elif kind == "id":
            if peek()[1] == "(":
                take("(")
                args = []
                if peek()[1] != ")":
                    args.append(expr())
                    while peek()[1] == ",":
                        take(",")
                        args.append(expr())
                take(")")
                node = ("call", val.lower(), args)
            elif val.lower() in ("true", "false"):
                node = ("lit", val.lower() == "true")
            elif val.lower() == "null":
                node = ("lit", None)
            else:
                node = ("var", val)
        else:
            raise TemplateError(f"unexpected {val!r} in {text!r}")
        while peek()[1] in (".", "["):
            if take()[1] == ".":
                kind2, val2 = take()
                node = ("star", node) if val2 == "*" else ("prop", node, ("lit", val2))
            else:
                index = expr()
                take("]")
                node = ("prop", node, index)
        return node

    node = expr()
    if i != len(tokens):
        raise TemplateError(f"trailing tokens in {text!r}")
    return node


def to_str(v) -> str:
    if v is None:
        return ""
    if isinstance(v, bool):
        return "True" if v else "False"
    if isinstance(v, (dict, list)):
        return json.dumps(v)
    return str(v)


def truthy(v) -> bool:
    if isinstance(v, bool):
        return v
    if v is None:
        return False
    if isinstance(v, str):
        return v != ""
    return True


def equal(a, b) -> bool:
    if isinstance(a, (dict, list)) or isinstance(b, (dict, list)):
        return a == b
    return to_str(a).casefold() == to_str(b).casefold()


def items(v) -> list:
    if isinstance(v, dict):
        return list(v.values())
    if isinstance(v, list):
        return list(v)
    return []


def getprop(base, key):
    if isinstance(base, Star):
        return Star(getprop(b, key) for b in base)
    if isinstance(base, dict):
        for k, v in base.items():
            if str(k).casefold() == to_str(key).casefold():
                return v
        return None
    if isinstance(base, list):
        try:
            return base[int(key)]
        except (ValueError, IndexError):
            return None
    return None


def evaluate(node, ctx: dict):
    kind = node[0]
    if kind == "lit":
        return node[1]
    if kind == "var":
        for k, v in ctx.items():
            if k.casefold() == node[1].casefold():
                return v
        raise TemplateError(f"unknown name {node[1]!r}")
    if kind == "prop":
        return getprop(evaluate(node[1], ctx), evaluate(node[2], ctx))
    if kind == "star":
        return Star(items(evaluate(node[1], ctx)))
    name, args = node[1], [evaluate(a, ctx) for a in node[2]]
    if name == "eq":
        return equal(args[0], args[1])
    if name == "ne":
        return not equal(args[0], args[1])
    if name == "and":
        return all(truthy(a) for a in args)
    if name == "or":
        return any(truthy(a) for a in args)
    if name == "not":
        return not truthy(args[0])
    if name in ("le", "lt", "ge", "gt"):
        try:
            a, b = float(to_str(args[0])), float(to_str(args[1]))
        except ValueError as exc:
            raise TemplateError(f"{name}() needs numbers") from exc
        return {"le": a <= b, "lt": a < b, "ge": a >= b, "gt": a > b}[name]
    if name == "in":
        return any(equal(args[0], b) for b in args[1:])
    if name == "notin":
        return not any(equal(args[0], b) for b in args[1:])
    if name == "startswith":
        return to_str(args[0]).casefold().startswith(to_str(args[1]).casefold())
    if name == "endswith":
        return to_str(args[0]).casefold().endswith(to_str(args[1]).casefold())
    if name == "contains":
        if isinstance(args[0], list):
            return any(equal(x, args[1]) for x in args[0])
        return to_str(args[1]).casefold() in to_str(args[0]).casefold()
    if name == "containsvalue":
        return any(equal(x, args[1]) for x in items(args[0]))
    if name == "format":
        fmt = to_str(args[0])
        return re.sub(r"\{(\d+)\}", lambda m: to_str(args[1 + int(m.group(1))]), fmt)
    if name == "length":
        return len(args[0]) if isinstance(args[0], (list, dict, str)) else 0
    if name == "converttojson":
        return json.dumps(args[0], indent=2)
    if name == "join":
        return to_str(args[0]).join(to_str(x) for x in items(args[1]))
    if name == "replace":
        return to_str(args[0]).replace(to_str(args[1]), to_str(args[2]))
    if name == "coalesce":
        return next((a for a in args if a not in (None, "")), None)
    if name == "split":
        # Azure Pipelines splits by the whole delimiter string and keeps empty parts.
        return to_str(args[0]).split(to_str(args[1]))
    raise TemplateError(f"function {name}() is not supported by the test expander")


def directive(key):
    if not isinstance(key, str):
        return None
    m = WHOLE.match(key)
    if not m:
        return None
    inner = m.group(1).strip()
    low = inner.lower()
    if low.startswith("if "):
        return "if", inner[3:]
    if low.startswith("elseif "):
        return "elseif", inner[7:]
    if low == "else":
        return "else", None
    m2 = re.match(r"(?is)each\s+(\w+)\s+in\s+(.+)$", inner)
    if m2:
        return "each", (m2.group(1), m2.group(2))
    if low == "insert":
        return "insert", None
    return "key", inner


class Expander:
    def __init__(self, repo: Repo):
        self.repo = repo

    def pipeline(self, params: dict, entry: str = ENTRY) -> tuple[list[dict], list[str]]:
        try:
            doc = self.load(entry)
            ctx = {"parameters": self.bind(entry, doc, params), "__file__": entry}
            body = self.x({k: v for k, v in doc.items() if k != "parameters"}, ctx)
        except TemplateError as exc:
            return [], [str(exc)]
        stages, errors = [], []
        for st in body.get("stages") or []:
            if isinstance(st, dict) and "stage" in st:
                stages.append(st)
            else:
                errors.append(next(iter(st)) if isinstance(st, dict) and st else repr(st))
        return stages, errors

    def load(self, rel: str) -> dict:
        if rel not in self.repo.files:
            raise TemplateError(f"template {rel} not found")
        doc, errs = load_yaml(self.repo.files[rel], rel)
        if errs or not isinstance(doc, dict):
            raise TemplateError(f"template {rel} does not load")
        return doc

    def bind(self, rel: str, doc: dict, given: dict) -> dict:
        declared = {p["name"]: p for p in doc.get("parameters") or [] if isinstance(p, dict)}
        unknown = set(given) - set(declared)
        if unknown:
            raise TemplateError(f"{rel}: unexpected parameter(s) {sorted(unknown)}")
        bound = {}
        for name, decl in declared.items():
            if name in given:
                value = given[name]
            elif "default" in decl:
                value = decl["default"]
            else:
                raise TemplateError(f"{rel}: missing parameter {name}")
            kind = str(decl.get("type", "string")).lower()
            if kind == "number":
                try:
                    number = float(to_str(value))
                except ValueError as exc:
                    raise TemplateError(f"{rel}: parameter {name} must be a number") from exc
                value = int(number) if number.is_integer() else number
            elif kind == "string" and isinstance(value, (dict, list)):
                raise TemplateError(f"{rel}: parameter {name} must be a string")
            if "values" in decl and not any(equal(value, v) for v in decl["values"]):
                raise TemplateError(f"{rel}: parameter {name}: value {to_str(value)!r} is not allowed")
            bound[name] = value
        return bound

    def interp(self, text: str, ctx: dict):
        m = WHOLE.match(text)
        if m:
            return evaluate(parse_expr(m.group(1)), ctx)
        return EXPR.sub(lambda mm: to_str(evaluate(parse_expr(mm.group(1)), ctx)), text)

    def x(self, node, ctx: dict):
        if isinstance(node, str):
            return self.interp(node, ctx)
        if isinstance(node, list):
            return self.xseq(node, ctx)
        if isinstance(node, dict):
            return self.xmap(node, ctx)
        return node

    def as_list(self, value, ctx: dict) -> list:
        out = self.x(value, ctx)
        return out if isinstance(out, list) else [out]

    def xseq(self, seq: list, ctx: dict) -> list:
        out: list = []
        chain = None
        for item in seq:
            d = directive(next(iter(item))) if isinstance(item, dict) and len(item) == 1 else None
            if d and d[0] in ("if", "elseif", "else", "each", "insert"):
                kind, arg = d
                value = next(iter(item.values()))
                if kind == "if":
                    chain = truthy(evaluate(parse_expr(arg), ctx))
                    if chain:
                        out.extend(self.as_list(value, ctx))
                elif kind == "elseif":
                    if chain is None:
                        raise TemplateError("elseif without if")
                    if not chain and truthy(evaluate(parse_expr(arg), ctx)):
                        chain = True
                        out.extend(self.as_list(value, ctx))
                elif kind == "else":
                    if chain is None:
                        raise TemplateError("else without if")
                    if not chain:
                        out.extend(self.as_list(value, ctx))
                    chain = None
                elif kind == "each":
                    chain = None
                    var, coll = arg
                    for it in items(evaluate(parse_expr(coll), ctx)):
                        out.extend(self.as_list(value, {**ctx, var: it}))
                else:
                    raise TemplateError("insert in a sequence")
                continue
            chain = None
            if isinstance(item, dict) and isinstance(item.get("template"), str):
                out.extend(self.include(item, ctx))
            else:
                out.append(self.x(item, ctx))
        return out

    def xmap(self, mapping: dict, ctx: dict) -> dict:
        out: dict = {}
        chain = None
        for key, value in mapping.items():
            d = directive(key)
            kind = d[0] if d else None
            if kind in ("if", "elseif", "else", "each", "insert"):
                arg = d[1]
                if kind == "if":
                    chain = truthy(evaluate(parse_expr(arg), ctx))
                    if chain:
                        out.update(self.x(value, ctx))
                elif kind == "elseif":
                    if not chain and truthy(evaluate(parse_expr(arg), ctx)):
                        chain = True
                        out.update(self.x(value, ctx))
                elif kind == "else":
                    if not chain:
                        out.update(self.x(value, ctx))
                    chain = None
                elif kind == "each":
                    var, coll = arg
                    for it in items(evaluate(parse_expr(coll), ctx)):
                        out.update(self.x(value, {**ctx, var: it}))
                else:
                    out.update(self.x(value, ctx))
                continue
            chain = None
            new_key = to_str(self.interp(key, ctx)) if isinstance(key, str) else key
            out[new_key] = self.x(value, ctx)
        return out

    def include(self, item: dict, ctx: dict) -> list:
        ref = to_str(self.interp(item["template"], ctx))
        if "@" in ref:
            raise TemplateError(f"template {ref} from another repository")
        rel = Checker.resolve(ctx["__file__"], ref)
        doc = self.load(rel)
        params = self.x(item.get("parameters") or {}, ctx)
        tctx = {"parameters": self.bind(rel, doc, params), "__file__": rel}
        body = self.x({k: v for k, v in doc.items() if k != "parameters"}, tctx)
        for key in ("stages", "jobs", "steps"):
            if key in body:
                return body[key] or []
        raise TemplateError(f"{rel} has no stages, jobs or steps")


def report_curl_problems(line: str) -> list[str]:
    """What the one curl call of report.sh (T13) lacks or must not have."""
    problems = []
    for want in ("--proto '=https'", "--request POST", '--header @"$hdr"', "--max-time ", '"$url"'):
        if want not in line:
            problems.append(f"needs {want}")
    for bad, label in ((r"--location\b|\s-[A-Za-z]*L\b", "redirects (--location)"),
                       (r"--insecure\b|--proxy-insecure\b|\s-[A-Za-z]*k\b", "insecure TLS (--insecure)"),
                       (r"Authorization|\$\{?token\b|--user\b|\s-u\s|--oauth2-bearer\b", "a credential on the command line")):
        if re.search(bad, line):
            problems.append(f"must not use {label}")
    return problems


def strip_comments(text: str) -> str:
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def shell_functions(code: str) -> dict[str, str]:
    """name -> body of the top-level functions `name() {` ... `}` (column 0) or `name() { ...; }`."""
    bodies: dict[str, str] = {}
    current: str | None = None
    for line in code.splitlines():
        if current is not None:
            if line == "}":
                current = None
            else:
                bodies[current] += line + "\n"
            continue
        m = re.match(r"^(\w+)\(\)\s*\{(.*)$", line)
        if not m:
            continue
        if m.group(2).rstrip().endswith("}"):
            bodies[m.group(1)] = m.group(2).rstrip()[:-1]
        else:
            current = m.group(1)
            bodies[current] = m.group(2) + "\n"
    return bodies


def logical_lines(text: str) -> list[str]:
    """Joins backslash continuations so one command is one line."""
    return [l for l in re.sub(r"\\\n\s*", " ", text).splitlines() if l.strip()]


# -- P26: every mutating call of a script, keyed by file, enclosing function and command (ADR-0052) --
# az <group words> <verb>: the group words are plain words (no option), at most five.
MUT_AZ = re.compile(r"\baz((?:\s+[a-z][a-z0-9-]*){1,5}?)\s+(create|update|delete|import|restart|start|stop|approve|reject|purge|set|add|remove)\b")
MUT_AZ_REST_METHOD = re.compile(r"(?:--method|-m)(?:\s+|=)[\"']?([A-Za-z]+)")
# The platform CLI's subcommands that write (Azure, Microsoft Graph or Azure DevOps).
MUT_PLATFORM = re.compile(r"\b(provisioning\s+(?:easyauth-secret|easyauth-delete|entra-reconcile|entra-delete|dbinit)|ado\s+(?:apply|bootstrap|remove)|pipeline\s+retention-lease)\b")


def script_mutations(code: str) -> list[tuple[str, str, str]]:
    """(enclosing function or <top>, normalised command, line) of every mutating call in a script
    (comments stripped, continuations joined): az … create|update|delete|import|restart|start|stop|
    approve|reject|purge|set|add|remove, az tag update, az rest without a literal GET method, and
    the platform subcommands that write."""
    out: list[tuple[str, str, str]] = []
    func = "<top>"
    arm = ""
    for line in logical_lines(strip_comments(code)):
        m = re.match(r"^(\w+)\(\)\s*\{", line)
        if m:
            func, arm = m.group(1), ""
            if line.rstrip().endswith("}") and line.count("{") == line.count("}"):
                body = line[m.end():]
                out.extend((func, cmd, line) for cmd in _mutating_commands(body))
                func = "<top>"
            continue
        if line == "}":
            func, arm = "<top>", ""
            continue
        # A dispatcher's case arm (prov_arm `create/lz)`, plat_arm `create)`) names the call apart.
        a = re.match(r"^\s*((?:validate|what-if|create)(?:/[a-z][a-z-]*)?)\)\s*$", line)
        if a:
            arm = a.group(1)
            continue
        # Messages name commands too (saf_die "az acr import ... failed"): not calls.
        if re.match(r"^\s*(saf_die|saf_info|printf|echo|prov_wait|prov_detail)\b", line):
            continue
        where = f"{func}[{arm}]" if arm else func
        out.extend((where, cmd, line) for cmd in _mutating_commands(line))
    return out


def _mutating_commands(line: str) -> list[str]:
    cmds: list[str] = []
    for m in re.finditer(r"\baz\s+rest\b", line):
        method = MUT_AZ_REST_METHOD.search(line[m.end():])
        verb = method.group(1).lower() if method else ""
        if verb != "get":
            cmds.append(f"az rest --method {verb or '?'}")
    for m in MUT_AZ.finditer(line):
        words = m.group(1).split()
        if words and words[0] == "rest":
            continue
        cmds.append("az " + " ".join(words + [m.group(2)]))
    for m in MUT_PLATFORM.finditer(line):
        cmds.append("platform " + " ".join(m.group(1).split()))
    return cmds


class Guard(NamedTuple):
    """In `function` of `file`, every line matching `call` follows a line matching `before`; with
    `call` empty, the function only has to contain `before` (a predicate the call relies on)."""
    file: str
    function: str
    before: str
    call: str = ""


class Mutation(NamedTuple):
    """What a mutating call writes (target pattern), where (scope), why, and the guards of a call that
    writes in a shared scope (ADR-0052: never another app's object)."""
    target: str
    scope: str  # app | shared | platform | agent | read
    reason: str
    guards: tuple[Guard, ...] = ()


MUTATION_SCOPES = {"app", "shared", "platform", "agent", "read"}
_POST = "scripts/provisioning/azure-post.sh"
_LIB = "scripts/provisioning/prov-lib.sh"
_ENTRA = "scripts/provisioning/entra.sh"
_AZURE = "scripts/provisioning/azure.sh"
# Every mutating call of scripts/**/*.sh, keyed by (file, enclosing function[case arm], command).
SCRIPT_MUTATIONS: dict[tuple[str, str, str], Mutation] = {
    # -- delivery (ADR-0029): the app's own registry and release ------------------------------------
    ("scripts/deploy.sh", "publish_import", "az acr import"): Mutation(
        "the app's registry in the target environment, its repository, by digest from the app's registry of promoteFrom",
        "app", "promotion by digest (ADR-0029); the source registry check belongs to the delivery script"),
    ("scripts/deploy.sh", "<top>", "az deployment group create"): Mutation(
        "release-{slug} in rg-{prefix}-app-{slug}-{env} (release.bicepparam)", "app", "the delivery's release (ADR-0029)"),
    ("scripts/lib.sh", "saf_bicep_pin_check", "az config set"): Mutation(
        "the agent's az configuration (bicep.use_binary_from_path)", "agent", "use the pinned Bicep binary (P11)"),
    ("scripts/retain.sh", "<top>", "platform pipeline retention-lease"): Mutation(
        "a retention lease on the app's own delivery run", "app", "keep the source run of a production deploy (T28)"),
    # -- platform pipeline (ADR-0043): one environment's shared resources, after its Approval --------
    ("scripts/platform/plat-lib.sh", "plat_arm[create]", "az deployment sub create"): Mutation(
        "the environment deployment of environment.bicep, and in the portal host the portal deployment of portal.bicep, at "
        "subscription scope", "platform",
        "the environment's shared resources and the portal, deployed only as approved (E05, E06, E16)",
        (Guard("scripts/platform/deploy.sh", "<top>", r"jq -e --slurpfile a \"\$approved\" '\. == \$a\[0\]'", r"^\s*plat_arm create "),
         Guard("scripts/platform/deploy.sh", "deploy_portal", r"jq -e --slurpfile a \"\$approved_portal\" '\. == \$a\[0\]'", r"^\s*plat_arm create "))),
    ("scripts/platform/deploy.sh", "<top>", "az acr import"): Mutation(
        "the saf-jobs image into the environment's platform registry, by digest", "platform",
        "the platform jobs' image (E08), after the approved plan's check",
        (Guard("scripts/platform/deploy.sh", "<top>", r"jq -e --slurpfile a \"\$approved\" '\. == \$a\[0\]'", r"\baz acr import\b"),)),
    ("scripts/platform/deploy.sh", "deploy_portal", "az acr import"): Mutation(
        "the saf-portal image into the portal host's platform registry, by digest", "platform",
        "the portal's image (E08, E16), after the approved portal inputs' check",
        (Guard("scripts/platform/deploy.sh", "deploy_portal", r"jq -e --slurpfile a \"\$approved_portal\" '\. == \$a\[0\]'", r"\baz acr import\b"),)),
    # -- provisioning: the app's own resources ---------------------------------------------------------
    (_LIB, "prov_arm[create/lz]", "az deployment sub create"): Mutation(
        "lz-{slug}-{env} at subscription scope: rg-{prefix}-app-{slug}-{env} and the app-named children check-infra.py item 17 allows",
        "app", "the landing zone (ADR-0032); its writes outside the app RG are held by check-infra.py item 17"),
    (_LIB, "prov_arm[create/release]", "az deployment group create"): Mutation(
        "release-{slug} in the app resource group", "app", "bootstrap or re-apply of the release (ADR-0032)"),
    (_LIB, "prov_entra_expected", "az rest --method post"): Mutation(
        "/providers/Microsoft.Resources/calculateTemplateHash", "read", "a POST that computes a hash and changes nothing (P06)"),
    (_LIB, "prov_tags_restore", "az tag update"): Mutation(
        "the tags saf-u-* of rg-{prefix}-app-{slug}-{env}", "app", "unit tags back after a landing-zone deployment (ADR-0048)",
        (Guard(_LIB, "prov_tags_restore", r'if \[ "\$rg" != "\$\(prov_name "\$names" appResourceGroup\)" \]; then', r"\baz tag update\b"),)),
    ("scripts/provisioning/record.sh", "record_tags", "az tag update"): Mutation(
        "the tags saf-u-* of rg-{prefix}-app-{slug}-{env}", "app", "the unit records (ADR-0048 section 3)",
        (Guard("scripts/provisioning/record.sh", "record_tags", r"\.appResourceGroups\[\$s\]", r"\baz tag update\b"),)),
    ("scripts/provisioning/registry.sh", "purge_app", "az acr manifest delete"): Mutation(
        "a manifest of the app's repository {slug} in its own build-environment registry, found in rg-{prefix}-app-{slug}-{env} by naming",
        "app", "the registry image purge (ADR-0059): only the digests `platform provisioning registry-purge` returned",
        (Guard("scripts/provisioning/registry.sh", "purge_app", r'az acr show --name "\$registry" --resource-group "\$rg"', r"\baz acr manifest delete\b"),
         Guard("scripts/provisioning/registry.sh", "purge_app", r"saf_cli provisioning registry-purge --plan ", r"\baz acr manifest delete\b"))),
    ("scripts/provisioning/registry.sh", "purge_app", "az tag update"): Mutation(
        "the tag saf-registry-purge of rg-{prefix}-app-{slug}-{env}", "app", "the last registry purge's day and mode (ADR-0059)",
        (Guard("scripts/provisioning/registry.sh", "purge_app", r"\.appResourceGroups\[\$s\]", r"\baz tag update\b"),)),
    ("scripts/provisioning/ado.sh", "ado_apply", "platform ado apply"): Mutation(
        "the app's Azure DevOps objects (environments, service connections, pipeline)", "app", "unit ado (ADR-0039)"),
    (_POST, "import_placeholder", "az acr import"): Mutation(
        "saf-placeholder by digest into the app's registry", "app", "bootstrap release (ADR-0030)"),
    (_POST, "restart_stale", "az tag update"): Mutation(
        "the tag saf-easyauth of ca-{slug}", "app", "the version the app runs with (ADR-0041)",
        (Guard(_POST, "restart_stale", r'app_id="/subscriptions/\$subscription/resourceGroups/\$rg/providers/Microsoft\.App/containerApps/\$container_app"', r"\baz tag update\b"),)),
    (_POST, "restart_stale", "az rest --method post"): Mutation(
        "{ca-{slug}}/revisions/{revision}/restart", "app", "the restart after an Easy Auth rotation (ADR-0041), planned in the maintenance window",
        (Guard(_POST, "restart_stale", r'app_id="/subscriptions/\$subscription/resourceGroups/\$rg/providers/Microsoft\.App/containerApps/\$container_app"', r"/restart\?"),)),
    (_POST, "database_entry", "az tag update"): Mutation(
        "the tag saf-dbinit of the app's database server", "app", "dbinit once per landing-zone change (ADR-0028)",
        (Guard(_POST, "database_entry", r'\[ "\$rg" = "\$\(prov_name "\$names" appResourceGroup\)" \]', r'\baz tag update --resource-id "\$server_id"'),)),
    (_POST, "portal_endpoint_approve", "az keyvault private-endpoint-connection approve"): Mutation(
        "the Pending connection of pep-{vault}-portal on the app's vault", "app", "the portal-side endpoint in another subscription (ADR-0025)",
        (Guard(_POST, "portal_endpoint_approve", r'\[ "\$rg" = "\$\(prov_name "\$PROV_DIR/names-\$slug\.json" appResourceGroup\)" \]', r"private-endpoint-connection approve"),
         Guard(_POST, "portal_endpoint_approve", r'"\$\{vault_id,,\}/privateendpointconnections/"', r"private-endpoint-connection approve"))),
    # -- decommissioning (ADR-0056): the app's own objects ----------------------------------------------
    (_POST, "retire_step", "az rest --method post"): Mutation(
        "{ca-{slug}}/stop: the app's own Container App", "app", "the retire of a decommissioned app (reversible: start)",
        (Guard(_POST, "retire_step", r'\[ "\$rg" = "\$\(prov_name "\$names" appResourceGroup\)" \]', r"/stop\?"),)),
    (_POST, "start_step", "az rest --method post"): Mutation(
        "{ca-{slug}}/start: the app's own Container App", "app", "Cancel of a decommissioning: the stopped app starts again",
        (Guard(_POST, "start_step", r'\[ "\$rg" = "\$\(prov_name "\$names" appResourceGroup\)" \]', r"/start\?"),)),
    (_AZURE, "lz_delete", "az group delete"): Mutation(
        "rg-{prefix}-app-{slug}-{env} with everything in it", "app",
        "step 2 of the delete phase: the app's resource group by naming, with its own tags, without a lock",
        (Guard(_AZURE, "lz_delete", r'rg="\$\(prov_name "\$names" appResourceGroup\)"', r"\baz group delete\b"),
         Guard(_AZURE, "lz_delete", r"\.Application // \"\"' \"\$PROV_DIR/rg-tags\.json\"\)\" != \"\$slug\"", r"\baz group delete\b"),
         Guard(_AZURE, "lz_delete", r"az lock list --resource-group \"\$rg\"", r"\baz group delete\b"))),
    ("scripts/provisioning/record.sh", "lz_record_delete", "az deployment sub delete"): Mutation(
        "the record lz-{slug}-{env} at subscription scope", "app",
        "the landing zone's record, last: after its group and its service connection (sandbox run 3421, ADR-0056 amendment 2026-11-12)",
        (Guard("scripts/provisioning/record.sh", "lz_record_delete", r"\.landingZoneRecords\[\$s\]", r"\baz deployment sub delete\b"),
         Guard("scripts/provisioning/record.sh", "lz_record_delete", r'"connection-\$env_name"', r"\baz deployment sub delete\b"),
         Guard("scripts/provisioning/record.sh", "lz_record_delete", r"az group exists --name \"\$rg\"", r"\baz deployment sub delete\b"))),
    (_LIB, "prov_lz_stale_assignments", "az role assignment delete"): Mutation(
        "role assignments the app's own failed landing zone named, of identities deleted with its resource group",
        "shared", "PE010's clean-up (ADR-0064 amendment 2026-11-17): IDs from the app's own record, its scopes, not a principal it has now",
        (Guard(_LIB, "prov_lz_stale_assignments", r'az identity list --resource-group "\$rg"', r"\baz role assignment delete\b"),
         Guard(_LIB, "prov_lz_stale_assignments", r'az deployment operation sub list --name "\$lz_name"', r"\baz role assignment delete\b"),
         Guard(_LIB, "prov_lz_stale_assignments", r"RoleAssignmentUpdateNotPermitted", r"\baz role assignment delete\b"),
         Guard(_LIB, "prov_lz_stale_assignments", r"microsoft\\\.app/managedenvironments/", r"\baz role assignment delete\b"),
         Guard(_LIB, "prov_lz_stale_assignments", r"secrets/easyauth-\$\{slug\}", r"\baz role assignment delete\b"),
         Guard(_LIB, "prov_lz_stale_assignments", r'grep -qixF "\$principal" "\$PROV_DIR/stale-principals.txt"', r"\baz role assignment delete\b"))),
    (_AZURE, "lz_outside_assignments", "az role assignment delete"): Mutation(
        "role assignments of the app's own identities on its CAE, its Easy Auth secret, its own groups of other environments",
        "shared", "what the landing zone wrote outside its group (ADR-0052 item 2), by the identities' principals",
        (Guard(_AZURE, "lz_outside_assignments", r"az identity list --resource-group \"\$rg\"", r"\baz role assignment delete\b"),
         Guard(_AZURE, "lz_outside_assignments", r"microsoft\\\.app/managedenvironments/", r"\baz role assignment delete\b"),
         Guard(_AZURE, "lz_outside_assignments", r"secrets/easyauth-\$\{slug\}", r"\baz role assignment delete\b"))),
    (_AZURE, "lz_nested_cleanup", "az deployment group delete"): Mutation(
        "joinerOnCae-<13>, easyAuthOnSecret-<13> in rg-{prefix}-platform-{env}: the nested records of lz-{slug}-{env}",
        "shared", "deployment history of the platform resource group (ADR-0052); named by the app's own record's operations",
        (Guard(_AZURE, "lz_nested_cleanup", r"\(joineroncae\|easyauthonsecret\)-\[a-z0-9\]\{13\}", r"\baz deployment group delete\b"),)),
    (_POST, "portal_endpoint_remove", "az network private-endpoint delete"): Mutation(
        "pep-{app vault}-portal in the portal resource group", "shared",
        "the portal-side endpoint of the app's vault (ADR-0025): a decommissioned app's, a previous generation's, or one no longer "
        "VNet-based (amendment 2026-11-14); named for the vault, linking it in the app's resource group",
        (Guard(_POST, "portal_endpoint_remove", r'prov_name "\$names_file" portalVaultEndpoint', r"\bprivate-endpoint delete\b"),
         Guard(_POST, "portal_endpoint_remove", r'prov_name "\$names_file" appResourceGroup', r"\bprivate-endpoint delete\b"),
         Guard(_POST, "portal_endpoint_remove", r'if \[\[ "\$\{target,,\}" != /subscriptions/\*"\$\{vault_id,,\}" \]\]; then', r"\bprivate-endpoint delete\b"),
         Guard(_POST, "portal_endpoint_remove", r"^\s*prov_lock portal-endpoint$", r"\bprivate-endpoint delete\b"))),
    (_POST, "portal_endpoint_forget", "az deployment group delete"): Mutation(
        "the record pep-portal-{slug}-{env} in the portal resource group", "shared", "the endpoint's record, when it names this app and environment",
        (Guard(_POST, "portal_endpoint_forget", r"\.properties\.parameters\.slug\.value == \$s and \.properties\.parameters\.environmentName\.value == \$e", r"\baz deployment group delete\b"),)),
    (_ENTRA, "unregister", "platform provisioning entra-delete"): Mutation(
        "the application {prefix}-{slug}-{env}[--i{incarnation}] and its service principal (Graph); never Entra's recycle bin "
        "(a deleted application keeps its uniqueName there for 30 days, ADR-0061)", "app",
        "the app's own registration by its uniqueName (names.bicep with the app's incarnation from plan/apps.json, never an "
        "earlier app's with the slug); OwnedBy: only what the platform owns",
        (Guard(_ENTRA, "unregister", r'^\s*expected="\$prefix-\$slug-\$app_env"$', r"provisioning entra-delete"),
         Guard(_ENTRA, "unregister", r'\[ "\$incarnation" = 0 \] \|\| expected\+="--i\$incarnation"', r"provisioning entra-delete"),
         Guard(_ENTRA, "unregister", r'\[ "\$unique_name" = "\$expected" \] \|\| saf_die', r"provisioning entra-delete"))),
    (_ENTRA, "unregister", "az deployment group delete"): Mutation(
        "entra-{slug}-{env} in rg-{prefix}-entra-{env} and in rg-{prefix}-entra (a record deployed before ADR-0063)", "shared",
        "the registration's records, after the registration's delete; the name and both groups from names.bicep",
        (Guard(_ENTRA, "unregister", r'entra_name="\$\(prov_name "\$names" entraDeployment\)"', r"\baz deployment group delete\b"),
         Guard(_ENTRA, "unregister", r"jq -e --arg n \"\$unique_name\" '\.uniqueName == \$n'", r"\baz deployment group delete\b"),
         Guard(_ENTRA, "unregister", r'^\s*for entra_rg in "\$\(prov_name "\$names" entraEnvironmentResourceGroup\)" "\$\(prov_name "\$names" entraResourceGroup\)"; do$',
               r"\baz deployment group delete\b"))),
    (_ENTRA, "retire_instance_record", "az deployment group delete"): Mutation(
        "entra-{slug}-{env} in rg-{prefix}-entra: the app's record deployed before ADR-0063", "shared",
        "the record moved (ADR-0063): deleted only after the registration's deployment into its environment's records group "
        "succeeded; the app's own name and the instance's group from names.bicep; a record only, never the registration",
        (Guard(_ENTRA, "retire_instance_record", r'entra_name="\$\(prov_name "\$names" entraDeployment\)"', r"\baz deployment group delete\b"),
         Guard(_ENTRA, "retire_instance_record", r'instance_rg="\$\(prov_name "\$names" entraResourceGroup\)"', r"\baz deployment group delete\b"),
         Guard(_ENTRA, "register", r'^\s*prov_arm create entra "\$inputs" "\$entra_name" "\$entra_rg" ', r"\bretire_instance_record\b"),
         Guard(_ENTRA, "register", r'environment\) entra_rg="\$\(prov_name "\$names" entraEnvironmentResourceGroup\)" ;;', r"\bretire_instance_record\b"))),
    ("scripts/provisioning/ado.sh", "ado_remove", "platform ado remove"): Mutation(
        "the app's delivery pipeline, service connections, environments; the app's repository (starter, bring-your-own or "
        "unmanaged) renamed {name}-deleted-{requestedOn} (ADR-0061), a starter with decommission.repository delete renamed, then deleted",
        "app", "the delete phase; the CLI deletes each only when it proves to be the app's (ado/remove.ts)"),
    (_AZURE, "lz_secret_delete", "platform provisioning easyauth-delete"): Mutation(
        "a delete start of the kvset job caj-{prefix}-kvset-{mode} of the app's CAE for easyauth-{slug} in the environment vault of "
        "the app's mode", "shared",
        "ADR-0061: the delete phase frees the secret's name for a new app with the slug; the job and the vault of the app's mode by "
        "naming, exactly the app's secret, one execution of the job at a time",
        (Guard(_AZURE, "lz_secret_delete", r'job="\$\(prov_name "\$mode_names" kvsetJob\)"', r"saf_cli provisioning easyauth-delete "),
         Guard(_AZURE, "lz_secret_delete", r'vault="\$\(prov_name "\$mode_names" environmentVault\)"', r"saf_cli provisioning easyauth-delete "),
         Guard(_AZURE, "lz_secret_delete", r'\[ "\$secret" = "easyauth-\$slug" \]', r"saf_cli provisioning easyauth-delete "),
         Guard(_AZURE, "lz_secret_delete", r'^\s*prov_lock "kvset-\$job"$', r"saf_cli provisioning easyauth-delete "))),
    (_ENTRA, "remove_assignments", "platform provisioning entra-reconcile"): Mutation(
        "role assignments on the app's own service principal that its record declared", "app", "removals Graph Bicep doesn't make (ADR-0033, P24)"),
    # -- provisioning: shared scopes, each behind its guard (ADR-0052) -------------------------------
    (_LIB, "prov_arm[create/entra]", "az deployment group create"): Mutation(
        "entra-{slug}-{env} in rg-{prefix}-entra-{env} (ADR-0063; rg-{prefix}-entra while that group doesn't exist yet)", "shared",
        "the app's registration (ADR-0033); the record is named for the app, its group is one of the two names.bicep names",
        (Guard(_ENTRA, "register", r"'\.prefix == \$p and \.slug == \$s and \.environmentName == \$e'", r"^\s*prov_arm create entra "),
         Guard(_ENTRA, "register", r'environment\) entra_rg="\$\(prov_name "\$names" entraEnvironmentResourceGroup\)" ;;', r"^\s*prov_arm create entra "),
         Guard(_ENTRA, "register", r'instance\) entra_rg="\$\(prov_name "\$names" entraResourceGroup\)" ;;', r"^\s*prov_arm create entra "))),
    (_LIB, "prov_arm[create/frontdoor]", "az deployment group create"): Mutation(
        "fd-{slug}-{env} in rg-{prefix}-platform-{env}: og-/orig-/route-{slug}-{env}, cd-{host}, the host's CNAME and _dnsauth TXT",
        "shared", "the app's custom domain (ADR-0010); its DNS record sets are read first and never another's",
        (Guard(_POST, "front_door_step", r'^\s*fd_dns_guard "\$dir"$', r"^\s*prov_arm create frontdoor "),
         Guard(_POST, "front_door_step", r"^\s*prov_lock frontdoor$", r"^\s*prov_arm create frontdoor "),
         Guard(_POST, "fd_dns_guard", r'"\$\(fd_dns_owner "\$dir/dns-cname\.json"\)"'),
         Guard(_POST, "fd_dns_guard", r'"\$\(fd_dns_owner "\$dir/dns-txt\.json"\)"'))),
    (_LIB, "prov_arm[create/portal-endpoint]", "az deployment group create"): Mutation(
        "pep-portal-{slug}-{env} in the portal resource group: pep-{app vault}-portal", "shared",
        "the portal-side endpoint of the app's vault (ADR-0025), named for the vault",
        (Guard(_POST, "portal_endpoint", r"^\s*prov_lock portal-endpoint$", r"^\s*prov_arm create portal-endpoint "),)),
    (_POST, "database_entry", "platform provisioning dbinit"): Mutation(
        "an execution of the dbinit job caj-{prefix}-dbinit-{mode} of the app's CAE", "shared",
        "the runtime identity's database principal (ADR-0028); the job by naming, one execution at a time",
        (Guard(_POST, "database_entry", r'job="\$\(prov_name "\$job_names" dbinitJob\)"', r"saf_cli provisioning dbinit "),
         Guard(_POST, "database_entry", r'^\s*prov_lock "dbinit-\$job"$', r"saf_cli provisioning dbinit "))),
    (_ENTRA, "write_secret", "platform provisioning easyauth-secret"): Mutation(
        "the app's password, a secret of the kvset job caj-{prefix}-kvset-{mode}, easyauth-{slug} in the environment vault",
        "shared", "the Easy Auth secret (ADR-0035, ADR-0041); the job is the app's CAE's by naming",
        (Guard(_ENTRA, "write_secret", r'^\s*prov_secret_entry "\$plan/secret-plan/', r"saf_cli provisioning easyauth-secret "),
         Guard(_LIB, "prov_secret_entry", r'\[ "\$secret_job" = "\$job_prefix\$kvset" \]'))),
    (_POST, "fd_delete", "az rest --method delete"): Mutation(
        "a route, custom domain or origin group of afd-{prefix}-{env}, or a CNAME or TXT record set of a zone, in this subscription",
        "shared", "the cleanup of a removed or changed custom domain (ADR-0010); only the app's own objects",
        (Guard(_POST, "fd_delete", r'\[\[ "\$\{id,,\}" =~ \^/subscriptions/\$\{subscription,,\}/', r"\baz rest --method delete\b"),
         Guard(_POST, "front_door_cleanup", r"saf_cli provisioning fd-cleanup ", r"^\s*fd_delete "),
         Guard(_POST, "front_door_cleanup", r'if ! fd_domain_owned "\$cd" "\$host"; then', r'^\s*fd_delete "\$cd"'),
         Guard(_POST, "fd_dns_cleanup", r'owner="\$\(fd_dns_owner "\$dir/cname\.json"\)"', r'^\s*fd_delete "\$cname_id"'),
         Guard(_POST, "fd_dns_cleanup", r'"\$\(fd_cname_target "\$dir/cname\.json"\)" != "\$\{expected,,\}"', r'^\s*fd_delete "\$cname_id"'),
         Guard(_POST, "fd_dns_cleanup", r'owner="\$\(fd_dns_owner "\$dir/txt\.json"\)"', r'^\s*fd_delete "\$txt_id"'))),
    (_POST, "front_door_cleanup", "az deployment group delete"): Mutation(
        "the record fd-{slug}-{env} in rg-{prefix}-platform-{env}", "shared", "a removed custom domain's record, last (P06, P20)",
        (Guard(_POST, "front_door_cleanup", r"saf_cli provisioning fd-cleanup ", r"\baz deployment group delete\b"),
         Guard(_POST, "front_door_cleanup", r'^\s*fd_nested_cleanup "\$plan"$', r"\baz deployment group delete\b"))),
    (_POST, "fd_nested_cleanup", "az deployment group delete"): Mutation(
        "appRoute-<13> in rg-{prefix}-platform-{env}, dnsRecords-<13> in a zone's resource group: the nested records of fd-{slug}-{env}",
        "shared", "deployment history of shared scopes (ADR-0052); named by the app's own record's operations",
        (Guard(_POST, "fd_nested_cleanup", r"=~ \^/subscriptions/\$\{subscription,,\}/resourcegroups/.*\(approute\|dnsrecords\)", r"\baz deployment group delete\b"),
         Guard(_POST, "fd_nested_cleanup", r'\[\[ "\$zone_rgs" != \*" \$\{nested_rg,,\} "\* \]\]', r"\baz deployment group delete\b"))),
    # -- the move of a network mode change (ADR-0060): the app's own objects, shared scopes behind their guards --
    (_POST, "move_joiner_delete", "az role assignment delete"): Mutation(
        "the delivery identity's App Environment Joiner on the source CAE cae-{prefix}-{mode}-{env}[-c{cell}]", "shared",
        "a delivery during the move fails instead of creating the app in the source CAE again (decision 6.2); only the app's "
        "delivery identity (by naming, in its resource group), only at exactly the source CAE by naming, in the capacity "
        "cell the live app runs in (the plan's fromCell, ADR-0053; never another cell's CAE of the mode)",
        (Guard(_POST, "move_joiner_delete", r'az identity show --resource-group "\$rg" --name "\$\(prov_name "\$names" deliveryIdentity\)"', r"\baz role assignment delete\b"),
         Guard(_POST, "move_joiner_delete", r'if \[ "\$\{scope,,\}" != "\$\{cae,,\}" \]', r"\baz role assignment delete\b"),
         Guard(_POST, "move_step", r'^\s*prov_names "\$slug" "\$dir/names-from\.json" "\$env_name" "\$from" "" "" "\$\{from_cell:-none\}"$', r'^\s*move_joiner_delete "\$old_cae"$'),
         Guard(_POST, "move_step", r'old_cae=.*prov_name "\$dir/names-from\.json" managedEnvironment', r'^\s*move_joiner_delete "\$old_cae"$'))),
    (_POST, "move_app_delete", "az resource delete"): Mutation(
        "ca-{slug} in rg-{prefix}-app-{slug}-{env}", "app",
        "the move: the app is deleted in its source CAE and created again in the target one (decision 6.3, NMC-1), whose "
        "capacity cell is app.yaml's (the plan's toCell checked against it, ADR-0053)",
        (Guard(_POST, "move_step", r'^\s*\[ "\$to_cell" = "\$\(prov_app_cell "\$slug" "\$env_name"\)" \] \|\| saf_die ', r'^\s*move_app_delete "\$app_id"$'),
         Guard(_POST, "move_app_delete", r'\[ "\$\{id,,\}" = "/subscriptions/\$\{subscription,,\}/resourcegroups/\$\{rg,,\}/providers/microsoft\.app/containerapps/\$\{container_app,,\}" \]', r"\baz resource delete\b"),
         Guard(_POST, "move_step", r'\[ "\$rg" = "\$\(prov_name "\$names" appResourceGroup\)" \]', r'^\s*move_app_delete "\$app_id"$'))),
    (_POST, "move_endpoints", "az network private-endpoint delete"): Mutation(
        "the private endpoints of the app's own resources, in rg-{prefix}-app-{slug}-{env}", "app",
        "case B: the source spoke's endpoints can't change subnet (decision 6.4, NMC-3); case A out of hybrid: the app left the VNet (6.8)",
        (Guard(_POST, "move_endpoints", r"privateendpoints/\[a-z0-9\.-\]\{1,80\}\$ \]\] \|\| continue", r"\bprivate-endpoint delete\b"),
         Guard(_POST, "move_endpoints", r'grep -v "\^/subscriptions/\$\{subscription,,\}/resourcegroups/\$\{rg,,\}/providers/"', r"\bprivate-endpoint delete\b"))),
    (_POST, "move_secret_role", "az role assignment delete"): Mutation(
        "the Easy Auth identity's Key Vault Secrets User on easyauth-{slug} in the previous variant's environment vault", "shared",
        "case A: the old secret is no longer the app's (decision 6.8); only the identities in the app's group, only at exactly its secret",
        (Guard(_POST, "move_secret_role", r'az identity list --resource-group "\$rg"', r"\baz role assignment delete\b"),
         Guard(_POST, "move_secret_role", r'scope=.*/secrets/\$\(prov_name "\$names" easyAuthSecret\)"', r"\baz role assignment delete\b"),
         Guard(_POST, "move_secret_role", r'\[ "\$\{at,,\}" != "\$\{scope,,\}" \]; then continue; fi', r"\baz role assignment delete\b"))),
    (_ENTRA, "remove_old_secret", "platform provisioning easyauth-secret"): Mutation(
        "a delete start of the previous variant's kvset job caj-{prefix}-kvset-{mode} for easyauth-{slug}; the app's older passwords",
        "shared", "the follow-up of a case A move (decision 8): the job is the other mode's CAE's by naming, never the app's current one",
        (Guard(_ENTRA, "remove_old_secret", r'\[ "\$old_job" = "\$job_prefix\$\(prov_name "\$other_names" kvsetJob\)" \]', r"saf_cli provisioning easyauth-secret "),
         Guard(_ENTRA, "remove_old_secret", r"jq -e --arg n \"\$secret_name\" '\.secretName == \$n'", r"saf_cli provisioning easyauth-secret "))),
}


# ---------------------------------------------------------------------------------------------
def expand_main(path: str) -> int:
    spec = json.loads(Path(path).read_text(encoding="utf-8"))
    params = spec.get("parameters", spec)
    # Provisioning and platform scenarios name their entry; plain parameter files: `app` means delivery.
    entry = spec.get("entry") or (ENTRY if "app" in params else PLAT_ENTRY if "environment" in params else PROV_ENTRY)
    stages, errors = Expander(Repo.from_disk()).pipeline(params, entry)
    if errors:
        for e in errors:
            print(f"compile error: {e}", file=sys.stderr)
        return 1
    print(yaml.safe_dump({"stages": stages}, sort_keys=False, width=1000), end="")
    return 0


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--expand":
        return expand_main(sys.argv[2])
    repo = Repo.from_disk()
    checker = Checker(repo)
    failures = checker.run()
    for f in failures:
        print(f"FAIL {f}")

    fixture_errors: list[str] = []
    fixtures = sorted((HERE / "fixtures").glob("*.json"))
    covered: set[str] = set()
    for path in fixtures:
        spec = json.loads(path.read_text(encoding="utf-8"))
        rule = spec["rule"]
        covered.add(rule)
        try:
            mutated = repo.patched(spec["patches"])
        except KeyError as exc:
            fixture_errors.append(f"{path.name}: {exc}")
            continue
        result = Checker(mutated).run()
        if not any(r.startswith(rule + " ") for r in result):
            fixture_errors.append(f"{path.name}: expected rule {rule} to fire; got {result or 'no failures'}")
    for rule in sorted(ALL_RULES - covered):
        fixture_errors.append(f"no negative fixture for {rule}")
    for e in fixture_errors:
        print(f"FAIL fixture {e}")

    print(f"check-templates: {len(checker.docs)} delivery + {len(checker.pdocs)} provisioning + "
          f"{len(checker.vdocs)} validation + {len(checker.edocs)} platform templates, "
          f"{sum(1 for n in repo.files if n.endswith('.sh'))} scripts, {len(fixtures)} negative fixtures, "
          f"{len(failures)} policy failure(s), {len(fixture_errors)} fixture failure(s)")
    return 1 if failures or fixture_errors else 0


if __name__ == "__main__":
    sys.exit(main())
