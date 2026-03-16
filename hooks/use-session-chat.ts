"use client";

import { useMemo, useEffect, useState, useCallback, useRef } from "react";
import {
  consolidateEvents,
  type ChatItem,
} from "@/lib/sandbox-agent/event-types";
import type { SandboxAgentEvent } from "@/lib/sandbox-agent/SandboxAgentClient";

type RawEvent = {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  sender: string;
  payload: Record<string, unknown>;
};

type UseSessionChatOptions = {
  /** SDK session ID for fetching events from DB. */
  sdkSessionId: string | null;
  /** Session status — determines poll interval. */
  sessionStatus: string | null;
  /** Whether the session is in a terminal state. */
  terminal?: boolean;
};

type UseSessionChatReturn = {
  /** Consolidated chat items. */
  items: ChatItem[];
  /** Whether the agent is currently working. */
  turnInProgress: boolean;
  /** Whether the initial DB fetch is loading. */
  loading: boolean;
  /** Error from fetching. */
  error: Error | null;
  /** Trigger a manual refresh. */
  refresh: () => void;
};

// Poll intervals by session status
function getPollInterval(status: string | null): number {
  switch (status) {
    case "active":
    case "creating":
    case "snapshotting":
      return 2000;
    case "idle":
    case "hibernated":
    case "stopped":
    case "failed":
    case "completed":
      return 0; // No polling for stable states
    default:
      return 0;
  }
}

/**
 * Unified hook for session event display.
 *
 * Fetches events from DB via polling. Poll interval depends on session status:
 * - 2s during active/creating/snapshotting
 * - 0 (no polling) for stable states
 */
export function useSessionChat({
  sdkSessionId,
  sessionStatus,
  terminal,
}: UseSessionChatOptions): UseSessionChatReturn {
  const [dbEvents, setDbEvents] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetchEvents = useCallback(async () => {
    if (!sdkSessionId) return;
    try {
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

        if (items.length < pageSize) break;
        offset += pageSize;
      }

      if (mountedRef.current) {
        setDbEvents(allItems);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }, [sdkSessionId]);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchEvents().finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [fetchEvents]);

  // Polling
  const pollInterval = getPollInterval(sessionStatus);
  useEffect(() => {
    if (!pollInterval) return;
    const timer = setInterval(fetchEvents, pollInterval);
    return () => clearInterval(timer);
  }, [fetchEvents, pollInterval]);

  const { items, turnInProgress } = useMemo(() => {
    const sorted = [...dbEvents]
      .sort((a, b) => a.eventIndex - b.eventIndex)
      .map((e) => e as unknown as SandboxAgentEvent);
    return consolidateEvents(sorted, { terminal });
  }, [dbEvents, terminal]);

  return {
    items,
    turnInProgress,
    loading: loading && items.length === 0,
    error,
    refresh: fetchEvents,
  };
}
