import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionWithOrg } from "@/lib/auth/session";
import { dispatchPromptToSession } from "@/lib/sessions/prompt-dispatch";

/**
 * POST /api/interactive-sessions/:sessionId/prompt — send a message.
 *
 * v2: Dispatches via the job system. Returns { jobId } on 202 Accepted.
 * TODO(v2-phase3): Full implementation once dispatchPromptToSession is implemented.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

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

  const result = await dispatchPromptToSession({
    sessionId,
    prompt,
    requestId: randomUUID(),
    source: "user",
  });

  return NextResponse.json({ jobId: result.jobId }, { status: 202 });
}
