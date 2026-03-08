---
name: oracle
description: Strategic technical advisor with two modes. Use for second opinions, architecture decisions, debugging, security analysis, and research. REPO MODE explores your codebase autonomously (finds gaps, reviews code, traces bugs). WEB MODE researches external info via @steipete/oracle CLI (current best practices, library comparisons, docs). 
allowed-tools: Bash, TaskOutput, AskUserQuestion
---

# Oracle - Unified Technical Advisor

Two complementary modes for different types of questions.

## Routing Decision

**Ask: "Is the truth external, or is it in our code?"**

| Truth Location | Mode | Model |
|----------------|------|-------|
| In our code | Repo | `gpt-5.2` xhigh via Codex SDK |
| External (docs, standards, comparisons) | Web | `5.2 Thinking` + Heavy (default) |
| Complex research needing web synthesis | Web | `gpt-5.2-pro` (escalation) |
| Both (compare impl vs standards) | Parallel | Run both modes |

## Commands

**Script root**: `.agents/skills/oracle/scripts`

### Repo Oracle (codebase exploration)

```bash
bun .agents/skills/oracle/scripts/oracle.ts "question"
```

Capabilities: Explores files, runs commands, searches web (read-only sandbox).

### Web Oracle (`@steipete/oracle` CLI)

The CLI bundles your prompt + selected files into one "one-shot" request so another model can answer with real repo context (API or browser automation). Treat outputs as advisory: verify against the codebase + tests.

**Main workflow**: `--engine browser` with GPT-5.2 Pro in ChatGPT. This is the "human in the loop" path — it can take ~10 minutes to ~1 hour; expect a stored session you can reattach to.

#### Quick reference

```bash
# Default: 5.2 Thinking with Heavy reasoning (fast questions)
npx -y @steipete/oracle --engine browser --model "5.2 Thinking" --browser-thinking-time heavy -p "question"

# Escalation: gpt-5.2-pro (Deep Research - complex multi-source research)
npx -y @steipete/oracle --engine browser --model gpt-5.2-pro -p "question"

# Include repo context (curated files)
npx -y @steipete/oracle --engine browser --model "5.2 Thinking" --browser-thinking-time heavy \
  --file "src/auth/**/*.ts" \
  --file "!**/*.test.ts" \
  -p "question with context"
```

#### Preview & dry-run (no tokens spent)

Always preview before large runs to check token budget and file selection.

```bash
# Summary preview
npx -y @steipete/oracle --dry-run summary -p "<task>" --file "src/**" --file "!**/*.test.*"

# Full preview
npx -y @steipete/oracle --dry-run full -p "<task>" --file "src/**"

# Token/cost sanity check
npx -y @steipete/oracle --dry-run summary --files-report -p "<task>" --file "src/**"
```

#### Attaching files (`--file`)

`--file` accepts files, directories, and globs. Pass multiple times; entries can be comma-separated.

- **Include**: `--file "src/**"` | `--file src/index.ts` | `--file docs --file README.md`
- **Exclude** (prefix with `!`): `--file "src/**" --file "!src/**/*.test.ts" --file "!**/*.snap"`
- **Default-ignored dirs**: `node_modules`, `dist`, `coverage`, `.git`, `.turbo`, `.next`, `build`, `tmp`
- Honors `.gitignore` when expanding globs
- Does not follow symlinks
- Dotfiles filtered unless explicitly included (e.g. `--file ".github/**"`)
- **Hard cap**: files > 1 MB are rejected — narrow the match or split files

**Budget target**: keep total input under ~196k tokens. Use `--files-report` to spot token hogs before spending.

#### Engines (API vs browser)

- **Auto-pick**: uses `api` when `OPENAI_API_KEY` is set, otherwise `browser`.
- **Browser engine** supports GPT + Gemini only; use `--engine api` for Claude/Grok/Codex or multi-model runs.
- **API runs require explicit user consent** before starting because they incur usage costs.
- Browser attachments: `--browser-attachments auto|never|always` (auto pastes inline up to ~60k chars then uploads).

#### Sessions & reattachment

Runs may detach or take a long time (browser + GPT-5.2 Pro often does). **If the CLI times out, don't re-run — reattach.**

```bash
# List recent sessions
oracle status --hours 72

# Reattach to a session
oracle session <id> --render
```

- Sessions stored under `~/.oracle/sessions` (override with `ORACLE_HOME_DIR`).
- Use `--slug "<3-5 words>"` to keep session IDs readable.
- Duplicate prompt guard exists; use `--force` only when you truly want a fresh run.

#### Manual paste fallback

When browser automation isn't available, assemble the bundle and copy to clipboard:

```bash
npx -y @steipete/oracle --render --copy -p "<task>" --file "src/**"
```

