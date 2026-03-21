---
title: Session Filtering & Search
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, navigation]
---

# 13 — Session Filtering & Search

## Problem Statement

No search or filtering for sessions. As session count grows, finding sessions becomes painful. Need: ⌘K command palette, sessions page table filters.

## Design

### Two Interconnected Features

1. **⌘K Command Palette** — global session search via CommandDialog
2. **Sessions Page Filters** — status and repo dropdowns on the table

All consume the same enriched session data shape.

### Status Group Model

Add to `lib/sessions/status.ts`:
```typescript
export const STATUS_GROUPS = {
  active: ["creating", "active", "idle", "snapshotting"],
  completed: ["completed"],
  stopped: ["stopped", "hibernated"],
  failed: ["failed"],
} as const;

export const STATUS_GROUP_LABELS = {
  active: "Active",
  completed: "Completed",
  stopped: "Stopped",
  failed: "Failed",
} as const;
```

**Status group display names:** `STATUS_GROUP_LABELS` is used by command palette group headings and filter dropdowns.

### Shared Filter Utility

**Create `lib/sessions/filter.ts`**
```typescript
export function filterSessions(
  sessions: SessionListItem[],
  filters: { statusGroup: StatusGroup | "all"; repositoryId: string | "all"; query: string }
): SessionListItem[]
```

Pure function, no React dependencies, testable.

## Implementation

### Phase 1: Data Layer

1. Create `lib/sessions/types.ts` — shared `SessionListItem` type
2. Create `lib/sessions/queries.ts` — `findSessionsWithRepoByOrg` (sessions + repo JOIN)
3. Update `GET /api/interactive-sessions` to use enriched query (add `repoOwner`/`repoName`)
4. Add `STATUS_GROUPS`, `STATUS_GROUP_LABELS`, + `getStatusGroup` to `status.ts`
5. Create `lib/sessions/filter.ts`

**API limit:** The current `GET /api/interactive-sessions` has a hard-coded `limit(50)`. Raise to `limit(200)` to make the command palette useful. Add a TODO comment for cursor-based pagination when session counts exceed 200.

**File convention:** The automations module uses `queries.ts` while sessions uses `actions.ts` for reads. Follow automations' pattern and create `lib/sessions/queries.ts` for read-only queries, but add a note that existing queries in `actions.ts` should be migrated over time (not in this plan).

**Type consolidation:** The sessions page currently has an inline `Session` type (line 17-24 of `sessions/page.tsx`) and the session detail page has `InteractiveSession` (line 16-27 of `[sessionId]/page.tsx`). When introducing `SessionListItem`, update the sessions page to use it. Do NOT change the detail page type — it has additional fields.

### Phase 2: Command Palette

1. Create `components/command-palette-provider.tsx` — ⌘K listener, context for open/setOpen
2. Create `components/sessions/session-command-palette.tsx`:
   - Wraps `CommandDialog` with lazy fetch on open
   - cmdk fuzzy filtering on prompt + repo + agentType
   - Items: StatusBadge + truncated prompt + owner/repo + relative time
   - Groups by status group (Active, Completed, etc.)
   - onSelect navigates to `/sessions/{id}`
3. Wire provider into `app/(dashboard)/layout.tsx`

**Cmd+K registration:** The cmdk `CommandDialog` does NOT auto-register global keyboard shortcuts. Add a manual `keydown` listener in `CommandPaletteProvider` matching the pattern used in `components/ui/sidebar.tsx` (line 32: `SIDEBAR_KEYBOARD_SHORTCUT`). Use `useCallback` + `addEventListener` in a `useEffect`.

**Command palette caching:** Cache the fetched sessions in a `useRef` with a 30-second TTL to avoid re-fetching on every Cmd+K press. Clear cache on session status changes.

### Phase 3: Sessions Page Filters

1. Create `components/sessions/session-filters.tsx`:
   - Status filter: Select with "All" + STATUS_GROUPS keys
   - Repo filter: Select derived from unique repos in loaded sessions
   - Search input: text filter on prompt
2. Refactor `app/(dashboard)/sessions/page.tsx`:
   - Use `SessionListItem` type
   - Add filter bar above table
   - Apply `filterSessions` client-side
   - Add repository column
   - Use `useState` for filter state (no URL persistence)

**URL search params:** `useSearchParams` would be the first usage in the dashboard codebase. As an alternative, use simple `useState` for filter state (no URL persistence). URL persistence is a nice-to-have for v2.

## File Summary

| Action | File |
|--------|------|
| Create | `lib/sessions/types.ts` |
| Create | `lib/sessions/queries.ts` |
| Create | `lib/sessions/filter.ts` |
| Create | `components/command-palette-provider.tsx` |
| Create | `components/sessions/session-command-palette.tsx` |
| Create | `components/sessions/session-filters.tsx` |
| Modify | `app/api/interactive-sessions/route.ts` |
| Modify | `lib/sessions/status.ts` |
| Modify | `app/(dashboard)/sessions/page.tsx` |
| Modify | `app/(dashboard)/layout.tsx` |

## Key Considerations

- **Client-side filtering**: Works under ~500 sessions. API params prepared for future server-side.
- **Sidebar integration**: Remove the 'sidebar quick-filter toggles' from this plan's scope. The sidebar redesign (Plan 10) owns sidebar filtering. This plan provides the shared primitives (`STATUS_GROUPS`, `filterSessions`, `SessionListItem`) that Plan 10 can consume.
- **No new dependencies**: Uses existing cmdk/CommandDialog from shadcn.
