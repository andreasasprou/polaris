# Polaris

Cloud platform for orchestrating autonomous coding agents. Polaris provisions ephemeral [Vercel Sandbox](https://vercel.com/docs/sandbox) VMs, runs AI agents (Claude Code, Codex, OpenCode, Amp) inside them, and manages the full lifecycle from prompt to pull request.

**Core capabilities:**

- **Interactive sessions** — Chat with coding agents in a browser-based UI with real-time event streaming, file attachments, and human-in-the-loop (permission requests, multi-choice questions).
- **Automated PR reviews** — Continuous, incremental code reviews triggered by GitHub webhooks. Supports severity classification, inline comments, review state tracking across passes, and configurable filters.
- **Coding task automation** — Trigger agent coding tasks from GitHub events. Agents clone repos, make changes, and open PRs automatically.
- **Multi-org, multi-agent** — Organizations manage their own GitHub installations, encrypted API keys, key pools, and sandbox environment variables. Agents are interchangeable per automation.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Database | PostgreSQL 16 (Drizzle ORM) |
| Auth | better-auth (email/password, GitHub OAuth, multi-org) |
| Agent Runtimes | Vercel Sandbox (ephemeral Linux VMs) |
| Agent Protocol | sandbox-agent SDK (ACP JSON-RPC) |
| UI | React 19, shadcn/ui, Tailwind CSS |
| Observability | evlog structured logging to Axiom |
| Testing | Vitest |

## Architecture

```
app/
  api/                        # REST API (37 route handlers)
    interactive-sessions/     #   Session CRUD, prompt dispatch, HITL replies
    webhooks/github/          #   GitHub webhook receiver (PR, push, comment events)
    callbacks/                #   HMAC-signed callbacks from sandbox proxy
    automations/              #   Automation CRUD, toggle, runs
    cron/sweeper/             #   Job recovery & sandbox lifecycle (every 2min)
    secrets/                  #   Encrypted API key management
    integrations/github/      #   GitHub App install flow & repo sync
    ...
  (dashboard)/                # Web UI — automations, sessions, runs, settings
  (auth)/                     # Login, onboarding wizard

lib/
  L0: Foundation
    http/                     # Request parsing
    metrics/                  # Step-level timing
    config/                   # App configuration
    errors/                   # Typed error catalog

  L1: Schema
    db/                       # Drizzle ORM, unified schema, migrations

  L2: Domain
    sessions/                 # Interactive session state machine & CAS operations
    jobs/                     # Job/attempt lifecycle, callback inbox
    reviews/                  # PR review domain (prompts, parsing, inline comments, filters)
    automations/              # Automation config, runs, sessions, review locks
    sandbox/                  # Vercel Sandbox provisioning, git ops, health monitor
    sandbox-agent/            # Agent bootstrap, event consolidation, credentials
    sandbox-proxy/            # REST proxy running inside sandbox (bundled, not live)
    integrations/             # GitHub App, Octokit, webhook verification
    compute/                  # Compute claims, lifecycle policies, controller
    secrets/                  # AES-256-GCM encrypted credential storage
    key-pools/                # Multi-key LRU allocation (FOR UPDATE SKIP LOCKED)
    routing/                  # GitHub event routing, deduplication, trigger matching
    auth/                     # better-auth config, session helpers

  L3: Orchestration
    prompt-dispatch.ts        # Two-tier dispatch (alive sandbox → provision → dispatch)
    sandbox-lifecycle.ts      # Provision, snapshot, restore, destroy
    pr-review.ts              # Review lock acquisition, filter, diff, prompt, dispatch
    coding-task.ts            # Coding task dispatch (clone → agent → commit → PR)
    callback-processor.ts     # Epoch-fenced, idempotent callback ingestion
    review-lifecycle.ts       # Post-review: parse, comment, check, lock release
    sweeper.ts                # Cron recovery: timeouts, stale locks, orphaned sandboxes
    credential-resolver.ts    # Resolve single key or pool allocation at dispatch time

components/                   # React UI (shadcn/ui primitives + domain components)
  sessions/                   #   Chat UI, tool calls, thinking blocks, HITL widgets
  ui/                         #   30+ shadcn/radix base components

hooks/                        # Custom hooks
  use-session-chat.ts         #   Event polling, consolidation, turn tracking
  use-auto-scroll.ts          #   Smart scroll with user-scroll detection
  use-prompt-history.ts       #   Arrow-key prompt recall

scripts/                      # E2E test scripts & build utilities
docs/                         # Architecture docs, exec plans, references
```

### Layer Architecture

Dependencies flow downward only (enforced by ESLint):

```
L0 Foundation  →  L1 Schema  →  L2 Domain  →  L3 Orchestration  →  L4 Presentation
```

### Key Architectural Patterns

- **Compare-and-set (CAS)** — All state transitions use atomic `UPDATE ... WHERE status = $current` to prevent races.
- **Epoch fencing** — Session epoch increments on each sandbox creation. Callbacks from stale sandboxes are rejected.
- **Compute claims** — Declarative "I need a sandbox" records. The sweeper controller reconciles claims against policies to destroy/hibernate idle sandboxes.
- **Callback-based async** — Dispatch returns 202 immediately. The sandbox proxy delivers HMAC-signed callbacks when work completes. The platform processes side effects (git push, PR creation, inline comments).
- **Outbox pattern** — Callbacks are persisted to the sandbox filesystem before delivery, replayed on restart with exponential backoff.
- **Lock-based review queue** — One review in flight per PR. Concurrent requests queue and drain automatically.

### Request Lifecycle

```
User sends prompt (or GitHub webhook fires)
  ↓
Dispatch: CAS session idle→active, create job + attempt
  ↓
POST /prompt to sandbox proxy (port 2469) → 202 Accepted
  ↓
Proxy launches agent via ACP bridge (port 2468)
  ↓
Agent runs, events streamed back via batched callbacks
  ↓
prompt_complete callback → parse output → post-process
  ↓
Side effects: git push, PR creation, inline comments, check run
  ↓
Session returns to idle, compute claim released
```

### Sandbox Communication

Agents run inside Vercel Sandbox VMs. Two servers run inside each sandbox:

- **sandbox-agent** (`:2468`) — ACP JSON-RPC server wrapping the agent CLI (Claude Code, Codex, etc.)
- **REST proxy** (`:2469`) — Polaris-specific HTTP server managing prompt lifecycle, event batching, and callback delivery

The proxy is **bundled code** — changes require `pnpm build:proxy` and redeployment.

Credentials never enter the sandbox. GitHub tokens are injected at the network level via Vercel's `networkPolicy` (Basic auth headers), and agent API keys are passed as environment variables to the sandbox process.

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- PostgreSQL 16 (Docker Compose provided)
- Vercel account with Sandbox access

### Quick Start

```bash
pnpm install
cp .env.example .env

# Start local PostgreSQL
docker compose up -d

# Run migrations
pnpm drizzle-kit migrate

# Start dev server (port 3001)
pnpm dev
```

### Environment Variables

#### Vercel Sandbox

```env
VERCEL_TOKEN=xxx
VERCEL_TEAM_ID=team_xxx
VERCEL_PROJECT_ID=prj_xxx
```

#### GitHub App

A GitHub App provides short-lived installation tokens scoped to specific repos. Required for cloning, pushing, and creating PRs.

1. Create a GitHub App at [github.com/settings/apps/new](https://github.com/settings/apps/new):
   - **Permissions**: Contents (Read & Write), Pull requests (Read & Write)
   - **Webhook**: Active, pointed at `<your-url>/api/webhooks/github`
   - **Events**: Pull request, Push, Issue comment (for `/review` commands)
2. Generate a private key and install the App on target repos.
3. Configure:

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_B64=LS0tLS1CRUdJTi...   # base64 -encoded PEM
GITHUB_WEBHOOK_SECRET=xxx
```

Base64-encode the PEM to avoid multiline issues:

```bash
echo "GITHUB_APP_PRIVATE_KEY_B64=$(base64 < ~/Downloads/your-app.private-key.pem | tr -d '\n')" >> .env
```

#### Agent API Keys

Manage keys through the web UI (**Settings > Secrets**) or set fallback env vars:

| Agent | API Key | OAuth Alternative |
|-------|---------|-------------------|
| Claude Code | `ANTHROPIC_API_KEY` | `CLAUDE_CODE_OAUTH_TOKEN` |
| Codex | `OPENAI_API_KEY` | `CODEX_AUTH_JSON_B64` |

API keys take precedence when both are set. OAuth tokens expire and need periodic refresh — API keys are more reliable for production.

#### Database

```env
DATABASE_URL=postgresql://polaris:polaris@localhost:5432/polaris
```

#### Auth & Encryption

```env
BETTER_AUTH_SECRET=xxx          # Session signing
ENCRYPTION_KEY=xxx              # AES-256-GCM for stored secrets
```

### Security Model

| Layer | Safeguard |
|-------|-----------|
| **Token scoping** | Installation tokens minted per-repo with only `contents: write` + `pull_requests: write`. |
| **Token lifetime** | GitHub tokens expire after 1 hour. |
| **Credential isolation** | Agent API keys encrypted at rest (AES-256-GCM). GitHub tokens injected via network policy — sandbox processes never see raw tokens. |
| **Sandbox isolation** | Agents run in ephemeral VMs destroyed after use. No persistent state. |
| **PR-only workflow** | Agents create PRs — they cannot merge. Human review required. |
| **Epoch fencing** | Stale sandbox callbacks rejected via monotonic session epoch. |

## Development

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server on port 3001 |
| `pnpm typecheck` | TypeScript check (must pass before any change is complete) |
| `pnpm test` | All tests (unit + integration) |
| `pnpm test:unit` | Fast unit tests (no DB) |
| `pnpm lint` | ESLint (enforces layer architecture) |
| `pnpm build:proxy` | Rebuild sandbox proxy bundle |
| `pnpm drizzle-kit generate` | Generate migration from schema changes |
| `pnpm drizzle-kit migrate` | Run pending migrations |

### E2E Test Scripts

```bash
# Sandbox connectivity
npx tsx scripts/test-sandbox.ts

# Agent in sandbox
npx tsx scripts/test-agent-claude.ts owner/repo
npx tsx scripts/test-agent-codex.ts owner/repo

# Full pipeline: sandbox → agent → git → PR
npx tsx scripts/test-full-pipeline.ts owner/repo "fix the typo in README" --agent claude

# PR review flow
npx tsx scripts/test-continuous-review.ts

# Job state machine + callbacks
npx tsx scripts/test-v2-e2e.ts
```

### Database Migrations

Always use `drizzle-kit generate` — never hand-write migration files. The build script (`scripts/vercel-build.mjs`) calls `drizzle-kit migrate` which reads `meta/_journal.json` to determine which migrations to run.

## Web UI

The dashboard is organized around four main sections:

- **Dashboard** — KPIs (active automations, runs today, PRs created, success rate) and recent activity.
- **Automations** — Create and manage event-driven workflows. Configure trigger type (GitHub push/PR), agent, model, prompt, credentials (single key or pool), and review settings.
- **Sessions** — Interactive chat with coding agents. Real-time event display with tool call visualization, thinking blocks, inline diffs, and HITL permission/question widgets.
- **Runs** — Execution history across all automations with status, duration, verdict, and PR links.

Configuration pages: **Integrations** (GitHub App install), **Settings > Secrets** (encrypted API keys), **Settings > Environment** (sandbox env vars).

## Observability

Production logs go to **Axiom** via evlog structured logging.

Query the `vercel` dataset:
```
['vercel'] | where ['request.path'] == "/api/webhooks/github"
['vercel'] | where level == "error" | project _time, message
```

Key fields: `request.path`, `request.statusCode`, `level`, `message` (JSON with evlog context).
