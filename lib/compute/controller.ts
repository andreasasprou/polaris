/**
 * Runtime Controller — The single authority for sandbox lifecycle.
 *
 * Runs as part of the sweeper cron. Enforces one invariant:
 *
 *   A running sandbox MUST have a valid claim OR be within its idle grace period.
 *   Otherwise, the controller destroys or hibernates it per policy.
 *
 * This replaces scattered destroy/cleanup calls across consumer code.
 * Consumer code creates/releases claims. The controller does the rest.
 *
 * Two reconciliation loops:
 * 1. Claim-based: no active claims + past idle grace → destroy or hibernate per policy
 * 2. Hard TTL: runtime age > policy hard TTL → destroy regardless
 *
 * Design notes:
 * - Runtimes in 'creating' status are excluded from orphan detection because
 *   they are mid-provisioning (ensureSandboxReady creates the runtime before
 *   the dispatch creates a claim).
 * - Policy is resolved from session context (job type, session created_by),
 *   not stored on the runtime. This avoids schema changes and lets the policy
 *   be derived from the same facts the rest of the system uses.
 */

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { useLogger } from "@/lib/evlog";
import { expireOverdueClaims } from "./claims";
import {
  RUNTIME_POLICIES,
  resolveRuntimePolicy,
  type RuntimePolicyName,
} from "./policies";

type OrphanedRuntime = {
  runtime_id: string;
  session_id: string;
  sandbox_id: string;
  runtime_age_ms: number;
  session_created_by: string | null;
  job_type: string | null;
  has_active_claims: boolean;
  last_claim_released_at: string | null;
};

/**
 * Main reconciliation loop. Called by the sweeper every cycle.
 *
 * Returns counts of actions taken for observability.
 */
export type SandboxGauge = {
  liveRuntimes: number;
  maxAgeMs: number;
  over1h: number;
};

