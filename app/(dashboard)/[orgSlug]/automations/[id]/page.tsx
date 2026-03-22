import { notFound } from "next/navigation";
import { getOrgIdBySlug } from "@/lib/auth/session";
import { findAutomationById } from "@/lib/automations/queries";
import { findRepositoryById } from "@/lib/integrations/queries";
import { syncReposForOrg } from "@/lib/integrations/sync-repos";
import { findSecretsByOrg } from "@/lib/secrets/queries";
import { findKeyPoolsByOrg } from "@/lib/key-pools/queries";
import { getInstallationOctokit } from "@/lib/integrations/github";
import {
  loadRepoReviewConfig,
  extractOverrideInfo,
  type YamlOverrideInfo,
} from "@/lib/reviews/repo-config";
import { AutomationForm } from "../_components/automation-form";

export default async function EditAutomationPage({
  params,
}: {
  params: Promise<{ orgSlug: string; id: string }>;
}) {
  const { orgSlug, id } = await params;
  const orgId = await getOrgIdBySlug(orgSlug);
  if (!orgId) notFound();
  const automation = await findAutomationById(id);

  if (!automation || automation.organizationId !== orgId) {
    notFound();
  }

  const [repos, secrets, pools, targetRepo] = await Promise.all([
    syncReposForOrg(orgId),
    findSecretsByOrg(orgId),
    findKeyPoolsByOrg(orgId),
    automation.mode === "continuous" && automation.repositoryId
      ? findRepositoryById(automation.repositoryId)
      : Promise.resolve(null),
  ]);

  // Check for YAML config overrides (continuous mode only)
  let yamlOverrides: YamlOverrideInfo | null = null;
  if (targetRepo) {
    try {
      const octokit = await getInstallationOctokit(
        targetRepo.owner,
        targetRepo.name,
      );
      const configResult = await loadRepoReviewConfig(
        octokit,
        targetRepo.owner,
        targetRepo.name,
        targetRepo.defaultBranch,
      );
      if (configResult.status === "found") {
        yamlOverrides = extractOverrideInfo(
          configResult.definition,
          configResult.file,
          targetRepo.owner,
          targetRepo.name,
          targetRepo.defaultBranch,
        );
      }
    } catch {
      // Graceful degradation — form renders without YAML indicators
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Edit automation</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Update your automation configuration.
        </p>
      </div>
      <AutomationForm
        repos={repos}
        secrets={secrets}
        pools={pools}
        yamlOverrides={yamlOverrides}
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
          keyPoolId: automation.keyPoolId ?? undefined,
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
