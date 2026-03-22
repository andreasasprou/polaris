import { describe, expect, it } from "vitest";
import { buildChangedLineIndex } from "@/lib/reviews/diff";
import {
  buildInlineCommentMapFromTrackedThreads,
  dedupeTrackedInlineThreads,
  reconcileInlineThreads,
} from "@/lib/reviews/inline-thread-reconciliation";

describe("inline thread reconciliation", () => {
  it("auto-resolves only touched threads without overlapping anchors", () => {
    const result = reconcileInlineThreads({
      priorThreads: [
        {
          threadId: "thread-1",
          commentId: 101,
          issueId: "issue-1",
          file: "src/a.ts",
          line: 12,
        },
        {
          threadId: "thread-2",
          commentId: 102,
          issueId: "issue-2",
          file: "src/a.ts",
          line: 40,
        },
        {
          threadId: "thread-3",
          commentId: 103,
          issueId: "issue-3",
          file: "src/b.ts",
          line: 8,
          startLine: 6,
        },
      ],
      changedLineIndex: new Map([
        ["src/a.ts", [{ start: 10, end: 15 }]],
        ["src/b.ts", [{ start: 6, end: 9 }]],
      ]),
      currentInlineAnchors: [
        {
          issueId: "new-issue-3",
          file: "src/b.ts",
          line: 8,
          startLine: 7,
          title: "Still broken",
          body: "Still broken after the change.",
        },
      ],
    });

    expect(result.autoResolve.map((thread) => thread.threadId)).toEqual(["thread-1"]);
    expect(result.carryForward.map((thread) => thread.threadId)).toEqual(["thread-2"]);
    expect(result.overlapBlocked.map((thread) => thread.threadId)).toEqual(["thread-3"]);
  });

  it("keeps threads open when they sit in unchanged hunk context", () => {
    const result = reconcileInlineThreads({
      priorThreads: [
        {
          threadId: "thread-1",
          commentId: 101,
          issueId: "issue-1",
          file: "src/a.ts",
          line: 14,
        },
      ],
      changedLineIndex: new Map([
        ["src/a.ts", [{ start: 10, end: 10 }]],
      ]),
      currentInlineAnchors: [],
    });

    expect(result.autoResolve).toEqual([]);
    expect(result.overlapBlocked).toEqual([]);
    expect(result.carryForward.map((thread) => thread.threadId)).toEqual(["thread-1"]);
  });

  it("auto-resolves renamed threads when the touched lines move to a new path", () => {
    const changedLineIndex = buildChangedLineIndex([
      "diff --git a/src/old.ts b/src/new.ts",
      "@@ -12,1 +12,1 @@",
      "-broken()",
      "+fixed()",
    ].join("\n"));

    const result = reconcileInlineThreads({
      priorThreads: [
        {
          threadId: "thread-1",
          commentId: 101,
          issueId: "issue-1",
          file: "src/old.ts",
          line: 12,
        },
      ],
      changedLineIndex,
      currentInlineAnchors: [],
    });

    expect(result.autoResolve.map((thread) => thread.threadId)).toEqual(["thread-1"]);
    expect(result.carryForward).toEqual([]);
    expect(result.overlapBlocked).toEqual([]);
  });

  it("dedupes tracked threads by thread id and derives the comment map", () => {
    const threads = dedupeTrackedInlineThreads([
      {
        threadId: "thread-1",
        commentId: 101,
        issueId: "issue-1",
        file: "src/a.ts",
        line: 12,
      },
      {
        threadId: "thread-1",
        commentId: 101,
        issueId: "issue-1",
        file: "src/a.ts",
        line: 12,
      },
      {
        threadId: "thread-2",
        commentId: 202,
        issueId: "issue-2",
        file: "src/b.ts",
        line: 18,
      },
    ]);

    expect(threads).toHaveLength(2);
    expect(buildInlineCommentMapFromTrackedThreads(threads)).toEqual({
      "issue-1": 101,
      "issue-2": 202,
    });
  });
});
