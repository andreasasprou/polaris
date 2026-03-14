import { findAutomationById } from "@/lib/automations/queries";
import { findRepositoryById } from "@/lib/integrations/queries";
import { getDecryptedSecretForOrg, findSecretByIdAndOrg } from "@/lib/secrets/queries";
import { db } from "@/lib/db";
import { githubInstallations } from "@/lib/integrations/schema";
import { eq } from "drizzle-orm";

export type ResolvedCredentials = {
  agentApiKey: string;
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch: string;
  githubInstallationDbId: string;
  /** The numeric GitHub App installation ID (for minting tokens). */
  githubInstallationId: number;
  prompt: string;
  agentType: string;
  model: string | null;
  agentMode: string | null;
  modelParams: Record<string, unknown>;
  maxDurationSeconds: number;
  allowPush: boolean;
  allowPrCreate: boolean;
};

/**
 * Resolve all credentials and config needed to execute an automation run.
 */
export async function resolveCredentials(
  automationId: string,
): Promise<ResolvedCredentials | null> {
  const automation = await findAutomationById(automationId);
  if (!automation) return null;

  const orgId = automation.organizationId;

  // Resolve the agent API key — verify org ownership
  if (!automation.agentSecretId) return null;
  const agentApiKey = await getDecryptedSecretForOrg(automation.agentSecretId, orgId);
  if (!agentApiKey) return null;

  // Look up the secret to get the provider — already org-scoped
  const secret = await findSecretByIdAndOrg(automation.agentSecretId, orgId);
  if (!secret) return null;

  // Resolve repository — verify org ownership
  if (!automation.repositoryId) return null;
  const repo = await findRepositoryById(automation.repositoryId);
  if (!repo || repo.organizationId !== orgId) return null;

  // Look up the numeric GitHub installation ID — verify org ownership
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, repo.githubInstallationId))
    .limit(1);
  if (!installation || installation.organizationId !== orgId) return null;

  return {
    agentApiKey,
    provider: secret.provider,
    repositoryOwner: repo.owner,
    repositoryName: repo.name,
    defaultBranch: repo.defaultBranch,
    githubInstallationDbId: repo.githubInstallationId,
    githubInstallationId: installation.installationId,
    prompt: automation.prompt,
    agentType: automation.agentType,
    model: automation.model,
    agentMode: automation.agentMode,
    modelParams: automation.modelParams ?? {},
    maxDurationSeconds: automation.maxDurationSeconds,
    allowPush: automation.allowPush,
    allowPrCreate: automation.allowPrCreate,
  };
}
