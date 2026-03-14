/**
 * QA Test: Two-Phase Waiting (.once() + .wait())
 *
 * Tests the interactive session task's idle-loop behavior:
 *   1. Trigger a session → verify it goes active
 *   2. Wait for prompt completion → verify warm transition
 *   3. Send follow-up during warm → verify instant resume
 *   4. Wait past warm timeout → verify suspended transition
 *   5. Send follow-up during suspended → verify task resumes
 *   6. Stop session → verify clean shutdown
 *
 * Usage:
 *   npx tsx scripts/qa-two-phase-waiting.ts
 *
 * Required env vars:
 *   DATABASE_URL, TRIGGER_SECRET_KEY, ANTHROPIC_API_KEY (or CLAUDE_CODE_OAUTH_TOKEN)
 *
 * Optional:
 *   TEST_REPO_OWNER, TEST_REPO_NAME, TEST_GITHUB_INSTALLATION_ID
 *   — defaults to the first repo/installation found in the DB
 *
 * Tip: Lower WARM_TIMEOUT_MS to 15s and .wait() timeout to "1m" in
 *      trigger/interactive-session.ts for faster test cycles.
 */

import { tasks, configure } from "@trigger.dev/sdk/v3";
import { eq, desc } from "drizzle-orm";

// Configure Trigger.dev SDK for local dev
configure({
  secretKey: process.env.TRIGGER_SECRET_KEY,
});

import { db, pool } from "../lib/db";
import {
  interactiveSessions,
  interactiveSessionRuntimes,
} from "../lib/sessions/schema";
import { createRuntime } from "../lib/sessions/actions";
import { sessionMessages } from "../lib/trigger/streams";
import type { interactiveSessionTask } from "../trigger/interactive-session";
import { randomUUID } from "node:crypto";

// ── Config ──

const POLL_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 300_000; // 5 min max wait per step

type TestResult = {
  name: string;
  status: "pass" | "fail" | "skip";
  duration: number;
  details?: string;
};

const results: TestResult[] = [];
let sessionId: string | null = null;
let triggerRunId: string | null = null;

// ── Helpers ──

function log(msg: string) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`[${ts}] ${msg}`);
}

async function pollSessionStatus(
  targetStatuses: string[],
  timeoutMs = MAX_WAIT_MS,
): Promise<string | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const [row] = await db
      .select({ status: interactiveSessions.status })
      .from(interactiveSessions)
      .where(eq(interactiveSessions.id, sessionId!))
      .limit(1);

    if (row && targetStatuses.includes(row.status)) {
      return row.status;
    }

    await sleep(POLL_INTERVAL_MS);
  }
  return null;
}

async function getSession() {
  const [row] = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, sessionId!))
    .limit(1);
  return row ?? null;
}

