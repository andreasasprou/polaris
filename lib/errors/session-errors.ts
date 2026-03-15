import { SandboxUnreachableError } from "@/lib/sandbox/SandboxHealthMonitor";
import { PromptTimeoutError } from "@/lib/sandbox-agent/SandboxAgentClient";

// ── Error Codes ──

export const SESSION_ERROR_CODES = {
  SANDBOX_CREATE_FAILED: "SANDBOX_CREATE_FAILED",
  SANDBOX_CLONE_FAILED: "SANDBOX_CLONE_FAILED",
  AGENT_INSTALL_FAILED: "AGENT_INSTALL_FAILED",
  CREDENTIAL_PROVISION_FAILED: "CREDENTIAL_PROVISION_FAILED",
  AGENT_SERVER_HEALTH_FAILED: "AGENT_SERVER_HEALTH_FAILED",
  SANDBOX_UNREACHABLE: "SANDBOX_UNREACHABLE",
  PROMPT_TIMEOUT: "PROMPT_TIMEOUT",
  GITHUB_TOKEN_FAILED: "GITHUB_TOKEN_FAILED",
  SESSION_TERMINATED: "SESSION_TERMINATED",
  UNKNOWN: "UNKNOWN",
} as const;

export type SessionErrorCode =
  (typeof SESSION_ERROR_CODES)[keyof typeof SESSION_ERROR_CODES];

// ── Phases ──

export const SESSION_PHASES = {
  initialization: "initialization",
  github_auth: "github_auth",
  environment_setup: "environment_setup",
  sandbox_creation: "sandbox_creation",
  snapshot_restore: "snapshot_restore",
  sandbox_reconnect: "sandbox_reconnect",
  agent_bootstrap: "agent_bootstrap",
  agent_operation: "agent_operation",
  unknown: "unknown",
} as const;

export type SessionPhase =
  (typeof SESSION_PHASES)[keyof typeof SESSION_PHASES];

export const PHASE_LABELS: Record<SessionPhase, string> = {
  initialization: "Initialization",
  github_auth: "GitHub authentication",
  environment_setup: "Environment setup",
  sandbox_creation: "Sandbox creation",
  snapshot_restore: "Restoring from snapshot",
  sandbox_reconnect: "Reconnecting to sandbox",
  agent_bootstrap: "Agent setup",
  agent_operation: "Agent operation",
  unknown: "Session",
};

// ── Structured Error Shape ──

export type StructuredSessionError = {
  code: SessionErrorCode;
  category: "permanent" | "transient";
  phase: SessionPhase;
  message: string;
  detail?: string;
  recoveryHint?: string;
};

// ── Error Catalog ──

const ERROR_CATALOG: Record<
  SessionErrorCode,
  { category: "permanent" | "transient"; message: string; recoveryHint: string }
> = {
  SANDBOX_CREATE_FAILED: {
    category: "permanent",
    message: "Failed to create the development environment.",
    recoveryHint:
      "Check your Vercel integration settings or try creating a new session.",
  },
  SANDBOX_CLONE_FAILED: {
    category: "permanent",
    message: "Failed to clone the repository into the sandbox.",
    recoveryHint:
      "Check that the repository exists and the GitHub App has access.",
  },
  AGENT_INSTALL_FAILED: {
    category: "transient",
    message: "Failed to install the coding agent.",
    recoveryHint: "This may be a temporary issue. Try creating a new session.",
  },
  CREDENTIAL_PROVISION_FAILED: {
    category: "permanent",
    message: "Failed to set up agent credentials.",
    recoveryHint:
      "Check that the agent API key is configured correctly in settings.",
  },
  AGENT_SERVER_HEALTH_FAILED: {
    category: "transient",
    message: "The agent server failed to start.",
    recoveryHint: "Try creating a new session.",
  },
  SANDBOX_UNREACHABLE: {
    category: "transient",
    message: "The agent's development environment became unreachable.",
    recoveryHint:
      "The sandbox may have been terminated. Try resuming the session.",
  },
  PROMPT_TIMEOUT: {
    category: "transient",
    message: "The agent took too long to respond.",
    recoveryHint: "Try sending a shorter or simpler prompt.",
  },
  GITHUB_TOKEN_FAILED: {
    category: "permanent",
    message: "Failed to authenticate with GitHub.",
    recoveryHint:
      "Check that the GitHub App is installed on this repository.",
  },
  SESSION_TERMINATED: {
    category: "transient",
    message: "Session ended unexpectedly due to a platform issue.",
    recoveryHint: "Try sending a new message to restart the session.",
  },
  UNKNOWN: {
    category: "transient",
    message: "An unexpected error occurred.",
    recoveryHint: "Try sending a new message to restart the session.",
  },
};

