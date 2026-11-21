#!/bin/sh
# Local container smoke test: build, run, probe health endpoints, check non-root, stop with SIGTERM.
# Usage: sh smoke-local.sh [port] [extra-path ...]     (run from the repository root; needs Docker)
set -eu

PORT="${1:-8080}"
[ "$#" -gt 0 ] && shift
IMAGE="smoke-local:$(date +%s)"
NAME="smoke-local-$$"

fail() { echo "FAIL: $*" >&2; docker logs "$NAME" 2>/dev/null | tail -n 40 >&2 || true; docker rm -f "$NAME" >/dev/null 2>&1 || true; exit 1; }

echo "Building image…"
docker build -q -t "$IMAGE" . >/dev/null || fail "docker build failed"

echo "Starting container on port $PORT…"
docker run -d --name "$NAME" -p "$PORT:$PORT" -e PORT="$PORT" \
  -e DEV_FAKE_USER=smoke@contoso.com -e DEV_FAKE_ROLES=Admin "$IMAGE" >/dev/null || fail "docker run failed"

i=0
until curl -fsS "http://localhost:$PORT/healthz" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -ge 60 ] && fail "/healthz did not answer 200 within 60 s"
  sleep 1
done
echo "OK   /healthz"

curl -fsS "http://localhost:$PORT/readyz" >/dev/null 2>&1 && echo "OK   /readyz" || echo "WARN /readyz is not 200 (expected if a database is required but not available locally)"

for path in "$@"; do
  curl -fsS "http://localhost:$PORT$path" >/dev/null 2>&1 || fail "$path did not answer 200"
  echo "OK   $path"
done

# `id` may not exist in minimal images (distroless, chiseled): fall back to the image's USER setting.
USER_ID="$(docker exec "$NAME" id -u 2>/dev/null || docker inspect -f '{{.Config.User}}' "$NAME")"
case "$USER_ID" in
  "" | 0 | root | 0:* | root:*) fail "container runs as root (user: '${USER_ID}')" ;;
esac
echo "OK   non-root user ($USER_ID)"

echo "Stopping with SIGTERM…"
START="$(date +%s)"
docker stop -t 30 "$NAME" >/dev/null
ELAPSED=$(( $(date +%s) - START ))
EXIT_CODE="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
docker rm "$NAME" >/dev/null
[ "$ELAPSED" -lt 30 ] || fail "container did not stop within 30 s after SIGTERM"
echo "OK   stopped in ${ELAPSED}s (exit code $EXIT_CODE)"

docker rmi "$IMAGE" >/dev/null 2>&1 || true
echo "Smoke test passed."