async function getLatestRuntime() {
  const [row] = await db
    .select()
    .from(interactiveSessionRuntimes)
    .where(eq(interactiveSessionRuntimes.sessionId, sessionId!))
    .orderBy(desc(interactiveSessionRuntimes.createdAt))
    .limit(1);
  return row ?? null;
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runTest(
  name: string,
  fn: () => Promise<void>,
): Promise<void> {
  const start = Date.now();
  log(`\n── ${name} ──`);
  try {
    await fn();
    const duration = Date.now() - start;
    results.push({ name, status: "pass", duration });
    log(`  PASS (${duration}ms)`);
  } catch (err) {
    const duration = Date.now() - start;
    const details = err instanceof Error ? err.message : String(err);
    results.push({ name, status: "fail", duration, details });
    log(`  FAIL (${duration}ms): ${details}`);
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(message);
}

// ── Resolve test fixtures from DB ──

async function resolveTestFixtures() {
  const owner = process.env.TEST_REPO_OWNER;
  const name = process.env.TEST_REPO_NAME;
  const installId = process.env.TEST_GITHUB_INSTALLATION_ID
    ? parseInt(process.env.TEST_GITHUB_INSTALLATION_ID, 10)
    : undefined;

  if (owner && name && installId) {
    return {
      repositoryOwner: owner,
      repositoryName: name,
      githubInstallationId: installId,
    };
  }

  // Fall back to first repo in DB
  const { repositories } = await import("../lib/integrations/schema");
  const { githubInstallations } = await import("../lib/integrations/schema");

  const [repo] = await db.select().from(repositories).limit(1);
  if (!repo) throw new Error("No repositories found in DB. Set TEST_REPO_* env vars.");

  const [installation] = await db
    .select()
    .from(githubInstallations)
    .where(eq(githubInstallations.id, repo.githubInstallationId))
    .limit(1);

  if (!installation) throw new Error("No GitHub installation found for repo.");

  return {
    repositoryOwner: repo.owner,
    repositoryName: repo.name,
    defaultBranch: repo.defaultBranch,
    githubInstallationId: installation.installationId,
    repositoryId: repo.id,
  };
}

async function resolveOrgAndUser() {
  const { member: memberTable } = await import("../lib/db/auth-schema");
  const [row] = await db.select().from(memberTable).limit(1);
  if (!row) throw new Error("No members found in DB");
  return { orgId: row.organizationId, userId: row.userId };
}

// ── Tests ──

async function main() {
  log("QA Test: Two-Phase Waiting");
  log("=".repeat(50));

  // Resolve fixtures
  const fixtures = await resolveTestFixtures();
  const { orgId, userId } = await resolveOrgAndUser();
  log(`Repo: ${fixtures.repositoryOwner}/${fixtures.repositoryName}`);
  log(`Org: ${orgId}`);

  const agentApiKey =
    process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (!agentApiKey) throw new Error("Need ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN");

  // ── Test 1: Trigger session and verify active ──
  await runTest("1. Trigger session → active", async () => {
    // Create session record
    const [session] = await db
      .insert(interactiveSessions)
      .values({
        organizationId: orgId,
        createdBy: userId,
        agentType: "claude",
        repositoryId: (fixtures as Record<string, unknown>).repositoryId as string | undefined,
        prompt: "What files are in this repository? List the top 5.",
      })
      .returning();

    sessionId = session.id;
    log(`  Session created: ${sessionId}`);

    // Create runtime record (normally done by the prompt API route)
    const runtime = await createRuntime({
      sessionId,
      restoreSource: "qa_test",
    });
    log(`  Runtime created: ${runtime.id}`);

    // Trigger the task
    const handle = await tasks.trigger<typeof interactiveSessionTask>(
      "interactive-session",
      {
        sessionId,
        orgId,
        agentType: "claude" as const,
        agentApiKey,
        repositoryOwner: fixtures.repositoryOwner,
        repositoryName: fixtures.repositoryName,
        defaultBranch: (fixtures as Record<string, unknown>).defaultBranch as string | undefined,
        githubInstallationId: fixtures.githubInstallationId,
        prompt: "What files are in this repository? List the top 5.",
        runtimeId: runtime.id,
      },
      { tags: [`session:${sessionId}`, "qa-test"] },
    );

    triggerRunId = handle.id;
    log(`  Trigger run: ${triggerRunId}`);

    // Wait for active status
    const status = await pollSessionStatus(["active"], 120_000);
    assert(status === "active", `Expected active, got ${status}`);
    log(`  Status: ${status}`);
  });

  // ── Test 2: Wait for prompt completion → warm ──
  await runTest("2. Prompt completes → warm status", async () => {
    // Wait for the initial prompt to complete and status to transition to warm
    const status = await pollSessionStatus(["warm"], MAX_WAIT_MS);
    assert(status === "warm", `Expected warm, got ${status}`);

    const runtime = await getLatestRuntime();
    assert(runtime?.status === "warm", `Runtime status: ${runtime?.status}`);
    log(`  Session status: ${status}, Runtime status: ${runtime?.status}`);
  });

  // ── Test 3: Send follow-up during warm → instant resume ──
  await runTest("3. Follow-up during warm → active (instant)", async () => {
    const session = await getSession();
    assert(!!session?.triggerRunId, "No triggerRunId on session");

    const sendStart = Date.now();

    await sessionMessages.send(session!.triggerRunId!, {
      action: "prompt",
      prompt: "Now count the total lines of code. Just give me the number.",
      nonce: randomUUID(),
    });

    // Should go back to active almost instantly
    const status = await pollSessionStatus(["active"], 30_000);
    const latency = Date.now() - sendStart;

    assert(status === "active", `Expected active, got ${status}`);
    assert(latency < 10_000, `Warm resume took ${latency}ms (expected <10s)`);
    log(`  Resume latency: ${latency}ms`);
  });

  // ── Test 4: Wait for warm → suspended ──
  await runTest("4. Idle after prompt → warm → suspended", async () => {
    // First wait for warm
    const warmStatus = await pollSessionStatus(["warm"], MAX_WAIT_MS);
    assert(warmStatus === "warm", `Expected warm first, got ${warmStatus}`);
    log(`  Reached warm status`);

    // Then wait for suspended (after WARM_TIMEOUT_MS expires)
    const suspendedStatus = await pollSessionStatus(["suspended"], MAX_WAIT_MS);
    assert(
      suspendedStatus === "suspended",
      `Expected suspended, got ${suspendedStatus}`,
    );

    const runtime = await getLatestRuntime();
    assert(
      runtime?.status === "suspended",
      `Runtime status: ${runtime?.status}`,
    );
    log(`  Session: ${suspendedStatus}, Runtime: ${runtime?.status}`);
  });

  // ── Test 5: Send follow-up during suspended → resume ──
  await runTest("5. Follow-up during suspended → active (~1-2s)", async () => {
    const session = await getSession();
    assert(!!session?.triggerRunId, "No triggerRunId on session");

    const sendStart = Date.now();

    await sessionMessages.send(session!.triggerRunId!, {
      action: "prompt",
      prompt: "What is 2+2? Just answer with the number.",
      nonce: randomUUID(),
    });

    // Should resume from suspend — expect 1-5s latency
    const status = await pollSessionStatus(["active"], 60_000);
    const latency = Date.now() - sendStart;

    assert(status === "active", `Expected active, got ${status}`);
    log(`  Suspend resume latency: ${latency}ms`);
  });

  // ── Test 6: Stop session → clean shutdown ──
  await runTest("6. Stop session → stopped", async () => {
    // Wait for warm or suspended before sending stop — the stop message
    // must arrive while .once() or .wait() is listening, not during executePrompt()
    // (where .on() consumes and discards non-HITL messages).
    const idleStatus = await pollSessionStatus(["warm", "suspended"], 120_000);
    assert(!!idleStatus, `Expected warm or suspended before stop, got null`);
    log(`  Session idle at: ${idleStatus}`);

    const session = await getSession();
    assert(!!session?.triggerRunId, "No triggerRunId on session");

    await sessionMessages.send(session!.triggerRunId!, {
      action: "stop",
    });

    const status = await pollSessionStatus(["stopped"], 60_000);
    assert(status === "stopped", `Expected stopped, got ${status}`);

    const runtime = await getLatestRuntime();
    assert(
      runtime?.status === "stopped",
      `Runtime status: ${runtime?.status}`,
    );
    log(`  Session: ${status}, Runtime: ${runtime?.status}`);
  });

  // ── Report ──
  log("\n" + "=".repeat(50));
  log("QA AUDIT REPORT: Two-Phase Waiting");
  log("=".repeat(50));
  log(`Date: ${new Date().toISOString()}`);
  log(`Session ID: ${sessionId}`);
  log(`Trigger Run: ${triggerRunId}`);
  log("");

  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  for (const r of results) {
    const icon = r.status === "pass" ? "PASS" : r.status === "fail" ? "FAIL" : "SKIP";
    log(`  [${icon}] ${r.name} (${r.duration}ms)`);
    if (r.details) log(`         ${r.details}`);
  }

  log("");
  log(`Total: ${results.length} | Passed: ${passed} | Failed: ${failed} | Skipped: ${skipped}`);

  // Write audit file
  const audit = {
    date: new Date().toISOString(),
    sessionId,
    triggerRunId,
    results,
    summary: { total: results.length, passed, failed, skipped },
  };

  const fs = await import("node:fs");
  const auditPath = `qa-audit-two-phase-${new Date().toISOString().slice(0, 10)}.json`;
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  log(`\nAudit file written: ${auditPath}`);

  // Clean exit
  await pool.end();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  pool.end().then(() => process.exit(1));
});
