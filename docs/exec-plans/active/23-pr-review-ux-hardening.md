---
title: PR Review UX Hardening — Guidance Loading, Prompt Quality, Inline Delivery, and GitHub Presentation
status: planned
created: 2026-03-22
owner: andreas
related_prs: []
domains: [reviews, github, orchestration, prompts]
---

# 23 — PR Review UX Hardening — Guidance Loading, Prompt Quality, Inline Delivery, and GitHub Presentation

## Problem
### What
Polaris already has the important review architecture:

- durable `jobs` / `job_attempts`
- PR-scoped continuity in `automation_sessions`
- structured review metadata with continuity state
- platform-owned GitHub side effects
- best-effort inline comment support

The remaining gaps are mostly review ergonomics and rendering quality:

- changed-path scoped repository guidance is not actually wired into the review path because `loadRepoGuidelines()` is called with `[]`
- review prompts are solid but still too generic in a few high-value places
- inline review comments exist, but the delivery path is still thin and not clearly hardened against bad anchors
- GitHub check output is still sparse
- stale/superseded review presentation can be clearer

### Why
This is leverage on top of the existing architecture, not a replacement for it.

Improving review quality and GitHub delivery matters because:

- review usefulness is perceived mainly through the PR comment, inline findings, and check output
- weak review prompting creates trust problems even when orchestration is correct
- guidance-loading bugs silently waste repo-specific review context
- better GitHub presentation makes Polaris feel like a first-class autonomous review product without changing the control plane

## Non-Goals

- Do **not** change the jobs/callback/sweeper architecture.
- Do **not** add manual `/review` steering in this plan.
- Do **not** add repo-local `.agents/skills` or progressive skill loading in this plan.
- Do **not** let sandboxed agents mutate GitHub directly.
- Do **not** make inline GitHub comments a second source of truth.
- Do **not** introduce automatic fix/writeback behavior.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Keep this plan focused on review quality and delivery, not orchestration | The backend model is already the strong part |
| 2026-03-22 | Treat structured review metadata as the canonical review contract | GitHub rendering is a projection, not the durable state |
| 2026-03-22 | Use the existing inline-anchor path instead of inventing a second inline-comment system | `inlineAnchors` already exist in prompt, schema, parser, and postprocess |
| 2026-03-22 | Harden inline delivery through validation and graceful degradation | Bad anchors should reduce rendering fidelity, not break review completion |
| 2026-03-22 | Keep manual reviewer steering out of scope for now | It adds product surface area without being the highest-leverage current gap |
| 2026-03-22 | Keep repo-local skill loading out of scope for now | Guidance-loading correctness and prompt quality are more urgent and lower-risk |

## Current State vs Missing Work

Already implemented:

- structured review metadata parsing and persistence
- summary PR comment posting
- stale-comment marking
- GitHub check creation/completion
- incremental/full/reset/since review scopes
- optional inline anchors in prompt/schema/output
- best-effort inline review posting

Still missing or incomplete:

- changed-path guideline loading is not wired to actual changed files
- prompt heuristics are not yet explicitly optimized for high-confidence, concrete findings
- inline anchor delivery lacks a clearly defined validation/degradation layer
- check summaries are too thin
- stale review UX can be clearer

## Program Shape

Ship this as three sequential PRs:

1. guidance loading + prompt quality
2. inline review delivery hardening
3. GitHub check/comment polish

Recommended PR boundaries:

| PR | Scope | Must Land Before |
|----|-------|------------------|
| PR1 | fix guideline loading + tighten review prompt heuristics | PR2+ |
| PR2 | harden inline anchor validation and delivery | PR3 |
| PR3 | polish check summaries and supersession UX | final |

## Implementation

### Phase 1 — Guidance Loading and Prompt Quality

**Goal:** make sure the reviewer sees the right repo guidance and applies a more disciplined review heuristic.

**Modify**

- `lib/orchestration/pr-review.ts`
- `lib/reviews/guidelines.ts`
- `lib/reviews/prompt-builder.ts`

**Changes**

- Pass the actual filtered changed file paths into `loadRepoGuidelines()` instead of `[]`.
- Keep guideline loading deterministic and budgeted:
  - root `AGENTS.md` / `.agents.md`
  - scoped `AGENTS.md` / `.agents.md` for directories on changed-file paths
  - `REVIEW_GUIDELINES.md` / `.review-guidelines.md`
