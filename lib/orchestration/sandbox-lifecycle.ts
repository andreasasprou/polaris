/**
 * Sandbox Lifecycle Management — v2
 *
 * Manages sandbox provisioning, hibernation, and destruction.
 *
 * Key flows:
 * - ensureSandboxReady: create/restore sandbox, bootstrap agent + proxy
 * - snapshotAndHibernate: scrub creds, snapshot, hibernate session
 * - destroySandbox: stop sandbox, end runtime
 */

import { getCallbackUrl } from "@/lib/config/urls";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import type { SandboxUsageSummary } from "@/lib/sandbox/types";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import type { AgentType } from "@/lib/sandbox-agent/types";
import type { CredentialRef } from "@/lib/key-pools/types";
import { allocateKeyFromPool, resolveSecretKey } from "@/lib/key-pools/resolve";
import { useLogger } from "@/lib/evlog";
import { createStepTimer } from "@/lib/metrics/step-timer";
import {
  getOrgObservabilitySettings,
  isSandboxRawLogDebugEnabled,
} from "@/lib/observability/org-settings";
import {
  decodeProcessLogEntries,
  resolveProcessLogStream,
} from "@/lib/sessions/process-logs";
import {
  incrementEpoch,
  getInteractiveSession,
  updateInteractiveSession,
  casSessionStatus,
  createRuntime,
  endStaleRuntimes,
  getActiveRuntime,
  getLatestRuntime,
  updateRuntime,
  getCheckpoint,
  hibernateSession,
} from "@/lib/sessions/actions";
import type { Sandbox } from "@vercel/sandbox";

const sandboxManager = new SandboxManager();
const DEFAULT_AXIOM_INGEST_URL = "https://api.axiom.co";
const PROXY_LOG_PATH = "/tmp/polaris-proxy/proxy.log.ndjson";
const PROXY_LOG_ROTATED_PATH = "/tmp/polaris-proxy/proxy.log.1.ndjson";

