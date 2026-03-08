"use client";

import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";
import { consolidateEvents, type ChatItem } from "@/lib/sandbox-agent/event-types";
import type { SandboxAgentEvent } from "@/lib/sandbox-agent/SandboxAgentClient";
import type { EventStreamMap } from "@/lib/trigger/types";
import type { interactiveSessionTask } from "@/trigger/interactive-session";

type UseRealtimeSessionOptions = {
  triggerRunId: string | null;
  accessToken: string | null;
};

type UseRealtimeSessionReturn = {
  /** Consolidated chat items for rendering. */
  items: ChatItem[];
  /** Raw agent events from the output stream. */
  rawEvents: SandboxAgentEvent[];
  /** Current run status from Trigger.dev. */
  status: string | null;
  /** Session status from run metadata. */
  sessionStatus: string | null;
  /** SDK session ID from run metadata (for history fallback). */
  sdkSessionId: string | null;
  /** Current setup step (shown during "creating" phase). */
  setupStep: string | null;
  /** Error from the realtime subscription. */
  error: Error | null;
};

/**
 * Subscribe to a live interactive session via Trigger.dev realtime.
 * Provides consolidated chat items and run status.
 *
 * Note: Input stream sending is handled separately via `useInputStreamSend`
 * in components that have a valid access token (the hook requires a non-empty
 * token at call time and has no `enabled` flag).
 */
export function useRealtimeSession({
  triggerRunId,
  accessToken,
}: UseRealtimeSessionOptions): UseRealtimeSessionReturn {
  const enabled = !!triggerRunId && !!accessToken;

  const { run, streams, error } = useRealtimeRunWithStreams<
    typeof interactiveSessionTask,
    EventStreamMap
  >(triggerRunId ?? "", {
    accessToken: accessToken ?? "",
    enabled,
  });

  const rawEvents = (streams?.events ?? []) as SandboxAgentEvent[];
  const items = consolidateEvents(rawEvents);

  const meta = run?.metadata as Record<string, string> | undefined;

  return {
    items,
    rawEvents,
    status: run?.status ?? null,
    sessionStatus: meta?.status ?? null,
    sdkSessionId: meta?.sdkSessionId ?? null,
    setupStep: meta?.setupStep ?? null,
    error: error ?? null,
  };
}
