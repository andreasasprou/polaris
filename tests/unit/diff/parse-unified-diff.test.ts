import { describe, it, expect } from "vitest";
import { parseUnifiedDiff } from "@/lib/diff/parse-unified-diff";

describe("parseUnifiedDiff", () => {
  it("returns empty array for empty input", () => {
    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("  \n  ")).toEqual([]);
  });

  it("parses a simple hunk with additions and deletions", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " line1",
      "-old line",
      "+new line",
      " line3",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);

    expect(lines).toEqual([
      { type: "hunk_header", content: "@@ -1,3 +1,3 @@" },
      { type: "context", content: "line1", oldLineNo: 1, newLineNo: 1 },
      { type: "deletion", content: "old line", oldLineNo: 2 },
      { type: "addition", content: "new line", newLineNo: 2 },
      { type: "context", content: "line3", oldLineNo: 3, newLineNo: 3 },
    ]);
  });

  it("tracks line numbers across multiple hunks", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      "-old1",
      "+new1",
      " same",
      "@@ -10,2 +10,3 @@",
      " context",
      "+added1",
      "+added2",
      " more",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);

    // First hunk
    expect(lines[0]).toEqual({ type: "hunk_header", content: "@@ -1,2 +1,2 @@" });
    expect(lines[1]).toEqual({ type: "deletion", content: "old1", oldLineNo: 1 });
    expect(lines[2]).toEqual({ type: "addition", content: "new1", newLineNo: 1 });
    expect(lines[3]).toEqual({ type: "context", content: "same", oldLineNo: 2, newLineNo: 2 });

    // Second hunk
    expect(lines[4]).toEqual({ type: "hunk_header", content: "@@ -10,2 +10,3 @@" });
    expect(lines[5]).toEqual({ type: "context", content: "context", oldLineNo: 10, newLineNo: 10 });
    expect(lines[6]).toEqual({ type: "addition", content: "added1", newLineNo: 11 });
    expect(lines[7]).toEqual({ type: "addition", content: "added2", newLineNo: 12 });
    expect(lines[8]).toEqual({ type: "context", content: "more", oldLineNo: 11, newLineNo: 13 });
  });

  it("skips file header lines (diff --git, ---, +++, index)", () => {
    const diff = [
      "diff --git a/file.ts b/file.ts",
      "index abc123..def456 100644",
      "--- a/file.ts",
      "+++ b/file.ts",
      "@@ -1,1 +1,1 @@",
      "-old",
      "+new",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);

    expect(lines).toEqual([
      { type: "hunk_header", content: "@@ -1,1 +1,1 @@" },
      { type: "deletion", content: "old", oldLineNo: 1 },
      { type: "addition", content: "new", newLineNo: 1 },
    ]);
  });

  it("handles additions-only diff (new file)", () => {
    const diff = [
      "@@ -0,0 +1,3 @@",
      "+line1",
      "+line2",
      "+line3",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);

    expect(lines).toHaveLength(4); // 1 header + 3 additions
    expect(lines[0].type).toBe("hunk_header");
    expect(lines[1]).toEqual({ type: "addition", content: "line1", newLineNo: 1 });
    expect(lines[2]).toEqual({ type: "addition", content: "line2", newLineNo: 2 });
    expect(lines[3]).toEqual({ type: "addition", content: "line3", newLineNo: 3 });
  });

  it("handles deletions-only diff (deleted file)", () => {
    const diff = [
      "@@ -1,2 +0,0 @@",
      "-line1",
      "-line2",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);

    expect(lines).toHaveLength(3);
    expect(lines[1]).toEqual({ type: "deletion", content: "line1", oldLineNo: 1 });
    expect(lines[2]).toEqual({ type: "deletion", content: "line2", oldLineNo: 2 });
  });

  it("strips the leading space from context lines", () => {
    const diff = [
      "@@ -1,3 +1,3 @@",
      " context line",
      "-removed",
      "+added",
    ].join("\n");

    const lines = parseUnifiedDiff(diff);
    expect(lines[1]).toEqual({
      type: "context",
      content: "context line",
      oldLineNo: 1,
      newLineNo: 1,
    });
  });
});
