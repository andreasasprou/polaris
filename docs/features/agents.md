# Code Review Automations

Polaris runs automated code reviews on your pull requests using AI agents. You can configure reviews in two ways:

1. **Via the UI** — create an automation in the dashboard with instructions, agent, model, and filters
2. **Via code** — commit YAML files to `.polaris/reviews/` in your repository

Code-based configuration is the recommended approach. It's version-controlled, PR-reviewable, and supports multiple independent reviews per PR.

## Quick start

Create a file at `.polaris/reviews/default.yaml` in your repository:

```yaml
name: "Code Review"

instructions: |
  Focus on correctness, security, and reliability.
  Flag any error handling gaps in API routes.

agent: claude
model: sonnet
effort: high
```

That's it. The next PR opened against this repo will use these instructions. Polaris auto-discovers the `.polaris/reviews/` directory — no UI changes needed.

## How it works

1. A PR is opened (or pushed to) on a repo connected to Polaris
2. Polaris fetches `.polaris/reviews/*.yaml` from the repository at the PR's head commit
3. Each valid YAML file becomes an independent review — its own GitHub check, its own PR comment
4. If no `.polaris/reviews/` directory exists, Polaris falls back to the automation's UI-configured settings

Reviews run in parallel. Each definition gets its own sandbox, agent session, and lock — they don't interfere with each other.

## YAML reference

Every field except `name` is optional. Missing fields inherit from the automation's UI settings (the "connector").

```yaml
# .polaris/reviews/security.yaml

# Required: displayed in GitHub check name and PR comment header
name: "Security Review"

# Review instructions — replaces the automation's UI-configured prompt entirely
instructions: |
  You are a security-focused reviewer. Check for:
  - Auth/authz regressions
  - Injection risks (SQL, XSS, command)
  - Secret or token exposure
  - Unsafe input handling at system boundaries
  Ignore style, naming, and performance unless they create a security risk.

# Agent and model configuration
agent: claude                     # claude | codex
model: sonnet                     # model identifier for the chosen agent
effort: high                      # low | medium | high | xhigh

# Reference a platform credential by slug (key pool name or API key label)
# The actual secret never appears in the YAML — Polaris resolves the slug
# from your org's Settings > API Keys. If omitted, uses the automation's default.
credential: "anthropic-pool"

# Include the Polaris base review prompt as a preamble to your instructions.
# The base review covers structured severity analysis, dependency mapping,
# contract auditing, and omission detection. Default: false.
include-base-review: false

# Custom GitHub check name. Default: "Polaris: <name>"
check-name: "Security Scan"

# Filters — control which PRs trigger this review
filters:
  # Only review PRs targeting these branches (empty = all branches)
  branches:
    - main
    - release/*

  # Only trigger when changes touch these paths (glob patterns, empty = all paths)
  paths:
    - "src/**"
    - "lib/**"

  # Exclude these paths from the diff sent to the agent
  ignore-paths:
    - "*.lock"
    - "dist/**"
    - "**/*.generated.ts"

  # Skip draft PRs (default: true)
  skip-drafts: true

  # Skip PRs authored by bots (default: true)
  skip-bots: true

  # Skip PRs with any of these labels
  skip-labels:
    - "no-review"
    - "wip"

# File classification for severity calibration
file-classification:
  # Full scrutiny — all severity levels apply
  production:
    - "src/**"
    - "lib/**"
    - "app/**"
  # Non-security issues capped at P2
  relaxed:
    - "tests/**"
    - "docs/**"
    - "scripts/**"

# Limit overrides
limits:
  max-diff-bytes: 200000
  max-files: 150
  max-guidelines-bytes: 40000
```

## Multiple reviews

Each `.yaml` file in `.polaris/reviews/` runs as an independent review. Use this to get specialized feedback from different perspectives:

```
.polaris/
  reviews/
    architecture.yaml     # Dependency direction, module boundaries
    security.yaml         # Auth, injection, secret exposure
    docs.yaml             # Documentation completeness
```

Each review produces its own GitHub check and PR comment. They run in parallel and don't share state — an architecture review won't see or duplicate findings from the security review.

### Example: multi-review setup

