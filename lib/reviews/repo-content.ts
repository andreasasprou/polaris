import type { Octokit } from "octokit";

/** Check if an error is a GitHub API 404 response. */
export function isGitHub404(err: unknown): boolean {
  return (
    err != null &&
    typeof err === "object" &&
    "status" in err &&
    (err as { status: number }).status === 404
  );
}

/**
 * Fetch a single text file from a repo/ref via GitHub Contents API.
 * Returns `null` for 404/not-a-file and throws for unexpected transport/API failures.
 */
export async function fetchFileContent(
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
  } catch (err: unknown) {
    if (isGitHub404(err)) return null;
    throw err;
  }
}
