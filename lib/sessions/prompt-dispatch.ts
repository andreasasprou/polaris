/**
 * v2 Prompt Dispatch — Two-Tier Session Dispatch
 *
 * Tier 1 (sandbox alive): CAS idle→active, create job, POST /prompt to proxy
 * Tier 2 (sandbox dead):  call ensureSandboxReady, then execute Tier 1
 */

import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import {
  createJob,
  createJobAttempt,
  getActiveJobForSession,
} from "@/lib/jobs/actions";
import {
  casSessionStatus,
  getInteractiveSession,
  createTurn,
} from "./actions";
import { ensureSandboxReady } from "./sandbox-lifecycle";

export type DispatchResult = {
  jobId: string;
};

/**
 * Dispatch a prompt to a session's sandbox.
 *
 * Tier 1: If sandbox is alive, CAS idle→active and POST /prompt.
 * Tier 2: If sandbox is dead/missing, provision a new one, then Tier 1.
 */
export async function dispatchPromptToSession(input: {
  sessionId: string;
  prompt: string;
  requestId: string;
  source: string;
}): Promise<DispatchResult> {
  const { sessionId, prompt, requestId, source } = input;

  const session = await getInteractiveSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Check for existing active job (prevents double dispatch)
  const existingJob = await getActiveJobForSession(sessionId);
  if (existingJob) {
    throw new Error(
      `Session ${sessionId} already has an active job: ${existingJob.id}`,
    );
  }

  // CAS to active (serializes concurrent sends)
  // "creating" is included because new sessions from the router start in that state
  const cas = await casSessionStatus(
    sessionId,
    ["creating", "idle", "hibernated", "stopped", "failed"],
    "active",
  );
  if (!cas) {
    throw new Error(
      `Cannot dispatch to session ${sessionId}: status is ${session.status}`,
    );
  }

  // Resolve credentials
  const creds = await resolveSessionCredentials(session);

  // Determine if sandbox is alive (Tier 1) or needs provisioning (Tier 2)
  let sandboxBaseUrl = session.sandboxBaseUrl;
  let epoch = session.epoch;
  let sandboxId = session.sandboxId;

  const sandboxAlive = sandboxBaseUrl
    ? await probeSandboxHealth(sandboxBaseUrl)
    : false;

  if (!sandboxAlive) {
    // Tier 2: Provision sandbox
    const result = await ensureSandboxReady(sessionId, {
      agentApiKey: creds.agentApiKey,
      agentType: session.agentType as Parameters<typeof ensureSandboxReady>[1]["agentType"],
      repositoryOwner: creds.repositoryOwner,
      repositoryName: creds.repositoryName,
      defaultBranch: creds.defaultBranch,
      githubInstallationId: creds.githubInstallationId,
    });
    sandboxBaseUrl = result.proxyBaseUrl;
    epoch = result.epoch;
    sandboxId = result.sandboxId;
  }

  if (!sandboxBaseUrl) {
    // Rollback CAS
    await casSessionStatus(sessionId, ["active"], "idle");
    throw new Error("No sandbox URL available after provisioning");
  }

  // Create job + attempt + turn
  const hmacKey = generateJobHmacKey();
  const job = await createJob({
    organizationId: session.organizationId,
    type: "prompt",
    sessionId,
    requestId,
    hmacKey,
    payload: {
      prompt,
      source,
      sandboxId,
    },
    timeoutSeconds: 1200, // 20 minutes
  });

  if (!job) {
    // Idempotent conflict — job already exists for this request
    await casSessionStatus(sessionId, ["active"], "idle");
    throw new Error(`Job already exists for request ${requestId}`);
  }

  const attempt = await createJobAttempt({
    jobId: job.id,
    attemptNumber: 1,
    epoch,
    sandboxId: sandboxId ?? undefined,
  });

  await createTurn({
    sessionId,
    requestId,
    runtimeId: undefined,
    source,
    prompt,
  });

  // POST /prompt to sandbox proxy
  const proxyUrl = sandboxAlive
    ? sandboxBaseUrl.replace(/:2468\b/, ":2469") // Rewrite agent URL to proxy port
    : sandboxBaseUrl; // Already the proxy URL from ensureSandboxReady

  try {
    const response = await fetch(`https://${proxyUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch,
        prompt,
        callbackUrl: buildCallbackUrl(),
        hmacKey,
        config: {
          agent: session.agentType,
          cwd: "/vercel/sandbox",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 202) {
      return { jobId: job.id };
    }

    // Non-202: rollback
    const body = await response.text().catch(() => "");
    const { casAttemptStatus, casJobStatus } = await import(
      "@/lib/jobs/actions"
    );
    await casAttemptStatus(attempt.id, ["dispatching"], "failed", {
      error: `Proxy returned ${response.status}: ${body}`,
    });
    await casJobStatus(job.id, ["pending"], "failed_retryable");
    await casSessionStatus(sessionId, ["active"], "idle");
    throw new Error(`Proxy returned ${response.status}: ${body}`);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      // Dispatch unknown — sweeper will reconcile
      const { casAttemptStatus } = await import("@/lib/jobs/actions");
      await casAttemptStatus(attempt.id, ["dispatching"], "dispatch_unknown");
      return { jobId: job.id };
    }
    throw err;
  }
}

/**
 * Probe sandbox proxy health.
 */
async function probeSandboxHealth(baseUrl: string): Promise<boolean> {
  try {
    // Probe the proxy health endpoint
    const proxyUrl = baseUrl.replace(/:2468\b/, ":2469");
    const response = await fetch(`https://${proxyUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function buildCallbackUrl(): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
  if (appUrl) {
    const base = appUrl.startsWith("http") ? appUrl : `https://${appUrl}`;
    return `${base}/api/callbacks`;
  }
  return "http://localhost:3001/api/callbacks";
}

/**
 * Resolve agent API key + repository info for a session.
 * Shared by session creation and prompt dispatch.
 */
export async function resolveSessionCredentials(session: {
  organizationId: string;
  agentType: string;
  agentSecretId: string | null;
  repositoryId: string | null;
}) {
  let agentApiKey: string | undefined;

  if (session.agentSecretId) {
    const { getDecryptedSecretForOrg } = await import("@/lib/secrets/queries");
    agentApiKey =
      (await getDecryptedSecretForOrg(session.agentSecretId, session.organizationId)) ?? undefined;
  }

  if (!agentApiKey) {
    throw new Error(
      "No agent API key configured. Add one in Settings → Secrets.",
    );
  }

  let repositoryOwner: string | undefined;
  let repositoryName: string | undefined;
  let defaultBranch: string | undefined;
  let githubInstallationId: number | undefined;

  if (session.repositoryId) {
    const { findRepositoryById, findGithubInstallationById } = await import(
      "@/lib/integrations/queries"
    );
    const repo = await findRepositoryById(session.repositoryId);
    if (repo) {
      repositoryOwner = repo.owner;
      repositoryName = repo.name;
      defaultBranch = repo.defaultBranch;
      const installation = await findGithubInstallationById(
        repo.githubInstallationId,
      );
      if (installation) {
        githubInstallationId = installation.installationId;
      }
    }
  }

  if (!repositoryOwner || !repositoryName || !githubInstallationId) {
    throw new Error("Could not resolve repository for resume");
  }

  return {
    agentApiKey,
    repositoryOwner,
    repositoryName,
    defaultBranch,
    githubInstallationId,
  };
}
