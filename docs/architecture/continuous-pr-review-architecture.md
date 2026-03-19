# Continuous PR Review — Architecture

> Last updated: March 2026. Reflects the implemented and tested system.

One long-lived agent conversation spans the entire lifetime of a pull request. Each push resumes the same session with an incremental review prompt. The agent posts structured PR comments with severity-based verdicts and maintains issue state across reviews.

---

## How It Works (30-second overview)

```
GitHub webhook (pull_request / issue_comment)
  │
  ▼
routeGitHubEvent()                    lib/routing/trigger-router.ts
  ├─ oneshot → coding-task            (existing)
  └─ continuous → normalize + filter
       │
       ▼
  find/create automation_session      lib/automations/actions.ts
  create automation_run
       │
       ▼
continuous-pr-review task             trigger/continuous-pr-review.ts
  │
  ├─ 1. Acquire DB lock
  ├─ 2. Create GitHub check (in_progress)
  ├─ 3. Fetch diff + guidelines
  ├─ 4. Determine scope (full / incremental)
  ├─ 5. Build prompt
  ├─ 6. Dispatch to interactive session (hot/warm/cold/hibernate)
  ├─ 7. Wait for turn completion (poll DB)
  ├─ 8. Parse structured output
  ├─ 9. Collapse previous comment
  ├─ 10. Post new comment
  ├─ 11. Complete check (success/neutral/failure)
  ├─ 12. Advance lastReviewedSha
  └─ 13. Release lock → check for queued request
```

---

## 1. Data Model

### 1.1 `automations` table additions

| Column | Type | Purpose |
|--------|------|---------|
| `mode` | `text NOT NULL DEFAULT 'oneshot'` | `"oneshot"` or `"continuous"` |
| `pr_review_config` | `jsonb DEFAULT '{}'` | `PRReviewConfig` — all review settings |

### 1.2 `automation_sessions` table (new)

Bridge between an event-triggered automation and a long-lived interactive session. One row per PR.

| Column | Type | Purpose |
|--------|------|---------|
| `id` | `uuid` | Primary key |
| `automation_id` | `uuid FK` | Parent automation |
| `interactive_session_id` | `uuid FK` | Linked agent session |
| `organization_id` | `text` | Tenant |
| `repository_id` | `uuid FK` | Repository |
| `scope_key` | `text` | `github-pr:<repoUUID>:<prNumber>` — unique with automation_id |
| `status` | `text` | `active` / `closing` / `closed` / `failed` |
| `metadata` | `jsonb` | `AutomationSessionMetadata` — review state, SHA tracking, pending queue |
| `review_lock_run_id` | `text` | Current lock holder (automation_run ID) |
| `review_lock_expires_at` | `timestamptz` | Lock TTL expiration |

**Indexes:** unique(automation_id, scope_key), on(interactive_session_id), on(organization_id, status)

**Scope key** uses repository UUID, not `owner/repo` — survives repository renames.

### 1.3 `automation_runs` additions

Each webhook/manual trigger creates one row for auditability:

| Column | Purpose |
|--------|---------|
| `automation_session_id` | Links to parent session |
| `interactive_session_id` | Which agent session was used |
| `review_sequence` | Incrementing review number (1, 2, 3...) |
| `review_scope` | `full` / `incremental` / `since` / `reset` |
| `review_from_sha`, `review_to_sha` | Diff range |
| `github_check_run_id` | Posted check |
| `github_comment_id` | Posted comment |
| `verdict` | `BLOCK` / `ATTENTION` / `APPROVE` |
| `severity_counts` | `{ P0: n, P1: n, P2: n }` |

### 1.4 `interactive_session_turns` table (new)

Gives the orchestrator a reliable "this prompt finished" signal. The interactive-session runtime writes the turn result; the orchestrator polls for it.

| Column | Purpose |
|--------|---------|
| `session_id` | FK to interactive_sessions (cascade) |
| `request_id` | Unique per session — handshake token |
| `source` | `user` / `automation` |
| `status` | `pending` → `running` → `completed` / `failed` / `cancelled` |
| `prompt` | The prompt text sent |
| `final_message` | Agent's final output (up to 50KB) |
| `error` | Error message if failed |

