/**
 * Session status model — single source of truth.
 *
 * Every consumer derives behavior from this config instead of
 * scattering ad-hoc `status === "foo"` checks across the codebase.
 *
 * Status lifecycle:
 *   creating → active → warm → suspended → hibernating → hibernated
 *   Any state → stopped | failed
 */

export const SESSION_STATUSES = [
  "creating",
  "active",
  "warm",
  "suspended",
  "hibernating",
  "hibernated",
  "idle",
  "stopped",
  "completed",
  "failed",
] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

// ── Capability flags per status ──
//
// Each flag answers a question the UI or API route needs to ask.
// Adding a new status forces you to define all its capabilities here
// (TypeScript will error on missing keys in the Record).

type StatusCapabilities = {
  /** Task process exists and is reachable via input stream. */
  hasLiveProcess: boolean;
  /** User can type and send a message. */
  canSend: boolean;
  /** How the message should be delivered. */
  sendPath: "stream" | "api" | null;
  /** Realtime subscription should be active (Trigger.dev SSE). */
  isLive: boolean;
  /**
   * How often to poll the API for status changes (ms). 0 = no polling.
   *
   * Fast polling (2s): provisioning states without realtime (creating, hibernating).
   * Slow polling (30s): live states as a safety net when realtime fails.
   * No polling (0): terminal states, hibernated/idle (no expected transitions).
   */
  pollIntervalMs: number;
  /** User can click the stop button. */
  canStop: boolean;
  /** Session is in a terminal state (no further transitions). */
  isTerminal: boolean;
};

export const STATUS_CONFIG: Record<SessionStatus, StatusCapabilities> = {
  creating: {
    hasLiveProcess: false,
    canSend: false,
    sendPath: null,
    isLive: true,
    pollIntervalMs: 2_000,   // Fast — no realtime yet, waiting for provisioning
    canStop: false,
    isTerminal: false,
  },
  active: {
    hasLiveProcess: true,
    canSend: true,
    sendPath: "stream",
    isLive: true,
    pollIntervalMs: 30_000,  // Slow safety net — realtime is primary
    canStop: true,
    isTerminal: false,
  },
  warm: {
    hasLiveProcess: true,
    canSend: true,
    sendPath: "stream",
    isLive: true,
    pollIntervalMs: 30_000,  // Slow safety net — realtime is primary
    canStop: true,
    isTerminal: false,
  },
  suspended: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",         // Must go via API route for proper resume
    isLive: true,
    pollIntervalMs: 30_000,  // Slow safety net — also used dynamically when pendingPrompt is set
    canStop: true,
    isTerminal: false,
  },
  hibernating: {
    hasLiveProcess: false,
    canSend: false,
    sendPath: null,
    isLive: false,
    pollIntervalMs: 2_000,   // Fast — transient state, waiting for snapshot
    canStop: false,
    isTerminal: false,
  },
  hibernated: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",
    isLive: false,
    pollIntervalMs: 0,       // Stable — no expected transitions
    canStop: false,
    isTerminal: false,
  },
  idle: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",
    isLive: false,
    pollIntervalMs: 0,       // Stable — no expected transitions
    canStop: false,
    isTerminal: false,
  },
  // canSend is true for stopped/completed so users can send a follow-up
  // message, which triggers a new run (resume from checkpoint or cold start).
  stopped: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",
    isLive: false,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
  completed: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",
    isLive: false,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
  failed: {
    hasLiveProcess: false,
    canSend: true,
    sendPath: "api",
    isLive: false,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
};

/** Get capabilities for a status string. Falls back to safe defaults for unknown statuses. */
export function getStatusConfig(status: string): StatusCapabilities {
  return STATUS_CONFIG[status as SessionStatus] ?? STATUS_CONFIG.failed;
}

// ── Trigger.dev run status helpers ──

/** Session statuses where the DB claims a Trigger.dev task process is alive. */
export const LIVE_SESSION_STATUSES: string[] = ["active", "warm", "suspended"];

/** Trigger.dev run statuses that mean the task process is gone. */
export const RUN_TERMINAL_STATUSES = new Set([
  "COMPLETED", "CANCELED", "FAILED", "CRASHED",
  "SYSTEM_FAILURE", "TIMED_OUT", "EXPIRED",
]);

