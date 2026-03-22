import { describe, expect, it } from "vitest";
import { buildReviewPrompt } from "@/lib/reviews/prompt-builder";

describe("review prompt builder", () => {
  it("keeps internal finding ids out of visible resolved-issues instructions", () => {
    const prompt = buildReviewPrompt({
      event: {
        eventType: "pull_request",
        action: "synchronize",
        installationId: 1,
        owner: "polaris",
        repo: "polaris",
        prNumber: 123,
        prUrl: "https://github.com/polaris/pull/123",
        isOpen: true,
        isDraft: false,
        senderLogin: "andreas",
        senderType: "User",
        senderIsBot: false,
        labels: [],
        baseRef: "main",
        baseSha: "base-sha",
        headRef: "feature",
        headSha: "head-sha",
        title: "Improve review reconciliation",
        body: null,
      },
      files: ["lib/reviews/prompt-builder.ts"],
      fileClassifications: new Map(),
      guidelines: { scopedAgentsMd: [] },
      config: {},
      previousState: {
        lastReviewedSha: "prev-sha",
        openIssues: [],
        resolvedIssues: [],
        reviewCount: 1,
      },
      reviewScope: "incremental",
      reviewSequence: 2,
      fromSha: "prev-sha",
      toSha: "head-sha",
    });

    expect(prompt).toContain("Original title of the finding ✅");
    expect(prompt).toContain("Do NOT show internal finding IDs in the visible markdown comment.");
    expect(prompt).not.toContain("~~finding-id: Original title of the finding~~ ✅");
  });
});
