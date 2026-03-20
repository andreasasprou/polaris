import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "@/lib/reviews/output-parser";

// ── Helper: build a well-formed agent output with metadata marker ──

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
  // ── Primary: marker-based extraction ──

  describe("marker-based extraction", () => {
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
      const output = makeAgentOutput({ verdict: "BLOCK" });
      const result = parseReviewOutput(output);
      expect(result!.metadata.verdict).toBe("BLOCK");
    });

    it("parses ATTENTION verdict", () => {
      const output = makeAgentOutput({ verdict: "ATTENTION" });
      const result = parseReviewOutput(output);
      expect(result!.metadata.verdict).toBe("ATTENTION");
    });

    it("extracts resolvedIssueIds", () => {
      const output = makeAgentOutput({ resolvedIssueIds: ["old-1", "old-2"] });
      const result = parseReviewOutput(output);
      expect(result!.metadata.resolvedIssueIds).toEqual(["old-1", "old-2"]);
    });

    it("extracts reviewState with openIssues", () => {
      const output = makeAgentOutput({
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
      });
      const result = parseReviewOutput(output);

      expect(result!.metadata.reviewState.openIssues).toHaveLength(1);
      expect(result!.metadata.reviewState.openIssues[0]).toMatchObject({
        id: "f1",
        file: "src/auth.ts",
        severity: "P0",
      });
      expect(result!.metadata.reviewState.resolvedIssues).toHaveLength(1);
      expect(result!.metadata.reviewState.reviewCount).toBe(3);
    });

    it("strips metadata block from comment body", () => {
      const output = makeAgentOutput({
        body: "## ✅ Polaris Review #1: APPROVE\n\nAll good.\n\n<sub>Polaris Review #1</sub>",
      });
      const result = parseReviewOutput(output);

      expect(result!.commentBody).toBe(
        "## ✅ Polaris Review #1: APPROVE\n\nAll good.\n\n<sub>Polaris Review #1</sub>",
      );
      expect(result!.commentBody).not.toContain("polaris:metadata");
      expect(result!.commentBody).not.toContain('"verdict"');
    });

    it("uses last marker when multiple exist", () => {
      const body = "## Review\n\nSome text mentioning <!-- polaris:metadata --> in prose.";
      const output = makeAgentOutput({ body, verdict: "BLOCK" });
      const result = parseReviewOutput(output);

      // Should use the LAST marker (the real one at the end)
      expect(result).not.toBeNull();
      expect(result!.metadata.verdict).toBe("BLOCK");
    });
  });

  // ── Legacy fallback: fenced JSON with verdict key ──

  describe("legacy fallback — fenced JSON block", () => {
    function makeLegacyOutput(overrides?: Record<string, unknown>): string {
      const base = {
        verdict: "APPROVE",
        summary: "Looks good overall",
        severityCounts: { P0: 0, P1: 1, P2: 2 },
        resolvedIssueIds: ["old-1"],
        reviewState: {
          lastReviewedSha: "abc1234",
          openIssues: [
            { id: "f1", file: "src/index.ts", severity: "P1", summary: "Possible null deref" },
          ],
          resolvedIssues: [],
          reviewCount: 3,
        },
        ...overrides,
      };
      return `Here's my review:\n\n\`\`\`json\n${JSON.stringify(base, null, 2)}\n\`\`\``;
    }

    it("parses legacy fenced JSON block", () => {
      const output = makeLegacyOutput();
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.metadata.verdict).toBe("APPROVE");
      expect(result!.metadata.summary).toBe("Looks good overall");
      expect(result!.metadata.severityCounts).toEqual({ P0: 0, P1: 1, P2: 2 });
      expect(result!.metadata.resolvedIssueIds).toEqual(["old-1"]);
      expect(result!.metadata.reviewState.reviewCount).toBe(3);
    });

    it("strips JSON block from comment body", () => {
      const output = makeLegacyOutput();
      const result = parseReviewOutput(output);

      expect(result!.commentBody).toBe("Here's my review:");
      expect(result!.commentBody).not.toContain("```json");
    });

    it("parses BLOCK verdict in legacy format", () => {
      const output = makeLegacyOutput({ verdict: "BLOCK" });
      const result = parseReviewOutput(output);
      expect(result!.metadata.verdict).toBe("BLOCK");
    });

    it("parses unfenced JSON with verdict key", () => {
      const json = JSON.stringify({
        verdict: "ATTENTION",
        summary: "Some issues",
        severityCounts: { P0: 0, P1: 1, P2: 0 },
        reviewState: {
          lastReviewedSha: null,
          openIssues: [],
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `Here is the review:\n${json}\n\nEnd.`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.metadata.verdict).toBe("ATTENTION");
    });

    it("normalizes string[] openIssues to objects", () => {
      const json = JSON.stringify({
        verdict: "ATTENTION",
        summary: "Issues",
        reviewState: {
          lastReviewedSha: "def456",
          openIssues: ["f1", "f2"],
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.metadata.reviewState.openIssues).toHaveLength(2);
      expect(result!.metadata.reviewState.openIssues[0].id).toBe("f1");
      expect(result!.metadata.reviewState.openIssues[0].file).toBe("unknown");
    });
  });

  // ── Unparseable output ──

  describe("unparseable output", () => {
    it("returns null for completely irrelevant text", () => {
      expect(parseReviewOutput("Hello world, not a review.")).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseReviewOutput("")).toBeNull();
    });

    it("returns null for JSON without verdict", () => {
      const output = `\`\`\`json\n{"summary": "test", "findings": []}\n\`\`\``;
      expect(parseReviewOutput(output)).toBeNull();
    });

    it("returns null for malformed JSON after metadata marker", () => {
      const output = `## Review\n\n<!-- polaris:metadata -->\n\`\`\`json\n{invalid json}\n\`\`\``;
      expect(parseReviewOutput(output)).toBeNull();
    });
  });
});
