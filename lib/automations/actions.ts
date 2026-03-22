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
  keyPoolId?: string;
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
    keyPoolId: string | null;
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
  // Detach jobs before deleting — both jobs.automationId and
  // jobs.automationRunId have no onDelete clause (default RESTRICT).
  // The cascade deletes automationRuns, but jobs referencing those
  // runs via automationRunId block the cascade.
  const { jobs } = await import("@/lib/jobs/schema");
  const { automationRuns: runsTable } = await import("./schema");

  // Find all automation_run IDs for this automation
  const runs = await db
    .select({ id: runsTable.id })
    .from(runsTable)
    .where(eq(runsTable.automationId, id));
  const runIds = runs.map((r) => r.id);

  // Null out both FK columns on referencing jobs
  await db
    .update(jobs)
    .set({ automationId: null })
    .where(eq(jobs.automationId, id));

  if (runIds.length > 0) {
    await db
      .update(jobs)
      .set({ automationRunId: null })
      .where(inArray(jobs.automationRunId, runIds));
  }

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
    .onConflictDoNothing()
    .returning();
  return row ?? null;
}

/**
 * Atomically find or create an automation session + its backing interactive session.
 * Handles the TOCTOU race: if a concurrent request creates the session between
 * our read and write, we clean up the orphan interactive session and return the winner.
 */
export async function findOrCreateAutomationSession(input: {
  automationId: string;
  organizationId: string;
  repositoryId: string;
  scopeKey: string;
  agentType: string;
  agentSecretId?: string | null;
  keyPoolId?: string | null;
  metadata: AutomationSessionMetadata;
}): Promise<{ automationSession: NonNullable<Awaited<ReturnType<typeof findAutomationSessionByScope>>>; created: boolean }> {
  // 1. Check for existing
  const existing = await findAutomationSessionByScope(input.automationId, input.scopeKey);
  if (existing) return { automationSession: existing, created: false };

  // 2. Create interactive session
  const { createInteractiveSession, deleteInteractiveSession } = await import("@/lib/sessions/actions");
  const interactiveSession = await createInteractiveSession({
    organizationId: input.organizationId,
    createdBy: "automation",
    agentType: input.agentType,
    agentSecretId: input.agentSecretId,
    keyPoolId: input.keyPoolId,
    repositoryId: input.repositoryId,
    prompt: "(initial PR review — prompt will be sent by orchestrator)",
  });

  // 3. Try to insert automation session (onConflictDoNothing)
  let automationSession;
  try {
    automationSession = await createAutomationSession({
      automationId: input.automationId,
      interactiveSessionId: interactiveSession.id,
      organizationId: input.organizationId,
      repositoryId: input.repositoryId,
      scopeKey: input.scopeKey,
      metadata: input.metadata,
    });
  } catch (err) {
    // Non-conflict DB error — clean up the orphan interactive session
    await deleteInteractiveSession(interactiveSession.id);
    throw err;
  }

  if (automationSession) {
    return { automationSession, created: true };
  }

  // 4. Race lost (conflict) — clean up orphan interactive session, return the winner
  await deleteInteractiveSession(interactiveSession.id);
  const winner = await findAutomationSessionByScope(input.automationId, input.scopeKey);
  if (!winner) throw new Error("Automation session vanished after conflict");
  return { automationSession: winner, created: false };
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
 * Force-release a review lock regardless of which job holds it.
 * Used by the sweeper to clean up stale locks.
 */
export async function forceReleaseAutomationSessionLock(
  automationSessionId: string,
) {
  await db
    .update(automationSessions)
    .set({ reviewLockJobId: null, updatedAt: new Date() })
    .where(eq(automationSessions.id, automationSessionId));
}

/**
 * Find automation sessions with stale review locks.
 *
 * The lock column stores `automationRunId` (not job.id). A lock is stale when
 * the referenced automation run is terminal or doesn't exist. We only check
 * the automation_runs table since that's what the lock key references.
 */
export async function getStaleReviewLocks() {
  const { sql } = await import("drizzle-orm");
  const rows = await db.execute(sql`
    SELECT as2.id AS automation_session_id, as2.review_lock_job_id
    FROM automation_sessions as2
    WHERE as2.review_lock_job_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM automation_runs ar
      WHERE ar.id = as2.review_lock_job_id::uuid
      AND ar.status IN ('pending', 'running')
      AND ar.created_at > NOW() - INTERVAL '30 minutes'
    )
  `);
  return rows.rows as { automation_session_id: string; review_lock_job_id: string }[];
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

/**
 * Check lock ownership for sweeper retry.
 * Returns:
 *   "owned"    — lock is held by the given jobId (we already own it)
 *   "acquired" — lock was free and we acquired it
 *   "busy"     — lock is held by a different job
 */
export async function ensureReviewLockOwnership(input: {
  automationSessionId: string;
  jobId: string;
}): Promise<"owned" | "acquired" | "busy"> {
  const session = await getAutomationSession(input.automationSessionId);
  if (!session) return "busy";

  if (session.reviewLockJobId === input.jobId) return "owned";
  if (!session.reviewLockJobId) {
    const acquired = await tryAcquireAutomationSessionLock(input);
    return acquired ? "acquired" : "busy";
  }
  return "busy";
}

/**
 * Check if a review job's automation run is still the latest for its session.
 * Used by the sweeper to skip retrying stale reviews superseded by newer runs.
 */
export async function isLatestRunForSession(
  automationRunId: string,
  createdAt: Date,
): Promise<boolean> {
  const { sql } = await import("drizzle-orm");
  const { findRunById } = await import("./queries");
  const run = await findRunById(automationRunId);
  if (!run?.automationSessionId) return true;

  const [newerRun] = await db
    .select({ id: automationRuns.id })
    .from(automationRuns)
    .where(
      and(
        eq(automationRuns.automationSessionId, run.automationSessionId),
        sql`${automationRuns.createdAt} > ${createdAt}`,
      ),
    )
    .limit(1);

  return !newerRun;
}
