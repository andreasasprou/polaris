# v2 Coordination State Machine

**Status:** Revised — blocker fixes applied
**Date:** 2026-03-16 (revised 2026-03-16)
**Prerequisite:** Read `proposed-architecture-v2.md` and `proposed-architecture-v2-review.md` first.
**Purpose:** Define the exact Postgres tables, status enums, invariants, and failure handling that replace Trigger.dev's orchestration. This is the design that prevents us from "rebuilding half of Trigger.dev as ad-hoc tables."

---

## Design Principles

Carried forward from v1 (these are good and we keep them):

1. **State as data** — no explicit state machine class. Status transitions happen via atomic CAS operations. Consumers derive capabilities from status config.
2. **CAS as concurrency primitive** — conditional updates, not locks. Winner is whoever's WHERE matches.
3. **Idempotent operations** — re-running any operation on already-transitioned state is a noop.
4. **Separation of concerns** — session status (user-facing), job status (execution), sandbox lease (infrastructure).

New for v2:

5. **Sandbox is execution authority, Postgres is coordination authority.**
6. **Every callback carries a fencing token (epoch).** Stale sandboxes are fenced off.
7. **Result ingestion is separated from side effects.** Never post a GitHub comment inside the callback handler.

---

## Table Design

### Overview of new/modified tables

| Table | Purpose | New or modified? |
|-------|---------|-----------------|
| `interactive_sessions` | User-facing session state | Modified (simplified statuses, add `epoch`) |
| `interactive_session_runtimes` | One row per sandbox lifecycle | Modified (add `epoch`, `lease_status`) |
| `interactive_session_turns` | Turn-level prompt→response tracking | Modified (add `job_id`, `attempt_id`) |
| `interactive_session_checkpoints` | Hibernation snapshots | Keep as-is |
| `jobs` | Replaces Trigger.dev runs for all async work | **New** |
| `job_attempts` | One row per execution attempt | **New** |
| `callback_inbox` | Idempotent callback ingestion | **New** |
| `job_events` | Append-only audit log | **New** |
| `automation_sessions` | PR-scoped session bridge | Modified (lock pattern evolves to job-based) |
| `automation_runs` | Individual automation run records | Modified (link to `jobs` instead of `triggerRunId`) |
| `event_deliveries` | Webhook deduplication | Keep as-is (already good) |

### `interactive_sessions` (modified)

Changes from v1:
- Remove `triggerRunId` (no more Trigger.dev)
- Add `epoch` (monotonically increasing per session, incremented on each sandbox create/restore)
- Simplify status enum

```sql
ALTER TABLE interactive_sessions
  ADD COLUMN epoch INTEGER NOT NULL DEFAULT 0,
  DROP COLUMN triggerRunId;
```

**v2 Status Enum:**

```
creating    -- Sandbox being provisioned
active      -- Prompt running in sandbox
idle        -- Sandbox alive, no prompt running (replaces warm + suspended)
snapshotting -- Snapshot in progress
hibernated  -- Sandbox destroyed, snapshot saved
stopped     -- User-requested stop
completed   -- Terminal
failed      -- Terminal (can resume)
```

**Status capabilities (v2):**

| Status | Sandbox alive? | Can send? | Send path | Poll interval |
|--------|---------------|-----------|-----------|---------------|
| creating | Being created | No | — | 2s |
| active | Yes | No (busy) | — | 2s |
| idle | Yes | Yes | `POST /sandbox/prompt` | 0 (stable) |
| snapshotting | Being snapshotted | No | — | 2s |
| hibernated | No | Yes | Restore then POST | 0 |
| stopped | No | Yes | Create then POST | 0 |
| completed | No | Yes | Create then POST | 0 |
| failed | No | Yes | Create then POST | 0 |

**Key simplification:** `warm` and `suspended` collapse into `idle`. There's no distinction because there's no task process to be warm or suspended — the sandbox is either alive or not.

### `interactive_session_runtimes` (modified)

Add epoch tracking:

```sql
ALTER TABLE interactive_session_runtimes
  ADD COLUMN epoch INTEGER NOT NULL,
  DROP COLUMN triggerRunId;
```

Each runtime gets the session's current epoch at creation time. This is the fencing token — callbacks from old epochs are rejected.

### `jobs` (new)

