import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  interactiveSessions,
  interactiveSessionRuntimes,
  interactiveSessionCheckpoints,
  interactiveSessionTurns,
} from "./schema";
// Runtime statuses that indicate a "live" runtime (used for unique index + queries).
// v2: simplified — no more warm/suspended distinction.
const LIVE_RUNTIME_STATUSES = ["creating", "running", "idle"];

// ── Interactive Sessions ──

export async function createInteractiveSession(input: {
  organizationId: string;
  createdBy: string;
  agentType: string;
  agentSecretId?: string | null;
  keyPoolId?: string | null;
  repositoryId?: string;
  prompt: string;
  cwd?: string;
}) {
  const [row] = await db
    .insert(interactiveSessions)
    .values(input)
    .returning();
  return row;
}

/**
 * Delete an interactive session by ID.
 * Used to clean up orphan sessions created during race conditions.
 */
export async function deleteInteractiveSession(id: string) {
  await db
    .delete(interactiveSessions)
    .where(eq(interactiveSessions.id, id));
}

export async function updateInteractiveSession(
  id: string,
  input: Partial<{
    status: string;
    agentType: string;
    sdkSessionId: string;
    sandboxId: string;
    sandboxBaseUrl: string;
    nativeAgentSessionId: string;
    cwd: string;
    latestCheckpointId: string;
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

/**
 * Compare-and-set status transition. Returns the updated row if the CAS
 * succeeds, or null if the current status didn't match (another process won).
 */
export async function casSessionStatus(
  id: string,
  fromStatuses: string[],
  toStatus: string,
  extra?: Partial<{
    error: string | null;
    endedAt: Date | null;
    latestCheckpointId: string;
  }>,
) {
  const [row] = await db
    .update(interactiveSessions)
    .set({ status: toStatus, ...extra })
    .where(
      and(
        eq(interactiveSessions.id, id),
        inArray(interactiveSessions.status, fromStatuses),
      ),
    )
    .returning();
  return row ?? null;
}

export async function getInteractiveSession(id: string) {
  const [row] = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.id, id))
    .limit(1);
  return row ?? null;
}

