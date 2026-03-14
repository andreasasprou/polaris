import type { Sandbox, CommandResult } from "./types";

export class SandboxCommands {
  constructor(
    private sandbox: Sandbox,
    private projectDir: string,
  ) {}

  async run(
    cmd: string,
    args: string[] = [],
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    const result = await this.sandbox.runCommand({
      cmd,
      args,
      cwd: opts?.cwd ?? this.projectDir,
      env: opts?.env,
    });

    return {
      exitCode: result.exitCode,
      stdout: await result.stdout(),
      stderr: await result.stderr(),
    };
  }

  async runInProject(cmd: string, args: string[] = []): Promise<CommandResult> {
    return this.run(cmd, args, { cwd: this.projectDir });
  }

  async runShell(
    script: string,
    opts?: { cwd?: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    return this.run("sh", ["-c", script], opts);
  }
}
