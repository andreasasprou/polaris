---
title: Evolve CLAUDE.md with Navigation Pointers and Anti-Patterns
status: active
created: 2026-03-19
owner: andreas
related_prs: []
domains: [CLAUDE.md, AGENTS.md]
---

# 02 — Evolve CLAUDE.md with Navigation Pointers & Anti-Patterns

## Problem Statement

### What
CLAUDE.md (symlinked as AGENTS.md for Codex compatibility) is 40 lines with architecture principles, QA checklist, and commands. It works as a behavioral guide but provides no structural navigation — agents don't know where to start for a given task.

### Why
The OpenAI Codex blog: "give the agent a map, not a 1,000-page instruction manual." CLAUDE.md is read automatically by Claude Code (AGENTS.md by Codex). It should answer "where do I start?" in under 30 seconds.

### Relationship to Plan 01
Plan 01 (ARCHITECTURE.md) owns the full structural codemap (domain table, entry points, dependency graph). This plan does NOT duplicate that. Instead, CLAUDE.md gets brief navigation pointers into ARCHITECTURE.md and the `docs/` directory, plus anti-patterns and verification instructions that shape agent behavior.

## Design

### New Structure (6 sections, target 60–80 lines)

| Section | Lines | Content |
|---------|-------|---------|
| Architecture Principles | ~7 | Keep as-is (no plasters, data produces state, context params) |
| Codebase Navigation | ~5 | Points to ARCHITECTURE.md for the full codemap + lists `docs/` directory |
| Where to Start | ~10 | 3–5 high-value task-oriented flow pointers with full file paths |
| Anti-Patterns | ~10 | Real incident-sourced warnings (never use Bearer for git, etc.) |
| Testing & Verification | ~12 | Condensed QA process + pointer to `docs/qa-checklist.md` |
| Key Commands | ~4 | Keep as-is + add `pnpm test` |

### Codebase Navigation Section (replaces Codemap)

CLAUDE.md should NOT contain a full codemap table — that lives in ARCHITECTURE.md (see Plan 01). Instead, 3–5 lines that orient the agent:

```markdown
## Codebase Navigation

- Full domain map and entry points: see `ARCHITECTURE.md`
- Architecture decisions and design docs: `docs/architecture/`
- Execution plans: `docs/exec-plans/active/`
- QA checklist for session/sandbox changes: `docs/qa-checklist.md`
```

### Where to Start Section

Trimmed to 3–5 highest-value flows. All file references use full paths:
- "Changing session lifecycle?" → `lib/sessions/status.ts` → `lib/sessions/actions.ts` → `lib/sandbox/sandbox-lifecycle.ts`
- "Modifying PR review logic?" → `lib/reviews/prompt-builder.ts` → `lib/orchestration/pr-review.ts`
- "Adding a new session status?" → Add to `lib/sessions/status.ts` statusConfig → update UI `statusConfig` maps in components → verify in all contexts (detail page, runs page, session list)

### Anti-Patterns Section

Sourced from `docs/qa-checklist.md`, git history, and past incidents documented in architecture docs:
- Never use Bearer auth for git HTTPS (incident: sandbox clone failures)
- Never assume `git diff --cached origin/main` works in sandbox (returns empty)
- Never check stderr to determine git push success (git writes progress there)
- Always end stale runtimes before creating new ones (unique constraint crash)
- Always wrap CAS + trigger in try/catch with rollback (stuck sessions)
- When adding a new session status, update ALL statusConfig maps

### Bloat Prevention

Two mechanisms:
1. **Graduation protocol**: Rules consistently followed → lints. Anti-patterns detectable programmatically → assertions. Where-to-start entries obvious from naming → remove.
2. **Line target (60–80)**. Comment at top reminds contributors to keep it tight. Content that doesn't fit graduates to `docs/`.

Comment at top: `<!-- Line budget: ~70 lines. Graduate detailed content to docs/. -->`

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | 60–80 line target (no CI gate) | Current 40-line file is dense and opinionated — we're adding ~30 lines of navigation + anti-patterns, not a codemap. CI gate is over-engineered for this size. | 120-line hard cap: too generous, invites bloat |
| 2026-03-19 | Anti-patterns from real incidents only | Speculative anti-patterns add noise without value | Empty section initially: misses known landmines |
| 2026-03-19 | Navigation pointers instead of codemap | ARCHITECTURE.md (Plan 01) owns the full codemap; duplicating it in CLAUDE.md creates staleness risk | Full codemap table: conflicts with Plan 01, adds 30 lines |
| 2026-03-19 | AGENTS.md symlink to CLAUDE.md | Single source of truth for both Claude Code and Codex agents | Separate files: drift risk |

## Progress

- [ ] Rewrite CLAUDE.md with 6-section structure (target 60–80 lines)
- [ ] Add `<!-- Line budget -->` comment
- [ ] Verify AGENTS.md symlink points to CLAUDE.md
- [ ] Run `pnpm typecheck`

## Risks & Mitigations

| Risk | Severity | Mitigation |
|------|----------|------------|
| Navigation pointers to ARCHITECTURE.md become stale | Low | Only 3–5 lines to maintain; ARCHITECTURE.md is source of truth |
| Anti-patterns grow unbounded | Low | Max 8 entries; graduate to lints when possible |
| Where-to-start pointers become wrong after refactors | Medium | Pointers use full file paths (stable) not line numbers (fragile); only 3–5 flows to maintain |

## Completion Criteria

- [ ] CLAUDE.md has all 6 sections
- [ ] Line count 60–80
- [ ] Codebase Navigation section points to ARCHITECTURE.md (no duplicated codemap)
- [ ] At least 5 anti-patterns sourced from `docs/qa-checklist.md`, git history, and architecture docs
- [ ] AGENTS.md is a symlink to CLAUDE.md
- [ ] `pnpm typecheck` passes
