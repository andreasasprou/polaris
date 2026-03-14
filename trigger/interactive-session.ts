import { task, streams, logger, metadata } from "@trigger.dev/sdk/v3";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { SandboxCommands } from "@/lib/sandbox/SandboxCommands";
import { GitOperations } from "@/lib/sandbox/GitOperations";
import { SandboxHealthMonitor, SandboxUnreachableError } from "@/lib/sandbox/SandboxHealthMonitor";
import { SandboxAgentBootstrap } from "@/lib/sandbox-agent/SandboxAgentBootstrap";
import {
  SandboxAgentClient,
  type AgentSession,
  type SandboxAgentEvent,
} from "@/lib/sandbox-agent/SandboxAgentClient";
import { buildSessionEnv } from "@/lib/sandbox-agent/credentials";
import { createPersistDriver } from "@/lib/sandbox-agent/persist";
import type { AgentType } from "@/lib/sandbox-agent/types";
import { resolveAgentConfig, applyFilesystemConfig } from "@/lib/sandbox-agent/agent-profiles";
import { resolveSnapshotSource } from "@/lib/sandbox/snapshots/queries";
import { sessionMessages } from "@/lib/trigger/streams";

export type InteractiveSessionPayload = {
  sessionId: string;
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
  /** Snapshot to restore from (hibernate resume) */
  hibernateSnapshotId?: string;
  /** Runtime ID to record in the runtimes table */
  runtimeId?: string;
  /** Native agent session ID for native resume (claude --resume, codex resume) */
  nativeAgentSessionId?: string;
  /** Org-level env vars to inject into the sandbox (decrypted at caller) */
  extraEnv?: Record<string, string>;
  /** Request ID for turn tracking (set by orchestrator for turn completion handshake) */
  requestId?: string;
  /** Agent-native mode override (e.g. "dontAsk", "read-only"). Resolved by agent-profiles. */
  modeOverride?: string;
  /** Agent model (e.g. "opus", "gpt-5.3-codex"). */
  model?: string;
  /** Effort / thought level (e.g. "low", "medium", "high", "max"). */
  effortLevel?: import("@/lib/sandbox-agent/agent-profiles").EffortLevel;
  /** Semantic mode intent — determines permissions scope. Defaults to "autonomous". */
  modeIntent?: "autonomous" | "read-only" | "interactive";
};

const sandboxManager = new SandboxManager();

/** How long to keep sandbox alive in warm-wait for quick resume */
const WARM_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

