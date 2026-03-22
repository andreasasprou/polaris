import { describe, expect, it } from "vitest";
import {
  buildIssueSeverityMap,
  buildReviewComments,
  formatInlineCommentBody,
} from "@/lib/reviews/inline-comments";

describe("inline review comments", () => {
  it("includes severity emoji and priority in inline comment titles", () => {
    const body = formatInlineCommentBody(
      {
        issueId: "finding-1",
        file: "src/auth.ts",
        line: 42,
        title: "Missing null check",
        body: "The function can crash when auth is absent.",
        category: "Correctness",
      },
      "P1",
    );

    expect(body).toContain("**🟡 [P1] Missing null check**");
    expect(body).toContain("*Category: Correctness*");
  });

  it("hydrates inline comment severity from the matching open issue", () => {
    const comments = buildReviewComments(
      [
        {
          issueId: "finding-1",
          file: "src/auth.ts",
          line: 42,
          title: "Missing null check",
          body: "The function can crash when auth is absent.",
        },
      ],
      buildIssueSeverityMap([
        { id: "finding-1", severity: "P1" },
      ]),
    );

    expect(comments).toHaveLength(1);
    expect(comments[0].body).toContain("**🟡 [P1] Missing null check**");
  });
});
