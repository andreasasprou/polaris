---
title: Execution Plans System
status: active
created: 2026-03-19
owner: andreas
related_prs: []
domains: [docs, process]
---

# Execution Plans System

## Problem
### What
Multi-step changes get lost between agent sessions. There is no lightweight way to track decisions, progress, and known issues across conversations.

### Why
Agents repeat work, contradict earlier decisions, and miss context that was established in previous sessions. A minimal docs-based system gives agents (and humans) a shared scratchpad.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-19 | Docs-only, no tooling | Keep it simple; markdown is sufficient for now |
| 2026-03-19 | No index/registry file | Git and glob are the discovery mechanism |
| 2026-03-19 | Simplified template (~25 lines) | Must fit on one screen to stay useful |

## Progress

- [x] Create `docs/exec-plans/archive/` directory
- [x] Create `docs/exec-plans/templates/plan-template.md`
- [x] Create `docs/exec-plans/known-hotspots.md`
- [ ] Consolidation pass: update AGENTS.md/CLAUDE.md to reference exec-plans

## Done When

- [x] `docs/exec-plans/` structure exists with template, hotspots, and archive dir
- [ ] CLAUDE.md references exec-plans convention
- [ ] `pnpm typecheck` passes
