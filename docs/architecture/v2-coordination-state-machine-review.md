# v2 Coordination State Machine — External Review

**Source:** GPT-5.2 Thinking (Heavy) via Oracle, 2026-03-16
**Input:** All 5 architecture docs (proposal, first review, state machine, two-phase waiting, PR review architecture)
**Verdict:** "Good enough to keep, but not yet good enough to implement blindly."

---

## Overall Assessment

The design is now pointed at the right problem and fixes most structural mistakes from the first proposal. The big improvements are real: narrowed authority correctly, added epoch fencing, separated raw agent completion from side effects, made dispatch async with 202 Accepted, and moved migration order to coding tasks first.

What is still missing is not conceptual. It is **operational correctness**.

---

## Three Blockers (Must Fix Before Implementation)

### 1. Fix `callback_inbox` dedupe for HITL

The current unique key `(job_id, attempt_id, epoch, callback_type)` breaks `permission_requested` and `question_requested` — a single attempt can emit multiple callbacks of the same type. Only the first would survive.

**Fix:** Add `callback_id` or `callback_seq` (sandbox-generated). Change inbox dedupe to use that instead of `callback_type`.

Also need:
- Processing decoupled from receipt (drainer for `processed = false` rows)
- Duplicate callbacks return success (so sandbox stops retrying)
- Stale epoch callbacks return terminal "stale lease" response

### 2. Fix review lock correctness

Reviews can take 2-20 minutes. If the lock TTL is 10 minutes (carried from v1), a valid review can lose the lock mid-run and a second review can start.

**Fix:** Either renew lock from progress, or derive "lock held" from the existence of an active nonterminal review job (no TTL).

### 3. Add serialization around prompt dispatch, restore, and snapshot

Multiple race conditions identified:
- **Concurrent send race:** Two API requests can both dispatch prompts before session transitions `idle → active`. Need CAS claim before sandbox dispatch, not after.
- **Snapshot vs prompt race:** Sweeper can snapshot while a prompt arrives. Both need CAS gate on session status.
- **Fast callback race:** Very fast completion can arrive before API persists `accepted`. Transition logic must tolerate `pending → agent_completed`.

---

## Additional Issues (Should Fix Before or During Implementation)

### 4. No explicit human-wait state for HITL

Job stays `running` while agent waits for human permission, but the timeout model doesn't distinguish "agent actively executing" from "agent blocked waiting for human input." These need different timeout behavior.

**Fix:** Add `waiting_human` status on jobs or job_attempts, or a `blocked_reason` + paused timeout model.

### 5. One-shot jobs lack clean fencing

Session epoch works for session-backed jobs. Coding tasks start with a fresh sandbox and may have no interactive_session. `epoch = 1` is not a fencing system.

**Fix:** Use an attempt-scoped lease token for jobs without interactive sessions.

### 6. Side effects need stronger idempotency

If comment posting succeeds but DB update fails, retry can post a second comment.

**Fix:** Either a `job_side_effects` table or `postprocess_attempts`. GitHub comment creation and PR creation need explicit dedupe keys (e.g., `automation_run_id` as idempotency key for the GitHub API call).

### 7. `job_events` table still missing

Called for in first review, still absent. `jobs` and `job_attempts` are not enough to reconstruct timelines cleanly.

**Fix:** Add append-only `job_events` table for every major state transition with correlation IDs.

### 8. Sandbox acceptance semantics undefined

`POST /prompt` is only safe if the sandbox durably records `{jobId, attemptId, epoch}` before returning `202`. Otherwise a network timeout after sandbox accept creates ambiguous state.

**Fix:** Define that 202 means durable accept. Add `GET /attempts/:attemptId` so the API can resolve ambiguous dispatch.

### 9. Cancel semantics undefined

What happens on stop during running, during waiting for permission, and after completion but before postprocess?

**Fix:** Define explicit cancel rules for each state.

### 10. Link turns to jobs

`interactive_session_turns` should have `job_id` and `attempt_id` columns to tie the turn handshake to the job system.

---

## Invariants Assessment

### Good as written
- I1 (one live sandbox per session)
- I2 (epoch monotonically increases)
- I5 (result stored before side effects)
- I7 (credential scrubbing before snapshot)

### Need fixing
- I3 (callback idempotency) — dedupe key is wrong for multi-event callbacks
- I4 (request_id prevents duplicate dispatch) — doesn't serialize concurrent prompts
- I6 (review lock) — unsafe with TTL shorter than review duration

### Should add
- I8: At most one nonterminal prompt job per interactive session
- I9: Snapshot/restore and prompt dispatch are mutually exclusive session mutations
- I10: Every accepted attempt is bound to exactly one fencing token
- I11: Side effects are idempotent per job or automation run
- I12: Completion accepted only after event persistence is flushed

---

## Flow-Specific Issues

### Interactive Prompt
- Concurrent send race (CAS before dispatch, not after)
- Dispatch ambiguity on HTTP timeout (sandbox acceptance must be idempotent by attemptId)
- Stop vs complete race (need defined terminalization rule)
- Fast callback race (tolerate pending → agent_completed)

### PR Review
- Lock expiry during real review (biggest issue)
- Duplicate side effects on retry
- Queued request after failure needs deterministic pickup
- Outdated completion if PR closed/force-pushed during review

### Coding Task
- No clean epoch model for one-shot
- Duplicate PR creation risk
- Sandbox cleanup path not explicit

### HITL
- Inbox dedupe key drops valid callbacks (multiple permissions per attempt)
- Human-wait not modeled (different timeout behavior needed)
- Duplicate/stale replies need single-accept rule keyed by permissionId + epoch

### Sandbox Lifecycle
- Snapshot vs prompt dispatch race
- 5-minute failure detection too slow for active prompts

---

## Sweeper Recommendations

- **5 minutes** for idle snapshot and orphan cleanup (fine)
- **1 minute** for stuck jobs and postprocess retries (add separate cron)
- **In-request liveness** for interactive prompts (progress timestamps or health checks)
- Add `job_attempts.last_progress_at` updated from event persistence path — cheap fast-fail signal

---

## Event Persistence

Keeping Option D (sandbox persist driver writes to Postgres during execution) is the right call for Phase 1.

Two rules to make explicit:
1. Sandbox must not send `prompt_complete` until all prompt events are durably persisted
2. Completion result must be reconstructed from persisted events, not live callback buffers

---

## Postgres-Only Assessment

Acceptable for Phase 1. Do not use "cron plus Postgres rows" as primary delivery/retry mechanism if volume grows. Medium term: add Vercel Queues for dispatch and postprocess delivery, keeping Postgres as coordination source of truth.

---

## Schema Nits

- `postprocess_failed` appears in transition diagram but not in declared `jobs.status` values — add it or remove from diagram
- Use enums or check constraints — don't leave status strings as free text in a design this stateful
- Keep callback payloads compact (Vercel Function body cap: 4.5 MB) — use pointers for large results

---

*References: [Vercel Function Limits](https://vercel.com/docs/functions/limitations), [Vercel Cron](https://vercel.com/docs/cron-jobs/manage-cron-jobs), [Vercel Queues](https://vercel.com/docs/queues/concepts)*
