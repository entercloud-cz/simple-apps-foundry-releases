---
name: app-contract-and-docker
description: Use when creating or changing the Dockerfile, .dockerignore, base image, exposed port, health endpoints (/healthz, /readyz), startup command or shutdown handling, or when adapting an existing ("bring your own") app to run on the platform. Also use when platform check reports Dockerfile, port, non-root, pinned-image or health/smoke-test errors.
---

# App contract and Docker

The platform runs the app as one container on Azure Container Apps. These rules are checked by
`platform check` locally and in the pipeline; a violation blocks the deploy.

## The contract

| Rule | How to meet it |
|---|---|
| One container | One `Dockerfile` at the path in `platform.yaml` (`build.dockerfile`, default `Dockerfile`). UI and API in the same container. |
| Listen on `$PORT` | Read `PORT` (default 8080), bind `0.0.0.0`. `platform.yaml` `runtime.port` must match `EXPOSE`. |
| `/healthz` | Liveness. 200 while the process works. No database or network calls. No sign-in. Fast (< 1 s). |
| `/readyz` | Readiness. 200 when this replica can serve traffic (database reachable, migrations done), else 503. Each check with a timeout (≈3 s). |
| JSON logs to stdout | One JSON object per line. See `observability`. |
| Config from env vars | See `secrets-and-config`. |
| Stateless | No files that must survive a restart. `/tmp` for scratch only. Data → database, files → Blob Storage. |
| Non-root | Final stage has `USER <non-root>`. Files copied as root stay read-only for the app (good). |
| Pinned base image | Exact version tag, e.g. `node:22.23.4-trixie-slim`; add `@sha256:<digest>` for reproducibility. Never `latest`, `node:22`, `python:3`. |
| Graceful shutdown | Handle `SIGTERM`: stop accepting, finish in-flight requests, close pools, exit in ≤ 25 s (the platform waits about 30 s). |
| No secrets in image | Nothing secret in `COPY`, `ARG`, `ENV` or build steps. `.dockerignore` excludes `.env*`. |

## Dockerfile rules

1. Multi-stage: a build stage with compilers and dev dependencies, a small runtime stage with only
   what runs.
2. Copy dependency manifests first (`package.json` + lockfile, `requirements.txt`, `*.csproj`),
   install, then copy source: dependency layers stay cached.
3. Install from the lockfile: `npm ci`, `pip install -r requirements.txt` (pinned `==`),
   `dotnet restore`. Never `npm install` in the Dockerfile.
4. Start in **exec form** so the app is PID 1 and gets `SIGTERM`:
   `CMD ["node", "dist/server/index.js"]`. Not `CMD npm start`, not `sh -c`.
5. `EXPOSE 8080` and `ENV PORT=8080` (the platform sets `PORT` too).
6. No `HEALTHCHECK` needed: the platform probes `/healthz` and `/readyz` itself.
7. No `apt-get upgrade`; if you must install OS packages, pin them where possible and clean the
   cache in the same layer.
8. Keep `.dockerignore` excluding `.git`, `node_modules`, `dist`, `.venv`, `bin`, `obj`, `.env*`,
   test output.

Starter Dockerfiles for Node, Python and .NET, and notes for other stacks:
[reference/dockerfiles.md](reference/dockerfiles.md).

## Health endpoints (Node/TS starter)

Already in `src/server/routes/health.ts`. To add a readiness check, pass it to `buildApp`:

```ts
const app = await buildApp({
  config,
  readinessChecks: [() => db.ping(), () => queue.ping()], // each throws when not usable
});
```

Python: add checks inside `readyz()` in `app/main.py` and return
`JSONResponse({"status": "not ready"}, status_code=503)` on failure.
.NET: `builder.Services.AddHealthChecks().AddCheck<MyCheck>("my-dependency")` (served on `/readyz`).

Never make `/healthz` depend on the database: a database outage would make the platform restart
every replica in a loop.

## Graceful shutdown

- Node starter: `src/server/index.ts` handles `SIGTERM`/`SIGINT` → `app.close()`, closes the DB
  pool, flushes telemetry, exits; forced exit after 25 s.
- Python: uvicorn handles `SIGTERM` (`timeout_graceful_shutdown=25`); close resources in a FastAPI
  `lifespan` handler.
- .NET: the host handles `SIGTERM`; `HostOptions.ShutdownTimeout = 25 s` in `Program.cs`. Use
  `IHostApplicationLifetime.ApplicationStopping` for cleanup.

## Adapting an existing app ("bring your own container")

Work through this list with the user, one item per commit where possible:

1. Find how the app starts and which port it uses → make it read `PORT`, bind `0.0.0.0`.
2. Add `/healthz` and `/readyz` (no sign-in, no redirects).
3. Move every config value and secret to environment variables; delete config files with
   secrets (and rotate those secrets: they were in git history).
4. Replace file-based storage (uploads folder, SQLite file, local cache that matters) with
   PostgreSQL/Azure SQL/Blob Storage (`database-*`, `blob-storage` skills).
5. Replace own login/session code with the platform's sign-in header (`auth-entra`).
6. Switch logging to JSON on stdout.
7. Write or fix the Dockerfile (multi-stage, pinned base, non-root, exec-form start).
8. Create `platform.yaml` (`secrets-and-config`), README, CHANGELOG, `docs/architecture.md`.
9. Run `platform check` until it passes.

## Verify

```bash
platform check                                  # all contract checks, incl. a /healthz smoke test
docker build -t app . && docker run --rm -p 8080:8080 -e DEV_FAKE_USER=dev@contoso.com app
curl -i localhost:8080/healthz && curl -i localhost:8080/readyz
docker run --rm app id -u                       # must not print 0
```

`testing-smoke` has a script that does the build–run–probe–stop cycle.

`platform check` (and the platform's pipeline) runs the image with only `PORT` set: no database,
storage or secrets. If `/readyz` waits for the database, it answers 503 there, and the check reports
it as a warning (PC063), not an error. That is fine: keep `/readyz` honest. In the environment the
platform sets `DATABASE_*` and waits for `/readyz` to return 200 before the new version gets
traffic. `/healthz` must still answer 200 without any of them.

## Common mistakes

- `CMD npm start` or `CMD ["sh", "-c", "…"]`: `SIGTERM` doesn't reach the app → killed after 30 s,
  requests cut off.
- `/healthz` checks the database → restart loops during a database blip.
- `/healthz` behind sign-in or redirecting to `/login` → probes fail, container restarts.
- Listening on `localhost`/`127.0.0.1` → works locally, unreachable in the container.
- `FROM node:latest` or `FROM python:3.13-slim` (floating) → check fails; builds change silently.
- Writing uploads to `./uploads` → files vanish on restart and differ between replicas.
- `COPY . .` without a `.dockerignore` → `.env`, `node_modules` and `.git` end up in the image.
- `USER` set in the build stage only, not the final stage.
