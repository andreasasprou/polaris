# Architecture v2 Review — External Critique

**Source:** GPT-5.2 Thinking (Heavy) via Oracle, 2026-03-16
**Input:** proposed-architecture-v2.md + 8 current implementation files
**Reviewer prompt:** Critical review of sandbox-as-authority migration proposal

---

## Verdict

The proposal is right about the root problem and wrong about where the simplification really ends.

Moving from a long-lived Trigger.dev task with a persistent ACP connection to **per-prompt, stateless dispatch into the sandbox** is the correct direction. But the proposal risks replacing an explicit workflow engine with a weaker implicit one built out of API routes, a Postgres table, and cron.

---

## 1. Blind Spots and Risks

### A. "Sandbox as authority" is too broad

It is sound for the sandbox to be the authority for **live execution state**: the running agent process, native session state, local filesystem, prompt queue, pending permission requests. It is **not** sound for the sandbox to be the sole authority for **orchestration state**: which attempt is current, whether a callback has been accepted, whether a job is completed, which sandbox lease is valid, which snapshot is the latest committed checkpoint.

The current code already separates some of this correctly:
- `trigger/interactive-session.ts` owns turn handshakes via `createTurn` / `completeTurn` / `failTurn`
- `trigger/continuous-pr-review.ts` owns the review lock and queued-request behavior
- `interactive-session.ts` scrubs credentials before snapshot and uses CAS when hibernating
- `SandboxHealthMonitor.ts` gives fast failure detection during a prompt

Those are not incidental details. They are the hard-earned invariants.

### B. The proposal underestimates how much correctness lives in the current client layer

`SandboxAgentClient.ts` is not just transport glue. It handles:
- Agent-specific fallback behavior when `set_config_option` fails
- Native resume vs text replay
- Ordered output reconstruction from persisted events via `readPersistedOutput()`
- Permission/question replies over raw RPC

Some of that logic must move into the sandbox server.

### C. The health model regresses badly if you replace fast-fail with cron

Today, `SandboxHealthMonitor` aborts hung prompts quickly when the sandbox dies. In the proposal, failure detection drifts toward "callback failed, cron sweep notices later." That is a big regression for user-facing sessions and PR reviews.

Cron on Vercel does **not** retry failed invocations, and overlapping cron runs are possible unless you add your own locking.

### D. Event persistence is the real hard part

The proposal is internally conflicted:
- Section 4 says sandbox persists locally and syncs to Postgres
- Section 8.1 recommends Option D, where the sandbox keeps writing to Postgres during execution

Those are very different architectures. The current clean-output fix depends on persisted ordered events in `readPersistedOutput()`. If persistence semantics change, output parsing for PR review can quietly regress.

### E. Secret lifecycle is glossed over

Current hibernation flow explicitly scrubs credentials before snapshot. The new design still needs to deal with agent API keys, GitHub installation tokens, callback auth tokens, and any DB/event-sync credentials. If the sandbox becomes a more capable authority, secret handling gets harder, not easier.

### F. The proposed job state machine is too shallow

`pending -> dispatched -> running -> completed/failed/timed_out` is not enough. PR review already has a hidden two-stage completion:
1. Agent finishes
2. Parse result, update state, post GitHub comment, complete check run

If the callback handler both ingests the result and performs GitHub side effects inline, one retry or timeout can duplicate comments. Need separate states:
- `accepted`
- `running`
- `agent_completed`
- `postprocess_pending`
- `completed`
- `failed_retryable`
- `failed_terminal`

---

## 2. Is Sandbox-as-Authority Sound?

**Yes, with a narrower definition. No, as a blanket rule.**

The good version is an **actor model**:
- One sandbox per session
- One command queue per session
- Commands carry idempotency keys
- Sandbox emits events into an append-only journal / outbox
- Postgres tracks the current valid **lease epoch**
- Every callback / event sync includes that epoch
- Old sandboxes are fenced off

