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

  it("accumulates hunks when the same file is edited multiple times", () => {
    const diff1 = "@@ -1,1 +1,1 @@\n-old\n+mid";
    const diff2 = "@@ -10,1 +10,1 @@\n-mid\n+final";

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
    // Two separate hunks preserved
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].hunks[0].oldValue).toContain("old");
    expect(result.files[0].hunks[1].newValue).toContain("final");
    // Aggregated counts
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(2);
    expect(result.totalAdditions).toBe(2);
    expect(result.totalDeletions).toBe(2);
  });

  it("accumulates diff parts (oldText/newText) as separate hunks", () => {
    const items: ChatItem[] = [
      makeToolCall([
        {
          type: "diff",
          oldText: "line1\nline2\n",
          newText: "line1\nline2_v1\n",
          path: "/src/app.ts",
        },
      ], { toolCallId: "tc-1" }),
      makeToolCall([
        {
          type: "diff",
          oldText: "line3\nline4\n",
          newText: "line3\nline4_v2\n",
          path: "/src/app.ts",
        },
      ], { toolCallId: "tc-2" }),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(1);
    // Two separate hunks, not concatenated
    expect(result.files[0].hunks).toHaveLength(2);
    expect(result.files[0].additions).toBe(2);
    expect(result.files[0].deletions).toBe(2);
  });

  it("resolves file path from tool_call locations when diff part has no path", () => {
    const items: ChatItem[] = [
      makeToolCall(
        [
          {
            type: "diff",
            oldText: "const greeting = \"hello\";\n",
            newText: "const greeting = \"hello world\";\n",
          },
        ],
        { locations: [{ path: "src/app.ts" }] },
      ),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(1);
    expect(result.files[0].path).toBe("src/app.ts");
    expect(result.files[0].additions).toBeGreaterThan(0);
  });

  it("resolves separate files from locations across multiple tool_calls", () => {
    const items: ChatItem[] = [
      makeToolCall(
        [{ type: "diff", oldText: "a\n", newText: "b\n" }],
        { toolCallId: "tc-1", locations: [{ path: "src/app.ts" }] },
      ),
      makeToolCall(
        [{ type: "diff", oldText: "", newText: "export function add() {}\n" }],
        { toolCallId: "tc-2", locations: [{ path: "src/utils.ts" }] },
      ),
      makeToolCall(
        [{ type: "diff", oldText: "port = 3000\n", newText: "port = 8080\n" }],
        { toolCallId: "tc-3", locations: [{ path: "src/config.ts" }] },
      ),
    ];

    const result = extractFileChanges(items);
    expect(result.totalFiles).toBe(3);
    expect(result.files.map((f) => f.path)).toEqual([
      "src/app.ts",
      "src/utils.ts",
      "src/config.ts",
    ]);
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
