import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSession,
  casSessionStatus,
} from "@/lib/sessions/actions";
import { getStatusConfig } from "@/lib/sessions/status";

/**
 * GET /api/interactive-sessions/:sessionId — get session details.
 *
 * v2: Reconciliation via job status (no Trigger.dev cross-check).
 * If the session is in an active state but has no active job,
 * the DB is stale — heal before responding.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // TODO(v2-phase3): Add job-based reconciliation here.
  // If session is 'active' but no nonterminal job exists, heal to 'idle' or 'failed'.

  return NextResponse.json({ session });
}

/**
 * DELETE /api/interactive-sessions/:sessionId — stop an active session.
 *
 * v2: Two modes:
 *   - Stop current turn (default): POST /stop to sandbox proxy → session returns to idle
 *   - Terminate session (?terminate=true): CAS → stopped (terminal), destroy sandbox
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

  // TODO(v2-phase3): Implement stop via POST /stop to sandbox proxy.
  // For now, just CAS to stopped.
  const stopped = await casSessionStatus(
    sessionId,
    ["active", "idle"],
    "stopped",
    { endedAt: new Date() },
  );

  if (!stopped) {
    return NextResponse.json(
      { error: "Session already transitioned" },
      { status: 409 },
    );
  }

  return NextResponse.json({ ok: true });
}
