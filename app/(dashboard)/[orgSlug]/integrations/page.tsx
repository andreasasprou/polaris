import { notFound } from "next/navigation";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import { GitHubInstallCard } from "./_components/github-install-card";

export default async function IntegrationsPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();
  const installations = await findGithubInstallationsByOrg(orgId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Integrations</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Connect your tools and services.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <GitHubInstallCard installations={installations} />
      </div>
    </div>
  );
}
