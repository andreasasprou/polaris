# Polaris

Autonomous coding agent orchestration platform. Triggers coding tasks from Slack commands or Sentry webhooks, runs Claude Code or Codex inside Vercel Sandbox VMs, and opens PRs with the results.

## Architecture

```
lib/
  sandbox/          # Vercel Sandbox lifecycle, command execution, git ops
  agents/           # Abstract agent pattern — Claude Code + Codex implementations
  orchestration/    # Task payload types, prompt builder, Trigger.dev metadata
  integrations/     # Slack, GitHub App, Sentry

trigger/            # Trigger.dev tasks (coding-task, slack notifications, PR creation)
app/api/            # Next.js API routes (Slack commands, Sentry webhook, task status)
scripts/            # Standalone E2E test scripts
```

## Setup

```bash
pnpm install
cp .env.example .env
```

### Vercel Sandbox

Polaris uses [Vercel Sandbox](https://vercel.com/docs/sandbox) to run agents in ephemeral Linux VMs.

```env
VERCEL_TOKEN=xxx
VERCEL_TEAM_ID=team_xxx
VERCEL_PROJECT_ID=prj_xxx
```

### GitHub App

A GitHub App provides short-lived installation tokens for cloning repos and pushing branches. This is the recommended approach for backend automation — tokens are scoped to specific repos and permissions, and expire after 1 hour.

#### Creating the App

1. Go to [github.com/settings/apps/new](https://github.com/settings/apps/new)
2. Fill in:
   - **Name**: `polaris-agent` (must be globally unique)
   - **Homepage URL**: any URL (e.g. `https://example.com`)
   - **Webhook**: uncheck "Active" (not needed)
3. Under **Permissions → Repository**, set:
   - **Contents**: Read & Write (clone repos, push to `agent/*` branches)
   - **Pull requests**: Read & Write (create PRs)
   - Leave everything else as "No access"
4. Under **Where can this GitHub App be installed?**, select "Only on this account"
5. Click **Create GitHub App**

#### Getting credentials

On the app settings page after creation:
1. Copy the **App ID** shown near the top
2. Scroll to **Private keys** → click **Generate a private key** (downloads a `.pem` file)

#### Installing on repos

1. Go to your app's page → **Install App** (left sidebar)
2. Click **Install** next to your account
3. Select **"Only select repositories"** and pick only the repos you want agents to work on

#### Configuring credentials

All secrets should be stored in the **Trigger.dev dashboard** for production. Only use `.env` for local development.

The private key is best stored as base64 to avoid multiline PEM issues:

```bash
# Base64 encode the PEM file
export GITHUB_APP_PRIVATE_KEY_B64="$(base64 < ~/Downloads/polaris-agent.*.private-key.pem | tr -d '\n')"

# Add to .env for local dev
echo "GITHUB_APP_PRIVATE_KEY_B64=$(base64 < ~/Downloads/polaris-agent.*.private-key.pem | tr -d '\n')" >> .env
```

```env
GITHUB_APP_ID=123456
GITHUB_APP_PRIVATE_KEY_B64=LS0tLS1CRUdJTi...
```

The raw `GITHUB_APP_PRIVATE_KEY` (PEM string) is also supported as a fallback but not recommended for CI/dashboard use.

#### Where to store secrets

| Environment | Where | Notes |
|-------------|-------|-------|
| **Local dev** | `.env` file (gitignored) | For running test scripts |
| **Production** | [Trigger.dev dashboard](https://cloud.trigger.dev) → Project → Environment Variables | Available to all tasks at runtime |
| **CI/GitHub Actions** | GitHub repo → Settings → Secrets | For deploy workflows |

All sensitive values (`GITHUB_APP_PRIVATE_KEY_B64`, `CLAUDE_CODE_OAUTH_TOKEN`, `CODEX_AUTH_JSON_B64`, `VERCEL_TOKEN`) should use base64 encoding where possible — it avoids quoting issues and works reliably across all environments.

#### Security model

Polaris is designed to limit the blast radius of agent actions:

| Layer | Safeguard |
|-------|-----------|
| **Branch restriction** | Code enforces agents can only create/push to `agent/*` branches. Pushing to `main` or any other prefix is blocked at the application level. |
| **Token scoping** | Each installation token is minted for a single repo with only `contents: write` + `pull_requests: write`. No admin, no merge, no branch protection changes. |
| **Token lifetime** | Installation tokens expire after 1 hour (GitHub default). |
| **Sandbox isolation** | Agents run in ephemeral Vercel Sandbox VMs that are destroyed after each task. Tokens don't persist. |
| **PR-only workflow** | Agents create PRs — they cannot merge. A human must review and merge. |
| **Selective installation** | The App is only installed on repos you explicitly choose. |

#### Recommended: branch protection

For each repo the App is installed on, set up branch protection on `main`:

1. Go to **Settings → Branches → Add branch ruleset** (or "Add rule" for classic protection)
2. Branch name pattern: `main`
3. Enable:
   - **Require a pull request before merging**
   - **Require approvals** (at least 1)
   - **Require status checks to pass** (optional, but recommended)
4. Do **not** check "Allow specified actors to bypass" for the App

This ensures that even with `contents: write`, the App cannot push directly to `main` or merge PRs without review.

### Agent Authentication

Each agent supports two auth modes: an API key or an OAuth token from your existing subscription. OAuth lets you use your Claude Max/Pro or ChatGPT Pro subscription instead of paying for API usage separately.

Set `DEFAULT_AGENT` to choose the default agent (`claude` or `codex`).

#### Claude Code

Use **one** of:

| Method | Env var | How to get it |
|--------|---------|---------------|
| API key | `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com/) — starts with `sk-ant-` |
| OAuth token | `CLAUDE_CODE_OAUTH_TOKEN` | Stored locally by Claude Code after `claude auth login`. Check your local Claude Code config or export it from your session. |

When both are set, `ANTHROPIC_API_KEY` takes precedence.

#### Codex

Use **one** of:

| Method | Env var | How to get it |
|--------|---------|---------------|
| API key | `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com/) — starts with `sk-` |
| OAuth (ChatGPT) | `CODEX_AUTH_JSON_B64` | Base64-encoded `~/.codex/auth.json` from a ChatGPT-authenticated Codex session |

To generate `CODEX_AUTH_JSON_B64`:

```bash
# 1. Authenticate codex (if not already)
codex auth

# 2. Export as base64
export CODEX_AUTH_JSON_B64="$(base64 < ~/.codex/auth.json | tr -d '\n')"

# Or add to .env
echo "CODEX_AUTH_JSON_B64=$(base64 < ~/.codex/auth.json | tr -d '\n')" >> .env
```

When both are set, `OPENAI_API_KEY` takes precedence.

> **Note:** OAuth tokens expire and need periodic refresh. For production use, API keys are more reliable.

### Slack (optional)

```env
SLACK_SIGNING_SECRET=xxx
SLACK_BOT_TOKEN=xoxb-xxx
```

### Sentry (optional)

```env
SENTRY_WEBHOOK_SECRET=xxx
REQUIRE_SENTRY_APPROVAL=false
```

## Testing

Each component can be tested independently with real API keys:

```bash
# 1. Sandbox connectivity
npx tsx scripts/test-sandbox.ts

# 2. Claude Code with OAuth
npx tsx scripts/test-claude-oauth.ts

# 3. Codex with OAuth
CODEX_AUTH_JSON_B64="$(base64 < ~/.codex/auth.json | tr -d '\n')" npx tsx scripts/test-codex-oauth.ts

# 4. Git operations (needs GitHub App creds)
npx tsx scripts/test-git.ts owner/repo

# 5. Full agent run (needs all creds)
npx tsx scripts/test-agent-claude.ts owner/repo
npx tsx scripts/test-agent-codex.ts owner/repo

# 6. Full pipeline: sandbox → agent → git → PR
npx tsx scripts/test-full-pipeline.ts owner/repo "fix the typo in README" --agent claude
```

## Trigger.dev

```bash
npx trigger dev   # local development
npx trigger deploy # production
```

## Slack Commands

- `/agent owner/repo your prompt [--agent claude|codex]` — start a new coding task
- `/agent-followup run_xxx follow-up instruction` — continue on an existing branch
