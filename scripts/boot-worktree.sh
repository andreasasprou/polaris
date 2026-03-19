#!/usr/bin/env bash
set -euo pipefail

WORKTREE_DIR="${1:-$(pwd)}"
WORKTREE_HASH=$(echo -n "$WORKTREE_DIR" | shasum -a 256 | head -c 12)

# Find available port in 3100-3999
find_port() {
  for port in $(seq 3100 3999); do
    if ! lsof -i :"$port" &>/dev/null; then
      echo "$port"
      return
    fi
  done
  echo "ERROR: No port available in 3100-3999" >&2
  exit 1
}

PORT=$(find_port)
BASE_URL="http://localhost:${PORT}"

# Ensure dependencies are installed
if [ ! -d "${WORKTREE_DIR}/node_modules" ]; then
  echo "Installing dependencies..."
  (cd "$WORKTREE_DIR" && pnpm install --frozen-lockfile)
fi

# Start dev server
APP_BASE_URL="$BASE_URL" \
BETTER_AUTH_URL="$BASE_URL" \
PORT="$PORT" \
pnpm dev &
DEV_PID=$!

PIDFILE="/tmp/polaris-wt-${WORKTREE_HASH}.pid"
echo "${DEV_PID}:${PORT}:${WORKTREE_HASH}" > "$PIDFILE"

# Wait for health check
echo "Waiting for app on port ${PORT}..."
for i in $(seq 1 60); do
  if curl -sf "${BASE_URL}/api/health" > /dev/null 2>&1; then
    echo "App ready at ${BASE_URL}"
    echo "PID: ${DEV_PID} | Pidfile: ${PIDFILE}"
    echo "---"
    echo "{\"url\":\"${BASE_URL}\",\"pid\":${DEV_PID},\"hash\":\"${WORKTREE_HASH}\"}"
    exit 0
  fi
  sleep 2
done

echo "ERROR: Health check failed after 120s" >&2
kill "$DEV_PID" 2>/dev/null
rm -f "$PIDFILE"
exit 1
