# Event Display Architecture: Current State & Problems

## How It Works Today

There are **two completely separate systems** for showing events to the user, and the page picks one OR the other — never both.

### System 1: Live Mode (Trigger.dev Realtime Stream)

```
Agent in Sandbox
    │
    │  onEvent callback
    ▼
streams.writer("events")  ──►  Trigger.dev Cloud  ──►  useRealtimeRunWithStreams()
                                (SSE stream)              │
                                                          ▼
                                                   useRealtimeSession()
                                                          │
                                                          ▼
                                                   <LiveSessionChat />
```

- Events flow in real-time via Server-Sent Events (SSE)
- Subscribed by **run ID** — each Trigger.dev task run has its own stream
- Only works while the stream is active (i.e. the specific run is alive)
- Events are ephemeral — they exist in the stream, not persisted by this path

### System 2: History Mode (Database Polling)

```
Agent in Sandbox
    │
    │  SDK persist driver (automatic)
    ▼
sandbox_agent.events table  ◄──  PostgresSessionPersistDriver.insertEvent()
    │
    │  HTTP GET /api/sessions/:sdkSessionId/events
    │  (polled every 2 seconds when shouldPollHistory=true)
    ▼
useSessionEvents()
    │
    ▼
<HistorySessionChat />
```

- Events are written to Postgres by the sandbox-agent SDK's persist driver
- Keyed by **SDK session ID** — a logical session identity that spans multiple runs
- Frontend polls every 2 seconds (when enabled)
- Works across page refreshes, but has 2s latency

### How The Page Chooses

```
                        ┌─────────────────────┐
                        │  session.sdkSessionId │
                        │      exists?          │
                        └──────┬────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
                   YES                    NO
                    │                     │
                    ▼                     ▼
            ┌──────────────┐     ┌──────────────────┐
            │ HISTORY MODE │     │ hasRealtimeAccess │
            │              │     │ && hasLiveProcess?│
            │ Poll DB for  │     └────────┬─────────┘
            │ events using │              │
            │ sdkSessionId │        YES ──┤── NO
            └──────────────┘              │      │
                                          ▼      ▼
                                   ┌───────────┐  "No data"
                                   │ LIVE MODE │
                                   │           │
                                   │ Subscribe │
                                   │ to stream │
                                   │ via runId │
                                   └───────────┘
```

**The switch is a one-way door**: Once `sdkSessionId` is set (after the first prompt completes), the page ALWAYS uses history mode. It never goes back to live mode.

## The Problem: What Happens On Resume

### Timeline of a Hibernate Resume

```
TIME    │ DB STATE                        │ FRONTEND STATE              │ WHAT USER SEES
────────┼─────────────────────────────────┼─────────────────────────────┼──────────────────────
T0      │ status: hibernated              │ status: hibernated          │ Old events from
        │ triggerRunId: run_OLD (dead)     │ triggerRunId: run_OLD       │ first turn.
        │ sdkSessionId: sdk_123           │ sdkSessionId: sdk_123       │ "Send a message
        │                                 │                             │  to resume..."
────────┼─────────────────────────────────┼─────────────────────────────┼──────────────────────
T1      │ User clicks send                │                             │
        │ POST /prompt returns 200        │                             │
        │ Status CAS → "creating"         │ Pending prompt shown        │ "Resuming session..."
        │ tasks.trigger() fires           │                             │
────────┼─────────────────────────────────┼─────────────────────────────┼──────────────────────
T2      │ New task starts (run_NEW)       │ Polls session every 2s      │
(+1-3s) │ DB updated:                     │ Still has:                  │
        │   triggerRunId: run_NEW         │   triggerRunId: run_OLD     │ PROBLEM: If realtime
        │   status: active                │   status: creating          │ is enabled, it's
        │                                 │                             │ subscribed to run_OLD
────────┼─────────────────────────────────┼─────────────────────────────┼──────────────────────
T3      │ Agent processes prompt          │ Poll fires, gets:           │
(+2-4s) │ Events written to              │   triggerRunId: run_NEW     │ Frontend updates
        │   sandbox_agent.events          │   status: active            │ session state.
        │   (under sdk_123)               │                             │
        │                                 │ Mode: HISTORY (sdk exists)  │
        │                                 │ shouldPollHistory: true     │ Events start
        │                                 │                             │ appearing (from
        │                                 │                             │ DB poll)
────────┼─────────────────────────────────┼─────────────────────────────┼──────────────────────
T4      │ Prompt completed                │ Events visible              │ User sees response
(+5-15s)│                                 │                             │ (with 2s lag)
```

