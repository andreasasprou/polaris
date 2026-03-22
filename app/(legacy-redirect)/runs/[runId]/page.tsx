import { redirect, notFound } from "next/navigation";
import { getSessionWithOrg, getOrgSlugById, hasOrganizationMembership } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { automationRuns } from "@/lib/automations/schema";
import { eq } from "drizzle-orm";

export default async function LegacyRunRedirect({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const { session } = await getSessionWithOrg();

  // Resolve the run's org from DB
  const [run] = await db
    .select({ organizationId: automationRuns.organizationId })
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);

  if (!run) notFound();

  const isMember = await hasOrganizationMembership(session.user.id, run.organizationId);
  if (!isMember) notFound();

  const slug = await getOrgSlugById(run.organizationId);
  redirect(`/${slug}/runs/${runId}`);
}
