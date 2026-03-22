import { redirect } from "next/navigation";
import { orgPath } from "@/lib/config/urls";
export default async function LegacyMcpSettingsRedirect({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  redirect(orgPath(orgSlug, "/integrations/mcp/custom"));
}
