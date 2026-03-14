import { task, tasks, logger, runs } from "@trigger.dev/sdk/v3";
import type { NormalizedPrReviewEvent } from "@/lib/reviews/types";
import { resolveAgentConfig } from "@/lib/sandbox-agent/agent-profiles";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { createStepTimer } from "@/lib/metrics/step-timer";

export type ContinuousPrReviewPayload = {
  orgId: string;
  automationId: string;
  automationSessionId: string;
  automationRunId: string;
  installationId: number;
  deliveryId: string;
  normalizedEvent: NormalizedPrReviewEvent;
  /** Check run created eagerly by the router for immediate PR visibility. */
  checkRunId?: string;
};

export const continuousPrReviewTask = task({
  id: "continuous-pr-review",
  maxDuration: 1800, // 30 min max per review cycle

  run: async (payload: ContinuousPrReviewPayload) => {
    const {
      orgId,
      automationId,
      automationSessionId,
      automationRunId,
      installationId,
      normalizedEvent: event,
    } = payload;

    const timer = createStepTimer();

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
    const [automation, automationSession] = await timer.time("load_entities", async () => {
      const a = await findAutomationById(automationId);
      if (!a) throw new Error(`Automation ${automationId} not found`);
      const s = await getAutomationSession(automationSessionId);
      if (!s) throw new Error(`AutomationSession ${automationSessionId} not found`);
      return [a, s] as const;
    });

    const config = (automation.prReviewConfig ?? {}) as import("@/lib/reviews/types").PRReviewConfig;
    const sessionMetadata = automationSession.metadata as import("@/lib/reviews/types").AutomationSessionMetadata;

    // Import GitHub helpers early — needed for check cleanup in all exit paths
    const { createPendingCheck, completeCheck, failCheck, postReviewComment, markCommentStale, getReviewOctokit, isAncestor } =
      await import("@/lib/reviews/github");

    let checkRunId: string | undefined = payload.checkRunId;

    /** Cancel the eagerly-created check (skipped/queued). Non-fatal. */
    const cancelCheck = async (summary: string) => {
      if (!checkRunId) return;
      try {
        await completeCheck({
          installationId,
          owner: event.owner,
          repo: event.repo,
          checkRunId,
          verdict: "APPROVE",
          summary,
        });
      } catch (err) {
        logger.warn("Failed to cancel check", { error: err instanceof Error ? err.message : String(err) });
      }
    };

    // ── 2. Acquire lock ──
    const lockAcquired = await timer.time("acquire_lock", () =>
      tryAcquireAutomationSessionLock({
        automationSessionId,
        runId: automationRunId,
        ttlMs: 30 * 60 * 1000, // 30 min
      }),
    );

    if (!lockAcquired) {
      // Queue this request for later
      logger.info("Lock not acquired — queuing review request");
      await cancelCheck("Queued — another review is in progress");
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
      await updateAutomationRun(automationRunId, {
        status: "cancelled",
        summary: "Queued — lock held by another review",
        metrics: timer.finalize(),
      });
      return { ok: true, queued: true };
    }

    try {
      // ── 3. Apply filters ──
      const filterResult = await timer.time("apply_filters", async () => {
        const { shouldReviewPR } = await import("@/lib/reviews/filters");
        return shouldReviewPR(event, config);
      });
      if (!filterResult.review) {
        logger.info("Skipped by filters", { reason: filterResult.reason });
        await cancelCheck(`Skipped: ${filterResult.reason}`);
        await updateAutomationRun(automationRunId, {
          status: "completed",
          summary: `Skipped: ${filterResult.reason}`,
          completedAt: new Date(),
          metrics: timer.finalize(),
        });
        return { ok: true, skipped: true, reason: filterResult.reason };
      }

      // ── 4. Ensure GitHub check exists ──
      // The router creates the check eagerly for immediate PR visibility.
      // Only create here as fallback (e.g. queued re-dispatch, older payloads).
      if (!checkRunId) {
        await timer.time("create_check", async () => {
          try {
            const check = await createPendingCheck({
              installationId,
              owner: event.owner,
              repo: event.repo,
              headSha: event.headSha,
              checkName: config.checkName,
            });
            checkRunId = check.checkRunId;
          } catch (err) {
            logger.warn("Failed to create check run — continuing without it", {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        });
      }

      await updateAutomationRun(automationRunId, {
        ...(checkRunId ? { githubCheckRunId: checkRunId } : {}),
        status: "running",
        startedAt: new Date(),
      });

      // ── 5. Gather metadata (agent explores the code itself) ──
      const { filteredFiles, fileClassifications, guidelines, reviewScope, fromSha, toSha, reviewSequence } =
        await timer.time("gather_metadata", async () => {
          const octokit = await getReviewOctokit(installationId);
          const { fetchPRFileList } = await import("@/lib/reviews/diff");
          const { loadRepoGuidelines } = await import("@/lib/reviews/guidelines");
          const { classifyFiles, filterIgnoredPaths } = await import("@/lib/reviews/classification");

          // Determine review scope
          let scope: "full" | "incremental" | "since" | "reset" = "full";
          let from: string | undefined;
          const to = event.headSha;

          if (event.manualCommand) {
            scope = event.manualCommand.mode;
            if (event.manualCommand.mode === "since" && event.manualCommand.sinceSha) {
              from = event.manualCommand.sinceSha;
            }
          } else if (sessionMetadata.lastReviewedSha) {
            const ancestorCheck = await isAncestor({
              installationId,
              owner: event.owner,
              repo: event.repo,
              baseSha: sessionMetadata.lastReviewedSha,
              headSha: to,
            });

            if (ancestorCheck) {
              scope = "incremental";
              from = sessionMetadata.lastReviewedSha;
            } else {
              scope = "full";
              logger.info("Force push detected — falling back to full review", {
                lastReviewedSha: sessionMetadata.lastReviewedSha,
                headSha: to,
              });
            }
          }

          const seq = (sessionMetadata.reviewCount ?? 0) + 1;

          const [allFiles, guidelines_] = await Promise.all([
            fetchPRFileList(octokit, event.owner, event.repo, event.prNumber, {
              maxFiles: config.maxPromptFiles,
            }),
            loadRepoGuidelines(
              octokit,
              event.owner,
              event.repo,
              to,
              [],
              { maxBytes: config.maxGuidelinesBytes },
            ),
          ]);

          const filtered = filterIgnoredPaths(allFiles, config.ignorePaths ?? []);
          const classifications = classifyFiles(filtered, config);

          return {
            filteredFiles: filtered,
            fileClassifications: classifications,
            guidelines: guidelines_,
            reviewScope: scope,
            fromSha: from,
            toSha: to,
            reviewSequence: seq,
          };
        });

      // ── 6. Build prompt ──
      const reviewPrompt = await timer.time("build_prompt", async () => {
        const { buildReviewPrompt } = await import("@/lib/reviews/prompt-builder");
        return buildReviewPrompt({
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
      });

      // Update automation run with scope info
      await updateAutomationRun(automationRunId, {
        reviewSequence,
        reviewScope,
        reviewFromSha: fromSha,
        reviewToSha: toSha,
      });

      // ── 7. Dispatch prompt to interactive session ──
      const { dispatchResult, targetSessionId } = await timer.time("dispatch_prompt", async () => {
        const { dispatchPromptToSession } = await import("@/lib/sessions/prompt-dispatch");
        const requestId_ = `review-${automationRunId}`;
        let target = automationSession.interactiveSessionId;

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
          target = newSession.id;

          const { swapAutomationSessionInteractiveSession } = await import("@/lib/automations/actions");
          await swapAutomationSessionInteractiveSession(automationSessionId, newSession.id);
        }

        const agentType = (automation.agentType ?? "claude") as AgentType;
        const effortLevel = (automation.modelParams as Record<string, unknown>)?.effortLevel as string | undefined;
        const reviewAgentConfig = resolveAgentConfig({
          agentType,
          modeIntent: "read-only",
          model: automation.model ?? undefined,
          effortLevel,
        });

        const result = await dispatchPromptToSession({
          sessionId: target,
          orgId,
          prompt: reviewPrompt,
          requestId: requestId_,
          source: "automation",
          model: reviewAgentConfig.model,
          effortLevel,
          branch: event.headRef,
        });

        return { dispatchResult: result, targetSessionId: target };
      });

      if (dispatchResult.tier === "unavailable") {
        throw new Error(`Dispatch failed: ${dispatchResult.error}`);
      }

      await updateAutomationRun(automationRunId, {
        interactiveSessionId: targetSessionId,
      });

      timer.setMeta("dispatch_tier", dispatchResult.tier);

      // ── 8. Wait for turn completion ──
      const requestId = `review-${automationRunId}`;
      const waitStart = Date.now();
      const turnResult = await waitForTurnCompletion(
        targetSessionId,
        requestId,
        { timeoutMs: 25 * 60 * 1000, pollIntervalMs: 5000 },
      );
      timer.record("wait_for_turn", Date.now() - waitStart);

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

        timer.setMeta("error", errorMsg);
        await updateAutomationRun(automationRunId, {
          status: "failed",
          error: errorMsg,
          completedAt: new Date(),
          metrics: timer.finalize(),
        });

        return { ok: false, error: errorMsg };
      }

      // ── 9. Parse agent output ──
      const { parsed, agentOutput } = await timer.time("parse_output", async () => {
        const { parseReviewOutput } = await import("@/lib/reviews/output-parser");
        const output = turnResult.output ?? "";
        return {
          parsed: output ? parseReviewOutput(output) : null,
          agentOutput: output,
        };
      });

      // ── 10. Mark previous comment stale ──
      if (sessionMetadata.lastCommentId) {
        await timer.time("mark_stale", async () => {
          try {
            const { renderStaleComment } = await import("@/lib/reviews/comment-renderer");
            await markCommentStale({
              installationId,
              owner: event.owner,
              repo: event.repo,
              commentId: sessionMetadata.lastCommentId!,
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
        });
      }

      // ── 11. Update review state FIRST (survives comment post failure) ──
      const newMetadata: import("@/lib/reviews/types").AutomationSessionMetadata = {
        ...sessionMetadata,
        headSha: toSha,
        reviewCount: reviewSequence,
        lastCompletedRunId: automationRunId,
        ...(parsed
          ? {
              lastReviewedSha: toSha,
              reviewState: parsed.reviewState,
            }
          : {}),
      };

      await timer.time("update_session", async () => {
        await updateAutomationSession(automationSessionId, {
          metadata: newMetadata,
        });
      });

      // ── 12. Post review comment (non-fatal — state already saved) ──
      let commentId: string | undefined;
      try {
        commentId = await timer.time("post_comment", async () => {
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
            return result.commentId;
          }
          // Unparseable output — post raw with warning
          const result = await postReviewComment({
            installationId,
            owner: event.owner,
            repo: event.repo,
            prNumber: event.prNumber,
            body: `## Polaris Review #${reviewSequence}\n\n${agentOutput.slice(0, 60000) || "(No output captured)"}\n\n<sub>⚠️ Could not parse structured output. Raw review shown above.</sub>`,
          });
          return result.commentId;
        });
      } catch (err) {
        logger.error("Failed to post review comment — state already saved", {
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Update comment ID if we got one
      if (commentId) {
        await updateAutomationSession(automationSessionId, {
          metadata: { ...newMetadata, lastCommentId: commentId },
        });
      }

      // ── 13. Complete GitHub check ──
      await timer.time("complete_check", async () => {
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
      });

      // ── 14. Record metrics + complete automation run ──
      timer.count("file_count", filteredFiles.length);
      timer.count("finding_count", parsed?.findings?.length ?? 0);
      timer.setMeta("review_scope", reviewScope);
      timer.setMeta("review_sequence", reviewSequence);
      timer.setMeta("prompt_length", reviewPrompt.length);
      timer.setMeta("verdict", parsed?.verdict ?? null);
      timer.setMeta("agent_output_length", agentOutput.length);

      await updateAutomationRun(automationRunId, {
        status: "completed",
        summary: parsed?.summary ?? "Review completed",
        verdict: parsed?.verdict,
        severityCounts: parsed?.severityCounts,
        githubCommentId: commentId,
        completedAt: new Date(),
        metrics: timer.finalize(),
      });

      return {
        ok: true,
        verdict: parsed?.verdict,
        reviewSequence,
        commentId,
      };
    } finally {
      // ── 15. Clear pending request BEFORE releasing lock (prevents race) ──
      const pending = await clearPendingReviewRequest(automationSessionId);

      // ── 16. Release lock ──
      await releaseAutomationSessionLock({
        automationSessionId,
        runId: automationRunId,
      });

      // ── 17. Dispatch queued review (after lock release so it can acquire) ──
      if (pending) {
        logger.info("Dispatching queued review request", {
          headSha: pending.headSha,
        });
        try {
          const { createAutomationRun } = await import("@/lib/automations/actions");
          const run = await createAutomationRun({
            automationId,
            organizationId: orgId,
            source: "github",
            externalEventId: pending.deliveryId,
            automationSessionId,
            interactiveSessionId: automationSession.interactiveSessionId,
          });
          await tasks.trigger("continuous-pr-review", {
            orgId,
            automationId,
            automationSessionId,
            automationRunId: run.id,
            installationId,
            deliveryId: pending.deliveryId ?? payload.deliveryId,
            normalizedEvent: {
              ...event,
              headSha: pending.headSha,
              action: pending.reason,
              manualCommand: pending.mode !== "incremental"
                ? { mode: pending.mode, sinceSha: pending.sinceSha }
                : undefined,
              commentId: pending.commentId,
            },
          } satisfies ContinuousPrReviewPayload, {
            idempotencyKey: `run:${run.id}`,
          });
        } catch (err) {
          logger.error("Failed to dispatch queued review", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
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
