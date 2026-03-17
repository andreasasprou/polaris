import { RequestError } from "@/lib/errors/request-error";
import { findRepositoryByIdAndOrg } from "@/lib/integrations/queries";
import { findSecretByIdAndOrg } from "@/lib/secrets/queries";

export async function validateAutomationRelationsForOrg(input: {
  organizationId: string;
  repositoryId?: string | null;
  agentSecretId?: string | null;
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

  return {
    repositoryId,
    agentSecretId,
  };
}
