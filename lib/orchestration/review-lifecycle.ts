/**
 * Review Run Lifecycle — Shared Finalization
 *
 * Extracted from postprocessReview() so both success (postprocess)
 * and terminal failure (sweeper exhaustion, dispatch cancel) use
 * the same lock/queue/cleanup path.
 *
 * Key invariants:
 *   - Lock is held during replay to prevent webhook races
 *   - Pending request is only cleared after successful dispatch
 *   - Re-queue uses CAS to avoid overwriting newer requests
 *   - Replay reconstructs the full normalizedEvent from queued fields
 */

import { useLogger } from "@/lib/evlog";
import type { NormalizedPrReviewEvent, ManualReviewCommand } from "@/lib/reviews/types";

export async function finalizeReviewRun(input: {
  automationSessionId: string;
  automationRunId: string;
  orgId: string;
  automationId?: string | null;
  installationId: number;
  normalizedEvent?: Record<string, unknown>;
}): Promise<void> {
  const {
    clearPendingReviewRequest,
    requeuePendingReviewRequest,
    releaseAutomationSessionLock,
    createAutomationRun,
    getAutomationSession,
    updateAutomationRun,
  } = await import("@/lib/automations/actions");

  const {
    automationSessionId,
    automationRunId,
    orgId,
    automationId,
    installationId,
    normalizedEvent,
  } = input;

  // 1. Pop pending review request (returns the queued request if any)
  const pending = await clearPendingReviewRequest(automationSessionId);

  // 2. If no pending or no automationId, just release and return
  if (!pending || !automationId) {
    await releaseAutomationSessionLock({
      automationSessionId,
      jobId: automationRunId,
    });
    return;
  }

  // 3. Dispatch queued review WHILE HOLDING THE LOCK to prevent webhook races.
  //    Lock ownership transfers from the completed run to the replay run inside
  //    dispatchPrReview (which acquires its own lock). We release after dispatch
  //    regardless of outcome.
  const log = useLogger();
  let replayRunId: string | undefined;

  try {
    const session = await getAutomationSession(automationSessionId);

    const run = await createAutomationRun({
      automationId,
      organizationId: orgId,
      source: "github",
      externalEventId: pending.deliveryId,
      automationSessionId,
      interactiveSessionId: session?.interactiveSessionId,
    });
    replayRunId = run.id;

    log.set({ queueReplay: { automationSessionId, headSha: pending.headSha, runId: run.id } });

    // Reconstruct the full normalized event from queued request fields.
    // The queued request stores mode/sinceSha/commentId which the previous
    // normalizedEvent snapshot may not reflect (e.g. queued /review reset).
    const replayEvent = buildReplayEvent(normalizedEvent, pending);

    // Release the old lock before dispatch — dispatchPrReview acquires its own.
    await releaseAutomationSessionLock({
      automationSessionId,
      jobId: automationRunId,
    });

    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    await dispatchPrReview({
      orgId,
      automationId,
      automationSessionId,
      automationRunId: run.id,
      installationId,
      deliveryId: pending.deliveryId ?? "",
      normalizedEvent: replayEvent as never,
    });
  } catch (err) {
    // Release lock if we haven't yet (dispatch may not have been reached)
    await releaseAutomationSessionLock({
      automationSessionId,
      jobId: automationRunId,
    }).catch(() => {});

    // Mark orphaned replay run as failed so it doesn't sit as ghost "pending"
    if (replayRunId) {
      await updateAutomationRun(replayRunId, {
        status: "failed",
        summary: "Queue replay failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      }).catch(() => {});
    }

    // Re-queue only if the slot is still empty (CAS). If a newer webhook
    // already queued a different request, don't overwrite it.
    try {
      await requeuePendingReviewRequest(automationSessionId, pending);
    } catch {
      // Last resort — if re-queue also fails, at least log it
    }

    log.set({
      queueReplay: {
        automationSessionId,
        headSha: pending.headSha,
        error: err instanceof Error ? err.message : String(err),
        requeued: true,
      },
    });
  }
}

/**
 * Reconstruct a NormalizedPrReviewEvent for replay from the queued request.
 * Patches headSha, action, and manualCommand from the queued request onto
 * the base normalizedEvent snapshot. This ensures /review reset, /review since,
 * and manual commands replay correctly instead of defaulting to incremental.
 */
function buildReplayEvent(
  base: Record<string, unknown> | undefined,
  pending: { headSha: string; reason: string; mode: ManualReviewCommand["mode"]; sinceSha?: string; commentId?: string },
): Record<string, unknown> {
  const event: Record<string, unknown> = { ...(base ?? {}) };

  event.headSha = pending.headSha;
  event.action = pending.reason;

  // Reconstruct manualCommand if the queued request was a manual /review command
  if (pending.reason === "manual") {
    event.manualCommand = {
      mode: pending.mode,
      ...(pending.sinceSha ? { sinceSha: pending.sinceSha } : {}),
    } satisfies ManualReviewCommand;
    event.commentId = pending.commentId;
  } else {
    // Non-manual replays shouldn't carry a stale manualCommand from a previous event
    event.manualCommand = null;
  }

  return event;
}
