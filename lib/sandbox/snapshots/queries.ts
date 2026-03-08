import { db } from "@/lib/db";
import { sandboxSnapshots } from "./schema";
import { eq, and, desc } from "drizzle-orm";
import { logger } from "@trigger.dev/sdk/v3";
import type { AgentType } from "@/lib/sandbox-agent/types";
import type { SandboxSource } from "@/lib/sandbox/types";

export async function getActiveSnapshot(
  agentType: AgentType,
): Promise<string | null> {
  const [row] = await db
    .select({ snapshotId: sandboxSnapshots.snapshotId })
    .from(sandboxSnapshots)
    .where(
      and(
        eq(sandboxSnapshots.agentType, agentType),
        eq(sandboxSnapshots.status, "active"),
      ),
    )
    .orderBy(desc(sandboxSnapshots.createdAt))
    .limit(1);

  return row?.snapshotId ?? null;
}

/**
 * Resolve the sandbox source for an agent type.
 * Returns an existing snapshot if available, otherwise builds one first.
 * Always returns a snapshot source — no git fallback needed.
 */
export async function resolveSnapshotSource(
  agentType: AgentType,
): Promise<SandboxSource> {
  const existing = await getActiveSnapshot(agentType);

  if (existing) {
    return { type: "snapshot", snapshotId: existing };
  }

  // No snapshot — build one now (first-time setup)
  logger.info("No snapshot found, building one", { agentType });

  const { buildSnapshotTask } = await import("@/trigger/build-snapshot");
  const result = await buildSnapshotTask
    .triggerAndWait({ agentType })
    .unwrap();

  return { type: "snapshot", snapshotId: result.snapshotId };
}
