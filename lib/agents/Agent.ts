import type { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import type { AgentConfig, AgentResult } from "./types";

export abstract class Agent {
  constructor(protected commands: SandboxCommands) {}

  async execute(prompt: string, config: AgentConfig): Promise<AgentResult> {
    await this.install();
    await this.configure(config);

    const result = await this.run(prompt, config);

    const status = await this.commands.runInProject("git", [
      "status",
      "--porcelain",
    ]);

    return {
      ...result,
      changesDetected: status.stdout.trim().length > 0,
    };
  }

  protected abstract install(): Promise<void>;
  protected abstract configure(config: AgentConfig): Promise<void>;
  protected abstract run(
    prompt: string,
    config: AgentConfig,
  ): Promise<Omit<AgentResult, "changesDetected">>;
}
