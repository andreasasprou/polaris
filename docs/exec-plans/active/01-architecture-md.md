---
title: Create ARCHITECTURE.md
status: completed
created: 2026-03-19
owner: andreas
related_prs: []
domains: [docs, CLAUDE.md]
---

# 01 — Create ARCHITECTURE.md

## Problem Statement

### What
Polaris has no top-level structural map of the codebase. There are 87 TS/TSX files across 18 top-level `lib/` directories, plus 10 architecture docs in `docs/architecture/`, but nothing that answers "where is the thing that does X?" or "what does this directory do?" at a glance.

### Why
matklad's insight: "it takes 2x more time to write a patch if unfamiliar, but 10x more time to figure out WHERE to change." For agents, this is even more acute — they waste tokens exploring wrong files.

## Design

### Structure (7 sections, target 300-400 lines)

```
# Polaris Architecture
## One-Paragraph Overview (5-8 lines)
## System Topology (ASCII diagram, 15-25 lines)
## Request Lifecycle (two flows traced end-to-end, 40-60 lines)
## Module Map (one entry per lib/ directory, 60-80 lines)
## State Machines (session + job status, 30-40 lines)
## Invariants (numbered rules with NEVER/ALWAYS, 40-60 lines)
## Cross-Cutting Concerns (durability, retries, fencing, dedupe, hibernation, lock ownership, auth, DB, 30-40 lines)
```

### Section Details

**One-Paragraph Overview**: What Polaris is, runtime model, key external deps (Vercel Sandbox, Postgres, GitHub App). Establishes mental model in 30 seconds.

**System Topology**: ASCII diagram showing the four runtime boundaries:
- Vercel (serverless) — API routes, orchestration
- Vercel Sandbox VM — proxy, agent CLI, git
- PostgreSQL — state coordination via CAS
- GitHub — webhooks in, PRs/comments out
Name actual files and ports in the diagram.

**Request Lifecycle**: Two complete flows traced end-to-end:
- Flow A: User sends a message in an interactive session (browser → API → sandbox → callback → postprocess)
- Flow B: GitHub webhook triggers a PR review (webhook → routing → dedupe → orchestration → sandbox → review output)
Each step names the actual file.

**Module Map**: One entry per `lib/` directory. Format:
```
### lib/sessions/ — Session Lifecycle
Session state machine, prompt dispatch, sandbox provisioning, HITL.
Key types: `interactiveSessions` (Drizzle table), `SessionStatus`, `STATUS_CONFIG`.
Depends on: db, sandbox, jobs, integrations.
```

**State Machines**: Session status transitions + job status transitions. Name the authoritative file (`lib/sessions/status.ts`, `lib/jobs/status.ts`). Include ASCII transition diagrams.

**Invariants**: The "absence of something" section. Critical rules:
1. Sandbox never sees raw tokens (network policy brokering)
2. Contested state transitions use CAS (compare-and-swap). Non-contested transitions (e.g., runtime creation, hibernation cleanup) may use direct writes where only one actor can reach the state.
3. Every callback carries epoch fencing token
4. One live runtime per session (partial unique index)
5. HMAC keys never in job payload
6. Post-processing side effects are idempotent (tracked in JSONB)
7. v2 dispatch path uses jobs table, not Trigger.dev. Legacy naming (e.g., `trigger-router.ts`) persists but the Trigger.dev SDK is no longer in the orchestration hot path.
8. Sweeper uses advisory locks (single concurrent sweep)
9. Data produces correct state; UI just renders
10. Review locks are primarily job-fenced (`review_lock_job_id`), but stale-lock cleanup uses a 30-minute time window as a fallback safety net.

**Cross-Cutting Concerns**: Prioritize durability, retries, fencing, dedupe, hibernation, and lock ownership. Also cover: auth (Better Auth + GitHub App), multi-tenancy (org-scoped), error handling (RequestError + SessionError), supported agents (Claude/Codex/OpenCode/AMP), database (Drizzle ORM).

### Writing Style
- Name files, not abstractions ("See `lib/jobs/sweeper.ts`" not "see the sweeper")
- Name types to search for (enables Ctrl+Shift+F)
- Document the absence of things (Invariant 7 is more valuable than what IS there)
- Present tense, active voice
- No deep links to line numbers (stale); file paths only

### Staying Fresh

**CI script** (`scripts/check-architecture.sh`):
1. List all directories under `lib/` (one level deep)
2. For each, check ARCHITECTURE.md contains `lib/<dirname>/`
3. Fail CI if any lib/ directory is missing

> CI should only validate presence of lib/ directory mentions, not enforce line count.

Add to `package.json`: `"check:architecture": "bash scripts/check-architecture.sh"`

Add comment at top of ARCHITECTURE.md:
```
<!-- CI: scripts/check-architecture.sh validates every lib/ directory is mentioned. -->
```

### Relationship to CLAUDE.md
- CLAUDE.md = behavioral rules + quick navigation (how to behave)
- ARCHITECTURE.md = structural map + invariants (where things are)
- CLAUDE.md gets a one-line pointer: "For structural map, see ARCHITECTURE.md"
- No content duplication between the two

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | 7-section structure | Covers bird's eye → module detail → invariants → cross-cutting. Progressive disclosure. | Single flat list: less navigable. Separate docs per section: too fragmented. |
| 2026-03-19 | CI validation for lib/ coverage | Prevents the #1 staleness vector (new domain added, doc not updated) | Manual review: doesn't scale |
| 2026-03-19 | Name types without linking | Links go stale; names enable search; search discovers related types | Deep links: break on refactor |

## Missing / Additional Items

- **Attempt state machine**: Must be documented alongside job/session state machines (attempt lifecycle is distinct and non-obvious).
- **Cron/sweeper in system topology**: The sweeper belongs in the System Topology ASCII diagram as a first-class runtime actor, not as a side note.
- **API entrypoints subsection**: Add an explicit subsection for the four main API entrypoints: prompt route, webhook route, callbacks route, sweeper route.
- **Lock acquisition timing mismatch**: `dispatchPrReview()` acquires the review lock *before* the review job exists. The doc should accurately reflect this ordering rather than paper over it.

## Progress

- [ ] Draft ARCHITECTURE.md with all 7 sections
- [ ] Document attempt state machine alongside job/session state machines
- [ ] Add sweeper as first-class actor in System Topology diagram
- [ ] Add API entrypoints subsection (prompt, webhook, callbacks, sweeper)
- [ ] Note lock acquisition ordering in `dispatchPrReview()` (lock acquired before job exists)
- [ ] Create `scripts/check-architecture.sh`
- [ ] Add `check:architecture` script to `package.json`
- [ ] Add pointer to ARCHITECTURE.md from CLAUDE.md
- [ ] Run `pnpm typecheck` to verify no breakage

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Document grows past 400 lines | Medium | Module map entries max 4 lines; review in PR |
| Stale architecture docs in docs/architecture/ cause confusion | Low | ARCHITECTURE.md notes: "docs/architecture/ contains frozen design specs; this doc is the as-built map" |
| Agents ignore ARCHITECTURE.md | Low | CLAUDE.md pointer ensures it's in the discovery path |

## Completion Criteria

- [ ] ARCHITECTURE.md exists at repo root (300-400 lines)
- [ ] Every `lib/` directory has an entry in Module Map
- [ ] At least 8 invariants documented
- [ ] CI script passes
- [ ] CLAUDE.md has pointer to ARCHITECTURE.md
- [ ] `pnpm typecheck` passes