### 1.5 Key types (`lib/reviews/types.ts`)

```ts
AutomationSessionMetadata {
  repositoryOwner, repositoryName, prNumber, prNodeId?,
  baseRef, baseSha, headRef, headSha,
  lastReviewedSha: string | null,      // Controls incremental scope
  reviewState: ReviewState | null,      // Open/resolved issues
  reviewCount: number,
  lastCommentId: string | null,         // For stale-collapse
  lastCheckRunId: string | null,
  lastCompletedRunId: string | null,
  pendingReviewRequest: QueuedReviewRequest | null,  // Queued during lock
}

ReviewState {
  lastReviewedSha: string | null,
  openIssues: ReviewIssue[],            // Carried across reviews
  resolvedIssues: ResolvedReviewIssue[],
  reviewCount: number,
}

PRReviewConfig {
  customPrompt?, branchFilter?, pathFilter?, ignorePaths?,
  skipDrafts?, skipBots?, skipLabels?,
  onConcurrentPush?: "queue" | "cancel",
  fileClassification?: { production: string[], relaxed: string[] },
  maxPromptDiffBytes? (200KB), maxPromptFiles? (150), maxGuidelinesBytes? (40KB),
  staleCommentStrategy?: "edit-collapse" | "tag-only",
  checkName?,
}
```

---

## 2. Event Routing

**File:** `lib/routing/trigger-router.ts`

```
routeGitHubEvent(installationId, deliveryId, eventType, action, payload)
  │
  ├─ isDuplicate(deliveryId)?  → skip
  ├─ lookupInstallation → orgId
  ├─ findMatchingAutomations(orgId, triggerType, events)
  │
  └─ for each automation:
       ├─ mode === "continuous"
       │    ├─ normalizePREvent()           → NormalizedPrReviewEvent
       │    ├─ PR closed?                   → mark session "closed", skip
       │    ├─ findOrCreateAutomationSession (by scope key)
       │    ├─ createAutomationRun
       │    └─ tasks.trigger("continuous-pr-review", payload)
       │
       └─ mode === "oneshot"
            └─ tasks.trigger("coding-task", payload)    (existing)
```

### Event normalization (`lib/reviews/github-events.ts`)

Handles two webhook types:

- **`pull_request`**: Extracts owner, repo, PR number, refs, SHAs, labels, draft status directly from payload.
- **`issue_comment`**: Parses `/review` or `/polaris-review` command from comment body. Fetches PR details via GitHub API (since issue_comment payloads lack full PR data). Returns `null` if not a valid review command.

### Supported events

| Webhook | Action | Effect |
|---------|--------|--------|
| `pull_request` | `opened` | First full review |
| `pull_request` | `synchronize` | Incremental review (new commits) |
| `pull_request` | `ready_for_review` | Full review (draft → ready) |
| `pull_request` | `reopened` | Reactivate session |
| `pull_request` | `closed` | Close session |
| `issue_comment` | `created` (with `/review`) | Manual trigger |

---

## 3. Orchestrator Task

**File:** `trigger/continuous-pr-review.ts`

### Constants

| Constant | Value | Purpose |
|----------|-------|---------|
| `maxDuration` | 600s (10 min) | Trigger.dev task timeout |
| Lock TTL | 10 min | Review lock expiration |
| Turn timeout | 5 min | Max wait for agent response |
| Poll interval | 3s | DB poll for turn completion |

### Payload

```ts
type ContinuousPrReviewPayload = {
  orgId: string;
  automationId: string;
  automationSessionId: string;   // Pre-created by router
  automationRunId: string;
  installationId: number;
  deliveryId: string;
  normalizedEvent: NormalizedPrReviewEvent;
};
```

### Full orchestration flow

