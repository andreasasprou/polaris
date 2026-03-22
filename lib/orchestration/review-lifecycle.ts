/**
 * Review Run Lifecycle — Shared Finalization
 *
 * Extracted from postprocessReview() so both success (postprocess)
 * and terminal failure (sweeper exhaustion, dispatch cancel) use
 * the same lock/queue/cleanup path.
 */

import { useLogger } from "@/lib/evlog";

export async function finalizeReviewRun(input: {
  automationSessionId: string;
  automationRunId: string;
  orgId: string;
  automationId?: string | null;
  installationId: number;
  normalizedEvent?: Record<string, unknown>;
}): Promise<void> {
  const {
    releaseAutomationSessionLock,
    clearPendingReviewRequest,
    setPendingReviewRequest,
    createAutomationRun,
    getAutomationSession,
  } = await import("@/lib/automations/actions");

  const {
    automationSessionId,
    automationRunId,
    orgId,
    automationId,
    installationId,
    normalizedEvent,
  } = input;

  // 1. Clear pending review request (returns the queued request if any)
  const pending = await clearPendingReviewRequest(automationSessionId);

  // 2. Release lock (keyed by automationRunId, same as pr-review.ts)
  await releaseAutomationSessionLock({
    automationSessionId,
    jobId: automationRunId,
  });

  // 3. Dispatch queued review if pending
  if (pending && automationId) {
    const log = useLogger();
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

      log.set({ queueReplay: { automationSessionId, headSha: pending.headSha, runId: run.id } });

      const { dispatchPrReview } = await import(
        "@/lib/orchestration/pr-review"
      );
      await dispatchPrReview({
        orgId,
        automationId,
        automationSessionId,
        automationRunId: run.id,
        installationId,
        deliveryId: pending.deliveryId ?? "",
        normalizedEvent: {
          ...(normalizedEvent ?? {}),
          headSha: pending.headSha,
          action: pending.reason,
        } as never,
      });
    } catch (err) {
      // Re-queue the pending request so the next webhook or sweeper can retry.
      // Without this, a transient failure permanently loses the queued review.
      try {
        await setPendingReviewRequest(automationSessionId, pending);
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
}
