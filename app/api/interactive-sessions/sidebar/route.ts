import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
import { reconcileSessionStatus } from "@/lib/sessions/reconcile";
import { withEvlog } from "@/lib/evlog";

export type SidebarSessionRow = {
  id: string;
  status: string;
  title: string;
  createdAt: string;
  repoOwner: string | null;
  repoName: string | null;
  needsAttention: boolean;
};

/**
 * GET /api/interactive-sessions/sidebar — lightweight session list for the sidebar.
 *
 * Returns the 100 most recent sessions joined with repositories and a
 * needsAttention flag computed from job_attempts with status 'waiting_human'.
 *
 * Reconciles stale sessions so the sidebar matches the detail endpoint:
 * - "creating" >60s with no active job → healed to "failed"
 * - "active" with no active job → healed to "idle"
 */
export const GET = withEvlog(async () => {
  const { orgId } = await getSessionWithOrg();

  const rows = await db.execute<SidebarSessionRow>(sql`
    SELECT
      s.id,
      s.status,
      substring(s.prompt from 1 for 100) AS "title",
      s.created_at AS "createdAt",
      r.owner AS "repoOwner",
      r.name AS "repoName",
      EXISTS(
        SELECT 1 FROM job_attempts ja
        JOIN jobs j ON j.id = ja.job_id
        WHERE j.session_id = s.id AND ja.status = 'waiting_human'
      ) AS "needsAttention"
    FROM interactive_sessions s
    LEFT JOIN repositories r ON r.id = s.repository_id
    WHERE s.organization_id = ${orgId}
      AND s.source = 'user'
    ORDER BY s.created_at DESC
    LIMIT 100
  `);

  const sessions = rows.rows;

  // Reconcile stale sessions — "creating" older than 60s and any "active" session
  // need checking. This is cheap: typically 0-2 sessions match, each requiring
  // one job lookup. Covers both healing paths in reconcileSessionStatus.
  const stale = sessions.filter(
    (s) =>
      (s.status === "creating" &&
        Date.now() - new Date(s.createdAt).getTime() > 60_000) ||
      s.status === "active",
  );

  if (stale.length > 0) {
    const healed = await Promise.all(
      stale.map(async (s) => {
        const reconciledStatus = await reconcileSessionStatus(s);
        return { id: s.id, reconciledStatus };
      }),
    );

    // Patch the in-memory rows with reconciled statuses so the response is fresh.
    const healedMap = new Map(healed.map((h) => [h.id, h.reconciledStatus]));
    for (const session of sessions) {
      const patched = healedMap.get(session.id);
      if (patched) session.status = patched;
    }
  }

  return NextResponse.json({ sessions });
});
