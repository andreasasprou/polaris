import { describe, it, expect } from "vitest";
import { shouldReviewPR, type FilterResult } from "@/lib/reviews/filters";
import type { NormalizedPrReviewEvent, PRReviewConfig } from "@/lib/reviews/types";

// ── Factory for a base event with sensible defaults ──

function makeEvent(overrides?: Partial<NormalizedPrReviewEvent>): NormalizedPrReviewEvent {
  return {
    eventType: "pull_request",
    action: "opened",
    installationId: 1,
    owner: "test-org",
    repo: "test-repo",
    prNumber: 42,
    prUrl: "https://github.com/test-org/test-repo/pull/42",
    isOpen: true,
    isDraft: false,
    senderLogin: "developer",
    senderType: "User",
    senderIsBot: false,
    labels: [],
    baseRef: "main",
    baseSha: "abc123",
    headRef: "feature-branch",
    headSha: "def456",
    title: "Add feature",
    body: "Description",
    ...overrides,
  };
}

function makeConfig(overrides?: Partial<PRReviewConfig>): PRReviewConfig {
  return { ...overrides };
}

describe("shouldReviewPR", () => {
  // ── Manual command always passes ──

  describe("manual command", () => {
    it("passes even for closed PRs", () => {
      const event = makeEvent({
        isOpen: false,
        manualCommand: { mode: "full" },
      });
      const result = shouldReviewPR(event, makeConfig());
      expect(result).toEqual({ review: true });
    });

    it("passes even for draft PRs", () => {
      const event = makeEvent({
        isDraft: true,
        manualCommand: { mode: "incremental" },
      });
      const result = shouldReviewPR(event, makeConfig({ skipDrafts: true }));
      expect(result).toEqual({ review: true });
    });

    it("passes even when sender is a bot", () => {
      const event = makeEvent({
        senderIsBot: true,
        senderLogin: "dependabot[bot]",
        manualCommand: { mode: "incremental" },
      });
      const result = shouldReviewPR(event, makeConfig({ skipBots: true }));
      expect(result).toEqual({ review: true });
    });
  });

  // ── Closed PR ──

  describe("closed PR", () => {
    it("skips closed PRs", () => {
      const event = makeEvent({ isOpen: false });
      const result = shouldReviewPR(event, makeConfig());
      expect(result.review).toBe(false);
      expect(result.reason).toContain("closed");
    });
  });

  // ── Draft PR ──

  describe("draft PR", () => {
    it("skips draft PRs by default", () => {
      const event = makeEvent({ isDraft: true });
      const result = shouldReviewPR(event, makeConfig());
      expect(result.review).toBe(false);
      expect(result.reason).toContain("draft");
    });

    it("skips draft PRs when skipDrafts=true", () => {
      const event = makeEvent({ isDraft: true });
      const result = shouldReviewPR(event, makeConfig({ skipDrafts: true }));
      expect(result.review).toBe(false);
    });

    it("does NOT skip draft PRs when skipDrafts=false", () => {
      const event = makeEvent({ isDraft: true });
      const result = shouldReviewPR(event, makeConfig({ skipDrafts: false }));
      expect(result.review).toBe(true);
    });
  });

  // ── Bot sender ──

  describe("bot sender", () => {
    it("skips bot senders by default", () => {
      const event = makeEvent({
        senderIsBot: true,
        senderLogin: "dependabot[bot]",
      });
      const result = shouldReviewPR(event, makeConfig());
      expect(result.review).toBe(false);
      expect(result.reason).toContain("bot");
    });

    it("does NOT skip bots when skipBots=false", () => {
      const event = makeEvent({
        senderIsBot: true,
        senderLogin: "dependabot[bot]",
      });
      const result = shouldReviewPR(event, makeConfig({ skipBots: false }));
      expect(result.review).toBe(true);
    });
  });

  // ── Label skip ──

  describe("label skip", () => {
    it("skips when PR has a matching skip label", () => {
      const event = makeEvent({ labels: ["no-review", "bug"] });
      const result = shouldReviewPR(event, makeConfig({ skipLabels: ["no-review"] }));
      expect(result.review).toBe(false);
      expect(result.reason).toContain("no-review");
    });

    it("does not skip when labels don't match", () => {
      const event = makeEvent({ labels: ["enhancement"] });
      const result = shouldReviewPR(event, makeConfig({ skipLabels: ["no-review"] }));
      expect(result.review).toBe(true);
    });

    it("does not skip when skipLabels is empty", () => {
      const event = makeEvent({ labels: ["no-review"] });
      const result = shouldReviewPR(event, makeConfig({ skipLabels: [] }));
      expect(result.review).toBe(true);
    });
  });

  // ── Branch filter ──

  describe("branch filter", () => {
    it("passes when base branch is in filter list", () => {
      const event = makeEvent({ baseRef: "main" });
      const result = shouldReviewPR(event, makeConfig({ branchFilter: ["main", "develop"] }));
      expect(result.review).toBe(true);
    });

    it("skips when base branch is NOT in filter list", () => {
      const event = makeEvent({ baseRef: "staging" });
      const result = shouldReviewPR(event, makeConfig({ branchFilter: ["main", "develop"] }));
      expect(result.review).toBe(false);
      expect(result.reason).toContain("staging");
      expect(result.reason).toContain("not in filter");
    });

    it("passes when branchFilter is not set", () => {
      const event = makeEvent({ baseRef: "any-branch" });
      const result = shouldReviewPR(event, makeConfig());
      expect(result.review).toBe(true);
    });

    it("passes when branchFilter is empty", () => {
      const event = makeEvent({ baseRef: "any-branch" });
      const result = shouldReviewPR(event, makeConfig({ branchFilter: [] }));
      expect(result.review).toBe(true);
    });
  });

  // ── Path filter ──

  describe("path filter", () => {
    it("passes when changed files match pattern", () => {
      const event = makeEvent();
      const result = shouldReviewPR(
        event,
        makeConfig({ pathFilter: ["src/**/*.ts"] }),
        ["src/index.ts", "src/utils.ts"],
      );
      expect(result.review).toBe(true);
    });

    it("skips when no changed files match pattern", () => {
      const event = makeEvent();
      const result = shouldReviewPR(
        event,
        makeConfig({ pathFilter: ["src/**/*.ts"] }),
        ["docs/readme.md", "package.json"],
      );
      expect(result.review).toBe(false);
      expect(result.reason).toContain("pathFilter");
    });

    it("skips pathFilter when changedFiles is undefined (permissive)", () => {
      const event = makeEvent();
      const result = shouldReviewPR(
        event,
        makeConfig({ pathFilter: ["src/**/*.ts"] }),
        undefined,
      );
      // When changedFiles is missing, the path filter is permissively skipped
      expect(result.review).toBe(true);
    });

    it("skips pathFilter when changedFiles is empty (permissive)", () => {
      const event = makeEvent();
      const result = shouldReviewPR(
        event,
        makeConfig({ pathFilter: ["src/**/*.ts"] }),
        [],
      );
      // Empty changedFiles means the condition `changedFiles?.length` is falsy
      expect(result.review).toBe(true);
    });

    it("passes when pathFilter is not set", () => {
      const event = makeEvent();
      const result = shouldReviewPR(event, makeConfig(), ["anything.ts"]);
      expect(result.review).toBe(true);
    });
  });

  // ── All filters pass ──

  describe("all filters pass", () => {
    it("returns review: true when all conditions are met", () => {
      const event = makeEvent({
        isOpen: true,
        isDraft: false,
        senderIsBot: false,
        labels: ["enhancement"],
        baseRef: "main",
      });
      const config = makeConfig({
        skipDrafts: true,
        skipBots: true,
        skipLabels: ["no-review"],
        branchFilter: ["main"],
        pathFilter: ["src/**/*.ts"],
      });
      const result = shouldReviewPR(event, config, ["src/feature.ts"]);
      expect(result).toEqual({ review: true });
    });
  });
});