export async function getInteractiveSessionForOrg(
  id: string,
  organizationId: string,
) {
  const [row] = await db
    .select()
    .from(interactiveSessions)
    .where(
      and(
        eq(interactiveSessions.id, id),
        eq(interactiveSessions.organizationId, organizationId),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ── Runtimes ──

export async function createRuntime(input: {
  sessionId: string;
  sandboxId?: string;
  sandboxBaseUrl?: string;
  agentServerUrl?: string;
  sdkSessionId?: string;
  epoch: number;
  restoreSource: string;
  restoreSnapshotId?: string;
  status?: string;
}) {
  const [row] = await db
    .insert(interactiveSessionRuntimes)
    .values(input)
    .returning();
  return row;
}

export async function updateRuntime(
  id: string,
  input: Partial<{
    sandboxId: string;
    sandboxBaseUrl: string;
    agentServerUrl: string;
    sdkSessionId: string;
    status: string;
    endedAt: Date;
  }>,
) {
  const [row] = await db
    .update(interactiveSessionRuntimes)
    .set(input)
    .where(eq(interactiveSessionRuntimes.id, id))
    .returning();
  return row;
}

export async function getActiveRuntime(sessionId: string) {
  const [row] = await db
    .select()
    .from(interactiveSessionRuntimes)
    .where(
      and(
        eq(interactiveSessionRuntimes.sessionId, sessionId),
        inArray(interactiveSessionRuntimes.status, LIVE_RUNTIME_STATUSES),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Find sessions stuck in 'active' with no nonterminal job.
 * Used by the sweeper to heal stale state.
 */
export async function getStaleActiveSessions() {
  const rows = await db.execute(sql`
    SELECT s.id FROM interactive_sessions s
    WHERE s.status = 'active'
    AND NOT EXISTS (
      SELECT 1 FROM jobs j
      WHERE j.session_id = s.id
      AND j.status NOT IN ('completed', 'failed_terminal', 'failed_retryable', 'cancelled')
    )
  `);
  return rows.rows as { id: string }[];
}

// ── Epoch ──

/**
 * Atomically increment the session epoch and return the new value.
 * Used when creating/restoring a sandbox to invalidate stale callbacks.
 */
export async function incrementEpoch(sessionId: string): Promise<number> {
  const [row] = await db
    .update(interactiveSessions)
    .set({ epoch: sql`epoch + 1` })
    .where(eq(interactiveSessions.id, sessionId))
    .returning({ epoch: interactiveSessions.epoch });
  if (!row) throw new Error(`Session not found: ${sessionId}`);
  return row.epoch;
}

/**
 * Get the most recent runtime for a session (any status).
 * Used for log retrieval — logs may be available even after runtime ends.
 */
export async function getLatestRuntime(sessionId: string) {
  const [row] = await db
    .select()
    .from(interactiveSessionRuntimes)
    .where(eq(interactiveSessionRuntimes.sessionId, sessionId))
    .orderBy(sql`created_at DESC`)
    .limit(1);
  return row ?? null;
}

/**
 * End any live runtimes for a session. Called before creating a new runtime
 * on resume to satisfy the one-live-runtime-per-session unique constraint.
 */
export async function endStaleRuntimes(sessionId: string) {
  await db
    .update(interactiveSessionRuntimes)
    .set({ status: "failed", endedAt: new Date() })
    .where(
      and(
        eq(interactiveSessionRuntimes.sessionId, sessionId),
        inArray(interactiveSessionRuntimes.status, LIVE_RUNTIME_STATUSES),
      ),
    );
}

// ── Checkpoints ──

export async function createCheckpoint(input: {
  sessionId: string;
  runtimeId?: string;
  snapshotId: string;
  baseCommitSha?: string;
  lastEventIndex?: number;
  sizeBytes?: number;
  expiresAt?: Date;
}) {
  const [row] = await db
    .insert(interactiveSessionCheckpoints)
    .values(input)
    .returning();
  return row;
}

export async function getCheckpoint(id: string) {
  const [row] = await db
    .select()
    .from(interactiveSessionCheckpoints)
    .where(eq(interactiveSessionCheckpoints.id, id))
    .limit(1);
  return row ?? null;
}

/**
 * Atomically create checkpoint + update session + end runtime.
 * Used in the hibernation sequence to prevent orphan states.
 */
export async function hibernateSession(input: {
  sessionId: string;
  runtimeId: string;
  snapshotId: string;
  baseCommitSha?: string;
  lastEventIndex?: number;
  sizeBytes?: number;
}) {
  return db.transaction(async (tx) => {
    // 1. Insert checkpoint
    const [checkpoint] = await tx
      .insert(interactiveSessionCheckpoints)
      .values({
        sessionId: input.sessionId,
        runtimeId: input.runtimeId,
        snapshotId: input.snapshotId,
        baseCommitSha: input.baseCommitSha,
        lastEventIndex: input.lastEventIndex,
        sizeBytes: input.sizeBytes,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
      })
      .returning();

    // 2. Update session: set status to hibernated + point to checkpoint
    await tx
      .update(interactiveSessions)
      .set({
        status: "hibernated",
        latestCheckpointId: checkpoint.id,
        endedAt: new Date(),
      })
      .where(eq(interactiveSessions.id, input.sessionId));

    // 3. End the runtime
    await tx
      .update(interactiveSessionRuntimes)
      .set({ status: "stopped", endedAt: new Date() })
      .where(eq(interactiveSessionRuntimes.id, input.runtimeId));

    return checkpoint;
  });
}

// ── Turns ──

export async function createTurn(input: {
  sessionId: string;
  requestId: string;
  runtimeId?: string;
  source: string;
  prompt: string;
}) {
  const [row] = await db
    .insert(interactiveSessionTurns)
    .values({ ...input, status: "pending" })
    .returning();
  return row;
}

export async function startTurn(requestId: string, sessionId: string) {
  const [row] = await db
    .update(interactiveSessionTurns)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(interactiveSessionTurns.sessionId, sessionId),
        eq(interactiveSessionTurns.requestId, requestId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function completeTurn(
  requestId: string,
  sessionId: string,
  result: { finalMessage?: string; metadata?: Record<string, unknown> },
) {
  const [row] = await db
    .update(interactiveSessionTurns)
    .set({
      status: "completed",
      finalMessage: result.finalMessage,
      metadata: result.metadata ?? {},
      completedAt: new Date(),
    })
    .where(
      and(
        eq(interactiveSessionTurns.sessionId, sessionId),
        eq(interactiveSessionTurns.requestId, requestId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function failTurn(
  requestId: string,
  sessionId: string,
  error: string,
) {
  const [row] = await db
    .update(interactiveSessionTurns)
    .set({
      status: "failed",
      error,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(interactiveSessionTurns.sessionId, sessionId),
        eq(interactiveSessionTurns.requestId, requestId),
      ),
    )
    .returning();
  return row ?? null;
}

export async function getTurnByRequestId(
  requestId: string,
  sessionId: string,
) {
  const [row] = await db
    .select()
    .from(interactiveSessionTurns)
    .where(
      and(
        eq(interactiveSessionTurns.sessionId, sessionId),
        eq(interactiveSessionTurns.requestId, requestId),
      ),
    )
    .limit(1);
  return row ?? null;
}