Replaces Trigger.dev runs as the coordination record for all async work.

```sql
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id TEXT NOT NULL,

  -- What kind of work
  type            TEXT NOT NULL,
  -- Values: 'prompt', 'review', 'coding_task', 'snapshot', 'pr_create'

  -- Links
  session_id        UUID REFERENCES interactive_sessions(id),
  automation_id     UUID REFERENCES automations(id),
  automation_run_id UUID REFERENCES automation_runs(id),
  request_id        TEXT,             -- Idempotency key (source-specific, see Dedupe Keys section)

  -- State
  status          TEXT NOT NULL DEFAULT 'pending',
  -- Values: pending, accepted, running, agent_completed,
  --         postprocess_pending, completed,
  --         failed_retryable, failed_terminal, cancelled

  -- Configuration
  payload         JSONB NOT NULL DEFAULT '{}',
  max_attempts    INTEGER NOT NULL DEFAULT 3,
  timeout_seconds INTEGER NOT NULL DEFAULT 1200,

  -- Security (dedicated column — never in payload to avoid log leakage)
  hmac_key        TEXT,               -- Per-job HMAC-SHA256 key for callback auth

  -- Result (populated on agent_completed)
  result          JSONB,

  -- Side effect tracking (idempotency for post-processing)
  side_effects_completed JSONB DEFAULT '{}',
  -- Example: {"comment_posted": "comment_id_123", "check_completed": true}

  -- Timing
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  timeout_at      TIMESTAMPTZ,      -- Sweeper marks failed if past this

  -- Indexes
  CONSTRAINT idx_jobs_request_id UNIQUE (session_id, request_id)
);

CREATE INDEX idx_jobs_status ON jobs (status) WHERE status NOT IN ('completed', 'failed_terminal', 'cancelled');
CREATE INDEX idx_jobs_timeout ON jobs (timeout_at) WHERE status IN ('accepted', 'running');
CREATE INDEX idx_jobs_session ON jobs (session_id);
CREATE INDEX idx_jobs_automation ON jobs (automation_id);
```

**Status transitions:**

```
pending ──→ accepted ──→ running ──→ agent_completed ──→ postprocess_pending ──→ completed
                │            │              │
                │            │              └──→ postprocess_failed ──→ postprocess_pending (retry)
                │            │
                │            └──→ failed_retryable ──→ pending (retry, new attempt)
                │
                └──→ failed_retryable ──→ pending (retry, new attempt)

Any state ──→ failed_terminal (max attempts exceeded, or non-retryable error)
Any state ──→ cancelled (user-initiated)
```

**Why these statuses matter:**

| Status | Meaning | What can happen next |
|--------|---------|---------------------|
| `pending` | Queued, not yet dispatched | Dispatch to sandbox |
| `accepted` | Sandbox acknowledged the prompt | Sandbox starts agent |
| `running` | Agent actively executing | Agent finishes or fails |
| `agent_completed` | Agent done, raw result stored | Parse result, start side effects |
| `postprocess_pending` | Side effects queued (GitHub comment, check run) | Execute side effects |
| `completed` | Everything done | Terminal |
| `failed_retryable` | Failed, can try again | Create new attempt |
| `failed_terminal` | Failed, no more retries | Terminal |
| `cancelled` | User cancelled | Terminal |

The critical split: **`agent_completed` → `postprocess_pending` → `completed`**. If posting the GitHub comment fails, the job stays at `postprocess_pending` and only the post-processing retries — the agent never re-runs.

### `job_attempts` (new)

One row per execution attempt. A job with `max_attempts: 3` can have up to 3 attempt rows.

```sql
CREATE TABLE job_attempts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_number  INTEGER NOT NULL,
  epoch           INTEGER NOT NULL,   -- Session epoch at time of attempt
  sandbox_id      TEXT,               -- Which sandbox ran this attempt

  -- State
  status          TEXT NOT NULL DEFAULT 'dispatching',
  -- Values: dispatching, dispatch_unknown, accepted, running,
  --         waiting_human, completed, failed
  --
  -- dispatch_unknown: POST /prompt timed out — sweeper reconciles via GET /status
  -- waiting_human: agent blocked on permission/question — timeout paused

  -- Result
  result_payload  JSONB,              -- Raw agent output
  error           TEXT,

  -- Liveness
  last_progress_at TIMESTAMPTZ,       -- Updated from event persistence — cheap fast-fail signal

  -- Timing
  dispatched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  accepted_at     TIMESTAMPTZ,
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,

  CONSTRAINT idx_job_attempt_unique UNIQUE (job_id, attempt_number)
);

CREATE INDEX idx_job_attempts_job ON job_attempts (job_id);
CREATE INDEX idx_job_attempts_epoch ON job_attempts (epoch);
```

