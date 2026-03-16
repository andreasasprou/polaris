/**
 * Job Post-Processing
 *
 * Dispatches type-specific post-processing after prompt completion.
 * Called by processCallback() when prompt_complete is received.
 *
 * Each side effect is idempotent via sideEffectsCompleted JSONB.
 * On failure, job stays in postprocess_pending for sweeper retry.
 */

import { casJobStatus, getJob } from "./actions";
import type { JobStatus } from "./status";

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
      default:
        console.warn(`[postprocess] Unknown job type: ${job.type}`);
    }

    // CAS to completed
    await casJobStatus(jobId, ["postprocess_pending"], "completed");
  } catch (error) {
    // Leave in postprocess_pending for sweeper retry
    console.error(
      `[postprocess] Failed for job ${jobId}:`,
      error instanceof Error ? error.message : error,
    );
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
  const sideEffects = (job.sideEffectsCompleted ?? {}) as Record<string, boolean>;

  const branchName = payload.branchName as string;
  const baseSha = payload.baseSha as string;
  const baseBranch = payload.baseBranch as string | undefined ?? "main";
  const owner = payload.owner as string;
  const repo = payload.repo as string;
  const title = payload.title as string | undefined ?? "Automated fix";
  const agentType = payload.agentType as string | undefined ?? "agent";
  const allowPush = payload.allowPush !== false;
  const allowPrCreate = payload.allowPrCreate !== false;
  const sandboxId = payload.sandboxId as string | undefined;

  if (!sandboxId || !branchName || !baseSha || !owner || !repo) {
    console.error("[postprocess] Missing required payload for coding task");
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
    console.error(`[postprocess] Sandbox ${sandboxId} not found`);
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

    let prUrl: string | undefined;
    let commitSha: string | undefined;

    // Commit and push (idempotent via sideEffects)
    if (changes.changed && allowPush && !sideEffects.committed) {
      const gitResult = await git.commitAndPush(
        branchName,
        `fix: ${title}`,
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
            title,
            body: `Automated PR by Polaris (${agentType} agent).\n\n${changes.diffSummary}`,
          });
          prUrl = pr.url;
          await markSideEffect(job.id, "pr_created");
        } catch (err) {
          console.error(
            "[postprocess] Failed to create PR:",
            err instanceof Error ? err.message : err,
          );
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
    // Destroy sandbox
    if (!sideEffects.sandbox_destroyed) {
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
    releaseAutomationSessionLock,
    clearPendingReviewRequest,
    createAutomationRun,
  } = await import("@/lib/automations/actions");
  const { parseReviewOutput } = await import("@/lib/reviews/output-parser");
  const { renderReviewComment, renderStaleComment } = await import(
    "@/lib/reviews/comment-renderer"
  );
  const {
    postReviewComment,
    markCommentStale,
    completeCheck,
  } = await import("@/lib/reviews/github");

  const payload = (job.payload ?? {}) as Record<string, unknown>;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const sideEffects = (job.sideEffectsCompleted ?? {}) as Record<string, boolean>;
  const automationRunId = job.automationRunId;
  const automationId = job.automationId;

  const automationSessionId = payload.automationSessionId as string;
  const installationId = payload.installationId as number;
  const owner = payload.owner as string;
  const repo = payload.repo as string;
  const prNumber = payload.prNumber as number;
  const checkRunId = payload.checkRunId as string | undefined;
  const toSha = payload.toSha as string;
  const reviewSequence = (payload.reviewSequence as number) ?? 1;
  const reviewScope = (payload.reviewScope as string) ?? "full";
  const lastCommentId = payload.lastCommentId as string | undefined;
  const orgId = job.organizationId;

  // Read persisted output from the result
  const agentOutput = (result.lastMessage as string) ?? "";

  try {
    // 1. Parse output
    const parsed = agentOutput ? parseReviewOutput(agentOutput) : null;

    // 2. Mark previous comment stale
    if (lastCommentId && !sideEffects.stale_marked) {
      try {
        await markCommentStale({
          installationId,
          owner,
          repo,
          commentId: lastCommentId,
          newBody: renderStaleComment(
            "*(original review content)*",
            reviewSequence,
          ),
        });
        await markSideEffect(job.id, "stale_marked");
      } catch (err) {
        console.warn(
          `[postprocess] Failed to mark comment stale: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 3. Update session metadata (survives comment post failure)
    if (automationSessionId && !sideEffects.session_updated) {
      const { getAutomationSession } = await import(
        "@/lib/automations/actions"
      );
      const session = await getAutomationSession(automationSessionId);
      const sessionMetadata = session?.metadata;

      if (sessionMetadata) {
        const newMetadata: import("@/lib/reviews/types").AutomationSessionMetadata = {
          ...sessionMetadata,
          headSha: toSha,
          reviewCount: reviewSequence,
          lastCompletedRunId: automationRunId ?? null,
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
      }
      await markSideEffect(job.id, "session_updated");
    }

    // 4. Post review comment (non-fatal)
    let commentId: string | undefined;
    if (!sideEffects.comment_posted) {
      try {
        if (parsed) {
          const commentBody = renderReviewComment(parsed, reviewSequence);
          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: commentBody,
          });
          commentId = commentResult.commentId;
        } else {
          // Unparseable — post raw with warning
          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: `## Polaris Review #${reviewSequence}\n\n${agentOutput.slice(0, 60000) || "(No output captured)"}\n\n<sub>Warning: Could not parse structured output. Raw review shown above.</sub>`,
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
        console.error(
          `[postprocess] Failed to post review comment: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 5. Complete GitHub check
    if (checkRunId && !sideEffects.check_completed) {
      try {
        if (parsed) {
          await completeCheck({
            installationId,
            owner,
            repo,
            checkRunId,
            verdict: parsed.verdict,
            summary: parsed.summary,
          });
        } else {
          await completeCheck({
            installationId,
            owner,
            repo,
            checkRunId,
            verdict: "ATTENTION",
            summary: "Review completed but output could not be parsed.",
          });
        }
        await markSideEffect(job.id, "check_completed");
      } catch (err) {
        console.warn(
          `[postprocess] Failed to complete check: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    // 6. Update automation run
    if (automationRunId && !sideEffects.run_updated) {
      await updateAutomationRun(automationRunId, {
        status: "completed",
        summary: parsed?.summary ?? "Review completed",
        verdict: parsed?.verdict,
        severityCounts: parsed?.severityCounts,
        githubCommentId: commentId,
        completedAt: new Date(),
      });
      await markSideEffect(job.id, "run_updated");
    }
  } finally {
    // 7. Release lock + dispatch queued review (always runs)
    if (automationSessionId) {
      const pending = await clearPendingReviewRequest(automationSessionId);

      if (job.id) {
        await releaseAutomationSessionLock({
          automationSessionId,
          jobId: job.id,
        });
      }

      // Dispatch queued review after lock release
      if (pending && automationId) {
        try {
          const { getAutomationSession: getSession } = await import(
            "@/lib/automations/actions"
          );
          const session = await getSession(automationSessionId);

          const run = await createAutomationRun({
            automationId,
            organizationId: orgId,
            source: "github",
            externalEventId: pending.deliveryId,
            automationSessionId,
            interactiveSessionId: session?.interactiveSessionId,
          });

          // Import and call dispatchPrReview directly (no Trigger.dev)
          const { dispatchPrReview } = await import(
            "@/lib/orchestration/pr-review"
          );
          await dispatchPrReview({
            orgId,
            automationId,
            automationSessionId,
            automationRunId: run.id,
            installationId,
            deliveryId: pending.deliveryId ?? "",
            normalizedEvent: {
              ...(payload.normalizedEvent as Record<string, unknown>),
              headSha: pending.headSha,
              action: pending.reason,
            } as never, // Type will be refined when pr-review.ts is created
          });
        } catch (err) {
          console.error(
            `[postprocess] Failed to dispatch queued review: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    }
  }
}

// ── Side Effect Tracking ──

/**
 * Mark a side effect as completed (idempotent updates).
 */
async function markSideEffect(
  jobId: string,
  effectName: string,
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { jobs } = await import("./schema");
  const { eq, sql } = await import("drizzle-orm");

  await db
    .update(jobs)
    .set({
      sideEffectsCompleted: sql`COALESCE(${jobs.sideEffectsCompleted}, '{}'::jsonb) || ${JSON.stringify({ [effectName]: true })}::jsonb`,
    })
    .where(eq(jobs.id, jobId));
}
