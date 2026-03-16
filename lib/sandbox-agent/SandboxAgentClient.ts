import { SandboxAgent, type SessionPersistDriver } from "sandbox-agent";
import { AcpHttpClient } from "acp-http-client";
import type { AnyMessage } from "acp-http-client";
import type { AgentType, AgentResult } from "./types";

type PromptContentPart = { type: "text"; text: string };

type SessionConfig = {
  agent: AgentType;
  model?: string;
  mode?: string;
  thoughtLevel?: string;
  cwd: string;
};

type ConnectOptions = {
  baseUrl: string;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
  /** Timeout (ms) for the SDK health wait gate. Default: 30 000. */
  healthTimeoutMs?: number;
  /** Abort signal — aborts connection if the sandbox dies during connect. */
  signal?: AbortSignal;
};

type ExecuteOptions = {
  onEvent?: (event: SandboxAgentEvent) => void;
  timeoutMs?: number;
  /** External abort signal — e.g. from SandboxHealthMonitor. */
  signal?: AbortSignal;
};

export type SandboxAgentEvent = {
  eventIndex: number;
  sender: string;
  payload: Record<string, unknown>;
};

type SandboxAgentSession = Awaited<ReturnType<SandboxAgent["createSession"]>>;

/**
 * Minimal session interface used by executePrompt and HITL methods.
 * Both SDK Session and NativeResumedSession satisfy this.
 */
export type AgentSession = {
  id: string;
  agentSessionId: string;
  onEvent(listener: (event: SandboxAgentEvent) => void): () => void;
  prompt(prompt: PromptContentPart[]): Promise<{ stopReason?: string }>;
  rawSend(method: string, params?: Record<string, unknown>): Promise<unknown>;
};

// ── Output reconstruction ──

type IndexedEntry =
  | { type: "text"; eventIndex: number; text: string }
  | { type: "boundary"; eventIndex: number };

/**
 * Reconstruct agent text output from indexed event entries.
 * Sorts by eventIndex to correct for out-of-order listener invocations,
 * then splits on boundary events (tool calls / turn end) into separate messages.
 */
function reconstructOutput(entries: IndexedEntry[]): {
  allOutput: string;
  lastMessage: string | undefined;
} {
  if (entries.length === 0) {
    return { allOutput: "", lastMessage: undefined };
  }

  // Sort by eventIndex to restore correct order
  entries.sort((a, b) => a.eventIndex - b.eventIndex);

  const messages: string[] = [];
  let current: string[] = [];

  for (const entry of entries) {
    if (entry.type === "text") {
      current.push(entry.text);
    } else {
      // Boundary — flush current message
      if (current.length > 0) {
        messages.push(current.join(""));
        current = [];
      }
    }
  }

  // Flush remaining
  if (current.length > 0) {
    messages.push(current.join(""));
  }

  const allOutput = messages.join("\n\n");
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
  return { allOutput, lastMessage };
}

/**
 * Wraps the sandbox-agent SDK for use in Trigger.dev tasks.
 * Handles session lifecycle, event streaming, and prompt execution.
 */
export class SandboxAgentClient {
  private constructor(private sdk: SandboxAgent) {}

  static async connect(options: string | ConnectOptions): Promise<SandboxAgentClient> {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    const sdk = await SandboxAgent.connect({
      baseUrl: opts.baseUrl,
      persist: opts.persist,
      replayMaxEvents: opts.replayMaxEvents,
      replayMaxChars: opts.replayMaxChars,
      waitForHealth: { timeoutMs: opts.healthTimeoutMs ?? 30_000 },
      signal: opts.signal,
    });
    return new SandboxAgentClient(sdk);
  }

  async createSession(config: SessionConfig): Promise<SandboxAgentSession> {
    // Create session with all options — the SDK internally sets mode, model,
    // and thoughtLevel via ACP RPC after creating the bare session.
    try {
      return await this.sdk.createSession({
        agent: config.agent,
        model: config.model,
        mode: config.mode,
        ...(config.thoughtLevel ? { thoughtLevel: config.thoughtLevel } : {}),
        sessionInit: {
          cwd: config.cwd,
          mcpServers: [],
        },
      });
    } catch (error) {
      // Some agent binaries reject session/set_config_option for certain options
      // (e.g. Codex 0.3.2 rejects model/thoughtLevel via this RPC).
      // Fall back to creating a bare session, then manually set mode via the
      // direct session/set_mode RPC — mode is critical for read-only reviews.
      const isRpcParamError =
        error instanceof Error &&
        error.message.includes("Invalid parameters");
      if (!isRpcParamError) throw error;

      const session = await this.sdk.createSession({
        agent: config.agent,
        sessionInit: {
          cwd: config.cwd,
          mcpServers: [],
        },
      });

      // Best-effort: set mode directly via session/set_mode RPC.
      // This is a different RPC than session/set_config_option and may be
      // supported even when the latter fails.
      if (config.mode) {
        try {
          await session.rawSend("session/set_mode", { modeId: config.mode });
        } catch (modeError) {
          console.warn(
            `[SandboxAgentClient] Failed to set mode "${config.mode}" for ${config.agent} session — ` +
            `agent will use its built-in default. Error: ${modeError instanceof Error ? modeError.message : modeError}`,
          );
        }
      }

      return session;
    }
  }

