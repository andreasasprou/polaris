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
  } = await import("@/lib/automations/actions");
  const { parseReviewOutput } = await import("@/lib/reviews/output-parser");
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

  // Read persisted output from the result.
  // Prefer allOutput (full concatenated output) over lastMessage (only final
  // segment after last tool call) — the agent may interleave tool calls with
  // its review writing, splitting the comment across multiple text segments.
  const agentOutput = (result.allOutput as string) || (result.lastMessage as string) || "";

  try {
    // 1. Parse output
    const parsed = agentOutput ? parseReviewOutput(agentOutput) : null;
    const metadata = parsed?.metadata ?? null;

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
          // Comment body IS the agent's output, already stripped of metadata
          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: parsed.commentBody.slice(0, 60000),
          });
          commentId = commentResult.commentId;
        } else {
          // Unparseable — post raw with warning
          const commentResult = await postReviewComment({
            installationId,
            owner,
            repo,
            prNumber,
            body: `## Polaris Review #${reviewSequence}\n\n${agentOutput.slice(0, 60000) || "(No output captured)"}\n\n<sub>Warning: Could not parse review metadata. Raw review shown above.</sub>`,
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

    // 5. Complete GitHub check
    if (checkRunId && !sideEffects.check_completed) {
      const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
      const detailsUrl = automationRunId && appUrl
        ? `${appUrl.startsWith("http") ? appUrl : `https://${appUrl}`}/runs/${automationRunId}`
        : undefined;
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

    // 6. Update automation run
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
    // 7. Release lock + dispatch queued review (always runs)
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

// ── Side Effect Tracking ──

/**
 * Mark a side effect as completed (idempotent updates).
 */
async function markSideEffect(
  jobId: string,
  effectName: string,
): Promise<void> {
  const { db } = await import("@/lib/db");
  const { jobs } = await import("@/lib/jobs/schema");
  const { eq, sql } = await import("drizzle-orm");

  await db
    .update(jobs)
    .set({
      sideEffectsCompleted: sql`COALESCE(${jobs.sideEffectsCompleted}, '{}'::jsonb) || ${JSON.stringify({ [effectName]: true })}::jsonb`,
    })
    .where(eq(jobs.id, jobId));
}
