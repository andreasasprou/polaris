/**
 * Job Post-Processing
 *
 * Dispatches type-specific post-processing after prompt completion.
 * Called by processCallback() when prompt_complete is received.
 *
 * Each side effect is idempotent via sideEffectsCompleted JSONB.
 * On failure, job stays in postprocess_pending for sweeper retry.
 */

import { casJobStatus, getJob } from "@/lib/jobs/actions";
import type { JobStatus } from "@/lib/jobs/status";
import { useLogger } from "@/lib/evlog";
import type {
  AutomationSessionMetadata,
  TrackedInlineThread,
} from "@/lib/reviews/types";

// ── Main Dispatch ──

/**
 * Run post-processing for a completed job.
 * CAS job agent_completed → postprocess_pending → completed.
 */
export async function runPostProcessing(jobId: string): Promise<void> {
  // CAS to postprocess_pending (prevents duplicate processing)
  const job = await casJobStatus(
    jobId,
    ["agent_completed"],
    "postprocess_pending",
  );
  if (!job) {
    // Already processing or completed — skip
    return;
  }

  try {
    switch (job.type) {
      case "coding_task":
        await postprocessCodingTask(job);
        break;
      case "review":
        await postprocessReview(job);
        break;
      case "prompt":
        // Interactive session prompts have no post-processing
        break;
      default: {
        const log = useLogger();
        log.set({ postprocess: { unknownType: job.type } });
      }
    }

    // CAS to completed
    await casJobStatus(jobId, ["postprocess_pending"], "completed");
  } catch (error) {
    // Leave in postprocess_pending for sweeper retry
    const log = useLogger();
    log.error(error instanceof Error ? error : new Error(String(error)));
    log.set({ postprocess: { failed: jobId } });
    throw error;
  }
}

// ── Coding Task Post-Processing ──

type JobRow = NonNullable<Awaited<ReturnType<typeof getJob>>>;

/**
 * Post-processing for coding tasks:
 * 1. Check for git changes
 * 2. Commit and push
 * 3. Create PR
 * 4. Update automation run
 */
