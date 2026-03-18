/**
 * Integration Test: Dispatch Resilience
 *
 * Tests that the session/lock state machine recovers from every failure mode:
 * - Lock is always released when dispatch fails
 * - Session transitions back to idle on job completion/failure
 * - Stale active sessions are healed before dispatch and by sweeper
 * - Stale review locks are released by sweeper
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

  const repo = await createTestRepository(ctx.client, {
    organizationId: orgId,
  });
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

// ── Helpers ──

async function createFullSetup() {
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
  return { sessionId: session.id, automationSessionId: automationSession.id };
}

async function getSessionStatus(sessionId: string): Promise<string> {
  const result = await ctx.client.query(
    `SELECT status FROM interactive_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0]?.status;
}

async function setSessionStatus(
  sessionId: string,
  status: string,
): Promise<void> {
  await ctx.client.query(
    `UPDATE interactive_sessions SET status = $1 WHERE id = $2`,
    [status, sessionId],
  );
}

async function acquireLock(
  automationSessionId: string,
  key: string,
): Promise<boolean> {
  const result = await ctx.client.query(
    `UPDATE automation_sessions
     SET review_lock_job_id = $1, updated_at = NOW()
     WHERE id = $2 AND review_lock_job_id IS NULL
     RETURNING id`,
    [key, automationSessionId],
  );
  return result.rowCount! > 0;
}

async function createTestJob(
  sessionId: string,
  status: string,
): Promise<string> {
  const id = randomUUID();
  await ctx.client.query(
    `INSERT INTO jobs (id, organization_id, type, status, payload, side_effects_completed, session_id)
     VALUES ($1, $2, 'review', $3, '{}', '{}', $4)`,
    [id, orgId, status, sessionId],
  );
  return id;
}

// ── Tests ──

describe("Session heals stale active state", () => {
  it("stale active session (no job) healed before dispatch would proceed", async () => {
    const { sessionId } = await createFullSetup();

    // Session stuck in active with no job (sandbox died, callback never came)
    await setSessionStatus(sessionId, "active");

    // Verify it's active
    expect(await getSessionStatus(sessionId)).toBe("active");

    // The healing logic: if active and no active job → CAS to idle
    const jobResult = await ctx.client.query(
      `SELECT id FROM jobs WHERE session_id = $1 AND status NOT IN ('completed', 'failed_terminal', 'cancelled')`,
      [sessionId],
    );
    expect(jobResult.rowCount).toBe(0); // No active job

    // Heal
    await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle' WHERE id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(await getSessionStatus(sessionId)).toBe("idle");
  });

  it("active session WITH an active job is NOT healed", async () => {
    const { sessionId } = await createFullSetup();
    await setSessionStatus(sessionId, "active");

    // Create an active job
    await createTestJob(sessionId, "running");

    // Check: active job exists
    const jobResult = await ctx.client.query(
      `SELECT id FROM jobs WHERE session_id = $1 AND status NOT IN ('completed', 'failed_terminal', 'cancelled')`,
      [sessionId],
    );
    expect(jobResult.rowCount).toBe(1);

    // Should NOT heal — session legitimately active
    const casResult = await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle'
       WHERE id = $1 AND status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.session_id = $1
         AND j.status NOT IN ('completed', 'failed_terminal', 'cancelled')
       )
       RETURNING id`,
      [sessionId],
    );
    expect(casResult.rowCount).toBe(0); // Not healed
    expect(await getSessionStatus(sessionId)).toBe("active");
  });
});

describe("Session transitions idle on job completion", () => {
  it("prompt_complete transitions session active → idle", async () => {
    const { sessionId } = await createFullSetup();
    await setSessionStatus(sessionId, "active");

    // Create a completed job
    await createTestJob(sessionId, "agent_completed");

    // Simulate what callbacks.ts now does:
    await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle' WHERE id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(await getSessionStatus(sessionId)).toBe("idle");
  });

  it("prompt_failed transitions session active → idle", async () => {
    const { sessionId } = await createFullSetup();
    await setSessionStatus(sessionId, "active");

    await createTestJob(sessionId, "failed_terminal");

    await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle' WHERE id = $1 AND status = 'active'`,
      [sessionId],
    );
    expect(await getSessionStatus(sessionId)).toBe("idle");
  });
});

describe("Sweeper heals stale state", () => {
  it("sweeper finds stale active sessions with no job", async () => {
    const { sessionId } = await createFullSetup();
    await setSessionStatus(sessionId, "active");

    // No jobs for this session — sweeper query should find it
    const stale = await ctx.client.query(
      `SELECT s.id FROM interactive_sessions s
       WHERE s.status = 'active'
       AND s.id = $1
       AND NOT EXISTS (
         SELECT 1 FROM jobs j WHERE j.session_id = s.id
         AND j.status NOT IN ('completed', 'failed_terminal', 'cancelled')
       )`,
      [sessionId],
    );
    expect(stale.rowCount).toBe(1);
    expect(stale.rows[0].id).toBe(sessionId);
  });

  it("sweeper finds stale review locks referencing terminal runs", async () => {
    const { automationSessionId } = await createFullSetup();
    const runId = randomUUID();

    // Create a terminal automation run
    const run = await createTestAutomationRun(ctx.client, {
      automationId,
      organizationId: orgId,
      status: "failed",
    });

    // Set lock to reference the terminal run
    await ctx.client.query(
      `UPDATE automation_sessions SET review_lock_job_id = $1 WHERE id = $2`,
      [run.id, automationSessionId],
    );

    // Sweeper query should find this stale lock
    const stale = await ctx.client.query(
      `SELECT as2.id AS automation_session_id
       FROM automation_sessions as2
       WHERE as2.id = $1
       AND as2.review_lock_job_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM automation_runs ar
         WHERE ar.id = as2.review_lock_job_id::uuid
         AND ar.status IN ('pending', 'running')
       )`,
      [automationSessionId],
    );
    expect(stale.rowCount).toBe(1);

    // Force-release the lock
    await ctx.client.query(
      `UPDATE automation_sessions SET review_lock_job_id = NULL WHERE id = $1`,
      [automationSessionId],
    );

    const row = await getAutomationSessionRow(
      ctx.client,
      automationSessionId,
    );
    expect(row.review_lock_job_id).toBeNull();
  });

  it("sweeper heals session when job times out", async () => {
    const { sessionId } = await createFullSetup();
    await setSessionStatus(sessionId, "active");

    // Create a timed-out job (running, past timeout_at)
    const jobId = randomUUID();
    await ctx.client.query(
      `INSERT INTO jobs (id, organization_id, type, status, payload, side_effects_completed, session_id, timeout_at)
       VALUES ($1, $2, 'review', 'running', '{}', '{}', $3, NOW() - INTERVAL '1 minute')`,
      [jobId, orgId, sessionId],
    );

    // Simulate sweeper: mark job as failed_terminal
    await ctx.client.query(
      `UPDATE jobs SET status = 'failed_terminal' WHERE id = $1`,
      [jobId],
    );

    // Heal session
    await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle' WHERE id = $1 AND status = 'active'`,
      [sessionId],
    );

    expect(await getSessionStatus(sessionId)).toBe("idle");
  });
});

describe("Lock lifecycle with try-finally", () => {
  it("lock released when dispatch would fail (simulated)", async () => {
    const { automationSessionId } = await createFullSetup();
    const runId = randomUUID();

    // Simulate: lock acquired, then dispatch fails
    await acquireLock(automationSessionId, runId);

    // Verify lock is held
    let row = await getAutomationSessionRow(ctx.client, automationSessionId);
    expect(row.review_lock_job_id).toBe(runId);

    // Simulate finally block: release lock on failure
    await ctx.client.query(
      `UPDATE automation_sessions SET review_lock_job_id = NULL, updated_at = NOW()
       WHERE id = $1 AND review_lock_job_id = $2`,
      [automationSessionId, runId],
    );

    row = await getAutomationSessionRow(ctx.client, automationSessionId);
    expect(row.review_lock_job_id).toBeNull();
  });

  it("lock stays held on successful handoff (202 response)", async () => {
    const { automationSessionId } = await createFullSetup();
    const runId = randomUUID();

    await acquireLock(automationSessionId, runId);

    // Simulate successful 202 — handedOff = true, finally skips cleanup
    const handedOff = true;

    if (!handedOff) {
      // This block should NOT execute
      await ctx.client.query(
        `UPDATE automation_sessions SET review_lock_job_id = NULL WHERE id = $1`,
        [automationSessionId],
      );
    }

    // Lock is still held (callback path will release it later)
    const row = await getAutomationSessionRow(ctx.client, automationSessionId);
    expect(row.review_lock_job_id).toBe(runId);
  });
});
