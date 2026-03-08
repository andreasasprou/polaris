import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { getInteractiveSession } from "@/lib/sessions/actions";
import { sessionMessages } from "@/lib/trigger/streams";

/**
 * GET /api/interactive-sessions/:sessionId — get session details.
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

  if (session.status !== "active") {
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

  await sessionMessages.send(session.triggerRunId, { action: "stop" });

  return NextResponse.json({ ok: true });
}
