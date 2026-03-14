# QA Report — Session Lifecycle & Resume (2026-03-11)

## Bugs Found & Fixed

### 1. Failed sessions not resumable (UI)
- **Symptom**: Input disabled with "Session failed" on failed sessions
- **Root cause**: `status.ts` had `canSend: false` for `failed` status
- **Fix**: Changed to `canSend: true, sendPath: "api"` — same as `stopped`/`completed`
- **Verified**: Input now shows "Send a message to resume..."

### 2. Failed sessions not resumable (API)
- **Symptom**: Prompt API returned 400 for failed sessions
- **Root cause**: `RESUMABLE_STATUSES` in prompt route didn't include `"failed"`
- **Fix**: Added `"failed"` to the array
- **Verified**: POST `/api/.../prompt` now accepts failed sessions

### 3. Session stuck at "creating" forever on trigger failure
- **Symptom**: If `tasks.trigger()` throws, CAS already set status to "creating" with no rollback
- **Root cause**: No try/catch around `tasks.trigger` in both hibernate and cold resume paths
- **Fix**: Wrapped in try/catch with rollback to previous status + error message
- **Verified**: On trigger failure, session rolls back to "failed" with descriptive error

### 4. Stale `triggerRunId` in DB after resume
- **Symptom**: DB kept old dead run ID after CAS; polls/refreshes see stale data
- **Root cause**: CAS didn't clear `triggerRunId`, and new ID wasn't written until task started
- **Fix**: CAS now passes `triggerRunId: null`, then `updateInteractiveSession` sets new ID after trigger
- **Verified**: DB shows correct run ID immediately after resume

### 5. Stale runtime blocks new runtime creation (unique constraint)
- **Symptom**: `createRuntime` throws unique constraint violation on `idx_one_live_runtime_per_session`
- **Root cause**: Previous runtime from timed-out run was still `status: 'running'` — never cleaned up
- **Fix**: Added `endStaleRuntimes(sessionId)` call before `createRuntime` in both resume paths
- **Verified**: Resume creates new runtime after ending stale one

### 6. Git clone fails with networkPolicy Bearer auth
- **Symptom**: `fatal: could not read Username for 'https://github.com'`
- **Root cause**: `networkPolicy` used `Authorization: Bearer <token>` — git HTTPS requires Basic auth
- **Fix**: Changed to `Basic base64(x-access-token:<token>)` format
- **Verified**: Git clone works inside sandbox via networkPolicy

### 7. GET reconciliation left stale triggerRunId
- **Symptom**: Healed session still pointed to dead run ID
- **Root cause**: `casSessionStatus` in GET handler didn't null out `triggerRunId`
- **Fix**: Added `triggerRunId: null` to the CAS extra fields
- **Verified**: Healed sessions have null triggerRunId

### 8. Tool calls show spinner in terminal sessions
- **Symptom**: Last Bash tool call in failed session showed indefinite spinner
- **Root cause**: No `turn_ended` event (sandbox died), so `turnInProgress` stayed true
- **Fix**: `consolidateEvents` accepts `terminal` flag — forces `turnInProgress: false`, marks incomplete tool calls as "interrupted"
- **Verified**: Tool calls in failed sessions show orange ■ (interrupted), no spinner

## Visual State Matrix — Verified

| State | Status Badge | Tool Call Icons | Input | Stop Button | Polling |
|-------|-------------|----------------|-------|-------------|---------|
| **failed** | Red "failed" | Orange ■ (interrupted) | "Send a message to resume..." (enabled) | Hidden | None |
| **creating** | Grey "creating" | Shimmer spinner | "Starting up..." (disabled) | Hidden | 2s |
| **active** | Green "active" | Green ✓ / Blue spinner | "Send a message..." (enabled) | Visible | 30s safety |
| **paused** | Grey "paused" | Orange ■ (interrupted) | "Send a message to resume..." (enabled) | Hidden | None |

## Flows Tested

### Resume from failed session
1. Session shows "failed" badge + error banner
2. Input enabled with "Send a message to resume..." placeholder
3. User types message and hits Enter
4. POST `/api/.../prompt` → CAS to "creating", trigger new task
5. Status transitions: failed → creating → active
6. Agent replays session history, processes new prompt
7. Agent responds, tool calls execute successfully

### Stop active session
1. Click "Stop" button in header
2. Session transitions: active → paused (hibernating)
3. Tool calls in progress marked as interrupted (orange ■)
4. Input shows "Send a message to resume..."
5. No Stop button in paused state

### Trigger failure rollback
1. User sends message on failed session
2. `tasks.trigger()` fails (e.g., worker not running)
3. CAS rolls back: creating → failed with error "Resume failed: ..."
4. Session is NOT stuck at "creating"
5. User can retry

## Files Modified

| File | Changes |
|------|---------|
| `lib/sessions/status.ts` | `failed.canSend: true`, `failed.sendPath: "api"` |
| `lib/sessions/actions.ts` | Added `endStaleRuntimes()` helper |
| `app/api/.../prompt/route.ts` | Added `"failed"` to RESUMABLE_STATUSES, try/catch with rollback, `endStaleRuntimes` calls, `updateInteractiveSession` for triggerRunId |
| `app/api/.../route.ts` | GET reconciliation nulls `triggerRunId` |
| `lib/sandbox/SandboxManager.ts` | networkPolicy uses Basic auth (not Bearer) |
| `lib/sandbox-agent/event-types.ts` | `consolidateEvents` accepts `terminal` flag |
| `components/sessions/tool-call-item.tsx` | Added "interrupted" status (orange ■) |
| `hooks/use-session-chat.ts` | Passes `terminal` to `consolidateEvents` |
| `CLAUDE.md` | Architecture principles + expanded QA process |