### `callback_inbox` (new)

Makes callback ingestion idempotent. Same pattern as `event_deliveries`.

```sql
CREATE TABLE callback_inbox (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id      UUID NOT NULL REFERENCES job_attempts(id) ON DELETE CASCADE,
  epoch           INTEGER NOT NULL,

  -- Payload
  callback_type   TEXT NOT NULL,
  -- Values: 'prompt_complete', 'prompt_failed', 'prompt_accepted',
  --         'permission_requested', 'question_requested'
  payload         JSONB NOT NULL DEFAULT '{}',

  -- Processing
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processed_at    TIMESTAMPTZ,
  process_error   TEXT,

  -- Timing
  received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Dedupe: sandbox-generated UUID per callback emission
  callback_id     TEXT NOT NULL,

  -- Dedupe: same callback can't be ingested twice
  CONSTRAINT idx_callback_inbox_dedupe
    UNIQUE (job_id, attempt_id, epoch, callback_id)
);
```

### `job_events` (new)

Append-only audit log for every major state transition. Not used for control flow — used for debugging, timeline reconstruction, and observability.

```sql
CREATE TABLE job_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id      UUID REFERENCES job_attempts(id) ON DELETE CASCADE,

  event_type      TEXT NOT NULL,
  -- Values: 'created', 'dispatched', 'dispatch_unknown', 'accepted', 'running',
  --         'waiting_human', 'resumed', 'agent_completed', 'postprocess_started',
  --         'postprocess_failed', 'completed', 'failed', 'cancelled', 'timeout'

  payload         JSONB DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_job_events_job ON job_events (job_id, created_at);
```

### `interactive_session_turns` (modified)

Link turns to the job system for correlation:

```sql
ALTER TABLE interactive_session_turns
  ADD COLUMN job_id UUID REFERENCES jobs(id),
  ADD COLUMN attempt_id UUID REFERENCES job_attempts(id);
```

**Ingestion pattern:**

```typescript
async function ingestCallback(input: {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackId: string;        // Sandbox-generated UUID — unique per emission
  callbackType: string;
  payload: Record<string, unknown>;
}): Promise<{ accepted: boolean; reason?: string }> {

  // 1. Verify epoch is current (fence stale sandboxes)
  const session = await getSessionByJobId(input.jobId);
  if (session.epoch !== input.epoch) {
    return { accepted: false, reason: `stale epoch: got ${input.epoch}, current is ${session.epoch}` };
  }

  // 2. Idempotent insert
  const [row] = await db
    .insert(callbackInbox)
    .values(input)
    .onConflictDoNothing()
    .returning();

  if (!row) {
    return { accepted: false, reason: "duplicate callback" };
  }

  // 3. Process the callback (update job/attempt status, store result)
  await processCallback(row);

  return { accepted: true };
}
```

---

## Flows

### Flow 1: Interactive Session Prompt

