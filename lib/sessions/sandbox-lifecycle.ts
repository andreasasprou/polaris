/**
 * Sandbox Lifecycle Management — v2
 *
 * Manages sandbox provisioning, hibernation, and destruction.
 * Replaces the sandbox lifecycle logic from trigger/interactive-session.ts.
 *
 * Key flows:
 * - ensureSandboxReady: create/restore sandbox, bootstrap agent + proxy
 * - snapshotAndHibernate: scrub creds, snapshot, hibernate session
 * - destroySandbox: stop sandbox, end runtime
 */

import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { incrementEpoch } from "@/lib/jobs/actions";
import {
  getInteractiveSession,
  updateInteractiveSession,
  casSessionStatus,
  createRuntime,
  endStaleRuntimes,
  getActiveRuntime,
  updateRuntime,
  getCheckpoint,
  hibernateSession,
} from "./actions";

const sandboxManager = new SandboxManager();

export type EnsureSandboxResult = {
  sandboxId: string;
  sandboxBaseUrl: string;
  proxyBaseUrl: string;
  epoch: number;
  runtimeId: string;
};

/**
 * Ensure a sandbox is ready for the given session.
 *
 * 1. Load session + latest checkpoint
 * 2. If checkpoint → createFromSnapshot, else → create from git
 * 3. incrementEpoch (invalidates stale callbacks)
 * 4. endStaleRuntimes + createRuntime
 * 5. Bootstrap agent server + REST proxy
 * 6. Configure git credentials
 * 7. Update session with sandboxId + sandboxBaseUrl
 */
export async function ensureSandboxReady(
  sessionId: string,
  credentials: {
    agentApiKey: string;
    agentType: AgentType;
    repositoryOwner: string;
    repositoryName: string;
    defaultBranch?: string;
    githubInstallationId: number;
    extraEnv?: Record<string, string>;
  },
): Promise<EnsureSandboxResult> {
  const session = await getInteractiveSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  // Mint GitHub token
  const { mintInstallationToken } = await import("@/lib/integrations/github");
  const gitToken = await mintInstallationToken(
    credentials.githubInstallationId,
    [credentials.repositoryName],
    { contents: "write", pull_requests: "write" },
  );

  const repoUrl = `https://github.com/${credentials.repositoryOwner}/${credentials.repositoryName}.git`;

  // Resolve sandbox source: checkpoint → snapshot restore, else → cold create
  let sandbox;
  let restoreSource = "cold";
  let restoreSnapshotId: string | undefined;

  if (session.latestCheckpointId) {
    const checkpoint = await getCheckpoint(session.latestCheckpointId);
    if (checkpoint?.snapshotId) {
      sandbox = await sandboxManager.createFromSnapshot({
        snapshotId: checkpoint.snapshotId,
        gitToken,
        timeoutMs: 3_600_000,
        ports: [2468, 2469],
      });
      restoreSource = "snapshot";
      restoreSnapshotId = checkpoint.snapshotId;
    }
  }

  if (!sandbox) {
    // Cold create from git
    const { getActiveSnapshot } = await import(
      "@/lib/sandbox/snapshots/queries"
    );
    const agentSnapshot = await getActiveSnapshot(
      credentials.agentType,
    );

    sandbox = await sandboxManager.create({
      source: agentSnapshot
        ? { type: "snapshot", snapshotId: agentSnapshot }
        : { type: "git" },
      repoUrl,
      gitToken,
      baseBranch: credentials.defaultBranch ?? "main",
      timeoutMs: 3_600_000,
      ports: [2468, 2469],
    });
  }

  // Increment epoch (invalidates callbacks from previous sandbox)
  const epoch = await incrementEpoch(sessionId);

  // End stale runtimes + create new one
  await endStaleRuntimes(sessionId);
  const runtime = await createRuntime({
    sessionId,
    sandboxId: sandbox.sandboxId,
    epoch,
    restoreSource,
    restoreSnapshotId,
    status: "creating",
  });

  // Bootstrap agent server
  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);
  const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

  const rawEnv = buildSessionEnv(
    credentials.agentType,
    credentials.agentApiKey,
    credentials.extraEnv,
  );
  const sessionEnv = await bootstrap.provisionCredentialFiles(rawEnv);

  if (restoreSource === "cold") {
    const { getActiveSnapshot: getSnap } = await import(
      "@/lib/sandbox/snapshots/queries"
    );
    const snap = await getSnap(credentials.agentType);
    if (!snap) {
      // No snapshot — install sandbox-agent from scratch
      await bootstrap.install();
    }
    // Always install the agent CLI (snapshot may have sandbox-agent
    // but not the specific agent CLI like claude/codex)
    await bootstrap.installAgent(credentials.agentType, sessionEnv);
  } else {
    // Snapshot restore — ensure agent CLI is available
    await bootstrap.installAgent(credentials.agentType, sessionEnv);
  }

  // Configure git
  await git.configure({ repoUrl });

  // Start agent server
  const serverUrl = await bootstrap.start(2468, sessionEnv);

  // Install + start REST proxy
  const fs = await import("node:fs");
  const path = await import("node:path");
  const proxyBundlePath = path.resolve(
    import.meta.dirname,
    "../sandbox-proxy/dist/proxy.js",
  );
  const proxyBundle = fs.readFileSync(proxyBundlePath, "utf-8");
  await bootstrap.installProxy(proxyBundle);

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.VERCEL_URL;
  const callbackBaseUrl = appUrl
    ? `${appUrl.startsWith("http") ? appUrl : `https://${appUrl}`}/api/callbacks`
    : "http://localhost:3001/api/callbacks";

  const proxyBaseUrl = await bootstrap.startProxy({
    ...sessionEnv,
    CALLBACK_URL: callbackBaseUrl,
  });

  // Update runtime + session
  // Store the proxy URL as sandboxBaseUrl since all v2 communication
  // goes through the proxy (port 2469), not the agent server directly.
  await updateRuntime(runtime.id, {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: proxyBaseUrl,
    status: "running",
  });

  await updateInteractiveSession(sessionId, {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: proxyBaseUrl,
  });

  return {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: serverUrl,
    proxyBaseUrl,
    epoch,
    runtimeId: runtime.id,
  };
}

