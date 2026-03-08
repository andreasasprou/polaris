import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { findGithubInstallationsByOrg } from "@/lib/integrations/queries";
import { GitHubInstallCard } from "./_components/github-install-card";

export default async function IntegrationsPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  }).catch(() => null);

  if (!session?.session.activeOrganizationId) {
    redirect("/onboarding");
  }

  const orgId = session.session.activeOrganizationId;
  const installations = await findGithubInstallationsByOrg(orgId);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">Integrations</h1>
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
