import { NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSession,
  casSessionStatus,
} from "@/lib/sessions/actions";
import { getStatusConfig, LIVE_SESSION_STATUSES, RUN_TERMINAL_STATUSES } from "@/lib/sessions/status";
import { sessionMessages } from "@/lib/trigger/streams";

/**
 * GET /api/interactive-sessions/:sessionId — get session details.
 *
 * If the session is in a "live" state but the Trigger.dev run is terminal,
 * the DB is stale (e.g. onFailure didn't fire). We heal the mismatch before
 * responding so every poll/refresh automatically recovers.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  let session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Reconcile: if session thinks it's live but the run is dead, heal the DB.
  if (
    LIVE_SESSION_STATUSES.includes(session.status) &&
    session.triggerRunId
  ) {
    try {
      const run = await runs.retrieve(session.triggerRunId);
      if (RUN_TERMINAL_STATUSES.has(run.status)) {
        const healed = await casSessionStatus(
          sessionId,
          [...LIVE_SESSION_STATUSES],
          "failed",
          {
            error: `Run ${run.status.toLowerCase()} — session recovered automatically`,
            endedAt: new Date(),
            triggerRunId: null,
          },
        );
        if (healed) {
          session = (await getInteractiveSession(sessionId)) ?? session;
        }
      }
    } catch {
      // Can't reach Trigger.dev API — return stale data rather than failing
    }
  }

  return NextResponse.json({ session });
}

/**
 * DELETE /api/interactive-sessions/:sessionId — stop an active session.
 */
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!getStatusConfig(session.status).canStop) {
    return NextResponse.json(
      { error: `Session is ${session.status}, cannot stop` },
      { status: 400 },
    );
  }

  if (!session.triggerRunId) {
    return NextResponse.json(
      { error: "No active run" },
      { status: 400 },
    );
  }

  // Verify run is alive before sending stop. If the run died externally,
  // just mark the session as stopped directly.
  try {
    const run = await runs.retrieve(session.triggerRunId);
    if (RUN_TERMINAL_STATUSES.has(run.status)) {
      await casSessionStatus(
        sessionId,
        [...LIVE_SESSION_STATUSES],
        "stopped",
        { endedAt: new Date(), triggerRunId: null },
      );
      return NextResponse.json({ ok: true, reconciled: true });
    }
  } catch {
    // Can't reach Trigger.dev API — try sending stop anyway
  }

  await sessionMessages.send(session.triggerRunId, { action: "stop" });

  return NextResponse.json({ ok: true });
}
