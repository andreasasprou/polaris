/**
 * Parsed event types from the Sandbox Agent JSON-RPC event stream.
 * Used by the chat UI to render events meaningfully.
 */

/** A tool call made by the agent (e.g., Read, Edit, Bash). */
export type ToolCallEvent = {
  type: "tool_call";
  toolCallId: string;
  toolName: string;
  title: string;
  kind: string;
  status: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path: string; line?: number }>;
  content?: Array<Record<string, unknown>>;
};

/** An update to a previously emitted tool call. */
export type ToolCallUpdateEvent = {
  type: "tool_call_update";
  toolCallId: string;
  toolName: string;
  title: string;
  kind: string;
  status?: string;
  rawInput?: Record<string, unknown>;
  locations?: Array<{ path: string; line?: number }>;
  content?: Array<Record<string, unknown>>;
};

/** A chunk of agent text (thinking or message). */
export type TextChunkEvent = {
  type: "agent_thought_chunk" | "agent_message_chunk";
  text: string;
};

/** The user/system prompt sent to the agent. */
export type PromptEvent = {
  type: "prompt";
  text: string;
};

/** Session lifecycle events. */
export type SessionLifecycleEvent = {
  type: "session_created" | "session_cancelled" | "set_mode";
  detail?: string;
};

/** Usage/cost update. */
export type UsageEvent = {
  type: "usage_update";
  cost?: { amount: number; currency: string };
  used?: number;
  size?: number;
};

/** Permission request from the agent. */
export type PermissionRequestEvent = {
  type: "permission_requested";
  permissionId: string;
  action: string;
  status: string;
  metadata?: Record<string, unknown>;
};

/** Permission resolved (user replied or auto-resolved). */
export type PermissionResolvedEvent = {
  type: "permission_resolved";
  permissionId: string;
  action: string;
  status: string;
};

/** Question from the agent requiring user input. */
export type QuestionRequestEvent = {
  type: "question_requested";
  questionId: string;
  prompt: string;
  options: string[];
  status: string;
};

/** Question resolved (user answered or rejected). */
export type QuestionResolvedEvent = {
  type: "question_resolved";
  questionId: string;
  status: string;
  response?: string;
};

/** Turn lifecycle events. */
export type TurnEvent = {
  type: "turn_started" | "turn_ended";
};

/** Session ended event. */
export type SessionEndedEvent = {
  type: "session_ended";
  reason: string;
  terminatedBy?: string;
  message?: string;
};

/** Runtime error event. */
export type ErrorEvent = {
  type: "error";
  message: string;
  code?: string;
};

/** Catch-all for unknown events. */
export type UnknownEvent = {
  type: "unknown";
  method?: string;
};

export type ParsedEvent =
  | ToolCallEvent
  | ToolCallUpdateEvent
  | TextChunkEvent
  | PromptEvent
  | SessionLifecycleEvent
  | UsageEvent
  | PermissionRequestEvent
  | PermissionResolvedEvent
  | QuestionRequestEvent
  | QuestionResolvedEvent
  | TurnEvent
  | SessionEndedEvent
  | ErrorEvent
  | UnknownEvent;

/**
 * Parse a raw Sandbox Agent JSON-RPC event payload into a typed event.
 */