### Failure Modes Not Addressed

1. **Zombie sandbox after restore** — API decides sandbox A is dead, restores sandbox B, but A was just partitioned. Now both think they own the session.
2. **Duplicate prompt execution** — User retries or API retries a `POST /prompt`; sandbox runs it twice unless prompt dispatch is idempotent.
3. **Duplicate or stale completion callback** — Sandbox A finishes after sandbox B already took over. Old completion arrives late and overwrites good state.
4. **Local durability gap** — Sandbox accepts prompt, starts running, then dies before syncing enough state to recover cleanly.
5. **Split authority over events** — UI cursor is from DB, sandbox has newer local events, restore happens, cursor continuity breaks.

**Rule: Use sandbox-as-authority for execution, but keep Postgres as authority for coordination, leases, and committed user-visible state.**

---

## 3. Callback Pattern Robustness

The Phase 1 REST endpoint says `POST /api/sessions/:id/prompt` → "send prompt, return when complete." That endpoint contract is wrong for the final architecture.

With Vercel Fluid Compute, Node functions default to 300s and max out at 800s on Pro/Enterprise. Vercel will terminate the request if it exceeds the configured duration.

Correct contract:
- `POST /prompt` durably **accepts** the command
- Returns `202 Accepted` quickly with `turnId`, `jobId`, `epoch`
- Sandbox executes asynchronously
- Sandbox sends progress events separately
- Sandbox sends an idempotent completion callback later

### Edge Cases to Design Explicitly

- **Dispatch accepted twice** — Fix with `idempotency_key` on prompt API plus per-session mutex
- **Callback lost** — Fix with sandbox outbox plus sweeper that reconciles unacked completions
- **Callback duplicated** — Fix with `callback_inbox` table keyed by `(job_id, attempt, epoch)`
- **Callback arrives from stale sandbox** — Fix with lease epoch fencing
- **Completion payload too large** — Vercel function payloads capped at 4.5 MB. Send metadata and a pointer, not huge event batches.
- **Post-completion side effects fail** — Do not post GitHub comments inside the callback acceptance path. Ingest the result first, then enqueue post-processing.
- **Stop / permission reply races** — Interactive sessions still need a live control channel into the running prompt. Need an equivalent to current `.on()` handler.

---

## 4. Observability Gap

**Serious enough that you should treat it as first-class migration work, not cleanup.**

Vercel runtime logs: Pro retains 1 day, Enterprise 3 days, unless you pay for Observability Plus. Per-request log size and line limits apply.

### Minimum Viable Replacement

1. **`job_events` append-only timeline** — Every major state transition, with correlation IDs
2. **`job_attempts` table** — One row per execution attempt, not just one row per job
3. **`sandbox_leases` or `session_epoch` field** — Reason about ownership
4. **`callback_inbox` and `callback_outbox`** — Make retries and duplicates safe
5. **Structured logs with stable correlation IDs** — `sessionId`, `jobId`, `attempt`, `epoch`, `sandboxId`, `requestId`
6. **Small internal admin UI** — Session timeline, attempts, current lease owner, callbacks, snapshot ref
7. **External log retention** — Forward logs using Vercel Drains or another sink

---

## 5. Migration Ordering (Revised)

**Interactive first is the wrong risk order.** Proposed revision:

| Phase | What | Why |
|-------|------|-----|
| 1 | Sandbox REST wrapper + keep current event persistence | Lowest-change bridge, Option D from Section 8.1 |
| 2 | Migrate **coding tasks** first | Simplest case: no HITL, no resume, no chat continuity. Safest canary. |
| 3 | Migrate **PR review** | Has durable queueing and clear job boundaries, fewer latency expectations than chat |
| 4 | Migrate **interactive sessions** last | Hardest: long-running execution, resume, streaming, stop, permissions, human latency |
| 5 | Remove Trigger.dev only after dual-run confidence | Do not remove rollback path until confident in leases, callbacks, cleanup, observability |

