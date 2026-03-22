# OpenReview — Codex Code Review GitHub Action

A lightweight, self-contained PR review bot powered by Codex. Copy three files to any repo and get AI code reviews with inline comments, incremental review continuity, and automatic issue resolution.

## Features

- **Incremental reviews** — only reviews new commits since the last review pass
- **Inline comments** — findings appear directly on the PR diff with file+line anchors
- **Auto-resolve** — when a fix is pushed, the bot replies "Resolved" and closes the review thread
- **Stale comment management** — previous reviews are collapsed with a "Superseded" banner
- **State continuity** — tracks open/resolved issues across review passes
- **`/codex-review` command** — trigger reviews manually with options (`full`, `reset`, `--since <sha>`)
- **Structured output** — uses `--output-schema` for reliable JSON output from Codex
- **Repo guidelines** — loads `AGENTS.md` and `REVIEW_GUIDELINES.md` as review criteria
- **Sandbox hardening** — workspace-write sandbox with network disabled, dirty-tree check, persist-credentials:false

## Setup

### 1. Copy files to your repo

```
.github/
  workflows/
    codex-review.yml          ← from docs/open-review/codex-review.yml
  scripts/
    codex-review/
      index.cjs               ← from docs/open-review/scripts/index.cjs
      output-schema.json       ← from docs/open-review/scripts/output-schema.json
      prompt.md                ← from docs/open-review/scripts/prompt.md
```

### 2. Set up Codex auth

```bash
codex login
gh secret set CODEX_AUTH_JSON_B64 \
  --body "$(cat ~/.codex/auth.json | base64 | tr -d '\n')"
```

See [Codex auth docs](https://developers.openai.com/codex/auth#credential-storage) for where `auth.json` is stored on your platform.

### 3. Customize

Edit `codex-review.yml`:

```yaml
env:
  CODEX_MODEL: gpt-5.4                  # Model to use
  CODEX_REASONING: xhigh                # Reasoning effort
  CODEX_SANDBOX_MODE: workspace-write   # workspace-write | read-only
  CODEX_WEB_SEARCH_MODE: disabled       # disabled | cached | live
```

Optionally uncomment the `paths:` filter to only trigger on specific directories.

## How it works

### Review lifecycle

1. PR opened or push → workflow triggers
2. Loads previous review state from a hidden GitHub comment (base64 JSON)
3. Determines scope (full vs incremental) based on last reviewed SHA
4. Generates diff, builds prompt with repo guidelines
5. Runs Codex with `--output-schema` for structured JSON output
6. Posts summary comment + inline review comments on the diff
7. Tracks inline comment IDs for future reply-on-resolve
8. Persists state for the next review pass

### Inline comment resolution

When a fix is pushed and the next review detects a resolved issue:

1. The bot replies to the original inline comment: "Resolved in `<sha>`"
2. The bot auto-resolves the review thread via GraphQL `resolveReviewThread`
3. The summary comment lists resolved issues with strikethrough

This requires `contents: write` permission (already configured in the workflow).

### State storage

Review state is stored as a base64-encoded JSON blob inside a hidden HTML comment on the PR. No database required. State includes:

- `last_reviewed_head_sha` — checkpoint for incremental reviews
- `review_count` — pass number (1, 2, 3...)
- `open_issues` — currently open findings with stable IDs
- `recently_resolved_issues` — issues resolved in the latest pass
- `inlineCommentMap` — maps issue IDs to GitHub comment IDs for reply-on-resolve

### Security model

- Uses `pull_request_target` for secret access — only same-repo PRs are reviewed (fork PRs ignored)
- `GITHUB_TOKEN` is NOT passed to Codex
- PR code is checked out by SHA with `persist-credentials: false`
- Codex runs in `workspace-write` sandbox with `network_access=false`
- A dirty-tree check fails the job if Codex modifies tracked files
- AppArmor fix for Ubuntu 24.04 matches `openai/codex-action@v1` (action.yml lines 262-286)
- Sandbox probe hard-fails the job if bwrap can't create user namespaces

### Commands

| Command | Effect |
|---------|--------|
| `/codex-review` | Incremental review (new commits only) |
| `/codex-review full` | Full review of entire PR diff |
| `/codex-review reset` | Clear state, start fresh |
| `/codex-review --since <sha>` | Review changes since specific commit |

## Architecture decisions

- **Summary always posted first** — inline comments are additive, never a replacement. If inline posting fails, the summary is already visible.
- **Always COMMENT event** — never `REQUEST_CHANGES`. The check run (not the review event) is the merge-blocking mechanism. This avoids stale blocking reviews in branch protection.
- **API validates anchors** — no local diff parser. Invalid line numbers cause a 422 which is handled gracefully.
- **Stateless per-run** — each `codex exec` is a fresh session. Continuity is via state injection in the prompt, not session resumption.
