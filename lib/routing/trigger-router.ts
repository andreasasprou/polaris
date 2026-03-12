import { findGithubInstallationByInstallationId } from "@/lib/integrations/queries";
import { findEnabledAutomationsByTrigger } from "@/lib/automations/queries";
import { createAutomationRun } from "@/lib/automations/actions";
import { isDuplicate, recordDelivery } from "./dedupe";
import { matchesGitHubTrigger } from "./matchers";
import type { GitHubTriggerConfig } from "@/lib/automations/types";
import { tasks } from "@trigger.dev/sdk/v3";

/**
 * Route an incoming GitHub webhook event to matching automations.
 * Returns the number of automations triggered.
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

  // Check for duplicate delivery
  if (await isDuplicate(dedupeKey)) {
    console.log("[router] Duplicate delivery, skipping:", dedupeKey);
    return 0;
  }

  // Look up which org this installation belongs to
  const installation = await findGithubInstallationByInstallationId(input.installationId);
  if (!installation) {
    console.log("[router] No installation found for ID:", input.installationId);
    return 0;
  }

  const orgId = installation.organizationId;

  // Find matching enabled automations
  const candidates = await findEnabledAutomationsByTrigger(orgId, "github");
  console.log(`[router] Found ${candidates.length} candidate automation(s) for org ${orgId}`);

  let triggered = 0;

  for (const automation of candidates) {
    const config = automation.triggerConfig as unknown as GitHubTriggerConfig;
    const fullEvent = input.action ? `${input.eventType}.${input.action}` : input.eventType;
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
      // Oneshot: existing coding-task dispatch
      const run = await createAutomationRun({
        automationId: automation.id,
        organizationId: orgId,
        source: "github",
        externalEventId: input.deliveryId,
        dedupeKey,
        triggerEvent: input.payload,
      });

      const handle = await tasks.trigger("coding-task", {
        orgId,
        automationId: automation.id,
        automationRunId: run.id,
        source: "automation" as const,
        triggerEvent: input.payload,
      }, {
        idempotencyKey: `run:${run.id}`,
      });

      if (handle.id) {
        const { updateAutomationRun } = await import("@/lib/automations/actions");
        await updateAutomationRun(run.id, { triggerRunId: handle.id });
      }

      triggered++;
    }
  }

  // Record the delivery for deduplication
  await recordDelivery({
    source: "github",
    externalEventId: input.deliveryId,
    sourceDeliveryId: input.deliveryId,
    dedupeKey,
    organizationId: orgId,
  });

  return triggered;
}

// ── Continuous mode dispatch ──

async function dispatchContinuousReview(
  automation: { id: string; repositoryId: string | null; agentType: string; agentSecretId: string | null; mode: string },
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
    createAutomationSession,
    findAutomationSessionByScope,
    updateAutomationSession,
  } = await import("@/lib/automations/actions");
  const { createInteractiveSession } = await import("@/lib/sessions/actions");

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
  console.log("[router] Normalized PR event:", { prNumber: prEvent.prNumber, isOpen: prEvent.isOpen, headSha: prEvent.headSha?.slice(0, 8) });

  if (!automation.repositoryId) {
    console.log("[router] Automation has no repository, skipping");
    return false;
  }

  // Scope key: unique per automation + PR
  const scopeKey = `github-pr:${automation.repositoryId}:${prEvent.prNumber}`;

  // Find or create automation session
  let automationSession = await findAutomationSessionByScope(automation.id, scopeKey);
  console.log("[router] Automation session lookup:", { scopeKey, found: !!automationSession, sessionId: automationSession?.id });

  if (!automationSession) {
    // PR closed without an existing session — nothing to do
    if (!prEvent.isOpen) return false;

    // Create a new interactive session for this PR
    const interactiveSession = await createInteractiveSession({
      organizationId: orgId,
      createdBy: "automation",
      agentType: automation.agentType ?? "claude",
      agentSecretId: automation.agentSecretId ?? undefined,
      repositoryId: automation.repositoryId,
      prompt: "(initial PR review — prompt will be sent by orchestrator)",
    });

    automationSession = await createAutomationSession({
      automationId: automation.id,
      interactiveSessionId: interactiveSession.id,
      organizationId: orgId,
      repositoryId: automation.repositoryId,
      scopeKey,
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
  }

  // Handle PR closed/merged
  if (!prEvent.isOpen) {
    await updateAutomationSession(automationSession.id, {
      status: "closed",
      endedAt: new Date(),
    });
    return false;
  }

  console.log("[router] Creating automation run + triggering task for PR", prEvent.prNumber);

  // Create run + dispatch
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

  const handle = await tasks.trigger("continuous-pr-review", {
    orgId,
    automationId: automation.id,
    automationSessionId: automationSession.id,
    automationRunId: run.id,
    installationId: input.installationId,
    deliveryId: input.deliveryId,
    normalizedEvent: prEvent,
  }, {
    idempotencyKey: `run:${run.id}`,
  });

  if (handle.id) {
    const { updateAutomationRun } = await import("@/lib/automations/actions");
    await updateAutomationRun(run.id, { triggerRunId: handle.id });
  }

  return true;
}
