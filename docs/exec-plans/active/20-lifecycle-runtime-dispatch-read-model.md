---
title: Lifecycle, Runtime, Dispatch, and Session Read Model Refactor
status: planned
created: 2026-03-21
owner: andreas
related_prs: []
domains: [sessions, jobs, orchestration, sandbox-proxy, automations, ui, architecture]
---

# 20 — Lifecycle, Runtime, Dispatch, and Session Read Model Refactor

## Problem
### What
The architecture documents describe a clean split between session state, job coordination, sandbox runtime state, proxy transport, and UI presentation. `docs/architecture/00-what-is-polaris.md` further clarifies that Polaris should evolve toward a **task-centric** cloud agent platform where the current `interactive_session` becomes a **continuation primitive**, not the top-level product noun.

The current implementation still re-implements those boundaries ad hoc:

- session/job/attempt transitions are open-coded in routes and orchestrators
- runtime identity is split between `interactive_sessions` and `interactive_session_runtimes`
- prompt dispatch logic is duplicated across interactive prompts, PR review, and sweeper retry
- the proxy/API contract exists in docs and code, but the actual transport fields have drifted
- job-type behavior lives in `switch (job.type)` branches with untyped payload/result casts
- the session UI reconstructs polling, status capabilities, and transcript state on the client

### Why
This is the main reason the codebase feels home-made: the primitives exist, but they are not the only allowed path. The result is drift, repeated edge-case fixes, brittle state transitions, and presentation code that compensates for backend seams. It also makes future agent-assisted changes riskier because the intended flow is not enforced structurally.

This refactor is therefore not just cleanup. It is the control-plane hardening step required before Polaris can safely add a first-class `Task` layer, richer `Environment` modeling, and task/run/artifact-oriented product surfaces.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-21 | Treat this as a 5-wave program, not one PR | Each wave changes a distinct abstraction boundary and should be reviewable on its own |
| 2026-03-21 | Keep low-level `cas*Status` DB helpers, but route all semantic transitions through lifecycle services | Preserve the efficient DAL while centralizing business transitions |
| 2026-03-21 | Make `interactive_session_runtimes` the authority for live runtime identity | Runtime identity is ephemeral execution state, not canonical conversation state |
| 2026-03-21 | Use additive dual-read/dual-write before removing legacy session runtime columns | Existing sessions and routes need a no-downtime migration path |
| 2026-03-21 | Introduce a shared protocol module with Zod schemas for proxy requests/responses/callbacks | The transport contract must be executable and shared, not duplicated in prose |
| 2026-03-21 | Remove semantic fields from the wire contract (`modeIntent`, `effortLevel`) and send only resolved transport config | Semantic agent selection belongs in agent-profile resolution, not in the sandbox transport |
| 2026-03-21 | Replace job-type branching with a registry of typed job specs | Retry, postprocess, and failure cleanup are job semantics and need one extension point |
| 2026-03-21 | Move transcript projection and session capability derivation to server-side read models | UI should render projected state, not reconstruct orchestration facts from raw events |
| 2026-03-21 | Do not add TanStack Query in this program | The missing abstraction is the app-specific read model/polling layer, not a generic cache library |
| 2026-03-21 | Treat this program as control-plane hardening, not the introduction of a new top-level `Task` aggregate | The current repo already has strong session/runtime/job/attempt primitives; this wave sequence makes them disciplined enough to support the later task-centric product model |
| 2026-03-21 | Interpret `interactive_session` as a future continuation/session primitive when making new abstractions | New APIs and read models should avoid deepening the mistake that a session is the top-level product noun |

## North-Star Alignment

This plan should be read together with `docs/architecture/00-what-is-polaris.md`.

The relationship is:

- the north-star doc defines **what Polaris is becoming**
- this exec plan defines **which control-plane refactors are required to get there safely**

In north-star terms:

- current `jobs` / `job_attempts` are the closest existing primitives to future **runs** / **attempts**
- current `interactive_session_runtimes` are the beginning of future **environment** modeling
- current `interactive_sessions` should be treated as future **continuation sessions**

This program deliberately does **not** introduce a first-class `Task` aggregate yet. That is a follow-on program after these control-plane seams are hardened.

## Target State

### Invariants

