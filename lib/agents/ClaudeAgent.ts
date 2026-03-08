import { Agent } from "./Agent";
import type { AgentConfig, AgentResult } from "./types";

export class ClaudeAgent extends Agent {
  protected async install(): Promise<void> {
    const check = await this.commands.run("which", ["claude"], { cwd: "/" });
    if (check.exitCode === 0) return;

    const install = await this.commands.runShell(
      "curl -fsSL https://claude.ai/install.sh | bash",
      { cwd: "/" },
    );

    if (install.exitCode !== 0) {
      throw new Error(`Failed to install Claude CLI: ${install.stderr}`);
    }
  }

  protected async configure(config: AgentConfig): Promise<void> {
    if (!config.model) return;

    const configJson = JSON.stringify({
      model: config.model,
    });

    await this.commands.runShell(
      `mkdir -p $HOME/.config/claude && echo '${configJson}' > $HOME/.config/claude/config.json`,
      { cwd: "/" },
    );
  }

  protected async run(
    prompt: string,
    config: AgentConfig,
  ): Promise<Omit<AgentResult, "changesDetected">> {
    // sk-ant-oat01- = OAuth token (consumer), sk-ant-api03- = API key
    const isOAuthToken = config.apiKey.startsWith("sk-ant-oat");
    const isApiKey = config.apiKey.startsWith("sk-ant-") && !isOAuthToken;

    const env: Record<string, string> = {
      ...(isApiKey
        ? { ANTHROPIC_API_KEY: config.apiKey }
        : { CLAUDE_CODE_OAUTH_TOKEN: config.apiKey }),
      ...config.env,
    };

    const result = await this.commands.run(
      "claude",
      [
        "-p",
        prompt,
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      { env },
    );

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      errorOutput: result.stderr,
      error:
        result.exitCode !== 0
          ? `Claude CLI exited with code ${result.exitCode}`
          : undefined,
    };
  }
}
