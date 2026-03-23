# Local Development & E2E Testing Guide

How to run Polaris locally with a dedicated test GitHub App and
create automated E2E tests that agents can run via `agent-browser`.

---

## 1. Prerequisites

```bash
docker compose up -d          # PostgreSQL
pnpm install
```

## 2. Environment Variables

Copy `.env.example` → `.env` and set:

```bash
# ── Required for basic local dev ──
DATABASE_URL=postgresql://polaris:polaris@localhost:5432/polaris
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
ENCRYPTION_KEY=$(openssl rand -hex 32)

# ── GitHub OAuth (for login button — can be dummy for email/password) ──
GITHUB_CLIENT_ID=placeholder
GITHUB_CLIENT_SECRET=placeholder

# ── Test GitHub App (see Section 3) ──
GITHUB_APP_ID=<test-app-id>
GITHUB_APP_PRIVATE_KEY_B64=<base64-encoded-pem>
GITHUB_APP_WEBHOOK_SECRET=$(openssl rand -hex 20)
GITHUB_APP_SLUG=polaris-test-dev
```

## 3. Create a Dedicated Test GitHub App

This app is **only for local development and testing**. It's installed
on a single throwaway repo so there's no risk to real codebases.

### Step 1: Create the test repo

1. Go to https://github.com/new
2. Create `andreasasprou/polaris-test-fixture` (public or private)
3. Add a README.md and a few dummy files so the agent has something to edit

### Step 2: Create the GitHub App

1. Go to https://github.com/settings/apps/new
2. Fill in:
   - **App name**: `polaris-test-dev`
   - **Homepage URL**: `http://localhost:3001`
   - **Callback URL**: `http://localhost:3001/api/integrations/github/callback`
   - **Setup URL**: `http://localhost:3001/api/integrations/github/callback` (check "Redirect on update")
   - **Webhook URL**: `https://smee.io/YOUR_CHANNEL` (use [smee.io](https://smee.io) for local webhook forwarding, or leave blank and disable webhooks for now)
   - **Webhook secret**: same as `GITHUB_APP_WEBHOOK_SECRET` in your `.env`
3. **Permissions**:
   - Repository:
     - Contents: Read & Write
     - Pull requests: Read & Write
     - Issues: Read & Write
     - Checks: Read & Write
     - Metadata: Read-only
   - Organization:
     - Members: Read-only
4. **Subscribe to events**: `pull_request`, `push` (optional for testing)
5. Click "Create GitHub App"
6. Note the **App ID** → set as `GITHUB_APP_ID`
7. Generate a **private key** → download the `.pem` file

### Step 3: Encode and store the private key

```bash
# Encode the PEM file
base64 < polaris-test-dev.private-key.pem | tr -d '\n'
# Copy the output → GITHUB_APP_PRIVATE_KEY_B64 in .env
```

### Step 4: Install on the test repo

1. Go to `https://github.com/apps/polaris-test-dev/installations/new`
2. Select your account
3. Choose "Only select repositories" → pick `polaris-test-fixture`
4. Click Install

### Step 5: Verify

```bash
pnpm dev
# Go to http://localhost:3001, sign up, complete onboarding
# The test repo should appear in the repo selector
```

## 4. Run Migrations

```bash
pnpm drizzle-kit push
# Or if that doesn't work:
pnpm drizzle-kit migrate
```

This ensures your local DB schema matches the code (e.g., the `source`
column on `interactive_sessions`).

## 5. Automated Test User Creation

Agents can create test users programmatically without browser interaction:

```bash
# Create a test user via the auth API
curl -X POST http://localhost:3001/api/auth/sign-up/email \
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
agent-browser --session e2e open http://localhost:3001/login

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

## 6. Seeding Test Data

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
curl http://localhost:3001/api/sessions/test-sdk-session-001/events \
  -H "Cookie: <session-cookie>"
```

## 7. E2E Test Flow (agent-browser)

A complete E2E test that an agent can run:

```bash
#!/bin/bash
SESSION="polaris-e2e"

# 1. Create test user
agent-browser --session $SESSION open http://localhost:3001/login
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
agent-browser --session $SESSION open http://localhost:3001/<org-slug>/dashboard
agent-browser --session $SESSION screenshot screenshots/dashboard.png

# 4. Check sidebar sessions
agent-browser --session $SESSION snapshot -i
# Verify session list renders

# 5. Navigate to a seeded session with diffs
agent-browser --session $SESSION open http://localhost:3001/<org-slug>/sessions/<session-id>
agent-browser --session $SESSION click @reviewTab
agent-browser --session $SESSION screenshot screenshots/review-tab.png
# Verify diff viewer renders

# 6. Cleanup
agent-browser --session $SESSION close
```

## 8. Webhook Forwarding (Optional)

For testing GitHub webhooks locally:

```bash
# Install smee-client
npx smee-client --url https://smee.io/YOUR_CHANNEL --target http://localhost:3001/api/webhooks/github
```

Or use `ngrok`:
```bash
ngrok http 3001
# Update the GitHub App webhook URL to the ngrok URL
```

## 9. Troubleshooting

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
