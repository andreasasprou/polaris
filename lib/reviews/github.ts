import { getInstallationOctokitById } from "@/lib/integrations/github";
import type { InlineAnchor, ReviewVerdict, TrackedInlineThread } from "./types";
import { formatReviewLabel } from "./formatting";
import { useLogger } from "@/lib/evlog";

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
  } catch (err) {
    // 422 = invalid anchors, network errors, etc.
    // Non-fatal — summary comment is already posted
    const log = useLogger();
    log.set({ inlineReview: { error: err instanceof Error ? err.message : String(err) } });
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
}): Promise<boolean> {
  const octokit = await getInstallationOctokitById(input.installationId);
  try {
    await octokit.rest.pulls.dismissReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      review_id: input.reviewId,
      message: input.message,
    });
    return true;
  } catch (err) {
    const log = useLogger();
    log.set({ dismissReview: { reviewId: input.reviewId, error: err instanceof Error ? err.message : String(err) } });
    return false;
  }
}

type GithubReviewThread = {
  id: string;
  isResolved: boolean;
  path: string | null;
  line: number | null;
  startLine: number | null;
  comments: Array<{ databaseId: number; body?: string | null }>;
};

type GithubReviewThreadsPageResponse = {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          path?: string | null;
          line?: number | null;
          startLine?: number | null;
          comments: {
            nodes: Array<{
              databaseId: number;
              body?: string | null;
            }>;
          };
        }>;
        pageInfo: {
          hasNextPage: boolean;
          endCursor: string | null;
        };
      };
    };
  };
};

function buildAnchorKey(input: {
  file: string;
  line: number;
  startLine?: number | null;
}) {
  return `${input.file}::${input.line}::${input.startLine ?? ""}`;
}

function buildResolutionReplyBody(headSha: string, resolution?: string) {
  const shortSha = headSha.slice(0, 8);
  return `> **Resolved** in \`${shortSha}\`\n>\n> ${resolution || "Fixed"}`;
}

function hasResolutionReply(
  comments: Array<{ body?: string | null }>,
  headSha: string,
) {
  const marker = `**Resolved** in \`${headSha.slice(0, 8)}\``;
  return comments.some((comment) => typeof comment.body === "string" && comment.body.includes(marker));
}

async function fetchAllReviewThreads(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
}): Promise<GithubReviewThread[]> {
  const octokit = await getInstallationOctokitById(input.installationId);
  const threads: GithubReviewThread[] = [];
  let cursor: string | null = null;

  do {
    const response: GithubReviewThreadsPageResponse = await octokit.graphql(`
      query($owner: String!, $repo: String!, $pr: Int!, $cursor: String) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $pr) {
            reviewThreads(first: 100, after: $cursor) {
              nodes {
                id
                isResolved
                path
                line
                startLine
                comments(first: 20) {
                  nodes {
                    databaseId
                    body
                  }
                }
              }
              pageInfo {
                hasNextPage
                endCursor
              }
            }
          }
        }
      }
    `, {
      owner: input.owner,
      repo: input.repo,
      pr: input.prNumber,
      cursor,
    });

    const repository = response.repository;
    const reviewThreads = repository.pullRequest.reviewThreads;
    threads.push(...reviewThreads.nodes.map((thread) => ({
      id: thread.id,
      isResolved: thread.isResolved,
      path: thread.path ?? null,
      line: thread.line ?? null,
      startLine: thread.startLine ?? null,
      comments: thread.comments.nodes,
    })));

    cursor = reviewThreads.pageInfo.hasNextPage
      ? reviewThreads.pageInfo.endCursor
      : null;
  } while (cursor);

  return threads;
}

async function fetchAllReviewCommentsForReview(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: number;
}) {
  const octokit = await getInstallationOctokitById(input.installationId);
  const comments: Awaited<ReturnType<typeof octokit.rest.pulls.listCommentsForReview>>["data"] = [];
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listCommentsForReview({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      review_id: input.reviewId,
      per_page: 100,
      page,
    });
    comments.push(...response.data);
    if (response.data.length < 100) break;
    page += 1;
  }

  return comments;
}