async function postprocessCodingTask(job: JobRow): Promise<void> {
  const {
    updateAutomationRun,
  } = await import("@/lib/automations/actions");
  const { Sandbox } = await import("@vercel/sandbox");
  const { SandboxCommands } = await import("@/lib/sandbox/SandboxCommands");
  const { GitOperations } = await import("@/lib/sandbox/GitOperations");
  const { createPullRequest } = await import("@/lib/integrations/github");

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const automationRunId = job.automationRunId;
  const sideEffects = (job.sideEffectsCompleted ?? {}) as Record<string, unknown>;

  const branchName = payload.branchName as string;
  const baseSha = payload.baseSha as string;
  const baseBranch = payload.baseBranch as string | undefined ?? "main";
  const owner = payload.owner as string;
  const repo = payload.repo as string;
  const title = payload.title as string | undefined ?? "Automated fix";
  const agentType = payload.agentType as string | undefined ?? "agent";
  const allowPush = payload.allowPush !== false;
  const allowPrCreate = payload.allowPrCreate !== false;
  // Resolve sandboxId: prefer session-based lookup, fall back to legacy payload
  const { getInteractiveSession } = await import("@/lib/sessions/actions");
  const sessionRecord = job.sessionId
    ? await getInteractiveSession(job.sessionId)
    : null;
  const sandboxId = sessionRecord?.sandboxId ?? (payload.sandboxId as string | undefined);

  if (!sandboxId || !branchName || !baseSha || !owner || !repo) {
    const log = useLogger();
    log.set({ postprocess: { error: "missing_payload", jobId: job.id } });
    if (automationRunId) {
      await updateAutomationRun(automationRunId, {
        status: "failed",
        error: "Missing required payload for post-processing",
        completedAt: new Date(),
      });
    }
    return;
  }

  let sandbox;

  try {
    sandbox = await Sandbox.get({ sandboxId });
  } catch {
    const log = useLogger();
    log.set({ postprocess: { error: "sandbox_not_found", sandboxId } });
    if (automationRunId) {
      await updateAutomationRun(automationRunId, {
        status: "failed",
        error: "Sandbox no longer available for post-processing",
        completedAt: new Date(),
      });
    }
    return;
  }

  const projectDir = "/vercel/sandbox"; // SandboxManager.PROJECT_DIR
  const commands = new SandboxCommands(sandbox, projectDir);
  const git = new GitOperations(commands);

  try {
    // Ensure we're on the expected branch
    await git.ensureBranch(branchName);

    // Check for changes
    const changes = await git.checkChanges(baseSha);
    const summary = changes.changed
      ? `Agent made changes:\n${changes.diffSummary}`
      : "Agent completed without making changes.";

    // Generate AI commit message and PR title from actual diff
    let commitMessage = `fix: ${title}`;
    let prTitle = title;

    if (job.automationId && changes.changed) {
      try {
        // Use non-allocating resolution to avoid spurious pool rotation.
        // resolveCredentials() uses the allocator which advances LRU state —
        // postprocessing only needs a key for metadata generation, not dispatch.
        const { findAutomationById } = await import("@/lib/automations/queries");
        const { credentialRefFromRow } = await import("@/lib/key-pools/types");
        const { resolveSecretKey } = await import("@/lib/key-pools/resolve");

        const automation = await findAutomationById(job.automationId);
        if (automation) {
          const credRef = credentialRefFromRow({
            agentSecretId: automation.agentSecretId,
            keyPoolId: automation.keyPoolId,
          });

          // For pools, pick any active member without advancing LRU.
          // For single secrets, resolve directly.
          let apiKey: string | undefined;
          let provider: string | undefined;

          if (credRef?.type === "secret") {
            const resolved = await resolveSecretKey(credRef.secretId, automation.organizationId);
            apiKey = resolved.decryptedKey;
            provider = resolved.provider;
          } else if (credRef?.type === "pool") {
            // Read-only: find a usable Anthropic API key (not OAuth) without stamping lastSelectedAt.
            // Iterate members because the first active one may be an OAuth token.
            const { findKeyPoolMembers } = await import("@/lib/key-pools/queries");
            const { decrypt } = await import("@/lib/credentials/encryption");
            const { findSecretByIdAndOrg } = await import("@/lib/secrets/queries");
            const members = await findKeyPoolMembers(credRef.poolId);
            for (const member of members) {
              if (!member.enabled || member.secretRevokedAt) continue;
              const secret = await findSecretByIdAndOrg(member.secretId, automation.organizationId);
              if (!secret || secret.revokedAt) continue;
              const decrypted = decrypt(secret.encryptedValue);
              // Skip OAuth tokens — they can't be used for direct API calls
              if (secret.provider === "anthropic" && decrypted.startsWith("sk-ant-oat")) continue;
              apiKey = decrypted;
              provider = secret.provider;
              break;
            }
          }

          if (apiKey && provider === "anthropic" && !apiKey.startsWith("sk-ant-oat")) {
            const metadataCtx = { apiKey, provider };
            const { generateCommitMessage, generatePrTitle } = await import("./metadata");
            const [cmResult, prResult] = await Promise.allSettled([
              generateCommitMessage(title, changes.diffSummary, changes.filesChanged, metadataCtx),
              generatePrTitle(title, changes.diffSummary, metadataCtx),
            ]);
            if (cmResult.status === "fulfilled") commitMessage = cmResult.value;
            if (prResult.status === "fulfilled") prTitle = prResult.value;
          }
        }
      } catch {
        // Metadata generation is best-effort — fall through to defaults
      }
    }

    let prUrl: string | undefined;
    let commitSha: string | undefined;

    // Commit and push (idempotent via sideEffects)
    if (changes.changed && allowPush && !sideEffects.committed) {
      const gitResult = await git.commitAndPush(
        branchName,
        commitMessage,
        baseSha,
      );
      commitSha = gitResult.commitSha;

      await markSideEffect(job.id, "committed");

      // Create PR
      if (gitResult.pushed && allowPrCreate && !sideEffects.pr_created) {
        try {
          const pr = await createPullRequest({
            owner,
            repo,
            head: branchName,
            base: baseBranch,
            title: prTitle,
            body: `Automated PR by Polaris (${agentType} agent).\n\n${changes.diffSummary}`,
          });
          prUrl = pr.url;
          await markSideEffect(job.id, "pr_created");
        } catch (err) {
          const log = useLogger();
          log.error(err instanceof Error ? err : new Error(String(err)));
          log.set({ postprocess: { prCreationFailed: true } });
        }
      }
    }

    // Update automation run
    if (automationRunId && !sideEffects.run_updated) {
      await updateAutomationRun(automationRunId, {
        status: "succeeded",
        prUrl,
        branchName,
        summary,
        completedAt: new Date(),
      });
      await markSideEffect(job.id, "run_updated");
    }
  } finally {
    // Destroy sandbox + release claim
    if (job.sessionId && !sideEffects.sandbox_destroyed) {
      try {
        const { destroySandbox } = await import("./sandbox-lifecycle");
        await destroySandbox(job.sessionId);
        await markSideEffect(job.id, "sandbox_destroyed");
      } catch {
        // Best-effort — runtime controller will catch it next cycle
      }
      // Release both the job claim and the postprocess finalizer claim
      const { releaseClaimsByClaimant } = await import("@/lib/compute/claims");
      await releaseClaimsByClaimant(job.sessionId, job.id).catch(() => {});
      await releaseClaimsByClaimant(job.sessionId, `postprocess:${job.id}`).catch(() => {});
    } else if (!job.sessionId && !sideEffects.sandbox_destroyed) {
      // Legacy path: jobs created before session migration
      try {
        await sandbox.stop();
        await markSideEffect(job.id, "sandbox_destroyed");
      } catch {
        // Best-effort cleanup
      }
    }
  }
}

