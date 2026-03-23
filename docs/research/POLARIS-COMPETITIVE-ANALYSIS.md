# Polaris Competitive Analysis & Architecture Recommendations

*Deep analysis of 7 open-source agent orchestration platforms. Each repo was cloned, explored, and compared against Polaris's codebase. This document synthesizes findings into actionable recommendations.*

---

## Table of Contents
1. [Repos Studied](#repos-studied)
2. [Individual Analyses](#individual-analyses)
   - [Vercel coding-agent-template](#1-vercel-coding-agent-template)
   - [Background Agents (Open-Inspect)](#2-background-agents-open-inspect)
   - [Sandboxed.sh](#3-sandboxedsh)
   - [SWE-AF](#4-swe-af)
   - [AgentRove](#5-agentrove)
   - [OpenHands](#6-openhands)
   - [VibeSDK (Cloudflare)](#7-vibesdk-cloudflare)
3. [Cross-Cutting Themes](#cross-cutting-themes)
4. [Where Polaris Is Already Ahead](#where-polaris-is-already-ahead)
5. [Prioritized Action Plan](#prioritized-action-plan)
6. [The 5 Changes That Matter Most](#the-5-changes-that-matter-most)

---

## Repos Studied

| Repo | Stars | Stack | Best At |
|------|-------|-------|---------|
| [vercel-labs/coding-agent-template](https://github.com/vercel-labs/coding-agent-template) | 1,642 | Next.js + Vercel Sandbox | IDE-like workspace UX |
| [ColeMurray/background-agents](https://github.com/ColeMurray/background-agents) | — | CF Workers + Durable Objects + Modal | Real-time architecture, child task spawning |
| [Th0rgal/sandboxed.sh](https://github.com/Th0rgal/sandboxed.sh) | 324 | Rust (Axum) + Next.js + systemd-nspawn | Agent backend abstraction, config-as-code |
| [Agent-Field/SWE-AF](https://github.com/Agent-Field/SWE-AF) | — | Python + Claude Code runtime | Multi-agent factory, adaptive error recovery |
| [Mng-dev-ai/agentrove](https://github.com/Mng-dev-ai/agentrove) | 246 | React + FastAPI + Docker + Redis | Richest chat UI, stream processing pipeline |
| [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | massive | Python SDK + React SPA + Docker | Event type system, Action/Observation model |
| [cloudflare/vibesdk](https://github.com/cloudflare/vibesdk) | — | CF Workers + Durable Objects + D1 | State management, formal state machine |

---

## Individual Analyses

### 1. Vercel coding-agent-template

**Architecture:** Monolith Next.js App Router, ~223 TS files. Single `tasks` table with flat status (`pending | processing | completed | error | stopped`). Agent execution happens synchronously inside `after()` callbacks in serverless functions. No job queue, no sweeper, no CAS — state transitions are simple `UPDATE SET status = 'processing'`. Logs stored in JSONB on the task row via a TaskLogger that does a full read-modify-write on every log line — O(n²) in the number of logs. Polling-based UI: polls `/api/tasks/:id` every 5s, messages every 3s.

**What's better than Polaris:**

- **IDE-like workspace layout (★★★★★):** Four-pane resizable layout with Files, Code Editor, Chat, and Preview — each toggleable. The `TaskDetails` component is 2700+ lines implementing a full coding workspace. This is the single biggest UX gap in Polaris, which has chat-only.

- **In-browser terminal (★★★★☆):** Real xterm.js terminal connected to the sandbox. Users can run arbitrary commands while the agent works. Polaris has no terminal access.

- **Inline file editing (★★★★☆):** `FileBrowser` + `FileEditor` + `FileDiffViewer` components let users browse sandbox files, edit them in Monaco, and see diffs — all without leaving the task page. Polaris has no file browsing at all.

- **PR comments → follow-up (★★★★☆):** "Send as Follow-Up" button on PR comments that pre-fills the chat input. Bridges the gap between PR review and agent interaction. Polaris keeps reviews and sessions separate.

- **Sticky user messages (★★★☆☆):** `position: sticky; top: 0` with stacking z-index — user messages stay visible while scrolling through long agent responses. Simple CSS trick, big UX impact.

- **Sandbox setup progress (★★★☆☆):** Instead of a spinner, they show step-by-step progress: "Cloning repository...", "Installing dependencies...", etc. with a 0-100 numeric progress indicator.

- **Dev server auto-detection (★★★☆☆):** Detects package manager, dev script, port, and auto-starts the dev server. Preview URL appears automatically when the server is ready.

**What's worse than Polaris:**

- **Agent abstraction is a switch/case mess.** Each of 6 agents (Claude, Codex, Copilot, Cursor, Gemini, OpenCode) is a 200-400 line file with duplicated install/verify/execute patterns. No shared interface. `process.env` mutation for API keys (thread-unsafe). Polaris's `agent-profiles.ts` with semantic intents is dramatically better.

- **No state management rigor.** No CAS, no epoch fencing, no contention handling. Simple `UPDATE` statements that would race under concurrent access. Polaris's state machine approach is production-hardened.

- **No HITL.** No permission requests, no question handling, no human-in-the-loop at all. Polaris has first-class `PermissionRequest` and `QuestionRequest` components.

- **No durability.** Crash = lost. No write-ahead outbox, no sweeper, no callback retry. Polaris's callback inbox with HMAC signing is much more robust.

- **O(n²) log storage.** TaskLogger reads entire log array, copies it, adds one entry, writes back. For 200 logs, that's 200 full reads + 200 full writes.

**Don't steal:** TaskLogger pattern, agent switch/case, process.env mutation, flat status model.

---

### 2. Background Agents (Open-Inspect)

**Architecture:** Three-tier control-plane/data-plane split. Control plane runs on Cloudflare Workers + Durable Objects (per-session SQLite, WebSocket hub, event stream). Data plane runs on Modal (sandbox VMs). One Durable Object per session gives perfect isolation — no shared Postgres contention. Stateless router dispatches to stateful DOs. Clean package boundaries: `@open-inspect/shared` is the protocol source of truth (per ADR-0002). `SessionDO` uses lazy-initialized services: `SessionMessageQueue`, `SessionSandboxEventProcessor`, `PresenceService`, `CallbackNotificationService`, `ParticipantService`, `SandboxLifecycleManager`.

**What's better than Polaris:**

- **WebSocket-first real-time (★★★★★):** Token-based WebSocket auth, subscribe-with-replay pattern, cursor-based pagination. On subscribe, server sends full `SessionState` + replays last 500 events + pagination cursor for history. Smart token collapsing: streaming `token` events accumulate in a ref, only rendered on `execution_complete` — prevents re-render storms. Reconnection with exponential backoff (5 attempts, max 30s). Ping/pong keepalive every 30s. **Polaris polls every 2s and re-fetches ALL events each cycle.**

- **Service decomposition with dependency injection (★★★★★):** Every service uses an explicit deps interface with narrow types:
  ```typescript
  interface CallbackServiceDeps {
    repository: CallbackRepository;  // Narrow interface, not full repo
    env: CallbackServiceEnv;
    log: Logger;
    getSessionId: () => string;
  }
  ```
  Handler factories are pure functions: `createMessagesHandler(deps): MessagesHandler`. Makes testing trivial — inject mocks for exactly the dependencies used. Prevents accidental coupling. Route table is data, not code. **Polaris's `lib/orchestration/` functions are procedural with direct imports — hard to test in isolation.**

- **Protocol contracts as shared package (★★★★☆):** All wire types live in `@open-inspect/shared`: `ClientMessage`, `ServerMessage`, `SandboxEvent` discriminated unions. Prevents type drift between backend and frontend. **Polaris has types scattered across `lib/sandbox-agent/`, `lib/sandbox-proxy/`, `lib/sessions/`, and UI components.**

- **Multiplayer presence (★★★★☆):** `PresenceService` (~90 lines) tracks active/idle/away per participant. Avatar stack in sidebar. Typing indicator triggers proactive sandbox warming. **Polaris has no presence awareness at all.**

- **Child session spawning with guardrails (★★★★☆):** Agents can spawn independent child tasks in their own sandboxes. Guardrails: `MAX_SPAWN_DEPTH = 2`, `MAX_CONCURRENT_CHILDREN = 5`, `MAX_TOTAL_CHILDREN = 15`. Parent provides `SpawnContext` (repo, credentials, model). Child inherits repo (enforced), gets its own DO. Real-time `child_session_update` events flow from child → parent via DO-to-DO `fetch()`. UI shows sub-tasks in sidebar with status badges. **Polaris has no sub-task capability.**

- **Smart event persistence (★★★☆☆):** Only persists `tool_call` events with `completed` or `error` status (not `running`). Token events are upserted (only latest content kept in DB). Dramatically reduces storage without losing information. **Polaris stores every raw SDK event.**

- **Callback routing by source (★★★☆☆):** `CallbackNotificationService` routes completion notifications to the correct integration (Slack, Linear, Scheduler) based on `message.source`. Each integration has its own callback handler. **Polaris has a monolithic callback handler.**

**What's worse than Polaris:**

- **No CAS state machines.** Simpler state model without contention handling. Would race under concurrent writes.
- **No PR review system.** Basic GitHub integration for creating sessions from PRs, but no continuous review, no inline threading, no repo-config-as-code.
- **No agent profile abstraction.** Agent config is ad-hoc, not organized by semantic intent.

---

### 3. Sandboxed.sh

**Architecture:** Rust monolith (Axum web server) + Next.js dashboard + iOS SwiftUI app. Single binary deployment via Docker or native install. No external services beyond optional SQLite. Manages multiple coding agents (Claude Code, OpenCode, Amp, Codex, Gemini) through a `Backend` trait abstraction. Uses systemd-nspawn for container isolation on Linux. All configuration (skills, commands, agents, MCPs, workspace templates, config profiles) stored in a git-backed Library repo.

**What's better than Polaris:**

- **Backend Trait abstraction (★★★★★):** Clean Rust trait with 5 methods: `id()`, `name()`, `list_agents()`, `create_session()`, `send_message_streaming()`. Each backend (Claude Code, OpenCode, Amp, Codex, Gemini) implements it. Unified `ExecutionEvent` enum with 8 variants covers thinking, tool calls, tool results, text, usage, completion, and errors. Shared NDJSON parser (`shared.rs`) handles the common streaming protocol with forward-compat `Unknown` variant. `BackendRegistry` manages multiple backends with a default. **Polaris has no equivalent interface — agent-specific logic is scattered across `agent-profiles.ts`, `SandboxAgentBootstrap`, `AcpBridge`, `event-types.ts`, and multiple orchestration files. Adding a new agent means touching 10+ files.**

- **Per-backend workspace config generation (★★★★★):** `write_backend_config()` dispatches to per-backend config writers. From a unified set of skills/MCPs/permissions, it generates each agent's native config format:
  - Claude Code → `.claude/settings.local.json`, `CLAUDE.md`, `.claude/skills/`
  - OpenCode → `opencode.json`, `.opencode/skill/`
  - Amp → `AGENTS.md`, `.agents/skills/`, `settings.json`
  - Codex → `~/.codex/config.toml`, `~/.codex/skills/`
  One set of skills in the Library, each agent gets them in its native format. **Polaris has agent-specific branching throughout the bootstrap logic.**

- **Git-backed Library (★★★★☆):** Skills, MCPs, commands, workspace templates all versioned in a git repo. Directory structure: `skill/<name>/SKILL.md`, `command/<name>.md`, `agent/<name>.md`, `configs/<profile>/`. Per-profile directories contain backend-specific settings. Changes are git-tracked and reviewable. **Polaris stores config in DB tables and scattered config files.**

- **Mission Kanban (★★★★☆):** Homepage shows 3-column Kanban: Running / Needs You / Finished. Stats cards: total tasks, active count, success rate, total cost. **Much more useful than Polaris's flat session list.**

- **System monitoring (★★★★☆):** Real-time CPU/memory/network graphs via WebSocket streaming. Per-container metrics. Sparkline histories. **Polaris has zero system monitoring or resource visibility.**

- **Agent tree visualization (★★★☆☆):** Canvas-based tree showing parent/child mission hierarchy. Visual representation of sub-agent workflows.

- **Worker peek modals (★★★☆☆):** See into individual agent workers with live terminal output. Inspect what each agent is doing without switching context.

- **Sophisticated automations (★★★☆☆):** Webhook-triggered, interval-based, or agent-finished triggers with retry config and stop policies. Auto-pause after consecutive failures.

**What's worse than Polaris:**

- **No CAS/epoch fencing.** Simpler state management, would not handle concurrent contention.
- **No PR review system.** No inline review, no repo-config-as-code.
- **Single-operator only.** No multi-tenant org model.
- **Self-hosted burden.** Requires Docker or Ubuntu 24.04 bare metal.

---

### 4. SWE-AF

**Architecture:** Batch autonomous engineering factory. One API call spawns a full pipeline: PM → architect → tech lead review → sprint planner → parallel DAG execution with three nested error-recovery loops → verification → PR. 16 agent roles (PM, architect, coder, reviewer, QA, tech lead, etc.) all invoked through a single unified harness. Uses Claude Code as the underlying runtime. Supports multi-repo orchestration with `primary` and `dependency` roles. All agent interactions have typed Pydantic schemas for input and output.

**What's better than Polaris:**

- **`router.harness()` — unified agent invocation (★★★★★):** Every agent role goes through ONE function that handles: provider routing, structured output extraction via Pydantic schemas, tool whitelisting, model selection per role, and turn budgeting. The sprint planner's `IssueGuidance.needs_deeper_qa` flag routes issues to different execution paths (2 vs 4 LLM calls). **Polaris has no equivalent — agent dispatch is scattered across `prompt-dispatch.ts`, `pr-review.ts`, `coding-task.ts` with different patterns in each. A unified harness would collapse all of these.**

- **Three-loop adaptive error recovery (★★★★★):**
  - **Inner loop:** coder → reviewer → fix cycle. If the review finds issues, feed them back to the coder.
  - **Middle loop:** Issue Advisor adapts strategy. Options: relax acceptance criteria, change approach, split the issue into smaller pieces, accept with technical debt.
  - **Outer loop:** Replanner restructures the entire execution DAG based on what's been learned.
  **Polaris has sweeper-based retry only — crude timeout + redispatch with no intelligence about *why* something failed or *what to do differently*.**

- **Pydantic schemas as agent contracts (★★★★☆):** Every agent interaction has typed input and output schemas. The schemas define what the agent receives and what it must return. Structured extraction replaces string parsing. **Polaris parses review output with regex heuristics in `output-parser.ts` — fragile, lossy, and hard to extend.**

- **Per-role model configuration (★★★★☆):** `models: { default: "sonnet", coder: "opus", qa: "opus" }` — each of 16 roles gets its own model. Different roles have different quality requirements — the coder needs deep reasoning (opus) while the PM needs speed (sonnet). **Polaris has one model per session or automation. No way to say "use opus for coding, sonnet for review."**

- **Cross-issue shared memory (★★★☆☆):** Conventions discovered by the first coder (naming patterns, import styles, architecture decisions) propagate to subsequent issues. Failure patterns feed-forward so later agents avoid known pitfalls. Interface registries track what each issue exports for dependency resolution. **Polaris has no cross-session learning.**

**What's worse than Polaris:**

- **Batch-only.** No interactive sessions — fire and forget.
- **No real-time UI.** No chat interface, no streaming, no preview.
- **No HITL.** No permission requests during execution.
- **No multi-tenant.** Single-operator tool.

---

### 5. AgentRove

**Architecture:** React frontend (Vite + Tauri for desktop) + Python/FastAPI backend + Docker/host sandboxes + Redis pub/sub + PostgreSQL. Uses `claude_agent_sdk` to manage Claude Code CLI sessions directly. SSE streaming via Redis pub/sub with `seq`-based reconnection. Events are persisted with sequential `seq` numbers; frontend reconnects via `afterSeq` parameter. Abstract `SandboxProvider` base class with `LocalDockerProvider` and `LocalHostProvider` implementations. Multi-provider via "anthropic-bridge" sidecar translating OpenAI/OpenRouter/Copilot API calls to Claude-compatible format.

**What's better than Polaris:**

- **Split-view workspace (★★★★★):** `MosaicSplitView` enables side-by-side views: Chat + Editor, Chat + Terminal, Chat + Web Preview, Chat + IDE (OpenVSCode Server), Chat + VNC Browser, Chat + Mobile Preview, Chat + Diff View. Each panel is resizable and toggleable. **Polaris has single-column chat only — the most minimal session UI of any repo studied.**

- **Tool component registry (★★★★★):** `getToolComponent()` maps tool names to lazy-loaded React components. Each tool gets its own specialized renderer:
  - Bash → terminal output with exit code and timing
  - Read → syntax-highlighted file content
  - Write/Edit → before/after diff view
  - Glob/Grep → file list with match highlights
  - WebSearch → search results with links
  - MCP → custom per-server rendering
  **Polaris renders ALL tools with a single generic `ToolCallItem` component. This is why agent output looks flat and uninformative.**

- **Segment builder pattern (★★★★★):** `buildSegments()` is a pure function: `AssistantStreamEvent[] → MessageSegment[]`. Handles:
  - Text batching (merge consecutive text events into one segment)
  - Tool call grouping (parent tool_call + child tool_result as one segment)
  - Thinking block collapsing
  - Out-of-order event handling (parent reassignment mid-stream)
  Completely separates event processing from rendering — both become independently testable. **Polaris's `consolidateEvents()` does similar work but mixes parsing, state tracking, dedup, and formatting in one 300+ line function.**

- **SSE streaming with seq-based reconnection (★★★★★):** `StreamEnvelope` typed wrapper: `{ chatId, messageId, streamId, seq, kind, payload }`. Sanitization built in. `StreamSnapshotAccumulator` batches events and flushes to DB every 200ms or 24 events (whichever first). On disconnect, client reconnects with `afterSeq` and gets only new events. **Polaris polls every 2s and re-fetches ALL events, making it the only repo without real-time delivery.**

- **ChatSessionOrchestrator pattern (★★★★☆):** Dedicated component that wires ALL hooks (streaming, permissions, models, initialization) into a context with separate `State` and `Actions` interfaces:
  ```
  ChatSessionContext.State  — read-only (events, status, model, ...)
  ChatSessionContext.Actions — mutations (send, cancel, setModel, ...)
  ```
  Split into separate files: `ChatSessionContextDefinition.ts` (interfaces), `ChatSessionContext.tsx` (provider), `useChatSessionContext.ts` (consumer). Page component just renders layout. **Polaris's `SessionDetailPage` is a 300-line god component mixing fetch, polling, HITL, prompt sending, and layout. Every change risks breaking something.**

- **StreamSnapshotAccumulator (★★★★☆):** Batches events and flushes to DB every 200ms or 24 events. Prevents per-event DB writes during fast streaming. **Polaris writes events one-at-a-time via REST callbacks.**

- **Message queue (★★★☆☆):** When the agent is busy, user messages queue with edit/cancel/send-now affordances. **Polaris blocks on one message at a time.**

- **Rich chat features (★★★☆☆):** Sub-threads (branching conversations from any message), command palette (Cmd+K), @mention system for agents/files/contexts, agent prompt suggestions, context usage indicator (token visualization), permission mode selector (Plan/Ask/Auto), thinking mode selector (Low/Medium/High/Ultra).

**What's worse than Polaris:**

- **No CAS state management.** State managed in-process — would race under concurrent access.
- **No PR review system.** No review automations, no inline threading.
- **No automation system.** No webhook-triggered workflows.
- **No multi-tenant.** Single-user deployment.
- **No sandbox snapshotting/hibernation.** Docker containers are ephemeral.

---

### 6. OpenHands

**Architecture:** Two coexisting architectures during migration. V0: monolithic Python backend with socket.io WebSockets, `AgentController` drives agent loop, `EventStream` as central pub/sub bus, runtime is Docker container with HTTP action execution server. V1: FastAPI app server + software-agent-sdk, WebSocket per conversation, ULID event identifiers. Events are first-class immutable objects with `id`, `timestamp`, `source` (user/agent/environment), and `cause` (parent event ID linking observations to actions). Multiple agent implementations: `CodeActAgent`, `BrowsingAgent`, `ReadonlyAgent` with delegation support.

**What's better than Polaris:**

- **Event as first-class typed abstraction (★★★★★):** This is the single most important finding from all 7 repos.
  ```
  Event (base) → Action (can be "runnable")
                   → CmdRunAction { command, thought }
                   → FileEditAction { path, content, thought }
                   → BrowseURLAction { url, thought }
                   → ... (~20+ action types)
               → Observation (has "content")
                   → CmdOutputObservation { output, exit_code, metadata }
                   → FileEditObservation { path, old_content, new_content }
                   → ErrorObservation { message, code }
                   → ... (mirrors each action type)
  ```
  Every event carries: `id`, `timestamp`, `source`, `cause` (parent event ID). Actions carry: `confirmation_state`, `security_risk`, `thought`. Observations carry typed domain-specific content.

  **Adding a new event type in OpenHands** means 5 isolated steps: (1) Create Python dataclass extending Action, (2) Add serialization mapping, (3) Add TypeScript interface, (4) Add type guard, (5) Add renderer. Each step is independent.

  **Adding a new event type in Polaris** means modifying `parseEventPayload()` (giant switch), `consolidateEvents()` (giant switch), `ChatItem` union, and `ChatItemRenderer` (giant switch). Every change touches 3-4 deeply coupled files. **This coupling is why Polaris is hard to evolve without bugs.**

- **Action-Observation pairing (★★★★★):** Actions linked to observations via `cause`/`action_id`. Rendered together as collapsible "action + result" blocks in the UI: "Edited file X" → expandable diff; "Ran command Y" → expandable terminal output. The `ObservationPairEventMessage` component handles this pairing. **Polaris shows tool calls as flat standalone items with no visible result. The user sees "Tool: write_file — completed" but never sees what was written.**

- **File edit diff display (★★★★☆):** `FileEditorObservation` captures `old_content` and `new_content`. Inline diffs render in the chat stream. **Polaris already has `diff-review/` components but only uses them in a separate review tab — never in the chat. This is a free win: reuse existing components in the chat stream.**

- **Type guard pattern for rendering (★★★★☆):** Instead of a giant switch statement in the renderer, type guards dispatch: `isUserMessage(event)`, `isErrorObservation(event)`, `isFinishAction(event)`. Each guard is testable, composable, and self-documenting. Content helpers (`get-action-content.ts`, `get-observation-content.ts`) extract human-readable summaries from structured event data. **Polaris's `ChatItemRenderer` is a switch on `item.type` — functional but less extensible.**

- **EventStream pub/sub bus (★★★★☆):** Subscribers register by ID with callbacks. Thread pools per subscriber for isolation. Secret replacement happens at the stream level. Event persistence is a write-through page cache. **Polaris has no event bus — events go DB → API → client poll → state, with no pub/sub layer.**

- **Agent delegation (★★★☆☆):** `AgentDelegateAction` lets one agent hand off to another agent type. Maps to child task spawning.

- **Task tracking / plan preview (★★★☆☆):** `TaskTrackerAction`/`TaskTrackerObservation` with `TaskItem[]` lists. `PlanPreview` component shows the agent's plan inline in chat. **Polaris has nothing similar — no visibility into what the agent plans to do.**

- **Integration Manager pattern (★★★☆☆):** Abstract `Manager[ViewInterface]` base class for all integrations. Each integration (Slack, Jira, Linear, GitHub, GitLab, Bitbucket) implements: a `Manager` (business logic), a `View` (templates/formatting), a `Types` module (data models), and a route handler. Includes a solvability classifier that ML-triages which issues are worth auto-solving.

**What's worse than Polaris:**

- **No CAS/epoch fencing.** Event-sourced but without Polaris's contention handling rigor.
- **No PR review system.** Can create PRs but no continuous review with config-as-code, no inline threading/resolution.
- **More complex deployment.** Requires Docker + Keycloak for auth. Polaris deploys to Vercel.
- **V0/V1 migration debt.** Two architectures coexisting with compatibility shims.

---

### 7. VibeSDK (Cloudflare)

**Architecture:** Durable Objects as AI agents — each chat session is one `SimpleCodeGeneratorAgent` DO instance with single-threaded consistency, persistent in-memory state, and built-in WebSocket. Explicit state machine: `IDLE → PHASE_GENERATING → PHASE_IMPLEMENTING → REVIEWING → FINALIZING`. Behavior polymorphism: `phasic` (structured multi-phase development) vs `agentic` (autonomous tool-calling). Each major action is a standalone operation class with `execute()`, typed inputs/outputs, and abort controller support. Service interfaces: `ICodingAgent`, `IFileManager`, `IStateManager`, `IDeploymentManager`, `IAnalysisManager`. WebSocket-first with ~30+ typed message types. State restoration on reconnect via `agent_connected` full state dump. D1 + Drizzle for persistence.

**What's better than Polaris:**

- **Formal state machine with enforced transitions (★★★★★):** `CurrentDevState` enum with explicit transitions. Operations check current state before proceeding — illegal transitions are blocked in code, not just in the DB. The state machine is the source of truth, not a DB column that gets CAS'd. **Polaris has status strings without formal enforcement. CAS operations catch contention but don't prevent illegal transitions at the application level.**

- **SessionStateStore — client-side state machine (★★★★★):** Single class that processes ALL incoming WebSocket events into one typed state object via `applyWsMessage()`. The entire UI is a pure projection of this state — no scattered `useState`, no derived state, no stale closures. Single point of state mutation makes behavior predictable and debuggable. **Polaris's `consolidateEvents()` is a 300+ line function that does parsing, state tracking, dedup, text merging, and output formatting in one pass. The `SessionDetailPage` component then adds more state on top. This layering is fragile — change one thing, break three others.**

- **Operations as standalone classes (★★★★☆):** `PhaseGeneration`, `PhaseImplementation`, `DeepDebugger`, `UserConversationProcessor`, `FileRegeneration` — each with `execute()`, typed inputs/outputs, and shared abort controller. Clean, testable, composable. Can be swapped, extended, or parallelized independently. **Polaris has ad-hoc functions in `lib/orchestration/` — `prompt-dispatch.ts`, `sandbox-lifecycle.ts`, `callback-processor.ts`. These are procedural, tightly coupled, and hard to test without the full Postgres setup.**

- **Phase timeline visualization (★★★★☆):** Visual timeline showing each development phase with status icons (generating → implementing → validating → completed). Per-file progress tracking within each phase. Blueprint preview before code generation begins. **Polaris has no progress visualization at all — the user sees a spinner with no context about what's happening.**

- **Real-time file streaming (★★★★☆):** File chunks stream via WebSocket. The editor shows the currently-generating file with a typing effect (`useFileContentStream` with configurable tokens-per-second). Users watch code being written in real-time.

- **Auto-view switching (★★★★☆):** UI automatically switches from blueprint → editor → preview as the session progresses. When a preview URL becomes available, the view switches to the preview pane with a tooltip notification.

- **Conversation during execution (★★★☆☆):** Users can send `user_suggestion` messages while code generation is in progress. The `UserConversationProcessor` handles these asynchronously without interrupting the main generation flow. **Polaris only accepts prompts when the agent is idle.**

- **Deep Debugger (★★★☆☆):** After generation, a separate agent (Gemini 2.5 Pro) runs with tools for runtime error detection, log analysis, and file regeneration. Key insight: **separate the builder from the debugger** — different models, different tools, different prompts.

- **BuildSession SDK (★★★☆☆):** Clean programmatic API: `session.wait.generationComplete()`, `session.phases.onChange(cb)`, `session.deployPreview()`, `session.followUp(message)`. If Polaris ever wants a public API, this is the design target.

- **WebSocket state restoration on reconnect (★★★☆☆):** On reconnect, server sends `agent_connected` with the full agent state. Client rebuilds its entire view from this single message — no incremental catch-up, no partial state.

- **Abort controller pattern (★★★☆☆):** `getOrCreateAbortController()` shares a single abort controller across nested operations. User cancellation kills the entire operation tree cleanly.

**What's worse than Polaris:**

- **Gemini-only.** No multi-agent support.
- **No PR review system.** Generates apps, doesn't review code.
- **No automation system.** No webhook triggers or scheduled reviews.
- **No multi-tenant.** Single-user deployment.
- **No CAS for contention.** Single-threaded DO avoids the problem rather than solving it — wouldn't scale to multi-process.

---

## Cross-Cutting Themes

### Theme 1: Real-Time Event Delivery (ALL 7 repos)
Every repo uses WebSockets or SSE for real-time events. Polaris is the **only one** that polls the database every 2 seconds. This is the root cause of the "poor interactive session UX."

| Repo | Transport | Reconnection |
|------|-----------|--------------|
| Background Agents | WebSocket | Token auth + subscribe-with-replay |
| AgentRove | SSE via Redis pub/sub | seq-based reconnection |
| VibeSDK | WebSocket | Full state dump on reconnect |
| OpenHands V0 | socket.io | Built-in reconnection |
| OpenHands V1 | WebSocket per conversation | Typed events |
| Sandboxed.sh | WebSocket | System metrics streaming |
| Vercel | Polling (5s) | None |
| **Polaris** | **Polling (2s)** | **Re-fetches ALL events** |

### Theme 2: Typed Event Hierarchy (5/7 repos)
Most repos have a proper, extensible event type system. Polaris parses raw JSON-RPC payloads ad-hoc through coupled functions.

| Repo | Event System |
|------|-------------|
| OpenHands | Action/Observation with causal `cause` field linking them |
| Sandboxed.sh | ExecutionEvent enum (8 variants, unified across all agents) |
| Background Agents | SandboxEvent discriminated union in shared package |
| AgentRove | StreamEnvelope with `kind` + typed payload |
| VibeSDK | ~30 WebSocket message types with discriminated unions |
| **Polaris** | **Raw JSON-RPC → parseEventPayload() → consolidateEvents() → ChatItem** |

### Theme 3: Agent Backend Interface (4/7 repos)
A clean contract that all agent implementations satisfy — adding a new agent means implementing one interface, not touching 10 files.

| Repo | Pattern | Quality |
|------|---------|---------|
| Sandboxed.sh | Rust Backend trait (5 methods) | Gold standard |
| SWE-AF | router.harness() unified invocation | Best for multi-role |
| OpenHands | Agent base class + Runtime abstraction | Most extensible |
| Vercel | switch/case + copy-paste per agent | Anti-pattern |
| **Polaris** | **agent-profiles.ts (good) but no execution interface** | **Profile layer is good, execution layer is missing** |

### Theme 4: Split-View Workspace (4/7 repos)
Multi-pane layout showing files, code, terminal, and preview alongside chat.

| Repo | Layout |
|------|--------|
| Vercel | 4-pane resizable (files + code + chat + preview) |
| AgentRove | Mosaic (chat + editor/terminal/preview/VNC/mobile) |
| VibeSDK | Chat left + live preview right with auto-switching |
| OpenHands | Chat + browser screenshots + terminal + file viewer |
| **Polaris** | **Single-column chat only** |

### Theme 5: Client-Side State Machine (3/7 repos)
A single state object updated by events, with the UI as a pure projection.

| Repo | Pattern |
|------|---------|
| VibeSDK | SessionStateStore with applyWsMessage() |
| Background Agents | sessionState updated from WebSocket |
| AgentRove | Zustand stores (streamStore, chatStore, uiStore) |
| **Polaris** | **Scattered useState + consolidateEvents() god function** |

### Theme 6: Tool-Specific Rendering (3/7 repos)
Each tool type gets its own specialized UI component instead of a generic renderer.

| Repo | Pattern |
|------|---------|
| AgentRove | getToolComponent() registry with lazy loading |
| OpenHands | Action-Observation pairing with collapsible blocks |
| VibeSDK | Phase-specific rendering with file progress |
| **Polaris** | **Single generic ToolCallItem for all tools** |

---

## Where Polaris Is Already Ahead

These are genuine competitive advantages. Don't lose them in a rewrite.

### 1. CAS State Machines with Epoch Fencing
More rigorous state management than any other repo. Background Agents and VibeSDK have state machines but no contention handling. Polaris's `casSessionStatus()`, `casJobStatus()`, `casAttemptStatus()` with epoch fencing prevent race conditions that every other repo is vulnerable to.

### 2. PR Review System
Continuous review with repo-config-as-code (`.polaris/reviews/*.yaml`), scoped `AGENTS.md` discovery, inline-review threading with resolution tracking, review lock queuing, and runtime drift detection. **NO other repo has anything close.** Background Agents has basic GitHub integration. SWE-AF has automated reviews but no inline threading. This is Polaris's moat.

### 3. Agent Profile Abstraction
Semantic intents (`autonomous`, `read-only`, `interactive`) mapped to agent-native flags. Call sites express intent, not implementation. Better than Vercel's switch/case, comparable to Sandboxed's Backend trait but at a higher level of abstraction.

### 4. HITL (Human-in-the-Loop)
First-class `PermissionRequest` and `QuestionRequest` with proper status tracking. Only OpenHands has something similar (`confirmation_state` on actions). Vercel, AgentRove, SWE-AF, VibeSDK have no HITL.

### 5. Automation System
Webhook-triggered review automations with `.polaris/reviews/*.yaml`. GitHub event routing via `trigger-router.ts`. SWE-AF has batch automation but not event-driven. Sandboxed.sh has mission automations but simpler.

### 6. Architecture Vision
`00-what-is-polaris.md` is the best architecture document of any repo studied. The future noun model (Task → Run → Attempt → Environment → ContinuationSession → Artifact → FeedbackThread) demonstrates clear thinking about where the product needs to go. No other repo has this level of strategic clarity.

---

## Prioritized Action Plan

### Phase 0: Foundation Fixes (Weeks 1-2)
*These unblock everything else and fix the core fragility.*

#### 0.1 — Event Type Layer
**Inspired by:** OpenHands (Action/Observation) + Sandboxed.sh (ExecutionEvent)

Create `lib/events/types.ts` with a proper hierarchy:
```typescript
interface BaseEvent {
  id: string;
  timestamp: string;
  source: 'user' | 'agent' | 'system';
  causeId?: string;  // Links observations to actions
}

type PolarisEvent =
  | ActionEvent    // user_prompt, agent_message, thinking
  | ToolEvent      // tool_call with actionId → tool_result
  | SystemEvent    // status_change, error, session_ended
  | HitlEvent;     // permission_request, question_request
```

Then split `consolidateEvents()` into two independent pure functions:
- `parseRawEvent(payload) → PolarisEvent | null` — pure parsing, testable
- `buildChatItems(events: PolarisEvent[]) → ChatItem[]` — pure display logic, testable

Every UI bug traces back to `consolidateEvents()` being a coupled monster. Typed events make parsing, storage, and rendering independently evolvable. Adding a new event type becomes: (1) add to union, (2) add parser case, (3) add renderer — each in isolation.

**Effort:** ~2-3 days

#### 0.2 — SessionStateStore (Client-Side State Machine)
**Inspired by:** VibeSDK (SessionStateStore) + AgentRove (Zustand stores)

Single class that processes events into typed state:
```typescript
class SessionStateStore {
  applyEvent(event: PolarisEvent): void;
  getState(): Readonly<SessionState>;
  subscribe(cb: (state: SessionState) => void): () => void;
}

type SessionState = {
  status: SessionStatus;
  turn: 'idle' | 'in_progress';
  events: PolarisEvent[];
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  activeToolCalls: Map<string, ToolCall>;
  currentMessage: string;
  currentThought: string;
};
```

Replaces: scattered `useState` in the page component, state tracking in `consolidateEvents()`, polling-driven re-renders. The UI becomes a pure projection of `SessionState`.

**Effort:** ~2-3 days

#### 0.3 — SSE for Real-Time Events
**Inspired by:** AgentRove (SSE + seq) + Background Agents (WebSocket + subscribe-with-replay)

Add SSE endpoint at `/api/sessions/[id]/stream`:
- On connect: send historical events (catch-up from `afterSeq`)
- On new callback: push event via Postgres `LISTEN/NOTIFY` or in-memory event emitter
- Client reconnects with `lastSeq` parameter — gets only new events

Adopt the `collapseTokenEvents` pattern from Background Agents: accumulate streaming text tokens in a ref, only trigger re-render on `execution_complete`. Prevents the re-render storms that make streaming UIs feel janky.

Start with SSE (simpler than WebSocket, works with serverless). Upgrade to WebSocket later if needed.

**Effort:** ~3-5 days

---

### Phase 1: UI Overhaul (Weeks 3-4)
*With the foundation in place, rebuild the session experience.*

#### 1.1 — Session Context Architecture
**Inspired by:** AgentRove (ChatSessionOrchestrator) + VibeSDK (state/actions split)

Extract `SessionOrchestrator` component. Split `State` and `Actions` interfaces. Page component renders layout only:
```
SessionPage (layout only — no business logic)
  └─ SessionOrchestrator (wires hooks → context)
      ├─ SessionStateProvider (read-only state from SessionStateStore)
      ├─ SessionActionsProvider (send prompt, approve permission, cancel, ...)
      └─ SessionLayout
          ├─ ChatPanel (consumes state, calls actions)
          ├─ DetailPanel (files/diff/preview — toggleable)
          └─ LogPanel (bottom — collapsible)
```

**Why:** `SessionDetailPage` is a 300-line god component. Every change risks breaking something unrelated. This decomposition mirrors what every mature repo does.

**Effort:** ~3-4 days

#### 1.2 — Tool Component Registry
**Inspired by:** AgentRove (getToolComponent()) + OpenHands (Action-Observation pairing)

Map tool types to specialized lazy-loaded renderers:
- `bash`/`command` → terminal output with exit code, timing, scrollable
- `write_file`/`edit_file` → inline diff view (reuse existing `diff-review/` components)
- `read_file` → syntax-highlighted code block
- `mcp_*` → custom per-server rendering
- default → current generic `ToolCallItem` (backward compatible)

Plus action-observation pairing: when a tool result arrives, link it to its parent tool call. Render as collapsible "action + result" block: "Edited `src/app.tsx`" → expandable diff.

**Why:** Tool calls are the majority of agent output. Generic rendering hides the most useful information — the actual code changes, command output, and file diffs.

**Effort:** ~3-4 days

#### 1.3 — Segment Builder
**Inspired by:** AgentRove (buildSegments())

Pure function: `PolarisEvent[] → MessageSegment[]`:
- Text batching: merge consecutive text events into one segment
- Tool call grouping: parent action + child result as one segment
- Thinking block collapsing: merge consecutive thinking events
- Out-of-order handling: buffer events until parent arrives

**Why:** Separates event processing from rendering. Both become independently testable. Currently these concerns are mixed in `consolidateEvents()`.

**Effort:** ~2 days

#### 1.4 — Split-View Layout
**Inspired by:** Vercel (4-pane) + AgentRove (MosaicSplitView)

Resizable multi-pane layout:
```
┌──────────────┬──────────────────┬──────────────┐
│ File Browser │  Code/Diff View  │  Chat Panel  │
│  (tree)      │  (Monaco/CM)     │  (existing)  │
│              │                  │              │
├──────────────┴──────────────────┴──────────────┤
│              Logs / Terminal                     │
└─────────────────────────────────────────────────┘
```
- Chat panel always visible
- Detail panel (file browser + code/diff viewer) — toggleable via button
- Preview panel (sandbox URL iframe) — toggleable
- Log/terminal panel (bottom) — collapsible with cookie-persisted height

Requires new API routes: `GET /api/sessions/:id/files` (tree), `GET /api/sessions/:id/files/:path` (content), and `GET /api/sessions/:id/preview-url`.

**Why:** This is the single biggest UX gap. Users need to see what the agent is doing to their code, not just read chat messages.

**Effort:** ~5-7 days

---

### Phase 2: Agent Abstraction (Weeks 5-6)
*Make the system evolvable for new agents.*

#### 2.1 — AgentBackend Interface
**Inspired by:** Sandboxed.sh (Backend trait) + SWE-AF (router.harness())

```typescript
interface AgentBackend {
  id: string;
  name: string;
  capabilities: AgentCapabilities;
  createSession(config: SessionConfig): Promise<AgentSession>;
  sendMessage(session: AgentSession, msg: string): AsyncIterable<PolarisEvent>;
  writeWorkspaceConfig(workspace: string, config: UnifiedConfig): Promise<void>;
}

// Implementations:
class ClaudeCodeBackend implements AgentBackend { ... }
class CodexBackend implements AgentBackend { ... }
class OpenCodeBackend implements AgentBackend { ... }  // future
class AmpBackend implements AgentBackend { ... }        // future
```

All agent-specific bootstrap, credential handling, event parsing, and workspace config generation moves INTO the backend implementation. The rest of the codebase only talks to `AgentBackend`. Polaris's existing `agent-profiles.ts` becomes the capabilities metadata layer on top of this execution interface.

**Why:** Adding OpenCode or Amp currently requires touching 10+ files. With this interface, it's one implementation file.

**Effort:** ~3-5 days

#### 2.2 — Unified Workspace Config Generation
**Inspired by:** Sandboxed.sh (write_backend_config())

Given a unified set of skills, MCPs, and permissions, `writeWorkspaceConfig()` generates each agent's native config format:
- Claude Code → `.claude/settings.local.json` + `.claude/skills/`
- Codex → `~/.codex/config.toml` + `~/.codex/skills/`
- Future agents → their native format

One source of truth for what the agent can do. Each backend translates to its native format.

**Why:** Eliminates agent-specific branching throughout the bootstrap logic.

**Effort:** ~2-3 days

#### 2.3 — Typed Output Schemas (Zod)
**Inspired by:** SWE-AF (Pydantic schemas for all agent output)

Define Zod schemas for every output type:
```typescript
const ReviewOutputSchema = z.object({
  verdict: z.enum(['approve', 'request_changes', 'comment']),
  summary: z.string(),
  findings: z.array(FindingSchema),
  suggestedChanges: z.array(SuggestedChangeSchema).optional(),
});
```

Replace regex parsing in `output-parser.ts` with structured extraction. Schemas are self-documenting, composable, and validate at runtime.

**Why:** Structured extraction is more reliable than regex. Current review output parsing is fragile and lossy.

**Effort:** ~2-3 days

---

### Phase 3: Advanced Features (Weeks 7+)
*Differentiation features once the foundation is solid.*

#### 3.1 — Child Task Spawning
**Inspired by:** Background Agents (spawn-task + guardrails)

Add `parent_job_id` to jobs table. Create `spawn-task` tool for the sandbox agent. Guardrails: `MAX_DEPTH=2`, `MAX_CONCURRENT=5`. Parent gets real-time status updates via event stream. UI shows sub-tasks in sidebar tree.

**Effort:** ~5-7 days

#### 3.2 — Adaptive Error Recovery
**Inspired by:** SWE-AF (three-loop recovery)

Move beyond sweeper-based timeout + redispatch. Add an "advisor" layer that evaluates *why* a task failed and adapts strategy: retry with different approach, relax constraints, split into smaller tasks, or accept with known limitations.

**Effort:** ~5-7 days

#### 3.3 — Per-Role Model Configuration
**Inspired by:** SWE-AF (models per role)

Let automations specify different models for different phases:
```yaml
models:
  planning: sonnet
  coding: opus
  review: sonnet
```

**Effort:** ~2-3 days

#### 3.4 — Session Kanban + Progress Visualization
**Inspired by:** Sandboxed.sh (mission kanban) + VibeSDK (phase timeline)

Replace flat session list with columns: Running / Needs Attention / Completed. Add per-session progress phases: provisioning → running → reviewing → completed.

**Effort:** ~3-4 days

#### 3.5 — Proactive Sandbox Warming
**Inspired by:** Background Agents (typing → warm sandbox)

Fire warm request on first keystroke in chat input. By the time the user hits enter, the sandbox is already provisioned. One new API endpoint + one `useEffect` in the chat input.

**Effort:** ~1-2 days

---

## The 5 Changes That Matter Most

| Priority | Change | Fixes | Inspired By | Effort |
|----------|--------|-------|-------------|--------|
| 1 | Event Type Layer | Root cause of fragility — coupled parsing/state/rendering | OpenHands + Sandboxed.sh | 2-3 days |
| 2 | Real-Time Streaming (SSE) | Root cause of poor UX — 2s polling lag | AgentRove + Background Agents | 3-5 days |
| 3 | SessionStateStore | Unpredictable UI state — scattered useState + god function | VibeSDK + AgentRove | 2-3 days |
| 4 | Tool Component Registry | Flat, uninformative agent output | AgentRove + OpenHands | 3-4 days |
| 5 | AgentBackend Interface | Can't add agents without touching 10+ files | Sandboxed.sh + SWE-AF | 3-5 days |

These five changes total ~14-20 days of focused work and address the two stated problems: **poor interactive session UX** (items 2, 3, 4) and **weak abstractions that make the system hard to evolve** (items 1, 5). Everything else in the action plan builds on top of them.
