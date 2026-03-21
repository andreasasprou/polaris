---
title: Session-Centric Sidebar Redesign
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, sidebar]
---

# 10 — Session-Centric Sidebar Redesign

## Problem Statement

The current sidebar (`app/(dashboard)/_components/app-sidebar.tsx`) is a static nav menu (Dashboard, Automations, Runs, Sessions, Integrations, Settings). This is an admin-panel pattern, not an agent-workbench pattern. Users must click "Sessions" and navigate to a separate page to see their session list. There's no at-a-glance visibility into session status, HITL attention needs, or project grouping.

Cursor Glass and Codex both use the sidebar as the primary session/thread browser — always visible, always live.

## Target Design

```
┌─────────────────────────┐
│ [Org Avatar] Org Name ▾ │  ← Keep org switcher
├─────────────────────────┤
│ + New Session      ⌘N   │  ← Primary action
│ ⏿ Automations           │  ← Secondary nav
├─────────────────────────┤
│ ▾ dweet-solutions/web   │  ← Project group (collapsible)
│   ✓ Fix flex request... │     Status + title + unread dot
│   ✓ Refactor job ind... │
│ ▾ dweet-solutions/nova  │
│   ● Implement stream... │     ● = active/running
│   ✓ Datadog metrics ... │
│   ··· More              │
├─────────────────────────┤
│ ⚙ Settings              │
│ [AA] Andreas    Pro ▾   │
└─────────────────────────┘
```

## Implementation Plan

### Phase 1: New API Endpoint

**Create `app/api/interactive-sessions/sidebar/route.ts`**

Lightweight endpoint optimized for sidebar. Returns sessions joined with repositories and HITL attention flag:

```sql
SELECT s.id, s.status, substring(s.prompt from 1 for 100) as title,
       s.created_at, r.owner as repo_owner, r.name as repo_name,
       EXISTS(
         SELECT 1 FROM job_attempts ja
         JOIN jobs j ON j.id = ja.job_id
         WHERE j.session_id = s.id AND ja.status = 'waiting_human'
       ) as needs_attention
FROM interactive_sessions s
LEFT JOIN repositories r ON r.id = s.repository_id
WHERE s.organization_id = $1
ORDER BY s.created_at DESC LIMIT 100
```

> **Performance:** Add a time window filter (e.g., last 30 days) or status filter to avoid querying thousands of old terminal sessions. Consider adding an index on `(organization_id, created_at DESC)` if one doesn't exist.

### Phase 2: Client-Side Data Hook

**Create `hooks/use-sidebar-sessions.ts`**

Types:
```typescript
type SidebarSession = {
  id: string; status: string; title: string; createdAt: string;
  repoOwner: string | null; repoName: string | null; needsAttention: boolean;
};
type RepoGroup = {
  key: string; label: string; sessions: SidebarSession[];
  hasAttention: boolean; activeCount: number;
};
```

- Polls every 5s when any session is non-terminal, 0 otherwise
- Groups sessions by repo via `useMemo` (derived state)
- Sorts groups alphabetically, sessions by createdAt desc

### Phase 3: Session Status Icon Component

**Create `components/sidebar/session-status-icon.tsx`**

Maps session status to visual indicators using `STATUS_CONFIG`:
- `creating`/`snapshotting`: spinning loader
- `active`: green pulsing dot
- `idle`: blue/muted dot
- `completed`: green checkmark
- `failed`: red X
- `needsAttention` (HITL): amber pulsing dot (overrides active)

### Phase 4: Sidebar Rewrite

**Modify `app/(dashboard)/_components/app-sidebar.tsx`**

Structure:
- SidebarHeader: OrgSwitcher (unchanged)
- SidebarContent:
  - Actions group: "New Session" button (PlusIcon, ⌘N), "Automations" link
  - Sessions group (flex-1 overflow-auto): Collapsible per RepoGroup → SidebarMenuSub → session items
  - Each session: `<Link href={/sessions/${id}}>` with SessionStatusIcon + truncated title + relative time
  - "More" button per group (expand beyond initial 5)
- SidebarFooter: Settings link + Account dropdown

> **Caution:** Changing `SIDEBAR_WIDTH` from 16rem to 18rem compresses main content by 32px on every page. Verify this doesn't break tight layouts (especially session detail page's `min-w-0` flex). Consider keeping 16rem and relying on text truncation instead.

### Phase 5: Keyboard Navigation

**Create `hooks/use-sidebar-keyboard.ts`**

- `⌘N`: navigate to `/sessions/new`
- `⌘↑/↓`: cycle through sessions in sidebar

> **Note:** `Cmd+N` conflicts with browser 'new window'. Use `Cmd+Shift+N` or scope the shortcut to only fire when the app is focused and no input is active. `Cmd+Up/Down` may conflict with OS shortcuts — test on macOS.

### Phase 6: Relative Time Utility

Inline the `relativeTime` function in `hooks/use-sidebar-sessions.ts` or add it to the existing `lib/utils.ts` rather than creating a separate file for a 10-line function.

Simple `relativeTime(date)` → "just now", "2m", "3h", "5d", or formatted date.

### Phase 7: Admin Nav Demotion

**Needs more detail before implementation.** Specific proposal: Keep Automations as a primary nav item. Move Dashboard and Runs to small icon-only buttons in the SidebarFooter alongside Settings. Remove Integrations from sidebar (accessible from Settings page). Each demoted item uses its existing lucide icon at 16px.

## Notes

> **Collapsed sidebar mode:** When `collapsible='icon'`, the entire session list vanishes (`SidebarMenuSub` has `group-data-[collapsible=icon]:hidden`). Only top-level icons remain: New Session (+), Automations, Settings. This is acceptable behavior — acknowledge it explicitly.

> **Sessions page fate:** The `/sessions` page remains as a full-list view with search/filters (Plan 13). The sidebar shows recent sessions as a quick-access list. Both can coexist.

## File Summary

| Action | File | Purpose |
|--------|------|---------|
| Create | `app/api/interactive-sessions/sidebar/route.ts` | Sidebar data endpoint |
| Create | `hooks/use-sidebar-sessions.ts` | Data fetching + grouping hook |
| Create | `components/sidebar/session-status-icon.tsx` | Status icon with animations |
| Create | `hooks/use-sidebar-keyboard.ts` | Keyboard shortcuts |
| Modify | `app/(dashboard)/_components/app-sidebar.tsx` | Full sidebar rewrite |
| Modify | `components/ui/sidebar.tsx` | Sidebar width (if needed after testing) |

## Key Considerations

- **Performance**: 5s poll interval (not 2s). Lightweight query. Polling stops when all terminal.
- **HITL**: `needsAttention` computed server-side via subquery on `job_attempts.status = 'waiting_human'`. Plan 17 (HITL Notifications) should consume this data from the sidebar endpoint rather than creating a separate `/attention` endpoint — avoid duplicate polling.
- **Collapsed mode**: `collapsible="icon"` hides session list. Only top-level nav icons remain.
- **No react-query/SWR**: Custom hook with `useState` + `setInterval` matches existing patterns.
