---
title: Task-Centric Product Layer — Task, Run, Environment, Artifact, and Feedback Model
status: planned
created: 2026-03-21
owner: andreas
related_prs: []
domains: [architecture, tasks, jobs, sessions, automations, ui, api]
---

# 21 — Task-Centric Product Layer — Task, Run, Environment, Artifact, and Feedback Model

## Problem
### What
`docs/architecture/00-what-is-polaris.md` defines Polaris as a future **task-centric cloud agent platform**, but the current product layer is still split across older nouns:

- `interactive_sessions` act as the user-facing container for interactive work
- `automation_runs` act as the user-facing container for automation work
- `jobs` are the real execution primitive, but mostly hidden behind implementation details
- `/runs` is an automation-run UI, not a unified run UI
- `/api/tasks/*` exists only as a deprecated stub
- review continuity, chat continuity, and future Slack/API continuity do not share one explicit product model

The result is that Polaris has a strong control plane but an inconsistent product surface:

- the system knows how to execute work
- the product does not yet know how to name that work consistently

### Why
This is the next structural blocker after the control-plane hardening work in `docs/exec-plans/active/20-lifecycle-runtime-dispatch-read-model.md`.

Without a first-class task/run/environment/artifact model:

- sessions remain overloaded as the product noun
- automations and reviews keep feeling like special cases
- future Slack/API/integration surfaces have no canonical aggregate to attach to
- artifacts remain incidental fields instead of durable outputs
- the UI cannot evolve toward a clear mental model of “what is running, where, and what did it produce?”

This plan is the product-layer follow-on to plan 20.  
Plan 20 hardens the control plane.  
This plan introduces the stable product nouns on top of that control plane.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-21 | Introduce `Task` as the top-level product aggregate | Polaris needs one durable unit of requested work across web, GitHub, automations, and future integrations |
| 2026-03-21 | Reuse `jobs` / `job_attempts` as the underlying run / attempt control-plane records | The current repo already has a strong execution model; do not fork it with a parallel run engine |
| 2026-03-21 | Add `taskId` to `jobs` instead of introducing a new `task_runs` table immediately | This preserves the current control plane and makes the product-layer transition additive |
| 2026-03-21 | Treat `interactive_session` as a continuation/session primitive linked from a task | This aligns the product model with `docs/architecture/00-what-is-polaris.md` without requiring immediate session removal |
| 2026-03-21 | Keep `automation_runs` as trigger/audit records, not the long-term user-facing run primitive | They remain useful lineage records, but `jobs` become the canonical run backing model |
| 2026-03-21 | Add `taskId` bridge linkage to `automation_sessions`, not just `automation_runs` | Continuous review continuity is scoped to automation session business identity, not only to individual run rows |
| 2026-03-21 | Introduce `Artifact` as a first-class durable output | PRs, comments, checks, summaries, diffs, and future screenshots/log bundles need one explicit domain model |
| 2026-03-21 | Introduce `FeedbackThread` as a first-class continuation surface | Web threads, PR threads, and future Slack threads should attach to tasks consistently |
| 2026-03-21 | Introduce `EnvironmentSpec` at the task/run layer before renaming runtime tables | `interactive_session_runtimes` are already the environment lease primitive; add requested/effective environment modeling first |
| 2026-03-21 | Migrate product APIs and UI additively; do not big-bang replace `/sessions` and `/runs` | Reviewable migration matters more than naming purity |
| 2026-03-21 | Use `Task.surface` for the primary product surface and `Task.triggerType` for invocation mechanics | The previous `source` field mixed user-visible surface, schedule/webhook trigger types, and automation routing into one axis |
| 2026-03-21 | Do not introduce a second independent run-status state machine | User-facing run status should be a projection of `jobs.status`, not a parallel state model that drifts |
| 2026-03-21 | Keep the initial `tasks` table slim and derive current/latest run pointers in read models | Persisting denormalized pointers too early increases coordination complexity without adding real leverage |
| 2026-03-21 | Add bridge linkage on existing tables (`interactive_sessions.task_id`, `automation_sessions.task_id`, `automation_runs.task_id`) during migration | Reverse lookups and compatibility reads will be much simpler with explicit bridging columns than with only indirect joins |
| 2026-03-21 | Give tasks, artifacts, and feedback threads explicit identity/dedupe rules | The product layer needs stable “find-or-create” semantics, especially for PR review and continuation surfaces |
| 2026-03-21 | Task lifecycle is a small explicit product workflow reduced from linked run state plus explicit user intent | Tasks can outlive individual runs, reopen later, and must not drift through ad hoc status writes |
| 2026-03-21 | Artifacts may be either run-final or attempt-scoped | Retries produce distinct evidence; logs and failure bundles should not collapse across attempts |
| 2026-03-22 | Continuation sessions are role-aware and not all of them are user-chat surfaces | Review and automation continuity may need durable context without exposing a prompt box or primary Sessions-list entry |
| 2026-03-22 | Review GitHub delivery should produce explicit review artifacts, while inline comment maps and thread-resolution bookkeeping remain review state/metadata rather than artifact rows | User-visible outputs and operational bookkeeping are different concerns |