export const interactiveSessionTask = task({
  id: "interactive-session",
  maxDuration: 3600, // 1 hour max

  onCancel: async () => {
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
      hibernateSnapshotId,
      runtimeId,
      nativeAgentSessionId,
      extraEnv,
      requestId: payloadRequestId,
    } = payload;

    const isResume = !!resumeSdkSessionId;

    const {
      updateInteractiveSession,
      casSessionStatus,
      updateRuntime,
      hibernateSession,
      createTurn,
      completeTurn,
      failTurn,
    } = await import("@/lib/sessions/actions");

    // ── Turn tracking ──
    // Each prompt→response cycle is tracked as a "turn" for the orchestrator
    // to poll for completion. The initial prompt's requestId comes from the
    // payload; follow-up prompts use nonce or requestId from the input stream.
    let currentTurnRequestId: string | null = null;

    /** Record a completed turn in DB + Trigger.dev metadata. */
    const recordTurnCompleted = async (
      turnRequestId: string,
      result: { output?: string; lastMessage?: string },
      timing?: { durationMs: number; promptLength: number; source: string },
    ) => {
      currentTurnRequestId = null;
      // Prefer lastMessage (final agent response after last tool call)
      // for the DB finalMessage — it's cleaner for orchestrator parsing.
      // Fall back to full output if lastMessage isn't available.
      const finalMsg = result.lastMessage ?? result.output;
      await completeTurn(turnRequestId, sessionId, {
        finalMessage: finalMsg?.slice(0, 50_000),
        metadata: timing ?? undefined,
      });
      metadata.set(`turnResult:${turnRequestId}`, JSON.stringify({
        status: "completed",
        output: finalMsg?.slice(0, 4000),
        success: true,
      }));
    };

    /** Record a failed turn in DB + Trigger.dev metadata. */
    const recordTurnFailed = async (turnRequestId: string, error: string) => {
      currentTurnRequestId = null;
      await failTurn(turnRequestId, sessionId, error);
      metadata.set(`turnResult:${turnRequestId}`, JSON.stringify({
        status: "failed",
        error: error.slice(0, 4000),
        success: false,
      }));
    };

    // Helper: update runtime if it exists (runtimeId is optional in payload)
    const setRuntime = async (fields: Parameters<typeof updateRuntime>[1]) => {
      if (runtimeId) await updateRuntime(runtimeId, fields);
    };

    await updateInteractiveSession(sessionId, {
      triggerRunId: ctx.run.id,
      startedAt: new Date(),
    });

    await setRuntime({ triggerRunId: ctx.run.id });

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

    // ── Resolve sandbox: warm resume → hibernate resume → cold create ──
    let sandbox!: Awaited<ReturnType<typeof sandboxManager.create>>;
    let isWarmResume = false;
    let serverUrl!: string;

    if (warmResumeSandboxId) {
      // Warm resume: reconnect to existing sandbox + running server
      metadata.set("setupStep", "Reconnecting to sandbox...");
      const reconnected = await sandboxManager.reconnect(warmResumeSandboxId);

      if (reconnected && warmResumeSandboxBaseUrl) {
        const healthy = await sandboxManager.isServerHealthy(
          warmResumeSandboxBaseUrl,
        );
        if (healthy) {
          sandbox = reconnected;
          isWarmResume = true;
          serverUrl = warmResumeSandboxBaseUrl;
          await sandboxManager.extendTimeout(sandbox, 3600_000);
          logger.info("Warm resume: reconnected", {
            sandboxId: sandbox.sandboxId,
          });
        }
      }
    }

    if (!isWarmResume && hibernateSnapshotId) {
      // Hibernate resume: restore from snapshot
      metadata.set("setupStep", "Restoring from snapshot...");
      logger.info("Hibernate resume: creating sandbox from snapshot", {
        snapshotId: hibernateSnapshotId,
      });

      sandbox = await sandboxManager.createFromSnapshot({
        snapshotId: hibernateSnapshotId,
        gitToken,
        timeoutMs: 3600_000,
        ports: [2468],
      });

      logger.info("Sandbox restored from snapshot", {
        sandboxId: sandbox.sandboxId,
      });

      await updateInteractiveSession(sessionId, {
        sandboxId: sandbox.sandboxId,
      });

      await setRuntime({ sandboxId: sandbox.sandboxId });
    }

    // Resolved once on cold path and reused for both sandbox creation and bootstrap
    let snapshotSource: Awaited<ReturnType<typeof resolveSnapshotSource>> | null = null;

    if (!isWarmResume && !hibernateSnapshotId) {
      // Cold path: create new sandbox
      metadata.set("setupStep", "Preparing environment...");
      snapshotSource = await resolveSnapshotSource(agentType);

      metadata.set("setupStep", "Creating sandbox...");
      logger.info("Creating sandbox", { repoUrl, source: snapshotSource.type });

      sandbox = await sandboxManager.create({
        source: snapshotSource,
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

      await setRuntime({ sandboxId: sandbox.sandboxId });
    }

    // ── Heartbeat: extend sandbox timeout periodically ──
    const HEARTBEAT_INTERVAL_MS = 20 * 60 * 1000;
    const HEARTBEAT_EXTEND_MS = 30 * 60 * 1000;
    let heartbeat: ReturnType<typeof setInterval> = setInterval(async () => {
      await sandboxManager.extendTimeout(sandbox, HEARTBEAT_EXTEND_MS);
    }, HEARTBEAT_INTERVAL_MS);

    const commands = new SandboxCommands(sandbox, SandboxManager.PROJECT_DIR);
    const git = new GitOperations(commands);

    let exitReason: "idle_timeout" | "user_stop" | "error" = "idle_timeout";

    try {
      if (isWarmResume) {
        // Warm resume: server already running, refresh git token via networkPolicy
        await sandboxManager.updateGitToken(sandbox, gitToken);
        await git.configure({ repoUrl });
        logger.info("Warm resume: reusing agent server", { serverUrl });
      } else {
        // Cold or hibernate path: full or partial bootstrap
        await git.configure({ repoUrl });

        if (hibernateSnapshotId) {
          // Hibernate resume: server binary is in snapshot, just restart it
          metadata.set("setupStep", "Starting agent server...");
          const bootstrap = new SandboxAgentBootstrap(sandbox, commands);
          const rawEnv = buildSessionEnv(agentType, agentApiKey, extraEnv);
          const sessionEnv = await bootstrap.provisionCredentialFiles(rawEnv);
          serverUrl = await bootstrap.start(2468, sessionEnv);
        } else {
          // Cold start: full bootstrap
          const bootstrap = new SandboxAgentBootstrap(sandbox, commands);
          const rawEnv = buildSessionEnv(agentType, agentApiKey, extraEnv);
          const sessionEnv = await bootstrap.provisionCredentialFiles(rawEnv);

          if (snapshotSource!.type === "git") {
            await bootstrap.install();
            await bootstrap.installAgent(agentType, sessionEnv);
          }

          serverUrl = await bootstrap.start(2468, sessionEnv);
        }

        logger.info("Agent server started", { serverUrl });

        await updateInteractiveSession(sessionId, {
          sandboxBaseUrl: serverUrl,
        });

        await setRuntime({ sandboxBaseUrl: serverUrl });
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

      const resolved = resolveAgentConfig({
        agentType,
        modeIntent: payload.modeIntent ?? "autonomous",
        modeOverride: payload.modeOverride,
        model: payload.model,
        effortLevel: payload.effortLevel,
      });

      // Write filesystem config (e.g. .claude/settings.json) if needed
      if (resolved.filesystemConfig) {
        await applyFilesystemConfig(
          (cmd, opts) => commands.runShell(cmd, opts),
          SandboxManager.PROJECT_DIR,
          resolved.filesystemConfig,
        );
      }

      const sessionConfig = {
        agent: resolved.agent,
        model: resolved.model,
        mode: resolved.mode,
        thoughtLevel: resolved.thoughtLevel,
        cwd: SandboxManager.PROJECT_DIR,
      };

      let session: AgentSession | undefined;
      let usedNativeResume = false;

      if (isResume && !isWarmResume) {
        // Try native resume first on hibernate path (preserves full agent state)
        if (hibernateSnapshotId && nativeAgentSessionId) {
          const nativeSession = await client.nativeResumeSession(
            nativeAgentSessionId,
            { ...sessionConfig, serverUrl },
          );
          if (nativeSession) {
            session = nativeSession;
            usedNativeResume = true;
            logger.info("Native session resumed", {
              nativeSessionId: nativeAgentSessionId,
            });
          }
        }

        // Fallback: text replay (cold resume or native resume failed/unavailable)
        if (!usedNativeResume) {
          logger.info("Resuming session via text replay", {
            sdkSessionId: resumeSdkSessionId,
          });
          session = await client.resumeSession(
            resumeSdkSessionId!,
            sessionConfig,
          );
        }
      } else if (isWarmResume) {
        // Warm resume: reconnect to existing session (still in server memory)
        logger.info("Reconnecting to warm session", {
          sdkSessionId: resumeSdkSessionId,
        });
        session = await client.resumeSession(
          resumeSdkSessionId!,
          sessionConfig,
        );
      } else {
        session = await client.createSession(sessionConfig);
      }

      // session is always assigned by one of the branches above
      const activeSession = session!;

      logger.info(isResume ? "Session resumed" : "Session created", {
        sdkSessionId: activeSession.id,
      });

      // Mark as active + capture native agent session ID for future resume.
      // On native resume, keep the original sdkSessionId so history events
      // (stored in sandbox_agent.events under that ID) remain accessible.
      const sdkId = usedNativeResume ? undefined : activeSession.id;
      await updateInteractiveSession(sessionId, {
        status: "active",
        ...(sdkId ? { sdkSessionId: sdkId } : {}),
        ...(!isResume
          ? {
              nativeAgentSessionId: activeSession.agentSessionId,
              cwd: SandboxManager.PROJECT_DIR,
            }
          : {}),
      });

      await setRuntime({ sdkSessionId: sdkId ?? activeSession.id, status: "running" });

      metadata.set("status", "active");
      metadata.set("sdkSessionId", sdkId ?? activeSession.id);
      metadata.del("setupStep");

      // ── Event stream bridge ──
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

      // When using native resume, events bypass the SDK's persist layer.
      // We must: (1) assign proper eventIndex (offset past existing events)
      // so the stream and DB use consistent indices, and (2) persist to
      // sandbox_agent.events so page refresh recovery works.
      const persistSdkSessionId = resumeSdkSessionId ?? activeSession.id;
      let nativeEventIndex = 0;

      if (usedNativeResume) {
        const existingEvents = await persist.listEvents({
          sessionId: persistSdkSessionId,
          limit: 10000,
        });
        if (existingEvents.items.length > 0) {
          const maxIdx = Math.max(...existingEvents.items.map((e) => e.eventIndex));
          nativeEventIndex = maxIdx + 1;
        }
      }

      /** Process an event: assign proper index for native resume, forward to stream, persist if needed. */
      const processEvent = (event: SandboxAgentEvent) => {
        if (usedNativeResume) {
          const idx = nativeEventIndex++;
          const indexed = { ...event, eventIndex: idx };
          eventForwarder?.(indexed);
          persist.insertEvent({
            id: `${persistSdkSessionId}-nr-${idx}`,
            eventIndex: idx,
            sessionId: persistSdkSessionId,
            createdAt: Date.now(),
            connectionId: `native-${ctx.run.id}`,
            sender: event.sender as "client" | "agent",
            payload: event.payload as import("acp-http-client").AnyMessage,
          });
        } else {
          eventForwarder?.(event);
        }
      };

      /**
       * For native resume, onEnvelope only captures inbound (agent→client) messages.
       * The user's prompt (client→agent) is never emitted. Emit a synthetic prompt
       * event so it appears in the chat transcript at the correct position.
       */
      const emitPromptEvent = (text: string) => {
        if (!usedNativeResume) return;
        processEvent({
          eventIndex: 0, // re-assigned by processEvent
          sender: "client",
          payload: {
            method: "session/prompt",
            params: { prompt: [{ type: "text", text }] },
          } as Record<string, unknown>,
        });
      };

      // ── Sandbox health monitor ──
      // Periodically checks server liveness. If the sandbox dies mid-prompt,
      // the monitor's signal aborts executePrompt instead of hanging forever.
      const healthMonitor = new SandboxHealthMonitor(serverUrl);
      healthMonitor.start();

      // ── Send initial/resume prompt ──
      logger.info("Sending prompt", { length: prompt.length, isResume });

      // Track initial turn (requestId comes from payload if set by orchestrator)
      const initialRequestId = payloadRequestId ?? `initial-${ctx.run.id}`;
      currentTurnRequestId = initialRequestId;
      await createTurn({
        sessionId,
        requestId: initialRequestId,
        runtimeId,
        source: payloadRequestId ? "automation" : "user",
        prompt,
      });

      emitPromptEvent(prompt);
      const promptStart = Date.now();
      const initialResult = await client.executePrompt(activeSession, prompt, {
        timeoutMs: 1_200_000,
        signal: healthMonitor.signal,
        onEvent: processEvent,
      });

      await recordTurnCompleted(initialRequestId, initialResult, {
        durationMs: Date.now() - promptStart,
        promptLength: prompt.length,
        source: payloadRequestId ? "automation" : "user",
      });
      logger.info("Prompt completed");

      // ── HITL + stop handler via .on() ──
      // Handles permission/question replies immediately during follow-up executePrompt() calls.
      // Also captures stop requests — when .on() is active and no .once() waiter exists,
      // messages are consumed by .on() and NOT buffered for the next .once().
      // The stopRequested flag ensures stop isn't silently dropped.
      let stopRequested = false;
      const hitlHandler = (msg: import("@/lib/trigger/types").SessionMessage) => {
        if (msg.action === "stop") {
          logger.info("Stop requested via .on() handler");
          stopRequested = true;
        } else if (msg.action === "permission_reply") {
          logger.info("Replying to permission", { permissionId: msg.permissionId });
          client.replyPermission(activeSession, msg.permissionId, msg.reply);
        } else if (msg.action === "question_reply") {
          logger.info("Replying to question", { questionId: msg.questionId });
          client.replyQuestion(activeSession, msg.questionId, msg.answers);
        } else if (msg.action === "question_reject") {
          logger.info("Rejecting question", { questionId: msg.questionId });
          client.rejectQuestion(activeSession, msg.questionId);
        }
      };

      let inputStreamSub = sessionMessages.on(hitlHandler);

      // ── Two-phase idle loop ──
      // Phase 1 (warm): .once() keeps process alive for instant response (2 min)
      // Phase 2 (suspend): .wait() suspends process, frees compute ($0 cost)
      // See: docs/architecture/two-phase-waiting.md
      let shouldContinue = true;

      while (shouldContinue) {
        // ── Phase 1: Warm wait (.once(), instant response) ──
        metadata.set("status", "warm");
        await updateInteractiveSession(sessionId, { status: "warm" });
        await setRuntime({ status: "warm" });

        logger.info("Entering warm wait", { timeoutMs: WARM_TIMEOUT_MS });

        const warmResult = await sessionMessages.once({
          timeoutMs: WARM_TIMEOUT_MS,
        });

        if (warmResult.ok) {
          const msg = warmResult.output;

          // HITL messages are already handled by .on() — skip them
          if (msg.action !== "prompt" && msg.action !== "stop") {
            continue;
          }

          if (msg.action === "stop") {
            logger.info("Session stopped by user (warm phase)");
            exitReason = "user_stop";
            shouldContinue = false;
            break;
          }

          // Prompt received during warm wait — instant response
          logger.info("Warm resume: message received", { length: msg.prompt.length });

          const warmRequestId = msg.requestId ?? msg.nonce;
          currentTurnRequestId = warmRequestId;
          await createTurn({
            sessionId,
            requestId: warmRequestId,
            runtimeId,
            source: msg.requestId ? "automation" : "user",
            prompt: msg.prompt,
          });

          metadata.set("status", "active");
          await updateInteractiveSession(sessionId, { status: "active" });
          await setRuntime({ status: "running" });

          emitPromptEvent(msg.prompt);
          const warmPromptStart = Date.now();
          const warmExecResult = await client.executePrompt(activeSession, msg.prompt, {
            timeoutMs: 1_200_000,
            signal: healthMonitor.signal,
            onEvent: processEvent,
          });

          await recordTurnCompleted(warmRequestId, warmExecResult, {
            durationMs: Date.now() - warmPromptStart,
            promptLength: msg.prompt.length,
            source: msg.requestId ? "automation" : "user",
          });
          logger.info("Follow-up prompt completed");

          // Check if stop was received during executePrompt
          if (stopRequested) {
            logger.info("Stop received during prompt execution (warm)");
            exitReason = "user_stop";
            shouldContinue = false;
            break;
          }

          continue; // back to warm wait
        }

        // ── Phase 2: Suspend (.wait(), frees compute) ──
        // Warm timeout expired — no message arrived. Suspend the task process.
        // The sandbox stays alive (extended timeout), but we free compute.
        logger.info("Warm window expired — suspending task");

        clearInterval(heartbeat);
        healthMonitor.stop(); // No sandbox interaction during suspend
        await sandboxManager.extendTimeout(sandbox, 60 * 60_000); // 60 min buffer
        inputStreamSub.off(); // .on() handlers don't fire during suspend anyway

        metadata.set("status", "suspended");
        await updateInteractiveSession(sessionId, { status: "suspended" });
        await setRuntime({ status: "suspended" });

        const suspendResult = await sessionMessages.wait({ timeout: "53m" });

        // ── Resumed from suspend ──
        if (suspendResult.ok) {
          const msg = suspendResult.output;
          logger.info("Resumed from suspend", { action: msg.action });

          // Re-register HITL handler
          inputStreamSub = sessionMessages.on(hitlHandler);

          // Restart heartbeat + health monitor
          heartbeat = setInterval(async () => {
            await sandboxManager.extendTimeout(sandbox, HEARTBEAT_EXTEND_MS);
          }, HEARTBEAT_INTERVAL_MS);
          healthMonitor.start();

          // Refresh git token via networkPolicy (may have expired during suspend)
          const freshGitToken = await mintInstallationToken(
            githubInstallationId,
            [repositoryName],
            { contents: "write", pull_requests: "write" },
          );
          await sandboxManager.updateGitToken(sandbox, freshGitToken);

          // HITL messages — skip (shouldn't arrive during suspend, but handle gracefully)
          if (msg.action !== "prompt" && msg.action !== "stop") {
            continue;
          }

          if (msg.action === "stop") {
            logger.info("Session stopped by user (suspend phase)");
            exitReason = "user_stop";
            shouldContinue = false;
            break;
          }

          // Prompt — back to active
          logger.info("Processing prompt after suspend resume", { length: msg.prompt.length });

          const suspendRequestId = msg.requestId ?? msg.nonce;
          currentTurnRequestId = suspendRequestId;
          await createTurn({
            sessionId,
            requestId: suspendRequestId,
            runtimeId,
            source: msg.requestId ? "automation" : "user",
            prompt: msg.prompt,
          });

          metadata.set("status", "active");
          await updateInteractiveSession(sessionId, { status: "active" });
          await setRuntime({ status: "running" });

          emitPromptEvent(msg.prompt);
          const suspendPromptStart = Date.now();
          const suspendExecResult = await client.executePrompt(activeSession, msg.prompt, {
            timeoutMs: 1_200_000,
            signal: healthMonitor.signal,
            onEvent: processEvent,
          });

          await recordTurnCompleted(suspendRequestId, suspendExecResult, {
            durationMs: Date.now() - suspendPromptStart,
            promptLength: msg.prompt.length,
            source: msg.requestId ? "automation" : "user",
          });
          logger.info("Follow-up prompt completed (post-suspend)");

          // Check if stop was received during executePrompt
          if (stopRequested) {
            logger.info("Stop received during prompt execution (post-suspend)");
            exitReason = "user_stop";
            shouldContinue = false;
            break;
          }

          continue; // back to warm wait
        }

        // Suspend timed out — no message for ~55 min total. Hibernate.
        logger.info("Suspend timeout expired — hibernating");
        exitReason = "idle_timeout";
        shouldContinue = false;
      }

      inputStreamSub.off();
      healthMonitor.stop();

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
        await setRuntime({ status: "stopped", endedAt: new Date() });
      }
      // idle_timeout handled in finally block (hibernation sequence)

      return { ok: true, sessionId };
    } catch (error) {
      exitReason = "error";
      const isSandboxDead = error instanceof SandboxUnreachableError;
      const message = error instanceof Error ? error.message : String(error);
      logger.error(
        `${isSandboxDead ? "Sandbox became unreachable" : "Session failed"}: ${message} ` +
        `(sessionId=${sessionId.slice(0, 8)})`,
      );

      // Fail the active turn if one was in progress
      if (currentTurnRequestId) {
        await recordTurnFailed(currentTurnRequestId, message).catch(() => {});
      }

      metadata.set("status", "failed");

      await updateInteractiveSession(sessionId, {
        status: "failed",
        error: isSandboxDead
          ? "Agent sandbox became unreachable — the session has ended."
          : message,
        endedAt: new Date(),
      });

      await setRuntime({ status: "failed", endedAt: new Date() });

      throw error;
    } finally {
      clearInterval(heartbeat);

      if (exitReason === "idle_timeout") {
        // ── Hibernation sequence ──
        // CAS to hibernating (may fail if another process already handled it)
        const casResult = await casSessionStatus(
          sessionId,
          ["suspended"],
          "hibernating",
        );

        if (!casResult) {
          logger.info("CAS to hibernating failed — another process handled it");
          return;
        }

        metadata.set("status", "hibernating");

        // Step 1: Credential scrubbing
        const scrubOk = await sandboxManager.scrubCredentials(sandbox);
        if (!scrubOk) {
          logger.error("Credential scrubbing failed");
          await sandboxManager.destroy(sandbox);
          await casSessionStatus(sessionId, ["hibernating"], "stopped", {
            endedAt: new Date(),
          });
          await setRuntime({ status: "stopped", endedAt: new Date() });
          return;
        }

        // Step 2: Snapshot (stops the sandbox automatically)
        const snapshotResult = await sandboxManager.snapshot(sandbox);
        if (!snapshotResult) {
          logger.error("Snapshot failed");
          await sandboxManager.destroy(sandbox); // May be redundant
          await casSessionStatus(sessionId, ["hibernating"], "stopped", {
            endedAt: new Date(),
          });
          await setRuntime({ status: "stopped", endedAt: new Date() });
          return;
        }

        logger.info("Snapshot created", {
          snapshotId: snapshotResult.snapshotId,
          sizeBytes: snapshotResult.sizeBytes,
        });

        // Step 3: DB transaction (checkpoint + session + runtime)
        if (!runtimeId) {
          logger.error("Cannot hibernate: runtimeId is missing");
          await sandboxManager.destroy(sandbox);
          await casSessionStatus(sessionId, ["hibernating"], "stopped", {
            endedAt: new Date(),
          });
          return;
        }

        try {
          await hibernateSession({
            sessionId,
            runtimeId,
            snapshotId: snapshotResult.snapshotId,
            sizeBytes: snapshotResult.sizeBytes,
          });

          metadata.set("status", "hibernated");
          logger.info("Session hibernated successfully");
        } catch (dbError) {
          // Orphan snapshot — snapshot exists in Vercel but DB write failed
          logger.error(
            `Hibernate DB transaction failed — orphan snapshot ` +
            `(snapshotId=${snapshotResult.snapshotId}): ${dbError instanceof Error ? dbError.message : String(dbError)}`,
          );

          await casSessionStatus(sessionId, ["hibernating"], "stopped", {
            endedAt: new Date(),
          });
          await setRuntime({ status: "stopped", endedAt: new Date() });
        }
      } else {
        // user_stop or error: destroy sandbox
        logger.info("Destroying sandbox", { exitReason });
        await sandboxManager.destroy(sandbox);
      }
    }
  },

  onFailure: async ({ payload: rawPayload, error }) => {
    const payload = rawPayload as unknown as InteractiveSessionPayload;
    const failureMsg = error instanceof Error ? error.message
      : typeof error === "object" && error !== null && "message" in error
        ? String((error as Record<string, unknown>).message)
        : String(error);
    console.log(
      `[onFailure] session=${payload.sessionId.slice(0, 8)} ` +
      `runtimeId=${payload.runtimeId?.slice(0, 8) ?? "null"}: ${failureMsg}`,
    );

    const {
      updateInteractiveSession,
      getInteractiveSession,
      updateRuntime,
      createTurn,
      failTurn,
    } = await import("@/lib/sessions/actions");

    const session = await getInteractiveSession(payload.sessionId);
    if (session?.sandboxId) {
      await sandboxManager.destroyById(session.sandboxId);
    }

    await updateInteractiveSession(payload.sessionId, {
      status: "failed",
      error: `Session terminated unexpectedly: ${failureMsg}`,
      endedAt: new Date(),
    });

    if (payload.runtimeId) {
      await updateRuntime(payload.runtimeId, {
        status: "failed",
        endedAt: new Date(),
      });
    }

    // Write a failed turn so the orchestrator's waitForTurnCompletion() unblocks
    // instead of polling for 25 min on a turn that will never arrive.
    // If run() already created the turn (crash happened later), createTurn will
    // throw a unique constraint violation — catch it and just failTurn.
    if (payload.requestId) {
      try {
        await createTurn({
          sessionId: payload.sessionId,
          requestId: payload.requestId,
          runtimeId: payload.runtimeId,
          source: "automation",
          prompt: "",
        });
      } catch {
        // Turn already exists from run() — that's fine, we'll fail it below
      }
      await failTurn(payload.requestId, payload.sessionId, failureMsg);
    }
  },
});
