import { redirect, notFound } from "next/navigation";
import { getSessionWithOrg, getOrgSlugById, hasOrganizationMembership } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { automations } from "@/lib/automations/schema";
import { eq } from "drizzle-orm";

export default async function LegacyAutomationRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { session } = await getSessionWithOrg();

  const [row] = await db
    .select({ organizationId: automations.organizationId })
    .from(automations)
    .where(eq(automations.id, id))
    .limit(1);

  if (!row) notFound();

  const isMember = await hasOrganizationMembership(session.user.id, row.organizationId);
  if (!isMember) notFound();

  const slug = await getOrgSlugById(row.organizationId);
  redirect(`/${slug}/automations/${id}`);
}