## Dependencies and Start Gate

This plan depends on the north-star note and the current control-plane refactor:

- `docs/architecture/00-what-is-polaris.md`
- `docs/exec-plans/active/20-lifecycle-runtime-dispatch-read-model.md`

Implementation start gate:

- Do not start Wave 1 of this plan until **Wave 2** of plan 20 lands. The product layer should not be built on top of duplicated dispatch paths and untyped proxy contracts.
- Do not start Wave 2a of this plan until **Wave 3** of plan 20 lands. Artifact emission should plug into job specs, not bypass them with another postprocess branch layer.
- Do not start Wave 4 of this plan until **Wave 4** of plan 20 lands. The product-layer UI migration should build on top of server-side read models, not pre-refactor client consolidation code.

## Target State

### Product Nouns

At the end of this program Polaris should expose these first-class nouns:

- **Task** — the durable unit of requested work
- **Run** — one execution of a task, backed by a `job`
- **Attempt** — one concrete try within a run, backed by `job_attempt`
- **Environment** — the requested and effective execution context for a run
- **Artifact** — a durable output of a run
- **FeedbackThread** — a human continuation surface attached to a task
- **ContinuationSession** — an implementation-level session/context primitive used when long-lived agent continuity matters

### Invariants

- Every user-visible work item has a `task`.
- Every user-visible run is backed by exactly one `job` and has `job.taskId` set.
- No new user-facing product surface is allowed to anchor directly on `interactive_session` or `automation_run` alone.
- `interactive_session` is optional from a task perspective; it is a continuation primitive, not the top-level aggregate.
- Continuation sessions linked to review or automation tasks are read-only by default unless a later product feature explicitly promotes them to an interactive surface.
- Every durable output intended for user inspection is persisted as an `artifact` or is intentionally documented as ephemeral/debug-only.
- Every human continuation surface is represented by a `feedback_thread`.
- Requested environment configuration is modeled separately from the currently leased runtime.
- Product APIs and UI use task/run read models instead of stitching together raw session rows and automation-run rows.
- `Task.kind`, `Task.surface`, and `Task.triggerType` are distinct concepts and do not duplicate one another.
- Review task identity is stable per PR/automation scope; interactive task identity is stable per continuation session.
- User-facing run status is derived from `jobs.status`, not stored in a second product-layer status column.
- Attempt-scoped evidence artifacts attach to the relevant attempt instead of collapsing retries into one run-level blob.

### Canonical Mapping

| Product noun | Backing persistence in this program |
|--------------|------------------------------------|
| `Task` | new `tasks` table |
| `Run` | `jobs` table + run read model |
| `Attempt` | `job_attempts` table |
| `ContinuationSession` | `interactive_sessions` |
| `EnvironmentLease` | `interactive_session_runtimes` |
| `FeedbackThread` | new `feedback_threads` table |
| `Artifact` | new `artifacts` table |
| automation trigger lineage | `automation_runs` remains as source/audit metadata |

## Program Shape

Ship this as five sequential waves, preferably seven PRs:

