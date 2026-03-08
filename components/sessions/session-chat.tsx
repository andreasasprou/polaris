"use client";

import { useRef, useEffect } from "react";
import { useSessionEvents } from "@/hooks/use-session-events";
import { useRealtimeSession } from "@/hooks/use-realtime-session";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

function UserPrompt({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-lg bg-accent px-4 py-3">
        <pre className="whitespace-pre-wrap text-sm">{text}</pre>
      </div>
    </div>
  );
}

function AgentMessage({ text }: { text: string }) {
  return (
    <div className="max-w-[80%]">
      <div className="rounded-lg border border-border px-4 py-3">
        <pre className="whitespace-pre-wrap text-sm">{text}</pre>
      </div>
    </div>
  );
}

function AgentThought({ text }: { text: string }) {
  return (
    <div className="max-w-[80%]">
      <div className="rounded-lg border border-dashed border-border px-4 py-3">
        <p className="mb-1 text-xs font-medium text-muted-foreground">
          Thinking
        </p>
        <pre className="whitespace-pre-wrap text-sm text-muted-foreground">
          {text}
        </pre>
      </div>
    </div>
  );
}

/** Extract displayable text from tool call content entries. */
function extractToolOutput(
  content: Array<Record<string, unknown>>,
): { text?: string; diff?: { oldText: string; newText: string } } {
  for (const entry of content) {
    // Diff content (Edit tool)
    if (entry.type === "diff" && entry.oldText && entry.newText) {
      return {
        diff: {
          oldText: entry.oldText as string,
          newText: entry.newText as string,
        },
      };
    }
    // Read content — nested content.content.text
    if (entry.type === "content" && entry.content) {
      const inner = entry.content as Record<string, unknown>;
      if (inner.text) return { text: inner.text as string };
    }
    // Direct text
    if (entry.text) return { text: entry.text as string };
  }
  return {};
}

function ToolCallItem({
  toolName,
  title,
  kind,
  status,
  locations,
  content,
}: {
  toolName: string;
  title: string;
  kind: string;
  status: string;
  locations: Array<{ path: string; line?: number }>;
  content: Array<Record<string, unknown>>;
}) {
  const statusColors: Record<string, string> = {
    pending: "text-yellow-600",
    running: "text-blue-600",
    completed: "text-green-600",
    failed: "text-red-600",
  };

  const output = extractToolOutput(content);

  return (
    <div className="max-w-[90%]">
      <div className="rounded-lg border border-border bg-muted/30 px-4 py-2">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs font-medium text-muted-foreground">
            {toolName}
          </span>
          <span className="text-muted-foreground">{title}</span>
          {status && (
            <span
              className={`ml-auto text-xs ${statusColors[status] ?? "text-muted-foreground"}`}
            >
              {status}
            </span>
          )}
        </div>
        {locations.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {locations.map((loc, i) => (
              <span
                key={i}
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
              >
                {loc.path}
                {loc.line != null ? `:${loc.line}` : ""}
              </span>
            ))}
          </div>
        )}
        {output.diff && (
          <div className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2 font-mono text-xs">
            {output.diff.oldText.split("\n").map((line, i) => (
              <div key={`old-${i}`} className="text-red-600">
                - {line}
              </div>
            ))}
            {output.diff.newText.split("\n").map((line, i) => (
              <div key={`new-${i}`} className="text-green-600">
                + {line}
              </div>
            ))}
          </div>
        )}
        {output.text && (
          <div className="mt-2 max-h-48 overflow-auto rounded bg-muted p-2">
            <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
              {output.text.slice(0, 2000)}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}

function UsageItem({
  cost,
  used,
  size,
}: {
  cost?: { amount: number; currency: string };
  used?: number;
  size?: number;
}) {
  return (
    <div className="flex justify-center">
      <div className="flex items-center gap-3 rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        {cost && (
          <span>
            ${cost.amount.toFixed(4)} {cost.currency}
          </span>
        )}
        {used != null && size != null && (
          <span>
            {((used / size) * 100).toFixed(0)}% context used
          </span>
        )}
      </div>
    </div>
  );
}

function StatusItem({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex justify-center">
      <span className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground">
        {label}
        {detail ? `: ${detail}` : ""}
      </span>
    </div>
  );
}

function ChatItemRenderer({ item }: { item: ChatItem }) {
  switch (item.type) {
    case "user_prompt":
      return <UserPrompt text={item.text} />;
    case "agent_message":
      return <AgentMessage text={item.text} />;
    case "agent_thought":
      return <AgentThought text={item.text} />;
    case "tool_call":
      return (
        <ToolCallItem
          toolName={item.toolName}
          title={item.title}
          kind={item.kind}
          status={item.status}
          locations={item.locations}
          content={item.content}
        />
      );
    case "usage":
      return <UsageItem cost={item.cost} used={item.used} size={item.size} />;
    case "status":
      return <StatusItem label={item.label} detail={item.detail} />;
    default:
      return null;
  }
}

type SessionChatProps =
  | { mode: "live"; triggerRunId: string; accessToken: string }
  | { mode: "history"; sdkSessionId: string };

/**
 * Renders agent events as a chat timeline.
 * - `mode: "live"` — subscribes to a running task's output stream via Trigger.dev realtime.
 * - `mode: "history"` — loads completed session events via REST.
 */
export function SessionChat(props: SessionChatProps) {
  if (props.mode === "live") {
    return (
      <LiveSessionChat
        triggerRunId={props.triggerRunId}
        accessToken={props.accessToken}
      />
    );
  }

  return <HistorySessionChat sdkSessionId={props.sdkSessionId} />;
}

function LiveSessionChat({
  triggerRunId,
  accessToken,
}: {
  triggerRunId: string;
  accessToken: string;
}) {
  const { items, error } = useRealtimeSession({
    triggerRunId,
    accessToken,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">
          Failed to connect: {error.message}
        </p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <p className="text-sm text-muted-foreground">
          Waiting for agent events...
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
        Live
      </div>
      {items.map((item, i) => (
        <ChatItemRenderer key={i} item={item} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}

function HistorySessionChat({
  sdkSessionId,
}: {
  sdkSessionId: string;
}) {
  const { items, loading, error, streaming } = useSessionEvents({
    sessionId: sdkSessionId,
    live: false,
  });
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  if (loading) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Loading session events...
      </p>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">Failed to load events: {error}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No events recorded for this session.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {streaming && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-500" />
          Live
        </div>
      )}
      {items.map((item, i) => (
        <ChatItemRenderer key={i} item={item} />
      ))}
      <div ref={bottomRef} />
    </div>
  );
}
