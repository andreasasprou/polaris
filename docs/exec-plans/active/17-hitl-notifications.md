---
title: HITL Notification System
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, notifications]
---

# 17 — HITL Notification System

## Problem Statement

Sessions can request HITL input (permission/question requests), but the user must be looking at the specific session to notice. No browser notifications, no sidebar indicators, no tab title badge.

## Design

### Three Layers

1. **Tab title badge**: `(2) Polaris` when pending HITL count > 0 (works without permission)
2. **Browser notifications**: Web Notification API with tag-based dedup per session
3. **Sidebar attention indicator**: amber pulsing dot on Sessions nav item

### Data Source

**Data source:** Do NOT create a separate `/attention` endpoint. Instead, consume the `needsAttention` flag from Plan 10's sidebar endpoint (`GET /api/interactive-sessions/sidebar`). The sidebar hook (`useSidebarSessions`) already polls every 5s and provides `hasPendingHitl(sessionId)` and `pendingCount`. Plan 17 wraps this in a `HitlAttentionProvider` that re-exports the attention state for consumers that don't need the full sidebar data. **If Plan 10 hasn't shipped yet:** use a minimal standalone endpoint as a temporary bridge, to be consolidated when Plan 10 lands.

`jobAttempts.status = 'waiting_human'` remains the authoritative DB signal. Set by callback processor on `permission_requested`/`question_requested`, cleared on `permission_resumed`.

## Implementation

### Phase 1: Core Infrastructure

**Create `hooks/use-hitl-attention.ts`**

`HitlAttentionProvider` (React Context):
```typescript
type HitlAttentionState = {
  pendingSessions: Map<string, { hitlType: "permission" | "question"; since: Date }>;
  pendingCount: number;
  hasPendingHitl: (sessionId: string) => boolean;
};
```

- Consumes attention state from Plan 10's `useSidebarSessions` hook (no separate polling)
- Re-exports attention-specific state for consumers that don't need full sidebar data

**Client wrapper:** Create `app/(dashboard)/_components/hitl-provider-wrapper.tsx` as a `'use client'` component that renders `<HitlAttentionProvider>{children}</HitlAttentionProvider>`. Import and render this in `layout.tsx` inside the existing `<SidebarProvider>` wrapper.

**Tab visibility:** Do NOT pause polling when tab is hidden — notifications are most valuable when the tab IS hidden. Instead, reduce poll frequency to 15s when hidden (vs. 5s when visible). This saves resources while still delivering timely notifications.

### Phase 2: Tab Title + Sidebar Badge

**Split hooks:** Break `useDocumentNotifications` into two focused hooks:
- (a) `useTabTitleBadge(count: number)` — manages `document.title` only
- (b) `useBrowserNotifications(sessions: Map<string, HitlInfo>)` — manages Notification API, permission, firing, clearing

Each hook has a single responsibility and is independently testable.

**Create `hooks/use-tab-title-badge.ts`**

- Tab title: `(${count}) Polaris` when count > 0, restore when 0

**Sidebar:** Modify `app-sidebar.tsx` to show `SidebarMenuBadge` with amber pulse on Sessions item when `pendingCount > 0`

### Phase 3: Browser Notifications

**Create `hooks/use-browser-notifications.ts`**

In `useBrowserNotifications`:
- Request permission lazily (on first HITL, not page load)
- Fire notification when session enters pending AND not currently viewing AND tab not focused
- Tag: `polaris-hitl-${sessionId}` for dedup
- Click: `window.focus()` + `router.push(/sessions/${sessionId})`
- Clear when session leaves pending set

### Phase 4 (Sound + Preferences): Deferred to v2.

Ship Phases 1-3 first. Sound and preferences add complexity (Audio API preloading, localStorage, settings UI) for marginal value.

## File Summary

| Action | File |
|--------|------|
| Create | `hooks/use-hitl-attention.ts` |
| Create | `hooks/use-tab-title-badge.ts` |
| Create | `hooks/use-browser-notifications.ts` |
| Create | `app/(dashboard)/_components/hitl-provider-wrapper.tsx` |
| Modify | `app/(dashboard)/layout.tsx` |
| Modify | `app/(dashboard)/_components/app-sidebar.tsx` |
| Depends on | Plan 10's `GET /api/interactive-sessions/sidebar` |

## Key Considerations

- **5s poll lag**: Attention clears slightly later than in-chat status. Acceptable.
- **Multiple tabs**: Notification API deduplicates by tag per-origin. Tab titles may show stale in background.
- **Graceful degradation**: Everything works without notification permission, just without browser notifications.
- **Sidebar integration**: `useHitlAttention` is a shared primitive. Future sidebar redesign uses `hasPendingHitl(sessionId)` per entry.
