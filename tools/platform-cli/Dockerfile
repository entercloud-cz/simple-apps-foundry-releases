# syntax=docker/dockerfile:1
#
# Container image of the `platform` CLI (ADR-0013).
#
#   Build (context = repository root, because the schemas live in config/schema):
#     docker build -f tools/platform-cli/Dockerfile -t platform-cli:dev .
#   Run against an app repo (read-only mount; use --user to match the owner for sync-agent-files):
#     docker run --rm -v "$PWD:/work:ro" platform-cli:dev check . --skip-runtime
#     docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" platform-cli:dev sync-agent-files .
#
# The runtime smoke test needs a docker CLI and daemon. This image does not contain one, so it
# reports that check as skipped (a failure under --strict). Pipelines either run the CLI where
# docker is available or pass --image with an image built by the pipeline's own build step.
#
# Vulnerability scanning of app images (Trivy) is NOT part of this image or of `platform check`.
# It runs in the delivery pipeline template from a pinned, checksum-verified binary
# (ADR-0024); the CLI only evaluates the normalised scan result.
#
# Base image: exact version tag AND index digest (digest read from the Docker Hub registry API on
# 2026-11-14, multi-arch index; bumped for the Node.js 22.23.5 security release).
# TODO(verify): confirm the digest with `docker buildx imagetools inspect node:22.23.5-alpine3.24`
# on a machine with docker before the first release, and bump both lines together.
ARG NODE_IMAGE=node:22.23.5-alpine3.24@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a

# ---- build ----
FROM ${NODE_IMAGE} AS build
WORKDIR /src/tools/platform-cli
COPY tools/platform-cli/package.json tools/platform-cli/package-lock.json tools/platform-cli/.npmrc ./
# --ignore-scripts: no dependency may run code at install time.
RUN npm ci --ignore-scripts
COPY tools/platform-cli/ ./
COPY config/schema /src/config/schema
RUN npm run build && npm prune --omit=dev --ignore-scripts

# ---- runtime ----
FROM ${NODE_IMAGE} AS runtime
# git is used for the file list (honours .gitignore) and the docs freshness warning.
# TODO(verify): pin the apk package version once the Alpine snapshot policy is decided (ADR-0024).
RUN apk add --no-cache git \
 && git config --system safe.directory '*'
WORKDIR /opt/platform-cli
COPY --from=build /src/tools/platform-cli/package.json ./
COPY --from=build /src/tools/platform-cli/node_modules ./node_modules
COPY --from=build /src/tools/platform-cli/dist ./dist
ENV NODE_ENV=production
USER node
WORKDIR /work
ENTRYPOINT ["node", "/opt/platform-cli/dist/src/cli.js"]
CMD ["--help"]
