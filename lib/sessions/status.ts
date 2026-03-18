/**
 * Session status model — single source of truth.
 *
 * Every consumer derives behavior from this config instead of
 * scattering ad-hoc `status === "foo"` checks across the codebase.
 *
 * v2 Status lifecycle:
 *   creating → idle → active → idle → snapshotting → hibernated
 *   hibernated/stopped/failed → (restore/create) → idle
 *   active → idle (on prompt_complete/prompt_failed callback, or sweeper healing)
 *   Any state → stopped | failed
 */

export const SESSION_STATUSES = [
  "creating",
  "active",
  "idle",
  "snapshotting",
  "hibernated",
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
  /** User can type and send a message. */
  canSend: boolean;
  /**
   * How often to poll the API for status changes (ms). 0 = no polling.
   *
   * Fast polling (2s): transient states (creating, active, snapshotting).
   * No polling (0): stable states (idle, hibernated, terminal).
   */
  pollIntervalMs: number;
  /** User can click the stop button. */
  canStop: boolean;
  /** Session is in a terminal state (no further transitions). */
  isTerminal: boolean;
};

export const STATUS_CONFIG: Record<SessionStatus, StatusCapabilities> = {
  creating: {
    canSend: false,
    pollIntervalMs: 2_000,   // Fast — waiting for sandbox provisioning
    canStop: false,
    isTerminal: false,
  },
  active: {
    canSend: false,          // Busy — prompt is running
    pollIntervalMs: 2_000,   // Fast — waiting for prompt completion
    canStop: true,
    isTerminal: false,
  },
  idle: {
    canSend: true,
    pollIntervalMs: 0,       // Stable — sandbox alive, no prompt running
    canStop: false,
    isTerminal: false,
  },
  snapshotting: {
    canSend: false,
    pollIntervalMs: 2_000,   // Fast — transient, waiting for snapshot
    canStop: false,
    isTerminal: false,
  },
  hibernated: {
    canSend: true,           // Will restore sandbox on send
    pollIntervalMs: 0,       // Stable
    canStop: false,
    isTerminal: false,
  },
  // canSend is true for stopped/completed/failed so users can send a follow-up
  // message, which triggers a new sandbox (resume from snapshot or fresh start).
  stopped: {
    canSend: true,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
  completed: {
    canSend: true,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
  failed: {
    canSend: true,
    pollIntervalMs: 0,
    canStop: false,
    isTerminal: true,
  },
};

/** Get capabilities for a status string. Falls back to safe defaults for unknown statuses. */
export function getStatusConfig(status: string): StatusCapabilities {
  return STATUS_CONFIG[status as SessionStatus] ?? STATUS_CONFIG.failed;
}
