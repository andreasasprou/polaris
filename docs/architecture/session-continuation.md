# Session Continuation Architecture

## Status: Approved (v5) — fix list before implementation below

## Problem Statement

Interactive sessions currently break on resume. When a user sends a new message after the Trigger.dev task has ended, the sandbox-agent SDK's session restoration replays previous events as raw JSON-RPC text into the agent's context window. This causes:

1. **Raw JSON in the chat UI** — the replay preamble and raw JSON-RPC payloads are stored as regular events in Postgres and rendered in the chat
2. **Context truncation** — replay is capped at `replayMaxEvents`/`replayMaxChars`, so long conversations lose history
3. **Duplicate events in Postgres** — replayed events are re-stored as new rows alongside the originals
4. **No native agent resume** — Claude Code, OpenCode, and Codex all support native session continuation, but the SDK bypasses this entirely
5. **Filesystem state loss** — new sandbox = clean checkout; all previous changes, installed deps, and agent state are gone

The goal: **it should feel like the user just sent another message in the same conversation.**

---

## Supported Agents

This architecture applies to three first-class agents:

- **Claude Code** — `claude --resume <session-id>`
- **OpenCode** — `opencode --session <id> --continue`
- **Codex** — `codex resume <SESSION_ID>`, `codex exec resume <SESSION_ID>` (non-interactive automation path with `--json` JSONL output)

All three are supported by sandbox-agent (`agent: "claude"`, `agent: "opencode"`, `agent: "codex"`) and use the same tiered lifecycle:

| Tier | Behavior |
|------|----------|
| **Hot** | Same live runtime, message delivered via input stream |
| **Warm** | Same sandbox, same in-memory agent session, new task reconnects |
| **Hibernate** | Restored filesystem + native agent resume |

---

## Proposed Architecture: Tiered Resume with Snapshot Hibernation

A three-tier model: hot → warm → hibernate.

| Tier | Condition | What Happens | Latency | Idle Cost |
|------|-----------|-------------|---------|-----------|
| **Hot** | Task is still running | Message delivered via input stream | Instant | $0 (actively in use) |
| **Warm** | Task ended < warm window (1-3 min) | Sandbox still alive; trigger new task, reconnect | ~2-3s | Memory only (short window) |
| **Hibernate** | Warm window expired | Snapshot filesystem → stop sandbox → resume from snapshot later | ~5-10s (needs benchmarking) | $0 + snapshot storage |

The warm tier covers natural short pauses (user thinking for 30 seconds, reading a response). The hibernate tier covers everything else (user leaves for an hour, overnight, etc.).

**Key principle**: The warm window is short (1-3 minutes), not the current 30-minute grace period. This is a UX optimization, not a cost center.

**Warm tier prerequisite**: The sandbox-agent server must be started as a **detached long-lived process** inside the sandbox, independent of the Trigger.dev task lifecycle. sandbox-agent holds live sessions in memory only while the server process is alive. If the server dies with the task, warm resume collapses into replay/cold behavior. The task must verify the server is healthy (health check) before attempting warm reconnect.

---

## Identity Model

Three distinct identities that must not be conflated:

| Identity | What it is | Lifetime | Stored in |
|----------|-----------|----------|-----------|
| **Conversation ID** | `interactive_sessions.id` — the user's logical session | Indefinite | `interactive_sessions` |
| **Runtime Instance** | A specific sandbox + Trigger.dev run serving the conversation | Minutes to hours (one per turn/batch of turns) | `interactive_session_runtimes` |
| **Native Agent Session ID** | Claude Code session ID, OpenCode thread/session ID, or Codex session ID | Tied to agent session files/state on disk | `interactive_sessions.native_agent_session_id` |

