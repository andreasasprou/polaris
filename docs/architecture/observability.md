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
log.set({ sweep: { timedOut: 3, unknownReconciled: 1 } });

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