export async function reconcileRuntimes(): Promise<{
  expiredClaims: number;
  destroyedOrphans: number;
  hibernatedOrphans: number;
  destroyedTtlExceeded: number;
  gauge: SandboxGauge;
}> {
  const log = useLogger();

  // Step 1: Expire overdue claims (safety net for crashed consumers)
  const expiredClaims = await expireOverdueClaims();
  if (expiredClaims > 0) {
    log.set({ controller: { expiredClaims } });
  }

  // Step 2: Find orphaned runtimes (running/idle, no valid claims, past grace)
  // Note: 'creating' runtimes are excluded — they are mid-provisioning
  // and claims are created after ensureSandboxReady returns.
  const orphans = await findOrphanedRuntimes();
  let destroyedOrphans = 0;
  let hibernatedOrphans = 0;

  for (const orphan of orphans) {
    const policy = resolvePolicy(orphan);

    // Skip if within idle grace period (claim was recently released)
    if (orphan.last_claim_released_at) {
      const releasedAt = new Date(orphan.last_claim_released_at).getTime();
      const idleMs = Date.now() - releasedAt;
      if (idleMs < policy.idleGraceMs) continue;
    }

    // Decide action based on policy
    if (policy.afterLastClaim === "hibernate" && policy.hibernatable) {
      const hibernated = await hibernateRuntime(orphan);
      if (hibernated) {
        hibernatedOrphans++;
        log.set({
          controller: {
            [`hibernated_${orphan.runtime_id}`]: {
              sessionId: orphan.session_id,
              sandboxId: orphan.sandbox_id,
              reason: "no_active_claims",
              ageMs: orphan.runtime_age_ms,
            },
          },
        });
      }
    } else {
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

  // Step 4: Emit gauge metrics for observability/alerting
  const gauge = await buildGauge();
  log.set({ sandbox_gauge: gauge });

  return { expiredClaims, destroyedOrphans, hibernatedOrphans, destroyedTtlExceeded, gauge };
}

/**
 * Find running/idle runtimes with no active claims.
 * Excludes 'creating' runtimes — they are mid-provisioning and claims
 * are created after ensureSandboxReady returns.
 */
async function findOrphanedRuntimes(): Promise<OrphanedRuntime[]> {
  const rows = await db.execute(sql`
    SELECT
      r.id AS runtime_id,
      r.session_id,
      r.sandbox_id,
      EXTRACT(EPOCH FROM (NOW() - r.created_at)) * 1000 AS runtime_age_ms,
      s.created_by AS session_created_by,
      (
        SELECT j.type FROM jobs j
        WHERE j.session_id = r.session_id
        AND j.status NOT IN ('completed', 'failed_terminal', 'cancelled')
        ORDER BY j.created_at DESC LIMIT 1
      ) AS job_type,
      (
        SELECT c.released_at::text
        FROM compute_claims c
        WHERE c.session_id = r.session_id
        ORDER BY c.released_at DESC NULLS FIRST
        LIMIT 1
      ) AS last_claim_released_at,
      false AS has_active_claims
    FROM interactive_session_runtimes r
    JOIN interactive_sessions s ON s.id = r.session_id
    WHERE r.status IN ('running', 'idle')
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
      s.created_by AS session_created_by,
      (
        SELECT j.type FROM jobs j
        WHERE j.session_id = r.session_id
        ORDER BY j.created_at DESC LIMIT 1
      ) AS job_type,
      NULL AS last_claim_released_at,
      false AS has_active_claims
    FROM interactive_session_runtimes r
    JOIN interactive_sessions s ON s.id = r.session_id
    WHERE r.status IN ('creating', 'running', 'idle')
    AND r.sandbox_id IS NOT NULL
    AND EXTRACT(EPOCH FROM (NOW() - r.created_at)) > ${maxTtlSeconds}
  `);

  // Filter by per-policy TTL
  return (rows.rows as unknown as OrphanedRuntime[]).filter((r) => {
    const policy = resolvePolicy(r);
    return r.runtime_age_ms > policy.hardTtlMs;
  });
}

/**
 * Destroy a sandbox and end its runtime record.
 * Used for ephemeral sessions (reviews, coding tasks).
 * Idempotent — returns false if already stopped.
 */
async function destroyRuntime(runtime: {
  runtime_id: string;
  session_id: string;
  sandbox_id: string;
}): Promise<boolean> {
  const log = useLogger();

  // Attempt to stop the Vercel sandbox. Only mark the runtime as stopped
  // if the destroy succeeds or the sandbox is already gone. If the destroy
  // throws a non-"not found" error, the sandbox may still be running —
  // leave the runtime as-is so the next sweep cycle retries.
  let destroyConfirmed = false;
  try {
    const { SandboxManager } = await import("@/lib/sandbox/SandboxManager");
    const manager = new SandboxManager();
    await manager.destroyById(runtime.sandbox_id);
    destroyConfirmed = true;
  } catch (err) {
    // "not found" / "already stopped" = sandbox is gone, safe to mark stopped
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not found") || msg.includes("not_found") || msg.includes("already")) {
      destroyConfirmed = true;
    }
    log.set({
      controller: {
        [`destroyError_${runtime.runtime_id}`]: msg,
      },
    });
  }

  if (!destroyConfirmed) {
    // Sandbox may still be running — don't mark stopped, retry next cycle
    return false;
  }

  try {
    const { updateRuntime } = await import("@/lib/sessions/actions");
    await updateRuntime(runtime.runtime_id, {
      status: "stopped",
      endedAt: new Date(),
    });

    // Heal session: idle → stopped (for ephemeral sessions only).
    // Interactive sessions that should hibernate go through hibernateRuntime instead.
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

/**
 * Hibernate a sandbox — snapshot + stop. Used for interactive sessions
 * whose policy says "hibernate" instead of "destroy" after last claim.
 * Falls back to destroy if hibernation fails.
 */
async function hibernateRuntime(runtime: {
  runtime_id: string;
  session_id: string;
  sandbox_id: string;
}): Promise<boolean> {
  try {
    const { snapshotAndHibernate } = await import(
      "@/lib/orchestration/sandbox-lifecycle"
    );
    const { casSessionStatus } = await import("@/lib/sessions/actions");

    // snapshotAndHibernate requires session to be in 'idle' status
    // (it CASes idle → snapshotting internally)
    const hibernated = await snapshotAndHibernate(runtime.session_id);
    if (hibernated) return true;

    // Fallback: snapshot failed — destroy instead of leaking
    return destroyRuntime(runtime);
  } catch {
    // Fallback: destroy on any error
    return destroyRuntime(runtime);
  }
}

/**
 * Resolve runtime policy from session context.
 * Uses session created_by and most recent job type to determine the policy.
 */
function resolvePolicy(runtime: {
  session_created_by: string | null;
  job_type: string | null;
}): (typeof RUNTIME_POLICIES)[RuntimePolicyName] {
  // Interactive sessions (created by a user, not automation)
  const isInteractive = runtime.session_created_by !== "automation";
  const policyName = resolveRuntimePolicy({
    sessionType: isInteractive ? "interactive" : undefined,
    jobType: runtime.job_type ?? undefined,
  });
  return RUNTIME_POLICIES[policyName];
}

/**
 * Build a gauge snapshot of current runtime state.
 * Emitted every sweep cycle for Axiom alerting.
 *
 * Recommended Axiom monitors:
 * - sandbox_gauge.over1h > 0 sustained 10min → Warning (long-running sandbox)
 * - sandbox_gauge.liveRuntimes > 20 sustained 10min → Warning (high count)
 * - sandbox_gauge.maxAgeMs > 28800000 → Critical (sandbox exceeded 8h)
 */
async function buildGauge(): Promise<SandboxGauge> {
  const rows = await db.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status IN ('creating', 'running', 'idle')) AS live,
      COALESCE(MAX(EXTRACT(EPOCH FROM (NOW() - created_at)) * 1000)
        FILTER (WHERE status IN ('creating', 'running', 'idle')), 0) AS max_age_ms,
      COUNT(*) FILTER (
        WHERE status IN ('creating', 'running', 'idle')
        AND EXTRACT(EPOCH FROM (NOW() - created_at)) > 3600
      ) AS over_1h
    FROM interactive_session_runtimes
    WHERE sandbox_id IS NOT NULL
  `);
  const row = rows.rows[0] as Record<string, string | null>;
  return {
    liveRuntimes: Number(row.live ?? 0),
    maxAgeMs: Number(row.max_age_ms ?? 0),
    over1h: Number(row.over_1h ?? 0),
  };
}
