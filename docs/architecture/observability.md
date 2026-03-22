# Polaris — Observability Architecture

## Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Vercel Serverless  (Next.js)                                   │
│                                                                  │
│  app/api/**  →  withEvlog  →  useLogger()  →  log.set({...})   │
│                        │                                         │
│                        └──→ stdout (JSON wide events)           │
│                                │                                 │
│                                ▼                                 │
│                        Vercel Log Drain  →  Axiom `vercel`      │
│                                                                  │
│  lib/orchestration/                                              │
│    prompt-dispatch.ts  →  log.set({ dispatch.* })               │
│    callback-processor.ts → log.set({ callback.*, metrics.* })   │
│    sandbox-lifecycle.ts  → log.set({ lifecycle.* })             │
│    sweeper.ts           → log.set({ sweep.* })                  │
│    postprocess.ts       → log.set({ postprocess.* })            │
│                                                                  │
│  lib/jobs/                                                       │
│    jobEvents table       →  append-only state audit log         │
│                                                                  │
│  lib/metrics/                                                    │
│    step-timer.ts         →  StepMetrics on automationRuns       │
│                                                                  │
│  sandbox_agent.events    →  Postgres (persist-postgres driver)  │
│    ACP JSON-RPC events from agent execution                     │
│    Queried via GET /api/sessions/:id/events                     │
└──────────────────────────┬──────────────────────────────────────┘
                           │
         HTTPS POST /prompt (port 2469)
                           │
┌──────────────────────────▼──────────────────────────────────────┐
│  Vercel Sandbox VM  (ephemeral, 1-hour timeout)                  │
│                                                                  │
│  REST Proxy :2469  (lib/sandbox-proxy/, bundled)                │
│    Structured JSON logs → stdout (visible via followProcessLogs) │
│    Proxy metrics → embedded in prompt_complete/prompt_failed     │
│    callback payloads (piggybacks on existing HMAC delivery)     │
│                                                                  │
│  sandbox-agent :2468  (ACP JSON-RPC server)                     │
│    Events persisted via SDK persist driver → Postgres           │
│                                                                  │
│  Agent CLI (claude / codex)                                      │
│    Token usage via usage_update events                           │
│    Tool calls, text chunks, permissions via ACP events          │
└─────────────────────────────────────────────────────────────────┘
```

## Data Sources

| Source | Location | What it captures | Queryable via |
|--------|----------|-----------------|---------------|
| **evlog wide events** | All API routes via `withEvlog` | Request lifecycle, timing, errors, structured context | Axiom `vercel` dataset |
| **jobEvents table** | `lib/jobs/schema.ts` | State machine transitions: created → accepted → running → completed/failed | Postgres, `GET /api/jobs/:id` |
| **sandbox_agent.events** | Postgres via persist-postgres | ACP JSON-RPC events: tool calls, text, permissions, questions, usage | `GET /api/sessions/:id/events` |
| **StepMetrics** | `lib/metrics/step-timer.ts` | Per-step timing for automation pipelines | `automationRuns.metrics` JSONB |
| **Proxy metrics** | Embedded in callback payloads | Sandbox-internal timing: connect, session create, prompt execution, resume type | Axiom (logged by callback-processor), `jobAttempts.resultPayload` |
| **Proxy structured logs** | stdout inside sandbox VM | Request handling, callback delivery, health checks, resume decisions | `followProcessLogs()` API (future) |

## Gap Matrix

| Component | Observable? | What's visible | What's dark |
|-----------|------------|----------------|-------------|
| API routes | **Yes** | Request timing, status, structured context via evlog → Axiom | — |
| Webhook routing | **Yes** | Delivery dedup, automation matching, dispatch decisions | — |
| Sweeper | **Yes** | Timeout counts, reconciliation, lock releases | — |
| Prompt dispatch | **Yes** | Tier 1/2 decision, credential resolution, sandbox health, job/attempt creation | — |
| Callback processing | **Yes** | Epoch fence, dedup, CAS transitions, proxy metrics extraction | — |
| Sandbox provisioning | **Yes** | Cold vs snapshot, timing per step (StepTimer) | — |
| **Sandbox proxy** | **Partial** | Metrics in callback payloads; structured logs to VM stdout | Logs not shipped to Axiom (future: followProcessLogs) |
| **Agent execution** | **Partial** | ACP events persisted to Postgres; token usage in events | No real-time streaming to external systems |
| **Callback delivery** | **Partial** | Delivery metrics in callback payloads | File-based outbox lost if VM dies before delivery |
| Resource usage | **No** | — | CPU, memory, disk of sandbox unmeasured |

## Sweeper Cron

The sweeper runs every 2 minutes via Vercel Cron, configured in `vercel.ts`:

```typescript
// vercel.ts
crons: [{ path: "/api/cron/sweeper", schedule: "*/2 * * * *" }]
```

Each cycle runs (in order):
1. **Runtime controller** — expire overdue claims, destroy/hibernate orphaned sandboxes, enforce hard TTLs
2. **Provider janitor** — list Vercel sandboxes, stop any without a DB runtime record
3. **Job sweeps** — timeout, stale-progress detection (dead sandbox recovery), dispatch_unknown reconciliation, postprocess retry, stale session healing, stale lock release, retryable job processing

The route at `app/api/cron/sweeper/route.ts` is protected by `CRON_SECRET` in production.

## Instrumentation Standards

### Wide Event Field Naming

All `log.set()` calls should use namespaced keys to avoid collision:

```typescript
// Dispatch path
log.set({ dispatch: { tier: 1, sandboxAlive: true, requestId, sessionId, jobId } });

