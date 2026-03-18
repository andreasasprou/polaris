import { findGithubInstallationByInstallationId } from "@/lib/integrations/queries";
import { findEnabledAutomationsByTrigger } from "@/lib/automations/queries";
import { createAutomationRun } from "@/lib/automations/actions";
import { claimDelivery } from "./dedupe";
import { matchesGitHubTrigger } from "./matchers";
import type { GitHubTriggerConfig } from "@/lib/automations/types";

/**
 * Route an incoming GitHub webhook event to matching automations.
 * Returns the number of automations triggered.
 *
 * v2: Dispatches directly to orchestration modules (no Trigger.dev).
 */
export async function routeGitHubEvent(input: {
  installationId: number;
  deliveryId: string;
  eventType: string;
  action?: string;
  ref?: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const dedupeKey = `github:${input.deliveryId}`;

  // Look up which org this installation belongs to
  const installation = await findGithubInstallationByInstallationId(input.installationId);
  if (!installation) {
    console.log("[router] No installation found for ID:", input.installationId);
    return 0;
  }

  const orgId = installation.organizationId;

  // Atomic dedupe: claim the delivery or bail if already processed
  const claimed = await claimDelivery({
    source: "github",
    externalEventId: input.deliveryId,
    sourceDeliveryId: input.deliveryId,
    dedupeKey,
    organizationId: orgId,
  });
  if (!claimed) {
    console.log("[router] Duplicate delivery, skipping:", dedupeKey);
    return 0;
  }

  // Find matching enabled automations
  const candidates = await findEnabledAutomationsByTrigger(orgId, "github");
  console.log(`[router] Found ${candidates.length} candidate automation(s) for org ${orgId}`);

  // Extract webhook repository for filtering
  const webhookRepo = input.payload.repository as { full_name?: string; owner?: { login?: string }; name?: string } | undefined;
  const webhookRepoFullName = webhookRepo?.full_name
    ?? (webhookRepo?.owner?.login && webhookRepo?.name ? `${webhookRepo.owner.login}/${webhookRepo.name}` : null);

  let triggered = 0;

  for (const automation of candidates) {
    const config = automation.triggerConfig as unknown as GitHubTriggerConfig;
    const fullEvent = input.action ? `${input.eventType}.${input.action}` : input.eventType;

    // Filter by repository — only trigger if the automation's repo matches the webhook's repo
    if (automation.repoOwner && automation.repoName && webhookRepoFullName) {
      const automationRepoFullName = `${automation.repoOwner}/${automation.repoName}`;
      if (automationRepoFullName !== webhookRepoFullName) {
        continue; // Silent skip — not this automation's repo
      }
    }

    if (!matchesGitHubTrigger(input.eventType, input.action, input.ref, config)) {
      console.log(`[router] Automation ${automation.id} (${automation.name}): event "${fullEvent}" does not match config`, config);
      continue;
    }
    console.log(`[router] Automation ${automation.id} (${automation.name}): matched event "${fullEvent}", mode=${automation.mode}`);

    if (automation.mode === "continuous") {
      const dispatched = await dispatchContinuousReview(
        automation,
        orgId,
        input,
        dedupeKey,
      );
      if (dispatched) triggered++;
    } else {
      // Oneshot: dispatch coding task directly
      const run = await createAutomationRun({
        automationId: automation.id,
        organizationId: orgId,
        source: "github",
        externalEventId: input.deliveryId,
        dedupeKey,
        triggerEvent: input.payload,
      });

      try {
        const { dispatchCodingTask } = await import("@/lib/orchestration/coding-task");
        await dispatchCodingTask({
          orgId,
          automationId: automation.id,
          automationRunId: run.id,
          source: "automation" as const,
          triggerEvent: input.payload,
        });
        triggered++;
      } catch (err) {
        console.error(
          `[router] Failed to dispatch coding task for automation ${automation.id}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
  }

  return triggered;
}

// ── Continuous mode dispatch ──

async function dispatchContinuousReview(
  automation: { id: string; repositoryId: string | null; agentType: string; agentSecretId: string | null; mode: string; prReviewConfig?: import("@/lib/reviews/types").PRReviewConfig | null },
  orgId: string,
  input: {
    installationId: number;
    deliveryId: string;
    eventType: string;
    action?: string;
    payload: Record<string, unknown>;
  },
  dedupeKey: string,
): Promise<boolean> {
  const { normalizePREvent } = await import("@/lib/reviews/github-events");
  const {
    findOrCreateAutomationSession,
    updateAutomationSession,
  } = await import("@/lib/automations/actions");

  // Normalize the event
  const prEvent = normalizePREvent(
    input.eventType,
    input.action,
    input.payload,
    input.installationId,
  );
  if (!prEvent) {
    console.log("[router] Could not normalize PR event:", input.eventType, input.action);
    return false;
  }
  // Resolve missing PR data for issue_comment events
  if (!prEvent.headSha || !prEvent.baseSha) {
    const { getPullRequest } = await import("@/lib/reviews/github");
    const pr = await getPullRequest({
      installationId: input.installationId,
      owner: prEvent.owner,
      repo: prEvent.repo,
      prNumber: prEvent.prNumber,
    });
    prEvent.baseRef = pr.base.ref;
    prEvent.baseSha = pr.base.sha;
    prEvent.headRef = pr.head.ref;
    prEvent.headSha = pr.head.sha;
    prEvent.isDraft = pr.draft ?? false;
    prEvent.isOpen = pr.state === "open";
  }

  console.log("[router] Normalized PR event:", { prNumber: prEvent.prNumber, isOpen: prEvent.isOpen, headSha: prEvent.headSha?.slice(0, 8) });

  if (!automation.repositoryId) {
    console.log("[router] Automation has no repository, skipping");
    return false;
  }

  // Scope key: unique per automation + PR
  const scopeKey = `github-pr:${automation.repositoryId}:${prEvent.prNumber}`;

  // PR closed without an existing session — nothing to do
  if (!prEvent.isOpen) {
    const { findAutomationSessionByScope } = await import("@/lib/automations/actions");
    const existing = await findAutomationSessionByScope(automation.id, scopeKey);
    if (!existing) return false;
    await updateAutomationSession(existing.id, {
      status: "closed",
      endedAt: new Date(),
    });
    return false;
  }

  // Find or create automation session (race-safe)
  const { automationSession, created } = await findOrCreateAutomationSession({
    automationId: automation.id,
    organizationId: orgId,
    repositoryId: automation.repositoryId,
    scopeKey,
    agentType: automation.agentType ?? "claude",
    agentSecretId: automation.agentSecretId ?? undefined,
    metadata: {
      repositoryOwner: prEvent.owner,
      repositoryName: prEvent.repo,
      prNumber: prEvent.prNumber,
      baseRef: prEvent.baseRef,
      baseSha: prEvent.baseSha,
      headRef: prEvent.headRef,
      headSha: prEvent.headSha,
      lastReviewedSha: null,
      reviewState: null,
      reviewCount: 0,
      lastCommentId: null,
      lastCheckRunId: null,
      lastCompletedRunId: null,
      pendingReviewRequest: null,
    },
  });
  console.log("[router] Automation session:", { scopeKey, created, sessionId: automationSession.id });

  console.log("[router] Creating automation run + dispatching review for PR", prEvent.prNumber);

  // Create GitHub check immediately so it appears on the PR while the task queues
  let checkRunId: string | undefined;
  try {
    const { createPendingCheck } = await import("@/lib/reviews/github");
    const check = await createPendingCheck({
      installationId: input.installationId,
      owner: prEvent.owner,
      repo: prEvent.repo,
      headSha: prEvent.headSha,
      checkName: automation.prReviewConfig?.checkName,
    });
    checkRunId = check.checkRunId;
  } catch (err) {
    console.log("[router] Failed to create early check run — dispatch will retry:", err instanceof Error ? err.message : String(err));
  }

  // Create run + dispatch directly
  const run = await createAutomationRun({
    automationId: automation.id,
    organizationId: orgId,
    source: "github",
    externalEventId: input.deliveryId,
    dedupeKey,
    triggerEvent: input.payload,
    automationSessionId: automationSession.id,
    interactiveSessionId: automationSession.interactiveSessionId,
  });

  if (checkRunId) {
    const { updateAutomationRun } = await import("@/lib/automations/actions");
    await updateAutomationRun(run.id, {
      githubCheckRunId: checkRunId,
    });
  }

  try {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    await dispatchPrReview({
      orgId,
      automationId: automation.id,
      automationSessionId: automationSession.id,
      automationRunId: run.id,
      installationId: input.installationId,
      deliveryId: input.deliveryId,
      normalizedEvent: prEvent,
      checkRunId,
    });
  } catch (err) {
    console.error(
      `[router] Failed to dispatch PR review for automation ${automation.id}:`,
      err instanceof Error ? err.message : err,
    );
    // Cancel the eagerly-created check
    if (checkRunId) {
      try {
        const { failCheck } = await import("@/lib/reviews/github");
        await failCheck({
          installationId: input.installationId,
          owner: prEvent.owner,
          repo: prEvent.repo,
          checkRunId,
          error: "Failed to start review task",
        });
      } catch { /* best-effort */ }
    }
    return false;
  }

  return true;
}
