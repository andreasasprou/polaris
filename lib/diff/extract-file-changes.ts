import { createTwoFilesPatch } from "diff";
import { parseUnifiedDiff } from "./parse-unified-diff";
import type {
  DiffContentPart,
  DiffSummary,
  FileChange,
  FileRefContentPart,
} from "./types";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

// ── Type guards for content parts ──

function isFileRefPart(part: Record<string, unknown>): part is FileRefContentPart & Record<string, unknown> {
  return (
    part.type === "file_ref" &&
    typeof part.path === "string"
  );
}

function isDiffPart(part: Record<string, unknown>): part is DiffContentPart & Record<string, unknown> {
  return (
    part.type === "diff" &&
    typeof part.oldText === "string" &&
    typeof part.newText === "string"
  );
}

// ── PR URL extraction ──

const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/\d+/g;

/**
 * Scan ChatItem[] for GitHub PR URLs in agent messages.
 * Returns the last PR URL found, or null.
 */
export function extractPrUrl(items: ChatItem[]): string | null {
  let lastUrl: string | null = null;

  for (const item of items) {
    if (item.type === "agent_message") {
      const matches = item.text.match(PR_URL_RE);
      if (matches) {
        lastUrl = matches[matches.length - 1];
      }
    }
  }

  return lastUrl;
}

// ── File change extraction ──

/**
 * Extract all file changes from a ChatItem[] array.
 *
 * Walks tool_call items, extracts file_ref parts (with action !== "read" and
 * a non-empty diff field), and diff content parts (oldText/newText converted
 * to unified diff via the `diff` package).
 *
 * Deduplicates by file path, keeping the last change per file.
 */
export function extractFileChanges(items: ChatItem[]): DiffSummary {
  // Use a map keyed by file path — last write wins
  const changesByPath = new Map<string, FileChange>();

  for (const item of items) {
    if (item.type !== "tool_call") continue;

    const content = item.content;
    if (!content || content.length === 0) continue;

    // Track the path from a file_ref for associating with diff parts
    let lastFileRefPath: string | null = null;

    for (const part of content) {
      if (isFileRefPart(part)) {
        const action = part.action ?? "";
        // Skip read-only file refs (no meaningful change)
        if (action === "read" || !part.diff) {
          // Still track the path for potential diff parts
          lastFileRefPath = part.path;
          continue;
        }

        const parsedLines = parseUnifiedDiff(part.diff);
        const additions = parsedLines.filter((l) => l.type === "addition").length;
        const deletions = parsedLines.filter((l) => l.type === "deletion").length;

        changesByPath.set(part.path, {
          path: part.path,
          action,
          diff: part.diff,
          parsedLines,
          additions,
          deletions,
        });

        lastFileRefPath = part.path;
        continue;
      }

      if (isDiffPart(part)) {
        // Convert oldText/newText to unified diff using the `diff` package
        const filePath = part.path ?? lastFileRefPath ?? "unknown";
        const unifiedDiff = createTwoFilesPatch(
          filePath,
          filePath,
          part.oldText,
          part.newText,
        );

        const parsedLines = parseUnifiedDiff(unifiedDiff);
        const additions = parsedLines.filter((l) => l.type === "addition").length;
        const deletions = parsedLines.filter((l) => l.type === "deletion").length;

        changesByPath.set(filePath, {
          path: filePath,
          action: "patch",
          diff: unifiedDiff,
          parsedLines,
          additions,
          deletions,
        });
        continue;
      }
    }
  }

  const files = Array.from(changesByPath.values());
  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0);
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0);

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalFiles: files.length,
  };
}
