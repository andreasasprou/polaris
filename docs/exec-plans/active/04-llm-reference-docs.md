---
title: LLM-Optimized Reference Documentation
status: active
created: 2026-03-19
owner: andreas
related_prs: []
domains: [docs]
---

# 04 — LLM-Optimized Reference Documentation

## Problem Statement

### What
Polaris relies on niche/recent APIs (`@vercel/sandbox`, `sandbox-agent`, `acp-http-client`) that are poorly represented in LLM training data. Agents hallucinate non-existent methods, use wrong parameter shapes, and miss critical gotchas.

### Why
The Codex blog stores `*-llms.txt` reference docs for key deps. These are the highest-ROI investment for niche APIs — agents read real type definitions instead of guessing.

## Directory Structure

```
docs/references/
  vercel-sandbox-llms.txt        # @vercel/sandbox@1.8.0
  sandbox-agent-llms.txt         # sandbox-agent@0.3.2
  acp-http-client-llms.txt       # acp-http-client@0.3.2
```

**Why `.txt`?** Cheaper in tokens, renders identically everywhere, signals "for LLM consumption."

## Document Format

```
# <Package Name> Reference — v<version>
# Source: <npm URL>
# Polaris usage: <one-line description>
# Last updated: YYYY-MM-DD
# Locked version: <installed version from node_modules/<pkg>/package.json>

## Quick Summary
<2-3 sentences>

## Core API Surface
<Verbatim TypeScript declarations from .d.ts files — NOT paraphrased>

## Polaris Usage Patterns
<Code patterns from actual codebase, referencing files>

## Gotchas & Hard-Won Knowledge
<From MEMORY.md and past bugs. Problem, cause, fix.>

## What NOT To Do
<Anti-patterns agents commonly attempt>

## Common Error Messages & Fixes
<Error strings with root cause and resolution>
```

**Target length** (per-package estimates):
- `@vercel/sandbox`: ~200-300 lines (curated used-surface)
- `sandbox-agent`: ~150-250 lines (curated)
- `acp-http-client`: ~80-120 lines (small)

## Priority Order

### First Pass (Active)

| # | Package | Risk Level | Gotchas in MEMORY.md |
|---|---------|-----------|---------------------|
| 1 | `@vercel/sandbox` | CRITICAL | 6+ gotchas (network policy, git auth, command API, writeFiles) |
| 2 | `sandbox-agent` | CRITICAL | 5+ gotchas (text replay vs native resume, RPC compat, events) |
| 3 | `acp-http-client` | HIGH | 4+ gotchas (transport path, unstableResumeSession, extMethod) |

### Deferred

Defer until repeated evidence that agents are failing on these deps.

| # | Package | Risk Level | Notes |
|---|---------|-----------|-------|
| 4 | `drizzle-orm` | MEDIUM | Barrel exports, not a usable single surface; 3+ gotchas but agents rarely hallucinate here |
| 5 | `better-auth` | LOW | Uses `.d.mts` not `.d.ts`; stable, small API surface |
| 6 | `@trigger.dev/sdk` | LOW-MEDIUM | Complex but well-documented in docs/architecture/ |

### Package Structure Notes

Not all packages have clean `dist/*.d.ts` files. Per-package manual curation is required (no generic extraction script):

- **`@vercel/sandbox`**: Clean split across `sandbox.d.ts`, `command.d.ts`, `network-policy.d.ts`, `snapshot.d.ts` (~889 lines total). Include only the methods Polaris actually uses: `Sandbox.create/get`, `runCommand`, `stop`, `snapshot`, `extendTimeout`, `updateNetworkPolicy`, `writeFiles`, `Command.stdout/stderr`.
- **`sandbox-agent`**: 1,784-line generated bundle where useful classes start around line 1558. Needs manual extraction of the relevant surface.
- **`acp-http-client`**: Only 69 lines locally; meaningful types come from `@agentclientprotocol/sdk`. Curate from both sources.

## Version Freshness System

### CI Check (`scripts/check-reference-versions.ts`)

For each `docs/references/*-llms.txt`:
1. Parse the `# Locked version:` comment line from the first 10 lines of each `.txt` file, along with the package name
2. Compare against installed version in `node_modules/<pkg>/package.json` (not the semver range in root `package.json`)
3. If versions differ → fail with clear message

Add to `package.json`: `"check:reference-docs": "tsx scripts/check-reference-versions.ts"`

### Regeneration Workflow

When a dep bumps: re-curate the relevant `.txt` doc from updated `.d.ts` files → review diff → update gotchas → commit with updated version.

## Curation Approach

Manually curate each doc using the used-surface + gotchas pattern. There is no generic generation script — package structures are too heterogeneous (see Package Structure Notes above).

For `@vercel/sandbox`, include only the methods Polaris actually uses (`Sandbox.create/get`, `runCommand`, `stop`, `snapshot`, `extendTimeout`, `updateNetworkPolicy`, `writeFiles`, `Command.stdout/stderr`). For `sandbox-agent` and `acp-http-client`, extract only the classes/methods referenced in `lib/sandbox/` and `lib/agents/`.

## Agent Discovery

AGENTS.md addition:
```markdown
## Reference Documentation
Working with niche dependencies? Read the reference doc first:
- Vercel Sandbox: `docs/references/vercel-sandbox-llms.txt`
- Sandbox Agent: `docs/references/sandbox-agent-llms.txt`
- ACP HTTP Client: `docs/references/acp-http-client-llms.txt`
```

## Decision Log

| Date | Decision | Rationale | Alternatives |
|------|----------|-----------|-------------|
| 2026-03-19 | .txt over .md | Cheaper tokens, signals LLM-target, no rendering ambiguity | .md: no real benefit for agent consumption |
| 2026-03-19 | Verbatim .d.ts over paraphrased | Agents need exact types; paraphrasing introduces errors | Summary only: agents can't verify parameter shapes |
| 2026-03-19 | CI version check | #1 staleness vector is dep bumps without doc update | Manual: forgotten within a week |
| 2026-03-19 | Manual curation over generic script | Codex review found package structure heterogeneity: clean split `.d.ts` (@vercel/sandbox), 1784-line generated bundle (sandbox-agent), 69-line stub with types in upstream dep (acp-http-client), barrel exports (drizzle-orm), `.d.mts` not `.d.ts` (better-auth). A generic extraction script would need per-package special cases anyway — manual curation is simpler and produces better results. | Generic `generate-reference-docs.ts` script: dropped |
| 2026-03-19 | Top 3 only in first pass | Agents primarily hallucinate on sandbox/agent/acp APIs. drizzle, better-auth, trigger-dev failures are rare. | All 6 at once: higher effort, lower marginal ROI |

## Progress

- [ ] Create `docs/references/` directory
- [ ] Curate `vercel-sandbox-llms.txt`
- [ ] Curate `sandbox-agent-llms.txt`
- [ ] Curate `acp-http-client-llms.txt`
- [ ] Write `scripts/check-reference-versions.ts`
- [ ] Add AGENTS.md reference section

## Completion Criteria

- [ ] 3 reference docs created (top 3 priority deps)
- [ ] Each has Core API Surface with real .d.ts content
- [ ] Each has at least 3 Gotchas from MEMORY.md
- [ ] Version freshness CI script works
- [ ] AGENTS.md has Reference Documentation section
- [ ] `pnpm typecheck` passes
