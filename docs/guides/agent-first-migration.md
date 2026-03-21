# Migrating a Codebase to Agent-First

A step-by-step playbook for making any codebase navigable and modifiable by AI coding agents (Claude Code, Codex, etc.). Based on real experience migrating a production codebase.

**Time estimate**: 1-2 days for a medium codebase (50-100 source files).

---

## Why Agent-First?

Coding agents navigate codebases the same way a new engineer does: they read docs, search for patterns, trace imports. The difference is they do this every session with zero memory. An agent-first codebase makes this fast and reliable by:

1. **Progressive disclosure** — agents start with a 60-line behavioral guide, expand to a structural map, then dive into deep docs only when needed.
2. **Mechanical enforcement** — CI catches violations so agents can't accidentally degrade the architecture.
3. **Predictable structure** — strict boundaries mean agents can work fast without risk of cross-cutting breakage.

---

## Phase 1: CLAUDE.md (The Behavioral Guide)

**Goal**: A single file that fits in one context window and tells agents HOW to work here.

Create `CLAUDE.md` at the repo root (symlink `AGENTS.md` → `CLAUDE.md` for multi-agent support):

```bash
ln -s CLAUDE.md AGENTS.md
```

### Template

```markdown
<!-- Line budget: 80 lines max. Graduate detailed content to docs/ or ARCHITECTURE.md -->
# [Project Name] — Agent Instructions

## Architecture Principles
- [2-3 core principles that shape every decision]

## Codebase Navigation
- **Structural map**: See `ARCHITECTURE.md` for module map, state machines, and request lifecycle traces.
- **Deep-dive docs**: `docs/architecture/` for detailed design docs.
- **Reference docs**: `docs/references/` for LLM-optimized API docs of niche dependencies.

## Where to Start
Pick the flow closest to your task:
- **[Common task 1]?** `path/to/file1.ts` → `path/to/file2.ts` → `path/to/file3.ts`
- **[Common task 2]?** `path/to/file4.ts` → `path/to/file5.ts`
[Add 5-7 flows that cover 80% of changes]

## Anti-Patterns
These have caused real bugs — avoid them:
- **[Anti-pattern 1]** — [why it's bad and what to do instead]
- **[Anti-pattern 2]** — [why it's bad and what to do instead]
[Add patterns discovered from actual incidents, not theoretical ones]

## Testing & Verification
**Always verify your own work.** Run `[typecheck command]` before considering any change complete.
1. **Typecheck**: `[command]` must pass.
2. **Tests**: `[command]` must pass.
[Add verification steps specific to your project]

## Observability
[How to query production logs. Which MCP tools to use. Key datasets and fields.]

## Key Commands
- `[typecheck]` — must pass before considering work complete
- `[test]` — all tests
- `[dev]` — local dev server
```

### Key principles

- **80-line budget**. If it doesn't fit, graduate content to ARCHITECTURE.md or docs/.
- **Battle-tested anti-patterns only**. Don't add theoretical warnings. Add patterns that caused real bugs.
- **File paths, not abstractions**. Say `lib/jobs/sweeper.ts`, not "the sweeper module".
- **Where-to-Start flows**. This is the highest-leverage section. Map the 5-7 most common change patterns as file-path reading orders.

---

## Phase 2: ARCHITECTURE.md (The Structural Map)

**Goal**: A comprehensive reference that agents consult when CLAUDE.md isn't enough. Target ~300-500 lines.

### Template

```markdown
# [Project Name] — Architecture

## Overview
[2-3 sentences: what the system does, key technologies]

## System Topology
[ASCII diagram showing major components and data flow]

## Request Lifecycle
### Flow A — [Primary flow name]
1. **`path/to/entrypoint.ts`** — [what happens here]
2. **`path/to/next-file.ts` → `functionName()`** — [what happens]
[Trace 2-3 critical flows end-to-end with exact file paths and function names]

## Module Map
### `[directory-name]`
[1-3 sentence description]
**Key exports:** `functionA()`, `functionB()`.
**Depends on:** `[other-directory]`.
[One entry per top-level source directory]

## State Machines
[ASCII diagrams of key state machines with all valid transitions]

## Invariants
[Numbered list of things that must always be true. These guide agents away from violations.]

## Cross-Cutting Concerns
[Auth model, error handling patterns, logging conventions, etc.]
```

