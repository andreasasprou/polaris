import { db } from "@/lib/db";
import { sandboxSnapshots } from "./schema";
import { eq, and, desc } from "drizzle-orm";
import type { AgentType } from "@/lib/sandbox-agent/types";
import type { SandboxSource } from "@/lib/sandbox/types";
import { useLogger } from "@/lib/evlog";

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
 * Returns an existing snapshot if available, otherwise falls back to git.
 */
export async function resolveSnapshotSource(
  agentType: AgentType,
): Promise<SandboxSource> {
  const existing = await getActiveSnapshot(agentType);

  if (existing) {
    return { type: "snapshot", snapshotId: existing };
  }

  // No snapshot available — fall back to git source
  const log = useLogger();
  log.set({ snapshot: { fallback: "git", agentType } });
  return { type: "git" };
}
