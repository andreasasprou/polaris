import { getInstallationOctokitById } from "@/lib/integrations/github";
import type { ReviewVerdict } from "./types";
import { formatReviewLabel } from "./formatting";

/**
 * Create a pending GitHub check run.
 */
export async function createPendingCheck(input: {
  installationId: number;
  owner: string;
  repo: string;
  headSha: string;
  checkName?: string;
  detailsUrl?: string;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  const { data } = await octokit.rest.checks.create({
    owner: input.owner,
    repo: input.repo,
    name: input.checkName ?? "Polaris Review",
    head_sha: input.headSha,
    status: "in_progress",
    started_at: new Date().toISOString(),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
  });
  return { checkRunId: String(data.id) };
}

/**
 * Complete a GitHub check run with the review verdict.
 */
export async function completeCheck(input: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: string;
  verdict: ReviewVerdict;
  summary: string;
  detailsUrl?: string;
}) {
  const conclusionMap: Record<ReviewVerdict, "failure" | "neutral" | "success"> = {
    BLOCK: "failure",
    ATTENTION: "neutral",
    APPROVE: "success",
  };

  const octokit = await getInstallationOctokitById(input.installationId);
  await octokit.rest.checks.update({
    owner: input.owner,
    repo: input.repo,
    check_run_id: Number(input.checkRunId),
    status: "completed",
    conclusion: conclusionMap[input.verdict],
    completed_at: new Date().toISOString(),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    output: {
      title: `Review: ${input.verdict}`,
      summary: input.summary.slice(0, 65535),
    },
  });
}

/**
 * Fail a GitHub check run (used when the review process itself fails).
 */
export async function failCheck(input: {
  installationId: number;
  owner: string;
  repo: string;
  checkRunId: string;
  error: string;
  detailsUrl?: string;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  await octokit.rest.checks.update({
    owner: input.owner,
    repo: input.repo,
    check_run_id: Number(input.checkRunId),
    status: "completed",
    conclusion: "failure",
    completed_at: new Date().toISOString(),
    ...(input.detailsUrl ? { details_url: input.detailsUrl } : {}),
    output: {
      title: "Review Failed",
      summary: input.error.slice(0, 65535),
    },
  });
}

/**
 * Post a review comment on a PR.
 */
export async function postReviewComment(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  body: string;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  const { data } = await octokit.rest.issues.createComment({
    owner: input.owner,
    repo: input.repo,
    issue_number: input.prNumber,
    body: input.body,
  });
  return { commentId: String(data.id) };
}

/**
 * Mark a previous review comment as stale.
 *
 * Fetches the original comment body, wraps it in a collapsed `<details>`
 * section, and prepends a "Superseded" banner pointing to the new review.
 */
export async function markCommentStale(input: {
  installationId: number;
  owner: string;
  repo: string;
  commentId: string;
  supersededBySequence: number;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  const commentId = Number(input.commentId);

  // Fetch existing body so we can preserve it in the collapsed section
  let previousBody = "";
  try {
    const { data } = await octokit.rest.issues.getComment({
      owner: input.owner,
      repo: input.repo,
      comment_id: commentId,
    });
    previousBody = data.body ?? "";
  } catch {
    // Best-effort — comment may have been deleted
  }

  const staleBody =
    `> **Superseded** — See ${formatReviewLabel(input.supersededBySequence)} for the latest review.\n\n` +
    (previousBody
      ? `<details><summary>Previous review (collapsed)</summary>\n\n${previousBody}\n\n</details>`
      : "");

  await octokit.rest.issues.updateComment({
    owner: input.owner,
    repo: input.repo,
    comment_id: commentId,
    body: staleBody,
  });
}

/**
 * Get the full PR data (needed for issue_comment events where we don't have PR details).
 */
export async function getPullRequest(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  const { data } = await octokit.rest.pulls.get({
    owner: input.owner,
    repo: input.repo,
    pull_number: input.prNumber,
  });
  return data;
}

/**
 * Check if a commit SHA is an ancestor of another (for incremental vs full detection).
 */
export async function isAncestor(input: {
  installationId: number;
  owner: string;
  repo: string;
  baseSha: string;
  headSha: string;
}): Promise<boolean> {
  try {
    const octokit = await getInstallationOctokitById(input.installationId);
    const { data } = await octokit.rest.repos.compareCommits({
      owner: input.owner,
      repo: input.repo,
      base: input.baseSha,
      head: input.headSha,
    });
    // "behind" = base is behind head (base is an ancestor of head) ✓
    // "identical" = same commit ✓
    // "ahead" = base is AHEAD of head (base has commits head doesn't) ✗
    //   This happens after force-push — must fall back to full review
    return data.status === "behind" || data.status === "identical";
  } catch {
    // If compare fails (e.g., force push removed the base commit), it's not an ancestor
    return false;
  }
}

/**
 * Post an inline review with COMMENT event.
 *
 * Never uses REQUEST_CHANGES — the check run is the merge-blocking mechanism.
 * This avoids stale blocking reviews in branch protection.
 *
 * Returns the review ID, or null if posting failed.
 * Non-fatal — the summary comment (posted before this) is the primary artifact.
 */
export async function postInlineReview(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  body: string;
  comments: Array<{
    path: string;
    line: number;
    start_line?: number;
    start_side?: "RIGHT";
    side: "RIGHT";
    body: string;
  }>;
}): Promise<{ reviewId: number } | null> {
  const octokit = await getInstallationOctokitById(input.installationId);
  try {
    const { data } = await octokit.rest.pulls.createReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      commit_id: input.headSha,
      body: input.body,
      event: "COMMENT",
      comments: input.comments,
    });
    return { reviewId: data.id };
  } catch {
    // 422 = invalid anchors, network errors, etc.
    // Non-fatal — summary comment is already posted
    return null;
  }
}

/**
 * Dismiss a previous inline review (best-effort).
 * Used when a new review supersedes the old one.
 * COMMENT reviews may not be dismissible — failure is silently ignored.
 */
export async function dismissReview(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: number;
  message: string;
}): Promise<void> {
  const octokit = await getInstallationOctokitById(input.installationId);
  try {
    await octokit.rest.pulls.dismissReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      review_id: input.reviewId,
      message: input.message,
    });
  } catch {
    // Best-effort — COMMENT reviews may not be dismissible
  }
}

/**
 * Get an Octokit instance for use by other review modules.
 */
export async function getReviewOctokit(installationId: number) {
  return getInstallationOctokitById(installationId);
}
