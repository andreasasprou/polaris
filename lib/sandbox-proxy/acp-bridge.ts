/**
 * Sandbox REST Proxy — ACP Bridge
 *
 * Manages the ACP connection lifecycle, session create/resume,
 * and prompt execution. Absorbs correctness logic from SandboxAgentClient.ts.
 *
 * Key difference from v1: the ACP connection is now local (localhost:2468)
 * so the suspend/resume connection death problem is eliminated entirely.
 */

import { SandboxAgent, type SessionPersistDriver } from "sandbox-agent";
import { AcpHttpClient } from "acp-http-client";
import type { AnyMessage } from "acp-http-client";
import type {
  AgentType,
  PromptConfig,
  AgentEvent,
  AgentSession,
  PromptContentPart,
} from "./types";

const AGENT_SERVER_URL = "http://localhost:2468";
const HEALTH_TIMEOUT_MS = 30_000;

type PromptResult = {
  success: boolean;
  lastMessage?: string;
  sdkSessionId?: string;
  nativeAgentSessionId?: string;
  cwd?: string;
  durationMs: number;
  error?: string;
  exitCode?: number;
};

type EventCallback = (event: AgentEvent) => void;

/**
 * NativeResumedSession — adapter that makes a direct AcpHttpClient session
 * look like an SDK Session. Ported from SandboxAgentClient.ts.
 */
class NativeResumedSession implements AgentSession {
  readonly id: string;
  readonly agentSessionId: string;

  constructor(
    nativeSessionId: string,
    private readonly acp: AcpHttpClient,
    private readonly eventListeners: Set<EventCallback>,
  ) {
    this.id = nativeSessionId;
    this.agentSessionId = nativeSessionId;
  }

  onEvent(listener: EventCallback): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  async prompt(prompt: PromptContentPart[]): Promise<{ stopReason?: string }> {
    const response = await this.acp.prompt({
      sessionId: this.agentSessionId,
      prompt,
    });
    return { stopReason: response.stopReason ?? undefined };
  }

  async rawSend(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    return this.acp.extMethod(method, {
      ...params,
      sessionId: this.agentSessionId,
    });
  }

  async disconnect(): Promise<void> {
    await this.acp.disconnect();
  }
}

/**
 * AcpBridge manages the lifecycle of ACP connections and sessions.
 */
export class AcpBridge {
  private sdk: SandboxAgent | null = null;
  private session: AgentSession | null = null;
  private persist: SessionPersistDriver | undefined;

  constructor(persist?: SessionPersistDriver) {
    this.persist = persist;
  }

  /** Whether a session is currently active. */
  get hasSession(): boolean {
    return this.session !== null;
  }

  /** Get the current session (throws if none). */
  getSession(): AgentSession {
    if (!this.session) throw new Error("No active session");
    return this.session;
  }

  /**
   * Connect to the sandbox-agent server.
   * Lazy — called on first prompt, not at proxy startup.
   */
  async connect(signal?: AbortSignal): Promise<void> {
    if (this.sdk) return;

    this.sdk = await SandboxAgent.connect({
      baseUrl: AGENT_SERVER_URL,
      persist: this.persist,
      waitForHealth: { timeoutMs: HEALTH_TIMEOUT_MS },
      signal,
    });
  }

  /**
   * Create or resume a session based on config.
   *
   * Resume precedence:
   * 1. Native resume via AcpHttpClient.unstableResumeSession()
   * 2. Text replay via SDK's resumeOrCreateSession()
   * 3. Fresh session via SDK's createSession()
   */
  async createOrResumeSession(
    config: PromptConfig,
    cwd: string,
  ): Promise<AgentSession> {
    if (!this.sdk) {
      throw new Error("AcpBridge not connected — call connect() first");
    }

    const sessionConfig = {
      agent: config.agent,
      model: config.model,
      mode: config.mode,
      cwd,
    };

    // 1. Try native resume
    if (config.nativeAgentSessionId) {
      const nativeSession = await this.tryNativeResume(
        config.nativeAgentSessionId,
        config.agent,
        cwd,
      );
      if (nativeSession) {
        this.session = nativeSession;
        return nativeSession;
      }
      console.warn(
        "[proxy] Native resume failed, falling back to text replay",
      );
    }

    // 2. Try text replay resume
    if (config.sdkSessionId) {
      const session = await this.createSessionWithFallback(
        sessionConfig,
        config.sdkSessionId,
      );
      this.session = session;
      return session;
    }

    // 3. Fresh session
    const session = await this.createSessionWithFallback(sessionConfig);
    this.session = session;
    return session;
  }