```
User clicks Send
    │
    ▼
API route: POST /api/sessions/:id/prompt
    │
    ├─ Is sandbox alive? (check runtime status + health endpoint)
    │   ├─ YES → proceed
    │   └─ NO → restore from snapshot or create fresh
    │           increment session.epoch
    │           create new runtime (epoch = session.epoch)
    │
    ├─ CAS session status: idle → active (serializes concurrent sends — I8)
    │   └─ If CAS fails → return 409 (another prompt is already dispatching)
    │
    ├─ Insert job (type: 'prompt', status: 'pending', request_id = idempotency key)
    │   └─ ON CONFLICT DO NOTHING (idempotent — same request_id is a noop)
    │
    ├─ Insert job_attempt (attempt_number: 1, epoch: session.epoch, status: dispatching)
    │
    ├─ POST /prompt { jobId, attemptId, epoch, prompt, callbackUrl, hmacKey }
    │   ├─ 202 Accepted → CAS attempt dispatching → accepted, CAS job pending → accepted
    │   ├─ 4xx Rejected → CAS attempt → failed, CAS session active → idle (rollback)
    │   └─ Timeout/network error → CAS attempt dispatching → dispatch_unknown
    │       (do NOT rollback session — sweeper reconciles via GET /status)
    │
    └─ Return 202 to UI with { jobId, turnId }

    ... sandbox runs agent ...

Sandbox calls POST /api/callbacks { callbackType: "prompt_complete" }
    { jobId, attemptId, epoch, callbackId, callbackType, payload: { result } }
    │
    ├─ Verify HMAC signature
    ├─ ingestCallback() — epoch fence + dedupe insert (by callbackId)
    ├─ Update job_attempt: status → completed, result_payload = result
    ├─ Update job: status → agent_completed, result = result
    ├─ Update session: status active → idle
    ├─ Update turn: status → completed, finalMessage = result.lastMessage
    ├─ Append job_event (event_type: 'completed')
    │
    └─ Return 200 to sandbox

UI polls GET /api/sessions/:id/events?since=cursor
    └─ Returns events from DB (same as v1, no change)
```

### Flow 2: PR Review

```
GitHub webhook: pull_request.synchronize
    │
    ▼
API route: POST /api/webhooks/github
    │
    ├─ claimDelivery() — dedupe (same as v1)
    ├─ Route to automation
    ├─ Determine review scope (full vs incremental)
    │
    ├─ Try acquire review lock (CAS reviewLockJobId from NULL/terminal → new job ID)
    │   └─ Lock acquire + queue update + job creation in single db.transaction()
    │   └─ If locked (active nonterminal job exists) → queue in metadata.pendingReviewRequest → return
    │
    ├─ Insert job (type: 'review', status: 'pending')
    ├─ Insert automation_run (link to job)
    ├─ Create GitHub check run (status: in_progress)
    │
    ├─ Find/create sandbox for this automation session
    │   └─ Increment epoch if creating/restoring
    │
    ├─ Insert job_attempt (epoch = session.epoch)
    ├─ POST /sandbox/api/prompt { jobId, attemptId, epoch, prompt }
    │   └─ 202 Accepted
    │
    ├─ Update job: pending → accepted
    │
    └─ Return 200 to GitHub

    ... agent runs review (2-20 min) ...

Sandbox calls POST /api/callbacks/prompt-complete
    { jobId, attemptId, epoch, result }
    │
    ├─ ingestCallback() — epoch fence + dedupe
    ├─ Update job: → agent_completed (store raw result)
    ├─ Update job: → postprocess_pending
    │
    ├─ Post-processing pipeline:
    │   ├─ Parse review output (parseReviewOutput)
    │   ├─ Post GitHub comment (renderReviewComment)
    │   ├─ Update check run (completed, with verdict)
    │   ├─ Update automation_session metadata (reviewState, lastReviewedSha)
    │   ├─ Update automation_run (verdict, severityCounts, metrics)
    │   └─ Mark previous comments stale
    │
    ├─ Update job: → completed
    ├─ Release review lock
    ├─ Check for pendingReviewRequest → dispatch if exists
    │
    └─ Return 200

If post-processing fails:
    ├─ Job stays at postprocess_pending
    ├─ Sweeper retries post-processing (agent result is already stored)
    └─ Agent does NOT re-run
```

### Flow 3: Coding Task

```
Event trigger (GitHub push, Slack command, etc.)
    │
    ▼
API route: POST /api/webhooks/:source
    │
    ├─ claimDelivery() — dedupe
    ├─ Route to automation
    │
    ├─ Insert job (type: 'coding_task', status: 'pending')
    ├─ Insert automation_run (link to job)
    │
    ├─ Create sandbox (fresh, no resume)
    ├─ Insert job_attempt (epoch = 1)
    ├─ POST /sandbox/api/prompt { jobId, attemptId, epoch, prompt }
    │   └─ 202 Accepted
    │
    ├─ Update job: pending → accepted
    │
    └─ Return 200

    ... agent runs task ...

Sandbox calls POST /api/callbacks/prompt-complete
    │
    ├─ ingestCallback()
    ├─ Update job: → agent_completed
    ├─ Update job: → postprocess_pending
    │
    ├─ Post-processing:
    │   ├─ Check for git changes (diff in sandbox)
    │   ├─ Push branch if changes exist
    │   ├─ Create PR if allowPrCreate
    │   └─ Update automation_run (prUrl, summary)
    │
    ├─ Update job: → completed
    └─ Return 200
```

