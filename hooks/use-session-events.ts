"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { consolidateEvents, type ChatItem } from "@/lib/sandbox-agent/event-types";

type RawEvent = {
  id: string;
  eventIndex: number;
  sessionId: string;
  createdAt: number;
  sender: string;
  payload: Record<string, unknown>;
};

type UseSessionEventsOptions = {
  sessionId: string | null;
  /** Whether to open an SSE connection for live streaming. */
  live?: boolean;
};

type UseSessionEventsReturn = {
  items: ChatItem[];
  rawEvents: RawEvent[];
  loading: boolean;
  error: string | null;
  /** Whether the SSE stream is currently connected. */
  streaming: boolean;
};

/**
 * Hook that loads session events (paginated) and optionally streams live via SSE.
 * Consolidates raw events into displayable chat items.
 */
export function useSessionEvents({
  sessionId,
  live = false,
}: UseSessionEventsOptions): UseSessionEventsReturn {
  const [rawEvents, setRawEvents] = useState<RawEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Load initial events
  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);

    fetch(`/api/sessions/${sessionId}/events?limit=500`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        setRawEvents(data.items ?? []);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message);
        setLoading(false);
      });
  }, [sessionId]);

  // SSE for live streaming
  useEffect(() => {
    if (!sessionId || !live) return;

    const source = new EventSource(
      `/api/sessions/${sessionId}/events/stream`,
    );

    eventSourceRef.current = source;
    setStreaming(true);

    source.addEventListener("event", (e) => {
      const event = JSON.parse(e.data) as RawEvent;
      setRawEvents((prev) => {
        // Dedupe by id
        if (prev.some((p) => p.id === event.id)) return prev;
        return [...prev, event];
      });
    });

    source.addEventListener("done", () => {
      setStreaming(false);
      source.close();
    });

    source.addEventListener("error", () => {
      setStreaming(false);
    });

    return () => {
      source.close();
      eventSourceRef.current = null;
      setStreaming(false);
    };
  }, [sessionId, live]);

  // Consolidate into chat items
  const { items } = consolidateEvents(rawEvents);

  return { items, rawEvents, loading, error, streaming };
}
