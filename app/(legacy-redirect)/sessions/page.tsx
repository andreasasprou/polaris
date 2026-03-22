import { redirect } from "next/navigation";
import { getSessionWithOrg, getOrgSlugById } from "@/lib/auth/session";

export default async function LegacySessionsRedirect() {
  const { orgId } = await getSessionWithOrg();
  const slug = await getOrgSlugById(orgId);
  redirect(`/${slug}/sessions`);
}
