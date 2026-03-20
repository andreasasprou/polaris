import { RequestError } from "@/lib/errors/request-error";
import { findRepositoryByIdAndOrg } from "@/lib/integrations/queries";
import { findSecretByIdAndOrg } from "@/lib/secrets/queries";
import { findKeyPoolByIdAndOrg, poolHasActiveMembers } from "@/lib/key-pools/queries";

export async function validateAutomationRelationsForOrg(input: {
  organizationId: string;
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

  if (agentSecretId) {
    const secret = await findSecretByIdAndOrg(
      agentSecretId,
      input.organizationId,
    );
    if (!secret) {
      throw new RequestError("Secret not found", 404);
    }
    if (secret.revokedAt) {
      throw new RequestError("This API key has been revoked", 400);
    }
  }

  if (keyPoolId) {
    const pool = await findKeyPoolByIdAndOrg(keyPoolId, input.organizationId);
    if (!pool) {
      throw new RequestError("Key pool not found", 404);
    }
    const hasActive = await poolHasActiveMembers(keyPoolId);
    if (!hasActive) {
      throw new RequestError(
        `All keys in pool "${pool.name}" are revoked or disabled`,
        400,
      );
    }
  }

  return {
    repositoryId,
    agentSecretId,
    keyPoolId,
  };
}
