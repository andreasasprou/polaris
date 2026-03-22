"use client";

import { useState } from "react";
import { ChevronRightIcon } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "./spinner";
import { CopyButton } from "./copy-button";

// ── Status indicators ──

const statusConfig: Record<string, { icon: string; className: string }> = {
  pending: { icon: "\u25CB", className: "text-status-warning" },
  running: { icon: "\u25C9", className: "text-status-active" },
  completed: { icon: "\u2713", className: "text-status-success" },
  failed: { icon: "\u2717", className: "text-status-error" },
  interrupted: { icon: "\u25A0", className: "text-status-warning" },
};

// ── Content part renderers ──

function DiffContent({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="max-h-60 overflow-auto font-mono text-xs">
      {oldText.split("\n").map((line, i) => (
        <div key={`old-${i}`} className="bg-red-500/5 text-red-600 dark:text-red-400">
          <span className="mr-2 select-none text-red-400/60">-</span>
          {line}
        </div>
      ))}
      {newText.split("\n").map((line, i) => (
        <div key={`new-${i}`} className="bg-emerald-500/5 text-emerald-600 dark:text-emerald-400">
          <span className="mr-2 select-none text-emerald-400/60">+</span>
          {line}
        </div>
      ))}
    </div>
  );
}

function FileRefContent({ path, action, diff }: { path: string; action?: string; diff?: string }) {
  const [showDiff, setShowDiff] = useState(false);

  return (
    <div className="py-0.5">
      <button
        onClick={() => diff && setShowDiff(!showDiff)}
        className={`flex items-center gap-2 text-xs ${
          diff ? "cursor-pointer hover:text-foreground" : "cursor-default"
        } text-muted-foreground`}
      >
        <span className="font-mono">{path.split("/").pop()}</span>
        {action && (
          <Badge variant="outline" className="text-[10px] px-1.5 py-0">
            {action}
          </Badge>
        )}
        {diff && (
          <ChevronRightIcon
            className={`size-3 transition-transform duration-150 ${
              showDiff ? "rotate-90" : ""
            }`}
          />
        )}
      </button>
      {showDiff && diff && (
        <div className="mt-1 max-h-60 overflow-auto rounded-md border border-border bg-muted/20 p-2 font-mono text-xs">
          {diff.split("\n").map((line, i) => {
            const color = line.startsWith("+")
              ? "text-emerald-600 bg-emerald-500/5 dark:text-emerald-400"
              : line.startsWith("-")
                ? "text-red-600 bg-red-500/5 dark:text-red-400"
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

function ReasoningContent({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Collapsible open={expanded} onOpenChange={setExpanded} className="py-0.5">
      <CollapsibleTrigger className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon
          className={`size-3 transition-transform duration-150 ${
            expanded ? "rotate-90" : ""
          }`}
        />
        Reasoning
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 border-l-2 border-border pl-3">
          <p className="whitespace-pre-wrap text-xs text-muted-foreground">{text}</p>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

// ── Content extraction ──

function extractToolOutput(content: Array<Record<string, unknown>>) {
  const parts: Array<Record<string, unknown>> = [];
  let text: string | undefined;
  let diff: { oldText: string; newText: string } | undefined;

  for (const entry of content) {
    if (
      entry.type === "file_ref" ||
      entry.type === "image" ||
      entry.type === "reasoning" ||
      entry.type === "status"
    ) {
      parts.push(entry);
      continue;
    }
    if (entry.type === "diff" && entry.oldText && entry.newText) {
      diff = { oldText: entry.oldText as string, newText: entry.newText as string };
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

// ── Content part renderer ──

function ContentPart({ part }: { part: Record<string, unknown> }) {
  switch (part.type as string) {
    case "file_ref":
      return (
        <FileRefContent
          path={part.path as string}
          action={part.action as string | undefined}
          diff={part.diff as string | undefined}
        />
      );
    case "image":
      return (
        <div className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
          <svg className="size-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
            <path strokeLinecap="round" strokeLinejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0 0 22.5 18.75V5.25A2.25 2.25 0 0 0 20.25 3H3.75A2.25 2.25 0 0 0 1.5 5.25v13.5A2.25 2.25 0 0 0 3.75 21Z" />
          </svg>
          <span className="font-mono">{part.path as string}</span>
        </div>
      );
    case "reasoning":
      if (part.visibility === "private") return null;
      return <ReasoningContent text={part.text as string} />;
    case "status":
      return (
        <div className="py-0.5 text-xs text-muted-foreground">
          {part.label as string}
          {part.detail ? ` \u2014 ${part.detail}` : ""}
        </div>
      );
    default:
      return null;
  }
}

// ── Main tool call component ──

interface ToolCallItemProps {
  toolName: string;
  title: string;
  status: string;
  locations: Array<{ path: string; line?: number }>;
  content: Array<Record<string, unknown>>;
}

export function ToolCallItem({ toolName, title, status, locations, content }: ToolCallItemProps) {
  const [expanded, setExpanded] = useState(false);
  const output = extractToolOutput(content);
  const hasOutput = output.text || output.diff || output.parts.length > 0;
  const si = statusConfig[status] ?? { icon: "\u00B7", className: "text-muted-foreground" };
  const isPending = status === "pending" || status === "running";

  const locationLabel = locations[0]
    ? `${locations[0].path.split("/").pop()}${locations[0].line != null ? `:${locations[0].line}` : ""}`
    : null;

  return (
    <div className="w-full min-w-0">
      {/* Trigger row */}
      <button
        onClick={() => hasOutput && setExpanded(!expanded)}
        className={`flex w-full min-w-0 min-h-[36px] items-center gap-2 overflow-hidden text-left text-sm ${
          hasOutput ? "cursor-pointer" : "cursor-default"
        }`}
      >
        {/* Status indicator or spinner */}
        {isPending ? (
          <Spinner className="size-4 text-muted-foreground" />
        ) : (
          <span className={`shrink-0 font-mono text-xs leading-none ${si.className}`}>
            {si.icon}
          </span>
        )}

        {/* Title - shimmer effect when pending */}
        <span
          className={`shrink-0 text-sm font-medium ${
            isPending ? "text-shimmer" : "text-foreground"
          }`}
        >
          {toolName}
        </span>

        {/* Subtitle - only show when not pending */}
        {!isPending && title && (
          <span className="min-w-0 truncate text-sm text-muted-foreground">{title}</span>
        )}

        {/* File location */}
        {!isPending && locationLabel && (
          <span className="ml-auto shrink-0 font-mono text-xs text-muted-foreground/50">
            {locationLabel}
          </span>
        )}

        {/* Expand arrow */}
        {hasOutput && !isPending && (
          <ChevronRightIcon
            className={`ml-1 size-3.5 shrink-0 text-muted-foreground/40 transition-transform duration-150 ${
              expanded ? "rotate-90" : ""
            }`}
          />
        )}
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="mt-1 overflow-hidden rounded-md border border-border">
          {output.diff && (
            <div className="p-3">
              <DiffContent oldText={output.diff.oldText} newText={output.diff.newText} />
            </div>
          )}

          {output.parts.length > 0 && (
            <div className="p-3">
              {output.parts.map((part, i) => (
                <ContentPart key={i} part={part} />
              ))}
            </div>
          )}

          {output.text && (
            <div className="group/output relative max-h-60 overflow-auto scrollbar-none p-3">
              <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-muted-foreground">
                {output.text.slice(0, 4000)}
              </pre>
              <div className="absolute right-2 top-2 opacity-0 transition-opacity group-hover/output:opacity-100">
                <CopyButton text={output.text} />
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
