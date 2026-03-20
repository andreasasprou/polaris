import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { callbackInbox, jobs } from "@/lib/jobs/schema";
import {
  casJobStatus,
  casAttemptStatus,
  appendJobEvent,
  getJob,
} from "@/lib/jobs/actions";
import type { CallbackType } from "@/lib/jobs/status";
import { useLogger } from "@/lib/evlog";

type IngestResult =
  | { accepted: true }
  | { accepted: false; reason: string };

/**
 * Ingest a callback from the sandbox proxy.
 *
 * 1. Epoch fence (reject stale sandbox callbacks)
 * 2. Idempotent INSERT ON CONFLICT DO NOTHING
 * 3. Process inline by callback_type
 */
export async function ingestCallback(input: {
  jobId: string;
  attemptId: string;
  epoch: number;
  callbackId: string;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
}): Promise<IngestResult> {
  // 1. Epoch fence — reject callbacks from stale sandboxes
  const job = await getJob(input.jobId);
  if (!job) {
    return { accepted: false, reason: "unknown job" };
  }

  if (job.sessionId) {
    const [session] = await db
      .select({ epoch: interactiveSessions.epoch })
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, job.sessionId))
      .limit(1);

    if (session && session.epoch !== input.epoch) {
      return {
        accepted: false,
        reason: `stale epoch: got ${input.epoch}, current is ${session.epoch}`,
      };
    }
  }

  // 2. Idempotent insert — dedupe by (jobId, attemptId, epoch, callbackId)
  const [row] = await db
    .insert(callbackInbox)
    .values({
      jobId: input.jobId,
      attemptId: input.attemptId,
      epoch: input.epoch,
      callbackId: input.callbackId,
      callbackType: input.callbackType,
      payload: input.payload,
    })
    .onConflictDoNothing()
    .returning();

  if (!row) {
    // Duplicate callback — already processed. Return success so sandbox stops retrying.
    return { accepted: false, reason: "duplicate callback" };
  }

  // 3. Process inline by type
  try {
    await processCallback(input);

    // Mark as processed
    await db
      .update(callbackInbox)
      .set({ processed: true, processedAt: new Date() })
      .where(eq(callbackInbox.id, row.id));
  } catch (error) {
    // Record processing error but don't fail the ingestion
    await db
      .update(callbackInbox)
      .set({
        processError: error instanceof Error ? error.message : String(error),
      })
      .where(eq(callbackInbox.id, row.id));
    throw error;
  }

  return { accepted: true };
}

/**
 * Process a callback based on its type. Updates job/attempt status accordingly.
 */
