# PRD: Continuous PR Review

## Problem

Code review is the most common automation use case for coding agents. Today, Polaris automations are fire-and-forget — each GitHub event triggers an isolated run with no memory of previous interactions. This means:

- Every commit on a PR starts a fresh agent session (no context of prior review)
- The agent can't track whether its previous feedback was addressed
- No conversational thread — each review is disconnected
- Expensive: full sandbox + repo clone + cold agent start per commit

Teams need a review agent that behaves like a human reviewer: it opens one conversation thread on a PR, reviews each push incrementally, and remembers what it already said.

## Solution

A **continuous PR review** system where one long-lived agent conversation spans the lifetime of a PR. Each new commit adds a follow-up message to the same session. The agent posts structured feedback as PR comments, and subsequent reviews are incremental — the agent knows what it already reviewed.

```
PR opened (commit A)
  → Create session, run initial review
  → Agent posts review comment on PR

New push (commit B)
  → Resume same session with: "New commits pushed. Review the changes since your last review."
  → Agent posts incremental review comment

New push (commit C)
  → Resume same session with incremental context
  → Agent posts follow-up: "Previous feedback on X was addressed. New issue found in Y."

PR merged/closed
  → Session ends
```

## Core Requirements

### 1. PR-scoped sessions

A session is scoped to a single PR. One PR = one continuous conversation.

- **Key**: `(automationId, repositoryId, prNumber)` → one active session
- On `pull_request.opened` / `pull_request.ready_for_review`: create session + initial review
- On `push` / `pull_request.synchronize`: resume session with new commit context
- On `pull_request.closed` / `pull_request.merged`: end session

### 2. Session continuation via follow-up messages

Each event sends a new prompt to the existing session — not a new run. The agent's internal context (Claude Code's conversation history, Codex's thread) handles compaction.

- **Hot/warm session**: send via input stream (instant)
- **Suspended/hibernated session**: resume via existing prompt API tiers
- **Dead session** (failed/stopped): cold resume with replay

This reuses the existing interactive session infrastructure — the same resume tiers (hot → warm → suspended → hibernated → cold) apply.

### 3. Structured review context

Each follow-up message includes structured context the agent needs:

```
Initial review (PR opened):
  - PR title, description, author
  - Full diff (base..head)
  - File list with change stats
  - Repository conventions (AGENTS.md, .github/REVIEW_GUIDELINES.md, or similar)

Incremental review (new push):
  - Commits since last review (messages + SHAs)
  - Incremental diff (last-reviewed SHA..new HEAD)
  - Previous review state (structured — see §6)
  - "Review only the new changes. Note which previous feedback was addressed."
```

#### Review scope determination

The system determines full vs. incremental review:

| Condition | Scope |
|-----------|-------|
| First review (no `lastReviewedSha`) | Full (`base..head`) |
| `lastReviewedSha` is ancestor of HEAD | Incremental (`lastReviewedSha..head`) |
| `lastReviewedSha` not in history (force push / rebase) | Full (`base..head`) |
| Manual trigger with `full` flag | Full (`base..head`) |
| Manual trigger with `--since <sha>` | Custom (`<sha>..head`) |

#### Repository guidelines injection

The prompt builder injects repo-specific guidelines if present:

1. Root `AGENTS.md` — project-wide conventions
2. App/package-specific `AGENTS.md` — scoped to affected directories (detected from changed file paths)
3. `.github/REVIEW_GUIDELINES.md` — explicit review instructions

These are read from the repo at the target branch HEAD and prepended to the review prompt.

### 4. PR comment output

The agent posts its review as a GitHub PR comment (not inline review comments in v1). The comment includes:

- Summary of findings
- Categorized feedback with severity levels (see §7)
- What was addressed since last review (for incremental reviews)
- Explicit verdict signal (see §7)

The system manages comment threading:
- First review: new comment
- Subsequent reviews: new comment referencing the previous one (not editing — preserves history)
- Previous review comments are marked as stale (collapsed via `<details>` tag or similar)

### 5. Automation configuration

Users configure PR review as an automation type:

```
Trigger: pull_request.opened, pull_request.synchronize, pull_request.ready_for_review
Repository: owner/repo
Agent: claude (default)
Model: claude-sonnet-4-20250514 (configurable)
Prompt: "You are a senior code reviewer. Review this PR for bugs, security issues, and adherence to our coding standards. Be concise and actionable."
```

#### Core settings

