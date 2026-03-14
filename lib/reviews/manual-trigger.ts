import type { ManualReviewCommand } from "./types";

/**
 * Parse a PR comment body for a /review command.
 * Returns null if the comment is not a review command.
 *
 * Supported formats:
 *   /review              → incremental (default)
 *   /review full         → full re-review
 *   /review reset        → reset session, fresh start
 *   /review since <sha>  → review since specific commit
 *   /polaris-review ...  → alias
 */
export function parseManualReviewCommand(
  body: string,
): ManualReviewCommand | null {
  const trimmed = body.trim();

  // Match /review or /polaris-review at start of line
  const match = trimmed.match(
    /^\/(?:polaris-)?review(?:\s+(.*))?$/im,
  );
  if (!match) return null;

  const args = (match[1] ?? "").trim().toLowerCase();

  if (!args || args === "incremental") {
    return { mode: "incremental" };
  }

  if (args === "full") {
    return { mode: "full" };
  }

  if (args === "reset") {
    return { mode: "reset" };
  }

  const sinceMatch = args.match(/^since\s+([0-9a-f]{7,40})$/i);
  if (sinceMatch) {
    return { mode: "since", sinceSha: sinceMatch[1] };
  }

  // Unknown argument — treat as incremental
  return { mode: "incremental" };
}
