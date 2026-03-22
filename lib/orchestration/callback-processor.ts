import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { callbackInbox, jobs } from "@/lib/jobs/schema";
import {
  casJobStatus,
  casAttemptStatus,
  appendJobEvent,
  getJob,
  touchAttemptProgress,
} from "@/lib/jobs/actions";
import type { CallbackType } from "@/lib/jobs/status";
import { useLogger } from "@/lib/evlog";

/** Extract session identifiers from an untyped callback payload, narrowing at runtime. */
function pickSessionIdentifiers(source: Record<string, unknown>): Partial<{
  sdkSessionId: string;
  nativeAgentSessionId: string;
  cwd: string;
}> {
  const out: Record<string, string> = {};
  if (typeof source.sdkSessionId === "string") out.sdkSessionId = source.sdkSessionId;
  if (typeof source.nativeAgentSessionId === "string") out.nativeAgentSessionId = source.nativeAgentSessionId;
  if (typeof source.cwd === "string") out.cwd = source.cwd;
  return out;
}

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
    await processCallback(input, job);

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
type JobRow = Awaited<ReturnType<typeof getJob>>;

async function processCallback(input: {
  jobId: string;
  attemptId: string;
  callbackType: CallbackType;
  payload: Record<string, unknown>;
}, callerJob: NonNullable<JobRow>) {
  const { jobId, attemptId, callbackType, payload } = input;

  switch (callbackType) {
    case "prompt_accepted": {
      await casAttemptStatus(attemptId, ["dispatching"], "accepted", {
        acceptedAt: new Date(),
        lastProgressAt: new Date(),
      });
      await casJobStatus(jobId, ["pending"], "accepted");
      await appendJobEvent(jobId, "accepted", attemptId);

      // Persist sdkSessionId early so events are queryable from the first turn
      // (before prompt_complete). This is the first trusted callback after
      // session creation — the proxy includes the session IDs.
      if (callerJob.sessionId) {
        const ids = pickSessionIdentifiers(payload);
        if (ids.sdkSessionId) {
          const { updateInteractiveSession } = await import("@/lib/sessions/actions");
          await updateInteractiveSession(callerJob.sessionId!, ids);
        }
      }
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
          ...pickSessionIdentifiers(result),
          error: null, // clear stale errors on success
        });
      }

      if (completedJobRow?.sessionId) {
        const { releaseClaimsByClaimant, createClaim } = await import("@/lib/compute/claims");
        // Release the job_active claim — execution is done.
        await releaseClaimsByClaimant(completedJobRow.sessionId, jobId).catch(() => {});

        // Coding tasks need the sandbox during postprocess (git push, PR creation).
        // Create a short-lived postprocess_finalizer claim so the controller doesn't
        // destroy the sandbox while postprocess is running.
        if (completedJobRow.type === "coding_task") {
          await createClaim({
            sessionId: completedJobRow.sessionId,
            claimant: `postprocess:${jobId}`,
            reason: "postprocess_finalizer",
            ttlMs: 10 * 60 * 1000, // 10 min max for git push + PR creation
          }).catch(() => {});
        }
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
      if (jobCasSucceeded && callerJob.sessionId) {
        const { casSessionStatus } = await import("@/lib/sessions/actions");
        await casSessionStatus(callerJob.sessionId, ["active"], "idle", {
          ...pickSessionIdentifiers(payload),
        });

        // Release compute claim — job failed, sandbox no longer needed.
        const { releaseClaimsByClaimant } = await import("@/lib/compute/claims");
        await releaseClaimsByClaimant(callerJob.sessionId, jobId).catch(() => {});
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

    case "session_events": {
      // Incremental event persistence — the proxy flushes batches during execution
      // so the chat UI can show live progress via DB polling.
      //
      // SECURITY: The trustedSessionId comes ONLY from the platform DB's
      // sdkSessionId field, which is set exclusively by the prompt_accepted
      // callback. We NEVER hydrate sdkSessionId from session_events payloads —
      // the sandbox is untrusted and could forge payload.sessionId to inject
      // events into another session's stream. Events arriving before
      // prompt_accepted are dropped; the proxy will re-send them.
      if (!callerJob.sessionId) break;

      const { getInteractiveSession } = await import("@/lib/sessions/actions");
      const session = await getInteractiveSession(callerJob.sessionId);
      const trustedSessionId = session?.sdkSessionId ?? null;
      if (!trustedSessionId) break; // prompt_accepted hasn't arrived yet — drop

      const events = Array.isArray(payload.events) ? payload.events as Array<Record<string, unknown>> : [];
      if (events.length > 0) {
        const { persistSessionEvents } = await import("@/lib/sandbox-agent/queries");
        await persistSessionEvents(
          events.map((e) => ({
            id: typeof e.id === "string" ? e.id : `fallback-${Math.random().toString(36).slice(2)}`,
            eventIndex: typeof e.eventIndex === "number" ? e.eventIndex : 0,
            sessionId: trustedSessionId!,
            createdAt: typeof e.createdAt === "number" ? e.createdAt : Date.now(),
            connectionId: typeof e.connectionId === "string" ? e.connectionId : "platform",
            sender: typeof e.sender === "string" ? e.sender : "agent",
            payload: (typeof e.payload === "object" && e.payload != null ? e.payload : e) as Record<string, unknown>,
          })),
        );
      }

      // Update liveness — session_events prove the agent is alive
      await touchAttemptProgress(attemptId);

      // Transition accepted → running on first session_events batch
      // (the agent is executing if it's producing events).
      // CAS ensures this fires only once; subsequent calls are no-ops.
      // Must transition BOTH attempt and job so downstream HITL CAS
      // (permission_requested, question_requested) can find the attempt
      // in "running" as expected.
      await casAttemptStatus(attemptId, ["accepted"], "running");
      await casJobStatus(jobId, ["accepted"], "running");

      break;
    }
  }
}
