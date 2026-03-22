import type { Octokit } from "octokit";
import { useLogger } from "@/lib/evlog";

export interface DiffResult {
  /** Raw unified diff string */
  diff: string;
  /** List of changed file paths */
  files: string[];
  /** True if the diff was truncated to fit the prompt budget */
  truncated: boolean;
}

export type ChangedLineIndex = Map<string, Array<{ start: number; end: number }>>;

/**
 * Fetch the PR diff and file list via GitHub API.
 * Truncates the diff to `maxBytes` (default 200KB) for prompt budget.
 */
export async function fetchPRDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  opts?: { maxBytes?: number; maxFiles?: number },
): Promise<DiffResult> {
  const maxBytes = opts?.maxBytes ?? 200_000;
  const maxFiles = opts?.maxFiles ?? 150;

  // Fetch file list (always works, even for huge PRs)
  const allFiles: Array<{ filename: string; patch?: string; status: string; additions: number; deletions: number }> = [];
  let page = 1;
  while (allFiles.length < maxFiles) {
    const { data: fileList } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    if (fileList.length === 0) break;
    allFiles.push(...fileList.map((f) => ({
      filename: f.filename,
      patch: f.patch,
      status: f.status ?? "modified",
      additions: f.additions,
      deletions: f.deletions,
    })));
    if (fileList.length < 100) break;
    page++;
  }

  let diff: string;
  let truncated = false;

  // Try fetching the full raw diff first
  try {
    const { data: rawDiff } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });
    diff = rawDiff as unknown as string;
  } catch (err) {
    // GitHub returns 422 "diff too large" for PRs over 20k lines.
    // Fall back to reconstructing a diff from per-file patches (listFiles).
    const log = useLogger();
    log.set({ diff: { tooLarge: true, prNumber, fallback: "file_patches" } });
    diff = reconstructDiffFromPatches(allFiles);
    truncated = true;
  }

  if (diff.length > maxBytes) {
    diff = diff.slice(0, maxBytes);
    truncated = true;
  }

  const files = allFiles.slice(0, maxFiles).map((f) => f.filename);
  if (allFiles.length > maxFiles) {
    truncated = true;
  }

  return { diff, files, truncated };
}

/**
 * Reconstruct a unified diff from per-file patches returned by listFiles.
 * GitHub's listFiles endpoint returns individual file patches even when
 * the full diff exceeds the 20k line limit.
 */
function reconstructDiffFromPatches(
  files: Array<{ filename: string; patch?: string; status: string; additions: number; deletions: number }>,
): string {
  const parts: string[] = [];
  for (const file of files) {
    if (file.patch) {
      parts.push(`diff --git a/${file.filename} b/${file.filename}`);
      parts.push(file.patch);
    } else {
      // Binary files or files too large for individual patches
      parts.push(`diff --git a/${file.filename} b/${file.filename}`);
      parts.push(`(${file.status}: +${file.additions} -${file.deletions}, patch not available)`);
    }
  }
  return parts.join("\n");
}

/**
 * Fetch the file list for a PR (no diff content).
 * Pass `maxFiles: Infinity` (or omit) for an uncapped list.
 * Default cap is 150 for prompt-budgeted usage.
 */
export async function fetchPRFileList(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  opts?: { maxFiles?: number },
): Promise<string[]> {
  const maxFiles = opts?.maxFiles ?? 150;
  const files: string[] = [];
  let page = 1;

  while (files.length < maxFiles) {
    const { data } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 100,
      page,
    });
    if (data.length === 0) break;
    files.push(...data.map((f) => f.filename));
    if (data.length < 100) break;
    page++;
  }

  return maxFiles === Infinity ? files : files.slice(0, maxFiles);
}

/**
 * Fetch the complete list of changed file paths for a PR.
 * Uncapped — used for filter evaluation and scoped guidelines,
 * NOT for prompt rendering.
 */
export function fetchFullFileList(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<string[]> {
  return fetchPRFileList(octokit, owner, repo, prNumber, { maxFiles: Infinity });
}

/**
 * Fetch the diff between two commits (for incremental review).
 */
export async function fetchCommitRangeDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
  opts?: { maxBytes?: number },
): Promise<DiffResult> {
  const maxBytes = opts?.maxBytes ?? 200_000;

  const { data } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
    mediaType: { format: "diff" },
  });

  // When using diff format, data is actually a string
  let diff = data as unknown as string;
  let truncated = false;

  if (diff.length > maxBytes) {
    diff = diff.slice(0, maxBytes);
    truncated = true;
  }

  // Parse file names from the diff (compare endpoint with diff format
  // doesn't give structured file list)
  const files: string[] = [];
  const fileHeaderRe = /^diff --git a\/(.+?) b\//gm;
  let match;
  while ((match = fileHeaderRe.exec(diff)) !== null) {
    files.push(match[1]);
  }

  return { diff, files, truncated };
}

/**
 * Fetch the full diff between two commits for reconciliation logic.
 * Unlike prompt-oriented helpers, this never truncates silently.
 */
export async function fetchFullCommitRangeDiff(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseSha: string,
  headSha: string,
): Promise<string> {
  const { data } = await octokit.rest.repos.compareCommits({
    owner,
    repo,
    base: baseSha,
    head: headSha,
    mediaType: { format: "diff" },
  });

  return data as unknown as string;
}

/**
 * Build an index of changed right-side line ranges per file from a unified diff.
 */
export function buildChangedLineIndex(diff: string): ChangedLineIndex {
  const index: ChangedLineIndex = new Map();
  let currentFile: string | null = null;

  for (const line of diff.split("\n")) {
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (fileMatch) {
      currentFile = fileMatch[2] ?? null;
      continue;
    }

    const hunkMatch = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunkMatch || !currentFile) continue;

    const start = Number(hunkMatch[1]);
    const count = hunkMatch[2] == null ? 1 : Number(hunkMatch[2]);
    if (!Number.isFinite(start) || !Number.isFinite(count) || count <= 0) continue;

    const ranges = index.get(currentFile) ?? [];
    ranges.push({ start, end: start + count - 1 });
    index.set(currentFile, ranges);
  }

  return index;
}
