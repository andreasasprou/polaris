import { findGithubInstallationByInstallationId } from "@/lib/integrations/queries";
import { findEnabledAutomationsByTrigger } from "@/lib/automations/queries";
import { createAutomationRun } from "@/lib/automations/actions";
import { claimDelivery } from "./dedupe";
import { matchesGitHubTrigger } from "./matchers";
import type { GitHubTriggerConfig } from "@/lib/automations/types";
import { useLogger } from "@/lib/evlog";

/**
 * Route an incoming GitHub webhook event to matching automations.
 * Returns the number of automations triggered.
 *
 * Dispatches directly to orchestration modules.
 */
export async function routeGitHubEvent(input: {
  installationId: number;
  deliveryId: string;
  eventType: string;
  action?: string;
  ref?: string;
  payload: Record<string, unknown>;
}): Promise<number> {
  const log = useLogger();
  const dedupeKey = `github:${input.deliveryId}`;

  // Look up which org this installation belongs to
  const installation = await findGithubInstallationByInstallationId(input.installationId);
  if (!installation) {
    log.set({ router: { outcome: "no_installation", installationId: input.installationId } });
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
    log.set({ router: { outcome: "duplicate", dedupeKey } });
    return 0;
  }

  // Find matching enabled automations
  const candidates = await findEnabledAutomationsByTrigger(orgId, "github");
  log.set({ router: { orgId, candidates: candidates.length } });

  // Extract webhook repository for filtering
  const webhookRepo = input.payload.repository as { full_name?: string; owner?: { login?: string }; name?: string } | undefined;
  const webhookRepoFullName = webhookRepo?.full_name
    ?? (webhookRepo?.owner?.login && webhookRepo?.name ? `${webhookRepo.owner.login}/${webhookRepo.name}` : null);

  let triggered = 0;

  for (const automation of candidates) {
    const config = automation.triggerConfig as unknown as GitHubTriggerConfig;
    const fullEvent = input.action ? `${input.eventType}.${input.action}` : input.eventType;

    // Filter by repository — only trigger if the automation's repo matches the webhook's repo
    if (!matchesRepository(automation.repoOwner, automation.repoName, webhookRepoFullName)) {
      log.set({ router: { [`skip_${automation.id}`]: `repo mismatch: automation=${automation.repoOwner}/${automation.repoName}, webhook=${webhookRepoFullName}` } });
      continue;
    }

    if (!matchesGitHubTrigger(input.eventType, input.action, input.ref, config)) {
      log.set({ router: { [`skip_${automation.id}`]: `event "${fullEvent}" does not match` } });
      continue;
    }
    log.set({ router: { [`match_${automation.id}`]: `event "${fullEvent}", mode=${automation.mode}` } });

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
        log.error(err instanceof Error ? err : new Error(String(err)));
        log.set({ router: { [`dispatch_failed_${automation.id}`]: true } });
      }
    }
  }

  log.set({ router: { triggered } });
  return triggered;
}

// ── Continuous mode dispatch ──

async function dispatchContinuousReview(
  automation: { id: string; repositoryId: string | null; agentType: string; agentSecretId: string | null; keyPoolId: string | null; mode: string; prReviewConfig?: import("@/lib/reviews/types").PRReviewConfig | null },
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
  const log = useLogger();
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
    log.set({ router: { prNormalization: "failed", eventType: input.eventType, action: input.action } });
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

  log.set({ router: { prNumber: prEvent.prNumber, isOpen: prEvent.isOpen, headSha: prEvent.headSha?.slice(0, 8) } });

  if (!automation.repositoryId) {
    log.set({ router: { outcome: "no_repository" } });
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
    keyPoolId: automation.keyPoolId ?? undefined,
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
  log.set({ router: { scopeKey, sessionCreated: created, sessionId: automationSession.id } });

  log.set({ router: { dispatchingReview: true, prNumber: prEvent.prNumber } });

  // Create run first so we have run.id for the check details URL
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

  // Build run details URL for GitHub check links
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
  const runDetailsUrl = appUrl
    ? `${appUrl.startsWith("http") ? appUrl : `https://${appUrl}`}/runs/${run.id}`
    : undefined;

  // Create GitHub check so it appears on the PR while the task queues
  let checkRunId: string | undefined;
  try {
    const { createPendingCheck } = await import("@/lib/reviews/github");
    const check = await createPendingCheck({
      installationId: input.installationId,
      owner: prEvent.owner,
      repo: prEvent.repo,
      headSha: prEvent.headSha,
      checkName: automation.prReviewConfig?.checkName,
      detailsUrl: runDetailsUrl,
    });
    checkRunId = check.checkRunId;
  } catch (err) {
    log.set({ router: { checkCreationFailed: err instanceof Error ? err.message : String(err) } });
  }

  if (checkRunId) {
    const { updateAutomationRun } = await import("@/lib/automations/actions");
    await updateAutomationRun(run.id, {
      githubCheckRunId: checkRunId,
    });
  }

  try {
    const { dispatchPrReview } = await import("@/lib/orchestration/pr-review");
    const result = await dispatchPrReview({
      orgId,
      automationId: automation.id,
      automationSessionId: automationSession.id,
      automationRunId: run.id,
      installationId: input.installationId,
      deliveryId: input.deliveryId,
      normalizedEvent: prEvent,
      checkRunId,
    });

    // Dispatch deferred to sweeper — check stays pending, don't fail it
    if (result.retryDeferred) {
      console.log(`[router] Dispatch deferred to sweeper for automation ${automation.id}, job ${result.jobId}`);
      return true;
    }
  } catch (err) {
    log.error(err instanceof Error ? err : new Error(String(err)));
    log.set({ router: { dispatchReviewFailed: automation.id, errorDetail: err instanceof Error ? err.message : String(err) } });

    // Mark the eagerly-created run as failed so it doesn't strand
    try {
      const { updateAutomationRun } = await import("@/lib/automations/actions");
      await updateAutomationRun(run.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      });
    } catch { /* best-effort */ }

    // Cancel the eagerly-created check — generic message, detail in logs/run page
    if (checkRunId) {
      try {
        const { failCheck } = await import("@/lib/reviews/github");
        await failCheck({
          installationId: input.installationId,
          owner: prEvent.owner,
          repo: prEvent.repo,
          checkRunId,
          error: "Failed to start review task — see run details for more info.",
          detailsUrl: runDetailsUrl,
        });
      } catch { /* best-effort */ }
    }
    return false;
  }

  return true;
}

// ── Repository matching ──

/**
 * Check if an automation's repository matches the webhook's repository.
 *
 * Returns true only when both sides have a repo AND they match.
 * If the automation has no repo configured, or the webhook has no repo
 * (shouldn't happen for PR/push events), the automation is skipped.
 */
export function matchesRepository(
  automationRepoOwner: string | null,
  automationRepoName: string | null,
  webhookRepoFullName: string | null,
): boolean {
  // Both sides must have repo info — skip if either is missing
  if (!automationRepoOwner || !automationRepoName || !webhookRepoFullName) {
    return false;
  }
  return `${automationRepoOwner}/${automationRepoName}` === webhookRepoFullName;
}
