/**
 * v2 Prompt Dispatch — Two-Tier Session Dispatch
 *
 * Tier 1 (sandbox alive): CAS idle→active, create job, POST /prompt to proxy
 * Tier 2 (sandbox dead):  call ensureSandboxReady, then execute Tier 1
 */

import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import { RequestError } from "@/lib/errors/request-error";
import {
  createJob,
  createJobAttempt,
  getActiveJobForSession,
} from "@/lib/jobs/actions";
import {
  casSessionStatus,
  getInteractiveSessionForOrg,
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
  organizationId: string;
  sessionId: string;
  prompt: string;
  requestId: string;
  source: string;
}): Promise<DispatchResult> {
  const { organizationId, sessionId, prompt, requestId, source } = input;

  const session = await getInteractiveSessionForOrg(sessionId, organizationId);
  if (!session) throw new RequestError("Session not found", 404);

  // Check for existing active job (prevents double dispatch)
  const existingJob = await getActiveJobForSession(sessionId);
  if (existingJob) {
    throw new RequestError(
      `Session ${sessionId} already has an active job: ${existingJob.id}`,
      409,
    );
  }

  // Heal stale active state before CAS — if sandbox died and session
  // was never reconciled, we'd otherwise reject with 409.
  if (session.status === "active") {
    const activeJob = await getActiveJobForSession(sessionId);
    if (!activeJob) {
      await casSessionStatus(sessionId, ["active"], "idle");
    }
  }

  // CAS to active (serializes concurrent sends)
  // "creating" is included because new sessions from the router start in that state
  const cas = await casSessionStatus(
    sessionId,
    ["creating", "idle", "hibernated", "stopped", "failed"],
    "active",
  );
  if (!cas) {
    throw new RequestError(
      `Cannot dispatch to session ${sessionId}: status is ${session.status}`,
      409,
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
    throw new RequestError("No sandbox URL available after provisioning", 502);
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
    throw new RequestError(`Job already exists for request ${requestId}`, 409);
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
  // sandboxBaseUrl is already the proxy URL (stored as proxy URL by ensureSandboxReady)
  const proxyUrl = sandboxBaseUrl;

  try {
    const response = await fetch(`${proxyUrl}/prompt`, {
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
    throw new RequestError(`Proxy returned ${response.status}: ${body}`, 502);
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
    // sandboxBaseUrl is already the proxy URL
    const response = await fetch(`${baseUrl}/health`, {
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
    const { findSecretByIdAndOrg } = await import("@/lib/secrets/queries");
    const secret = await findSecretByIdAndOrg(
      session.agentSecretId,
      session.organizationId,
    );
    if (!secret) {
      throw new RequestError("Secret not found", 404);
    }
    if (secret.revokedAt) {
      throw new RequestError("This API key has been revoked", 400);
    }

    const { decrypt } = await import("@/lib/credentials/encryption");
    agentApiKey = decrypt(secret.encryptedValue);
  }

  if (!agentApiKey) {
    throw new RequestError(
      "No agent API key configured. Add one in Settings → Secrets.",
      400,
    );
  }

  let repositoryOwner: string | undefined;
  let repositoryName: string | undefined;
  let defaultBranch: string | undefined;
  let githubInstallationId: number | undefined;

  if (session.repositoryId) {
    const { findRepositoryByIdAndOrg, findGithubInstallationByIdAndOrg } = await import(
      "@/lib/integrations/queries"
    );
    const repo = await findRepositoryByIdAndOrg(
      session.repositoryId,
      session.organizationId,
    );
    if (!repo) {
      throw new RequestError("Repository not found", 404);
    }

    repositoryOwner = repo.owner;
    repositoryName = repo.name;
    defaultBranch = repo.defaultBranch;

    const installation = await findGithubInstallationByIdAndOrg(
      repo.githubInstallationId,
      session.organizationId,
    );
    if (!installation) {
      throw new RequestError("GitHub installation not found", 404);
    }

    githubInstallationId = installation.installationId;
  }

  if (!repositoryOwner || !repositoryName || !githubInstallationId) {
    throw new RequestError("Could not resolve repository for resume", 400);
  }

  return {
    agentApiKey,
    repositoryOwner,
    repositoryName,
    defaultBranch,
    githubInstallationId,
  };
}