1. Task aggregate and linkage
2. Artifact and feedback-thread model
3. Environment spec and environment read models
4. Surface adapter migration (interactive, review, automation APIs)
5. Task/run UI migration and cleanup

Recommended PR boundaries:

| PR | Scope | Must Land Before |
|----|-------|------------------|
| PR1 (`W1a`) | `tasks` table + task lifecycle + task/read models | PR2+ |
| PR2 (`W1b`) | bridge linkage on `jobs`, `interactive_sessions`, `automation_sessions`, and `automation_runs` + surface task creation | PR3+ |
| PR3 (`W2a`) | `artifacts` table + artifact emitters | PR4+ |
| PR4 (`W2b`) | `feedback_threads` table + thread adapters | PR5+ |
| PR5 (`W3`) | environment spec types + environment read models | PR6+ |
| PR6 (`W4`) | surface adapters + task/run APIs | PR7 |
| PR7 (`W5`) | task/run UI migration + cleanup/deprecations | final |

## Implementation

### Wave 1 — Task Aggregate and Linkage

**Goal:** introduce a first-class `Task` without replacing the existing run engine.

Treat this wave as two sub-phases:

- **W1a — task aggregate + lifecycle + read models**
- **W1b — bridge linkage + task creation at current entrypoints**

**Create**

- `lib/tasks/schema.ts`
- `lib/tasks/actions.ts`
- `lib/tasks/status.ts`
- `lib/tasks/lifecycle.ts`
- `lib/tasks/read-model.ts`

**Schema**

Add a new `tasks` table:

```ts
tasks {
  id: uuid
  organizationId: text
  kind: text
  surface: text
  triggerType: text
  identityKey: text | null
  title: text
  instruction: text
  status: text
  continuationSessionId: uuid | null
  requestedEnvironment: jsonb
  metadata: jsonb
  createdBy: text | null
  createdAt: timestamptz
  updatedAt: timestamptz
  completedAt: timestamptz | null
}
```

Add nullable `task_id` to `jobs`.

Add nullable `task_id` bridge columns to:

- `interactive_sessions`
- `automation_sessions`
- `automation_runs`

**Task kinds**

Start with explicit kinds:

- `interactive`
- `review`
- `coding_task`

Do not over-generalize beyond current supported product shapes.

`kind` means **what the work is**.  
`surface` means **where the work primarily shows up as a product concept**.  
`triggerType` means **how the task/run was invoked**.

Initial `surface` values should cover the current product surfaces:

- `web`
- `github`
- `automation`
- `api`

Do not use `automation` as a task kind in this program.  
Do not use `schedule` or `webhook` as surface values in this program.

Initial `triggerType` values should cover the current invocation mechanisms:

- `direct`
- `github_event`
- `schedule`
- `webhook`
- `manual`

**Task identity rules**

Use `identityKey` for stable “find-or-create” behavior where continuity matters:

- interactive task: `interactive-session:<sessionId>`
- review task: `review-scope:<automationId>:<scopeKey>`
- coding-task automation: `automation-run:<automationRunId>`

Back this with a partial unique constraint over:

- `organization_id`
- `kind`
- `identity_key`

where `identity_key IS NOT NULL`.

Review-task creation should:

- find or create by the stable review scope identity key
- write `automation_sessions.taskId` once the task is resolved
- treat `automation_runs.taskId` as lineage for individual executions, not the continuity anchor

**Task status**

Introduce a small task status model:

- `open`
- `running`
- `waiting_feedback`
- `completed`
- `cancelled`
- `failed`

`TaskLifecycleService` should own transitions.  
Do not let product-layer task state become another ad hoc field updated from random routes.

Status semantics:

- `open` — task exists and can accept additional runs or follow-up work
- `running` — at least one nonterminal run/job exists for the task
- `waiting_feedback` — the current run is blocked on human input
- `completed` — the task is intentionally considered done
- `cancelled` — the task was intentionally terminated
- `failed` — the task is not currently runnable without explicit restart/reopen

Allowed transitions:

