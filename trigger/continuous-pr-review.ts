import { task, logger, runs } from "@trigger.dev/sdk/v3";
import type { NormalizedPrReviewEvent } from "@/lib/reviews/types";
import { resolveAgentConfig } from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";

export type ContinuousPrReviewPayload = {
  orgId: string;
  automationId: string;
  automationSessionId: string;
  automationRunId: string;
  installationId: number;
  deliveryId: string;
  normalizedEvent: NormalizedPrReviewEvent;
};

export const continuousPrReviewTask = task({
  id: "continuous-pr-review",
  maxDuration: 600, // 10 min max per review cycle

  run: async (payload: ContinuousPrReviewPayload) => {
    const {
      orgId,
      automationId,
      automationSessionId,
      automationRunId,
      installationId,
      normalizedEvent: event,
    } = payload;

    const {
      getAutomationSession,
      updateAutomationSession,
      updateAutomationRun,
      tryAcquireAutomationSessionLock,
      releaseAutomationSessionLock,
      setPendingReviewRequest,
      clearPendingReviewRequest,
    } = await import("@/lib/automations/actions");
    const { findAutomationById } = await import("@/lib/automations/queries");

    // ── 1. Load automation + session ──
    const automation = await findAutomationById(automationId);
    if (!automation) throw new Error(`Automation ${automationId} not found`);

    let automationSession = await getAutomationSession(automationSessionId);
    if (!automationSession) throw new Error(`AutomationSession ${automationSessionId} not found`);

    const config = (automation.prReviewConfig ?? {}) as import("@/lib/reviews/types").PRReviewConfig;
    const sessionMetadata = automationSession.metadata as import("@/lib/reviews/types").AutomationSessionMetadata;

    // ── 2. Acquire lock ──
    const lockAcquired = await tryAcquireAutomationSessionLock({
      automationSessionId,
      runId: automationRunId,
      ttlMs: 10 * 60 * 1000, // 10 min
    });

    if (!lockAcquired) {
      // Queue this request for later
      logger.info("Lock not acquired — queuing review request");
      await setPendingReviewRequest(automationSessionId, {
        reason: event.action as import("@/lib/reviews/types").QueuedReviewRequest["reason"],
        headSha: event.headSha,
        requestedAt: new Date().toISOString(),
        requestedBy: event.senderLogin,
        mode: event.manualCommand?.mode ?? "incremental",
        sinceSha: event.manualCommand?.sinceSha,
        commentId: event.commentId,
        deliveryId: payload.deliveryId,
      });
      await updateAutomationRun(automationRunId, { status: "cancelled", summary: "Queued — lock held by another review" });
      return { ok: true, queued: true };
    }

    try {
      // ── 3. Apply filters ──
      const { shouldReviewPR } = await import("@/lib/reviews/filters");
      const filterResult = shouldReviewPR(event, config);
      if (!filterResult.review) {
        logger.info("Skipped by filters", { reason: filterResult.reason });
        await updateAutomationRun(automationRunId, {
          status: "completed",
          summary: `Skipped: ${filterResult.reason}`,
          completedAt: new Date(),
        });
        return { ok: true, skipped: true, reason: filterResult.reason };
      }

      // ── 4. Create pending GitHub check ──
      const { createPendingCheck, completeCheck, failCheck, postReviewComment, markCommentStale, getReviewOctokit, isAncestor } =
        await import("@/lib/reviews/github");

      let checkRunId: string | undefined;
      try {
        const check = await createPendingCheck({
          installationId,
          owner: event.owner,
          repo: event.repo,
          headSha: event.headSha,
          checkName: config.checkName,
        });
        checkRunId = check.checkRunId;
        await updateAutomationRun(automationRunId, {
          githubCheckRunId: checkRunId,
          status: "running",
          startedAt: new Date(),
        });
      } catch (err) {
        logger.warn("Failed to create check run — continuing without it", {
          error: err instanceof Error ? err.message : String(err),
        });
        await updateAutomationRun(automationRunId, {
          status: "running",
          startedAt: new Date(),
        });
      }

      // ── 5. Fetch diff + guidelines ──
      const octokit = await getReviewOctokit(installationId);
      const { fetchPRDiff, fetchCommitRangeDiff } = await import("@/lib/reviews/diff");
      const { loadRepoGuidelines } = await import("@/lib/reviews/guidelines");
      const { classifyFiles, filterIgnoredPaths } = await import("@/lib/reviews/classification");

      // Determine review scope
      let reviewScope: "full" | "incremental" | "since" | "reset" = "full";
      let fromSha: string | undefined;
      const toSha = event.headSha;

      if (event.manualCommand) {
        reviewScope = event.manualCommand.mode;
        if (event.manualCommand.mode === "since" && event.manualCommand.sinceSha) {
          fromSha = event.manualCommand.sinceSha;
        }
      } else if (sessionMetadata.lastReviewedSha) {
        // Check if lastReviewedSha is still an ancestor (not force-pushed away)
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
        } else {
          // Force push detected — full review with advisory
          reviewScope = "full";
          logger.info("Force push detected — falling back to full review", {
            lastReviewedSha: sessionMetadata.lastReviewedSha,
            headSha: toSha,
          });
        }
      }

      const reviewSequence = (sessionMetadata.reviewCount ?? 0) + 1;

      // Fetch diff
      let diffResult;
      if (reviewScope === "incremental" && fromSha) {
        diffResult = await fetchCommitRangeDiff(
          octokit,
          event.owner,
          event.repo,
          fromSha,
          toSha,
          { maxBytes: config.maxPromptDiffBytes },
        );
      } else {
        diffResult = await fetchPRDiff(
          octokit,
          event.owner,
          event.repo,
          event.prNumber,
          { maxBytes: config.maxPromptDiffBytes, maxFiles: config.maxPromptFiles },
        );
      }

      // Filter ignored paths
      const filteredFiles = filterIgnoredPaths(diffResult.files, config.ignorePaths ?? []);

      // Classify files + load guidelines
      const fileClassifications = classifyFiles(filteredFiles, config);
      const guidelines = await loadRepoGuidelines(
        octokit,
        event.owner,
        event.repo,
        toSha,
        filteredFiles,
        { maxBytes: config.maxGuidelinesBytes },
      );

      // ── 6. Build prompt ──
      const { buildReviewPrompt } = await import("@/lib/reviews/prompt-builder");
      const reviewPrompt = buildReviewPrompt({
        event,
        diff: diffResult.diff,
        diffTruncated: diffResult.truncated,
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

      // Update automation run with scope info
      await updateAutomationRun(automationRunId, {
        reviewSequence,
        reviewScope,
        reviewFromSha: fromSha,
        reviewToSha: toSha,
      });

      // ── 7. Dispatch prompt to interactive session ──
      const { dispatchPromptToSession } = await import("@/lib/sessions/prompt-dispatch");
      const requestId = `review-${automationRunId}`;
      let targetSessionId = automationSession.interactiveSessionId;

      // Handle "reset" — create new interactive session
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

        // Swap the interactive session on the automation session
        const { swapAutomationSessionInteractiveSession } = await import("@/lib/automations/actions");
        await swapAutomationSessionInteractiveSession(automationSessionId, newSession.id);
      }

      // Resolve read-only agent config for code review
      const agentType = (automation.agentType ?? "claude") as AgentType;
      const effortLevel = (automation.modelParams as Record<string, unknown>)?.effortLevel as string | undefined;
      const reviewConfig = resolveAgentConfig({
        agentType,
        modeIntent: "read-only",
        model: automation.model ?? undefined,
        effortLevel,
      });

      const dispatchResult = await dispatchPromptToSession({
        sessionId: targetSessionId,
        orgId,
        prompt: reviewPrompt,
        requestId,
        source: "automation",
        modeOverride: reviewConfig.mode,
        model: reviewConfig.model,
        effortLevel,
      });

      if (dispatchResult.tier === "unavailable") {
        throw new Error(`Dispatch failed: ${dispatchResult.error}`);
      }

      await updateAutomationRun(automationRunId, {
        interactiveSessionId: targetSessionId,
      });

      // ── 8. Wait for turn completion ──
      const turnResult = await waitForTurnCompletion(
        targetSessionId,
        requestId,
        { timeoutMs: 5 * 60 * 1000, pollIntervalMs: 3000 },
      );

      if (turnResult.status !== "completed") {
        const errorMsg = turnResult.error ?? "Turn did not complete successfully";
        logger.error("Turn failed", { requestId, error: errorMsg });

        if (checkRunId) {
          await failCheck({
            installationId,
            owner: event.owner,
            repo: event.repo,
            checkRunId,
            error: errorMsg,
          }).catch(() => {});
        }

        await updateAutomationRun(automationRunId, {
          status: "failed",
          error: errorMsg,
          completedAt: new Date(),
        });

        return { ok: false, error: errorMsg };
      }

      // ── 9. Parse agent output ──
      const { parseReviewOutput } = await import("@/lib/reviews/output-parser");
      const agentOutput = turnResult.output ?? "";
      const parsed = agentOutput ? parseReviewOutput(agentOutput) : null;

      // ── 10. Mark previous comment stale ──
      if (sessionMetadata.lastCommentId) {
        try {
          const { renderStaleComment } = await import("@/lib/reviews/comment-renderer");
          // We don't have the old body, so we'll just mark it with a note
          await markCommentStale({
            installationId,
            owner: event.owner,
            repo: event.repo,
            commentId: sessionMetadata.lastCommentId,
            newBody: renderStaleComment(
              "*(original review content)*",
              reviewSequence,
            ),
          });
        } catch (err) {
          logger.warn("Failed to mark previous comment stale", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // ── 11. Post review comment ──
      let commentId: string | undefined;
      if (parsed) {
        const { renderReviewComment } = await import("@/lib/reviews/comment-renderer");
        const commentBody = renderReviewComment(parsed, reviewSequence);
        const result = await postReviewComment({
          installationId,
          owner: event.owner,
          repo: event.repo,
          prNumber: event.prNumber,
          body: commentBody,
        });
        commentId = result.commentId;
      } else {
        // Unparseable output — post raw with warning
        const result = await postReviewComment({
          installationId,
          owner: event.owner,
          repo: event.repo,
          prNumber: event.prNumber,
          body: `## Polaris Review #${reviewSequence}\n\n${agentOutput.slice(0, 60000) || "(No output captured)"}\n\n<sub>⚠️ Could not parse structured output. Raw review shown above.</sub>`,
        });
        commentId = result.commentId;
      }

      // ── 12. Update state ──
      // Only advance lastReviewedSha if parse succeeded
      const newMetadata: import("@/lib/reviews/types").AutomationSessionMetadata = {
        ...sessionMetadata,
        headSha: toSha,
        reviewCount: reviewSequence,
        lastCommentId: commentId ?? sessionMetadata.lastCommentId,
        lastCompletedRunId: automationRunId,
        ...(parsed
          ? {
              lastReviewedSha: toSha,
              reviewState: parsed.reviewState,
            }
          : {}),
      };

      await updateAutomationSession(automationSessionId, {
        metadata: newMetadata,
      });

      // ── 13. Complete GitHub check ──
      if (checkRunId && parsed) {
        await completeCheck({
          installationId,
          owner: event.owner,
          repo: event.repo,
          checkRunId,
          verdict: parsed.verdict,
          summary: parsed.summary,
        }).catch((err: unknown) => {
          logger.warn("Failed to complete check", {
            error: err instanceof Error ? err.message : String(err),
          });
        });
      } else if (checkRunId) {
        await completeCheck({
          installationId,
          owner: event.owner,
          repo: event.repo,
          checkRunId,
          verdict: "ATTENTION",
          summary: "Review completed but output could not be parsed.",
        }).catch(() => {});
      }

      // ── 14. Complete automation run ──
      await updateAutomationRun(automationRunId, {
        status: "completed",
        summary: parsed?.summary ?? "Review completed",
        verdict: parsed?.verdict,
        severityCounts: parsed?.severityCounts,
        githubCommentId: commentId,
        completedAt: new Date(),
      });

      return {
        ok: true,
        verdict: parsed?.verdict,
        reviewSequence,
        commentId,
      };
    } finally {
      // ── 15. Release lock ──
      await releaseAutomationSessionLock({
        automationSessionId,
        runId: automationRunId,
      });

      // ── 16. Check for pending review request ──
      const pending = await clearPendingReviewRequest(automationSessionId);
      if (pending) {
        logger.info("Processing queued review request", {
          headSha: pending.headSha,
        });
        // Re-trigger ourselves with the pending request
        // This is handled by the router on the next iteration
        // For now, log it — the router will pick it up on next webhook
      }
    }
  },
});

// ── Helpers ──

/**
 * Poll for turn completion via DB.
 * The interactive-session task writes turn results to both DB and Trigger.dev metadata.
 */
async function waitForTurnCompletion(
  sessionId: string,
  requestId: string,
  opts: { timeoutMs: number; pollIntervalMs: number },
): Promise<{ status: string; output?: string; error?: string }> {
  const { getTurnByRequestId } = await import("@/lib/sessions/actions");
  const deadline = Date.now() + opts.timeoutMs;

  while (Date.now() < deadline) {
    const turn = await getTurnByRequestId(requestId, sessionId);

    if (turn?.status === "completed") {
      return {
        status: "completed",
        output: turn.finalMessage ?? undefined,
      };
    }

    if (turn?.status === "failed") {
      return {
        status: "failed",
        error: turn.error ?? "Turn failed",
      };
    }

    // Wait before next poll
    await new Promise((r) => setTimeout(r, opts.pollIntervalMs));
  }

  return { status: "timeout", error: "Turn completion timed out" };
}
