"use client";

import { useEffect, useState, useCallback, useMemo, createContext, useContext } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ChevronLeftIcon } from "lucide-react";
import { SessionErrorAlert } from "@/components/sessions/session-error-alert";
import { StatusBadge } from "@/components/status-badge";
import { SessionChat } from "@/components/sessions/session-chat";
import { ChatInput, type Attachment } from "@/components/sessions/chat-input";
import { UserMessage } from "@/components/sessions/user-message";
import { useSessionChat } from "@/hooks/use-session-chat";
import { getStatusConfig } from "@/lib/sessions/status";

type InteractiveSession = {
  id: string;
  agentType: string;
  status: string;
  sdkSessionId: string | null;
  sandboxBaseUrl: string | null;
  prompt: string;
  summary: string | null;
  error: string | null;
  createdAt: string;
  endedAt: string | null;
};

// ── Helpers ──

type ApiAttachment = {
  name: string;
  mimeType: string;
  data: string; // base64
};

/** Convert a File to a base64-encoded API attachment. */
function fileToApiAttachment(file: File): Promise<ApiAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      const base64 = dataUrl.split(",")[1];
      resolve({ name: file.name, mimeType: file.type, data: base64 });
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Send a prompt via the API route with retry for 425 (hibernating). */
async function sendPromptViaApi(
  sessionId: string,
  text: string,
  attachments?: Attachment[],
): Promise<{ ok: boolean; jobId?: string }> {
  // Convert File objects to base64
  let apiAttachments: ApiAttachment[] | undefined;
  if (attachments?.length) {
    apiAttachments = await Promise.all(
      attachments.map((a) => fileToApiAttachment(a.file)),
    );
  }

  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fetch(
      `/api/interactive-sessions/${sessionId}/prompt`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: text,
          ...(apiAttachments?.length ? { attachments: apiAttachments } : {}),
        }),
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
    return { ok: true, jobId: data.jobId };
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
  status,
  turnInProgress,
  onRefresh,
  onPendingPrompt,
  onStop,
  children,
}: {
  sessionId: string;
  status: string;
  turnInProgress: boolean;
  onRefresh: () => void;
  onPendingPrompt?: (text: string) => void;
  onStop: () => void;
  children: React.ReactNode;
}) {
  const [sending, setSending] = useState(false);
  const config = getStatusConfig(status);

  const canSend = config.canSend && !turnInProgress;

  // HITL actions via REST
  const hitlActions: HitlActions = useMemo(() => ({
    replyPermission: (permissionId, reply) => {
      fetch(`/api/interactive-sessions/${sessionId}/permission`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissionId, reply }),
      }).catch(console.error);
    },
    replyQuestion: (questionId, answers) => {
      fetch(`/api/interactive-sessions/${sessionId}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answers }),
      }).catch(console.error);
    },
    rejectQuestion: (questionId) => {
      fetch(`/api/interactive-sessions/${sessionId}/question`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ questionId, answers: { __reject: "true" } }),
      }).catch(console.error);
    },
  }), [sessionId]);

  const handleSubmit = useCallback(
    async (text: string, attachments: Attachment[]) => {
      if (!text.trim() && attachments.length === 0) return;
      if (sending) return;

      onPendingPrompt?.(text.trim());

      setSending(true);
      try {
        const result = await sendPromptViaApi(
          sessionId,
          text.trim(),
          attachments.length > 0 ? attachments : undefined,
        );
        if (result.ok) {
          onRefresh();
        }
      } finally {
        setSending(false);
      }
    },
    [sending, sessionId, onRefresh, onPendingPrompt],
  );

  const placeholder = !canSend
    ? turnInProgress
      ? "Agent is working..."
      : !config.isTerminal
        ? "Starting up..."
        : "Session ended"
    : "Send a message...";

  return (
    <HitlContext.Provider value={hitlActions}>
      {children}
      <div className="shrink-0 px-1 pb-4 pt-3">
        <ChatInput
          onSubmit={handleSubmit}
          onStop={onStop}
          placeholder={placeholder}
          disabled={!canSend || sending}
          loading={sending}
          working={turnInProgress}
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
  const [pendingPrompt, setPendingPromptRaw] = useState<string | null>(null);

  const config = getStatusConfig(session?.status ?? "failed");

  // Fetch session from DB on mount
  useEffect(() => {
    fetchSession(sessionId).then((s) => {
      setSession(s);
      setLoading(false);
    });
  }, [sessionId]);

  // Unified chat hook — polls DB for events
  const chat = useSessionChat({
    sdkSessionId: session?.sdkSessionId ?? null,
    sessionStatus: session?.status ?? null,
    terminal: config.isTerminal,
  });

  const setPendingPrompt = useCallback((text: string | null) => {
    setPendingPromptRaw(text);
  }, []);

  // Refetch session from API
  const refreshSession = useCallback(() => {
    fetchSession(sessionId).then((s) => {
      if (s) setSession(s);
    });
  }, [sessionId]);

  const handleStop = useCallback(() => {
    stopSession(session?.id ?? sessionId);
  }, [session?.id, sessionId]);

  // Poll session status
  const pollIntervalMs = config.pollIntervalMs;

  useEffect(() => {
    if (!pollIntervalMs) return;

    const poll = setInterval(async () => {
      const s = await fetchSession(sessionId);
      if (s) {
        setSession(s);
        if (getStatusConfig(s.status).pollIntervalMs === 0) {
          clearInterval(poll);
        }
      }
    }, pollIntervalMs);

    const timeout = setTimeout(() => clearInterval(poll), 2 * 60 * 60_000);
    return () => {
      clearInterval(poll);
      clearTimeout(timeout);
    };
  }, [pollIntervalMs, sessionId]);

  // Clear optimistic prompt once the real event appears
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

      {session.status === "failed" && (
        <SessionErrorAlert error={session.error} />
      )}

      {/* Chat area + Input */}
      <SessionChatInput
        sessionId={session.id}
        status={session.status}
        turnInProgress={chat.turnInProgress}
        onRefresh={refreshSession}
        onPendingPrompt={setPendingPrompt}
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
        </div>
      </SessionChatInput>
    </div>
  );
}
