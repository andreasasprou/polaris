import { eq, and, desc, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations, automationRuns } from "./schema";
import { repositories } from "@/lib/integrations/schema";

export async function findAutomationsByOrg(organizationId: string) {
  return db
    .select()
    .from(automations)
    .where(eq(automations.organizationId, organizationId))
    .orderBy(desc(automations.createdAt));
}

export async function findAutomationsWithRepoByOrg(organizationId: string) {
  return db
    .select({
      automation: automations,
      repoOwner: repositories.owner,
      repoName: repositories.name,
    })
    .from(automations)
    .leftJoin(repositories, eq(automations.repositoryId, repositories.id))
    .where(eq(automations.organizationId, organizationId))
    .orderBy(desc(automations.createdAt));
}

export async function findAutomationById(id: string) {
  const [row] = await db
    .select()
    .from(automations)
    .where(eq(automations.id, id))
    .limit(1);
  return row ?? null;
}

export async function findEnabledAutomationsByTrigger(
  organizationId: string,
  triggerType: string,
) {
  return db
    .select()
    .from(automations)
    .where(
      and(
        eq(automations.organizationId, organizationId),
        eq(automations.triggerType, triggerType),
        eq(automations.enabled, true),
      ),
    );
}

export async function findRunsByAutomation(automationId: string, limit = 50) {
  return db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.automationId, automationId))
    .orderBy(desc(automationRuns.createdAt))
    .limit(limit);
}

export async function findRunById(runId: string) {
  const [row] = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.id, runId))
    .limit(1);
  return row ?? null;
}
