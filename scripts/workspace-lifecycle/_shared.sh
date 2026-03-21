#!/usr/bin/env bash
# Shared functions for Polaris workspace lifecycle (worktrees, Superset hooks).
# Source this file, do not execute it directly.

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

log_error() { echo -e "${RED}x${NC} $1" >&2; }
log_success() { echo -e "${GREEN}v${NC} $1" >&2; }
log_warn() { echo -e "${YELLOW}!${NC} $1" >&2; }
log_info() { echo -e "  $1" >&2; }

# Resolve the parent (main) repo from a worktree path.
# Returns the parent repo root on stdout. Returns 1 if not a worktree.
resolve_parent_repo_from_worktree() {
  local workspace_path="$1"

  if [ ! -f "$workspace_path/.git" ]; then
    return 1
  fi

  local gitdir
  gitdir=$(sed -n 's/^gitdir: //p' "$workspace_path/.git")
  if [ -z "$gitdir" ]; then
    return 1
  fi

  # Resolve relative gitdir paths
  if [[ "$gitdir" != /* ]]; then
    gitdir="$workspace_path/$gitdir"
  fi

  local gitdir_dir
  gitdir_dir="$(cd "$(dirname "$gitdir")" && pwd)"
  gitdir="$gitdir_dir/$(basename "$gitdir")"

  # Walk up: .git/worktrees/<name> -> .git -> parent_root
  local parent_root
  parent_root="$(dirname "$(dirname "$(dirname "$gitdir")")")"

  if [ ! -d "$parent_root/.git" ]; then
    return 1
  fi

  echo "$parent_root"
}

# Symlink .env.vault.local files from the parent repo into a worktree.
# Args: $1 = worktree path
symlink_env_files() {
  local workspace_path="$1"

  if [ ! -f "$workspace_path/.git" ]; then
    log_warn "Not in a Git worktree, skipping env symlinks"
    return 0
  fi

  local parent_root
  if ! parent_root="$(resolve_parent_repo_from_worktree "$workspace_path")"; then
    log_warn "Could not resolve parent repository, skipping env symlinks"
    return 0
  fi

  log_success "Detected worktree parent repo: $parent_root"

  # Single Next.js app at repo root (see README: copy .env.example → .env)
  local env_files=(
    ".env"
    ".env.local"
  )

  local symlinks_created=0
  for env_file in "${env_files[@]}"; do
    local worktree_file="$workspace_path/$env_file"
    local parent_file="$parent_root/$env_file"

    if [ ! -f "$parent_file" ]; then
      continue
    fi

    if [ -L "$worktree_file" ] && [ "$(readlink "$worktree_file")" = "$parent_file" ]; then
      log_success "Symlink exists: $env_file"
      continue
    fi

    if [ -e "$worktree_file" ] || [ -L "$worktree_file" ]; then
      log_warn "Replacing existing $env_file with symlink"
      rm "$worktree_file"
    fi

    ln -s "$parent_file" "$worktree_file"
    log_success "Created symlink: $env_file -> $parent_file"
    symlinks_created=$((symlinks_created + 1))
  done

  if [ $symlinks_created -eq 0 ]; then
    log_warn "No parent env files found to link (.env, .env.local, .env.vault.local)"
  fi
}

# Trust mise configuration in a workspace.
# Args: $1 = workspace path
trust_mise_config() {
  local workspace_path="$1"

  if ! command -v mise >/dev/null 2>&1; then
    log_warn "mise not available, skipping trust"
    return 0
  fi

  local mise_config="$workspace_path/mise.toml"
  if [ ! -f "$mise_config" ]; then
    log_info "No mise.toml, skipping mise trust"
    return 0
  fi

  if ! mise trust "$mise_config" 1>&2; then
    log_error "Failed to trust mise config"
    return 1
  fi

  log_success "Trusted mise.toml"
}
