/**
 * Provider Janitor — Vercel API reconciliation.
 *
 * Catches sandboxes that exist in Vercel but have no runtime record in our DB.
 * This handles the case where sandbox creation succeeded but the runtime row
 * was never written (crash, partial failure, timeout).
 *
 * Two-pass approach:
 * 1. Fetch running sandboxes from Vercel via Sandbox.list()
 * 2. Compare against interactive_session_runtimes sandbox_ids
 * 3. Stop any sandbox that has no runtime AND is older than the grace period
 */

import { Sandbox } from "@vercel/sandbox";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { useLogger } from "@/lib/evlog";

/** Grace period: don't kill sandboxes younger than this (in-flight provisioning). */
const GRACE_PERIOD_MS = 5 * 60 * 1000;
const PAGE_SIZE = 100;

export type JanitorResult = {
  vercelRunning: number;
  unknownStopped: number;
  withinGrace: number;
  errors: number;
};

/**
 * Compare Vercel's running sandboxes against our DB.
 * Stop any sandbox we don't recognize that's past the grace period.
 */
export async function reconcileProvider(): Promise<JanitorResult> {
  const log = useLogger();
  const result: JanitorResult = {
    vercelRunning: 0,
    unknownStopped: 0,
    withinGrace: 0,
    errors: 0,
  };

  const projectId = process.env.VERCEL_PROJECT_ID;
  const token = process.env.VERCEL_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;

  if (!projectId || !token) {
    log.set({ janitor: { skipped: true, reason: "missing_credentials" } });
    return result;
  }

  // 1. Fetch all running sandboxes from Vercel (paginated)
  const allRunning = await fetchAllRunningSandboxes({ projectId, token, teamId });
  result.vercelRunning = allRunning.length;

  if (allRunning.length === 0) return result;

  // 2. Get all known sandbox IDs from our DB (any status — a recently-stopped
  // runtime's sandbox might still show as "running" in Vercel briefly)
  const knownIds = await getKnownSandboxIds();

  // 3. Reconcile
  const now = Date.now();
  for (const vSandbox of allRunning) {
    if (knownIds.has(vSandbox.id)) continue;

    // Check grace period — sandbox might be mid-provisioning
    const ageMs = now - vSandbox.createdAt;
    if (ageMs < GRACE_PERIOD_MS) {
      result.withinGrace++;
      continue;
    }

    // Unknown + past grace → stop it
    try {
      const sandbox = await Sandbox.get({ sandboxId: vSandbox.id, token, teamId });
      await sandbox.stop();
      result.unknownStopped++;
      log.set({
        janitor: {
          [`stopped_${vSandbox.id}`]: { ageMs, createdAt: vSandbox.createdAt },
        },
      });
    } catch (err) {
      result.errors++;
      log.set({
        janitor: {
          [`error_${vSandbox.id}`]: err instanceof Error ? err.message : String(err),
        },
      });
    }
  }

  return result;
}

async function fetchAllRunningSandboxes(creds: {
  projectId: string;
  token: string;
  teamId?: string;
}): Promise<Array<{ id: string; createdAt: number }>> {
  const all: Array<{ id: string; createdAt: number }> = [];
  let hasMore = true;
  let until: number | undefined;

  while (hasMore) {
    const parsed = await Sandbox.list({
      projectId: creds.projectId,
      token: creds.token,
      teamId: creds.teamId,
      limit: PAGE_SIZE,
      ...(until ? { until } : {}),
    });
    const page = parsed.json;

    const running = page.sandboxes.filter(
      (s) => s.status === "running" || s.status === "pending",
    );
    all.push(...running.map((s) => ({ id: s.id, createdAt: s.createdAt })));

    if (page.pagination.next) {
      until = page.pagination.next;
    } else {
      hasMore = false;
    }

    if (page.sandboxes.length < PAGE_SIZE) hasMore = false;
  }

  return all;
}

async function getKnownSandboxIds(): Promise<Set<string>> {
  // Only consider live runtimes as "known". Failed/stopped runtimes should
  // not protect their sandbox from cleanup — they may be stale leftovers
  // from a resume cycle where the sandbox was never destroyed.
  const rows = await db.execute(sql`
    SELECT DISTINCT sandbox_id
    FROM interactive_session_runtimes
    WHERE sandbox_id IS NOT NULL
    AND status IN ('creating', 'running', 'idle')
  `);
  return new Set(
    (rows.rows as Array<{ sandbox_id: string }>).map((r) => r.sandbox_id),
  );
}