- `open -> running | cancelled`
- `running -> waiting_feedback | open | completed | failed | cancelled`
- `waiting_feedback -> running | open | completed | failed | cancelled`
- `completed -> open` only through explicit reopen/retry intent
- `failed -> open` only through explicit reopen/retry intent
- `cancelled -> open` only through explicit reopen intent

Reducer rules:

- if any linked nonterminal run exists and the active attempt is blocked on HITL, task status becomes `waiting_feedback`
- else if any linked nonterminal run exists, task status becomes `running`
- else if the task has an explicit terminal state (`completed`, `failed`, `cancelled`) and no reopen intent has been issued, preserve that terminal state
- else task status becomes `open`

Concurrency rules for this program:

- `interactive` tasks allow at most one nonterminal run at a time
- `review` tasks allow at most one nonterminal run at a time and must stay aligned with `automation_sessions.reviewLockJobId`
- `coding_task` tasks allow at most one nonterminal run at a time in this program

Do not add broader multi-run concurrency until there is a concrete product need for parallel runs under one task.

**Task-to-continuation defaults**

- `interactive` tasks may create a `user_interactive` continuation session
- `review` tasks may create or reuse a `review_continuation` session
- `coding_task` tasks do not require a continuation session, but if one exists for continuity/debugging it should default to a non-primary, read-only role

The task aggregate should not assume that every task owns a user-chat thread.

**Read-model responsibilities**

`buildTaskDetailView(taskId, organizationId)` returns:

- canonical task row
- linked continuation session summary if present
- current run summary
- recent artifacts
- feedback-thread summaries
- derived task capabilities

`buildRunView(jobId, organizationId)` returns the user-facing run model backed by `jobs`, `job_attempts`, task linkage, continuation session linkage, and artifacts.

`buildRunView()` must derive user-facing run status from `jobs.status`.  
Do not add a second run status column in this wave.

**Refactor call sites**

- interactive session creation flow should create a task and link the session to it
- continuous PR review session creation should create or find a task scoped to `automationId + scopeKey`
- one-shot automation dispatch should create a task before creating the first run/job

Target files:

- `lib/automations/actions.ts`
- `lib/routing/trigger-router.ts`
- `lib/orchestration/prompt-dispatch.ts`
- `lib/orchestration/pr-review.ts`
- `lib/orchestration/coding-task.ts`

In W1b these entrypoints should:

- create/find the correct task
- set `job.taskId`
- set bridge linkage on `interactive_sessions.taskId`, `automation_sessions.taskId`, and/or `automation_runs.taskId` where applicable

**Migration rule**

- Keep all current flows working with additive dual-write
- existing rows do not need a full historical backfill before the first PR lands
- only new work created after this wave must have a task
- `currentJobId` / `latestCompletedJobId` should be derived in read models, not backfilled as persisted pointers

**Tests**

- unit tests for task lifecycle transitions
- integration tests for task creation from interactive session, review, and coding-task entrypoints
- read-model tests for task detail / run view

**PR exit criteria**

- **PR1 / W1a** exits with a stable `tasks` aggregate, lifecycle, and read-model foundation
- **PR2 / W1b** exits with all newly created user-visible work creating a `task` and all newly created user-visible `jobs` carrying `taskId`

### Wave 2 — Artifact and Feedback-Thread Model

**Goal:** make outputs and continuation surfaces explicit instead of incidental.

Treat this as two PRs if needed:

- **W2a — artifacts**
- **W2b — feedback threads**

#### Wave 2a — Artifacts

**Create**

- `lib/artifacts/schema.ts`
- `lib/artifacts/actions.ts`
- `lib/artifacts/types.ts`
- `lib/artifacts/read-model.ts`

**Schema**

Add an `artifacts` table:

```ts
artifacts {
  id: uuid
  organizationId: text
  taskId: uuid
  jobId: uuid
  attemptId: uuid | null
  type: text
  title: text | null
  status: text
  uri: text | null
  payload: jsonb
  metadata: jsonb
  dedupeKey: text | null
  supersededByArtifactId: uuid | null
  createdAt: timestamptz
}
```

Start with explicit artifact types:

- `summary`
- `pull_request`
- `review_comment`
- `github_check`
- `branch`
- `diff_summary`
- `usage_report`
- `log_bundle`

