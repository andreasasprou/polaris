# What Is Polaris?

**Status:** Draft north-star architecture note  
**Last updated:** 2026-03-21  
**Purpose:** Define Polaris in product and architectural terms so the rest of the codebase, refactors, and future features use the same model.

---

## One-Sentence Definition

**Current Polaris** is a session-centric control plane for long-running coding-agent work running in cloud sandboxes.

**Future Polaris** should be a task-centric cloud agent platform where sessions are only one continuation primitive among several product surfaces such as web, GitHub, Slack, API, and automations.

---

## Why This Document Exists

`ARCHITECTURE.md` explains how the system currently works.  
Execution plans explain how to change parts of it.  
Neither document cleanly answers the higher-order question:

> What is Polaris actually trying to be?

Without that answer, the code drifts toward local optimizations:

- interactive sessions become the default noun for everything
- status fields carry too many meanings
- automations and reviews look bolted on instead of first-class
- frontend views compensate for backend seams instead of rendering stable read models

This note defines the intended product model and the architectural consequences of that model.

---

## Polaris in Plain Terms

Polaris is software for running coding agents in isolated cloud environments on behalf of an organization.

It exists to make agent work:

- durable across sandbox restarts and retries
- safe across org-scoped credentials and repositories
- observable through persisted state and audit history
- controllable through human feedback, stops, and follow-up actions
- reusable across multiple surfaces such as manual chat, PR review, automations, and future integrations

The core value of Polaris is not “chat with an agent.”  
The core value is **coordinated, reviewable, resumable software work executed by agents in the cloud**.

---

## What Polaris Is Not

Polaris is **not** primarily:

- a thin wrapper around Claude Code or Codex
- a chat UI with a sandbox attached
- a generic workflow engine for arbitrary business automation
- a local IDE replacement

Those things may overlap with Polaris, but they are not the product boundary.

The correct mental model is:

> Polaris is a cloud agent orchestration platform for software work.

---

## Current-State Product Model

Today, Polaris is implemented around a strong internal control plane, but the top-level product model is still too session-centric.

### Current user-visible flows

Polaris currently supports three major shapes of work:

1. **Interactive session** — a user sends prompts into a durable conversation backed by an ephemeral sandbox runtime
2. **Continuous PR review** — GitHub events dispatch review work against a PR-scoped long-lived session
3. **Automation / coding task** — a triggered workflow runs an agent against a repository and may create a PR or other side effects

### Current architectural definition

At the code level, Polaris today is:

- a Next.js monolith deployed on Vercel
- a Postgres-backed coordination system using CAS transitions
- an in-sandbox REST proxy over `sandbox-agent`
- a runtime model built around ephemeral Vercel Sandbox VMs

This current implementation is already much closer to a cloud agent platform than to a side project. The main gap is not missing infrastructure; it is missing product-level abstraction clarity.

---

## Current Core Primitives

These are the real primitives the codebase already models well.

| Primitive | Meaning today | Primary code |
|-----------|---------------|--------------|
| `interactive_session` | Durable user/automation conversation identity | `lib/sessions/schema.ts` |
| `interactive_session_runtime` | One sandbox lifecycle attached to a session | `lib/sessions/schema.ts` |
| `job` | Coordinated unit of async work | `lib/jobs/schema.ts` |
| `job_attempt` | One concrete execution attempt of a job | `lib/jobs/schema.ts` |
| `callback_inbox` | Idempotent acceptance of proxy callbacks | `lib/jobs/schema.ts` |
| `automation_session` | PR-scoped continuity record for continuous review | `lib/automations/schema.ts` |
| `automation_run` | One automation trigger/run record | `lib/automations/schema.ts` |
| `sandbox_agent.events` | Append-only execution event stream persisted to Postgres | `lib/sandbox-agent/queries.ts` |

### Why these primitives are good

These primitives correctly reflect the hard realities of cloud agent execution:

- runtimes die
- callbacks can be duplicated or arrive late
- retries need explicit modeling
- org-level credentials and repo context must be resolved safely
- user-visible state must survive execution failures

This is why the current system already has a credible control plane.

---

## Current Strengths

The existing codebase has several decisions worth preserving.

### 1. Postgres is the coordination authority

The system relies on durable rows and compare-and-set transitions instead of in-memory workflow state.

This is visible in:

- `interactive_sessions`
- `interactive_session_runtimes`
- `jobs`
- `job_attempts`
- `callback_inbox`
- `job_events`

That is the correct foundation for cloud agent work.

### 2. Runtime and conversation are at least partially separated

`interactive_session_runtimes` already exists as a distinct table from `interactive_sessions`.

