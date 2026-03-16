import { eq, and, inArray, sql, isNull, notInArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { jobs, jobAttempts, jobEvents } from "./schema";
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
  const [row] = await db
    .insert(jobs)
    .values(input)
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
 */
export async function getActiveJobForSession(sessionId: string) {
  const terminalStatuses: JobStatus[] = ["completed", "failed_terminal", "cancelled"];
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
 * Count the number of attempts for a job (to decide retry vs terminal failure).
 */
export async function countAttempts(jobId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(jobAttempts)
    .where(eq(jobAttempts.jobId, jobId));
  return rows[0]?.count ?? 0;
}

// ── Epoch ──

/**
 * Atomically increment the session epoch and return the new value.
 * Used when creating/restoring a sandbox.
 */
export async function incrementEpoch(sessionId: string): Promise<number> {
  const [row] = await db
    .update(interactiveSessions)
    .set({ epoch: sql`epoch + 1` })
    .where(eq(interactiveSessions.id, sessionId))
    .returning({ epoch: interactiveSessions.epoch });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  return row.epoch;
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
        inArray(jobs.status, ["accepted", "running"]),
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
        sql`${jobs.updatedAt} < NOW() - INTERVAL '${sql.raw(String(olderThanMinutes))} minutes'`,
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
