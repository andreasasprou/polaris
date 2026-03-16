# Proposed Architecture v2: Sandbox-as-Authority

**Status:** Draft for review
**Date:** 2026-03-16
**Goal:** Simplify the platform from 4+ services to 2, eliminate the class of bugs caused by stateful connections across task suspension, and build a foundation that scales to new use cases.

---

## Table of Contents

1. [What's Wrong with the Current Architecture](#1-whats-wrong-with-the-current-architecture)
2. [The Core Insight](#2-the-core-insight)
3. [Proposed Stack](#3-proposed-stack)
4. [Architecture Overview](#4-architecture-overview)
5. [How Each Feature Works](#5-how-each-feature-works)
6. [What Replaces Trigger.dev](#6-what-replaces-triggerdev)
7. [Migration Path](#7-migration-path)
8. [Open Questions](#8-open-questions)
9. [Appendix: Alternatives Considered](#9-appendix-alternatives-considered)

---

## 1. What's Wrong with the Current Architecture

### The current stack

| Platform | Role |
|----------|------|
| Vercel | Next.js frontend + API routes |
| Vercel Sandbox | Isolated containers running AI agents |
| Trigger.dev | Task orchestration (interactive sessions, PR reviews, coding tasks) |
| Neon Postgres | Database |

### The problems

**A. Trigger.dev is the wrong primitive for interactive sessions.**

Interactive sessions need persistent connections to the sandbox agent server (ACP over HTTP). Trigger.dev's suspend/resume checkpoints the JS heap to disk, which kills all network connections. When the task resumes, sockets point at nothing. The code must manually reconnect everything — and we keep discovering things we forgot to reconnect.

The two-phase waiting pattern (2 min warm → 53 min suspend → hibernate) exists solely to work around this: keep the process alive for instant response, then suspend for cost savings, then snapshot for long-term storage. This single pattern accounts for ~400 lines of complex lifecycle code.

**B. Too many platforms.**

4 platforms = 4 billing dashboards, 4 sets of credentials, 4 failure modes, 4 monitoring systems. Each cross-platform interaction is a potential failure point (Trigger.dev calling Vercel Sandbox, Vercel Sandbox calling back via Trigger.dev streams, etc.).

**C. The orchestrator owns state it shouldn't.**

The Trigger.dev task owns the ACP connection, streams events through itself to the DB, manages the sandbox heartbeat, handles HITL dispatch via input streams, and tracks session status. If the task dies, all of this state is lost or becomes stale. The DB reconciliation logic (session GET API healing stale records against Trigger.dev run status) exists because the source of truth is split across two systems.

---

## 2. The Core Insight

**The sandbox is already the long-lived stateful thing.** It runs for minutes to hours. It has a filesystem. It runs the agent server process. It persists agent session state on disk (e.g., Claude Code's session JSONLs).

The orchestrator (Trigger.dev task) is trying to be a long-lived stateful thing too — maintaining connections, streaming events, managing lifecycle. But it's running on infrastructure designed for batch jobs that checkpoint and resume.

**Fix: make the sandbox the authority for session state, and make the orchestrator stateless.**

Each prompt becomes a simple HTTP request to the sandbox. No persistent connections. No suspend/resume. No two-phase waiting. The orchestrator just dispatches work and reads results.

---

## 3. Proposed Stack

```
┌─────────────────────────────────────┐
│  Vercel                             │
│  ├── Next.js (frontend + API)       │
│  ├── Vercel Functions (webhooks,    │
│  │    prompt dispatch, callbacks)   │
│  ├── Vercel Cron (retry sweep,      │
│  │    sandbox cleanup)              │
│  └── Vercel Sandbox (agents +       │
│       session management)           │
└──────────────┬──────────────────────┘
               │
       ┌───────┴───────┐
       │  Neon Postgres │
       │  (state, jobs, │
       │   events)      │
       └───────────────┘
```

**Two platforms.** Vercel (frontend, API, compute, sandboxes) + Neon Postgres (state, job queue). Vercel Postgres is Neon under the hood, so these are tightly integrated.

---

## 4. Architecture Overview

### Current: Orchestrator-as-Authority

```
UI ──poll──→ DB ←──write── Trigger.dev task ←──ACP──→ Sandbox:2468
                           (long-lived, stateful,     (agent server,
                            owns connection,            thin relay)
                            manages lifecycle)
```

### Proposed: Sandbox-as-Authority

```
UI ──poll──→ DB ←──sync── Sandbox:2468
     │                    (agent server,
     │                     session manager,
     └──prompt──→ API ──→  event persistence)
                  route    ↑
                  (thin,   │ callback on
                   stateless) completion
```

### Key architectural shifts

| Concern | Current (v1) | Proposed (v2) |
|---------|-------------|---------------|
| Session state authority | Trigger.dev task (in-memory) | Sandbox (filesystem + local DB) |
| Event persistence | Task streams events → DB via persist driver | Sandbox persists locally → syncs to Postgres |
| HITL dispatch | Trigger.dev input streams (.on/.once/.wait) | REST API on sandbox (POST /permissions/:id/reply) |
| Prompt delivery | Input stream message to long-lived task | HTTP POST to sandbox API |
| Idle cost management | Two-phase warm/suspend + hibernate | Sandbox timeout extension + snapshot on idle |
| Health monitoring | SandboxHealthMonitor in task process | Self-monitoring in sandbox + API-level health checks |
| Connection management | Persistent ACP client in task, breaks on suspend | Per-request HTTP to sandbox, no persistent connection |

---

## 5. How Each Feature Works

### 5.1 Interactive Sessions (Human Chatting)

**Current flow:**
1. User sends prompt → API route → dispatches to Trigger.dev task
2. Task maintains ACP connection to sandbox, sends prompt, streams events
3. Events flow: sandbox → ACP → task → streams.writer → DB → UI polls DB
4. Between prompts: warm wait (2 min) → suspend (53 min) → hibernate
5. On resume: restore checkpoint, reconnect ACP (buggy), resend prompt

**Proposed flow:**
1. User sends prompt → API route → `POST /api/prompt` to sandbox directly
2. Sandbox runs agent, persists events to local storage
3. Sandbox calls back to `POST /api/sessions/:id/turn-complete` when done
4. UI polls `GET /api/sessions/:id/events?since=cursor` (proxied to sandbox or read from DB)
5. Between prompts: sandbox sits idle (no process to manage, just a container)
6. On resume: if sandbox alive, POST prompt directly. If dead, restore from snapshot.

**What changes:**
- No Trigger.dev task for interactive sessions
- No ACP connection management
- No two-phase waiting
- Sandbox lifecycle managed by API layer (extend timeout on activity, snapshot on idle via cron)

**HITL (permissions, questions):**

When the agent requests permission:
1. Sandbox persists a `permission_requested` event to local storage
2. Event syncs to Postgres (immediate push or next poll cycle)
3. UI renders permission dialog
4. User approves/denies → `POST /api/sessions/:id/permissions/:permId/reply`
5. API route forwards to sandbox → `POST /sandbox/permissions/:permId/reply`
6. Sandbox delivers reply to running agent process

No input streams. No persistent connection. Just REST calls.

**Real-time event delivery:**

Three options (in order of simplicity):

| Option | Latency | Complexity |
|--------|---------|------------|
| **A. Poll DB** (current) | 1-2s (poll interval) | Lowest — already works |
| **B. Poll sandbox directly** | ~200ms (via API proxy) | Low — proxy route, sandbox serves from local storage |
| **C. SSE relay** | Real-time | Medium — stateless proxy holds open connection to sandbox SSE endpoint |

Recommendation: Start with **Option A** (no change to UI). Upgrade to B or C later if latency matters.

### 5.2 PR Review Automation

**Current flow:**
1. GitHub webhook → API route → Trigger.dev `continuous-pr-review` task
2. Task resolves review scope, builds prompt, acquires concurrency lock
3. Task dispatches prompt to interactive session (another Trigger.dev task)
4. Interactive session task manages sandbox, ACP connection, streams events
5. Parent task waits for turn completion, parses output, posts GitHub comment

**Proposed flow:**
1. GitHub webhook → API route → insert job into `review_jobs` Postgres table
2. API route creates/finds sandbox for this PR's automation session
3. API route POSTs review prompt to sandbox
4. Returns 200 to GitHub immediately
5. Sandbox runs agent, completes review
6. Sandbox calls back: `POST /api/reviews/:jobId/complete` with result
7. Callback handler: parses output, posts GitHub comment, updates check run
8. If sandbox dies without callback: Vercel Cron sweep retries after 5 min

**What changes:**
- `continuous-pr-review` Trigger.dev task → API route + callback handler
- `interactive-session` Trigger.dev task → sandbox handles everything
- Concurrency lock stays in Postgres (same as today)
- Review scope determination stays the same (full vs incremental)
- Output parsing stays the same

**Concurrency and queueing:**
- One sandbox per automation session (one per PR)
- If a review is already running (sandbox busy), queue the request in Postgres
- When the current review completes and calls back, check for queued requests
- This replaces Trigger.dev's `reviewLockRunId` pattern with a simpler Postgres-based queue

### 5.3 Coding Tasks (One-Shot Automations)

**Current flow:**
1. Event trigger → Trigger.dev `coding-task` task
2. Task provisions sandbox, runs agent, collects results
3. If changes detected, dispatches `create-pr` task

**Proposed flow:**
1. Event trigger → API route → insert into `coding_jobs` table
2. API route provisions sandbox, POSTs prompt
3. Sandbox runs agent, calls back with result
4. Callback handler: checks for changes, creates PR if needed
5. Cron sweep handles failures/timeouts

**Note:** Coding tasks are the simplest case. They're already close to stateless — no HITL, no multi-turn, no resume. The main change is removing the Trigger.dev wrapper.

### 5.4 Sandbox Lifecycle

**Current:** Managed by the Trigger.dev task (create, heartbeat, health monitor, snapshot, destroy).

**Proposed:** Managed by the API layer + sandbox self-management.

| Concern | How it works |
|---------|-------------|
| **Creation** | API route calls Vercel Sandbox API (same as today) |
| **Keep-alive** | Sandbox self-extends its timeout while an agent is running. API layer extends on each prompt dispatch. |
| **Health** | Sandbox agent server has `/health` endpoint. API layer checks before dispatching prompts. Cron sweep detects dead sandboxes. |
| **Idle timeout** | Cron job checks for sandboxes with no activity for N minutes. Triggers snapshot + destroy. |
| **Snapshot (hibernate)** | API route or cron calls `sandbox.snapshot()`, stores checkpoint in DB, destroys sandbox. |
| **Restore (resume)** | On next prompt, API route restores from snapshot, waits for health, dispatches prompt. |
| **Cleanup** | Cron sweep destroys orphaned sandboxes (no matching active session). |

### 5.5 Session Resume

The resume tiers simplify significantly:

| Current | Proposed |
|---------|----------|
| **Hot:** Send via input stream (instant) | **Sandbox alive:** POST prompt to sandbox API |
| **Warm:** Send via input stream (2 min window) | (same as above — no distinction needed) |
| **Suspended:** Trigger new task, text replay | (same as above — sandbox is still alive) |
| **Hibernated:** Restore snapshot, new task, replay | **Sandbox dead:** Restore from snapshot, POST prompt |
| **Cold:** Full restart | **No snapshot:** Create fresh sandbox, POST prompt |

Two tiers instead of five:
1. **Sandbox alive** → POST prompt directly
2. **Sandbox dead** → Restore or create sandbox, then POST prompt

The API route just checks: is the sandbox healthy? If yes, send. If no, restore/create and send.

### 5.6 Agent Support

No changes to the agent profile system. `resolveAgentConfig()` still maps semantic intents to agent-native modes/models/effort levels. The resolved config is passed to the sandbox when creating/resuming the agent session.

The sandbox agent server already understands agent types, modes, models — it runs the CLI binaries directly. The only change is that the server now exposes a REST API for prompt dispatch instead of receiving prompts over ACP from the Trigger.dev task.

### 5.7 GitHub Integration

Minimal changes:

| Concern | Change |
|---------|--------|
| Webhook handling | Stays in API route (already there) |
| Token minting | Stays in API layer |
| Token injection | Still via `networkPolicy` on sandbox |
| Token refresh | API layer refreshes before each prompt dispatch (tokens last 1 hour, prompts are shorter) |
| PR creation | API route calls GitHub API directly (no `create-pr` Trigger.dev task) |

### 5.8 Onboarding

No changes. The onboarding wizard is purely frontend + API routes. It doesn't interact with Trigger.dev.

---

## 6. What Replaces Trigger.dev

| Trigger.dev feature | Replacement | Notes |
|---------------------|-------------|-------|
| Task execution | Sandbox does the work | Long-running compute moves to sandbox |
| Task dispatch | API routes + Postgres job table | Insert row, POST to sandbox |
| Retries | Cron sweep + job state machine | Check for stale/failed jobs every 5 min |
| Max duration | Sandbox timeout + cron sweep | Sandbox auto-destroys on timeout; cron marks jobs failed |
| Input streams (HITL) | REST API on sandbox | POST to sandbox's permission/question endpoints |
| Suspend/resume | Eliminated | Sandbox is always-on or snapshot-restored |
| Run traces | Structured logging to Postgres | Log key events (prompt sent, completed, error) to a `job_events` table |
| Metadata/tags | Postgres columns | Already have most of these |
| Webhook handling | API routes | Already handled by Next.js routes |
| Scheduling | Vercel Cron | Simple cron expressions |
| Concurrency control | Postgres advisory locks or row-level locks | Same pattern as current `reviewLockRunId` |

### Job state machine (replaces Trigger.dev run lifecycle)

```
pending → dispatched → running → completed
                    ↘ failed → (retry?) → pending
                    ↘ timed_out → (retry?) → pending
```

Tracked in a `jobs` table:

```sql
CREATE TABLE jobs (
  id UUID PRIMARY KEY,
  type TEXT NOT NULL,          -- 'review', 'coding_task', 'prompt'
  status TEXT NOT NULL,        -- 'pending', 'dispatched', 'running', 'completed', 'failed'
  session_id UUID,
  sandbox_id TEXT,
  payload JSONB,
  result JSONB,
  attempts INT DEFAULT 0,
  max_attempts INT DEFAULT 3,
  created_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ,
  timeout_at TIMESTAMPTZ       -- cron sweep marks as failed if past this
);
```

The cron sweep query:
```sql
UPDATE jobs SET status = 'failed', updated_at = NOW()
WHERE status IN ('dispatched', 'running')
  AND timeout_at < NOW();
```

---

## 7. Migration Path

### Phase 1: Sandbox REST API (no user-facing changes)

Extend the sandbox-agent server to expose REST endpoints alongside the existing ACP protocol:

- `POST /api/sessions/:id/prompt` — send prompt, return when complete
- `GET /api/sessions/:id/events` — poll for events since cursor
- `POST /api/sessions/:id/permissions/:id/reply` — HITL reply
- `POST /api/sessions/:id/questions/:id/reply` — HITL reply
- `GET /api/sessions/:id/status` — session state + health
- `POST /api/sessions/:id/stop` — cancel running prompt

The ACP protocol continues to work alongside these. No breaking changes.

**Verification:** Deploy sandbox-agent with REST API. Call endpoints manually from a test script. Confirm prompt execution, event retrieval, and HITL work over REST.

### Phase 2: Interactive sessions via REST (behind feature flag)

Build a new prompt dispatch path in the API layer:

1. New API route: `POST /api/v2/sessions/:id/prompt` that POSTs directly to sandbox instead of dispatching via Trigger.dev
2. Feature flag: `USE_DIRECT_DISPATCH=true` enables the new path
3. Run both paths in parallel — Trigger.dev path as fallback

**Verification:** Create interactive sessions with the new path. Verify: prompt execution, event streaming, HITL, sandbox timeout management, snapshot/restore. Compare behavior with Trigger.dev path.

### Phase 3: PR review automation via REST

Rewrite `continuous-pr-review` as an API route + callback pattern:

1. Webhook handler inserts job, dispatches to sandbox
2. Sandbox calls back on completion
3. Callback handler posts GitHub comment
4. Cron sweep handles failures

**Verification:** Push to a PR, verify review runs end-to-end without Trigger.dev in the path.

### Phase 4: Remove Trigger.dev

1. Delete `trigger/` directory
2. Remove `@trigger.dev/sdk`, `trigger.dev` from `package.json`
3. Remove Trigger.dev environment variables
4. Update monitoring/alerting
5. Cancel Trigger.dev subscription

### Phase 5: Simplify session lifecycle

With Trigger.dev removed, clean up the session status model:

| v1 status | v2 equivalent |
|-----------|---------------|
| creating | creating (sandbox provisioning) |
| active | active (prompt running) |
| warm | idle (sandbox alive, no prompt running) |
| suspended | idle (same — no distinction needed) |
| hibernating | snapshotting |
| hibernated | hibernated (sandbox destroyed, snapshot saved) |
| stopped | stopped |
| failed | failed |
| completed | completed |

Warm, suspended → **idle**. One status instead of three for "sandbox alive, waiting for input."

---

## 8. Open Questions

### 8.1 Event sync: push or pull?

When the sandbox persists events locally, how do they get to Postgres for the UI?

- **Option A: Sandbox pushes to API** — After each event, sandbox POSTs to `/api/sessions/:id/events/sync`. Simple but adds network calls during prompt execution.
- **Option B: Batch sync on turn complete** — Sandbox sends all events when prompt finishes. Lower overhead but UI doesn't see events until turn completes (breaks real-time streaming).
- **Option C: UI polls sandbox directly** — API route proxies `GET /events` to sandbox. Events don't need to be in Postgres for real-time display. Persist to Postgres on turn complete for durability.
- **Option D: Keep current DB-write pattern** — Sandbox uses the existing persist driver to write events to Postgres during execution. UI polls Postgres as today. No change to event flow.

Recommendation: **Start with Option D** (zero change to event flow), then consider C for lower latency later.

### 8.2 Sandbox self-timeout vs external management

Should the sandbox manage its own idle timeout (self-snapshot after N minutes of no activity), or should an external cron job manage it?

- **Self-management:** Simpler, but requires the sandbox agent server to know how to snapshot itself (calling Vercel Sandbox API from inside the sandbox).
- **External management:** Cron job checks last activity timestamp in DB, calls Vercel API to snapshot. Sandbox doesn't need to know about its own lifecycle.

Recommendation: **External management** — the sandbox shouldn't need Vercel API credentials or self-awareness of its lifecycle.

### 8.3 Callback reliability

When the sandbox calls back to the API on prompt completion, what if the callback fails (API route down, network error)?

- The sandbox should retry the callback with exponential backoff (3 attempts)
- If all retries fail, the sandbox persists the result locally
- Cron sweep detects sandboxes with completed-but-unacknowledged results and fetches them

### 8.4 Sandbox agent server scope

How much do we need to change in the sandbox-agent npm package (v0.3.2)?

- If we control the package: add REST endpoints directly
- If we don't: run a thin HTTP server alongside the agent server inside the sandbox (same port or different port), proxying to ACP internally

Need to assess: do we contribute upstream to sandbox-agent, or wrap it?

### 8.5 Long-running prompt timeouts

Currently, `executePrompt` has a 1200s (20 min) timeout enforced by the Trigger.dev task. In the new architecture:

- The API route that dispatches the prompt returns immediately (fire-and-forget with callback)
- The sandbox enforces its own timeout on the agent CLI process
- Vercel Sandbox has its own max lifetime (configurable)
- The cron sweep catches any sandbox that exceeds expected runtime

### 8.6 Observability gap

Trigger.dev provides run traces, live logs, and a dashboard for inspecting task execution. Losing this means we need:

- A `job_events` table logging key lifecycle events (dispatched, started, completed, failed, retried)
- A simple admin UI showing job history (or rely on Vercel Logs + Postgres queries initially)
- Structured logging with correlation IDs (session ID, job ID) for debugging

This is a real cost of the migration. The question is whether the reduced platform complexity outweighs the observability regression.

---

## 9. Appendix: Alternatives Considered

### Cloudflare Durable Objects

**What:** Stateful JavaScript actors with WebSocket hibernation. One DO per session accepts WebSocket from UI, makes per-prompt fetch() to sandbox.

**Verdict:** Strong primitive for real-time UI, but adds a third platform (Cloudflare). The per-prompt fetch() pattern is exactly what we'd do with API routes anyway. DOs solve the "real-time push to UI" problem elegantly, but polling with 1-2s latency is acceptable for now.

**When to reconsider:** If real-time event streaming becomes critical (e.g., users complain about latency, or we need collaborative features).

### Vercel Workflow (useworkflow.dev)

**What:** Durable workflow engine using JS directives for step-level checkpointing.

**Verdict:** Doesn't solve the core problem. Durability is between steps, not within them. Our `executePrompt()` is a single long-running call — the connection problem lives inside one step. Also in beta.

**When to reconsider:** If it reaches GA and we find we need durable multi-step workflows (e.g., complex multi-agent orchestration with human approvals at each stage).

### Keep Trigger.dev but fix the reconnection

**What:** Add `reconnectAfterSuspend()` to the interactive-session task that re-establishes the ACP connection after every suspend/resume.

**Verdict:** Patches this bug but doesn't address the architectural smell. Every new stateful resource added to the task will need its own reconnection logic. The two-phase waiting pattern remains complex. We keep paying for Trigger.dev infrastructure.

**When to reconsider:** If migration timeline is too long and we need a quick fix for production stability.

### Stateless Trigger.dev tasks (one per prompt)

**What:** Keep Trigger.dev but make each prompt a separate short-lived task. Sandbox lifecycle managed separately.

**Verdict:** Solves the connection problem but keeps Trigger.dev in the stack for what becomes a very thin dispatch layer. If the task is just "POST prompt to sandbox, wait for result, update DB," an API route does the same thing without the overhead.

**When to reconsider:** If we find we need Trigger.dev's retry/queue semantics for prompt dispatch specifically.
