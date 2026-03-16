import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { getInteractiveSession } from "@/lib/sessions/actions";
import { replyQuestion } from "@/lib/sessions/hitl";

/**
 * POST /api/interactive-sessions/:sessionId/question
 * Reply to a question request from the sandbox agent.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);
  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { questionId, answers } = body;

  if (!questionId || !answers || typeof answers !== "object") {
    return NextResponse.json(
      { error: "Missing questionId or answers object" },
      { status: 400 },
    );
  }

  try {
    await replyQuestion(sessionId, questionId, answers);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
