import type { ParsedReviewOutput, ReviewVerdict } from "./types";

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  BLOCK: "🚫",
  ATTENTION: "⚠️",
  APPROVE: "✅",
};

const SEVERITY_EMOJI: Record<string, string> = {
  P0: "🔴",
  P1: "🟡",
  P2: "🔵",
};

/**
 * Render a structured PR review comment in markdown.
 */
export function renderReviewComment(
  parsed: ParsedReviewOutput,
  reviewSequence: number,
): string {
  const sections: string[] = [];

  // Header
  const emoji = VERDICT_EMOJI[parsed.verdict];
  sections.push(
    `## ${emoji} Polaris Review #${reviewSequence}: ${parsed.verdict}`,
  );

  // Summary
  sections.push(parsed.summary);

  // Severity counts
  const counts = parsed.severityCounts;
  if (counts.P0 + counts.P1 + counts.P2 > 0) {
    sections.push(
      `**Findings:** ${SEVERITY_EMOJI.P0} ${counts.P0} P0 · ${SEVERITY_EMOJI.P1} ${counts.P1} P1 · ${SEVERITY_EMOJI.P2} ${counts.P2} P2`,
    );
  }

  // Findings
  if (parsed.findings.length > 0) {
    sections.push("### Findings\n");
    for (const finding of parsed.findings) {
      const sev = SEVERITY_EMOJI[finding.severity] ?? "";
      sections.push(
        `#### ${sev} [${finding.severity}] ${finding.title}\n` +
          `**File:** \`${finding.file}\` · **Category:** ${finding.category}\n\n` +
          finding.body,
      );
    }
  }

  // Resolved issues
  if (parsed.resolvedIssueIds.length > 0) {
    sections.push(
      `### Resolved Issues\n\n` +
        parsed.resolvedIssueIds
          .map((id) => `- ~~${id}~~ ✅`)
          .join("\n"),
    );
  }

  // Footer
  sections.push(
    `\n<sub>Polaris Review #${reviewSequence} · Automated by [Polaris](https://github.com/apps/polaris-review)</sub>`,
  );

  return sections.join("\n\n");
}

/**
 * Render a "stale" wrapper around a previous comment body.
 * Used to collapse superseded reviews.
 */
export function renderStaleComment(
  originalBody: string,
  supersededBySequence: number,
): string {
  return (
    `> **Superseded** — See Review #${supersededBySequence} for the latest review.\n\n` +
    `<details><summary>Previous review (collapsed)</summary>\n\n` +
    originalBody +
    `\n\n</details>`
  );
}
