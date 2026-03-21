#!/usr/bin/env bash
set -euo pipefail

# Claude Code WorktreeCreate hook (Polaris).
# Receives JSON on stdin: { name, session_id, cwd, hook_event_name }
# Must print the worktree path on stdout.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_shared.sh"

# Read hook input
INPUT=$(cat)
NAME=$(echo "$INPUT" | jq -r '.name // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd')

REPO_ROOT="$CWD"
WORKTREE_DIR="$REPO_ROOT/.claude/worktrees"
# Sanitize name: allow only alphanumeric, dots, hyphens, underscores
RAW_NAME="${NAME:-agent-$(openssl rand -hex 4)}"
WORKTREE_NAME="$(echo "$RAW_NAME" | tr -cs 'a-zA-Z0-9._-' '-' | sed 's/^-*//;s/-*$//')"
WORKTREE_NAME="${WORKTREE_NAME:-agent-$(openssl rand -hex 4)}"
WORKTREE_PATH="$WORKTREE_DIR/$WORKTREE_NAME"

# Guard against path traversal
case "$WORKTREE_PATH" in
  "$WORKTREE_DIR"/*) ;;
  *)
    log_error "Resolved worktree path escapes worktree dir: $WORKTREE_PATH"
    exit 1
    ;;
esac

mkdir -p "$WORKTREE_DIR"

# Create the git worktree with HUSKY=0 to skip the post-checkout hook
# (we handle setup ourselves, avoiding the slow unconditional pnpm install)
log_info "Creating git worktree at $WORKTREE_PATH..."
HUSKY=0 git worktree add "$WORKTREE_PATH" -b "worktree-$WORKTREE_NAME" HEAD >&2 2>&1

# Fast setup: env symlinks + mise trust (~0.1s)
symlink_env_files "$WORKTREE_PATH"
trust_mise_config "$WORKTREE_PATH" || log_warn "mise trust failed (non-critical, continuing)"

# Background pnpm install: the worktree is usable for code reading immediately,
# and the install completes async (~23s). Tools like typecheck will work once done.
INSTALL_LOG="$WORKTREE_PATH/.pnpm-install.log"
(
  cd "$WORKTREE_PATH"
  if NODE_ENV=development pnpm install --frozen-lockfile --prefer-offline \
    >"$INSTALL_LOG" 2>&1; then
    log_success "Background pnpm install completed in $WORKTREE_PATH"
  else
    log_warn "Background pnpm install failed in $WORKTREE_PATH (see .pnpm-install.log)"
  fi
  rm -f "$WORKTREE_PATH/.pnpm-install.pid"
) &
INSTALL_PID=$!
echo "$INSTALL_PID" > "$WORKTREE_PATH/.pnpm-install.pid"
log_info "Background pnpm install started (PID $INSTALL_PID, log: .pnpm-install.log)"

# Required: print the worktree path on stdout for Claude Code
echo "$WORKTREE_PATH"