### Key principles

- **Trace real requests**. Don't describe abstractions — trace actual HTTP requests through exact file paths.
- **Module map completeness**. Every source directory must have an entry. Enforce with CI (see Phase 5).
- **Depends-on is the dependency graph**. Agents use this to understand blast radius.
- **State machines are ASCII**. Agents parse ASCII better than Mermaid/PlantUML.

---

## Phase 3: Reference Docs for Niche Dependencies

**Goal**: LLM-friendly API docs for dependencies that agents can't figure out from types alone.

For each niche dependency (SDKs without good public docs, internal packages, etc.):

1. Create `docs/references/[package-name]-llms.txt`
2. Include: used API surface (with types), constructor patterns, gotchas/footguns
3. Add a `# Locked version: X.Y.Z` header
4. Create a CI check that compares locked version vs installed version

### Template

```
# [package-name] Reference — vX.Y.Z
# Locked version: X.Y.Z

## Quick Summary
[What it does, why we use it, key classes]

## Used API Surface
[Only the parts YOUR codebase actually uses — not the full API]

### [ClassName]
```typescript
// Constructor
new ClassName(options: { ... }): ClassName;
// Methods we use
methodA(param: Type): ReturnType;
```

## Gotchas
1. [Gotcha from real experience]
2. [Another gotcha]
```

### When to create a reference doc

- The package has no `llms.txt` or `llms-full.txt` at its docs site
- Agents consistently make mistakes with this package
- The types alone don't convey the correct usage patterns (e.g., ordering requirements, auth quirks)

---

## Phase 4: Domain Boundaries & Layer Architecture

**Goal**: Enforce directional dependencies so agents can't accidentally deepen coupling.

### Step 1: Define layers

Map your source directories to layers. A 4-5 layer model works for most projects:

```
Layer 0 — Foundation (zero domain knowledge)
  lib/http/, lib/config/, lib/metrics/

Layer 1 — Schema (DB tables, error types)
  lib/db/, lib/errors/

Layer 2 — Domain (business entities, CRUD)
  lib/users/, lib/orders/, lib/products/, ...

Layer 3 — Orchestration (multi-domain workflows)
  lib/orchestration/

Layer 4 — Presentation (UI, API routes)
  app/, components/, hooks/
```

**Rule**: imports flow downward only. L2 cannot import from L3. L1 cannot import from L2.

### Step 2: Identify violations

```bash
# Find bidirectional coupling between directories
for dir_a in lib/*/; do
  a=$(basename "$dir_a")
  for dir_b in lib/*/; do
    b=$(basename "$dir_b")
    [ "$a" = "$b" ] && continue
    a_imports_b=$(grep -rl "@/lib/${b}" "$dir_a" 2>/dev/null | head -1)
    b_imports_a=$(grep -rl "@/lib/${a}" "$dir_b" 2>/dev/null | head -1)
    if [ -n "$a_imports_b" ] && [ -n "$b_imports_a" ]; then
      echo "BIDIRECTIONAL: lib/$a <-> lib/$b"
    fi
  done
done
```

### Step 3: Move orchestration files

The most common violation pattern: domain directories contain files that orchestrate across multiple domains. Move them:

```
lib/jobs/sweeper.ts       → lib/orchestration/sweeper.ts
lib/sessions/dispatch.ts  → lib/orchestration/dispatch.ts
```

Update imports. Run typecheck. Repeat until no bidirectional coupling remains.

### Step 4: Enforce with ESLint

Install `eslint-plugin-import-x` (ESM + flat config compatible):

```bash
npm install -D eslint-plugin-import-x
```

Configure `no-restricted-paths` rules per layer:

```javascript
// eslint.config.mjs
import importPlugin from "eslint-plugin-import-x";

{
  files: ["lib/**/*.ts"],
  plugins: { "import-x": importPlugin },
  rules: {
    "import-x/no-restricted-paths": ["error", {
      zones: [
        {
          target: ["lib/db/**", "lib/errors/**"],  // L1
          from: ["lib/users/**", "lib/orders/**", "lib/orchestration/**"],  // L2+
          message: "Schema modules (L1) cannot import from Domain (L2) or Orchestration (L3)."
        },
        {
          target: ["lib/users/**", "lib/orders/**"],  // L2
          from: ["lib/orchestration/**"],  // L3
          message: "Domain modules cannot import from Orchestration. Move the logic to lib/orchestration/."
        },
      ],
    }],
  },
}
```

