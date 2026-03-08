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

    // ── Resolve snapshot (builds one on first use) ──
    metadata.set("setupStep", "Preparing environment...");
    const source = await resolveSnapshotSource(agentType);

    metadata.set("setupStep", "Creating sandbox...");
    logger.info("Creating sandbox", { repoUrl, source: source.type });

    const sandbox = await sandboxManager.create({
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

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);

    // Configure git
    const git = new GitOperations(commands);
    await git.configure({ repoUrl, gitToken });

    try {
      // ── Bootstrap agent (skip install when using snapshot) ──
      const bootstrap = new SandboxAgentBootstrap(sandbox, commands);

      const sessionEnv = buildSessionEnv(agentType, agentApiKey, {
        GITHUB_TOKEN: gitToken,
      });

      if (source.type === "git") {
        await bootstrap.install();
        await bootstrap.installAgent(agentType, sessionEnv);
      }

      const serverUrl = await bootstrap.start(2468, sessionEnv);

      logger.info("Agent server started", { serverUrl });

      await updateInteractiveSession(sessionId, {
        sandboxBaseUrl: serverUrl,
      });

      // ── Connect SDK with persistence ──
      const persist = createPersistDriver();
      const client = await SandboxAgentClient.connect({
        baseUrl: serverUrl,
        persist,
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
      // prompt text and skip duplicates, with a safety limit to avoid
      // infinite spinning if the buffer never clears.
      let shouldContinue = true;
      let lastPromptText = prompt;
      let consecutiveDupes = 0;
      const MAX_CONSECUTIVE_DUPES = 3;

      while (shouldContinue) {
        logger.info("Waiting for next message");

        const message = await sessionMessages.wait({ timeout: "55m" });

        if (!message.ok) {
          logger.info("Session timed out");
          shouldContinue = false;
        } else if (message.output.action === "stop") {
          logger.info("Session stopped by user");
          shouldContinue = false;
        } else if (message.output.action === "prompt") {
          if (message.output.prompt === lastPromptText) {
            consecutiveDupes++;
            logger.info("Skipping duplicate prompt", {
              count: consecutiveDupes,
              max: MAX_CONSECUTIVE_DUPES,
            });
            if (consecutiveDupes >= MAX_CONSECUTIVE_DUPES) {
              logger.warn(
                "Too many duplicate messages from input stream buffer, stopping",
              );
              shouldContinue = false;
            }
            continue;
          }

          consecutiveDupes = 0;
          lastPromptText = message.output.prompt;
          logger.info("Sending follow-up prompt", {
            length: message.output.prompt.length,
          });

          await client.executePrompt(session, message.output.prompt, {
            timeoutMs: 300_000,
            onEvent: (event) => eventForwarder?.(event),
          });

          logger.info("Follow-up prompt completed");
        }
      }

      // ── Cleanup ──
      streamControl.resolve();
      await waitForEventStream();
      await client.dispose();

      metadata.set("status", "stopped");

      await updateInteractiveSession(sessionId, {
        status: "stopped",
        endedAt: new Date(),
      });

      return { ok: true, sessionId };
    } catch (error) {
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
      logger.info("Destroying sandbox");
      await sandboxManager.destroy(sandbox);
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