**Stage 1 — Load & lock**
1. Fetch automation + automation_session + automation_run from DB
2. Acquire CAS lock on automation_session (`reviewLockRunId` + `reviewLockExpiresAt`)
3. If lock held → `setPendingReviewRequest()`, mark run cancelled, return early

**Stage 2 — Filter**
4. Run `shouldReviewPR(event, config)` — check drafts, bots, labels, branch, path filters
5. If filtered → update run with "Skipped: \<reason\>", exit gracefully

**Stage 3 — GitHub check**
6. `createPendingCheck()` — "in_progress" status. Failure is non-fatal (continues without check).

**Stage 4 — Diff & context**
7. Determine review scope:
   - No `lastReviewedSha` → **full**
   - `lastReviewedSha` is ancestor of HEAD → **incremental** (commit range diff)
   - `lastReviewedSha` not in history (force push) → **full** with advisory state
   - Manual `/review full|reset|since` → override
8. Fetch diff via GitHub API (`fetchPRDiff()` or `fetchCommitRangeDiff()`)
9. Filter ignored paths via `filterIgnoredPaths()`
10. Classify files via `classifyFiles()` (production vs relaxed)
11. Load repo guidelines via `loadRepoGuidelines()` (AGENTS.md, REVIEW_GUIDELINES.md)

**Stage 5 — Prompt & dispatch**
12. Build prompt via `buildReviewPrompt()`
13. For "reset" mode: create fresh interactive session, swap FK on automation_session
14. `dispatchPromptToSession()` → routes to appropriate tier (hot/warm/cold/hibernate)

**Stage 6 — Wait for completion**
15. Poll `interactive_session_turns` by `requestId` every 3s
16. Timeout after 5 min → fail

**Stage 7 — Post-processing**
17. Parse agent output via `parseReviewOutput()` (JSON → unfenced JSON → regex fallback)
18. Mark previous comment stale via `markCommentStale()` (edit-collapse into `<details>`)
19. Post new review comment via `postReviewComment()`
20. Update automation_session metadata: `lastReviewedSha`, `reviewState`, `reviewCount`, `lastCommentId`
21. Complete GitHub check: verdict → conclusion (`APPROVE→success`, `ATTENTION→neutral`, `BLOCK→failure`)
22. Complete automation_run: status, verdict, severity counts

**Stage 8 — Cleanup (finally block)**
23. Release lock (CAS — only if held by this run)
24. Check `pendingReviewRequest` → if exists, log for next webhook pickup

### Error boundaries

| Error | Handling |
|-------|----------|
| Lock held | Queue request, mark run cancelled |
| Filter skip | Update run with reason, exit |
| Check creation fails | Continue without check |
| Turn timeout/failure | Fail check, mark run failed |
| Output parse fails | Post raw output with warning, **don't advance `lastReviewedSha`** |
| PR closed mid-review | Skip comment, neutral check |

### Reliability rule

`lastReviewedSha` only advances when:
1. Agent output parsed successfully (structured or regex)
2. Comment posted to PR
3. No infrastructure failure

This prevents review gaps — a failed review will be retried as a full review on next push.

---

## 4. Session Dispatch (Tier System)

**File:** `lib/orchestration/prompt-dispatch.ts`

Extracted from the API route, shared by both the UI prompt endpoint and the orchestrator task.

```ts
dispatchPromptToSession({
  sessionId, orgId, prompt, requestId, source: "user" | "automation"
}): Promise<DispatchResult>
```

### Tiers

| Tier | Session Status | Mechanism | Latency |
|------|---------------|-----------|---------|
| **Hot** | `active` | `sessionMessages.send()` | ~0s |
| **Warm** | `warm` | `sessionMessages.send()` (wakes `.once()`) | ~0s |
| **Suspended** | `suspended` | `sessionMessages.send()` (resumes `.wait()`) | ~2s |
| **Hibernate** | `hibernated` | Restore snapshot, trigger new task | ~20s |
| **Cold** | `idle/stopped/completed/failed` | Probe sandbox, trigger new task | ~30s |
| **Fresh** | `creating` (no run) | Trigger new task | ~30s |