That is an important architectural decision because a conversation can outlive any single sandbox runtime.

### 3. Execution is modeled as jobs and attempts

The `jobs` / `job_attempts` split is the correct control-plane model for:

- retries
- timeouts
- dispatch ambiguity
- auditability
- side-effect staging

### 4. Agent semantics are centralized

`lib/sandbox-agent/agent-profiles.ts` already separates:

- semantic intent (`interactive`, `read-only`, `autonomous`)
- transport config (`mode`, `model`, `thoughtLevel`)

That is the right boundary.

### 5. The proxy boundary is directionally correct

The sandbox proxy accepts prompt requests, durably acknowledges them, runs work asynchronously, and calls the platform back later.

That is the right execution boundary for Vercel + sandbox-agent.

---

## Current Structural Problems

The main problems are not “bad code.”  
They are modeling problems.

### 1. `Session` is overloaded

Today `interactive_sessions` mixes three concerns:

1. **continuation state** — the durable conversation identity
2. **runtime pointers** — `sandboxId`, `sandboxBaseUrl`, `sdkSessionId`
3. **user-facing work state** — `creating`, `active`, `completed`, `failed`, etc.

That makes one table carry product meaning, execution meaning, and infrastructure meaning at the same time.

### 2. One status machine carries too many meanings

The current session status model mixes:

- runtime lifecycle: `creating`, `snapshotting`, `hibernated`
- active execution: `active`, `idle`
- task outcome: `stopped`, `completed`, `failed`

Those should not be one undifferentiated state machine in the long run.

### 3. The product is still session-first

The UI, routes, and orchestration code mostly treat “session” as the primary user-facing unit.

That works for interactive chat, but it is too narrow for:

- PR review
- agent actions
- Slack-triggered work
- API-triggered work
- future multi-agent workflows

### 4. `Task` is not a first-class product noun

The category leaders expose a top-level unit closer to a task, work item, or cloud agent run.

Polaris internally has pieces of that model, but it does not yet express it as a canonical product primitive.

### 5. `Environment` is under-modeled

Today a runtime mostly means “the current sandbox for a session.”  
That is not enough for the future.

Polaris will need explicit modeling for:

- repo targets
- branch strategy
- sandbox profile / machine shape
- tool profile / MCP bundle
- resume policy
- isolation scope

### 6. `Artifact` is under-modeled

The system produces results such as:

- assistant summaries
- PRs
- review comments
- check runs
- logs
- event streams

These are outputs of work, but they are not yet treated as a first-class domain object.

### 7. `Feedback Loop` is implicit instead of explicit

PR review follow-ups, chat follow-ups, future Slack thread replies, and similar flows are all forms of “continue this work with new context.”

Today that capability is partly encoded as “send another prompt to the same session.”  
That is too low-level for the future product.

---

## Future-State Product Model

The target model is:

> Polaris is a task-centric cloud agent platform for software work.

The user-facing unit should become a **task**, not a session.

### Future primary nouns

| Future noun | Meaning |
|-------------|---------|
| **Task** | The durable unit of user or system intent |
| **Run** | One orchestrated execution of a task |
| **Attempt** | One concrete try within a run |
| **Environment** | The execution context in which agent work runs |
| **Continuation Session** | A reusable conversation/thread identity used when follow-up context matters |
| **Artifact** | A durable output of a run |
| **Feedback Thread** | An external or internal surface where follow-up work happens |
| **Automation** | A reusable rule that creates tasks from triggers |

### Future surfaces

Polaris should support the same core work model across:

- web UI
- GitHub
- Slack
- API
- cron / scheduled automations
- future external triggers

The top-level primitive must survive all of those surfaces cleanly.

---

## Target Nouns and Responsibilities

### 1. Task

A **task** is the durable unit of requested software work.

Examples:

- “Investigate this bug in repo X”
- “Review PR #42”
- “Fix this issue and open a PR”
- “Continue the previous work with this feedback”

The task owns:

- originating surface
- initiating instruction
- organization and repository scope
- current state
- latest run
- links to continuation/session and feedback thread when relevant

### 2. Run

A **run** is one orchestrated execution of a task.

Examples:

- first review pass on a PR
- resumed run after additional feedback
- rerun after retryable failure

The run owns:

- dispatch lifecycle
- agent selection
- execution status
- timeout / retry policy
- post-processing lifecycle
- resulting artifacts

### 3. Attempt

An **attempt** is one concrete try to execute a run.

This stays close to the current `job_attempt` model.

The attempt owns:

- fencing token / epoch
- dispatch outcome
- progress heartbeats
- execution result or error
- callback reconciliation

