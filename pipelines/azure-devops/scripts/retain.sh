#!/usr/bin/env bash
# retain.sh — job `retain` of every deploy stage (normal job after the deployment job `release`;
# no app code, no Azure credentials, no artifact download).
# Keeps the artifacts of the run whose image was just deployed (deliver: this run; redeploy: the
# source run) beyond the default retention, so a later redeploy/rollback can still read them:
# `platform pipeline retention-lease` creates or renews a lease with ownerId
# saf-deployed:<slug>:<env> through the Azure DevOps REST API (POST _apis/build/retention/leases)
# with the job token, mapped into this step only.
#
# Env: SAF_SLUG, SAF_RETAIN_RUN_ID, SAF_ENV_NAME, SAF_RETAIN_DAYS (template constants or $(Build.BuildId));
# SYSTEM_ACCESSTOKEN; SYSTEM_COLLECTIONURI, SYSTEM_TEAMPROJECTID, SYSTEM_DEFINITIONID (predefined).

set -euo pipefail
# shellcheck source=lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

saf_require_env SAF_RETAIN_RUN_ID SAF_ENV_NAME SAF_RETAIN_DAYS SYSTEM_ACCESSTOKEN
[[ "$SAF_RETAIN_RUN_ID" =~ ^[1-9][0-9]*$ ]] || saf_die "the run to retain is not a run id"
[[ "$SAF_RETAIN_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || saf_die "retention days must be a positive number"
saf_check_names

saf_cli pipeline retention-lease --run-id "$SAF_RETAIN_RUN_ID" --env "$SAF_ENV_NAME" --days "$SAF_RETAIN_DAYS" --slug "$SAF_SLUG"
