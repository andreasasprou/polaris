import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { callbackInbox, jobs } from "./schema";
import {
  casJobStatus,
  casAttemptStatus,
  appendJobEvent,
  getJob,
} from "./actions";
import type { CallbackType } from "./status";

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
      await casAttemptStatus(attemptId, ["running", "accepted"], "completed", {
        resultPayload: result,
        completedAt: new Date(),
      });
      await casJobStatus(jobId, ["running", "accepted"], "agent_completed", {
        result,
      });
      await appendJobEvent(jobId, "agent_completed", attemptId);

      // Transition session active → idle so it's available for next dispatch.
      // Must happen before postprocessing (which may dispatch a queued review).
      const completedJob = await getJob(jobId);
      if (completedJob?.sessionId) {
        const { casSessionStatus } = await import("@/lib/sessions/actions");
        await casSessionStatus(completedJob.sessionId, ["active"], "idle");
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

      if (isRetryable) {
        await casJobStatus(
          jobId,
          ["pending", "accepted", "running"],
          "failed_retryable",
        );
      } else {
        await casJobStatus(
          jobId,
          ["pending", "accepted", "running"],
          "cancelled",
        );
      }

      await appendJobEvent(jobId, "failed", attemptId, {
        error,
        reason,
      });

      // Heal session so next dispatch can proceed
      if (job.sessionId) {
        const { casSessionStatus } = await import("@/lib/sessions/actions");
        await casSessionStatus(job.sessionId, ["active"], "idle");
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
