/**
 * Inline Review Comments
 *
 * Formats InlineAnchors into GitHub review comment payloads.
 * No local diff parsing — the GitHub API validates anchors.
 * If any anchor is invalid, the entire review creation fails
 * gracefully and the summary comment (already posted) stands alone.
 */

import type { InlineAnchor } from "./types";

/**
 * Format an InlineAnchor into a GitHub review comment body.
 */
export function formatInlineCommentBody(anchor: InlineAnchor): string {
  let body = `**${anchor.title}**\n\n`;
  if (anchor.body) body += `${anchor.body}\n\n`;
  if (anchor.category) body += `*Category: ${anchor.category}*\n\n`;
  if (anchor.suggestion) {
    body += "```suggestion\n" + anchor.suggestion + "\n```\n";
  }
  return body;
}

/**
 * Build the comments array for pulls.createReview.
 *
 * Filters out invalid ranges and includes start_side for multi-line
 * comments (GitHub requires both start_line and start_side, or neither).
 */
export function buildReviewComments(anchors: InlineAnchor[]): Array<{
  path: string;
  line: number;
  start_line?: number;
  start_side?: "RIGHT";
  side: "RIGHT";
  body: string;
}> {
  return anchors
    .filter((a) => {
      if (a.startLine != null && a.startLine >= a.line) return false;
      return true;
    })
    .map((a) => ({
      path: a.file,
      line: a.line,
      ...(a.startLine != null
        ? { start_line: a.startLine, start_side: "RIGHT" as const }
        : {}),
      side: "RIGHT" as const,
      body: formatInlineCommentBody(a),
    }));
}

/**
 * Extract inline anchors from parsed metadata, then strip them
 * so they don't pollute the persisted reviewState.
 */
export function extractInlineAnchors(
  metadata: { inlineAnchors?: InlineAnchor[] },
): InlineAnchor[] {
  const anchors = metadata.inlineAnchors ?? [];
  delete (metadata as Record<string, unknown>).inlineAnchors;
  return anchors;
}
