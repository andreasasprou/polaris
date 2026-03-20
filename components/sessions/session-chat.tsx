"use client";

import { useAutoScroll } from "@/hooks/use-auto-scroll";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon } from "lucide-react";
import { ChatItemRenderer } from "./chat-item-renderer";
import { TurnIndicator } from "./session-status";
import { ScrollToBottomButton } from "./scroll-to-bottom";
import { Spinner } from "./spinner";
import { getStatusConfig } from "@/lib/sessions/status";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

export type EmptyState = "spinner" | "terminal" | "idle";

/** Resolve what to show when the chat has no items. Exported for testing. */
export function resolveEmptyState(sessionStatus: string | null | undefined): EmptyState {
  if (!sessionStatus) return "spinner";
  const config = getStatusConfig(sessionStatus);
  if (config.isTerminal) return "terminal";
  if (!config.canStop && config.canSend && config.pollIntervalMs === 0) return "idle";
  return "spinner";
}

type SessionChatProps = {
  items: ChatItem[];
  turnInProgress: boolean;
  loading?: boolean;
  error?: Error | null;
  sessionStatus?: string | null;
};

const EMPTY_STATE_MESSAGES: Record<EmptyState, string> = {
  terminal: "No events recorded for this session.",
  idle: "Session ready. Send a message to begin.",
  spinner: "Waiting for agent...",
};

export function SessionChat({
  items,
  turnInProgress,
  loading,
  error,
  sessionStatus,
}: SessionChatProps) {
  const { scrollRef, isAtBottom, scrollToBottom, handleScroll } = useAutoScroll({
    dependency: items.length,
  });

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <Spinner className="text-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading session...</p>
      </div>
    );
  }

  if (error && items.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertDescription>Failed to load events: {error.message}</AlertDescription>
      </Alert>
    );
  }

  if (items.length === 0) {
    const state = resolveEmptyState(sessionStatus);
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        {state === "spinner" && <Spinner className="text-muted-foreground" />}
        <p className="text-sm text-muted-foreground">{EMPTY_STATE_MESSAGES[state]}</p>
      </div>
    );
  }

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="min-w-0 flex-1 overflow-y-auto overflow-x-hidden scrollbar-none scroll-fade"
      >
        <div className="flex min-w-0 flex-col gap-3 pb-4">
          {items.map((item, i) => (
            <ChatItemRenderer key={i} item={item} />
          ))}
          {turnInProgress && <TurnIndicator />}
        </div>
      </div>
      <ScrollToBottomButton
        visible={!isAtBottom}
        onClick={() => scrollToBottom(true)}
      />
    </div>
  );
}
