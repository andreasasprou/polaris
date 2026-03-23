import { RequestError } from "@/lib/errors/request-error";
import {
  getAllAgentTypes,
  getCompatibleProviders,
  type ProviderType,
} from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";
import type { CredentialRef } from "./types";

/**
 * Layer 1: Pure credential reference validation.
 * Checks existence, org-scoping, revocation, and active pool members.
 * Does NOT select a specific key or advance LRU state.
 *
 * Use this in: session creation routes, automation validation, postprocessing.
 */
export async function validateCredentialRef(
  ref: CredentialRef,
  organizationId: string,
): Promise<{ provider: string }> {
  switch (ref.type) {
    case "secret": {
      const { findSecretByIdAndOrg } = await import("@/lib/secrets/queries");
      const secret = await findSecretByIdAndOrg(ref.secretId, organizationId);
      if (!secret) throw new RequestError("Secret not found", 404);
      if (secret.revokedAt) throw new RequestError("This API key has been revoked", 400);
      return { provider: secret.provider };
    }

    case "pool": {
      const { findKeyPoolByIdAndOrg, poolHasActiveMembers } = await import("./queries");
      const pool = await findKeyPoolByIdAndOrg(ref.poolId, organizationId);
      if (!pool) throw new RequestError("Key pool not found", 404);

      const hasActive = await poolHasActiveMembers(ref.poolId);
      if (!hasActive) {
        throw new RequestError(
          `All keys in pool "${pool.name}" are revoked or disabled`,
          400,
        );
      }

      return { provider: pool.provider };
    }
  }
}

export function assertSupportedAgentType(agentType: string): AgentType {
  if (getAllAgentTypes().includes(agentType as AgentType)) {
    return agentType as AgentType;
  }

  throw new RequestError(`Unsupported agent "${agentType}"`, 400);
}

export function isProviderCompatibleWithAgent(
  provider: string,
  agentType: string,
): boolean {
  if (!getAllAgentTypes().includes(agentType as AgentType)) {
    return false;
  }

  return getCompatibleProviders(agentType as AgentType).includes(
    provider as ProviderType,
  );
}

export function assertProviderCompatibleWithAgent(
  provider: string,
  agentType: string,
): void {
  const supportedAgentType = assertSupportedAgentType(agentType);

  if (isProviderCompatibleWithAgent(provider, supportedAgentType)) {
    return;
  }

  throw new RequestError(
    `Selected API key provider "${provider}" is not compatible with agent "${supportedAgentType}"`,
    400,
  );
}

export async function validateCredentialRefForAgent(
  ref: CredentialRef,
  organizationId: string,
  agentType: string,
): Promise<{ provider: string }> {
  const credential = await validateCredentialRef(ref, organizationId);
  assertProviderCompatibleWithAgent(credential.provider, agentType);
  return credential;
}