The current `sdk_session_id` (sandbox-agent's session ID) is **not** a durable identity — sandbox-agent stores sessions in memory and loses them when the server restarts. It is a property of a runtime instance, not the conversation.

**Note on `native_agent_session_id`**: sandbox-agent already returns `session.agentSessionId` and persists it in `SessionRecord`. Verify whether this field already equals the real Claude/OpenCode/Codex session ID before introducing a separate concept. If it does, copy it directly into the canonical session row rather than maintaining a parallel identity.

---

## Data Model

### `interactive_sessions` — canonical conversation record

```sql
-- Existing columns remain. Add:
ALTER TABLE interactive_sessions ADD COLUMN native_agent_session_id TEXT;
ALTER TABLE interactive_sessions ADD COLUMN cwd TEXT;  -- stable working directory
-- latest_checkpoint_id added after interactive_session_checkpoints exists (see migration order note)
```

Remove runtime-specific columns from this table over time (`sandbox_id`, `sandbox_base_url`, `trigger_run_id`). These move to the runtimes table.

### `interactive_session_runtimes` — one row per sandbox lifecycle

```sql
CREATE TABLE interactive_session_runtimes (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES interactive_sessions(id),
  sandbox_id TEXT,
  sandbox_base_url TEXT,
  trigger_run_id TEXT,
  sdk_session_id TEXT,             -- sandbox-agent's ephemeral session ID for this runtime
  restore_source TEXT NOT NULL,     -- 'base_snapshot' | 'hibernate_snapshot' | 'warm_reconnect'
  restore_snapshot_id TEXT,         -- which snapshot was used to create this runtime
  status TEXT NOT NULL DEFAULT 'creating', -- creating | running | warm | suspended | stopped | failed
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  ended_at TIMESTAMPTZ
);

-- Enforce: only one live runtime per session
CREATE UNIQUE INDEX idx_one_live_runtime_per_session
  ON interactive_session_runtimes (session_id)
  WHERE status IN ('creating', 'running', 'warm', 'suspended');
```

Note: `warm` status on the runtime row means the task process is alive but waiting for the next message (instant response). `suspended` means the Trigger.dev process has been checkpointed and freed ($0 compute) — the sandbox stays alive but the task resumes with ~1-2s latency when a message arrives. See `docs/architecture/two-phase-waiting.md` for details.

### `interactive_session_checkpoints` — hibernation snapshots

```sql
CREATE TABLE interactive_session_checkpoints (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES interactive_sessions(id),
  runtime_id UUID REFERENCES interactive_session_runtimes(id),
  snapshot_id TEXT NOT NULL,         -- Vercel snapshot ID
  base_commit_sha TEXT,              -- git HEAD at checkpoint time
  last_event_index INTEGER,          -- last event_index in sandbox_agent.events at checkpoint
  size_bytes BIGINT,
  created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL,
  expires_at TIMESTAMPTZ             -- snapshot expiration (default 30 days, configurable)
);

-- Now add the FK from interactive_sessions to checkpoints
ALTER TABLE interactive_sessions ADD COLUMN latest_checkpoint_id UUID
  REFERENCES interactive_session_checkpoints(id);
```

### Migration order

The `interactive_sessions.latest_checkpoint_id` FK references `interactive_session_checkpoints`, while `interactive_session_checkpoints.session_id` references `interactive_sessions`. This circular relationship requires:
1. Create `interactive_session_runtimes` table
2. Create `interactive_session_checkpoints` table
3. `ALTER TABLE interactive_sessions ADD COLUMN latest_checkpoint_id ...` with the FK

---

## Stable Working Directory

For cross-host resume, the `cwd` must match between the original session and the restored session.

- **Claude Code** stores session files at `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, where the encoding replaces non-alphanumeric characters with `-`.
- **Codex** scopes `codex resume --last` to the current working directory unless `--all` is passed. For direct CLI bypass (Option B), use `codex exec resume <id> --cd <cwd>` to explicitly set the working directory. Codex also supports overriding `CODEX_HOME` (default `~/.codex`) — for multi-tenant isolation, consider setting `CODEX_HOME=/workspace/sessions/<interactive_session_id>/.codex-home` to keep transcripts, auth, and caches isolated per conversation.
- **OpenCode** uses `--session <id>` for explicit resume, but a stable cwd avoids path-dependent surprises.

**Invariant**: Every interactive session has a stable, deterministic working directory:

```
/workspace/sessions/<interactive_session_id>
```

This is stored in `interactive_sessions.cwd` and used for:
- `sessionInit.cwd` when creating sandbox-agent sessions
- `git clone` target directory
- Claude Code's session file path derivation
- Codex's cwd-scoped `resume --last` behavior
- Ensuring snapshot restore puts files in the right place

On first session creation, clone the repo to this path. On snapshot restore, the path is already correct.

---

## State Machine

```
                    ┌──────────┐
    [New Session]──►│ creating │
                    └────┬─────┘
                         │ task starts, SDK session created
                         ▼
                    ┌──────────┐
               ┌───►│  active  │◄────────────────────┐
               │    └────┬─────┘                      │
               │         │                            │
               │    task ends (idle timeout)           │
               │         │                            │
               │         ▼                            │
               │    ┌──────────┐                      │
               │    │   warm   │                      │
               │    │ (sandbox │                      │
               │    │  alive)  │                      │
               │    └────┬─────┘                      │
               │         │                            │
               │    ┌────┴────┐                       │
               │    │         │                       │
               │  warm      user sends                │
               │  window    message                   │
               │  expires   (warm resume)─────────────┘
               │    │
               │    ▼
               │  ┌──────────────┐
               │  │ hibernating  │
               │  │ (scrub +     │
               │  │  snapshot +  │
               │  │  stop sandbox)│
               │  └──────┬───────┘
               │         │ DB transaction succeeds
               │         ▼
               │  ┌──────────────┐
               │  │  hibernated  │
               │  └──────┬───────┘
               │         │ user sends message
               │         ▼
               │  ┌──────────────┐
               └──│  resuming    │────────────────────┘
                  │ (create from │   task starts,
                  │  snapshot)   │   SDK session created
                  └──────────────┘

  [User stops]  → stopped
  [Error]       → failed
  [Snapshot fails during hibernating] → stopped (fallback)
```

### State semantics

| State | Session meaning | Runtime meaning |
|-------|----------------|-----------------|
| `creating` | Session is being set up | Sandbox being provisioned |
| `active` | Task is running, input stream available | Runtime status = `running` |
| `warm` | Task ended, sandbox alive for short window | Runtime status = `warm` |
| `hibernating` | Snapshot in progress | Transitional (no new messages accepted) |
| `hibernated` | Sandbox stopped, snapshot available | Runtime ended |
| `resuming` | New sandbox being created from snapshot | New runtime being created |
| `stopped` | User stopped or snapshot failed | Runtime ended |
| `failed` | Error | Runtime ended |

### Race condition protection

- **Status transitions use compare-and-set** (atomic WHERE clause on current status)
- **Single live runtime enforced in DB** via partial unique index: only one `interactive_session_runtimes` row can be in `creating`, `running`, or `warm` status per session (see schema above)
- Resume acquires a DB lease (sets status to `resuming`) before creating a sandbox
- **If a user message arrives during `hibernating`**: return HTTP 425 (Too Early) with `Retry-After: 5` header. The client retries automatically. Do not queue messages in application memory — hidden in-process queues break under multi-instance deployments.

---

## Hibernation Sequence

The exact sequence for transitioning from warm to hibernated, with failure recovery at every step:

```
1. CAS session status: warm → hibernating
   (If CAS fails, another process is handling it — abort)

2. Credential scrubbing (see Security section)
   - git remote set-url origin <url-without-token>
   - Remove ~/.local/share/opencode/auth.json
   - Remove ~/.local/share/opencode/mcp-auth.json
   - Remove ~/.codex/auth.json

   If scrub fails:
   - Attempt sandbox.stop() to prevent leaking a running sandbox
   - CAS session status: hibernating → stopped
   - Alert on scrub failure (credentials may still be in sandbox state)
   - User can still cold-resume

3. Call sandbox.snapshot()
   (This stops the sandbox automatically. Record the returned snapshotId.)
   Verify snapshot.status is valid (Vercel returns snapshotId, status,
   sizeBytes, sourceSandboxId).

   If snapshot call throws or returns a non-success status:
   - Attempt sandbox.stop() (may be redundant if snapshot partially ran)
   - CAS session status: hibernating → stopped
   - Alert on snapshot failure
   - User can still cold-resume

4. Single DB transaction:
   - INSERT into interactive_session_checkpoints (snapshot_id, ...)
   - UPDATE interactive_sessions SET latest_checkpoint_id = <new checkpoint>,
     status = 'hibernated'
   - UPDATE interactive_session_runtimes SET status = 'stopped',
     ended_at = NOW()

5. If step 4 fails (DB transaction error):
   - The snapshot exists in Vercel but we have no record of it
   - Log the orphan snapshotId to a durable error log / dead-letter table
   - CAS session status: hibernating → stopped
     (fallback — user can still cold-resume)
   - Alert on orphan snapshots for manual reconciliation
```

---

## Security: Snapshot Credential Scrubbing

Vercel snapshots capture the entire filesystem **and environment configuration**. This means sandbox-level env vars present at snapshot time may survive into the restored sandbox. Do not assume env vars are ephemeral across snapshots until verified empirically.

A naive snapshot may contain:

- **Sandbox env vars** — API keys passed via `Sandbox.create({ env })` may be captured in the snapshot's environment configuration
- **Git tokens** — embedded in remote URLs (`https://x-access-token:<token>@github.com/...`)
- **Claude Code OAuth tokens** — written to `~/.claude/` config during login
- **OpenCode auth artifacts** — `~/.local/share/opencode/auth.json` (provider credentials) and `~/.local/share/opencode/mcp-auth.json` (MCP OAuth tokens)
- **Codex auth artifacts** — `~/.codex/auth.json` when file-based credential storage is enabled
- **MCP server tokens** — in agent config files

**Policy**:

1. **Never use agent login flows inside the sandbox.** Do not run `claude login`, `opencode auth`, or `codex login` inside the sandbox. Always inject credentials externally. For Codex automation, use `CODEX_API_KEY` env var rather than persisting account auth on disk.

2. **Never rely on sandbox-level `env` for secrets if snapshots may preserve environment configuration.** If using direct CLI execution (Option B), inject secrets only into the spawned command's environment via `sandbox.runCommand({ env })`, which supports per-command env overrides. This does not solve credentials for sandbox-agent server mode unless sandbox-agent itself gains a safe credential-passing path.

3. **Before snapshotting, scrub known generated credential paths** (see Hibernation Sequence step 2):
   - `git remote set-url origin <url-without-token>`
   - Remove `~/.local/share/opencode/auth.json` and `~/.local/share/opencode/mcp-auth.json`
   - Remove `~/.codex/auth.json`
   - Do **not** glob-delete project `.env` files — these may be repo-owned configuration, not generated secrets. Only remove files that the task explicitly wrote.
   - **Preserve** agent session state directories (`~/.claude/projects/`, `~/.local/share/opencode/`, `~/.codex/sessions/` or `$CODEX_HOME/sessions/`) — these are required for native resume.
   - Review whether `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`) should be preserved or regenerated on restore, especially if it contains MCP or environment-specific settings.

