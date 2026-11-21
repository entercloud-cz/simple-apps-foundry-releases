---
name: troubleshooting
description: Use when something fails or behaves unexpectedly - platform check errors, failed pipeline runs, the app not starting, crash or restart loops, 401/403/404/500/502/503 responses, database or storage sign-in errors, missing environment variables or secrets, slow responses, or when the user pastes an error, a log excerpt or a "copy prompt for your AI agent" text from the portal.
---

# Troubleshooting

Work like this: read the whole error → reproduce locally if possible → find the cause → fix the
cause (never the check) → verify with tests and `platform check` → explain to the user in plain
language what was wrong and what you changed.

## Where to look

| Source | How |
|---|---|
| `platform check` output | names each failed rule, file and line, and how to fix it |
| Local run | `{dev command}` from AGENTS.md; call `/healthz`, `/readyz`, the failing route |
| Pipeline run | portal → app → the failed run: plain-language explanation + "copy prompt for your AI agent" |
| App logs (any environment) | portal log viewer: filter `level=error`, time range, live tail, "copy prompt for AI" |
| System events (restarts, probe failures, image pull) | portal log viewer, system logs |
| Telemetry | portal / Application Insights: failed requests, dependency failures, exceptions |

Ask the user to paste what they see. Don't ask for secrets, and don't print environment variables
or `.env` to "check" values.

## Symptoms → likely causes

| Symptom | Likely cause | Fix |
|---|---|---|
| `platform check`: base image not pinned | `FROM node:22`, `latest` | exact tag, e.g. `node:22.23.4-trixie-slim` (`app-contract-and-docker`) |
| `platform check`: runs as root | no `USER` in final stage | add `USER node` / `USER app` |
| `platform check`: secret found | key/token/password in a file | remove it, move to a secret (`secrets-and-config`), tell the user to **rotate** it |
| `platform check`: forbidden file | `.env`, `node_modules/`, `bin/`, `obj/` committed | `git rm --cached`, check `.gitignore` |
| `platform check`: agent files out of sync | edited `.agents/skills` without sync, or edited `.claude/skills` | `platform sync-agent-files`; never edit `.claude/skills` |
| `platform check`: platform.yaml invalid | typo, reserved env var, secret not listed | follow the message; see `secrets-and-config` |
| Smoke test: `/healthz` not reachable | wrong port, listening on `127.0.0.1`, crash at startup | read the container log; `PORT` + `0.0.0.0` |
| Container restarts in a loop | crash at startup (config error, missing secret, migration failure), or `/healthz` failing | first error line in logs; liveness must not depend on the database |
| Deploy fails after adding a secret | secret value not set in that environment | owner sets it in the portal, then re-run/push |
| `Invalid configuration: X …` at startup | required env var missing or invalid | set it in `platform.yaml` (or portal for secrets); locally in `.env` |
| 401 on every API call (Azure) | route guard but no sign-in header (anonymous app, or calling the container URL directly) | use the app URL from the portal; check `requireUser` placement |
| 401 locally | `DEV_FAKE_USER` not set | set it in `.env` / launchSettings |
| 403 for a user who should have access | missing role assignment, wrong role value (case), or role assigned recently | owner checks role/group in the portal; user signs out and in; compare role string in code |
| 403 for everything, with `FRONT_DOOR_ID` set | request didn't come through Front Door, or wrong id | use the Front Door URL; platform team checks the id |
| 404 on page reload in the SPA | missing SPA fallback | keep the not-found handler that serves `index.html` for non-`/api` GETs |
| 502/503 from the platform | no healthy replica: crash, `/readyz` failing, too slow to start | logs + `/readyz` checks; increase size or `minReplicas` only if the cause is load |
| First request after a pause is slow | scaled to zero (`minReplicas: 0`) | expected in nonprod; `minReplicas: 1` in prod if needed |
| PostgreSQL `password authentication failed` / `no pg_hba.conf entry` | no token used, wrong `DATABASE_USER`, or SSL off | managed-identity token, `DATABASE_USER` as given, `ssl` required (`database-postgres`) |
| SQL `Login failed for user '<token-identified principal>'` | identity has no database user, wrong client id | check `AZURE_CLIENT_ID` usage; if correct, platform team |
| `ManagedIdentityCredential authentication failed` | wrong/missing `AZURE_CLIENT_ID`, or running locally | on Azure use `AZURE_CLIENT_ID`; locally `DefaultAzureCredential` + `az login` |
| Storage `AuthorizationPermissionMismatch` / key-based auth errors | wrong account, or account key / connection string used | `STORAGE_BLOB_ENDPOINT` + managed identity (`blob-storage`) |
| Rollback broke the app | migration not backward compatible | restore compatibility with a new migration; follow expand/contract next time |
| Works in nonprod, fails in prod | prod secret/setting missing, data volume, prod-only role or URL config | compare `environments.prod` in `platform.yaml`, ask owner to check secrets |
| Vulnerability scan blocks prod | critical/high finding with an available fix | update the package or base image patch version, rebuild |

## Debugging locally

1. Run the tests: the failing behaviour often reproduces in a test.
2. Run the app with the same settings: copy the failing env var names (not secret values) into
   `.env`; set `LOG_LEVEL=debug`.
3. Build and run the container (`testing-smoke` script) to catch Dockerfile, port and user issues.
4. Add a test that reproduces the bug, then fix it.

## When it is not the app

Escalate to the platform team (through the portal) when the cause is: permissions or role
assignments of the app's identity, a database/storage/URL that doesn't exist or isn't approved
yet, network or Front Door configuration, approvals, quotas, or the pipeline itself. Tell the user
exactly what to report: app name, environment, time, the error text and the run link.

## Don'ts

- Don't disable checks, tests, TLS verification, security headers, auth guards or the Front Door
  check to make an error go away.
- Don't add pipeline files, Bicep or `az` commands to "fix" a deploy.
- Don't guess about Azure behaviour; say what you know and what needs the platform team.
