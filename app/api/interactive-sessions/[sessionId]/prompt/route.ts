import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import { dispatchPromptToSession } from "@/lib/sessions/prompt-dispatch";

/**
 * POST /api/interactive-sessions/:sessionId/prompt — send a message.
 *
 * Thin HTTP wrapper over dispatchPromptToSession(). All routing logic
 * (hot/warm/suspended/hibernate/cold) lives in prompt-dispatch.ts.
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
    orgId,
    prompt,
    source: "user",
  });

  if (result.tier === "unavailable") {
    const status = result.error.includes("not found")
      ? 404
      : result.error.includes("already resuming")
        ? 409
        : result.error.includes("being saved")
          ? 425
          : 400;

    const headers: Record<string, string> = {};
    if (result.retryAfterMs) {
      headers["Retry-After"] = String(Math.ceil(result.retryAfterMs / 1000));
    }

    return NextResponse.json({ error: result.error }, { status, headers });
  }

  // Map dispatch result to the existing JSON response shape
  switch (result.tier) {
    case "hot":
      return NextResponse.json({ ok: true });
    case "warm":
      return NextResponse.json({ ok: true, warm: true });
    case "suspended":
      return NextResponse.json({ ok: true, suspended: true });
    case "hibernate":
      return NextResponse.json({
        ok: true,
        resumed: true,
        tier: "hibernate",
        triggerRunId: result.triggerRunId,
        accessToken: result.accessToken,
      });
    case "cold":
      return NextResponse.json({
        ok: true,
        resumed: true,
        warm: false,
        triggerRunId: result.triggerRunId,
        accessToken: result.accessToken,
      });
    case "fresh":
      return NextResponse.json({
        ok: true,
        resumed: false,
        triggerRunId: result.triggerRunId,
        accessToken: result.accessToken,
      });
  }
}
