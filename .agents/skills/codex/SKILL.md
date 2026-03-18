---
name: codex
description: Dispatch Codex as a stateless coding sub-agent via Bash. Use when you're stuck, need a second opinion, need parallel research on a hard problem, or want code review from a different model. Codex has no memory — you must provide all context. Triggers on "run codex", "dispatch codex", "ask codex", "codex review", "second opinion", or when you decide autonomously that a fresh perspective would help.
allowed-tools: Bash, TaskOutput, AskUserQuestion
---

# Dispatching Codex

Shell out to **Codex** (`codex`) as a stateless sub-agent via Bash. It has filesystem and tool access (sandboxed) but **zero memory** — every session starts from scratch.

**Default to `run_in_background: true`** so you can keep working. Check results later with `TaskOutput`.

## Step 1: Ask the User for Model and Effort

Before dispatching, use AskUserQuestion to ask which model and reasoning effort to use in a **single prompt**:

```
Which model and reasoning effort should Codex use?

**Model:**
1. `gpt-5.3-codex` — Frontier reasoning. Best for the hardest debugging and complex tasks. Slow with long trajectories.
2. `gpt-5.3-codex-spark` — Ultra-fast. Good for quick checks and simple tasks.
3. `gpt-5.4` — Latest frontier. Fast, general-purpose. More likely to make silly errors than gpt-5.3-codex.

**Reasoning effort:**
1. `xhigh` — Maximum depth. Use for the hardest problems.
2. `high` — Strong reasoning. Good default for non-trivial tasks.
3. `medium` — Balanced. Good for moderate complexity.
4. `low` — Fast and cheap. Simple lookups and checks.
```

If context makes the choice obvious (e.g. quick grep = spark+low, brutal debugging = gpt-5.3-codex+xhigh), propose defaults and let the user confirm or override.

## Step 2: Build the Prompt

Codex is a brilliant intern who showed up today. It knows nothing about the codebase, the user's preferences, or what you've already tried. **Give context, not a plan** — let it figure out the approach.

### Prompt template

```
TASK: [one-sentence summary]

CONTEXT:
- Repo: [path]
- Key files: [list specific files and what they contain]
- Architecture: [brief relevant context]

WHAT TO DO:
[precise instructions — but let Codex figure out the approach]

EDIT SCOPE: [read-only | may edit files | may edit + run tests]

CONSTRAINTS:
- [code style, error handling patterns, things to avoid]
- [what you've already tried, if dispatching because stuck]

OUTPUT:
[what you want back — a diff, a list of files, a root cause analysis, etc.]
[if edits: list files changed and commands run]
```

### What makes a good prompt

- **Be specific about files** — `src/agent/message.ts lines 40-80`, not "the message handling code"
- **State the output format** — "return a bullet list of findings" vs. leaving it open-ended
- **State the edit scope** — "read-only analysis" vs. "you may edit files". Match the sandbox mode accordingly
- **Include constraints** — user preferences, patterns to follow, things the user has corrected you on
- **Provide what you've tried** — when stuck, prevent Codex from repeating your dead ends
- **Don't over-specify the approach** — tell it what to do, not how. It may find a better path

## Step 3: Dispatch

### For tasks that need edits (implementation, fixes)

```bash
codex exec -m MODEL -c model_reasoning_effort=EFFORT --full-auto -C /path/to/repo "YOUR PROMPT"
```

`--full-auto` = `workspace-write` sandbox + auto-approve on request. Use for tasks where Codex should be able to edit files and run commands.

### For read-only tasks (research, review, analysis)

```bash
codex exec -m MODEL -c model_reasoning_effort=EFFORT -s read-only -C /path/to/repo "YOUR PROMPT"
```

`-s read-only` = no file writes, no destructive commands. Prefer this for investigations, second opinions, and code review.

Use `run_in_background: true` on the Bash call. Continue your own work.

## When to Dispatch (and When Not To)

### Dispatch for:
- **Hard debugging** — you've been looping on a problem and need fresh eyes
- **Second opinions** — validate before a risky change
- **Parallel research** — investigate multiple hypotheses simultaneously
- **Large-scope investigation** — tracing a flow across many files in an unfamiliar area
- **Code review** — have another agent review your diff or plan

### Don't dispatch for:
- Simple file reads, greps, or small edits — faster to do yourself
- Anything < ~3 minutes of direct work
- Tasks where you already know exactly what to do
- When context transfer would take longer than just doing the task

## Dispatch Patterns

### Background dispatch (default)

```bash
# Edit task — use --full-auto
codex exec -m gpt-5.3-codex -c model_reasoning_effort=high --full-auto -C /path/to/repo "PROMPT"

# Read-only task — use -s read-only
codex exec -m gpt-5.4 -c model_reasoning_effort=high -s read-only -C /path/to/repo "PROMPT"
```

Continue working. Check results with `TaskOutput` when ready.

### Parallel research — multiple hypotheses

Run multiple Codex sessions simultaneously via separate Bash calls in a single message (all `run_in_background: true`). Compare results for higher confidence.