// ── PR Review Post-Processing ──

/**
 * Post-processing for PR reviews:
 * 1. Parse agent output from persisted events
 * 2. Mark previous comment stale
 * 3. Update session metadata (state survives failures)
 * 4. Post review comment (non-fatal)
 * 5. Complete GitHub check
 * 6. Update automation run
 * 7. Release lock + dispatch queued review
 */
async function postprocessReview(job: JobRow): Promise<void> {
  const {
    updateAutomationRun,
    updateAutomationSession,
  } = await import("@/lib/automations/actions");
  const { parseReviewOutput } = await import("@/lib/reviews/output-parser");
  const {
    postReviewComment,
    markCommentStale,
    completeCheck,
    postInlineReview,
    dismissReview,
    findInlineReviewIdByMarker,
    fetchTrackedInlineThreadsForReview,
    hydrateTrackedInlineThreadsFromCommentMap,
    replyAndResolveInlineComments,
    resolveTrackedInlineThreads,
    getReviewOctokit,
  } = await import("@/lib/reviews/github");
  const {
    extractInlineAnchors,
    buildReviewComments,
    buildIssueSeverityMap,
  } = await import("@/lib/reviews/inline-comments");
  const {
    normalizeActiveInlineReviewIds,
    buildInlineReviewTrackingState,
  } = await import("@/lib/reviews/inline-review-state");
  const {
    formatReviewHeading,
    formatReviewLabel,
  } = await import("@/lib/reviews/formatting");
  const {
    reconcileInlineThreads,
    dedupeTrackedInlineThreads,
    buildInlineCommentMapFromTrackedThreads,
  } = await import("@/lib/reviews/inline-thread-reconciliation");
  const {
    fetchFullCommitRangeDiff,
    buildChangedLineIndex,
  } = await import("@/lib/reviews/diff");

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const sideEffects = (job.sideEffectsCompleted ?? {}) as Record<string, unknown>;
  const automationRunId = job.automationRunId;
  const automationId = job.automationId;

  const automationSessionId = payload.automationSessionId as string;
  const installationId = payload.installationId as number;
  const owner = payload.owner as string;
  const repo = payload.repo as string;
  const prNumber = payload.prNumber as number;
  const checkRunId = payload.checkRunId as string | undefined;
  const fromSha = payload.fromSha as string | undefined;
  const canAutoReconcileInlineThreads = payload.canAutoReconcileInlineThreads === true;
  const toSha = payload.toSha as string;
  const reviewSequence = (payload.reviewSequence as number) ?? 1;
  const reviewScope = (payload.reviewScope as string) ?? "full";
  const lastCommentId = payload.lastCommentId as string | undefined;
  const orgId = job.organizationId;
  let activeInlineReviewIds: number[] = [];

  // Read persisted output from the result.
  // Prefer allOutput (full concatenated output) over lastMessage (only final
  // segment after last tool call) — the agent may interleave tool calls with
  // its review writing, splitting the comment across multiple text segments.
  const allOutput = typeof result.allOutput === "string" ? result.allOutput : "";
  const lastMessage = typeof result.lastMessage === "string" ? result.lastMessage : "";
  const agentOutput = allOutput || lastMessage;

  try {
    // 1. Parse output
    const parsed = agentOutput ? parseReviewOutput(agentOutput) : null;
    const metadata = parsed?.metadata ?? null;
    const anchors = parsed ? extractInlineAnchors(parsed.metadata) : [];
    let trackedInlineThreadsForMetadata: TrackedInlineThread[] | null = null;
    let legacyInlineCommentMapForMetadata: Record<string, number> | null = null;

    // 2. Mark previous comment stale
    if (lastCommentId && !sideEffects.stale_marked) {
      try {
        await markCommentStale({
          installationId,
          owner,
          repo,
          commentId: lastCommentId,
          supersededBySequence: reviewSequence,
        });
        await markSideEffect(job.id, "stale_marked");
      } catch (err) {
        const log = useLogger();
        log.set({ postprocess: { staleMarkFailed: err instanceof Error ? err.message : String(err) } });
      }
    }

    // 2b. Dismiss previous inline review (best-effort)
    //
    // Load activeInlineReviewIds BEFORE the dismissal try/catch so that
    // even if dismissal fails, step 3 has the correct pre-existing IDs
    // and won't overwrite them with []. If the session load itself fails,
    // it propagates to the outer catch — step 3 can't persist either.
    if (automationSessionId && !sideEffects.inline_review_dismissed) {
      const { getAutomationSession: getSessionForDismiss } = await import(
        "@/lib/automations/actions"
      );
      const sessionForDismiss = await getSessionForDismiss(automationSessionId);
      activeInlineReviewIds = normalizeActiveInlineReviewIds(
        sessionForDismiss?.metadata ?? {},
      );

      try {
        const remainingInlineReviewIds: number[] = [];

        for (const reviewId of activeInlineReviewIds) {
          const dismissed = await dismissReview({
            installationId,
            owner,
            repo,
            prNumber,
            reviewId,
            message: `Superseded by ${formatReviewLabel(reviewSequence)}`,
          });

          if (!dismissed) {
            remainingInlineReviewIds.push(reviewId);
          }
        }

        activeInlineReviewIds = remainingInlineReviewIds;
        await markSideEffect(job.id, "inline_review_dismissed");
      } catch {
        // Best-effort — COMMENT reviews may not be dismissible.
        // activeInlineReviewIds retains the pre-dismissal list so step 3
        // preserves existing tracked IDs instead of wiping them.
      }
    } else if (automationSessionId) {
      const { getAutomationSession: getSessionForInlineState } = await import(
        "@/lib/automations/actions"
      );
      const sessionForInlineState = await getSessionForInlineState(automationSessionId);
      activeInlineReviewIds = normalizeActiveInlineReviewIds(
        sessionForInlineState?.metadata ?? {},
      );
    }

    // 2c. Reply to resolved inline comments + auto-resolve tracked threads
    if (parsed && automationSessionId) {
      try {
        const { getAutomationSession: getSessionForResolve } = await import(
          "@/lib/automations/actions"
        );
        const sessionForResolve = await getSessionForResolve(automationSessionId);
        const sessionMetadata = sessionForResolve?.metadata as AutomationSessionMetadata | undefined;
        const prevCommentMap = sessionMetadata?.inlineCommentMap ?? {};
        let trackedThreads = dedupeTrackedInlineThreads(sessionMetadata?.inlineThreads ?? []);
        let remainingLegacyCommentMap = { ...prevCommentMap };

        if (trackedThreads.length === 0 && Object.keys(prevCommentMap).length > 0) {
          trackedThreads = dedupeTrackedInlineThreads(await hydrateTrackedInlineThreadsFromCommentMap({
            installationId,
            owner,
            repo,
            prNumber,
            inlineCommentMap: prevCommentMap,
          }));
        }

        const resolutionSummaryByIssueId = new Map(
          (metadata?.reviewState?.resolvedIssues ?? []).map((issue) => [issue.id, issue.summary]),
        );
        const explicitlyResolvedIssueIds = new Set(metadata?.resolvedIssueIds ?? []);

        let repliedCount = 0;
        let resolvedCount = 0;

        const trackedThreadsForExplicitResolve = trackedThreads.filter((thread) =>
          explicitlyResolvedIssueIds.has(thread.issueId),
        );
        if (trackedThreadsForExplicitResolve.length > 0) {
          const trackedResolveResult = await resolveTrackedInlineThreads({
            installationId,
            owner,
            repo,
            prNumber,
            headSha: toSha,
            threads: trackedThreadsForExplicitResolve.map((thread) => ({
              ...thread,
              resolution: resolutionSummaryByIssueId.get(thread.issueId) ?? "Fixed",
            })),
          });

          repliedCount += trackedResolveResult.repliedCount;
          resolvedCount += trackedResolveResult.resolvedCount;

          const resolvedTrackedThreadIds = new Set(trackedResolveResult.resolvedThreadIds);
          const resolvedTrackedIssueIds = new Set(
            trackedThreadsForExplicitResolve
              .filter((thread) => resolvedTrackedThreadIds.has(thread.threadId))
              .map((thread) => thread.issueId),
          );

          trackedThreads = trackedThreads.filter((thread) => !resolvedTrackedThreadIds.has(thread.threadId));
          for (const issueId of resolvedTrackedIssueIds) {
            delete remainingLegacyCommentMap[issueId];
          }
        }

        const trackedIssueIds = new Set(trackedThreads.map((thread) => thread.issueId));
        const legacyResolvedIssues = (metadata?.reviewState?.resolvedIssues ?? []).filter((issue) =>
          explicitlyResolvedIssueIds.has(issue.id) &&
          Boolean(remainingLegacyCommentMap[issue.id]) &&
          !trackedIssueIds.has(issue.id),
        );

        if (legacyResolvedIssues.length > 0) {
          const legacyResolveResult = await replyAndResolveInlineComments({
            installationId,
            owner,
            repo,
            prNumber,
            headSha: toSha,
            resolvedIssues: legacyResolvedIssues.map((issue) => ({
              id: issue.id,
              resolution: issue.summary,
            })),
            inlineCommentMap: remainingLegacyCommentMap,
          });

          repliedCount += legacyResolveResult.repliedCount;
          resolvedCount += legacyResolveResult.resolvedCount;
          for (const issueId of legacyResolveResult.resolvedIssueIds) {
            delete remainingLegacyCommentMap[issueId];
          }
        }

        if (
          (reviewScope === "incremental" || reviewScope === "since") &&
          fromSha &&
          canAutoReconcileInlineThreads &&
          trackedThreads.length > 0
        ) {
          try {
            const octokit = await getReviewOctokit(installationId);
            const fullDiff = await fetchFullCommitRangeDiff(
              octokit,
              owner,
              repo,
              fromSha,
              toSha,
            );
            const changedLineIndex = buildChangedLineIndex(fullDiff);
            const reconciliation = reconcileInlineThreads({
              priorThreads: trackedThreads,
              changedLineIndex,
              currentInlineAnchors: anchors,
            });

            const autoResolveResult = await resolveTrackedInlineThreads({
              installationId,
              owner,
              repo,
              prNumber,
              headSha: toSha,
              threads: reconciliation.autoResolve.map((thread) => ({
                ...thread,
                resolution: "Resolved by follow-up changes in this commit range.",
              })),
            });

            repliedCount += autoResolveResult.repliedCount;
            resolvedCount += autoResolveResult.resolvedCount;

            const resolvedThreadIds = new Set(autoResolveResult.resolvedThreadIds);
            const resolvedIssueIds = new Set(
              reconciliation.autoResolve
                .filter((thread) => resolvedThreadIds.has(thread.threadId))
                .map((thread) => thread.issueId),
            );

            trackedThreads = dedupeTrackedInlineThreads([
              ...reconciliation.carryForward,
              ...reconciliation.overlapBlocked,
              ...reconciliation.autoResolve.filter((thread) => !resolvedThreadIds.has(thread.threadId)),
            ]);
            for (const issueId of resolvedIssueIds) {
              delete remainingLegacyCommentMap[issueId];
            }
          } catch (err) {
            const log = useLogger();
            log.set({
              postprocess: {
                inlineReconcileSkipped: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }

        trackedInlineThreadsForMetadata = dedupeTrackedInlineThreads(trackedThreads);
        legacyInlineCommentMapForMetadata = remainingLegacyCommentMap;

        if (repliedCount > 0 || resolvedCount > 0) {
          const log = useLogger();
          log.set({ postprocess: { inlineReplied: repliedCount, threadsResolved: resolvedCount } });
        }
      } catch {
        // Non-fatal — inline resolution is a UX enhancement
      }

      if (!sideEffects.inline_resolved) {
        await markSideEffect(job.id, "inline_resolved");
      }
    }

    // 3. Update session metadata (survives comment post failure)
    if (automationSessionId && !sideEffects.session_updated) {
      const { getAutomationSession } = await import(
        "@/lib/automations/actions"
      );
      const session = await getAutomationSession(automationSessionId);
      const sessionMetadata = session?.metadata as AutomationSessionMetadata | undefined;

      if (sessionMetadata) {
        const nextInlineThreads = trackedInlineThreadsForMetadata ?? sessionMetadata.inlineThreads ?? null;
        const nextInlineCommentMap = trackedInlineThreadsForMetadata
          ? mergeInlineCommentMapWithTrackedThreads(
              legacyInlineCommentMapForMetadata ?? {},
              trackedInlineThreadsForMetadata,
              buildInlineCommentMapFromTrackedThreads,
            )
          : sessionMetadata.inlineCommentMap ?? null;

        const newMetadata: AutomationSessionMetadata = {
          ...sessionMetadata,
          headSha: toSha,
          reviewCount: reviewSequence,
          lastCompletedRunId: automationRunId ?? null,
          ...buildInlineReviewTrackingState(activeInlineReviewIds),
          inlineThreads: nextInlineThreads,
          inlineCommentMap: nextInlineCommentMap,
          ...(parsed
            ? {
                lastReviewedSha: toSha,
                reviewState: metadata!.reviewState,
              }
            : {}),
        };

        await updateAutomationSession(automationSessionId, {
          metadata: newMetadata,
        });
      }
      await markSideEffect(job.id, "session_updated");
    }

    // 4. Post review comment (non-fatal)
    let commentId: string | undefined;
    if (!sideEffects.comment_posted) {
      try {
        if (parsed) {
          // Comment body IS the agent's output, already stripped of metadata.
          // Append collapsible pipeline latency section from proxy metrics.
          const latencySection = formatLatencySection(result);
          const fullBody = latencySection
            ? `${parsed.commentBody}\n\n${latencySection}`
            : parsed.commentBody;

          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: fullBody.slice(0, 60000),
          });
          commentId = commentResult.commentId;
        } else {
          // Unparseable — post raw with warning
          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: `${formatReviewHeading(reviewSequence, "ATTENTION")}\n\n${agentOutput.slice(0, 60000) || "(No output captured)"}\n\n<sub>Warning: Could not parse review metadata. Raw review shown above.</sub>`,
          });
          commentId = commentResult.commentId;
        }
        await markSideEffect(job.id, "comment_posted");

        // Update comment ID on session
        if (commentId && automationSessionId) {
          const { getAutomationSession: getSession } = await import(
            "@/lib/automations/actions"
          );
          const session = await getSession(automationSessionId);
          if (session?.metadata) {
            await updateAutomationSession(automationSessionId, {
              metadata: { ...session.metadata, lastCommentId: commentId },
            });
          }
        }
      } catch (err) {
        const log = useLogger();
        log.error(err instanceof Error ? err : new Error(String(err)));
        log.set({ postprocess: { commentPostFailed: true } });
      }
    }

    // 5. Post inline review (best-effort, after summary comment)
    if (parsed && (sideEffects.inline_review_posted !== true || sideEffects.inline_review_tracked !== true)) {
      try {
        if (anchors.length > 0) {
          const issueSeverityById = buildIssueSeverityMap(
            parsed.metadata.reviewState.openIssues,
          );
          const comments = buildReviewComments(anchors, issueSeverityById);
          if (comments.length === 0) {
            await markSideEffects(job.id, {
              inline_review_posted: true,
              inline_review_tracked: true,
            });
          } else {
            const inlineReviewMarker = buildInlineReviewMarker(job.id);
            let inlineReviewId = readInlineReviewId(sideEffects);

            if (!inlineReviewId) {
              inlineReviewId = await findInlineReviewIdByMarker({
                installationId,
                owner,
                repo,
                prNumber,
                headSha: toSha,
                marker: inlineReviewMarker,
              });
            }

            if (!inlineReviewId) {
              const inlineResult = await postInlineReview({
                installationId,
                owner,
                repo,
                prNumber,
                headSha: toSha,
                body: buildInlineReviewSummaryBody(
                  formatReviewLabel(reviewSequence),
                  inlineReviewMarker,
                ),
                comments,
              });
              inlineReviewId = inlineResult?.reviewId ?? null;
            }

            if (inlineReviewId) {
              await markSideEffects(job.id, {
                inline_review_posted: true,
                inline_review_review_id: inlineReviewId,
              });

              if (!automationSessionId) {
                await markSideEffects(job.id, {
                  inline_review_tracked: true,
                });
              } else if (sideEffects.inline_review_tracked !== true) {
                activeInlineReviewIds = normalizeActiveInlineReviewIds({
                  activeInlineReviewIds: [
                    ...activeInlineReviewIds,
                    inlineReviewId,
                  ],
                });

                const { threads: newTrackedThreads, commentMap: newCommentMap } = await fetchTrackedInlineThreadsForReview({
                  installationId,
                  owner,
                  repo,
                  prNumber,
                  reviewId: inlineReviewId,
                  reviewSequence,
                  inlineAnchors: anchors,
                });

                const { getAutomationSession: getSessionForInline } = await import(
                  "@/lib/automations/actions"
                );
                const sessionForInline = await getSessionForInline(automationSessionId);
                if (!sessionForInline?.metadata) {
                  throw new Error(`Automation session metadata missing for inline review tracking: ${automationSessionId}`);
                }

                const metadataForInline = sessionForInline.metadata as AutomationSessionMetadata;
                const prevMap = metadataForInline.inlineCommentMap ?? {};
                const mergedTrackedThreads = dedupeTrackedInlineThreads([
                  ...(metadataForInline.inlineThreads ?? []),
                  ...newTrackedThreads,
                ]);
                await updateAutomationSession(automationSessionId, {
                  metadata: {
                    ...metadataForInline,
                    ...buildInlineReviewTrackingState(activeInlineReviewIds),
                    inlineThreads: mergedTrackedThreads,
                    inlineCommentMap: mergeInlineCommentMapWithTrackedThreads(
                      Object.keys(newCommentMap).length > 0
                        ? { ...prevMap, ...newCommentMap }
                        : prevMap,
                      mergedTrackedThreads,
                      buildInlineCommentMapFromTrackedThreads,
                    ),
                  },
                });
                await markSideEffects(job.id, {
                  inline_review_tracked: true,
                });
              }
            }
          }
        }
      } catch (err) {
        const log = useLogger();
        log.set({
          postprocess: {
            inlineReviewTrackingFailed: err instanceof Error ? err.message : String(err),
          },
        });
      }
    }

    // 6. Complete GitHub check
    if (checkRunId && !sideEffects.check_completed) {
      let detailsUrl: string | undefined;
      if (automationRunId) {
        try {
          const { getOrgSlugById } = await import("@/lib/auth/session");
          const { runUrl } = await import("@/lib/config/urls");
          const slug = await getOrgSlugById(orgId);
          detailsUrl = runUrl(automationRunId, slug);
        } catch {
          const { runUrl } = await import("@/lib/config/urls");
          detailsUrl = runUrl(automationRunId);
        }
      }
      try {
        if (parsed) {
          await completeCheck({
            installationId,
            owner,
            repo,
            checkRunId,
            verdict: metadata!.verdict,
            summary: metadata!.summary,
            detailsUrl,
          });
        } else {
          await completeCheck({
            installationId,
            owner,
            repo,
            checkRunId,
            verdict: "ATTENTION",
            summary: "Review completed but output could not be parsed.",
            detailsUrl,
          });
        }
        await markSideEffect(job.id, "check_completed");
      } catch (err) {
        const log = useLogger();
        log.set({ postprocess: { checkCompleteFailed: err instanceof Error ? err.message : String(err) } });
      }
    }

    // 7. Update automation run
    if (automationRunId && !sideEffects.run_updated) {
      await updateAutomationRun(automationRunId, {
        status: "completed",
        summary: metadata?.summary ?? "Review completed",
        verdict: metadata?.verdict,
        severityCounts: metadata?.severityCounts,
        githubCommentId: commentId,
        completedAt: new Date(),
      });
      await markSideEffect(job.id, "run_updated");
    }
  } finally {
    // 8. Destroy sandbox — review postprocess doesn't need the VM
    // (all data is already persisted platform-side via callbacks).
    if (job.sessionId && !sideEffects.sandbox_destroyed) {
      try {
        const { destroySandbox } = await import("./sandbox-lifecycle");
        await destroySandbox(job.sessionId);
        await markSideEffect(job.id, "sandbox_destroyed");
      } catch {
        // Best-effort — runtime controller will catch it next cycle
      }
    }

    // 9. Release lock + dispatch queued review (always runs)
    if (automationSessionId) {
      const { finalizeReviewRun } = await import(
        "./review-lifecycle"
      );
      await finalizeReviewRun({
        automationSessionId,
        automationRunId: automationRunId ?? job.id,
        orgId,
        automationId,
        installationId,
        normalizedEvent: payload.normalizedEvent as Record<string, unknown>,
      });
    }
  }
}

