/** A single line in a parsed unified diff. */
export type DiffLine = {
  type: "addition" | "deletion" | "context" | "hunk_header";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
};

/** A file change extracted from tool call content parts. */
export type FileChange = {
  path: string;
  action: string;
  diff: string;
  parsedLines: DiffLine[];
  additions: number;
  deletions: number;
};

/** Summary of all file changes in a session. */
export type DiffSummary = {
  files: FileChange[];
  totalAdditions: number;
  totalDeletions: number;
  totalFiles: number;
};

/** Typed interface for file_ref content parts in tool call content arrays. */
export type FileRefContentPart = {
  type: "file_ref";
  path: string;
  action?: string;
  diff?: string;
};

/** Typed interface for diff content parts in tool call content arrays. */
export type DiffContentPart = {
  type: "diff";
  oldText: string;
  newText: string;
  path?: string;
};
