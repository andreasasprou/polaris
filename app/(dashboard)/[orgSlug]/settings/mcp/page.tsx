import { redirect } from "next/navigation";
import { orgPath } from "@/lib/config/urls";
export default async function LegacyMcpSettingsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ orgSlug: string }>;
  searchParams: Promise<{
    success?: string | string[];
    error?: string | string[];
  }>;
}) {
  const { orgSlug } = await params;
  const { success, error } = await searchParams;
  const query = new URLSearchParams();

  if (typeof success === "string") {
    query.set("success", success);
  }
  if (typeof error === "string") {
    query.set("error", error);
  }

  const destination = orgPath(orgSlug, "/integrations/mcp/custom");
  const queryString = query.toString();
  redirect(queryString ? `${destination}?${queryString}` : destination);
}
