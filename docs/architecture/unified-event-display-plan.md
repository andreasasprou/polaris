# Unified Event Display: Realtime-First with DB Recovery

## Problem

Two separate event display systems (live mode via Trigger.dev stream, history mode via DB polling) with a one-way switch between them. This causes:

1. **2-4s blank screen on resume** — `shouldPollHistory: false` during "creating", realtime points at dead run
2. **Events disappearing/reappearing** — optimistic prompt cleared by realtime, then re-added by history poll
3. **Run ID mismatch** — frontend holds old `triggerRunId` while new run starts, realtime subscribes to dead stream
4. **Redundant data paths** — same events fetched via both realtime stream and DB polling, with no deduplication

Root cause: the page makes a **one-time decision** between live and history mode. Once `sdkSessionId` is set, it never uses realtime again — even though realtime is the only path that provides zero-latency events.

## Solution

**Single unified display**: DB events for history + realtime stream for current turn, always.

```
                    ┌──────────────────────────────────────────┐
                    │         ON PAGE LOAD / REFRESH           │
                    │                                          │
                    │  Fetch DB events (all past turns)         │
                    │  via sdkSessionId                         │
                    │  → Immediate display of full history      │
                    └──────────────┬───────────────────────────┘
                                   │
                                   │  if active run exists
                                   │
                    ┌──────────────▼───────────────────────────┐
                    │         REALTIME OVERLAY                 │
                    │                                          │
                    │  Subscribe to triggerRunId stream         │
                    │  → Live events for current turn (0ms lag) │
                    │  → Metadata: setupStep, status            │
                    │                                          │
                    │  Merge with DB events by eventIndex       │
                    │  (dedup: realtime wins on conflict)       │
                    └──────────────────────────────────────────┘
```

**Key enabler**: The prompt API returns `triggerRunId` + `accessToken` on resume, so the frontend can subscribe to the new run's stream **immediately** — no 2-4s polling gap.

## Data Flow: Before vs After

### Before (Current)

```
RESUME TIMELINE         FRONTEND                          WHAT USER SEES
─────────────────────────────────────────────────────────────────────
T0  User sends msg      POST /prompt → 200                "Resuming..."
T1  (+0s)               sdkSessionId exists →              Blank (history mode,
                        HISTORY MODE selected              but not polling)
T2  (+2s)               Status poll fires →                Still blank
                        gets triggerRunId: run_NEW          (creating access token)
T3  (+3s)               Access token ready →               Maybe events start
                        realtime subscribes to run_NEW     appearing (if lucky)
T4  (+4s)               Status changes to "active" →       Events visible
                        shouldPollHistory: true            (with 2s lag from polling)
```

### After (Refactored)

```
RESUME TIMELINE         FRONTEND                          WHAT USER SEES
─────────────────────────────────────────────────────────────────────
T0  User sends msg      POST /prompt → 200                History from DB +
                        Response: { triggerRunId,          "Resuming..." spinner
                                    accessToken }
T0  (+0ms)              Subscribe to run_NEW stream        Setup steps visible
                        with accessToken from response     via realtime metadata
T1  (+1-3s)             Task starts, sets metadata →       "Restoring snapshot..."
                        realtime delivers setupStep        "Starting agent..."
T2  (+3-5s)             Agent produces events →            Events appear
                        realtime delivers instantly        in real-time (0ms lag)
```

## Detailed Changes

### 1. Prompt API returns `triggerRunId` + `accessToken` on resume

**File: `app/api/interactive-sessions/[sessionId]/prompt/route.ts`**

For Tier 3 (hibernate resume) and Tier 4 (cold resume), capture the return value of `tasks.trigger()` and mint an access token for the new run:

```typescript
// Tier 3 (hibernate) — around line 158
const handle = await tasks.trigger<typeof interactiveSessionTask>(...);

const accessToken = await auth.createPublicToken({
  scopes: {
    read: { runs: [handle.id] },
    write: { inputStreams: [handle.id] },
  },
  expirationTime: "2h",
});

return NextResponse.json({
  ok: true,
  resumed: true,
  tier: "hibernate",
  triggerRunId: handle.id,
  accessToken,
});
```

Same pattern for Tier 4 (cold resume).

For Tier 1/2/2b (hot/warm/suspended), the run doesn't change — no need to return `triggerRunId`.

### 2. Update `sendPromptViaApi` to return run info

**File: `app/(dashboard)/sessions/[sessionId]/page.tsx`**

Change `sendPromptViaApi` to return `{ ok, triggerRunId?, accessToken? }` instead of `boolean`. The page uses this to update session state immediately:

```typescript
async function sendPromptViaApi(sessionId: string, text: string): Promise<{
  ok: boolean;
  triggerRunId?: string;
  accessToken?: string;
}> {
  // ... existing retry logic ...
  const data = await res.json();
  return {
    ok: true,
    triggerRunId: data.triggerRunId,
    accessToken: data.accessToken,
  };
}
```

