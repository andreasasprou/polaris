"use client";

import { useEffect, useState, useCallback, createContext, useContext } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useInputStreamSend } from "@trigger.dev/react-hooks";
import { SessionChat } from "@/components/sessions/session-chat";
import { useRealtimeSession } from "@/hooks/use-realtime-session";
import { createSessionAccessToken } from "@/lib/trigger/access-tokens";
import { sessionMessages } from "@/lib/trigger/streams";
import type { SessionMessage } from "@/lib/trigger/types";

type InteractiveSession = {
  id: string;
  agentType: string;
  status: string;
  sdkSessionId: string | null;
  triggerRunId: string | null;
  sandboxBaseUrl: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
};

// ── HITL Action Context ──

export type HitlActions = {
  replyPermission: (permissionId: string, reply: string) => void;
  replyQuestion: (questionId: string, answers: string[][]) => void;
  rejectQuestion: (questionId: string) => void;
};

const HitlContext = createContext<HitlActions | null>(null);

export function useHitlActions(): HitlActions | null {
  return useContext(HitlContext);
}

// ── Components ──

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    creating: "bg-yellow-100 text-yellow-800",
    active: "bg-green-100 text-green-800",
    idle: "bg-blue-100 text-blue-800",
    completed: "bg-gray-100 text-gray-800",
    failed: "bg-red-100 text-red-800",
    stopped: "bg-blue-100 text-blue-800",
  };

  const labels: Record<string, string> = {
    idle: "paused",
    stopped: "paused",
    completed: "paused",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {labels[status] ?? status}
    </span>
  );
}

/**
 * Chat input that uses `useInputStreamSend` for active sessions.
 * Only mounted when triggerRunId + accessToken are available,
 * since the hook requires a valid token at call time.
 */
function ActiveChatInput({
  sessionId,
  triggerRunId,
  accessToken,
  status,
  turnInProgress,
  onResumeTriggered,
  children,
}: {
  sessionId: string;
  triggerRunId: string;
  accessToken: string;
  status: string;
  turnInProgress: boolean;
  onResumeTriggered: () => void;
  children: React.ReactNode;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);

  const {
    send,
    isLoading: isSending,
    isReady,
  } = useInputStreamSend<SessionMessage>(
    sessionMessages.id,
    triggerRunId,
    { accessToken },
  );

  const isResumable = status === "idle" || status === "stopped" || status === "completed";
  const isActive = status === "active";
  const canSend = (isActive && !turnInProgress) || isResumable;

  // HITL actions via input stream
  const hitlActions: HitlActions = {
    replyPermission: (permissionId, reply) => {
      if (isReady) {
        send({ action: "permission_reply", permissionId, reply });
      }
    },
    replyQuestion: (questionId, answers) => {
      if (isReady) {
        send({ action: "question_reply", questionId, answers });
      }
    },
    rejectQuestion: (questionId) => {
      if (isReady) {
        send({ action: "question_reject", questionId });
      }
    },
  };

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || sending || isSending) return;

    // Active session: prefer direct input stream, fall back to API route
    if (isActive) {
      if (isReady) {
        send({ action: "prompt", prompt: prompt.trim() });
        setPrompt("");
      } else {
        // Input stream not ready yet — send via API route as fallback
        setSending(true);
        try {
          const res = await fetch(
            `/api/interactive-sessions/${sessionId}/prompt`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ prompt: prompt.trim() }),
            },
          );
          if (!res.ok) {
            const data = await res.json();
            console.error("Failed to send:", data.error);
          } else {
            setPrompt("");
          }
        } finally {
          setSending(false);
        }
      }
      return;
    }

    if (isResumable) {
      setSending(true);
      try {
        const res = await fetch(
          `/api/interactive-sessions/${sessionId}/prompt`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt }),
          },
        );

        if (!res.ok) {
          const data = await res.json();
          console.error("Failed to send:", data.error);
        } else {
          setPrompt("");
          onResumeTriggered();
        }
      } finally {
        setSending(false);
      }
    }
  }

  const isBusy = sending || isSending;

  const placeholder = !canSend
    ? turnInProgress
      ? "Agent is working..."
      : status === "creating"
        ? "Starting up..."
        : "Session failed"
    : isResumable
      ? "Send a message to resume..."
      : "Send a message...";

  return (
    <HitlContext.Provider value={hitlActions}>
      {children}
      <div className="border-t border-border pt-4">
        <form onSubmit={handleSend} className="flex gap-2">
          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={placeholder}
            disabled={!canSend || isBusy}
            className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:opacity-50"
          />
          <button
            type="submit"
            disabled={!canSend || isBusy || !prompt.trim()}
            className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {isBusy ? (isResumable ? "Resuming..." : "Sending...") : "Send"}
          </button>
        </form>
      </div>
    </HitlContext.Provider>
  );
}