// Callback path
log.set({ callback: { jobId, attemptId, callbackType, epoch, accepted: true } });

// Proxy metrics (extracted from callback payload)
log.set({ proxyMetrics: { connectMs, sessionCreateMs, promptExecutionMs, resumeType } });

// Lifecycle
log.set({ lifecycle: { phase: "provisioning", restoreSource: "snapshot" } });

// Sweeper
log.set({ sweep: { timedOut: 3, staleKilled: 1, unknownReconciled: 1 } });

// Timing (StepTimer)
log.set({ timing: timer.finalize() });
```

### Correlation IDs

Every wide event on the prompt critical path should include:
- `sessionId` — the interactive session
- `jobId` — the job coordinating this prompt
- `attemptId` — the specific attempt
- `epoch` — sandbox generation (for filtering stale callbacks)
- `requestId` — original user request (end-to-end trace key)

### Proxy Structured Log Format

The sandbox proxy emits JSON to stdout:

```json
{
  "ts": "2025-03-20T10:30:00.000Z",
  "level": "info",
  "component": "proxy",
  "jobId": "job_abc",
  "attemptId": "att_xyz",
  "epoch": 3,
  "msg": "prompt_accepted",
  "durationMs": 120
}
```

## Sandbox Lifecycle Observability

The runtime controller and provider janitor emit structured metrics every sweeper cycle (2 min).
These flow to Axiom via evlog and power the **Sandbox Lifecycle** dashboard + monitors.

### Data emitted per sweep cycle

```typescript
// Runtime controller (lib/compute/controller.ts)
log.set({ sandbox_gauge: { liveRuntimes, maxAgeMs, over1h } });
log.set({ controller: { expiredClaims, destroyedOrphans, hibernatedOrphans, destroyedTtlExceeded } });

