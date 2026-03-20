import type {
  PRReviewConfig,
  ReviewState,
  RepoGuidelines,
  NormalizedPrReviewEvent,
} from "./types";
import type { FileClassification } from "./classification";

export interface BuildReviewPromptInput {
  event: NormalizedPrReviewEvent;
  files: string[];
  fileClassifications: Map<string, FileClassification>;
  guidelines: RepoGuidelines;
  config: PRReviewConfig;
  previousState: ReviewState | null;
  reviewScope: "full" | "incremental" | "since" | "reset";
  reviewSequence: number;
  fromSha?: string;
  toSha: string;
  /** Pre-fetched diff written to the sandbox filesystem */
  diffPrepared?: {
    filePath: string;
    truncated: boolean;
  };
}

/**
 * Build the review prompt that gets sent to the agent.
 *
 * The agent explores the code itself using git commands in the sandbox —
 * no diff is stuffed into the prompt. The prompt provides metadata,
 * instructions, and the output contract.
 */
export function buildReviewPrompt(input: BuildReviewPromptInput): string {
  const sections: string[] = [];

  // 1. System role + review contract
  sections.push(SYSTEM_SECTION);

  // 2. Severity definitions
  sections.push(SEVERITY_SECTION);

  // 3. Custom automation prompt
  if (input.config.customPrompt) {
    sections.push(
      `## Custom Review Instructions\n\n${input.config.customPrompt}`,
    );
  }

  // 4. Repo guidelines
  const guidelineText = formatGuidelines(input.guidelines);
  if (guidelineText) {
    sections.push(`## Repository Guidelines\n\n${guidelineText}`);
  }

  // 5. PR metadata
  sections.push(formatPRMetadata(input));

  // 6. Review scope
  sections.push(formatReviewScope(input));

  // 7. Changed files with classification
  sections.push(formatFileList(input.files, input.fileClassifications));

  // 8. Diff + exploration instructions
  if (input.diffPrepared) {
    sections.push(formatPreparedDiffInstructions(input));
  } else {
    sections.push(formatExplorationInstructions(input));
  }

  // 9. Previous state (for incremental)
  if (input.previousState && input.reviewScope !== "reset") {
    sections.push(formatPreviousState(input.previousState));
  }

  // 10. Output format contract
  sections.push(OUTPUT_FORMAT_SECTION);

  return sections.join("\n\n---\n\n");
}

// ── Static sections ──

const SYSTEM_SECTION = `## Role

You are a senior code reviewer performing a structured PR review. Your job is to identify real issues that matter — bugs, security vulnerabilities, design problems, and missing tests — while ignoring style preferences and nitpicks.

**Review contract:**
- Only raise issues you are confident about
- Every finding must reference a specific file and explain the problem concretely
- Assign severity honestly: P0 for blocking issues, P1 for important concerns, P2 for suggestions
- If the code looks good, say so — don't manufacture issues to fill a quota
- For incremental reviews, focus on NEW changes and check if previously raised issues are resolved`;

const SEVERITY_SECTION = `## Severity Levels

- **P0 (Blocking):** Bugs that will break production, security vulnerabilities, data loss risks, crashes. The PR should NOT be merged until fixed.
- **P1 (Important):** Design issues, missing error handling, performance problems, missing tests for critical paths. Should be addressed before merge.
- **P2 (Suggestion):** Code improvements, better naming, minor refactoring ideas. Nice to have but not blocking.

**File classification rules:**
- Production files get full scrutiny (all severity levels)
- Relaxed files (tests, docs, scripts) cap non-security issues at P2
- Security issues are always full severity regardless of file classification`;

const OUTPUT_FORMAT_SECTION = `## Output Format

Your response will be posted **directly** as a GitHub PR comment. Write it as the final, reader-facing review — use markdown formatting, headers, code references, and clear language.

### Required structure

1. **Header line** — Start with a header showing the verdict:
   - \`## ✅ Polaris Review #N: APPROVE\`
   - \`## ⚠️ Polaris Review #N: ATTENTION\`
   - \`## 🚫 Polaris Review #N: BLOCK\`
   where N is the review sequence number (provided in Review Scope above).

2. **Summary** — 2-3 sentences summarizing the changes and your overall assessment.

3. **Findings** (if any) — List each issue with its severity, file, and explanation. Use this format:
   \`\`\`
   #### 🔴 [P0] Title of finding
   **File:** \`path/to/file.ts\` · **Category:** Correctness

   Detailed explanation...
   \`\`\`
   Severity emoji mapping: 🔴 P0, 🟡 P1, 🔵 P2

4. **Resolved Issues** (incremental reviews only) — If previously raised issues are now fixed, list them with the original title for context: \`- ~~finding-id: Original title of the finding~~ ✅\`

5. **Footer** — End the visible comment with the review number and the head commit SHA you reviewed (from Review Scope above):
   \`<sub>Polaris Review #N · \`<head-sha-short>\` · Automated by Polaris</sub>\`

### Metadata block

After the footer, append a metadata block using this exact format:

\`\`\`\`
<!-- polaris:metadata -->
\`\`\`json
{
  "verdict": "APPROVE" | "ATTENTION" | "BLOCK",
  "summary": "1-2 sentence summary",
  "severityCounts": { "P0": 0, "P1": 0, "P2": 0 },
  "resolvedIssueIds": ["finding-id-from-previous-review"],
  "reviewState": {
    "lastReviewedSha": "<head sha>",
    "openIssues": [
      { "id": "finding-1", "file": "path/to/file.ts", "severity": "P0", "summary": "Short description" }
    ],
    "resolvedIssues": [
      { "id": "old-finding", "file": "path/to/old.ts", "summary": "Was fixed", "resolvedInReview": 2 }
    ],
    "reviewCount": <N>
  }
}
\`\`\`
\`\`\`\`

**Critical rules:**
- The metadata block MUST use the \`<!-- polaris:metadata -->\` HTML comment as its delimiter.
- The JSON must be valid and match the schema exactly.
- Do NOT duplicate finding details in the metadata — findings only appear in the markdown body above.
- \`openIssues\` must include all unresolved findings from this review.
- For incremental reviews, \`resolvedIssueIds\` must list IDs of previously raised issues that are now fixed.`;

