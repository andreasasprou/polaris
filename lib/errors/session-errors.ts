import { SandboxUnreachableError } from "@/lib/sandbox/SandboxHealthMonitor";
import { PromptTimeoutError } from "@/lib/sandbox-agent/SandboxAgentClient";
import {
  type SessionErrorCode,
  type SessionPhase,
  type StructuredSessionError,
  ERROR_CATALOG,
} from "./session-error-types";

export type { SessionErrorCode, SessionPhase, StructuredSessionError };
export { SESSION_ERROR_CODES, SESSION_PHASES, PHASE_LABELS } from "./session-error-types";
export { parseSessionError } from "./session-error-types";

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