export function parseEventPayload(
  payload: Record<string, unknown>,
): ParsedEvent | null {
  const method = payload?.method as string | undefined;
  const params = payload?.params as Record<string, unknown> | undefined;

  if (method === "session/update" && params?.update) {
    const update = params.update as Record<string, unknown>;
    const updateType = update.sessionUpdate as string | undefined;
    const meta = update._meta as Record<string, Record<string, unknown>> | undefined;

    switch (updateType) {
      case "tool_call":
        return {
          type: "tool_call",
          toolCallId: update.toolCallId as string,
          toolName: meta?.claudeCode?.toolName as string ?? update.title as string ?? "unknown",
          title: update.title as string ?? "",
          kind: update.kind as string ?? "",
          status: update.status as string ?? "pending",
          rawInput: update.rawInput as Record<string, unknown> | undefined,
          locations: update.locations as Array<{ path: string; line?: number }> | undefined,
          content: update.content as Array<{ type: string; text?: string }> | undefined,
        };

      case "tool_call_update":
        return {
          type: "tool_call_update",
          toolCallId: update.toolCallId as string,
          toolName: meta?.claudeCode?.toolName as string ?? update.title as string ?? "unknown",
          title: update.title as string ?? "",
          kind: update.kind as string ?? "",
          status: update.status as string | undefined,
          rawInput: update.rawInput as Record<string, unknown> | undefined,
          locations: update.locations as Array<{ path: string; line?: number }> | undefined,
          content: update.content as Array<{ type: string; text?: string }> | undefined,
        };

      case "agent_thought_chunk":
      case "agent_message_chunk": {
        const content = update.content as { text?: string } | undefined;
        return {
          type: updateType,
          text: content?.text ?? "",
        };
      }

      case "usage_update":
        return {
          type: "usage_update",
          cost: update.cost as { amount: number; currency: string } | undefined,
          used: update.used as number | undefined,
          size: update.size as number | undefined,
        };

      case "permission_requested":
        return {
          type: "permission_requested",
          permissionId: update.permissionId as string ?? update.permission_id as string,
          action: update.action as string ?? "",
          status: update.status as string ?? "requested",
          metadata: update.metadata as Record<string, unknown> | undefined,
        };

      case "permission_resolved":
        return {
          type: "permission_resolved",
          permissionId: update.permissionId as string ?? update.permission_id as string,
          action: update.action as string ?? "",
          status: update.status as string ?? "",
        };

      case "question_requested":
        return {
          type: "question_requested",
          questionId: update.questionId as string ?? update.question_id as string,
          prompt: update.prompt as string ?? "",
          options: (update.options as string[]) ?? [],
          status: update.status as string ?? "requested",
        };

      case "question_resolved":
        return {
          type: "question_resolved",
          questionId: update.questionId as string ?? update.question_id as string,
          status: update.status as string ?? "",
          response: update.response as string | undefined,
        };

      case "turn_started":
        return { type: "turn_started" };

      case "turn_ended":
        return { type: "turn_ended" };

      case "session_ended":
        return {
          type: "session_ended",
          reason: update.reason as string ?? "completed",
          terminatedBy: update.terminated_by as string ?? update.terminatedBy as string,
          message: update.message as string | undefined,
        };

      case "error":
        return {
          type: "error",
          message: update.message as string ?? "Unknown error",
          code: update.code as string | undefined,
        };

      case "available_commands_update":
      case "config_option_update":
        return null; // Skip config noise

      default:
        return { type: "unknown", method: `session/update:${updateType}` };
    }
  }

  if (method === "session/prompt") {
    const prompt = params?.prompt as Array<{ text?: string }> | undefined;
    return {
      type: "prompt",
      text: prompt?.[0]?.text ?? "",
    };
  }

  if (method === "session/new") {
    return { type: "session_created" };
  }

  if (method === "session/set_mode") {
    return { type: "set_mode", detail: params?.modeId as string };
  }

  if (method === "session/cancel") {
    return { type: "session_cancelled" };
  }

  // JSON-RPC responses — skip
  if (payload?.result !== undefined && !method) {
    return null;
  }

  return null;
}

/**
 * Represents a consolidated chat item built from multiple events.
 * Text chunks are merged into full messages, tool calls are tracked by ID.
 */
export type ChatItem =
  | { type: "user_prompt"; text: string }
  | { type: "agent_message"; text: string }
  | { type: "agent_thought"; text: string }
  | {
      type: "tool_call";
      toolCallId: string;
      toolName: string;
      title: string;
      kind: string;
      status: string;
      locations: Array<{ path: string; line?: number }>;
      content: Array<Record<string, unknown>>;
    }
  | { type: "usage"; cost?: { amount: number; currency: string }; used?: number; size?: number }
  | { type: "status"; label: string; detail?: string }
  | { type: "permission_request"; permissionId: string; action: string; status: "pending" | "accepted" | "rejected"; metadata?: Record<string, unknown> }
  | { type: "question_request"; questionId: string; prompt: string; options: string[]; status: "pending" | "answered" | "rejected"; response?: string }
  | { type: "error"; message: string; code?: string }
  | { type: "session_ended"; reason: string; message?: string };

export type ConsolidatedResult = {
  items: ChatItem[];
  turnInProgress: boolean;
};

/**
 * Consolidate a stream of parsed events into displayable chat items.
 * Merges consecutive text chunks into single messages, tracks tool call state.
 */