// ── Formatting helpers ──

function formatGuidelines(guidelines: RepoGuidelines): string {
  const parts: string[] = [];

  if (guidelines.rootAgentsMd) {
    parts.push(`### AGENTS.md (root)\n\n${guidelines.rootAgentsMd}`);
  }

  for (const scoped of guidelines.scopedAgentsMd) {
    parts.push(`### ${scoped.path}\n\n${scoped.content}`);
  }

  if (guidelines.reviewGuidelinesMd) {
    parts.push(
      `### REVIEW_GUIDELINES.md\n\n${guidelines.reviewGuidelinesMd}`,
    );
  }

  return parts.join("\n\n");
}

function formatPRMetadata(input: BuildReviewPromptInput): string {
  return `## PR Metadata

- **Title:** ${input.event.title}
- **Author:** ${input.event.senderLogin}
- **Branch:** ${input.event.headRef} → ${input.event.baseRef}
- **PR:** ${input.event.prUrl}
${input.event.body ? `\n**Description:**\n${input.event.body.slice(0, 2000)}` : ""}`;
}

function formatReviewScope(input: BuildReviewPromptInput): string {
  const scopeDescriptions: Record<string, string> = {
    full: "Full review of the entire PR diff.",
    incremental: `Incremental review: only changes since commit ${input.fromSha?.slice(0, 8) ?? "unknown"}.`,
    since: `Review since commit ${input.fromSha?.slice(0, 8) ?? "unknown"}.`,
    reset: "Fresh review — ignore all previous review history.",
  };

  return `## Review Scope

**Type:** ${input.reviewScope} (Review #${input.reviewSequence})
${scopeDescriptions[input.reviewScope]}
**Reviewing:** ${input.fromSha?.slice(0, 8) ?? "start"}..${input.toSha.slice(0, 8)}`;
}

function formatFileList(
  files: string[],
  classifications: Map<string, FileClassification>,
): string {
  const lines = files.map((f) => {
    const cls = classifications.get(f) ?? "production";
    return `- ${f} [${cls}]`;
  });

  return `## Changed Files (${files.length})\n\n${lines.join("\n")}`;
}

function formatPreparedDiffInstructions(input: BuildReviewPromptInput): string {
  const { diffPrepared } = input;
  if (!diffPrepared) return "";

  const baseSha = input.event.baseSha;
  const headSha = input.toSha;
  const parts: string[] = [`## Prepared Diff`];

  parts.push(
    `The unified diff for this review has been pre-loaded at \`${diffPrepared.filePath}\`. Start by reading this file to understand the changes.`,
  );

  if (diffPrepared.truncated) {
    parts.push(
      `**Note:** The diff was truncated to fit the prompt budget. Use git commands to explore files not covered by the prepared diff.`,
    );
  }

  parts.push(
    `\n## Exploring Further`,
    `You have full access to the repository in this sandbox. Use git commands and file reads to explore surrounding context, read full files, or check commit history. Do NOT ask for permission — your tools are pre-approved.`,
  );

  // Setup commands are still needed for git exploration (repo is shallow)
  const prNumber = input.event.prNumber;
  parts.push(`### Setup — run these if you need to explore beyond the diff`);
  parts.push(
    `\`\`\`bash`,
    `# Unshallow and fetch all branches so base branch commits are available`,
    `git fetch --unshallow 2>/dev/null || git fetch origin`,
    `# Fetch the PR head (works for forks too)`,
    `git fetch origin refs/pull/${prNumber}/head`,
    `# Checkout the PR head commit so file reads reflect the PR's code`,
    `git checkout ${headSha}`,
    `\`\`\``,
  );

  parts.push(`### Useful commands`);
  parts.push(`**Important:** Always use commit SHAs, not branch names or \`origin/...\` refs (remote refs are not available).`);

  if (input.reviewScope === "incremental" && input.fromSha) {
    parts.push(
      `- \`git diff ${input.fromSha} ${headSha} -- <file>\` — diff for a specific file`,
      `- \`git log ${input.fromSha}..${headSha} --oneline\` — commits in this increment`,
    );
  } else {
    parts.push(
      `- \`git diff ${baseSha} ${headSha} -- <file>\` — diff for a specific file`,
      `- \`git log ${baseSha}..${headSha} --oneline\` — all PR commits`,
    );
  }

  parts.push(
    `- \`git show <sha>\` — view a specific commit`,
    `- Read any file directly to understand surrounding context`,
  );

  parts.push(
    `\n### Review strategy`,
    `1. Read \`${diffPrepared.filePath}\` to understand all changes`,
    `2. For each changed file, read surrounding code to understand context and catch issues the diff alone wouldn't reveal`,
    `3. Pay special attention to production-classified files`,
    `4. Check for missing tests, error handling gaps, and security issues`,
    `5. If the diff was truncated, run the git setup commands and explore the remaining files`,
  );

  return parts.join("\n");
}

