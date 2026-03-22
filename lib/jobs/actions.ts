import { eq, and, asc, desc, inArray, sql, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { jobs, jobAttempts, jobEvents, callbackInbox } from "./schema";
import type { JobStatus, AttemptStatus, JobType, JobEventType } from "./status";

// ── Jobs ──

export async function createJob(input: {
  organizationId: string;
  type: JobType;
  sessionId?: string;
  automationId?: string;
  automationRunId?: string;
  requestId?: string;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  timeoutSeconds?: number;
  hmacKey?: string;
}) {
  const timeoutAt = input.timeoutSeconds != null
    ? new Date(Date.now() + input.timeoutSeconds * 1000)
    : undefined;
  const [row] = await db
    .insert(jobs)
    .values({ ...input, timeoutAt })
    .onConflictDoNothing() // Idempotent by (session_id, request_id)
    .returning();
  return row ?? null;
}

export async function getJob(jobId: string) {
  const [row] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1);
  return row ?? null;
}

/**
 * Compare-and-set job status transition. Returns the updated row if the CAS
 * succeeds, or null if the current status didn't match.
 */
export async function casJobStatus(
  jobId: string,
  fromStatuses: JobStatus[],
  toStatus: JobStatus,
  extra?: Partial<{
    result: Record<string, unknown>;
    sideEffectsCompleted: Record<string, unknown>;
    timeoutAt: Date | null;
    updatedAt: Date;
  }>,
) {
  const [row] = await db
    .update(jobs)
    .set({
      status: toStatus,
      updatedAt: new Date(),
      ...extra,
    })
    .where(
      and(
        eq(jobs.id, jobId),
        inArray(jobs.status, fromStatuses),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Get the active (non-terminal) job for a session.
 * failed_retryable is treated as terminal here because the session
 * has already been healed to idle — the sweeper handles retry.
 */
export async function getActiveJobForSession(sessionId: string) {
  const terminalStatuses: JobStatus[] = ["completed", "failed_terminal", "failed_retryable", "cancelled"];
  const [row] = await db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.sessionId, sessionId),
        notInArray(jobs.status, terminalStatuses),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Job Attempts ──

export async function createJobAttempt(input: {
  jobId: string;
  attemptNumber: number;
  epoch: number;
  sandboxId?: string;
  resolvedSecretId?: string;
}) {
  const [row] = await db
    .insert(jobAttempts)
    .values(input)
    .returning();
  return row;
}

export async function getActiveAttempt(jobId: string) {
  const [row] = await db
    .select()
    .from(jobAttempts)
    .where(
      and(
        eq(jobAttempts.jobId, jobId),
        notInArray(jobAttempts.status, ["completed", "failed"]),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getAttempt(attemptId: string) {
  const [row] = await db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.id, attemptId))
    .limit(1);
  return row ?? null;
}

/**
 * Compare-and-set attempt status transition.
 */
export async function casAttemptStatus(
  attemptId: string,
  fromStatuses: AttemptStatus[],
  toStatus: AttemptStatus,
  extra?: Partial<{
    resultPayload: Record<string, unknown>;
    error: string;
    acceptedAt: Date;
    startedAt: Date;
    completedAt: Date;
    lastProgressAt: Date;
  }>,
) {
  const [row] = await db
    .update(jobAttempts)
    .set({
      status: toStatus,
      ...extra,
    })
    .where(
      and(
        eq(jobAttempts.id, attemptId),
        inArray(jobAttempts.status, fromStatuses),
      ),
    )
    .returning();
  return row ?? null;
}

/**
 * Touch the attempt's lastProgressAt timestamp (liveness heartbeat).
 * Does NOT require a status transition — used for session_events callbacks.
 */
export async function touchAttemptProgress(attemptId: string): Promise<void> {
  await db
    .update(jobAttempts)
    .set({ lastProgressAt: new Date() })
    .where(eq(jobAttempts.id, attemptId));
}

/**
 * Get jobs in accepted/running status whose latest attempt hasn't reported
 * progress for longer than the staleness threshold.
 */
export async function getStaleRunningJobs(staleMinutes: number = 5) {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["accepted", "running"]),
        sql`EXISTS (
          SELECT 1 FROM job_attempts ja
          WHERE ja.job_id = ${jobs.id}
          AND ja.last_progress_at IS NOT NULL
          AND ja.last_progress_at < NOW() - (${staleMinutes} * INTERVAL '1 minute')
          AND ja.status NOT IN ('waiting_human')
          AND ja.attempt_number = (
            SELECT MAX(ja2.attempt_number) FROM job_attempts ja2
            WHERE ja2.job_id = ${jobs.id}
          )
        )`,
        // Exclude jobs already past their hard timeout (handled by sweepTimedOutJobs)
        sql`(${jobs.timeoutAt} IS NULL OR ${jobs.timeoutAt} > NOW())`,
      ),
    );
}

/**
 * Count the number of attempts for a job (to decide retry vs terminal failure).
 */
export async function countAttempts(jobId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId));
  return rows[0]?.count ?? 0;
}