export type EnsureSandboxResult = {
  sandboxId: string;
  sandboxBaseUrl: string;
  proxyBaseUrl: string;
  proxyCmdId: string;
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
    credentialRef: CredentialRef;
    agentType: AgentType;
    repositoryOwner: string;
    repositoryName: string;
    defaultBranch?: string;
    githubInstallationId: number;
    extraEnv?: Record<string, string>;
  },
): Promise<EnsureSandboxResult> {
  const log = useLogger();
  const timer = createStepTimer();
  log.set({ lifecycle: { sessionId, agentType: credentials.agentType } });

  const session = await getInteractiveSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  const orgId = session.organizationId;
  const observabilitySettings = await getOrgObservabilitySettings(orgId);
  const rawLogDebugEnabled = isSandboxRawLogDebugEnabled(observabilitySettings);

  // Mint GitHub token
  const { mintInstallationToken } = await import("@/lib/integrations/github");
  const gitToken = await timer.time("mintToken", () => mintInstallationToken(
    credentials.githubInstallationId,
    [credentials.repositoryName],
    { contents: "write", pull_requests: "write" },
  ));

  const repoUrl = `https://github.com/${credentials.repositoryOwner}/${credentials.repositoryName}.git`;
  const proxyObservability = getProxyObservabilityConfig({
    rawLogDebugEnabled,
    rawLogDebugExpiresAt: observabilitySettings.sandboxRawLogs.expiresAt,
  });

  // Resolve sandbox source: checkpoint → snapshot restore, else → cold create
  let sandbox;
  let restoreSource = "cold";
  let restoreSnapshotId: string | undefined;

  if (session.latestCheckpointId) {
    const checkpoint = await getCheckpoint(session.latestCheckpointId);
    if (checkpoint?.snapshotId) {
      sandbox = await timer.time("createFromSnapshot", () => sandboxManager.createFromSnapshot({
        snapshotId: checkpoint.snapshotId,
        gitToken,
        timeoutMs: 3_600_000,
        ports: [2468, 2469],
        observability: proxyObservability.networkPolicy,
      }));
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

    sandbox = await timer.time("createSandbox", () => sandboxManager.create({
      source: agentSnapshot
        ? { type: "snapshot", snapshotId: agentSnapshot }
        : { type: "git" },
      repoUrl,
      gitToken,
      baseBranch: credentials.defaultBranch ?? "main",
      timeoutMs: 3_600_000,
      ports: [2468, 2469],
      observability: proxyObservability.networkPolicy,
    }));
  }

  timer.setMeta("restoreSource", restoreSource);

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

  // Resolve the actual API key — delayed until after sandbox creation so
  // failed provisioning doesn't advance LRU and skew fairness for retries.
  // Wrapped in try/catch to destroy the sandbox if allocation fails (e.g. all
  // pool keys revoked between validation and provisioning).
  const ref = credentials.credentialRef;
  let agentApiKey: string;
  try {
    switch (ref.type) {
      case "pool": {
        const { poolId } = ref;
        const allocated = await timer.time("allocateKey", () =>
          allocateKeyFromPool(poolId, orgId),
        );
        agentApiKey = allocated.decryptedKey;
        break;
      }
      case "secret": {
        const { secretId } = ref;
        const resolved = await timer.time("resolveKey", () =>
          resolveSecretKey(secretId, orgId),
        );
        agentApiKey = resolved.decryptedKey;
        break;
      }
    }
  } catch (err) {
    // Clean up the orphaned sandbox + runtime before re-throwing
    await sandboxManager.destroyById(sandbox.sandboxId).catch(() => {});
    await updateRuntime(runtime.id, { status: "failed", endedAt: new Date() });
    throw err;
  }

  // Bootstrap agent server
  const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
  const git = new GitOperations(commands);
  const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

  const rawEnv = buildSessionEnv(
    credentials.agentType,
    agentApiKey,
    credentials.extraEnv,
  );
  const sessionEnv = await timer.time("provisionCreds", () => bootstrap.provisionCredentialFiles(rawEnv));

  if (restoreSource === "cold") {
    const { getActiveSnapshot: getSnap } = await import(
      "@/lib/sandbox/snapshots/queries"
    );
    const snap = await getSnap(credentials.agentType);
    if (!snap) {
      // No snapshot — install sandbox-agent from scratch
      await timer.time("installSandboxAgent", () => bootstrap.install());
    }
    // Always install the agent CLI (snapshot may have sandbox-agent
    // but not the specific agent CLI like claude/codex)
    await timer.time("installAgent", () => bootstrap.installAgent(credentials.agentType, sessionEnv));
  } else {
    // Snapshot restore — ensure agent CLI is available
    await timer.time("installAgent", () => bootstrap.installAgent(credentials.agentType, sessionEnv));
  }

  // Configure git
  await timer.time("gitConfigure", () => git.configure({ repoUrl }));

  // Start agent server
  const serverUrl = await timer.time("startAgentServer", () => bootstrap.start(2468, sessionEnv));

  // Install + start REST proxy
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const proxyBundlePath = path.resolve(
    currentDir,
    "../sandbox-proxy/dist/proxy.js",
  );
  const proxyBundle = fs.readFileSync(proxyBundlePath, "utf-8");
  await timer.time("installProxy", () => bootstrap.installProxy(proxyBundle));

  const proxy = await timer.time("startProxy", () => bootstrap.startProxy({
    ...sessionEnv,
    CALLBACK_URL: getCallbackUrl(),
    ...proxyObservability.proxyEnv,
    POLARIS_SESSION_ID: sessionId,
    POLARIS_RUNTIME_ID: runtime.id,
    POLARIS_SANDBOX_ID: sandbox.sandboxId,
  }));
  const proxyBaseUrl = proxy.baseUrl;

  // Update runtime + session
  // Store the proxy URL as sandboxBaseUrl since all v2 communication
  // goes through the proxy (port 2469), not the agent server directly.
  await updateRuntime(runtime.id, {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: proxyBaseUrl,
    agentServerUrl: serverUrl,
    proxyCmdId: proxy.cmdId,
    status: "running",
  });

  await updateInteractiveSession(sessionId, {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: proxyBaseUrl,
  });

  log.set({ timing: timer.finalize() });
  log.set({ lifecycle: { phase: "ready", restoreSource, sandboxId: sandbox.sandboxId } });

  return {
    sandboxId: sandbox.sandboxId,
    sandboxBaseUrl: serverUrl,
    proxyBaseUrl,
    proxyCmdId: proxy.cmdId,
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
    const log = useLogger();
    log.error(err instanceof Error ? err : new Error(String(err)));
    log.set({ lifecycle: { hibernateFailed: true, orphanSnapshot: snapshotResult.snapshotId } });
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
export async function destroySandbox(
  sessionId: string,
  stopReason: string = "destroyed",
): Promise<void> {
  const session = await getInteractiveSession(sessionId);
  if (!session?.sandboxId) return;
  const runtime = await getActiveRuntime(sessionId) ?? await getLatestRuntime(sessionId);
  const log = useLogger();
  let usageSummary: SandboxUsageSummary | undefined;
  let teardownArtifacts: Record<string, unknown> | undefined;
  const observabilitySettings = await getOrgObservabilitySettings(
    session.organizationId,
  );
  const rawLogDebugEnabled = isSandboxRawLogDebugEnabled(observabilitySettings);

  try {
    const sandbox = await sandboxManager.reconnect(session.sandboxId);
    if (sandbox) {
      if (runtime) {
        teardownArtifacts = await collectTeardownArtifacts(sandbox, runtime, {
          rawLogDebugEnabled,
          rawLogDebugExpiresAt: observabilitySettings.sandboxRawLogs.expiresAt,
        });
      }
      usageSummary = await sandboxManager.stopAndCollectUsage(sandbox);
    } else {
      await sandboxManager.destroyById(session.sandboxId);
      usageSummary = {
        sandboxId: session.sandboxId,
        status: "unknown",
        stoppedAt: new Date().toISOString(),
      };
    }
  } catch (error) {
    await sandboxManager.destroyById(session.sandboxId).catch(() => {});
    log.error(error instanceof Error ? error : new Error(String(error)));
    usageSummary ??= {
      sandboxId: session.sandboxId,
      status: "unknown",
      stoppedAt: new Date().toISOString(),
    };
  }

  if (runtime) {
    await updateRuntime(runtime.id, {
      status: "stopped",
      endedAt: new Date(),
      stopReason,
      usageSummary: usageSummary
        ? {
            ...usageSummary,
            proxyCmdId: runtime.proxyCmdId ?? null,
          }
        : {},
      teardownArtifacts: teardownArtifacts ?? {},
    });
  }

  log.set({
    lifecycle: {
      stop: {
        sessionId,
        runtimeId: runtime?.id,
        sandboxId: session.sandboxId,
        stopReason,
        usageSummary,
        rawLogDebugEnabled,
        artifactsCollected: teardownArtifacts ? Object.keys(teardownArtifacts).length : 0,
      },
    },
  });
}

function getProxyObservabilityConfig(input: {
  rawLogDebugEnabled: boolean;
  rawLogDebugExpiresAt: string | null;
}): {
  networkPolicy?: { axiomIngestUrl?: string; axiomToken?: string };
  proxyEnv: Record<string, string>;
} {
  const dataset = process.env.AXIOM_PROXY_DATASET;
  const token = process.env.AXIOM_TOKEN;
  const proxyEnv: Record<string, string> = {};

  if (input.rawLogDebugEnabled) {
    proxyEnv.POLARIS_RAW_LOG_DEBUG = "true";
  }
  if (input.rawLogDebugExpiresAt) {
    proxyEnv.POLARIS_RAW_LOG_DEBUG_EXPIRES_AT = input.rawLogDebugExpiresAt;
  }

  if (!dataset || !token) {
    return { proxyEnv };
  }

  const ingestUrl = process.env.AXIOM_PROXY_INGEST_URL ?? DEFAULT_AXIOM_INGEST_URL;
  return {
    networkPolicy: {
      axiomIngestUrl: ingestUrl,
      axiomToken: token,
    },
    proxyEnv: {
      ...proxyEnv,
      AXIOM_PROXY_DATASET: dataset,
      AXIOM_PROXY_INGEST_URL: ingestUrl,
    },
  };
}

async function collectTeardownArtifacts(
  sandbox: Sandbox,
  runtime: NonNullable<Awaited<ReturnType<typeof getLatestRuntime>>>,
  options: {
    rawLogDebugEnabled: boolean;
    rawLogDebugExpiresAt: string | null;
  },
): Promise<Record<string, unknown>> {
  const artifacts: Record<string, unknown> = {
    collectedAt: new Date().toISOString(),
    sandboxId: runtime.sandboxId,
    proxyCmdId: runtime.proxyCmdId,
    observability: options,
  };
  const maxProcesses = options.rawLogDebugEnabled ? 6 : 3;
  const tailEntries = options.rawLogDebugEnabled ? 400 : 120;

  if (runtime.sandboxBaseUrl) {
    try {
      const response = await fetch(`${runtime.sandboxBaseUrl}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      artifacts.proxyStatus = response.ok
        ? await response.json()
        : { status: response.status };
    } catch (error) {
      artifacts.proxyStatusError =
        error instanceof Error ? error.message : String(error);
    }

    const processes = await fetchJson<Record<string, unknown>>(
      `${runtime.sandboxBaseUrl}/processes`,
      5_000,
    );
    if (Array.isArray(processes?.processes)) {
      artifacts.managedProcesses = processes.processes;

      const processLogs: Record<string, unknown> = {};
      for (const processInfo of processes.processes.slice(0, maxProcesses)) {
        const processRecord =
          processInfo && typeof processInfo === "object"
            ? (processInfo as { id?: string; tty?: boolean })
            : null;
        if (!processRecord?.id) continue;

        const stream = resolveProcessLogStream(null, {
          tty: processRecord.tty === true,
        });
        const logPayload = await fetchJson<{ entries?: Array<{
          sequence: number;
          stream: string;
          timestampMs: number;
          data: string;
          encoding: string;
        }> }>(
          `${runtime.sandboxBaseUrl}/processes/${encodeURIComponent(processRecord.id)}/logs?tail=${tailEntries}&stream=${stream}`,
          10_000,
        );

        if (logPayload?.entries?.length) {
          processLogs[processRecord.id] = decodeProcessLogEntries(
            logPayload.entries,
          );
        }
      }

      if (Object.keys(processLogs).length > 0) {
        artifacts.managedProcessLogs = processLogs;
      }
    }
  }

  artifacts.proxyLogTail = await readCommandOutput(
    sandbox,
    `tail -n 200 ${PROXY_LOG_PATH} 2>/dev/null || true`,
  );
  artifacts.proxyLogTailRotated = await readCommandOutput(
    sandbox,
    `tail -n 200 ${PROXY_LOG_ROTATED_PATH} 2>/dev/null || true`,
  );
  artifacts.processSnapshot = await readCommandOutput(
    sandbox,
    "ps -eo pid,ppid,pcpu,pmem,etime,stat,args --sort=-pcpu | head -n 25",
  );
  artifacts.diskSnapshot = await readCommandOutput(
    sandbox,
    "df -h /tmp /vercel/sandbox 2>/dev/null || df -h /tmp 2>/dev/null || true",
  );
  artifacts.uptime = await readCommandOutput(
    sandbox,
    "uptime 2>/dev/null || true",
  );

  if (runtime.proxyCmdId) {
    artifacts.proxyCommandLogTail = await collectCommandLogTail(
      sandbox,
      runtime.proxyCmdId,
    );
  }

  return artifacts;
}

async function fetchJson<T>(
  url: string,
  timeoutMs: number,
): Promise<T | null> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function readCommandOutput(
  sandbox: Sandbox,
  script: string,
): Promise<string> {
  try {
    const result = await sandbox.runCommand({
      cmd: "sh",
      args: ["-c", script],
      cwd: "/",
    });
    return (await result.stdout()).trim();
  } catch (error) {
    return `command failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

async function collectCommandLogTail(
  sandbox: Sandbox,
  cmdId: string,
): Promise<string> {
  try {
    const command = await sandbox.getCommand(cmdId);
    const signal = AbortSignal.timeout(2_000);
    let tail = "";
    for await (const chunk of command.logs({ signal })) {
      tail += `[${chunk.stream}] ${chunk.data}`;
      if (tail.length > 20_000) {
        tail = tail.slice(-20_000);
      }
    }
    return tail.trim();
  } catch (error) {
    return `log collection failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