  /**
   * Resume a previously persisted session. The SDK replays stored events
   * as context so the agent picks up where it left off.
   */
  async resumeSession(
    sdkSessionId: string,
    config: SessionConfig,
  ): Promise<SandboxAgentSession> {
    try {
      return await this.sdk.resumeOrCreateSession({
        id: sdkSessionId,
        agent: config.agent,
        model: config.model,
        mode: config.mode,
        ...(config.thoughtLevel ? { thoughtLevel: config.thoughtLevel } : {}),
        sessionInit: {
          cwd: config.cwd,
          mcpServers: [],
        },
      });
    } catch (error) {
      // Same fallback as createSession — some binaries reject set_config_option.
      const isRpcParamError =
        error instanceof Error &&
        error.message.includes("Invalid parameters");
      if (!isRpcParamError) throw error;

      const session = await this.sdk.resumeOrCreateSession({
        id: sdkSessionId,
        agent: config.agent,
        sessionInit: {
          cwd: config.cwd,
          mcpServers: [],
        },
      });

      if (config.mode) {
        try {
          await session.rawSend("session/set_mode", { modeId: config.mode });
        } catch (modeError) {
          console.warn(
            `[SandboxAgentClient] Failed to set mode "${config.mode}" for ${config.agent} resumed session — ` +
            `agent will use its built-in default. Error: ${modeError instanceof Error ? modeError.message : modeError}`,
          );
        }
      }

      return session;
    }
  }

  /**
   * Resume a session using the native agent CLI resume (e.g. claude --resume).
   * Bypasses sandbox-agent SDK's text-replay and calls AcpHttpClient.unstableResumeSession() directly.
   * Returns null if native resume is not supported or fails — caller should fall back to text replay.
   */
  async nativeResumeSession(
    nativeSessionId: string,
    config: SessionConfig & { serverUrl: string },
  ): Promise<NativeResumedSession | null> {
    try {
      const serverId = `native-${config.agent}-${Date.now()}`;
      const eventListeners: Set<(event: SandboxAgentEvent) => void> = new Set();

      const acp = new AcpHttpClient({
        baseUrl: config.serverUrl,
        transport: {
          path: `/v1/acp/${encodeURIComponent(serverId)}`,
          bootstrapQuery: { agent: config.agent },
        },
        client: {
          sessionUpdate: async () => {},
          extNotification: async () => {},
        },
        onEnvelope: (envelope: AnyMessage, direction) => {
          if (direction !== "inbound") return;
          const event: SandboxAgentEvent = {
            eventIndex: 0,
            sender: "agent",
            payload: envelope as Record<string, unknown>,
          };
          for (const listener of eventListeners) {
            listener(event);
          }
        },
      });

      await acp.initialize();
      await acp.unstableResumeSession({
        sessionId: nativeSessionId,
        cwd: config.cwd,
        mcpServers: [],
      });

      return new NativeResumedSession(
        nativeSessionId,
        acp,
        eventListeners,
      );
    } catch {
      return null;
    }
  }

