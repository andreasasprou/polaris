import { findAutomationById } from "@/lib/automations/queries";
import {
  findGithubInstallationByIdAndOrg,
  findRepositoryByIdAndOrg,
} from "@/lib/integrations/queries";
import { credentialRefFromRow } from "@/lib/key-pools/types";
import { allocateKeyFromPool, resolveSecretKey } from "@/lib/key-pools/resolve";
import { validateCredentialRefForAgent } from "@/lib/key-pools/validate";
import type { ModelParams } from "@/lib/sandbox-agent/types";

export type ResolvedCredentials = {
  agentApiKey: string;
  provider: string;
  resolvedSecretId: string;
  /** DB ID for creating interactive sessions. */
  repositoryId: string;
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
  modelParams: ModelParams;
  maxDurationSeconds: number;
  allowPush: boolean;
  allowPrCreate: boolean;
};

/**
 * Resolve all credentials and config needed to execute an automation run.
 *
 * This is a dispatch-level function — for pools, it allocates a key
 * via LRU and advances lastSelectedAt. It also re-validates provider
 * compatibility against the persisted automation row so legacy or
 * externally-written mismatches fail before sandbox setup.
 */
export async function resolveCredentials(
  automationId: string,
): Promise<ResolvedCredentials | null> {
  const automation = await findAutomationById(automationId);
  if (!automation) return null;

  const orgId = automation.organizationId;

  // Resolve agent API key — pool or single secret
  const credRef = credentialRefFromRow({
    agentSecretId: automation.agentSecretId,
    keyPoolId: automation.keyPoolId,
  });
  if (!credRef) return null;

  await validateCredentialRefForAgent(credRef, orgId, automation.agentType);

  let agentApiKey: string;
  let provider: string;
  let resolvedSecretId: string;

  switch (credRef.type) {
    case "pool": {
      const allocated = await allocateKeyFromPool(credRef.poolId, orgId);
      agentApiKey = allocated.decryptedKey;
      provider = allocated.provider;
      resolvedSecretId = allocated.secretId;
      break;
    }
    case "secret": {
      const resolved = await resolveSecretKey(credRef.secretId, orgId);
      agentApiKey = resolved.decryptedKey;
      provider = resolved.provider;
      resolvedSecretId = resolved.secretId;
      break;
    }
  }

  // Resolve repository — verify org ownership
  if (!automation.repositoryId) return null;
  const repo = await findRepositoryByIdAndOrg(automation.repositoryId, orgId);
  if (!repo) return null;

  // Look up the numeric GitHub installation ID — verify org ownership
  const installation = await findGithubInstallationByIdAndOrg(
    repo.githubInstallationId,
    orgId,
  );
  if (!installation) return null;

  return {
    agentApiKey,
    provider,
    resolvedSecretId,
    repositoryId: automation.repositoryId!,
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