4. **On restore, re-inject fresh credentials** via per-command env or process-level injection, and call `git.configure()` to set the new token in the remote URL.

5. **For multi-tenant BYOK**: credentials are resolved per-session from the secrets table and injected at the process level by the task. They are never persisted in sandbox-level configuration.

---

## Resume Flow: Detailed

### Hot (task still running)

```
User sends message
  → POST /api/interactive-sessions/:id/prompt
  → Session status is "active" with triggerRunId
  → sessionMessages.send(triggerRunId, { action: "prompt", prompt })
  → Task receives via input stream, sends to agent
  → Response streams back via events → Postgres → UI polls
```

No change from current behavior. Same flow for all agents.

### Warm (task ended, sandbox still alive)

```
User sends message
  → POST /api/interactive-sessions/:id/prompt
  → Session status is "warm"
  → Health check: is sandbox-agent server still responding?
    (sandboxManager.reconnect + HTTP health probe to server URL)
  → If yes:
    → CAS status: warm → active
    → Trigger new task with same sandboxId + serverUrl
    → Task reconnects to sandbox, reconnects to sandbox-agent server
    → Server still has session in memory (no replay needed)
    → Sends prompt
  → If no (sandbox or server died unexpectedly):
    → Fall through to hibernate resume path
```

The warm window is enforced by a short `extendTimeout()` (1-3 minutes) set when the task transitions the runtime to `warm` status. No heartbeats, no long grace periods.