- No route, orchestrator, or callback processor imports `casSessionStatus`, `casJobStatus`, or `casAttemptStatus` directly outside lifecycle services and tests.
- No module except the shared prompt executor posts to sandbox proxy `POST /prompt`.
- No UI component or page derives poll intervals or capabilities from raw status strings.
- No UI component consolidates raw sandbox-agent events directly.
- All prompt-like execution paths (`prompt`, `review`, sweeper retry) use the same executor and the same typed proxy envelope.
- All job-specific behavior is owned by a `JobSpec` implementation, not by `switch (job.type)` branches.
- Any new code added during this program treats `interactive_session` as a continuation/session boundary, not as the permanent top-level product noun.
- Review-specific pre-dispatch concerns that already exist today — repo-config-as-code loading, runtime-drift continuity policy, and review prompt construction — remain explicit domain concerns and are not pushed into the generic executor.

### Program Shape

Ship this as five sequential waves, preferably six PRs:

1. Lifecycle services + current runtime authority (`W1a` + `W1b`)
2. Shared prompt executor + typed proxy contract
3. Job spec registry
4. Session read model + transcript projection + session UI migration
5. Cleanup, legacy removal, and enforcement

Do not start Wave 3 before Wave 2 lands, and do not remove legacy session runtime columns before Wave 4 consumers have fully switched to the read model.

### Recommended PR Boundaries

Use these as the default handoff slices:

| PR | Scope | Must Land Before |
|----|-------|------------------|
| PR1 (`W1a`) | lifecycle services + lifecycle tests + route/orchestration migration away from raw CAS helpers | all later PRs |
| PR2 (`W1b`) | current-runtime gateway + dual-read/dual-write + runtime call-site migration | PR3+ |
| PR3 (`W2`) | shared protocol module + proxy client + prompt executor + callback decoding migration | PR4+ |
| PR4 (`W3`) | job-spec registry + postprocess/sweeper migration to specs | PR5+ |
| PR5 (`W4`) | session read model + transcript projector + session detail UI migration | PR6 |
| PR6 (`W5`) | cleanup, enforcement, migration gate, and legacy column removal | final |

Review rule: do not mix two rows from this table into one PR unless a dependency forces it. The handoff assumption is one reviewer-friendly PR per row.

## Implementation

### Wave 1 — Lifecycle Services and Current Runtime Authority

**Goal:** make continuation-session lifecycle transitions and runtime ownership explicit, centralized, and reusable.

Treat this wave as two sub-phases/PRs:

- **W1a — lifecycle services + tests**
- **W1b — current-runtime gateway + call-site migration**

**Create in W1a**

- `lib/orchestration/lifecycle/session-lifecycle.ts`
- `lib/orchestration/lifecycle/job-lifecycle.ts`
- `lib/orchestration/lifecycle/attempt-lifecycle.ts`

**Create in W1b**

- `lib/sessions/current-runtime.ts`

**Keep as low-level DAL only**

- `lib/sessions/actions.ts`
- `lib/jobs/actions.ts`

These files remain thin table/query helpers. They may still expose `cas*Status`, but those functions are no longer imported by routes or orchestration entrypoints once this wave is complete.

**Session lifecycle service responsibilities**

For the purpose of this wave, “session lifecycle” means the lifecycle of the current **continuation-session** primitive, not the final top-level task model.

- `reconcileForRead(sessionId, source)` — replaces ad-hoc “active but no live job” healing in API GET handlers and dispatch entrypoints
- `beginDispatch(sessionId, allowedFromStatuses)` — the only supported session activation path
- `completeDispatch(sessionId, metadata)` — clears active state on success and persists session identifiers atomically
- `failDispatch(sessionId, metadata)` — clears active state on failure/cancel and persists partial identifiers when present
- `stopCurrentTurn(sessionId)` — encapsulates the current-turn stop path
- `terminateSession(sessionId)` — encapsulates hard-stop termination, sandbox destruction, and job cancellation
- `beginSnapshot(sessionId)` / `snapshotFailed(sessionId)` / `snapshotCompleted(sessionId)` — centralize snapshot transition semantics used by sandbox lifecycle code

`reconcileForRead()` is intentionally a side-effecting read path. When it heals stale state it must emit an evlog event with:

