/**
 * Script to trigger an automation via Trigger.dev for E2E testing.
 * Usage: pnpm tsx -r dotenv/config scripts/trigger-automation.ts
 */
import { tasks } from "@trigger.dev/sdk/v3";
import type { codingTask } from "@/trigger/coding-task";
import { db } from "@/lib/db";
import { automationRuns } from "@/lib/automations/schema";

const AUTOMATION_ID = "dd4450c0-6324-4755-a4fa-58d8c93e9751";
const ORG_ID = "gC2NaEnYzv6YNfCq7X7kjmB6m5N1SD6o";

async function main() {
  // 1. Create an automation_runs record
  const [run] = await db
    .insert(automationRuns)
    .values({
      automationId: AUTOMATION_ID,
      organizationId: ORG_ID,
      source: "manual",
      triggerEvent: { manual: true, triggeredAt: new Date().toISOString() },
    })
    .returning();

  console.log("Created automation run:", run.id);

  // 2. Trigger the coding task
  const handle = await tasks.trigger<typeof codingTask>("coding-task", {
    source: "automation",
    orgId: ORG_ID,
    automationId: AUTOMATION_ID,
    automationRunId: run.id,
    triggerEvent: { manual: true, triggeredAt: new Date().toISOString() },
  });

  console.log("Triggered coding task:", handle.id);
  console.log("View in Trigger.dev dashboard or check run status in DB.");

  process.exit(0);
}

main().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});
