#!/usr/bin/env bash
set -euo pipefail

# Claude Code WorktreeRemove hook (Polaris).
# Receives JSON on stdin: { session_id, cwd, hook_event_name, worktree_path }

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_shared.sh"

INPUT=$(cat)
WORKTREE_PATH=$(echo "$INPUT" | jq -r '.worktree_path // .cwd')

if [ -z "$WORKTREE_PATH" ] || [ ! -d "$WORKTREE_PATH" ]; then
  log_warn "Worktree path not found: $WORKTREE_PATH"
  exit 0
fi

# Guard: only proceed if this is actually a worktree (.git is a file, not a directory)
if [ ! -f "$WORKTREE_PATH/.git" ]; then
  log_error "Refusing to clean up $WORKTREE_PATH: not a git worktree"
  exit 1
fi

# Kill background pnpm install if still running
if [ -f "$WORKTREE_PATH/.pnpm-install.pid" ]; then
  PID="$(cat "$WORKTREE_PATH/.pnpm-install.pid")"
  if [[ "$PID" =~ ^[0-9]+$ ]] && kill -0 "$PID" 2>/dev/null; then
    if ps -p "$PID" -o args= 2>/dev/null | grep -Fq "pnpm install" || \
       pgrep -P "$PID" -a 2>/dev/null | grep -Fq "pnpm install"; then
      log_info "Killing background pnpm install (PID $PID)..."
      pkill -P "$PID" 2>/dev/null || true
      kill "$PID" 2>/dev/null || true
    else
      log_warn "PID $PID is not a pnpm install process, skipping kill"
    fi
  fi
  rm -f "$WORKTREE_PATH/.pnpm-install.pid"
fi

# Revoke mise trust
if command -v mise >/dev/null 2>&1; then
  local_mise="$WORKTREE_PATH/mise.toml"
  if [ -f "$local_mise" ]; then
    mise trust --untrust "$local_mise" 2>/dev/null || true
  fi
fi

# Remove the git worktree
log_info "Removing worktree $WORKTREE_PATH..."
git worktree remove --force "$WORKTREE_PATH" 2>/dev/null || true