export async function findInlineReviewIdByMarker(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  marker: string;
}): Promise<number | null> {
  const octokit = await getInstallationOctokitById(input.installationId);
  let page = 1;

  while (true) {
    const response = await octokit.rest.pulls.listReviews({
      owner: input.owner,
      repo: input.repo,
      pull_number: input.prNumber,
      per_page: 100,
      page,
    });

    for (const review of response.data) {
      if (
        review.commit_id === input.headSha &&
        typeof review.body === "string" &&
        review.body.includes(input.marker)
      ) {
        return review.id;
      }
    }

    if (response.data.length < 100) break;
    page += 1;
  }

  return null;
}

async function fetchReviewThreadState(input: {
  installationId: number;
  threadId: string;
}): Promise<GithubReviewThread | null> {
  const octokit = await getInstallationOctokitById(input.installationId);
  const { node } = await octokit.graphql<{
    node: {
      id: string;
      isResolved: boolean;
      path?: string | null;
      line?: number | null;
      startLine?: number | null;
      comments: {
        nodes: Array<{
          databaseId: number;
          body?: string | null;
        }>;
      };
    } | null;
  }>(`
    query($threadId: ID!) {
      node(id: $threadId) {
        ... on PullRequestReviewThread {
          id
          isResolved
          path
          line
          startLine
          comments(last: 20) {
            nodes {
              databaseId
              body
            }
          }
        }
      }
    }
  `, {
    threadId: input.threadId,
  });

  if (!node) return null;

  return {
    id: node.id,
    isResolved: node.isResolved,
    path: node.path ?? null,
    line: node.line ?? null,
    startLine: node.startLine ?? null,
    comments: node.comments.nodes,
  };
}

export async function fetchTrackedInlineThreadsForReview(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  reviewId: number;
  reviewSequence: number;
  inlineAnchors: InlineAnchor[];
}): Promise<{
  threads: TrackedInlineThread[];
  commentMap: Record<string, number>;
}> {
  const log = useLogger();
  const commentMap: Record<string, number> = {};

  try {
    const [reviewComments, reviewThreads] = await Promise.all([
      fetchAllReviewCommentsForReview({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
        reviewId: input.reviewId,
      }),
      fetchAllReviewThreads({
        installationId: input.installationId,
        owner: input.owner,
        repo: input.repo,
        prNumber: input.prNumber,
      }),
    ]);

    const threadsByRootCommentId = new Map<number, GithubReviewThread>();
    for (const thread of reviewThreads) {
      const rootCommentId = thread.comments[0]?.databaseId;
      if (rootCommentId) {
        threadsByRootCommentId.set(rootCommentId, thread);
      }
    }

    const anchorQueues = new Map<string, InlineAnchor[]>();
    for (const anchor of input.inlineAnchors) {
      const key = buildAnchorKey({
        file: anchor.file,
        line: anchor.line,
        startLine: anchor.startLine,
      });
      const queue = anchorQueues.get(key) ?? [];
      queue.push(anchor);
      anchorQueues.set(key, queue);
    }

    const trackedThreads: TrackedInlineThread[] = [];
    const rootReviewComments = reviewComments.filter((comment) =>
      comment.pull_request_review_id === input.reviewId && comment.in_reply_to_id == null,
    );

    for (const reviewComment of rootReviewComments) {
      const line = reviewComment.line ?? reviewComment.original_line ?? null;
      if (!reviewComment.path || line == null) continue;

      const key = buildAnchorKey({
        file: reviewComment.path,
        line,
        startLine: reviewComment.start_line ?? reviewComment.original_start_line ?? null,
      });
      const queue = anchorQueues.get(key);
      const anchor = queue?.shift();
      if (!anchor?.issueId) continue;

      commentMap[anchor.issueId] = reviewComment.id;

      const thread = threadsByRootCommentId.get(reviewComment.id);
      if (!thread?.id || !thread.path || thread.line == null) {
        log.set({
          fetchTrackedInlineThreads: {
            missingThread: reviewComment.id,
            reviewId: input.reviewId,
          },
        });
        continue;
      }

      trackedThreads.push({
        threadId: thread.id,
        commentId: reviewComment.id,
        reviewId: input.reviewId,
        issueId: anchor.issueId,
        file: thread.path,
        line: thread.line,
        ...(thread.startLine != null ? { startLine: thread.startLine } : {}),
        postedInPass: input.reviewSequence,
      });
    }

    return { threads: trackedThreads, commentMap };
  } catch (err) {
    log.set({ fetchTrackedInlineThreads: { error: err instanceof Error ? err.message : String(err) } });
    return { threads: [], commentMap };
  }
}

