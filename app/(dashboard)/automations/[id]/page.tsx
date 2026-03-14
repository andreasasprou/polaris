import { notFound } from "next/navigation";
import { getSessionWithOrg } from "@/lib/auth/session";
import { findAutomationById } from "@/lib/automations/queries";
import { syncReposForOrg } from "@/lib/integrations/sync-repos";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { AutomationForm } from "../_components/automation-form";

export default async function EditAutomationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { orgId } = await getSessionWithOrg();
  const { id } = await params;
  const automation = await findAutomationById(id);

  if (!automation || automation.organizationId !== orgId) {
    notFound();
  }

  const [repos, secrets] = await Promise.all([
    syncReposForOrg(orgId),
    findSecretsByOrg(orgId),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Edit automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update your automation configuration.
        </p>
      </div>
      <AutomationForm
        repos={repos}
        secrets={secrets}
        initial={{
          id: automation.id,
          name: automation.name,
          triggerType: automation.triggerType,
          triggerConfig: automation.triggerConfig,
          prompt: automation.prompt,
          agentType: automation.agentType,
          model: automation.model ?? "",
          agentMode: automation.agentMode ?? "",
          repositoryId: automation.repositoryId ?? "",
          agentSecretId: automation.agentSecretId ?? "",
          maxDurationSeconds: automation.maxDurationSeconds,
          allowPush: automation.allowPush,
          allowPrCreate: automation.allowPrCreate,
          mode: automation.mode,
          modelParams: automation.modelParams ?? {},
          prReviewConfig: (automation.prReviewConfig ?? {}) as Record<string, unknown>,
        }}
      />
    </div>
  );
}
