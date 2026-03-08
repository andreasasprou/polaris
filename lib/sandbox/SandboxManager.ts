import { Sandbox } from "@vercel/sandbox";
import { SandboxCommands } from "./SandboxCommands";
import type { SandboxConfig } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export class SandboxManager {
  static readonly PROJECT_DIR = "/vercel/sandbox";

  async create(config: SandboxConfig): Promise<Sandbox> {
    const { source } = config;

    const sharedOpts = {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ports: config.ports,
      env: {
        ...(config.gitToken ? { GITHUB_TOKEN: config.gitToken } : {}),
        ...config.env,
      },
    };

    if (source.type === "snapshot") {
      const sandbox = await Sandbox.create({
        ...sharedOpts,
        source: { type: "snapshot", snapshotId: source.snapshotId },
      });

      await this.cloneRepo(sandbox, config);
      return sandbox;
    }

    // Git source — existing behavior
    return Sandbox.create({
      ...sharedOpts,
      runtime: "node24",
      source: {
        type: "git",
        url: config.repoUrl,
        username: "x-access-token",
        password: config.gitToken,
        revision: config.baseBranch,
      },
    });
  }

  private async cloneRepo(
    sandbox: Sandbox,
    config: SandboxConfig,
  ): Promise<void> {
    const authedUrl = config.repoUrl.replace(
      "https://",
      `https://x-access-token:${config.gitToken}@`,
    );
    const branch = config.baseBranch ?? "main";
    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const result = await commands.runShell(
      `git clone --depth 1 --branch ${branch} ${authedUrl} ${SandboxManager.PROJECT_DIR}`,
      { cwd: "/" },
    );
    if (result.exitCode !== 0) {
      throw new Error(`Failed to clone repo: ${result.stderr}`);
    }
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.stop();
    } catch {
      // Best-effort cleanup — sandbox may already be stopped or timed out
    }
  }

  /**
   * Stop a sandbox by ID. Used for cleanup when the task process is killed
   * (cancellation, crash) and we only have the sandbox ID from the DB.
   */
  async destroyById(sandboxId: string): Promise<void> {
    try {
      const sandbox = await Sandbox.get({
        sandboxId,
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
      });
      await sandbox.stop();
    } catch {
      // Best-effort — sandbox may already be stopped
    }
  }
}
