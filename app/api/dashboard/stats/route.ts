import { NextResponse } from "next/server";
import { eq, and, sql, gte, isNotNull, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations, automationRuns } from "@/lib/automations/schema";
import { getSessionWithOrg } from "@/lib/auth/session";

export async function GET() {
  const { orgId } = await getSessionWithOrg();
  const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const [
    activeAutomationsResult,
    runsToday,
    prsToday,
    statusCounts,
  ] = await Promise.all([
    // Active automations
    db
      .select({ count: count() })
      .from(automations)
      .where(
        and(
          eq(automations.organizationId, orgId),
          eq(automations.enabled, true),
        ),
      ),

    // Runs in last 24h
    db
      .select({ count: count() })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.organizationId, orgId),
          gte(automationRuns.createdAt, twentyFourHoursAgo),
        ),
      ),

    // PRs created in last 24h
    db
      .select({ count: count() })
      .from(automationRuns)
      .where(
        and(
          eq(automationRuns.organizationId, orgId),
          gte(automationRuns.createdAt, twentyFourHoursAgo),
          isNotNull(automationRuns.prUrl),
        ),
      ),

    // Status breakdown
    db
      .select({
        status: automationRuns.status,
        count: count(),
      })
      .from(automationRuns)
      .where(eq(automationRuns.organizationId, orgId))
      .groupBy(automationRuns.status),
  ]);

  const statusMap = Object.fromEntries(
    statusCounts.map((r) => [r.status, r.count]),
  );

  const totalRuns = Object.values(statusMap).reduce((a, b) => a + b, 0);
  const successRate =
    totalRuns > 0 ? ((statusMap.succeeded ?? 0) / totalRuns) * 100 : 0;

  return NextResponse.json({
    activeAutomations: activeAutomationsResult[0]?.count ?? 0,
    runsToday: runsToday[0]?.count ?? 0,
    prsToday: prsToday[0]?.count ?? 0,
    successRate: Math.round(successRate),
    totalRuns,
    statusBreakdown: statusMap,
  });
}
