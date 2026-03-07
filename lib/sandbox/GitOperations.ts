import type { GitChanges, GitCommitResult } from "./types";
import type { SandboxCommands } from "./SandboxCommands";

const ALLOWED_BRANCH_PREFIX = "agent/";

export class GitOperations {
  constructor(private commands: SandboxCommands) {}

  private assertSafeBranch(name: string): void {
    if (!name.startsWith(ALLOWED_BRANCH_PREFIX)) {
      throw new Error(
        `Branch "${name}" is not allowed. Agents can only push to "${ALLOWED_BRANCH_PREFIX}*" branches.`,
      );
    }
  }

  async configure(opts?: {
    name?: string;
    email?: string;
    repoUrl?: string;
    gitToken?: string;
  }): Promise<void> {
    const name = opts?.name ?? "Polaris Agent";
    const email = opts?.email ?? "polaris-agent@noreply.github.com";

    await this.commands.runInProject("git", ["config", "user.name", name]);
    await this.commands.runInProject("git", ["config", "user.email", email]);

    // Set authenticated remote URL so push works
    if (opts?.repoUrl && opts?.gitToken) {
      const url = new URL(opts.repoUrl);
      url.username = "x-access-token";
      url.password = opts.gitToken;
      await this.commands.runInProject("git", [
        "remote",
        "set-url",
        "origin",
        url.toString(),
      ]);
      // Fetch remote refs so origin/<branch> is available for createBranch
      await this.commands.runInProject("git", ["fetch", "origin"]);
    }
  }

  /** Resolve a ref (e.g. origin/main) to a commit SHA. Call before agent runs. */
  async resolveRef(ref: string): Promise<string> {
    const result = await this.commands.runInProject("git", ["rev-parse", ref]);
    return result.stdout.trim();
  }

  async createBranch(name: string, baseBranch: string): Promise<void> {
    this.assertSafeBranch(name);
    await this.commands.runInProject("git", [
      "checkout",
      "-b",
      name,
      `origin/${baseBranch}`,
    ]);
  }

  async checkoutBranch(name: string): Promise<void> {
    await this.commands.runInProject("git", ["fetch", "origin", name]);
    await this.commands.runInProject("git", ["checkout", name]);
  }

  /**
   * Check for changes relative to a base commit SHA.
   * Use resolveRef() before the agent runs to get the SHA,
   * since agents may remove remote refs during execution.
   */
  async checkChanges(baseSha: string): Promise<GitChanges> {
    // Check for uncommitted changes
    const status = await this.commands.runInProject("git", [
      "status",
      "--porcelain",
    ]);
    const hasUncommitted = status.stdout.trim().length > 0;

    // Check if agent made commits beyond the base
    const log = await this.commands.runInProject("git", [
      "log",
      `${baseSha}..HEAD`,
      "--oneline",
    ]);
    const hasCommits = log.stdout.trim().length > 0;

    const changed = hasUncommitted || hasCommits;

    let diffSummary = "";
    let filesChanged: string[] = [];

    if (changed) {
      // Stage and commit everything so we can reliably diff
      await this.commands.runInProject("git", ["add", "-A"]);

      const indexStatus = await this.commands.runInProject("git", ["diff", "--cached", "--quiet"]);
      if (indexStatus.exitCode !== 0) {
        await this.commands.runInProject("git", ["commit", "-m", "chore: collect changes"]);
      }

      // Use git show to get diff stats — more reliable than git diff with SHAs
      // in sandboxed environments where remote refs may be removed by agents
      const diff = await this.commands.runInProject("git", [
        "diff",
        baseSha,
        "HEAD",
        "--stat",
      ]);
      diffSummary = diff.stdout.trim();

      // Fallback: use git log --stat if git diff returns empty
      if (!diffSummary) {
        const showDiff = await this.commands.runInProject("git", [
          "show",
          "--stat",
          "--format=",
        ]);
        diffSummary = showDiff.stdout.trim();
      }

      const nameOnly = await this.commands.runInProject("git", [
        "diff",
        baseSha,
        "HEAD",
        "--name-only",
      ]);
      filesChanged = nameOnly.stdout.trim().split("\n").filter(Boolean);

      if (filesChanged.length === 0) {
        const showNames = await this.commands.runInProject("git", [
          "show",
          "--name-only",
          "--format=",
        ]);
        filesChanged = showNames.stdout.trim().split("\n").filter(Boolean);
      }
    }

    return { changed, diffSummary, filesChanged };
  }

  async commitAll(message: string, baseSha: string): Promise<string> {
    // Stage and commit any uncommitted changes
    const status = await this.commands.runInProject("git", [
      "status",
      "--porcelain",
    ]);
    if (status.stdout.trim().length > 0) {
      await this.commands.runInProject("git", ["add", "-A"]);
      await this.commands.runInProject("git", ["commit", "-m", message]);
    }

    // Squash all commits since base into one with the provided message
    const log = await this.commands.runInProject("git", [
      "log",
      `${baseSha}..HEAD`,
      "--oneline",
    ]);
    const commitCount = log.stdout.trim().split("\n").filter(Boolean).length;
    if (commitCount > 1) {
      await this.commands.runInProject("git", ["reset", "--soft", baseSha]);
      await this.commands.runInProject("git", ["commit", "-m", message]);
    } else if (commitCount === 1) {
      await this.commands.runInProject("git", ["commit", "--amend", "-m", message]);
    }

    const result = await this.commands.runInProject("git", [
      "rev-parse",
      "HEAD",
    ]);
    return result.stdout.trim();
  }

  async push(branchName: string): Promise<{ pushed: boolean; stdout: string; stderr: string }> {
    this.assertSafeBranch(branchName);
    const result = await this.commands.runInProject("git", [
      "push",
      "origin",
      branchName,
    ]);
    return {
      pushed: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  async ensureBranch(branchName: string): Promise<void> {
    const current = await this.commands.runInProject("git", ["branch", "--show-current"]);
    if (current.stdout.trim() !== branchName) {
      // Agent may have detached HEAD or switched branch — recover
      await this.commands.runInProject("git", ["checkout", "-B", branchName]);
    }
  }

  async commitAndPush(
    branchName: string,
    message: string,
    baseSha: string,
  ): Promise<GitCommitResult> {
    await this.ensureBranch(branchName);
    const commitSha = await this.commitAll(message, baseSha);
    const pushResult = await this.push(branchName);
    return { commitSha, pushed: pushResult.pushed, pushStderr: pushResult.stderr };
  }

  async getLog(count: number = 10): Promise<string> {
    const result = await this.commands.runInProject("git", [
      "log",
      `--oneline`,
      `-${count}`,
      "--no-decorate",
    ]);
    return result.stdout.trim();
  }
}