### What Could Go Wrong at Each Phase

- **REST wrapper:** Underestimating auth, idempotency, and command queueing inside sandbox
- **Coding tasks:** Duplicate PRs, lost results, Git token expiry mid-run
- **PR review:** Duplicate comments, stale check runs, broken pending queue, ambiguous post-processing failure
- **Interactive:** Regressions in stop, permission replies, restore, event cursor continuity
- **Trigger removal:** You discover too late that your cron + DB state machine is a worse workflow engine

**Note:** Vercel Queues is now a much closer fit than "Postgres jobs + cron sweep" — it gives at-least-once delivery, retries, visibility timeouts, and queue observability inside the same platform.

---

## 6. Patterns from Similar Systems

### Separate interactive and background agent modes
GitHub Copilot: agent mode is synchronous/interactive; coding agent runs asynchronously in GitHub Actions, updating a draft PR as it works. Strong signal not to force one runtime model for everything.

### Plan before execution
Cursor's long-running agents explicitly propose a plan and wait for approval. Argues for a first-class `planned -> approved -> executing` path on larger jobs.

### Prepared workspaces and indexed context
Devin separates repo understanding and planning from execution. Indexes codebase in background, starts sessions from prepared workspaces/saved machine states. Maps well to existing snapshot strategy.

### Rules, memory, and workflow artifacts
GitHub supports repository custom instructions. Windsurf emphasizes rules, workflows, memories, and multiple parallel agents. Keep repo-level instructions, per-session memory, and reusable workflow artifacts separate from transport and lifecycle concerns.

### Reflection and validation loops
Replit Agent tests and fixes its own work in a reflection loop; users keep working while the agent builds in the background. The execution harness should make validation easy, not just dispatch easy.

---

## 7. Biggest Risk

**Split-brain ownership between sandbox and database.**

If you remove Trigger and do not replace it with lease epochs, idempotent command acceptance, idempotent callback ingestion, and an outbox/inbox model, every rare network flap becomes one of:
- Duplicate prompt execution
- Duplicate PR comments
- Lost turn completions
- Zombie sandboxes still writing events
- Restored sessions overwritten by stale callbacks

The second biggest risk: you spend three months deleting Trigger, then rebuild half of it as ad hoc Postgres tables, cron sweepers, and one-off reconciliation code.

---

## Recommendation

Keep the architectural direction, but tighten the contract:

1. **Sandbox is execution authority, Postgres is coordination authority**
2. **`POST /prompt` only accepts work; it never waits for completion**
3. **Use lease epochs and fencing tokens everywhere**
4. **Make callback ingestion idempotent and separate it from GitHub side effects**
5. **Use cron only as a sweeper. Prefer Vercel Queues for retries and visibility.**
6. **Migrate coding tasks first, interactive last**
7. **Do not remove Trigger until you have the replacement observability**

### Next Artifact to Write

A revised v2 state machine with these fields: `session_epoch`, `job_attempts`, `callback_inbox`, `callback_outbox`, `sandbox_lease_owner`, and explicit `agent_completed` vs `postprocess_pending` states.

---

*References: [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Vercel Function Limits](https://vercel.com/docs/functions/limitations), [Vercel Runtime Logs](https://vercel.com/docs/logs/runtime), [Vercel Drains](https://vercel.com/docs/drains), [Vercel Queues](https://vercel.com/docs/queues/concepts), [GitHub Copilot Agent Mode](https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/), [Cursor Long-Running Agents](https://cursor.com/blog/long-running-agents), [Devin Ask Mode](https://docs.devin.ai/work-with-devin/ask-devin), [GitHub Custom Instructions](https://docs.github.com/copilot/customizing-copilot/adding-custom-instructions-for-github-copilot), [Replit Agent](https://replit.com/products/agent)*
