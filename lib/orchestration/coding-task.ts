/**
 * Coding Task Dispatch — v3
 *
 * Creates an interactive session, provisions a sandbox via ensureSandboxReady,
 * creates a compute claim, and POSTs /prompt to the proxy. Post-processing
 * (git push, PR creation) is triggered by the prompt_complete callback.
 *
 * v3 change: uses session-based lifecycle instead of direct sandbox management.
 * This means the runtime controller can track and clean up coding task sandboxes
 * the same way it handles reviews and interactive sessions.
 */

import { getCallbackUrl } from "@/lib/config/urls";
import type { AutomationCodingTaskPayload } from "./types";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import { createJob, createJobAttempt } from "@/lib/jobs/actions";
import { generateBranchName } from "./metadata";
import { useLogger } from "@/lib/evlog";

export async function dispatchCodingTask(
  payload: AutomationCodingTaskPayload,
): Promise<{ jobId: string }> {
  const { automationRunId } = payload;

  const { updateAutomationRun } = await import("@/lib/automations/actions");
  await updateAutomationRun(automationRunId, {
    status: "running",
    startedAt: new Date(),
  });

  const ctx = await resolveAutomationContext(payload);
  const log = useLogger();
  log.set({ codingTask: { automationRunId, automationId: payload.automationId, owner: ctx.owner, repo: ctx.repo, agentType: ctx.agentType } });

  // Create interactive session — gives the sandbox a runtime record
  // so the controller can track and clean it up.
  const { createInteractiveSession } = await import("@/lib/sessions/actions");
  const session = await createInteractiveSession({
    organizationId: payload.orgId,
    createdBy: "automation",
    agentType: ctx.agentType,
    agentSecretId: ctx.agentSecretId ?? undefined,
    keyPoolId: ctx.keyPoolId ?? undefined,
    repositoryId: ctx.repositoryId,
    prompt: ctx.prompt,
  });

  await updateAutomationRun(automationRunId, {
    interactiveSessionId: session.id,
  });

  log.set({ codingTask: { sessionId: session.id } });

  // Start AI branch name concurrently
  const fallbackBranch = `agent/${Date.now()}`;
  const branchNamePromise = generateBranchName(ctx.title, ctx.prompt, {
    apiKey: ctx.agentApiKey,
    provider: ctx.provider,
  }).catch(() => fallbackBranch);

  let createdJobId: string | undefined;
  let result: Awaited<ReturnType<typeof import("./sandbox-lifecycle").ensureSandboxReady>> | undefined;
  try {
    // Provision sandbox via session lifecycle (creates runtime record + epoch).
    // Inside the try block so provisioning failures trigger rollback
    // (otherwise the session is left with a 'creating' runtime and the
    // automation_run stays 'running' forever).
    const { ensureSandboxReady } = await import("./sandbox-lifecycle");
    result = await ensureSandboxReady(session.id, {
      credentialRef: ctx.credentialRef,
      agentType: ctx.agentType,
      repositoryOwner: ctx.owner,
      repositoryName: ctx.repo,
      defaultBranch: ctx.baseBranch,
      githubInstallationId: ctx.githubInstallationId,
    });

    log.set({ codingTask: { sandboxId: result.sandboxId } });
    // Create branch — ensureSandboxReady handles bootstrap but not branch creation
    const { Sandbox } = await import("@vercel/sandbox");
    const sandbox = await Sandbox.get({
      sandboxId: result.sandboxId,
      token: process.env.VERCEL_TOKEN,
      teamId: process.env.VERCEL_TEAM_ID,
    });
    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    const branchName = await branchNamePromise;
    await git.createBranch(branchName, ctx.baseBranch);
    log.set({ codingTask: { branchName } });
    const baseSha = await git.resolveRef(`origin/${ctx.baseBranch}`);

    // Create job with session link
    const hmacKey = generateJobHmacKey();
    const prompt = buildAutomationPrompt({
      prompt: ctx.prompt,
      title: ctx.title,
      branchName,
    });

    const job = await createJob({
      organizationId: payload.orgId,
      type: "coding_task",
      sessionId: session.id,
      automationId: payload.automationId,
      automationRunId,
      hmacKey,
      payload: {
        prompt,
        branchName,
        baseSha,
        baseBranch: ctx.baseBranch,
        owner: ctx.owner,
        repo: ctx.repo,
        title: ctx.title,
        agentType: ctx.agentType,
        allowPush: ctx.allowPush,
        allowPrCreate: ctx.allowPrCreate,
        sandboxId: result.sandboxId, // kept for backward compat in postprocess
      },
      timeoutSeconds: ctx.maxDurationSeconds,
    });

    if (!job) {
      throw new Error("Failed to create job (idempotent conflict)");
    }
    createdJobId = job.id;

    // Create compute claim — the controller will destroy the sandbox
    // when this claim expires or is released.
    const { createClaim } = await import("@/lib/compute/claims");
    await createClaim({
      sessionId: session.id,
      claimant: job.id,
      reason: "job_active",
      ttlMs: (ctx.maxDurationSeconds + 600) * 1000, // job timeout + 10 min postprocess grace
    });

    const attempt = await createJobAttempt({
      jobId: job.id,
      attemptNumber: 1,
      epoch: result.epoch,
      sandboxId: result.sandboxId,
    });

    log.set({ codingTask: { jobId: job.id, proxyBaseUrl: result.proxyBaseUrl } });

    // POST /prompt to proxy
    const callbackUrl = getCallbackUrl();
    const response = await fetch(`${result.proxyBaseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch: result.epoch,
        prompt,
        callbackUrl,
        hmacKey,
        config: {
          agent: ctx.agentType,
          mode: ctx.agentMode ?? undefined,
          model: ctx.model ?? undefined,
          cwd: SandboxManager.PROJECT_DIR,
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    log.set({ codingTask: { proxyStatus: response.status, contentType: response.headers.get("content-type") } });

    if (response.status !== 202) {
      const body = await response.text().catch(() => "");
      log.set({ codingTask: { failedResponseBody: body.slice(0, 500) } });
      throw new Error(`Proxy returned ${response.status}: ${body}`);
    }

    return { jobId: job.id };
  } catch (error) {
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.set({ codingTask: { failed: true, sandboxId: result?.sandboxId } });

    // Centralized rollback: terminalize orphaned job, release claims, destroy sandbox, fail session
    if (createdJobId) {
      const { casJobStatus } = await import("@/lib/jobs/actions");
      await casJobStatus(createdJobId, ["pending"], "failed_terminal").catch(() => {});
      const { releaseClaimsByClaimant } = await import("@/lib/compute/claims");
      await releaseClaimsByClaimant(session.id, createdJobId).catch(() => {});
    }

    const { destroySandbox } = await import("./sandbox-lifecycle");
    await destroySandbox(session.id).catch(() => {});

    const { casSessionStatus } = await import("@/lib/sessions/actions");
    await casSessionStatus(session.id, ["creating", "active", "idle"], "failed").catch(() => {});

    const message = error instanceof Error ? error.message : String(error);
    await updateAutomationRun(automationRunId, {
      status: "failed",
      error: message,
      completedAt: new Date(),
    });

    throw error;
  }
}

/**
 * Resolve automation context from payload.
 */
async function resolveAutomationContext(payload: AutomationCodingTaskPayload) {
  const { resolveCredentials } = await import("@/lib/orchestration/credential-resolver");
  const { findAutomationById } = await import("@/lib/automations/queries");
  const { credentialRefFromRow } = await import("@/lib/key-pools/types");

  const creds = await resolveCredentials(payload.automationId);
  if (!creds) {
    throw new Error(
      `Failed to resolve credentials for automation ${payload.automationId}`,
    );
  }

  // Get raw automation for session creation fields (agentSecretId, keyPoolId)
  const automation = await findAutomationById(payload.automationId);
  if (!automation) throw new Error(`Automation not found: ${payload.automationId}`);

  const credentialRef = credentialRefFromRow({
    agentSecretId: automation.agentSecretId,
    keyPoolId: automation.keyPoolId,
  });
  if (!credentialRef) throw new Error("No credential configured on automation");

  const event = payload.triggerEvent;
  let title = "Automation task";
  if (event.action && event.pull_request) {
    const pr = event.pull_request as Record<string, unknown>;
    title = `PR ${event.action}: ${pr.title ?? ""}`;
  } else if (event.ref && event.commits) {
    const commits = event.commits as Array<Record<string, unknown>>;
    title = `Push to ${String(event.ref).replace("refs/heads/", "")}: ${commits[0]?.message ?? ""}`;
  }

  return {
    owner: creds.repositoryOwner,
    repo: creds.repositoryName,
    baseBranch: creds.defaultBranch,
    title: title.slice(0, 200),
    prompt: creds.prompt,
    agentType: creds.agentType as import("@/lib/sandbox-agent/types").AgentType,
    agentApiKey: creds.agentApiKey,
    credentialRef,
    agentSecretId: automation.agentSecretId,
    keyPoolId: automation.keyPoolId,
    repositoryId: creds.repositoryId,
    provider: creds.provider,
    agentMode: creds.agentMode,
    model: creds.model,
    modelParams: creds.modelParams,
    githubInstallationId: creds.githubInstallationId,
    maxDurationSeconds: creds.maxDurationSeconds,
    allowPush: creds.allowPush,
    allowPrCreate: creds.allowPrCreate,
  };
}

function buildAutomationPrompt(input: {
  prompt: string;
  title: string;
  branchName: string;
}): string {
  return [
    `Task: ${input.title}`,
    "",
    input.prompt,
    "",
    "REQUIREMENTS:",
    `1. You are on branch ${input.branchName}. Make changes on this branch.`,
    "2. Make the smallest safe fix.",
    "3. Run the most relevant checks available in the repo.",
    "4. Do NOT commit or push — the orchestrator handles git operations.",
    "5. Do not open a PR yourself.",
    "",
    "OUTPUT STYLE:",
    "- Be concise in intermediate messages.",
    "- Prefer concrete repo actions over general commentary.",
  ].join("\n");
}