### 4. Environment

An **environment** is the execution context used by a run.

This is broader than “the current sandbox row.”  
It should eventually model:

- repo(s) and branch(es)
- sandbox size/profile
- mounted tools / MCP configuration
- credential access policy
- hibernation / reuse policy
- file system continuity

The current runtime table is the beginning of this concept, not the full concept.

### 5. Continuation Session

A **continuation session** is a durable thread of agent context used when follow-up work needs memory and continuity.

This is what `interactive_session` should become conceptually:

- not the top-level work object
- not the runtime object
- not the task object
- instead, the reusable continuity channel for long-lived agent context

### 6. Artifact

An **artifact** is a durable output produced by a run.

Examples:

- PR URL
- GitHub review comment
- summary/result blob
- diff summary
- process log bundle
- screenshot or recording
- structured findings

Artifacts should become first-class because they are how users inspect and trust agent work.

### 7. Feedback Thread

A **feedback thread** is the place where humans continue or redirect work.

Examples:

- web conversation
- GitHub PR comment thread
- Slack thread
- future Linear issue thread

The feedback thread is not the run itself. It is the continuity surface around the work.

---

## Current-to-Future Mapping

This is the most important translation table in the document.

| Current model | Future role |
|---------------|-------------|
| `interactive_sessions` | `ContinuationSession` |
| `interactive_session_runtimes` | `EnvironmentLease` or runtime instance under `Environment` |
| `jobs` | `Run` or run coordination record |
| `job_attempts` | `Attempt` |
| `automation_sessions` | task lineage / scoped feedback continuity for PRs |
| `automation_runs` | surfaced run history for triggered tasks |
| `sandbox_agent.events` | raw execution event journal feeding transcript/artifact projection |

This mapping is why the current codebase does not need a blank-slate rewrite. The raw materials are already here. What is missing is a cleaner top-level product model.

### Preferred vocabulary going forward

When talking about the product and future architecture:

- use **task** for the durable unit of requested work
- use **run** for one orchestrated execution of a task
- use **attempt** for one concrete execution try
- use **environment** for the execution context
- use **session** for continuity/thread state, not for the top-level product noun

This vocabulary is important because naming drift causes design drift.

---

## Concrete Examples

The future model should handle all of these cases using the same top-level nouns.

### Example 1 — Web chat follow-up

- User asks Polaris to investigate a failing test suite
- Polaris creates a **task**
- Polaris executes a **run** in an isolated **environment**
- The agent produces **artifacts** such as a summary, diff, and logs
- The user sends follow-up guidance through the same **continuation session**

### Example 2 — Continuous PR review

- GitHub webhook creates or continues a review **task**
- Each review pass is a new **run**
- The PR comment thread is the **feedback thread**
- Review comments and check runs are **artifacts**
- A review-scoped continuation/session preserves context between passes

### Example 3 — Slack-triggered coding task

- A Slack mention creates a coding **task**
- Polaris allocates an **environment** for the target repository
- The agent executes a **run**
- The Slack thread becomes the **feedback thread**
- A PR URL, summary, and screenshots become **artifacts**

### Example 4 — Scheduled automation

- A cron rule triggers an automation which creates a **task**
- Polaris runs the work in a managed **environment**
- Retryable execution is modeled as multiple **attempts**
- Completion is visible through the resulting **artifacts**

These examples differ in surface area, but they should not require different architectural foundations.

---

## State Machines We Actually Need

The future system should not have one overloaded status model. It should have layered state machines.

### 1. Task state

A task-level state answers:

- is the work newly created?
- awaiting execution?
- actively being worked?
- blocked on feedback?
- completed?
- cancelled?

Example shape:

```ts
type TaskState =
  | "open"
  | "scheduled"
  | "running"
  | "waiting_feedback"
  | "completed"
  | "cancelled"
  | "failed";
```

### 2. Run state

A run-level state answers:

- was dispatch accepted?
- is the agent running?
- has raw execution completed?
- is post-processing still running?

This is already close to the current `jobs.status` model and should stay close to that.

### 3. Attempt state

An attempt-level state answers:

- did dispatch succeed?
- is execution ambiguous?
- is the agent waiting for human input?
- did the attempt fail terminally?

This is already close to the current `job_attempts.status` model.

### 4. Environment state

An environment-level state answers:

- is a sandbox being created?
- alive and usable?
- hibernated?
- being destroyed?

This should move infrastructure lifecycle out of the user-facing task/session states.

### 5. Continuation state

A continuation/session-level state answers:

- can follow-up context be resumed?
- does the thread still have a usable environment?
- does it need restore or fresh start?

