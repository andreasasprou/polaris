/**
 * PR Review Dispatch — v2
 *
 * Pre-processes the review (filters, metadata, prompt), then dispatches
 * to the sandbox proxy. Post-processing (parse output, post comment,
 * complete check, release lock) is handled by postprocessReview()
 * triggered by the prompt_complete callback.
 *
 * Lock lifecycle:
 *   - Lock acquired at the start (tryAcquireAutomationSessionLock)
 *   - If dispatch succeeds (202): callback path owns the lock, released in postprocessReview
 *   - If dispatch fails: try-finally releases the lock immediately
 *   - If dispatch_unknown (timeout): sweeper owns the lock, released when job times out
 */

import type { NormalizedPrReviewEvent, AutomationSessionMetadata } from "@/lib/reviews/types";
import { generateJobHmacKey } from "@/lib/jobs/callback-auth";
import { createJob, createJobAttempt } from "@/lib/jobs/actions";
import { resolveAgentConfig } from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { useLogger } from "@/lib/evlog";

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
): Promise<{ jobId: string; queued?: boolean; retryDeferred?: boolean }> {
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
    updateAutomationRun,
    updateAutomationSession,
    tryAcquireAutomationSessionLock,
    releaseAutomationSessionLock,
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

  const connectorConfig = (automation.prReviewConfig ?? {}) as import("@/lib/reviews/types").PRReviewConfig;
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

  // Lock acquired — everything below is wrapped in try-finally to guarantee release.
  // `handedOff` tracks whether we successfully handed execution to the callback path
  // (sandbox accepted the prompt) or the sweeper (dispatch_unknown timeout).
  let handedOff = false;
  let createdJobId: string | undefined;
  let targetSessionId = automationSession.interactiveSessionId;

  try {
    const log = useLogger();
    log.set({ dispatch: { automationRunId, automationId, sessionId: automationSessionId, prNumber: event.prNumber } });

    // 3. Ensure check exists (before config validation so error paths can fail it)
    if (!checkRunId) {
      try {
        const check = await createPendingCheck({
          installationId,
          owner: event.owner,
          repo: event.repo,
          headSha: event.headSha,
          checkName: connectorConfig.checkName,
        });
        checkRunId = check.checkRunId;
      } catch {
        // Continue without check — best effort
      }
    }

    // 4. Load repo-level config from BASE branch
    const octokit = await getReviewOctokit(installationId);
    const { loadRepoReviewConfig, mergeWithConnector, formatConfigError } = await import("@/lib/reviews/repo-config");
    const repoConfigResult = await loadRepoReviewConfig(octokit, event.owner, event.repo, event.baseRef);

    let config = connectorConfig;
    let resolvedRuntime: {
      agentType: AgentType;
      model: string;
      modelParams: import("@/lib/sandbox-agent/types").ModelParams;
      credentialOverride?: { agentSecretId: string | null; keyPoolId: string | null };
    } | null = null;

    // Helper: fail config validation and return early
    const failConfig = async (errorMsg: string) => {
      const { failCheck } = await import("@/lib/reviews/github");
      if (checkRunId) {
        await failCheck({ installationId, owner: event.owner, repo: event.repo, checkRunId, error: errorMsg });
      }
      await updateAutomationRun(automationRunId, { status: "failed", summary: errorMsg, error: errorMsg, completedAt: new Date() });
      await releaseAutomationSessionLock({ automationSessionId, jobId: automationRunId });
      handedOff = true;
    };

    if (repoConfigResult.status === "found") {
      const resolved = mergeWithConnector(repoConfigResult.definition, automation);
      config = resolved.reviewConfig;
      resolvedRuntime = {
        agentType: resolved.agentType,
        model: resolved.model,
        modelParams: resolved.modelParams,
      };

      // Validate agent/model/effort coherence before proceeding
      const { validateRuntimeCoherence } = await import("@/lib/reviews/repo-config");
      const coherenceError = await validateRuntimeCoherence(resolved);
      if (coherenceError) {
        await failConfig(`Review config error: .polaris/reviews/${repoConfigResult.file} — ${coherenceError}`);
        return { jobId: "" };
      }

      // Resolve credential slug to actual ID (scoped by agent type)
      if (repoConfigResult.definition.credential) {
        const { resolveCredentialSlug } = await import("@/lib/reviews/repo-config");
        const credRef = await resolveCredentialSlug(orgId, repoConfigResult.definition.credential, resolvedRuntime.agentType);
        if (!credRef) {
          await failConfig(`Review config error: credential "${repoConfigResult.definition.credential}" not found. Check that the key pool name or API key label exists in your organization settings.`);
          return { jobId: "" };
        }
        resolvedRuntime.credentialOverride = {
          agentSecretId: credRef.type === "secret" ? credRef.secretId : null,
          keyPoolId: credRef.type === "pool" ? credRef.poolId : null,
        };
      }
    } else if (
      repoConfigResult.status === "invalid" ||
      repoConfigResult.status === "multiple" ||
      repoConfigResult.status === "error"
    ) {
      await failConfig(formatConfigError(repoConfigResult));
      return { jobId: "" };
    }

    // 5. Fetch raw full file list for filters and guideline scoping
    const { fetchFullFileList } = await import("@/lib/reviews/diff");
    const allChangedFiles = await fetchFullFileList(octokit, event.owner, event.repo, event.prNumber);

    // 6. Apply filters with the RAW full file list
    const { shouldReviewPR } = await import("@/lib/reviews/filters");
    const filterResult = shouldReviewPR(event, config, allChangedFiles);
    if (!filterResult.review) {
      const skipSummary = `Skipped: ${filterResult.reason}`;
      await cancelCheck(skipSummary);
      await updateAutomationRun(automationRunId, {
        status: "completed",
        summary: skipSummary,
        completedAt: new Date(),
      });

      // Post a brief PR comment so the author knows why the review was skipped.
      // Only on the first skip per PR (don't spam on every push).
      if (sessionMetadata.reviewCount === 0 || !sessionMetadata.reviewCount) {
        try {
          const { postReviewComment } = await import("@/lib/reviews/github");
          await postReviewComment({
            installationId,
            owner: event.owner,
            repo: event.repo,
            prNumber: event.prNumber,
            body: `**Polaris Review** — ${skipSummary}\n\nNo review will be performed for this PR. If this is unexpected, check your automation's filter settings.`,
          });
        } catch {
          // Best-effort — don't fail the skip flow
        }
      }

      await releaseAutomationSessionLock({ automationSessionId, jobId: automationRunId });
      handedOff = true; // lock explicitly released, skip finally cleanup
      return { jobId: "" };
    }

    await updateAutomationRun(automationRunId, {
      ...(checkRunId ? { githubCheckRunId: checkRunId } : {}),
      status: "running",
      startedAt: new Date(),
    });

    // 7. Gather metadata
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

    // Compute reviewed paths (post-ignorePaths) for scoped guideline discovery
    const reviewedPaths = filterIgnoredPaths(allChangedFiles, config.ignorePaths ?? []);

    const { fetchPRDiff, fetchCommitRangeDiff } = await import("@/lib/reviews/diff");

    const [guidelines, diffResult] = await Promise.all([
      // Load guidelines from trusted base ref using reviewed paths
      loadRepoGuidelines(octokit, event.owner, event.repo, event.baseRef, reviewedPaths, {
        maxBytes: config.maxGuidelinesBytes,
      }),
      reviewScope === "incremental" && fromSha
        ? fetchCommitRangeDiff(octokit, event.owner, event.repo, fromSha, toSha, {
            maxBytes: config.maxPromptDiffBytes,
          })
        : fetchPRDiff(octokit, event.owner, event.repo, event.prNumber, {
            maxBytes: config.maxPromptDiffBytes,
            maxFiles: config.maxPromptFiles,
          }),
    ]);

    // Cap the file list for prompt rendering (separate from the uncapped list used for filters/guidelines)
    const maxPromptFiles = config.maxPromptFiles ?? 150;
    const filteredFiles = reviewedPaths.slice(0, maxPromptFiles);
    const fileClassifications = classifyFiles(filteredFiles, config);

    // 8. Build prompt
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
      diffPrepared: {
        filePath: "/tmp/review-diff.patch",
        truncated: diffResult.truncated,
      },
    });

    await updateAutomationRun(automationRunId, {
      reviewSequence,
      reviewScope,
      reviewFromSha: fromSha,
      reviewToSha: toSha,
    });

    // 9. Handle session creation — explicit "reset" or YAML runtime drift
    const effectiveAgentType = resolvedRuntime?.agentType ?? automation.agentType ?? "claude";
    const effectiveModel = resolvedRuntime?.model || automation.model || null;
    const effectiveEffort = resolvedRuntime?.modelParams?.effortLevel ?? automation.modelParams?.effortLevel ?? null;
    // When YAML specifies a credential, use the entire override (not individual fields)
    // to avoid mixing YAML's null agentSecretId with connector's agentSecretId,
    // which violates the DB CHECK constraint (both cannot be set).
    const effectiveSecretId = resolvedRuntime?.credentialOverride
      ? resolvedRuntime.credentialOverride.agentSecretId
      : automation.agentSecretId ?? null;
    const effectivePoolId = resolvedRuntime?.credentialOverride
      ? resolvedRuntime.credentialOverride.keyPoolId
      : automation.keyPoolId ?? null;

    // Build the full runtime config for drift comparison and metadata tracking
    const currentRuntimeConfig = {
      agentType: effectiveAgentType,
      model: effectiveModel,
      effort: effectiveEffort,
      agentSecretId: effectiveSecretId,
      keyPoolId: effectivePoolId,
    };

    // Detect if YAML changed the agent, credential, model, or effort vs what the
    // existing session was created with. If so, we need a fresh session — the old
    // sandbox, agent session IDs, and credentials/model/effort are stale.
    // Agent type and credentials are compared against the interactive session (DB source of truth).
    // Model and effort are compared against metadata (not stored on interactive_sessions).
    const { getInteractiveSession: getSessionForDriftCheck } = await import("@/lib/sessions/actions");
    const currentSession = await getSessionForDriftCheck(targetSessionId);
    const lastRuntime = sessionMetadata.lastRuntimeConfig as
      | { model?: string | null; effort?: string | null }
      | undefined;
    const runtimeDrifted = currentSession && (
      // Agent type / credential drift (compare against interactive session)
      currentSession.agentType !== effectiveAgentType ||
      (currentSession.agentSecretId ?? null) !== effectiveSecretId ||
      (currentSession.keyPoolId ?? null) !== effectivePoolId ||
      // Model / effort drift (compare against last dispatched config in metadata).
      // If lastRuntime is absent (pre-existing session), only drift if YAML
      // explicitly specifies a model/effort (resolvedRuntime exists).
      (lastRuntime
        ? (lastRuntime.model ?? null) !== effectiveModel ||
          (lastRuntime.effort ?? null) !== effectiveEffort
        : resolvedRuntime !== null && repoConfigResult.status === "found" && (
            repoConfigResult.definition.model !== undefined ||
            repoConfigResult.definition.effort !== undefined
          ))
    );

    if (reviewScope === "reset" || runtimeDrifted) {
      const { createInteractiveSession } = await import("@/lib/sessions/actions");
      const newSession = await createInteractiveSession({
        organizationId: orgId,
        createdBy: "automation",
        agentType: effectiveAgentType,
        agentSecretId: effectiveSecretId ?? undefined,
        keyPoolId: effectivePoolId ?? undefined,
        repositoryId: automation.repositoryId!,
        prompt: reviewPrompt,
      });
      targetSessionId = newSession.id;

      const { swapAutomationSessionInteractiveSession } = await import("@/lib/automations/actions");
      await swapAutomationSessionInteractiveSession(automationSessionId, newSession.id);
    }

    // 10. Dispatch prompt to session sandbox
    const { getInteractiveSession, casSessionStatus } = await import("@/lib/sessions/actions");
    // Reuse the drift-check fetch if targetSessionId didn't change (common path)
    const session = (currentSession && currentSession.id === targetSessionId)
      ? currentSession
      : await getInteractiveSession(targetSessionId);
    if (!session) throw new Error(`Interactive session ${targetSessionId} not found`);

    // Heal stale active state before CAS — if sandbox died and session
    // was never reconciled, we'd otherwise throw "status is active".
    if (session.status === "active") {
      const { getActiveJobForSession } = await import("@/lib/jobs/actions");
      const activeJob = await getActiveJobForSession(targetSessionId);
      if (!activeJob) {
        await casSessionStatus(targetSessionId, ["active"], "idle");
      }
    }

    const cas = await casSessionStatus(
      targetSessionId,
      ["creating", "idle", "hibernated", "stopped", "failed"],
      "active",
    );
    if (!cas) {
      throw new Error(`Cannot dispatch to session ${targetSessionId}: status is ${session.status}`);
    }

    // 11. Create review job (before dispatch loop — job is the durable boundary)
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
      },
      timeoutSeconds: 1800,
    });

    if (!job) {
      throw new Error(`Job already exists for review request review-${automationRunId}`);
    }
    createdJobId = job.id;

    // Create compute claim — declares this review job needs the sandbox.
    const { createClaim } = await import("@/lib/compute/claims");
    await createClaim({
      sessionId: targetSessionId,
      claimant: job.id,
      reason: "job_active",
      ttlMs: (job.timeoutSeconds + 300) * 1000, // job timeout + 5 min grace
    });

    // Resolve agent config (using effective values computed in step 9)
    const resolved = resolveAgentConfig({
      agentType: effectiveAgentType as AgentType,
      modeIntent: "read-only",
      model: effectiveModel ?? undefined,
      effortLevel: effectiveEffort ?? undefined,
    });

    // Resolve MCP servers for this org
    const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");
    const mcpServers = await getResolvedMcpServers(orgId);

    // Shared primitives
    const { probeSandboxHealth, buildCallbackUrl } = await import("./prompt-dispatch");
    const { getNextEventIndex } = await import("@/lib/sandbox-agent/queries");
    const { casAttemptStatus, casJobStatus } = await import("@/lib/jobs/actions");
    const callbackUrl = buildCallbackUrl();

    log.set({ dispatch: { callbackUrl, jobId: job.id, agent: resolved.agent } });

    // 12. Dispatch with inline retry — health check adjacent to POST
    let currentSandboxUrl = session.sandboxBaseUrl;
    let currentEpoch = session.epoch;
    let currentSandboxId = session.sandboxId;
    const MAX_INLINE_ATTEMPTS = 2;

    for (let i = 1; i <= MAX_INLINE_ATTEMPTS; i++) {
      // Health check right before POST (no metadata gap)
      const alive = currentSandboxUrl
        ? await probeSandboxHealth(currentSandboxUrl)
        : false;

      log.set({ dispatch: { [`attempt_${i}_health`]: { alive, sandboxId: currentSandboxId, sandboxUrl: currentSandboxUrl ? "set" : "none" } } });

      if (!alive) {
        log.set({ dispatch: { [`attempt_${i}_reprovisioning`]: true } });
        const { resolveSessionCredentials } = await import("./prompt-dispatch");
        const creds = await resolveSessionCredentials(session);

        const { ensureSandboxReady } = await import("./sandbox-lifecycle");
        const result = await ensureSandboxReady(targetSessionId, {
          credentialRef: creds.credentialRef,
          agentType: session.agentType as AgentType,
          repositoryOwner: creds.repositoryOwner,
          repositoryName: creds.repositoryName,
          defaultBranch: creds.defaultBranch,
          githubInstallationId: creds.githubInstallationId,
        });
        currentSandboxUrl = result.proxyBaseUrl;
        currentEpoch = result.epoch;
        currentSandboxId = result.sandboxId;
      }

      if (!currentSandboxUrl) {
        throw new Error("No sandbox URL available after provisioning");
      }

      // Create attempt only when POST is imminent
      const attempt = await createJobAttempt({
        jobId: job.id,
        attemptNumber: i,
        epoch: currentEpoch,
        sandboxId: currentSandboxId ?? undefined,
      });

      // Compute resume fields so subsequent reviews in the same session
      // continue the agent session instead of creating a fresh one.
      const nextEventIndex = await getNextEventIndex(session.sdkSessionId);

      const promptBody = {
        jobId: job.id,
        attemptId: attempt.id,
        epoch: currentEpoch,
        prompt: reviewPrompt,
        callbackUrl,
        hmacKey,
        config: {
          agent: resolved.agent,
          mode: resolved.mode,
          model: resolved.model,
          thoughtLevel: resolved.thoughtLevel,
          cwd: "/vercel/sandbox",
          sdkSessionId: session.sdkSessionId ?? undefined,
          nativeAgentSessionId: session.nativeAgentSessionId ?? undefined,
          nextEventIndex: nextEventIndex ?? undefined,
          mcpServers,
        },
        contextFiles: [
          {
            path: "/tmp/review-diff.patch",
            content: diffResult.diff,
          },
        ],
      };

      log.set({ dispatch: { [`attempt_${i}_dispatching`]: { sandboxUrl: currentSandboxUrl, sandboxId: currentSandboxId } } });

      let response: Response | "timeout";
      try {
        response = await fetch(`${currentSandboxUrl}/prompt`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(promptBody),
          signal: AbortSignal.timeout(30_000),
        });
      } catch (err) {
        if (err instanceof Error && err.name === "TimeoutError") {
          response = "timeout";
        } else {
          throw err;
        }
      }

      // Timeout — sweeper owns recovery
      if (response === "timeout") {
        handedOff = true;
        await casAttemptStatus(attempt.id, ["dispatching"], "dispatch_unknown").catch(() => {});
        log.set({ dispatch: { [`attempt_${i}_timeout`]: true } });
        return { jobId: job.id };
      }

      log.set({ dispatch: { [`attempt_${i}_response`]: { status: response.status, contentType: response.headers.get("content-type") } } });

      // Success
      if (response.status === 202) {
        handedOff = true;
        await Promise.all([
          updateAutomationRun(automationRunId, {
            interactiveSessionId: targetSessionId,
          }),
          // Persist runtime config so future dispatches can detect model/effort drift.
          // Re-read metadata to avoid clobbering concurrent pendingReviewRequest writes.
          getAutomationSession(automationSessionId).then((fresh) => {
            if (!fresh) return;
            const freshMetadata = fresh.metadata as AutomationSessionMetadata;
            return updateAutomationSession(automationSessionId, {
              metadata: { ...freshMetadata, lastRuntimeConfig: currentRuntimeConfig },
            });
          }),
        ]).catch(() => {});
        return { jobId: job.id };
      }

      // Non-202: mark attempt failed
      const body = await response.text().catch(() => "");
      log.set({ dispatch: { [`attempt_${i}_failedBody`]: body.slice(0, 500), sandboxId: currentSandboxId } });
      await casAttemptStatus(attempt.id, ["dispatching"], "failed", {
        error: `Proxy returned ${response.status}: ${body}`,
      });

      if (i < MAX_INLINE_ATTEMPTS) {
        log.set({ dispatch: { [`attempt_${i}_retrying`]: true } });
        currentSandboxUrl = null;
        continue;
      }
    }

    // Both inline attempts exhausted — defer to sweeper (non-exceptional return)
    await casJobStatus(job.id, ["pending"], "failed_retryable");
    handedOff = true; // Lock stays held for sweeper retry
    log.set({ dispatch: { exhaustedAttempts: true, deferredToSweeper: true } });
    return { jobId: job.id, retryDeferred: true };
  } catch (err) {
    // Rollback: terminalize orphaned job + release claim so the shared
    // session isn't left with a dangling pending job that blocks future
    // reviews and causes sweepTimedOutJobs to destroy the sandbox.
    if (createdJobId) {
      const { casJobStatus: casJ } = await import("@/lib/jobs/actions");
      await casJ(createdJobId, ["pending"], "failed_terminal").catch(() => {});
      const { releaseClaimsByClaimant } = await import("@/lib/compute/claims");
      await releaseClaimsByClaimant(targetSessionId, createdJobId).catch(() => {});
    }

    // Mark run as failed (best-effort)
    await updateAutomationRun(automationRunId, {
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
      completedAt: new Date(),
    }).catch(() => {});

    // Cancel the check if we created one
    if (checkRunId) {
      await cancelCheck("Review dispatch failed").catch(() => {});
    }

    throw err;
  } finally {
    if (!handedOff) {
      // Dispatch failed — release lock and heal session
      const { casSessionStatus } = await import("@/lib/sessions/actions");
      await casSessionStatus(targetSessionId, ["active"], "idle").catch(() => {});
      await releaseAutomationSessionLock({
        automationSessionId,
        jobId: automationRunId,
      }).catch(() => {});
    }
  }
}