- `sessionId`
- `source` (`session_get`, `prompt_dispatch`, `pr_review_dispatch`, etc.)
- `previousStatus`
- `nextStatus`
- `activeJobFound`
- `reason` (`active_without_live_job`)

**Job/attempt lifecycle service responsibilities**

- wrap accepted/running/completed/failed/cancelled transition sequences
- record job events at the same boundary as state changes
- own “fast callback race” tolerance (for example `pending -> agent_completed`)
- make retry ownership explicit instead of open-coding CAS arrays in callback and sweeper paths

**Current runtime gateway responsibilities (W1b)**

- `getCurrentRuntime(sessionId)` returns the live runtime row if present; if none exists, it falls back to the legacy runtime fields on `interactive_sessions`
- `replaceCurrentRuntime(sessionId, runtimeInput)` ends stale live runtimes, creates the new runtime row, and dual-writes legacy session columns during the migration period
- `closeCurrentRuntime(sessionId, status, endedAt)` ends the live runtime row and clears legacy session runtime fields during the dual-write period
- `getRuntimeBackedSessionPointers(sessionId)` becomes the single read path for `sandboxId`, `sandboxBaseUrl`, `sdkSessionId`, and `nativeAgentSessionId`

**Refactor call sites**

- `app/api/interactive-sessions/[sessionId]/route.ts`
- `lib/orchestration/prompt-dispatch.ts`
- `lib/orchestration/pr-review.ts`
- `lib/orchestration/sweeper.ts`
- `lib/orchestration/callback-processor.ts`
- `lib/orchestration/sandbox-lifecycle.ts`

Each of these should call lifecycle services/current-runtime helpers instead of performing raw CAS operations and session runtime reads inline.

**Wave gate**

- W1a may land with legacy runtime reads still in place.
- W1b must not start until W1a lifecycle services and tests are merged.
- After W1b, all non-test runtime identity reads go through `lib/sessions/current-runtime.ts`.

**Migration rule**

- Do **not** backfill every historical session runtime row in this wave.
- Use dual-read/dual-write first.
- Only nonterminal sessions with active legacy runtime fields need backfill before Wave 5 column removal.

**Tests**

- unit tests for lifecycle service transitions, including stale-active healing, stop vs terminate, and snapshot transition failures
- unit tests for current-runtime fallback and dual-write behavior
- integration tests for GET/DELETE session API paths using lifecycle services

**PR exit criteria**

- **PR1 / W1a** exits with lifecycle services introduced and raw CAS usage removed from the primary route/orchestration call sites even if runtime reads are still legacy-backed
- **PR2 / W1b** exits with non-test runtime identity reads routed through `lib/sessions/current-runtime.ts`

### Wave 2 — Shared Prompt Executor and Typed Proxy Contract

**Goal:** make prompt dispatch one reusable run-execution pipeline with one shared transport contract.

**Create**

- `lib/protocol/sandbox-proxy.ts`
- `lib/orchestration/prompt-executor.ts`
- `lib/orchestration/proxy-client.ts`

**Update**

- `eslint.config.mjs` to treat `lib/protocol/**` as a foundation layer importable by platform and proxy code
- `lib/sandbox-proxy/types.ts` to re-export from the protocol module or delete it if the protocol module fully replaces it
- `docs/architecture/v2-protocol-contract.md` so the document becomes explanatory and explicitly points to `lib/protocol/sandbox-proxy.ts` as the normative contract

**Protocol module requirements**

Implement Zod schemas and exported TS types for:

- `PromptRequest`
- `PromptAcceptedResponse`
- `PromptConflictResponse`
- `PromptErrorResponse`
- `CallbackEnvelope` discriminated by `callbackType`
- typed payloads for `prompt_accepted`, `prompt_complete`, `prompt_failed`, `permission_requested`, `question_requested`, `permission_resumed`, and `session_events`

**Wire contract cleanup**

Remove semantic agent-selection fields from the prompt transport:

- remove `modeIntent`
- remove `effortLevel`

Keep only resolved transport fields:

- `agent`
- `mode`
- `model`
- `thoughtLevel`
- `cwd`
- `sdkSessionId`
- `nativeAgentSessionId`
- `nextEventIndex`
- `env`
- `mcpServers`
- `branch` if still needed by the proxy path

The only module allowed to resolve semantic agent intent remains `lib/sandbox-agent/agent-profiles.ts`.