### Hibernate Resume (sandbox stopped, snapshot exists)

The flow branches on whether native agent resume (Option A or B) has been implemented:

```
User sends message
  → POST /api/interactive-sessions/:id/prompt
  → Session status is "hibernated"
  → Retrieve latest_checkpoint_id from interactive_sessions
  → Look up snapshot_id from interactive_session_checkpoints
  → CAS status: hibernated → resuming
  → Trigger new task with hibernateSnapshotId + nativeAgentSessionId

Task:
  → Create sandbox from snapshot (filesystem fully restored)
  → Re-inject fresh credentials (per-command env, not sandbox env)
  → Reconfigure git auth (fresh token in remote URL)

  If Option A (upstream sandbox-agent support):
    → Start sandbox-agent server (binary already in snapshot)
    → Call resumeOrCreateSession() with native resume flag
    → Server launches the agent with native resume semantics:
      - Claude: --resume <nativeAgentSessionId>
      - OpenCode: --session <id> --continue
      - Codex: codex resume <nativeAgentSessionId>
    → Session files already on disk from snapshot
    → Send new prompt via SDK

  If Option B (direct CLI bypass):
    → Start sandbox-agent server for event capture only
    → Spawn agent CLI directly with native resume flags via
      sandbox.runCommand({ env }) for per-command credential injection:
      - Claude: claude --resume <id> --dangerously-skip-permissions
      - OpenCode: opencode --session <id> --continue
      - Codex: codex resume <id>
    → Session files already on disk from snapshot
    → Pipe prompt to CLI, capture output via sandbox-agent event stream

  If neither Option A nor B yet (current state):
    → Start sandbox-agent server
    → resumeOrCreateSession() triggers text replay from persist driver
    → Limited by replayMaxEvents/replayMaxChars
    → Send new prompt (degraded but functional)

  → Stream events → Postgres → UI polls
```

