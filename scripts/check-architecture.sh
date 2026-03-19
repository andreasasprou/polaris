#!/usr/bin/env bash
#
# Verify that every top-level lib/ directory is mentioned in ARCHITECTURE.md.
# Exits 0 on success, 1 if any directory is missing.
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH_FILE="$REPO_ROOT/ARCHITECTURE.md"

if [ ! -f "$ARCH_FILE" ]; then
  echo "ERROR: ARCHITECTURE.md not found at $ARCH_FILE"
  exit 1
fi

missing=0

for dir in "$REPO_ROOT"/lib/*/; do
  # Strip trailing slash and get basename
  name="$(basename "$dir")"
  if ! grep -q "$name" "$ARCH_FILE"; then
    echo "MISSING: lib/$name is not mentioned in ARCHITECTURE.md"
    missing=1
  fi
done

# Also check lib/utils.ts (the lone file in lib/)
if [ -f "$REPO_ROOT/lib/utils.ts" ]; then
  # utils.ts is a single utility file, not a directory — skip
  true
fi

if [ "$missing" -eq 0 ]; then
  echo "OK: All top-level lib/ directories are mentioned in ARCHITECTURE.md"
else
  exit 1
fi
