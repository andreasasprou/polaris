import { RequestError } from "@/lib/errors/request-error";
import { findRepositoryByIdAndOrg } from "@/lib/integrations/queries";
import { validateCredentialRefForAgent } from "@/lib/key-pools/validate";
import { credentialRefFromRow } from "@/lib/key-pools/types";
import type { AgentType } from "@/lib/sandbox-agent/types";

export async function validateAutomationRelationsForOrg(input: {
  organizationId: string;
  agentType: AgentType;
  repositoryId?: string | null;
  agentSecretId?: string | null;
  keyPoolId?: string | null;
}) {
  const repositoryId = input.repositoryId ?? null;
  if (repositoryId) {
    const repository = await findRepositoryByIdAndOrg(
      repositoryId,
      input.organizationId,
    );
    if (!repository) {
      throw new RequestError("Repository not found", 404);
    }
  }

  const agentSecretId = input.agentSecretId ?? null;
  const keyPoolId = input.keyPoolId ?? null;

  // Mutual exclusivity
  if (agentSecretId && keyPoolId) {
    throw new RequestError(
      "Cannot set both agentSecretId and keyPoolId — use one or the other",
      400,
    );
  }

  const credentialRef = credentialRefFromRow({
    agentSecretId,
    keyPoolId,
  });

  if (credentialRef) {
    await validateCredentialRefForAgent(
      credentialRef,
      input.organizationId,
      input.agentType,
    );
  }

  return {
    repositoryId,
    agentSecretId,
    keyPoolId,
  };
}
