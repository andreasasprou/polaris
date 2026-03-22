# Codex Code Review — QA Checklist

## Setup Verification

- [x] Workflow appears in Actions tab after push to main
- [x] `CODEX_AUTH_JSON_B64` secret is set and valid
- [x] Codex CLI installs successfully in the workflow
- [x] AppArmor sysctl fix applied (sandbox probe passes)
- [x] Sandbox probe (`codex sandbox linux /bin/true`) hard-gates the job

## Trigger Tests

| # | Trigger | How to test | Expected | Status |
|---|---------|-------------|----------|--------|
| T1 | PR opened | Open a new non-draft PR | Review runs automatically | PASS |
| T2 | PR push (synchronize) | Push a commit to an open PR | Review runs on new commits | PASS |
| T3 | Draft PR ignored | Open a draft PR | Workflow does not trigger | untested |
| T4 | Draft → ready | Mark a draft PR as ready | Review runs | untested |
| T5 | `/codex-review` command | Comment `/codex-review` on a PR | Review runs, 👀 reaction added | PASS |
| T6 | `/codex-review full` | Comment `/codex-review full` | Full review (not incremental) | PASS |
| T7 | `/codex-review reset` | Comment `/codex-review reset` | State cleared, full review | untested |
| T8 | `/codex-review --since <sha>` | Comment with a valid SHA | Reviews only changes since that SHA | untested |
| T9 | `workflow_dispatch` | Trigger manually with PR number | Review runs on specified PR | untested |
| T10 | Bot PR skipped | PR from a bot account (e.g. dependabot) | Skipped with reason in logs | untested |
| T11 | Fork PR ignored | PR from a fork | Workflow `if` prevents execution | untested |
| T12 | Non-collaborator `/codex-review` | Comment from a non-collaborator | Workflow `if` prevents execution | untested |

## Incremental Review

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| I1 | First review on a PR | `review_mode=full`, `review_scope_reason=no_previous_review` | PASS |
| I2 | Push after first review | `review_mode=incremental`, diff only covers new commits | PASS |
| I3 | No new commits (re-trigger) | `review_mode=skip`, check says "No New Commits" | untested |
| I4 | Force push (history rewrite) | `review_mode=full`, `review_scope_reason=history_rewritten` | untested |
| I5 | Previous SHA missing | `review_mode=full`, `review_scope_reason=previous_sha_missing` | untested |

## State Continuity

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| S1 | First review creates state | State comment appears (collapsed, "do not edit") | PASS |
| S2 | Second review updates state | Same state comment updated (not a new one) | PASS |
| S3 | State contains correct SHA | `last_reviewed_head_sha` matches HEAD after review | PASS |
| S4 | Review count increments | `review_count` goes 1 → 2 → 3 → 4 | PASS |
| S5 | Open issues persist | Issues raised in review pass 1 appear in state for pass 2 | PASS |
| S6 | Resolved issues tracked | When a fix is pushed, resolved issues appear in review | PASS — Review Pass 4 noted "parseUserId now rejects invalid input" |
| S7 | `/codex-review reset` clears state | New state comment created, count resets to 1 | untested |

## Stale Comment Management

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| C1 | Second review marks first stale | First review gets "Superseded" banner + collapsed body | PASS |
| C2 | Already-stale comment not double-marked | Re-running doesn't wrap in nested `<details>` | PASS |
| C3 | Review pass label references correct number | Stale banner says "See Codex Review Pass N" | PASS |
| C4 | Latest review is NOT stale | Only previous reviews are stale-marked | PASS — verified: review passes 1-3 stale, pass 4 current |

## Check Run

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| K1 | Review succeeds with OK | Check: success, title "Codex Review Pass N: OK" | PASS |
| K2 | Review finds P0 | Check: failure, title "Codex Review Pass N: BLOCK" | untested |
| K3 | Review finds P1 only | Check: success, title "Codex Review Pass N: ATTENTION" | PASS |
| K4 | Codex fails to produce output | Check: failure, title "Review Failed" | untested |
| K5 | Review skipped (bot) | Check: neutral, title "Review Skipped" | untested |
| K6 | No new commits | Check: success, title "No New Commits" | untested |
| K7 | Cancelled by newer push | Check: cancelled | untested |

