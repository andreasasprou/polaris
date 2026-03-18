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
  // Try advisory lock — skip if another sweep is running
  const lockRows = await db.execute(
    sql`SELECT pg_try_advisory_lock(${SWEEPER_LOCK_ID}) AS acquired`,
  );
  const lockResult = lockRows.rows?.[0] as { acquired: boolean } | undefined;

  if (!lockResult?.acquired) {
    console.log("[sweeper] Another sweep is running — skipping");
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
  const jobs = await getTimedOutJobs();
  let count = 0;

  for (const job of jobs) {
    const updated = await casJobStatus(
      job.id,
      ["accepted", "running"],
      "failed_terminal",
    );
    if (updated) {
      await appendJobEvent(job.id, "timeout", undefined, {
        reason: "sweeper_timeout",
      });
      count++;
      console.log(`[sweeper] Timed out job ${job.id}`);

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
      console.log(
        `[sweeper] Reconciled dispatch_unknown attempt ${attempt.id} → failed`,
      );
    }
  }

  return count;
}

/**
 * Retry stuck postprocess_pending jobs.
 */
async function sweepStuckPostprocess(): Promise<number> {
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
        console.log(`[sweeper] Retried postprocess for job ${job.id}`);
      }
    } catch (err) {
      console.error(
        `[sweeper] Postprocess retry failed for job ${job.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return count;
}

/**
 * Heal sessions stuck in 'active' with no nonterminal job.
 * This catches cases where the sandbox died and the callback never arrived.
 */
async function sweepStaleActiveSessions(): Promise<number> {
  const { getStaleActiveSessions, casSessionStatus } = await import(
    "@/lib/sessions/actions"
  );
  const staleSessions = await getStaleActiveSessions();
  let count = 0;

  for (const session of staleSessions) {
    const healed = await casSessionStatus(session.id, ["active"], "idle");
    if (healed) {
      count++;
      console.log(`[sweeper] Healed stale active session ${session.id}`);
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
  const { getStaleReviewLocks, forceReleaseAutomationSessionLock } =
    await import("@/lib/automations/actions");
  const staleLocks = await getStaleReviewLocks();
  let count = 0;

  for (const lock of staleLocks) {
    await forceReleaseAutomationSessionLock(lock.automation_session_id);
    count++;
    console.log(
      `[sweeper] Released stale review lock on ${lock.automation_session_id}`,
    );
  }

  return count;
}