**Codex note**: Codex also supports `codex exec resume` for non-interactive automation runs. If we later split interactive and background execution paths, this provides a dedicated resume surface for headless mode.

### Cold Resume (snapshot expired or missing)

```
Same as hibernate resume, but:
  → No snapshot available (expired or never created)
  → Create sandbox from base agent snapshot (pre-installed deps)
  → Clone repo fresh
  → Agent starts with no conversation history (native session files gone)
  → Conversation history is still visible in UI from Postgres (read-only)
  → Optionally inject a structured summary as context (not raw JSON replay)
```

---

## Native Agent Resume Strategy

The critical dependency for true seamless continuation. Ranked by preference:

### Option A: Upstream sandbox-agent support (best)

Request/contribute a change to sandbox-agent where resumed sessions can launch the underlying agent with native resume semantics:

- **Claude**: `claude --resume <session-id>`
- **OpenCode**: `opencode --session <id> --continue`
- **Codex**: `codex resume <SESSION_ID>` with an optional follow-up prompt

The agent's session files are already on disk from the snapshot, so the server just needs to launch the CLI differently.

**Status**: Requires upstream work. File an issue / PR on sandbox-agent.

### Option B: Bypass on resume (fallback)

On snapshot resume, bypass sandbox-agent session restoration and invoke the native agent directly:

1. **Claude**: `claude --resume <id> --dangerously-skip-permissions` via `sandbox.runCommand({ env })`
2. **OpenCode**: `opencode --session <id> --continue` via `sandbox.runCommand({ env })`
3. **Codex**: `codex exec resume <id> --cd <cwd> --json` via `sandbox.runCommand({ env })` — prefer `exec resume` over interactive `resume` because it supports `--json` (JSONL event output), `--cd`, and non-interactive execution, making it a better fit for the Trigger.dev/Postgres event pipeline. Use `CODEX_API_KEY` env var for automation credentials.
4. Use sandbox-agent only for event capture and streaming
5. More control but more code to maintain