**Prompt executor responsibilities**

- reconcile/read the session through lifecycle services
- resolve current runtime through `lib/sessions/current-runtime.ts`
- health-check the runtime-adjacent proxy
- provision or restore a sandbox if needed
- create or reuse the job/attempt boundary supplied by the caller
- compute resume fields (`sdkSessionId`, `nativeAgentSessionId`, `nextEventIndex`)
- carry fully resolved tool/runtime transport inputs such as MCP server configuration
- POST the typed prompt envelope through `proxy-client.ts`
- normalize outcomes into `accepted`, `failed`, and `dispatch_unknown`
- invoke lifecycle services for rollback and timeout ownership

This executor is the main bridge from the current codebase into the future **run** abstraction described in `docs/architecture/00-what-is-polaris.md`.

**Executor outcome contract**

The executor must return an explicit discriminated union and own rollback semantics per outcome:

```ts
type PromptExecutionOutcome =
  | { kind: "accepted"; jobId: string; attemptId: string }
  | { kind: "failed"; jobId: string; attemptId?: string; rollbackComplete: true; error: string }
  | { kind: "dispatch_unknown"; jobId: string; attemptId: string; sweeperOwnsRecovery: true };
```

Ownership rules:

- **`accepted`** — prompt was durably handed to the proxy; lifecycle remains active and callback processing owns subsequent completion/failure
- **`failed`** — dispatch definitively failed before durable handoff or received a definitive non-`202`; executor must already have completed rollback for session/job/attempt state before returning
- **`dispatch_unknown`** — handoff outcome is uncertain (for example HTTP timeout after request write); executor must mark the attempt `dispatch_unknown`, must not roll back active ownership, and the sweeper becomes the sole recovery owner

**API shape**

Use one executor API for all prompt-like flows:

```ts
type PromptExecutionRequest = {
  sessionId: string;
  requestKind: "interactive_prompt" | "review_dispatch" | "review_retry";
  prompt: string;
  contextFiles?: ContextFile[];
  attachments?: PromptAttachment[];
  resolvedAgentConfig: ResolvedAgentConfig;
  jobBinding: NewJobBinding | ExistingJobBinding;
};
```

The executor must support both:

- **new job** flows (`prompt`, initial `review`)
- **existing job + new attempt** flows (sweeper retry)

**Refactor call sites**

- `lib/orchestration/prompt-dispatch.ts` becomes a thin adapter that validates the interactive prompt request and delegates to the executor
- `lib/orchestration/pr-review.ts` keeps review-domain preparation responsibilities that already exist today — repo-config loading/merge, runtime-coherence validation, credential-slug resolution, runtime-drift session selection, diff/guideline gathering, and review prompt construction — then delegates the actual dispatch to the executor
- `lib/orchestration/sweeper.ts` delegates review retry dispatch to the same executor instead of recreating the POST flow
- `app/api/callbacks/route.ts` validates and decodes the callback body through the shared Zod schemas before invoking orchestration
- `lib/orchestration/callback-processor.ts` accepts typed `CallbackEnvelope` input instead of `Record<string, unknown>` callback payloads

**Additional cleanup in this wave**

- remove duplicated callback URL helpers and use `getCallbackUrl()` directly or via one thin helper in `lib/config/urls.ts`
- move callback type ownership out of `lib/jobs/status.ts`; job status and transport callback names are different domains

**Tests**

- unit tests for protocol schemas and proxy-client response parsing
- unit tests for prompt executor accepted/failed/timeout branches
- integration tests for interactive prompt dispatch, review dispatch, and sweeper retry through the executor
- rebuild the proxy bundle as part of the validation path for any change under `lib/sandbox-proxy/`

**PR exit criteria**

- all prompt-like dispatch paths use `prompt-executor.ts`
- callback request bodies are decoded through shared schemas before reaching orchestration logic
- no transport caller sends semantic config fields that should have been resolved platform-side

### Wave 3 — Typed Job Spec Registry

**Goal:** move all current run-type semantics behind one registry instead of branching across postprocess and sweeper.

**Create**

- `lib/orchestration/job-specs/types.ts`
- `lib/orchestration/job-specs/index.ts`
- `lib/orchestration/job-specs/prompt.ts`
- `lib/orchestration/job-specs/review.ts`
- `lib/orchestration/job-specs/coding-task.ts`

