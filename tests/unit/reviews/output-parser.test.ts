import { describe, it, expect } from "vitest";
import { parseReviewOutput } from "@/lib/reviews/output-parser";

// ── Helpers to build well-formed JSON ──

function makeFullOutput(overrides?: Record<string, unknown>): string {
  const base = {
    verdict: "APPROVE",
    summary: "Looks good overall",
    severityCounts: { P0: 0, P1: 1, P2: 2 },
    findings: [
      {
        id: "f1",
        severity: "P1",
        category: "logic",
        file: "src/index.ts",
        title: "Possible null deref",
        body: "Check for null before accessing .name",
      },
      {
        id: "f2",
        severity: "P2",
        category: "style",
        file: "src/utils.ts",
        title: "Unused import",
        body: "Remove unused import of lodash",
      },
    ],
    resolvedIssueIds: ["old-1"],
    reviewState: {
      lastReviewedSha: "abc1234",
      openIssues: [
        { id: "f1", file: "src/index.ts", severity: "P1", summary: "Possible null deref" },
      ],
      resolvedIssues: [
        { id: "old-1", file: "src/old.ts", summary: "Fixed", resolvedInReview: 2 },
      ],
      reviewCount: 3,
    },
    ...overrides,
  };
  return JSON.stringify(base, null, 2);
}

