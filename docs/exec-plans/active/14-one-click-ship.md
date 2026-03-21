---
title: One-Click Ship Workflow
status: planned
created: 2026-03-20
owner: andreas
related_prs: []
domains: [ui, sessions, git, github]
---

# 14 — One-Click Ship Workflow

## Problem Statement

After a session completes, PR creation is either automatic (for automations) or doesn't happen (for interactive sessions). There's no "ship" surface in the session UI. Codex positions "shipping as a workflow, not a prompt."

## Design Decisions

- **Sandbox is source of truth for git state** — interactive sessions don't store branch/diff info in DB
- **Reuse existing `pr_create` job type** — already in schema, makes PR creation auditable
- **Reuse existing `GitOperations` + `createPullRequest`** — follows postprocess.ts patterns
- **No schema migration** — PR URL stored on job `result` field

## Implementation

### Step 1: Git Info Endpoint

**Create `app/api/interactive-sessions/[sessionId]/git-info/route.ts`**

Queries live sandbox for git state:
1. Reconnect to sandbox via `SandboxManager.reconnect(sandboxId)`
2. Run: `git branch --show-current`, `git log origin/<base>..HEAD --oneline`, `git diff --stat`, `git status --porcelain`
3. Return `{ available, branch, baseBranch, commitsAhead, diffSummary, filesChanged, hasUncommittedChanges }`
4. If sandbox dead → `{ available: false, reason: "sandbox_offline" }`

**Sandbox reconnect:** Both `git-info` AND `create-pr` must handle `SandboxManager.reconnect()` returning `null`. The git-info route returns `{ available: false, reason: "sandbox_offline" }`. The create-pr route should check this BEFORE attempting any git operations and return `{ error: "sandbox_offline" }` with a 409 status.

**Base branch detection:** The session doesn't store a base branch. Load the repository record via `session.repositoryId` to get `repository.defaultBranch`. Fall back to `'main'` if null. Pass this to all git operations that need a base reference.

### Step 2: Create PR Endpoint

**Create `app/api/interactive-sessions/[sessionId]/create-pr/route.ts`**

Request: `{ title, description, baseBranch? }`

Logic:
1. Load session + repository, reconnect sandbox
2. Guard: check for existing completed `pr_create` job (idempotency)
3. Guard: re-check `session.status` server-side — if `active` (agent running), return `{ error: "agent_running" }` with 409
4. Resolve credentials via `resolveSessionCredentials`
5. Mint fresh GitHub token, update network policy
6. Git: re-run `git status` to validate state (do not rely on git-info response), configure remote, ensure branch, commit uncommitted changes, push
7. Create PR via `createPullRequest()`
8. Create `pr_create` job record with `result: { prUrl, prNumber }`
9. Return `{ prUrl, prNumber, branchName }`

**Branch safety:** Do NOT skip `assertSafeBranch()` entirely. Instead, add a `pushForUserShip(branchName)` method that validates: (a) branch is not `main`, `master`, or the repo's `defaultBranch`, (b) branch exists and has commits ahead of base. This preserves safety while allowing user-initiated ships on any non-protected branch.

**Sandbox chain construction:** The route must construct the full chain: `const sandbox = await SandboxManager.reconnect(session.sandboxId)` → `const commands = new SandboxCommands(sandbox)` → `const git = new GitOperations(commands)`. Document this boilerplate in the route, following the pattern from `postprocess.ts`.

**Race condition guard:** The `create-pr` endpoint must re-check `session.status` server-side before proceeding. If status is `active` (agent is running), return `{ error: "agent_running" }` with a 409 status. The client shows "Agent is still working — wait for it to finish before shipping."

**Stale state:** The `create-pr` endpoint re-runs `git status` before committing, not relying on the git-info response. The form preview is best-effort; the actual ship operation validates independently.

**Serverless timeout risk:** The `create-pr` route performs sandbox reconnect + git operations + push + PR creation. This can exceed Vercel's function timeout (60s on Pro). **Mitigation:** Split into two steps: (1) POST starts a background job via Trigger.dev `pr_create` task, (2) client polls for completion. This matches the existing pattern where heavy operations run in Trigger.dev. **Alternative (simpler, v1):** Keep as a single request but add a 45-second `AbortController` timeout with a clear error message.

### Step 3: Enrich Session API with PR URL

Extend `GET /api/interactive-sessions/[sessionId]` to include `prUrl` from completed `pr_create` jobs.

### Step 4: ShipButton Component

**Create `components/sessions/ship-button.tsx`**

- "Create PR" button → opens ShipDialog (when no PR exists, session has sandbox)
- "View PR" link → opens GitHub (when PR exists)
- Only visible for sessions with repositoryId in idle/active/hibernated state
- Disabled during active agent work (status === "active")

### Step 5: ShipDialog Component

**Create `components/sessions/ship-dialog.tsx`**

States: Loading → No Changes → Ready → Creating → Success → Error

Form fields (Ready state):
- Title (editable Input, pre-populated from prompt)
- Description (editable Textarea, pre-populated from changes summary)
- Base branch (read-only display)
- Branch name (read-only display)
- Changes summary (read-only diff stats)

### Step 6: Page Integration

Add ShipButton to session detail header, next to Stop button.

## File Summary

| Action | File |
|--------|------|
| Create | `app/api/interactive-sessions/[sessionId]/git-info/route.ts` |
| Create | `app/api/interactive-sessions/[sessionId]/create-pr/route.ts` |
| Create | `components/sessions/ship-button.tsx` |
| Create | `components/sessions/ship-dialog.tsx` |
| Modify | `app/(dashboard)/sessions/[sessionId]/page.tsx` |
| Modify | `app/api/interactive-sessions/[sessionId]/route.ts` |
| Modify | `lib/sandbox/GitOperations.ts` |

## Edge Cases

- **Sandbox offline**: Show "Sandbox is offline. Send a message to wake it up."
- **No changes**: Show "No changes to ship."
- **PR already exists**: Show "View PR" instead.
- **Branch conflicts**: GitHub creates PR even with conflicts. No special handling.
- **Agent actively running**: Disable Ship button.