Note: `--copy` is a hidden alias for `--copy-markdown`.

### Parallel Execution

Run both with `run_in_background=true`, poll with TaskOutput, synthesize results.

## When to Use Each Mode

### Repo Oracle

Questions where the answer is **in the codebase**:

- "What's causing this race condition in the queue processor?"
- "Audit the blast radius before I refactor the payment service"
- "Why are tests flaky on CI? Investigate the test setup"
- "Map how a request flows from API route to database"
- "Review the uncommitted changes for issues"

### Web Oracle (5.2 Thinking - default)

Questions needing **external knowledge** with quick turnaround:

- "Drizzle vs Prisma for heavy read loads - what are teams saying?"
- "Current security gotchas with Google OAuth?"
- "Is it worth migrating Next.js pages router to app router now?"
- "Compare Socket.io vs Ably vs Pusher for a team of 3"

### Web Oracle (gpt-5.2-pro - escalation)

**Complex research** requiring multi-source synthesis (expect longer runtimes):

- "Comprehensive analysis of auth patterns for B2B SaaS in 2026"
- "Migration path from Redis to Valkey - gather all community experiences"
- "Full competitive analysis of state management solutions"

### Both in Parallel

When comparing **your code against current standards**:

- "Is our auth middleware following current OWASP guidelines?"
- "Does our error handling match RFC 7807? Review our impl"
- "Are we using this library correctly per current docs?"

## Routing When Unclear

If the question type isn't obvious, use AskUserQuestion:

```
What kind of help do you need?
- Find issues in the current implementation (Repo)
- Research best practices and patterns (Web)
- Compare our implementation against current standards (Both)
```

## Prompt Crafting (Web Oracle)

Oracle starts with **zero** project knowledge. The model cannot infer your stack, build tooling, conventions, or "obvious" paths. Include:

- **Project briefing**: stack + build/test commands + platform constraints
- **"Where things live"**: key directories, entrypoints, config files, dependency boundaries
- **Exact question**: what you tried + the error text (verbatim)
- **Constraints**: "don't change X", "must keep public API", "perf budget", etc.
- **Desired output**: "return patch plan + tests", "list risky assumptions", "give 3 options with tradeoffs"

### Exhaustive prompt pattern (long investigations)

When you know this will be a deep investigation, write a self-contained prompt:
- Top: 6-30 sentence project briefing + current goal
- Middle: concrete repro steps + exact errors + what you already tried
- Bottom: attach *all* context files needed so a fresh model can fully understand

If you need to reproduce the same context later, re-run with the same prompt + `--file` set (Oracle runs are one-shot; the model doesn't remember prior runs).

## Second Opinion Workflow

Best practice from developer research: **review diffs and tests, not raw code**.

```
1. Generate changes (primary agent writes code)
2. Package context for review (diff + key files + test results)
3. Review with oracle (critique: bugs, edge cases, missing tests)
4. Apply fixes + run tests
5. Repeat until critique converges
```

Effective review questions:
- "Review the current diff for security issues"
- "What edge cases am I missing in these uncommitted changes?"
- "At the end of this phase, review my work"

## Response Format

Both modes return structured responses:

### Essential
- **Bottom Line**: Direct answer (1-2 sentences)
- **Action Plan**: Numbered next steps
- **Effort Estimate**: Quick (<1h) | Short (1-4h) | Medium (1-2d) | Large (3d+)

### Expanded (when relevant)
- **Reasoning**: Why this approach
- **Trade-offs**: Gains vs sacrifices
- **Dependencies**: Prerequisites

### Edge Cases (when applicable)
- **Escalation Triggers**: When to reconsider
- **Alternatives**: Backup options
- **Gotchas**: Common mistakes

## Background Execution

For deep analysis, run in background:

```bash
# Repo Oracle (use run_in_background=true)
bun .agents/skills/oracle/scripts/oracle.ts "Audit this codebase for security issues"

# Web Oracle (use run_in_background=true)
npx -y @steipete/oracle --engine browser --model gpt-5.2-pro -p "Audit auth patterns" --file "src/auth/**"

# Poll
TaskOutput with block=false

# Get result (avoid context flooding)
tail -100 /path/to/output
```

## Safety

- Don't attach secrets (`.env`, key files, auth tokens). Redact aggressively; share only what's required.
- Prefer "just enough context": fewer files + better prompt beats whole-repo dumps.
- **API runs require explicit user consent** before starting (they incur costs).

## Model Selection Summary

| Mode | Model | Use When |
|------|-------|----------|
| Repo | `gpt-5.2` xhigh | Codebase questions, finding gaps, code review |
| Web (default) | `5.2 Thinking` + Heavy | External research, best practices, comparisons |
| Web (escalation) | `gpt-5.2-pro` | Complex multi-source research, deep synthesis |
