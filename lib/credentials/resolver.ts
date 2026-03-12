import { findAutomationById } from "@/lib/automations/queries";
import { findRepositoryById } from "@/lib/integrations/queries";
import { getDecryptedSecret } from "@/lib/secrets/queries";
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

  // Look up the numeric GitHub installation ID
  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, repo.githubInstallationId))
    .limit(1);
  if (!installation) return null;

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