### Deep investigation — frontier reasoning

For the hardest problems:

```bash
codex exec -m gpt-5.3-codex -c model_reasoning_effort=xhigh -s read-only -C /path/to/repo "PROMPT"
```

### Code review

```bash
# Native review — uses default model from config. No -m or -C flag available.
# Set Bash working directory to the repo root.
codex review --uncommitted

# Review with model selection — use exec review. No -C flag, so set Bash cwd.
codex exec review -m gpt-5.4 -c model_reasoning_effort=high "Focus on error handling and edge cases"

# Review specific commits or branches
codex review --base main
codex review --commit HEAD~3

# Review a diff via stdin (better than $(git diff) for large diffs)
git diff | codex exec -m gpt-5.4 -c model_reasoning_effort=high -s read-only -C /path/to/repo -
```

**Note:** `codex review` and `codex exec review` do not support `-C`. Set the Bash tool's working directory to the repo root instead.

### Get outside feedback on your work

Write your plan or analysis to a file, then ask Codex to critique it:

```bash
codex exec -m gpt-5.3-codex -c model_reasoning_effort=high -s read-only -C /path/to/repo \
  "Read /tmp/my-plan.md and critique it. What am I missing? What could go wrong?"
```

## CLI Reference

```bash
codex exec -m MODEL -c model_reasoning_effort=EFFORT -s SANDBOX -C DIR "PROMPT"
```

| Flag | Purpose |
|------|---------|
| `exec` | Non-interactive mode, prints response and exits |
| `-m MODEL` | `gpt-5.3-codex` (frontier), `gpt-5.3-codex-spark` (ultra-fast), `gpt-5.4` (latest general-purpose) |
| `-c model_reasoning_effort=EFFORT` | `xhigh`, `high`, `medium`, `low` — controls reasoning depth |
| `-c web_search=live` | Enable web search tool |
| `-s SANDBOX` | Sandbox policy: `read-only` (research/review), `workspace-write` (edits), `danger-full-access` (unrestricted) |
| `--full-auto` | Shorthand for `-s workspace-write` + auto-approve on request |
| `-C DIR` | Set working directory (not available on `review` subcommand) |
| `-p PROFILE` | Load a named profile from `~/.codex/config.toml` |
| `-o FILE` | Write last agent message to a file (useful for harvesting structured output) |
| `--json` | Print events to stdout as JSONL |
| `--output-schema FILE` | JSON Schema for structured final response |
| `-` (as PROMPT) | Read prompt from stdin (useful for large diffs or prompts) |
| `review` | Native code review — `codex review --uncommitted` or `codex exec review "prompt"` |

`-c` overrides any `config.toml` value. Multiple `-c` flags can be chained.

## Session Management

Codex persists full session data (tool calls, reasoning, files read) to disk. The Bash output is just the final summary — the session file is much richer.

### Session storage

`~/.codex/sessions/<year>/<month>/<day>/rollout-*-<session-id>.jsonl`

For programmatic lookup, prefer `~/.codex/session_index.jsonl` or `--last` over parsing stdout.

### Resuming sessions

Use session resumption to continue a line of investigation without re-providing all context:

```bash
codex exec resume SESSION_ID "Follow up prompt"  # Resume by ID (non-interactive)
codex exec resume --last "Follow up prompt"       # Resume most recent (non-interactive)
```

Interactive variants (use only when truly needed):

```bash
codex resume SESSION_ID "Follow up prompt"        # Resume by ID
codex resume --last "Follow up prompt"            # Resume most recent
codex fork SESSION_ID "Try a different approach"  # Fork session (new branch, keeps history)
```

**When to resume vs. start fresh:** Resume when Codex asked a question or you want to continue the same investigation. Start fresh when the task is distinct or the previous session was long enough to risk compaction.

## Handling Failures

| Problem | Fix |
|---------|-----|
| **Garbage output** | Prompt too vague. Rewrite with specific file paths and clearer instructions |
| **Compaction mid-task** | Session ran too long, earlier context lost. Break into shorter sequential sessions |
| **Session errors** | Start a fresh `exec` session |
| **Timeout** | Shorter, more focused prompt. Or switch from `xhigh` to `high` effort |

## Timeouts

Set Bash timeouts appropriate to the task:

| Task type | Timeout |
|-----------|---------|
| Quick checks / reviews | `timeout: 120000` (2 min) |
| Research / analysis | `timeout: 300000` (5 min) |
| Implementation | `timeout: 600000` (10 min) |

## Model Strengths

| Model | Best for | Watch out for |
|-------|----------|---------------|
| `gpt-5.3-codex` | Hardest debugging, complex multi-step reasoning | Slow with long trajectories, compactions can destroy context |
| `gpt-5.3-codex-spark` | Quick checks, simple tasks, fast iteration | Less thorough reasoning |
| `gpt-5.4` | General-purpose, fast, readable output | More likely to make silly errors than gpt-5.3-codex |

Track what works over time — your own observations are more valuable than these defaults.