- Tighten prompt instructions around the existing structured output contract:
  - require a concrete failure scenario or concrete risk explanation for every finding
  - explicitly reject speculative or low-confidence findings
  - add an omission-recheck pass before finalizing output
  - tell the reviewer to carry forward still-open severe issues unless they are clearly fixed
  - keep the current “no tests/lint/build” rule intact

**Important rule**

- This phase improves reviewer discipline, but does **not** change the durable metadata contract or review state model.

**Acceptance criteria**

- changed-directory guideline files appear in the built prompt when relevant files are touched
- prompt text clearly biases toward concrete, high-confidence findings
- current structured output schema remains valid and unchanged

### Phase 2 — Inline Review Delivery Hardening

**Goal:** make the existing inline comment path reliable enough to ship as a polished secondary rendering target.

**Modify**

- `lib/reviews/types.ts`
- `lib/reviews/inline-comments.ts`
- `lib/reviews/github.ts`
- `lib/orchestration/postprocess.ts`

**Changes**

- Keep `inlineAnchors` transient and rendering-only.
- Add an explicit validation layer before GitHub review creation:
  - anchor `issueId` must map to an unresolved issue in `reviewState.openIssues`
  - file path must belong to the reviewed diff/change set
  - line numbers must be positive and internally consistent
  - multi-line ranges must satisfy GitHub range rules
  - suggestion blocks must be non-empty and size-limited
- Build inline comments only from validated anchors.
- If no anchors survive validation, skip inline review creation entirely.
- If GitHub rejects the final inline review payload, keep the summary comment and check result as the successful canonical rendering path and log the rejection reason.
- Keep summary comment posting first; inline review remains best-effort and never blocks state persistence, stale marking, or check completion.

**Important rule**

- Do not move line anchors or suggestion text into durable `reviewState.openIssues`.
- The durable contract remains verdict, summary, severity counts, open issues, resolved issues, and review count.

**Acceptance criteria**

- valid anchors render as inline review comments
- invalid anchors degrade gracefully without blocking review completion
- summary comment, review-state persistence, and check completion still succeed when inline posting fails

### Phase 3 — GitHub Check and Comment Polish

**Goal:** make the GitHub-facing result easier to scan and easier to trust.

**Modify**

- `lib/reviews/github.ts`
- `lib/orchestration/postprocess.ts`
- `lib/reviews/prompt-builder.ts` if footer/scope wording needs alignment

**Changes**

- Improve check summaries so they include:
  - verdict
  - severity counts
  - short review summary
  - run details link when available
- Make stale/superseded review text more directional and easier to understand.
- Add a compact reviewed-scope summary where useful:
  - full vs incremental vs reset vs since
  - reviewed SHA range
- Keep the top-level summary comment as the primary human-readable artifact.

**Acceptance criteria**

- the check run alone is enough to understand whether the PR is blocked and why
- superseded reviews clearly point to the latest review
- scope context is visible without reading raw metadata

## File Summary

| Action | File |
|--------|------|
| Modify | `lib/orchestration/pr-review.ts` |
| Modify | `lib/reviews/guidelines.ts` |
| Modify | `lib/reviews/prompt-builder.ts` |
| Modify | `lib/reviews/types.ts` |
| Modify | `lib/reviews/inline-comments.ts` |
| Modify | `lib/reviews/github.ts` |
| Modify | `lib/orchestration/postprocess.ts` |

## Risks and Watchouts

- **Prompt drift:** heuristics can improve signal, but if they become too wordy they can bury the repo-specific guidance.
- **Anchor fragility:** GitHub anchor rules are strict; local validation should catch obvious problems, but server-side rejection is still possible.
- **State duplication:** inline rendering must not become a shadow persistence model.
- **Over-correction:** aggressive “confidence” language must not suppress legitimate findings entirely.

## Progress

- [ ] Phase 1: wire changed-path guidance loading and improve review prompt discipline
- [ ] Phase 2: harden inline anchor validation and delivery
- [ ] Phase 3: improve GitHub check/comment presentation

## Done When

- [ ] changed-path scoped repository guidance is actually loaded into review prompts
- [ ] review prompt heuristics explicitly require concrete, high-confidence findings
- [ ] inline anchors are validated before posting
- [ ] invalid inline anchors degrade gracefully without breaking review completion
- [ ] GitHub check summaries include verdict, severity counts, summary, and run link when available
- [ ] superseded review presentation is clearer
- [ ] `pnpm typecheck` passes