The hot/warm/suspended tiers use Trigger.dev input streams for instant delivery. Hibernate/cold/fresh create a new Trigger.dev run with the prompt in the payload.

### Turn tracking handshake

1. Orchestrator creates `interactive_session_turns` row (status: `pending`)
2. Prompt dispatched with `requestId` token
3. Runtime (`interactive-session.ts`) receives prompt, marks turn `running`
4. After `executePrompt()` completes, marks turn `completed` with `finalMessage`
5. Also writes `metadata.set("turnResult:<requestId>", ...)` for fast polling
6. Orchestrator polls DB every 3s for turn completion

---

## 5. Review Modules

All review domain logic lives in `lib/reviews/`. The orchestrator composes these modules.

```
lib/reviews/
├── types.ts              Type definitions (ReviewState, PRReviewConfig, etc.)
├── github-events.ts      Normalize webhook → NormalizedPrReviewEvent
├── manual-trigger.ts     Parse /review commands
├── filters.ts            Should-review decision logic
├── diff.ts               Fetch PR diff / commit range diff via GitHub API
├── guidelines.ts         Load AGENTS.md, REVIEW_GUIDELINES.md from repo
├── classification.ts     Classify files as production / relaxed
├── prompt-builder.ts     Assemble full review prompt
├── output-parser.ts      Extract structured output from agent response
├── comment-renderer.ts   Render PR comment markdown
└── github.ts             All GitHub API calls (checks, comments, PR data)
```

### 5.1 Filters (`filters.ts`)

```
shouldReviewPR(event, config, changedFiles?) → { review: boolean, reason? }
```

Rules (in order):
1. Manual `/review` command → **always pass**
2. PR must be open
3. Skip drafts (default: true, configurable)
4. Skip bot authors (default: true, configurable)
5. Skip PRs with matching labels (`skipLabels`)
6. Branch filter — base ref must be in `branchFilter` (empty = all)
7. Path filter — at least one changed file must match `pathFilter` glob (empty = all)

### 5.2 Diff fetching (`diff.ts`)

Two modes:
- **`fetchPRDiff()`** — Full PR diff via `pulls.get({ mediaType: { format: "diff" } })`
- **`fetchCommitRangeDiff()`** — Incremental diff via `repos.compareCommits()`

Both respect `maxPromptDiffBytes` (default 200KB) and `maxPromptFiles` (default 150). Returns `{ diff, files, truncated }`.

### 5.3 File classification (`classification.ts`)

| Classification | Default globs | Behavior |
|----------------|--------------|----------|
| **production** | `src/**`, `lib/**`, `app/**`, `packages/**` | Full severity range |
| **relaxed** | `test/**`, `tests/**`, `**/*.test.*`, `docs/**`, `scripts/**` | Non-security capped at P2 |

Configurable per automation via `prReviewConfig.fileClassification`.

### 5.4 Guidelines loading (`guidelines.ts`)

Fetches from the repo at the PR head ref:
1. Root: `AGENTS.md`, `.agents.md`, `REVIEW_GUIDELINES.md`, `.review-guidelines.md`
2. Scoped: `AGENTS.md` / `.agents.md` in directories containing changed files

Budget: 40KB max total. Stops loading when exceeded.

### 5.5 Prompt construction (`prompt-builder.ts`)

Template sections:
1. **System role** — "You are a senior code reviewer..."
2. **Severity definitions** — P0 (must fix), P1 (should fix), P2 (consider)
3. **File classification rules** — Production vs relaxed severity calibration
4. **Custom instructions** — From `config.customPrompt`
5. **Repository guidelines** — AGENTS.md content
6. **PR metadata** — Title, author, branch, description
7. **Review scope** — Full/incremental + commit range
8. **Changed files** — List with classification tags
9. **Diff** — Unified diff (with truncation note if over budget)
10. **Previous state** — Open issues from prior review (incremental only)
11. **Output format contract** — JSON schema the agent must produce

### 5.6 Output parsing (`output-parser.ts`)

