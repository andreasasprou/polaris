import { eq, and, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  interactiveSessions,
  interactiveSessionRuntimes,
  interactiveSessionCheckpoints,
  interactiveSessionTurns,
} from "./schema";
// Runtime statuses that indicate a "live" runtime (used for unique index + queries).
// These are RUNTIME statuses (creating/running/warm/suspended), not session statuses.
const LIVE_RUNTIME_STATUSES = ["creating", "running", "warm", "suspended"];

// ── Interactive Sessions ──

export async function createInteractiveSession(input: {
  organizationId: string;
  createdBy: string;
  agentType: string;
  agentSecretId?: string;
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

export async function updateInteractiveSession(
  id: string,
  input: Partial<{
    status: string;
    sdkSessionId: string;
    sandboxId: string;
    sandboxBaseUrl: string;
    triggerRunId: string | null;
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
    triggerRunId: string | null;
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

// ── Runtimes ──

export async function createRuntime(input: {
  sessionId: string;
  sandboxId?: string;
  sandboxBaseUrl?: string;
  triggerRunId?: string;
  sdkSessionId?: string;
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
    triggerRunId: string;
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
  triggerRunId?: string;
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
