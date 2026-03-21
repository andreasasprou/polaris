/**
 * v2 Prompt Dispatch — Two-Tier Session Dispatch
 *
 * Tier 1 (sandbox alive): CAS idle→active, create job, POST /prompt to proxy
 * Tier 2 (sandbox dead):  call ensureSandboxReady, then execute Tier 1
 */

import { getCallbackUrl } from "@/lib/config/urls";
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
} from "@/lib/sessions/actions";
import { ensureSandboxReady } from "./sandbox-lifecycle";
import { getMaxEventIndex } from "@/lib/sandbox-agent/queries";
import { useLogger } from "@/lib/evlog";
import { createStepTimer } from "@/lib/metrics/step-timer";

export type DispatchResult = {
  jobId: string;
};

/**
 * Dispatch a prompt to a session's sandbox.
 *
 * Tier 1: If sandbox is alive, CAS idle→active and POST /prompt.
 * Tier 2: If sandbox is dead/missing, provision a new one, then Tier 1.
 */
export type PromptAttachment = {
  name: string;
  mimeType: string;
  /** base64-encoded binary content */
  data: string;
};

export async function dispatchPromptToSession(input: {
  organizationId: string;
  sessionId: string;
  prompt: string;
  requestId: string;
  source: string;
  attachments?: PromptAttachment[];
}): Promise<DispatchResult> {
  const { organizationId, sessionId, prompt, requestId, source, attachments } = input;
  const log = useLogger();
  const timer = createStepTimer();
  log.set({ dispatch: { sessionId, requestId, source } });

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
  const creds = await timer.time("resolveCredentials", () => resolveSessionCredentials(session));

  // Determine if sandbox is alive (Tier 1) or needs provisioning (Tier 2)
  let sandboxBaseUrl = session.sandboxBaseUrl;
  let epoch = session.epoch;
  let sandboxId = session.sandboxId;

  const sandboxAlive = sandboxBaseUrl
    ? await timer.time("healthProbe", () => probeSandboxHealth(sandboxBaseUrl!))
    : false;

  const tier = sandboxAlive ? 1 : 2;
  log.set({ dispatch: { tier, sandboxAlive, agentType: session.agentType } });

  if (!sandboxAlive) {
    // Tier 2: Provision sandbox (key allocation happens inside ensureSandboxReady)
    const result = await timer.time("ensureSandboxReady", () => ensureSandboxReady(sessionId, {
      credentialRef: creds.credentialRef,
      agentType: session.agentType as Parameters<typeof ensureSandboxReady>[1]["agentType"],
      repositoryOwner: creds.repositoryOwner,
      repositoryName: creds.repositoryName,
      defaultBranch: creds.defaultBranch,
      githubInstallationId: creds.githubInstallationId,
    }));
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

  // Create compute claim — declares this job needs the sandbox.
  // The runtime controller will destroy the sandbox when the claim expires or is released.
  const { createClaim } = await import("@/lib/compute/claims");
  await createClaim({
    sessionId,
    claimant: job.id,
    reason: "job_active",
    ttlMs: (job.timeoutSeconds + 300) * 1000, // job timeout + 5 min grace
  });

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

  // Compute next event index for resumed sessions so event indexes stay monotonic
  const maxIdx = session.sdkSessionId ? await getMaxEventIndex(session.sdkSessionId) : null;
  const nextEventIndex = maxIdx != null ? maxIdx + 1 : 0;

  log.set({ dispatch: { jobId: job.id, attemptId: attempt.id, epoch } });

  try {
    const response = await timer.time("postPrompt", () => fetch(`${proxyUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch,
        prompt,
        callbackUrl: buildCallbackUrl(),
        hmacKey,
        requestId,
        config: {
          agent: session.agentType,
          cwd: "/vercel/sandbox",
          sdkSessionId: session.sdkSessionId ?? undefined,
          nativeAgentSessionId: session.nativeAgentSessionId ?? undefined,
          nextEventIndex: nextEventIndex ?? undefined,
        },
        ...(attachments?.length ? { attachments } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    }));

    if (response.status === 202) {
      log.set({ timing: timer.finalize() });
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
      log.set({ timing: timer.finalize() });
      return { jobId: job.id };
    }
    throw err;
  }
}

/**
 * Probe sandbox proxy health.
 * Validates the response body (not just HTTP status) because stopped
 * Vercel sandboxes return 200 with an HTML page, not JSON.
 */
export async function probeSandboxHealth(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

export function buildCallbackUrl(): string {
  return getCallbackUrl();
}

/**
 * Resolve credential reference + repository info for a session.
 *
 * This is the VALIDATION layer — it checks that credentials exist and are valid,
 * but does NOT decrypt keys or allocate from pools. Key allocation happens
 * inside ensureSandboxReady() at provisioning time.
 */
export async function resolveSessionCredentials(session: {
  organizationId: string;
  agentType: string;
  agentSecretId: string | null;
  keyPoolId: string | null;
  repositoryId: string | null;
}) {
  const { credentialRefFromRow } = await import("@/lib/key-pools/types");
  const { validateCredentialRef } = await import("@/lib/key-pools/validate");

  const credentialRef = credentialRefFromRow({
    agentSecretId: session.agentSecretId,
    keyPoolId: session.keyPoolId,
  });

  if (!credentialRef) {
    throw new RequestError(
      "No agent API key configured. Add one in Settings → Secrets.",
      400,
    );
  }

  // Validate existence, org-scoping, revocation — no key decryption
  await validateCredentialRef(credentialRef, session.organizationId);

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
    credentialRef,
    repositoryOwner,
    repositoryName,
    defaultBranch,
    githubInstallationId,
  };
}
