import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations, automationRuns } from "./schema";

export async function createAutomation(input: {
  organizationId: string;
  createdBy: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  prompt: string;
  agentType?: string;
  model?: string;
  repositoryId?: string;
  agentSecretId?: string;
  maxDurationSeconds?: number;
  maxConcurrentRuns?: number;
  allowPush?: boolean;
  allowPrCreate?: boolean;
}) {
  const [row] = await db
    .insert(automations)
    .values(input)
    .returning();
  return row;
}

export async function updateAutomation(
  id: string,
  input: Partial<{
    name: string;
    triggerType: string;
    triggerConfig: Record<string, unknown>;
    prompt: string;
    agentType: string;
    model: string | null;
    repositoryId: string | null;
    agentSecretId: string | null;
    enabled: boolean;
    maxDurationSeconds: number;
    maxConcurrentRuns: number;
    allowPush: boolean;
    allowPrCreate: boolean;
  }>,
) {
  const [row] = await db
    .update(automations)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(automations.id, id))
    .returning();
  return row;
}

export async function deleteAutomation(id: string) {
  await db.delete(automations).where(eq(automations.id, id));
}

export async function toggleAutomation(id: string, enabled: boolean) {
  const [row] = await db
    .update(automations)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(automations.id, id))
    .returning();
  return row;
}

export async function createAutomationRun(input: {
  automationId: string;
  organizationId: string;
  source: string;
  externalEventId?: string;
  dedupeKey?: string;
  triggerEvent?: Record<string, unknown>;
}) {
  const [row] = await db
    .insert(automationRuns)
    .values(input)
    .returning();
  return row;
}

export async function updateAutomationRun(
  id: string,
  input: Partial<{
    triggerRunId: string;
    status: string;
    agentSessionId: string;
    prUrl: string;
    branchName: string;
    summary: string;
    error: string;
    startedAt: Date;
    completedAt: Date;
  }>,
) {
  const [row] = await db
    .update(automationRuns)
    .set(input)
    .where(eq(automationRuns.id, id))
    .returning();
  return row;
}
