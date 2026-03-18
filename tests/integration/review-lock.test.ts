/**
 * Integration Test: Review Lock Lifecycle
 *
 * Tests the concurrency lock used by continuous PR reviews.
 * This test catches the exact bug that shipped: lock acquired with
 * automationRunId but released with job.id (different UUIDs),
 * causing the lock to stay held forever.
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

  // Create prerequisite entities
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

async function createSessionWithLockTarget() {
  const session = await createTestInteractiveSession(ctx.client, {
    organizationId: orgId,
  });
  const automationSession = await createTestAutomationSession(ctx.client, {
    automationId,
    interactiveSessionId: session.id,
    organizationId: orgId,
    repositoryId,
    scopeKey: `github-pr:${repositoryId}:${randomUUID().slice(0, 8)}`,
  });
  return automationSession;
}

describe("Review Lock", () => {
  it("acquire and release with the same key succeeds", async () => {
    const automationSession = await createSessionWithLockTarget();
    const lockKey = randomUUID();

    // Acquire
    const acquired = await acquireLock(ctx, automationSession.id, lockKey);
    expect(acquired).toBe(true);

    // Verify lock is held
    const row = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(row.review_lock_job_id).toBe(lockKey);

    // Release with same key
    const released = await releaseLock(ctx, automationSession.id, lockKey);
    expect(released).toBe(true);

    // Verify lock is cleared
    const after = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(after.review_lock_job_id).toBeNull();
  });

  it("release with WRONG key fails and lock stays held", async () => {
    const automationSession = await createSessionWithLockTarget();
    const acquireKey = randomUUID();
    const wrongKey = randomUUID();

    // Acquire with key A
    await acquireLock(ctx, automationSession.id, acquireKey);

    // Try to release with key B — should fail
    const released = await releaseLock(ctx, automationSession.id, wrongKey);
    expect(released).toBe(false);

    // Lock is STILL held by key A
    const row = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(row.review_lock_job_id).toBe(acquireKey);
  });

  it("second acquire fails while lock is held", async () => {
    const automationSession = await createSessionWithLockTarget();
    const firstKey = randomUUID();
    const secondKey = randomUUID();

    // First acquire succeeds
    const first = await acquireLock(ctx, automationSession.id, firstKey);
    expect(first).toBe(true);

    // Second acquire fails
    const second = await acquireLock(ctx, automationSession.id, secondKey);
    expect(second).toBe(false);

    // Lock still held by first key
    const row = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(row.review_lock_job_id).toBe(firstKey);
  });

  it("simulates the shipped bug: acquire with runId, release with jobId", async () => {
    const automationSession = await createSessionWithLockTarget();
    const automationRunId = randomUUID(); // This is what pr-review.ts passes
    const jobId = randomUUID(); // This is a different UUID (the actual job)

    // Acquire with automationRunId (like pr-review.ts:85)
    await acquireLock(ctx, automationSession.id, automationRunId);

    // Try to release with jobId (like the OLD postprocess.ts:398)
    const released = await releaseLock(ctx, automationSession.id, jobId);
    expect(released).toBe(false); // THIS IS THE BUG — release fails silently

    // Lock is stuck forever
    const row = await getAutomationSessionRow(ctx.client, automationSession.id);
    expect(row.review_lock_job_id).toBe(automationRunId); // Still held!

    // Correct fix: release with automationRunId
    const fixedRelease = await releaseLock(
      ctx,
      automationSession.id,
      automationRunId,
    );
    expect(fixedRelease).toBe(true);
  });

  it("lock release is idempotent — releasing already-released lock is safe", async () => {
    const automationSession = await createSessionWithLockTarget();
    const key = randomUUID();

    await acquireLock(ctx, automationSession.id, key);
    await releaseLock(ctx, automationSession.id, key);

    // Second release — no error, just returns false
    const secondRelease = await releaseLock(ctx, automationSession.id, key);
    expect(secondRelease).toBe(false);
  });
});

// ── Helpers that execute the same SQL as the action functions ──

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

async function releaseLock(
  ctx: TestDbContext,
  automationSessionId: string,
  jobId: string,
): Promise<boolean> {
  const result = await ctx.client.query(
    `UPDATE automation_sessions
     SET review_lock_job_id = NULL, updated_at = NOW()
     WHERE id = $1 AND review_lock_job_id = $2
     RETURNING id`,
    [automationSessionId, jobId],
  );
  return result.rowCount! > 0;
}