4-pass extraction strategy:
1. **Fenced JSON** — Find `` ```json ... ``` `` blocks (last one wins)
2. **Unfenced JSON** — Find `{ ... }` containing `"verdict"` key
3. **Regex fallback** — Match BLOCK/ATTENTION/APPROVE + count P0/P1/P2 mentions
4. **Return null** — Unparseable (orchestrator posts raw output, doesn't advance SHA)

Zod validation is lenient — `openIssues` fields like `category`, `summary`, `title`, `body`, `firstRaisedInReview` are all optional because the agent doesn't always follow the exact schema.

### 5.7 Comment rendering (`comment-renderer.ts`)

```markdown
## {emoji} Polaris Review #{sequence}: {VERDICT}

{summary}

**Findings:** {emoji} {n} P0 · {emoji} {n} P1 · {emoji} {n} P2

### Findings

#### {emoji} [P0] Title
**File:** `path.ts` · **Category:** Correctness
Body...

### Resolved Issues
- ~~finding-123~~ (checkmark)

<sub>Polaris Review #{sequence} · Automated code review</sub>
```

Previous comments are collapsed via edit:
```markdown
<details><summary>Outdated: Polaris Review #1 (superseded by #2)</summary>
{original body}
</details>
```

### 5.8 GitHub API operations (`github.ts`)

| Function | Purpose |
|----------|---------|
| `createPendingCheck()` | Check run with `status: "in_progress"` |
| `completeCheck()` | Set conclusion based on verdict |
| `failCheck()` | Mark check as failed |
| `postReviewComment()` | Post PR comment, return comment ID |
| `markCommentStale()` | Edit previous comment into collapsed `<details>` |
| `getPullRequest()` | Fetch PR data |
| `isAncestor()` | Check if SHA is ancestor of HEAD (force-push detection) |
| `getReviewOctokit()` | Get installation Octokit instance |

**Verdict → Check conclusion mapping:**

| Verdict | Conclusion | Meaning |
|---------|-----------|---------|
| `APPROVE` | `success` | No blocking issues |
| `ATTENTION` | `neutral` | Issues found, none blocking |
| `BLOCK` | `failure` | Blocking issues must be addressed |

---

## 6. Concurrency Control

### Lock mechanism

CAS-based lock on `automation_sessions`:

```sql
-- Acquire: only if unlocked or expired
UPDATE automation_sessions
SET review_lock_run_id = :runId,
    review_lock_expires_at = NOW() + INTERVAL '10 minutes'
WHERE id = :sessionId
  AND (review_lock_run_id IS NULL OR review_lock_expires_at < NOW());

-- Release: only if held by this run
UPDATE automation_sessions
SET review_lock_run_id = NULL,
    review_lock_expires_at = NULL
WHERE id = :sessionId
  AND review_lock_run_id = :runId;
```

### Queue mode (default)

When a push arrives while a review is in progress:
1. New orchestrator run attempts lock → fails
2. Stores request in `metadata.pendingReviewRequest` (latest wins — intermediate pushes superseded)
3. Marks its automation_run as cancelled: "Queued — lock held by another review"
4. Current review finishes → releases lock
5. Next webhook picks up the pending request

### Why not input-stream buffering

Pushing another prompt into a live `executePrompt()` call has undefined behavior — the agent's streaming response interleaves unpredictably. DB-backed queueing ensures reviews are strictly sequential.

---

## 7. Review Scope Resolution

| Condition | Scope | Diff Source |
|-----------|-------|-------------|
| No `lastReviewedSha` | **full** | Full PR diff |
| `lastReviewedSha` is ancestor of HEAD | **incremental** | Commit range diff (ancestor → HEAD) |
| `lastReviewedSha` not in history (force push) | **full** | Full PR diff + advisory previous state |
| Manual `/review full` | **full** | Full PR diff |
| Manual `/review reset` | **reset** | New session, full PR diff, no previous state |
| Manual `/review since <sha>` | **since** | Diff from specified SHA |

Force-push detection uses `isAncestor()` which calls the GitHub compare API. If the previous SHA isn't reachable from the new HEAD, it's a rewrite — the agent gets full context plus the previous `ReviewState` as advisory.

---

## 8. Manual Trigger

**File:** `lib/reviews/manual-trigger.ts`

PR comment commands:

| Command | Effect |
|---------|--------|
| `/review` | Incremental review (default) |
| `/review full` | Full re-review |
| `/review reset` | New agent session, clean slate |
| `/review since <sha>` | Review from specific commit |
| `/polaris-review ...` | Alias for `/review` |

`/review reset` creates a **new interactive session** and swaps the FK on `automation_sessions`. This is necessary because you can't reliably instruct the agent to "forget" prior context via prompt alone.

---

## 9. Agent Output Fix: Persisted Event Reconstruction

**File:** `lib/sandbox-agent/SandboxAgentClient.ts`

### Problem

The sandbox-agent SDK persists events asynchronously (`await persist.insertEvent(event)`) then fires listeners. Under concurrent message arrival, two async handlers run in parallel with variable persist latency — listeners fire out-of-order despite events having correct sequential `eventIndex` values. This causes garbled/interleaved text output.

### Solution

Instead of capturing text in live `onEvent` callbacks, `executePrompt()` calls `readPersistedOutput()` after `session.prompt()` completes. This reads all events from the DB persist driver (guaranteed correct order by `event_index`) and reconstructs clean text.

```
session.prompt()          ← agent runs, events persist to DB
    │
    ▼
readPersistedOutput()     ← read all events in correct order
    │
    ├─ agent_message_chunk → accumulate text
    ├─ tool_call           → message boundary
    ├─ turn_ended          → message boundary
    │
    ▼
reconstructOutput()       ← sort by eventIndex, split on boundaries
    │
    ▼
{ allOutput, lastMessage }
```

`lastMessage` is the final agent message after the last tool call — this is what the review orchestrator uses for output parsing. `allOutput` is all messages joined.

---

## 10. Interactive Session Runtime Integration

**File:** `trigger/interactive-session.ts`

The existing generic runtime is extended, not forked.

### Turn tracking

At each `executePrompt()` call site (initial prompt, warm-wake prompt, suspended-resume prompt):

```
Before prompt:
  createTurn({ sessionId, requestId, triggerRunId, prompt })

After prompt:
  completeTurn(requestId, sessionId, { finalMessage })
  metadata.set("turnResult:<requestId>", { status, output, success })

On error:
  failTurn(requestId, sessionId, { error })
```

The `requestId` flows from the orchestrator → dispatch → task payload → turn row. This is the handshake token that links "I sent this prompt" to "the agent finished and here's the result."

---

## 11. File Inventory

| File | Lines | Key Exports |
|------|-------|-------------|
| `trigger/continuous-pr-review.ts` | ~350 | `continuousPrReviewTask` — Trigger.dev task |
| `lib/routing/trigger-router.ts` | ~120 | `routeGitHubEvent()` — webhook dispatcher |
| `lib/orchestration/prompt-dispatch.ts` | ~300 | `dispatchPromptToSession()` — tier routing |
| `lib/automations/schema.ts` | ~200 | `automations`, `automationRuns`, `automationSessions` tables |
| `lib/automations/actions.ts` | ~250 | Session CRUD, lock acquire/release, pending queue |
| `lib/sessions/schema.ts` | ~150 | `interactiveSessions`, `interactiveSessionTurns` tables |
| `lib/sessions/actions.ts` | ~200 | Turn CRUD: `createTurn`, `completeTurn`, `failTurn` |
| `lib/reviews/types.ts` | ~180 | All review type definitions |
| `lib/reviews/github-events.ts` | ~100 | `normalizePREvent()` |
| `lib/reviews/manual-trigger.ts` | ~50 | `parseManualReviewCommand()` |
| `lib/reviews/filters.ts` | ~80 | `shouldReviewPR()` |
| `lib/reviews/diff.ts` | ~100 | `fetchPRDiff()`, `fetchCommitRangeDiff()` |
| `lib/reviews/guidelines.ts` | ~100 | `loadRepoGuidelines()` |
| `lib/reviews/classification.ts` | ~70 | `classifyFiles()`, `filterIgnoredPaths()` |
| `lib/reviews/prompt-builder.ts` | ~250 | `buildReviewPrompt()` |
| `lib/reviews/output-parser.ts` | ~190 | `parseReviewOutput()` |
| `lib/reviews/comment-renderer.ts` | ~120 | `renderReviewComment()`, `renderStaleComment()` |
| `lib/reviews/github.ts` | ~150 | Check/comment CRUD, `isAncestor()` |
| `lib/sandbox-agent/SandboxAgentClient.ts` | ~460 | `executePrompt()`, `readPersistedOutput()` |
| `lib/sandbox-agent/event-types.ts` | ~565 | `parseEventPayload()`, `consolidateEvents()` |
| `trigger/interactive-session.ts` | ~700 | Generic session runtime + turn tracking |

---

## 12. End-to-End Example: Three-Push Lifecycle

### Push 1: PR opened

```
1. Webhook: pull_request.opened
2. Router: create automation_session (scope: github-pr:<repoId>:42)
         create interactive_session (fresh)
         create automation_run #1
3. Orchestrator: acquire lock ✓
                 scope = full (no lastReviewedSha)
                 fetch full PR diff (12 files, 8KB)
                 build prompt (system + severity + diff + output contract)
                 dispatch to session (cold tier → trigger new run)
4. Runtime: create agent session, execute prompt
           agent reviews, outputs JSON with verdict=ATTENTION, 0 P0, 2 P1
           complete turn with finalMessage
5. Orchestrator: parse output ✓
                 post comment: "Polaris Review #1: ATTENTION"
                 complete check: neutral
                 set lastReviewedSha = abc123
                 release lock
```

### Push 2: New commits pushed

```
1. Webhook: pull_request.synchronize
2. Router: find existing automation_session
         create automation_run #2
3. Orchestrator: acquire lock ✓
                 isAncestor(abc123, def456) = true → incremental
                 fetch commit range diff (3 new files, 2KB)
                 build prompt (includes previous ReviewState with 2 open P1s)
                 dispatch to session (warm tier → instant wake)
4. Runtime: resume same agent session, execute prompt
           agent reviews incrementally, resolves 1 P1, finds 1 new P2
           verdict=ATTENTION, 0 P0, 1 P1, 1 P2
           complete turn
5. Orchestrator: parse output ✓
                 collapse Review #1 comment into <details>
                 post comment: "Polaris Review #2: ATTENTION"
                 complete check: neutral
                 set lastReviewedSha = def456
                 release lock
```

### Push 3: Concurrent push during review

```
1. Webhook: pull_request.synchronize
2. Router: find existing automation_session
         create automation_run #3
3. Orchestrator: acquire lock ✗ (held by run #2)
                 setPendingReviewRequest(headSha=ghi789)
                 mark run #3 cancelled: "Queued — lock held"
4. (Run #2 finishes, releases lock)
5. Next synchronize webhook picks up naturally
```

---

## Design Invariants

1. **One PR = one `automation_session` row + one linked `interactive_session`**
2. **One push/manual trigger = one `automation_run` row**
3. **Reuse `interactive-session.ts` as the generic runtime** — no forking
4. **`continuous-pr-review` is the GitHub-aware wrapper** — all GitHub API calls outside sandbox
5. **DB-backed turn result handshake** — reliable completion signal
6. **Queue concurrency in DB** — not via input-stream buffering
7. **`/review reset` creates a new `interactive_session`** — clean agent context
8. **Advance `lastReviewedSha` only after successful parse + comment** — prevents review gaps
9. **Persisted event reconstruction for clean output** — bypasses SDK async race condition
10. **Keep GitHub posting entirely outside the sandbox** — orchestrator owns all external writes
