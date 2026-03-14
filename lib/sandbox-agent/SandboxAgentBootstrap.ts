import type { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import type { Sandbox } from "@vercel/sandbox";
import type { AgentType } from "./types";
import { buildSessionEnv } from "./credentials";

const SANDBOX_AGENT_VERSION = "0.3.x";
const DEFAULT_PORT = 2468;
const HEALTH_CHECK_RETRIES = 5;
const HEALTH_CHECK_INTERVAL_MS = 2000;

/**
 * Installs and starts the sandbox-agent server inside a Vercel Sandbox.
 */
export class SandboxAgentBootstrap {
  constructor(
    private sandbox: Sandbox,
    private commands: SandboxCommands,
  ) {}

  /**
   * Install the sandbox-agent binary via curl.
   */
  async install(): Promise<void> {
    const result = await this.commands.runShell(
      `curl -fsSL https://releases.rivet.dev/sandbox-agent/${SANDBOX_AGENT_VERSION}/install.sh | sh`,
      { cwd: "/" },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to install sandbox-agent: ${result.stderr}`,
      );
    }

    await this.installGitHubCLI();
  }

  /**
   * Install the GitHub CLI (`gh`) binary.
   * Idempotent — skips if already installed.
   * Non-fatal — logs a warning on failure since gh is nice-to-have.
   */
  private async installGitHubCLI(): Promise<void> {
    const result = await this.commands.runShell(
      `export PATH="$HOME/bin:$PATH"
      (command -v gh > /dev/null 2>&1) || {
        GH_VERSION="2.67.0"
        mkdir -p "$HOME/bin" \
        && curl -fsSL "https://github.com/cli/cli/releases/download/v\${GH_VERSION}/gh_\${GH_VERSION}_linux_amd64.tar.gz" -o /tmp/gh.tar.gz \
        && tar -xzf /tmp/gh.tar.gz -C /tmp \
        && mv "/tmp/gh_\${GH_VERSION}_linux_amd64/bin/gh" "$HOME/bin/gh" \
        && chmod +x "$HOME/bin/gh" \
        && rm -rf /tmp/gh.tar.gz /tmp/gh_* \
        && { grep -q 'HOME/bin' "$HOME/.bashrc" 2>/dev/null || echo 'export PATH="$HOME/bin:$PATH"' >> "$HOME/.bashrc"; }
      }`,
      { cwd: "/" },
    );

    if (result.exitCode !== 0) {
      console.warn(`Failed to install gh CLI: ${result.stderr}`);
    }
  }

  /**
   * Pre-install a specific agent to avoid lazy install latency.
   */
  async installAgent(agentType: AgentType, env: Record<string, string>): Promise<void> {
    const result = await this.commands.run(
      "sandbox-agent",
      ["install-agent", agentType],
      { cwd: "/", env },
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `Failed to install agent ${agentType}: ${result.stderr}`,
      );
    }
  }

  /**
   * Provision credential files in the sandbox from special env vars.
   * E.g. CODEX_AUTH_JSON_B64 → ~/.codex/auth.json for ChatGPT OAuth.
   * Returns a cleaned env with consumed vars removed.
   */
  async provisionCredentialFiles(
    env: Record<string, string>,
  ): Promise<Record<string, string>> {
    const cleaned = { ...env };

    // CODEX_AUTH_JSON_B64 → ~/.codex/auth.json
    if (cleaned.CODEX_AUTH_JSON_B64) {
      const content = Buffer.from(cleaned.CODEX_AUTH_JSON_B64, "base64");
      await this.sandbox.writeFiles([
        { path: "/root/.codex/auth.json", content },
      ]);
      await this.commands.runShell(
        "chmod 600 $HOME/.codex/auth.json",
        { cwd: "/" },
      );
      delete cleaned.CODEX_AUTH_JSON_B64;
    }

    return cleaned;
  }

  /**
   * Start the sandbox-agent server as a background process.
   * Returns the base URL for SDK connection.
   */
  async start(
    port: number = DEFAULT_PORT,
    env: Record<string, string> = {},
  ): Promise<string> {
    // Start server in detached mode
    await this.sandbox.runCommand({
      cmd: "sandbox-agent",
      args: [
        "server",
        "--no-token",
        "--host",
        "0.0.0.0",
        "--port",
        String(port),
      ],
      env,
      detached: true,
    });

    const baseUrl = this.sandbox.domain(port);
    await this.waitForHealth(baseUrl);

    return baseUrl;
  }

  /**
   * Wait for the sandbox-agent server to become healthy.
   */
  private async waitForHealth(baseUrl: string): Promise<void> {
    for (let attempt = 1; attempt <= HEALTH_CHECK_RETRIES; attempt++) {
      try {
        const response = await fetch(`${baseUrl}/v1/health`);
        if (response.ok) return;
      } catch {
        // Server not ready yet
      }

      if (attempt < HEALTH_CHECK_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, HEALTH_CHECK_INTERVAL_MS),
        );
      }
    }

    throw new Error(
      `sandbox-agent server failed health check after ${HEALTH_CHECK_RETRIES} attempts at ${baseUrl}`,
    );
  }
}
