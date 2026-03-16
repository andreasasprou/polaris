/**
 * E2E Test: v2 Architecture
 *
 * Tests the complete v2 flow without Trigger.dev:
 *   1. Job state machine (DB-level)
 *   2. Callback ingestion & processing
 *   3. Sweeper recovery
 *   4. Session lifecycle (DB + sandbox if available)
 *   5. Coding task dispatch (full pipeline)
 *
 * Usage:
 *   # DB-only tests (no sandbox required):
 *   npx tsx scripts/test-v2-e2e.ts --db-only
 *
 *   # Full E2E (requires sandbox + GitHub):
 *   npx tsx scripts/test-v2-e2e.ts owner/repo
 *
 * Required env vars (DB-only):
 *   DATABASE_URL
 *
 * Required env vars (full):
 *   DATABASE_URL, VERCEL_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_B64
 *   ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN
 */

import { randomUUID } from "node:crypto";

// ── Test Framework ──

let passed = 0;
let failed = 0;
let skipped = 0;

function log(msg: string) {
  console.log(`  ${msg}`);
}

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}`);
    console.log(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

function skip(name: string, reason: string) {
  skipped++;
  console.log(`  ○ ${name} (${reason})`);
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(`Assertion failed: ${msg}`);
}

function assertEqual<T>(actual: T, expected: T, msg: string) {
  if (actual !== expected) {
    throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ── Test Suites ──

async function testJobStateMachine() {
  console.log("\n── Job State Machine ──");

  const { createJob, casJobStatus, getJob, createJobAttempt, casAttemptStatus, getActiveAttempt, appendJobEvent } =
    await import("../lib/jobs/actions");
  const { generateJobHmacKey } = await import("../lib/jobs/callback-auth");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("Create job with HMAC key", async () => {
    const hmacKey = generateJobHmacKey();
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      hmacKey,
      requestId: randomUUID(),
      payload: { prompt: "test" },
      timeoutSeconds: 300,
    });
    assert(job !== null, "Job should be created");
    assertEqual(job!.status, "pending", "Initial status should be pending");
    assert(job!.hmacKey === hmacKey, "HMAC key should match");
  });

  await test("CAS pending → accepted", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    const updated = await casJobStatus(job!.id, ["pending"], "accepted");
    assert(updated !== null, "CAS should succeed");
    assertEqual(updated!.status, "accepted", "Status should be accepted");
  });

  await test("CAS rejects wrong source status", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    // Try to CAS from "running" when job is "pending"
    const updated = await casJobStatus(job!.id, ["running"], "accepted");
    assert(updated === null, "CAS should fail when status doesn't match");
  });

  await test("Full lifecycle: pending → accepted → running → agent_completed → postprocess_pending → completed", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    const id = job!.id;

    let updated = await casJobStatus(id, ["pending"], "accepted");
    assertEqual(updated!.status, "accepted", "→ accepted");

    updated = await casJobStatus(id, ["accepted"], "running");
    assertEqual(updated!.status, "running", "→ running");

    updated = await casJobStatus(id, ["running", "accepted"], "agent_completed");
    assertEqual(updated!.status, "agent_completed", "→ agent_completed");

    updated = await casJobStatus(id, ["agent_completed"], "postprocess_pending");
    assertEqual(updated!.status, "postprocess_pending", "→ postprocess_pending");

    updated = await casJobStatus(id, ["postprocess_pending"], "completed");
    assertEqual(updated!.status, "completed", "→ completed");
  });

  await test("Create job attempt + CAS through statuses", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });

    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
      sandboxId: "test-sandbox",
    });
    assertEqual(attempt.status, "dispatching", "Attempt starts as dispatching");

    const updated = await casAttemptStatus(attempt.id, ["dispatching"], "accepted");
    assertEqual(updated!.status, "accepted", "→ accepted");

    const active = await getActiveAttempt(job!.id);
    assert(active !== null, "Active attempt should exist");
  });

  await test("Append job event", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    const event = await appendJobEvent(job!.id, "accepted", undefined, { test: true });
    assert(event !== null, "Event should be created");
    assertEqual(event.eventType, "accepted", "Event type should match");
  });

  await test("Idempotent job creation (same session+request)", async () => {
    const { createInteractiveSession } = await import("../lib/sessions/actions");
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });
    const requestId = randomUUID();
    const job1 = await createJob({
      organizationId: orgId,
      type: "prompt",
      sessionId: session.id,
      requestId,
    });
    const job2 = await createJob({
      organizationId: orgId,
      type: "prompt",
      sessionId: session.id,
      requestId,
    });
    assert(job1 !== null, "First job should be created");
    assert(job2 === null, "Second job should be null (idempotent)");
  });
}

async function testCallbackIngestion() {
  console.log("\n── Callback Ingestion ──");

  const { createJob, createJobAttempt, getJob } = await import("../lib/jobs/actions");
  const { ingestCallback } = await import("../lib/jobs/callbacks");
  const { generateJobHmacKey } = await import("../lib/jobs/callback-auth");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("Ingest prompt_accepted callback", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const result = await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });
    assert(result.accepted, "Callback should be accepted");

    const updated = await getJob(job!.id);
    assertEqual(updated!.status, "accepted", "Job should be accepted");
  });

  await test("Ingest prompt_failed callback", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });
    // First accept, then fail
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });

    const result = await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_failed",
      payload: { error: "Agent crashed", reason: "crash" },
    });
    assert(result.accepted, "Callback should be accepted");

    const updated = await getJob(job!.id);
    assertEqual(updated!.status, "failed_retryable", "Job should be failed_retryable");
  });

  await test("Duplicate callback rejected", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const callbackId = randomUUID();
    const first = await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId,
      callbackType: "prompt_accepted",
      payload: {},
    });
    assert(first.accepted, "First should be accepted");

    const second = await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId, // same ID
      callbackType: "prompt_accepted",
      payload: {},
    });
    assert(!second.accepted, "Duplicate should be rejected");
  });

  await test("Stale epoch rejected", async () => {
    // Create a session with epoch > 1
    const { createInteractiveSession } = await import("../lib/sessions/actions");
    const { incrementEpoch } = await import("../lib/jobs/actions");

    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });

    // Increment epoch twice: 0 → 1 → 2
    await incrementEpoch(session.id);
    await incrementEpoch(session.id);

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      sessionId: session.id,
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1, // stale epoch (session is at 2)
    });

    const result = await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1, // stale
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });
    assert(!result.accepted, "Stale epoch should be rejected");
    assert(
      "reason" in result && (result as { reason: string }).reason.includes("stale epoch"),
      "Should mention stale epoch",
    );
  });
}

async function testCallbackAuth() {
  console.log("\n── Callback Auth (HMAC) ──");

  const { generateJobHmacKey, signCallback, verifyCallback } =
    await import("../lib/jobs/callback-auth");

  await test("Sign and verify callback", async () => {
    const key = generateJobHmacKey();
    const payload = { jobId: "test", callbackType: "prompt_accepted" };
    const signature = signCallback(payload, key);
    assert(verifyCallback(payload, signature, key), "Signature should verify");
  });

  await test("Wrong key fails verification", async () => {
    const key1 = generateJobHmacKey();
    const key2 = generateJobHmacKey();
    const payload = { jobId: "test" };
    const signature = signCallback(payload, key1);
    assert(!verifyCallback(payload, signature, key2), "Wrong key should fail");
  });

  await test("Tampered payload fails verification", async () => {
    const key = generateJobHmacKey();
    const payload = { jobId: "test" };
    const signature = signCallback(payload, key);
    assert(
      !verifyCallback({ jobId: "tampered" }, signature, key),
      "Tampered payload should fail",
    );
  });
}

async function testSessionLifecycle() {
  console.log("\n── Session Lifecycle ──");

  const {
    createInteractiveSession,
    casSessionStatus,
    getInteractiveSession,
    createRuntime,
    endStaleRuntimes,
    getActiveRuntime,
  } = await import("../lib/sessions/actions");
  const { incrementEpoch } = await import("../lib/jobs/actions");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("Create session + CAS creating → idle → active", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test prompt",
    });
    assertEqual(session.status, "creating", "Initial status should be creating");

    // Simulate sandbox provisioning completing
    const idle = await casSessionStatus(session.id, ["creating"], "idle");
    assert(idle !== null, "CAS creating → idle should succeed");
    assertEqual(idle!.status, "idle", "Status should be idle");

    const active = await casSessionStatus(session.id, ["idle"], "active");
    assert(active !== null, "CAS idle → active should succeed");
    assertEqual(active!.status, "active", "Status should be active");
  });

  await test("Increment epoch", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });
    assertEqual(session.epoch, 0, "Initial epoch should be 0");

    const epoch1 = await incrementEpoch(session.id);
    assertEqual(epoch1, 1, "Epoch should be 1");

    const epoch2 = await incrementEpoch(session.id);
    assertEqual(epoch2, 2, "Epoch should be 2");
  });

  await test("Runtime lifecycle: create + end stale", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });

    const runtime = await createRuntime({
      sessionId: session.id,
      sandboxId: "sandbox-1",
      epoch: 1,
      restoreSource: "cold",
      status: "running",
    });
    assert(runtime !== null, "Runtime should be created");

    const active = await getActiveRuntime(session.id);
    assert(active !== null, "Active runtime should exist");

    // End stale runtimes
    await endStaleRuntimes(session.id);
    const activeAfter = await getActiveRuntime(session.id);
    assert(activeAfter === null, "No active runtime after endStaleRuntimes");
  });

  await test("CAS rejects concurrent status changes", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });

    // Move to idle first
    await casSessionStatus(session.id, ["creating"], "idle");

    // Two concurrent CAS attempts from idle → active
    const [a, b] = await Promise.all([
      casSessionStatus(session.id, ["idle"], "active"),
      casSessionStatus(session.id, ["idle"], "active"),
    ]);

    // Exactly one should win
    const wins = [a, b].filter(Boolean).length;
    assertEqual(wins, 1, "Exactly one CAS should win");
  });
}

async function testSweeper() {
  console.log("\n── Sweeper ──");

  const { createJob, casJobStatus, getJob, createJobAttempt, casAttemptStatus } =
    await import("../lib/jobs/actions");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("Timed-out job detected by sweeper query", async () => {
    const { getTimedOutJobs } = await import("../lib/jobs/actions");

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      timeoutSeconds: 1, // 1 second timeout
    });
    // Move to accepted (sweeper checks accepted/running)
    await casJobStatus(job!.id, ["pending"], "accepted");

    // Wait for timeout to expire
    await new Promise((r) => setTimeout(r, 1500));

    const timedOut = await getTimedOutJobs();
    const found = timedOut.some((j) => j.id === job!.id);
    assert(found, "Job should appear in timed-out query");
  });

  await test("Dispatch unknown attempt detected", async () => {
    const { getDispatchUnknownAttempts } = await import("../lib/jobs/actions");

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });
    await casAttemptStatus(attempt.id, ["dispatching"], "dispatch_unknown");

    const unknown = await getDispatchUnknownAttempts();
    const found = unknown.some((r) => r.attempt.id === attempt.id);
    assert(found, "Attempt should appear in dispatch_unknown query");
  });

  await test("Run full sweep cycle", async () => {
    const { runSweep } = await import("../lib/jobs/sweeper");
    const result = await runSweep();
    assert(
      typeof result.timedOut === "number" &&
      typeof result.unknownReconciled === "number" &&
      typeof result.postprocessRetried === "number",
      "Sweep should return counts",
    );
    log(`  swept: ${result.timedOut} timed out, ${result.unknownReconciled} unknown, ${result.postprocessRetried} postprocess`);
  });
}

async function testActiveJobForSession() {
  console.log("\n── Active Job Tracking ──");

  const { createJob, casJobStatus, getActiveJobForSession } =
    await import("../lib/jobs/actions");
  const { createInteractiveSession } = await import("../lib/sessions/actions");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("getActiveJobForSession returns active job", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      sessionId: session.id,
      requestId: randomUUID(),
    });

    const active = await getActiveJobForSession(session.id);
    assert(active !== null, "Should find active job");
    assertEqual(active!.id, job!.id, "Should be the same job");
  });

  await test("getActiveJobForSession returns null for completed job", async () => {
    const session = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "test",
      agentType: "claude",
      prompt: "test",
    });

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      sessionId: session.id,
      requestId: randomUUID(),
    });

    await casJobStatus(job!.id, ["pending"], "completed");

    const active = await getActiveJobForSession(session.id);
    assert(active === null, "Should not find completed job");
  });
}

async function testFullPipeline(owner: string, repo: string) {
  console.log("\n── Full Pipeline (Sandbox + Agent) ──");

  const hasVercelToken = !!process.env.VERCEL_TOKEN;
  const hasGitHubApp = !!process.env.GITHUB_APP_ID;
  const hasAgentKey = !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_CODE_OAUTH_TOKEN);

  if (!hasVercelToken || !hasGitHubApp || !hasAgentKey) {
    skip("Full pipeline", "Missing env: VERCEL_TOKEN, GITHUB_APP_ID, or agent key");
    return;
  }

  const { SandboxManager } = await import("../lib/sandbox/SandboxManager");
  const { SandboxCommands } = await import("../lib/sandbox/SandboxCommands");
  const { GitOperations } = await import("../lib/sandbox/GitOperations");
  const { SandboxAgentBootstrap } = await import("../lib/sandbox-agent/SandboxAgentBootstrap");
  const { buildSessionEnv } = await import("../lib/sandbox-agent/credentials");
  const { getInstallationToken } = await import("../lib/integrations/github");
  const { generateJobHmacKey } = await import("../lib/jobs/callback-auth");
  const { createJob, createJobAttempt, getJob } = await import("../lib/jobs/actions");
  const { getActiveSnapshot } = await import("../lib/sandbox/snapshots/queries");

  const sandboxManager = new SandboxManager();
  const agentType = "claude" as const;
  const agentApiKey = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_API_KEY!;

  await test("Create sandbox + bootstrap agent + proxy", async () => {
    log("  Minting GitHub token...");
    const gitToken = await getInstallationToken(owner, repo);
    const repoUrl = `https://github.com/${owner}/${repo}.git`;

    log("  Resolving snapshot...");
    const snapshot = await getActiveSnapshot(agentType);

    log("  Creating sandbox...");
    const sandbox = await sandboxManager.create({
      source: snapshot ? { type: "snapshot", snapshotId: snapshot } : { type: "git" },
      repoUrl,
      gitToken,
      baseBranch: "main",
      timeoutMs: 600_000,
      ports: [2468, 2469],
    });
    log(`  Sandbox created: ${sandbox.sandboxId}`);

    try {
      const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
      const git = new GitOperations(commands);
      const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

      // Configure git
      await git.configure({ repoUrl });

      // Bootstrap agent
      const sessionEnv = buildSessionEnv(agentType, agentApiKey);
      if (!snapshot) {
        log("  Installing agent (no snapshot)...");
        await bootstrap.install();
        await bootstrap.installAgent(agentType, sessionEnv);
      }

      log("  Starting agent server...");
      const serverUrl = await bootstrap.start(2468, sessionEnv);
      log(`  Agent server: ${serverUrl}`);

      // Install + start proxy
      log("  Installing proxy bundle...");
      const fs = await import("node:fs");
      const path = await import("node:path");
      const proxyBundle = fs.readFileSync(
        path.resolve(import.meta.dirname, "../lib/sandbox-proxy/dist/proxy.js"),
        "utf-8",
      );
      await bootstrap.installProxy(proxyBundle);

      log("  Starting proxy...");
      const proxyUrl = await bootstrap.startProxy({
        ...sessionEnv,
        CALLBACK_URL: "http://localhost:3001/api/callbacks",
      });
      log(`  Proxy: ${proxyUrl}`);

      // Wait a bit then check if proxy is alive
      await new Promise((r) => setTimeout(r, 3000));

      // Wait for proxy to start (retry health check)
      // proxyUrl already includes https:// from sandbox.domain()
      log("  Checking proxy health...");
      let proxyHealthy = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const healthRes = await fetch(`${proxyUrl}/health`, {
            signal: AbortSignal.timeout(5_000),
          });
          if (healthRes.ok) {
            proxyHealthy = true;
            break;
          }
          log(`  Health check attempt ${attempt + 1}: ${healthRes.status}`);
        } catch (e) {
          log(`  Health check attempt ${attempt + 1}: ${e instanceof Error ? e.message : "failed"}`);
        }
      }
      assert(proxyHealthy, "Proxy health check failed after 10 attempts");
      log("  Proxy healthy!");

      // Check status
      const statusRes = await fetch(`${proxyUrl}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      const statusBody = await statusRes.json();
      log(`  Proxy status: ${JSON.stringify(statusBody)}`);
      assertEqual(statusBody.state, "idle", "Proxy should be idle");

      // Create job + attempt
      const hmacKey = generateJobHmacKey();
      const orgId = `test-org-${randomUUID().slice(0, 8)}`;
      const job = await createJob({
        organizationId: orgId,
        type: "prompt",
        requestId: randomUUID(),
        hmacKey,
        payload: { prompt: "What is 2+2? Reply in one word." },
        timeoutSeconds: 120,
      });

      const attempt = await createJobAttempt({
        jobId: job!.id,
        attemptNumber: 1,
        epoch: 1,
        sandboxId: sandbox.sandboxId,
      });

      // POST /prompt to proxy
      log("  Sending prompt to proxy...");
      const promptRes = await fetch(`${proxyUrl}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobId: job!.id,
          attemptId: attempt.id,
          epoch: 1,
          prompt: "What is 2+2? Reply in one word.",
          callbackUrl: "http://localhost:3001/api/callbacks",
          hmacKey,
          config: {
            agent: agentType,
            cwd: SandboxManager.PROJECT_DIR,
          },
        }),
        signal: AbortSignal.timeout(30_000),
      });

      assertEqual(promptRes.status, 202, "Proxy should return 202");
      log("  Prompt accepted!");

      // Poll proxy status until complete
      log("  Waiting for agent to complete...");
      const deadline = Date.now() + 120_000;
      let finalState = "running";
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 3000));
        const statusCheck = await fetch(`${proxyUrl}/status`, {
          signal: AbortSignal.timeout(5_000),
        }).catch(() => null);
        if (statusCheck?.ok) {
          const s = await statusCheck.json();
          log(`  Status: ${s.state}`);
          if (s.state === "idle") {
            finalState = "idle";
            break;
          }
        }
      }
      assertEqual(finalState, "idle", "Agent should return to idle after completion");

      // Check outbox for delivered callbacks
      const outboxRes = await fetch(`${proxyUrl}/outbox`, {
        signal: AbortSignal.timeout(5_000),
      });
      const outbox = await outboxRes.json();
      log(`  Outbox entries: ${outbox.entries?.length ?? 0}`);

      log("  Full pipeline test passed!");
    } finally {
      log("  Destroying sandbox...");
      await sandboxManager.destroy(sandbox);
    }
  });
}

