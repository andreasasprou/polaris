import { NextResponse } from "next/server";
import { desc, eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { automationRuns, automations } from "@/lib/automations/schema";
import { repositories } from "@/lib/integrations/schema";
import { getSessionWithOrg } from "@/lib/auth/session";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (req: Request) => {
  const { orgId } = await getSessionWithOrg();
  const url = new URL(req.url);
  const limit = Number(url.searchParams.get("limit") ?? "50");
  const automationId = url.searchParams.get("automationId");

  const conditions = [eq(automationRuns.organizationId, orgId)];
  if (automationId) {
    conditions.push(eq(automationRuns.automationId, automationId));
  }

  const runs = await db
    .select({
      id: automationRuns.id,
      automationId: automationRuns.automationId,
      automationName: automations.name,
      status: automationRuns.status,
      source: automationRuns.source,
      interactiveSessionId: automationRuns.interactiveSessionId,
      prUrl: automationRuns.prUrl,
      branchName: automationRuns.branchName,
      summary: automationRuns.summary,
      error: automationRuns.error,
      verdict: automationRuns.verdict,
      reviewScope: automationRuns.reviewScope,
      jobId: automationRuns.jobId,
      repoOwner: repositories.owner,
      repoName: repositories.name,
      startedAt: automationRuns.startedAt,
      completedAt: automationRuns.completedAt,
      createdAt: automationRuns.createdAt,
    })
    .from(automationRuns)
    .leftJoin(automations, eq(automationRuns.automationId, automations.id))
    .leftJoin(repositories, and(eq(automations.repositoryId, repositories.id), eq(repositories.organizationId, orgId)))
    .where(and(...conditions))
    .orderBy(desc(automationRuns.createdAt))
    .limit(limit);

  return NextResponse.json({ runs });
});
