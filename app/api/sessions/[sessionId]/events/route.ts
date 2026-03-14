import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { automationRuns } from "@/lib/automations/schema";
import { getSessionEvents } from "@/lib/sandbox-agent/queries";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  // The route param is an SDK/agent session ID (used by sandbox_agent.events),
  // NOT the interactive session UUID. Verify ownership by checking both
  // interactiveSessions.sdkSessionId and automationRuns.agentSessionId.
  const [session] = await db
    .select({ id: interactiveSessions.id })
    .from(interactiveSessions)
    .where(
      and(
        eq(interactiveSessions.sdkSessionId, sessionId),
        eq(interactiveSessions.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!session) {
    const [autoRun] = await db
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.agentSessionId, sessionId),
          eq(automationRuns.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!autoRun) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "100");
  const offset = Number(url.searchParams.get("offset") ?? "0");

  const result = await getSessionEvents(sessionId, { limit, offset });

  return NextResponse.json(result);
}
