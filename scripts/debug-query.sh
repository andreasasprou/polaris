#!/usr/bin/env bash
# Run read-only SQL queries against the Polaris production database.
# Credentials are fetched from 1Password at runtime — never written to disk.
#
# Usage:
#   ./scripts/debug-query.sh "SELECT count(*) FROM sandbox_agent.events"
#   ./scripts/debug-query.sh -f query.sql
#   echo "SELECT 1" | ./scripts/debug-query.sh

set -euo pipefail

OP_ITEM="uyhidsxgst4qgcl6yizdap3yua"

# Build connection string with password injected via op at runtime
DATABASE_URL="postgresql://$(
  op item get "$OP_ITEM" --fields label=username --reveal
):$(
  op item get "$OP_ITEM" --fields label=password --reveal
)@$(
  op item get "$OP_ITEM" --fields label=hostname --reveal
)/$(
  op item get "$OP_ITEM" --fields label=database --reveal
)?sslmode=require"

export PGCONNECT_TIMEOUT=10

if [[ "${1:-}" == "-f" && -n "${2:-}" ]]; then
  psql "$DATABASE_URL" -f "$2"
elif [[ -n "${1:-}" ]]; then
  psql "$DATABASE_URL" -c "$1"
elif [[ ! -t 0 ]]; then
  psql "$DATABASE_URL"
else
  echo "Usage:"
  echo "  $0 \"SELECT count(*) FROM sandbox_agent.events\""
  echo "  $0 -f query.sql"
  echo "  echo \"SELECT 1\" | $0"
  exit 1
fi
