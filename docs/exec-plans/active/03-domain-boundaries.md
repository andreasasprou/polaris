---
title: Define Domain Boundaries & Dependency Rules
status: completed
created: 2026-03-19
owner: andreas
related_prs: []
domains: [all lib/ directories, eslint.config.mjs]
---

# 03 — Domain Boundaries & Dependency Rules

## Problem Statement

### What
No enforced dependency rules between the 19 `lib/` directories. Strong bidirectional directory-level coupling exists between top-level `lib/` directories (sessions ↔ jobs, jobs ↔ orchestration), 42+ dynamic `await import()` calls obscure the dependency graph, and nothing prevents upward imports from foundation modules into domain modules. Note: Codex ran Tarjan's SCC algorithm across all 87 source files and found **zero file-level circular dependencies** — the issue is directional coupling between directories, not import cycles between individual files.

### Why
The Codex blog: "strict boundaries and predictable structure are an early prerequisite for coding agents — the constraints allow speed without decay." Without enforcement, every agent change risks deepening coupling.

## Proposed Layer Architecture

```
Layer 0 — Foundation (zero domain knowledge)
  lib/http/, lib/metrics/

Layer 1 — Schema (DB table definitions, error types)
  lib/db/, lib/errors/

Layer 2 — Domain (business entities, CRUD, domain logic)
  lib/auth/, lib/credentials/, lib/secrets/, lib/integrations/,
  lib/automations/, lib/sandbox/, lib/sandbox-agent/, lib/sandbox-proxy/,
  lib/sandbox-env/, lib/sessions/, lib/jobs/, lib/reviews/, lib/routing/

Layer 3 — Orchestration (multi-domain workflows)
  lib/orchestration/

Layer 4 — Presentation (UI and API routes)
  hooks/, components/, app/
```

### Dependency Rules

| Layer | Can Import From |
|-------|----------------|
| L0 | Nothing in lib/ |
| L1 | L0, other L1 files |
| L2 | L0, L1, L2 siblings (no cycles) |
| L3 | L0, L1, L2, L3 siblings (no cycles) |
| L4 | L0, L1, L2, L3 |

### Identified Violations