### Step 5: Add CI check for bidirectional coupling

Create `scripts/check-deps.sh` that fails if any two `lib/` directories import from each other. Add exceptions for known-acceptable pairs (tightly coupled siblings). Wire into CI.

---

## Phase 5: Mechanical Enforcement (CI)

**Goal**: Every structural rule is enforced by CI, not by convention.

### Checks to add

| Check | What it enforces | Script |
|-------|-----------------|--------|
| `pnpm lint` | Layer violation via `no-restricted-paths` | ESLint config |
| `pnpm check:deps` | No bidirectional imports between lib/ dirs | `scripts/check-deps.sh` |
| `pnpm check:architecture` | Every lib/ directory mentioned in ARCHITECTURE.md | `scripts/check-architecture.sh` |
| `pnpm check:reference-docs` | Reference doc versions match installed packages | `scripts/check-reference-versions.ts` |

### Architecture presence check

```bash
#!/usr/bin/env bash
# scripts/check-architecture.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
errors=0
for dir in "$ROOT"/lib/*/; do
  name=$(basename "$dir")
  if ! grep -q "$name" "$ROOT/ARCHITECTURE.md"; then
    echo "ERROR: lib/$name not mentioned in ARCHITECTURE.md"
    errors=$((errors + 1))
  fi
done
[ "$errors" -eq 0 ] && echo "OK" || exit 1
```

---

## Phase 6: Data-Driven Tests

**Goal**: Table-driven tests for state machines and business rules so agents can add cases without understanding test infrastructure.

### Pattern

```typescript
describe("status transitions", () => {
  const cases = [
    { from: "idle",    to: "active",  allowed: true },
    { from: "active",  to: "idle",    allowed: true },
    { from: "stopped", to: "active",  allowed: false },
    // Agents add new rows here — no boilerplate needed
  ];

  it.each(cases)("$from → $to: $allowed", ({ from, to, allowed }) => {
    expect(canTransition(from, to)).toBe(allowed);
  });
});
```

### What to test this way

- State machine transitions (exhaustive matrix)
- Filter/matcher functions (table of inputs → expected outputs)
- Config completeness (every enum value has a config entry)
- Error classification (input error → expected code)

---

## Migration Order

Do the phases in this order — each builds on the previous:

1. **CLAUDE.md** (30 min) — Immediate impact. Agents start reading this on every session.
2. **ARCHITECTURE.md** (2-3 hours) — Trace 2-3 request flows, write the module map.
3. **Domain boundaries** (2-4 hours) — Identify violations, move files, update imports, typecheck.
4. **ESLint + CI enforcement** (1 hour) — Lock in the boundary rules.
5. **Reference docs** (30 min per dependency) — Only for dependencies that cause repeated agent mistakes.
6. **Data-driven tests** (1 hour) — Convert existing state machine tests or write new ones.

---

## Maintenance

The docs rot if not maintained. Enforcement keeps them alive:

- **ARCHITECTURE.md** — `check-architecture.sh` fails if a new lib/ directory isn't documented.
- **Reference docs** — `check-reference-versions.ts` fails if a package is upgraded without updating the doc.
- **Boundaries** — `eslint no-restricted-paths` + `check-deps.sh` fail on layer violations.
- **CLAUDE.md** — No automated check, but the 80-line budget forces curation. Review it quarterly.

When adding a new module:
1. Add to ARCHITECTURE.md module map
2. Add to ESLint layer config
3. Run `pnpm lint` + `pnpm check:deps` + `pnpm check:architecture`

---

## Checklist

- [ ] `CLAUDE.md` exists with <80 lines, anti-patterns, where-to-start flows
- [ ] `AGENTS.md` symlinked to `CLAUDE.md`
- [ ] `ARCHITECTURE.md` exists with module map, request lifecycle traces, state machines
- [ ] Layer architecture defined and documented
- [ ] `eslint-plugin-import-x` configured with `no-restricted-paths`
- [ ] `scripts/check-deps.sh` passes (no bidirectional coupling)
- [ ] `scripts/check-architecture.sh` passes (all dirs documented)
- [ ] Reference docs exist for niche dependencies with version locks
- [ ] Key state machines have table-driven tests
- [ ] All checks wired into CI
