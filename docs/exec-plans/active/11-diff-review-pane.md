---
title: Diff Review Pane
status: completed
created: 2026-03-20
owner: andreas
related_prs: [126]
domains: [ui, sessions, code-review]
---

# 11 — Diff Review Pane

## Problem Statement

When a coding session produces file changes, diffs are only visible inside collapsed tool call items in the chat view. There's no dedicated review surface. Both Cursor Glass and Codex invest heavily in code review UX — Codex has a full diff viewer with inline comments, 3-level staging, and line-click feedback.

## Design Decisions

- **Tab approach** (not panel): Add "Chat" | "Review" tabs on session detail. Clean separation, full width for each, mobile-friendly. Avoids ResizablePanel dependency and width constraints.
- **Data from existing ChatItem[]**: No new API needed. All diff data flows through tool call content parts (`file_ref`, `diff` types).
- **Pure extraction function**: `extractFileChanges(items)` produces `DiffSummary`. UI just renders.

## Implementation Plan

### Phase 1: Data Layer (pure logic + tests)

**Create `lib/diff/parse-unified-diff.ts`**

Parses unified diff format into structured lines:
```typescript
type DiffLine = {
  type: "addition" | "deletion" | "context" | "hunk_header";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
};
```

**Create `lib/diff/extract-file-changes.ts`**

Walks ChatItem[], extracts file changes:
```typescript
type FileChange = {
  path: string;
  action: "write" | "patch" | "create" | "delete";
  diff: string;
  parsedLines: DiffLine[];
  additions: number;
  deletions: number;
};
type DiffSummary = {
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
};
```

Logic:
1. Filter ChatItem[] to `type === "tool_call"`
2. Extract `file_ref` parts with `action !== "read"` and non-empty diff
3. Handle `diff` content parts (oldText/newText → pseudo-unified diff)
4. Deduplicate by path (keep last change per file)
5. Parse diffs, count additions/deletions
6. Scan agent_message items for GitHub PR URLs

> **`diff` content parts (oldText/newText):** Converting to unified diff requires a string diff algorithm. Add `diff` npm package as a dependency (`pnpm add diff`) and use `createTwoFilesPatch()` for the conversion. Do NOT implement a custom diff algorithm.

> **Type safety:** The `ChatItem` tool_call content is typed as `Array<Record<string, unknown>>`. Create typed interfaces for `FileRefContentPart` and `DiffContentPart` in `lib/diff/extract-file-changes.ts` to avoid `as` casts throughout the extraction logic.

**Tests:** Create `lib/diff/__tests__/parse-unified-diff.test.ts` and `lib/diff/__tests__/extract-file-changes.test.ts`. These are pure functions — easy to test with fixture data.

### Phase 2: Hook

**Create `hooks/use-diff-review.ts`**

Thin `useMemo` wrapper: `useDiffReview(items) → { summary: DiffSummary, prUrl: string | null }`

### Phase 3: Components

**Create `components/sessions/diff-review/`**

- `diff-line.tsx` — Line renderer with gutter, +/- coloring, hunk header styling
- `diff-file-section.tsx` — Per-file collapsible (shadcn Collapsible), header with path + stats
- `diff-review-header.tsx` — Stats bar (files, +N, -N), view mode toggle, "View on GitHub" link
- `diff-review-pane.tsx` — Top-level container, calls useDiffReview, renders all sub-components

> **v1 simplification:** Drop `diff-file-list.tsx` (the click-to-scroll file sidebar). A flat list of collapsible `DiffFileSection` components with a summary header is sufficient. Add the file list sidebar in v2.

Color scheme (reuse from tool-call-item.tsx):
- Additions: `text-emerald-600 bg-emerald-500/5 dark:text-emerald-400`
- Deletions: `text-red-600 bg-red-500/5 dark:text-red-400`
- Hunk headers: `text-blue-500`

### Phase 4: Integration

**Modify `app/(dashboard)/sessions/[sessionId]/page.tsx`**

- Add Tabs wrapping chat and review
- Review tab trigger shows file count badge
- Tabs must preserve existing `flex min-h-0 flex-col` layout for auto-scroll

## Notes

> **Large diffs:** Add a truncation guard — if a single file diff exceeds 5000 lines, show a 'Diff too large to display' message with a link to view on GitHub. No virtual scrolling needed for v1.

> **Integration with Plans 12, 14, 18:** This plan establishes the Tabs layout on the session detail page. Plans 12 (ProgressBar), 18 (Timeline), and 14 (ShipButton) must render ABOVE the tabs (in the header area), not inside them. The rendering order is: Header → ProgressBar → Timeline → Tabs(Chat | Review) → Input.

## File Summary

| Action | File |
|--------|------|
| Create | `lib/diff/parse-unified-diff.ts` |
| Create | `lib/diff/extract-file-changes.ts` |
| Create | `lib/diff/__tests__/parse-unified-diff.test.ts` |
| Create | `lib/diff/__tests__/extract-file-changes.test.ts` |
| Create | `hooks/use-diff-review.ts` |
| Create | `components/sessions/diff-review/diff-line.tsx` |
| Create | `components/sessions/diff-review/diff-file-section.tsx` |
| Create | `components/sessions/diff-review/diff-review-header.tsx` |
| Create | `components/sessions/diff-review/diff-review-pane.tsx` |
| Modify | `app/(dashboard)/sessions/[sessionId]/page.tsx` |
| Add dep | `diff` (npm package — `pnpm add diff`) |

## Future Extensions

- **Inline feedback**: Click diff line → send instruction to agent (onLineClick callback)
- **Per-file staging**: `staged: boolean` on FileChange, useReducer for staging state
- **Split view**: DiffLine already tracks oldLineNo/newLineNo for side-by-side rendering
- **File list sidebar**: Restore `diff-file-list.tsx` with click-to-scroll navigation (v2)
