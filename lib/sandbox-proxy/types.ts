/**
 * Sandbox REST Proxy — Shared Types
 *
 * These types define the protocol between the proxy (running inside the sandbox)
 * and the Polaris API. They mirror the frozen contract in
 * docs/architecture/v2-protocol-contract.md but are standalone — the proxy
 * has no access to the Polaris codebase at runtime.
 */

// ── Agent Config ──

export type AgentType = "claude" | "codex" | "opencode" | "amp";

export type PromptConfig = {
  agent: AgentType;
  mode?: string;
  model?: string;
  effortLevel?: string;
  modeIntent?: "autonomous" | "read-only" | "interactive";
  sdkSessionId?: string;
  nativeAgentSessionId?: string;
  branch?: string;
  cwd?: string;
  env?: Record<string, string>;
  nextEventIndex?: number;
  mcpServers?: Array<{
    url: string;
    transport?: "streamable-http" | "sse";
    headers?: Record<string, string>;
  }>;
};

// ── Prompt Request (POST /prompt body) ──

export type ContextFile = {
  /** Absolute path in the sandbox filesystem */
  path: string;
  /** File content (text) */
  content: string;
};

export type PromptAttachment = {
  /** Original filename (e.g. "screenshot.png") */
  name: string;
  /** MIME type (e.g. "image/png") */
  mimeType: string;
  /** base64-encoded binary content */
  data: string;
};

export type PromptRequest = {
  jobId: string;
  attemptId: string;
  epoch: number;
  prompt: string;
  callbackUrl: string;
  hmacKey: string;
  config: PromptConfig;
  /** Original request ID from the API — used as end-to-end trace key */
  requestId?: string;
  /** Files to write to the sandbox before starting the agent */
  contextFiles?: ContextFile[];
  /** Binary attachments (images, PDFs) to upload and reference in the prompt */
  attachments?: PromptAttachment[];
};

// ── Active Prompt (persisted to local file for durable accept) ──

export type ActivePrompt = {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackUrl: string;
  hmacKey: string;
  config: PromptConfig;
  startedAt: string;
};

// ── Callback Types ──

export type CallbackType =
  | "prompt_accepted"
  | "prompt_complete"
  | "prompt_failed"
  | "permission_requested"
  | "question_requested"
  | "permission_resumed"
  | "session_events";

export type CallbackBody = {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackId: string;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
};

// ── Outbox Entry (persisted to local filesystem) ──

export type OutboxEntryStatus = "pending" | "delivered" | "failed";

export type OutboxEntry = {
  callbackId: string;
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
  status: OutboxEntryStatus;
  attempts: number;
  lastAttemptAt?: string;
  createdAt: string;
};

// ── Proxy State ──

export type ProxyState = "idle" | "running" | "stopping";

export type ProxyStatus = {
  state: ProxyState;
  jobId?: string;
  attemptId?: string;
  epoch?: number;
  startedAt?: string;
  agentPid?: number;
};

// ── Agent Session Interface ──
// Minimal interface satisfied by both SDK sessions and NativeResumedSession.

export type PromptContentPart =
  | { type: "text"; text: string }
  | { type: "resource_link"; name: string; uri: string; mimeType: string };

export type AgentEvent = {
  eventIndex: number;
  sender: string;
  payload: Record<string, unknown>;
};

export type AgentSession = {
  id: string;
  agentSessionId: string;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  prompt(prompt: PromptContentPart[]): Promise<{ stopReason?: string }>;
  rawSend(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

// ── Proxy Metrics (embedded in prompt_complete/prompt_failed callbacks) ──

export type CallbackDeliveryMetric = {
  type: CallbackType;
  deliveryMs: number;
  attempts: number;
  success: boolean;
};

export type ProxyMetrics = {
  connectMs?: number;
  sessionCreateMs?: number;
  promptExecutionMs?: number;
  totalMs: number;
  resumeType?: "native" | "text_replay" | "fresh";
  callbackDeliveries: CallbackDeliveryMetric[];
  healthChecks: { total: number; failed: number };
  eventCount: number;
};