Keep screenshots/video in the type union as future follow-ons only if the implementation genuinely produces them.

Artifact status should be explicit and minimal:

- `available`
- `superseded`
- `failed`

Artifacts may be either:

- **run-final artifacts** attached at the `jobId` level when they represent the durable outcome of the run
- **attempt-scoped artifacts** attached at the `attemptId` level when they represent retry-specific evidence such as logs or failure bundles

Add a unique constraint that makes duplicate durable emissions impossible for intended singletons:

- `job_id`
- `type`
- `dedupe_key`

where `attempt_id IS NULL` and `dedupe_key IS NOT NULL`.

Add a second uniqueness rule for attempt-scoped singleton emissions:

- `attempt_id`
- `type`
- `dedupe_key`

where `attempt_id IS NOT NULL` and `dedupe_key IS NOT NULL`.

**Emit artifacts from existing flows**

- `prompt` jobs should emit summary/result artifacts when appropriate
- `review` jobs should emit summary comment, GitHub check, and inline review artifacts when those outputs are actually created
- `coding_task` jobs should emit branch, PR, and summary artifacts

Do **not** model internal review bookkeeping as separate artifacts:

- `inlineCommentMap`
- active/superseded inline review tracking IDs
- reply-on-resolve / thread-resolution bookkeeping

Those remain part of review state / metadata until there is a concrete user-facing audit requirement that justifies promoting them.

Primary refactor files:

- `lib/orchestration/postprocess.ts`
- `lib/orchestration/job-specs/*.ts` once plan 20 Wave 3 lands

**Migration rule**

- dual-write existing summary / PR URL / comment ID fields while the UI still depends on them
- artifacts become the canonical new output path
- emitters should live behind job specs once plan 20 Wave 3 is complete; do not add a parallel artifact-emission abstraction outside the job-spec layer

#### Wave 2b — Feedback Threads

**Create**

- `lib/feedback-threads/schema.ts`
- `lib/feedback-threads/actions.ts`
- `lib/feedback-threads/read-model.ts`

**Schema**

Add a `feedback_threads` table:

```ts
feedbackThreads {
  id: uuid
  organizationId: text
  taskId: uuid
  surface: text
  externalRef: text
  status: text
  metadata: jsonb
  createdAt: timestamptz
  updatedAt: timestamptz
}
```

Start with surfaces:

- `web`
- `github_pr`
- `github_comment_thread`

Do not add Slack rows until a real Slack integration exists.

Add a unique constraint over:

- `task_id`
- `surface`
- `external_ref`

to make thread upserts deterministic.

**Refactor call sites**

- web-created tasks get a `web` feedback thread
- PR review tasks get a PR-thread feedback thread
- future follow-ups should attach to the thread rather than inferring continuity only from session IDs

**Tests**

- schema/unit tests for artifact and feedback-thread writes
- integration tests proving postprocess emits durable artifacts
- integration tests proving retries create distinct attempt-scoped artifacts where applicable
- integration tests proving review tasks and web tasks attach the correct feedback-thread records

**PR exit criteria**

- user-visible outputs from new runs are persisted as artifacts
- new tasks created from current supported surfaces also create feedback threads

### Wave 3 — Environment Spec and Environment Read Models

**Goal:** separate requested execution context from the currently leased runtime.

**Create**

- `lib/environments/types.ts`
- `lib/environments/read-model.ts`
- `lib/environments/profiles.ts`

**Do not rename runtime tables in this wave**

`interactive_session_runtimes` remains the backing environment-lease table. This wave adds a higher-level environment model above it.

**Environment spec**

Define typed `EnvironmentSpec` and `EffectiveEnvironmentView`.

```ts
type EnvironmentSpec = {
  repoTargets: Array<{ repositoryId: string; branch?: string }>;
  sandboxProfile: "ephemeral_coding" | "review_continuation" | "interactive_continuation";
  toolProfileId?: string | null;
  resumePolicy: "fresh" | "resume" | "hibernate";
  workingDirectoryStrategy: "task_scoped" | "session_scoped";
};
```

