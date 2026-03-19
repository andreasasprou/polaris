import { describe, it, expect } from "vitest";
import { normalizePREvent } from "@/lib/reviews/github-events";

// ── Factories for GitHub webhook payloads ──

function makePullRequestPayload(overrides?: {
  pull_request?: Record<string, unknown>;
  repository?: Record<string, unknown>;
  sender?: Record<string, unknown>;
}) {
  return {
    pull_request: {
      number: 42,
      html_url: "https://github.com/test-org/test-repo/pull/42",
      state: "open",
      draft: false,
      title: "Add feature",
      body: "PR description",
      labels: [{ name: "enhancement" }],
      head: { ref: "feature-branch", sha: "head-sha-123" },
      base: { ref: "main", sha: "base-sha-456" },
      ...overrides?.pull_request,
    },
    repository: {
      name: "test-repo",
      owner: { login: "test-org" },
      ...overrides?.repository,
    },
    sender: {
      login: "developer",
      type: "User",
      ...overrides?.sender,
    },
  };
}

function makeIssueCommentPayload(overrides?: {
  issue?: Record<string, unknown>;
  comment?: Record<string, unknown>;
  repository?: Record<string, unknown>;
  sender?: Record<string, unknown>;
}) {
  return {
    issue: {
      number: 42,
      html_url: "https://github.com/test-org/test-repo/pull/42",
      state: "open",
      title: "Add feature",
      body: "PR description",
      labels: [{ name: "bug" }],
      pull_request: { url: "https://api.github.com/repos/test-org/test-repo/pulls/42" },
      ...overrides?.issue,
    },
    comment: {
      id: 12345,
      body: "/review",
      ...overrides?.comment,
    },
    repository: {
      name: "test-repo",
      owner: { login: "test-org" },
      ...overrides?.repository,
    },
    sender: {
      login: "reviewer",
      type: "User",
      ...overrides?.sender,
    },
  };
}

describe("normalizePREvent", () => {
  // ── pull_request events ──

  describe("pull_request event", () => {
    it("extracts all fields correctly", () => {
      const payload = makePullRequestPayload();
      const result = normalizePREvent("pull_request", "opened", payload, 999);

      expect(result).not.toBeNull();
      expect(result!.eventType).toBe("pull_request");
      expect(result!.action).toBe("opened");
      expect(result!.installationId).toBe(999);
      expect(result!.owner).toBe("test-org");
      expect(result!.repo).toBe("test-repo");
      expect(result!.prNumber).toBe(42);
      expect(result!.prUrl).toBe("https://github.com/test-org/test-repo/pull/42");
      expect(result!.isOpen).toBe(true);
      expect(result!.isDraft).toBe(false);
      expect(result!.senderLogin).toBe("developer");
      expect(result!.senderType).toBe("User");
      expect(result!.senderIsBot).toBe(false);
      expect(result!.labels).toEqual(["enhancement"]);
      expect(result!.baseRef).toBe("main");
      expect(result!.baseSha).toBe("base-sha-456");
      expect(result!.headRef).toBe("feature-branch");
      expect(result!.headSha).toBe("head-sha-123");
      expect(result!.title).toBe("Add feature");
      expect(result!.body).toBe("PR description");
    });

    it("detects bot senders", () => {
      const payload = makePullRequestPayload({
        sender: { login: "dependabot[bot]", type: "Bot" },
      });
      const result = normalizePREvent("pull_request", "opened", payload, 1);

      expect(result!.senderIsBot).toBe(true);
      expect(result!.senderType).toBe("Bot");
    });

    it("detects draft PRs", () => {
      const payload = makePullRequestPayload({
        pull_request: { draft: true },
      });
      const result = normalizePREvent("pull_request", "opened", payload, 1);

      expect(result!.isDraft).toBe(true);
    });

    it("detects closed PRs", () => {
      const payload = makePullRequestPayload({
        pull_request: { state: "closed" },
      });
      const result = normalizePREvent("pull_request", "closed", payload, 1);

      expect(result!.isOpen).toBe(false);
    });

    it("uses 'unknown' action when action is undefined", () => {
      const payload = makePullRequestPayload();
      const result = normalizePREvent("pull_request", undefined, payload, 1);
      expect(result!.action).toBe("unknown");
    });

    it("returns null when pull_request key is missing from payload", () => {
      const result = normalizePREvent("pull_request", "opened", {}, 1);
      expect(result).toBeNull();
    });
  });

  // ── issue_comment events ──

  describe("issue_comment event", () => {
    it("returns event with manualCommand for /review comment", () => {
      const payload = makeIssueCommentPayload();
      const result = normalizePREvent("issue_comment", "created", payload, 999);

      expect(result).not.toBeNull();
      expect(result!.eventType).toBe("issue_comment");
      expect(result!.action).toBe("created");
      expect(result!.installationId).toBe(999);
      expect(result!.owner).toBe("test-org");
      expect(result!.repo).toBe("test-repo");
      expect(result!.prNumber).toBe(42);
      expect(result!.senderLogin).toBe("reviewer");
      expect(result!.manualCommand).toEqual({ mode: "incremental" });
      expect(result!.commentId).toBe("12345");
      expect(result!.commentBody).toBe("/review");
    });

    it("returns event with full mode for /review full", () => {
      const payload = makeIssueCommentPayload({
        comment: { id: 100, body: "/review full" },
      });
      const result = normalizePREvent("issue_comment", "created", payload, 1);

      expect(result).not.toBeNull();
      expect(result!.manualCommand).toEqual({ mode: "full" });
    });

    it("returns null for comment without /review command", () => {
      const payload = makeIssueCommentPayload({
        comment: { id: 100, body: "Looks good to me!" },
      });
      const result = normalizePREvent("issue_comment", "created", payload, 1);
      expect(result).toBeNull();
    });

    it("returns null for non-PR issue comment", () => {
      const payload = makeIssueCommentPayload({
        issue: {
          number: 10,
          html_url: "https://github.com/test-org/test-repo/issues/10",
          state: "open",
          title: "Bug report",
          body: "Something broken",
          labels: [],
          // Explicitly unset pull_request — this is an issue, not a PR
          pull_request: undefined,
        },
      });
      const result = normalizePREvent("issue_comment", "created", payload, 1);
      expect(result).toBeNull();
    });

    it("returns null for non-created action", () => {
      const payload = makeIssueCommentPayload();
      const result = normalizePREvent("issue_comment", "edited", payload, 1);
      expect(result).toBeNull();
    });

    it("returns null for deleted action", () => {
      const payload = makeIssueCommentPayload();
      const result = normalizePREvent("issue_comment", "deleted", payload, 1);
      expect(result).toBeNull();
    });
  });

  // ── Unknown event types ──

  describe("unknown event types", () => {
    it("returns null for push event", () => {
      const result = normalizePREvent("push", undefined, {}, 1);
      expect(result).toBeNull();
    });

    it("returns null for release event", () => {
      const result = normalizePREvent("release", "published", {}, 1);
      expect(result).toBeNull();
    });

    it("returns null for empty event type", () => {
      const result = normalizePREvent("", undefined, {}, 1);
      expect(result).toBeNull();
    });
  });
});
