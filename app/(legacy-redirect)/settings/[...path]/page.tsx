import { redirect } from "next/navigation";
import { getSessionWithOrg, getOrgSlugById } from "@/lib/auth/session";

export default async function LegacySettingsRedirect({
  params,
}: {
  params: Promise<{ path: string[] }>;
}) {
  const { path } = await params;
  const { orgId } = await getSessionWithOrg();
  const slug = await getOrgSlugById(orgId);
  redirect(`/${slug}/settings/${path.join("/")}`);
}
