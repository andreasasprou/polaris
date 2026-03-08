import { SandboxAgent, type SessionPersistDriver } from "sandbox-agent";
import type { AgentType, AgentResult } from "./types";

type PromptContentPart = { type: "text"; text: string };

type SessionConfig = {
  agent: AgentType;
  model?: string;
  mode?: string;
  cwd: string;
};

type ConnectOptions = {
  baseUrl: string;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
};

type ExecuteOptions = {
  onEvent?: (event: SandboxAgentEvent) => void;
  timeoutMs?: number;
};

export type SandboxAgentEvent = {
  eventIndex: number;
  sender: string;
  payload: Record<string, unknown>;
};

type SandboxAgentSession = Awaited<ReturnType<SandboxAgent["createSession"]>>;

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
      waitForHealth: { timeoutMs: 30_000 },
    });
    return new SandboxAgentClient(sdk);
  }

  async createSession(config: SessionConfig): Promise<SandboxAgentSession> {
    const session = await this.sdk.createSession({
      agent: config.agent,
      model: config.model,
      mode: config.mode,
      sessionInit: {
        cwd: config.cwd,
        mcpServers: [],
      },
    });

    return session;
  }

  /**
   * Resume a previously persisted session. The SDK replays stored events
   * as context so the agent picks up where it left off.
   */
  async resumeSession(
    sdkSessionId: string,
    config: SessionConfig,
  ): Promise<SandboxAgentSession> {
    const session = await this.sdk.resumeOrCreateSession({
      id: sdkSessionId,
      agent: config.agent,
      model: config.model,
      mode: config.mode,
      sessionInit: {
        cwd: config.cwd,
        mcpServers: [],
      },
    });

    return session;
  }

  /**
   * Send a prompt and wait for the agent to complete.
   * Returns an AgentResult compatible with the rest of the orchestration.
   */
  async executePrompt(
    session: SandboxAgentSession,
    prompt: string,
    options?: ExecuteOptions,
  ): Promise<AgentResult> {
    // Subscribe to events if callback provided
    let unsubscribe: (() => void) | undefined;
    const eventLog: string[] = [];

    if (options?.onEvent) {
      unsubscribe = session.onEvent((event: SandboxAgentEvent) => {
        options.onEvent!(event);

        // Capture text output for the result
        const payload = event.payload as Record<string, unknown>;
        if (payload?.type === "text" && typeof payload.text === "string") {
          eventLog.push(payload.text);
        }
      });
    }

    try {
      const promptContent: PromptContentPart[] = [
        { type: "text", text: prompt },
      ];

      // Execute with optional timeout
      let result: { stopReason?: string };

      if (options?.timeoutMs) {
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          options.timeoutMs,
        );

        try {
          result = await session.prompt(promptContent);
        } finally {
          clearTimeout(timeout);
        }
      } else {
        result = await session.prompt(promptContent);
      }

      return {
        success: true,
        output: eventLog.join(""),
        stopReason: result.stopReason,
        changesDetected: false, // Checked separately via git status
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        output: eventLog.join(""),
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
    session: SandboxAgentSession,
    permissionId: string,
    reply: string,
  ): Promise<void> {
    await session.send("permission/reply", { permissionId, reply });
  }

  /**
   * Reply to a question from the agent with selected answers.
   */
  async replyQuestion(
    session: SandboxAgentSession,
    questionId: string,
    answers: string[][],
  ): Promise<void> {
    await session.send("question/reply", { questionId, answers });
  }

  /**
   * Reject a question from the agent.
   */
  async rejectQuestion(
    session: SandboxAgentSession,
    questionId: string,
  ): Promise<void> {
    await session.send("question/reject", { questionId });
  }

  async dispose(): Promise<void> {
    try {
      await this.sdk.dispose();
    } catch {
      // Best-effort cleanup
    }
  }
}