// ── Job Events ──

/**
 * Append an event to the job audit log. Fire-and-forget — failures are logged
 * but do not block the caller.
 */
export async function appendJobEvent(
  jobId: string,
  eventType: JobEventType,
  attemptId?: string,
  payload?: Record<string, unknown>,
) {
  const [row] = await db
    .insert(jobEvents)
    .values({
      jobId,
      attemptId,
      eventType,
      payload: payload ?? {},
    })
    .returning();
  return row;
}

// ── Queries ──

/**
 * Get jobs that have timed out (past timeout_at while in an active status).
 */
export async function getTimedOutJobs() {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        inArray(jobs.status, ["pending", "accepted", "running"]),
        sql`${jobs.timeoutAt} < NOW()`,
      ),
    );
}

/**
 * Get jobs eligible for retry.
 */
export async function getRetryableJobs() {
  return db
    .select()
    .from(jobs)
    .where(eq(jobs.status, "failed_retryable"));
}

/**
 * Get jobs stuck in postprocess_pending.
 */
export async function getStuckPostprocessJobs(olderThanMinutes: number = 2) {
  return db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "postprocess_pending"),
        sql`${jobs.updatedAt} < NOW() - (${olderThanMinutes} * INTERVAL '1 minute')`,
      ),
    );
}

/**
 * Get attempts in dispatch_unknown status (for sweeper reconciliation).
 */
export async function getDispatchUnknownAttempts() {
  return db
    .select({
      attempt: jobAttempts,
      job: jobs,
    })
    .from(jobAttempts)
    .innerJoin(jobs, eq(jobAttempts.jobId, jobs.id))
    .where(eq(jobAttempts.status, "dispatch_unknown"));
}

/**
 * Get all attempts for a job (ordered by attempt number).
 */
export async function getAttemptsByJob(jobId: string) {
  return db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId))
    .orderBy(asc(jobAttempts.attemptNumber));
}

// ── Org-scoped queries (for API endpoints) ──

/**
 * Get a job by ID, scoped to an organization. Returns null if not found or wrong org.
 */
export async function getJobForOrg(jobId: string, orgId: string) {
  const [row] = await db
    .select({
      id: jobs.id,
      type: jobs.type,
      status: jobs.status,
      sessionId: jobs.sessionId,
      automationId: jobs.automationId,
      automationRunId: jobs.automationRunId,
      requestId: jobs.requestId,
      maxAttempts: jobs.maxAttempts,
      timeoutSeconds: jobs.timeoutSeconds,
      result: jobs.result,
      sideEffectsCompleted: jobs.sideEffectsCompleted,
      createdAt: jobs.createdAt,
      updatedAt: jobs.updatedAt,
      timeoutAt: jobs.timeoutAt,
    })
    .from(jobs)
    .where(and(eq(jobs.id, jobId), eq(jobs.organizationId, orgId)))
    .limit(1);
  return row ?? null;
}

/**
 * Get all attempts for a job, ordered by attempt number.
 */
export async function getJobAttempts(jobId: string) {
  return db
    .select()
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId))
    .orderBy(asc(jobAttempts.attemptNumber));
}

/**
 * Get all events for a job, ordered chronologically.
 */
export async function getJobEvents(jobId: string) {
  return db
    .select()
    .from(jobEvents)
    .where(eq(jobEvents.jobId, jobId))
    .orderBy(asc(jobEvents.createdAt));
}

/**
 * Get all callbacks for a job, ordered by receive time.
 * Excludes raw payload to avoid returning large data.
 */
export async function getJobCallbacks(jobId: string) {
  return db
    .select({
      id: callbackInbox.id,
      callbackType: callbackInbox.callbackType,
      processed: callbackInbox.processed,
      processedAt: callbackInbox.processedAt,
      processError: callbackInbox.processError,
      receivedAt: callbackInbox.receivedAt,
    })
    .from(callbackInbox)
    .where(eq(callbackInbox.jobId, jobId))
    .orderBy(asc(callbackInbox.receivedAt));
}
