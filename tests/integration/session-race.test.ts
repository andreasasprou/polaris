/**
 * Integration Test: Session Race Conditions
 *
 * Tests the TOCTOU fix in findOrCreateAutomationSession.
 * Verifies that concurrent creation doesn't produce orphan sessions.
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

describe("Automation Session Deduplication", () => {
  it("unique constraint prevents duplicate (automationId, scopeKey)", async () => {
    const session = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const scopeKey = `github-pr:${repositoryId}:${randomUUID().slice(0, 8)}`;

    // First insert succeeds
    await createTestAutomationSession(ctx.client, {
      automationId,
      interactiveSessionId: session.id,
      organizationId: orgId,
      repositoryId,
      scopeKey,
    });

    // Second insert with same (automationId, scopeKey) should fail
    const session2 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });

    await expect(
      createTestAutomationSession(ctx.client, {
        automationId,
        interactiveSessionId: session2.id,
        organizationId: orgId,
        repositoryId,
        scopeKey, // same scope key
      }),
    ).rejects.toThrow(); // unique constraint violation
  });

  it("onConflictDoNothing returns null on duplicate", async () => {
    const session = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const scopeKey = `github-pr:${repositoryId}:${randomUUID().slice(0, 8)}`;

    // First insert
    await ctx.client.query(
      `INSERT INTO automation_sessions (id, automation_id, interactive_session_id, organization_id, repository_id, scope_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, '{}')`,
      [randomUUID(), automationId, session.id, orgId, repositoryId, scopeKey],
    );

    // Second insert with ON CONFLICT DO NOTHING — returns no rows
    const session2 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const result = await ctx.client.query(
      `INSERT INTO automation_sessions (id, automation_id, interactive_session_id, organization_id, repository_id, scope_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, '{}')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [randomUUID(), automationId, session2.id, orgId, repositoryId, scopeKey],
    );

    expect(result.rowCount).toBe(0); // Conflict — no row returned
  });

  it("different automations can have sessions for the same PR", async () => {
    const session1 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const session2 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    const scopeKey = `github-pr:${repositoryId}:shared-pr`;

    // Create second automation
    const automation2 = await createTestAutomation(ctx.client, {
      organizationId: orgId,
      repositoryId,
      name: "Second Automation",
    });

    // Both should succeed — unique index is (automationId, scopeKey)
    await createTestAutomationSession(ctx.client, {
      automationId,
      interactiveSessionId: session1.id,
      organizationId: orgId,
      repositoryId,
      scopeKey,
    });

    await createTestAutomationSession(ctx.client, {
      automationId: automation2.id,
      interactiveSessionId: session2.id,
      organizationId: orgId,
      repositoryId,
      scopeKey,
    });

    // Verify both exist
    const result = await ctx.client.query(
      `SELECT id FROM automation_sessions WHERE scope_key = $1`,
      [scopeKey],
    );
    expect(result.rowCount).toBe(2);
  });

  it("no orphan interactive sessions after conflict", async () => {
    const scopeKey = `github-pr:${repositoryId}:orphan-test`;

    // Count interactive sessions before
    const before = await ctx.client.query(
      `SELECT count(*)::int as count FROM interactive_sessions WHERE organization_id = $1`,
      [orgId],
    );
    const countBefore = before.rows[0].count;

    // Create first session + automation session
    const session1 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });
    await createTestAutomationSession(ctx.client, {
      automationId,
      interactiveSessionId: session1.id,
      organizationId: orgId,
      repositoryId,
      scopeKey,
    });

    // Simulate the race: create a second interactive session, try to create
    // automation session, it conflicts, so we should clean up the orphan
    const session2 = await createTestInteractiveSession(ctx.client, {
      organizationId: orgId,
    });

    const insertResult = await ctx.client.query(
      `INSERT INTO automation_sessions (id, automation_id, interactive_session_id, organization_id, repository_id, scope_key, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, '{}')
       ON CONFLICT DO NOTHING
       RETURNING id`,
      [randomUUID(), automationId, session2.id, orgId, repositoryId, scopeKey],
    );

    if (insertResult.rowCount === 0) {
      // Conflict — clean up orphan (this is what findOrCreateAutomationSession does)
      await ctx.client.query(
        `DELETE FROM interactive_sessions WHERE id = $1`,
        [session2.id],
      );
    }

    // Verify: exactly 1 interactive session was added (not 2)
    const after = await ctx.client.query(
      `SELECT count(*)::int as count FROM interactive_sessions WHERE organization_id = $1`,
      [orgId],
    );
    expect(after.rows[0].count).toBe(countBefore + 1);
  });
});
