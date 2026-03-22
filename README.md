# Polaris

Cloud platform for orchestrating autonomous coding agents. Polaris provisions ephemeral [Vercel Sandbox](https://vercel.com/docs/sandbox) VMs, runs AI agents inside them, and manages the full lifecycle from prompt to pull request.

**Core capabilities:**

- **Interactive sessions** — Chat with coding agents in a browser-based UI with real-time event streaming, file attachments, and human-in-the-loop (permission requests, multi-choice questions).
- **Automated PR reviews** — Continuous, incremental code reviews triggered by GitHub webhooks. Supports severity classification, inline comments, review state tracking, and configurable filters.
- **Coding task automation** — Trigger agent coding tasks from GitHub events. Agents clone repos, make changes, and open PRs automatically.
- **Multi-org, multi-agent** — Organizations manage their own GitHub installations, encrypted API keys, key pools, and sandbox environment variables.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Framework | Next.js (App Router) |
| Database | PostgreSQL (Drizzle ORM) |
| Auth | better-auth (email/password, GitHub OAuth, multi-org) |
| Agent Runtimes | Vercel Sandbox (ephemeral Linux VMs) |
| Agent Protocol | sandbox-agent SDK (ACP JSON-RPC) |
| UI | React, shadcn/ui, Tailwind CSS |
| Observability | evlog structured logging to Axiom |
| Testing | Vitest |

## Architecture

See **[ARCHITECTURE.md](ARCHITECTURE.md)** for the full module map, state machines, request lifecycle traces, and sandbox communication details.

**Layer architecture** — dependencies flow downward only (enforced by ESLint):

```
L0 Foundation  →  L1 Schema  →  L2 Domain  →  L3 Orchestration  →  L4 Presentation
```

**Key patterns:**

- **Compare-and-set (CAS)** state transitions to prevent races
- **Epoch fencing** to reject callbacks from stale sandboxes
- **Callback-based async** — dispatch returns 202; the in-sandbox proxy delivers HMAC-signed callbacks when work completes
- **Lock-based review queue** — one review in flight per PR

## Setup

### Prerequisites

- Node.js 18+
- pnpm
- PostgreSQL (Docker Compose provided)
- Vercel account with Sandbox access

### Quick Start

```bash
pnpm install
cp .env.example .env
# Fill in the required values — see .env.example for documentation

# Start local PostgreSQL
docker compose up -d

# Run migrations
pnpm drizzle-kit migrate

# Start dev server
pnpm dev
```

### Environment Variables

All required variables are documented in **`.env.example`**. The key groups:

| Group | Variables | Notes |
|-------|-----------|-------|
| Database | `DATABASE_URL`, `ENCRYPTION_KEY` | Encryption key for AES-256-GCM secret storage |
| Auth | `BETTER_AUTH_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | GitHub OAuth for user login |
| GitHub App | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`, `GITHUB_APP_WEBHOOK_SECRET`, `GITHUB_APP_SLUG` | See [GitHub App setup](#github-app) below |
| Vercel Sandbox | `VERCEL_TOKEN`, `VERCEL_TEAM_ID`, `VERCEL_PROJECT_ID` | |
| Agent API Keys | Managed via web UI (**Settings > Secrets**) | Per-org encrypted storage; env var fallbacks available |

#### GitHub App

A GitHub App provides short-lived installation tokens scoped to specific repos. Required for cloning, pushing, and creating PRs.

1. Create a GitHub App at [github.com/settings/apps/new](https://github.com/settings/apps/new):
   - **Permissions**: Contents (Read & Write), Pull requests (Read & Write)
   - **Webhook**: Active, pointed at `<your-url>/api/webhooks/github`
   - **Events**: Pull request, Push, Issue comment
2. Generate a private key and install the App on target repos.
3. Base64-encode the PEM to avoid multiline issues:

```bash
echo "GITHUB_APP_PRIVATE_KEY_B64=$(base64 < ~/Downloads/your-app.private-key.pem | tr -d '\n')" >> .env
```

### Security Model

| Layer | Safeguard |
|-------|-----------|
| **Token scoping** | Installation tokens minted per-repo with minimal permissions |
| **Credential isolation** | Agent API keys encrypted at rest (AES-256-GCM). GitHub tokens injected via network policy — sandbox processes never see raw tokens |
| **Sandbox isolation** | Agents run in ephemeral VMs destroyed after use. No persistent state |
| **PR-only workflow** | Agents create PRs — human review required before merge |
| **Epoch fencing** | Stale sandbox callbacks rejected via monotonic session epoch |

## Development

### Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Dev server |
| `pnpm typecheck` | TypeScript check (must pass before any change is complete) |
| `pnpm test` | All tests (unit + integration) |
| `pnpm test:unit` | Fast unit tests (no DB) |
| `pnpm lint` | ESLint (enforces layer architecture) |

### Database Migrations

Always use `drizzle-kit generate` — never hand-write migration files. The build script runs `drizzle-kit migrate` which reads `meta/_journal.json` to determine pending migrations.

## Web UI

- **Dashboard** — KPIs and recent activity
- **Automations** — Event-driven workflows: trigger type, agent, model, prompt, credentials, review settings
- **Sessions** — Interactive chat with coding agents, tool call visualization, HITL widgets
- **Runs** — Execution history with status, duration, verdict, and PR links
- **Settings** — Integrations (GitHub App), Secrets (encrypted API keys), Environment (sandbox env vars)
