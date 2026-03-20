import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { secrets } from "@/lib/secrets/schema";
import { decrypt } from "@/lib/credentials/encryption";
import { RequestError } from "@/lib/errors/request-error";
import { sql } from "drizzle-orm";

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
 * Uses FOR UPDATE SKIP LOCKED to ensure concurrent dispatches pick different keys.
 * If all keys are locked (extreme burst), falls back to a plain select.
 *
 * Use this ONLY at sandbox provisioning time and automation dispatch.
 */
export async function allocateKeyFromPool(
  poolId: string,
  organizationId: string,
): Promise<AllocatedKey> {
  // Atomic select-and-stamp using CTE with FOR UPDATE SKIP LOCKED.
  // This ensures concurrent dispatches pick different keys.
  const result = await db.execute<{
    secret_id: string;
    encrypted_value: string;
    provider: string;
  }>(sql`
    WITH selected AS (
      SELECT m.id AS member_id, s.id AS secret_id, s.encrypted_value, s.provider
      FROM key_pool_members m
      JOIN key_pools p ON p.id = m.pool_id
      JOIN secrets s ON s.id = m.secret_id
      WHERE m.pool_id = ${poolId}
        AND p.organization_id = ${organizationId}
        AND m.enabled = true
        AND s.revoked_at IS NULL
      ORDER BY m.last_selected_at ASC NULLS FIRST
      LIMIT 1
      FOR UPDATE OF m SKIP LOCKED
    )
    UPDATE key_pool_members
    SET last_selected_at = NOW()
    FROM selected
    WHERE key_pool_members.id = selected.member_id
    RETURNING selected.secret_id, selected.encrypted_value, selected.provider
  `);

  // If SKIP LOCKED skipped all rows (extreme burst), retry without locking
  if (result.rows.length === 0) {
    const fallback = await db.execute<{
      secret_id: string;
      encrypted_value: string;
      provider: string;
    }>(sql`
      WITH selected AS (
        SELECT m.id AS member_id, s.id AS secret_id, s.encrypted_value, s.provider
        FROM key_pool_members m
        JOIN key_pools p ON p.id = m.pool_id
        JOIN secrets s ON s.id = m.secret_id
        WHERE m.pool_id = ${poolId}
          AND p.organization_id = ${organizationId}
          AND m.enabled = true
          AND s.revoked_at IS NULL
        ORDER BY m.last_selected_at ASC NULLS FIRST
        LIMIT 1
      )
      UPDATE key_pool_members
      SET last_selected_at = NOW()
      FROM selected
      WHERE key_pool_members.id = selected.member_id
      RETURNING selected.secret_id, selected.encrypted_value, selected.provider
    `);

    if (fallback.rows.length === 0) {
      throw new RequestError(
        "All keys in this pool are revoked or disabled. Add or enable a key.",
        400,
      );
    }

    const row = fallback.rows[0];
    return {
      secretId: row.secret_id,
      decryptedKey: decrypt(row.encrypted_value),
      provider: row.provider,
    };
  }

  const row = result.rows[0];
  return {
    secretId: row.secret_id,
    decryptedKey: decrypt(row.encrypted_value),
    provider: row.provider,
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
