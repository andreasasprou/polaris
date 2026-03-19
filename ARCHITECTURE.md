# Polaris — Architecture

Polaris is an autonomous coding-agent orchestration platform.
It is a monolithic Next.js 15 application deployed on Vercel.
Coding agents (Claude Code, Codex) execute inside ephemeral Vercel Sandbox VMs;
the platform communicates with them exclusively over REST (no WebSockets, no
Trigger.dev task queues). Postgres (via Drizzle ORM) is the single source of
truth; contested state transitions use compare-and-set (CAS) operations.
The v2 architecture replaces Trigger.dev with a `jobs` table, a cron-driven
sweeper, and an in-sandbox REST proxy that manages the agent lifecycle and
delivers HMAC-signed callbacks back to the Polaris API.

---

## System Topology

```
┌─────────────────────────────────────────────────────────┐
│  Vercel Serverless  (Next.js App Router)                │
│                                                         │
│  app/api/interactive-sessions/[id]/prompt  (user msg)   │
│  app/api/webhooks/github                  (webhook in)  │
│  app/api/callbacks                        (sandbox→API) │
│  app/api/cron/sweeper                     (every 2 min) │
│                                                         │
│  lib/orchestration/prompt-dispatch.ts → POST /prompt ────┤──┐
│  lib/routing/trigger-router.ts       → routeGitHubEvent │  │
│  lib/orchestration/pr-review.ts      → dispatchPrReview │  │
│  lib/orchestration/coding-task.ts    → dispatchCodingTask│  │
│  lib/orchestration/sweeper.ts        → runSweep         │  │
├─────────────────────────────────────────────────────────┤  │
│  PostgreSQL  (Drizzle ORM)                              │  │
│  jobs, job_attempts, callback_inbox, job_events,        │  │
│  interactive_sessions, interactive_session_runtimes,    │  │
│  automations, automation_sessions, automation_runs,     │  │
│  event_deliveries, secrets, repositories ...            │  │
└─────────────────────────────────────────────────────────┘  │
                                                             │
         HTTPS POST /prompt (port 2469)                      │
         ◄───────────────────────────────────────────────────┘
                                                             │
┌────────────────────────────────────────────────────────────▼┐
│  Vercel Sandbox VM  (ephemeral, 1-hour timeout)             │
│                                                             │
│  ┌──────────────────────────┐  ┌──────────────────────────┐ │
│  │  REST Proxy  :2469       │  │  sandbox-agent  :2468    │ │
│  │  lib/sandbox-proxy/      │  │  (ACP JSON-RPC server)   │ │
│  │  server.ts               │──│  manages agent sessions  │ │
│  │  callback-delivery.ts    │  │  via AcpHttpClient        │ │
│  │  outbox.ts (file-based)  │  └────────────┬─────────────┘ │
│  └──────────────────────────┘               │               │
│                                    ┌────────▼────────┐      │
│                                    │  Agent CLI       │      │
│                                    │  claude / codex  │      │
│                                    └─────────────────┘      │
│  /vercel/sandbox  (cloned repo, networkPolicy for git auth) │
└─────────────────────────────────────────────────────────────┘
                         │
                         ▼
                ┌─────────────────┐
                │  GitHub          │
                │  (git push, PR, │
                │   checks, comments)
                └─────────────────┘
```

---

## Request Lifecycle

### Flow A — User sends a message (interactive session)

1. **`app/api/interactive-sessions/[sessionId]/prompt/route.ts`** — POST handler.
   Authenticates via `lib/auth/session.ts`, validates prompt, generates `requestId`.
2. **`lib/orchestration/prompt-dispatch.ts` → `dispatchPromptToSession()`** — entry point.
   - Loads session via `getInteractiveSessionForOrg()`.
   - Guards against double-dispatch (`getActiveJobForSession()`).
   - Heals stale active state (active + no live job → CAS to idle).
   - CAS `[creating|idle|hibernated|stopped|failed]` → `active`.
   - Resolves agent API key + repo via `resolveSessionCredentials()`.