export async function hydrateTrackedInlineThreadsFromCommentMap(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  inlineCommentMap: Record<string, number>;
}): Promise<TrackedInlineThread[]> {
  const log = useLogger();

  try {
    const reviewThreads = await fetchAllReviewThreads({
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
    });

    const threadsByRootCommentId = new Map<number, GithubReviewThread>();
    for (const thread of reviewThreads) {
      const rootCommentId = thread.comments[0]?.databaseId;
      if (rootCommentId) {
        threadsByRootCommentId.set(rootCommentId, thread);
      }
    }

    const hydrated: TrackedInlineThread[] = [];

    for (const [issueId, commentId] of Object.entries(input.inlineCommentMap)) {
      const thread = threadsByRootCommentId.get(commentId);
      if (!thread || thread.isResolved || !thread.path || thread.line == null) continue;

      hydrated.push({
        threadId: thread.id,
        commentId,
        reviewId: null,
        issueId,
        file: thread.path,
        line: thread.line,
        ...(thread.startLine != null ? { startLine: thread.startLine } : {}),
        postedInPass: null,
      });
    }

    return hydrated;
  } catch (err) {
    log.set({ hydrateTrackedInlineThreads: { error: err instanceof Error ? err.message : String(err) } });
    return [];
  }
}

/**
 * Reply "Resolved" to inline comments for resolved issues, then auto-resolve the threads.
 */
