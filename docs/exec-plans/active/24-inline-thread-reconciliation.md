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

When Polaris posts inline review comments (GitHub review threads) anchored to specific file+line, and a follow-up push fixes the issue, the threads are not auto-resolved. They stay open until a human manually resolves them.

### Why

The current system depends entirely on the **agent** to include the old finding's `issueId` in `resolvedIssueIds` in its metadata output. In practice:

- The agent frequently raises a **new** finding with a **new** ID instead of resolving the old one
- The agent treats a refined concern (e.g., "use last match instead of first match") as conceptually different from the original ("match() returns first occurrence")
- Prompt engineering cannot reliably fix this — it's a judgment problem across agent sessions

The platform has no fallback. If the agent doesn't emit the ID, the thread stays open forever.

### Evidence

Production session `178c5cfa-8b05-434f-9596-6e23cfc7f24f` (PR #119):
- Pass 4 posted inline comment on `output-parser.ts:64-70` about `match()` returning first occurrence
- Pass 5 push changed those exact lines (switched to `findLastMatch`)
- Agent's metadata: `"resolvedIssueIds": []` — empty array
- Agent raised a new finding `"first-inline-header-match-can-cut-wrong-place"` instead
- The old thread stayed open

## Root Cause

`inlineCommentMap` in session metadata stores only `{ issueId: commentDatabaseId }`. The file, line, and startLine of each posted inline comment are discarded after posting. The postprocessor has no way to compare old comment positions against the current diff — it can only check if the agent explicitly named the old ID.

## Design

### Core Principle

**Inline thread lifecycle should be driven by the diff, not by agent issue IDs.** The platform owns the thread state and reconciles it against code changes. Agent `resolvedIssueIds` becomes a fast path, not a requirement.

### New Type: `TrackedInlineThread`

```typescript
interface TrackedInlineThread {
  /** GitHub review comment database ID */
  commentId: number;
  /** The finding ID the agent used when posting this comment */
  issueId: string;
  /** File path at time of posting */
  file: string;
  /** End line (right side of diff) */
  line: number;
  /** Start line for multi-line comments */
  startLine?: number;
  /** Review pass that posted this thread */
  postedInPass: number;
}
```

Added to `AutomationSessionMetadata`:
```typescript
/** Durable inline thread state for diff-driven reconciliation */
inlineThreads?: TrackedInlineThread[];
```

`inlineCommentMap` kept for backward compatibility but no longer the primary source.

### Changed-Line Index

A pure function that parses a unified diff and returns the set of changed line ranges per file:

```typescript
type ChangedLineIndex = Map<string, Array<{ start: number; end: number }>>;

function buildChangedLineIndex(diff: string): ChangedLineIndex;
```

Parses `@@ -a,b +c,d @@` hunk headers to extract the right-side (new file) line ranges that were added or modified.

### Reconciliation Algorithm

Runs in `postprocess.ts` step 2c, before posting new inline comments:

```
For each TrackedInlineThread from previous pass:
  1. Is the thread's file in the diff?
     No  → carry forward (untouched)
     Yes → check line intersection

  2. Does the thread's [startLine..line] range intersect any changed range?
     No  → carry forward, translate line numbers if insertions above shifted them
     Yes → thread is "touched"

  3. For touched threads:
     a. Does the current review's inlineAnchors have an anchor on the same
        file within the same line range? (overlapping anchor)
        Yes → treat as same thread:
              - Update issueId to the new anchor's ID
              - Suppress posting a duplicate inline comment
              - Carry forward with updated metadata
        No  → auto-resolve:
              - Reply "Resolved in <sha>" to the thread
              - Resolve via GraphQL resolveReviewThread
              - Remove from inlineThreads
```

### Fast Path

Explicit `resolvedIssueIds` from the agent still works as before — if the agent names an old ID, resolve it immediately without diff analysis. The diff reconciliation is the fallback for when the agent doesn't.

## Implementation Plan

### Phase 1: Persist thread anchors (no behavior change)

1. Add `TrackedInlineThread` type to `lib/reviews/types.ts`
2. Update `fetchInlineCommentMap` in `lib/reviews/github.ts` to return `TrackedInlineThread[]` instead of `Record<string, number>`
   - Match comments by `path + line + start_line`, not array order
3. Persist `inlineThreads` in session metadata alongside `inlineCommentMap`
4. Add `fromSha` to review job payload in `lib/orchestration/pr-review.ts`
5. Legacy migration: sessions with only `inlineCommentMap` hydrate thread state from GitHub on first incremental review

### Phase 2: Diff-driven reconciliation

1. Add `buildChangedLineIndex(diff: string): ChangedLineIndex` to `lib/reviews/diff.ts`
   - Parse unified diff hunk headers
   - Return per-file changed line ranges
2. Add `reconcileInlineThreads()` pure function
   - Inputs: prior threads, changed-line index, current inline anchors
   - Outputs: `{ carryForward, autoResolve, suppressAnchors }`
3. Wire into `postprocess.ts` step 2c:
   - Fetch incremental diff (`fromSha → toSha`) if available
   - Run reconciliation
   - Auto-resolve touched threads with no overlapping anchor
   - Filter `suppressAnchors` from step 2b inline posting
4. Persist updated `inlineThreads` back to metadata

### Phase 3: Hardening

1. Paginate `reviewThreads` GraphQL query (currently `first: 100`)
2. Handle file renames: carry thread forward to new path if anchor content unchanged
3. Handle file deletions: auto-resolve all threads on deleted files
4. Handle truncated diffs: skip reconciliation, log, fail open
5. Line translation: shift thread line numbers when insertions/deletions above the anchor move it

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Thread on line 10, only line 100 changed | No resolve — no line intersection |
| Thread on line 10, lines 5-15 changed | Touched — check for overlapping anchor |
| Insertions above thread (line numbers shift) | Translate line forward, keep open |
| File renamed, anchor content unchanged | Update path, keep open |
| File deleted | Auto-resolve all threads on that file |
| Agent explicitly resolves via `resolvedIssueIds` | Fast path — resolve immediately |
| Diff too large / truncated | Skip reconciliation, fail open |
| >100 review threads | Paginate GraphQL query |
| Legacy session (only `inlineCommentMap`) | Hydrate from GitHub on first run |

## Testing

### Unit tests (vitest)

- `buildChangedLineIndex`: hunk parsing, multi-file diffs, renames, binary files
- `reconcileInlineThreads`: all intersection/overlap/carry-forward/auto-resolve scenarios
- Line translation after insertions/deletions

### Integration tests

- Full postprocess flow: post inline → push fix → incremental review → verify thread resolved
- Legacy migration: session with old `inlineCommentMap` → first incremental → hydrated to `inlineThreads`

### Production QA

- Open PR, trigger review with inline findings
- Push fix that changes the flagged lines
- Verify threads auto-resolve without agent cooperation

## Non-Goals

- Changing agent prompt to improve `resolvedIssueIds` reliability (the whole point is to not depend on this)
- Cross-file issue tracking (e.g., a finding in file A resolved by a change in file B)
- Semantic analysis of whether the fix actually addresses the concern (we only check if the code changed)
