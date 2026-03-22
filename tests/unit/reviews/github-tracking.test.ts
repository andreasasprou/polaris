import { beforeEach, describe, expect, it, vi } from "vitest";

const octokit = {
  rest: {
    pulls: {
      listCommentsForReview: vi.fn(),
      listReviews: vi.fn(),
    },
  },
  graphql: vi.fn(),
};

vi.mock("@/lib/integrations/github", () => ({
  getInstallationOctokitById: vi.fn().mockResolvedValue(octokit),
}));

vi.mock("@/lib/evlog", () => ({
  useLogger: vi.fn().mockReturnValue({ set: vi.fn(), error: vi.fn() }),
}));

describe("review tracking helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("paginates review comments when capturing tracked inline threads", async () => {
    const { fetchTrackedInlineThreadsForReview } = await import("@/lib/reviews/github");

    octokit.rest.pulls.listCommentsForReview
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          pull_request_review_id: 900,
          in_reply_to_id: null,
          path: `src/file-${index + 1}.ts`,
          line: index + 1,
          start_line: null,
          original_line: index + 1,
          original_start_line: null,
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 101,
            pull_request_review_id: 900,
            in_reply_to_id: null,
            path: "src/file-101.ts",
            line: 101,
            start_line: null,
            original_line: 101,
            original_start_line: null,
          },
        ],
      });

    octokit.graphql
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: Array.from({ length: 100 }, (_, index) => ({
                id: `thread-${index + 1}`,
                isResolved: false,
                path: `src/file-${index + 1}.ts`,
                line: index + 1,
                startLine: null,
                comments: {
                  nodes: [{ databaseId: index + 1, body: null }],
                },
              })),
              pageInfo: {
                hasNextPage: true,
                endCursor: "cursor-1",
              },
            },
          },
        },
      })
      .mockResolvedValueOnce({
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "thread-101",
                  isResolved: false,
                  path: "src/file-101.ts",
                  line: 101,
                  startLine: null,
                  comments: {
                    nodes: [{ databaseId: 101, body: null }],
                  },
                },
              ],
              pageInfo: {
                hasNextPage: false,
                endCursor: null,
              },
            },
          },
        },
      });

    const result = await fetchTrackedInlineThreadsForReview({
      installationId: 1,
      owner: "polaris",
      repo: "polaris",
      prNumber: 42,
      reviewId: 900,
      reviewSequence: 7,
      inlineAnchors: Array.from({ length: 101 }, (_, index) => ({
        issueId: `issue-${index + 1}`,
        file: `src/file-${index + 1}.ts`,
        line: index + 1,
        title: `Issue ${index + 1}`,
        body: "Body",
      })),
    });

    expect(octokit.rest.pulls.listCommentsForReview).toHaveBeenCalledTimes(2);
    expect(result.threads).toHaveLength(101);
    expect(result.commentMap["issue-101"]).toBe(101);
    expect(result.threads.at(-1)).toMatchObject({
      threadId: "thread-101",
      commentId: 101,
      issueId: "issue-101",
      file: "src/file-101.ts",
      line: 101,
      postedInPass: 7,
    });
  });

  it("finds inline reviews by marker across paginated review lists", async () => {
    const { findInlineReviewIdByMarker } = await import("@/lib/reviews/github");

    octokit.rest.pulls.listReviews
      .mockResolvedValueOnce({
        data: Array.from({ length: 100 }, (_, index) => ({
          id: index + 1,
          commit_id: "old-sha",
          body: "no marker here",
        })),
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 901,
            commit_id: "head-sha",
            body: "See summary\n\n<!-- polaris-inline-review:job-123 -->",
          },
        ],
      });

    const reviewId = await findInlineReviewIdByMarker({
      installationId: 1,
      owner: "polaris",
      repo: "polaris",
      prNumber: 42,
      headSha: "head-sha",
      marker: "polaris-inline-review:job-123",
    });

    expect(octokit.rest.pulls.listReviews).toHaveBeenCalledTimes(2);
    expect(reviewId).toBe(901);
  });
});