export async function replyAndResolveInlineComments(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  resolvedIssues: Array<{ id: string; resolution?: string }>;
  inlineCommentMap: Record<string, number>;
}): Promise<{ repliedCount: number; resolvedCount: number; resolvedIssueIds: string[] }> {
  const octokit = await getInstallationOctokitById(input.installationId);
  const log = useLogger();
  let repliedCount = 0;
  const commentIdsToResolve: number[] = [];
  const issueIdByCommentId = new Map<number, string>();

  // Step 1: Reply to each resolved issue's inline comment
  for (const resolved of input.resolvedIssues) {
    const commentId = input.inlineCommentMap[resolved.id];
    if (!commentId) continue;

    try {
      const resolution = resolved.resolution || "Fixed";
      await octokit.rest.pulls.createReplyForReviewComment({
        owner: input.owner,
        repo: input.repo,
        pull_number: input.prNumber,
        comment_id: commentId,
        body: buildResolutionReplyBody(input.headSha, resolution),
      });
      commentIdsToResolve.push(commentId);
      issueIdByCommentId.set(commentId, resolved.id);
      repliedCount++;
    } catch (err) {
      log.set({ replyResolved: { commentId, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  // Step 2: Auto-resolve the threads via GraphQL
  let resolvedCount = 0;
  let resolvedIssueIds: string[] = [];
  if (commentIdsToResolve.length > 0) {
    const resolved = await resolveReviewThreads({
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
      commentIds: commentIdsToResolve,
    });
    resolvedCount = resolved.resolvedCount;
    resolvedIssueIds = resolved.resolvedCommentIds
      .map((commentId) => issueIdByCommentId.get(commentId))
      .filter((issueId): issueId is string => Boolean(issueId));
  }

  return { repliedCount, resolvedCount, resolvedIssueIds };
}

export async function resolveTrackedInlineThreads(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  headSha: string;
  threads: Array<TrackedInlineThread & { resolution?: string }>;
}): Promise<{ repliedCount: number; resolvedCount: number; resolvedThreadIds: string[] }> {
  const octokit = await getInstallationOctokitById(input.installationId);
  const log = useLogger();
  let repliedCount = 0;
  let resolvedCount = 0;
  const resolvedThreadIds: string[] = [];

  for (const thread of input.threads) {
    try {
      const state = await fetchReviewThreadState({
        installationId: input.installationId,
        threadId: thread.threadId,
      });
      if (!state) continue;

      if (state.isResolved) {
        resolvedCount++;
        resolvedThreadIds.push(thread.threadId);
        continue;
      }

      if (
        Number.isInteger(thread.commentId) &&
        thread.commentId > 0 &&
        !hasResolutionReply(state.comments, input.headSha)
      ) {
        try {
          await octokit.rest.pulls.createReplyForReviewComment({
            owner: input.owner,
            repo: input.repo,
            pull_number: input.prNumber,
            comment_id: thread.commentId,
            body: buildResolutionReplyBody(input.headSha, thread.resolution),
          });
          repliedCount++;
        } catch (err) {
          log.set({ replyResolvedTracked: { threadId: thread.threadId, error: err instanceof Error ? err.message : String(err) } });
        }
      }

      try {
        await octokit.graphql(`
          mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread { isResolved }
            }
          }
        `, { threadId: thread.threadId });
        resolvedCount++;
        resolvedThreadIds.push(thread.threadId);
      } catch (err) {
        log.set({ resolveTrackedThread: { threadId: thread.threadId, error: err instanceof Error ? err.message : String(err) } });
      }
    } catch (err) {
      log.set({ resolveTrackedThread: { threadId: thread.threadId, error: err instanceof Error ? err.message : String(err) } });
    }
  }

  return { repliedCount, resolvedCount, resolvedThreadIds };
}

/**
 * Resolve review comment threads via GraphQL.
 * Finds threads by matching comment database IDs, then resolves them.
 */
export async function resolveReviewThreads(input: {
  installationId: number;
  owner: string;
  repo: string;
  prNumber: number;
  commentIds: number[];
}): Promise<{ resolvedCount: number; resolvedCommentIds: number[] }> {
  const octokit = await getInstallationOctokitById(input.installationId);
  const resolvedCommentIds: number[] = [];

  try {
    const commentIdSet = new Set(input.commentIds);
    const reviewThreads = await fetchAllReviewThreads({
      installationId: input.installationId,
      owner: input.owner,
      repo: input.repo,
      prNumber: input.prNumber,
    });

    for (const thread of reviewThreads) {
      const firstCommentId = thread.comments[0]?.databaseId;
      if (!firstCommentId || !commentIdSet.has(firstCommentId)) continue;

      if (thread.isResolved) {
        resolvedCommentIds.push(firstCommentId);
        continue;
      }

      try {
        await octokit.graphql(`
          mutation($threadId: ID!) {
            resolveReviewThread(input: { threadId: $threadId }) {
              thread { isResolved }
            }
          }
        `, { threadId: thread.id });
        resolvedCommentIds.push(firstCommentId);
      } catch (err) {
        const log = useLogger();
        log.set({ resolveThread: { threadId: thread.id, error: err instanceof Error ? err.message : String(err) } });
      }
    }
  } catch (err) {
    const log = useLogger();
    log.set({ resolveThreads: { error: err instanceof Error ? err.message : String(err) } });
  }

  return {
    resolvedCount: resolvedCommentIds.length,
    resolvedCommentIds,
  };
}

/**
 * Get an Octokit instance for use by other review modules.
 */
export async function getReviewOctokit(installationId: number) {
  return getInstallationOctokitById(installationId);
}