When the page receives a response with `triggerRunId`:

```typescript
const result = await sendPromptViaApi(sessionId, text);
if (result.ok && result.triggerRunId) {
  // Immediately update local state — no polling needed
  setSession(prev => prev ? {
    ...prev,
    triggerRunId: result.triggerRunId!,
    status: "creating",
  } : prev);
  setAccessToken(result.accessToken ?? null);
}
```

### 3. Create unified `useSessionChat` hook

**New file: `hooks/use-session-chat.ts`**

Replaces both `useRealtimeSession` and `useSessionEvents` with a single hook that merges DB history and realtime events.

```typescript
type UseSessionChatOptions = {
  /** SDK session ID for fetching historical events from DB. */
  sdkSessionId: string | null;
  /** Current Trigger.dev run ID for realtime subscription. */
  triggerRunId: string | null;
  /** Access token for the current run (run-scoped). */
  accessToken: string | null;
};

type UseSessionChatReturn = {
  /** Consolidated chat items from all sources (DB + realtime). */
  items: ChatItem[];
  /** Whether the agent is currently working. */
  turnInProgress: boolean;
  /** Trigger.dev run status (QUEUED, EXECUTING, COMPLETED, etc.). */
  runStatus: string | null;
  /** App-level session status from run metadata. */
  sessionStatus: string | null;
  /** Current setup phase (shown during provisioning). */
  setupStep: string | null;
  /** Whether the initial DB fetch is loading. */
  loading: boolean;
  /** Error from either source. */
  error: Error | null;
};
```

**Internal logic:**

1. **DB layer** — fetch historical events from `/api/sessions/${sdkSessionId}/events` on mount and when `sdkSessionId` changes. Also re-fetch when the realtime run reaches a terminal status (ensures final events are captured).

2. **Realtime layer** — `useRealtimeRunWithStreams` subscribed when `triggerRunId` + `accessToken` are available. Returns current turn's events + run metadata.

3. **Merge** — combine both event arrays, deduplicate by `eventIndex` (realtime wins on conflict), sort by `eventIndex`, then pass through `consolidateEvents()`.

```typescript
const merged = useMemo(() => {
  // Build map: eventIndex → event (DB first, realtime overwrites)
  const eventMap = new Map<number, SandboxAgentEvent>();
  for (const event of dbEvents) {
    eventMap.set(event.eventIndex, event);
  }
  for (const event of realtimeEvents) {
    eventMap.set(event.eventIndex, event);
  }
  // Sort by eventIndex
  const sorted = [...eventMap.values()].sort((a, b) => a.eventIndex - b.eventIndex);
  return consolidateEvents(sorted);
}, [dbEvents, realtimeEvents]);
```

### 4. Simplify `SessionChat` to single component

**File: `components/sessions/session-chat.tsx`**

Remove the `LiveSessionChat` / `HistorySessionChat` split. Single component:

```typescript
type SessionChatProps = {
  items: ChatItem[];
  turnInProgress: boolean;
  loading?: boolean;
};

export function SessionChat({ items, turnInProgress, loading }: SessionChatProps) {
  // Single render path — no mode switching
  // Uses useAutoScroll, ChatItemRenderer, TurnIndicator
}
```

The hook returns everything the component needs. No mode decision.

### 5. Simplify session page

**File: `app/(dashboard)/sessions/[sessionId]/page.tsx`**

Major simplification:

```typescript
// Before: complex mode switching
let chatContent: React.ReactNode;
if (session.sdkSessionId) {
  chatContent = <SessionChat mode="history" ... />;
} else if (hasRealtimeAccess && config.hasLiveProcess) {
  chatContent = <SessionChat mode="live" ... />;
} else { ... }

// After: single unified view
const chat = useSessionChat({
  sdkSessionId: session.sdkSessionId,
  triggerRunId: session.triggerRunId,
  accessToken,
});

chatContent = (
  <>
    <SessionChat
      items={chat.items}
      turnInProgress={chat.turnInProgress}
      loading={chat.loading}
    />
    {pendingPrompt && <UserMessage text={pendingPrompt} />}
    {chat.setupStep && (
      <SetupSpinner step={chat.setupStep} />
    )}
  </>
);
```

**Access token flow change:**

Don't clear-and-recreate the access token on `triggerRunId` change. Instead:
- On initial load: create access token from session's `triggerRunId` (existing behavior)
- On resume: use the access token returned by the prompt API (new behavior)
- The `useEffect` that creates access tokens becomes a fallback for page load only

