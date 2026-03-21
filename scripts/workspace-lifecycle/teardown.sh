#!/usr/bin/env bash
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/workspace-lifecycle/_shared.sh
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
  echo "Teardown Summary"
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

step_revoke_mise_trust() {
  local workspace_path
  local mise_config

  echo "Revoking mise config trust..."

  if ! command -v mise >/dev/null 2>&1; then
    log_warn "mise not available, skipping trust revocation"
    step_skipped "Revoke mise trust"
    return 0
  fi

  workspace_path="$(get_workspace_path)"
  mise_config="$workspace_path/mise.toml"

  if [ ! -f "$mise_config" ]; then
    log_info "No mise.toml, skipping trust revocation"
    step_skipped "Revoke mise trust"
    return 0
  fi

  if ! mise trust --untrust "$mise_config"; then
    log_error "Failed to revoke mise trust"
    return 1
  fi

  log_success "Revoked mise.toml trust"
}

main() {
  echo "Tearing down Polaris workspace..."
  echo ""

  if ! step_revoke_mise_trust; then
    step_failed "Revoke mise trust"
  fi

  print_summary
}

main "$@"