```yaml
# .polaris/reviews/architecture.yaml
name: "Architecture"
agent: claude
model: sonnet
effort: high
instructions: |
  Focus on dependency direction, module boundaries, and coupling.
  Flag new cross-module dependencies that violate existing patterns.
  Check that the PR respects the module map in ARCHITECTURE.md.
filters:
  ignore-paths: ["docs/**", "tests/**"]
```

```yaml
# .polaris/reviews/docs.yaml
name: "Documentation"
agent: claude
model: haiku
effort: medium
instructions: |
  Check that README, ARCHITECTURE.md, API docs, and inline comments
  are updated when the PR changes behavior, contracts, or configuration.
  Do not flag missing docs for pure refactors or internal implementation.
filters:
  paths: ["docs/**", "README.md", "ARCHITECTURE.md", "src/**", "lib/**"]
```

## Credentials

YAML files reference credentials by **slug** — the name of a key pool or the label of an API key from Settings > API Keys. Actual secrets never appear in the YAML.

```yaml
credential: "my-anthropic-pool"    # matches a key pool name in Polaris
```

```yaml
credential: "team-claude-key"      # matches an API key label in Polaris
```

Resolution order:
1. Key pools — matched by pool name within your organization
2. Individual API keys — matched by key label within your organization

If the slug doesn't match any credential, the review fails with a clear error in the GitHub check. If `credential` is omitted, the automation's default credential is used.

## Polaris base review

Polaris includes a built-in review prompt that covers structured severity analysis, dependency mapping, contract auditing, state machine walkthroughs, and omission detection. It's the same prompt used by the default review automation.

To include it as a preamble to your custom instructions:

```yaml
include-base-review: true
instructions: |
  In addition to the base review, pay special attention to
  database migration safety and backward compatibility.
```

When `include-base-review: false` (the default), only your custom instructions are used. The core review framework (severity levels, output format) is always included regardless of this setting.

## Repository guidelines

Polaris always discovers and injects these repo-level files into every review, regardless of how the review is configured:

- `AGENTS.md` or `.agents.md` at the repo root
- `REVIEW_GUIDELINES.md` or `.review-guidelines.md` at the repo root
- Scoped `AGENTS.md` files in directories containing changed files

These are injected as "Repository Guidelines" in the review prompt. They work alongside your YAML instructions — use AGENTS.md for general repo guidance and YAML instructions for review-specific focus.

## Code vs UI configuration

| Aspect | Code (`.polaris/reviews/`) | UI (automation settings) |
|--------|---------------------------|--------------------------|
| Instructions | YAML `instructions` field | "Instructions" textarea |
| Agent / model / effort | YAML fields | Dropdowns |
| Credentials | Slug reference in YAML | Dropdown picker |
| Filters | YAML `filters` block | Form fields |
| Version control | Yes (committed to repo) | No |
| PR-reviewable | Yes | No |
| Multiple reviews | One file per review | One automation per review |

When both exist, **code takes precedence**. If `.polaris/reviews/` contains valid YAML files, those define the reviews. The UI automation serves as the "connector" — it provides the webhook subscription and default credentials for any YAML fields you leave unspecified.

If you remove `.polaris/reviews/` from the repo, Polaris falls back to the UI-configured automation settings automatically.

## Connector automation

Even with code-based reviews, you still need one automation configured in the Polaris UI. This "connector" automation:

- Links the repository to Polaris (webhook subscription)
- Provides default credentials when YAML doesn't specify `credential`
- Provides default agent/model/effort when YAML doesn't specify them
- Controls the master enable/disable toggle

Think of it as the bridge between your GitHub repo and Polaris. The YAML files define _what_ to review and _how_; the connector defines _where_ the credentials come from.

## Tips

- **Start with one file** — a single `default.yaml` already gives you version-controlled review config
- **Use different agents for different reviews** — Codex for architecture (deep reasoning), Claude Haiku for docs (fast and cheap)
- **Keep instructions focused** — a 10-line focused prompt outperforms a 200-line generic one
- **Test changes in a branch** — YAML is read from the PR's head commit, so you can iterate on review config in a feature branch before merging
- **AGENTS.md still works** — repo guidelines are always injected alongside your YAML instructions; use AGENTS.md for broad repo context and YAML for review-specific focus