This should eventually be much narrower than the current `interactive_sessions.status`.

---

## Architectural Consequences

If this model is correct, several architectural consequences follow.

### 1. `Session` should stop being the top-level product noun

Interactive sessions remain important, but they should become one kind of continuation primitive rather than the main container for all work.

### 2. Runtime identity must move fully out of session records

The runtime table should become the authority for live environment identity.  
This is already the direction in `docs/exec-plans/active/20-lifecycle-runtime-dispatch-read-model.md`.

### 3. The control plane should center on runs and attempts

The run/attempt model is already the strongest part of the codebase.  
That is where orchestration should continue to harden.

### 4. The UI should become task/run-first

The current UI is session/chat-first.  
Over time, the user should be able to reason about:

- what task is running
- which run is current
- what artifacts were produced
- what feedback is pending
- what environment backed the run

### 5. Feedback loops need a first-class model

“Send another prompt” is not enough as the universal abstraction.

We need explicit support for:

- follow-up on previous results
- PR comment-driven continuation
- Slack-thread continuation
- revision/review cycles

### 6. Automations must be a first-class citizen

Automations are not a sidecar.  
They are one of the main product surfaces.

That means the architecture must treat triggered work as equal to manually initiated work, not as something that must tunnel through “interactive session” concepts.

---

## Product Surfaces and How They Should Relate

All product surfaces should create or continue the same top-level work model.

| Surface | What it should do |
|---------|-------------------|
| Web | Create tasks, inspect runs, continue feedback threads |
| GitHub | Create review or coding tasks, attach feedback to PR threads |
| Slack | Create tasks from mentions/threads and continue them from the same thread |
| API | Programmatically create tasks and inspect results |
| Automations | Materialize tasks from trigger rules and policies |

The system should not have one architecture for “interactive chat” and another for “automation.” Both should compile down to the same task/run/environment primitives.

---

## Product Inspirations

This future model aligns with where the category is moving:

- **Cursor** is making cloud agents a cross-surface product with automations, artifacts, and isolated environments
- **JetBrains Air** treats async tasks and execution environments as first-class
- **Tembo** treats automations, integrations, and feedback loops as core product surfaces

Polaris does not need to copy any one of these products, but it should align with the underlying category shape rather than anchoring itself to a “chat session with a sandbox” model.

---

## What We Should Keep

These parts of the current architecture should survive:

- Postgres as the coordination source of truth
- CAS-based state transitions
- the sandbox proxy callback model
- the `jobs` / `job_attempts` control plane
- explicit runtime rows
- centralized agent-profile resolution
- durable event persistence for execution history

These are strong platform decisions.

---

## What We Should Change

These are the main strategic changes implied by this document.

### Near term

- finish the control-plane hardening work in the lifecycle/runtime/dispatch/read-model refactor
- stop leaking runtime identity through session rows
- stop treating the UI as the place that derives domain state from raw events

### Medium term

- introduce a first-class `Task` concept at the product boundary
- reframe `interactive_session` as a continuation primitive
- introduce explicit read models for task, run, environment, artifact, and feedback thread views

### Long term

- support multiple external surfaces using the same top-level work model
- treat artifacts and feedback loops as first-class, not incidental outputs
- support multi-agent or child-task execution without distorting the core model

### What this does **not** require

This direction does **not** require a blank-slate rewrite.

It requires:

- keeping the existing control-plane strengths
- tightening the missing application-service boundaries
- gradually introducing the missing top-level nouns at the API, read-model, and product layers

The right path is an aggressive control-plane and product-model refactor, not demolition of the current core primitives.

---

## Decision

The working architectural definition of Polaris is:

> Polaris is a cloud agent orchestration platform for software work.  
> Internally it is a durable control plane around ephemeral runtimes.  
> Externally it should evolve into a task-centric product where sessions are only one continuation mechanism.

This definition should guide:

- future schema work
- orchestration boundaries
- read-model design
- UI information architecture
- automation and integration design

---

## Relationship to Other Docs

- `ARCHITECTURE.md` explains the current implementation and request flows
- `docs/architecture/v2-coordination-state-machine.md` explains the current coordination model
- `docs/architecture/v2-protocol-contract.md` explains the proxy/API execution boundary
- `docs/exec-plans/active/20-lifecycle-runtime-dispatch-read-model.md` is the current control-plane refactor program
- `docs/exec-plans/active/21-task-run-environment-artifact-feedback-model.md` is the follow-on product-layer program that introduces task-centric product nouns over the hardened control plane

This document sits above those. It answers the “what are we building?” question that those documents assume but do not define.
