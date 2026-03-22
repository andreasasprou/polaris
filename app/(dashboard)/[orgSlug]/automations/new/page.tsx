import { notFound } from "next/navigation";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { syncReposForOrg } from "@/lib/integrations/sync-repos";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { findKeyPoolsByOrg } from "@/lib/key-pools/queries";
import { AutomationForm } from "../_components/automation-form";

export default async function NewAutomationPage({
  params,
}: {
  params: Promise<{ orgSlug: string }>;
}) {
  const { orgSlug } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();

  const [repos, secrets, pools] = await Promise.all([
    syncReposForOrg(orgId),
    findSecretsByOrg(orgId),
    findKeyPoolsByOrg(orgId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">New automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Set up a new agent workflow triggered by GitHub events.
        </p>
      </div>
      <AutomationForm repos={repos} secrets={secrets} pools={pools} />
    </div>
  );
}
