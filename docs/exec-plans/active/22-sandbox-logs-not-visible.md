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

The original proxy hypothesis was wrong. `lib/sandbox-proxy/server.ts` already forwards `/processes*` to the sandbox-agent server.

The actual bug is in the logs API:

- Active agent processes are started in **TTY mode**
- sandbox-agent returns **no entries** for TTY processes when queried with `stream=combined`
- TTY logs must be fetched with `stream=pty`
- Returned log payloads are **base64-encoded**, so the API must decode them before the UI renders them

## Files to Investigate

| File | What to check |
|------|--------------|
| `lib/sandbox-proxy/server.ts` | Confirms `/processes*` is already proxied. |
| `app/api/sessions/[sessionId]/logs/route.ts` | Default stream selection and log decoding. |
| `lib/sessions/schema.ts` | Runtime schema has both `sandboxBaseUrl` (proxy, 2469) and `agentServerUrl` (agent, 2468) |
| `lib/sessions/actions.ts` | `getActiveRuntime` / `getLatestRuntime` — do they return `agentServerUrl`? |

## Likely Fix

Use the existing proxy URL, but fix the API contract:

1. When no `stream` query param is provided, auto-select:
   - `pty` for `process.tty === true`
   - `combined` otherwise
2. Decode base64 log payloads before returning JSON to the UI

## Verification

1. Start a local dev session or trigger a review
2. While the sandbox is running, hit `GET /api/sessions/:id/logs`
3. Verify TTY processes return readable log text while still running
4. Check the run detail page — Sandbox Logs section should show output
