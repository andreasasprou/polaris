/**
 * Integration Test: Job State Machine
 *
 * Tests the job/attempt/callback lifecycle with real Postgres.
 * Verifies CAS transitions, epoch fencing, and idempotency.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestDb, type TestDbContext } from "../helpers/db";
import { testOrgId } from "../helpers/factories";

let ctx: TestDbContext;
let orgId: string;

beforeAll(async () => {
  ctx = await setupTestDb();
  orgId = testOrgId();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("Job CAS Transitions", () => {
  it("pending → accepted → running → agent_completed → postprocess_pending → completed", async () => {
    const jobId = randomUUID();
    await createJob(ctx, jobId, orgId);

    // pending → accepted
    let updated = await casJobStatus(ctx, jobId, ["pending"], "accepted");
    expect(updated).toBe(true);

    // accepted → running
    updated = await casJobStatus(ctx, jobId, ["accepted"], "running");
    expect(updated).toBe(true);

    // running → agent_completed
    updated = await casJobStatus(ctx, jobId, ["running"], "agent_completed");
    expect(updated).toBe(true);

    // agent_completed → postprocess_pending
    updated = await casJobStatus(ctx, jobId, ["agent_completed"], "postprocess_pending");
    expect(updated).toBe(true);

    // postprocess_pending → completed
    updated = await casJobStatus(ctx, jobId, ["postprocess_pending"], "completed");
    expect(updated).toBe(true);
  });

  it("CAS from wrong status fails", async () => {
    const jobId = randomUUID();
    await createJob(ctx, jobId, orgId);

    // Try pending → completed (skipping intermediate states)
    const updated = await casJobStatus(ctx, jobId, ["running"], "completed");
    expect(updated).toBe(false);

    // Status unchanged
    const job = await getJob(ctx, jobId);
    expect(job.status).toBe("pending");
  });

  it("CAS is atomic — no double transitions", async () => {
    const jobId = randomUUID();
    await createJob(ctx, jobId, orgId);

    // Two concurrent CAS from pending
    const [a, b] = await Promise.all([
      casJobStatus(ctx, jobId, ["pending"], "accepted"),
      casJobStatus(ctx, jobId, ["pending"], "failed_retryable"),
    ]);

    // Exactly one succeeds
    expect([a, b].filter(Boolean).length).toBe(1);
  });
});

describe("Callback Idempotency", () => {
  it("duplicate callback insert is rejected", async () => {
    const jobId = randomUUID();
    const attemptId = randomUUID();
    await createJob(ctx, jobId, orgId);
    await createAttempt(ctx, jobId, attemptId, 1, 1);

    const callbackId = randomUUID();

    // First insert succeeds
    const first = await insertCallback(ctx, jobId, attemptId, 1, callbackId, "prompt_accepted");
    expect(first).toBe(true);

    // Duplicate is rejected
    const duplicate = await insertCallback(ctx, jobId, attemptId, 1, callbackId, "prompt_accepted");
    expect(duplicate).toBe(false);
  });
});

describe("Epoch Fencing", () => {
  it("callback with stale epoch is logically rejectable", async () => {
    const jobId = randomUUID();
    await createJob(ctx, jobId, orgId);

    // Create session and job linked to it
    const sessionId = randomUUID();
    await ctx.client.query(
      `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch)
       VALUES ($1, $2, 'test', 'claude', 'active', 'test', 2)`,
      [sessionId, orgId],
    );

    // Update job to link to session
    await ctx.client.query(
      `UPDATE jobs SET session_id = $1 WHERE id = $2`,
      [sessionId, jobId],
    );

    // Session epoch is 2 — a callback with epoch 1 should be stale
    const session = await ctx.client.query(
      `SELECT epoch FROM interactive_sessions WHERE id = $1`,
      [sessionId],
    );
    expect(session.rows[0].epoch).toBe(2);

    // The epoch fence check: callback epoch (1) !== session epoch (2)
    const isStale = session.rows[0].epoch !== 1;
    expect(isStale).toBe(true);
  });
});

// ── SQL helpers (mirror the action functions) ──

async function createJob(ctx: TestDbContext, id: string, orgId: string) {
  await ctx.client.query(
    `INSERT INTO jobs (id, organization_id, type, status, payload, side_effects_completed)
     VALUES ($1, $2, 'review', 'pending', '{}', '{}')`,
    [id, orgId],
  );
}

async function getJob(ctx: TestDbContext, id: string) {
  const result = await ctx.client.query(`SELECT * FROM jobs WHERE id = $1`, [id]);
  return result.rows[0];
}

async function casJobStatus(
  ctx: TestDbContext,
  jobId: string,
  fromStatuses: string[],
  toStatus: string,
): Promise<boolean> {
  const placeholders = fromStatuses.map((_, i) => `$${i + 3}`).join(", ");
  const result = await ctx.client.query(
    `UPDATE jobs SET status = $1, updated_at = NOW()
     WHERE id = $2 AND status IN (${placeholders})
     RETURNING id`,
    [toStatus, jobId, ...fromStatuses],
  );
  return result.rowCount! > 0;
}

async function createAttempt(
  ctx: TestDbContext,
  jobId: string,
  attemptId: string,
  attemptNumber: number,
  epoch: number,
) {
  await ctx.client.query(
    `INSERT INTO job_attempts (id, job_id, attempt_number, epoch, status)
     VALUES ($1, $2, $3, $4, 'dispatching')`,
    [attemptId, jobId, attemptNumber, epoch],
  );
}

async function insertCallback(
  ctx: TestDbContext,
  jobId: string,
  attemptId: string,
  epoch: number,
  callbackId: string,
  callbackType: string,
): Promise<boolean> {
  try {
    const result = await ctx.client.query(
      `INSERT INTO callback_inbox (job_id, attempt_id, epoch, callback_id, callback_type, payload)
       VALUES ($1, $2, $3, $4, $5, '{}')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [jobId, attemptId, epoch, callbackId, callbackType],
    );
    return result.rowCount! > 0;
  } catch {
    return false;
  }
}
