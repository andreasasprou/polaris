---
title: Live Progress Indicators
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, observability]
---

# 12 — Live Progress Indicators

## Problem Statement

Active sessions show "Agent is working..." with a spinner and a status badge. No elapsed time, no phase/step tracking, no real-time cost ticker. Cursor Glass shows execution time prominently; Codex streams events with visible to-do checklists.

## Design

### Timer Without useEffect — The `useTick` Hook

Uses `useSyncExternalStore` subscribing to a global 1-second clock store. Multiple components share one interval. No useEffect needed.

```typescript
// Global clock: tick updates every 1s, listeners are notified
export function useTick(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
```

Elapsed time is pure derived state: `now - startedAt`. Terminal sessions use `endedAt - startedAt`.

> **Hydration:** `getServerSnapshot` returns `Date.now()` captured at module load time (a stable constant). The first client render will show a brief stale value that immediately updates. Since `SessionProgressBar` only renders in `'use client'` components after the session loads, hydration mismatch risk is minimal.

### Phase Detection

> **Unified with Plan 18:** Instead of creating a separate `PHASE_CONFIG`, consume `derivePipelinePhases()` from `lib/sessions/pipeline-phases.ts` (Plan 18). The progress bar's phase label is simply the `label` of the phase with `state === 'active'` from that array. This avoids duplicate phase derivation systems.

Derive from session status + job status (not individual events):

| Session Status | Job Status | Phase Label |
|---|---|---|
| `creating` | — | Provisioning |
| `active` | `pending`/`accepted` | Setting up agent |
| `active` | `running` | Running agent |
| `active` | `waiting_human` | Waiting for input |
| `snapshotting` | — | Saving snapshot |
| terminal | `completed` | Complete |

> **HITL phase:** When session is `active` but job attempt is `waiting_human`, show phase 'Waiting for input' with an amber indicator. This is not currently in the phase table and needs to be added.

### Token/Cost Accumulation

> **latestUsage derivation:** Derive `latestUsage` from the `items` array in `use-session-chat.ts` via a `useMemo` rather than modifying `consolidateEvents()`. This avoids touching the shared consolidation function: `const latestUsage = useMemo(() => items.filter(i => i.type === 'usage').at(-1), [items])`

The last `usage_update` event in the stream is already cumulative. No new accumulation logic needed.

> **Cost units:** Verify the unit of `UsageEvent.cost.amount` — is it dollars or cents? Check the agent SDK documentation. Getting this wrong means a 100x display error. Add a comment in the component documenting the expected unit.

## Implementation

### Data Layer Changes

1. **Set `startedAt` atomically on first dispatch** — Set `startedAt` via the CAS `extra` fields in `dispatchPromptToSession`, not via a separate `updateInteractiveSession` call. The CAS guarantees atomicity. Add `startedAt: session.startedAt ? undefined : new Date()` to the extra fields in the CAS from idle/creating to active.
2. **Enrich session API** with `activeJobStatus` — use a shared `enrichSessionResponse(session)` helper (new file: `lib/sessions/api-helpers.ts`). Plans 14 and 18 will add their own fields to this helper. This prevents merge conflicts from three plans editing the same route handler.
3. **Surface `latestUsage`** from `useSessionChat` return via `useMemo` (see above)

### New Files

- `hooks/use-tick.ts` — useSyncExternalStore-based 1s clock
- `lib/utils/format-elapsed.ts` — ms → "1m 23s" formatter
- `components/sessions/session-progress-bar.tsx` — Compact bar: phase + timer + cost + context
- `lib/sessions/api-helpers.ts` — Shared `enrichSessionResponse(session)` helper

### SessionProgressBar Component

Props: `sessionStatus`, `activeJobStatus`, `createdAt`, `startedAt`, `endedAt`, `latestUsage`

Layout: single horizontal row
```
[Provisioning] [Running for 1m 23s] [$0.0234] [47% context]
```

When terminal:
```
[Completed in 3m 12s] [$0.1247] [62% context]
```

### Modified Files

| File | Change |
|------|--------|
| `lib/sessions/pipeline-phases.ts` | Plan 18's file — consume `derivePipelinePhases()`, don't duplicate |
| `lib/sessions/api-helpers.ts` | New — shared `enrichSessionResponse()` helper |
| `hooks/use-session-chat.ts` | Surface latestUsage via useMemo |
| `app/api/interactive-sessions/[sessionId]/route.ts` | Use enrichSessionResponse to add activeJobStatus |
| `lib/orchestration/prompt-dispatch.ts` | Set startedAt atomically in CAS extra fields |
| `app/(dashboard)/sessions/[sessionId]/page.tsx` | Render SessionProgressBar |
| `components/sessions/session-status.tsx` | Add phaseLabel to TurnIndicator |

## Key Considerations

- **Session resume**: `startedAt` represents first-ever start. Timer shows total elapsed, not per-run.
- **Hydration**: `useSyncExternalStore` with stable `getServerSnapshot` avoids mismatch.
- **`startedAt` backfill**: Existing sessions have null startedAt. UI falls back to `createdAt`.
- **Poll frequency**: activeJobStatus piggybacks on existing 2s session poll. No extra requests.
