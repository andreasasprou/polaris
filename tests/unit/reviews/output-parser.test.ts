import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "@/lib/reviews/output-parser";

function makeAgentOutput(opts?: {
  verdict?: string;
  summary?: string;
  body?: string;
  severityCounts?: Record<string, number>;
  resolvedIssueIds?: string[];
  reviewState?: Record<string, unknown>;
}): string {
  const verdict = opts?.verdict ?? "APPROVE";
  const body =
    opts?.body ??
    `## ✅ Polaris Review #1: ${verdict}\n\nLooks good overall.\n\n<sub>Polaris Review #1 · Automated by Polaris</sub>`;

  const metadata = {
    verdict,
    summary: opts?.summary ?? "Looks good overall",
    severityCounts: opts?.severityCounts ?? { P0: 0, P1: 0, P2: 0 },
    resolvedIssueIds: opts?.resolvedIssueIds ?? [],
    reviewState: opts?.reviewState ?? {
      lastReviewedSha: "abc1234",
      openIssues: [],
      resolvedIssues: [],
      reviewCount: 1,
    },
  };

  return `${body}\n\n<!-- polaris:metadata -->\n\`\`\`json\n${JSON.stringify(metadata, null, 2)}\n\`\`\``;
}

describe("parseReviewOutput", () => {
  it("extracts comment body and metadata from well-formed output", () => {
    const output = makeAgentOutput();
    const result = parseReviewOutput(output);

    expect(result).not.toBeNull();
    expect(result!.commentBody).toContain("Polaris Review #1");
    expect(result!.commentBody).not.toContain("polaris:metadata");
    expect(result!.metadata.verdict).toBe("APPROVE");
    expect(result!.metadata.summary).toBe("Looks good overall");
    expect(result!.metadata.severityCounts).toEqual({ P0: 0, P1: 0, P2: 0 });
    expect(result!.metadata.reviewState.lastReviewedSha).toBe("abc1234");
    expect(result!.metadata.reviewState.reviewCount).toBe(1);
  });

  it("parses BLOCK verdict", () => {
    const result = parseReviewOutput(makeAgentOutput({ verdict: "BLOCK" }));
    expect(result!.metadata.verdict).toBe("BLOCK");
  });

  it("parses ATTENTION verdict", () => {
    const result = parseReviewOutput(makeAgentOutput({ verdict: "ATTENTION" }));
    expect(result!.metadata.verdict).toBe("ATTENTION");
  });

  it("extracts resolvedIssueIds", () => {
    const result = parseReviewOutput(makeAgentOutput({ resolvedIssueIds: ["old-1", "old-2"] }));
    expect(result!.metadata.resolvedIssueIds).toEqual(["old-1", "old-2"]);
  });

  it("extracts reviewState with openIssues and resolvedIssues", () => {
    const result = parseReviewOutput(makeAgentOutput({
      reviewState: {
        lastReviewedSha: "def456",
        openIssues: [
          { id: "f1", file: "src/auth.ts", severity: "P0", summary: "XSS bug" },
        ],
        resolvedIssues: [
          { id: "old-1", file: "src/old.ts", summary: "Fixed", resolvedInReview: 2 },
        ],
        reviewCount: 3,
      },
    }));

    expect(result!.metadata.reviewState.openIssues).toHaveLength(1);
    expect(result!.metadata.reviewState.openIssues[0]).toMatchObject({
      id: "f1", file: "src/auth.ts", severity: "P0",
    });
    expect(result!.metadata.reviewState.resolvedIssues).toHaveLength(1);
    expect(result!.metadata.reviewState.reviewCount).toBe(3);
  });

  it("strips metadata block from comment body", () => {
    const result = parseReviewOutput(makeAgentOutput({
      body: "## ✅ Review\n\nAll good.\n\n<sub>Footer</sub>",
    }));

    expect(result!.commentBody).toBe("## ✅ Review\n\nAll good.\n\n<sub>Footer</sub>");
    expect(result!.commentBody).not.toContain("polaris:metadata");
    expect(result!.commentBody).not.toContain('"verdict"');
  });

  it("uses last marker when multiple exist", () => {
    const body = "## Review\n\nText mentioning <!-- polaris:metadata --> in prose.";
    const result = parseReviewOutput(makeAgentOutput({ body, verdict: "BLOCK" }));
    expect(result!.metadata.verdict).toBe("BLOCK");
  });

  it("returns null for output without marker", () => {
    expect(parseReviewOutput("Just some text without any marker.")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseReviewOutput("")).toBeNull();
  });

  it("returns null for malformed JSON after marker", () => {
    const output = `## Review\n\n<!-- polaris:metadata -->\n\`\`\`json\n{invalid}\n\`\`\``;
    expect(parseReviewOutput(output)).toBeNull();
  });

  it("returns null for valid JSON that doesn't match schema", () => {
    const output = `## Review\n\n<!-- polaris:metadata -->\n\`\`\`json\n{"foo": "bar"}\n\`\`\``;
    expect(parseReviewOutput(output)).toBeNull();
  });

  it("returns null when marker exists but no JSON block follows", () => {
    const output = `## Review\n\n<!-- polaris:metadata -->\nno json here`;
    expect(parseReviewOutput(output)).toBeNull();
  });
});
