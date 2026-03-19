import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { getInteractiveSession } from "@/lib/sessions/actions";
import { replyPermission } from "@/lib/sessions/hitl";
import { withEvlog } from "@/lib/evlog";

/**
 * POST /api/interactive-sessions/:sessionId/permission
 * Reply to a permission request from the sandbox agent.
 */
export const POST = withEvlog(async (
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);
  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { permissionId, reply } = body;

  if (!permissionId || !reply || !["allow", "deny"].includes(reply)) {
    return NextResponse.json(
      { error: "Missing permissionId or invalid reply (allow/deny)" },
      { status: 400 },
    );
  }

  try {
    await replyPermission(sessionId, permissionId, reply);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
});