// ── SessionError Class ──

export class SessionError extends Error {
  constructor(
    public readonly code: SessionErrorCode,
    public readonly phase: SessionPhase,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SessionError";
  }
}

// ── Classification ──

/**
 * Classify any thrown error into a StructuredSessionError.
 *
 * Priority:
 *  1. SessionError (typed, thrown from owned code)
 *  2. Known error classes (SandboxUnreachableError, PromptTimeoutError)
 *  3. Regex heuristics for third-party/unknown errors
 *  4. Default: UNKNOWN
 */
export function toStructuredError(
  error: unknown,
  fallbackPhase: SessionPhase,
): StructuredSessionError {
  const rawMessage =
    error instanceof Error ? error.message : String(error);

  // 1. Typed SessionError from owned code
  if (error instanceof SessionError) {
    const catalog = ERROR_CATALOG[error.code];
    return {
      code: error.code,
      category: catalog.category,
      phase: error.phase,
      message: catalog.message,
      detail: rawMessage,
      recoveryHint: catalog.recoveryHint,
    };
  }

  // 2. Known error classes
  if (error instanceof SandboxUnreachableError) {
    return buildFromCatalog("SANDBOX_UNREACHABLE", fallbackPhase, rawMessage);
  }
  if (error instanceof PromptTimeoutError) {
    return buildFromCatalog("PROMPT_TIMEOUT", fallbackPhase, rawMessage);
  }

  // 3. Regex heuristics for third-party errors
  const code = classifyByMessage(rawMessage);
  if (code) {
    return buildFromCatalog(code, fallbackPhase, rawMessage);
  }

  // 4. Default
  return buildFromCatalog("UNKNOWN", fallbackPhase, rawMessage);
}

function classifyByMessage(message: string): SessionErrorCode | null {
  // HTTP 4xx from Vercel Sandbox API — permanent client errors
  if (/Status code 4\d{2}/i.test(message)) return "SANDBOX_CREATE_FAILED";
  // HTTP 5xx — transient server errors
  if (/Status code 5\d{2}/i.test(message)) return "SANDBOX_CREATE_FAILED";
  if (/failed to clone/i.test(message)) return "SANDBOX_CLONE_FAILED";
  if (/failed to install sandbox-agent/i.test(message))
    return "AGENT_INSTALL_FAILED";
  if (/failed to install agent/i.test(message)) return "AGENT_INSTALL_FAILED";
  if (/failed to provision/i.test(message))
    return "CREDENTIAL_PROVISION_FAILED";
  if (/health check/i.test(message)) return "AGENT_SERVER_HEALTH_FAILED";
  return null;
}

function buildFromCatalog(
  code: SessionErrorCode,
  phase: SessionPhase,
  detail: string,
): StructuredSessionError {
  const catalog = ERROR_CATALOG[code];
  return {
    code,
    category: catalog.category,
    phase,
    message: catalog.message,
    detail,
    recoveryHint: catalog.recoveryHint,
  };
}

// ── Serialization ──

export function serializeSessionError(err: StructuredSessionError): string {
  return JSON.stringify(err);
}

/**
 * Parse a session error from the DB `error` text column.
 * Handles both structured JSON (new) and legacy plain strings (old).
 */
export function parseSessionError(
  raw: string | null,
): StructuredSessionError | null {
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    // Validate it has the expected shape
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.code === "string" &&
      typeof parsed.message === "string"
    ) {
      return parsed as StructuredSessionError;
    }
  } catch {
    // Not JSON — legacy plain string
  }

  // Wrap legacy string as UNKNOWN
  return {
    code: "UNKNOWN",
    category: "transient",
    phase: "unknown",
    message: raw,
    detail: raw,
    recoveryHint: "Try sending a new message to restart the session.",
  };
}