  /**
   * Create a session with config fallback.
   * If session/set_config_option fails with "Invalid parameters",
   * falls back to bare session + manual session/set_mode RPC.
   */
  private async createSessionWithFallback(
    config: { agent: AgentType; model?: string; mode?: string; cwd: string },
    resumeSdkSessionId?: string,
  ): Promise<AgentSession> {
    if (!this.sdk) throw new Error("Not connected");

    const createOpts = {
      agent: config.agent,
      model: config.model,
      mode: config.mode,
      sessionInit: { cwd: config.cwd, mcpServers: [] },
    };

    try {
      if (resumeSdkSessionId) {
        return (await this.sdk.resumeOrCreateSession({
          id: resumeSdkSessionId,
          ...createOpts,
        })) as AgentSession;
      }
      return (await this.sdk.createSession(createOpts)) as AgentSession;
    } catch (error) {
      // Some agent binaries reject session/set_config_option for certain options.
      // Fall back to bare session + manual mode set.
      const isRpcParamError =
        error instanceof Error &&
        error.message.includes("Invalid parameters");
      if (!isRpcParamError) throw error;

      console.warn(
        `[proxy] Config option RPC failed for ${config.agent}, using fallback`,
      );

      const bareOpts = {
        agent: config.agent,
        sessionInit: { cwd: config.cwd, mcpServers: [] },
      };

      const session = resumeSdkSessionId
        ? await this.sdk.resumeOrCreateSession({
            id: resumeSdkSessionId,
            ...bareOpts,
          })
        : await this.sdk.createSession(bareOpts);

      // Best-effort mode set via direct RPC
      if (config.mode) {
        try {
          await session.rawSend("session/set_mode", {
            modeId: config.mode,
          });
        } catch (modeError) {
          console.warn(
            `[proxy] Failed to set mode "${config.mode}" — agent uses defaults. ` +
              `Error: ${modeError instanceof Error ? modeError.message : modeError}`,
          );
        }
      }

      return session as AgentSession;
    }
  }

