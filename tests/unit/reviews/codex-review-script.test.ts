import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildIssueSeverityMap,
  formatInlineBody,
  formatReviewLabel,
  summarizePreviousState,
} = require("../../../.github/scripts/codex-review/index.cjs");

describe("codex review script helpers", () => {
  it("formats review labels as review passes", () => {
    expect(formatReviewLabel(4)).toBe("Codex Review Pass 4");
  });

  it("prefixes inline comments with severity emoji and badge", () => {
    const body = formatInlineBody(
      {
        title: "Arbitrary code execution",
        body: "Untrusted input reaches eval().",
        category: "Security",
      },
      "P1",
    );

    expect(body).toContain("**🟡 [P1] Arbitrary code execution**");
    expect(body).toContain("*Category: Security*");
  });

  it("builds a severity map from open issues", () => {
    const map = buildIssueSeverityMap({
      open_issues: [
        { id: "finding-1", severity: "P0" },
        { id: "finding-2", severity: "P2" },
      ],
    });

    expect(map.get("finding-1")).toBe("P0");
    expect(map.get("finding-2")).toBe("P2");
  });

  it("preserves lastInlineReviewId in summarized previous state", () => {
    expect(
      summarizePreviousState({
        stateCommentId: 1,
        reviewCommentId: 2,
        lastReviewedSha: "abc1234",
        reviewCount: 3,
        lastInlineReviewId: 99,
      }),
    ).toEqual({
      stateCommentId: 1,
      reviewCommentId: 2,
      lastReviewedSha: "abc1234",
      reviewCount: 3,
      lastInlineReviewId: 99,
    });
  });

  it("falls back to nested state.lastInlineReviewId when needed", () => {
    expect(
      summarizePreviousState({
        stateCommentId: 1,
        reviewCommentId: 2,
        lastReviewedSha: "abc1234",
        reviewCount: 3,
        state: { lastInlineReviewId: 77 },
      }),
    ).toMatchObject({
      lastInlineReviewId: 77,
    });
  });
});
