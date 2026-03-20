import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { getSessionWithOrg } from "@/lib/auth/session";
import { RequestError } from "@/lib/errors/request-error";
import { getInteractiveSessionForOrg } from "@/lib/sessions/actions";
import { dispatchPromptToSession } from "@/lib/orchestration/prompt-dispatch";
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
  const { prompt, attachments } = body;

  const hasText = !!prompt?.trim();
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (!hasText && !hasAttachments) {
    return NextResponse.json(
      { error: "prompt or attachments required" },
      { status: 400 },
    );
  }

  if (hasText && prompt.length > 100_000) {
    return NextResponse.json(
      { error: "Prompt exceeds maximum length of 100,000 characters" },
      { status: 400 },
    );
  }

  // Validate attachments if provided
  const ALLOWED_MIME_TYPES = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "application/pdf",
  ];
  const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per attachment (base64)

  if (attachments) {
    if (!Array.isArray(attachments) || attachments.length > 10) {
      return NextResponse.json(
        { error: "attachments must be an array of at most 10 items" },
        { status: 400 },
      );
    }
    for (const att of attachments) {
      if (!att.name || !att.mimeType || !att.data) {
        return NextResponse.json(
          { error: "Each attachment must have name, mimeType, and data" },
          { status: 400 },
        );
      }
      if (!ALLOWED_MIME_TYPES.includes(att.mimeType)) {
        return NextResponse.json(
          { error: `Unsupported attachment type: ${att.mimeType}` },
          { status: 400 },
        );
      }
      if (att.data.length > MAX_ATTACHMENT_SIZE) {
        return NextResponse.json(
          { error: `Attachment "${att.name}" exceeds maximum size` },
          { status: 400 },
        );
      }
    }
  }

  try {
    const result = await dispatchPromptToSession({
      organizationId: orgId,
      sessionId,
      prompt: prompt?.trim() || "",
      requestId: randomUUID(),
      source: "user",
      attachments: attachments?.length ? attachments : undefined,
    });

    return NextResponse.json({ jobId: result.jobId }, { status: 202 });
  } catch (error) {
    if (error instanceof RequestError) {
      return NextResponse.json({ error: error.message }, { status: error.status });
    }
    throw error;
  }
});
