/**
 * Shared types and constants for session errors.
 * This file has NO server-only imports and is safe for client components.
 */

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

export const ERROR_CATALOG: Record<
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

// ── Parsing (safe for client) ──

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
