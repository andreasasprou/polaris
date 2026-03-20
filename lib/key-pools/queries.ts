import { eq, and, isNull, count } from "drizzle-orm";
import { db } from "@/lib/db";
import { keyPools, keyPoolMembers } from "./schema";
import { secrets } from "@/lib/secrets/schema";

export async function findKeyPoolsByOrg(organizationId: string) {
  const pools = await db
    .select({
      id: keyPools.id,
      name: keyPools.name,
      provider: keyPools.provider,
      createdBy: keyPools.createdBy,
      createdAt: keyPools.createdAt,
      updatedAt: keyPools.updatedAt,
    })
    .from(keyPools)
    .where(eq(keyPools.organizationId, organizationId))
    .orderBy(keyPools.createdAt);

  // Fetch member counts in a single query
  const memberCounts = await db
    .select({
      poolId: keyPoolMembers.poolId,
      count: count(),
    })
    .from(keyPoolMembers)
    .innerJoin(secrets, eq(secrets.id, keyPoolMembers.secretId))
    .where(
      and(
        eq(keyPoolMembers.enabled, true),
        isNull(secrets.revokedAt),
      ),
    )
    .groupBy(keyPoolMembers.poolId);

  const countMap = new Map(memberCounts.map((r) => [r.poolId, Number(r.count)]));

  return pools.map((pool) => ({
    ...pool,
    activeKeyCount: countMap.get(pool.id) ?? 0,
  }));
}

export async function findKeyPoolByIdAndOrg(id: string, organizationId: string) {
  const [row] = await db
    .select()
    .from(keyPools)
    .where(and(eq(keyPools.id, id), eq(keyPools.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

export async function findKeyPoolMembers(poolId: string) {
  return db
    .select({
      id: keyPoolMembers.id,
      secretId: keyPoolMembers.secretId,
      enabled: keyPoolMembers.enabled,
      lastSelectedAt: keyPoolMembers.lastSelectedAt,
      addedAt: keyPoolMembers.addedAt,
      // Secret metadata (never expose encrypted value)
      secretProvider: secrets.provider,
      secretLabel: secrets.label,
      secretRevokedAt: secrets.revokedAt,
      secretCreatedAt: secrets.createdAt,
    })
    .from(keyPoolMembers)
    .innerJoin(secrets, eq(secrets.id, keyPoolMembers.secretId))
    .where(eq(keyPoolMembers.poolId, poolId))
    .orderBy(keyPoolMembers.addedAt);
}

/**
 * Check if a pool has at least one active (enabled + non-revoked) member.
 */
export async function poolHasActiveMembers(poolId: string): Promise<boolean> {
  const [result] = await db
    .select({ count: count() })
    .from(keyPoolMembers)
    .innerJoin(secrets, eq(secrets.id, keyPoolMembers.secretId))
    .where(
      and(
        eq(keyPoolMembers.poolId, poolId),
        eq(keyPoolMembers.enabled, true),
        isNull(secrets.revokedAt),
      ),
    );
  return (result?.count ?? 0) > 0;
}

/**
 * Check if any automations or sessions reference this pool.
 */
export async function isPoolReferenced(poolId: string): Promise<boolean> {
  const { automations } = await import("@/lib/automations/schema");
  const { interactiveSessions } = await import("@/lib/sessions/schema");

  const [automationRef] = await db
    .select({ id: automations.id })
    .from(automations)
    .where(eq(automations.keyPoolId, poolId))
    .limit(1);

  if (automationRef) return true;

  const [sessionRef] = await db
    .select({ id: interactiveSessions.id })
    .from(interactiveSessions)
    .where(eq(interactiveSessions.keyPoolId, poolId))
    .limit(1);

  return !!sessionRef;
}