**Registry contract**

```ts
type JobSpec<TPayload, TResult> = {
  type: JobType;
  payloadSchema: z.ZodType<TPayload>;
  resultSchema: z.ZodType<TResult>;
  postprocess(job: JobRow, payload: TPayload, result: TResult): Promise<void>;
  retry(job: JobRow, payload: TPayload, attemptNumber: number): Promise<void>;
  finalizeFailure(job: JobRow, payload: TPayload): Promise<void>;
  deriveTimeline(input: TimelineInput): TimelinePhase[];
};
```

**Responsibilities by spec**

- `prompt` — no-op postprocess, no retry-specific cleanup beyond generic lifecycle handling
- `review` — owns retry dispatch, review lock cleanup, check failure, queued-review drain, stale/inline review lifecycle, inline comment-map tracking, runtime-config continuity metadata, and timeline phase derivation for review jobs
- `coding_task` — owns commit/push/PR creation postprocess and terminal failure cleanup for automation runs

**Refactor existing orchestration**

- replace `switch (job.type)` in `lib/orchestration/postprocess.ts`
- replace `if (job.type === "review")` branching in `lib/orchestration/sweeper.ts`
- parse `job.payload` and `job.result` through each spec’s schema before using them
- move retry/final-failure logic out of sweeper branches and into the job spec implementations

**Unused job types**

- keep `snapshot` and `pr_create` as explicit unsupported placeholders unless an active code path is introduced during this program
- do **not** silently branch around them
- if they remain in `JOB_TYPES`, register a placeholder spec that throws a clear “unsupported job spec” error and add a test so future work must implement them intentionally

**Tests**

- unit tests for each spec’s payload/result schema
- unit tests for registry lookup and unsupported job types
- integration tests for review postprocess and coding-task postprocess through the registry entrypoint

**PR exit criteria**

- `lib/orchestration/postprocess.ts` no longer switches on `job.type`
- `lib/orchestration/sweeper.ts` no longer branches on review-specific retry/finalization logic outside job specs

### Wave 4 — Session Read Model, Transcript Projector, and Session UI Migration

**Goal:** make the current continuation-session UI consume projected state from the server rather than reconstructing orchestration state on the client.

This wave is intentionally **not** the final task/run information architecture. It is a server-side read-model cleanup that stops the current session-first UI from deriving domain state client-side and positions the UI for a later task-centric layer.

**Create**

- `lib/sessions/read-model.ts`
- `lib/sessions/transcript-projector.ts`
- `hooks/use-polling-resource.ts`
- `hooks/use-session-detail.ts`
- `hooks/use-session-transcript.ts`
- `app/api/interactive-sessions/[sessionId]/transcript/route.ts`

**Refactor**

- `app/api/interactive-sessions/route.ts`
- `app/api/interactive-sessions/[sessionId]/route.ts`
- `app/(dashboard)/sessions/page.tsx`
- `app/(dashboard)/sessions/[sessionId]/page.tsx`
- `app/(dashboard)/runs/[runId]/page.tsx`
- `components/sessions/session-chat.tsx`
- `components/status-badge.tsx`
- `components/sessions/session-status.tsx`
- `hooks/use-session-chat.ts` (replace or delete)
- `hooks/use-session-events.ts` (delete)
- `lib/sandbox-agent/event-types.ts`

**Read-model responsibilities**

`buildSessionDetailView(sessionId, organizationId)` returns one server-side view model with:

- canonical session row
- derived continuation role (`user_interactive`, `review_continuation`, `automation_continuation`)
- current runtime pointers
- latest active/recent job summary
- derived session capabilities (`canSend`, `canStop`, `isTerminal`, `showInPrimarySessionsList`)
- derived interaction policy (`readOnly` vs `interactive`)
- transcript presentation mode (`full` vs `preview`)
- `pollIntervalMs`
- derived timeline state
- any banner/error state the page needs

`buildSessionTranscriptView(sessionId, organizationId, filters?)` returns:

- projected transcript items ready to render
- `turnInProgress`
- latest usage/cost summary
- pending permission/question state
- `nextPollIntervalMs`
- supports a preview/snippet mode for embedding session context into run/task pages without dumping the full history inline

