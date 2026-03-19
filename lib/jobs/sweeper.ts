/**
 * Job Sweeper — Recovery & Lifecycle Management
 *
 * Runs via Vercel Cron (every 2 min). Uses Postgres advisory lock
 * to prevent concurrent sweeps.
 *
 * Responsibilities:
 * - Timed-out jobs → failed_terminal + heal session
 * - dispatch_unknown attempts → probe sandbox GET /status, reconcile
 * - Stuck postprocess_pending → retry
 * - Stale active sessions (no nonterminal job) → idle
 * - Stale review locks (terminal/missing job) → release
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  getTimedOutJobs,
  getRetryableJobs,
  getStuckPostprocessJobs,
  getDispatchUnknownAttempts,
  casJobStatus,
  casAttemptStatus,
  appendJobEvent,
} from "./actions";
import { runPostProcessing } from "./postprocess";
import { useLogger } from "@/lib/evlog";

const SWEEPER_LOCK_ID = 42_000_001; // Arbitrary advisory lock ID

/**
 * Run a full sweep cycle. Acquires advisory lock first.
 */
export async function runSweep(): Promise<{
  timedOut: number;
  unknownReconciled: number;
  postprocessRetried: number;
  staleSessionsHealed: number;
  staleLocksReleased: number;
}> {
  const log = useLogger();

  // Try advisory lock — skip if another sweep is running
  const lockRows = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SWEEPER_LOCK_ID}) AS acquired`,
  );
  const lockResult = lockRows.rows?.[0] as { acquired: boolean } | undefined;

  if (!lockResult?.acquired) {
    log.set({ sweep: { skipped: true, reason: "lock_held" } });
    return {
      timedOut: 0,
      unknownReconciled: 0,
      postprocessRetried: 0,
      staleSessionsHealed: 0,
      staleLocksReleased: 0,
    };
  }

  try {
    const timedOut = await sweepTimedOutJobs();
    const unknownReconciled = await sweepDispatchUnknown();
    const postprocessRetried = await sweepStuckPostprocess();
    const staleSessionsHealed = await sweepStaleActiveSessions();
    const staleLocksReleased = await sweepStaleReviewLocks();

    log.set({ sweep: { timedOut, unknownReconciled, postprocessRetried, staleSessionsHealed, staleLocksReleased } });

    return {
      timedOut,
      unknownReconciled,
      postprocessRetried,
      staleSessionsHealed,
      staleLocksReleased,
    };
  } finally {
    // Release advisory lock
    await db.execute(
      sql`SELECT pg_advisory_unlock(${SWEEPER_LOCK_ID})`,
    );
  }
}

/**
 * Mark timed-out jobs as failed_terminal and heal their sessions.
 */
async function sweepTimedOutJobs(): Promise<number> {
  const log = useLogger();
  const jobs = await getTimedOutJobs();
  let count = 0;

  for (const job of jobs) {
    const updated = await casJobStatus(
      job.id,
      ["pending", "accepted", "running"],
      "failed_terminal",
    );
    if (updated) {
      await appendJobEvent(job.id, "timeout", undefined, {
        reason: "sweeper_timeout",
      });
      count++;
      log.set({ sweep: { [`timedOut_${job.id}`]: true } });

      // Heal session: active → idle so next dispatch can proceed
      if (job.sessionId) {
        try {
          const { casSessionStatus } = await import("@/lib/sessions/actions");
          await casSessionStatus(job.sessionId, ["active"], "idle");
        } catch {
          // Best-effort
        }
      }
    }
  }

  return count;
}

/**
 * Reconcile dispatch_unknown attempts by probing sandbox status.
 */
async function sweepDispatchUnknown(): Promise<number> {
  const log = useLogger();
  const rows = await getDispatchUnknownAttempts();
  let count = 0;

  for (const { attempt, job } of rows) {
    // Try to probe sandbox proxy status
    const sandboxId = attempt.sandboxId;
    if (!sandboxId) {
      // No sandbox — mark as failed
      await casAttemptStatus(attempt.id, ["dispatch_unknown"], "failed", {
        error: "No sandbox ID for reconciliation",
      });
      await casJobStatus(job.id, ["pending", "accepted"], "failed_terminal");
      count++;
      continue;
    }

    // TODO: When sandbox-lifecycle.ts is implemented, probe GET /status
    // on the sandbox proxy. For now, mark as failed after a grace period.
    const attemptAge = Date.now() - new Date(attempt.dispatchedAt).getTime();
    const graceMs = 5 * 60 * 1000; // 5 minutes

    if (attemptAge > graceMs) {
      await casAttemptStatus(attempt.id, ["dispatch_unknown"], "failed", {
        error: "Dispatch unknown — not reconciled within grace period",
      });
      await casJobStatus(
        job.id,
        ["pending", "accepted"],
        "failed_retryable",
      );
      await appendJobEvent(job.id, "failed", attempt.id, {
        reason: "dispatch_unknown_expired",
      });
      count++;
      log.set({ sweep: { [`reconciled_${attempt.id}`]: "failed" } });
    }
  }

  return count;
}

/**
 * Retry stuck postprocess_pending jobs.
 */
async function sweepStuckPostprocess(): Promise<number> {
  const log = useLogger();
  const jobs = await getStuckPostprocessJobs(2);
  let count = 0;

  for (const job of jobs) {
    try {
      // Reset to agent_completed so runPostProcessing can re-CAS
      const reset = await casJobStatus(
        job.id,
        ["postprocess_pending"],
        "agent_completed",
      );
      if (reset) {
        await runPostProcessing(job.id);
        count++;
        log.set({ sweep: { [`postprocessRetried_${job.id}`]: true } });
      }
    } catch (err) {
      log.error(err instanceof Error ? err : new Error(String(err)));
      log.set({ sweep: { [`postprocessRetryFailed_${job.id}`]: true } });
    }
  }

  return count;
}

/**
 * Heal sessions stuck in 'active' with no nonterminal job.
 * This catches cases where the sandbox died and the callback never arrived.
 */
async function sweepStaleActiveSessions(): Promise<number> {
  const log = useLogger();
  const { getStaleActiveSessions, casSessionStatus } = await import(
    "@/lib/sessions/actions"
  );
  const staleSessions = await getStaleActiveSessions();
  let count = 0;

  for (const session of staleSessions) {
    const healed = await casSessionStatus(session.id, ["active"], "idle");
    if (healed) {
      count++;
      log.set({ sweep: { [`healedSession_${session.id}`]: true } });
    }
  }

  return count;
}

/**
 * Release review locks held by terminal or nonexistent jobs/runs.
 * This catches cases where dispatchPrReview failed after lock acquisition
 * but before the try-finally was in place (legacy), or edge cases where
 * the lock key (automationRunId) doesn't match any active entity.
 */
async function sweepStaleReviewLocks(): Promise<number> {
  const log = useLogger();
  const { getStaleReviewLocks, forceReleaseAutomationSessionLock } =
    await import("@/lib/automations/actions");
  const staleLocks = await getStaleReviewLocks();
  let count = 0;

  for (const lock of staleLocks) {
    await forceReleaseAutomationSessionLock(lock.automation_session_id);

    // Also mark the stale run as failed so it doesn't block future sweeps
    try {
      const { updateAutomationRun } = await import("@/lib/automations/actions");
      await updateAutomationRun(lock.review_lock_job_id, {
        status: "failed",
        error: "Sweeper: lock held too long without progress",
        completedAt: new Date(),
      });
    } catch {
      // Run may not exist or already terminal — best effort
    }

    count++;
    log.set({ sweep: { [`releasedLock_${lock.automation_session_id}`]: lock.review_lock_job_id } });
  }

  return count;
}
