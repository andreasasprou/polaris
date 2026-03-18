import { NextRequest, NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { automationRuns, automations } from "@/lib/automations/schema";
import { repositories } from "@/lib/integrations/schema";
import { interactiveSessions } from "@/lib/sessions/schema";
import { getSessionWithOrg } from "@/lib/auth/session";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { runId } = await params;

  const [row] = await db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      automationName: automations.name,
      status: automationRuns.status,
      source: automationRuns.source,
      prUrl: automationRuns.prUrl,
      branchName: automationRuns.branchName,
      summary: automationRuns.summary,
      error: automationRuns.error,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      createdAt: automationRuns.createdAt,
      // v2 session link
      interactiveSessionId: automationRuns.interactiveSessionId,
      sdkSessionId: interactiveSessions.sdkSessionId,
      sessionStatus: interactiveSessions.status,
      // Review fields
      jobId: automationRuns.jobId,
      verdict: automationRuns.verdict,
      severityCounts: automationRuns.severityCounts,
      reviewScope: automationRuns.reviewScope,
      reviewSequence: automationRuns.reviewSequence,
      reviewFromSha: automationRuns.reviewFromSha,
      reviewToSha: automationRuns.reviewToSha,
      githubCommentId: automationRuns.githubCommentId,
      // Repo info
      repoOwner: repositories.owner,
      repoName: repositories.name,
    })
    .from(automationRuns)
    .leftJoin(automations, eq(automationRuns.automationId, automations.id))
    .leftJoin(repositories, and(eq(automations.repositoryId, repositories.id), eq(repositories.organizationId, orgId)))
    .leftJoin(
      interactiveSessions,
      eq(automationRuns.interactiveSessionId, interactiveSessions.id),
    )
    .where(
      and(
        eq(automationRuns.id, runId),
        eq(automationRuns.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!row) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  return NextResponse.json({ run: row });
}
