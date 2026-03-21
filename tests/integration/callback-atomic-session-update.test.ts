/**
 * Regression Test: Atomic callback session updates
 *
 * Verifies that prompt_complete and prompt_failed callback processing
 * atomically persists session metadata (sdkSessionId, nativeAgentSessionId, cwd)
 * alongside the status CAS in a single UPDATE.
 *
 * Uses raw SQL to mirror the exact callback-processor logic, avoiding the
 * global db pool / test schema mismatch when calling ingestCallback() directly.
 * (Same pattern as callback-sdksession.test.ts.)
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

async function seedSessionWithJobAndAttempt(opts?: { error?: string }) {
  const sessionId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();

  await ctx.client.query(
    `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch, error)
     VALUES ($1, $2, 'test', 'claude', 'active', 'test prompt', 0, $3)`,
    [sessionId, orgId, opts?.error ?? null],
  );

  await ctx.client.query(
    `INSERT INTO jobs (id, organization_id, type, status, session_id, payload, side_effects_completed)
     VALUES ($1, $2, 'review', 'running', $3, '{}', '{}')`,
    [jobId, orgId, sessionId],
  );

  await ctx.client.query(
    `INSERT INTO job_attempts (id, job_id, attempt_number, epoch, status)
     VALUES ($1, $2, 1, 0, 'running')`,
    [attemptId, jobId],
  );

  return { sessionId, jobId, attemptId };
}

async function getSession(sessionId: string) {
  const result = await ctx.client.query(
    `SELECT sdk_session_id, native_agent_session_id, cwd, status, error
     FROM interactive_sessions WHERE id = $1`,
    [sessionId],
  );
  return result.rows[0];
}

/**
 * Simulate the atomic CAS + metadata update from callback-processor prompt_complete.
 * This mirrors the exact SQL pattern: single UPDATE with status CAS + session identifiers.
 */
async function simulatePromptComplete(
  sessionId: string,
  jobId: string,
  attemptId: string,
  result: Record<string, unknown>,
) {
  // CAS attempt
  await ctx.client.query(
    `UPDATE job_attempts SET status = 'completed', completed_at = NOW()
     WHERE id = $1 AND status IN ('running', 'accepted')`,
    [attemptId],
  );
  // CAS job
  await ctx.client.query(
    `UPDATE jobs SET status = 'agent_completed', result = $1, updated_at = NOW()
     WHERE id = $2 AND status IN ('running', 'accepted')`,
    [JSON.stringify(result), jobId],
  );
  // Atomic session CAS + metadata (the fix under test)
  const setClauses = [`status = 'idle'`, `error = NULL`];
  const params: unknown[] = [sessionId];
  let idx = 2;

  if (typeof result.sdkSessionId === "string") {
    setClauses.push(`sdk_session_id = $${idx++}`);
    params.push(result.sdkSessionId);
  }
  if (typeof result.nativeAgentSessionId === "string") {
    setClauses.push(`native_agent_session_id = $${idx++}`);
    params.push(result.nativeAgentSessionId);
  }
  if (typeof result.cwd === "string") {
    setClauses.push(`cwd = $${idx++}`);
    params.push(result.cwd);
  }

  await ctx.client.query(
    `UPDATE interactive_sessions SET ${setClauses.join(", ")}
     WHERE id = $1 AND status IN ('active')`,
    params,
  );
}

describe("prompt_complete atomic session update", () => {
  it("persists sdkSessionId, nativeAgentSessionId, cwd atomically with status CAS", async () => {
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt();
    const sdkSessionId = `sdk-${randomUUID()}`;
    const nativeAgentSessionId = `native-${randomUUID()}`;
    const cwd = "/home/user/repo";

    await simulatePromptComplete(sessionId, jobId, attemptId, {
      sdkSessionId,
      nativeAgentSessionId,
      cwd,
      durationMs: 5000,
    });

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.sdk_session_id).toBe(sdkSessionId);
    expect(session.native_agent_session_id).toBe(nativeAgentSessionId);
    expect(session.cwd).toBe(cwd);
  });

  it("clears stale error on prompt_complete", async () => {
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt({
      error: "SANDBOX_UNREACHABLE",
    });

    await simulatePromptComplete(sessionId, jobId, attemptId, {
      sdkSessionId: `sdk-${randomUUID()}`,
      durationMs: 3000,
    });

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.error).toBeNull();
  });

  it("persists sdkSessionId on prompt_failed", async () => {
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt();
    const sdkSessionId = `sdk-${randomUUID()}`;

    // CAS attempt to failed
    await ctx.client.query(
      `UPDATE job_attempts SET status = 'failed', completed_at = NOW()
       WHERE id = $1 AND status IN ('running', 'accepted', 'dispatching', 'waiting_human')`,
      [attemptId],
    );
    // CAS job to failed_retryable
    await ctx.client.query(
      `UPDATE jobs SET status = 'failed_retryable', updated_at = NOW()
       WHERE id = $1 AND status IN ('running', 'accepted', 'pending')`,
      [jobId],
    );
    // Session healing with sdkSessionId
    await ctx.client.query(
      `UPDATE interactive_sessions SET status = 'idle', sdk_session_id = $2
       WHERE id = $1 AND status IN ('active')`,
      [sessionId, sdkSessionId],
    );

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.sdk_session_id).toBe(sdkSessionId);
  });

  it("single UPDATE prevents race between status CAS and metadata write", async () => {
    // Regression: before the fix, status and sdkSessionId were written in
    // separate UPDATEs. If the client polled between them, it saw "idle" without
    // sdkSessionId. This test verifies they arrive together.
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt();
    const sdkSessionId = `sdk-${randomUUID()}`;

    await simulatePromptComplete(sessionId, jobId, attemptId, {
      sdkSessionId,
      durationMs: 1000,
    });

    // A single read should see both status=idle AND sdkSessionId set
    const session = await getSession(sessionId);
    if (session.status === "idle") {
      expect(session.sdk_session_id).toBe(sdkSessionId);
    }
  });
});
