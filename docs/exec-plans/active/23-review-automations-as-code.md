---
title: Review Automations as Code
status: active
created: 2026-03-22
owner: andreas
related_prs: []
domains: [reviews, automations, onboarding]
---

# Review Automations as Code

## Problem

### What

PR review automations are configured entirely via the Polaris UI — instructions in a textarea, agent/model/effort in dropdowns, filters as toggles. There is no way to version-control, PR-review, or iterate on review config in code.

### Why

- Review instructions are hard to iterate on (edit in a web textarea, no diff history)
- Config isn't version-controlled or PR-reviewable
- Users can't commit review instructions alongside their code
- No path to multiple independent review profiles per repo (architecture, security, docs)
- Customers want infrastructure-as-code for review config, not UI-only management

## Prompt Architecture

The review prompt has two layers. This separation is load-bearing — the platform scaffold must remain intact for output parsing to work.

**Platform scaffold (always included, not user-customizable):**
- System role preamble — `SYSTEM_SECTION` in `lib/reviews/prompt-builder.ts:92`
- Severity level definitions — `SEVERITY_SECTION` in `lib/reviews/prompt-builder.ts:104`
- PR metadata, review scope, changed files, diff — `formatPRMetadata()`, `formatReviewScope()`, etc.
- Output format contract — `OUTPUT_FORMAT_SECTION` in `lib/reviews/prompt-builder.ts:115`
- Previous review state (incremental reviews) — `formatPreviousState()`

The platform depends on this scaffold for `output-parser.ts` (JSON metadata extraction), comment posting, and review state management. Users cannot modify it.

**User instructions (from YAML `instructions` field):**
- What to focus on, what to skip, review philosophy
- Injected as section 3 in `buildReviewPrompt()` (the existing `customPrompt` slot)
- Fully user-owned and customizable

**No `include-base-review` flag.** Instead, during onboarding we create a PR in the user's repo with `.polaris/reviews/default.yaml` containing our recommended review prompt as the `instructions` value. The user reviews, modifies, and merges — they own the instructions from day one.

## Two-Layer Model

**Platform Layer (UI)** — the "connector" automation:
- GitHub App installation + webhook subscription
- Repository association
- Credentials (API key or key pool) — **owns runtime config in Phase 1**
- Agent, model, effort level — **owns runtime config in Phase 1**
- Master enable/disable toggle

**Repo Layer (Code)** — `.polaris/reviews/*.yaml`:
- Review identity and instructions
- Filters (branches, ignore-paths, skip-drafts, skip-bots, skip-labels)
- File classification (production vs relaxed paths)
- Agent/model/effort/credential overrides — **deferred to Phase 2+**

**Resolution**: If `.polaris/reviews/` contains exactly one valid `.yaml`/`.yml` file on the **base branch** (not the PR head), its instructions and filters override the connector's `prReviewConfig`. Directory doesn't exist or is empty → connector config used as-is. Multiple valid files → fail GitHub check with clear error message (Phase 1).

## Trust Model

**Review config is read from the base/default branch, not the PR head.**

This is a load-bearing decision. If config were read from the PR head, a PR author could weaken or skip their own review by modifying `.polaris/reviews/` in the same PR. Reading from the base branch means:

