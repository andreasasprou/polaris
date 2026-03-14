# Deployment Guide

Fresh deployment guide for Polaris — from zero to running.

## Prerequisites

- Node.js 20+
- pnpm
- PostgreSQL 13+
- Accounts: GitHub, [Trigger.dev](https://trigger.dev), [Vercel](https://vercel.com) (for sandbox VMs)

## 1. External Service Setup

### PostgreSQL

Create a database. Any managed provider works (Neon, Supabase, Vercel Postgres, RDS) or self-hosted.

```
postgresql://user:password@host:5432/polaris
```

### GitHub OAuth App (user login)

1. Go to **Settings → Developer settings → OAuth Apps → New**
2. Set callback URL to `https://<your-domain>/api/auth/callback/github`
3. Save the **Client ID** and **Client Secret**

### GitHub App (repo access + webhooks)

1. Go to **Settings → Developer settings → GitHub Apps → New**
2. Configure:
   - **Webhook URL**: `https://<your-domain>/api/webhooks/github`
   - **Webhook secret**: generate with `openssl rand -hex 20`
3. **Permissions** (Repository):
   - Contents: **Read & Write**
   - Pull requests: **Read & Write**
   - Checks: **Read & Write**
4. **Subscribe to events**: `push`, `pull_request`, `issue_comment`
5. Generate a **private key** → base64 encode:
   ```bash
   base64 < your-app.private-key.pem | tr -d '\n'
   ```
6. Install the app on your target repositories

### Trigger.dev

1. Create a project at [cloud.trigger.dev](https://cloud.trigger.dev)
2. Note the **project ref** — update `trigger.config.ts` if it differs
3. Copy the **secret key** (`tr_dev_*` for dev, `tr_prod_*` for production)

### Vercel (Sandbox VMs)

Polaris runs coding agents in Vercel Sandbox VMs. You need:

1. A Vercel **API token** (Account Settings → Tokens)
2. Your **Team ID** (`team_xxx` — from Vercel dashboard URL)
3. A **Project ID** (`prj_xxx` — create a project, any name, it's just for sandbox allocation)

## 2. Environment Variables

Copy `.env.example` to `.env.local` and fill in all values:

```bash
cp .env.example .env.local
```

| Variable | Required | How to get |
|----------|----------|------------|
| `DATABASE_URL` | Yes | Your Postgres provider |
| `ENCRYPTION_KEY` | Yes | `openssl rand -hex 32` |
| `BETTER_AUTH_SECRET` | Yes | `openssl rand -base64 32` |
| `GITHUB_CLIENT_ID` | Yes | GitHub OAuth app |
| `GITHUB_CLIENT_SECRET` | Yes | GitHub OAuth app |
| `GITHUB_APP_ID` | Yes | GitHub App settings |
| `GITHUB_APP_PRIVATE_KEY_B64` | Yes | Base64-encoded PEM (see above) |
| `GITHUB_APP_WEBHOOK_SECRET` | Yes | The secret you set on the GitHub App |
| `TRIGGER_SECRET_KEY` | Yes | Trigger.dev dashboard |
| `VERCEL_TOKEN` | Yes | Vercel account settings |
| `VERCEL_TEAM_ID` | Yes | Vercel dashboard |
| `VERCEL_PROJECT_ID` | Yes | Vercel project settings |
| `APP_BASE_URL` | Prod | Your deployment URL (e.g. `https://plrs.sh`) |

> **Agent API keys** (Anthropic, OpenAI) are configured per-organization in **Settings → Secrets**, not as platform env vars. Each org manages its own credentials.

> **Slack and Sentry integrations** are planned for a future release with full multi-tenant support (per-org OAuth flows).

## 3. Install & Build

```bash
pnpm install
pnpm typecheck        # verify everything compiles
pnpm build            # build Next.js app
```

## 4. Database Migration

### First-time setup (local)

For quick local iteration, push the schema directly:

```bash
pnpm drizzle-kit push
```

### Production

Migrations run automatically during `pnpm build` on Vercel production deploys (gated by `VERCEL_ENV=production`). The build script (`scripts/vercel-build.mjs`) runs `drizzle-kit migrate` before `next build`.

To generate a new migration after schema changes:

```bash
pnpm drizzle-kit generate
```

Commit the generated SQL file in `lib/db/migrations/` — it will be applied on the next production deploy.

The `sandbox_agent` schema (agent event persistence) is auto-created at runtime — no manual setup needed.

## 5. Deploy Trigger.dev Tasks

Trigger.dev tasks run on Trigger.dev's infrastructure, deployed separately:

```bash
npx trigger.dev@latest deploy
```

This deploys all tasks in the `trigger/` directory. Must be authenticated — run `npx trigger.dev@latest login` first if needed.

## 6. Deploy the App

### Vercel (recommended)

```bash
vercel --prod
```

Set all environment variables in the Vercel dashboard (Settings → Environment Variables).

### Docker / VPS

```bash
pnpm build
pnpm start   # starts on port 3000
```

Set `PORT` to customize.

### Key URLs after deploy

| Endpoint | Purpose |
|----------|---------|
| `/` | Dashboard |
| `/login` | User authentication |
| `/api/webhooks/github` | GitHub webhook receiver |
| `/api/auth/*` | Better Auth endpoints |

## 7. Post-Deploy Verification

1. **Login**: Visit `https://<your-domain>/login` — sign in with GitHub
2. **Create org**: First user is prompted to create an organization
3. **Add agent secret**: Go to Settings → Secrets → add your Anthropic or OpenAI API key
4. **Install GitHub App**: Go to Settings → Integrations → Install GitHub App
5. **Verify webhooks**: Push to a connected repo — check the Runs page for activity
6. **Check Trigger.dev**: Open the Trigger.dev dashboard to see task executions

## Architecture Overview

```
GitHub webhooks
      │
      ▼
 Next.js API routes (webhook verification + routing)
      │
      ▼
 Trigger.dev tasks (orchestration + lifecycle)
      │
      ▼
 Vercel Sandbox VMs (agent execution)
      │
      ▼
 Git push → PR creation
```

- **PostgreSQL**: All state — sessions, runs, agent events, secrets (AES-256-GCM encrypted)
- **Trigger.dev**: Async task orchestration, durable execution, suspend/resume
- **Vercel Sandbox**: Ephemeral VMs for running coding agents (Claude Code, Codex)
- **No Redis/cache**: All state lives in Postgres
