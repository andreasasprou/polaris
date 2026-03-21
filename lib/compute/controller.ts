/**
 * Runtime Controller — The single authority for sandbox lifecycle.
 *
 * Runs as part of the sweeper cron. Enforces one invariant:
 *
 *   A running sandbox MUST have a valid claim OR be within its idle grace period.
 *   Otherwise, the controller destroys it.
 *
 * This replaces scattered destroy/cleanup calls across consumer code.
 * Consumer code creates/releases claims. The controller does the rest.
 *
 * Two reconciliation loops:
 * 1. Claim-based: no active claims + past idle grace → destroy
 * 2. Hard TTL: runtime age > policy hard TTL → destroy regardless
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { useLogger } from "@/lib/evlog";
import { expireOverdueClaims } from "./claims";
import { RUNTIME_POLICIES, type RuntimePolicyName } from "./policies";

type OrphanedRuntime = {
  runtime_id: string;
  session_id: string;
  sandbox_id: string;
  runtime_age_ms: number;
  runtime_policy: string | null;
  has_active_claims: boolean;
  last_claim_released_at: string | null;
};

/**
 * Main reconciliation loop. Called by the sweeper every cycle.
 *
 * Returns counts of actions taken for observability.
 */
export async function reconcileRuntimes(): Promise<{
  expiredClaims: number;
  destroyedOrphans: number;
  destroyedTtlExceeded: number;
}> {
  const log = useLogger();

  // Step 1: Expire overdue claims (safety net for crashed consumers)
  const expiredClaims = await expireOverdueClaims();
  if (expiredClaims > 0) {
    log.set({ controller: { expiredClaims } });
  }

  // Step 2: Find orphaned runtimes (running, no valid claims, past grace)
  const orphans = await findOrphanedRuntimes();
  let destroyedOrphans = 0;

  for (const orphan of orphans) {
    const policy = getPolicy(orphan.runtime_policy);

    // Skip if within idle grace period (claim was recently released)
    if (orphan.last_claim_released_at) {
      const releasedAt = new Date(orphan.last_claim_released_at).getTime();
      const idleMs = Date.now() - releasedAt;
      if (idleMs < policy.idleGraceMs) continue;
    }

    // Destroy the orphan
    const destroyed = await destroyRuntime(orphan);
    if (destroyed) {
      destroyedOrphans++;
      log.set({
        controller: {
          [`destroyed_orphan_${orphan.runtime_id}`]: {
            sessionId: orphan.session_id,
            sandboxId: orphan.sandbox_id,
            reason: "no_active_claims",
            ageMs: orphan.runtime_age_ms,
          },
        },
      });
    }
  }

  // Step 3: Hard TTL enforcement — kill anything over the max lifetime
  const ttlExceeded = await findTtlExceededRuntimes();
  let destroyedTtlExceeded = 0;

  for (const runtime of ttlExceeded) {
    const destroyed = await destroyRuntime(runtime);
    if (destroyed) {
      destroyedTtlExceeded++;
      log.set({
        controller: {
          [`destroyed_ttl_${runtime.runtime_id}`]: {
            sessionId: runtime.session_id,
            sandboxId: runtime.sandbox_id,
            reason: "hard_ttl_exceeded",
            ageMs: runtime.runtime_age_ms,
          },
        },
      });
    }
  }

  return { expiredClaims, destroyedOrphans, destroyedTtlExceeded };
}

/**
 * Find running runtimes with no active claims.
 * These are candidates for destruction (subject to idle grace).
 */
