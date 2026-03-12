import type {
  PRReviewConfig,
  ReviewState,
  RepoGuidelines,
  NormalizedPrReviewEvent,
} from "./types";
import type { FileClassification } from "./classification";

export interface BuildReviewPromptInput {
  event: NormalizedPrReviewEvent;
  diff: string;
  diffTruncated: boolean;
  files: string[];
  fileClassifications: Map<string, FileClassification>;
  guidelines: RepoGuidelines;
  config: PRReviewConfig;
  previousState: ReviewState | null;
  reviewScope: "full" | "incremental" | "since" | "reset";
  reviewSequence: number;
  fromSha?: string;
  toSha: string;
}

/**
 * Build the review prompt that gets sent to the agent.
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

  // 8. Diff
  sections.push(formatDiff(input.diff, input.diffTruncated));

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

Structure your response as follows:

1. **Summary** — A 2-3 sentence overview of the changes and your assessment
2. **Verdict** — One of: APPROVE, ATTENTION, BLOCK
   - APPROVE: No P0/P1 issues, code is ready to merge
   - ATTENTION: Has P1 issues that should be addressed
   - BLOCK: Has P0 issues that must be fixed before merge
3. **Findings** — List each issue with severity, file, and description
4. **Resolved Issues** — If this is an incremental review, list IDs of previously raised issues that are now fixed

End your response with a fenced JSON block containing the structured review state:

\`\`\`json
{
  "verdict": "APPROVE" | "ATTENTION" | "BLOCK",
  "summary": "...",
  "severityCounts": { "P0": 0, "P1": 0, "P2": 0 },
  "findings": [
    {
      "id": "finding-1",
      "severity": "P0" | "P1" | "P2",
      "category": "Correctness" | "Design" | "Security" | "Performance" | "Tests" | "Style",
      "file": "path/to/file.ts",
      "title": "Short description",
      "body": "Detailed explanation"
    }
  ],
  "resolvedIssueIds": ["finding-id-from-previous-review"],
  "reviewState": {
    "lastReviewedSha": "<head sha>",
    "openIssues": [...],
    "resolvedIssues": [...],
    "reviewCount": <N>
  }
}
\`\`\``;

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

function formatDiff(diff: string, truncated: boolean): string {
  let header = "## Diff";
  if (truncated) {
    header +=
      "\n\n> **Note:** The diff was truncated to fit the prompt budget. Some files may be omitted. Review the full PR for complete context.";
  }

  return `${header}\n\n\`\`\`diff\n${diff}\n\`\`\``;
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
