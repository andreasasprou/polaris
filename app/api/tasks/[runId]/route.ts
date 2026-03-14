import { NextRequest, NextResponse } from "next/server";
import { runs } from "@trigger.dev/sdk/v3";
import { eq, and } from "drizzle-orm";
import { getSessionWithOrg } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { automationRuns } from "@/lib/automations/schema";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { runId } = await params;

  // Verify run belongs to caller's org (check both session and automation run tables)
  const [session] = await db
    .select({ id: interactiveSessions.id })
    .from(interactiveSessions)
    .where(
      and(
        eq(interactiveSessions.triggerRunId, runId),
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
          eq(automationRuns.triggerRunId, runId),
          eq(automationRuns.organizationId, orgId),
        ),
      )
      .limit(1);

    if (!autoRun) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  const run = await runs.retrieve(runId);

  return NextResponse.json({
    id: run.id,
    status: run.status,
    metadata: run.metadata,
    output: run.output,
    tags: run.tags,
  });
}
