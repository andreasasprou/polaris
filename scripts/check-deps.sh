#!/usr/bin/env bash
#
# check-deps.sh — Verify no bidirectional imports between top-level lib/ directories.
#
# For every pair of lib/ directories, ensure imports only flow in one direction.
# Bidirectional coupling is a sign of misplaced orchestration logic.
#
# Exit 0 if clean, exit 1 if bidirectional coupling detected.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LIB_DIR="$ROOT/lib"

errors=0
checked_pairs=""

# Known exceptions — tightly coupled L2 siblings that operate as a unit.
# Format: "dir1:dir2" (alphabetical order)
ALLOWED_PAIRS="sandbox:sandbox-agent"

for dir_a in "$LIB_DIR"/*/; do
  a=$(basename "$dir_a")
  for dir_b in "$LIB_DIR"/*/; do
    b=$(basename "$dir_b")
    [ "$a" = "$b" ] && continue

    # Skip if already checked this pair (in either order)
    pair1="${a}:${b}"
    pair2="${b}:${a}"
    case "$checked_pairs" in
      *"|$pair1|"*|*"|$pair2|"*) continue ;;
    esac
    checked_pairs="${checked_pairs}|${pair1}|"

    # Does a import from b? (exclude db/schema.ts — Drizzle schema registry exception)
    a_imports_b=$(grep -rl --include='*.ts' "@/lib/${b}[/\"]" "$dir_a" 2>/dev/null | grep -v 'db/schema\.ts$' | head -1 || true)
    # Does b import from a? (exclude db/schema.ts)
    b_imports_a=$(grep -rl --include='*.ts' "@/lib/${a}[/\"]" "$dir_b" 2>/dev/null | grep -v 'db/schema\.ts$' | head -1 || true)

    # Check allowlist (sort pair alphabetically for consistent matching)
    sorted_pair=$(echo "$a:$b" | tr ':' '\n' | sort | tr '\n' ':' | sed 's/:$//')
    case "$ALLOWED_PAIRS" in
      *"$sorted_pair"*) continue ;;
    esac

    if [ -n "$a_imports_b" ] && [ -n "$b_imports_a" ]; then
      echo "ERROR: Bidirectional coupling: lib/$a <-> lib/$b"
      echo "  lib/$a -> lib/$b:"
      grep -rl --include='*.ts' "@/lib/${b}[/\"]" "$dir_a" 2>/dev/null | sed 's|.*/lib/|    lib/|' || true
      echo "  lib/$b -> lib/$a:"
      grep -rl --include='*.ts' "@/lib/${a}[/\"]" "$dir_b" 2>/dev/null | sed 's|.*/lib/|    lib/|' || true
      echo ""
      errors=$((errors + 1))
    fi
  done
done

if [ "$errors" -gt 0 ]; then
  echo "Found $errors bidirectional coupling violation(s)."
  echo "Fix: Move cross-domain logic to lib/orchestration/."
  exit 1
fi

echo "No bidirectional coupling detected between lib/ directories."
exit 0
