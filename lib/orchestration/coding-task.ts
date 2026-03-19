/**
 * Coding Task Dispatch — v2
 *
 * Replaces trigger/coding-task.ts.
 * Creates a sandbox, bootstraps agent + proxy, creates a job,
 * and POSTs /prompt to the proxy. Post-processing (git push, PR creation)
 * is triggered by the prompt_complete callback via postprocess.ts.
 */

import { getCallbackUrl } from "@/lib/config/urls";
import type { AutomationCodingTaskPayload } from "./types";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import { createJob, createJobAttempt } from "@/lib/jobs/actions";

const sandboxManager = new SandboxManager();

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

  // Mint GitHub token
  const { mintInstallationToken } = await import("@/lib/integrations/github");
  const gitToken = await mintInstallationToken(
    ctx.githubInstallationId,
    [ctx.repo],
    { contents: "write", pull_requests: "write" },
  );

  const repoUrl = `https://github.com/${ctx.owner}/${ctx.repo}.git`;

  // Create sandbox
  const { getActiveSnapshot } = await import("@/lib/sandbox/snapshots/queries");
  const agentSnapshot = await getActiveSnapshot(ctx.agentType);

  const sandbox = await sandboxManager.create({
    source: agentSnapshot
      ? { type: "snapshot", snapshotId: agentSnapshot }
      : { type: "git" },
    repoUrl,
    gitToken,
    baseBranch: ctx.baseBranch,
    timeoutMs: ctx.maxDurationSeconds * 1000,
    ports: [2468, 2469],
  });

  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);
  const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

  try {
    // Configure git + create branch
    await git.configure({ repoUrl });
    const branchName = `agent/${Date.now()}`;
    await git.createBranch(branchName, ctx.baseBranch);
    const baseSha = await git.resolveRef(`origin/${ctx.baseBranch}`);

    // Bootstrap agent server
    const sessionEnv = buildSessionEnv(ctx.agentType, ctx.agentApiKey);
    if (!agentSnapshot) {
      await bootstrap.install();
      await bootstrap.installAgent(ctx.agentType, sessionEnv);
    }
    await bootstrap.start(2468, sessionEnv);

    // Install + start REST proxy
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const proxyBundlePath = path.resolve(
      currentDir,
      "../sandbox-proxy/dist/proxy.js",
    );
    const proxyBundle = fs.readFileSync(proxyBundlePath, "utf-8");
    await bootstrap.installProxy(proxyBundle);

    const callbackBaseUrl = getCallbackUrl();

    const proxyBaseUrl = await bootstrap.startProxy({
      ...sessionEnv,
      CALLBACK_URL: callbackBaseUrl,
    });

    // Create job
    const hmacKey = generateJobHmacKey();
    const prompt = buildAutomationPrompt({
      prompt: ctx.prompt,
      title: ctx.title,
      branchName,
    });

    const job = await createJob({
      organizationId: payload.orgId,
      type: "coding_task",
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
        sandboxId: sandbox.sandboxId,
      },
      timeoutSeconds: ctx.maxDurationSeconds,
    });

    if (!job) {
      throw new Error("Failed to create job (idempotent conflict)");
    }

    const attempt = await createJobAttempt({
      jobId: job.id,
      attemptNumber: 1,
      epoch: 1,
      sandboxId: sandbox.sandboxId,
    });

    // POST /prompt to proxy
    const response = await fetch(`${proxyBaseUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch: 1,
        prompt,
        callbackUrl: callbackBaseUrl,
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

    if (response.status !== 202) {
      const body = await response.text().catch(() => "");
      throw new Error(`Proxy returned ${response.status}: ${body}`);
    }

    return { jobId: job.id };
  } catch (error) {
    // On failure, clean up sandbox and mark run as failed
    await sandboxManager.destroy(sandbox);

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
  const { resolveCredentials } = await import("@/lib/credentials/resolver");
  const creds = await resolveCredentials(payload.automationId);
  if (!creds) {
    throw new Error(
      `Failed to resolve credentials for automation ${payload.automationId}`,
    );
  }

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