### The Failure Windows

**Window 1 (T1→T3): "Creating" status, no event display**

During this 2-4 second window:
- Status is "creating" → `shouldPollHistory: false` → history mode doesn't poll
- `sdkSessionId` exists → page uses history mode (not live mode)
- But history mode isn't polling → **nothing appears**
- Realtime hook IS enabled (`isLive: true` for "creating") but it has the OLD run ID
- Result: **blank screen for 2-4 seconds**

**Window 2 (T2→T3): Wrong run ID for realtime**

- Frontend still has `triggerRunId: run_OLD`
- New task writes events to `run_NEW`'s stream
- Realtime subscription points at dead `run_OLD`
- This is harmless IF history mode is working (it would show events from DB instead)
- But history mode isn't polling during "creating" → compounds Window 1

**Window 3: Page refresh during active resumed session**

- Page reloads → fetches session from API → gets `triggerRunId: run_NEW`
- `sdkSessionId` exists → history mode
- `shouldPollHistory: true` (status is "active") → polls every 2s
- **This actually works!** Events appear with 2s lag
- But the realtime hook ALSO subscribes to `run_NEW` (since `isLive: true`)
- This creates redundant subscriptions but doesn't cause visible bugs

## The Two Options

### Option A: History-Only (Simple, Reliable)

Always use history mode after the first turn. Just fix the polling gaps.

```
                    ┌──────────────────────────────────────┐
                    │         FIRST TURN ONLY              │
                    │  (sdkSessionId not set yet)           │
                    │                                      │
                    │  Agent ──► Trigger.dev Stream ──► UI  │
                    │         (real-time, 0 latency)        │
                    └──────────────────────────────────────┘
                                     │
                              sdkSessionId set
                                     │
                                     ▼
                    ┌──────────────────────────────────────┐
                    │     ALL SUBSEQUENT INTERACTIONS       │
                    │                                      │
                    │  Agent ──► SDK Persist ──► Postgres   │
                    │                              │        │
                    │                         poll every 2s │
                    │                              │        │
                    │                              ▼        │
                    │                          Frontend     │
                    │         (~2s latency, but reliable)   │
                    └──────────────────────────────────────┘
```

**Changes needed:**
1. Set `shouldPollHistory: true` for "creating" status (currently `false`)
2. Remove the realtime subscription for resumed sessions (it's never useful — wrong run ID)
3. Remove native resume's manual `persistEvent` — the SDK persist driver already handles this for non-native resume, and for native resume we need to ensure events are written regardless

**Pros:**
- Simple, one data path after first turn
- No run ID mismatch issues — history is keyed by SDK session ID, not run ID
- Works across page refreshes
- Works immediately on resume (events appear as SDK writes them)

**Cons:**
- ~2s latency on all events after first turn
- Slightly less "live" feeling

### Option B: Unified Live + History (Better UX, More Complex)

Always show history for past events, AND overlay live events for the current run.

```
                    ┌──────────────────────────────────────┐
                    │           ALWAYS ACTIVE              │
                    │                                      │
                    │  ┌─────────────────────────────────┐ │
                    │  │ HISTORY LAYER (bottom)           │ │
                    │  │                                  │ │
                    │  │ Postgres → poll → all past events│ │
                    │  └─────────────────────────────────┘ │
                    │              +                        │
                    │  ┌─────────────────────────────────┐ │
                    │  │ LIVE LAYER (top, when run alive) │ │
                    │  │                                  │ │
                    │  │ Trigger.dev stream → new events  │ │
                    │  │ (deduplicated against history)   │ │
                    │  └─────────────────────────────────┘ │
                    └──────────────────────────────────────┘
```

**Changes needed:**
1. Always render history (for past events)
2. When a live run exists, ALSO subscribe to its stream
3. Merge + deduplicate events from both sources
4. When run ID changes (resume), re-subscribe to new run
5. Page needs to detect run ID changes and update subscription

**Pros:**
- Real-time events during active turns (0 latency)
- Full history always visible
- Best possible UX

**Cons:**
- Complex merge/dedup logic
- Need to handle run ID transitions carefully
- More moving parts = more potential bugs

## Recommendation

**Start with Option A.** It fixes all current bugs with minimal changes and gives a reliable baseline. The 2s polling latency is acceptable — most AI agent responses take seconds anyway, so a 2s lag on individual events is barely noticeable.

Option B can be layered on later as an optimization once the foundation is solid.