## Review Quality

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| Q1 | Review header format | `## Codex Review Pass N — Verdict: [BLOCK|ATTENTION|OK]` | PASS |
| Q2 | Review has Scope section | Lists what was reviewed | PASS |
| Q3 | Review has Summary section | 1-3 bullets of what changed | PASS |
| Q4 | Issues have required fields | Severity, category, file:lines, failure scenario, fix | PASS |
| Q5 | OK verdict skips issue sections | No empty P0/P1/P2 headers | PASS — Review Pass 4 (OK) only shows P2 |
| Q6 | Incremental review references prior issues | Mentions resolved/carried-forward issues | PASS — Review Pass 4 notes both P1 fixes |
| Q7 | Guidelines loaded | If AGENTS.md exists, review references its rules | PASS |
| Q8 | Real file paths | Review cites actual `file:line` not placeholders | PASS — after sandbox fix |

## Sandbox & Security

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| X1 | AppArmor sysctl fix applied | `apparmor_restrict_unprivileged_userns=0` in logs | PASS |
| X2 | Sandbox probe passes | `codex sandbox linux /bin/true` succeeds | PASS |
| X3 | Codex reads source files | No bwrap errors, real file paths in review | PASS |
| X4 | Dirty-tree check passes | Codex didn't modify tracked files | PASS |
| X5 | `persist-credentials: false` | Git config doesn't leak auth token | PASS (configured) |
| X6 | Network disabled for commands | `sandbox_workspace_write.network_access=false` | PASS (configured) |
| X7 | Web search disabled | `web_search="disabled"` | PASS (configured) |

## Error Resilience

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| E1 | Comment post fails | State still persisted, check still updated | untested |
| E2 | State persist fails | Comment still posted, check still updated | untested |
| E3 | Stale marking fails | Comment posted, state persisted, check updated | untested |
| E4 | All post-processing fails | Check updated with "Review Error" | untested |
| E5 | Codex times out | Check: failure, no comment posted | untested |
| E6 | Inline review 422 (invalid anchors) | Summary comment already posted, no error | untested (graceful fallback in code) |
| E7 | Schema file not on PR branch | Fallback schema written inline | PASS |

## Concurrency

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| X1 | Two pushes in quick succession | First review cancelled, second covers all changes | untested |
| X2 | Cancelled review state | State not updated (expected), next review does full | untested |
| X3 | `/codex-review` during auto-review | Concurrency group handles correctly | untested |

## Inline Review Comments (Phase 2)

| # | Scenario | Expected | Status |
|---|----------|----------|--------|
| R1 | Model provides inlineAnchors | Inline comments appear on diff lines | untested — model hasn't seen new prompt yet |
| R2 | Model provides no anchors | Summary comment only; previous inline review is cleared or retained for retry if dismissal fails | PASS — unit tested |
| R3 | Invalid anchor lines (422) | Summary posted, inline fails silently | untested (code handles it) |
| R4 | Previous inline review dismissed | Old inline review is dismissed before a replacement review is posted | PASS — unit tested |
| R5 | lastCommentId is always issue comment ID | Never stores review ID in lastCommentId | PASS (by design) |
| R6 | Anchor data not persisted in reviewState | openIssues has no line/startLine/body/suggestion | PASS (by design — extractInlineAnchors strips them) |
| R7 | Multi-line comments include start_side | start_side: "RIGHT" when start_line present | PASS (unit tested via buildReviewComments) |

## Portability (for sharing with other teams)

- [x] Works with only the workflow + scripts directory copied
- [x] Works without AGENTS.md or REVIEW_GUIDELINES.md
- [x] Works with custom path filters uncommented
- [x] No dependencies on Polaris-specific code
- [x] Auth docs link included in workflow header

## Bugs Found & Fixed During QA

| Bug | Root Cause | Fix |
|-----|-----------|-----|
| `parseCommand` require fails on issue_comment | Script required before checkout | Inlined command parsing |
| Codex can't read/write files (bwrap error) | AppArmor blocks unprivileged user namespaces on Ubuntu 24.04 | Added sysctl fix matching openai/codex-action@v1 |
| Schema file not found | PR branch doesn't have latest schema | Checkout scripts from main first, copy to /tmp |
| `--output-schema` invalid_json_schema | Missing `additionalProperties: false` on all objects | Added to all object types |
| `--ask-for-approval` unknown flag | Not a valid `codex exec` flag | Removed; `--sandbox` controls approval behavior |
| Review posted but `REVIEW_GENERATED: false` | Old parseOutput looked for /tmp files | Switched to --output-schema + -o for structured output |
| Check run name duplicates workflow name | Check run named "Codex Code Review" same as workflow | Renamed to "Codex Review Result" |
| Duplicate sidebar entries | Check run appeared alongside workflow job | Renamed check to avoid confusion |
| Scripts stale on PR branch | PR checkout replaces main's scripts | Sparse-checkout main scripts to /tmp first |
| Diff files in /tmp not readable by sandbox | bwrap sandbox can't access /tmp | Moved artifacts to .codex-ci/ in workspace |