**Status**: Implementable today, but increases maintenance surface.

### Option C: Disable replay and hope agents auto-detect (not recommended)

Setting `replayMaxEvents: 0` and hoping agents auto-discover their session files is not a reliable architecture. sandbox-agent documents `replayMaxEvents` and `replayMaxChars` only as replay-size caps — it does **not** document that `0` disables replay entirely. Claude's cross-host resume flow is explicit: restore the session file and resume with the session ID. It does not auto-scan for existing sessions. Codex and OpenCode similarly require explicit session IDs for resume.

**Status**: Do not use as a primary strategy.

---

## UI Architecture: Postgres as Single Source of Truth

### Principle

Chat history is rendered exclusively from Postgres (`sandbox_agent.events` table). The Trigger.dev output stream is used only for control signals (`turnInProgress`, `sessionStatus`, `setupStep`), never for chat item rendering.

### Current (polling)

```
UI loads history from Postgres on mount
While session is active, polls every 2s for new events
Trigger.dev realtime subscription provides turnInProgress/status only
```

This works but feels chunky for real-time interaction.

### Target (event-driven, future work)

```
Events written to Postgres by persist driver
  → NOTIFY on insert (or CDC / logical replication)
  → SSE endpoint forwards committed event IDs to UI
  → UI fetches rows with event_index > lastSeen
```

Or simpler: use the Trigger.dev output stream as the transport for NEW events (deduplicated against Postgres by `(session_id, event_index)` composite key), but always reconcile against Postgres as the source of truth.

### Deduplication key

Events in `sandbox_agent.events` are keyed by `(session_id, event_index)`. The SDK supports durable ordering via `eventIndex`/`sequence` and tracing via `connectionId` and `agentSessionId`. The UI must deduplicate using `(session_id, event_index)`, not by array position or timestamp.

---

## Migration Path

### Phase 0: Stop the bleeding
- Filter replay preamble from `session/prompt` events in `consolidateEvents()` (currently only `agent_message` is filtered)
- Postgres is the only rendered chat source (already in progress via polling)
- Add `UNIQUE(session_id, event_index)` constraint to `sandbox_agent.events` if not already present — verify actual column names from persist-postgres schema first (SDK uses `eventIndex`/`sessionId` in code; SQL column names may differ)

### Phase 1: Data model + stable cwd
- Create `interactive_session_runtimes` table (with partial unique index for single-live-runtime constraint)
- Create `interactive_session_checkpoints` table
- `ALTER TABLE interactive_sessions` to add `native_agent_session_id`, `cwd`, and `latest_checkpoint_id` (in that order — `latest_checkpoint_id` FK requires checkpoints table to exist first)
- Add `warm`, `hibernating`, `hibernated`, `resuming` status values
- Verify whether sandbox-agent's `session.agentSessionId` already equals the native agent session ID (for all three agents: Claude, OpenCode, Codex)
- Migrate existing runtime fields (`sandbox_id`, `trigger_run_id`, etc.) to write to both tables during transition

### Phase 2: Snapshot hibernation
- Add `snapshot()` and `createFromSnapshot()` to `SandboxManager`
- Implement credential scrubbing before snapshot (see Security section — includes Codex-specific paths)
- Implement the full hibernation sequence with failure handling at every step (scrub failure, snapshot failure, DB transaction failure)
- **Empirically verify**: do sandbox-level env vars survive snapshot+restore?
- **Empirically verify**: does `sandbox.snapshot()` capture `~/.claude/`, `~/.local/share/opencode/`, and `~/.codex/`?
- Ensure sandbox-agent server is started as a detached process (not tied to task lifecycle)
- On task end: set runtime to `warm`, extend sandbox 1-3 minutes
- On warm expiry: scrub → snapshot → single DB transaction → `hibernated`
- On resume: health-check sandbox + server, then fall back to snapshot restore
- Benchmark: snapshot creation time, restore latency, snapshot size, first-token latency

