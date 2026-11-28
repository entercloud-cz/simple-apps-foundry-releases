# syntax=docker/dockerfile:1
#
# Base image pinned to an exact version. For a fully reproducible build, also pin the
# digest: run `docker buildx imagetools inspect node:22.23.5-trixie-slim` and change both
# FROM lines to node:22.23.5-trixie-slim@sha256:<digest>. Never use `latest` or `node:22`.

# ---- build: install all dependencies, compile server and client ----
FROM node:22.23.5-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime: only what the app needs to run ----
FROM node:22.23.5-trixie-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /app
# Files stay owned by root and read-only for the app user.
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/migrations ./migrations
# Run as the unprivileged "node" user (uid 1000) that the base image provides.
USER node
EXPOSE 8080
# Exec form: node is PID 1 and receives SIGTERM directly (no npm or shell in between).
CMD ["node", "--enable-source-maps", "--import", "./dist/server/telemetry.js", "dist/server/index.js"]
