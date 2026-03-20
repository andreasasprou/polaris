/**
 * Integration Test: Atomic callback session updates
 *
 * Verifies that prompt_complete and prompt_failed callbacks atomically
 * persist session metadata (sdkSessionId, nativeAgentSessionId, cwd)
 * alongside the status CAS in a single UPDATE — preventing the race
 * where a client polls between status change and metadata write.
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

async function seedSessionWithJobAndAttempt(status = "active") {
  const sessionId = randomUUID();
  const jobId = randomUUID();
  const attemptId = randomUUID();

  await ctx.client.query(
    `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch)
     VALUES ($1, $2, 'test', 'claude', $3, 'test prompt', 0)`,
    [sessionId, orgId, status],
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

describe("prompt_complete atomic session update", () => {
  it("persists sdkSessionId, nativeAgentSessionId, cwd atomically with status CAS", async () => {
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt();
    const sdkSessionId = `sdk-${randomUUID()}`;
    const nativeAgentSessionId = `native-${randomUUID()}`;
    const cwd = "/home/user/repo";

    const { ingestCallback } = await import("@/lib/orchestration/callback-processor");

    await ingestCallback({
      jobId,
      attemptId,
      epoch: 0,
      callbackId: randomUUID(),
      callbackType: "prompt_complete",
      payload: {
        result: {
          lastMessage: "Done.",
          sdkSessionId,
          nativeAgentSessionId,
          cwd,
          durationMs: 5000,
        },
        completedAt: new Date().toISOString(),
      },
    });

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.sdk_session_id).toBe(sdkSessionId);
    expect(session.native_agent_session_id).toBe(nativeAgentSessionId);
    expect(session.cwd).toBe(cwd);
  });

  it("clears stale error on prompt_complete", async () => {
    const sessionId = randomUUID();
    const jobId = randomUUID();
    const attemptId = randomUUID();

    // Create session with a stale error
    await ctx.client.query(
      `INSERT INTO interactive_sessions (id, organization_id, created_by, agent_type, status, prompt, epoch, error)
       VALUES ($1, $2, 'test', 'claude', 'active', 'test prompt', 0, 'SANDBOX_UNREACHABLE')`,
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

    const { ingestCallback } = await import("@/lib/orchestration/callback-processor");

    await ingestCallback({
      jobId,
      attemptId,
      epoch: 0,
      callbackId: randomUUID(),
      callbackType: "prompt_complete",
      payload: {
        result: {
          lastMessage: "Done.",
          sdkSessionId: `sdk-${randomUUID()}`,
          durationMs: 3000,
        },
        completedAt: new Date().toISOString(),
      },
    });

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.error).toBeNull();
  });

  it("persists sdkSessionId on prompt_failed", async () => {
    const { sessionId, jobId, attemptId } = await seedSessionWithJobAndAttempt();
    const sdkSessionId = `sdk-${randomUUID()}`;

    const { ingestCallback } = await import("@/lib/orchestration/callback-processor");

    await ingestCallback({
      jobId,
      attemptId,
      epoch: 0,
      callbackId: randomUUID(),
      callbackType: "prompt_failed",
      payload: {
        error: "Agent crashed",
        reason: "agent_crash",
        sdkSessionId,
        durationMs: 2000,
      },
    });

    const session = await getSession(sessionId);
    expect(session.status).toBe("idle");
    expect(session.sdk_session_id).toBe(sdkSessionId);
  });
});
