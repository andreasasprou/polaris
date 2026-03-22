---
title: Inline Thread Reconciliation — Diff-Driven Auto-Resolve
status: planned
created: 2026-03-22
owner: andreas
related_prs: []
domains: [reviews, orchestration, github]
---

# 24 — Inline Thread Reconciliation — Diff-Driven Auto-Resolve

## Problem

### What

Polaris already posts inline GitHub review threads, but it only auto-resolves them when the agent explicitly emits the previous issue ID in `resolvedIssueIds`.

That is too weak for the actual review workflow:

- agent issue IDs are not stable across runs
- refined follow-up findings often get a new ID
- the platform has no fallback when the code clearly changed on the flagged lines

Result: stale inline threads stay open indefinitely unless a human resolves them.

### Evidence

Production session `178c5cfa-8b05-434f-9596-6e23cfc7f24f` (PR #119):

- pass 4 posted an inline thread on `output-parser.ts:64-70`
- pass 5 changed those exact lines (`findLastMatch`)
- the agent emitted `"resolvedIssueIds": []`
- the old thread remained open even though the flagged code moved

## Root Cause

The current durable state is not rich enough to reconcile threads platform-side:

- `inlineCommentMap` stores only `{ issueId: commentDatabaseId }`
- `fetchInlineCommentMap()` currently matches comments by array order, not durable identity
- `postprocessReview()` only has the agent's `resolvedIssueIds` fast path
- the available diff helpers are prompt-budgeted and may truncate, which is acceptable for prompting but not for state transitions

## Non-Goals

- Do **not** make semantic judgments about whether a code change truly fixed the issue.
- Do **not** introduce cross-file issue tracking.
- Do **not** depend on prompt changes to stabilize `resolvedIssueIds`.
- Do **not** turn inline rendering into a second durable review-state model.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Platform owns inline thread lifecycle | Thread state should not depend on agent issue-ID continuity |
| 2026-03-22 | Persist durable thread identity, not just comment IDs | Reconciliation needs file/range identity and direct thread resolution |
| 2026-03-22 | Reconciliation only runs on trusted commit ranges | Full/reset/force-push paths do not have a safe `fromSha → toSha` mapping |
| 2026-03-22 | State transitions must use non-truncated reconciliation inputs | Prompt-budgeted diffs are not strong enough for durable state changes |
| 2026-03-22 | Ship safe auto-resolve before duplicate suppression | Avoid false-positive suppression based on loose overlap heuristics |
| 2026-03-22 | Fail open when reconciliation context is incomplete | Incorrectly resolving a live thread is worse than leaving one open |

## Current State vs Missing Work

Already implemented:

- summary comment is the primary review artifact
- inline review posting exists as a best-effort projection
- explicit `resolvedIssueIds` can reply-and-resolve existing inline threads
- automation-session metadata already persists review continuity

Still missing:

- durable inline thread tracking (`threadId`, file, range, review pass)
- a non-truncated reconciliation diff path
- safe gating for incremental-only reconciliation
- idempotent retry semantics for diff-driven thread resolution
- a stricter foundation for future duplicate suppression

## Program Shape

Ship this as three sequential PRs:

1. durable thread tracking + payload plumbing
2. safe diff-driven auto-resolve
3. hardening for retries, renames, deletes, and duplicate suppression

Recommended PR boundaries:

| PR | Scope | Must Land Before |
|----|-------|------------------|
| PR1 | durable thread capture, pagination, legacy hydration, `fromSha` plumbing | PR2+ |
| PR2 | incremental-only diff reconciliation and safe auto-resolve | PR3 |
| PR3 | line translation, rename/delete handling, retry hardening, duplicate suppression | final |

## Design

### Durable Thread State

Add a first-class durable type to `AutomationSessionMetadata`:

```typescript
interface TrackedInlineThread {
  threadId: string;
  commentId: number;
  reviewId: number;
  issueId: string;
  file: string;
  line: number;
  startLine?: number;
  postedInPass: number;
}
```

```typescript
inlineThreads?: TrackedInlineThread[];
```

Notes:

- `threadId` is the primary resolution handle
- `commentId` is kept for reply threading and legacy compatibility
- `inlineCommentMap` remains temporarily for backward compatibility, but `inlineThreads` becomes the canonical durable source

### Reconciliation Inputs

Diff-driven reconciliation must use a dedicated, non-prompt path:

- only for `incremental` and `since` reviews
- only when `fromSha` is available and is still an ancestor of `toSha`
- never from prompt-truncated diff helpers
- fail open if GitHub cannot provide a complete compare result

The reconciliation primitive is still a pure function:

```typescript
type ChangedLineIndex = Map<string, Array<{ start: number; end: number }>>;

function buildChangedLineIndex(diff: string): ChangedLineIndex;
```

But Phase 2 uses it only for touched-line detection, not line translation.

### Safe Reconciliation Algorithm

Run in `postprocess.ts` before posting new inline comments:

1. Resolve explicit `resolvedIssueIds` first as the fast path.
2. If the current review is not `incremental` / `since`, skip diff-driven reconciliation.
3. Build a changed-line index from the full `fromSha → toSha` compare diff.
4. For each tracked thread not already handled by explicit resolution:
   - if its file is absent from the changed index, carry forward unchanged
   - if its range does not intersect changed lines, carry forward unchanged
   - if its range intersects changed lines and the current pass has an overlapping inline anchor on the same file/range, keep the old thread open and allow the new inline comment to post
   - if its range intersects changed lines and there is no overlapping current anchor, auto-resolve it

Phase 2 deliberately does **not** suppress new inline comments. Overlap only prevents false auto-resolve; it does not yet prove two findings are the same thread.

### Idempotency Model

Diff-driven resolution must survive retries:

- resolve by stored `threadId`, not by scanning `reviewThreads(first: 100)` on every retry
- before mutating GitHub, check whether the thread is already resolved
- avoid posting duplicate Polaris “Resolved in `<sha>`” replies on retry
- only remove a thread from `inlineThreads` after the GitHub mutation succeeds
- if a thread mutation fails, keep it tracked so the sweeper retry can attempt it again

## Implementation

### Phase 1 — Durable Thread Tracking

**Goal:** replace the brittle order-based map with durable thread metadata.

**Modify**

- `lib/reviews/types.ts`
- `lib/reviews/github.ts`
- `lib/orchestration/postprocess.ts`
- `lib/orchestration/pr-review.ts`

**Changes**

- Add `TrackedInlineThread` and `inlineThreads` to `AutomationSessionMetadata`.
- Replace `fetchInlineCommentMap()` with a helper that returns tracked threads for a newly posted review:
  - match comments by `path + line + start_line`, not array order
  - resolve and persist `threadId` as part of the same capture flow
  - paginate thread queries up front; pagination is correctness, not hardening
- Keep `inlineCommentMap` as a compatibility field derived from tracked threads where needed.
- Add `fromSha` to the review job payload so postprocess has the exact compare base.
- Add lazy legacy hydration:
  - when a session has `inlineCommentMap` but no `inlineThreads`, query GitHub for currently open matching threads
  - hydrate only what can be recovered exactly
  - otherwise fail open and wait for newly posted threads to establish canonical state

**Acceptance criteria**

- newly posted inline comments persist `threadId`, `commentId`, file, and range
- comment-to-issue matching does not depend on returned array order
- sessions dispatched for incremental review persist `fromSha` into the job payload

### Phase 2 — Safe Diff-Driven Auto-Resolve

**Goal:** resolve obviously stale inline threads without depending on agent issue IDs.

**Modify**

- `lib/reviews/diff.ts`
- `lib/reviews/github.ts`
- `lib/orchestration/postprocess.ts`
- add a pure reconciliation helper module if it keeps `postprocess.ts` readable

**Changes**

- Add a dedicated compare helper for reconciliation that never truncates silently.
- Add `buildChangedLineIndex()` for right-side changed ranges.
- Add `reconcileInlineThreads()` returning:
  - `carryForward`
  - `autoResolve`
  - `overlapBlocked`
- Wire it into `postprocessReview()` after the explicit `resolvedIssueIds` fast path and before posting new inline comments.
- Auto-resolve only when all of the following are true:
  - review scope is `incremental` or `since`
  - `fromSha` exists
  - ancestry is trustworthy
  - compare output is complete
  - the tracked thread’s range was touched
  - the current pass did not emit an overlapping inline anchor on the same file/range
- Persist the updated `inlineThreads` set after successful per-thread mutations.

**Important rule**

- Phase 2 does **not** add duplicate suppression for newly posted inline comments.
- Overlap only blocks auto-resolve; it does not yet merge or replace threads.

**Acceptance criteria**

- touched threads with no overlapping current anchor auto-resolve
- touched threads with overlapping current anchors stay open
- full/reset/force-push paths skip reconciliation and leave tracked threads untouched
- incomplete compare results fail open and do not resolve anything

### Phase 3 — Hardening

**Goal:** close the remaining correctness gaps after the safe path ships.

**Modify**

- `lib/reviews/diff.ts`
- `lib/reviews/github.ts`
- `lib/orchestration/postprocess.ts`
- reconciliation helper module

**Changes**

- Add line translation for untouched threads when insertions/deletions above the anchor shift line numbers.
- Use structured compare metadata to handle:
  - renamed files
  - deleted files
  - files with missing patches
- Strengthen retry semantics so partial GitHub failures do not leave session metadata ahead of actual thread state.
- If we want duplicate suppression, add it only with a stricter identity rule than “same file + overlapping range”.

**Acceptance criteria**

- untouched threads survive line shifts with updated stored ranges
- renamed/deleted files behave deterministically
- retries do not post duplicate resolution replies or silently drop unresolved tracked threads

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Explicit `resolvedIssueIds` contains the old issue ID | Fast path resolves immediately |
| Incremental review, touched lines, no overlapping anchor | Auto-resolve |
| Incremental review, touched lines, overlapping anchor | Keep old thread open; still allow new inline comment |
| Incremental review, unrelated file/line changes | Keep thread open |
| Full or reset review | Skip reconciliation |
| Force-push / non-ancestor history | Skip reconciliation |
| Compare diff unavailable or incomplete | Skip reconciliation, log, fail open |
| Legacy session with only `inlineCommentMap` | Hydrate what can be recovered exactly; otherwise fail open |
| >100 review threads | Paginate in Phase 1 capture/hydration path |
| Already-resolved thread on retry | Treat as idempotent success |

## Testing

### Unit tests

- tracked-thread capture matching by `path + line + start_line`
- `buildChangedLineIndex()` hunk parsing for multi-file diffs
- `reconcileInlineThreads()` for carry-forward, overlap-blocked, and auto-resolve decisions
- gating rules for `full`, `reset`, missing `fromSha`, and broken ancestry

### Integration tests

- post inline review → persist tracked threads with `threadId`
- push fix on flagged lines → incremental review → auto-resolve without agent cooperation
- push unrelated change → old thread stays open
- legacy session with only `inlineCommentMap` hydrates or fails open cleanly
- retry after partial GitHub failure does not duplicate replies

### Production QA

- open a PR with inline findings
- push a fix that edits the flagged lines
- verify old thread auto-resolves even when `resolvedIssueIds` is empty
- push a follow-up commit that re-raises a nearby finding and verify the old thread is not incorrectly auto-resolved

## File Summary

| Action | File |
|--------|------|
| Modify | `lib/reviews/types.ts` |
| Modify | `lib/reviews/github.ts` |
| Modify | `lib/reviews/diff.ts` |
| Modify | `lib/orchestration/pr-review.ts` |
| Modify | `lib/orchestration/postprocess.ts` |
| Add | `lib/reviews/inline-thread-reconciliation.ts` (if extracted) |

## Risks and Watchouts

- **False resolve risk:** resolving a live thread is worse than leaving a stale one open; fail open aggressively.
- **Truncated compare data:** prompt-budgeted diff helpers must not leak into reconciliation paths.
- **Retry gaps:** GitHub mutation order and metadata persistence order need explicit idempotency design.
- **Loose overlap matching:** “same file + overlapping lines” is not strong enough for duplicate suppression by itself.

## Progress

- [ ] Phase 1: persist durable tracked inline threads and `fromSha`
- [ ] Phase 2: ship safe incremental-only diff-driven auto-resolve
- [ ] Phase 3: add translation, rename/delete handling, and retry hardening

## Done When

- [ ] newly posted inline comments persist canonical tracked thread state
- [ ] incremental reviews can auto-resolve touched threads without agent issue-ID continuity
- [ ] reconciliation never uses truncated prompt diff data
- [ ] full/reset/force-push paths fail open
- [ ] retry behavior is explicitly idempotent
- [ ] `pnpm typecheck` passes
