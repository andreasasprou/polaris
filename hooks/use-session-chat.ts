"use client";

import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import { useRealtimeRunWithStreams } from "@trigger.dev/react-hooks";
import {
  consolidateEvents,
  type ChatItem,
} from "@/lib/sandbox-agent/event-types";
import type { SandboxAgentEvent } from "@/lib/sandbox-agent/SandboxAgentClient";
import type { EventStreamMap } from "@/lib/trigger/types";
import type { interactiveSessionTask } from "@/trigger/interactive-session";

const TRIGGER_TERMINAL_STATES = [
  "CANCELED",
  "FAILED",
  "COMPLETED",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
];

type RawEvent = {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  sender: string;
  payload: Record<string, unknown>;
};

type UseSessionChatOptions = {
  /** SDK session ID for fetching historical events from DB. */
  sdkSessionId: string | null;
  /** Current Trigger.dev run ID for realtime subscription. */
  triggerRunId: string | null;
  /** Access token for the current run (run-scoped). */
  accessToken: string | null;
  /** Whether the session is in a terminal state (failed, stopped, completed). */
  terminal?: boolean;
};

type UseSessionChatReturn = {
  /** Consolidated chat items from all sources (DB + realtime). */
  items: ChatItem[];
  /** Whether the agent is currently working. */
  turnInProgress: boolean;
  /** Trigger.dev run status (QUEUED, EXECUTING, COMPLETED, etc.). */
  runStatus: string | null;
  /** App-level session status from run metadata. */
  sessionStatus: string | null;
  /** Current setup phase (shown during provisioning). */
  setupStep: string | null;
  /** Whether the initial DB fetch is loading. */
  loading: boolean;
  /** Error from either source. */
  error: Error | null;
};

/**
 * Unified hook for session event display.
 *
 * Merges two sources:
 * 1. DB events (historical, all past turns) — fetched once on mount
 * 2. Realtime events (current turn) — streamed via Trigger.dev SSE
 *
 * Events are deduplicated by eventIndex (realtime wins on conflict)
 * and consolidated into displayable ChatItems.
 */
export function useSessionChat({
  sdkSessionId,
  triggerRunId,
  accessToken,
  terminal,
}: UseSessionChatOptions): UseSessionChatReturn {
  // ── DB layer: historical events ──
  const [dbEvents, setDbEvents] = useState<RawEvent[]>([]);
  const [dbLoading, setDbLoading] = useState(false);
  const [dbError, setDbError] = useState<Error | null>(null);
  const prevRunStatusRef = useRef<string | null>(null);

  const fetchDbEvents = useCallback(async () => {
    if (!sdkSessionId) return;
    setDbLoading(true);
    setDbError(null);
    try {
      // Paginate through all events — sessions with many tool calls
      // can easily exceed a single page. Without full pagination,
      // tail events (including the final response) get lost on refresh.
      const pageSize = 500;
      let allItems: RawEvent[] = [];
      let offset = 0;

      for (;;) {
        const r = await fetch(
          `/api/sessions/${sdkSessionId}/events?limit=${pageSize}&offset=${offset}`,
        );
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        const items: RawEvent[] = data.items ?? [];
        allItems = allItems.concat(items);

        if (items.length < pageSize) break; // last page
        offset += pageSize;
      }

      setDbEvents(allItems);
    } catch (err) {
      setDbError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setDbLoading(false);
    }
  }, [sdkSessionId]);

  // Fetch DB events on mount / when sdkSessionId changes
  useEffect(() => {
    fetchDbEvents();
  }, [fetchDbEvents]);

  // ── Realtime layer: current turn events ──
  const realtimeEnabled = !!triggerRunId && !!accessToken;

  const { run, streams, error: realtimeError } = useRealtimeRunWithStreams<
    typeof interactiveSessionTask,
    EventStreamMap
  >(triggerRunId ?? "", {
    accessToken: accessToken ?? "",
    enabled: realtimeEnabled,
  });

  const realtimeEvents = (streams?.events ?? []) as SandboxAgentEvent[];

  // Re-fetch DB events when the realtime run reaches a terminal state
  // (ensures final events from the completed turn are captured)
  const runStatus = run?.status ?? null;
  useEffect(() => {
    const prev = prevRunStatusRef.current;
    prevRunStatusRef.current = runStatus;

    if (
      runStatus &&
      TRIGGER_TERMINAL_STATES.includes(runStatus) &&
      prev &&
      !TRIGGER_TERMINAL_STATES.includes(prev)
    ) {
      // Small delay to let the persist driver flush
      const timer = setTimeout(fetchDbEvents, 1000);
      return () => clearTimeout(timer);
    }
  }, [runStatus, fetchDbEvents]);

  // ── Merge: DB events + realtime events, dedup by eventIndex ──
  const { items, turnInProgress } = useMemo(() => {
    const eventMap = new Map<number, SandboxAgentEvent>();

    // DB events first (lower priority)
    for (const event of dbEvents) {
      eventMap.set(event.eventIndex, event as unknown as SandboxAgentEvent);
    }

    // Realtime events overwrite (higher priority — fresher data)
    for (const event of realtimeEvents) {
      eventMap.set(event.eventIndex, event);
    }

    const sorted = [...eventMap.values()].sort(
      (a, b) => a.eventIndex - b.eventIndex,
    );

    return consolidateEvents(sorted, { terminal });
  }, [dbEvents, realtimeEvents, terminal]);

  // ── Metadata from realtime ──
  const meta = run?.metadata as Record<string, string> | undefined;

  return {
    items,
    turnInProgress,
    runStatus,
    sessionStatus: meta?.status ?? null,
    setupStep: meta?.setupStep ?? null,
    loading: dbLoading && items.length === 0,
    error: dbError ?? realtimeError ?? null,
  };
}
