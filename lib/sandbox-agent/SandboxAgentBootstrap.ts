import type { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import type { Sandbox } from "@vercel/sandbox";
import type { AgentType } from "./types";
import { buildSessionEnv } from "./credentials";

const SANDBOX_AGENT_VERSION = "0.3.2";
const DEFAULT_PORT = 2468;
const PROXY_PORT = 2469;

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
        && rm -rf /tmp/gh.tar.gz /tmp/gh_*
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
    // Use shell commands instead of sandbox.writeFiles() because the Vercel
    // Sandbox fs/write API uses tar extraction which rejects paths outside
    // the project directory (tar exits with code 2).
    if (cleaned.CODEX_AUTH_JSON_B64) {
      const result = await this.commands.runShell(
        "mkdir -p $HOME/.codex && echo \"$_CRED_B64\" | base64 -d > $HOME/.codex/auth.json && chmod 600 $HOME/.codex/auth.json",
        { cwd: "/", env: { _CRED_B64: cleaned.CODEX_AUTH_JSON_B64 } },
      );
      if (result.exitCode !== 0) {
        throw new Error(`Failed to provision codex credentials: ${result.stderr}`);
      }
      delete cleaned.CODEX_AUTH_JSON_B64;
    }

    return cleaned;
  }

  /**
   * Start the sandbox-agent server as a background process.
   * Returns the base URL for SDK connection.
   *
   * Health readiness is deferred to `SandboxAgent.connect({ waitForHealth })`
   * which the SDK handles with its own retry logic (30s timeout).
   */
  async start(
    port: number = DEFAULT_PORT,
    env: Record<string, string> = {},
  ): Promise<string> {
    // Start server in detached mode, wrapping in a shell to ensure $HOME/bin
    // (where gh CLI is installed) is on PATH for the server and child agents.
    await this.sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `export PATH="$HOME/bin:$PATH" && exec sandbox-agent server --no-token --host 0.0.0.0 --port ${port}`,
      ],
      env,
      detached: true,
    });

    return this.sandbox.domain(port);
  }

  // ── Proxy Installation & Start ──

  /**
   * Install the REST proxy into the sandbox.
   * Writes the bundled proxy.js file to /tmp/polaris-proxy.js.
   */
  async installProxy(proxyBundle: string): Promise<void> {
    // Write proxy bundle into the project directory via writeFiles API.
    // Path is relative to sandbox cwd (project root).
    await this.sandbox.writeFiles([
      { path: ".polaris-proxy.js", content: Buffer.from(proxyBundle) },
    ]);
  }

  /**
   * Start the REST proxy as a background process.
   * Returns the proxy base URL (e.g. https://sandbox-id.sbx.vercel.app:2469).
   *
   * Waits for the proxy to become healthy (GET /health returns {ok:true})
   * before returning. This prevents race conditions where the caller POSTs
   * to the proxy before it has bound to the port.
   *
   * Must be called after installProxy() and start() (agent server must be running).
   */
  async startProxy(
    env: Record<string, string> = {},
    port: number = PROXY_PORT,
  ): Promise<{ baseUrl: string; cmdId: string }> {
    const command = await this.sandbox.runCommand({
      cmd: "sh",
      args: [
        "-c",
        `exec node .polaris-proxy.js`,
      ],
      env: {
        ...env,
        PROXY_PORT: String(port),
      },
      detached: true,
    });

    const baseUrl = this.sandbox.domain(port);

    // Wait for proxy to become healthy before returning
    const maxAttempts = 30;
    const intervalMs = 500;
    for (let i = 0; i < maxAttempts; i++) {
      try {
        const res = await fetch(`${baseUrl}/health`, {
          signal: AbortSignal.timeout(2_000),
        });
        if (res.ok) {
          const body = await res.json().catch(() => null);
          if (body?.ok === true) return { baseUrl, cmdId: command.cmdId };
        }
      } catch {
        // Not ready yet
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }

    // Return URL anyway — caller will handle unhealthy proxy
    return { baseUrl, cmdId: command.cmdId };
  }
}