### Flow 4: HITL (Permission Request)

```
Agent hits a tool call requiring permission
    │
    ▼
Sandbox calls POST /api/callbacks { callbackType: "permission_requested" }
    { jobId, attemptId, epoch, callbackId, callbackType,
      payload: { permissionId, toolName, toolInput } }
    │
    ├─ Verify HMAC signature
    ├─ ingestCallback() — epoch fence + dedupe by callbackId
    │   (multiple permission_requested per attempt is valid — callbackId is unique per emission)
    ├─ CAS attempt status: running → waiting_human
    │   └─ Pause timeout clock (waiting_human has different timeout behavior)
    ├─ Append job_event (event_type: 'waiting_human')
    │
    └─ Return 200

UI polls events, sees permission_requested event
    │
    ▼
User clicks Approve
    │
    ▼
API route: POST /api/sessions/:id/permissions/:permId/reply
    │
    ├─ Verify session epoch (don't reply to stale sandbox)
    ├─ POST /permissions/:permId/reply { reply: "allow", epoch }
    │   └─ Sandbox delivers to agent, agent continues
    ├─ CAS attempt status: waiting_human → running
    │   └─ Resume timeout clock
    ├─ Append job_event (event_type: 'resumed')
    │
    └─ Return 200

Agent finishes → normal prompt-complete callback flow
```

### Flow 5: Sandbox Lifecycle (Idle → Snapshot → Restore)

```
Vercel Cron: every 5 minutes
    │
    ▼
API route: GET /api/cron/sandbox-lifecycle
    │
    ├─ Find sessions in 'idle' status where sandbox has been idle > N minutes
    │   (check runtime.updatedAt or last job.completedAt)
    │
    ├─ For each idle session:
    │   ├─ Update session: idle → snapshotting
    │   ├─ Call Vercel API: sandbox.snapshot()
    │   ├─ Insert checkpoint record (snapshotId, baseCommitSha)
    │   ├─ Update session: snapshotting → hibernated
    │   ├─ Update runtime: → stopped
    │   └─ Destroy sandbox
    │
    ├─ Find jobs stuck in 'accepted' or 'running' past timeout_at
    │   ├─ Update job: → failed_retryable (if attempts < max_attempts)
    │   ├─ Update job: → failed_terminal (if attempts >= max_attempts)
    │   └─ Update session: active → failed (with error message)
    │
    └─ Find orphaned sandboxes (no matching live runtime)
        └─ Destroy

Restore (triggered by prompt dispatch):
    │
    ├─ Get latest checkpoint for session
    ├─ Call Vercel API: sandbox.restore(snapshotId)
    ├─ Wait for health (GET /sandbox/health)
    ├─ Increment session.epoch
    ├─ Create new runtime (epoch = new epoch)
    ├─ Update session: hibernated → idle
    │
    └─ Ready for prompt dispatch
```

---

## Invariants

These are the rules that must always hold. If any are violated, something is broken.

### I1: One live sandbox per session

Enforced by `idx_one_live_runtime_per_session` (same unique partial index as v1). Before creating a new runtime, call `endStaleRuntimes(sessionId)`.

### I2: Epoch monotonically increases

`session.epoch` only goes up. Each new sandbox (create or restore) increments it. Callbacks from epoch < current are rejected. This prevents zombie sandboxes from corrupting state.

```typescript
async function incrementEpoch(sessionId: string): Promise<number> {
  const [row] = await db
    .update(interactiveSessions)
    .set({ epoch: sql`epoch + 1` })
    .where(eq(interactiveSessions.id, sessionId))
    .returning({ epoch: interactiveSessions.epoch });
  return row.epoch;
}
```

### I3: Callbacks are idempotent

`callback_inbox` has a unique constraint on `(job_id, attempt_id, epoch, callback_id)`. The `callback_id` is a sandbox-generated UUID unique per emission — this correctly handles multiple callbacks of the same type per attempt (e.g. multiple `permission_requested` events). Duplicate callbacks are silently ignored. The sandbox can retry safely.

### I4: Job request_id prevents duplicate dispatch

