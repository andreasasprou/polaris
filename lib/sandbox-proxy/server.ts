/**
 * Sandbox REST Proxy — HTTP Server
 *
 * Thin http.createServer on port 2469. Routes REST requests to the ACP bridge
 * and manages prompt lifecycle (durable accept, callbacks, stop).
 */

import http from "node:http";
import fs from "node:fs";
import type {
  PromptRequest,
  ActivePrompt,
  ProxyState,
  ProxyStatus,
  AgentEvent,
} from "./types";
import { AcpBridge } from "./acp-bridge";
import { AgentMonitor } from "./agent-monitor";
import { emitCallback, replayPendingCallbacks } from "./callback-delivery";
import { readPendingEntries } from "./outbox";
import type { SessionPersistDriver } from "sandbox-agent";

const ACTIVE_PROMPT_PATH = "/tmp/polaris-proxy/active-prompt.json";
const PROMPT_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes

export class ProxyServer {
  private state: ProxyState = "idle";
  private activePrompt: ActivePrompt | null = null;
  private bridge: AcpBridge;
  private monitor: AgentMonitor;
  private server: http.Server | null = null;

  constructor(persist?: SessionPersistDriver) {
    this.bridge = new AcpBridge(persist);
    this.monitor = new AgentMonitor();
  }

