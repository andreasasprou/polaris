import type { DiffLine } from "./types";

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse a unified diff string into structured DiffLine[].
 *
 * Handles:
 * - `@@ -a,b +c,d @@` hunk headers with line number tracking
 * - `+` / `-` prefixed lines (additions / deletions)
 * - Context lines (no prefix or space-prefixed)
 * - File header lines (`---`, `+++`, `diff --git`) are skipped
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  if (!diff.trim()) return [];

  const rawLines = diff.split("\n");
  const result: DiffLine[] = [];

  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of rawLines) {
    // Skip file header lines — but only BEFORE the first hunk.
    // Inside a hunk, lines like "--- TODO" or "+++counter" are real content.
    if (
      !inHunk &&
      (line.startsWith("diff --git") ||
        line.startsWith("index ") ||
        line.startsWith("---") ||
        line.startsWith("+++"))
    ) {
      continue;
    }

    // "\ No newline at end of file" can appear anywhere — always skip
    if (line.startsWith("\\")) {
      continue;
    }

    const hunkMatch = line.match(HUNK_HEADER_RE);
    if (hunkMatch) {
      inHunk = true;
      oldLine = parseInt(hunkMatch[1], 10);
      newLine = parseInt(hunkMatch[2], 10);
      result.push({
        type: "hunk_header",
        content: line,
      });
      continue;
    }

    if (line.startsWith("+")) {
      result.push({
        type: "addition",
        content: line.slice(1),
        newLineNo: newLine,
      });
      newLine++;
      continue;
    }

    if (line.startsWith("-")) {
      result.push({
        type: "deletion",
        content: line.slice(1),
        oldLineNo: oldLine,
      });
      oldLine++;
      continue;
    }

    // Context line: starts with a space or is bare text after a hunk header
    const content = line.startsWith(" ") ? line.slice(1) : line;
    // Only emit context lines if we're inside a hunk (line numbers initialized)
    if (oldLine > 0 || newLine > 0) {
      result.push({
        type: "context",
        content,
        oldLineNo: oldLine,
        newLineNo: newLine,
      });
      oldLine++;
      newLine++;
    }
  }

  return result;
}
