import { task, streams, logger, metadata } from "@trigger.dev/sdk/v3";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import {
  SandboxAgentClient,
  type SandboxAgentEvent,
} from "@/lib/sandbox-agent/SandboxAgentClient";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import { createPersistDriver } from "@/lib/sandbox-agent/persist";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { resolveSnapshotSource } from "@/lib/sandbox/snapshots/queries";
import { sessionMessages } from "@/lib/trigger/streams";

export type InteractiveSessionPayload = {
  sessionId: string; // Our interactive_sessions.id
  orgId: string;
  agentType: AgentType;
  agentApiKey: string;
  repositoryOwner: string;
  repositoryName: string;
  defaultBranch?: string;
  githubInstallationId: number;
  prompt: string;
  /** If set, resume the given SDK session instead of creating a new one */
  resumeSdkSessionId?: string;
  /** If set, reconnect to this existing sandbox instead of creating a new one */
  warmResumeSandboxId?: string;
  /** Agent server URL from the previous task (used for warm resume) */
  warmResumeSandboxBaseUrl?: string;
};

const sandboxManager = new SandboxManager();

export const interactiveSessionTask = task({
  id: "interactive-session",
  maxDuration: 3600, // 1 hour max

  onCancel: async () => {
    // Clean up sandbox — the finally block won't run on cancellation
    const sessionId = metadata.get("sessionId") as string | undefined;
    if (!sessionId) return;
    const { getInteractiveSession } = await import("@/lib/sessions/actions");
    const session = await getInteractiveSession(sessionId);
    if (session?.sandboxId) {
      await sandboxManager.destroyById(session.sandboxId);
    }
  },

  run: async (payload: InteractiveSessionPayload, { ctx }) => {
    const {
      sessionId,
      agentType,
      agentApiKey,
      repositoryOwner,
      repositoryName,
      defaultBranch,
      githubInstallationId,
      prompt,
      resumeSdkSessionId,
      warmResumeSandboxId,
      warmResumeSandboxBaseUrl,
    } = payload;

    const isResume = !!resumeSdkSessionId;

    const { updateInteractiveSession } = await import(
      "@/lib/sessions/actions"
    );

    // ── Keep status as "creating" until SDK session is ready ──
    await updateInteractiveSession(sessionId, {
      triggerRunId: ctx.run.id,
      startedAt: new Date(),
    });

    metadata.set("sessionId", sessionId);
    metadata.set("agentType", agentType);

    // ── Mint GitHub token ──
    const { mintInstallationToken } = await import(
      "@/lib/integrations/github"
    );
    const gitToken = await mintInstallationToken(
      githubInstallationId,
      [repositoryName],
      { contents: "write", pull_requests: "write" },
    );

    const repoUrl = `https://github.com/${repositoryOwner}/${repositoryName}.git`;

    // ── Resolve sandbox: warm resume (reconnect) or cold (create new) ──
    // Definite assignment: one of the two branches below always assigns sandbox
    let sandbox!: Awaited<ReturnType<typeof sandboxManager.create>>;
    let isWarmResume = false;
    let serverUrl!: string;

    if (warmResumeSandboxId) {
      metadata.set("setupStep", "Reconnecting to sandbox...");
      const reconnected = await sandboxManager.reconnect(warmResumeSandboxId);

      if (reconnected) {
        sandbox = reconnected;
        isWarmResume = true;
        await sandboxManager.extendTimeout(sandbox, 3600_000);
        logger.info("Warm resume: reconnected to existing sandbox", {
          sandboxId: sandbox.sandboxId,
        });
      }
    }

    if (!isWarmResume) {
      // Cold path: create new sandbox
      metadata.set("setupStep", "Preparing environment...");
      const source = await resolveSnapshotSource(agentType);

      metadata.set("setupStep", "Creating sandbox...");
      logger.info("Creating sandbox", { repoUrl, source: source.type });

      sandbox = await sandboxManager.create({
        source,
        repoUrl,
        gitToken,
        baseBranch: defaultBranch ?? "main",
        timeoutMs: 3600_000,
        ports: [2468],
      });

      logger.info("Sandbox created", { sandboxId: sandbox.sandboxId });

      await updateInteractiveSession(sessionId, {
        sandboxId: sandbox.sandboxId,
      });
    }

    // ── Heartbeat: extend sandbox timeout periodically ──
    const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1000;
    const HEARTBEAT_EXTEND_MS = 30 * 60 * 1000;
    const heartbeat = setInterval(async () => {
      await sandboxManager.extendTimeout(sandbox, HEARTBEAT_EXTEND_MS);
    }, HEARTBEAT_INTERVAL_MS);

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    // Track why the task exits to decide sandbox fate
    let exitReason: "idle_timeout" | "user_stop" | "error" = "idle_timeout";

    try {
      if (isWarmResume) {
        // Warm resume: agent server is already running, just reconfigure git auth
        await git.configure({ repoUrl, gitToken });
        serverUrl = warmResumeSandboxBaseUrl!;
        logger.info("Warm resume: reusing agent server", { serverUrl });
      } else {
        // Cold path: full bootstrap
        await git.configure({ repoUrl, gitToken });

        const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

        const sessionEnv = buildSessionEnv(agentType, agentApiKey, {
          GITHUB_TOKEN: gitToken,
        });

        // Snapshot source — agent already installed; git source — need full install
        const source = await resolveSnapshotSource(agentType);
        if (source.type === "git") {
          await bootstrap.install();
          await bootstrap.installAgent(agentType, sessionEnv);
        }

        serverUrl = await bootstrap.start(2468, sessionEnv);

        logger.info("Agent server started", { serverUrl });

        await updateInteractiveSession(sessionId, {
          sandboxBaseUrl: serverUrl,
        });
      }

      // ── Connect SDK with persistence ──
      const persist = createPersistDriver();
      const client = await SandboxAgentClient.connect({
        baseUrl: serverUrl,
        persist,
        ...(isResume && !isWarmResume
          ? { replayMaxEvents: 200, replayMaxChars: 50_000 }
          : {}),
      });

      const defaultMode =
        agentType === "codex" ? "full-access" : "bypassPermissions";

      const sessionConfig = {
        agent: agentType,
        mode: defaultMode,
        cwd: SandboxManager.PROJECT_DIR,
      };

      let session: Awaited<ReturnType<typeof client.createSession>>;

      if (isResume) {
        // Resume: replay persisted events as context, then send the new prompt
        logger.info("Resuming session", { sdkSessionId: resumeSdkSessionId });
        session = await client.resumeSession(resumeSdkSessionId, sessionConfig);
      } else {
        session = await client.createSession(sessionConfig);
      }

      logger.info(isResume ? "Session resumed" : "Session created", {
        sdkSessionId: session.id,
      });

      // Mark as active now that the SDK session exists
      await updateInteractiveSession(sessionId, {
        status: "active",
        sdkSessionId: session.id,
      });

      metadata.set("status", "active");
      metadata.set("sdkSessionId", session.id);

      // ── Event stream bridge — forwards onEvent callbacks to output stream ──
      let eventForwarder: ((event: SandboxAgentEvent) => void) | null = null;
      const streamControl = { resolve: () => {} };
      const streamDone = new Promise<void>((r) => {
        streamControl.resolve = r;
      });

      const { waitUntilComplete: waitForEventStream } = streams.writer(
        "events",
        {
          execute: async ({ write }) => {
            eventForwarder = (event) => write(event);
            await streamDone;
          },
        },
      );

      // ── Send initial/resume prompt ──
      logger.info("Sending prompt", { length: prompt.length, isResume });

      await client.executePrompt(session, prompt, {
        timeoutMs: 300_000,
        onEvent: (event) => eventForwarder?.(event),
      });

      logger.info("Prompt completed");

      // ── Wait loop: accept follow-up prompts via input stream ──
      // NOTE: input stream .wait() may return a stale buffered value
      // repeatedly (the buffer isn't cleared on read). We track the last
      // prompt text and skip duplicates silently.
      let shouldContinue = true;
      let lastPromptText = prompt;

      while (shouldContinue) {
        logger.info("Waiting for next message");

        const message = await sessionMessages.wait({ timeout: "55m" });

        if (!message.ok) {
          logger.info("Session timed out — entering idle for warm resume");
          exitReason = "idle_timeout";
          shouldContinue = false;
        } else if (message.output.action === "stop") {
          logger.info("Session stopped by user");
          exitReason = "user_stop";
          shouldContinue = false;
        } else if (message.output.action === "prompt") {
          if (message.output.prompt === lastPromptText) {
            // Stale buffer — throttle to avoid busy-spinning
            await new Promise((r) => setTimeout(r, 2000));
            continue;
          }

          lastPromptText = message.output.prompt;
          logger.info("Sending follow-up prompt", {
            length: message.output.prompt.length,
          });

          await client.executePrompt(session, message.output.prompt, {
            timeoutMs: 300_000,
            onEvent: (event) => eventForwarder?.(event),
          });

          logger.info("Follow-up prompt completed");
        } else if (message.output.action === "permission_reply") {
          logger.info("Replying to permission", {
            permissionId: message.output.permissionId,
            reply: message.output.reply,
          });
          await client.replyPermission(
            session,
            message.output.permissionId,
            message.output.reply,
          );
        } else if (message.output.action === "question_reply") {
          logger.info("Replying to question", {
            questionId: message.output.questionId,
          });
          await client.replyQuestion(
            session,
            message.output.questionId,
            message.output.answers,
          );
        } else if (message.output.action === "question_reject") {
          logger.info("Rejecting question", {
            questionId: message.output.questionId,
          });
          await client.rejectQuestion(session, message.output.questionId);
        }
      }

      // ── Cleanup ──
      streamControl.resolve();
      await waitForEventStream();
      await client.dispose();

      if (exitReason === "user_stop") {
        metadata.set("status", "stopped");
        await updateInteractiveSession(sessionId, {
          status: "stopped",
          endedAt: new Date(),
        });
      } else {
        // idle_timeout — status set in finally block
        metadata.set("status", "idle");
      }

      return { ok: true, sessionId };
    } catch (error) {
      exitReason = "error";
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Session failed", { error: message });

      metadata.set("status", "failed");

      await updateInteractiveSession(sessionId, {
        status: "failed",
        error: message,
        endedAt: new Date(),
      });

      throw error;
    } finally {
      clearInterval(heartbeat);

      if (exitReason === "idle_timeout") {
        // Keep sandbox alive for warm resume
        logger.info("Keeping sandbox alive for warm resume", {
          gracePeriodMs: SandboxManager.IDLE_GRACE_PERIOD_MS,
        });
        await sandboxManager.extendTimeout(
          sandbox,
          SandboxManager.IDLE_GRACE_PERIOD_MS,
        );
        await updateInteractiveSession(sessionId, {
          status: "idle",
          triggerRunId: null,
          endedAt: new Date(),
        });
      } else {
        logger.info("Destroying sandbox");
        await sandboxManager.destroy(sandbox);
      }
    }
  },

  onFailure: async ({ payload: rawPayload }) => {
    // Runs when task is killed by maxDuration, cancellation, unhandled crash, etc.
    // The finally block may not execute in these cases, so ensure both
    // DB and sandbox are cleaned up.
    const payload = rawPayload as unknown as InteractiveSessionPayload;
    const { updateInteractiveSession, getInteractiveSession } = await import(
      "@/lib/sessions/actions"
    );

    // Stop the sandbox if it's still running
    const session = await getInteractiveSession(payload.sessionId);
    if (session?.sandboxId) {
      await sandboxManager.destroyById(session.sandboxId);
    }

    await updateInteractiveSession(payload.sessionId, {
      status: "failed",
      error: "Session terminated unexpectedly",
      endedAt: new Date(),
    });
  },
});