  /**
   * Start the HTTP server on the given port.
   */
  async start(port: number = 2469): Promise<void> {
    // Recover orphans and replay pending callbacks
    await this.recoverOrphans();

    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (err) {
        console.error("[proxy] Unhandled error:", err);
        sendJson(res, 500, { error: "Internal server error" });
      }
    });

    this.server.listen(port, "0.0.0.0", () => {
      console.log(`[proxy] Listening on port ${port}`);
    });
  }

  /**
   * Route dispatch.
   */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url ?? "/", `http://localhost`);
    const method = req.method ?? "GET";
    const path = url.pathname;

    // POST /prompt
    if (method === "POST" && path === "/prompt") {
      return this.handlePrompt(req, res);
    }

    // POST /stop
    if (method === "POST" && path === "/stop") {
      return this.handleStop(req, res);
    }

    // POST /permissions/:id/reply
    const permMatch = path.match(/^\/permissions\/([^/]+)\/reply$/);
    if (method === "POST" && permMatch) {
      return this.handlePermissionReply(req, res, permMatch[1]);
    }

    // POST /questions/:id/reply
    const qMatch = path.match(/^\/questions\/([^/]+)\/reply$/);
    if (method === "POST" && qMatch) {
      return this.handleQuestionReply(req, res, qMatch[1]);
    }

    // GET /status
    if (method === "GET" && path === "/status") {
      return this.handleStatus(res);
    }

    // GET /outbox
    if (method === "GET" && path === "/outbox") {
      return this.handleOutbox(res);
    }

    // GET /health
    if (method === "GET" && path === "/health") {
      sendJson(res, 200, { ok: true, state: this.state });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  }

  // ── POST /prompt ──

  private async handlePrompt(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody<PromptRequest>(req);
    if (!body) {
      sendJson(res, 400, { accepted: false, reason: "Invalid JSON body" });
      return;
    }

    // Validate required fields
    if (!body.jobId || !body.attemptId || body.epoch == null || !body.prompt || !body.callbackUrl || !body.hmacKey || !body.config?.agent) {
      sendJson(res, 400, { accepted: false, reason: "Missing required fields" });
      return;
    }

    // Epoch fencing
    if (this.activePrompt && body.epoch < this.activePrompt.epoch) {
      sendJson(res, 409, {
        accepted: false,
        reason: "stale_epoch",
        currentEpoch: this.activePrompt.epoch,
      });
      return;
    }

    // Idempotency: same attemptId already running
    if (
      this.state === "running" &&
      this.activePrompt?.attemptId === body.attemptId
    ) {
      sendJson(res, 202, {
        accepted: true,
        attemptId: body.attemptId,
        status: "running",
      });
      return;
    }

    // Conflict: different prompt already running
    if (this.state === "running") {
      sendJson(res, 409, {
        accepted: false,
        reason: "already_running",
        activeAttemptId: this.activePrompt?.attemptId,
      });
      return;
    }

    // Durable accept: write active prompt to local file BEFORE returning 202
    const activePrompt: ActivePrompt = {
      jobId: body.jobId,
      attemptId: body.attemptId,
      epoch: body.epoch,
      callbackUrl: body.callbackUrl,
      hmacKey: body.hmacKey,
      config: body.config,
      startedAt: new Date().toISOString(),
    };

    this.writeActivePrompt(activePrompt);
    this.activePrompt = activePrompt;
    this.state = "running";

    // Return 202 immediately
    sendJson(res, 202, { accepted: true, attemptId: body.attemptId });

    // Execute prompt in background (fire-and-forget from HTTP perspective)
    this.executePromptAsync(body).catch((err) => {
      console.error("[proxy] Prompt execution error:", err);
    });
  }

  /**
   * Execute a prompt asynchronously after returning 202.
   */
  private async executePromptAsync(request: PromptRequest): Promise<void> {
    const { jobId, attemptId, epoch, callbackUrl, hmacKey, config, prompt } =
      request;
    const cwd = config.branch
      ? `/home/user/repo` // Default sandbox repo path
      : "/home/user/repo";

    try {
      // Connect to sandbox-agent (lazy, first prompt triggers connection)
      await this.bridge.connect();

      // Create or resume session
      await this.bridge.createOrResumeSession(config, cwd);

      // Emit prompt_accepted callback
      await emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "prompt_accepted",
        payload: { startedAt: new Date().toISOString() },
        callbackUrl,
        hmacKey,
      });

      // Start health monitor
      this.monitor.reset();
      this.monitor.start();

      // Set up event handler for HITL callbacks
      const onEvent = (event: AgentEvent) => {
        this.handleAgentEvent(event, jobId, attemptId, epoch, callbackUrl, hmacKey);
      };

      // Execute prompt
      const result = await this.bridge.executePrompt(
        this.bridge.getSession(),
        prompt,
        {
          onEvent,
          timeoutMs: PROMPT_TIMEOUT_MS,
          signal: this.monitor.signal,
        },
      );

      // Stop health monitor
      this.monitor.stop();

      if (result.success) {
        // Emit prompt_complete callback
        await emitCallback({
          jobId,
          attemptId,
          epoch,
          callbackType: "prompt_complete",
          payload: {
            result: {
              lastMessage: result.lastMessage,
              sdkSessionId: result.sdkSessionId,
              nativeAgentSessionId: result.nativeAgentSessionId,
              cwd: result.cwd,
              durationMs: result.durationMs,
            },
            completedAt: new Date().toISOString(),
          },
          callbackUrl,
          hmacKey,
        });
      } else {
        // Emit prompt_failed callback
        const reason = result.error?.includes("timed out")
          ? "agent_timeout"
          : result.error?.includes("unreachable")
            ? "agent_crash"
            : "unknown";

        await emitCallback({
          jobId,
          attemptId,
          epoch,
          callbackType: "prompt_failed",
          payload: {
            error: result.error ?? "Unknown error",
            reason,
            durationMs: result.durationMs,
          },
          callbackUrl,
          hmacKey,
        });
      }
    } catch (err) {
      this.monitor.stop();

      const error = err instanceof Error ? err.message : String(err);
      const reason = error.includes("timed out")
        ? "agent_timeout"
        : error.includes("unreachable")
          ? "agent_crash"
          : "unknown";

      await emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "prompt_failed",
        payload: { error, reason },
        callbackUrl,
        hmacKey,
      });
    } finally {
      this.state = "idle";
      this.clearActivePrompt();
    }
  }

  /**
   * Handle agent events during prompt execution.
   * Emits HITL callbacks for permission/question requests.
   */
  private handleAgentEvent(
    event: AgentEvent,
    jobId: string,
    attemptId: string,
    epoch: number,
    callbackUrl: string,
    hmacKey: string,
  ): void {
    const payload = event.payload;
    const params = payload?.params as Record<string, unknown> | undefined;
    const update = params?.update as Record<string, unknown> | undefined;
    const updateType = update?.sessionUpdate as string | undefined;

    if (updateType === "permission_requested") {
      const permissionId = update!.permissionId as string;
      const meta = (update as Record<string, unknown>)?._meta as Record<string, unknown> | undefined;
      const claudeCode = meta?.claudeCode as Record<string, unknown> | undefined;
      const toolName = (claudeCode?.toolName as string) ?? "unknown";
      const toolInput = update!.rawInput as Record<string, unknown> ?? {};

      emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "permission_requested",
        payload: {
          permissionId,
          toolName,
          toolInput,
          requestedAt: new Date().toISOString(),
        },
        callbackUrl,
        hmacKey,
      }).catch((err) =>
        console.error("[proxy] Failed to emit permission_requested:", err),
      );
    } else if (updateType === "question_requested") {
      const questionId = update!.questionId as string;
      const question = update!.prompt as string;
      const options = update!.options as string[] | undefined;

      emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "question_requested",
        payload: {
          questionId,
          question,
          options,
          requestedAt: new Date().toISOString(),
        },
        callbackUrl,
        hmacKey,
      }).catch((err) =>
        console.error("[proxy] Failed to emit question_requested:", err),
      );
    }
  }

  // ── POST /stop ──

  private async handleStop(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const body = await readBody<{ epoch: number; reason?: string }>(req);
    if (!body || body.epoch == null) {
      sendJson(res, 400, { error: "Missing epoch" });
      return;
    }

    if (!this.activePrompt) {
      sendJson(res, 404, { error: "no_active_prompt" });
      return;
    }

    if (body.epoch < this.activePrompt.epoch) {
      sendJson(res, 409, { error: "stale_epoch" });
      return;
    }

    this.state = "stopping";
    sendJson(res, 200, { stopped: true });

    // The prompt execution will catch the abort and emit prompt_failed
    // We don't need to explicitly send SIGTERM — the monitor abort signal
    // will cause the prompt to reject. For explicit stop, we abort the monitor.
    this.monitor.stop();

    // Emit prompt_failed with user_stop reason
    const { jobId, attemptId, epoch, callbackUrl, hmacKey, startedAt } =
      this.activePrompt;
    const durationMs = Date.now() - new Date(startedAt).getTime();

    await emitCallback({
      jobId,
      attemptId,
      epoch,
      callbackType: "prompt_failed",
      payload: {
        error: body.reason ?? "User requested stop",
        reason: "user_stop",
        durationMs,
      },
      callbackUrl,
      hmacKey,
    });
  }

  // ── POST /permissions/:id/reply ──

  private async handlePermissionReply(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    permissionId: string,
  ): Promise<void> {
    const body = await readBody<{ reply: string; epoch: number }>(req);
    if (!body || !body.reply || body.epoch == null) {
      sendJson(res, 400, { error: "Missing reply or epoch" });
      return;
    }

    if (!this.activePrompt) {
      sendJson(res, 409, { error: "no_active_prompt" });
      return;
    }

    if (body.epoch < this.activePrompt.epoch) {
      sendJson(res, 409, { error: "stale_epoch" });
      return;
    }

    try {
      await this.bridge.replyPermission(permissionId, body.reply);

      // Emit permission_resumed callback
      const { jobId, attemptId, epoch, callbackUrl, hmacKey } =
        this.activePrompt;
      emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "permission_resumed",
        payload: {
          permissionId,
          resumedAt: new Date().toISOString(),
        },
        callbackUrl,
        hmacKey,
      }).catch((err) =>
        console.error("[proxy] Failed to emit permission_resumed:", err),
      );

      sendJson(res, 200, { delivered: true });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Failed to forward reply",
      });
    }
  }

  // ── POST /questions/:id/reply ──

  private async handleQuestionReply(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    questionId: string,
  ): Promise<void> {
    const body = await readBody<{
      answers: Record<string, string>;
      epoch: number;
    }>(req);
    if (!body || body.epoch == null) {
      sendJson(res, 400, { error: "Missing answers or epoch" });
      return;
    }

    if (!this.activePrompt) {
      sendJson(res, 409, { error: "no_active_prompt" });
      return;
    }

    if (body.epoch < this.activePrompt.epoch) {
      sendJson(res, 409, { error: "stale_epoch" });
      return;
    }

    try {
      if (body.answers) {
        await this.bridge.replyQuestion(questionId, body.answers);
      } else {
        await this.bridge.rejectQuestion(questionId);
      }

      const { jobId, attemptId, epoch, callbackUrl, hmacKey } =
        this.activePrompt;
      emitCallback({
        jobId,
        attemptId,
        epoch,
        callbackType: "permission_resumed",
        payload: {
          questionId,
          resumedAt: new Date().toISOString(),
        },
        callbackUrl,
        hmacKey,
      }).catch((err) =>
        console.error("[proxy] Failed to emit question_resumed:", err),
      );

      sendJson(res, 200, { delivered: true });
    } catch (err) {
      sendJson(res, 500, {
        error: err instanceof Error ? err.message : "Failed to forward reply",
      });
    }
  }

  // ── GET /status ──

  private handleStatus(res: http.ServerResponse): void {
    const status: ProxyStatus = {
      state: this.state,
    };

    if (this.activePrompt) {
      status.jobId = this.activePrompt.jobId;
      status.attemptId = this.activePrompt.attemptId;
      status.epoch = this.activePrompt.epoch;
      status.startedAt = this.activePrompt.startedAt;
    }

    sendJson(res, 200, status);
  }

  // ── GET /outbox ──

  private handleOutbox(res: http.ServerResponse): void {
    const entries = readPendingEntries();
    sendJson(res, 200, { entries });
  }

  // ── Active Prompt Persistence ──

  private writeActivePrompt(prompt: ActivePrompt): void {
    const dir = "/tmp/polaris-proxy";
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(ACTIVE_PROMPT_PATH, JSON.stringify(prompt, null, 2));
  }

  private clearActivePrompt(): void {
    this.activePrompt = null;
    try {
      if (fs.existsSync(ACTIVE_PROMPT_PATH)) {
        fs.unlinkSync(ACTIVE_PROMPT_PATH);
      }
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * On startup, check for orphaned active prompts and replay pending callbacks.
   */
  private async recoverOrphans(): Promise<void> {
    // Check for orphaned active prompt
    if (fs.existsSync(ACTIVE_PROMPT_PATH)) {
      try {
        const content = fs.readFileSync(ACTIVE_PROMPT_PATH, "utf-8");
        const orphan = JSON.parse(content) as ActivePrompt;

        console.warn(
          `[proxy] Found orphaned active prompt: job=${orphan.jobId} attempt=${orphan.attemptId}`,
        );

        // Emit prompt_failed for the orphan
        await emitCallback({
          jobId: orphan.jobId,
          attemptId: orphan.attemptId,
          epoch: orphan.epoch,
          callbackType: "prompt_failed",
          payload: {
            error: "Proxy restarted while prompt was running",
            reason: "proxy_restart_orphan",
            durationMs: Date.now() - new Date(orphan.startedAt).getTime(),
          },
          callbackUrl: orphan.callbackUrl,
          hmacKey: orphan.hmacKey,
        });
      } catch (err) {
        console.error("[proxy] Failed to handle orphaned prompt:", err);
      } finally {
        this.clearActivePrompt();
      }
    }

    // Replay any pending outbox entries
    // We can't replay without knowing callbackUrl/hmacKey, but entries already
    // have all the info baked in. The delivery function reads from the entry.
    const pending = readPendingEntries();
    if (pending.length > 0) {
      console.log(`[proxy] Found ${pending.length} pending outbox entries`);
      // These will be picked up by the sweeper via GET /outbox
      // since we don't have the callbackUrl/hmacKey for generic replay
    }
  }
}

// ── HTTP Helpers ──

function sendJson(
  res: http.ServerResponse,
  status: number,
  body: Record<string, unknown>,
): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

async function readBody<T>(req: http.IncomingMessage): Promise<T | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as T;
        resolve(body);
      } catch {
        resolve(null);
      }
    });
    req.on("error", () => resolve(null));
  });
}