  /**
   * Attempt native resume via AcpHttpClient.unstableResumeSession().
   * Returns null if native resume is not supported or fails.
   */
  private async tryNativeResume(
    nativeSessionId: string,
    agent: AgentType,
    cwd: string,
  ): Promise<NativeResumedSession | null> {
    try {
      const serverId = `native-${agent}-${Date.now()}`;
      const eventListeners = new Set<EventCallback>();

      const acp = new AcpHttpClient({
        baseUrl: AGENT_SERVER_URL,
        transport: {
          path: `/v1/acp/${encodeURIComponent(serverId)}`,
          bootstrapQuery: { agent },
        },
        client: {
          sessionUpdate: async () => {},
          extNotification: async () => {},
        },
        onEnvelope: (envelope: AnyMessage, direction) => {
          if (direction !== "inbound") return;
          const event: AgentEvent = {
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
        cwd,
        mcpServers: [],
      });

      return new NativeResumedSession(nativeSessionId, acp, eventListeners);
    } catch {
      return null;
    }
  }

  /**
   * Execute a prompt on the current session.
   *
   * Sets up event listeners for HITL callbacks, races prompt against
   * timeout and health monitor abort signal.
   */
  async executePrompt(
    session: AgentSession,
    prompt: string,
    options?: {
      onEvent?: EventCallback;
      timeoutMs?: number;
      signal?: AbortSignal;
      /** Attachments already written to sandbox filesystem */
      attachments?: Array<{ name: string; absolutePath: string; mimeType: string }>;
    },
  ): Promise<PromptResult> {
    const startTime = Date.now();
    let unsubscribe: (() => void) | undefined;

    if (options?.onEvent) {
      unsubscribe = session.onEvent(options.onEvent);
    }

    try {
      const promptContent: PromptContentPart[] = [
        { type: "text", text: prompt },
      ];

      // Add resource_link parts for each attachment
      if (options?.attachments?.length) {
        for (const att of options.attachments) {
          promptContent.push({
            type: "resource_link",
            name: att.name,
            uri: `file://${att.absolutePath}`,
            mimeType: att.mimeType,
          });
        }
      }

      // Build race guards
      const guards: Promise<never>[] = [];

      if (options?.timeoutMs) {
        guards.push(
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () =>
                reject(new Error(`Prompt timed out after ${options.timeoutMs}ms`)),
              options.timeoutMs,
            );
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

      // Read persisted events for output reconstruction (correct order guaranteed)
      const { lastMessage } = await this.readPersistedOutput(session.id);

      return {
        success: true,
        lastMessage,
        sdkSessionId: session.id,
        nativeAgentSessionId: session.agentSessionId,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: message,
        durationMs: Date.now() - startTime,
      };
    } finally {
      unsubscribe?.();
    }
  }

  /**
   * Read persisted events and reconstruct the last message.
   * Events are stored in correct order by the persist driver.
   */
  private async readPersistedOutput(
    sessionId: string,
  ): Promise<{ lastMessage: string | undefined }> {
    if (!this.sdk) return { lastMessage: undefined };

    try {
      type IndexedEntry =
        | { type: "text"; text: string }
        | { type: "boundary" };

      const entries: IndexedEntry[] = [];
      let cursor: string | undefined;

      for (;;) {
        const page = await this.sdk.getEvents({
          sessionId,
          cursor,
          limit: 500,
        });
        for (const item of page.items) {
          const payload = item.payload as Record<string, unknown>;
          const params = payload?.params as
            | Record<string, unknown>
            | undefined;
          const update = params?.update as
            | Record<string, unknown>
            | undefined;
          const updateType = update?.sessionUpdate as string | undefined;

          if (updateType === "agent_message_chunk") {
            const content = update!.content as
              | { text?: string }
              | undefined;
            if (content?.text) {
              entries.push({ type: "text", text: content.text });
            }
          } else if (
            updateType === "tool_call" ||
            updateType === "turn_ended"
          ) {
            entries.push({ type: "boundary" });
          }
        }
        if (!page.nextCursor) break;
        cursor = page.nextCursor;
      }

      // Reconstruct: split on boundaries, take last message
      const messages: string[] = [];
      let current: string[] = [];

      for (const entry of entries) {
        if (entry.type === "text") {
          current.push(entry.text);
        } else {
          if (current.length > 0) {
            messages.push(current.join(""));
            current = [];
          }
        }
      }
      if (current.length > 0) {
        messages.push(current.join(""));
      }

      return {
        lastMessage: messages.length > 0 ? messages[messages.length - 1] : undefined,
      };
    } catch {
      return { lastMessage: undefined };
    }
  }

  /** Forward a permission reply to the agent. */
  async replyPermission(permissionId: string, reply: string): Promise<void> {
    const session = this.getSession();
    await session.rawSend("permission/reply", { permissionId, reply });
  }

  /** Forward a question reply to the agent. */
  async replyQuestion(
    questionId: string,
    answers: Record<string, string>,
  ): Promise<void> {
    const session = this.getSession();
    await session.rawSend("question/reply", { questionId, answers });
  }

  /** Reject a question. */
  async rejectQuestion(questionId: string): Promise<void> {
    const session = this.getSession();
    await session.rawSend("question/reject", { questionId });
  }

  /** Clean up resources. */
  async dispose(): Promise<void> {
    this.session = null;
    if (this.sdk) {
      try {
        await this.sdk.dispose();
      } catch {
        // Best-effort
      }
      this.sdk = null;
    }
  }
}
