"use client";

import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { STATUS_CONFIG, type SessionStatus } from "@/lib/sessions/status";

// ── Types ──

export type SidebarSession = {
  id: string;
  status: string;
  title: string;
  createdAt: string;
  repoOwner: string | null;
  repoName: string | null;
  needsAttention: boolean;
};

export type RepoGroup = {
  key: string;
  label: string;
  sessions: SidebarSession[];
  hasAttention: boolean;
  activeCount: number;
};

type UseSidebarSessionsReturn = {
  groups: RepoGroup[];
  loading: boolean;
  error: Error | null;
};

// ── Helpers ──

function relativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr).getTime();
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);

  if (diffSec < 60) return "just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  const diffHrs = Math.floor(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h`;
  const diffDays = Math.floor(diffHrs / 24);
  if (diffDays < 30) return `${diffDays}d`;
  return new Date(dateStr).toLocaleDateString();
}

export { relativeTime };

function hasNonTerminalSession(sessions: SidebarSession[]): boolean {
  return sessions.some((s) => {
    const config = STATUS_CONFIG[s.status as SessionStatus];
    return config != null && !config.isTerminal;
  });
}

const POLL_ACTIVE_MS = 5_000;

// ── Hook ──

export function useSidebarSessions(): UseSidebarSessionsReturn {
  const [sessions, setSessions] = useState<SidebarSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);

  const fetchSessions = useCallback(async () => {
    try {
      const res = await fetch("/api/interactive-sessions/sidebar");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (mountedRef.current) {
        setSessions(data.sessions ?? []);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }, []);

  // Initial fetch
  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    fetchSessions().finally(() => {
      if (mountedRef.current) setLoading(false);
    });
    return () => {
      mountedRef.current = false;
    };
  }, [fetchSessions]);

  // Polling: 5s if any session is non-terminal, 0 otherwise
  const shouldPoll = useMemo(
    () => hasNonTerminalSession(sessions),
    [sessions],
  );

  useEffect(() => {
    if (!shouldPoll) return;
    const timer = setInterval(fetchSessions, POLL_ACTIVE_MS);
    return () => clearInterval(timer);
  }, [shouldPoll, fetchSessions]);

  // Group sessions by repo
  const groups = useMemo<RepoGroup[]>(() => {
    const map = new Map<string, SidebarSession[]>();
    for (const s of sessions) {
      const key =
        s.repoOwner && s.repoName
          ? `${s.repoOwner}/${s.repoName}`
          : "_ungrouped";
      const arr = map.get(key);
      if (arr) {
        arr.push(s);
      } else {
        map.set(key, [s]);
      }
    }

    const result: RepoGroup[] = [];
    for (const [key, groupSessions] of map) {
      // Sessions already sorted by createdAt DESC from API
      const hasAttention = groupSessions.some((s) => s.needsAttention);
      const activeCount = groupSessions.filter(
        (s) => !STATUS_CONFIG[s.status as SessionStatus]?.isTerminal,
      ).length;
      result.push({
        key,
        label: key === "_ungrouped" ? "No Repository" : key,
        sessions: groupSessions,
        hasAttention,
        activeCount,
      });
    }

    // Sort groups alphabetically, ungrouped last
    result.sort((a, b) => {
      if (a.key === "_ungrouped") return 1;
      if (b.key === "_ungrouped") return -1;
      return a.key.localeCompare(b.key);
    });

    return result;
  }, [sessions]);

  return { groups, loading, error };
}
