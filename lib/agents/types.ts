export type AgentType = "claude" | "codex";

export type AgentConfig = {
  apiKey: string;
  model?: string;
  env?: Record<string, string>;
};

export type AgentResult = {
  success: boolean;
  output: string;
  errorOutput?: string;
  changesDetected: boolean;
  error?: string;
};
