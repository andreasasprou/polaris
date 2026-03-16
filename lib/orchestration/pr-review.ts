/**
 * PR Review Dispatch — v2
 *
 * Replaces trigger/continuous-pr-review.ts.
 * Pre-processes the review (filters, metadata, prompt), then dispatches
 * to the sandbox proxy. Post-processing (parse output, post comment,
 * complete check, release lock) is handled by postprocessReview()
 * triggered by the prompt_complete callback.
 */

import type { NormalizedPrReviewEvent, AutomationSessionMetadata } from "@/lib/reviews/types";
import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import { createJob, createJobAttempt } from "@/lib/jobs/actions";
import { resolveAgentConfig } from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";

export type DispatchPrReviewInput = {
  orgId: string;
  automationId: string;
  automationSessionId: string;
  automationRunId: string;
  installationId: number;
  deliveryId: string;
  normalizedEvent: NormalizedPrReviewEvent;
  checkRunId?: string;
};

export async function dispatchPrReview(
  input: DispatchPrReviewInput,
): Promise<{ jobId: string; queued?: boolean }> {
  const {
    orgId,
    automationId,
    automationSessionId,
    automationRunId,
    installationId,
    normalizedEvent: event,
  } = input;

  const {
    getAutomationSession,
    updateAutomationSession,
    updateAutomationRun,
    tryAcquireAutomationSessionLock,
    setPendingReviewRequest,
  } = await import("@/lib/automations/actions");
  const { findAutomationById } = await import("@/lib/automations/queries");
  const {
    createPendingCheck,
    completeCheck,
    getReviewOctokit,
    isAncestor,
  } = await import("@/lib/reviews/github");

  // 1. Load automation + session
  const automation = await findAutomationById(automationId);
  if (!automation) throw new Error(`Automation ${automationId} not found`);
  const automationSession = await getAutomationSession(automationSessionId);
  if (!automationSession) throw new Error(`AutomationSession ${automationSessionId} not found`);

  const config = (automation.prReviewConfig ?? {}) as import("@/lib/reviews/types").PRReviewConfig;
  const sessionMetadata = automationSession.metadata as AutomationSessionMetadata;

  let checkRunId: string | undefined = input.checkRunId;

  const cancelCheck = async (summary: string, verdict: "APPROVE" | "ATTENTION" = "APPROVE") => {
    if (!checkRunId) return;
    try {
      await completeCheck({
        installationId,
        owner: event.owner,
        repo: event.repo,
        checkRunId,
        verdict,
        summary,
      });
    } catch {
      // Best-effort
    }
  };

  // 2. Acquire lock
  const lockAcquired = await tryAcquireAutomationSessionLock({
    automationSessionId,
    jobId: automationRunId,
  });

  if (!lockAcquired) {
    await cancelCheck("Queued — another review is in progress", "ATTENTION");
    await setPendingReviewRequest(automationSessionId, {
      reason: event.action as import("@/lib/reviews/types").QueuedReviewRequest["reason"],
      headSha: event.headSha,
      requestedAt: new Date().toISOString(),
      requestedBy: event.senderLogin,
      mode: event.manualCommand?.mode ?? "incremental",
      sinceSha: event.manualCommand?.sinceSha,
      commentId: event.commentId,
      deliveryId: input.deliveryId,
    });
    await updateAutomationRun(automationRunId, {
      status: "cancelled",
      summary: "Queued — lock held by another review",
    });
    return { jobId: "", queued: true };
  }

  // 3. Apply filters
  const { shouldReviewPR } = await import("@/lib/reviews/filters");
  const filterResult = shouldReviewPR(event, config);
  if (!filterResult.review) {
    await cancelCheck(`Skipped: ${filterResult.reason}`);
    await updateAutomationRun(automationRunId, {
      status: "completed",
      summary: `Skipped: ${filterResult.reason}`,
      completedAt: new Date(),
    });
    // Release lock since we're not doing a review
    const { releaseAutomationSessionLock } = await import("@/lib/automations/actions");
    await releaseAutomationSessionLock({ automationSessionId, jobId: automationRunId });
    return { jobId: "" };
  }

  // 4. Ensure check exists
  if (!checkRunId) {
    try {
      const check = await createPendingCheck({
        installationId,
        owner: event.owner,
        repo: event.repo,
        headSha: event.headSha,
        checkName: config.checkName,
      });
      checkRunId = check.checkRunId;
    } catch {
      // Continue without check
    }
  }

  await updateAutomationRun(automationRunId, {
    ...(checkRunId ? { githubCheckRunId: checkRunId } : {}),
    status: "running",
    startedAt: new Date(),
  });

  // 5. Gather metadata
  const octokit = await getReviewOctokit(installationId);
  const { fetchPRFileList } = await import("@/lib/reviews/diff");
  const { loadRepoGuidelines } = await import("@/lib/reviews/guidelines");
  const { classifyFiles, filterIgnoredPaths } = await import("@/lib/reviews/classification");

  let reviewScope: "full" | "incremental" | "since" | "reset" = "full";
  let fromSha: string | undefined;
  const toSha = event.headSha;

  if (event.manualCommand) {
    reviewScope = event.manualCommand.mode;
    if (event.manualCommand.mode === "since" && event.manualCommand.sinceSha) {
      fromSha = event.manualCommand.sinceSha;
    }
  } else if (sessionMetadata.lastReviewedSha) {
    const ancestorCheck = await isAncestor({
      installationId,
      owner: event.owner,
      repo: event.repo,
      baseSha: sessionMetadata.lastReviewedSha,
      headSha: toSha,
    });
    if (ancestorCheck) {
      reviewScope = "incremental";
      fromSha = sessionMetadata.lastReviewedSha;
    }
  }

  const reviewSequence = (sessionMetadata.reviewCount ?? 0) + 1;

  const [allFiles, guidelines] = await Promise.all([
    fetchPRFileList(octokit, event.owner, event.repo, event.prNumber, {
      maxFiles: config.maxPromptFiles,
    }),
    loadRepoGuidelines(octokit, event.owner, event.repo, toSha, [], {
      maxBytes: config.maxGuidelinesBytes,
    }),
  ]);

  const filteredFiles = filterIgnoredPaths(allFiles, config.ignorePaths ?? []);
  const fileClassifications = classifyFiles(filteredFiles, config);

  // 6. Build prompt
  const { buildReviewPrompt } = await import("@/lib/reviews/prompt-builder");
  const reviewPrompt = buildReviewPrompt({
    event,
    files: filteredFiles,
    fileClassifications,
    guidelines,
    config,
    previousState: sessionMetadata.reviewState ?? null,
    reviewScope,
    reviewSequence,
    fromSha,
    toSha,
  });

  await updateAutomationRun(automationRunId, {
    reviewSequence,
    reviewScope,
    reviewFromSha: fromSha,
    reviewToSha: toSha,
  });

  // 7. Handle "reset" — create new interactive session
  let targetSessionId = automationSession.interactiveSessionId;
  if (reviewScope === "reset") {
    const { createInteractiveSession } = await import("@/lib/sessions/actions");
    const newSession = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "automation",
      agentType: automation.agentType ?? "claude",
      agentSecretId: automation.agentSecretId ?? undefined,
      repositoryId: automation.repositoryId!,
      prompt: reviewPrompt,
    });
    targetSessionId = newSession.id;

    const { swapAutomationSessionInteractiveSession } = await import("@/lib/automations/actions");
    await swapAutomationSessionInteractiveSession(automationSessionId, newSession.id);
  }

  // 8. Dispatch prompt to session sandbox
  // Use dispatchPromptToSession but we need a "review" type job, so we handle it directly
  const { getInteractiveSession } = await import("@/lib/sessions/actions");
  const session = await getInteractiveSession(targetSessionId);
  if (!session) throw new Error(`Interactive session ${targetSessionId} not found`);

  // Ensure sandbox is ready
  const { casSessionStatus } = await import("@/lib/sessions/actions");
  const cas = await casSessionStatus(
    targetSessionId,
    ["creating", "idle", "hibernated", "stopped", "failed"],
    "active",
  );
  if (!cas) {
    throw new Error(`Cannot dispatch to session ${targetSessionId}: status is ${session.status}`);
  }

  let sandboxBaseUrl = session.sandboxBaseUrl;
  let epoch = session.epoch;
  let sandboxId = session.sandboxId;

  // Check if sandbox is alive
  let sandboxAlive = false;
  if (sandboxBaseUrl) {
    try {
      const proxyUrl = sandboxBaseUrl.replace(/:2468\b/, ":2469");
      const resp = await fetch(`https://${proxyUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      });
      sandboxAlive = resp.ok;
    } catch {
      sandboxAlive = false;
    }
  }

  if (!sandboxAlive) {
    const { resolveSessionCredentials } = await import("@/lib/sessions/prompt-dispatch");
    const creds = await resolveSessionCredentials(session);

    const { ensureSandboxReady } = await import("@/lib/sessions/sandbox-lifecycle");
    const result = await ensureSandboxReady(targetSessionId, {
      agentApiKey: creds.agentApiKey,
      agentType: session.agentType as AgentType,
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
    await casSessionStatus(targetSessionId, ["active"], "idle");
    throw new Error("No sandbox URL available after provisioning");
  }

  // Create review job with all metadata needed for post-processing
  const hmacKey = generateJobHmacKey();
  const job = await createJob({
    organizationId: orgId,
    type: "review",
    sessionId: targetSessionId,
    automationId,
    automationRunId,
    requestId: `review-${automationRunId}`,
    hmacKey,
    payload: {
      prompt: reviewPrompt,
      automationSessionId,
      installationId,
      owner: event.owner,
      repo: event.repo,
      prNumber: event.prNumber,
      checkRunId,
      toSha,
      reviewSequence,
      reviewScope,
      lastCommentId: sessionMetadata.lastCommentId,
      normalizedEvent: event,
      sandboxId,
    },
    timeoutSeconds: 1800, // 30 min
  });

  if (!job) {
    await casSessionStatus(targetSessionId, ["active"], "idle");
    throw new Error(`Job already exists for review request review-${automationRunId}`);
  }

  const attempt = await createJobAttempt({
    jobId: job.id,
    attemptNumber: 1,
    epoch,
    sandboxId: sandboxId ?? undefined,
  });

  // Resolve agent config for the review
  const agentType = (automation.agentType ?? "claude") as AgentType;
  const resolved = resolveAgentConfig({
    agentType,
    modeIntent: "read-only",
    model: automation.model ?? undefined,
    effortLevel: automation.modelParams?.effortLevel,
  });

  // POST /prompt to sandbox proxy
  const proxyUrl = sandboxAlive
    ? sandboxBaseUrl.replace(/:2468\b/, ":2469")
    : sandboxBaseUrl;

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
  const callbackUrl = appUrl
    ? `${appUrl.startsWith("http") ? appUrl : `https://${appUrl}`}/api/callbacks`
    : "http://localhost:3001/api/callbacks";

  try {
    const response = await fetch(`https://${proxyUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jobId: job.id,
        attemptId: attempt.id,
        epoch,
        prompt: reviewPrompt,
        callbackUrl,
        hmacKey,
        config: {
          agent: resolved.agent,
          mode: resolved.mode,
          model: resolved.model,
          thoughtLevel: resolved.thoughtLevel,
          cwd: "/vercel/sandbox",
        },
      }),
      signal: AbortSignal.timeout(30_000),
    });

    if (response.status === 202) {
      await updateAutomationRun(automationRunId, {
        interactiveSessionId: targetSessionId,
      });
      return { jobId: job.id };
    }

    const body = await response.text().catch(() => "");
    const { casAttemptStatus, casJobStatus } = await import("@/lib/jobs/actions");
    await casAttemptStatus(attempt.id, ["dispatching"], "failed", {
      error: `Proxy returned ${response.status}: ${body}`,
    });
    await casJobStatus(job.id, ["pending"], "failed_retryable");
    await casSessionStatus(targetSessionId, ["active"], "idle");
    throw new Error(`Proxy returned ${response.status}: ${body}`);
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") {
      const { casAttemptStatus } = await import("@/lib/jobs/actions");
      await casAttemptStatus(attempt.id, ["dispatching"], "dispatch_unknown");
      return { jobId: job.id };
    }
    throw err;
  }
}
