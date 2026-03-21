#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/_shared.sh"

declare -a FAILED_STEPS=()
declare -a SKIPPED_STEPS=()

step_failed() {
  FAILED_STEPS+=("$1")
}

step_skipped() {
  SKIPPED_STEPS+=("$1")
}

get_workspace_path() {
  cd "$SCRIPT_DIR/../.." && pwd
}

print_summary() {
  echo ""
  echo "========================================"
  echo "Setup Summary"
  echo "========================================"

  if [ ${#FAILED_STEPS[@]} -eq 0 ] && [ ${#SKIPPED_STEPS[@]} -eq 0 ]; then
    echo -e "${GREEN}All steps completed successfully.${NC}"
  else
    if [ ${#SKIPPED_STEPS[@]} -gt 0 ]; then
      echo -e "${YELLOW}Skipped steps:${NC}"
      for step in "${SKIPPED_STEPS[@]}"; do
        echo "  - $step"
      done
    fi
    if [ ${#FAILED_STEPS[@]} -gt 0 ]; then
      echo -e "${RED}Failed steps:${NC}"
      for step in "${FAILED_STEPS[@]}"; do
        echo "  - $step"
      done
    fi
  fi
  echo "========================================"

  [ ${#FAILED_STEPS[@]} -eq 0 ]
}

step_symlink_env_files() {
  local workspace_path
  workspace_path="$(get_workspace_path)"

  echo "Setting up environment file symlinks..."
  symlink_env_files "$workspace_path"
}

step_trust_mise_config() {
  local workspace_path
  workspace_path="$(get_workspace_path)"

  echo "Trusting mise configuration..."
  trust_mise_config "$workspace_path"
}

step_install_dependencies() {
  echo "Installing dependencies..."

  if ! command -v pnpm >/dev/null 2>&1; then
    log_error "pnpm not available"
    return 1
  fi

  local workspace_path
  workspace_path="$(get_workspace_path)"

  # In worktrees, use --frozen-lockfile (skip lockfile resolution) and
  # --prefer-offline (skip registry staleness checks) for faster installs.
  local install_flags=""
  if [ -f "$workspace_path/.git" ]; then
    install_flags="--frozen-lockfile --prefer-offline"
  fi

  if ! NODE_ENV=development pnpm install $install_flags; then
    log_error "Failed to install dependencies"
    return 1
  fi

  log_success "Dependencies installed"
}

main() {
  echo "Setting up Polaris workspace..."
  echo ""

  if ! step_symlink_env_files; then
    step_failed "Symlink env files"
  fi

  if ! step_trust_mise_config; then
    step_failed "Trust mise config"
  fi

  if ! step_install_dependencies; then
    step_failed "Install dependencies"
  fi

  print_summary
}

main "$@"