### Phase 3: Native agent resume
- Implement Option A (upstream) or Option B (bypass) for native agent resume
- Must work for all three agents: Claude, OpenCode, Codex
- Only after native resume is proven end-to-end, consider shrinking or removing the warm window
- Remove sandbox-agent text replay for resumed sessions

### Phase 4: Cleanup
- Remove long grace period code (`IDLE_GRACE_PERIOD_MS = 30 min`)
- Remove heartbeat interval
- Migrate all runtime state to `interactive_session_runtimes` table
- Remove runtime fields from `interactive_sessions`

---

## Cost Analysis

Exact costs need benchmarking against actual usage. Vercel's published pricing surfaces are currently inconsistent — the docs pricing page and main pricing page show different per-GB-hour rates for provisioned memory. The following is directional only; rely on measured usage and invoices for planning.

| Dimension | How it's billed | Impact |
|-----------|----------------|--------|
| Active CPU | Per CPU-hour; idle/IO-wait excluded | Low — agents spend most time waiting on LLM APIs |
| Provisioned Memory | Per GB-hour, full runtime duration | Main idle cost; eliminated by hibernation |
| Sandbox Creations | Per creation | Negligible |
| Network | Per GB transferred | Moderate — package downloads on cold start, eliminated by snapshots |
| Snapshot Storage | Per GB-month | Small; monitor per-session snapshot sizes |

**Key savings from hibernation**: Eliminating provisioned memory charges during idle time. With a 1-3 minute warm window (instead of 30 minutes), memory cost during the warm pause is minimal before hibernation kicks in and costs drop to zero (plus snapshot storage).

**Key savings from native resume**: Eliminating redundant LLM API costs from context replay. Currently, every resume re-sends conversation history to the LLM. Native resume avoids this entirely.

### Plan limits

| | Hobby | Pro | Enterprise |
|---|---|---|---|
| Max sandbox duration | 45 min | 5 hours | 5 hours |
| Concurrent sandboxes | 10 | 2,000 | 2,000 |
| Snapshot expiration | 30 days default, configurable | Same | Same |

---

## Open Questions

1. **Snapshot env var persistence** — Do sandbox-level env vars (passed via `Sandbox.create({ env })`) survive snapshot+restore? This determines whether we can use sandbox env for credential injection or must use process-level injection only. **Verification step**: create a sandbox with a sentinel env var, snapshot it, restore it, check if the var is present.

2. **Snapshot home directory coverage** — Does `sandbox.snapshot()` capture home directory contents (`~/.claude/`, `~/.local/share/opencode/`, `~/.codex/`)? Vercel says "filesystem and installed packages" + "environment configuration" but does not enumerate scope. **Verification step**: write sentinel files to `/vercel/sandbox`, the user home dir, and the Claude/OpenCode/Codex storage paths, snapshot+restore, check presence.

3. **Snapshot restore latency** — Vercel says "even faster than starting a fresh sandbox" but doesn't give numbers. Need to benchmark on our workload.

4. **`snapshot.snapshotId` vs `snapshot.id`** — Verify the correct property name from the Vercel SDK return type.

5. **Sandbox-agent replay disable** — Does `replayMaxEvents: 0` work? Or does the SDK still inject a preamble? Need to test. (This affects Phase 0 filtering strategy, not the primary architecture.)

6. **Snapshot size growth** — Monitor how snapshot sizes grow over session lifetime (agent-installed packages, generated files, etc.). Set alerts if snapshots exceed a threshold.

7. **`agentSessionId` equivalence** — Verify whether sandbox-agent's `session.agentSessionId` already equals the native Claude/OpenCode/Codex session ID, or if it's a separate abstraction. This determines whether `native_agent_session_id` is a new column or just a copy of an existing field.

8. **Detached server lifetime** — Verify that sandbox-agent server started via `nohup` or similar inside the sandbox survives task teardown. If the sandbox's init system or process supervisor kills orphan processes, the warm tier breaks.

