/**
 * Job & attempt status model — single source of truth.
 *
 * Job status lifecycle:
 *   pending → accepted → running → agent_completed → postprocess_pending → completed
 *   Any → failed_retryable → pending (retry with new attempt)
 *   Any → failed_terminal | cancelled
 */

// ── Job Statuses ──

export const JOB_STATUSES = [
  "pending",
  "accepted",
  "running",
  "agent_completed",
  "postprocess_pending",
  "completed",
  "failed_retryable",
  "failed_terminal",
  "cancelled",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  "completed",
  "failed_terminal",
  "cancelled",
]);

export const JOB_ACTIVE_STATUSES: ReadonlySet<JobStatus> = new Set([
  "pending",
  "accepted",
  "running",
  "agent_completed",
  "postprocess_pending",
  "failed_retryable",
]);

/** Valid job status transitions. Key = from, Value = allowed "to" statuses. */
export const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ["accepted", "failed_retryable", "failed_terminal", "cancelled"],
  accepted: ["running", "failed_retryable", "failed_terminal", "cancelled"],
  running: ["agent_completed", "failed_retryable", "failed_terminal", "cancelled"],
  agent_completed: ["postprocess_pending", "failed_terminal", "cancelled"],
  postprocess_pending: ["completed", "postprocess_pending", "failed_terminal", "cancelled"],
  completed: [],
  failed_retryable: ["pending", "failed_terminal", "cancelled"],
  failed_terminal: [],
  cancelled: [],
};

// ── Attempt Statuses ──

export const ATTEMPT_STATUSES = [
  "dispatching",
  "dispatch_unknown",
  "accepted",
  "running",
  "waiting_human",
  "completed",
  "failed",
] as const;

export type AttemptStatus = (typeof ATTEMPT_STATUSES)[number];

export const ATTEMPT_TERMINAL_STATUSES: ReadonlySet<AttemptStatus> = new Set([
  "completed",
  "failed",
]);

/** Valid attempt status transitions. */
export const ATTEMPT_TRANSITIONS: Record<AttemptStatus, readonly AttemptStatus[]> = {
  dispatching: ["accepted", "dispatch_unknown", "failed"],
  dispatch_unknown: ["accepted", "failed"],
  accepted: ["running", "failed"],
  running: ["waiting_human", "completed", "failed"],
  waiting_human: ["running", "completed", "failed"],
  completed: [],
  failed: [],
};

// ── Helpers ──

export function isJobTerminal(status: string): boolean {
  return JOB_TERMINAL_STATUSES.has(status as JobStatus);
}

export function isAttemptTerminal(status: string): boolean {
  return ATTEMPT_TERMINAL_STATUSES.has(status as AttemptStatus);
}

export function isValidJobTransition(from: string, to: string): boolean {
  const allowed = JOB_TRANSITIONS[from as JobStatus];
  return allowed ? allowed.includes(to as JobStatus) : false;
}

export function isValidAttemptTransition(from: string, to: string): boolean {
  const allowed = ATTEMPT_TRANSITIONS[from as AttemptStatus];
  return allowed ? allowed.includes(to as AttemptStatus) : false;
}

// ── Callback Types ──

export const CALLBACK_TYPES = [
  "prompt_accepted",
  "prompt_complete",
  "prompt_failed",
  "permission_requested",
  "question_requested",
  "permission_resumed",
] as const;

export type CallbackType = (typeof CALLBACK_TYPES)[number];

// ── Job Types ──

export const JOB_TYPES = [
  "prompt",
  "review",
  "coding_task",
  "snapshot",
  "pr_create",
] as const;

export type JobType = (typeof JOB_TYPES)[number];

// ── Job Event Types ──

export const JOB_EVENT_TYPES = [
  "created",
  "dispatched",
  "dispatch_unknown",
  "accepted",
  "running",
  "waiting_human",
  "resumed",
  "agent_completed",
  "postprocess_started",
  "postprocess_failed",
  "completed",
  "failed",
  "cancelled",
  "timeout",
] as const;

export type JobEventType = (typeof JOB_EVENT_TYPES)[number];
