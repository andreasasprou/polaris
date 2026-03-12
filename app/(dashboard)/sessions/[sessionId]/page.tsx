"use client";

import { useEffect, useState, useCallback, useMemo, createContext, useContext } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useInputStreamSend } from "@trigger.dev/react-hooks";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircleIcon, ChevronLeftIcon } from "lucide-react";
import { StatusBadge } from "@/components/status-badge";
import { SessionChat } from "@/components/sessions/session-chat";
import { ChatInput, type Attachment } from "@/components/sessions/chat-input";
import { UserMessage } from "@/components/sessions/user-message";
import { useSessionChat } from "@/hooks/use-session-chat";
import { createSessionAccessToken } from "@/lib/trigger/access-tokens";
import { sessionMessages } from "@/lib/trigger/streams";
import { getStatusConfig } from "@/lib/sessions/status";
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

// ── Helpers ──

/** Send a prompt via the API route with retry for 425 (hibernating). */
async function sendPromptViaApi(
  sessionId: string,
  text: string,
): Promise<{ ok: boolean; triggerRunId?: string; accessToken?: string }> {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(
      `/api/interactive-sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: text }),
      },
    );

    if (res.status === 425) {
      const retryAfter = parseInt(res.headers.get("Retry-After") ?? "5", 10);
      await new Promise((r) => setTimeout(r, retryAfter * 1000));
      continue;
    }

    if (!res.ok) {
      const data = await res.json();
      console.error("Failed to send:", data.error);
      return { ok: false };
    }

    const data = await res.json();
    return {
      ok: true,
      triggerRunId: data.triggerRunId,
      accessToken: data.accessToken,
    };
  }
  console.error("Failed to send after retries (session hibernating)");
  return { ok: false };
}

async function fetchSession(sessionId: string): Promise<InteractiveSession | null> {
  try {
    const r = await fetch(`/api/interactive-sessions/${sessionId}`);
    if (!r.ok) return null;
    const data = await r.json();
    return data?.session ?? null;
  } catch {
    return null;
  }
}

async function stopSession(sessionId: string): Promise<void> {
  try {
    await fetch(`/api/interactive-sessions/${sessionId}`, { method: "DELETE" });
  } catch { /* ignore */ }
}

const TRIGGER_TERMINAL_STATES = ["CANCELED", "FAILED", "COMPLETED", "CRASHED", "SYSTEM_FAILURE", "TIMED_OUT"];

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

// ── Chat Input ──

function SessionChatInput({
  sessionId,
  triggerRunId,
  accessToken,
  status,
  turnInProgress,
  onRefresh,
  onPendingPrompt,
  onResumeRun,
  onStop,
  children,
}: {
  sessionId: string;
  triggerRunId?: string | null;
  accessToken?: string | null;
  status: string;
  turnInProgress: boolean;
  onRefresh: () => void;
  onPendingPrompt?: (text: string) => void;
  onResumeRun?: (triggerRunId: string, accessToken: string) => void;
  onStop: () => void;
  children: React.ReactNode;
}) {
  const [sending, setSending] = useState(false);
  const config = getStatusConfig(status);

  // Stream send — always called (hooks can't be conditional), but disabled
  // when triggerRunId/accessToken are unavailable to avoid auth errors.
  const hasStreamAccess = !!triggerRunId && !!accessToken;
  const {
    send,
    isLoading: isSending,
    isReady,
  } = useInputStreamSend<SessionMessage>(
    sessionMessages.id,
    triggerRunId ?? "",
    { accessToken: accessToken ?? "", enabled: hasStreamAccess },
  );

  const hasStream = hasStreamAccess && isReady;
  const canSend = config.canSend && (!config.hasLiveProcess || !turnInProgress);
  const isBusy = sending || isSending;

  // HITL actions via input stream (no-op when stream unavailable)
  const hitlActions: HitlActions = useMemo(() => ({
    replyPermission: (permissionId, reply) => {
      if (hasStream) send({ action: "permission_reply", permissionId, reply });
    },
    replyQuestion: (questionId, answers) => {
      if (hasStream) send({ action: "question_reply", questionId, answers });
    },
    rejectQuestion: (questionId) => {
      if (hasStream) send({ action: "question_reject", questionId });
    },
  }), [hasStream, send]);

  const handleSubmit = useCallback(
    async (text: string, _attachments: Attachment[]) => {
      if (!text.trim() || isBusy) return;

      onPendingPrompt?.(text.trim());

      // Route: direct stream send when process is alive and stream ready, else API
      if (config.sendPath === "stream" && hasStream) {
        send({ action: "prompt", prompt: text.trim(), nonce: crypto.randomUUID() });
      } else {
        setSending(true);
        try {
          const result = await sendPromptViaApi(sessionId, text.trim());
          if (result.ok) {
            // If the API returned a new run (resume), update immediately
            if (result.triggerRunId && result.accessToken) {
              onResumeRun?.(result.triggerRunId, result.accessToken);
            } else if (!config.hasLiveProcess) {
              onRefresh();
            }
          }
        } finally {
          setSending(false);
        }
      }
    },
    [config.sendPath, config.hasLiveProcess, hasStream, isBusy, send, sessionId, onRefresh, onPendingPrompt, onResumeRun],
  );

  const placeholder = !canSend
    ? turnInProgress
      ? "Agent is working..."
      : !config.isTerminal
        ? "Starting up..."
        : "Session failed"
    : config.hasLiveProcess
      ? "Send a message..."
      : "Send a message to resume...";

  return (
    <HitlContext.Provider value={hitlActions}>
      {children}
      <div className="shrink-0 px-1 pb-4 pt-3">
        <ChatInput
          onSubmit={handleSubmit}
          onStop={onStop}
          placeholder={placeholder}
          disabled={!canSend || isBusy}
          loading={isBusy}
          working={turnInProgress && config.hasLiveProcess}
        />
      </div>
    </HitlContext.Provider>
  );
}

// ── Page ──

export default function SessionDetailPage() {
  const { sessionId } = useParams<{ sessionId: string }>();
  const [session, setSession] = useState<InteractiveSession | null>(null);
  const [loading, setLoading] = useState(true);
  const [accessToken, setAccessToken] = useState<string | null>(null);
  const [pendingPrompt, setPendingPromptRaw] = useState<string | null>(null);

  const config = getStatusConfig(session?.status ?? "failed");

  // Fetch session from DB on mount
  useEffect(() => {
    fetchSession(sessionId).then((s) => {
      setSession(s);
      setLoading(false);
    });
  }, [sessionId]);

  // Obtain scoped access token on page load when session has a triggerRunId.
  // On resume, the prompt API returns the token directly — this effect is
  // only for initial page load / refresh.
  const triggerRunId = session?.triggerRunId ?? null;
  useEffect(() => {
    if (!triggerRunId || accessToken) return;
    createSessionAccessToken(sessionId)
      .then(setAccessToken)
      .catch((err) => {
        console.error("Failed to create access token:", err);
      });
  }, [sessionId, triggerRunId, accessToken]);

  // Unified chat hook — merges DB history + realtime current turn
  const chat = useSessionChat({
    sdkSessionId: session?.sdkSessionId ?? null,
    triggerRunId: config.isLive ? triggerRunId : null,
    accessToken: config.isLive ? accessToken : null,
    terminal: config.isTerminal,
  });

  const setPendingPrompt = useCallback((text: string | null) => {
    setPendingPromptRaw(text);
  }, []);

  // Sync realtime session status back to local state
  const sessionStatus = session?.status;
  useEffect(() => {
    if (chat.sessionStatus && sessionStatus !== undefined) {
      if (chat.sessionStatus !== sessionStatus) {
        setSession((prev) =>
          prev ? { ...prev, status: chat.sessionStatus! } : prev,
        );
      }
    }
  }, [chat.sessionStatus, sessionStatus]);

  // Refetch session from API (used after terminal state)
  const refreshSession = useCallback(() => {
    fetchSession(sessionId).then((s) => {
      if (s) setSession(s);
    });
  }, [sessionId]);

  const handleStop = useCallback(() => {
    stopSession(session?.id ?? sessionId);
  }, [session?.id, sessionId]);

  // Detect when the Trigger.dev run terminates — refresh session to get final state
  useEffect(() => {
    if (chat.runStatus && TRIGGER_TERMINAL_STATES.includes(chat.runStatus)) {
      refreshSession();
    }
  }, [chat.runStatus, refreshSession]);

  // Handle resume: prompt API returned a new triggerRunId + accessToken
  const handleResumeRun = useCallback(
    (newRunId: string, newAccessToken: string) => {
      setSession((prev) =>
        prev
          ? { ...prev, triggerRunId: newRunId, status: "creating" }
          : prev,
      );
      setAccessToken(newAccessToken);
    },
    [],
  );

  // Poll session status as a universal safety net.
  // Fast polling (2s) for provisioning states without realtime (creating, hibernating).
  // Slow polling (30s) for live states where realtime is primary but may fail.
  // Stops when the session reaches a terminal state or a stable non-polling state.
  const pollIntervalMs = config.pollIntervalMs;

  useEffect(() => {
    if (!pollIntervalMs) return;

    const poll = setInterval(async () => {
      const s = await fetchSession(sessionId);
      if (s) {
        setSession(s);
        // Stop polling if new status doesn't need it
        if (getStatusConfig(s.status).pollIntervalMs === 0) {
          clearInterval(poll);
        }
      }
    }, pollIntervalMs);

    // Safety cap — don't poll forever (2 hours max)
    const timeout = setTimeout(() => clearInterval(poll), 2 * 60 * 60_000);
    return () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [pollIntervalMs, sessionId]);

  // Clear optimistic prompt once the real event appears in the stream.
  // The pending prompt persists through status transitions (stopped → creating → active)
  // and is only removed when the realtime stream delivers the actual prompt event.
  useEffect(() => {
    if (!pendingPrompt) return;
    const alreadyInItems = chat.items.some(
      (item) => item.type === "user_prompt" && item.text === pendingPrompt,
    );
    if (alreadyInItems) {
      setPendingPromptRaw(null);
    }
  }, [pendingPrompt, chat.items]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!session) {
    return <p className="text-sm text-muted-foreground">Session not found.</p>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col px-6 pt-6">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-1 pb-3">
        <Link
          href="/sessions"
          className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronLeftIcon className="size-4" />
          Sessions
        </Link>
        <span className="text-muted-foreground/50">/</span>
        <div className="flex items-center gap-2">
          <h1 className="text-sm font-semibold capitalize">{session.agentType}</h1>
          <StatusBadge status={session.status} />
        </div>
        {chat.setupStep && (
          <span className="text-xs text-muted-foreground">
            {chat.setupStep}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {config.canStop && (
            <Button
              variant="ghost"
              size="sm"
              className="h-7 text-xs text-muted-foreground hover:text-destructive"
              onClick={handleStop}
            >
              Stop
            </Button>
          )}
        </div>
      </div>

      {session.error && session.status === "failed" && (
        <Alert variant="destructive" className="mb-4">
          <AlertCircleIcon />
          <AlertDescription>{session.error}</AlertDescription>
        </Alert>
      )}

      {/* Chat area + Input */}
      <SessionChatInput
        sessionId={session.id}
        triggerRunId={session.triggerRunId}
        accessToken={accessToken}
        status={session.status}
        turnInProgress={chat.turnInProgress}
        onRefresh={refreshSession}
        onPendingPrompt={setPendingPrompt}
        onResumeRun={handleResumeRun}
        onStop={handleStop}
      >
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <SessionChat
            items={chat.items}
            turnInProgress={chat.turnInProgress}
            loading={chat.loading}
            error={chat.error}
          />
          {pendingPrompt && <UserMessage text={pendingPrompt} />}
          {chat.setupStep && (
            <div className="flex items-center gap-2 py-3">
              <div className="size-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
              <span className="text-xs text-muted-foreground">
                {chat.setupStep}
              </span>
            </div>
          )}
        </div>
      </SessionChatInput>
    </div>
  );
}