9. **Codex session-state restore** — Verify exactly which files under `~/.codex/` are required for reliable `codex resume <SESSION_ID>` after snapshot restore. At minimum test: `~/.codex/sessions/`, `~/.codex/config.toml`, and that `~/.codex/auth.json` is absent after re-injecting credentials externally.

---

## Future Consideration: Codex-Native Integration

If Codex becomes important enough to justify a dedicated path outside sandbox-agent, OpenAI also exposes Codex-native integration surfaces: the Codex app-server for rich clients and SDK/Agents SDK flows that continue threads by thread ID. This is a bigger architectural fork and not planned for initial implementation, but it is a real alternative if the sandbox-agent abstraction layer becomes a bottleneck for Codex-specific features.

---

## Appendix: Implementation Decisions

Decisions made during detailed design review. These are binding for implementation.

### Architecture & Lifecycle

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Hibernation trigger | Trigger.dev `wait` inside the same task | Free idle time (wait doesn't charge), simpler than scheduled tasks or cron |
| Server detachment | nohup + PID file, health check before reconnect | Simple, no new dependencies |
| Warm resume handoff | Same task continues (no new task trigger) | Lower latency, task already has sandbox/server references |
| SDK session on warm resume | Reuse same in-memory session | Whole point of warm tier — no replay |
| Wait loop design | Single unified loop, timeout changes from long (active) to short (warm) | Simpler than two distinct wait phases |
| Grace period transition | Replace 30-min grace period with warm-wait in Phase 2 (no coexistence) | Clean cut, no dual-behavior period |

### Data & Migration

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Dual-write transition | Write-both, read-old-first until Phase 4 cleanup | Lowest risk, no reader changes until cleanup phase |
| Race protection | CAS handles it (Postgres serializes concurrent CAS on same row) | Already the design, no extra locking needed |
| Server URL persistence | `interactive_session_runtimes.sandbox_base_url` | Fits the data model, readable by API route for cross-task warm resume |
| Credential timing | Always resolve fresh at resume time | Handles key rotation between hibernation and resume |

### Frontend & UX

| Decision | Choice | Rationale |
|----------|--------|-----------|
| UI polling latency | Hybrid: poll 2s + Trigger.dev stream as instant "fetch now" signal | Zero backend changes — UI uses stream arrival as trigger to poll Postgres immediately |
| Stream signal design | Existing output stream as fetch trigger (ignore payload, just use arrival as signal) | Zero backend changes |
| Run status during warm-wait | Use session metadata status (`warm`), ignore Trigger.dev run status | Run may show COMPLETED while task is in warm-wait |
| Warm resume loading state | Optimistic, no spinner — feels like live chat | Input stream is still alive, delivery is instant |
| 425 during hibernating | Client-side retry in handleSubmit with "Saving session state..." message | Browser fetch doesn't auto-retry 425 |
| Resume divider | Detect timestamp gap (>2 min) between consecutive events | No new data needed, derived from existing event timestamps |
| Cold resume context | Defer — no summary for v1 | UI shows full history from Postgres; summary is nice-to-have |

### Phase 0

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Replay filter approach | Filter by content pattern in `consolidateEvents()` | Quick fix, replay events stay in Postgres for debugging |
| Filter target | `session/prompt` events starting with "Previous session history is replayed below" | Matches the exact preamble text, legitimate prompts pass through |

### Resilience & Fallbacks

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Snapshot doesn't capture home dirs | Move agent state into workspace (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) | Makes snapshot scope a non-issue — verify empirically first |
| `CLAUDE_CONFIG_DIR` scope | Verify empirically before building | Critical assumption for hibernate resume |
| Dead sandbox during warm | Health check on next user action, transition to stopped/hibernate | No background cleanup needed |
| Clone strategy | Shallow clone (`--depth=1`) + single worktree | Keeps snapshot size small |

### Sequencing

| Decision | Choice |
|----------|--------|
| Implementation order | Phase 0 first (standalone PR) → Phases 1+2 together → Phase 3 |
