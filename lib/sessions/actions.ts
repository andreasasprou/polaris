import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { interactiveSessions } from "./schema";

export async function createInteractiveSession(input: {
  organizationId: string;
  createdBy: string;
  agentType: string;
  agentSecretId?: string;
  repositoryId?: string;
  prompt: string;
}) {
  const [row] = await db
    .insert(interactiveSessions)
    .values(input)
    .returning();
  return row;
}

export async function updateInteractiveSession(
  id: string,
  input: Partial<{
    status: string;
    sdkSessionId: string;
    sandboxId: string;
    sandboxBaseUrl: string;
    triggerRunId: string;
    summary: string | null;
    error: string | null;
    startedAt: Date;
    endedAt: Date | null;
  }>,
) {
  const [row] = await db
    .update(interactiveSessions)
    .set(input)
    .where(eq(interactiveSessions.id, id))
    .returning();
  return row;
}

export async function getInteractiveSession(id: string) {
  const [row] = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, id))
    .limit(1);
  return row ?? null;
}