3. **Tier 1 / Tier 2 sandbox check** — `probeSandboxHealth()` pings `GET /health` on
   the existing proxy URL. If dead or missing:
   - **`lib/orchestration/sandbox-lifecycle.ts` → `ensureSandboxReady()`** — provisions a
     Vercel Sandbox (from snapshot or cold git clone via `SandboxManager`), increments
     session epoch, ends stale runtimes, creates a new runtime row, bootstraps the
     `sandbox-agent` server (:2468) and REST proxy (:2469) via `SandboxAgentBootstrap`.
4. **Job + Attempt + Turn creation** —
   `createJob()` (idempotent on `session_id + request_id`),
   `createJobAttempt()` (attempt #1, records epoch), `createTurn()`.
5. **POST /prompt to sandbox proxy** — sends `{ jobId, attemptId, epoch, prompt,
   callbackUrl, hmacKey, config }`. Proxy returns `202 Accepted`.
6. **Inside the sandbox** — `ProxyServer.handlePrompt()` in
   `lib/sandbox-proxy/server.ts`:
   - Epoch fencing + idempotency checks.
   - Writes `ActivePrompt` to `/tmp/polaris-proxy/active-prompt.json` (durable accept).
   - Returns 202 immediately; executes prompt asynchronously via `AcpBridge`.
   - Emits `prompt_accepted` callback, then runs the agent, forwarding HITL events
     (`permission_requested`, `question_requested`) as callbacks.
   - On completion: emits `prompt_complete` or `prompt_failed` callback.
7. **`app/api/callbacks/route.ts`** — receives the callback. Verifies HMAC signature
   via `lib/jobs/callback-auth.ts` → `verifyCallback()`.
8. **`lib/orchestration/callback-processor.ts` → `ingestCallback()`** —
   epoch fence, idempotent INSERT into `callback_inbox`, inline processing:
   - `prompt_accepted` → CAS attempt `dispatching→accepted`, CAS job `pending→accepted`.
   - `prompt_complete` → CAS attempt→completed, CAS job→`agent_completed`,
     CAS session `active→idle`, triggers `runPostProcessing()`.
   - `prompt_failed` → CAS attempt→failed, CAS job→`failed_retryable` or `cancelled`,
     CAS session `active→idle`.
9. **`lib/orchestration/postprocess.ts` → `runPostProcessing()`** —
   CAS job `agent_completed→postprocess_pending`. For `prompt` jobs: no-op → completed.
   For `coding_task`: git push + PR creation. For `review`: parse output, post GitHub
   comment, complete check, release lock.

### Flow B — GitHub webhook triggers a PR review

1. **`app/api/webhooks/github/route.ts`** — POST handler. Verifies webhook signature
   via `lib/integrations/github.ts` → `verifyWebhookSignature()`.
2. **`lib/routing/trigger-router.ts` → `routeGitHubEvent()`** —
   - Resolves org via `findGithubInstallationByInstallationId()`.
   - Atomic dedupe: `lib/routing/dedupe.ts` → `claimDelivery()` (INSERT ON CONFLICT).
   - Finds matching enabled automations via `findEnabledAutomationsByTrigger()`.
   - Filters by repository full name + `lib/routing/matchers.ts` → `matchesGitHubTrigger()`.
   - For `continuous` mode: normalizes PR event (`lib/reviews/github-events.ts`),
     finds-or-creates `automationSession`, creates `automationRun`, creates pending
     GitHub check, calls `dispatchPrReview()`.
   - For `oneshot` mode: creates `automationRun`, calls `dispatchCodingTask()`.
3. **`lib/orchestration/pr-review.ts` → `dispatchPrReview()`** —
   - Acquires review lock on `automationSession` (or queues the request).
   - Applies filters (`lib/reviews/filters.ts`), fetches diff + guidelines,
     classifies files (`lib/reviews/classification.ts`),
     builds prompt (`lib/reviews/prompt-builder.ts`).
   - CAS session to active, creates `review` job + attempt.
   - Inline retry loop (up to 2 attempts): health-check + POST /prompt.
   - Lock ownership transfers to callback path on 202, or to sweeper on timeout.
4. **Post-processing** (same callback path as Flow A) —
   `postprocessReview()`: parse output → mark stale comment → update session metadata
   → post review comment → complete GitHub check → update automation run →
   `lib/orchestration/review-lifecycle.ts` → `finalizeReviewRun()` (release lock,
   drain pending queue, dispatch next queued review).

---

## API Entrypoints

| Route | Method | Purpose |
|-------|--------|---------|
| `app/api/interactive-sessions/[id]/prompt` | POST | User sends a message to a session |
| `app/api/webhooks/github` | POST | GitHub webhook receiver |
| `app/api/callbacks` | POST | HMAC-signed callbacks from sandbox proxy |
| `app/api/cron/sweeper` | GET | Vercel Cron (every 2 min) — job timeout, retry, stale session healing |
| `app/api/interactive-sessions/[id]/permission` | POST | HITL: reply to permission request |
| `app/api/interactive-sessions/[id]/question` | POST | HITL: reply to question |
| `app/api/interactive-sessions/[id]` | GET/DELETE | Session detail / stop session |
| `app/api/jobs/[id]` | GET | Job detail with attempts and events |

---

## Module Map

### `lib/auth`
User authentication via better-auth (email+password, GitHub OAuth). Configures
the Drizzle adapter and the `organization` plugin for multi-tenancy.
**Key exports:** `auth` (better-auth instance), `getSessionWithOrg()`.
**Depends on:** `lib/db`.

### `lib/automations`
CRUD and state management for automations (trigger configs, runs, sessions).
Automation sessions bridge event-triggered automations to long-lived interactive
sessions. Includes review lock acquisition/release and pending-queue management.
**Key types:** `automations`, `automationRuns`, `automationSessions`.
**Depends on:** `lib/db`, `lib/sessions/schema`, `lib/integrations/schema`, `lib/secrets/schema`, `lib/reviews/types`.

### `lib/credentials`
AES-256-GCM encryption/decryption of secrets at rest.
**Key exports:** `encrypt()`, `decrypt()`.
**Depends on:** nothing (pure crypto utilities).

### `lib/db`
Drizzle ORM client and consolidated schema re-exports. All table definitions
live in their respective domain directories; `lib/db/schema.ts` re-exports them.
**Key exports:** `db` (drizzle client).
**Depends on:** drizzle-orm, @neondatabase/serverless.

### `lib/errors`
Typed error hierarchy. `RequestError` for HTTP error responses.
`session-error-types.ts` defines structured error codes, phases, and a
catalog — safe for client-side use (no server imports).
**Key exports:** `RequestError`, `parseSessionError()`, `ERROR_CATALOG`.
**Depends on:** nothing.

### `lib/http`
Request body parsing utilities shared by API routes. Guards against oversized
payloads with `BodyTooLargeError`.
**Key exports:** `readRequestBody()`, `BodyTooLargeError`.
**Depends on:** nothing.

### `lib/integrations`
GitHub App integration: webhook signature verification, Octokit factories,
installation token minting, PR creation, repository sync. Schema for
`githubInstallations` and `repositories`.
**Key exports:** `verifyWebhookSignature()`, `mintInstallationToken()`, `createPullRequest()`, `githubInstallations`, `repositories`.
**Depends on:** `lib/db`, octokit.

### `lib/jobs`
The v2 job coordination layer. Contains the `jobs`, `jobAttempts`, `callbackInbox`,
and `jobEvents` tables, CAS operations for job and attempt status transitions,
and HMAC key generation/verification. Pure domain CRUD — no cross-domain
orchestration (callback processing, post-processing, and sweeper logic live
in `lib/orchestration/`).
**Key types:** `jobs`, `jobAttempts`, `callbackInbox`, `JobStatus`, `AttemptStatus`, `CallbackType`, `JobType`.
**Depends on:** `lib/db`.

### `lib/metrics`
Lightweight step-level timing for pipeline instrumentation. Produces a
JSONB-friendly `StepMetrics` object stored on `automationRuns.metrics`.
**Key exports:** `createStepTimer()`, `StepMetrics`.
**Depends on:** nothing.

### `lib/orchestration`
Layer 3 — multi-domain workflows that coordinate across sessions, jobs, sandbox,
and automations. Contains:
- `coding-task.ts` — provisions sandbox, bootstraps agent, creates job, POSTs /prompt.
- `pr-review.ts` — lock acquisition, filtering, diff/guideline gathering, prompt building, dispatch with retry.
- `prompt-dispatch.ts` — two-tier session dispatch (alive sandbox vs. provision).
- `sandbox-lifecycle.ts` — sandbox provisioning, snapshot-and-hibernate, destroy.
- `callback-processor.ts` — epoch fence, callback ingestion, session healing.
- `postprocess.ts` — coding task PR creation, review comment posting, check completion.
- `sweeper.ts` — job timeout, dispatch-unknown reconciliation, stale session healing, review lock release.
- `credential-resolver.ts` — loads all credentials for an automation run.
- `review-lifecycle.ts` — releases locks and drains queued reviews.
**Key exports:** `dispatchCodingTask()`, `dispatchPrReview()`, `dispatchPromptToSession()`, `ensureSandboxReady()`, `ingestCallback()`, `runSweep()`, `resolveCredentials()`.
**Depends on:** `lib/jobs`, `lib/sessions`, `lib/sandbox`, `lib/sandbox-agent`, `lib/reviews`, `lib/automations`, `lib/integrations`, `lib/credentials`, `lib/secrets`.

### `lib/reviews`
PR review domain logic: event normalization, diff fetching, file classification,
path filtering, repo guidelines loading, structured prompt building, output
parsing (verdict/severity/summary), comment rendering (Markdown), and GitHub
API operations (post comment, mark stale, create/complete/fail checks, ancestor
detection).
**Key exports:** `normalizePREvent()`, `buildReviewPrompt()`, `parseReviewOutput()`, `renderReviewComment()`, `postReviewComment()`, `completeCheck()`.
**Depends on:** `lib/integrations` (Octokit factories).

### `lib/routing`
Webhook event routing. `routeGitHubEvent()` looks up the org, deduplicates the
delivery (atomic INSERT via `eventDeliveries`), matches against enabled
automation trigger configs, and dispatches to the appropriate orchestration
module. `matchesGitHubTrigger()` handles event + branch matching.
**Key types:** `eventDeliveries`.
**Key exports:** `routeGitHubEvent()`, `claimDelivery()`, `matchesGitHubTrigger()`.
**Depends on:** `lib/integrations`, `lib/automations`, `lib/orchestration`, `lib/reviews`.

### `lib/sandbox`
Vercel Sandbox lifecycle management. `SandboxManager` handles creation (from git
or snapshot), destruction, reconnection, snapshotting, git token refresh via
`networkPolicy`, and credential scrubbing before hibernation.
`SandboxCommands` wraps `sandbox.runCommand()`. `GitOperations` provides
branch creation, commit-and-push, change detection, and ref resolution.
`snapshots/` manages the `sandboxSnapshots` table for pre-built agent images.
**Key exports:** `SandboxManager`, `SandboxCommands`, `GitOperations`, `sandboxSnapshots`.
**Depends on:** @vercel/sandbox.

### `lib/sandbox-agent`
Agent bootstrap and session management inside the sandbox. `SandboxAgentBootstrap`
installs the sandbox-agent binary, agent CLIs (claude/codex), and the REST proxy
bundle. `agent-profiles.ts` is the centralized agent capability registry — maps
semantic intents (autonomous, read-only, interactive) to agent-native modes/models.
`credentials.ts` builds agent-specific env vars. `event-types.ts` parses and
consolidates ACP JSON-RPC events into typed `ChatItem`s for the UI.
`persist.ts` creates a Postgres session persist driver.
**Key types:** `AgentType`, `AgentSession`, `ParsedEvent`, `ChatItem`.
**Key exports:** `SandboxAgentBootstrap`, `resolveAgentConfig()`, `buildSessionEnv()`, `consolidateEvents()`.
**Depends on:** `lib/sandbox`, sandbox-agent SDK, acp-http-client.

### `lib/sandbox-env`
Org-level environment variables injected into sandbox sessions. Values are
encrypted at rest (AES-256-GCM). CRUD operations for the `sandboxEnvVars` table.
**Key types:** `sandboxEnvVars`.
**Depends on:** `lib/db`, `lib/credentials`.

### `lib/sandbox-proxy`
The REST proxy that runs inside the Vercel Sandbox on port 2469. Manages the
prompt lifecycle: durable accept (write to file before 202), epoch fencing,
ACP bridge to the agent server (:2468), HITL event forwarding, and
HMAC-signed callback delivery with file-based outbox and retry.
Bundled into `dist/proxy.js` and uploaded to the sandbox at provision time.
**Key types:** `PromptRequest`, `ActivePrompt`, `CallbackBody`, `OutboxEntry`, `ProxyState`, `AgentSession`.
**Key exports:** `ProxyServer`, `AcpBridge`, `emitCallback()`.
**Depends on:** sandbox-agent SDK, acp-http-client (bundled at build time; no access to lib/ at runtime).

### `lib/secrets`
Encrypted secret storage for agent API keys. Schema for the `secrets` table
(org-scoped, provider-tagged, revocable). Query functions include decryption.
**Key types:** `secrets`.
**Depends on:** `lib/db`, `lib/credentials`.

### `lib/sessions`
Interactive session lifecycle. Schema for `interactiveSessions`,
`interactiveSessionRuntimes`, `interactiveSessionCheckpoints`,
`interactiveSessionTurns`. CAS-based status transitions, epoch management,
runtime CRUD, and checkpoint/hibernation transactions. Pure domain CRUD —
orchestration logic (prompt dispatch, sandbox lifecycle) lives in
`lib/orchestration/`. Status model with capability flags (`canSend`,
`pollIntervalMs`, `canStop`, `isTerminal`).
**Key types:** `interactiveSessions`, `interactiveSessionRuntimes`, `SessionStatus`.
**Key exports:** `casSessionStatus()`, `incrementEpoch()`, `hibernateSession()`, `STATUS_CONFIG`.
**Depends on:** `lib/db`.

---

## State Machines

### Session Status

```
creating ──► idle ◄──► active
               │          │
               ▼          │
          snapshotting     │
               │          │
               ▼          │
          hibernated ─────┤ (resume triggers idle→active)
                          │
  Any state ──────────► stopped | completed | failed  (terminal)
```

Values: `creating`, `active`, `idle`, `snapshotting`, `hibernated`, `stopped`, `completed`, `failed`.
Defined in `lib/sessions/status.ts` → `SESSION_STATUSES`.
Terminal states: `stopped`, `completed`, `failed` — all allow `canSend` (triggers new sandbox).

### Job Status

```
pending ──► accepted ──► running ──► agent_completed ──► postprocess_pending ──► completed
  │            │            │              │                     │
  └──── Any ───┴──── Any ──┴── Any ──► failed_retryable ──► pending (retry)
  │            │            │
  └──── Any ───┴──── Any ──┴── Any ──► failed_terminal | cancelled
```

Values: `pending`, `accepted`, `running`, `agent_completed`, `postprocess_pending`, `completed`, `failed_retryable`, `failed_terminal`, `cancelled`.
Defined in `lib/jobs/status.ts` → `JOB_STATUSES`, `JOB_TRANSITIONS`.

### Attempt Status

```
dispatching ──► accepted ──► running ◄──► waiting_human
     │              │           │              │
     ▼              │           ▼              ▼
dispatch_unknown    └──► failed ◄── completed ◄┘
     │
     ▼
  accepted | failed  (sweeper reconciles)
```

Values: `dispatching`, `dispatch_unknown`, `accepted`, `running`, `waiting_human`, `completed`, `failed`.
Defined in `lib/jobs/status.ts` → `ATTEMPT_STATUSES`, `ATTEMPT_TRANSITIONS`.

---

## Invariants

### Sandbox credential isolation
The sandbox VM never sees raw GitHub tokens. `SandboxManager.buildGitNetworkPolicy()`
injects Basic auth headers at the Vercel network layer; git operations inside the
sandbox use plain HTTPS URLs. Agent API keys are passed as env vars to the
sandbox-agent server process, not written to files (except Codex, which requires
`~/.codex/auth.json` — scrubbed before snapshotting).

### Compare-and-set for contested transitions
Session status transitions that can race (e.g., concurrent prompt sends, callback
vs. sweeper) use CAS: `casSessionStatus()`, `casJobStatus()`, `casAttemptStatus()`.
Each issues an `UPDATE ... WHERE status IN (...) RETURNING`, so only one writer
wins. Non-contested writes (e.g., updating `sandboxBaseUrl` after provisioning)
may use direct updates.

### Epoch fencing on callbacks
Each sandbox provisioning increments the session `epoch` via `incrementEpoch()`.
The epoch is stamped on every attempt and callback. The callback ingestion path
(`ingestCallback()`) rejects callbacks whose epoch does not match the session's
current epoch, preventing stale sandbox callbacks from corrupting state. The
sandbox proxy also epoch-fences inbound `/prompt` requests.

### One live runtime per session
The `interactiveSessionRuntimes` table has a partial unique index
(`idx_one_live_runtime_per_session`) on `session_id` WHERE `status IN
('creating', 'running', 'idle')`. Before creating a new runtime,
`endStaleRuntimes()` marks any existing live runtimes as failed.

### HMAC keys stored separately from job payloads
Each job's HMAC key is stored in a dedicated `hmac_key` column on the `jobs`
table, never in `payload` JSONB. This prevents accidental key leakage through
logging or API responses that serialize `payload`.

### Post-processing side effects tracked in JSONB
The `sideEffectsCompleted` JSONB column on `jobs` tracks which post-processing
steps have completed (e.g., `committed`, `pr_created`, `comment_posted`,
`run_updated`, `sandbox_destroyed`). Each step checks the flag before executing,
making post-processing idempotent across retries.

### v2 dispatch uses the jobs table
All async work coordination flows through the `jobs` + `jobAttempts` tables.
Legacy Trigger.dev naming persists in some schema references (e.g.,
`triggerRunId` columns may still exist) but the runtime no longer uses
Trigger.dev. The sweeper cron replaces Trigger.dev's retry/timeout mechanisms.

### Sweeper uses advisory locks
`runSweep()` acquires Postgres advisory lock `42_000_001` via
`pg_try_advisory_lock()` before processing. If another sweep is already running,
the new invocation returns immediately. The lock is released in a `finally` block.

### Review locks are job-fenced
Automation session review locks use `reviewLockJobId` — a reference to the
active automation run. The lock is held while the referenced job is nonterminal.
The sweeper's `sweepStaleReviewLocks()` provides a fallback: it releases locks
where the referenced job is already terminal or missing.

### Webhook delivery deduplication
`claimDelivery()` in `lib/routing/dedupe.ts` performs an atomic
`INSERT ... ON CONFLICT DO NOTHING` into `eventDeliveries` keyed on `dedupeKey`.
If the insert returns no rows, the delivery was already claimed — the webhook
is skipped.

---

## Cross-Cutting Concerns

### Authentication and multi-tenancy
User auth is handled by better-auth with a GitHub OAuth provider and an
`organization` plugin. Every data query is scoped to `organizationId`. Agent API
keys are encrypted at rest (AES-256-GCM via `lib/credentials/encryption.ts`).
GitHub access uses short-lived App installation tokens minted per operation.

### Durability and retry
The sandbox proxy writes callbacks to a file-based outbox before attempting HTTP
delivery (write-ahead pattern). Delivery retries with exponential backoff (1s, 4s,
16s). The Vercel Cron sweeper (every 2 minutes) handles: timed-out jobs,
dispatch-unknown reconciliation, stuck post-processing retry, stale active session
healing, stale review lock release, and retryable job re-dispatch.

### Epoch fencing
Epoch is the primary mechanism for preventing stale-sandbox interference. It is
checked at three boundaries: (1) the sandbox proxy rejects prompt requests with
a stale epoch, (2) the callback ingestion route rejects callbacks with a
mismatched epoch, and (3) the sweeper uses epoch-aware attempt records for
reconciliation.

### Supported agents
Agent capabilities are centralized in `lib/sandbox-agent/agent-profiles.ts`.
Currently enabled: Claude Code (Anthropic) and Codex (OpenAI). Disabled but
defined: OpenCode, Amp. Each agent profile declares valid models, modes,
thought/effort levels, and maps semantic intents to agent-native values.

### Database
Postgres via Drizzle ORM. All tables use UUID primary keys and `timestamptz`
columns. Idempotency is enforced through unique indexes and ON CONFLICT clauses.
The schema is spread across domain directories and re-exported through
`lib/db/schema.ts`.
