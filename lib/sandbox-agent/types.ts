export type AgentType = "claude" | "codex" | "opencode" | "amp";

export const VALID_AGENT_TYPES: readonly AgentType[] = ["claude", "codex", "opencode", "amp"] as const;

export function isValidAgentType(value: unknown): value is AgentType {
  return typeof value === "string" && (VALID_AGENT_TYPES as readonly string[]).includes(value);
}

/** Typed model parameters stored as JSONB on persisted runtime configs. */
export type ModelParams = {
  effortLevel?: import("./agent-profiles").EffortLevel;
};

export type AgentConfig = {
  apiKey: string;
  model?: string;
  mode?: string;
  env?: Record<string, string>;
};

export type AgentResult = {
  success: boolean;
  output: string;
  /** The last agent message (after final tool call). Useful for review output. */
  lastMessage?: string;
  errorOutput?: string;
  changesDetected: boolean;
  error?: string;
  stopReason?: string;
};