async function processCallback(input: {
  jobId: string;
  attemptId: string;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
}) {
  const { jobId, attemptId, callbackType, payload } = input;

  switch (callbackType) {
    case "prompt_accepted": {
      await casAttemptStatus(attemptId, ["dispatching"], "accepted", {
        acceptedAt: new Date(),
      });
      await casJobStatus(jobId, ["pending"], "accepted");
      await appendJobEvent(jobId, "accepted", attemptId);
      break;
    }

    case "prompt_complete": {
      const result = (payload.result ?? payload) as Record<string, unknown>;
      const metrics = payload.metrics as Record<string, unknown> | undefined;

      // Log proxy metrics to evlog → Axiom for observability
      if (metrics) {
        const log = useLogger();
        log.set({
          proxyMetrics: {
            connectMs: metrics.connectMs,
            sessionCreateMs: metrics.sessionCreateMs,
            promptExecutionMs: metrics.promptExecutionMs,
            totalMs: metrics.totalMs,
            resumeType: metrics.resumeType,
            eventCount: metrics.eventCount,
            healthChecks: metrics.healthChecks,
          },
        });
      }

      await casAttemptStatus(attemptId, ["running", "accepted"], "completed", {
        resultPayload: { ...result, ...(metrics ? { proxyMetrics: metrics } : {}) },
        completedAt: new Date(),
      });
      // CAS job status — only proceed with session healing if this CAS
      // succeeds, proving we own this transition (not a stale callback).
      const completedJobRow = await casJobStatus(jobId, ["running", "accepted"], "agent_completed", {
        result,
      });
      await appendJobEvent(jobId, "agent_completed", attemptId);

      if (completedJobRow?.sessionId) {
        // We own the transition — atomically heal session status AND persist
        // agent identifiers in a single CAS (prevents race where client polls
        // between status change and metadata write).
        const { casSessionStatus } = await import("@/lib/sessions/actions");
        await casSessionStatus(completedJobRow.sessionId, ["active"], "idle", {
          ...(result.sdkSessionId ? { sdkSessionId: result.sdkSessionId as string } : {}),
          ...(result.nativeAgentSessionId ? { nativeAgentSessionId: result.nativeAgentSessionId as string } : {}),
          ...(result.cwd ? { cwd: result.cwd as string } : {}),
          error: null, // clear stale errors on success
        });
      }

      // Trigger post-processing (coding task PR creation, review comment, etc.)
      const { runPostProcessing } = await import("./postprocess");
      await runPostProcessing(jobId);
      break;
    }

    case "prompt_failed": {
      const error =
        typeof payload.error === "string"
          ? payload.error
          : "Agent execution failed";

      // Log proxy metrics to evlog → Axiom even on failure
      const failedMetrics = payload.metrics as Record<string, unknown> | undefined;
      if (failedMetrics) {
        const log = useLogger();
        log.set({
          proxyMetrics: {
            connectMs: failedMetrics.connectMs,
            sessionCreateMs: failedMetrics.sessionCreateMs,
            promptExecutionMs: failedMetrics.promptExecutionMs,
            totalMs: failedMetrics.totalMs,
            resumeType: failedMetrics.resumeType,
            eventCount: failedMetrics.eventCount,
            healthChecks: failedMetrics.healthChecks,
          },
        });
      }

      await casAttemptStatus(
        attemptId,
        ["dispatching", "accepted", "running", "waiting_human"],
        "failed",
        { error, completedAt: new Date() },
      );

      // Decide: retryable or terminal?
      const job = await getJob(jobId);
      if (!job) break;

      const reason = payload.reason as string | undefined;
      const isRetryable = reason !== "user_stop";

      // CAS job status — only heal session if CAS succeeds (ownership check).
      let jobCasSucceeded = false;
      if (isRetryable) {
        jobCasSucceeded = !!(await casJobStatus(
          jobId,
          ["pending", "accepted", "running"],
          "failed_retryable",
        ));
      } else {
        jobCasSucceeded = !!(await casJobStatus(
          jobId,
          ["pending", "accepted", "running"],
          "cancelled",
        ));
      }

      await appendJobEvent(jobId, "failed", attemptId, {
        error,
        reason,
      });

      // Only heal session if we actually transitioned the job (not a stale callback).
      // Persist session IDs even on failure so partial event history is accessible.
      if (jobCasSucceeded && job.sessionId) {
        const { casSessionStatus } = await import("@/lib/sessions/actions");
        await casSessionStatus(job.sessionId, ["active"], "idle", {
          ...(payload.sdkSessionId ? { sdkSessionId: payload.sdkSessionId as string } : {}),
          ...(payload.nativeAgentSessionId ? { nativeAgentSessionId: payload.nativeAgentSessionId as string } : {}),
          ...(payload.cwd ? { cwd: payload.cwd as string } : {}),
        });
      }
      break;
    }

    case "permission_requested": {
      await casAttemptStatus(attemptId, ["running"], "waiting_human", {
        lastProgressAt: new Date(),
      });
      await appendJobEvent(jobId, "waiting_human", attemptId, {
        permissionId: payload.permissionId,
        toolName: payload.toolName,
      });
      break;
    }

    case "question_requested": {
      await casAttemptStatus(attemptId, ["running"], "waiting_human", {
        lastProgressAt: new Date(),
      });
      await appendJobEvent(jobId, "waiting_human", attemptId, {
        questionId: payload.questionId,
      });
      break;
    }

    case "permission_resumed": {
      await casAttemptStatus(attemptId, ["waiting_human"], "running", {
        lastProgressAt: new Date(),
      });
      await appendJobEvent(jobId, "resumed", attemptId);
      break;
    }
  }
}
