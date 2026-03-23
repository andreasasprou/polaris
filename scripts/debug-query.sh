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

is_neon_pooler_host() {
  local host_lower
  host_lower="$(printf '%s' "$PGHOST" | tr '[:upper:]' '[:lower:]')"
  [[ "$host_lower" == *"pooler"* && "$host_lower" == *"neon.tech"* ]]
}

run_read_only_psql() {
  {
    printf 'BEGIN READ ONLY;\n'
    cat
    printf '\nROLLBACK;\n'
  } | psql "${PSQL_ARGS[@]}"
}

if [[ "${1:-}" == "-f" && -n "${2:-}" ]]; then
  if is_neon_pooler_host; then
    run_read_only_psql <"$2"
  else
    psql "${PSQL_ARGS[@]}" -f "$2"
  fi
elif [[ -n "${1:-}" ]]; then
  if is_neon_pooler_host; then
    printf '%s\n' "$1" | run_read_only_psql
  else
    psql "${PSQL_ARGS[@]}" -c "$1"
  fi
elif [[ ! -t 0 ]]; then
  if is_neon_pooler_host; then
    run_read_only_psql
  else
    psql "${PSQL_ARGS[@]}"
  fi
else
  echo "Usage:"
  echo "  $0 \"SELECT count(*) FROM sandbox_agent.events\""
  echo "  $0 -f query.sql"
  echo "  echo \"SELECT 1\" | $0"
  exit 1
fi
