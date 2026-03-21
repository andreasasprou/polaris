#!/usr/bin/env bash
# Superset / IDE workspace hook → Polaris lifecycle (env symlinks, mise, pnpm install).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_path="$(dirname "$script_dir")"

exec bash "$workspace_path/scripts/workspace-lifecycle/setup.sh" "$@"
