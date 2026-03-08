"use client";

import { useRef, useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSessionEvents } from "@/hooks/use-session-events";
import { useRealtimeSession } from "@/hooks/use-realtime-session";
import { useHitlActions } from "@/app/(dashboard)/sessions/[sessionId]/page";
import type { ChatItem } from "@/lib/sandbox-agent/event-types";

// ── Markdown renderer ──

function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        pre: ({ children }) => (
          <pre className="my-2 overflow-x-auto rounded-md bg-muted p-3 text-sm">
            {children}
          </pre>
        ),
        code: ({ className, children, ...props }) => {
          const isInline = !className;
          if (isInline) {
            return (
              <code
                className="rounded bg-muted px-1.5 py-0.5 font-mono text-[13px]"
                {...props}
              >
                {children}
              </code>
            );
          }
          return (
            <code className={`${className ?? ""} font-mono text-[13px]`} {...props}>
              {children}
            </code>
          );
        },
        p: ({ children }) => <p className="mb-2 last:mb-0">{children}</p>,
        ul: ({ children }) => <ul className="mb-2 ml-4 list-disc last:mb-0">{children}</ul>,
        ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal last:mb-0">{children}</ol>,
        li: ({ children }) => <li className="mb-1">{children}</li>,
        h1: ({ children }) => <h1 className="mb-2 text-lg font-semibold">{children}</h1>,
        h2: ({ children }) => <h2 className="mb-2 text-base font-semibold">{children}</h2>,
        h3: ({ children }) => <h3 className="mb-1 text-sm font-semibold">{children}</h3>,
        a: ({ children, href }) => (
          <a href={href} className="text-blue-600 underline" target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        table: ({ children }) => (
          <div className="my-2 overflow-x-auto">
            <table className="min-w-full border-collapse text-sm">{children}</table>
          </div>
        ),
        th: ({ children }) => (
          <th className="border border-border bg-muted px-3 py-1.5 text-left text-xs font-medium">
            {children}
          </th>
        ),
        td: ({ children }) => (
          <td className="border border-border px-3 py-1.5 text-sm">{children}</td>
        ),
        blockquote: ({ children }) => (
          <blockquote className="my-2 border-l-2 border-border pl-3 text-muted-foreground">
            {children}
          </blockquote>
        ),
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

// ── Content part renderers ──

function FileRefPart({ path, action, diff }: { path: string; action?: string; diff?: string }) {
  const [expanded, setExpanded] = useState(false);

  const actionColors: Record<string, string> = {
    read: "bg-blue-100 text-blue-700",
    write: "bg-green-100 text-green-700",
    patch: "bg-yellow-100 text-yellow-700",
  };

  return (
    <div className="my-1">
      <button
        onClick={() => diff && setExpanded(!expanded)}
        className={`flex items-center gap-2 text-xs ${diff ? "cursor-pointer hover:text-foreground" : "cursor-default"} text-muted-foreground`}
      >
        <span className="font-mono">{path.split("/").pop()}</span>
        {action && (
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${actionColors[action] ?? "bg-gray-100 text-gray-700"}`}>
            {action}
          </span>
        )}
        {diff && (
          <svg
            className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        )}
      </button>
      {expanded && diff && (
        <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">
          {diff.split("\n").map((line, i) => {
            const color = line.startsWith("+")
              ? "bg-green-500/10 text-green-600"
              : line.startsWith("-")
                ? "bg-red-500/10 text-red-600"
                : line.startsWith("@@")
                  ? "text-blue-500"
                  : "text-muted-foreground";
            return (
              <div key={i} className={color}>
                {line}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ImagePart({ path, mime }: { path: string; mime?: string }) {
  return (
    <div className="my-1 flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <svg className="h-4 w-4 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
        <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
      </svg>
      <span className="font-mono text-xs text-muted-foreground">{path}</span>
      {mime && <span className="text-[10px] text-muted-foreground/60">{mime}</span>}
    </div>
  );
}

function ReasoningPart({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="my-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Reasoning
        {!expanded && isLong && (
          <span className="text-muted-foreground/60">
            — {text.slice(0, 80).trim()}...
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 border-l-2 border-border pl-3">
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{text}</p>
        </div>
      )}
    </div>
  );
}

/** Render content parts from tool calls or items. */
function ContentPartRenderer({ part }: { part: Record<string, unknown> }) {
  switch (part.type as string) {
    case "file_ref":
      return (
        <FileRefPart
          path={part.path as string}
          action={part.action as string | undefined}
          diff={part.diff as string | undefined}
        />
      );
    case "image":
      return <ImagePart path={part.path as string} mime={part.mime as string | undefined} />;
    case "reasoning":
      if (part.visibility === "private") return null;
      return <ReasoningPart text={part.text as string} />;
    case "status":
      return (
        <div className="text-xs text-muted-foreground">
          {part.label as string}{part.detail ? ` — ${part.detail}` : ""}
        </div>
      );
    default:
      return null;
  }
}

// ── Chat item renderers ──

function UserPrompt({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-4 py-2.5 text-primary-foreground">
        <p className="whitespace-pre-wrap text-sm">{text}</p>
      </div>
    </div>
  );
}

function AgentMessage({ text }: { text: string }) {
  return (
    <div className="max-w-[85%]">
      <div className="prose-sm text-sm text-foreground">
        <Markdown>{text}</Markdown>
      </div>
    </div>
  );
}

function AgentThought({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = text.length > 200;

  return (
    <div className="max-w-[85%]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
      >
        <svg
          className={`h-3 w-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Thinking
        {!expanded && isLong && (
          <span className="text-muted-foreground/60">
            — {text.slice(0, 80).trim()}...
          </span>
        )}
      </button>
      {expanded && (
        <div className="mt-1.5 border-l-2 border-border pl-3">
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{text}</p>
        </div>
      )}
    </div>
  );
}

/** Extract displayable text from tool call content entries. */
function extractToolOutput(
  content: Array<Record<string, unknown>>,
): { text?: string; diff?: { oldText: string; newText: string }; parts: Array<Record<string, unknown>> } {
  const parts: Array<Record<string, unknown>> = [];
  let text: string | undefined;
  let diff: { oldText: string; newText: string } | undefined;

  for (const entry of content) {
    // Detect content part types for special rendering
    if (entry.type === "file_ref" || entry.type === "image" || entry.type === "reasoning" || entry.type === "status") {
      parts.push(entry);
      continue;
    }
    if (entry.type === "diff" && entry.oldText && entry.newText) {
      diff = {
        oldText: entry.oldText as string,
        newText: entry.newText as string,
      };
      continue;
    }
    if (entry.type === "content" && entry.content) {
      const inner = entry.content as Record<string, unknown>;
      if (inner.text) text = inner.text as string;
      continue;
    }
    if (entry.text && !text) {
      text = entry.text as string;
    }
  }

  return { text, diff, parts };
}

const statusIcons: Record<string, { icon: string; color: string }> = {
  pending: { icon: "○", color: "text-yellow-500" },
  running: { icon: "◉", color: "text-blue-500" },
  completed: { icon: "✓", color: "text-green-500" },
  failed: { icon: "✗", color: "text-red-500" },
};

function ToolCallItem({
  toolName,
  title,
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
  const [expanded, setExpanded] = useState(false);
  const output = extractToolOutput(content);
  const hasOutput = output.text || output.diff || output.parts.length > 0;
  const si = statusIcons[status] ?? { icon: "·", color: "text-muted-foreground" };

  return (
    <div className="max-w-[90%]">
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`flex w-full items-center gap-2 rounded-md border border-border bg-muted/40 px-3 py-1.5 text-left text-sm ${
          hasOutput ? "cursor-pointer hover:bg-muted/60" : "cursor-default"
        }`}
      >
        <span className={`font-mono text-xs ${si.color}`}>{si.icon}</span>
        <span className="font-mono text-xs text-muted-foreground">{toolName}</span>
        {title && <span className="truncate text-muted-foreground">— {title}</span>}
        {locations.length > 0 && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground/70">
            {locations[0].path.split("/").pop()}
            {locations[0].line != null ? `:${locations[0].line}` : ""}
          </span>
        )}
        {hasOutput && (
          <svg
            className={`ml-1 h-3 w-3 shrink-0 text-muted-foreground transition-transform ${
              expanded ? "rotate-90" : ""
            }`}
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
        )}
      </button>

      {expanded && output.diff && (
        <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">
          {output.diff.oldText.split("\n").map((line, i) => (
            <div key={`old-${i}`} className="bg-red-500/10 text-red-600">
              <span className="mr-2 select-none text-red-400">-</span>
              {line}
            </div>
          ))}
          {output.diff.newText.split("\n").map((line, i) => (
            <div key={`new-${i}`} className="bg-green-500/10 text-green-600">
              <span className="mr-2 select-none text-green-400">+</span>
              {line}
            </div>
          ))}
        </div>
      )}

      {expanded && output.parts.length > 0 && (
        <div className="mt-1 rounded-md border border-border bg-muted/20 p-2">
          {output.parts.map((part, i) => (
            <ContentPartRenderer key={i} part={part} />
          ))}
        </div>
      )}

      {expanded && output.text && (
        <div className="mt-1 max-h-64 overflow-auto rounded-md border border-border bg-muted/20 p-2">
          <pre className="whitespace-pre-wrap font-mono text-xs text-muted-foreground">
            {output.text.slice(0, 4000)}
          </pre>
        </div>
      )}
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
  if (!cost && used == null) return null;
  return (
    <div className="flex justify-center py-1">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground/60">
        {cost && <span>${cost.amount.toFixed(4)}</span>}
        {used != null && size != null && (
          <span>{((used / size) * 100).toFixed(0)}% context</span>
        )}
      </div>
    </div>
  );
}

function StatusItem({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="flex justify-center py-1">
      <span className="text-[11px] text-muted-foreground/60">
        {label}
        {detail ? ` · ${detail}` : ""}
      </span>
    </div>
  );
}

// ── HITL renderers ──

function PermissionRequestItem({
  permissionId,
  action,
  status,
}: {
  permissionId: string;
  action: string;
  status: "pending" | "accepted" | "rejected";
}) {
  const hitl = useHitlActions();
  const isPending = status === "pending";

  return (
    <div className="max-w-[90%]">
      <div className={`rounded-lg border px-4 py-3 ${
        isPending
          ? "border-yellow-300 bg-yellow-50"
          : status === "accepted"
            ? "border-green-200 bg-green-50"
            : "border-red-200 bg-red-50"
      }`}>
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-yellow-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
          </svg>
          <span className="text-sm font-medium text-foreground">Permission Request</span>
        </div>
        <p className="mb-3 text-sm text-foreground/80">{action}</p>
        {isPending && hitl ? (
          <div className="flex gap-2">
            <button
              onClick={() => hitl.replyPermission(permissionId, "once")}
              className="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
            >
              Allow Once
            </button>
            <button
              onClick={() => hitl.replyPermission(permissionId, "always")}
              className="rounded-md bg-green-600/80 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700"
            >
              Always Allow
            </button>
            <button
              onClick={() => hitl.replyPermission(permissionId, "reject")}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
            >
              Reject
            </button>
          </div>
        ) : (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            status === "accepted" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
          }`}>
            {status === "accepted" ? "Approved" : "Rejected"}
          </span>
        )}
      </div>
    </div>
  );
}

function QuestionRequestItem({
  questionId,
  prompt,
  options,
  status,
  response,
}: {
  questionId: string;
  prompt: string;
  options: string[];
  status: "pending" | "answered" | "rejected";
  response?: string;
}) {
  const hitl = useHitlActions();
  const [selected, setSelected] = useState<string[]>([]);
  const isPending = status === "pending";

  return (
    <div className="max-w-[90%]">
      <div className={`rounded-lg border px-4 py-3 ${
        isPending
          ? "border-blue-300 bg-blue-50"
          : status === "answered"
            ? "border-green-200 bg-green-50"
            : "border-red-200 bg-red-50"
      }`}>
        <div className="mb-2 flex items-center gap-2">
          <svg className="h-4 w-4 text-blue-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 5.25h.008v.008H12v-.008Z" />
          </svg>
          <span className="text-sm font-medium text-foreground">Question</span>
        </div>
        <p className="mb-3 text-sm text-foreground/80">{prompt}</p>
        {isPending && hitl ? (
          <>
            {options.length > 0 && (
              <div className="mb-3 flex flex-col gap-1.5">
                {options.map((option) => (
                  <label key={option} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={selected.includes(option)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSelected([...selected, option]);
                        } else {
                          setSelected(selected.filter((s) => s !== option));
                        }
                      }}
                      className="rounded border-gray-300"
                    />
                    {option}
                  </label>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => hitl.replyQuestion(questionId, [selected])}
                disabled={options.length > 0 && selected.length === 0}
                className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Submit
              </button>
              <button
                onClick={() => hitl.rejectQuestion(questionId)}
                className="rounded-md bg-gray-200 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-300"
              >
                Skip
              </button>
            </div>
          </>
        ) : (
          <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
            status === "answered" ? "bg-green-100 text-green-800" : "bg-red-100 text-red-800"
          }`}>
            {status === "answered" ? `Answered: ${response ?? ""}` : "Skipped"}
          </span>
        )}
      </div>
    </div>
  );
}

function ErrorItem({ message, code }: { message: string; code?: string }) {
  return (
    <div className="max-w-[90%]">
      <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3">
        <div className="flex items-center gap-2">
          <svg className="h-4 w-4 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
          </svg>
          <span className="text-sm font-medium text-red-800">Error{code ? ` (${code})` : ""}</span>
        </div>
        <p className="mt-1 text-sm text-red-700">{message}</p>
      </div>
    </div>
  );
}

function SessionEndedItem({ reason, message }: { reason: string; message?: string }) {
  const labels: Record<string, string> = {
    completed: "Session completed",
    error: "Session ended with error",
    terminated: "Session terminated",
  };

  return (
    <div className="flex justify-center py-2">
      <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-4 py-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${reason === "error" ? "bg-red-500" : "bg-gray-400"}`} />
        <span className="text-xs text-muted-foreground">
          {labels[reason] ?? `Session ended (${reason})`}
          {message ? ` — ${message}` : ""}
        </span>
      </div>
    </div>
  );
}

function TurnIndicator() {
  return (
    <div className="flex items-center gap-2 py-2">
      <div className="h-4 w-4 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
      <span className="text-xs text-muted-foreground">Agent is working...</span>
    </div>
  );
}

// ── Chat item dispatcher ──

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
    case "permission_request":
      return (
        <PermissionRequestItem
          permissionId={item.permissionId}
          action={item.action}
          status={item.status}
        />
      );
    case "question_request":
      return (
        <QuestionRequestItem
          questionId={item.questionId}
          prompt={item.prompt}
          options={item.options}
          status={item.status}
          response={item.response}
        />
      );
    case "error":
      return <ErrorItem message={item.message} code={item.code} />;
    case "session_ended":
      return <SessionEndedItem reason={item.reason} message={item.message} />;
    default:
      return null;
  }
}

// ── Chat containers ──

type SessionChatProps =
  | { mode: "live"; triggerRunId: string; accessToken: string; skipInitialPrompt?: boolean }
  | { mode: "history"; sdkSessionId: string };

export function SessionChat(props: SessionChatProps) {
  if (props.mode === "live") {
    return (
      <LiveSessionChat
        triggerRunId={props.triggerRunId}
        accessToken={props.accessToken}
        skipInitialPrompt={props.skipInitialPrompt}
      />
    );
  }
  return <HistorySessionChat sdkSessionId={props.sdkSessionId} />;
}

function LiveSessionChat({
  triggerRunId,
  accessToken,
  skipInitialPrompt,
}: {
  triggerRunId: string;
  accessToken: string;
  skipInitialPrompt?: boolean;
}) {
  const { items: rawItems, turnInProgress, error } = useRealtimeSession({ triggerRunId, accessToken });

  // When appended below history, skip the first user_prompt (it's the resume
  // prompt already visible in history)
  const items = skipInitialPrompt
    ? rawItems.filter((item, i) => !(i === 0 && item.type === "user_prompt"))
    : rawItems;
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [items.length]);

  if (error) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">Failed to connect: {error.message}</p>
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        <p className="text-sm text-muted-foreground">Waiting for agent...</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
        Live
      </div>
      {items.map((item, i) => (
        <ChatItemRenderer key={i} item={item} />
      ))}
      {turnInProgress && <TurnIndicator />}
      <div ref={bottomRef} />
    </div>
  );
}

function HistorySessionChat({ sdkSessionId }: { sdkSessionId: string }) {
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
      <div className="flex flex-col items-center gap-3 py-16">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-muted-foreground/30 border-t-muted-foreground" />
        <p className="text-sm text-muted-foreground">Loading session...</p>
      </div>
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
        No events recorded.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {streaming && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-green-500" />
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
