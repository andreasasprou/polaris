/**
 * Test script for the continuous PR review pipeline.
 *
 * Simulates a pull_request.opened webhook by:
 * 1. Creating/updating a continuous-mode automation in the DB
 * 2. Calling routeGitHubEvent() with a mock payload
 *
 * Usage:
 *   npx tsx scripts/test-continuous-review.ts [pr-number]
 *
 * Prerequisites:
 *   - Local DB running with existing repos + installations
 *   - Trigger.dev dev server running (pnpm dev:trigger or similar)
 *   - GITHUB_APP_* env vars set
 */

import { db } from "@/lib/db";
import { automations } from "@/lib/automations/schema";
import { eq } from "drizzle-orm";
import { routeGitHubEvent } from "@/lib/routing/trigger-router";

const PR_NUMBER = parseInt(process.argv[2] ?? "75", 10);
const EVENT_ACTION = (process.argv[3] ?? "opened") as "opened" | "synchronize";

// Known values from our DB
const INSTALLATION_ID = 114663655;
const REPO_OWNER = "andreasasprou";
const REPO_NAME = "polaris";
const REPOSITORY_ID = "1a13cf69-be73-41e4-9f14-62dff033557e";
const ORG_ID = "gC2NaEnYzv6YNfCq7X7kjmB6m5N1SD6o";

async function main() {
  console.log(`\n🔧 Testing continuous PR review for PR #${PR_NUMBER}\n`);

  // Step 1: Ensure we have a continuous-mode automation
  console.log("Step 1: Setting up continuous automation...");

  const existing = await db
    .select()
    .from(automations)
    .where(eq(automations.repositoryId, REPOSITORY_ID))
    .limit(1);

  let automationId: string;

  if (existing.length > 0 && existing[0].mode === "continuous") {
    automationId = existing[0].id;
    console.log(`  Using existing continuous automation: ${automationId}`);
  } else if (existing.length > 0) {
    // Update existing to continuous mode
    const [updated] = await db
      .update(automations)
      .set({
        mode: "continuous",
        triggerConfig: {
          events: ["pull_request.opened", "pull_request.synchronize", "pull_request.ready_for_review"],
        },
      })
      .where(eq(automations.id, existing[0].id))
      .returning();
    automationId = updated.id;
    console.log(`  Updated automation to continuous mode: ${automationId}`);
  } else {
    // Create new
    const [created] = await db
      .insert(automations)
      .values({
        organizationId: ORG_ID,
        createdBy: "test-script",
        name: "PR Review (continuous)",
        triggerType: "github",
        triggerConfig: {
          events: ["pull_request.opened", "pull_request.synchronize", "pull_request.ready_for_review"],
        },
        prompt: "Review this PR for bugs, security issues, and design problems.",
        agentType: "claude",
        repositoryId: REPOSITORY_ID,
        mode: "continuous",
      })
      .returning();
    automationId = created.id;
    console.log(`  Created continuous automation: ${automationId}`);
  }

  // Step 2: Fetch PR details from GitHub
  console.log("\nStep 2: Fetching PR details...");

  const { getInstallationOctokitById } = await import("@/lib/integrations/github");
  const octokit = await getInstallationOctokitById(INSTALLATION_ID);
  const { data: pr } = await octokit.rest.pulls.get({
    owner: REPO_OWNER,
    repo: REPO_NAME,
    pull_number: PR_NUMBER,
  });

  console.log(`  PR #${pr.number}: ${pr.title.slice(0, 80)}`);
  console.log(`  Head: ${pr.head.sha.slice(0, 8)} (${pr.head.ref})`);
  console.log(`  Base: ${pr.base.sha.slice(0, 8)} (${pr.base.ref})`);

  // Step 3: Simulate the webhook
  console.log(`\nStep 3: Simulating pull_request.${EVENT_ACTION} webhook...`);

  const mockPayload = {
    action: EVENT_ACTION,
    pull_request: {
      number: pr.number,
      html_url: pr.html_url,
      state: pr.state,
      draft: pr.draft,
      title: pr.title,
      body: pr.body,
      labels: pr.labels.map((l) => ({ name: l.name })),
      head: {
        ref: pr.head.ref,
        sha: pr.head.sha,
      },
      base: {
        ref: pr.base.ref,
        sha: pr.base.sha,
      },
    },
    repository: {
      name: REPO_NAME,
      owner: { login: REPO_OWNER },
    },
    sender: {
      login: pr.user?.login ?? "test",
      type: pr.user?.type ?? "User",
    },
    installation: {
      id: INSTALLATION_ID,
    },
  };

  const deliveryId = `test-${Date.now()}`;

  const triggered = await routeGitHubEvent({
    installationId: INSTALLATION_ID,
    deliveryId,
    eventType: "pull_request",
    action: EVENT_ACTION,
    ref: `refs/heads/${pr.base.ref}`,
    payload: mockPayload,
  });

  console.log(`\n✅ Dispatched ${triggered} automation(s)`);

  if (triggered > 0) {
    console.log("\nWatch the Trigger.dev dashboard or use:");
    console.log("  - Trigger.dev MCP: list_runs to see the continuous-pr-review task");
    console.log("  - DB: SELECT * FROM automation_sessions WHERE automation_id = '" + automationId + "';");
    console.log("  - DB: SELECT * FROM automation_runs WHERE automation_id = '" + automationId + "' ORDER BY created_at DESC LIMIT 1;");
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("\n❌ Error:", err);
  process.exit(1);
});
