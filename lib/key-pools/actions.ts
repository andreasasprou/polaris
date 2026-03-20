import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { keyPools, keyPoolMembers } from "./schema";
import { secrets } from "@/lib/secrets/schema";
import { findKeyPoolByIdAndOrg, isPoolReferenced } from "./queries";
import { RequestError } from "@/lib/errors/request-error";

export async function createKeyPool(input: {
  organizationId: string;
  name: string;
  provider: string;
  createdBy: string;
}) {
  const [row] = await db
    .insert(keyPools)
    .values({
      organizationId: input.organizationId,
      name: input.name.trim(),
      provider: input.provider,
      createdBy: input.createdBy,
    })
    .returning({
      id: keyPools.id,
      name: keyPools.name,
      provider: keyPools.provider,
      createdAt: keyPools.createdAt,
    });
  return row;
}

export async function updateKeyPool(input: {
  id: string;
  organizationId: string;
  name: string;
}) {
  const pool = await findKeyPoolByIdAndOrg(input.id, input.organizationId);
  if (!pool) throw new RequestError("Key pool not found", 404);

  const [row] = await db
    .update(keyPools)
    .set({ name: input.name.trim(), updatedAt: new Date() })
    .where(
      and(eq(keyPools.id, input.id), eq(keyPools.organizationId, input.organizationId)),
    )
    .returning({
      id: keyPools.id,
      name: keyPools.name,
      provider: keyPools.provider,
      createdAt: keyPools.createdAt,
    });
  return row;
}

export async function deleteKeyPool(id: string, organizationId: string) {
  const pool = await findKeyPoolByIdAndOrg(id, organizationId);
  if (!pool) throw new RequestError("Key pool not found", 404);

  const referenced = await isPoolReferenced(id);
  if (referenced) {
    throw new RequestError(
      "Cannot delete key pool — it is referenced by automations or sessions. Remove the references first.",
      409,
    );
  }

  await db.delete(keyPools).where(
    and(eq(keyPools.id, id), eq(keyPools.organizationId, organizationId)),
  );
}

export async function addKeyToPool(input: {
  poolId: string;
  secretId: string;
  organizationId: string;
}) {
  const pool = await findKeyPoolByIdAndOrg(input.poolId, input.organizationId);
  if (!pool) throw new RequestError("Key pool not found", 404);

  // Verify the secret exists, is org-scoped, and provider matches
  const { findSecretByIdAndOrg } = await import("@/lib/secrets/queries");
  const secret = await findSecretByIdAndOrg(input.secretId, input.organizationId);
  if (!secret) throw new RequestError("Secret not found", 404);
  if (secret.revokedAt) throw new RequestError("Cannot add a revoked secret to a pool", 400);

  if (secret.provider !== pool.provider) {
    throw new RequestError(
      `Provider mismatch: pool is for "${pool.provider}" but secret is "${secret.provider}"`,
      400,
    );
  }

  const [row] = await db
    .insert(keyPoolMembers)
    .values({
      poolId: input.poolId,
      secretId: input.secretId,
    })
    .onConflictDoNothing()
    .returning({
      id: keyPoolMembers.id,
      poolId: keyPoolMembers.poolId,
      secretId: keyPoolMembers.secretId,
      enabled: keyPoolMembers.enabled,
      addedAt: keyPoolMembers.addedAt,
    });

  return row ?? null;
}

export async function removeKeyFromPool(input: {
  poolId: string;
  secretId: string;
  organizationId: string;
}) {
  // Verify pool is org-scoped
  const pool = await findKeyPoolByIdAndOrg(input.poolId, input.organizationId);
  if (!pool) throw new RequestError("Key pool not found", 404);

  await db
    .delete(keyPoolMembers)
    .where(
      and(
        eq(keyPoolMembers.poolId, input.poolId),
        eq(keyPoolMembers.secretId, input.secretId),
      ),
    );
}

export async function togglePoolMember(input: {
  poolId: string;
  secretId: string;
  organizationId: string;
  enabled: boolean;
}) {
  const pool = await findKeyPoolByIdAndOrg(input.poolId, input.organizationId);
  if (!pool) throw new RequestError("Key pool not found", 404);

  const [row] = await db
    .update(keyPoolMembers)
    .set({ enabled: input.enabled })
    .where(
      and(
        eq(keyPoolMembers.poolId, input.poolId),
        eq(keyPoolMembers.secretId, input.secretId),
      ),
    )
    .returning({
      id: keyPoolMembers.id,
      enabled: keyPoolMembers.enabled,
    });

  if (!row) throw new RequestError("Pool member not found", 404);
  return row;
}
