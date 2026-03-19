#!/usr/bin/env bash
set -euo pipefail

HASH="${1:?Usage: teardown-worktree.sh <worktree-hash>}"
PIDFILE="/tmp/polaris-wt-${HASH}.pid"

if [ -f "$PIDFILE" ]; then
  IFS=':' read -r PID PORT WH < "$PIDFILE"
  if kill -0 "$PID" 2>/dev/null; then
    echo "Stopping dev server (PID: ${PID}, port: ${PORT})"
    kill "$PID"
    for i in $(seq 1 10); do
      kill -0 "$PID" 2>/dev/null || break
      sleep 1
    done
    kill -9 "$PID" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo "Cleaned up worktree ${HASH}"
else
  echo "No PID file found for hash ${HASH}"
fi