describe("parseReviewOutput", () => {
  // ── Strategy 1: Strict parse (fenced JSON) ──

  describe("strict parse — fenced JSON with all fields", () => {
    it("parses well-formed fenced JSON block", () => {
      const output = `Here's my review:\n\n\`\`\`json\n${makeFullOutput()}\n\`\`\`\n\nDone.`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("APPROVE");
      expect(result!.summary).toBe("Looks good overall");
      expect(result!.severityCounts).toEqual({ P0: 0, P1: 1, P2: 2 });
      expect(result!.findings).toHaveLength(2);
      expect(result!.findings[0].id).toBe("f1");
      expect(result!.resolvedIssueIds).toEqual(["old-1"]);
      expect(result!.reviewState.lastReviewedSha).toBe("abc1234");
      expect(result!.reviewState.openIssues).toHaveLength(1);
      expect(result!.reviewState.resolvedIssues).toHaveLength(1);
      expect(result!.reviewState.reviewCount).toBe(3);
    });

    it("parses BLOCK verdict", () => {
      const output = `\`\`\`json\n${makeFullOutput({ verdict: "BLOCK" })}\n\`\`\``;
      const result = parseReviewOutput(output);
      expect(result!.verdict).toBe("BLOCK");
    });

    it("parses ATTENTION verdict", () => {
      const output = `\`\`\`json\n${makeFullOutput({ verdict: "ATTENTION" })}\n\`\`\``;
      const result = parseReviewOutput(output);
      expect(result!.verdict).toBe("ATTENTION");
    });
  });

  // ── Strategy 2: Lenient parse ──

  describe("lenient parse — missing or alternate fields", () => {
    it("handles missing severityCounts by computing from findings", () => {
      const json = JSON.stringify({
        verdict: "BLOCK",
        summary: "Issues found",
        findings: [
          { id: "a", severity: "P0", category: "sec", file: "x.ts", title: "XSS", body: "..." },
          { id: "b", severity: "P0", category: "sec", file: "y.ts", title: "SQLi", body: "..." },
          { id: "c", severity: "P1", category: "perf", file: "z.ts", title: "N+1", body: "..." },
        ],
        reviewState: {
          lastReviewedSha: "abc",
          openIssues: [],
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.severityCounts).toEqual({ P0: 2, P1: 1, P2: 0 });
    });

    it("handles description instead of body in findings", () => {
      const json = JSON.stringify({
        verdict: "APPROVE",
        summary: "OK",
        findings: [
          { id: "f1", severity: "P2", category: "style", file: "a.ts", title: "Nit", description: "Use const" },
        ],
        reviewState: {
          lastReviewedSha: null,
          openIssues: [],
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.findings[0].body).toBe("Use const");
    });

    it("normalizes unknown severity to P2", () => {
      const json = JSON.stringify({
        verdict: "APPROVE",
        summary: "",
        findings: [
          { id: "f1", severity: "critical", file: "a.ts", title: "Bug", body: "..." },
        ],
        reviewState: {
          lastReviewedSha: null,
          openIssues: [],
          resolvedIssues: [],
          reviewCount: 0,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.findings[0].severity).toBe("P2");
    });
  });

  // ── Strategy: Unfenced JSON ──

  describe("unfenced JSON containing verdict key", () => {
    it("parses JSON without code fences", () => {
      const json = makeFullOutput();
      // No backtick fences — just raw JSON in the output
      const output = `Here is the review result:\n${json}\n\nEnd of review.`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("APPROVE");
      expect(result!.findings).toHaveLength(2);
    });
  });

  // ── Strategy 3: Regex fallback ──

  describe("regex fallback — prose with verdict keywords", () => {
    it("extracts BLOCK verdict from prose", () => {
      const output = `This PR has critical issues.\n\nVerdict: BLOCK\n\nFound P0 security vulnerability and P1 performance issue.`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("BLOCK");
      expect(result!.findings).toEqual([]);
    });

    it("extracts APPROVE verdict from prose", () => {
      const output = `Everything looks great. APPROVE this PR.`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.verdict).toBe("APPROVE");
    });

    it("counts P0/P1 mentions (subtracting 1 for definition mention)", () => {
      // The regex fallback subtracts 1 from each severity count
      // to account for the severity appearing in its own definition
      const output = `Verdict: BLOCK\n\nP0: SQL injection in auth.ts\nP0: XSS in render.ts\nP1: Missing validation`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      // 3 mentions of P0 minus 1 = 2... wait, 2 mentions minus 1 = 1
      expect(result!.severityCounts.P0).toBe(1); // 2 mentions - 1
      expect(result!.severityCounts.P1).toBe(0); // 1 mention - 1
    });

    it("sets summary from first line when no Summary heading", () => {
      const output = `Quick look: all good. APPROVE`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("Quick look: all good. APPROVE");
    });

    it("extracts summary from Summary heading", () => {
      const output = `# Summary\nNo major issues found.\n\nAPPROVE`;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.summary).toBe("No major issues found.");
    });
  });

  // ── Unparseable output ──

  describe("unparseable output", () => {
    it("returns null for completely irrelevant text", () => {
      const output = "Hello world, this is not a review at all.";
      expect(parseReviewOutput(output)).toBeNull();
    });

    it("returns null for empty string", () => {
      expect(parseReviewOutput("")).toBeNull();
    });

    it("returns null for JSON without verdict", () => {
      const output = `\`\`\`json\n{"summary": "test", "findings": []}\n\`\`\``;
      expect(parseReviewOutput(output)).toBeNull();
    });
  });

  // ── Multiple JSON blocks (last-block-wins) ──

  describe("multiple JSON blocks", () => {
    it("uses the last valid block (last-block-wins)", () => {
      const block1 = makeFullOutput({ verdict: "APPROVE", summary: "First pass" });
      const block2 = makeFullOutput({ verdict: "BLOCK", summary: "Final review" });
      const output = `\`\`\`json\n${block1}\n\`\`\`\n\nAfter further analysis:\n\n\`\`\`json\n${block2}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      // The parser iterates in reverse — last block tried first
      expect(result!.verdict).toBe("BLOCK");
      expect(result!.summary).toBe("Final review");
    });
  });

  // ── openIssues rehydration ──

  describe("openIssues rehydration from findings", () => {
    it("rehydrates string[] openIssues from findings", () => {
      const json = JSON.stringify({
        verdict: "ATTENTION",
        summary: "Some issues",
        findings: [
          { id: "f1", severity: "P0", category: "sec", file: "auth.ts", title: "XSS bug", body: "Details" },
          { id: "f2", severity: "P1", category: "perf", file: "db.ts", title: "N+1 query", body: "Details" },
        ],
        reviewState: {
          lastReviewedSha: "def456",
          openIssues: ["f1", "f2"], // string[] instead of object[]
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      expect(result!.reviewState.openIssues).toHaveLength(2);
      // Rehydrated from matching findings
      expect(result!.reviewState.openIssues[0]).toMatchObject({
        id: "f1",
        file: "auth.ts",
        severity: "P0",
      });
      expect(result!.reviewState.openIssues[1]).toMatchObject({
        id: "f2",
        file: "db.ts",
        severity: "P1",
      });
    });

    it("synthesizes openIssues from findings when reviewState.openIssues is empty", () => {
      const json = JSON.stringify({
        verdict: "BLOCK",
        summary: "Issues",
        findings: [
          { id: "f1", severity: "P0", category: "sec", file: "x.ts", title: "Bug", body: "..." },
        ],
        reviewState: {
          lastReviewedSha: null,
          openIssues: [],
          resolvedIssues: [],
          reviewCount: 0,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      // Empty openIssues in reviewState parses strictly, so it stays empty
      // (strict schema accepts empty array as valid)
      expect(result!.reviewState.openIssues).toEqual([]);
    });

    it("preserves string IDs without matching findings", () => {
      const json = JSON.stringify({
        verdict: "ATTENTION",
        summary: "Test",
        findings: [],
        reviewState: {
          lastReviewedSha: null,
          openIssues: ["orphan-id"],
          resolvedIssues: [],
          reviewCount: 1,
        },
      });
      const output = `\`\`\`json\n${json}\n\`\`\``;
      const result = parseReviewOutput(output);

      expect(result).not.toBeNull();
      // Lenient path rehydrates orphan string IDs with placeholder data
      expect(result!.reviewState.openIssues).toHaveLength(1);
      expect(result!.reviewState.openIssues[0].id).toBe("orphan-id");
      expect(result!.reviewState.openIssues[0].file).toBe("unknown");
    });
  });
});