function mergeInlineCommentMapWithTrackedThreads(
  legacyMap: Record<string, number>,
  trackedThreads: TrackedInlineThread[],
  buildInlineCommentMapFromTrackedThreads: (threads: TrackedInlineThread[]) => Record<string, number>,
) {
  const trackedMap = buildInlineCommentMapFromTrackedThreads(trackedThreads);
  const mergedLegacyEntries = Object.fromEntries(
    Object.entries(legacyMap).filter(([issueId]) => trackedMap[issueId] == null),
  );

  return {
    ...mergedLegacyEntries,
    ...trackedMap,
  };
}

function buildInlineReviewMarker(jobId: string) {
  return `polaris-inline-review:${jobId}`;
}

function buildInlineReviewSummaryBody(
  reviewLabel: string,
  marker: string,
) {
  return `See ${reviewLabel} above for the full summary.\n\n<!-- ${marker} -->`;
}

function readInlineReviewId(
  sideEffects: Record<string, unknown>,
) {
  const reviewId = sideEffects.inline_review_review_id;
  return typeof reviewId === "number" && Number.isInteger(reviewId) && reviewId > 0
    ? reviewId
    : null;
}

// ── Side Effect Tracking ──

/**
 * Mark a side effect as completed (idempotent updates).
 */
async function markSideEffect(
  jobId: string,
  effectName: string,
): Promise<void> {
  await markSideEffects(jobId, { [effectName]: true });
}

