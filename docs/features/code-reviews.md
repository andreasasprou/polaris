# Code Reviews as Code

Polaris can read review configuration from your repository instead of (or in addition to) the UI. Commit a YAML file to `.polaris/reviews/` and Polaris will use it to drive your PR reviews.

## Quick start

Create `.polaris/reviews/default.yaml` on your default branch:

```yaml
name: "Code Review"

instructions: |
  Focus on correctness, security, and reliability.
  Flag any error handling gaps in API routes.
  Ignore pure formatting or style issues.

filters:
  branches: [main]
  ignore-paths: ["*.lock", "dist/**"]
  skip-drafts: true
  skip-bots: true
  skip-labels: ["no-review"]

file-classification:
  production: ["src/**", "lib/**"]
  relaxed: ["tests/**", "docs/**"]
```

Merge this file. The next PR opened against the repo will be reviewed using these instructions.

## How it works

1. A PR is opened (or pushed to) on a repo connected to Polaris
2. Polaris fetches `.polaris/reviews/` from the **base branch** (e.g. `main`), not the PR head
3. If exactly one `.yaml`/`.yml` file is found, its instructions and filters merge with the connector automation
4. If no `.polaris/reviews/` directory exists, the connector's UI settings are used as-is

## Trust model

**Config is read from the base branch, not the PR head.** A PR author cannot weaken or skip their own review by modifying `.polaris/reviews/` in the same PR. Config changes take effect after they are merged — the same convention as `.github/workflows/`.

## YAML schema

Every field except `name` is optional. Missing fields inherit from the connector automation.

```yaml
# Required: identifies this review definition
name: "Code Review"

# Review instructions — replaces the connector's UI-configured prompt
instructions: |
  Your review instructions here.

# Agent and model configuration (overrides connector defaults)
agent: claude                      # claude | codex
model: sonnet                      # model identifier for the chosen agent
effort: high                       # claude: low|medium|high|max, codex: low|medium|high|xhigh

# Credential reference by slug — matches a key pool name or API key label
# from your org's Settings > API Keys. The actual secret never appears in YAML.
credential: "my-anthropic-pool"

# Filters — control which PRs trigger this review
filters:
  branches: [main]                 # exact match (no glob)
  ignore-paths: ["*.lock", "dist/**"]
  skip-drafts: true
  skip-bots: true
  skip-labels: ["no-review"]

# File classification for severity calibration
file-classification:
  production: ["src/**", "lib/**"]
  relaxed: ["tests/**", "docs/**"]
```

### Fields NOT supported yet

`check-name`, `limits`, `filters.paths` — these inherit from the connector automation and will be configurable in YAML in a future release.

## Merge semantics

Each YAML field either replaces or inherits from the connector:

| Field | Present in YAML | Omitted from YAML |
|-------|----------------|-------------------|
| `instructions` | Replaces `customPrompt` entirely | Inherits connector prompt |
| `instructions: ""` | Explicitly clears prompt | — |
| `agent` | Overrides connector agent | Inherits from connector |
| `model` | Overrides connector model | Inherits from connector |
| `effort` | Overrides connector effort level | Inherits from connector |
| `credential` | Resolves slug → overrides connector credential | Inherits from connector |
| `filters.*` | Each present field replaces its connector counterpart | Omitted fields inherit |
| `file-classification` | Replaces entirely | Inherits from connector |

No deep merge — YAML fields replace at the top level.

### Example

**YAML:**
```yaml
name: "Security Review"
instructions: |
  Focus on auth, injection, and secret exposure.
filters:
  skip-bots: false
```

**Connector config:**
```json
{
  "customPrompt": "Old UI prompt...",
  "branchFilter": ["main"],
  "skipBots": true,
  "skipLabels": ["no-review"]
}
```

**Result:** `instructions` replaces `customPrompt`, `skip-bots: false` overrides `skipBots`, everything else inherited.

## Error handling

| Scenario | Behavior |
|----------|----------|
| `.polaris/reviews/` missing | Connector config used (backward compatible) |
| Directory empty (no `.yaml`/`.yml`) | Connector config used |
| 1 valid file | Merged config used |
| Invalid YAML syntax | GitHub check fails with parse error |
| Schema validation failure | GitHub check fails with field-level errors |
| Multiple `.yaml` files | GitHub check fails: "Multiple definitions found" |
| Unknown `credential` slug | GitHub check fails: "credential not found" |

Present-but-broken config is always a check failure with diagnostics — never a silent fallback to connector settings.

## Repository guidelines

Polaris always discovers and includes these repo-level files in every review:

- `AGENTS.md` / `.agents.md` at the repo root
- `REVIEW_GUIDELINES.md` / `.review-guidelines.md` at the repo root
- Scoped `AGENTS.md` files in directories containing changed files

These are read from the base branch (same trust model as review config) and injected alongside your YAML instructions.

## Connector automation

Even with code-based config, you need one automation in the Polaris UI. This "connector" provides:

- GitHub App webhook subscription
- Default credentials (API key or key pool)
- Default agent, model, and effort level
- Master enable/disable toggle

The YAML file defines *what* to review and *how*; the connector provides the defaults for anything the YAML doesn't specify.

## Credentials

YAML files reference credentials by **slug** — the name of a key pool or the label of an API key from Settings > API Keys. Actual secrets never appear in the YAML.

```yaml
credential: "my-anthropic-pool"    # matches a key pool name in Polaris
```

Resolution order:
1. Key pools — matched by pool name within your organization
2. Individual API keys — matched by key label within your organization

If the slug doesn't match any credential, the review fails with a clear error in the GitHub check. If `credential` is omitted, the connector's default credential is used.

## Current limitations

- **One definition per repo** — multiple `.yaml` files in `.polaris/reviews/` produce an error. Multi-review fan-out is planned.
- **Exact branch matching** — `branches: [main]` uses exact string match, not globs.
