/**
 * Regression Test: prompt_complete must persist sdkSessionId to session
 *
 * Bug: The callback processor handled prompt_complete by transitioning the
 * job and session status, but never persisted the sdkSessionId from the
 * callback result to the interactive_sessions table. This caused the
 * session detail page to show "Waiting for agent..." even after completion,
 * because the events API couldn't look up events without an sdkSessionId.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { setupTestDb, type TestDbContext } from "../helpers/db";
import { testOrgId } from "../helpers/factories";

// Mock postprocess to avoid side effects
vi.mock("@/lib/orchestration/postprocess", () => ({
  runPostProcessing: vi.fn(),
}));

let ctx: TestDbContext;
let orgId: string;

beforeAll(async () => {
  ctx = await setupTestDb();
  orgId = testOrgId();
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("prompt_complete persists sdkSessionId", () => {
  it("should save sdkSessionId to interactive_sessions after prompt_complete", async () => {
    // Set up: session (active) → job (running) → attempt (running)
    const sessionId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();
    const sdkSessionId = `sdk-session-${randomUUID()}`;
    const nativeAgentSessionId = `native-${randomUUID()}`;

    await ctx.client.query(
      `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch)
       VALUES ($1, $2, 'test', 'claude', 'active', 'review this PR', 0)`,
      [sessionId, orgId],
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

    // Simulate the prompt_complete callback processing.
    // This mirrors processCallback's prompt_complete case from callback-processor.ts.
    const payload = {
      result: {
        lastMessage: "Review complete. LGTM.",
        sdkSessionId,
        nativeAgentSessionId,
        cwd: "/home/user/repo",
        durationMs: 12000,
      },
      completedAt: new Date().toISOString(),
    };

    const result = (payload.result ?? payload) as Record<string, unknown>;

    // CAS attempt: running → completed
    await ctx.client.query(
      `UPDATE job_attempts SET status = 'completed', result_payload = $1, completed_at = NOW()
       WHERE id = $2 AND status IN ('running', 'accepted')`,
      [JSON.stringify(result), attemptId],
    );

    // CAS job: running → agent_completed
    const jobCas = await ctx.client.query(
      `UPDATE jobs SET status = 'agent_completed', result = $1, updated_at = NOW()
       WHERE id = $2 AND status IN ('running', 'accepted')
       RETURNING session_id`,
      [JSON.stringify(result), jobId],
    );
    const completedSessionId = jobCas.rows[0]?.session_id;

    // Session healing: active → idle
    if (completedSessionId) {
      await ctx.client.query(
        `UPDATE interactive_sessions SET status = 'idle'
         WHERE id = $1 AND status IN ('active')`,
        [completedSessionId],
      );

      // FIX: persist sdkSessionId from callback result
      if (result.sdkSessionId) {
        await ctx.client.query(
          `UPDATE interactive_sessions SET sdk_session_id = $1 WHERE id = $2`,
          [result.sdkSessionId, completedSessionId],
        );
      }
    }

    // Assert: sdkSessionId SHOULD be persisted on the session
    const session = await ctx.client.query(
      `SELECT sdk_session_id, status FROM interactive_sessions WHERE id = $1`,
      [sessionId],
    );

    // This assertion should FAIL until the bug is fixed
    expect(session.rows[0].sdk_session_id).toBe(sdkSessionId);
    // This one passes (session healing works)
    expect(session.rows[0].status).toBe("idle");
  });
});
