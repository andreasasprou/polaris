import { eq, and, or, isNull, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { automations, automationRuns, automationSessions } from "./schema";
import type { AutomationSessionMetadata, QueuedReviewRequest } from "@/lib/reviews/types";
import type { ModelParams } from "@/lib/sandbox-agent/types";

export async function createAutomation(input: {
  organizationId: string;
  createdBy: string;
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  prompt: string;
  agentType?: string;
  model?: string;
  agentMode?: string;
  repositoryId?: string;
  agentSecretId?: string;
  maxDurationSeconds?: number;
  maxConcurrentRuns?: number;
  allowPush?: boolean;
  allowPrCreate?: boolean;
  mode?: string;
  modelParams?: ModelParams;
  prReviewConfig?: Record<string, unknown>;
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
    agentMode: string | null;
    repositoryId: string | null;
    agentSecretId: string | null;
    enabled: boolean;
    maxDurationSeconds: number;
    maxConcurrentRuns: number;
    allowPush: boolean;
    allowPrCreate: boolean;
    mode: string;
    modelParams: ModelParams;
    prReviewConfig: Record<string, unknown>;
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
  automationSessionId?: string;
  interactiveSessionId?: string;
  reviewSequence?: number;
  reviewScope?: string;
  reviewFromSha?: string;
  reviewToSha?: string;
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
    status: string;
    agentSessionId: string;
    prUrl: string;
    branchName: string;
    summary: string;
    error: string;
    startedAt: Date;
    completedAt: Date;
    automationSessionId: string;
    interactiveSessionId: string;
    reviewSequence: number;
    reviewScope: string;
    reviewFromSha: string;
    reviewToSha: string;
    githubCheckRunId: string;
    githubCommentId: string;
    verdict: string;
    severityCounts: { P0: number; P1: number; P2: number };
    metrics: import("@/lib/metrics/step-timer").StepMetrics;
    supersededByRunId: string;
  }>,
) {
  const [row] = await db
    .update(automationRuns)
    .set(input)
    .where(eq(automationRuns.id, id))
    .returning();
  return row;
}

// ── Automation Sessions ──

export async function createAutomationSession(input: {
  automationId: string;
  interactiveSessionId: string;
  organizationId: string;
  repositoryId: string;
  scopeType?: string;
  scopeKey: string;
  metadata?: AutomationSessionMetadata;
}) {
  const [row] = await db
    .insert(automationSessions)
    .values(input)
    .returning();
  return row;
}

export async function findAutomationSessionByScope(
  automationId: string,
  scopeKey: string,
) {
  const [row] = await db
    .select()
    .from(automationSessions)
    .where(
      and(
        eq(automationSessions.automationId, automationId),
        eq(automationSessions.scopeKey, scopeKey),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getAutomationSession(id: string) {
  const [row] = await db
    .select()
    .from(automationSessions)
    .where(eq(automationSessions.id, id))
    .limit(1);
  return row ?? null;
}

export async function updateAutomationSession(
  id: string,
  input: Partial<{
    interactiveSessionId: string;
    status: string;
    metadata: AutomationSessionMetadata;
    reviewLockRunId: string | null;
    reviewLockExpiresAt: Date | null;
    endedAt: Date | null;
  }>,
) {
  const [row] = await db
    .update(automationSessions)
    .set({ ...input, updatedAt: new Date() })
    .where(eq(automationSessions.id, id))
    .returning();
  return row;
}

/**
 * Swap the interactive session linked to an automation session.
 * Used by /review reset to start a fresh conversation.
 */
export async function swapAutomationSessionInteractiveSession(
  automationSessionId: string,
  newInteractiveSessionId: string,
) {
  return updateAutomationSession(automationSessionId, {
    interactiveSessionId: newInteractiveSessionId,
  });
}

/**
 * v2: Job-based review lock (no TTL).
 * Lock held = referenced job is nonterminal. Sweeper handles stuck jobs via timeout_at.
 * Lock acquire should happen inside a db.transaction() together with job creation.
 */
export async function tryAcquireAutomationSessionLock(input: {
  automationSessionId: string;
  jobId: string;
}) {
  const [row] = await db
    .update(automationSessions)
    .set({
      reviewLockJobId: input.jobId,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationSessions.id, input.automationSessionId),
        isNull(automationSessions.reviewLockJobId),
      ),
    )
    .returning();
  return row != null;
}

/**
 * Release the review lock. Only releases if the lock is held by the given job.
 */
export async function releaseAutomationSessionLock(input: {
  automationSessionId: string;
  jobId: string;
}) {
  const [row] = await db
    .update(automationSessions)
    .set({
      reviewLockJobId: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(automationSessions.id, input.automationSessionId),
        eq(automationSessions.reviewLockJobId, input.jobId),
      ),
    )
    .returning();
  return row != null;
}

/**
 * Set a pending review request (for queue-mode concurrency).
 * Overwrites any existing pending request (latest wins).
 */
export async function setPendingReviewRequest(
  automationSessionId: string,
  request: QueuedReviewRequest,
) {
  const session = await getAutomationSession(automationSessionId);
  if (!session) return null;

  const metadata = session.metadata as AutomationSessionMetadata;
  return updateAutomationSession(automationSessionId, {
    metadata: { ...metadata, pendingReviewRequest: request },
  });
}

/**
 * Clear pending review request and return it.
 */
export async function clearPendingReviewRequest(
  automationSessionId: string,
): Promise<QueuedReviewRequest | null> {
  const session = await getAutomationSession(automationSessionId);
  if (!session) return null;

  const metadata = session.metadata as AutomationSessionMetadata;
  const pending = metadata.pendingReviewRequest;
  if (!pending) return null;

  await updateAutomationSession(automationSessionId, {
    metadata: { ...metadata, pendingReviewRequest: null },
  });
  return pending;
}