function formatExplorationInstructions(input: BuildReviewPromptInput): string {
  const baseSha = input.event.baseSha;
  const headSha = input.toSha;
  const parts: string[] = [`## How to Explore the Changes`];

  parts.push(
    `You have full access to the repository in this sandbox. Use git commands and file reads to explore the changes yourself. Do NOT ask for permission — your tools are pre-approved.`,
  );

  // CRITICAL: Remote refs (origin/*) are NOT available. Use commit SHAs directly.
  // The repo is a shallow clone — must unshallow to access full diff history.
  // Use refs/pull/<pr>/head to fetch the PR head — works for both forks and same-repo PRs.
  // Never interpolate raw ref names into commands (shell injection risk via branch names).
  const prNumber = input.event.prNumber;
  parts.push(`### Setup — run these commands first`);
  parts.push(
    `\`\`\`bash`,
    `# 1. Unshallow and fetch all branches so base branch commits are available`,
    `git fetch --unshallow 2>/dev/null || git fetch origin`,
    `# 2. Fetch the PR head (works for forks too — refs/pull is always on the base repo)`,
    `git fetch origin refs/pull/${prNumber}/head`,
    `# 3. Checkout the PR head commit so file reads reflect the PR's code`,
    `git checkout ${headSha}`,
    `\`\`\``,
  );

  parts.push(`### Useful commands`);
  parts.push(`**Important:** Always use commit SHAs, not branch names or \`origin/...\` refs (remote refs are not available).`);

  if (input.reviewScope === "incremental" && input.fromSha) {
    parts.push(
      `- \`git diff ${input.fromSha} ${headSha}\` — show the incremental diff since last review`,
      `- \`git diff ${input.fromSha} ${headSha} -- <file>\` — diff for a specific file`,
      `- \`git log ${input.fromSha}..${headSha} --oneline\` — commits in this increment`,
    );
  } else {
    parts.push(
      `- \`git diff ${baseSha} ${headSha}\` — show the full PR diff`,
      `- \`git diff ${baseSha} ${headSha} -- <file>\` — diff for a specific file`,
      `- \`git log ${baseSha}..${headSha} --oneline\` — all PR commits`,
    );
  }

  parts.push(
    `- \`git show <sha>\` — view a specific commit`,
    `- \`git diff ${baseSha} ${headSha} --stat\` — summary of changes per file`,
    `- Read any file directly to understand surrounding context`,
  );

  parts.push(
    `\n### Review strategy`,
    `1. Run the setup commands above to ensure you're on the PR head and all commits are available`,
    `2. Start with \`git diff ${baseSha} ${headSha} --stat\` to understand the scope`,
    `3. Read the full diff or review file-by-file for focused analysis`,
    `4. For each changed file, read surrounding code to understand context and catch issues the diff alone wouldn't reveal`,
    `5. Pay special attention to production-classified files`,
    `6. Check for missing tests, error handling gaps, and security issues`,
  );

  return parts.join("\n");
}

function formatPreviousState(state: ReviewState): string {
  const parts: string[] = [`## Previous Review State (Review #${state.reviewCount})`];

  if (state.openIssues.length > 0) {
    parts.push("### Open Issues from Previous Review");
    for (const issue of state.openIssues) {
      parts.push(
        `- **${issue.id}** [${issue.severity}] ${issue.file}: ${issue.summary}`,
      );
    }
    parts.push(
      "\nCheck if these issues are still present. If fixed, include their IDs in resolvedIssueIds.",
    );
  }

  if (state.resolvedIssues.length > 0) {
    parts.push(
      `\n*${state.resolvedIssues.length} issues resolved in previous reviews.*`,
    );
  }

  return parts.join("\n");
}
