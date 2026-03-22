# Sandbox Logs Not Visible During Active Sessions

## Problem

The "Sandbox Logs" section on the run detail page (`/runs/:id`) and session page (`/sessions/:id`) shows "No log output captured for these processes" even while the sandbox is actively running and processing a review.

## Symptoms

- User opens a run detail page for an active review → Sandbox Logs section is empty
- The sandbox IS running (agent is executing, events are flowing)
- After the sandbox stops, logs show "Sandbox stopped after completion" (expected)

## Root Cause Investigation

The logs API at `app/api/sessions/[sessionId]/logs/route.ts` does:

1. Looks up the runtime's `sandboxBaseUrl` (which is the **proxy URL** on port 2469)
2. Calls `GET ${proxyBase}/processes` to discover running processes
3. For each process, calls `GET ${proxyBase}/processes/:id/logs` to fetch log output

**Hypothesis**: The REST proxy (`lib/sandbox-proxy/server.ts`, port 2469) may not forward `/processes` and `/processes/:id/logs` requests to the sandbox-agent server (port 2468). The proxy was built for the `/prompt`, `/health`, `/stop` request paths — process/log endpoints may not be proxied.

**Alternative hypothesis**: The runtime record stores `sandboxBaseUrl` as the proxy URL, but the processes/logs API is on the **agent server URL** (`agentServerUrl`, port 2468). The logs endpoint should use `runtime.agentServerUrl` instead of `runtime.sandboxBaseUrl`.

## Files to Investigate

| File | What to check |
|------|--------------|
| `lib/sandbox-proxy/server.ts` | Does the proxy forward `/processes` and `/processes/:id/logs`? Search for route handlers. |
| `app/api/sessions/[sessionId]/logs/route.ts` | Line 67: uses `runtime.sandboxBaseUrl` — should it use `runtime.agentServerUrl` instead? |
| `lib/sessions/schema.ts` | Runtime schema has both `sandboxBaseUrl` (proxy, 2469) and `agentServerUrl` (agent, 2468) |
| `lib/sessions/actions.ts` | `getActiveRuntime` / `getLatestRuntime` — do they return `agentServerUrl`? |

## Likely Fix

If the proxy doesn't forward process/log endpoints (most likely scenario):

**Option A** — Use `agentServerUrl` for logs:
```ts
// In logs/route.ts, line 67:
const proxyBase = runtime.agentServerUrl ?? runtime.sandboxBaseUrl;
```
This bypasses the proxy and hits the sandbox-agent directly for process/log data. The agent server runs on port 2468 which is exposed as a sandbox port.

**Option B** — Add proxy forwarding for `/processes*`:
Add a catch-all route in the proxy that forwards to the agent server. More complex, keeps all traffic through one URL.

Option A is simpler and more correct — the proxy shouldn't need to know about process/log APIs.

## Verification

1. Start a local dev session or trigger a review
2. While the sandbox is running, hit `GET /api/sessions/:id/logs`
3. Verify processes are listed and logs are returned
4. Check the run detail page — Sandbox Logs section should show output