```typescript
// Only create token on mount/page-load (not on triggerRunId change)
useEffect(() => {
  if (!session?.triggerRunId || accessToken) return; // Don't re-create if we already have one
  createSessionAccessToken(sessionId)
    .then(setAccessToken)
    .catch(console.error);
}, [sessionId, session?.triggerRunId]); // Note: no accessToken in deps
```

### 6. Update status config

**File: `lib/sessions/status.ts`**

Remove `shouldPollHistory` — no longer needed. History is fetched once on mount, not polled.

Consider removing `shouldPollStatus` for "creating" — realtime metadata now provides setup steps without polling. Keep it as a fallback for edge cases where realtime isn't connected yet.

## Scenario Walkthroughs

### First turn (new session)

1. User creates session → page loads with `triggerRunId` (from DB), no `sdkSessionId`
2. Access token created → realtime subscribes
3. `useSessionChat`: no DB events (sdkSessionId null), all events from realtime
4. Events stream in real-time — identical to current live mode
5. When run completes, `sdkSessionId` appears in metadata → stored for future

### Resume from hibernated

1. User sends message → POST /prompt
2. Response: `{ triggerRunId: "run_NEW", accessToken: "pk_..." }`
3. Page updates: `session.triggerRunId = "run_NEW"`, `setAccessToken("pk_...")`
4. `useSessionChat`: DB events from history (fetched on mount) + realtime from run_NEW
5. Setup steps appear via metadata: "Restoring from snapshot..." → "Starting agent..."
6. Agent events stream in real-time, merged with history

### Resume from suspended

1. User sends message → POST /prompt (Tier 2b)
2. Message sent via input stream → same run resumes from `.wait()`
3. `triggerRunId` doesn't change — realtime already subscribed
4. Agent sets metadata status to "active" → frontend sees it instantly
5. Events stream in real-time

### Page refresh during active turn

1. Page loads → fetches session (has `triggerRunId`, `sdkSessionId`)
2. DB fetch: gets all persisted events (history + some of current turn)
3. Access token created → realtime subscribes to current run
4. Merge: DB events (0-N + some current) + realtime events (current turn)
5. Dedup by eventIndex → complete, gapless display

### Page load on inactive session (hibernated/stopped)

1. Page loads → fetches session (no active `triggerRunId` or terminal run)
2. DB fetch: gets all persisted events
3. No realtime (no active run)
4. Shows complete history from DB — identical to current history mode

## What Doesn't Change

- **Backend event persistence** — SDK persist driver still writes to `sandbox_agent.events`
- **Native resume** — still works, `persistEvent` still writes events for native resume
- **Trigger.dev stream writer** — `streams.writer("events")` unchanged in task code
- **HITL** — permission/question handling via input stream unchanged
- **Event types and consolidation** — `event-types.ts` unchanged
- **Input stream send** — `useInputStreamSend` unchanged
- **Two-phase idle loop** — warm wait → suspend unchanged

## Files Modified

| File | Change |
|------|--------|
| `app/api/.../prompt/route.ts` | Return `triggerRunId` + `accessToken` on Tier 3/4 |
| `hooks/use-session-chat.ts` | **NEW** — unified hook merging DB + realtime |
| `components/sessions/session-chat.tsx` | Collapse to single component |
| `app/(dashboard)/sessions/[sessionId]/page.tsx` | Remove mode switch, use unified hook |
| `lib/sessions/status.ts` | Remove `shouldPollHistory` |
| `hooks/use-realtime-session.ts` | Delete (absorbed into use-session-chat) |
| `hooks/use-session-events.ts` | Delete (absorbed into use-session-chat) |

## Risks

1. **`useRealtimeRunWithStreams` run transition** — when `triggerRunId` changes, does the hook cleanly unsubscribe from the old run and subscribe to the new one? Need to verify. If not, may need to force-remount the hook via a React key.

2. **Event dedup correctness** — relies on `eventIndex` being globally unique across a session's lifetime. Currently true (SDK persist driver maintains monotonic index; native resume offsets past existing events). Must remain true.

3. **Access token for dead runs** — if the page loads with a `triggerRunId` for a completed/failed run, `useRealtimeRunWithStreams` will subscribe but get a terminal status immediately. The hook should handle this gracefully (it currently does — it just returns `run.status = "COMPLETED"`).

4. **DB event staleness** — DB events are fetched once on mount. If a previous turn's events were still being persisted when the page loaded, some might be missing. Mitigated by: re-fetching DB events when the realtime run reaches a terminal status.

## Verification

1. **New session first turn**: Events appear in real-time, no regressions
2. **Resume from hibernated**: Events appear immediately (no blank gap), history visible
3. **Resume from suspended**: Events appear immediately, no polling delay
4. **Page refresh during active turn**: Full history + live events, no duplicates
5. **Page load on inactive session**: Full history displayed
6. **Multiple turns**: Each turn's events accumulate correctly
7. `pnpm typecheck` passes
