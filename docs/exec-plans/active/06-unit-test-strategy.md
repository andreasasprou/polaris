---
title: Unit Test Strategy for Core Business Logic
status: completed
created: 2026-03-19
owner: andreas
related_prs: []
domains: [sessions, jobs, reviews, routing, credentials, errors, sandbox-agent]
---

# 06 — Unit Test Strategy

## Problem Statement

### What
86 source files, 4 integration tests, zero unit tests. Substantial pure-function business logic (state machines, parsers, classifiers, matchers) has no test coverage.

### Why
Tests ARE boundaries. Agents can't verify their own changes without them. `pnpm test` should catch regressions before `pnpm typecheck` even runs.

## Test Organization

Location: `tests/unit/` mirroring `lib/` structure. Existing `vitest.config.ts` pattern `tests/**/*.test.ts` already covers this.

```
tests/unit/
  # Tier 1 (first pass)
  sessions/status.test.ts
  jobs/status.test.ts
  reviews/output-parser.test.ts
  reviews/filters.test.ts
  reviews/github-events.test.ts
  routing/matchers.test.ts
  reviews/diff.test.ts
  # Tier 2 (second pass)
  jobs/callback-auth.test.ts
  reviews/manual-trigger.test.ts
  reviews/classification.test.ts
  credentials/encryption.test.ts
  sandbox-agent/agent-profiles.test.ts
```

Add script: `"test:unit": "vitest run tests/unit"` (`test:integration` already exists in package.json)

## Testing Philosophy

- **Tests as agent guardrails**: Run `pnpm test` to verify changes
- **Test behavior, not implementation**: Input/output contracts, state transitions, error shapes
- **Data-driven `check` pattern**: Table of `[input, expected]` tuples. Adding a case = one line.
- **No DB mocking**: Unit tests target pure functions. Functions that import `db` belong in integration tests.

## Implementation Tiers

### Tier 1 — Must-have (first pass)

**`tests/unit/sessions/status.test.ts`** — Target: `lib/sessions/status.ts`
- Completeness: every status has STATUS_CONFIG entry
- Terminal states: isTerminal true, pollIntervalMs 0
- Active states: pollIntervalMs 2000
- canSend/canStop matrices
- getStatusConfig fallback behavior

**`tests/unit/jobs/status.test.ts`** — Target: `lib/jobs/status.ts`
- Exhaustive transition matrix: every valid transition returns true, every invalid returns false
- Terminal status sets are disjoint from active
- isJobTerminal / isAttemptTerminal for all statuses
- Generate test cases programmatically from JOB_TRANSITIONS map
- Include `ATTEMPT_TRANSITIONS` and `isValidAttemptTransition` in the jobs/status test — the attempt state machine is equally critical for callback processing

**`tests/unit/reviews/output-parser.test.ts`** — Target: `lib/reviews/output-parser.ts`
- Test through the public `parseReviewOutput` function only. Exercise internal strategies (strict JSON, lenient JSON, unfenced JSON, regex fallback) via input variation, not direct calls to private functions.
- Returns null for unparseable output

**`tests/unit/reviews/filters.test.ts`** — `shouldReviewPR` decision matrix
- Explicit edge case: skips pathFilter enforcement when `changedFiles` is missing (permissive fallthrough)

**`tests/unit/reviews/github-events.test.ts`** — GitHub event classification

**`tests/unit/routing/matchers.test.ts`** — Event matching, branch filtering
- Explicit edge cases: skips branch filtering when `ref` is absent; auto-matches `issue_comment.created` for PR configs

**`tests/unit/reviews/diff.test.ts`** — Target: `lib/reviews/diff.ts`
- 422 fallback to patch reconstruction
- Diff truncation at byte budget
- File list extraction from diff output
- Empty diff handling

### Tier 2 — Second pass

**`tests/unit/jobs/callback-auth.test.ts`** — Target: `lib/jobs/callback-auth.ts`
- signCallback determinism, verifyCallback round-trip
- Wrong key rejected, tampered payload rejected
- Malformed signatures handled

**`tests/unit/reviews/manual-trigger.test.ts`** — Command parsing (/review, /review full, etc.)
**`tests/unit/reviews/classification.test.ts`** — File classification (production vs relaxed)
**`tests/unit/credentials/encryption.test.ts`** — Round-trip, different ciphertexts, tampered rejection
**`tests/unit/sandbox-agent/agent-profiles.test.ts`** — resolveAgentConfig for each agent/mode

### Tier 3 — Defer (unless a bug points there)

**`tests/unit/reviews/comment-renderer.test.ts`** — Comment rendering
**`tests/unit/reviews/prompt-builder.test.ts`** — Prompt construction
**`tests/unit/metrics/step-timer.test.ts`** — Step timing
**`tests/unit/sandbox/SandboxHealthMonitor.test.ts`** — Health checks with vi.useFakeTimers()
**`tests/unit/secrets/validation.test.ts`** — Secret validation

## What NOT to Test

- DB action functions (use integration tests with real Postgres)
- API routes (HTTP handlers — integration/E2E)
- UI components (browser automation)
- Pure Drizzle wrappers (thin, covered by integration tests)

## AGENTS.md Updates

Add to Key Commands:
```
- `pnpm test` — all tests. Must pass before work is complete.
- `pnpm test:unit` — unit tests only (fast, no DB)
```

Add Unit Test Policy section:
- Modifying lib/ files? Check for tests, update them.
- Adding new pure functions? Add tests.
- State machine changes? Must include test updates.

## Implementation Order

| Phase | What | Effort |
|-------|------|--------|
| 1 | jobs/status + sessions/status + output-parser | ~2h |
| 2 | filters + matchers + github-events + diff | ~2h |
| 3 | Tier 2 files as needed | ~2h |
| 4 | AGENTS.md updates | ~30m |

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | Centralized tests/unit/ over co-located | Matches existing vitest pattern; doesn't pollute lib/ | Co-located: requires vitest config change |
| 2026-03-19 | Data-driven check pattern | Scales with agents; adding case = one line | Individual it() blocks: more boilerplate |
| 2026-03-19 | No DB mocking | User preference; past incident where mocks diverged from prod | Mock DB: faster but less reliable |

## Progress

### Phase 1 — State machines + parser
- [ ] sessions/status.test.ts
- [ ] jobs/status.test.ts (including ATTEMPT_TRANSITIONS)
- [ ] reviews/output-parser.test.ts

### Phase 2 — Trigger gating + diff
- [ ] reviews/filters.test.ts
- [ ] routing/matchers.test.ts
- [ ] reviews/github-events.test.ts
- [ ] reviews/diff.test.ts

### Phase 3 — Tier 2 (as needed)
- [ ] jobs/callback-auth.test.ts
- [ ] reviews/manual-trigger.test.ts
- [ ] reviews/classification.test.ts
- [ ] credentials/encryption.test.ts
- [ ] sandbox-agent/agent-profiles.test.ts

### Phase 4
- [ ] AGENTS.md unit test policy

## Completion Criteria

- [ ] Tier 1 tests cover: all state machine transitions (job + attempt), review output parsing recovery strategies, trigger gating permissive edge cases, diff fallback/truncation
- [ ] AGENTS.md documents test commands and policy
- [ ] `pnpm test` passes (unit + integration)
- [ ] `pnpm typecheck` passes
