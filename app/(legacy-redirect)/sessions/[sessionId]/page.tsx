import { redirect, notFound } from "next/navigation";
import { getSessionWithOrg, getOrgSlugById, hasOrganizationMembership } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { interactiveSessions } from "@/lib/sessions/schema";
import { eq } from "drizzle-orm";

export default async function LegacySessionRedirect({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;
  const { session } = await getSessionWithOrg();

  const [row] = await db
    .select({ organizationId: interactiveSessions.organizationId })
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, sessionId))
    .limit(1);

  if (!row) notFound();

  const isMember = await hasOrganizationMembership(session.user.id, row.organizationId);
  if (!isMember) notFound();

  const slug = await getOrgSlugById(row.organizationId);
  redirect(`/${slug}/sessions/${sessionId}`);
}
