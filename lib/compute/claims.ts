/**
 * Compute Claims — CRUD operations.
 *
 * Claims are the interface between consumer code and the runtime controller.
 * Consumers create claims when they need a sandbox and release them when done.
 * The controller reads active claims to decide sandbox lifecycle.
 */

import { eq, and, sql, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { computeClaims } from "./schema";

export type ClaimReason =
  | "job_active"
  | "postprocess_finalizer"
  | "interactive_attached"
  | "queued_review";

/**
 * Create a compute claim — declares that a sandbox is needed for this session.
 * Returns the claim ID for later release.
 */
export async function createClaim(input: {
  sessionId: string;
  claimant: string;
  reason: ClaimReason;
  ttlMs: number;
}): Promise<string> {
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const [row] = await db
    .insert(computeClaims)
    .values({
      sessionId: input.sessionId,
      claimant: input.claimant,
      reason: input.reason,
      expiresAt,
    })
    .returning({ id: computeClaims.id });
  return row.id;
}

/**
 * Release a specific claim by ID.
 * Idempotent — no-op if already released.
 */
export async function releaseClaim(claimId: string): Promise<void> {
  await db
    .update(computeClaims)
    .set({ releasedAt: new Date() })
    .where(
      and(eq(computeClaims.id, claimId), isNull(computeClaims.releasedAt)),
    );
}

/**
 * Release all active claims for a claimant on a session.
 * Used when a job completes/fails — release all its claims at once.
 */
export async function releaseClaimsByClaimant(
  sessionId: string,
  claimant: string,
): Promise<number> {
  const result = await db
    .update(computeClaims)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(computeClaims.sessionId, sessionId),
        eq(computeClaims.claimant, claimant),
        isNull(computeClaims.releasedAt),
      ),
    )
    .returning({ id: computeClaims.id });
  return result.length;
}

/**
 * Get all active (non-expired, non-released) claims for a session.
 */
export async function getActiveClaims(sessionId: string) {
  return db
    .select()
    .from(computeClaims)
    .where(
      and(
        eq(computeClaims.sessionId, sessionId),
        isNull(computeClaims.releasedAt),
        sql`${computeClaims.expiresAt} > NOW()`,
      ),
    );
}

/**
 * Check if a session has any active claims.
 * Used by the runtime controller to decide if a sandbox should exist.
 */
export async function hasActiveClaims(
  sessionId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: computeClaims.id })
    .from(computeClaims)
    .where(
      and(
        eq(computeClaims.sessionId, sessionId),
        isNull(computeClaims.releasedAt),
        sql`${computeClaims.expiresAt} > NOW()`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Expire all claims past their TTL. Called by the sweeper.
 * Returns the count of expired claims.
 */
export async function expireOverdueClaims(): Promise<number> {
  const result = await db
    .update(computeClaims)
    .set({ releasedAt: sql`NOW()` })
    .where(
      and(
        isNull(computeClaims.releasedAt),
        sql`${computeClaims.expiresAt} <= NOW()`,
      ),
    )
    .returning({ id: computeClaims.id });
  return result.length;
}

/**
 * Renew a claim's TTL. Used by long-running jobs to extend their lease.
 */
export async function renewClaim(
  claimId: string,
  ttlMs: number,
): Promise<void> {
  const expiresAt = new Date(Date.now() + ttlMs);
  await db
    .update(computeClaims)
    .set({ expiresAt })
    .where(
      and(eq(computeClaims.id, claimId), isNull(computeClaims.releasedAt)),
    );
}