async function testCallbackApiRoute() {
  console.log("\n── Callback API Route (HTTP) ──");

  const { createJob, createJobAttempt } = await import("../lib/jobs/actions");
  const { generateJobHmacKey, signCallback } = await import("../lib/jobs/callback-auth");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;
  const BASE_URL = "http://localhost:3001";

  await test("POST /api/callbacks — valid signature accepted", async () => {
    const hmacKey = generateJobHmacKey();
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey,
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const body = {
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    };
    const signature = signCallback(body as unknown as Record<string, unknown>, hmacKey);

    const res = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": signature,
      },
      body: JSON.stringify(body),
    });

    assertEqual(res.status, 200, "Should return 200");
    const json = await res.json();
    assertEqual(json.ok, true, "Should return ok: true");
  });

  await test("POST /api/callbacks — invalid signature rejected (401)", async () => {
    const hmacKey = generateJobHmacKey();
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey,
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const body = {
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    };
    const wrongSignature = signCallback(body as unknown as Record<string, unknown>, generateJobHmacKey());

    const res = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": wrongSignature,
      },
      body: JSON.stringify(body),
    });

    assertEqual(res.status, 401, "Should return 401 for wrong signature");
  });

  await test("POST /api/callbacks — missing signature rejected (401)", async () => {
    const hmacKey = generateJobHmacKey();
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey,
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const body = {
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    };

    const res = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    assertEqual(res.status, 401, "Should return 401 for missing signature");
  });

  await test("POST /api/callbacks — unknown job returns 404", async () => {
    const body = {
      jobId: randomUUID(),
      attemptId: randomUUID(),
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    };

    const res = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": "deadbeef".repeat(8),
      },
      body: JSON.stringify(body),
    });

    assertEqual(res.status, 404, "Should return 404 for unknown job");
  });

  await test("POST /api/callbacks — duplicate callback returns 409", async () => {
    const hmacKey = generateJobHmacKey();
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey,
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    const callbackId = randomUUID();
    const body = {
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId,
      callbackType: "prompt_accepted",
      payload: {},
    };
    const signature = signCallback(body as unknown as Record<string, unknown>, hmacKey);

    // First call — accepted
    const res1 = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": signature,
      },
      body: JSON.stringify(body),
    });
    assertEqual(res1.status, 200, "First call should return 200");

    // Second call — duplicate
    const res2 = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Callback-Signature": signature,
      },
      body: JSON.stringify(body),
    });
    assertEqual(res2.status, 409, "Duplicate should return 409");
  });

  await test("POST /api/callbacks — missing fields returns 400", async () => {
    const res = await fetch(`${BASE_URL}/api/callbacks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: randomUUID() }), // missing required fields
    });
    assertEqual(res.status, 400, "Should return 400 for missing fields");
  });
}

async function testPostProcessingStateMachine() {
  console.log("\n── Post-Processing State Machine ──");

  const { createJob, casJobStatus, getJob } = await import("../lib/jobs/actions");
  const { runPostProcessing } = await import("../lib/jobs/postprocess");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("prompt type: agent_completed → postprocess_pending → completed (no-op)", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    // Advance to agent_completed
    await casJobStatus(job!.id, ["pending"], "accepted");
    await casJobStatus(job!.id, ["accepted"], "running");
    await casJobStatus(job!.id, ["running", "accepted"], "agent_completed");

    await runPostProcessing(job!.id);

    const final = await getJob(job!.id);
    assertEqual(final!.status, "completed", "Prompt job should complete (no post-processing)");
  });

  await test("idempotent: double runPostProcessing does not throw", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
    });
    await casJobStatus(job!.id, ["pending"], "accepted");
    await casJobStatus(job!.id, ["accepted"], "running");
    await casJobStatus(job!.id, ["running", "accepted"], "agent_completed");

    // First call processes
    await runPostProcessing(job!.id);
    // Second call is no-op (CAS from agent_completed fails since it's now completed)
    await runPostProcessing(job!.id);

    const final = await getJob(job!.id);
    assertEqual(final!.status, "completed", "Should still be completed");
  });

  await test("coding_task: fails gracefully with missing payload", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "coding_task",
      requestId: randomUUID(),
      payload: {}, // missing required fields
    });
    await casJobStatus(job!.id, ["pending"], "accepted");
    await casJobStatus(job!.id, ["accepted"], "running");
    await casJobStatus(job!.id, ["running", "accepted"], "agent_completed");

    // Should not throw — missing payload logs error and returns
    await runPostProcessing(job!.id);

    const final = await getJob(job!.id);
    assertEqual(final!.status, "completed", "Should complete despite missing payload");
  });

  await test("full callback→postprocess flow via ingestCallback", async () => {
    const { createJobAttempt } = await import("../lib/jobs/actions");
    const { ingestCallback } = await import("../lib/jobs/callbacks");
    const { generateJobHmacKey } = await import("../lib/jobs/callback-auth");

    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    // Accept
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });

    // Complete — this triggers runPostProcessing internally
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_complete",
      payload: { result: { lastMessage: "done" } },
    });

    const final = await getJob(job!.id);
    assertEqual(final!.status, "completed", "Job should be completed after prompt_complete callback");
  });
}

async function testWebhookRouting() {
  console.log("\n── Webhook Routing ──");

  const { db } = await import("../lib/db");
  const { githubInstallations, repositories } = await import("../lib/integrations/schema");
  const { createAutomation } = await import("../lib/automations/actions");
  const { matchesGitHubTrigger } = await import("../lib/routing/matchers");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;
  const installationId = Math.floor(Math.random() * 1_000_000) + 100_000;

  // Create test fixtures
  let repoId: string;
  let installId: string;

  await test("Create test fixtures (installation + repo + automation)", async () => {
    // Create GitHub installation
    const [inst] = await db
      .insert(githubInstallations)
      .values({
        organizationId: orgId,
        installationId,
        accountLogin: "test-owner",
        accountType: "Organization",
      })
      .returning();
    installId = inst.id;

    // Create repository
    const [repo] = await db
      .insert(repositories)
      .values({
        organizationId: orgId,
        githubInstallationId: installId,
        owner: "test-owner",
        name: "test-repo",
        defaultBranch: "main",
      })
      .returning();
    repoId = repo.id;

    // Create automation
    await createAutomation({
      organizationId: orgId,
      createdBy: "test",
      name: "Test PR Review",
      triggerType: "github",
      triggerConfig: {
        events: ["pull_request.opened", "pull_request.synchronize"],
      },
      prompt: "Review this PR",
      agentType: "claude",
      repositoryId: repoId,
      mode: "continuous",
    });

    assert(!!installId, "Installation created");
    assert(!!repoId, "Repository created");
  });

  await test("matchesGitHubTrigger — exact event match", () => {
    const config = { events: ["pull_request.opened", "pull_request.synchronize"] };
    assert(
      matchesGitHubTrigger("pull_request", "opened", undefined, config),
      "Should match pull_request.opened",
    );
    assert(
      matchesGitHubTrigger("pull_request", "synchronize", undefined, config),
      "Should match pull_request.synchronize",
    );
    assert(
      !matchesGitHubTrigger("pull_request", "closed", undefined, config),
      "Should NOT match pull_request.closed",
    );
    assert(
      !matchesGitHubTrigger("push", undefined, undefined, config),
      "Should NOT match push",
    );
  });

  await test("matchesGitHubTrigger — prefix match", () => {
    const config = { events: ["pull_request"] };
    assert(
      matchesGitHubTrigger("pull_request", "opened", undefined, config),
      "pull_request should match pull_request.opened via prefix",
    );
    assert(
      matchesGitHubTrigger("pull_request", "synchronize", undefined, config),
      "pull_request should match pull_request.synchronize via prefix",
    );
  });

  await test("matchesGitHubTrigger — branch filter", () => {
    const config = { events: ["push"], branches: ["main"] };
    assert(
      matchesGitHubTrigger("push", undefined, "refs/heads/main", config),
      "Should match push to main",
    );
    assert(
      !matchesGitHubTrigger("push", undefined, "refs/heads/feature", config),
      "Should NOT match push to feature branch",
    );
  });

  await test("matchesGitHubTrigger — issue_comment matches PR automation", () => {
    const config = { events: ["pull_request.opened", "pull_request.synchronize"] };
    assert(
      matchesGitHubTrigger("issue_comment", "created", undefined, config),
      "issue_comment.created should match PR automation for /review commands",
    );
  });

  await test("findEnabledAutomationsByTrigger returns matching automations", async () => {
    const { findEnabledAutomationsByTrigger } = await import("../lib/automations/queries");
    const results = await findEnabledAutomationsByTrigger(orgId, "github");
    assert(results.length >= 1, "Should find at least one enabled automation");
    assertEqual(results[0].triggerType, "github", "Should be github trigger type");
  });

  await test("Dedupe prevents duplicate deliveries", async () => {
    const { claimDelivery } = await import("../lib/routing/dedupe");
    const deliveryId = randomUUID();

    const first = await claimDelivery({
      source: "github",
      externalEventId: deliveryId,
      sourceDeliveryId: deliveryId,
      dedupeKey: `github:${deliveryId}`,
      organizationId: orgId,
    });
    assert(first, "First delivery should be claimed");

    const second = await claimDelivery({
      source: "github",
      externalEventId: deliveryId,
      sourceDeliveryId: deliveryId,
      dedupeKey: `github:${deliveryId}`,
      organizationId: orgId,
    });
    assert(!second, "Duplicate delivery should be rejected");
  });

  await test("routeGitHubEvent routes to matching automation", async () => {
    const { routeGitHubEvent } = await import("../lib/routing/trigger-router");

    // We need to mock dispatchPrReview since it tries to create a real sandbox.
    // Instead, just verify routing + run creation by catching the dispatch error.
    const deliveryId = randomUUID();
    let triggered: number;
    try {
      triggered = await routeGitHubEvent({
        installationId,
        deliveryId,
        eventType: "pull_request",
        action: "opened",
        payload: {
          action: "opened",
          pull_request: {
            number: 999,
            html_url: "https://github.com/test-owner/test-repo/pull/999",
            head: {
              ref: "test-branch",
              sha: "abc123def456abc123def456abc123def456abc1",
            },
            base: {
              ref: "main",
              sha: "def456abc123def456abc123def456abc123def4",
            },
            draft: false,
            state: "open",
            title: "Test PR",
            body: "Test body",
            labels: [],
            user: { login: "test-user", type: "User" },
          },
          sender: { login: "test-user", type: "User" },
          repository: {
            full_name: "test-owner/test-repo",
            owner: { login: "test-owner" },
            name: "test-repo",
          },
          installation: { id: installationId },
        },
      });
    } catch (err) {
      // Expected: dispatchPrReview may fail because there's no real sandbox.
      // The important thing is that routing proceeded past dedup, found the automation,
      // created the automation run, and attempted dispatch.
      log(`  Routing dispatch error (expected): ${err instanceof Error ? err.message : String(err)}`);
      triggered = 0; // We know it matched, it just failed at dispatch
    }

    // Verify: automation run was created for this delivery
    const { findRunsByAutomation } = await import("../lib/automations/queries");
    const { findEnabledAutomationsByTrigger } = await import("../lib/automations/queries");
    const automations = await findEnabledAutomationsByTrigger(orgId, "github");
    const runs = await findRunsByAutomation(automations[0].id, 5);
    const matchingRun = runs.find((r) => r.externalEventId === deliveryId);
    assert(matchingRun !== undefined, "Automation run should have been created for this delivery");
    assertEqual(matchingRun!.source, "github", "Run source should be github");
  });
}

async function testAutomationSessionLocking() {
  console.log("\n── Automation Session Locking ──");

  const { db } = await import("../lib/db");
  const { githubInstallations, repositories } = await import("../lib/integrations/schema");
  const {
    createAutomation,
    createAutomationSession,
    tryAcquireAutomationSessionLock,
    releaseAutomationSessionLock,
    setPendingReviewRequest,
    clearPendingReviewRequest,
    getAutomationSession,
  } = await import("../lib/automations/actions");
  const { createInteractiveSession } = await import("../lib/sessions/actions");
  const { createJob } = await import("../lib/jobs/actions");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;
  const installationId = Math.floor(Math.random() * 1_000_000) + 200_000;

  // Create fixtures
  const [inst] = await db
    .insert(githubInstallations)
    .values({
      organizationId: orgId,
      installationId,
      accountLogin: "lock-test",
    })
    .returning();

  const [repo] = await db
    .insert(repositories)
    .values({
      organizationId: orgId,
      githubInstallationId: inst.id,
      owner: "lock-test",
      name: "lock-repo",
    })
    .returning();

  const automation = await createAutomation({
    organizationId: orgId,
    createdBy: "test",
    name: "Lock Test",
    triggerType: "github",
    triggerConfig: { events: ["pull_request"] },
    prompt: "test",
    repositoryId: repo.id,
    mode: "continuous",
  });

  const session = await createInteractiveSession({
    organizationId: orgId,
    createdBy: "test",
    agentType: "claude",
    prompt: "test",
  });

  const automationSession = await createAutomationSession({
    automationId: automation.id,
    interactiveSessionId: session.id,
    organizationId: orgId,
    repositoryId: repo.id,
    scopeKey: `github-pr:${repo.id}:42`,
    metadata: {
      repositoryOwner: "lock-test",
      repositoryName: "lock-repo",
      prNumber: 42,
      baseRef: "main",
      baseSha: "aaa",
      headRef: "feature",
      headSha: "bbb",
      lastReviewedSha: null,
      reviewState: null,
      reviewCount: 0,
      lastCommentId: null,
      lastCheckRunId: null,
      lastCompletedRunId: null,
      pendingReviewRequest: null,
    },
  });

  await test("Acquire lock succeeds on unlocked session", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "review",
      requestId: randomUUID(),
    });

    const acquired = await tryAcquireAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job!.id,
    });
    assert(acquired, "Should acquire lock");

    // Clean up
    await releaseAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job!.id,
    });
  });

  await test("Acquire lock fails when already locked", async () => {
    const job1 = await createJob({
      organizationId: orgId,
      type: "review",
      requestId: randomUUID(),
    });
    const job2 = await createJob({
      organizationId: orgId,
      type: "review",
      requestId: randomUUID(),
    });

    const first = await tryAcquireAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job1!.id,
    });
    assert(first, "First lock should succeed");

    const second = await tryAcquireAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job2!.id,
    });
    assert(!second, "Second lock should fail — already locked");

    await releaseAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job1!.id,
    });
  });

  await test("Release lock only works with correct jobId", async () => {
    const job1 = await createJob({
      organizationId: orgId,
      type: "review",
      requestId: randomUUID(),
    });
    const job2 = await createJob({
      organizationId: orgId,
      type: "review",
      requestId: randomUUID(),
    });

    await tryAcquireAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job1!.id,
    });

    // Try releasing with wrong job ID
    const wrongRelease = await releaseAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job2!.id,
    });
    assert(!wrongRelease, "Should not release lock with wrong job ID");

    // Release with correct job ID
    const correctRelease = await releaseAutomationSessionLock({
      automationSessionId: automationSession.id,
      jobId: job1!.id,
    });
    assert(correctRelease, "Should release lock with correct job ID");
  });

  await test("Pending review request: set + clear roundtrip", async () => {
    const request = {
      deliveryId: randomUUID(),
      headSha: "abc123",
      reason: "synchronize",
    };

    await setPendingReviewRequest(automationSession.id, request);

    const sessionCheck = await getAutomationSession(automationSession.id);
    const metadata = sessionCheck!.metadata as { pendingReviewRequest: typeof request | null };
    assert(metadata.pendingReviewRequest !== null, "Pending request should be set");
    assertEqual(
      metadata.pendingReviewRequest!.headSha,
      "abc123",
      "Head SHA should match",
    );

    const cleared = await clearPendingReviewRequest(automationSession.id);
    assert(cleared !== null, "Should return the cleared request");
    assertEqual(cleared!.headSha, "abc123", "Cleared request head SHA should match");

    // Verify it's gone
    const secondClear = await clearPendingReviewRequest(automationSession.id);
    assert(secondClear === null, "Second clear should return null");
  });
}

async function testHITLCallbackFlow() {
  console.log("\n── HITL Callback Flow ──");

  const { createJob, createJobAttempt, getJob } = await import("../lib/jobs/actions");
  const { ingestCallback } = await import("../lib/jobs/callbacks");
  const { generateJobHmacKey } = await import("../lib/jobs/callback-auth");

  const orgId = `test-org-${randomUUID().slice(0, 8)}`;

  await test("Permission request → waiting_human → permission resumed → running", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    // Accept
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });

    // Agent starts running - CAS attempt to running
    const { casAttemptStatus } = await import("../lib/jobs/actions");
    await casAttemptStatus(attempt.id, ["accepted"], "running");
    await import("../lib/jobs/actions").then(m => m.casJobStatus(job!.id, ["accepted"], "running"));

    // Permission requested
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "permission_requested",
      payload: { permissionId: "perm-1", toolName: "Bash" },
    });

    const { getActiveAttempt } = await import("../lib/jobs/actions");
    const waitingAttempt = await getActiveAttempt(job!.id);
    assertEqual(waitingAttempt!.status, "waiting_human", "Attempt should be waiting_human");

    // Permission resumed
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "permission_resumed",
      payload: {},
    });

    const resumedAttempt = await getActiveAttempt(job!.id);
    assertEqual(resumedAttempt!.status, "running", "Attempt should be running after resume");
  });

  await test("Question request triggers waiting_human", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    // Accept → running
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });
    const { casAttemptStatus, casJobStatus } = await import("../lib/jobs/actions");
    await casAttemptStatus(attempt.id, ["accepted"], "running");
    await casJobStatus(job!.id, ["accepted"], "running");

    // Question requested
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "question_requested",
      payload: { questionId: "q-1" },
    });

    const { getActiveAttempt } = await import("../lib/jobs/actions");
    const waiting = await getActiveAttempt(job!.id);
    assertEqual(waiting!.status, "waiting_human", "Should be waiting_human after question");
  });

  await test("user_stop produces cancelled status", async () => {
    const job = await createJob({
      organizationId: orgId,
      type: "prompt",
      requestId: randomUUID(),
      hmacKey: generateJobHmacKey(),
    });
    const attempt = await createJobAttempt({
      jobId: job!.id,
      attemptNumber: 1,
      epoch: 1,
    });

    // Accept
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_accepted",
      payload: {},
    });

    // User stop
    await ingestCallback({
      jobId: job!.id,
      attemptId: attempt.id,
      epoch: 1,
      callbackId: randomUUID(),
      callbackType: "prompt_failed",
      payload: { error: "User stopped", reason: "user_stop" },
    });

    const final = await getJob(job!.id);
    assertEqual(final!.status, "cancelled", "user_stop should produce cancelled status");
  });
}

// ── Main ──

async function main() {
  const args = process.argv.slice(2);
  const dbOnly = args.includes("--db-only");
  const repoArg = args.find((a) => a.includes("/") && !a.startsWith("-"));

  console.log("╔═══════════════════════════════════════╗");
  console.log("║   Polaris v2 Architecture — E2E Test  ║");
  console.log("╚═══════════════════════════════════════╝");

  if (dbOnly) {
    console.log("\nMode: DB-only (no sandbox)");
  } else if (repoArg) {
    console.log(`\nMode: Full pipeline (repo: ${repoArg})`);
  } else {
    console.log("\nMode: DB-only (pass owner/repo for full pipeline)");
  }

  // DB-level tests (always run)
  await testCallbackAuth();
  await testJobStateMachine();
  await testCallbackIngestion();
  await testSessionLifecycle();
  await testActiveJobForSession();
  await testSweeper();
  await testPostProcessingStateMachine();
  await testWebhookRouting();
  await testAutomationSessionLocking();
  await testHITLCallbackFlow();

  // HTTP API tests (requires dev server on localhost:3001)
  try {
    const healthCheck = await fetch("http://localhost:3001", { signal: AbortSignal.timeout(2_000) });
    if (healthCheck.ok) {
      await testCallbackApiRoute();
    } else {
      skip("Callback API Route (HTTP)", "Dev server not healthy");
    }
  } catch {
    skip("Callback API Route (HTTP)", "Dev server not running on localhost:3001");
  }

  // Full pipeline (optional)
  if (!dbOnly && repoArg) {
    const [owner, repo] = repoArg.split("/");
    await testFullPipeline(owner, repo);
  }

  // Summary
  console.log("\n════════════════════════════════════════");
  console.log(`Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
  console.log("════════════════════════════════════════\n");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