`jobs` has a unique constraint on `(session_id, request_id)`. The same prompt can't be dispatched twice for the same session. The API returns the existing job if the request_id already exists.

### I5: Agent result is stored before side effects

The transition `running → agent_completed` stores the raw result. The transition `agent_completed → postprocess_pending → completed` executes side effects. If side effects fail, the agent result is safe — only post-processing retries.

### I6: Review lock prevents concurrent reviews

`automation_sessions.reviewLockJobId` replaces the old `reviewLockRunId` + `reviewLockExpiresAt`. **No TTL** — lock is held while the referenced job is in a nonterminal status. The sweeper handles stuck jobs via `timeout_at`, which transitively releases the lock. Queue in `metadata.pendingReviewRequest`. Lock acquire + queue update + job creation happen in a single `db.transaction()` for atomicity.

### I7: Credential scrubbing before snapshot

Before any `sandbox.snapshot()` call, scrub credentials from the sandbox filesystem. Same pattern as v1 `interactive-session.ts` finally block.

### I8: At most one nonterminal prompt job per interactive session

Enforced by CAS: session must be `idle` to dispatch, transitions to `active` before sandbox call. The `request_id` unique constraint `(session_id, request_id)` prevents double-dispatch of the same request.

### I9: Snapshot/restore and prompt dispatch are mutually exclusive

Both require CAS from `idle`. Snapshot transitions `idle → snapshotting`. Prompt transitions `idle → active`. Only one CAS can win — they serialize naturally.

### I10: Every accepted attempt is bound to exactly one fencing token

Session-backed jobs use `epoch`. One-shot jobs (coding tasks) without interactive sessions use `attempt_id` as the fencing token. The callback handler verifies the token before accepting.

### I11: Side effects are idempotent per job

`jobs.side_effects_completed` (JSONB) tracks which side effects have been executed. Each post-processing step checks its key before executing (e.g. `comment_posted`, `check_completed`, `pr_created`). This prevents duplicate GitHub comments on retry.

### I12: Completion accepted only after event persistence is flushed

The sandbox proxy must not send `prompt_complete` until all agent events are durably persisted to Postgres. The callback handler reconstructs the full output from persisted events, not from the callback payload.

---

## Sweeper (Cron)

A single Vercel Cron job runs every 5 minutes and handles all background maintenance. It is a **sweeper**, not the primary execution engine — it catches things that fell through the cracks.

### Sweeper responsibilities

| Check | Action |
|-------|--------|
| Jobs past `timeout_at` in `accepted`/`running` | Mark `failed_retryable` or `failed_terminal` |
| Jobs in `failed_retryable` with attempts < max | Create new attempt, re-dispatch |
| Jobs in `postprocess_pending` for > 2 min | Retry post-processing |
| Attempts in `dispatch_unknown` | `GET /status` on sandbox proxy → reconcile to `accepted` or `failed` |
| Undelivered callbacks | `GET /outbox` on sandbox proxy → ingest pending callbacks |
| Sessions in `idle` for > N minutes | Snapshot and hibernate |
| Sessions in `active` with dead sandbox | Mark failed, clean up |
| Orphaned sandboxes (no live runtime) | Destroy |
| Stale review locks (referenced job is terminal) | Release lock, dispatch queued review if any |

### Sweeper locking

To prevent overlapping cron runs:

