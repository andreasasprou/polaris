# Codex Code Review — QA Checklist

## Setup Verification

- [ ] Workflow appears in Actions tab after push to main
- [ ] `CODEX_AUTH_JSON_B64` secret is set and valid
- [ ] Codex CLI installs successfully in the workflow

## Trigger Tests

| # | Trigger | How to test | Expected |
|---|---------|-------------|----------|
| T1 | PR opened | Open a new non-draft PR | Review runs automatically |
| T2 | PR push (synchronize) | Push a commit to an open PR | Review runs on new commits |
| T3 | Draft PR ignored | Open a draft PR | Workflow does not trigger |
| T4 | Draft → ready | Mark a draft PR as ready | Review runs |
| T5 | `/codex-review` command | Comment `/codex-review` on a PR | Review runs, 👀 reaction added |
| T6 | `/codex-review full` | Comment `/codex-review full` | Full review (not incremental) |
| T7 | `/codex-review reset` | Comment `/codex-review reset` | State cleared, full review |
| T8 | `/codex-review --since <sha>` | Comment with a valid SHA | Reviews only changes since that SHA |
| T9 | `workflow_dispatch` | Trigger manually with PR number | Review runs on specified PR |
| T10 | Bot PR skipped | PR from a bot account (e.g. dependabot) | Skipped with reason in logs |
| T11 | Fork PR ignored | PR from a fork | Workflow `if` prevents execution |
| T12 | Non-collaborator `/codex-review` | Comment from a non-collaborator | Workflow `if` prevents execution |

## Incremental Review

| # | Scenario | Expected |
|---|----------|----------|
| I1 | First review on a PR | `review_mode=full`, `review_scope_reason=no_previous_review` |
| I2 | Push after first review | `review_mode=incremental`, diff only covers new commits |
| I3 | No new commits (re-trigger) | `review_mode=skip`, check says "No New Commits" |
| I4 | Force push (history rewrite) | `review_mode=full`, `review_scope_reason=history_rewritten` |
| I5 | Previous SHA missing | `review_mode=full`, `review_scope_reason=previous_sha_missing` |

## State Continuity

| # | Scenario | Expected |
|---|----------|----------|
| S1 | First review creates state | State comment appears (collapsed, "do not edit") |
| S2 | Second review updates state | Same state comment updated (not a new one) |
| S3 | State contains correct SHA | `last_reviewed_head_sha` matches HEAD after review |
| S4 | Review count increments | `review_count` goes 1 → 2 → 3 |
| S5 | Open issues persist | Issues raised in review #1 appear in state for review #2 |
| S6 | Resolved issues tracked | When a fix is pushed, resolved issues appear in state |
| S7 | `/codex-review reset` clears state | New state comment created, count resets to 1 |

## Stale Comment Management

| # | Scenario | Expected |
|---|----------|----------|
| C1 | Second review marks first stale | First review gets "Superseded" banner + collapsed body |
| C2 | Already-stale comment not double-marked | Re-running doesn't wrap in nested `<details>` |
| C3 | Review #N references correct number | Stale banner says "See Review #N" |
| C4 | Latest review is NOT stale | Only previous reviews are stale-marked |

## Check Run

| # | Scenario | Expected |
|---|----------|----------|
| K1 | Review succeeds with OK | Check: success, title "Review #N: OK" |
| K2 | Review finds P0 | Check: failure, title "Review #N: BLOCK" |
| K3 | Review finds P1 only | Check: success, title "Review #N: ATTENTION" |
| K4 | Codex fails to produce output | Check: failure, title "Review Failed" |
| K5 | Review skipped (bot) | Check: neutral, title "Review Skipped" |
| K6 | No new commits | Check: success, title "No New Commits" |
| K7 | Cancelled by newer push | Check: cancelled |

## Review Quality

| # | Scenario | Expected |
|---|----------|----------|
| Q1 | Review header format | `## Codex Review #N — Verdict: [BLOCK|ATTENTION|OK]` |
| Q2 | Review has Scope section | Lists what was reviewed |
| Q3 | Review has Summary section | 1-3 bullets of what changed |
| Q4 | Issues have required fields | Severity, category, file:lines, failure scenario, fix |
| Q5 | OK verdict skips issue sections | No empty P0/P1/P2 headers |
| Q6 | Incremental review references prior issues | Mentions resolved/carried-forward issues |
| Q7 | Guidelines loaded | If AGENTS.md exists, review references its rules |

## Error Resilience

| # | Scenario | Expected |
|---|----------|----------|
| E1 | Comment post fails | State still persisted, check still updated |
| E2 | State persist fails | Comment still posted, check still updated |
| E3 | Stale marking fails | Comment posted, state persisted, check updated |
| E4 | All post-processing fails | Check updated with "Review Error" |
| E5 | Codex times out | Check: failure, no comment posted |

## Concurrency

| # | Scenario | Expected |
|---|----------|----------|
| X1 | Two pushes in quick succession | First review cancelled, second covers all changes |
| X2 | Cancelled review state | State not updated (expected), next review does full |
| X3 | `/codex-review` during auto-review | Concurrency group handles correctly |

## Portability (for sharing with other teams)

- [ ] Works with only 3 files copied (workflow + 2 scripts)
- [ ] Works without AGENTS.md or REVIEW_GUIDELINES.md
- [ ] Works with custom path filters uncommented
- [ ] Works with different `CODEX_MODEL` values
- [ ] No dependencies on Polaris-specific code
