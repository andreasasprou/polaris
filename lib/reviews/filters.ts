import { minimatch } from "minimatch";
import type { NormalizedPrReviewEvent, PRReviewConfig } from "./types";

export type FilterResult = {
  review: boolean;
  reason?: string;
};

/**
 * Decide whether a PR event should trigger a review.
 * Returns { review: false, reason } if the event should be skipped.
 */
export function shouldReviewPR(
  event: NormalizedPrReviewEvent,
  config: PRReviewConfig,
  changedFiles?: string[],
): FilterResult {
  // Manual /review commands always pass filters
  if (event.manualCommand) {
    return { review: true };
  }

  // PR must be open
  if (!event.isOpen) {
    return { review: false, reason: "PR is closed" };
  }

  // Skip drafts
  if (config.skipDrafts !== false && event.isDraft) {
    return { review: false, reason: "PR is a draft" };
  }

  // Skip bots
  if (config.skipBots !== false && event.senderIsBot) {
    return { review: false, reason: `Sender is a bot: ${event.senderLogin}` };
  }

  // Skip labels
  if (config.skipLabels?.length) {
    const matchedLabel = event.labels.find((l) =>
      config.skipLabels!.includes(l),
    );
    if (matchedLabel) {
      return { review: false, reason: `Skipped by label: ${matchedLabel}` };
    }
  }

  // Branch filter
  if (config.branchFilter?.length) {
    if (!config.branchFilter.includes(event.baseRef)) {
      return {
        review: false,
        reason: `Base branch ${event.baseRef} not in filter: ${config.branchFilter.join(", ")}`,
      };
    }
  }

  // Path filter — at least one changed file must match
  if (config.pathFilter?.length && changedFiles?.length) {
    const anyMatch = changedFiles.some((file) =>
      config.pathFilter!.some((pattern) => minimatch(file, pattern)),
    );
    if (!anyMatch) {
      return {
        review: false,
        reason: "No changed files match pathFilter",
      };
    }
  }

  return { review: true };
}