Persist requested environment spec on `tasks.requestedEnvironment`.

`toolProfileId` should be capable of representing the effective tool/MCP bundle, not just a generic preset label. The current codebase already resolves org-level MCP servers during dispatch, so this wave must make that tool surface visible in the environment model instead of treating it as an invisible transport detail.

If a specific run needs to override the task-level environment request, model that as a run-level override in the job payload/read model rather than mutating the task-level requested environment in place.

**Read-model responsibilities**

`buildEnvironmentView(taskId | jobId)` returns:

- requested environment spec
- current effective runtime lease
- latest runtime history
- whether continuation is available
- effective branch/repository pointers
- effective tool / MCP bundle summary
- compute-policy summary

**Refactor call sites**

- interactive task creation sets environment spec explicitly
- PR review tasks set review-specific environment spec
- coding-task automations set coding-task environment spec explicitly instead of spreading repo/branch assumptions across payload fields

Target files:

- `lib/orchestration/coding-task.ts`
- `lib/orchestration/pr-review.ts`
- `lib/orchestration/prompt-dispatch.ts`
- `lib/compute/policies.ts`

**Tests**

- unit tests for environment spec validation
- read-model tests over runtime/session data
- integration tests for spec creation in each current surface

**PR exit criteria**

- every newly created task has an explicit requested environment spec
- product-layer code reads requested/effective environment through `lib/environments/**`, not ad hoc runtime/session fields

### Wave 4 — Surface Adapter Migration and Product APIs

**Goal:** expose the new product layer through stable APIs and stop anchoring surfaces directly on session-first and automation-run-first views.

**Create**

- `app/api/tasks/route.ts`
- `app/api/tasks/[taskId]/route.ts`
- `app/api/tasks/[taskId]/runs/route.ts`
- `app/api/jobs/[jobId]/route.ts` for canonical internal/debug job detail if needed

**API responsibilities**

`GET /api/tasks`

- list tasks across interactive, review, and automation work
- support surface/kind/status filters
- support optional `triggerType` filter for operational debugging

`GET /api/tasks/[taskId]`

- task detail view
- linked continuation session summary
- linked continuation session role/capabilities when present
- feedback threads
- recent artifacts

`GET /api/tasks/[taskId]/runs`

- list run views backed by `jobs`

`GET /api/jobs/[jobId]`

- canonical internal/debug job-backed run detail
- useful while `/api/runs/[runId]` remains the compatibility product route during migration

**Refactor current APIs**

- keep existing `/api/runs` and `/api/runs/[runId]` paths during migration
- gradually move those responses from `automation_runs`-backed payloads to task/job-backed run views
- keep `runId` path semantics backward compatible during dual-read; do not introduce a conflicting second `/api/runs/[jobId]` contract mid-migration
- existing `/api/tasks/*` deprecated stubs should be replaced with real task APIs
- session routes remain supported, but should return task linkage where relevant

**Surface adapter work**

- interactive task creation path returns `taskId` and linked continuation session
- PR review path finds or creates a task scoped to automation + PR scope
- automation one-shot path creates a task and links the first run/job
- `automation_runs` gain `taskId` as lineage for bridging existing screens
- task/read-model adapters should preserve the session role/capability distinction introduced in plan 20 instead of collapsing all continuations back into generic chat sessions

**Tests**

- route tests for task list/detail/runs APIs
- integration tests for each current entrypoint creating the correct task/run linkage
- compatibility tests for existing `/runs` consumers during dual-read period

**PR exit criteria**

- real task APIs exist and are used by at least one product surface
- deprecated `/api/tasks/*` stubs are removed or replaced
- existing `/api/runs` consumers continue to work while the underlying response model becomes job-backed

### Wave 5 — Task/Run UI Migration and Cleanup

**Goal:** make the product IA task-first while preserving implementation-level session views where needed.

**Create**

- `app/(dashboard)/tasks/page.tsx`
- `app/(dashboard)/tasks/[taskId]/page.tsx`
- `hooks/use-task-list.ts`
- `hooks/use-task-detail.ts`
- `hooks/use-task-runs.ts`

**Refactor**

