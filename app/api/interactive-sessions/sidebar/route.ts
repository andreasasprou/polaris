import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
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
    ORDER BY s.created_at DESC
    LIMIT 100
  `);

  return NextResponse.json({ sessions: rows.rows });
});
