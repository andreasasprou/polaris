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
    return 0;
  }

  // Look up which org this installation belongs to
  const installation = await findGithubInstallationByInstallationId(input.installationId);
  if (!installation) return 0;

  const orgId = installation.organizationId;

  // Find matching enabled automations
  const candidates = await findEnabledAutomationsByTrigger(orgId, "github");

  let triggered = 0;

  for (const automation of candidates) {
    const config = automation.triggerConfig as unknown as GitHubTriggerConfig;
    if (!matchesGitHubTrigger(input.eventType, input.action, input.ref, config)) {
      continue;
    }

    // Create a run record
    const run = await createAutomationRun({
      automationId: automation.id,
      organizationId: orgId,
      source: "github",
      externalEventId: input.deliveryId,
      dedupeKey,
      triggerEvent: input.payload,
    });

    // Dispatch to Trigger.dev
    const handle = await tasks.trigger("coding-task", {
      orgId,
      automationId: automation.id,
      automationRunId: run.id,
      source: "automation" as const,
      triggerEvent: input.payload,
    }, {
      idempotencyKey: `run:${run.id}`,
    });

    // Store the Trigger.dev run ID
    if (handle.id) {
      const { updateAutomationRun } = await import("@/lib/automations/actions");
      await updateAutomationRun(run.id, { triggerRunId: handle.id });
    }

    triggered++;
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
