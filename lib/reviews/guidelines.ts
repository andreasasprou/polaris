import type { Octokit } from "octokit";
import type { RepoGuidelines } from "./types";

const GUIDELINE_FILES = [
  "AGENTS.md",
  ".agents.md",
  "REVIEW_GUIDELINES.md",
  ".review-guidelines.md",
];

/**
 * Load repository-level review guidelines from well-known files.
 * Looks for AGENTS.md and REVIEW_GUIDELINES.md at repo root and
 * in directories containing changed files.
 */
export async function loadRepoGuidelines(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  changedPaths: string[],
  opts?: { maxBytes?: number },
): Promise<RepoGuidelines> {
  const maxBytes = opts?.maxBytes ?? 40_000;
  const result: RepoGuidelines = { scopedAgentsMd: [] };
  let totalBytes = 0;

  // Load root-level files
  for (const filename of GUIDELINE_FILES) {
    const content = await fetchFileContent(octokit, owner, repo, ref, filename);
    if (!content) continue;

    if (totalBytes + content.length > maxBytes) break;

    if (filename.toLowerCase().includes("agents")) {
      result.rootAgentsMd = content;
    } else {
      result.reviewGuidelinesMd = content;
    }
    totalBytes += content.length;
  }

  // Collect unique directories from changed files
  const dirs = new Set<string>();
  for (const path of changedPaths) {
    const parts = path.split("/");
    // Build directory paths from root downward (e.g., "src", "src/lib")
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/"));
    }
  }

  // Check for scoped AGENTS.md in changed directories
  for (const dir of dirs) {
    if (totalBytes >= maxBytes) break;

    for (const filename of ["AGENTS.md", ".agents.md"]) {
      const path = `${dir}/${filename}`;
      const content = await fetchFileContent(octokit, owner, repo, ref, path);
      if (!content) continue;

      if (totalBytes + content.length > maxBytes) break;

      result.scopedAgentsMd.push({ path, content });
      totalBytes += content.length;
    }
  }

  return result;
}

async function fetchFileContent(
  octokit: Octokit,
  owner: string,
  repo: string,
  ref: string,
  path: string,
): Promise<string | null> {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner,
      repo,
      path,
      ref,
    });

    if ("content" in data && data.encoding === "base64") {
      return Buffer.from(data.content, "base64").toString("utf-8");
    }

    return null;
  } catch {
    // 404 or other error — file doesn't exist
    return null;
  }
}
