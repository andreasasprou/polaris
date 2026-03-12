import { Sandbox, type NetworkPolicy } from "@vercel/sandbox";
import { SandboxCommands } from "./SandboxCommands";
import type { SandboxConfig } from "./types";

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes

/**
 * Build a networkPolicy that injects GitHub auth on outbound requests to *.github.com.
 * Uses Basic auth format (x-access-token:<token>) because git HTTPS requires it —
 * Bearer tokens only work for the GitHub REST/GraphQL API, not git protocol.
 */
function buildGitNetworkPolicy(gitToken: string): NetworkPolicy {
  const basicAuth = Buffer.from(`x-access-token:${gitToken}`).toString("base64");
  const rule = [{ transform: [{ headers: { Authorization: `Basic ${basicAuth}` } }] }];
  return {
    allow: {
      "github.com": rule,
      "*.github.com": rule,
      "*": [], // allow all other traffic (npm, pip, etc.)
    },
  };
}

export class SandboxManager {
  static readonly PROJECT_DIR = "/vercel/sandbox";
  static readonly IDLE_GRACE_PERIOD_MS = 30 * 60 * 1000; // 30 minutes

  async create(config: SandboxConfig): Promise<Sandbox> {
    const { source } = config;

    const sharedOpts = {
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ports: config.ports,
      env: config.env,
      // Inject GitHub auth at the network level — sandbox never sees raw token
      networkPolicy: buildGitNetworkPolicy(config.gitToken),
    };

    if (source.type === "snapshot") {
      const sandbox = await Sandbox.create({
        ...sharedOpts,
        source: { type: "snapshot", snapshotId: source.snapshotId },
      });

      await this.cloneRepo(sandbox, config);
      return sandbox;
    }

    // Git source — platform-level clone uses source.password (never enters sandbox)
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
    // networkPolicy injects Authorization header — no token in URL
    const branch = config.baseBranch ?? "main";
    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const result = await commands.runShell(
      `git clone --depth 1 --branch ${branch} ${config.repoUrl} ${SandboxManager.PROJECT_DIR}`,
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
   * Reconnect to an existing running sandbox by ID.
   * Returns the sandbox if it's still running, null otherwise.
   */
  async reconnect(sandboxId: string): Promise<Sandbox | null> {
    try {
      const sandbox = await Sandbox.get({
        sandboxId,
        token: process.env.VERCEL_TOKEN,
        teamId: process.env.VERCEL_TEAM_ID,
      });
      if (sandbox.status === "running") return sandbox;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Extend sandbox timeout by the given duration. Best-effort — may
   * fail silently if the sandbox has already stopped or hit plan limits.
   */
  async extendTimeout(sandbox: Sandbox, durationMs: number): Promise<void> {
    try {
      await sandbox.extendTimeout(durationMs);
    } catch {
      // Best-effort — sandbox may have reached plan max or already stopped
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

  /**
   * Snapshot a running sandbox. This stops the sandbox automatically.
   * Returns the snapshot metadata or null if snapshotting failed.
   */
  async snapshot(
    sandbox: Sandbox,
  ): Promise<{ snapshotId: string; sizeBytes?: number } | null> {
    try {
      const result = await sandbox.snapshot();
      return {
        snapshotId: result.snapshotId,
        sizeBytes: result.sizeBytes,
      };
    } catch {
      return null;
    }
  }

  /**
   * Create a sandbox from a hibernation snapshot.
   */
  async createFromSnapshot(config: {
    snapshotId: string;
    gitToken: string;
    timeoutMs?: number;
    ports?: number[];
    env?: Record<string, string>;
  }): Promise<Sandbox> {
    return Sandbox.create({
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
      projectId: process.env.VERCEL_PROJECT_ID,
      timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ports: config.ports,
      env: config.env,
      networkPolicy: buildGitNetworkPolicy(config.gitToken),
      source: { type: "snapshot", snapshotId: config.snapshotId },
    });
  }

  /**
   * Update the GitHub token injected via networkPolicy.
   * Used on warm/suspend resume to refresh expired installation tokens.
   */
  async updateGitToken(sandbox: Sandbox, gitToken: string): Promise<void> {
    await sandbox.updateNetworkPolicy(buildGitNetworkPolicy(gitToken));
  }

  /**
   * Check if a sandbox-agent server is healthy at the given URL.
   */
  async isServerHealthy(serverUrl: string): Promise<boolean> {
    try {
      const response = await fetch(`${serverUrl}/v1/health`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Run credential scrubbing commands inside a sandbox before snapshotting.
   * Git token is injected via networkPolicy (never in sandbox), so only
   * agent auth files need cleanup.
   */
  async scrubCredentials(sandbox: Sandbox): Promise<boolean> {
    const commands = [
      // Remove OpenCode auth artifacts
      "rm -f ~/.local/share/opencode/auth.json ~/.local/share/opencode/mcp-auth.json 2>/dev/null || true",
      // Remove Codex auth
      "rm -f ~/.codex/auth.json 2>/dev/null || true",
    ];

    try {
      for (const cmd of commands) {
        await sandbox.runCommand({ cmd: "sh", args: ["-c", cmd] });
      }
      return true;
    } catch {
      return false;
    }
  }
}
