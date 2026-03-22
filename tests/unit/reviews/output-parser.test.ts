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
    `## ✅ Polaris Review Pass 1: ${verdict}\n\nLooks good overall.\n\n<sub>Polaris Review Pass 1 · Automated by Polaris</sub>`;

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
    expect(result!.commentBody).toContain("Polaris Review Pass 1");
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

  // ── Regression tests: tool-call-interleaved output ──

  it("extracts review from allOutput with pre-review thinking text", () => {
    // Simulates allOutput where the agent wrote thinking text before the review
    const preReviewText = "Let me analyze the changes in this PR...\n\nI'll look at the key files.\n\n";
    const reviewBody = `## ⚠️ Polaris Review Pass 3: ATTENTION\n\nThis PR has a potential issue.\n\n#### 🟡 [P1] Missing null check\n**File:** \`src/auth.ts\` · **Category:** Correctness\n\nThe function does not check for null.\n\n<sub>Polaris Review Pass 3 · abc1234 · Automated by Polaris</sub>`;

    const output = preReviewText + makeAgentOutput({
      verdict: "ATTENTION",
      body: reviewBody,
      severityCounts: { P0: 0, P1: 1, P2: 0 },
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.metadata.verdict).toBe("ATTENTION");
    // Pre-review thinking text should be stripped
    expect(result!.commentBody).not.toContain("Let me analyze");
    // Review header should be present
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ⚠️ Polaris Review Pass 3: ATTENTION"));
    expect(result!.commentBody).toContain("Missing null check");
  });

  it("handles allOutput with tool call text interleaved before the review", () => {
    // Simulates the agent reading files (tool call output appears as text segments)
    const toolCallOutput = [
      "I need to check the implementation details.",
      "Looking at the auth module for potential issues.",
      "Found the relevant code section, now writing the review.",
    ].join("\n\n");

    const reviewBody = `## ✅ Polaris Review Pass 2: APPROVE\n\nClean implementation with good test coverage.\n\n<sub>Polaris Review Pass 2 · def5678 · Automated by Polaris</sub>`;

    const output = toolCallOutput + "\n\n" + makeAgentOutput({
      verdict: "APPROVE",
      body: reviewBody,
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.metadata.verdict).toBe("APPROVE");
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ✅ Polaris Review Pass 2: APPROVE"));
    expect(result!.commentBody).not.toContain("I need to check");
  });

  it("preserves full review body when no pre-review text exists", () => {
    // Clean output — no extra text before the review
    const output = makeAgentOutput({ verdict: "APPROVE" });
    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ✅ Polaris Review Pass 1: APPROVE"));
  });

  it("handles BLOCK verdict header with 🚫 emoji", () => {
    const reviewBody = `## 🚫 Polaris Review Pass 1: BLOCK\n\nCritical security issue found.\n\n<sub>Polaris Review Pass 1 · abc · Automated by Polaris</sub>`;
    const output = "Some thinking...\n\n" + makeAgentOutput({
      verdict: "BLOCK",
      body: reviewBody,
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## 🚫 Polaris Review Pass 1: BLOCK"));
    expect(result!.commentBody).not.toContain("Some thinking");
  });

  it("still recognizes legacy Review #N headers", () => {
    const output = makeAgentOutput({
      body: "## ✅ Polaris Review #4: APPROVE\n\nLooks good.\n\n<sub>Polaris Review #4 · Automated by Polaris</sub>",
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ✅ Polaris Review #4: APPROVE"));
  });

  // ── Regression: Codex reasoning summaries leaked into PR comment ──

  it("strips Codex reasoning summaries that appear as prose paragraphs before the review header", () => {
    // Exact format from production: Codex emits reasoning summaries as plain
    // prose paragraphs (not prefixed with thinking markers). These appear in
    // allOutput before the review header and must be stripped.
    const codexReasoning = [
      "Reviewing the scoped diff first to map what changed, what doc contract it touches, and whether any neighboring behavior or guidance needs to move with it. After that I'll dispatch the required docs-only subagent and wait for its result before finalizing the review.",
      "The diff is tiny but I'm checking the rendered file and git state carefully because the patch as shown adds a duplicate limitation line. I'm dispatching the required docs-only subagent now with a narrow scope: documentation completeness and correctness only.",
      "The dedicated `codex` CLI isn't installed in this sandbox, so I'm checking what alternate agent tooling is available to satisfy the mandatory docs-only delegation without broadening scope.",
      "The local worktree doesn't have the advertised head commit yet, and the checked-in file already matches the base doc tail. I'm fetching the PR head commit so I can verify whether the prepared patch is stale or whether the PR actually introduces a duplicate line.",
      "I've confirmed the PR head now: the only change is a second identical \"Exact branch matching\" bullet at the end of the limitations list.",
      "The surrounding docs already mention exact matching in two other places, which makes the current change look like an accidental duplicate rather than a missing clarification. There's no evidence of a broader doc omission beyond that.",
    ].join("\n\n");

    const reviewBody = `## ⚠️ Polaris Review Pass 1: ATTENTION\n\nThis PR is scoped to a single docs change.\n\n🔵 [P2] Duplicate limitation entry\n**File:** \`docs/features/code-reviews.md\` · **Category:** Documentation\n\nDuplicate bullet found.\n\n<sub>Polaris Review Pass 1 · 3d7ccd5 · Automated by Polaris</sub>`;

    const output = codexReasoning + "\n" + makeAgentOutput({
      verdict: "ATTENTION",
      body: reviewBody,
      severityCounts: { P0: 0, P1: 0, P2: 1 },
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.metadata.verdict).toBe("ATTENTION");
    // Reasoning must NOT appear in comment body
    expect(result!.commentBody).not.toContain("Reviewing the scoped diff first");
    expect(result!.commentBody).not.toContain("codex CLI isn't installed");
    expect(result!.commentBody).not.toContain("I've confirmed the PR head");
    // Review content must be preserved
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ⚠️ Polaris Review Pass 1: ATTENTION"));
    expect(result!.commentBody).toContain("Duplicate limitation entry");
  });

  it("strips reasoning when header is concatenated without line break (Codex single-chunk regression)", () => {
    // Codex can emit reasoning + header in a single agent_message_chunk,
    // so they get joined without \n\n between them. The ## header is NOT
    // at the start of a line — it follows the last reasoning sentence.
    const reasoningAndHeader = "The surrounding docs already mention exact matching in two other places.## ⚠️ Polaris Review Pass 1: ATTENTION\n\nThis PR has an issue.\n\n<sub>Polaris Review Pass 1 · abc · Automated by Polaris</sub>";

    const output = makeAgentOutput({
      verdict: "ATTENTION",
      body: reasoningAndHeader,
      severityCounts: { P0: 0, P1: 0, P2: 1 },
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    // Reasoning before ## must be stripped even without a line break
    expect(result!.commentBody).not.toContain("surrounding docs");
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ⚠️ Polaris Review Pass 1"));
  });

  it("uses exact metadata-aware header match over quoted headers in preamble (different verdict)", () => {
    // Preamble quotes an APPROVE header, but the actual review is ATTENTION.
    // The exact-match regex targets ATTENTION, skipping the APPROVE quote.
    const preambleWithQuotedHeader = [
      "The prompt says to use `## ✅ Polaris Review Pass 1: APPROVE` as the header.",
      "I'll follow that format for this review.",
    ].join("\n\n");

    const reviewBody = `## ⚠️ Polaris Review Pass 1: ATTENTION\n\nActual review content here.\n\n<sub>Polaris Review Pass 1 · abc · Automated by Polaris</sub>`;

    const output = preambleWithQuotedHeader + "\n\n" + makeAgentOutput({
      verdict: "ATTENTION",
      body: reviewBody,
      severityCounts: { P0: 0, P1: 0, P2: 1 },
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    expect(result!.commentBody).not.toContain("The prompt says");
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ⚠️ Polaris Review Pass 1: ATTENTION"));
  });

  it("uses last match when preamble quotes the SAME verdict/pass header", () => {
    // Preamble quotes the exact same header as the real review.
    // The parser must use the LAST match (closest to metadata marker).
    const preambleWithSameHeader = [
      "I will write the review as: ## ⚠️ Polaris Review Pass 1: ATTENTION",
      "Now analyzing the changes...",
    ].join("\n\n");

    const reviewBody = `## ⚠️ Polaris Review Pass 1: ATTENTION\n\nReal review content.\n\n<sub>Polaris Review Pass 1 · abc · Automated by Polaris</sub>`;

    const output = preambleWithSameHeader + "\n\n" + makeAgentOutput({
      verdict: "ATTENTION",
      body: reviewBody,
      severityCounts: { P0: 0, P1: 0, P2: 1 },
    });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    // Must use the LAST match — the real header, not the quoted one
    expect(result!.commentBody).not.toContain("I will write");
    expect(result!.commentBody).not.toContain("Now analyzing");
    expect(result!.commentBody).toSatisfy((s: string) => s.startsWith("## ⚠️ Polaris Review Pass 1: ATTENTION"));
    expect(result!.commentBody).toContain("Real review content");
  });

  it("falls back to full text before marker when no review header found", () => {
    // Edge case: agent wrote a review without the standard header format
    const body = "This PR looks fine. No major issues.\n\n<sub>Footer</sub>";
    const output = makeAgentOutput({ body });

    const result = parseReviewOutput(output);
    expect(result).not.toBeNull();
    // Without a matching header, should keep all text before marker
    expect(result!.commentBody).toBe(body);
  });
});
