import type { ReviewSeverity, ReviewVerdict } from "./types";

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  APPROVE: "✅",
  ATTENTION: "⚠️",
  BLOCK: "🚫",
};

const SEVERITY_EMOJI: Record<ReviewSeverity, string> = {
  P0: "🔴",
  P1: "🟡",
  P2: "🔵",
};

export function formatReviewPassLabel(reviewSequence: number): string {
  return `Pass ${reviewSequence}`;
}

export function formatReviewLabel(reviewSequence: number): string {
  return `Polaris Review ${formatReviewPassLabel(reviewSequence)}`;
}

export function formatReviewHeading(
  reviewSequence: number,
  verdict: ReviewVerdict,
): string {
  return `## ${VERDICT_EMOJI[verdict]} ${formatReviewLabel(reviewSequence)}: ${verdict}`;
}

export function formatSeverityBadge(severity: ReviewSeverity): string {
  return `${SEVERITY_EMOJI[severity]} [${severity}]`;
}
