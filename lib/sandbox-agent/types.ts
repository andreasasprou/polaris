export type AgentType = "claude" | "codex" | "opencode" | "amp";

export type AgentConfig = {
  apiKey: string;
  model?: string;
  mode?: string;
  env?: Record<string, string>;
};

export type AgentResult = {
  success: boolean;
  output: string;
  errorOutput?: string;
  changesDetected: boolean;
  error?: string;
  stopReason?: string;
};