`buildSessionListView(organizationId, options?)` returns:

- primary continuation sessions for the Sessions UI
- excludes non-user continuations by default or marks them explicitly as system/read-only when an include-system mode is requested
- enough summary metadata for the list to explain why a session is or is not directly interactive

These are still session-oriented read models because they are replacing existing session pages. They should be written in a way that can later compose into task/run/environment read models rather than hard-coding “session is the top-level object” assumptions.

**Transcript projector responsibilities**

Split parsing from projection:

- `lib/sandbox-agent/event-types.ts` (or a renamed sibling) becomes parsing-only
- `lib/sessions/transcript-projector.ts` owns all projection rules used by the UI

This is a **projector rewrite**, not a thin wrapper around `consolidateEvents()`.

- treat the current `consolidateEvents()` behavior as the reference semantics to preserve
- port its existing behavior into dedicated regression fixtures/tests first
- implement the new projector as a new pure function
- switch server-side transcript building to the new projector
- delete or deprecate `consolidateEvents()` only after the new projector passes the ported regression suite

The projector must own:

- replay preamble suppression
- duplicate-prompt suppression
- interrupted-turn closure on resume and terminal state
- tool call / HITL state accumulation
- final usage extraction
- terminal cleanup for pending HITL items

Do not leave any of those rules in client hooks after this wave.

**Client polling/data-fetching primitive**

Because the repo does not currently have `useQuery`, add a small app-specific polling primitive:

- `hooks/use-polling-resource.ts` built on `useSyncExternalStore`
- one cache entry per URL/resource key
- each resource owns its own fetcher, polling interval, and manual refresh
- timers are keyed by the view-model-derived `pollIntervalMs`

This is the only new client-side data primitive introduced in the program. Do not add TanStack Query in this wave.

**API changes**

- `GET /api/interactive-sessions` returns a role-aware session list view; by default it only includes primary user-interactive sessions and supports an explicit include-system/debug mode if needed
- `GET /api/interactive-sessions/[id]` returns `SessionDetailView`, not a near-raw `session`
- add `GET /api/interactive-sessions/[id]/transcript`
- the transcript endpoint supports preview/snippet parameters for embedding in run/task pages
- keep `/api/sessions/[sdkSessionId]/events` as an internal/debug endpoint; the session detail page should stop using it directly

**UI migration**

- `app/(dashboard)/sessions/page.tsx` should render only primary user-interactive sessions by default; review/automation continuations should be hidden or clearly marked behind an explicit system/debug affordance
- `app/(dashboard)/sessions/[sessionId]/page.tsx` should load `SessionDetailView` and `SessionTranscriptView` via the new hooks
- the page should not compute poll interval or capabilities from `getStatusConfig`
- the chat rendering layer should only render projected `TranscriptItem[]`
- the session detail page should suppress the prompt input and render a read-only transcript when `SessionDetailView` marks the continuation as non-interactive
- `app/(dashboard)/runs/[runId]/page.tsx` should consume transcript preview/snippet data instead of rendering the entire continuation transcript inline; it should link out to the full continuation page when the user needs complete history

**Tests**

- unit tests for transcript projection edge cases (resume replay, duplicate prompt cycles, interrupted tools, pending HITL at terminal state)
- regression fixtures ported from current `consolidateEvents()` behavior before swapping the UI to the projector
- route tests for the new detail/transcript view endpoints
- route tests for primary session list filtering / system-session inclusion
- browser verification of active, completed, failed/stopped, hibernated/resumed, and HITL states using the new view models
- browser verification that review/automation continuations are read-only and do not show a prompt box
- browser verification that run detail pages render only transcript previews with a link to the full continuation

**PR exit criteria**

- the session detail page consumes only `SessionDetailView` and `SessionTranscriptView`
- the old direct event-fetching path is no longer used by the session detail page
- transcript projection rules live server-side, not in client hooks
- non-user continuation sessions are modeled explicitly in the session read model and do not present as user-chat sessions by default

### Wave 5 — Cleanup, Legacy Removal, and Enforcement

**Goal:** remove migration scaffolding and make the new abstractions enforceable.

**Schema/data cleanup**

