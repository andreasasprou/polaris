#!/usr/bin/env bash
# Superset / IDE workspace hook → Polaris lifecycle (mise trust revocation).
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
workspace_path="$(dirname "$script_dir")"

exec bash "$workspace_path/scripts/workspace-lifecycle/teardown.sh" "$@"
