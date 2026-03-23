# Local Development & E2E Testing Guide

How to run Polaris locally with a dedicated test GitHub App and
create automated E2E tests that agents can run via `agent-browser`.

---

## 1. Prerequisites

```bash
# Install portless globally (HTTPS proxy for local dev)
npm install -g portless

# Start services
docker compose up -d          # PostgreSQL
pnpm install
```

## 2. Running the Dev Server

Polaris uses [portless](https://github.com/nicolo-ribaudo/portless)
for local HTTPS with a real TLD (`plrs.sh`). GitHub rejects `.localhost`
webhook URLs and some OAuth providers reject `.localhost` subdomains.

### One-time portless setup

```bash
npm install -g portless                              # global install
sudo portless proxy start --https -p 443 --tld sh    # HTTPS on port 443, .sh TLD
sudo portless trust                                  # trust local CA (no browser warnings)
```

Port 443 means no port in URLs. The proxy runs as a background daemon.

### Start the dev server

```bash
pnpm dev
# → https://polaris.local.plrs.sh
```

Bypass portless if needed:
```bash
pnpm dev:raw          # http://localhost:3000
PORTLESS=0 pnpm dev   # same, via env var
```

## 3. Environment Variables

Copy `.env.example` → `.env` and set:

```bash
# ── Required for basic local dev ──
DATABASE_URL=postgresql://polaris:polaris@localhost:5432/polaris
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# ── Better Auth URL (portless URL) ──
BETTER_AUTH_URL=https://polaris.local.plrs.sh

# ── GitHub OAuth (for login button — can be dummy for email/password) ──
GITHUB_CLIENT_ID=placeholder
GITHUB_CLIENT_SECRET=placeholder

# ── Test GitHub App (see Section 4 — auto-populated by setup script) ──
GITHUB_APP_ID=<test-app-id>
GITHUB_APP_PRIVATE_KEY_B64=<base64-encoded-pem>
GITHUB_APP_WEBHOOK_SECRET=$(openssl rand -hex 20)
GITHUB_APP_SLUG=polaris-test-dev
```

## 4. Create a Dedicated Test GitHub App

This app is **only for local development and testing**. It's installed
on a single throwaway repo so there's no risk to real codebases.

### Automated setup (recommended)

The setup script uses the GitHub App Manifest flow — it opens your
browser, you click "Create GitHub App", and it writes credentials to
`.env` automatically:

```bash
# Start portless proxy first (so the script detects your URL)
portless proxy start --https

# Run the setup script
pnpm tsx scripts/setup-github-app.ts
```

The script:
1. Opens `http://localhost:3456/setup` in your browser
2. Auto-submits a manifest to GitHub with correct permissions and URLs
3. You click "Create GitHub App" on GitHub
4. GitHub redirects back, the script exchanges the code for credentials
5. Writes `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY_B64`,
   `GITHUB_APP_WEBHOOK_SECRET`, and `GITHUB_APP_SLUG` to your `.env`

### After creating the app

1. Create a test fixture repo: `andreasasprou/polaris-test-fixture`
2. Install the app on it:
   ```
   https://github.com/apps/polaris-test-dev/installations/new
   ```
   Select "Only select repositories" → pick the test fixture repo.

### Manual setup

If the script doesn't work, see the
[GitHub docs on creating apps from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
or create the app manually at https://github.com/settings/apps/new with:

- **Homepage URL**: your portless URL (e.g., `https://polaris.local.plrs.sh`)
- **Callback URL**: `{portless-url}/api/integrations/github/callback`
- **Permissions**: Contents (R/W), Pull requests (R/W), Issues (R/W),
  Checks (R/W), Metadata (Read), Members (Read)
- Generate a private key → `base64 < key.pem | tr -d '\n'` → `GITHUB_APP_PRIVATE_KEY_B64`

## 5. Run Migrations

```bash
pnpm drizzle-kit push
# Or if that doesn't work:
pnpm drizzle-kit migrate
```

This ensures your local DB schema matches the code (e.g., the `source`
column on `interactive_sessions`).

## 6. Automated Test User Creation

Agents can create test users programmatically without browser interaction:

```bash
# Create a test user via the auth API
curl -X POST https://polaris.local.plrs.sh/api/auth/sign-up/email \
  -H "Content-Type: application/json" \
  -d '{
    "email": "e2e-test@polaris.dev",
    "password": "test-password-123",
    "name": "E2E Test User"
  }'

# Response includes a Set-Cookie header with the session token
# Extract it for authenticated requests
```

### In agent-browser:

```bash
# 1. Open the app
agent-browser --session e2e open https://polaris.local.plrs.sh/login

# 2. Sign up
agent-browser --session e2e snapshot -i
agent-browser --session e2e click @signUpTab
agent-browser --session e2e fill @firstName "E2E"
agent-browser --session e2e fill @lastName "Test"
agent-browser --session e2e fill @email "e2e-test@polaris.dev"
agent-browser --session e2e fill @password "test-password-123"
agent-browser --session e2e fill @confirmPassword "test-password-123"
agent-browser --session e2e click @createAccount
agent-browser --session e2e wait --load networkidle

# 3. Complete onboarding (skip GitHub if no app configured)
# ... or use the API to mark onboarding complete directly
```

### Programmatic onboarding bypass (for fast E2E setup):

```sql
-- After creating user via API, mark their org as onboarded:
UPDATE organization
SET metadata = jsonb_set(
  COALESCE(metadata, '{}'),
  '{onboardingCompletedAt}',
  to_jsonb(now()::text)
)
WHERE id = (
  SELECT organization_id FROM member
  WHERE user_id = (SELECT id FROM "user" WHERE email = 'e2e-test@polaris.dev')
  LIMIT 1
);
```

## 7. Seeding Test Data

### Seed a session with diff events (for Review tab testing)

```sql
-- 1. Find/create a session
INSERT INTO interactive_sessions (
  organization_id, created_by, prompt, status, sdk_session_id
) VALUES (
  '<org-id>',
  '<user-id>',
  'Test session with file edits',
  'idle',
  'test-sdk-session-001'
) RETURNING id;

-- 2. Insert events into sandbox_agent.events
-- The SDK stores events in the sandbox_agent schema
INSERT INTO sandbox_agent.events (id, event_index, session_id, created_at, connection_id, sender, payload_json)
VALUES
-- tool_call: Edit pending
('evt-001', 1, 'test-sdk-session-001', EXTRACT(EPOCH FROM now())::bigint * 1000, 'conn-1', 'server', '{
  "method": "session/update",
  "params": {
    "sessionId": "test-sdk-session-001",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "tc-001",
      "title": "Edit src/app.ts",
      "kind": "edit",
      "status": "completed",
      "locations": [{"path": "src/app.ts"}],
      "content": [{
        "type": "diff",
        "oldText": "const greeting = \"hello\";\nconsole.log(greeting);",
        "newText": "const greeting = \"hello world\";\nconsole.log(greeting);\nconsole.log(\"done\");"
      }]
    }
  },
  "jsonrpc": "2.0"
}'::jsonb),
-- tool_call: Write new file
('evt-002', 2, 'test-sdk-session-001', EXTRACT(EPOCH FROM now())::bigint * 1000 + 1000, 'conn-1', 'server', '{
  "method": "session/update",
  "params": {
    "sessionId": "test-sdk-session-001",
    "update": {
      "sessionUpdate": "tool_call",
      "toolCallId": "tc-002",
      "title": "Write src/utils.ts",
      "kind": "edit",
      "status": "completed",
      "locations": [{"path": "src/utils.ts"}],
      "content": [{
        "type": "diff",
        "oldText": "",
        "newText": "export function add(a: number, b: number) {\n  return a + b;\n}"
      }]
    }
  },
  "jsonrpc": "2.0"
}'::jsonb);
```

### Verify the seeded data

```bash
curl https://polaris.local.plrs.sh/api/sessions/test-sdk-session-001/events \
  -H "Cookie: <session-cookie>"
```

## 8. E2E Test Flow (agent-browser)

A complete E2E test that an agent can run:

```bash
#!/bin/bash
SESSION="polaris-e2e"

# 1. Create test user
agent-browser --session $SESSION open https://polaris.local.plrs.sh/login
agent-browser --session $SESSION wait --load networkidle
agent-browser --session $SESSION snapshot -i
agent-browser --session $SESSION click @signUpTab
agent-browser --session $SESSION fill @firstName "E2E"
agent-browser --session $SESSION fill @lastName "Test"
agent-browser --session $SESSION fill @email "e2e-$(date +%s)@test.dev"
agent-browser --session $SESSION fill @password "testpass123"
agent-browser --session $SESSION fill @confirmPassword "testpass123"
agent-browser --session $SESSION click @createAccount
agent-browser --session $SESSION wait --load networkidle

# 2. Skip onboarding (mark complete via DB)
psql $DATABASE_URL -c "UPDATE organization SET metadata = ... "

# 3. Navigate to dashboard
agent-browser --session $SESSION open https://polaris.local.plrs.sh/<org-slug>/dashboard
agent-browser --session $SESSION screenshot screenshots/dashboard.png

# 4. Check sidebar sessions
agent-browser --session $SESSION snapshot -i
# Verify session list renders

# 5. Navigate to a seeded session with diffs
agent-browser --session $SESSION open https://polaris.local.plrs.sh/<org-slug>/sessions/<session-id>
agent-browser --session $SESSION click @reviewTab
agent-browser --session $SESSION screenshot screenshots/review-tab.png
# Verify diff viewer renders

# 6. Cleanup
agent-browser --session $SESSION close
```

## 9. CI / Agent Testing with `emulate` (No GitHub App Needed)

For automated tests in CI or agent-driven E2E flows where you can't
install a real GitHub App, use the `emulate` package to run a local
GitHub API emulator.

```bash
# Start the GitHub emulator
npx emulate --service github --port 4001
```

Or in vitest:

```typescript
import { createEmulator } from 'emulate'

let github: Awaited<ReturnType<typeof createEmulator>>

beforeAll(async () => {
  github = await createEmulator({
    service: 'github',
    port: 4001,
    seed: {
      users: [{ login: 'testbot', name: 'Test Bot', email: 'bot@test.dev' }],
      repos: [{ owner: 'testbot', name: 'fixture', language: 'TypeScript', auto_init: true }],
      oauth_apps: [{
        client_id: 'test-client-id',
        client_secret: 'test-client-secret',
        name: 'Polaris Test',
        redirect_uris: ['https://polaris.local.plrs.sh/api/auth/callback/github'],
      }],
    },
  })
  process.env.GITHUB_EMULATOR_URL = github.url
})

afterAll(() => github.close())
```

Point Polaris at the emulator via env vars:

```bash
GITHUB_EMULATOR_URL=http://localhost:4001
GITHUB_CLIENT_ID=test-client-id
GITHUB_CLIENT_SECRET=test-client-secret
```

The emulator provides full-fidelity GitHub API responses (repos, PRs,
webhooks, OAuth) without needing a real GitHub App or private key.
See `.agents/skills/emulate/SKILL.md` for the full API reference.

### When to use which approach

| Scenario | Approach |
|----------|----------|
| Local dev (human) | Test GitHub App (Section 4) |
| Agent E2E via `agent-browser` | Either — emulator is faster |
| CI pipeline | Emulator (no secrets needed) |
| Testing webhook flows | Emulator + seed webhooks |
| Testing real GitHub integration | Test GitHub App |

## 11. Webhook Forwarding (Optional)

For testing GitHub webhooks locally:

```bash
# Install smee-client
npx smee-client --url https://smee.io/YOUR_CHANNEL --target https://polaris.local.plrs.sh/api/webhooks/github
```

Or use `ngrok`:
```bash
ngrok http 3001
# Update the GitHub App webhook URL to the ngrok URL
```

## 12. Troubleshooting

### "source column does not exist"
Run migrations: `pnpm drizzle-kit push`

### Login redirects to /onboarding endlessly
The org's `metadata.onboardingCompletedAt` is not set. Run the SQL
in Section 5 to bypass onboarding.

### "No sessions found" in sidebar
The sidebar filters by `source = 'user'`. If the column doesn't exist
in your local DB, run migrations first. If it exists but sessions don't
have `source` set, update them:
```sql
UPDATE interactive_sessions SET source = 'user' WHERE source IS NULL;
```
(Note: `source` may not exist yet if migrations are behind.)

### GitHub App installation fails
Check that:
- `GITHUB_APP_SLUG` matches exactly
- Callback URL in the app settings matches your local URL
- Private key is correctly base64-encoded (no line breaks)