/**
 * Fallback chat input for sessions without an active trigger run
 * (stopped/completed sessions that need resume via API route).
 */
function FallbackChatInput({
  sessionId,
  status,
  onResumeTriggered,
}: {
  sessionId: string;
  status: string;
  onResumeTriggered: () => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [sending, setSending] = useState(false);

  const isResumable = status === "idle" || status === "stopped" || status === "completed";
  const canSend = isResumable;

  async function handleSend(e: React.FormEvent) {
    e.preventDefault();
    if (!prompt.trim() || sending) return;

    setSending(true);
    try {
      const res = await fetch(
        `/api/interactive-sessions/${sessionId}/prompt`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt }),
        },
      );

      if (!res.ok) {
        const data = await res.json();
        console.error("Failed to send:", data.error);
      } else {
        setPrompt("");
        onResumeTriggered();
      }
    } finally {
      setSending(false);
    }
  }

  const placeholder = !canSend
    ? status === "creating"
      ? "Starting up..."
      : "Session failed"
    : "Send a message to resume...";

  return (
    <form onSubmit={handleSend} className="flex gap-2">
      <input
        type="text"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={placeholder}
        disabled={!canSend || sending}
        className="flex-1 rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground disabled:opacity-50"
      />
      <button
        type="submit"
        disabled={!canSend || sending || !prompt.trim()}
        className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
      >
        {sending ? "Resuming..." : "Send"}
      </button>
    </form>
  );
}

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<InteractiveSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);

  // Fetch session from DB on mount
  useEffect(() => {
    fetch(`/api/interactive-sessions/${sessionId}`)
      .then((r) => {
        if (!r.ok) return null;
        return r.json();
      })
      .then((data) => {
        setSession(data?.session ?? null);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [sessionId]);

  // Obtain scoped access token when session has a triggerRunId.
  // Re-mint when triggerRunId changes (e.g. after resume creates a new run).
  const triggerRunId = session?.triggerRunId ?? null;
  useEffect(() => {
    if (!triggerRunId) return;

    // Clear stale token immediately so we don't use it for the wrong run
    setAccessToken(null);

    createSessionAccessToken(sessionId)
      .then(setAccessToken)
      .catch((err) => {
        console.error("Failed to create access token:", err);
      });
  }, [sessionId, triggerRunId]);

  // Realtime subscription for live sessions
  const isLive =
    session?.status === "active" || session?.status === "creating";
  const realtime = useRealtimeSession({
    triggerRunId: isLive ? (session?.triggerRunId ?? null) : null,
    accessToken: isLive ? accessToken : null,
  });

  // Sync realtime status back to local session state
  useEffect(() => {
    if (realtime.sessionStatus && session) {
      if (realtime.sessionStatus !== session.status) {
        setSession((prev) =>
          prev ? { ...prev, status: realtime.sessionStatus! } : prev,
        );
      }
    }
  }, [realtime.sessionStatus, session]);

  // Detect when the Trigger.dev run terminates (cancelled, failed, etc.)
  // and re-fetch session from DB to get the true status
  useEffect(() => {
    const terminalStates = ["CANCELED", "FAILED", "COMPLETED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT"];
    if (realtime.status && terminalStates.includes(realtime.status)) {
      fetch(`/api/interactive-sessions/${sessionId}`)
        .then((r) => r.ok ? r.json() : null)
        .then((data) => {
          if (data?.session) setSession(data.session);
        })
        .catch(() => {});
    }
  }, [realtime.status, sessionId]);

  // Poll while session is "creating" to detect when triggerRunId is set
  // and status transitions to "active". Covers both initial creation and resume.
  useEffect(() => {
    if (session?.status !== "creating") return;

    const poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/interactive-sessions/${sessionId}`);
        if (!r.ok) return;
        const d = await r.json();
        if (d.session) {
          setSession(d.session);
          if (d.session.status !== "creating") {
            clearInterval(poll);
          }
        }
      } catch { /* ignore */ }
    }, 2000);

    const timeout = setTimeout(() => clearInterval(poll), 120_000);
    return () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [session?.status, sessionId]);

  // After resume: trigger the creating poll by setting status
  const handleResumeTriggered = useCallback(() => {
    // The "creating" status is already set by the API route.
    // Re-fetch session to pick it up and trigger the poll above.
    fetch(`/api/interactive-sessions/${sessionId}`)
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (data?.session) setSession(data.session);
      })
      .catch(() => {});
  }, [sessionId]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!session) {
    return <p className="text-sm text-muted-foreground">Session not found.</p>;
  }

  const isActive = session.status === "active";
  const isCreating = session.status === "creating";
  const hasRealtimeAccess = !!session.triggerRunId && !!accessToken;

  // Use live stream once it has events; otherwise fall back to history to avoid layout shift
  const liveHasEvents = realtime.items.length > 0;
  const canShowLive = !!(session.triggerRunId && accessToken && (isActive || isCreating));

  // Chat content to render — always show history first, append live events below
  let chatContent: React.ReactNode;
  if (session.sdkSessionId) {
    // Session has history — always show it
    chatContent = (
      <>
        <SessionChat mode="history" sdkSessionId={session.sdkSessionId} />
        {canShowLive && liveHasEvents && (
          <SessionChat
            mode="live"
            triggerRunId={session.triggerRunId!}
            accessToken={accessToken!}
            skipInitialPrompt
          />
        )}
        {canShowLive && !liveHasEvents && (
          <div className="flex items-center gap-2 py-3">
            <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
            <span className="text-xs text-muted-foreground">
              {realtime.setupStep ?? "Resuming session..."}
            </span>
          </div>
        )}
      </>
    );
  } else if (canShowLive) {
    // Fresh session — no history yet, show live only
    chatContent = (
      <SessionChat
        mode="live"
        triggerRunId={session.triggerRunId!}
        accessToken={accessToken!}
      />
    );
  } else if (isCreating) {
    chatContent = (
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent" />
        <p className="text-sm text-muted-foreground">
          {realtime.setupStep ?? "Provisioning sandbox..."}
        </p>
      </div>
    );
  } else {
    chatContent = (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No session data available.
      </p>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 pb-4">
        <Link
          href="/sessions"
          className="text-sm text-muted-foreground hover:underline"
        >
          Sessions
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-xl font-medium">{session.agentType}</h1>
        <StatusBadge status={session.status} />
        {isCreating && (
          <span className="text-sm text-muted-foreground">
            {realtime.setupStep ?? "Setting up sandbox..."}
          </span>
        )}
        {isActive && (
          <button
            onClick={async () => {
              await fetch(`/api/interactive-sessions/${session.id}`, {
                method: "DELETE",
              });
            }}
            className="ml-auto rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
          >
            Stop
          </button>
        )}
      </div>

      {session.error && session.status === "failed" && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-sm text-red-700">{session.error}</p>
        </div>
      )}

      {/* Chat area + Input — wrapped in HITL context when active */}
      {hasRealtimeAccess ? (
        <ActiveChatInput
          sessionId={session.id}
          triggerRunId={session.triggerRunId!}
          accessToken={accessToken!}
          status={session.status}
          turnInProgress={realtime.turnInProgress}
          onResumeTriggered={handleResumeTriggered}
        >
          <div className="min-h-0 flex-1 overflow-auto pb-4">
            {chatContent}
          </div>
        </ActiveChatInput>
      ) : (
        <>
          <div className="min-h-0 flex-1 overflow-auto pb-4">
            {chatContent}
          </div>
          <div className="border-t border-border pt-4">
            <FallbackChatInput
              sessionId={session.id}
              status={session.status}
              onResumeTriggered={handleResumeTriggered}
            />
          </div>
        </>
      )}
    </div>
  );
}