// Provider janitor (lib/compute/provider-janitor.ts)
log.set({ sweep: { providerJanitor: { vercelRunning, unknownStopped, withinGrace, errors } } });
```

### Dashboard: `polaris-sandbox-lifecycle`

Created via IaC: `scripts/axiom-sandbox-observability.sh`

| Panel | What it shows |
|-------|--------------|
| **Live Now** (stat) | Current running sandbox count. Warns >10, errors >20. |
| **Over 1h** (stat) | Sandboxes running longer than 1 hour. Any >0 is a warning. |
| **Live Sandboxes** (time series) | Sandbox count over time. |
| **Max Sandbox Age** (time series) | Oldest sandbox age in minutes. |
| **Controller Actions** (bar chart) | Destroyed orphans, hibernated, TTL exceeded, expired claims per cycle. |
| **Provider Janitor** (bar chart) | Vercel running total, unknowns stopped, errors per cycle. |
| **Sweeper Health** (bar chart) | Timed-out jobs, stale sessions healed, retried jobs, locks released. |
| **Active Alerts** (monitor list) | All firing monitors. |

### Monitors

| Monitor | Condition | Severity |
|---------|-----------|----------|
| Long-running sandboxes | `sandbox_gauge.over1h > 0` sustained 20min | Warning |
| High sandbox count | `sandbox_gauge.liveRuntimes > 20` sustained 20min | Warning |
| Janitor killing unknowns | `providerJanitor.unknownStopped > 0` | Info |
| Controller orphan spike | `runtimeController.destroyedOrphans > 3` | Warning |
| Sandbox exceeded 8h | `sandbox_gauge.maxAgeMs > 28800000` | Critical |

### Setup

```bash
AXIOM_TOKEN=xaat-xxx ./scripts/axiom-sandbox-observability.sh
# Optionally attach to a notifier (Slack, email):
AXIOM_TOKEN=xaat-xxx AXIOM_NOTIFIER_ID=not_xxx ./scripts/axiom-sandbox-observability.sh
```

## Axiom Query Cookbook

### Find a failed session's lifecycle

```apl
['vercel']
| where ['request.path'] contains "interactive-sessions"
  or ['request.path'] == "/api/callbacks"
| where message contains "SESSION_ID_HERE"
| sort by _time asc
```

### Trace a single prompt end-to-end by requestId

```apl
['vercel']
| where message contains "REQUEST_ID_HERE"
| sort by _time asc
```

### Find slow sandbox provisions

```apl
['vercel']
| where message contains "timing"
  and message contains "ensureSandboxReady"
| sort by _time desc
| take 20
```

### Find callback processing errors

```apl
['vercel']
| where ['request.path'] == "/api/callbacks"
  and ['request.statusCode'] >= 500
| sort by _time desc
```

### Find proxy metrics for a job

```apl
['vercel']
| where message contains "proxyMetrics"
  and message contains "JOB_ID_HERE"
```

### Sandbox gauge over time (live count + max age)

```apl
['vercel']
| where ['request.path'] == "/api/cron/sweeper"
| extend p = parse_json(message)
| where isnotnull(p.sandbox_gauge)
| project _time,
    live = toint(p.sandbox_gauge.liveRuntimes),
    maxAgeMin = todouble(p.sandbox_gauge.maxAgeMs) / 60000
| sort by _time desc
```

### Controller actions (orphans destroyed, claims expired)

```apl
['vercel']
| where ['request.path'] == "/api/cron/sweeper"
| extend p = parse_json(message)
| where isnotnull(p.sweep.runtimeController)
| project _time,
    orphans = toint(p.sweep.runtimeController.destroyedOrphans),
    hibernated = toint(p.sweep.runtimeController.hibernatedOrphans),
    ttl = toint(p.sweep.runtimeController.destroyedTtlExceeded),
    expired = toint(p.sweep.runtimeController.expiredClaims)
| where orphans > 0 or hibernated > 0 or ttl > 0 or expired > 0
```

### Stale-progress job kills (dead sandbox recovery)

```apl
['vercel']
| where ['request.path'] == "/api/cron/sweeper"
| extend p = parse_json(message)
| where toint(p.sweep.staleKilled) > 0
| project _time,
    staleKilled = toint(p.sweep.staleKilled),
    timedOut = toint(p.sweep.timedOut)
```

Jobs killed because their sandbox died and no progress was reported for 5+ minutes. Non-zero values indicate lost `prompt_complete` callbacks that were recovered before the 30-minute hard timeout.

### Provider janitor — unknown sandboxes stopped

```apl
['vercel']
| where ['request.path'] == "/api/cron/sweeper"
| extend p = parse_json(message)
| where toint(p.sweep.providerJanitor.unknownStopped) > 0
| project _time,
    vercelRunning = toint(p.sweep.providerJanitor.vercelRunning),
    unknownStopped = toint(p.sweep.providerJanitor.unknownStopped)
```
