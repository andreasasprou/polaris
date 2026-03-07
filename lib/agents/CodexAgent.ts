import { Agent } from "./Agent";
import type { AgentConfig, AgentResult } from "./types";

export class CodexAgent extends Agent {
  protected async install(): Promise<void> {
    const check = await this.commands.run("which", ["codex"], { cwd: "/" });
    if (check.exitCode === 0) return;

    const install = await this.commands.run(
      "npm",
      ["install", "-g", "@openai/codex"],
      { cwd: "/" },
    );

    if (install.exitCode !== 0) {
      throw new Error(`Failed to install Codex CLI: ${install.stderr}`);
    }
  }

  protected async configure(config: AgentConfig): Promise<void> {
    const model = config.model ?? "gpt-5.3-codex";
    const configToml = `model = "${model}"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n`;

    await this.commands.runShell(
      `mkdir -p $HOME/.codex && printf '%s' '${configToml}' > $HOME/.codex/config.toml`,
      { cwd: "/" },
    );

    // If apiKey is base64-encoded auth.json (ChatGPT OAuth), write it to ~/.codex/auth.json
    if (!config.apiKey.startsWith("sk-")) {
      await this.commands.runShell(
        `echo '${config.apiKey}' | base64 -d > $HOME/.codex/auth.json`,
        { cwd: "/" },
      );
    }
  }

  protected async run(
    prompt: string,
    config: AgentConfig,
  ): Promise<Omit<AgentResult, "changesDetected">> {
    const env: Record<string, string> = {
      ...(config.apiKey.startsWith("sk-")
        ? { OPENAI_API_KEY: config.apiKey }
        : {}),
      ...config.env,
    };

    const result = await this.commands.run(
      "codex",
      ["exec", "--dangerously-bypass-approvals-and-sandbox", prompt],
      { env },
    );

    return {
      success: result.exitCode === 0,
      output: result.stdout,
      errorOutput: result.stderr,
      error:
        result.exitCode !== 0
          ? `Codex CLI exited with code ${result.exitCode}`
          : undefined,
    };
  }
}