  /**
   * Send a prompt and wait for the agent to complete.
   * Returns an AgentResult compatible with the rest of the orchestration.
   */
  async executePrompt(
    session: AgentSession,
    prompt: string,
    options?: ExecuteOptions,
  ): Promise<AgentResult> {
    // Subscribe to events if callback provided — for forwarding to output stream.
    // Text capture is done post-prompt from persisted events (correct order guaranteed).
    let unsubscribe: (() => void) | undefined;
    let prePromptMaxIndex = -1;

    if (options?.onEvent) {
      unsubscribe = session.onEvent((event: SandboxAgentEvent) => {
        options.onEvent!(event);
        // Track the highest eventIndex we've seen — used as a cursor for
        // reading persisted events after prompt completes.
        if (event.eventIndex > prePromptMaxIndex) {
          prePromptMaxIndex = event.eventIndex;
        }
      });
    }

    try {
      const promptContent: PromptContentPart[] = [
        { type: "text", text: prompt },
      ];

      // Build race guards — prompt completes OR a guard fires first
      const guards: Promise<never>[] = [];

      if (options?.timeoutMs) {
        guards.push(
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new PromptTimeoutError(options.timeoutMs!)),
              options.timeoutMs,
            );
            // Don't keep the process alive just for this timer
            if (typeof timer === "object" && "unref" in timer) timer.unref();
          }),
        );
      }

      if (options?.signal) {
        guards.push(
          new Promise<never>((_, reject) => {
            if (options.signal!.aborted) {
              reject(options.signal!.reason);
              return;
            }
            options.signal!.addEventListener("abort", () =>
              reject(options.signal!.reason),
            );
          }),
        );
      }

      const result =
        guards.length > 0
          ? await Promise.race([session.prompt(promptContent), ...guards])
          : await session.prompt(promptContent);

      // Read persisted events in correct order to reconstruct clean output.
      // The live onEvent callbacks may fire out-of-order due to async persist,
      // but the persisted events in DB are guaranteed to be in correct sequence.
      const { allOutput, lastMessage } = await this.readPersistedOutput(session.id);

      return {
        success: true,
        output: allOutput,
        lastMessage,
        stopReason: result.stopReason,
        changesDetected: false, // Checked separately via git status
      };
    } catch (error) {
      // Infrastructure-level errors (timeout, sandbox death via abort signal)
      // must propagate so the task can handle lifecycle transitions properly.
      // Only agent/ACP errors are returned as non-throwing results.
      if (error instanceof PromptTimeoutError) throw error;
      if (options?.signal?.aborted) throw options.signal.reason ?? error;

      // Best-effort output capture on error
      const persisted = await this.readPersistedOutput(session.id).catch(() => ({
        allOutput: "",
        lastMessage: undefined,
      }));
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: persisted.allOutput,
        errorOutput: message,
        error: message,
        changesDetected: false,
      };
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Get persisted events for a session via the SDK.
   */
  async getEvents(sessionId: string, options?: { cursor?: string; limit?: number }) {
    return this.sdk.getEvents({
      sessionId,
      cursor: options?.cursor,
      limit: options?.limit ?? 100,
    });
  }

  /**
   * Read all persisted events for a session and reconstruct output text.
   * Events are stored in correct order by the persist driver, unlike the
   * live onEvent callbacks which may fire out-of-order.
   */
  private async readPersistedOutput(
    sessionId: string,
  ): Promise<{ allOutput: string; lastMessage: string | undefined }> {
    // Read all events (paginated) in order
    const allEvents: Array<{ payload: Record<string, unknown> }> = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.sdk.getEvents({
        sessionId,
        cursor,
        limit: 500,
      });
      for (const item of page.items) {
        allEvents.push({ payload: item.payload as Record<string, unknown> });
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }

    // Build indexed entries from persisted events (already in correct order)
    const entries: IndexedEntry[] = [];
    for (let i = 0; i < allEvents.length; i++) {
      const payload = allEvents[i].payload;
      const params = payload?.params as Record<string, unknown> | undefined;
      const update = params?.update as Record<string, unknown> | undefined;
      const updateType = update?.sessionUpdate as string | undefined;

      if (updateType === "agent_message_chunk") {
        const content = update!.content as { text?: string } | undefined;
        if (content?.text) {
          entries.push({ type: "text", eventIndex: i, text: content.text });
        }
      } else if (updateType === "tool_call" || updateType === "turn_ended") {
        entries.push({ type: "boundary", eventIndex: i });
      }
    }

    return reconstructOutput(entries);
  }

  async destroySession(sessionId: string): Promise<void> {
    try {
      await this.sdk.destroySession(sessionId);
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Reply to a permission request from the agent.
   */
  async replyPermission(
    session: AgentSession,
    permissionId: string,
    reply: string,
  ): Promise<void> {
    await session.rawSend("permission/reply", { permissionId, reply });
  }

  /**
   * Reply to a question from the agent with selected answers.
   */
  async replyQuestion(
    session: AgentSession,
    questionId: string,
    answers: string[][],
  ): Promise<void> {
    await session.rawSend("question/reply", { questionId, answers });
  }

  /**
   * Reject a question from the agent.
   */
  async rejectQuestion(
    session: AgentSession,
    questionId: string,
  ): Promise<void> {
    await session.rawSend("question/reject", { questionId });
  }

  async dispose(): Promise<void> {
    try {
      await this.sdk.dispose();
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Adapter that makes a direct AcpHttpClient session look like an SDK Session.
 * Used for native agent resume (bypasses sandbox-agent SDK's text replay).
 */
export class NativeResumedSession {
  readonly id: string;
  readonly agentSessionId: string;

  constructor(
    nativeSessionId: string,
    private readonly acp: AcpHttpClient,
    private readonly eventListeners: Set<(event: SandboxAgentEvent) => void>,
  ) {
    this.id = nativeSessionId;
    this.agentSessionId = nativeSessionId;
  }

  onEvent(listener: (event: SandboxAgentEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => { this.eventListeners.delete(listener); };
  }

  async prompt(prompt: PromptContentPart[]): Promise<{ stopReason?: string }> {
    const response = await this.acp.prompt({
      sessionId: this.agentSessionId,
      prompt,
    });
    return { stopReason: response.stopReason ?? undefined };
  }

  async rawSend(method: string, params?: Record<string, unknown>): Promise<unknown> {
    return this.acp.extMethod(method, {
      ...params,
      sessionId: this.agentSessionId,
    });
  }

  async disconnect(): Promise<void> {
    await this.acp.disconnect();
  }
}

export class PromptTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Prompt execution timed out after ${Math.round(timeoutMs / 1000)}s`);
    this.name = "PromptTimeoutError";
  }
}