1. **`lib/errors/` imports `lib/sandbox/` and `lib/sandbox-agent/`** — Foundation → Domain
2. **`lib/credentials/resolver.ts` imports `lib/automations/`** — Mixed-layer / orchestration leak (both `credentials/` and `automations/` are Layer 2; the real issue is that `resolver.ts` performs cross-domain orchestration that doesn't belong in either L2 directory)
3. **`lib/jobs/` ↔ `lib/sessions/`** — Bidirectional directory-level coupling (the hardest problem)
4. **`lib/jobs/postprocess.ts` imports `lib/orchestration/`** — Creates cycle: routing → orchestration → jobs → orchestration
5. **42+ dynamic `await import()` calls** — Some are legitimate lazy loading, but others obscure the dependency graph
6. **`lib/automations/actions.ts` creates interactive sessions** — Orchestration behavior in a Layer 2 "Domain" directory (known gap — not addressed in this plan's current phases)

### Mixed-Layer Files

Several directories contain files at different layers:
- `lib/sessions/`: `schema.ts`, `status.ts` (L1) + `actions.ts` (L2) + `prompt-dispatch.ts`, `sandbox-lifecycle.ts` (L3)
- `lib/jobs/`: `schema.ts`, `status.ts` (L1) + `actions.ts` (L2) + `postprocess.ts`, `callbacks.ts`, `sweeper.ts` (L3)

## Refactoring Plan

### Phase 1: Fix Upward Dependencies

**1a.** Fix `lib/errors/session-errors.ts`: Replace `instanceof` checks with error code discriminants. Define `CodedException` interface in errors/, have sandbox errors implement it. **Note:** `errors/session-errors.ts` currently has no call sites — the upward dependency is real but dormant/dead code. This is low leverage; consider deleting the file outright if no consumer materializes.

**1b.** Move `lib/credentials/resolver.ts` → `lib/orchestration/credential-resolver.ts`. Update single call site in `coding-task.ts`.

### Phase 2: Break sessions/jobs Circular Dependency

**2a.** Move `incrementEpoch` from `lib/jobs/actions.ts` to `lib/sessions/actions.ts` (it operates on the sessions table). Update 2 call sites.

**2b.** Move orchestration files out of `lib/jobs/`:
- `jobs/postprocess.ts` → `orchestration/postprocess.ts`
- Extract session-healing from `jobs/callbacks.ts` into `orchestration/callback-processor.ts`
- Move cross-domain sweep logic from `jobs/sweeper.ts` → `orchestration/sweeper.ts`

**2c.** Move orchestration files out of `lib/sessions/`:
- `sessions/prompt-dispatch.ts`: **Split before move.** Extract shared helpers (`buildCallbackUrl`, `resolveSessionCredentials`, `probeSandboxHealth`) into their own modules first (e.g. `lib/sessions/helpers.ts` or appropriate domain homes), then move only the orchestration entrypoint to `orchestration/prompt-dispatch.ts`.
- `sessions/sandbox-lifecycle.ts` → `orchestration/sandbox-lifecycle.ts`

### Phase 3: ESLint Enforcement

**3a.** Install `eslint-plugin-import-x` (ESM + flat config compatible)

**3b.** Configure `no-restricted-paths` rules per layer. Error messages written FOR agents:
```
"Domain modules cannot import from Orchestration. If you need orchestration logic
from a domain module, this is a sign the logic should be moved to lib/orchestration/."
```

**3c.** Add directory-level coupling check: a script or `madge`-based check that verifies no bidirectional imports exist between top-level `lib/` directories at the same layer. (`madge --circular` already passes today at the file level, so it is not useful as a new gate.)

### Phase 4: CI Enforcement

- `pnpm lint` catches all layer violations (eslint-plugin-import-x `no-restricted-paths`)
- `pnpm deps:check` catches bidirectional directory-level coupling
- Both run in CI

## Migration Order (dependency-aware)

| Step | Files Modified | Risk |
|------|---------------|------|
| 1a | 3 files (or 1 deletion) | Low — adds code property to errors (or delete dead file) |
| 1b | 2 files | Low — one call site update |
| 2a | 3 files | Low — move function + 2 call sites |
| 2b | ~8 files | Medium — postprocess has many dynamic imports; 4 importers need updating (2 API routes, pr-review, sweeper) |
| 2c | ~8 files | Medium — prompt-dispatch imported by 4 files (2 API routes, pr-review, sweeper); sandbox-lifecycle imported by 4 files; plus helper extraction step |
| 3a-c | 2 files | Low — lint config only |

### Special Case: lib/db/schema.ts

The schema registry re-exports all domain schemas (Drizzle requirement). Treated as an exception. Note: all consumers import `@/lib/db` (which re-exports via `lib/db/index.ts` → `lib/db/schema.ts`), not `@/lib/db/schema` directly. No special ESLint rule is needed for this path — the standard layer rules already cover it since `lib/db/` is Layer 1 and importable by all higher layers.

### New Module Onboarding

When creating a new `lib/` directory:
1. Declare layer in a comment at top of main file
2. Add to ESLint layer config
3. Run `pnpm lint` + `pnpm deps:check`
4. Update ARCHITECTURE.md module map

## Final Target State

```
lib/orchestration/ (after refactoring):
  coding-task.ts          (existing)
  pr-review.ts            (existing)
  prompt-dispatch.ts      (from sessions/)
  sandbox-lifecycle.ts    (from sessions/)
  credential-resolver.ts  (from credentials/)
  postprocess.ts          (from jobs/)
  callback-processor.ts   (extracted from jobs/callbacks.ts)
  sweeper.ts              (cross-domain parts from jobs/sweeper.ts)
```

No bidirectional coupling between top-level `lib/` directories. All cross-layer imports flow downward. Dynamic imports are not used to work around layer violations (lazy loading of heavy modules remains acceptable). Every violation caught at lint time.

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | 5-layer model | Matches actual code structure; orchestration is a clear distinct layer | 3-layer (foundation/domain/presentation): orchestration files don't fit neatly |
| 2026-03-19 | Move files to orchestration/ vs mediator pattern | Simpler; makes the layer explicit in the file path | Callback registration: adds indirection without clarity |
| 2026-03-19 | eslint-plugin-import-x over custom rule | Maintained, flat-config compatible, handles dynamic imports | Custom ESLint rule: more work, same result |
| 2026-03-19 | Reframe goal from "break cycles" to "enforce directional coupling" | Codex review ran Tarjan's SCC algorithm across 87 source files and found zero file-level circular dependencies. The real problem is bidirectional directory-level coupling, not import cycles. `madge --circular` would already pass today. | Keep "break cycles" framing: rejected because it mischaracterizes the problem and sets a completion criterion that is already met |

## Progress

- [x] Phase 1a: Fix errors/ upward imports (deleted dead session-errors.ts)
- [x] Phase 1b: Move credentials/resolver.ts to orchestration/
- [x] Phase 2a: Move incrementEpoch to sessions/actions.ts
- [x] Phase 2b: Move postprocess, callback-processor, sweeper to orchestration/
- [x] Phase 2c: Move prompt-dispatch, sandbox-lifecycle to orchestration/
- [x] Phase 3: Install eslint-plugin-import-x + configure rules
- [x] Phase 3: Add directory-level coupling check (scripts/check-deps.sh)
- [x] Phase 4: Verify CI catches violations (pnpm lint + pnpm check:deps)
- [x] Update ARCHITECTURE.md module map after moves

## Completion Criteria

- [x] `pnpm lint` passes with no layer violations
- [x] No bidirectional imports between top-level `lib/` directories at the same layer
- [x] ESLint `no-restricted-paths` passes with zero violations
- [x] Dynamic imports are not used to work around layer violations (lazy loading of heavy modules remains acceptable)
- [x] ARCHITECTURE.md module map updated
- [x] `pnpm typecheck` passes (only pre-existing evlog type errors remain)
