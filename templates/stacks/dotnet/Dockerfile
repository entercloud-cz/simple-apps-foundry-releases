# syntax=docker/dockerfile:1
#
# Base images pinned to exact versions. For a fully reproducible build, also pin the
# digests: run `docker buildx imagetools inspect <image>` and append @sha256:<digest>
# to each FROM line. Never use `latest` or a floating tag like `10.0`.

# ---- build: restore and publish ----
FROM mcr.microsoft.com/dotnet/sdk:10.0.403-noble AS build
WORKDIR /src
COPY global.json Directory.Build.props ./
COPY src/App/App.csproj src/App/
RUN dotnet restore src/App/App.csproj
COPY src/ src/
# .platform/ with the app's roles and their levels (roles.json, written by the platform); App.csproj
# puts roles.json next to App.dll. The [m] makes the folder optional: without roles.json the app uses
# the core's default roles.
COPY .platfor[m] .platform/
RUN dotnet publish src/App/App.csproj -c Release -o /out --no-restore

# ---- runtime: chiseled image (no shell, no package manager) ----
FROM mcr.microsoft.com/dotnet/aspnet:10.0.14-noble-chiseled AS runtime
WORKDIR /app
COPY --from=build /out .
# The chiseled image provides the unprivileged "app" user (uid 1654).
USER app
ENV PORT=8080
EXPOSE 8080
# Exec form: dotnet is PID 1 and receives SIGTERM directly.
ENTRYPOINT ["dotnet", "App.dll"]
