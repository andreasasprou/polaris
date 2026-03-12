import type { Octokit } from "octokit";

export interface DiffResult {
  /** Raw unified diff string */
  diff: string;
  /** List of changed file paths */
  files: string[];
  /** True if the diff was truncated to fit the prompt budget */
  truncated: boolean;
}

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

  // Fetch diff (raw format)
  const { data: rawDiff } = await octokit.rest.pulls.get({
    owner,
    repo,
    pull_number: prNumber,
    mediaType: { format: "diff" },
  });

  // Fetch file list
  const allFiles: string[] = [];
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
    allFiles.push(...fileList.map((f) => f.filename));
    if (fileList.length < 100) break;
    page++;
  }

  let diff = rawDiff as unknown as string;
  let truncated = false;

  if (diff.length > maxBytes) {
    diff = diff.slice(0, maxBytes);
    truncated = true;
  }

  const files = allFiles.slice(0, maxFiles);
  if (allFiles.length > maxFiles) {
    truncated = true;
  }

  return { diff, files, truncated };
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
