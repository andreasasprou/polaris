import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionWithOrg } from "@/lib/auth/session";
import { RequestError } from "@/lib/errors/request-error";
import { getInteractiveSessionForOrg } from "@/lib/sessions/actions";
import { dispatchPromptToSession } from "@/lib/sessions/prompt-dispatch";
import { withEvlog } from "@/lib/evlog";

/**
 * POST /api/interactive-sessions/:sessionId/prompt — send a message.
 *
 * v2: Dispatches via the job system. Returns { jobId } on 202 Accepted.
 * TODO(v2-phase3): Full implementation once dispatchPromptToSession is implemented.
 */
export const POST = withEvlog(async (
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSessionForOrg(sessionId, orgId);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { prompt } = body;

  if (!prompt?.trim()) {
    return NextResponse.json(
      { error: "prompt is required" },
      { status: 400 },
    );
  }

  if (prompt.length > 100_000) {
    return NextResponse.json(
      { error: "Prompt exceeds maximum length of 100,000 characters" },
      { status: 400 },
    );
  }

  try {
    const result = await dispatchPromptToSession({
      organizationId: orgId,
      sessionId,
      prompt,
      requestId: randomUUID(),
      source: "user",
    });

    return NextResponse.json({ jobId: result.jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
