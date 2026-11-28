# Reference Dockerfiles

Versions were current when this template was released. Use the newest **patch** of the same
major version when you start; then keep the tag pinned and update deliberately. Get a digest
with `docker buildx imagetools inspect <image:tag>` and pin it as `<image:tag>@sha256:<digest>`.

## Node.js / TypeScript (API + React SPA in one container)

```dockerfile
# syntax=docker/dockerfile:1
FROM node:22.23.5-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22.23.5-trixie-slim AS runtime
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
USER node
EXPOSE 8080
CMD ["node", "--enable-source-maps", "--import", "./dist/server/telemetry.js", "dist/server/index.js"]
```

## Python (FastAPI / any ASGI or WSGI app)

```dockerfile
# syntax=docker/dockerfile:1
FROM python:3.13.18-slim-trixie AS build
ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH
COPY requirements.txt .
RUN pip install -r requirements.txt

FROM python:3.13.18-slim-trixie AS runtime
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PATH=/opt/venv/bin:$PATH PORT=8080
RUN useradd --system --uid 10001 --no-create-home --shell /usr/sbin/nologin app
WORKDIR /app
COPY --from=build /opt/venv /opt/venv
COPY app ./app
USER app
EXPOSE 8080
CMD ["python", "-m", "app"]   # app/__main__.py reads PORT and starts uvicorn
```

Flask/Django: run `gunicorn` in exec form with the port from Python code or a
`gunicorn.conf.py` that reads `PORT` (`bind = f"0.0.0.0:{os.environ.get('PORT', '8080')}"`),
`graceful_timeout = 25`, logs to stdout.

## .NET (ASP.NET Core)

```dockerfile
# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/dotnet/sdk:10.0.403-noble AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY src/App/App.csproj src/App/
RUN dotnet restore src/App/App.csproj
COPY src/ src/
RUN dotnet publish src/App/App.csproj -c Release -o /out --no-restore

FROM mcr.microsoft.com/dotnet/aspnet:10.0.14-noble-chiseled AS runtime
WORKDIR /app
COPY --from=build /out .
USER app
ENV PORT=8080
EXPOSE 8080
ENTRYPOINT ["dotnet", "App.dll"]
```

Chiseled images have no shell: debugging tools must not be needed at runtime. Read `PORT` in
`Program.cs` (`builder.WebHost.UseUrls($"http://0.0.0.0:{port}")`).

## Other stacks (bring your own)

| Stack | Base image idea | Notes |
|---|---|---|
| Go | build `golang:<x.y.z>`, run `gcr.io/distroless/static-debian12:nonroot` (pin digest) | `CGO_ENABLED=0`; handle `SIGTERM` with `signal.NotifyContext` + `server.Shutdown`. |
| Java (Spring Boot) | `eclipse-temurin:<21.x.y_z>-jre` | `server.port=${PORT:8080}`, `server.shutdown=graceful`, JSON logs via logback encoder. |
| Static SPA only | `nginxinc/nginx-unprivileged:<x.y.z>` | listen on 8080; still needs `/healthz` (a static file is fine). |
| PHP | `php:<x.y.z>-apache` is root by default | prefer an unprivileged image or change the port and `USER`; ask the platform team if unsure. |

Whatever the stack: exact tags, multi-stage, non-root, exec-form start, `PORT`, health
endpoints, JSON logs, `SIGTERM` handling.
