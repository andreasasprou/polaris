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
  retriedJobs: number;
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
      retriedJobs: 0,
    };
  }

  try {
    const timedOut = await sweepTimedOutJobs();
    const unknownReconciled = await sweepDispatchUnknown();
    const postprocessRetried = await sweepStuckPostprocess();
    const staleSessionsHealed = await sweepStaleActiveSessions();
    const staleLocksReleased = await sweepStaleReviewLocks();
    const retriedJobs = await sweepRetryableJobs();

    return {
      timedOut,
      unknownReconciled,
      postprocessRetried,
      staleSessionsHealed,
      staleLocksReleased,
      retriedJobs,
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
      ["pending", "accepted", "running"],
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
    console.log(
      `[sweeper] Released stale review lock on ${lock.automation_session_id} (run ${lock.review_lock_job_id})`,
    );
  }

  return count;
}

/**
 * Retry jobs in failed_retryable status.
 * Type-dispatched: review jobs get re-dispatched, others are terminalized.
 */
async function sweepRetryableJobs(): Promise<number> {
  const retryableJobs = await getRetryableJobs();
  let count = 0;

  for (const job of retryableJobs) {
    const { getAttemptsByJob } = await import("./actions");
    const attempts = await getAttemptsByJob(job.id);

    if (attempts.length >= job.maxAttempts) {
      // Exhausted — terminalize
      const updated = await casJobStatus(
        job.id,
        ["failed_retryable"],
        "failed_terminal",
      );
      if (updated) {
        await appendJobEvent(job.id, "failed", undefined, {
          reason: "max_attempts_exhausted",
        });
        console.log(`[sweeper] Exhausted retries for job ${job.id} (${attempts.length}/${job.maxAttempts})`);

        // Heal session
        if (job.sessionId) {
          const { casSessionStatus } = await import("@/lib/sessions/actions");
          await casSessionStatus(job.sessionId, ["active"], "idle").catch(() => {});
        }

        // Review-specific cleanup: fail check, release lock, drain queue
        if (job.type === "review") {
          await finalizeFailedReviewJob(job);
        }

        count++;
      }
      continue;
    }

    // Type-specific retry
    if (job.type === "review") {
      try {
        await retryReviewDispatch(job, attempts.length + 1);
        count++;
      } catch (err) {
        console.error(
          `[sweeper] Retry failed for review job ${job.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    } else {
      // Non-review jobs: terminalize for now
      await casJobStatus(job.id, ["failed_retryable"], "failed_terminal");
      count++;
    }
  }

  return count;
}

/**
 * Retry a review dispatch: re-acquire lock, ensure sandbox, POST /prompt.
 */
async function retryReviewDispatch(
  job: { id: string; sessionId: string | null; automationRunId: string | null; payload: Record<string, unknown>; createdAt: Date },
  attemptNumber: number,
): Promise<void> {
  const {
    ensureReviewLockOwnership,
    isLatestRunForSession,
    releaseAutomationSessionLock,
    updateAutomationRun,
  } = await import("@/lib/automations/actions");
  const {
    getInteractiveSession,
    casSessionStatus,
  } = await import("@/lib/sessions/actions");
  const { createJobAttempt } = await import("./actions");

  const payload = job.payload;
  const automationSessionId = payload.automationSessionId as string;
  const automationRunId = job.automationRunId!;

  // Check lock ownership
  const lockStatus = await ensureReviewLockOwnership({
    automationSessionId,
    jobId: automationRunId,
  });

  if (lockStatus === "busy") {
    await casJobStatus(job.id, ["failed_retryable"], "cancelled");
    console.log(`[sweeper] Lock busy for job ${job.id} — cancelling`);
    return;
  }

  // Check freshness
  const isFresh = await isLatestRunForSession(automationRunId, job.createdAt);
  if (!isFresh) {
    await casJobStatus(job.id, ["failed_retryable"], "cancelled");
    if (lockStatus === "acquired") {
      await releaseAutomationSessionLock({ automationSessionId, jobId: automationRunId });
    }
    console.log(`[sweeper] Stale job ${job.id} — newer run exists, cancelling`);
    return;
  }

  // CAS job back to pending
  const reset = await casJobStatus(job.id, ["failed_retryable"], "pending");
  if (!reset) return;

  try {
    const session = await getInteractiveSession(job.sessionId!);
    if (!session) throw new Error("Session not found");

    const { probeSandboxHealth, buildCallbackUrl, resolveSessionCredentials } =
      await import("@/lib/sessions/prompt-dispatch");
    const { ensureSandboxReady } = await import("@/lib/sessions/sandbox-lifecycle");
    const { resolveAgentConfig } = await import("@/lib/sandbox-agent/agent-profiles");
    const { generateJobHmacKey } = await import("@/lib/jobs/callback-auth");

    const alive = session.sandboxBaseUrl
      ? await probeSandboxHealth(session.sandboxBaseUrl)
      : false;

    let sandboxUrl = session.sandboxBaseUrl;
    let currentEpoch = session.epoch;
    let currentSandboxId = session.sandboxId;

    if (!alive) {
      const creds = await resolveSessionCredentials(session);
      const result = await ensureSandboxReady(session.id, {
        agentApiKey: creds.agentApiKey,
        agentType: session.agentType as Parameters<typeof ensureSandboxReady>[1]["agentType"],
        repositoryOwner: creds.repositoryOwner,
        repositoryName: creds.repositoryName,
        defaultBranch: creds.defaultBranch,
        githubInstallationId: creds.githubInstallationId,
      });
      sandboxUrl = result.proxyBaseUrl;
      currentEpoch = result.epoch;
      currentSandboxId = result.sandboxId;
    }

    if (!sandboxUrl) throw new Error("No sandbox URL after provisioning");

    // CAS session to active
    if (session.status !== "active") {
      const cas = await casSessionStatus(
        session.id,
        ["idle", "hibernated", "stopped", "failed"],
        "active",
      );
      if (!cas) throw new Error(`Cannot activate session: status is ${session.status}`);
    }

    // Create attempt
    const attempt = await createJobAttempt({
      jobId: job.id,
      attemptNumber,
      epoch: currentEpoch,
      sandboxId: currentSandboxId ?? undefined,
    });

    // Resolve agent config
    const agentType = (session.agentType ?? "claude") as Parameters<typeof resolveAgentConfig>[0]["agentType"];
    const resolved = resolveAgentConfig({
      agentType,
      modeIntent: "read-only",
    });

    const hmacKey = generateJobHmacKey();
    const callbackUrl = buildCallbackUrl();
    const prompt = payload.prompt as string;

    console.log(`[sweeper] Retrying review job ${job.id}, attempt ${attemptNumber} → ${sandboxUrl}`);

    const response = await fetch(`${sandboxUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch: currentEpoch,
        prompt,
        callbackUrl,
        hmacKey,
        config: {
          agent: resolved.agent,
          mode: resolved.mode,
          model: resolved.model,
          thoughtLevel: resolved.thoughtLevel,
          cwd: "/vercel/sandbox",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 202) {
      // Update run metadata
      await updateAutomationRun(automationRunId, {
        interactiveSessionId: session.id,
        status: "running",
        startedAt: new Date(),
      }).catch(() => {});
      console.log(`[sweeper] Retry succeeded for job ${job.id}`);
      return;
    }

    throw new Error(`Proxy returned ${response.status}`);
  } catch (err) {
    // Re-mark retryable for next sweep cycle
    await casJobStatus(job.id, ["pending"], "failed_retryable");
    if (job.sessionId) {
      await casSessionStatus(job.sessionId, ["active"], "idle").catch(() => {});
    }
    throw err;
  }
}

/**
 * Terminal cleanup for a review job that exhausted retries.
 * Fails the check, marks the run, releases the lock, drains the pending queue.
 */
async function finalizeFailedReviewJob(
  job: { id: string; automationRunId: string | null; payload: Record<string, unknown>; organizationId: string },
): Promise<void> {
  const payload = job.payload;
  const automationSessionId = payload.automationSessionId as string;
  const automationRunId = job.automationRunId;
  const checkRunId = payload.checkRunId as string | undefined;
  const installationId = payload.installationId as number;
  const owner = payload.owner as string;
  const repo = payload.repo as string;

  // Mark automation run as failed
  if (automationRunId) {
    const { updateAutomationRun } = await import("@/lib/automations/actions");
    await updateAutomationRun(automationRunId, {
      status: "failed",
      error: "Max retry attempts exhausted",
      completedAt: new Date(),
    }).catch(() => {});
  }

  // Fail the GitHub check
  if (checkRunId && installationId && owner && repo) {
    try {
      const { failCheck } = await import("@/lib/reviews/github");
      await failCheck({
        installationId,
        owner,
        repo,
        checkRunId,
        error: "Review failed after retries",
      });
    } catch { /* best-effort */ }
  }

  // Release lock + drain pending queue
  if (automationSessionId && automationRunId) {
    try {
      const { finalizeReviewRun } = await import("@/lib/orchestration/review-lifecycle");
      await finalizeReviewRun({
        automationSessionId,
        automationRunId,
        orgId: job.organizationId,
        automationId: payload.automationId as string | undefined,
        installationId,
        normalizedEvent: payload.normalizedEvent as Record<string, unknown>,
      });
    } catch (err) {
      console.error(
        `[sweeper] Failed to finalize review job ${job.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
