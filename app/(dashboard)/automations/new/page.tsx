import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "@/lib/auth";
import { syncReposForOrg } from "@/lib/integrations/sync-repos";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { AutomationForm } from "../_components/automation-form";

export default async function NewAutomationPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  }).catch(() => null);

  if (!session?.session.activeOrganizationId) {
    redirect("/onboarding");
  }

  const orgId = session.session.activeOrganizationId;

  const [repos, secrets] = await Promise.all([
    syncReposForOrg(orgId),
    findSecretsByOrg(orgId),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">New automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up a new agent workflow triggered by GitHub events.
        </p>
      </div>
      <AutomationForm repos={repos} secrets={secrets} />
    </div>
  );
}