```typescript
// Use Postgres advisory lock
const SWEEPER_LOCK_ID = 42;

async function runSweeper() {
  const acquired = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SWEEPER_LOCK_ID})`
  );
  if (!acquired.rows[0].pg_try_advisory_lock) return; // Another sweep running

  try {
    await sweepTimedOutJobs();
    await sweepRetryableJobs();
    await sweepPostProcessing();
    await sweepDispatchUnknown();    // GET /status on sandbox → reconcile
    await sweepUndeliveredCallbacks(); // GET /outbox on sandbox → ingest
    await sweepIdleSessions();
    await sweepDeadSandboxes();      // Active sessions with dead sandbox
    await sweepOrphanedSandboxes();
    await sweepStaleReviewLocks();   // Release locks where job is terminal
  } finally {
    await db.execute(sql`SELECT pg_advisory_unlock(${SWEEPER_LOCK_ID})`);
  }
}
```

---

## Migration from v1 Tables

### What stays

| v1 Table | v2 Status | Notes |
|----------|-----------|-------|
| `interactive_sessions` | Keep, modify | Add `epoch`, drop `triggerRunId`, simplify statuses |
| `interactive_session_runtimes` | Keep, modify | Add `epoch`, drop `triggerRunId` |
| `interactive_session_checkpoints` | Keep as-is | Already good |
| `interactive_session_turns` | Keep, modify | Add `job_id` + `attempt_id` for correlation |
| `automations` | Keep as-is | No changes needed |
| `automation_sessions` | Keep, minor modify | Replace `reviewLockRunId` + `reviewLockExpiresAt` with `reviewLockJobId` (no TTL) |
| `automation_runs` | Keep, modify | Add `job_id` FK, drop `triggerRunId` |
| `event_deliveries` | Keep as-is | Dedupe pattern is solid |
| `secrets` | Keep as-is | |
| `sandbox_snapshots` | Keep as-is | |
| `sandbox_env_vars` | Keep as-is | |

### What's new

| v2 Table | Replaces | Purpose |
|----------|----------|---------|
| `jobs` | Trigger.dev runs | Coordination record for all async work |
| `job_attempts` | — | Per-attempt tracking with epoch fencing |
| `callback_inbox` | — | Idempotent callback ingestion |
| `job_events` | — | Append-only audit log for state transitions |

### What's removed

| Removed | Reason |
|---------|--------|
| `triggerRunId` on sessions/runtimes/runs | No more Trigger.dev |
| v1 session statuses: `warm`, `suspended` | Collapsed into `idle` |
| v1 session status: `hibernating` | Renamed to `snapshotting` |

---

## Relationship to Existing Patterns

### Patterns we keep

- **CAS for status transitions** — same `casSessionStatus()` pattern, just with fewer statuses
- **Turn handshake** — `createTurn` / `completeTurn` / `failTurn` unchanged, used by callback handler instead of task process
- **Review lock** — job-based CAS (no TTL), queue in metadata
- **Webhook dedupe** — `claimDelivery()` unchanged
- **One-live-runtime constraint** — same partial unique index
- **Credential resolution** — same `resolveSessionCredentials()`, called by API route instead of task

### Patterns that change

- **Dispatch tiers** — 5 tiers → 2 (sandbox alive / sandbox dead). No warm/suspended distinction.
- **Event persistence** — initially keep DB-write during execution (Option D). Sandbox persist driver writes to Postgres as before.
- **Health monitoring** — moves from in-process `SandboxHealthMonitor` to API-level health check before dispatch + callback timeout detection.
- **HITL dispatch** — Trigger.dev input streams → REST API calls to sandbox.

---

## Open Design Decisions

### D1: Should jobs use Vercel Queues instead of Postgres?

The oracle review recommended Vercel Queues for at-least-once delivery and retries. Trade-off:

- **Postgres jobs table:** We own the schema, can query/join/debug easily, no additional platform. But we build retry logic ourselves.
- **Vercel Queues:** Built-in retries, visibility timeouts, DLQ. But adds a dependency on a Vercel-specific feature, and the job state still needs to live in Postgres for queries/UI.

Recommendation: Start with Postgres. Add Vercel Queues later if retry complexity warrants it. The sweeper handles retries adequately for our current scale.

### D2: How does the sandbox authenticate callbacks? ✓ DECIDED

**HMAC-SHA256 per job.** API generates a random key stored in `jobs.hmac_key`, passes it to sandbox in `POST /prompt`. Sandbox signs every callback body with `HMAC-SHA256(JSON.stringify(body), key)` in the `X-Callback-Signature` header. See `v2-protocol-contract.md` §9 for details.

### D3: What about Vercel Queues for post-processing?

Post-processing (parse result → post GitHub comment → update check run) could be a separate queue consumer instead of running inline in the callback handler. This cleanly separates ingestion from side effects.

Worth considering after Phase 2 (coding tasks), when we have real data on post-processing failure rates.

### D4: Event streaming latency

v1 streams events through the task process to DB in real-time. v2 keeps this (Option D: sandbox persist driver writes to Postgres). If we later want lower latency:

- Option B: UI polls sandbox directly (via API proxy)
- Option C: SSE relay from sandbox

Defer until users complain about latency. Current polling at 2s is acceptable.
