# Two-Phase Waiting: Compute-Efficient Idle Sessions

## Problem

Interactive sessions stay idle between user prompts. The Trigger.dev task process was staying alive the entire time — burning compute at full rate even when the user walked away for 30+ minutes.

**Before**: ~57 minutes of compute per idle cycle (55min active + 2min warm).
**After**: ~2 minutes of compute per idle cycle. Suspend frees the process entirely ($0 compute).

## Architecture

After each `executePrompt()` completes, the task enters a two-phase idle loop:

```
executePrompt() completes
        │
        ▼
┌─────────────────────────┐
│ Phase 1: WARM            │  ← Process alive, instant response
│ Duration: 2 minutes      │  ← Uses: sessionMessages.once({ timeoutMs })
│ Compute: charged          │
│                           │
│ If message arrives:       │
│   → process immediately   │
│   → back to executePrompt │
└───────────┬───────────────┘
            │ timeout (no message)
            ▼
┌─────────────────────────┐
│ Phase 2: SUSPENDED       │  ← Process freed, $0 compute
│ Duration: ~53 minutes    │  ← Uses: sessionMessages.wait({ timeout })
│ Compute: NOT charged     │  ← Task checkpointed by Trigger.dev
│                           │
│ If message arrives:       │
│   → task resumes (~1-2s)  │
│   → refresh git token     │
│   → re-register handlers  │
│   → back to executePrompt │
└───────────┬───────────────┘
            │ timeout (no message for ~55min total)
            ▼
┌─────────────────────────┐
│ HIBERNATION SEQUENCE     │  ← Scrub credentials, snapshot sandbox
│ Status: hibernating →    │
│         hibernated       │
└─────────────────────────┘
```

## Session Status Lifecycle

```
creating → active → warm → suspended → hibernating → hibernated
             ↑        │        │
             └────────┴────────┘  (message arrives → back to active)

Any state → stopped | failed
```

| Status | Process | Sandbox | Compute Cost | Resume Latency |
|--------|---------|---------|-------------|----------------|
| active | Running | Alive | Full rate | N/A (already processing) |
| warm | Running (waiting) | Alive | Full rate | Instant |
| suspended | Checkpointed | Alive (extended timeout) | $0 | ~1-2 seconds |
| hibernated | Dead | Stopped (snapshot saved) | $0 | ~5-15 seconds |

## SDK Primitives Used

### `.once({ timeoutMs })` — Warm Phase

From `@trigger.dev/sdk/v3` input streams. Keeps the task process alive while waiting for the next message. Checks the in-memory buffer first (FIFO), so buffered messages during `executePrompt()` are consumed instantly.

Returns `{ ok: true, output }` on message or `{ ok: false }` on timeout.

### `.wait({ timeout })` — Suspend Phase

Creates a server-side waitpoint and **suspends the task process entirely**. Trigger.dev checkpoints the JavaScript heap state and frees compute resources. When a message arrives via `.send()`, the server resolves the waitpoint and the task resumes with all state restored.

Tracks `lastSeqNum` internally to prevent replaying already-consumed messages.

Returns a `ManualWaitpointPromise` — same type as `wait.forToken()`.

### `.on(handler)` — HITL Actions + Stop Capture

Persistent handler that fires for every incoming message. Handles HITL (human-in-the-loop) actions during `executePrompt()` and captures stop requests:
- `stop` — sets `stopRequested` flag (checked after `executePrompt()` returns)
- `permission_reply` — agent asks user for tool permission
- `question_reply` — agent asks user a question
- `question_reject` — user rejects agent's question

The `.on()` handler runs concurrently with `executePrompt()`, allowing immediate HITL responses without waiting for the prompt to finish.

**Dispatch priority** (three paths):

| Scenario | Behavior |
|----------|----------|
| `.once()` waiter + `.on()` handler | Waiter resolves first, then `.on()` fires — both see the message |
| Only `.on()` handler (during `executePrompt()`) | `.on()` fires, message is **NOT buffered** for next `.once()` |
| Neither registered | Message buffered for next `.once()` call |

**Critical implication**: Messages sent during `executePrompt()` are consumed by `.on()` and never reach `.once()`. This is why stop handling uses a `stopRequested` flag in the `.on()` handler — without it, stop messages sent during active processing would be silently dropped.

## Suspend Resume Details

When resuming from suspend:

1. **Re-register `.on()` handler** — `.on()` was unsubscribed before suspend (handlers don't fire during suspension anyway)
2. **Restart heartbeat** — sandbox timeout extension interval
3. **Refresh git token** — GitHub App installation tokens expire after ~1 hour. Since suspend can last up to 53 minutes, the token may be expired.
4. **Extend sandbox timeout** — before suspending, the sandbox timeout is extended to 60 minutes to cover the full suspend duration

## API Route Tiers

The prompt API route (`/api/interactive-sessions/:id/prompt`) routes messages based on session status:

| Tier | Status | Action | Latency |
|------|--------|--------|---------|
| 1 (Hot) | active | `.send()` to input stream | Instant |
| 2 (Warm) | warm | `.send()` to input stream | Instant |
| 2b (Suspended) | suspended | `.send()` to input stream (auto-resumes task) | ~1-2s |
| 3 (Hibernate) | hibernated | Trigger new task from snapshot | ~5-15s |
| 4 (Cold) | idle/stopped/completed | Trigger new task, replay history | ~15-20s |

## Key Files

| File | Role |
|------|------|
| `trigger/interactive-session.ts` | Task with two-phase idle loop |
| `lib/trigger/streams.ts` | Input stream definition (`sessionMessages`) |
| `lib/trigger/types.ts` | `SessionMessage` union type |
| `app/api/interactive-sessions/[sessionId]/prompt/route.ts` | API route with tiered dispatch |
| `lib/sessions/schema.ts` | DB schema with `suspended` in unique index |
| `lib/sessions/actions.ts` | `getActiveRuntime` includes `suspended` status |
