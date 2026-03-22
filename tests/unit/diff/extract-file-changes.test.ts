import { describe, it, expect } from "vitest";
import { extractFileChanges, extractPrUrl } from "@/lib/diff/extract-file-changes";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

function makeToolCall(
  content: Array<Record<string, unknown>>,
  overrides?: Partial<ChatItem & { type: "tool_call" }>,
): ChatItem & { type: "tool_call" } {
  return {
    type: "tool_call",
    toolCallId: "tc-1",
    toolName: "Edit",
    title: "Edit file",
    kind: "tool",
    status: "completed",
    locations: [],
    content,
    ...overrides,
  };
}

describe("extractFileChanges", () => {
  it("returns empty summary for no items", () => {
    const result = extractFileChanges([]);
    expect(result).toEqual({
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      totalFiles: 0,
    });
  });

  it("skips non-tool-call items", () => {
    const items: ChatItem[] = [
      { type: "user_prompt", text: "hello" },
      { type: "agent_message", text: "hi" },
    ];
    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(0);
  });

  it("skips file_ref with action=read", () => {
    const items: ChatItem[] = [
      makeToolCall([
        { type: "file_ref", path: "/src/index.ts", action: "read" },
      ]),
    ];
    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(0);
  });

  it("skips file_ref with no diff", () => {
    const items: ChatItem[] = [
      makeToolCall([
        { type: "file_ref", path: "/src/index.ts", action: "write" },
      ]),
    ];
    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(0);
  });

  it("extracts file_ref with action and diff", () => {
    const diff = [
      "@@ -1,2 +1,2 @@",
      " const a = 1;",
      "-const b = 2;",
      "+const b = 3;",
    ].join("\n");

    const items: ChatItem[] = [
      makeToolCall([
        { type: "file_ref", path: "/src/index.ts", action: "write", diff },
      ]),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("/src/index.ts");
    expect(result.files[0].action).toBe("write");
    expect(result.files[0].additions).toBe(1);
    expect(result.files[0].deletions).toBe(1);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });

  it("handles diff content parts with oldText/newText", () => {
    const items: ChatItem[] = [
      makeToolCall([
        {
          type: "diff",
          oldText: "line1\nline2\n",
          newText: "line1\nline2modified\n",
          path: "/src/app.ts",
        },
      ]),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("/src/app.ts");
    expect(result.files[0].action).toBe("patch");
    expect(result.files[0].additions).toBeGreaterThan(0);
    expect(result.files[0].deletions).toBeGreaterThan(0);
  });

  it("deduplicates by path (last change wins)", () => {
    const diff1 = "@@ -1,1 +1,1 @@\n-old\n+mid";
    const diff2 = "@@ -1,1 +1,1 @@\n-mid\n+final";

    const items: ChatItem[] = [
      makeToolCall([
        { type: "file_ref", path: "/src/index.ts", action: "write", diff: diff1 },
      ], { toolCallId: "tc-1" }),
      makeToolCall([
        { type: "file_ref", path: "/src/index.ts", action: "write", diff: diff2 },
      ], { toolCallId: "tc-2" }),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(1);
    // Last write wins — the diff should be diff2
    expect(result.files[0].diff).toBe(diff2);
  });

  it("aggregates multiple files correctly", () => {
    const diff1 = "@@ -1,1 +1,2 @@\n context\n+added";
    const diff2 = "@@ -1,2 +1,1 @@\n context\n-removed";

    const items: ChatItem[] = [
      makeToolCall([
        { type: "file_ref", path: "/a.ts", action: "write", diff: diff1 },
      ], { toolCallId: "tc-1" }),
      makeToolCall([
        { type: "file_ref", path: "/b.ts", action: "write", diff: diff2 },
      ], { toolCallId: "tc-2" }),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(2);
    expect(result.totalAdditions).toBe(1);
    expect(result.totalDeletions).toBe(1);
  });
});

describe("extractPrUrl", () => {
  it("returns null when no PR URLs found", () => {
    const items: ChatItem[] = [
      { type: "agent_message", text: "Done with the changes." },
    ];
    expect(extractPrUrl(items)).toBeNull();
  });

  it("extracts a GitHub PR URL from an agent message", () => {
    const items: ChatItem[] = [
      {
        type: "agent_message",
        text: "Created PR: https://github.com/org/repo/pull/42",
      },
    ];
    expect(extractPrUrl(items)).toBe("https://github.com/org/repo/pull/42");
  });

  it("returns the last PR URL when multiple exist", () => {
    const items: ChatItem[] = [
      {
        type: "agent_message",
        text: "First: https://github.com/org/repo/pull/1",
      },
      {
        type: "agent_message",
        text: "Second: https://github.com/org/repo/pull/2",
      },
    ];
    expect(extractPrUrl(items)).toBe("https://github.com/org/repo/pull/2");
  });

  it("ignores PR URLs in non-agent-message items", () => {
    const items: ChatItem[] = [
      { type: "user_prompt", text: "https://github.com/org/repo/pull/99" },
    ];
    expect(extractPrUrl(items)).toBeNull();
  });
});
