import { randomUUID } from "node:crypto";
import { tasks, runs, auth } from "@trigger.dev/sdk/v3";
import {
  getInteractiveSession,
  getCheckpoint,
  casSessionStatus,
  createRuntime,
  updateInteractiveSession,
  endStaleRuntimes,
} from "@/lib/sessions/actions";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { sessionMessages } from "@/lib/trigger/streams";
import type { interactiveSessionTask } from "@/trigger/interactive-session";
import { LIVE_SESSION_STATUSES, RUN_TERMINAL_STATUSES } from "@/lib/sessions/status";
import type { AgentType } from "@/lib/sandbox-agent/types";

const sandboxManager = new SandboxManager();

const RESUMABLE_STATUSES = ["idle", "stopped", "completed", "failed", "warm"];

// ── Result types ──

export type DispatchResult =
  | { tier: "hot"; triggerRunId: string }
  | { tier: "warm"; triggerRunId: string }
  | { tier: "suspended"; triggerRunId: string }
  | { tier: "hibernate"; triggerRunId: string; accessToken: string }
  | { tier: "cold"; triggerRunId: string; accessToken: string }
  | { tier: "fresh"; triggerRunId: string; accessToken: string }
  | { tier: "unavailable"; error: string; retryAfterMs?: number };

// ── Core dispatch ──

/**
 * Dispatch a prompt to an interactive session using the appropriate tier.
 *
 * Handles run liveness checks, 4-tier routing (hot/warm/suspended/hibernate/cold),
 * and all status transitions. Shared by the HTTP API route and the continuous
 * PR review orchestrator.
 */