export function consolidateEvents(
  events: Array<{ payload: Record<string, unknown> }>,
): ConsolidatedResult {
  const items: ChatItem[] = [];
  let currentThought = "";
  let currentMessage = "";
  let turnInProgress = false;
  const toolCalls = new Map<string, ChatItem & { type: "tool_call" }>();
  const permissions = new Map<string, ChatItem & { type: "permission_request" }>();
  const questions = new Map<string, ChatItem & { type: "question_request" }>();

  function flushThought() {
    if (currentThought.trim()) {
      items.push({ type: "agent_thought", text: currentThought.trim() });
    }
    currentThought = "";
  }

  function flushMessage() {
    const trimmed = currentMessage.trim();
    if (trimmed) {
      // Filter out session replay preamble — internal context not meant for the user
      if (!trimmed.startsWith("Previous session history is replayed below")) {
        items.push({ type: "agent_message", text: trimmed });
      }
    }
    currentMessage = "";
  }

  let lastPromptText: string | null = null;
  // When a duplicate prompt is detected, skip all events until the next
  // different prompt — this suppresses the duplicate response cycle too.
  let skipping = false;

  for (const event of events) {
    const parsed = parseEventPayload(event.payload);
    if (!parsed) continue;

    // Duplicate prompt cycle detection: if we see the same prompt text
    // again, skip it and all subsequent events until a new prompt arrives.
    if (parsed.type === "prompt") {
      if (parsed.text === lastPromptText) {
        skipping = true;
        continue;
      }
      skipping = false;
      lastPromptText = parsed.text;
    }

    if (skipping) continue;

    switch (parsed.type) {
      case "prompt":
        flushThought();
        flushMessage();
        items.push({ type: "user_prompt", text: parsed.text });
        break;

      case "agent_thought_chunk":
        flushMessage();
        currentThought += parsed.text;
        break;

      case "agent_message_chunk":
        flushThought();
        currentMessage += parsed.text;
        break;

      case "tool_call": {
        flushThought();
        flushMessage();
        const tc: ChatItem & { type: "tool_call" } = {
          type: "tool_call",
          toolCallId: parsed.toolCallId,
          toolName: parsed.toolName,
          title: parsed.title,
          kind: parsed.kind,
          status: parsed.status,
          locations: parsed.locations ?? [],
          content: parsed.content ?? [],
        };
        toolCalls.set(parsed.toolCallId, tc);
        items.push(tc);
        break;
      }

      case "tool_call_update": {
        const existing = toolCalls.get(parsed.toolCallId);
        if (existing) {
          existing.title = parsed.title || existing.title;
          existing.status = parsed.status ?? existing.status;
          if (parsed.locations?.length) existing.locations = parsed.locations;
          if (parsed.content?.length) existing.content = parsed.content;
        }
        break;
      }

      case "usage_update":
        flushThought();
        flushMessage();
        items.push({
          type: "usage",
          cost: parsed.cost,
          used: parsed.used,
          size: parsed.size,
        });
        break;

      case "permission_requested": {
        flushThought();
        flushMessage();
        const perm: ChatItem & { type: "permission_request" } = {
          type: "permission_request",
          permissionId: parsed.permissionId,
          action: parsed.action,
          status: "pending",
          metadata: parsed.metadata,
        };
        permissions.set(parsed.permissionId, perm);
        items.push(perm);
        break;
      }

      case "permission_resolved": {
        const existing = permissions.get(parsed.permissionId);
        if (existing) {
          existing.status = parsed.status === "reject" ? "rejected" : "accepted";
        }
        break;
      }

      case "question_requested": {
        flushThought();
        flushMessage();
        const q: ChatItem & { type: "question_request" } = {
          type: "question_request",
          questionId: parsed.questionId,
          prompt: parsed.prompt,
          options: parsed.options,
          status: "pending",
        };
        questions.set(parsed.questionId, q);
        items.push(q);
        break;
      }

      case "question_resolved": {
        const existing = questions.get(parsed.questionId);
        if (existing) {
          existing.status = parsed.status === "rejected" ? "rejected" : "answered";
          existing.response = parsed.response;
        }
        break;
      }

      case "turn_started":
        turnInProgress = true;
        break;

      case "turn_ended":
        turnInProgress = false;
        break;

      case "session_ended":
        flushThought();
        flushMessage();
        items.push({
          type: "session_ended",
          reason: parsed.reason,
          message: parsed.message,
        });
        break;

      case "error":
        flushThought();
        flushMessage();
        items.push({
          type: "error",
          message: parsed.message,
          code: parsed.code,
        });
        break;

      case "session_created":
        items.push({ type: "status", label: "Session created" });
        break;

      case "set_mode":
        items.push({ type: "status", label: "Mode set", detail: parsed.detail });
        break;

      case "session_cancelled":
        flushThought();
        flushMessage();
        items.push({ type: "status", label: "Session cancelled" });
        break;

      default:
        break;
    }
  }

  flushThought();
  flushMessage();

  return { items, turnInProgress };
}
