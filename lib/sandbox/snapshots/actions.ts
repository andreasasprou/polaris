import { db } from "@/lib/db";
import { sandboxSnapshots } from "./schema";
import { eq, and } from "drizzle-orm";
import { Sandbox } from "@vercel/sandbox";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { getEnabledAgentTypes } from "@/lib/sandbox-agent/agent-profiles";

const SANDBOX_AGENT_VERSION = "0.3.x";
const PROJECT_DIR = "/vercel/sandbox";

/** All agent types that should have snapshots built (derived from enabled agents). */
const SNAPSHOT_AGENT_TYPES: AgentType[] = getEnabledAgentTypes();

/**
 * Build a snapshot for a single agent type.
 * No API key needed — `install-agent` only downloads binaries.
 * Credentials are injected at runtime via `bootstrap.start()`.
 */
export async function buildSnapshot(agentType: AgentType): Promise<string> {
  const sandbox = await Sandbox.create({
    token: process.env.VERCEL_TOKEN,
    teamId: process.env.VERCEL_TEAM_ID,
    projectId: process.env.VERCEL_PROJECT_ID,
    runtime: "node24",
    timeout: 300_000,
  });

  try {
    const commands = new SandboxCommands(sandbox, PROJECT_DIR);
    const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

    await bootstrap.install();
    await bootstrap.installAgent(agentType, {});

    const snapshot = await sandbox.snapshot();
    const snapshotId = snapshot.snapshotId;

    await expireSnapshots(agentType);

    await db.insert(sandboxSnapshots).values({
      snapshotId,
      agentType,
      status: "active",
      sandboxAgentVersion: SANDBOX_AGENT_VERSION,
      expiresAt: snapshot.expiresAt ?? null,
    });

    return snapshotId;
  } finally {
    try {
      await sandbox.stop();
    } catch {
      // best-effort
    }
  }
}

/**
 * Build snapshots for all supported agent types.
 */
export async function buildAllSnapshots(): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const agentType of SNAPSHOT_AGENT_TYPES) {
    results[agentType] = await buildSnapshot(agentType);
  }
  return results;
}

export async function expireSnapshots(agentType: AgentType): Promise<void> {
  await db
    .update(sandboxSnapshots)
    .set({ status: "expired" })
    .where(
      and(
        eq(sandboxSnapshots.agentType, agentType),
        eq(sandboxSnapshots.status, "active"),
      ),
    );
}
