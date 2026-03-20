import { eq, and, isNull, asc } from "drizzle-orm";
import { db } from "@/lib/db";
import { keyPools, keyPoolMembers } from "./schema";
import { secrets } from "@/lib/secrets/schema";
import { decrypt } from "@/lib/credentials/encryption";
import { RequestError } from "@/lib/errors/request-error";

export type AllocatedKey = {
  secretId: string;
  decryptedKey: string;
  provider: string;
};

/**
 * Layer 2: Side-effectful key allocator.
 * Selects the least-recently-used member from the pool, stamps lastSelectedAt,
 * and returns the decrypted key.
 *
 * Use this ONLY at sandbox provisioning time and automation dispatch.
 */
export async function allocateKeyFromPool(
  poolId: string,
  organizationId: string,
): Promise<AllocatedKey> {
  // Select LRU member, org-scoped through pool join
  const candidates = await db
    .select({
      memberId: keyPoolMembers.id,
      secretId: keyPoolMembers.secretId,
      encryptedValue: secrets.encryptedValue,
      provider: secrets.provider,
    })
    .from(keyPoolMembers)
    .innerJoin(keyPools, eq(keyPools.id, keyPoolMembers.poolId))
    .innerJoin(secrets, eq(secrets.id, keyPoolMembers.secretId))
    .where(
      and(
        eq(keyPoolMembers.poolId, poolId),
        eq(keyPools.organizationId, organizationId),
        eq(keyPoolMembers.enabled, true),
        isNull(secrets.revokedAt),
      ),
    )
    .orderBy(asc(keyPoolMembers.lastSelectedAt)) // NULLS FIRST is default for ASC
    .limit(1);

  if (candidates.length === 0) {
    throw new RequestError(
      "All keys in this pool are revoked or disabled. Add or enable a key.",
      400,
    );
  }

  const selected = candidates[0];

  // Stamp LRU on the member row (pool-local, no cross-pool contamination)
  await db
    .update(keyPoolMembers)
    .set({ lastSelectedAt: new Date() })
    .where(eq(keyPoolMembers.id, selected.memberId));

  return {
    secretId: selected.secretId,
    decryptedKey: decrypt(selected.encryptedValue),
    provider: selected.provider,
  };
}

/**
 * Resolve a single secret by ID (existing path, extracted for reuse).
 */
export async function resolveSecretKey(
  secretId: string,
  organizationId: string,
): Promise<AllocatedKey> {
  const { findSecretByIdAndOrg } = await import("@/lib/secrets/queries");
  const secret = await findSecretByIdAndOrg(secretId, organizationId);
  if (!secret) throw new RequestError("Secret not found", 404);
  if (secret.revokedAt) throw new RequestError("This API key has been revoked", 400);

  return {
    secretId: secret.id,
    decryptedKey: decrypt(secret.encryptedValue),
    provider: secret.provider,
  };
}
