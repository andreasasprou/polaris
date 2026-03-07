import { Sandbox } from "@vercel/sandbox";
import type { SandboxConfig } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

export class SandboxManager {
  static readonly PROJECT_DIR = "/vercel/sandbox";

  async create(config: SandboxConfig): Promise<Sandbox> {
    const gitAuth = config.gitToken
      ? { username: "x-access-token", password: config.gitToken }
      : {};

    const sandbox = await Sandbox.create({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      source: {
        type: "git",
        url: config.repoUrl,
        ...gitAuth,
        revision: config.baseBranch,
      },
      runtime: "node24",
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      env: {
        ...(config.gitToken ? { GITHUB_TOKEN: config.gitToken } : {}),
        ...config.env,
      },
    });

    return sandbox;
  }

  async destroy(sandbox: Sandbox): Promise<void> {
    try {
      await sandbox.stop();
    } catch {
      // Best-effort cleanup — sandbox may already be stopped or timed out
    }
  }
}