- **Model**: which model to use (e.g., `claude-sonnet-4-20250514`, `gpt-5.3-codex`). Enables A/B testing multiple models on same PR.
- **Model parameters**: reasoning effort, temperature, etc. (agent-specific — e.g., Codex's `reasoningEffort`)
- **Custom prompt**: the review instructions — what to focus on, tone, strictness level
- **Review scope**: all files vs. changed files only
- **Auto-approve**: if no issues found, auto-approve the PR

#### Filtering & skipping

- **Branch filter**: only review PRs targeting specific branches (e.g., `main`, `develop`)
- **Path filter**: only trigger when changes touch specific paths (e.g., `src/**`, `apps/api/**`). If no matching files changed, skip the review entirely.
- **Ignore paths**: exclude specific patterns from the diff sent to the agent (e.g., `*.lock`, `*.generated.ts`, `dist/**`)
- **Skip drafts**: don't review draft PRs
- **Skip bot PRs**: skip PRs authored by bots (check `sender.type === "Bot"` or author login ending in `[bot]`)
- **Label filter**: skip/include based on PR labels (e.g., skip if `no-review` label present)

#### Manual trigger

Support a `/review` (or `/polaris-review`) comment command on PRs to:
- Trigger an on-demand review outside the normal push flow
- Options: `full` (force full review), `reset` (clear state, start fresh), `--since <sha>` (review from specific commit)
- Useful for: first-time setup on existing PRs, re-review after config changes, debugging

### 6. State continuity

Each review persists structured state in `automation_session.metadata` for the next review to consume:

```typescript
interface ReviewState {
  lastReviewedSha: string;
  openIssues: Array<{
    id: string;
    file: string;
    severity: "P0" | "P1" | "P2";
    summary: string;
    firstRaisedInReview: number;  // review sequence number
  }>;
  resolvedIssues: Array<{
    id: string;
    file: string;
    summary: string;
    resolvedInReview: number;
  }>;
  reviewCount: number;
}
```

On each incremental review, the agent receives the previous state and outputs an updated state. The system:
1. Passes previous `ReviewState` as context in the prompt
2. Instructs the agent to track which issues are resolved and which are new
3. Parses the agent's structured output to extract the updated state
4. Persists the new state to `automation_session.metadata`

This enables the agent to say "3 issues from my previous review were addressed, 1 remains open, 2 new issues found."

### 7. Structured output format

The agent's review output follows a structured format with severity levels and a verdict:

#### Severity levels

| Level | Meaning | Merge guidance |
|-------|---------|----------------|
| **P0** | Critical — blocks merge | Bug, security flaw, data loss risk, broken functionality |
| **P1** | Important — must fix before merge | Logic errors, missing error handling, bad patterns |
| **P2** | Minor — should fix, won't block | Style, naming, minor improvements, documentation |

#### Categories

Findings are categorized: **Correctness**, **Design**, **Security**, **Performance**, **Tests**, **Style**

#### Verdict

Each review ends with a clear verdict:

| Verdict | Condition |
|---------|-----------|
| **BLOCK** | Any P0 issue found |
| **ATTENTION** | P1 issues found, no P0 |
| **APPROVE** | Only P2 or no issues |

#### File classification

The system classifies changed files to calibrate review strictness:

- **Production code** (`src/**`, `lib/**`, `app/**`): full scrutiny, all severity levels
- **Relaxed files** (tests, scripts, config, docs): cap at P2 for non-security issues — don't block merge for test style nits

The file classification rules are configurable per automation.

### 8. GitHub Checks integration

Create a GitHub Check Run to surface review status directly in the PR's checks tab:

1. **On review start**: create a pending check (`status: "in_progress"`) with the automation name
2. **On review complete**: update the check with conclusion based on verdict:
   - `APPROVE` → `conclusion: "success"`
   - `ATTENTION` → `conclusion: "neutral"`
   - `BLOCK` → `conclusion: "failure"`
3. Check output includes the review summary (title + text)

This gives teams a merge-gating signal without requiring the GitHub Reviews API.

### 9. Concurrency control

One review per automation per PR at a time. If a new push arrives while a review is in progress:

- **Default**: queue the new push as a follow-up message (delivered when the current turn completes)
- **Alternative**: cancel the in-progress review and start a new one with the latest HEAD

Configurable per automation (`onConcurrentPush: "queue" | "cancel"`). Default is `"queue"` since most pushes are seconds apart and the session model handles queuing naturally.

### 10. Omission detection

After reviewing the diff, the agent should consider: "what SHOULD have changed but didn't?" For example:

- New API endpoint added but no tests
- Schema field added but no migration
- New dependency added but no lockfile update
- Feature flag added but not documented

This is a prompt engineering concern — the review prompt instructs the agent to check for omissions as a required step. The system provides the full file list (not just diff) to help the agent reason about completeness.

## Architecture

### New concept: Automation Sessions

Bridge automations (event-triggered) with sessions (multi-turn, resumable).

```
automations (config)
    │
    ▼
automation_sessions (one per PR)
    │  ├─ automationId
    │  ├─ interactive_session_id (FK)
    │  ├─ scopeKey: "pr:owner/repo#123"
    │  └─ metadata: { prNumber, baseRef, headRef, lastReviewedSha }
    │
    ▼
interactive_sessions (existing — multi-turn, hibernation-capable)
```

When a GitHub event arrives:
1. Router finds matching automation
2. Look up existing automation_session by `scopeKey`
3. If exists → send follow-up prompt to linked interactive session
4. If not → create new interactive session + automation_session record

### Event flow

```
GitHub webhook (pull_request.synchronize)
    │
    ▼
routeGitHubEvent() — existing router
    │
    ▼
Is this a "continuous" automation? (triggerType: "github", mode: "continuous")
    │
    ├─ YES: Look up automation_session by scope key
    │       ├─ Found + session alive → send follow-up prompt
    │       ├─ Found + session dead → resume session (cold/hibernate)
    │       └─ Not found → create new session + send initial prompt
    │
    └─ NO: Fire-and-forget (existing coding-task behavior)
```

### Review prompt construction

A dedicated prompt builder constructs the message sent to the agent:

```typescript
function buildReviewPrompt(context: {
  type: "initial" | "incremental";
  pr: { title, body, author, number, baseRef, headRef };
  diff: string;
  fileList: string[];              // all changed files (not just in diff)
  commits: Array<{ sha, message }>;
  previousState?: ReviewState;     // structured state from last review
  lastReviewedSha?: string;
  customInstructions?: string;     // from automation prompt field
  repoGuidelines?: string;        // AGENTS.md + REVIEW_GUIDELINES.md content
  fileClassification?: Record<string, "production" | "relaxed">;
}): string
```

Initial review gets the full diff. Incremental reviews get only the diff since `lastReviewedSha`.

The prompt includes:
1. Role and instructions (custom prompt + defaults)
2. Repo guidelines (AGENTS.md content)
3. PR metadata (title, body, author, branch)
4. Diff (full or incremental)
5. File classification rules
6. Previous review state (for incremental — open issues, resolved issues)
7. Output format requirements (severity levels, verdict, structured state)
8. Omission detection instructions

### Comment posting & state extraction

After the agent completes its turn, the system:
1. Extracts the agent's final message from the session events
2. Parses structured output (verdict, severity counts, updated `ReviewState`)
3. Posts the review as a PR comment via GitHub API
4. Marks previous review comments as stale
5. Updates `automation_session.metadata` with new `ReviewState`
6. Updates GitHub Check Run with verdict-based conclusion

This happens outside the sandbox — the task process has GitHub credentials and posts the comment directly via Octokit.

### Pre-review checks

Before sending the diff to the agent, the system can run lightweight pre-scans:

- **Skip check**: if no files match the path filter after ignore patterns, skip entirely
- **Diff size check**: if diff exceeds a threshold, truncate with a note or let the agent explore via `git diff` tools in the sandbox

## Data Model

### New table: `automation_sessions`

```sql
CREATE TABLE automation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id UUID NOT NULL REFERENCES automations(id),
  session_id UUID NOT NULL REFERENCES interactive_sessions(id),
  organization_id TEXT NOT NULL,
  scope_key TEXT NOT NULL,  -- e.g., "pr:owner/repo#123"
  metadata JSONB,           -- { prNumber, baseRef, headRef, lastReviewedSha, ... }
  created_at TIMESTAMPTZ DEFAULT now() NOT NULL,
  ended_at TIMESTAMPTZ,
  UNIQUE(automation_id, scope_key)  -- one active session per scope
);
```

### Schema changes to `automations`

Add a `mode` field:
- `"oneshot"` (default) — current fire-and-forget behavior
- `"continuous"` — session-based, events resume the same conversation

Add review-specific configuration (JSONB `config` field):

```typescript
interface PRReviewConfig {
  model?: string;                    // e.g., "claude-sonnet-4-20250514"
  modelParams?: Record<string, any>; // e.g., { reasoningEffort: "high" }
  customPrompt?: string;
  branchFilter?: string[];           // target branches to review
  pathFilter?: string[];             // glob patterns — only trigger if matched
  ignorePaths?: string[];            // glob patterns — exclude from diff
  skipDrafts?: boolean;
  skipBots?: boolean;
  skipLabels?: string[];             // skip if any of these labels present
  autoApprove?: boolean;
  onConcurrentPush?: "queue" | "cancel";
  fileClassification?: {
    production: string[];            // glob patterns for full-scrutiny files
    relaxed: string[];               // glob patterns for capped-at-P2 files
  };
}

### No changes to `interactive_sessions`

The existing interactive session infrastructure handles everything — status lifecycle, hibernation, resume tiers, event streaming. Automation sessions just link an automation + scope key to an interactive session.

## Scope & Non-goals

### In scope (v1)
- PR-scoped continuous sessions
- Initial + incremental review with scope detection
- Model configuration (agent type + model + params)
- Custom review prompts
- PR comment posting (top-level comments) with stale marking
- Structured output: severity levels (P0/P1/P2), verdict (BLOCK/ATTENTION/APPROVE)
- State continuity: open/resolved issue tracking across reviews
- Resume across commits via existing session tiers
- GitHub Checks integration (pending → pass/fail)
- Filtering: branch, path, drafts, bots, labels
- Ignore paths (exclude from diff)
- File classification (production vs. relaxed)
- Repo guidelines injection (AGENTS.md, REVIEW_GUIDELINES.md)
- Omission detection prompting
- Concurrency control (queue or cancel)
- Manual `/review` trigger via PR comment
- Automation UI to configure all of the above

### Out of scope (v1)
- Inline review comments (line-level annotations)
- PR approval/request-changes via GitHub review API (use Checks instead)
- Auto-fix suggestions (agent creating fix commits)
- Multi-model A/B testing on same PR (run two automations instead)
- Review comment reactions / resolution tracking via GitHub API
- Multi-repo PRs
- Domain-specific pre-scan guardrails (schema lifecycle, criteria boundaries — prompt-engineering only in v1)

## Key Files

| Area | Files |
|------|-------|
| Event routing | `lib/routing/trigger-router.ts`, `lib/routing/matchers.ts` |
| Automations | `lib/automations/schema.ts`, `lib/automations/actions.ts` |
| Sessions | `lib/sessions/schema.ts`, `lib/sessions/actions.ts` |
| Session resume | `app/api/interactive-sessions/[sessionId]/prompt/route.ts` |
| Task execution | `trigger/interactive-session.ts` |
| GitHub API | `lib/integrations/github.ts` |
| Sandbox | `lib/sandbox/SandboxManager.ts`, `lib/sandbox-agent/SandboxAgentBootstrap.ts` |

## Resolved Decisions

1. **Comment format**: Hybrid — the agent writes markdown but includes a fenced JSON block with structured state (`ReviewState`). The system parses the JSON for state continuity and posts the full markdown as the comment. This gives readability + machine-parseable state.

2. **Race conditions**: Configurable via `onConcurrentPush`. Default `"queue"` — the session model handles queuing naturally (second prompt delivered after first turn completes).

3. **Concurrency**: One review per automation per PR. Multiple automations (e.g., different models) can review the same PR independently — each has its own `automation_session`.

## Open Questions

1. **Diff size limits**: Large PRs may exceed agent context. Strategy: truncate diff with a note ("showing first N files of M changed"), or let the agent explore via tools (it can run `git diff` itself inside the sandbox). The sandbox approach is more powerful but slower.

2. **Session lifetime**: When should we hibernate vs. keep warm? PRs can be idle for days. Likely: same two-phase idle as interactive sessions (warm 2min → suspend 53min → hibernate). On next push, cold/hibernate resume.

3. **Existing automation_runs table**: Should we still create automation_run records for each event, even in continuous mode? Probably yes — for audit trail and observability. But the run links to the same session.

4. **Check suite naming**: What should the GitHub Check be named? Options: automation name, "Polaris Review", "Polaris Review (claude-sonnet-4-20250514)". Needs to be unique if multiple models review the same PR.

5. **State extraction reliability**: The agent must output structured `ReviewState` JSON. If the agent doesn't comply (malformed output), fallback: treat as stateless, next review is full scope. May need retry/validation logic.
