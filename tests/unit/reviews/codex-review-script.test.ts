import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  buildIssueSeverityMap,
  formatInlineBody,
  formatReviewLabel,
  MARKERS,
  postResults,
  summarizePreviousState,
} = require("../../../.github/scripts/codex-review/index.cjs");

function writeReviewOutput(output: {
  review_markdown: string;
  inline_comments: unknown[];
  state: Record<string, unknown>;
}) {
  const outputDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "codex-review-script-test-"),
  );
  fs.writeFileSync(
    path.join(outputDir, "codex-review-output.json"),
    JSON.stringify(output),
  );
  return outputDir;
}

function decodePersistedState(body: string) {
  const match = body.match(
    new RegExp(`<!--\\s*${MARKERS.state}\\s*\\n([A-Za-z0-9+/=\\n]+)\\n\\s*-->`),
  );

  if (!match?.[1]) {
    throw new Error("Persisted state marker not found");
  }

  return JSON.parse(
    Buffer.from(match[1].replace(/\s+/g, ""), "base64").toString("utf8"),
  );
}

function createGithubStub(options?: { dismissShouldFail?: boolean }) {
  const calls = {
    createComment: [] as Array<Record<string, unknown>>,
    updateComment: [] as Array<Record<string, unknown>>,
    createReview: [] as Array<Record<string, unknown>>,
    dismissReview: [] as Array<Record<string, unknown>>,
    updateCheck: [] as Array<Record<string, unknown>>,
  };

  return {
    calls,
    github: {
      rest: {
        issues: {
          createComment: async (input: Record<string, unknown>) => {
            calls.createComment.push(input);
            return { data: { id: calls.createComment.length } };
          },
          updateComment: async (input: Record<string, unknown>) => {
            calls.updateComment.push(input);
            return { data: { id: input.comment_id } };
          },
        },
        pulls: {
          createReview: async (input: Record<string, unknown>) => {
            calls.createReview.push(input);
            return { data: { id: 901 } };
          },
          dismissReview: async (input: Record<string, unknown>) => {
            calls.dismissReview.push(input);
            if (options?.dismissShouldFail) {
              throw new Error("dismiss failed");
            }
            return { data: {} };
          },
        },
        checks: {
          update: async (input: Record<string, unknown>) => {
            calls.updateCheck.push(input);
            return { data: {} };
          },
        },
      },
    },
  };
}

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

  it("clears the previous inline review after a summary-only pass dismisses it", async () => {
    const outputDir = writeReviewOutput({
      review_markdown: "## Codex Review Pass 4 — Verdict: OK",
      inline_comments: [],
      state: {
        schema_version: 1,
        last_reviewed_head_sha: "head-sha",
        review_count: 3,
        updated_at: "2026-03-22T12:00:00.000Z",
        open_issues: [],
        recently_resolved_issues: [],
      },
    });
    const { calls, github } = createGithubStub();

    await postResults({
      github,
      owner: "polaris",
      repo: "polaris",
      prNumber: 108,
      headSha: "head-sha",
      previousState: {
        reviewCount: 3,
        lastInlineReviewId: 77,
        stateCommentId: 12,
      },
      outputDir,
    });

    expect(calls.dismissReview).toHaveLength(1);
    expect(calls.createReview).toHaveLength(0);
    expect(calls.updateComment).toHaveLength(1);
    expect(
      decodePersistedState(String(calls.updateComment[0].body))
        .lastInlineReviewId,
    ).toBeNull();
  });

  it("retains the previous inline review ID when dismissal fails", async () => {
    const outputDir = writeReviewOutput({
      review_markdown: "## Codex Review Pass 4 — Verdict: ATTENTION",
      inline_comments: [
        {
          issue_id: "finding-1",
          file: ".github/scripts/codex-review/index.cjs",
          line: 525,
          start_line: null,
          title: "Inline review lifecycle bug",
          body: "Summary-only passes should clear the previous inline review.",
          category: "Correctness",
          suggestion: null,
        },
      ],
      state: {
        schema_version: 1,
        last_reviewed_head_sha: "head-sha",
        review_count: 3,
        updated_at: "2026-03-22T12:00:00.000Z",
        open_issues: [
          {
            id: "finding-1",
            severity: "P1",
            category: "Correctness",
            title: "Inline review lifecycle bug",
            location: ".github/scripts/codex-review/index.cjs:515",
            status: "open",
            first_seen_head_sha: "prev-sha",
            last_seen_head_sha: "head-sha",
          },
        ],
        recently_resolved_issues: [],
      },
    });
    const { calls, github } = createGithubStub({ dismissShouldFail: true });

    await postResults({
      github,
      owner: "polaris",
      repo: "polaris",
      prNumber: 108,
      headSha: "head-sha",
      previousState: {
        reviewCount: 3,
        lastInlineReviewId: 77,
        stateCommentId: 12,
      },
      outputDir,
    });

    expect(calls.dismissReview).toHaveLength(1);
    expect(calls.createReview).toHaveLength(0);
    expect(
      decodePersistedState(String(calls.updateComment[0].body))
        .lastInlineReviewId,
    ).toBe(77);
  });

  it("documents nullable inline comment fields as required keys", () => {
    const prompt = fs.readFileSync(
      path.resolve(".github/scripts/codex-review/prompt.md"),
      "utf8",
    );
    expect(prompt).toContain(
      "`start_line`: required key — use `null` for single-line comments",
    );
    expect(prompt).toContain(
      "`suggestion`: required key — use `null` when there is no replacement code to suggest",
    );
  });
});
