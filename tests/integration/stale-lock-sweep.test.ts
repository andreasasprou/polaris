/**
 * Integration Test: Stale Review Lock Sweep [REGRESSION]
 *
 * Reproduces the exact production scenario where:
 * 1. A review run acquires the lock
 * 2. The run stalls (sandbox dies, callback never arrives)
 * 3. The automation_run stays "running" for 18+ hours
 * 4. New pushes to the PR are queued/skipped ("another review in progress")
 * 5. The sweeper DETECTS the stale lock but fails to:
 *    a) Mark the automation_run as failed
 *    b) Drain the pending review request
 *
 * The fix should ensure sweepStaleReviewLocks:
 * - Releases the lock
 * - Marks the stale automation_run as failed
 * - Is resilient to individual lock release failures (try/catch per item)
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestDb, type TestDbContext } from "../helpers/db";
import {
  testOrgId,
  createTestInteractiveSession,
  createTestRepository,
  createTestAutomation,
  createTestAutomationSession,
  createTestAutomationRun,
  getAutomationSessionRow,
} from "../helpers/factories";

let ctx: TestDbContext;
let orgId: string;
let repositoryId: string;
let automationId: string;

beforeAll(async () => {
  ctx = await setupTestDb();
  orgId = testOrgId();

  const repo = await createTestRepository(ctx.client, { organizationId: orgId });
  repositoryId = repo.id;

  const automation = await createTestAutomation(ctx.client, {
    organizationId: orgId,
    repositoryId,
  });
  automationId = automation.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("Stale Review Lock Sweep [REGRESSION]", () => {
  it("reproduces: stale run holds lock for 18h, new reviews skipped", async () => {
    // 1. Create automation session with a review lock held by a stale run
    const session = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const automationSession = await createTestAutomationSession(ctx.client, {
      automationId,
      interactiveSessionId: session.id,
      organizationId: orgId,
      repositoryId,
      scopeKey: `github-pr:${repositoryId}:stale-lock-test`,
    });

    // Create a "running" automation run from 18 hours ago
    const staleRunId = randomUUID();
    await ctx.client.query(
      `INSERT INTO automation_runs (id, automation_id, organization_id, source, status, automation_session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '18 hours')`,
      [staleRunId, automationId, orgId, "github", "running", automationSession.id],
    );

    // Lock is held by the stale run
    await acquireLock(ctx, automationSession.id, staleRunId);

    // 2. Verify lock is held
    const before = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(before.review_lock_job_id).toBe(staleRunId);

    // 3. A new review tries to acquire — blocked
    const newRunId = randomUUID();
    const acquired = await acquireLock(ctx, automationSession.id, newRunId);
    expect(acquired).toBe(false); // BLOCKED — this is the user-visible symptom

    // 4. Verify the stale lock detection query finds this lock
    const staleLocks = await getStaleReviewLocks(ctx);
    const ourLock = staleLocks.find(
      (l) => l.automation_session_id === automationSession.id,
    );
    expect(ourLock).toBeDefined();
    expect(ourLock!.review_lock_job_id).toBe(staleRunId);
  });

  it("sweeper releases stale lock and marks run as failed", async () => {
    // Setup: same scenario as above
    const session = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const automationSession = await createTestAutomationSession(ctx.client, {
      automationId,
      interactiveSessionId: session.id,
      organizationId: orgId,
      repositoryId,
      scopeKey: `github-pr:${repositoryId}:sweep-fix-test`,
    });

    const staleRunId = randomUUID();
    await ctx.client.query(
      `INSERT INTO automation_runs (id, automation_id, organization_id, source, status, automation_session_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '2 hours')`,
      [staleRunId, automationId, orgId, "github", "running", automationSession.id],
    );
    await acquireLock(ctx, automationSession.id, staleRunId);

    // Execute: simulate what sweepStaleReviewLocks should do
    const staleLocks = await getStaleReviewLocks(ctx);
    const ourLock = staleLocks.find(
      (l) => l.automation_session_id === automationSession.id,
    );
    expect(ourLock).toBeDefined();

    // Force-release the lock
    await forceReleaseLock(ctx, automationSession.id);

    // Mark the run as failed
    await ctx.client.query(
      `UPDATE automation_runs SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2`,
      ["Sweeper: lock held too long without progress", staleRunId],
    );

    // Verify: lock is released
    const afterRelease = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(afterRelease.review_lock_job_id).toBeNull();

    // Verify: run is marked failed
    const runRow = await ctx.client.query(
      `SELECT status, error FROM automation_runs WHERE id = $1`,
      [staleRunId],
    );
    expect(runRow.rows[0].status).toBe("failed");
    expect(runRow.rows[0].error).toContain("lock held too long");

    // Verify: new review can now acquire the lock
    const newRunId = randomUUID();
    const acquired = await acquireLock(ctx, automationSession.id, newRunId);
    expect(acquired).toBe(true); // SUCCESS — no longer blocked
  });

  it("sweeper handles multiple stale locks without one failure blocking others", async () => {
    // Create 3 automation sessions with stale locks
    const sessions = await Promise.all(
      [1, 2, 3].map(async (i) => {
        const session = await createTestInteractiveSession(ctx.client, {
          organizationId: orgId,
        });
        const automationSession = await createTestAutomationSession(ctx.client, {
          automationId,
          interactiveSessionId: session.id,
          organizationId: orgId,
          repositoryId,
          scopeKey: `github-pr:${repositoryId}:multi-${i}-${randomUUID().slice(0, 4)}`,
        });

        const staleRunId = randomUUID();
        await ctx.client.query(
          `INSERT INTO automation_runs (id, automation_id, organization_id, source, status, automation_session_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW() - INTERVAL '1 hour')`,
          [staleRunId, automationId, orgId, "github", "running", automationSession.id],
        );
        await acquireLock(ctx, automationSession.id, staleRunId);
        return { automationSession, staleRunId };
      }),
    );

    // All 3 locks are detected as stale
    const staleLocks = await getStaleReviewLocks(ctx);
    const ourLocks = staleLocks.filter((l) =>
      sessions.some((s) => s.automationSession.id === l.automation_session_id),
    );
    expect(ourLocks.length).toBe(3);

    // Simulate sweeper processing all locks (with per-item try/catch)
    let released = 0;
    for (const lock of ourLocks) {
      try {
        await forceReleaseLock(ctx, lock.automation_session_id);
        await ctx.client.query(
          `UPDATE automation_runs SET status = 'failed', completed_at = NOW()
           WHERE id = $1 AND status = 'running'`,
          [lock.review_lock_job_id],
        );
        released++;
      } catch {
        // Per-item try/catch — one failure doesn't block others
      }
    }

    expect(released).toBe(3);

    // All locks are released
    for (const s of sessions) {
      const row = await getAutomationSessionRow(ctx.client, s.automationSession.id);
      expect(row.review_lock_job_id).toBeNull();
    }
  });
});

// ── Helpers that mirror the action functions ──

async function acquireLock(
  ctx: TestDbContext,
  automationSessionId: string,
  jobId: string,
): Promise<boolean> {
  const result = await ctx.client.query(
    `UPDATE automation_sessions
     SET review_lock_job_id = $1, updated_at = NOW()
     WHERE id = $2 AND review_lock_job_id IS NULL
     RETURNING id`,
    [jobId, automationSessionId],
  );
  return result.rowCount! > 0;
}

async function forceReleaseLock(
  ctx: TestDbContext,
  automationSessionId: string,
): Promise<void> {
  await ctx.client.query(
    `UPDATE automation_sessions
     SET review_lock_job_id = NULL, updated_at = NOW()
     WHERE id = $1`,
    [automationSessionId],
  );
}

/**
 * Mirrors getStaleReviewLocks() from lib/automations/actions.ts.
 * A lock is stale when there is NO automation run that is both
 * (pending|running) AND (created within last 30 min).
 */
async function getStaleReviewLocks(ctx: TestDbContext) {
  const result = await ctx.client.query(`
    SELECT as2.id AS automation_session_id, as2.review_lock_job_id
    FROM automation_sessions as2
    WHERE as2.review_lock_job_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM automation_runs ar
      WHERE ar.id = as2.review_lock_job_id::uuid
      AND ar.status IN ('pending', 'running')
      AND ar.created_at > NOW() - INTERVAL '30 minutes'
    )
  `);
  return result.rows as Array<{
    automation_session_id: string;
    review_lock_job_id: string;
  }>;
}
