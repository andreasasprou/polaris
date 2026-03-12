"use client";

// ── Usage display ──

interface UsageItemProps {
  cost?: { amount: number; currency: string };
  used?: number;
  size?: number;
}

export function UsageItem({ cost, used, size }: UsageItemProps) {
  if (!cost && used == null) return null;

  return (
    <div className="flex justify-center py-1">
      <div className="flex items-center gap-3 text-[11px] text-muted-foreground/50">
        {cost && <span>${cost.amount.toFixed(4)}</span>}
        {used != null && size != null && (
          <span>{((used / size) * 100).toFixed(0)}% context</span>
        )}
      </div>
    </div>
  );
}

// ── Status label ──

interface StatusItemProps {
  label: string;
  detail?: string;
}

export function StatusItem({ label, detail }: StatusItemProps) {
  return (
    <div className="flex justify-center py-1">
      <span className="text-[11px] text-muted-foreground/50">
        {label}
        {detail ? ` \u00B7 ${detail}` : ""}
      </span>
    </div>
  );
}

// ── Session ended ──

interface SessionEndedItemProps {
  reason: string;
  message?: string;
}

const endedLabels: Record<string, string> = {
  completed: "Session completed",
  error: "Session ended with error",
  terminated: "Session terminated",
};

export function SessionEndedItem({ reason, message }: SessionEndedItemProps) {
  return (
    <div className="flex justify-center py-2">
      <div className="flex items-center gap-2 rounded-full border border-border bg-muted/40 px-4 py-1.5">
        <span
          className={`h-1.5 w-1.5 rounded-full ${
            reason === "error" ? "bg-red-500" : "bg-muted-foreground/40"
          }`}
        />
        <span className="text-xs text-muted-foreground">
          {endedLabels[reason] ?? `Session ended (${reason})`}
          {message ? ` \u2014 ${message}` : ""}
        </span>
      </div>
    </div>
  );
}

// ── Turn in-progress indicator ──

import { Spinner } from "./spinner";

export function TurnIndicator() {
  return (
    <div className="flex items-center gap-2.5 py-2">
      <Spinner className="text-muted-foreground" />
      <span className="text-sm text-shimmer">Agent is working...</span>
    </div>
  );
}
