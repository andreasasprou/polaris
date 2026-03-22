import { casSessionStatus } from "./actions";
import { getActiveJobForSession } from "@/lib/jobs/actions";

/**
 * Reconcile a session's status against job reality.
 *
 * The DB status can become stale when:
 *   - "creating" persists because initial prompt dispatch failed silently
 *   - "active" persists because the job finished but the callback was lost
 *
 * Returns the reconciled status string. If healing was applied, the DB
 * is updated via CAS before returning.
 *
 * This is intentionally a pure function of (session → status) so it can
 * be called from both the detail endpoint (single session) and the
 * sidebar endpoint (batch of stale sessions) without duplication.
 */

const CREATING_STALE_THRESHOLD_MS = 60_000;

export async function reconcileSessionStatus(session: {
  id: string;
  status: string;
  createdAt: Date | string;
}): Promise<string> {
  if (session.status === "creating") {
    const ageMs = Date.now() - new Date(session.createdAt).getTime();
    if (ageMs > CREATING_STALE_THRESHOLD_MS) {
      const activeJob = await getActiveJobForSession(session.id);
      if (!activeJob) {
        const healed = await casSessionStatus(session.id, ["creating"], "failed", {
          error: "Session creation timed out — the initial prompt dispatch may have failed",
          endedAt: new Date(),
        });
        if (healed) return healed.status;
      }
    }
  } else if (session.status === "active") {
    const activeJob = await getActiveJobForSession(session.id);
    if (!activeJob) {
      const healed = await casSessionStatus(session.id, ["active"], "idle");
      if (healed) return healed.status;
    }
  }

  return session.status;
}