async function markSideEffects(
  jobId: string,
  effects: Record<string, unknown>,
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { jobs } = await import("@/lib/jobs/schema");
  const { eq, sql } = await import("drizzle-orm");

  await db
    .update(jobs)
    .set({
      sideEffectsCompleted: sql`COALESCE(${jobs.sideEffectsCompleted}, '{}'::jsonb) || ${JSON.stringify(effects)}::jsonb`,
    })
    .where(eq(jobs.id, jobId));
}

// ── Pipeline latency formatting ──

function fmtMs(ms: number | undefined): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Build a collapsible GitHub markdown section showing pipeline latency
 * breakdown from proxy metrics stored in the job result.
 */
function formatLatencySection(result: Record<string, unknown>): string | null {
  const metrics = result.proxyMetrics as Record<string, unknown> | undefined;
  if (!metrics) return null;

  const connectMs = typeof metrics.connectMs === "number" ? metrics.connectMs : undefined;
  const sessionCreateMs = typeof metrics.sessionCreateMs === "number" ? metrics.sessionCreateMs : undefined;
  const promptExecutionMs = typeof metrics.promptExecutionMs === "number" ? metrics.promptExecutionMs : undefined;
  const totalMs = typeof metrics.totalMs === "number" ? metrics.totalMs : undefined;
  const resumeType = typeof metrics.resumeType === "string" ? metrics.resumeType : undefined;
  const eventCount = typeof metrics.eventCount === "number" ? metrics.eventCount : undefined;

  const lines: string[] = [];

  if (connectMs != null) lines.push(`| Agent connect | ${fmtMs(connectMs)} |`);
  if (sessionCreateMs != null) {
    const label = resumeType && resumeType !== "fresh"
      ? `Session resume (${resumeType})`
      : "Session create";
    lines.push(`| ${label} | ${fmtMs(sessionCreateMs)} |`);
  }
  if (promptExecutionMs != null) lines.push(`| Prompt execution | ${fmtMs(promptExecutionMs)} |`);
  if (totalMs != null) lines.push(`| **Total** | **${fmtMs(totalMs)}** |`);

  if (lines.length === 0) return null;

  const extras: string[] = [];
  if (eventCount != null) extras.push(`${eventCount} events`);
  if (resumeType) extras.push(`resume: ${resumeType}`);

  return [
    `<details>`,
    `<summary>Pipeline latency</summary>`,
    ``,
    `| Step | Duration |`,
    `|------|----------|`,
    ...lines,
    ...(extras.length > 0 ? [``, extras.join(" · ")] : []),
    `</details>`,
  ].join("\n");
}
