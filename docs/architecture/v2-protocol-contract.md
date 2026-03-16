# v2 Protocol Contract — Sandbox Proxy ↔ Polaris API

**Status:** Frozen
**Date:** 2026-03-16
**Prerequisite:** Read `proposed-architecture-v2.md` and `v2-coordination-state-machine.md` first.
**Purpose:** Define the exact HTTP contract between the sandbox REST proxy (running inside the sandbox) and the Polaris API (running on Vercel). This document must be frozen before any Phase 1 or Phase 2 implementation begins.

---

## Overview

The sandbox proxy is a thin Node.js HTTP server running inside the Vercel Sandbox alongside the sandbox-agent server. It translates stateless REST calls from the Polaris API into local ACP (Agent Client Protocol) interactions with the sandbox-agent, and calls back to the Polaris API on completion.

```
Polaris API ──POST /prompt──→ Sandbox Proxy ──ACP (localhost)──→ sandbox-agent
                                    │
                                    └──POST /api/callbacks──→ Polaris API
```

All communication is HTTP. No persistent connections. No WebSockets between Polaris and sandbox.

---

## 1. Prompt Dispatch

### `POST /prompt`

Accepts a prompt for execution. Returns immediately after durable acceptance.

**Request:**

```typescript
{
  jobId: string;           // UUID — the Polaris job record
  attemptId: string;       // UUID — the specific attempt
  epoch: number;           // Session epoch — fencing token
  prompt: string;          // The prompt text
  callbackUrl: string;     // Where to POST callbacks (e.g. https://polaris.app/api/callbacks)
  hmacKey: string;         // HMAC-SHA256 signing key for callbacks
  config: {
    agent: "claude" | "codex" | "opencode" | "amp";
    mode?: string;         // Agent-native mode (e.g. "bypassPermissions", "full-access")
    model?: string;        // Model override (e.g. "opus", "gpt-5.4")
    effortLevel?: string;  // "low" | "medium" | "high" | "max"
    modeIntent?: "autonomous" | "read-only" | "interactive";
    sdkSessionId?: string; // SDK session ID for resume (text replay)
    nativeAgentSessionId?: string; // Native CLI session ID for native resume
    branch?: string;       // Git branch to checkout
    env?: Record<string, string>; // Environment variables for agent
  };
}
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| `202 Accepted` | `{accepted: true, attemptId}` | Prompt durably accepted. Proxy will execute and call back. |
| `409 Conflict` | `{accepted: false, reason: "stale_epoch", currentEpoch: N}` | Epoch is stale — a newer sandbox owns this session. |
| `409 Conflict` | `{accepted: false, reason: "already_running", activeAttemptId}` | Another prompt is already running. |
| `400 Bad Request` | `{accepted: false, reason: string}` | Invalid request (missing fields, unknown agent, etc.) |

**Idempotency:** If a request arrives with an `attemptId` that matches the currently running or completed prompt, the proxy returns the current status without re-executing:

```typescript
// Already running this attempt
202 {accepted: true, attemptId, status: "running"}

// Already completed this attempt
200 {accepted: true, attemptId, status: "completed"}
```

**Durable accept contract:** Before returning `202`, the proxy MUST:
1. Write `{jobId, attemptId, epoch, callbackUrl, hmacKey}` to a local file (e.g. `/tmp/polaris-proxy/active-prompt.json`)
2. This file survives proxy process restart (within the same sandbox lifecycle)
3. On proxy startup, if this file exists and no agent is running, the proxy sends a `prompt_failed` callback with `reason: "proxy_restart_orphan"`

---

## 2. Callbacks

The proxy POSTs callbacks to `callbackUrl` (from the prompt request) when events occur during execution.

### `POST {callbackUrl}`

**Request headers:**

```
Content-Type: application/json
X-Callback-Signature: <HMAC-SHA256 hex digest>
```

**Signature computation:**

```typescript
const signature = crypto
  .createHmac("sha256", hmacKey)
  .update(JSON.stringify(body))
  .digest("hex");