- backfill nonterminal sessions that still rely on legacy runtime columns and have no live runtime row
- remove fallback reads from `lib/sessions/current-runtime.ts`
- drop `interactive_sessions.sdk_session_id`, `interactive_sessions.sandbox_id`, and `interactive_sessions.sandbox_base_url` once all readers are migrated

Before dropping legacy runtime columns, add and run a migration gate script:

- `scripts/check-session-runtime-migration.ts`

It must fail if any row matches this invariant violation:

```sql
SELECT s.id
FROM interactive_sessions s
WHERE (
  s.sdk_session_id IS NOT NULL
  OR s.sandbox_id IS NOT NULL
  OR s.sandbox_base_url IS NOT NULL
)
AND NOT EXISTS (
  SELECT 1
  FROM interactive_session_runtimes r
  WHERE r.session_id = s.id
    AND r.status IN ('creating', 'running', 'idle')
);
```

The column-drop PR must not merge until this script returns zero rows in production-shaped data.

**Code cleanup**

- delete superseded hooks (`use-session-events`, old `use-session-chat` if still present)
- delete legacy helper paths that only existed to support the pre-executor flow
- reduce dynamic imports that were only hiding coupling; keep them only for legitimate environment or heavy-dependency boundaries

**Enforcement**

- extend lint/architecture checks so only lifecycle service modules may import raw `cas*Status` helpers
- extend architecture checks so only `prompt-executor.ts` / `proxy-client.ts` may call sandbox proxy `POST /prompt`
- update dependency checks to treat `lib/protocol/**` as foundation and prevent accidental upward imports

**Docs**

- update `ARCHITECTURE.md` module map and request lifecycle traces
- keep `docs/architecture/00-what-is-polaris.md` aligned with any terminology changes introduced during implementation
- update `docs/architecture/v2-protocol-contract.md`
- update `docs/exec-plans/known-hotspots.md` to remove resolved hotspots and add any intentionally deferred follow-ups

**Follow-on explicitly out of scope for this plan**

- introducing a new top-level `Task` aggregate/table
- redesigning the product IA around task/run/environment/artifact pages
- introducing first-class artifact persistence beyond what current jobs/postprocess already produce
- adding Slack or other new product surfaces

Those changes should be planned separately once this program lands and the control plane is disciplined enough to support them.

**Tests**

- migration/backfill test coverage for legacy runtime column removal
- lint + dependency-check coverage for the new architecture rules
- full regression pass across prompt, review, retry, stop, terminate, snapshot, and session detail UI flows

**PR exit criteria**

- migration gate script returns zero violating rows
- fallback runtime reads are removed
- legacy runtime columns are dropped only in this PR, never earlier

## Progress

- [ ] Wave 1a: introduce lifecycle services and lifecycle-focused tests
- [ ] Wave 1b: add current-runtime gateway and migrate runtime identity call sites
- [ ] Wave 2: consolidate prompt dispatch behind one executor and one typed protocol
- [ ] Wave 3: move job-specific behavior into a typed job-spec registry
- [ ] Wave 4: ship session read models, transcript projection, and session UI migration
- [ ] Wave 5: remove legacy runtime columns/fallbacks and tighten architecture enforcement
- [ ] Update architecture/protocol docs to match the final implementation
- [ ] Keep terminology aligned with `docs/architecture/00-what-is-polaris.md` throughout implementation

## Done When

- [ ] Routes and orchestrators no longer import raw `casSessionStatus`, `casJobStatus`, or `casAttemptStatus` outside lifecycle services/tests
- [ ] All prompt-like flows use the shared prompt executor and typed protocol module
- [ ] `interactive_session_runtimes` is the sole authority for live runtime identity
- [ ] `switch (job.type)` branching is removed from sweeper and postprocess in favor of job specs
- [ ] Session detail UI renders only server-projected `SessionDetailView` and `SessionTranscriptView`
- [ ] `reconcileForRead()` healing is observable in evlog and no longer happens silently
- [ ] Legacy session runtime columns are removed after additive migration/backfill
- [ ] The pre-drop runtime migration gate script returns zero violating rows
- [ ] The shipped implementation leaves Polaris better positioned for a later task/run/environment layer rather than deepening session-first assumptions
- [ ] `ARCHITECTURE.md` and `docs/architecture/v2-protocol-contract.md` match the shipped design
- [ ] `pnpm lint` passes
- [ ] `pnpm check:deps` passes
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
