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

# Pass credentials via env vars so special characters in passwords don't break URI parsing
export PGUSER="$(op item get "$OP_ITEM" --fields label=username --reveal)"
export PGPASSWORD="$(op item get "$OP_ITEM" --fields label=password --reveal)"
export PGHOST="$(op item get "$OP_ITEM" --fields label=hostname --reveal)"
export PGDATABASE="$(op item get "$OP_ITEM" --fields label=database --reveal)"
export PGSSLMODE=require
export PGCONNECT_TIMEOUT=10
export PGOPTIONS="${PGOPTIONS:+$PGOPTIONS }-c default_transaction_read_only=on"

PSQL_ARGS=(-X -v ON_ERROR_STOP=1)

if [[ "${1:-}" == "-f" && -n "${2:-}" ]]; then
  psql "${PSQL_ARGS[@]}" -f "$2"
elif [[ -n "${1:-}" ]]; then
  psql "${PSQL_ARGS[@]}" -c "$1"
elif [[ ! -t 0 ]]; then
  psql "${PSQL_ARGS[@]}"
else
  echo "Usage:"
  echo "  $0 \"SELECT count(*) FROM sandbox_agent.events\""
  echo "  $0 -f query.sql"
  echo "  echo \"SELECT 1\" | $0"
  exit 1
fi
