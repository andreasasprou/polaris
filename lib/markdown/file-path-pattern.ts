/**
 * Regex and parser for detecting file paths in markdown text.
 *
 * Requirements:
 * - At least one `/` separator (eliminates false positives like `e.g.`, package names)
 * - Recognised file extension
 * - Optional line number suffix: `file.ts:42` or `file.ts:42-50`
 * - Negative lookbehind excludes URLs (`https://`, `http://`)
 */

const EXTENSIONS =
  "ts|tsx|js|jsx|css|json|md|py|go|rs|yaml|yml|toml|sh|sql|html|vue|svelte|rb|java|kt|swift|c|cpp|h";

/**
 * Matches file paths like:
 *   src/foo/bar.tsx
 *   ./relative/path.ts
 *   lib/utils.ts:42
 *   lib/utils.ts:42-50
 *   app/(dashboard)/page.tsx
 *
 * Does NOT match:
 *   https://github.com/foo/bar.ts  (URL)
 *   react-markdown                  (no slash)
 *   some.thing                      (no slash)
 *   .env                            (no slash)
 */
export const FILE_PATH_REGEX = new RegExp(
  // Negative lookbehind: not preceded by :// (URLs), alphanumeric/slash (mid-URL), or dot (domain.com/...)
  `(?<![a-zA-Z0-9:/.])` +
    // Optional leading ./
    `(?:\\.\/)?` +
    // One or more directory segments: name/ (supports parens for Next.js routes)
    `(?:[a-zA-Z0-9_@(][a-zA-Z0-9_@.()-]*\\/)+` +
    // Filename with extension
    `[a-zA-Z0-9_.-]+\\.(?:${EXTENSIONS})` +
    // Optional :line or :line-lineEnd
    `(?::(\\d+)(?:-(\\d+))?)?` +
    // Negative lookahead: not followed by more path-like chars
    `(?![a-zA-Z0-9/])`,
  "g",
);

export interface ParsedFilePath {
  path: string;
  line?: number;
  lineEnd?: number;
}

/**
 * Parse a matched file path string into its components.
 * Strips optional line number suffix from the path.
 */
export function parseFilePath(match: string): ParsedFilePath {
  const lineMatch = match.match(/:(\d+)(?:-(\d+))?$/);
  if (lineMatch) {
    const path = match.slice(0, match.indexOf(":" + lineMatch[1]));
    return {
      path,
      line: Number(lineMatch[1]),
      lineEnd: lineMatch[2] ? Number(lineMatch[2]) : undefined,
    };
  }
  return { path: match };
}