```

**Request body (common fields):**

```typescript
{
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackId: string;     // UUID — unique per callback emission (for dedupe)
  callbackType: string;   // See types below
  payload: Record<string, unknown>;
}
```

### Callback Types

#### `prompt_accepted`

Sent when the proxy has started the agent process.

```typescript
payload: {
  startedAt: string; // ISO timestamp
}
```

#### `prompt_complete`

Sent when the agent finishes successfully.

```typescript
payload: {
  result: {
    lastMessage?: string;        // Agent's final text response
    exitCode?: number;           // Agent process exit code
    sdkSessionId?: string;       // SDK session ID (for future resume)
    nativeAgentSessionId?: string; // Native CLI session ID (for native resume)
    cwd?: string;                // Final working directory
    durationMs: number;          // Execution time
  };
  completedAt: string; // ISO timestamp
}
```

**Note:** The raw completion result is intentionally minimal. For PR reviews, the Polaris callback handler reconstructs the full output from persisted events in the database (via `readPersistedOutput`), not from this payload. The proxy sends the signal; the handler reads the data.

#### `prompt_failed`

Sent when the agent fails, crashes, or is stopped.

```typescript
payload: {
  error: string;
  reason: "agent_crash" | "agent_timeout" | "user_stop" | "proxy_restart_orphan" | "unknown";
  exitCode?: number;
  durationMs?: number;
}
```

#### `permission_requested`

Sent when the agent requests human permission for a tool call.

```typescript
payload: {
  permissionId: string;     // Unique ID for this permission request
  toolName: string;         // e.g. "bash", "write_file", "computer"
  toolInput: Record<string, unknown>; // Tool call arguments
  requestedAt: string;
}
```

#### `question_requested`

Sent when the agent asks a question requiring human input.

```typescript
payload: {
  questionId: string;
  question: string;
  options?: string[];        // If multiple choice
  requestedAt: string;
}
```

#### `permission_resumed`

Sent when the agent resumes after a permission/question reply.

```typescript
payload: {
  permissionId?: string;
  questionId?: string;
  resumedAt: string;
}
```

### Callback Delivery

The proxy maintains a **durable callback outbox** on local filesystem:

1. Every callback is written to the outbox file (`/tmp/polaris-proxy/outbox/`) before delivery
2. Delivery attempts: 3 retries with exponential backoff (1s, 4s, 16s)
3. If all retries fail, the callback stays in the outbox with `status: "pending"`
4. On proxy startup, pending outbox entries are replayed
5. The sweeper polls `GET /outbox` to recover undelivered callbacks

**Outbox entry format:**

```typescript
{
  callbackId: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackType: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "failed";
  attempts: number;
  lastAttemptAt?: string;
  createdAt: string;
}
```

### Callback Response

The Polaris API responds to callbacks:

| Status | Meaning | Proxy action |
|--------|---------|-------------|
| `200 OK` | Callback accepted and processed | Mark outbox entry `delivered` |
| `409 Conflict` | Stale epoch or duplicate | Mark outbox entry `delivered` (no retry needed) |
| `500+` | Server error | Retry per backoff schedule |

---

## 3. Permission and Question Replies

### `POST /permissions/:permissionId/reply`

Forwards a permission decision to the running agent.

**Request:**

```typescript
{
  reply: "allow" | "deny";
  epoch: number;           // Must match current epoch
}
```

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| `200 OK` | `{delivered: true}` | Reply forwarded to agent |
| `404 Not Found` | `{error: "unknown_permission_id"}` | No pending permission with this ID |
| `409 Conflict` | `{error: "stale_epoch"}` | Epoch mismatch |
| `409 Conflict` | `{error: "no_active_prompt"}` | No prompt is running |

### `POST /questions/:questionId/reply`

Forwards answers to a question from the agent.

**Request:**

```typescript
{
  answers: Record<string, string>; // Key-value answers
  epoch: number;
}
```

**Responses:** Same as permission reply.

---

## 4. Stop

### `POST /stop`

Stops the currently running prompt.

**Request:**

```typescript
{
  epoch: number;           // Must match current epoch
  reason?: string;         // Optional reason for logging
}
```

**Behavior:**

1. Proxy sends SIGTERM to the agent process
2. Waits up to 10 seconds for graceful shutdown
3. If still running after 10s, sends SIGKILL
4. Writes `prompt_failed` callback to outbox with `reason: "user_stop"`
5. Delivers callback to Polaris API

**Responses:**

| Status | Body | Meaning |
|--------|------|---------|
| `200 OK` | `{stopped: true}` | Stop initiated |
| `404 Not Found` | `{error: "no_active_prompt"}` | Nothing running to stop |
| `409 Conflict` | `{error: "stale_epoch"}` | Epoch mismatch |

---

## 5. Status

### `GET /status`

Returns the current state of the proxy.

**Response:**

```typescript
{
  state: "idle" | "running" | "stopping";
  jobId?: string;          // Set when running/stopping
  attemptId?: string;
  epoch?: number;
  startedAt?: string;      // When current prompt started
  agentPid?: number;       // Agent process PID (for debugging)
}
```

This endpoint is used by:
- The Polaris API to check sandbox health before dispatch
- The sweeper to reconcile `dispatch_unknown` attempts

---

## 6. Outbox

### `GET /outbox`

Returns pending (undelivered) callbacks. Used by the sweeper to recover lost callbacks.

**Response:**

```typescript
{
  entries: Array<{
    callbackId: string;
    jobId: string;
    attemptId: string;
    epoch: number;
    callbackType: string;
    payload: Record<string, unknown>;
    status: "pending" | "failed";
    attempts: number;
    lastAttemptAt?: string;
    createdAt: string;
  }>;
}
```

**Note:** Only returns entries with `status: "pending"` or `status: "failed"`. Delivered entries are excluded.

---

## 7. Dispatch Failure Semantics

When the Polaris API dispatches a prompt via `POST /prompt`, three outcomes are possible:

| Outcome | HTTP Response | Polaris Action |
|---------|--------------|----------------|
| **Accepted** | `202` | CAS attempt `dispatching → accepted`, CAS job `pending → accepted` |
| **Rejected** | `400` or `409` | CAS attempt → `failed`, rollback session CAS to `idle` |
| **Unknown** (timeout, network error) | No response | Mark attempt `dispatch_unknown`. Do NOT rollback session. Sweeper reconciles via `GET /status`. |

### Sweeper reconciliation for `dispatch_unknown`:

1. Call `GET /status` on the sandbox proxy
2. If `state: "running"` and `attemptId` matches → CAS attempt `dispatch_unknown → accepted`
3. If `state: "idle"` → CAS attempt `dispatch_unknown → failed`, rollback session to `idle`
4. If proxy unreachable → wait for `timeout_at`, then mark attempt `failed`, session `failed`

---

## 8. Health Check

### `GET /health`

The sandbox-agent server already exposes `GET /v1/health`. The proxy does not duplicate this — Polaris checks both:
- `GET {sandboxBaseUrl}/v1/health` — sandbox-agent is alive
- `GET {sandboxBaseUrl}:2469/status` — proxy is alive (or same port via path routing)

The proxy port is `2469` (distinct from sandbox-agent's `2468`).

---

## 9. Security

### HMAC Authentication

Every callback includes an `X-Callback-Signature` header containing the HMAC-SHA256 digest of the JSON body, signed with the per-job `hmacKey`.

The `hmacKey` is:
- Generated by the Polaris API when creating the job
- Stored in `jobs.hmac_key` (dedicated column, never in payload or logs)
- Passed to the proxy in the `POST /prompt` request
- Stored locally by the proxy for the duration of the prompt

### Epoch Fencing

Every mutating endpoint requires an `epoch` parameter. The proxy rejects requests with `epoch < currentEpoch`. This prevents stale sandboxes (from before a restore) from accepting prompts or delivering callbacks.

### Network Isolation

The proxy runs inside the Vercel Sandbox, which has network policies controlling egress. The `callbackUrl` must be reachable via the sandbox's network policy (Polaris API domain is allowed).

---

## 10. Proxy Lifecycle

### Startup

1. Proxy binary/script is installed by `SandboxAgentBootstrap.installProxy()`
2. Started alongside sandbox-agent server by `SandboxAgentBootstrap.startProxy()`
3. On startup, checks for orphaned outbox entries and replays them
4. Checks for active prompt file — if exists with no running agent, sends `prompt_failed` callback

### During Prompt Execution

1. Receives `POST /prompt`, writes active prompt file, returns 202
2. Connects to sandbox-agent via local ACP (WebSocket to `localhost:2468`)
3. Creates or resumes agent session (applying config fallbacks)
4. Executes prompt, handles permission/question events by emitting callbacks
5. On completion, writes `prompt_complete` callback to outbox, delivers to API
6. Cleans up active prompt file

### Idle

When no prompt is running, the proxy stays alive and responds to `GET /status` with `state: "idle"`. It has minimal resource consumption.

### Shutdown

On sandbox destruction, the proxy dies with the sandbox. Any pending outbox entries are lost unless the sweeper has already polled them. The sweeper detects the dead sandbox via health check failure and marks the active job as failed.

---

## 11. Correctness Properties Ported from SandboxAgentClient

The proxy absorbs session lifecycle management previously handled by `SandboxAgentClient.ts` + `trigger/interactive-session.ts`. These behaviors must be preserved:

### Agent Config Fallback

If `session/set_mode` or `session/set_config_option` RPC calls fail, the proxy logs a warning and continues with agent defaults. It does NOT fail the prompt.

### Native Resume vs Text Replay

When `config.nativeAgentSessionId` is provided:
1. Try native resume via `AcpHttpClient.unstableResumeSession()` — preserves full agent state
2. If native resume fails, fall back to text replay via SDK's `resumeOrCreateSession()` with `config.sdkSessionId`

### Persisted Output Reconstruction

The proxy sends a minimal `prompt_complete` callback. The Polaris callback handler reconstructs the full output from persisted events in the database. The proxy does NOT attempt to parse or structure the agent's output — that responsibility stays with `parseReviewOutput()` on the Polaris side.

### Permission/Question Forwarding

The proxy translates REST permission/question replies into the correct ACP JSON-RPC calls:
- Permission: `session/request_permission` reply via the session object
- Question: question reply via the session object

---

*This contract is the single source of truth for sandbox proxy ↔ Polaris API communication. Changes require updating this document first.*