/**
 * Snapshot the sandbox and hibernate the session.
 *
 * 1. CAS idle → snapshotting
 * 2. Scrub credentials
 * 3. Create snapshot (stops sandbox)
 * 4. DB transaction: create checkpoint + update session + end runtime
 */
export async function snapshotAndHibernate(
  sessionId: string,
): Promise<boolean> {
  const session = await getInteractiveSession(sessionId);
  if (!session?.sandboxId) return false;

  // CAS to snapshotting
  const cas = await casSessionStatus(sessionId, ["idle"], "snapshotting");
  if (!cas) return false;

  const runtime = await getActiveRuntime(sessionId);
  const sandbox = await sandboxManager.reconnect(session.sandboxId);

  if (!sandbox) {
    // Sandbox already dead — mark stopped
    await casSessionStatus(sessionId, ["snapshotting"], "stopped", {
      endedAt: new Date(),
    });
    if (runtime) {
      await updateRuntime(runtime.id, { status: "stopped", endedAt: new Date() });
    }
    return false;
  }

  // Scrub credentials
  const scrubOk = await sandboxManager.scrubCredentials(sandbox);
  if (!scrubOk) {
    await sandboxManager.destroy(sandbox);
    await casSessionStatus(sessionId, ["snapshotting"], "stopped", {
      endedAt: new Date(),
    });
    if (runtime) {
      await updateRuntime(runtime.id, { status: "stopped", endedAt: new Date() });
    }
    return false;
  }

  // Snapshot (stops sandbox automatically)
  const snapshotResult = await sandboxManager.snapshot(sandbox);
  if (!snapshotResult) {
    await sandboxManager.destroy(sandbox);
    await casSessionStatus(sessionId, ["snapshotting"], "stopped", {
      endedAt: new Date(),
    });
    if (runtime) {
      await updateRuntime(runtime.id, { status: "stopped", endedAt: new Date() });
    }
    return false;
  }

  // DB transaction: checkpoint + session → hibernated + runtime → stopped
  if (!runtime) {
    // No runtime — just update session
    await casSessionStatus(sessionId, ["snapshotting"], "stopped", {
      endedAt: new Date(),
    });
    return false;
  }

  try {
    await hibernateSession({
      sessionId,
      runtimeId: runtime.id,
      snapshotId: snapshotResult.snapshotId,
      sizeBytes: snapshotResult.sizeBytes,
    });
    return true;
  } catch (err) {
    console.error(
      `[sandbox-lifecycle] Hibernate DB transaction failed (orphan snapshot ${snapshotResult.snapshotId}):`,
      err instanceof Error ? err.message : err,
    );
    await casSessionStatus(sessionId, ["snapshotting"], "stopped", {
      endedAt: new Date(),
    });
    await updateRuntime(runtime.id, { status: "stopped", endedAt: new Date() });
    return false;
  }
}

/**
 * Destroy the sandbox for a session and mark the runtime as stopped.
 */
export async function destroySandbox(sessionId: string): Promise<void> {
  const session = await getInteractiveSession(sessionId);
  if (!session?.sandboxId) return;

  await sandboxManager.destroyById(session.sandboxId);

  const runtime = await getActiveRuntime(sessionId);
  if (runtime) {
    await updateRuntime(runtime.id, { status: "stopped", endedAt: new Date() });
  }
}
