import type { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import type { AgentType } from "./types";
import { Agent } from "./Agent";
import { ClaudeAgent } from "./ClaudeAgent";
import { CodexAgent } from "./CodexAgent";

export class AgentRegistry {
  static create(type: AgentType, commands: SandboxCommands): Agent {
    switch (type) {
      case "claude":
        return new ClaudeAgent(commands);
      case "codex":
        return new CodexAgent(commands);
      default:
        throw new Error(`Unknown agent type: ${type}`);
    }
  }
}