export async function dispatchPromptToSession(input: {
  sessionId: string;
  orgId: string;
  prompt: string;
  requestId?: string;
  source?: "user" | "automation";
  /** Agent-native mode override (e.g. "dontAsk" for read-only Claude). */
  modeOverride?: string;
  /** Agent model (e.g. "opus", "gpt-5.3-codex"). */
  model?: string;
  /** Effort / thought level (e.g. "low", "medium", "high", "max"). */
  effortLevel?: import("@/lib/sandbox-agent/agent-profiles").EffortLevel;
  /** Override the branch to clone/checkout (e.g. PR head branch for reviews). */
  branch?: string;
  /** Semantic mode intent — determines agent permissions scope. */
  modeIntent?: "autonomous" | "read-only" | "interactive";
  /** Override the agent type (e.g. when automation config changed since session creation). */
  agentType?: AgentType;
}): Promise<DispatchResult> {
  const { sessionId, orgId, prompt } = input;
  const requestId = input.requestId ?? randomUUID();

  let session = await getInteractiveSession(sessionId);
  if (!session || session.organizationId !== orgId) {
    return { tier: "unavailable", error: "Session not found" };
  }

  console.log(
    `[dispatch] session=${sessionId.slice(0, 8)} status=${session.status} ` +
    `sdkSessionId=${session.sdkSessionId ? "set" : "null"} ` +
    `triggerRunId=${session.triggerRunId?.slice(0, 12) ?? "null"} ` +
    `sandboxId=${session.sandboxId?.slice(0, 8) ?? "null"}`,
  );

  // If caller provides an agentType override (e.g. automation changed agent),
  // update the session so the task payload and future dispatches use the correct type.
  if (input.agentType && input.agentType !== session.agentType) {
    await updateInteractiveSession(sessionId, { agentType: input.agentType });
    session = { ...session, agentType: input.agentType };
  }

  // ── Run liveness check ──
  if (
    LIVE_SESSION_STATUSES.includes(session.status) &&
    session.triggerRunId
  ) {
    try {
      const run = await runs.retrieve(session.triggerRunId);
      if (RUN_TERMINAL_STATUSES.has(run.status)) {
        console.log(
          `[dispatch] stale run detected: run=${session.triggerRunId?.slice(0, 12)} ` +
          `runStatus=${run.status} — transitioning session to idle`,
        );
        await casSessionStatus(
          sessionId,
          LIVE_SESSION_STATUSES,
          "idle",
          { endedAt: new Date(), triggerRunId: null },
        );
        const refreshed = await getInteractiveSession(sessionId);
        if (!refreshed) {
          return { tier: "unavailable", error: "Session not found" };
        }
        session = refreshed;
      }
    } catch (err) {
      console.log(
        `[dispatch] run liveness check failed for run=${session.triggerRunId?.slice(0, 12)}: ` +
        `${err instanceof Error ? err.message : String(err)} — continuing`,
      );
    }
  }

  // ── Tier 1: Hot — active session with running task ──
  if (session.status === "active" && session.triggerRunId) {
    await sessionMessages.send(session.triggerRunId, {
      action: "prompt",
      prompt,
      nonce: requestId,
      requestId,
    });
    return { tier: "hot", triggerRunId: session.triggerRunId };
  }

  // ── Tier 2: Warm — task in warm-wait ──
  if (session.status === "warm" && session.triggerRunId) {
    await sessionMessages.send(session.triggerRunId, {
      action: "prompt",
      prompt,
      nonce: requestId,
      requestId,
    });
    return { tier: "warm", triggerRunId: session.triggerRunId };
  }

  // ── Tier 2b: Suspended — task paused via .wait(), auto-resumes on .send() ──
  if (session.status === "suspended" && session.triggerRunId) {
    await sessionMessages.send(session.triggerRunId, {
      action: "prompt",
      prompt,
      nonce: requestId,
      requestId,
    });
    return { tier: "suspended", triggerRunId: session.triggerRunId };
  }

  // ── Hibernating — snapshot in progress, retry later ──
  if (session.status === "hibernating") {
    return { tier: "unavailable", error: "Session is being saved, try again shortly", retryAfterMs: 5000 };
  }

  // Resolve org-level sandbox env vars (needed for both hibernate + cold resume)
  const { getDecryptedEnvVars } = await import("@/lib/sandbox-env/queries");
  const extraEnv = await getDecryptedEnvVars(orgId);
  const extraEnvPayload = Object.keys(extraEnv).length > 0 ? extraEnv : undefined;

  // ── Tier 3: Hibernated — restore from snapshot ──
  if (session.status === "hibernated" && session.latestCheckpointId) {
    const checkpoint = await getCheckpoint(session.latestCheckpointId);
    if (checkpoint) {
      const casResult = await casSessionStatus(
        sessionId,
        ["hibernated"],
        "creating",
        { error: null, endedAt: null, triggerRunId: null },
      );

      if (!casResult) {
        return { tier: "unavailable", error: "Session is already resuming" };
      }

      try {
        const creds = await resolveSessionCredentials(session);

        await endStaleRuntimes(sessionId);
        const runtime = await createRuntime({
          sessionId,
          restoreSource: "hibernate_snapshot",
          restoreSnapshotId: checkpoint.snapshotId,
        });

        const handle = await tasks.trigger<typeof interactiveSessionTask>(
          "interactive-session",
          {
            sessionId,
            orgId,
            agentType: session.agentType as AgentType,
            agentApiKey: creds.agentApiKey,
            repositoryOwner: creds.repositoryOwner,
            repositoryName: creds.repositoryName,
            defaultBranch: input.branch ?? creds.defaultBranch,
            githubInstallationId: creds.githubInstallationId,
            prompt,
            resumeSdkSessionId: session.sdkSessionId ?? undefined,
            hibernateSnapshotId: checkpoint.snapshotId,
            runtimeId: runtime.id,
            nativeAgentSessionId: session.nativeAgentSessionId ?? undefined,
            extraEnv: extraEnvPayload,
            requestId,
            modeOverride: input.modeOverride,
            model: input.model,
            effortLevel: input.effortLevel,
            modeIntent: input.modeIntent,
          },
          { tags: [`session:${sessionId}`] },
        );

        await updateInteractiveSession(sessionId, { triggerRunId: handle.id });
        const accessToken = await mintRunAccessToken(handle.id);

        return { tier: "hibernate", triggerRunId: handle.id, accessToken };
      } catch (err) {
        const resumeErr = err instanceof Error ? err.message : String(err);
        console.log(`[dispatch] hibernate resume failed for session=${sessionId.slice(0, 8)}: ${resumeErr}`);
        await casSessionStatus(sessionId, ["creating"], "hibernated", {
          error: `Resume failed: ${resumeErr}`,
        });
        return { tier: "unavailable", error: `Failed to resume session: ${resumeErr}` };
      }
    }
    // Checkpoint missing — fall through to cold resume
  }

  // ── Tier 4: Cold resume ──
  if (
    (RESUMABLE_STATUSES.includes(session.status) ||
      session.status === "hibernated") &&
    session.sdkSessionId
  ) {
    const previousStatus = session.status;

    const casResult = await casSessionStatus(
      sessionId,
      [...RESUMABLE_STATUSES, "hibernated"],
      "creating",
      { error: null, endedAt: null, triggerRunId: null },
    );

    if (!casResult) {
      return { tier: "unavailable", error: "Session is already resuming" };
    }

    try {
      const creds = await resolveSessionCredentials(session);

      // Probe sandbox: is it still alive?
      let warmResumeSandboxId: string | undefined;
      let warmResumeSandboxBaseUrl: string | undefined;

      if (session.sandboxId) {
        const alive = await sandboxManager.reconnect(session.sandboxId);
        if (alive && session.sandboxBaseUrl) {
          const healthy = await sandboxManager.isServerHealthy(session.sandboxBaseUrl);
          if (healthy) {
            warmResumeSandboxId = session.sandboxId;
            warmResumeSandboxBaseUrl = session.sandboxBaseUrl;
          }
        }
      }

      await endStaleRuntimes(sessionId);
      const runtime = await createRuntime({
        sessionId,
        restoreSource: warmResumeSandboxId ? "warm_reconnect" : "base_snapshot",
      });

      const handle = await tasks.trigger<typeof interactiveSessionTask>(
        "interactive-session",
        {
          sessionId,
          orgId,
          agentType: session.agentType as AgentType,
          agentApiKey: creds.agentApiKey,
          repositoryOwner: creds.repositoryOwner,
          repositoryName: creds.repositoryName,
          defaultBranch: input.branch ?? creds.defaultBranch,
          githubInstallationId: creds.githubInstallationId,
          prompt,
          resumeSdkSessionId: session.sdkSessionId,
          warmResumeSandboxId,
          warmResumeSandboxBaseUrl,
          runtimeId: runtime.id,
          nativeAgentSessionId: session.nativeAgentSessionId ?? undefined,
          extraEnv: extraEnvPayload,
          requestId,
          modeOverride: input.modeOverride,
          model: input.model,
          effortLevel: input.effortLevel,
          modeIntent: input.modeIntent,
        },
        { tags: [`session:${sessionId}`] },
      );

      await updateInteractiveSession(sessionId, { triggerRunId: handle.id });
      const accessToken = await mintRunAccessToken(handle.id);

      return { tier: "cold", triggerRunId: handle.id, accessToken };
    } catch (err) {
      const resumeErr = err instanceof Error ? err.message : String(err);
      console.log(`[dispatch] cold resume failed for session=${sessionId.slice(0, 8)}: ${resumeErr}`);
      await casSessionStatus(sessionId, ["creating"], previousStatus, {
        error: `Resume failed: ${resumeErr}`,
      });
      return { tier: "unavailable", error: `Failed to resume session: ${resumeErr}` };
    }
  }

  // ── Tier 5: Fresh — brand new session, never started ──
  // The session row exists but no task has ever been triggered for it.
  // This happens when the continuous review router pre-creates the session
  // and the orchestrator dispatches the first prompt.
  if (session.status === "creating" && !session.triggerRunId && !session.sdkSessionId) {
    try {
      const creds = await resolveSessionCredentials(session);

      await endStaleRuntimes(sessionId);
      const runtime = await createRuntime({
        sessionId,
        restoreSource: "fresh",
      });

      const handle = await tasks.trigger<typeof interactiveSessionTask>(
        "interactive-session",
        {
          sessionId,
          orgId,
          agentType: session.agentType as AgentType,
          agentApiKey: creds.agentApiKey,
          repositoryOwner: creds.repositoryOwner,
          repositoryName: creds.repositoryName,
          defaultBranch: input.branch ?? creds.defaultBranch,
          githubInstallationId: creds.githubInstallationId,
          prompt,
          runtimeId: runtime.id,
          extraEnv: extraEnvPayload,
          requestId,
          modeOverride: input.modeOverride,
          model: input.model,
          effortLevel: input.effortLevel,
          modeIntent: input.modeIntent,
        },
        { tags: [`session:${sessionId}`] },
      );

      await updateInteractiveSession(sessionId, { triggerRunId: handle.id });
      const accessToken = await mintRunAccessToken(handle.id);

      return { tier: "fresh", triggerRunId: handle.id, accessToken };
    } catch (err) {
      return { tier: "unavailable", error: `Failed to start session: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Creating/resuming: already starting up (task was triggered but hasn't finished setup) ──
  if (session.status === "creating" || session.status === "resuming") {
    console.log(`[dispatch] session=${sessionId.slice(0, 8)} still starting up (status=${session.status})`);
    return { tier: "unavailable", error: "Session is still starting up, please wait" };
  }

  console.log(
    `[dispatch] no tier matched for session=${sessionId.slice(0, 8)} — ` +
    `status=${session.status} sdkSessionId=${session.sdkSessionId ? "set" : "null"} ` +
    `triggerRunId=${session.triggerRunId?.slice(0, 12) ?? "null"} ` +
    `checkpointId=${session.latestCheckpointId ? "set" : "null"}`,
  );
  return { tier: "unavailable", error: `Session is ${session.status}, cannot send prompt` };
}

// ── Shared helpers ──

/** Mint a public access token scoped to a specific Trigger.dev run. */
export async function mintRunAccessToken(runId: string): Promise<string> {
  return auth.createPublicToken({
    scopes: {
      read: { runs: [runId] },
      write: { inputStreams: [runId] },
    },
    expirationTime: "2h",
  });
}

/** Resolve agent API key + repository details for a session. */
export async function resolveSessionCredentials(session: {
  organizationId: string;
  agentType: string;
  agentSecretId: string | null;
  repositoryId: string | null;
}) {
  let agentApiKey: string | undefined;

  if (session.agentSecretId) {
    const { getDecryptedSecretForOrg } = await import("@/lib/secrets/queries");
    agentApiKey =
      (await getDecryptedSecretForOrg(session.agentSecretId, session.organizationId)) ?? undefined;
  }

  if (!agentApiKey) {
    throw new Error(
      "No agent API key configured. Add one in Settings → Secrets.",
    );
  }

  let repositoryOwner: string | undefined;
  let repositoryName: string | undefined;
  let defaultBranch: string | undefined;
  let githubInstallationId: number | undefined;

  if (session.repositoryId) {
    const { findRepositoryById, findGithubInstallationById } = await import(
      "@/lib/integrations/queries"
    );
    const repo = await findRepositoryById(session.repositoryId);
    if (repo) {
      repositoryOwner = repo.owner;
      repositoryName = repo.name;
      defaultBranch = repo.defaultBranch;
      const installation = await findGithubInstallationById(
        repo.githubInstallationId,
      );
      if (installation) {
        githubInstallationId = installation.installationId;
      }
    }
  }

  if (!repositoryOwner || !repositoryName || !githubInstallationId) {
    throw new Error("Could not resolve repository for resume");
  }

  return {
    agentApiKey,
    repositoryOwner,
    repositoryName,
    defaultBranch,
    githubInstallationId,
  };
}