async function findOrphanedRuntimes(): Promise<OrphanedRuntime[]> {
  const rows = await db.execute(sql`
    SELECT
      r.id AS runtime_id,
      r.session_id,
      r.sandbox_id,
      EXTRACT(EPOCH FROM (NOW() - r.created_at)) * 1000 AS runtime_age_ms,
      s.status AS session_status,
      (
        SELECT c.released_at::text
        FROM compute_claims c
        WHERE c.session_id = r.session_id
        ORDER BY c.released_at DESC NULLS FIRST
        LIMIT 1
      ) AS last_claim_released_at,
      EXISTS (
        SELECT 1 FROM compute_claims c
        WHERE c.session_id = r.session_id
        AND c.released_at IS NULL
        AND c.expires_at > NOW()
      ) AS has_active_claims
    FROM interactive_session_runtimes r
    JOIN interactive_sessions s ON s.id = r.session_id
    WHERE r.status IN ('creating', 'running', 'idle')
    AND r.sandbox_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM compute_claims c
      WHERE c.session_id = r.session_id
      AND c.released_at IS NULL
      AND c.expires_at > NOW()
    )
  `);

  return rows.rows as unknown as OrphanedRuntime[];
}

/**
 * Find running runtimes that exceed the hard TTL for their policy.
 * These are destroyed regardless of claims — absolute safety cap.
 */
async function findTtlExceededRuntimes(): Promise<OrphanedRuntime[]> {
  // Use the most permissive hard TTL as the DB-level filter,
  // then check per-policy in code
  const maxTtlMs = Math.max(
    ...Object.values(RUNTIME_POLICIES).map((p) => p.hardTtlMs),
  );
  const maxTtlSeconds = maxTtlMs / 1000;

  const rows = await db.execute(sql`
    SELECT
      r.id AS runtime_id,
      r.session_id,
      r.sandbox_id,
      EXTRACT(EPOCH FROM (NOW() - r.created_at)) * 1000 AS runtime_age_ms,
      NULL AS runtime_policy,
      false AS has_active_claims,
      NULL AS last_claim_released_at
    FROM interactive_session_runtimes r
    WHERE r.status IN ('creating', 'running', 'idle')
    AND r.sandbox_id IS NOT NULL
    AND EXTRACT(EPOCH FROM (NOW() - r.created_at)) > ${maxTtlSeconds}
  `);

  // Filter by per-policy TTL
  return (rows.rows as unknown as OrphanedRuntime[]).filter((r) => {
    const policy = getPolicy(r.runtime_policy);
    return r.runtime_age_ms > policy.hardTtlMs;
  });
}

/**
 * Destroy a sandbox and end its runtime record.
 * Idempotent — returns false if already stopped.
 */
async function destroyRuntime(runtime: {
  runtime_id: string;
  session_id: string;
  sandbox_id: string;
}): Promise<boolean> {
  const log = useLogger();

  try {
    // Destroy the Vercel sandbox
    const { SandboxManager } = await import("@/lib/sandbox/SandboxManager");
    const manager = new SandboxManager();
    await manager.destroyById(runtime.sandbox_id);
  } catch (err) {
    // Best-effort — sandbox may already be stopped
    log.set({
      controller: {
        [`destroyError_${runtime.runtime_id}`]:
          err instanceof Error ? err.message : String(err),
      },
    });
  }

  // End the runtime record
  try {
    const { updateRuntime } = await import("@/lib/sessions/actions");
    await updateRuntime(runtime.runtime_id, {
      status: "stopped",
      endedAt: new Date(),
    });

    // Also heal session if it's idle with this sandbox
    const { casSessionStatus } = await import("@/lib/sessions/actions");
    await casSessionStatus(
      runtime.session_id,
      ["idle"],
      "stopped",
      { endedAt: new Date() },
    ).catch(() => {});

    return true;
  } catch {
    return false;
  }
}

function getPolicy(policyName: string | null): (typeof RUNTIME_POLICIES)[RuntimePolicyName] {
  if (policyName && policyName in RUNTIME_POLICIES) {
    return RUNTIME_POLICIES[policyName as RuntimePolicyName];
  }
  // Default: shortest-lived policy (fail safe)
  return RUNTIME_POLICIES.ephemeral_review;
}