- `app/(dashboard)/runs/page.tsx`
- `app/(dashboard)/runs/[runId]/page.tsx`
- `app/(dashboard)/sessions/[sessionId]/page.tsx`
- dashboard summary widgets that currently report only automation-run concepts

**UI responsibilities**

The task detail page should show:

- task summary
- current status and capabilities
- linked continuation session summary if present
- run history
- artifacts
- feedback-thread summary
- environment summary

The run detail page should become the canonical job-backed run page, not an automation-run page with session fields bolted on.

If a linked continuation session is non-interactive:

- show a transcript preview/snippet inline
- link to the full continuation/debug page when needed
- do not render a prompt input on the run page
- label the continuation clearly as read-only review/automation context rather than as a user session

The session page should remain available as an implementation-level continuity/debug view, not the primary work-navigation surface.

**Navigation changes**

- add `Tasks` as a first-class sidebar item
- keep `Runs` while migration is ongoing
- decide after rollout whether `Sessions` remains primary nav, secondary nav, or moves behind advanced/debugging affordances
- keep primary Sessions navigation focused on user-interactive sessions; system-owned continuations should only appear through task/run flows or explicit debug affordances

Add `Tasks` only after task list/detail APIs are stable enough to be the default product entrypoint. Do not ship empty or partial navigation that points to thin wrappers around old session pages.

**Cleanup**

- stop using `automation_runs` as the primary product list/detail source
- stop using session-first language in user-visible copy where task/run is more accurate
- deprecate bridge fields that only existed for the old automation-run UI once task/run pages fully cover the use case

**Tests**

- UI route tests for task pages
- browser verification for interactive, review, and automation tasks
- regression checks that session pages still work for continuity/HITL/debug cases

**PR exit criteria**

- there is a first-class task list/detail experience
- run detail pages are job-backed
- session pages are no longer the default product-level entrypoint for understanding work

## Explicitly Out of Scope

This plan does **not** include:

- multi-agent orchestration or child-task execution
- Slack implementation work
- a provider-agnostic marketplace for tool profiles or MCP bundles
- replacing the existing control plane with a different run engine
- physical renaming of `jobs` to `runs` tables in the same program

Those should only be planned after this product-layer program lands.

## Progress

- [ ] Wave 1a: add `tasks` aggregate, lifecycle, and read models
- [ ] Wave 1b: link tasks to jobs, sessions, automation sessions, and automation runs at current entrypoints
- [ ] Wave 2a: add `artifacts` and emit durable run outputs
- [ ] Wave 2b: add `feedback_threads` and attach supported surfaces
- [ ] Wave 3: introduce environment spec and environment read models
- [ ] Wave 4: ship task/run APIs and migrate current entrypoints
- [ ] Wave 5: ship task/run UI and demote session-first navigation
- [ ] Align docs and terminology with the north-star model throughout implementation

## Done When

- [ ] Every newly created user-visible work item creates a `task`
- [ ] Every newly created user-visible `job` has `taskId`
- [ ] Every newly created interactive session, automation session, or automation run that participates in user-visible work carries `taskId` bridge linkage
- [ ] `jobs` are the canonical backing model for user-visible run detail views
- [ ] `interactive_sessions` are treated as continuation/session primitives, not the top-level product aggregate
- [ ] review and automation continuation sessions are read-only by default and do not masquerade as user-chat sessions
- [ ] User-visible durable outputs are persisted as artifacts
- [ ] Supported current surfaces create feedback-thread records
- [ ] Requested environment is modeled explicitly and separately from runtime lease state
- [ ] `Task.kind`, `Task.surface`, and `Task.triggerType` are used consistently and do not overlap semantically
- [ ] No second product-layer run status machine is introduced
- [ ] Attempt-scoped evidence artifacts preserve retry-specific output when needed
- [ ] There is a first-class task list/detail UI
- [ ] Existing run detail UI is job-backed rather than automation-run-only
- [ ] The deprecated `/api/tasks/*` stubs are replaced with real task APIs
- [ ] `docs/architecture/00-what-is-polaris.md` remains aligned with the shipped implementation
- [ ] `pnpm typecheck` passes