- Config changes must be merged before they take effect
- A PR that modifies `.polaris/reviews/` is reviewed under the *current* rules, not the proposed ones
- This matches how CI workflows work (`.github/workflows/` changes don't affect the current run)

The same trust boundary applies to `AGENTS.md` and `REVIEW_GUIDELINES.md` — these are already loaded from the base ref via `loadRepoGuidelines()`.

**Which ref exactly:** Use `event.baseRef` (the branch name, e.g. `"main"`), NOT `event.baseSha` (the commit SHA). The branch name gives the latest merged state of the config, which is what we want — if someone merges a config change between the PR being opened and a new push, the latest config should apply. `octokit.rest.repos.getContent({ ref: "main" })` resolves to the branch tip.

**Note:** During onboarding, the first review after merging the setup PR will pick up the new config. Users iterate on config via normal PRs — merge the config change, then the next PR is reviewed under the new rules.

## YAML Schema (Phase 1)

```yaml
# .polaris/reviews/default.yaml
name: "Code Review"

instructions: |
  Focus on correctness, security, and reliability.
  Flag any error handling gaps in API routes.
  ...

filters:
  branches: [main]             # exact match (no glob support yet)
  ignore-paths: ["*.lock", "dist/**"]
  skip-drafts: true
  skip-bots: true
  skip-labels: ["no-review"]

file-classification:
  production: ["src/**", "lib/**"]
  relaxed: ["tests/**", "docs/**"]
```

Fields NOT in Phase 1: `agent`, `model`, `effort`, `credential`, `check-name`, `limits`, `filters.paths`. These inherit from the connector.

## Key Decisions

| Date | Decision | Rationale |
|------|----------|-----------|
| 2026-03-22 | Separate `RepoReviewDefinition` type (not `PRReviewConfig`) | YAML = prompt/filters only, connector = runtime config. Clean separation. |
| 2026-03-22 | No `include-base-review` flag | Onboarding PR seeds the user's repo with recommended prompt. Users own instructions from day one, no hidden toggles. |
| 2026-03-22 | Phase 1: instructions + filters only, no runtime overrides | Codex review: deferring agent/model/credential overrides reduces risk and complexity. |
| 2026-03-22 | Multiple YAML files → explicit error in Phase 1 | "First file wins" is non-deterministic. Explicit error is safer than silent misbehavior. |
| 2026-03-22 | Validation in Phase 1, not deferred | Every YAML typo must produce a clear error, not a confusing runtime failure. |
| 2026-03-22 | Top-level replace merge, not deep merge | Simpler mental model. Each YAML field either replaces or inherits from the connector. No surprising partial overrides. |
| 2026-03-22 | Support both `.yaml` and `.yml` | Both are standard extensions. |
| 2026-03-22 | Branch matching: exact match only | Current `filters.ts` uses `includes()`. Glob support is a separate change. |
| 2026-03-22 | Onboarding defaults: Codex + gpt-5.4 + xhigh | Best review quality. User can change during setup. |
| 2026-03-22 | Read config from base branch, not PR head | PR author must not be able to weaken their own review. Config changes take effect after merge. Matches `.github/workflows/` convention. |
| 2026-03-22 | Present-but-invalid YAML fails the check (no silent fallback) | Only fall back when directory is missing. Any broken config must surface as a clear check failure, not a silent connector fallback. |
| 2026-03-22 | Separate full file list from prompt-budgeted file list | `pathFilter` and scoped AGENTS.md need the complete file list; diff rendering uses the capped list. |
| 2026-03-22 | Normalize YAML keys to camelCase at parse boundary | Hyphenated YAML keys (`ignore-paths`) → camelCase TS (`ignorePaths`). Simplifies merge code and tests. |
| 2026-03-22 | Use `event.baseRef` (branch name) not `event.baseSha` (commit SHA) | Branch name resolves to tip, so config changes merged after PR opened still take effect. |

## Merge Semantics

- `instructions` present in YAML → replaces connector's `customPrompt` entirely
- `instructions` omitted → connector's `customPrompt` used (if any)
- `instructions: ""` (empty string) → explicitly clears inherited prompt
- `filters.*` → each present field replaces the corresponding connector field; omitted fields inherit
- `file-classification` → replaces entirely if present; inherits if omitted
- No nested deep-merge — each top-level YAML field either replaces or inherits

### Merge example

**YAML input:**
```yaml
name: "Security Review"
instructions: |
  Focus on auth, injection, and secret exposure.
filters:
  skip-bots: false
```

**Connector automation config:**
```json
{
  "prReviewConfig": {
    "customPrompt": "Old UI prompt...",
    "branchFilter": ["main"],
    "ignorePaths": ["*.lock"],
    "skipDrafts": true,
    "skipBots": true,
    "skipLabels": ["no-review"],
    "fileClassification": { "production": ["src/**"], "relaxed": ["tests/**"] }
  },
  "agentType": "codex",
  "model": "gpt-5.4"
}
```

**Merged `ResolvedReviewConfig.reviewConfig`:**
```json
{
  "customPrompt": "Focus on auth, injection, and secret exposure.\n",
  "branchFilter": ["main"],
  "ignorePaths": ["*.lock"],
  "skipDrafts": true,
  "skipBots": false,
  "skipLabels": ["no-review"],
  "fileClassification": { "production": ["src/**"], "relaxed": ["tests/**"] }
}
```

Rules applied:
- `instructions` → replaced `customPrompt` (YAML wins)
- `filters.skipBots` → replaced connector's `skipBots` (YAML wins: `false`)
- `filters.branches`, `filters.ignorePaths`, `filters.skipDrafts`, `filters.skipLabels` → inherited from connector (not in YAML)
- `fileClassification` → inherited from connector (not in YAML)

## Config Loading Outcome Matrix

The loader returns a discriminated result, not `null`/throw:

| Scenario | Result | Effect |
|----------|--------|--------|
| Directory missing (404) | `{ status: "not_found" }` | Fall back to connector config |
| Directory exists, 0 `.yaml`/`.yml` files | `{ status: "not_found" }` | Fall back to connector config |
| 1 valid file | `{ status: "found", definition }` | Use merged config |
| 1 file, YAML parse error | `{ status: "invalid", file, error }` | Fail GitHub check with diagnostics |
| 1 file, Zod validation failure | `{ status: "invalid", file, error }` | Fail GitHub check with field-level errors |
| >1 files | `{ status: "multiple", files }` | Fail GitHub check: "Multiple definitions found" |
| GitHub API error (rate limit, network) | `{ status: "error", error }` | Fail GitHub check with transient error message |

**Key rule:** Only `not_found` falls back to the connector. Any present-but-broken config is a check failure with diagnostics, never a silent fallback.

## Existing Bugs to Fix (prerequisite)

Surfaced by the Codex review — not part of the IaC feature, but must be fixed for it to work:

1. **`pr-review.ts:124`** — `shouldReviewPR()` called without `changedFiles`, making `pathFilter` a no-op.
2. **`pr-review.ts:217`** — `loadRepoGuidelines()` receives `[]` for changed paths, so scoped `AGENTS.md` discovery never runs.

### Fix: add `fetchFullFileList()` to `lib/reviews/diff.ts`

The existing `fetchPRDiff()` in `lib/reviews/diff.ts:17` already calls `octokit.rest.pulls.listFiles()` but caps at `maxFiles` (150) and couples the file list to diff fetching. We need a separate lightweight function that returns the **full** file list for gating/filters without fetching diff content.

```typescript
// Add to lib/reviews/diff.ts

/**
 * Fetch the complete list of changed file paths for a PR.
 * Paginates through all pages — no cap. Used for filter evaluation
 * and scoped guidelines, NOT for prompt rendering.
 *
 * Uses the same GitHub API as fetchPRDiff (pulls.listFiles) but:
 * - No maxFiles cap
 * - Returns only file paths (no patch content)
 * - Paginated to completion
 */
export async function fetchFullFileList(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  const files: string[] = [];
  let page = 1;
  while (true) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner, repo, pull_number: prNumber, per_page: 100, page,
    });
    if (data.length === 0) break;
    files.push(...data.map((f) => f.filename));
    if (data.length < 100) break;
    page++;
  }
  return files;
}
```

**Integration in `pr-review.ts`** — call this early, before step 3 (filters):

```typescript
// Before step 3 (filters), after loading automation + session:
const { fetchFullFileList } = await import("@/lib/reviews/diff");
const octokit = await getReviewOctokit(installationId);
const allChangedFiles = await fetchFullFileList(octokit, event.owner, event.repo, event.prNumber);

// Step 3: apply filters with full file list
const filterResult = shouldReviewPR(event, config, allChangedFiles);

// Later, when loading guidelines:
const guidelines = await loadRepoGuidelines(octokit, event.owner, event.repo, event.baseRef, allChangedFiles);
```

The existing `fetchPRDiff()` call (used for prompt assembly) stays as-is with its `maxFiles` cap.

## Progress

### Phase 1: Repo-Defined Instructions + Filters

- [ ] Add `fetchFullFileList()` to `lib/reviews/diff.ts`
- [ ] Fix bug: call `fetchFullFileList()` before filters in `pr-review.ts`
- [ ] Fix bug: pass full file list to `shouldReviewPR()` and `loadRepoGuidelines()`
- [ ] Extract `fetchFileContent()` from `lib/reviews/guidelines.ts` as shared utility
- [ ] Create `lib/reviews/repo-config.ts`:
  - `RepoReviewDefinitionSchema` (Zod schema — YAML keys normalized to camelCase at parse)
  - `RepoReviewDefinition` and `ResolvedReviewConfig` types
  - `RepoConfigResult` discriminated union (found | not_found | invalid | multiple | error)
  - `loadRepoReviewConfig(octokit, owner, repo, ref)` — fetch from `event.baseRef` (branch name)
  - `mergeWithConnector(definition, automation)` → `ResolvedReviewConfig`
  - `normalizeKeys()` — recursive kebab-case → camelCase
- [ ] Add `js-yaml` + `@types/js-yaml` to `package.json`
- [ ] Modify `lib/orchestration/pr-review.ts`:
  - Call `loadRepoReviewConfig()` with `event.baseRef` (branch name, not `headSha`)
  - Handle all `RepoConfigResult` statuses via switch (see integration snippet below)
  - For `invalid`/`multiple`/`error`: call `failCheck()` from `lib/reviews/github.ts:66` with specific error message, then release lock and return early
  - For `found`: merge with connector via `mergeWithConnector()`
  - Use `effectiveConfig.reviewConfig` for filters, prompt, and classification
- [ ] Ensure config errors surface in GitHub check (see error propagation section below)
- [ ] Write `docs/features/code-reviews.md` (user-facing feature doc)
- [ ] Write unit tests for `repo-config.ts` (parse, validate, merge, all outcome matrix scenarios)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes

### Phase 2: Multi-Review Fan-Out (deferred)

Requires a lifecycle spec before implementation, covering:
- Fan-out ownership: where N per-definition runs/checks are created
- `definitionSlug` rules: derived from filename (not `name`); rename = new session
- Scope key: `github-pr:<repoId>:<prNumber>:<defSlug>` with legacy fallback
- PR-close cleanup: iterate all definition-scoped sessions
- Queued replay: per-definition queue
- Manual `/review`: reruns all; `/review <name>` targets one
- Stale comments: include definition name in header for disambiguation
- Check names: `"Polaris: <name>"` per definition; validate uniqueness
- Resource cap: max 5 YAML files per repo

Schema change: add `definitionSlug` (nullable) to `automationRuns` via `drizzle-kit generate`.

### Phase 3: Runtime Overrides + Credential Binding (deferred)

- YAML fields: `agent`, `model`, `effort`, `credential`
- Credential resolution: provider-aware (derive provider from `agent` field)
- UI sync: `/api/automations/[id]/repo-configs` endpoint
- Validation: GitHub check on PRs that modify `.polaris/reviews/`

### Onboarding Flow (deferred — separate exec plan)

- During onboarding, after API keys + repo configured, ask if user wants code reviews
- Show agent/model/effort/credential selection (recommend Codex + gpt-5.4 + xhigh)
- Create connector automation in DB
- Create PR in user's repo with `.polaris/reviews/default.yaml` containing recommended prompt
- User reviews, modifies, merges → reviews start on next PR event

**Recommended prompt source:** `PR_REVIEW_PROMPT` in `app/api/onboarding/complete/route.ts:12` (~240 lines). This is the current hardcoded review prompt set as `customPrompt` during onboarding. In Phase 1, this exact prompt becomes the `instructions` value in the seeded `default.yaml`. The onboarding route should be updated to create a PR with this file instead of (or in addition to) storing it as `customPrompt` on the automation.

## Implementation Detail

### New files

| File | Purpose |
|------|---------|
| `lib/reviews/repo-config.ts` | Zod schema, discriminated result type, GitHub fetch, YAML parse, key normalization, merge with connector |
| `docs/features/code-reviews.md` | User-facing feature doc |
| `tests/unit/reviews/repo-config.test.ts` | Unit tests for parse/validate/merge/all outcome matrix scenarios |

### Modified files

| File | Changes |
|------|---------|
| `lib/reviews/diff.ts` | Add `fetchFullFileList()` — full paginated file list for filters/guidelines |
| `lib/reviews/guidelines.ts` | Extract `fetchFileContent()` as named export (currently private, line 72) |
| `lib/orchestration/pr-review.ts` | Bug fixes (full file list before filters, scoped guidelines), repo config discovery from `event.baseRef`, discriminated result handling, config error → `failCheck()` |
| `package.json` | Add `js-yaml`, `@types/js-yaml` |

### Files NOT modified

| File | Why |
|------|-----|
| `lib/reviews/prompt-builder.ts` | No changes — user instructions flow through existing `customPrompt` slot (section 3) |
| `lib/reviews/types.ts` | `PRReviewConfig` unchanged — `RepoReviewDefinition` is a separate type in `repo-config.ts` |
| `lib/routing/trigger-router.ts` | No changes needed — see error propagation section below |
| `lib/automations/schema.ts` | No schema changes in Phase 1 |

### New types (`lib/reviews/repo-config.ts`)

```typescript
import { z } from "zod";
import type { PRReviewConfig } from "./types";
import type { AgentType, ModelParams } from "@/lib/sandbox-agent/types";

// Zod schema — YAML keys normalized to camelCase at parse boundary
export const RepoReviewDefinitionSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().optional(),
  filters: z.object({
    branches: z.array(z.string()).optional(),
    ignorePaths: z.array(z.string()).optional(),
    skipDrafts: z.boolean().optional(),
    skipBots: z.boolean().optional(),
    skipLabels: z.array(z.string()).optional(),
  }).optional(),
  fileClassification: z.object({
    production: z.array(z.string()),
    relaxed: z.array(z.string()),
  }).optional(),
});

export type RepoReviewDefinition = z.infer<typeof RepoReviewDefinitionSchema>;

// Discriminated result from config loading
export type RepoConfigResult =
  | { status: "found"; definition: RepoReviewDefinition; file: string }
  | { status: "not_found" }
  | { status: "invalid"; file: string; error: string }
  | { status: "multiple"; files: string[] }
  | { status: "error"; error: string };

// Merged result: YAML + connector defaults, shaped for existing call sites
export interface ResolvedReviewConfig {
  definition: RepoReviewDefinition;
  // Merged PRReviewConfig for existing call sites (shouldReviewPR, buildReviewPrompt, classifyFiles):
  reviewConfig: PRReviewConfig;
  // Runtime config from connector (unchanged):
  agentType: AgentType;
  model: string;
  modelParams: ModelParams;
  credentialRef: { secretId?: string; keyPoolId?: string };
}
```

### Key functions (`lib/reviews/repo-config.ts`)

```typescript
/**
 * Fetch and parse .polaris/reviews/ from repo via GitHub Contents API.
 * Reads from the BASE BRANCH (event.baseRef), not the PR head.
 *
 * @param ref - Branch name (e.g. "main"), NOT a commit SHA.
 *   Branch name resolves to the branch tip, so config changes
 *   merged after the PR was opened still take effect.
 */
export async function loadRepoReviewConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
): Promise<RepoConfigResult>

/**
 * Merge a YAML definition with connector automation defaults.
 * Returns a shape that includes a PRReviewConfig for existing call sites.
 *
 * Merge rules:
 * - YAML `instructions` → replaces `customPrompt`
 * - YAML `filters.*` → each present field replaces; omitted inherits
 * - YAML `fileClassification` → replaces entirely if present
 * - Runtime config (agentType, model, credentials) always from connector
 */
export function mergeWithConnector(
  definition: RepoReviewDefinition,
  automation: {
    prReviewConfig: PRReviewConfig | null;
    agentType: string | null;
    model: string | null;
    modelParams: ModelParams | null;
    agentSecretId: string | null;
    keyPoolId: string | null;
  },
): ResolvedReviewConfig
```

### YAML key normalization

YAML uses kebab-case for readability (`ignore-paths`, `skip-drafts`, `file-classification`). At the parse boundary, before Zod validation, keys are normalized to camelCase:

```typescript
/**
 * Recursively convert kebab-case keys to camelCase.
 * "ignore-paths" → "ignorePaths"
 * "file-classification" → "fileClassification"
 * "skip-drafts" → "skipDrafts"
 */
function normalizeKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(normalizeKeys);
  if (obj !== null && typeof obj === "object") {
    return Object.fromEntries(
      Object.entries(obj as Record<string, unknown>).map(([key, val]) => [
        key.replace(/-([a-z])/g, (_, c) => c.toUpperCase()),
        normalizeKeys(val),
      ]),
    );
  }
  return obj;
}
```

### Discovery flow (`loadRepoReviewConfig`)

1. Fetch `.polaris/reviews/` directory listing via `octokit.rest.repos.getContent({ owner, repo, path: ".polaris/reviews", ref })`
2. If 404 → return `{ status: "not_found" }`
3. If response is not an array (file, not directory) → return `{ status: "invalid", file: ".polaris/reviews", error: ".polaris/reviews must be a directory" }`
4. Filter entries for `.yaml`/`.yml` extension
5. If 0 matching files → return `{ status: "not_found" }`
6. If >1 matching files → return `{ status: "multiple", files: [...names] }`
7. Fetch the single file content via `fetchFileContent()` (extracted from `guidelines.ts`)
8. Parse YAML with `yaml.load()` from `js-yaml`
9. Run `normalizeKeys()` on the parsed object
10. Validate against `RepoReviewDefinitionSchema` via `.safeParse()`
11. If parse or validation fails → return `{ status: "invalid", file, error: formatted message }`
12. Return `{ status: "found", definition: parsed, file }`

Wrap the entire function in try/catch for unexpected GitHub API errors → `{ status: "error", error: message }`.

**Important:** Do NOT reuse the catch-all `error => null` pattern from `guidelines.ts:92`. Config loading must distinguish "file missing" from "file broken."

### Error propagation: how config errors reach the GitHub check

The router (`trigger-router.ts:258-301`) already handles errors from `dispatchPrReview()`:
1. Line 276: catches any error thrown by `dispatchPrReview()`
2. Line 291-301: calls `failCheck()` with the error message on the eagerly-created check

**The fix is inside `pr-review.ts`, not the router.** Config errors should NOT throw — they should be handled inline within `dispatchPrReview()` using the existing `failCheck()` from `lib/reviews/github.ts:66`. This avoids changing the router and gives us control over the error message format.

```typescript
// Inside dispatchPrReview(), after lock acquired (line ~120), before filters (line ~124):

const repoConfigResult = await loadRepoReviewConfig(
  octokit, event.owner, event.repo, event.baseRef,
);

if (repoConfigResult.status === "invalid" ||
    repoConfigResult.status === "multiple" ||
    repoConfigResult.status === "error") {
  // Format a user-readable error message
  const errorMsg = formatConfigError(repoConfigResult);

  // Fail the GitHub check with specific diagnostics
  if (checkRunId) {
    await failCheck({
      installationId,
      owner: event.owner,
      repo: event.repo,
      checkRunId,
      error: errorMsg,
    });
  }

  // Update the automation run
  await updateAutomationRun(automationRunId, {
    status: "completed",
    summary: errorMsg,
    completedAt: new Date(),
  });

  // Release lock and return (don't throw — the check already shows the error)
  await releaseAutomationSessionLock({ automationSessionId, jobId: automationRunId });
  handedOff = true;
  return { jobId: "" };
}
```

Where `formatConfigError()` produces messages like:
- `"Review config error: .polaris/reviews/default.yaml has invalid YAML — unexpected token at line 5"`
- `"Review config error: .polaris/reviews/default.yaml failed validation — 'name' is required"`
- `"Review config error: Multiple review definitions found in .polaris/reviews/ (default.yaml, security.yaml). Only one is supported in the current version."`
- `"Review config error: Failed to load .polaris/reviews/ — GitHub API rate limit exceeded"`

**Why this works without changing `trigger-router.ts`:** The config error is handled and the check is failed *inside* `dispatchPrReview()`. The function returns `{ jobId: "" }` cleanly — the router never hits its catch block. The check already shows the specific error, not the generic "Failed to start review task."

### Integration in `pr-review.ts` (full picture)

```typescript
// After loading automation (existing line ~67):
const connectorConfig = (automation.prReviewConfig ?? {}) as PRReviewConfig;

// NEW: fetch full file list for filters + guidelines (before step 3)
const { fetchFullFileList } = await import("@/lib/reviews/diff");
const allChangedFiles = await fetchFullFileList(octokit, event.owner, event.repo, event.prNumber);

// NEW: load repo-level config from BASE branch
const { loadRepoReviewConfig, mergeWithConnector } = await import("@/lib/reviews/repo-config");
const repoConfigResult = await loadRepoReviewConfig(octokit, event.owner, event.repo, event.baseRef);

// Handle config loading result
let effectiveConfig = connectorConfig;
if (repoConfigResult.status === "found") {
  const resolved = mergeWithConnector(repoConfigResult.definition, automation);
  effectiveConfig = resolved.reviewConfig;
} else if (repoConfigResult.status !== "not_found") {
  // invalid | multiple | error → fail check with diagnostics, release lock, return
  // (see error propagation section above)
}

// Step 3: apply filters with FULL file list (bug fix)
const filterResult = shouldReviewPR(event, effectiveConfig, allChangedFiles);

// Later: load guidelines with full file list (bug fix)
const guidelines = await loadRepoGuidelines(octokit, event.owner, event.repo, event.baseRef, allChangedFiles);

// Build prompt — effectiveConfig.customPrompt now contains YAML instructions if present
const prompt = buildReviewPrompt({
  ...existingInput,
  config: effectiveConfig,
  guidelines,
});
```

## Done When

- [ ] `.polaris/reviews/default.yaml` on the base branch is discovered and its `instructions` appear in the review prompt
- [ ] Review posts correctly with YAML-defined instructions
- [ ] YAML-defined filters (`branches`, `skip-drafts`, `skip-bots`, `skip-labels`, `ignore-paths`) affect review behavior
- [ ] YAML-defined `file-classification` overrides connector's classification
- [ ] Second YAML file → GitHub check fails with clear "multiple definitions" error and specific file names
- [ ] Missing `.polaris/reviews/` → connector config used unchanged (backward compat)
- [ ] Invalid YAML → GitHub check fails with parse error diagnostics (NOT silent fallback)
- [ ] Config read from base branch (`event.baseRef`), not PR head — PR modifying `.polaris/reviews/` is reviewed under current rules
- [ ] Changed-file bug fixed: full file list used for `pathFilter` and scoped `AGENTS.md`
- [ ] Merge semantics work: YAML `instructions` replaces `customPrompt`, YAML `filters.skipBots: false` overrides connector, omitted fields inherit
- [ ] Unit tests cover: valid YAML parse, invalid YAML, multiple files, merge semantics (see merge example above), empty instructions, all outcome matrix scenarios, `normalizeKeys()` edge cases
- [ ] `docs/features/code-reviews.md` written and accurate
- [ ] `pnpm typecheck` passes
- [ ] `pnpm test` passes
