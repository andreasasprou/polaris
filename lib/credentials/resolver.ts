import { findAutomationById } from "@/lib/automations/queries";
import { findRepositoryById } from "@/lib/integrations/queries";
import { getDecryptedSecret } from "@/lib/secrets/queries";

export type ResolvedCredentials = {
  agentApiKey: string;
  provider: string;
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch: string;
  githubInstallationId: string;
  prompt: string;
  agentType: string;
  model: string | null;
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

  // Resolve the agent API key
  if (!automation.agentSecretId) return null;
  const agentApiKey = await getDecryptedSecret(automation.agentSecretId);
  if (!agentApiKey) return null;

  // Look up the secret to get the provider
  const { findSecretById } = await import("@/lib/secrets/queries");
  const secret = await findSecretById(automation.agentSecretId);
  if (!secret) return null;

  // Resolve repository
  if (!automation.repositoryId) return null;
  const repo = await findRepositoryById(automation.repositoryId);
  if (!repo) return null;

  return {
    agentApiKey,
    provider: secret.provider,
    repositoryOwner: repo.owner,
    repositoryName: repo.name,
    defaultBranch: repo.defaultBranch,
    githubInstallationId: repo.githubInstallationId,
    prompt: automation.prompt,
    agentType: automation.agentType,
    model: automation.model,
    maxDurationSeconds: automation.maxDurationSeconds,
    allowPush: automation.allowPush,
    allowPrCreate: automation.allowPrCreate,
  };
}
