"use client";

import { useState, useCallback, useRef } from "react";
import { useMountEffect } from "@/hooks/use-mount-effect";
import { useParams } from "next/navigation";
import Link from "next/link";
import { useOrgPath } from "@/hooks/use-org-path";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionErrorAlert } from "@/components/sessions/session-error-alert";
import { StatusBadge } from "@/components/status-badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { SessionChat } from "@/components/sessions/session-chat";
import { useSessionChat } from "@/hooks/use-session-chat";
import {
  ExternalLinkIcon,
} from "lucide-react";

type Run = {
  id: string;
  automationId: string;
  automationName: string | null;
  status: string;
  source: string;
  prUrl: string | null;
  branchName: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  // v2 session link
  interactiveSessionId: string | null;
  sdkSessionId: string | null;
  sessionStatus: string | null;
  // Review fields
  jobId: string | null;
  verdict: string | null;
  severityCounts: { P0: number; P1: number; P2: number } | null;
  reviewScope: string | null;
  reviewSequence: number | null;
  reviewFromSha: string | null;
  reviewToSha: string | null;
  githubCommentId: string | null;
  // PR info (extracted from trigger_event)
  prNumber: number | null;
  prTitle: string | null;
  // Repo info
  repoOwner: string | null;
  repoName: string | null;
};

function isReviewRun(run: Run): boolean {
  return run.verdict != null || run.reviewScope != null;
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "\u2014";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.round((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function prUrl(run: Run): string | null {
  if (run.prNumber && run.repoOwner && run.repoName) {
    return `https://github.com/${run.repoOwner}/${run.repoName}/pull/${run.prNumber}`;
  }
  return run.prUrl ?? null;
}

export default function RunDetailPage() {
  const op = useOrgPath();
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);

  const isTerminal = run ? TERMINAL_RUN_STATUSES.has(run.status) : false;
  const lastJsonRef = useRef<string>("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchRun = useCallback(async () => {
    try {
      const r = await fetch(`/api/runs/${runId}`, {
        signal: controllerRef.current?.signal,
      });
      const data = await r.json();
      const json = JSON.stringify(data.run);
      if (json !== lastJsonRef.current) {
        lastJsonRef.current = json;
        setRun(data.run ?? null);

        // Stop polling once terminal
        if (data.run && TERMINAL_RUN_STATUSES.has(data.run.status) && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
      }
    } catch {
      // Aborted or network error — leave current state
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useMountEffect(() => {
    controllerRef.current = new AbortController();
    lastJsonRef.current = "";
    setLoading(true);
    setRun(null);
    fetchRun();
    timerRef.current = setInterval(fetchRun, 3000);
    return () => {
      controllerRef.current?.abort();
      controllerRef.current = null;
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  });

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Run not found.</p>;
  }

  const pr = prUrl(run);
  const duration = formatDuration(run.startedAt, run.completedAt);

  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href={op("/runs")}
          className="text-sm text-muted-foreground hover:underline"
        >
          Runs
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-medium">
          {run.automationName ?? "Run"}
        </h1>
        <StatusBadge status={run.status} />
      </div>

      {/* Metadata cards */}
      {isReviewRun(run) ? (
        <ReviewMetadataCards run={run} pr={pr} duration={duration} />
      ) : (
        <CodingTaskMetadataCards run={run} pr={pr} duration={duration} />
      )}

      {/* Summary — the hero content */}
      {run.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">
              Summary
            </CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm">{run.summary}</pre>
          </CardContent>
        </Card>
      )}

      {run.error && <SessionErrorAlert error={run.error} />}

      {/* Agent Trace — collapsed by default */}
      {run.sdkSessionId && (
        <AgentTrace
          sdkSessionId={run.sdkSessionId}
          runStatus={run.status}
          runStartedAt={run.startedAt}
          runCompletedAt={run.completedAt}
          interactiveSessionId={run.interactiveSessionId}
        />
      )}

      {/* Job Lifecycle — collapsed */}
      {run.jobId && (
        <details>
          <summary className="cursor-pointer text-lg font-medium">
            Job Lifecycle
          </summary>
          <div className="mt-3">
            <JobLifecycle jobId={run.jobId} />
          </div>
        </details>
      )}

      {/* Sandbox Logs — collapsed, lazy-loaded */}
      {run.interactiveSessionId && (
        <SandboxLogs
          sessionId={run.interactiveSessionId}
          fallbackError={isTerminal ? "Sandbox stopped after completion." : undefined}
        />
      )}
    </div>
  );
}

// ── Review metadata cards ──

function ReviewMetadataCards({ run, pr, duration }: { run: Run; pr: string | null; duration: string }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <MetadataCard label="PR">
          {pr && run.prNumber ? (
            <a
              href={pr}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 text-primary hover:underline"
              title={run.prTitle ?? undefined}
            >
              #{run.prNumber}
              <ExternalLinkIcon className="h-3 w-3" />
            </a>
          ) : (
            <p className="font-mono text-sm text-muted-foreground">
              {run.repoOwner && run.repoName
                ? `${run.repoOwner}/${run.repoName}`
                : run.source}
            </p>
          )}
        </MetadataCard>
        <MetadataCard label="Verdict">
          {run.verdict ? (
            <VerdictBadge verdict={run.verdict} />
          ) : (
            <p className="text-muted-foreground">{"\u2014"}</p>
          )}
        </MetadataCard>
        <MetadataCard label="Duration">
          <p className="text-sm">{duration}</p>
        </MetadataCard>
        <MetadataCard label="Review">
          <p className="text-sm">
            {run.reviewSequence != null ? `#${run.reviewSequence}` : "\u2014"}
            {run.reviewScope ? ` · ${run.reviewScope}` : ""}
          </p>
        </MetadataCard>
      </div>
      {run.severityCounts && (
        <div className="grid gap-4 sm:grid-cols-4">
          <MetadataCard label="Severity">
            <div className="flex gap-3 text-sm">
              <span className="text-red-600 dark:text-red-400">
                P0: {run.severityCounts.P0}
              </span>
              <span className="text-amber-600 dark:text-amber-400">
                P1: {run.severityCounts.P1}
              </span>
              <span className="text-muted-foreground">
                P2: {run.severityCounts.P2}
              </span>
            </div>
          </MetadataCard>
          {run.reviewFromSha && run.reviewToSha && (
            <MetadataCard label="Commit Range">
              <p className="font-mono text-sm">
                {run.reviewFromSha.slice(0, 7)}..{run.reviewToSha.slice(0, 7)}
              </p>
            </MetadataCard>
          )}
          <MetadataCard label="Created">
            <p className="text-sm">
              {new Date(run.createdAt).toLocaleString()}
            </p>
          </MetadataCard>
        </div>
      )}
    </div>
  );
}

// ── Coding task metadata cards ──

function CodingTaskMetadataCards({ run, pr, duration }: { run: Run; pr: string | null; duration: string }) {
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <MetadataCard label="Source">
        <p className="font-medium">{run.source}</p>
      </MetadataCard>
      <MetadataCard label="Branch">
        <p className="font-mono text-sm">{run.branchName ?? "\u2014"}</p>
      </MetadataCard>
      <MetadataCard label="PR">
        {pr ? (
          <a
            href={pr}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-primary hover:underline"
          >
            {run.prNumber ? `#${run.prNumber}` : "View PR"}
            <ExternalLinkIcon className="h-3 w-3" />
          </a>
        ) : (
          <p className="text-muted-foreground">{"\u2014"}</p>
        )}
      </MetadataCard>
      <MetadataCard label="Duration">
        <p className="text-sm">{duration}</p>
      </MetadataCard>
    </div>
  );
}

// ── Shared card wrapper ──

function MetadataCard({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-medium text-muted-foreground">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

// ── Agent Trace (collapsed session preview) ──

const TERMINAL_RUN_STATUSES = new Set(["completed", "succeeded", "failed", "cancelled"]);

function AgentTrace({
  sdkSessionId,
  runStatus,
  runStartedAt,
  runCompletedAt,
  interactiveSessionId,
}: {
  sdkSessionId: string;
  runStatus: string;
  runStartedAt: string | null;
  runCompletedAt: string | null;
  interactiveSessionId: string | null;
}) {
  const op = useOrgPath();
  const terminal = TERMINAL_RUN_STATUSES.has(runStatus);

  const chat = useSessionChat({
    sdkSessionId,
    sessionStatus: terminal ? "completed" : "active",
    terminal,
    filterStartMs: runStartedAt ? new Date(runStartedAt).getTime() : undefined,
    filterEndMs: runCompletedAt ? new Date(runCompletedAt).getTime() : undefined,
  });

  const eventCount = chat.items.length;

  return (
    <details>
      <summary className="flex cursor-pointer items-center gap-3 text-lg font-medium">
        <span>Agent Trace</span>
        {eventCount > 0 && (
          <span className="text-sm font-normal text-muted-foreground">
            ({eventCount} events)
          </span>
        )}
        {interactiveSessionId && (
          <Link
            href={op(`/sessions/${interactiveSessionId}`)}
            className="ml-auto text-sm font-normal text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            View session &rarr;
          </Link>
        )}
      </summary>
      <div className="mt-3">
        <SessionChat
          items={chat.items}
          turnInProgress={chat.turnInProgress}
          loading={chat.loading}
          error={chat.error}
          sessionStatus={terminal ? "completed" : "active"}
        />
      </div>
    </details>
  );
}

// ── Job lifecycle ──

type JobEvent = {
  id: string;
  eventType: string;
  attemptId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
};

type JobAttempt = {
  id: string;
  attemptNumber: number;
  status: string;
  sandboxId: string | null;
  error: string | null;
  dispatchedAt: string;
  acceptedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
};

type JobCallback = {
  id: string;
  callbackType: string;
  processed: boolean;
  processedAt: string | null;
  processError: string | null;
  receivedAt: string;
};

type JobDetail = {
  job: {
    id: string;
    type: string;
    status: string;
    sideEffectsCompleted: Record<string, boolean>;
    createdAt: string;
    updatedAt: string;
  };
  attempts: JobAttempt[];
  events: JobEvent[];
  callbacks: JobCallback[];
};

const eventColors: Record<string, string> = {
  created: "text-muted-foreground",
  dispatched: "text-blue-600 dark:text-blue-400",
  accepted: "text-blue-600 dark:text-blue-400",
  running: "text-blue-600 dark:text-blue-400",
  agent_completed: "text-green-600 dark:text-green-400",
  postprocess_started: "text-blue-600 dark:text-blue-400",
  completed: "text-green-600 dark:text-green-400",
  failed: "text-red-600 dark:text-red-400",
  timeout: "text-red-600 dark:text-red-400",
  cancelled: "text-muted-foreground",
  waiting_human: "text-amber-600 dark:text-amber-400",
  resumed: "text-blue-600 dark:text-blue-400",
};

function JobLifecycle({ jobId }: { jobId: string }) {
  const [data, setData] = useState<JobDetail | null>(null);
  const [loading, setLoading] = useState(true);

  useMountEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  });

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading job details...</p>
    );
  }
  if (!data) return null;

  const { job, events, attempts, callbacks } = data;
  const sideEffects = job.sideEffectsCompleted ?? {};

  return (
    <div className="space-y-4">
      {/* Timeline */}
      {events.length > 0 && (
        <div className="space-y-1">
          {events.map((event, i) => {
            const prev = i > 0 ? events[i - 1] : null;
            const delta = prev
              ? Math.round(
                  (new Date(event.createdAt).getTime() -
                    new Date(prev.createdAt).getTime()) /
                    1000,
                )
              : null;
            return (
              <div key={event.id} className="flex items-baseline gap-3 text-sm">
                <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                  {new Date(event.createdAt).toLocaleTimeString()}
                </span>
                <span
                  className={`font-medium ${eventColors[event.eventType] ?? "text-muted-foreground"}`}
                >
                  {event.eventType}
                </span>
                {delta != null && delta > 0 && (
                  <span className="text-xs text-muted-foreground">
                    +{delta}s
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Attempts */}
      {attempts.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Attempts ({attempts.length})
          </summary>
          <div className="mt-2 space-y-2">
            {attempts.map((attempt) => (
              <div
                key={attempt.id}
                className="rounded border p-3 text-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="font-medium">
                    Attempt #{attempt.attemptNumber}
                  </span>
                  <StatusBadge status={attempt.status} />
                  {attempt.sandboxId && (
                    <span className="font-mono text-xs text-muted-foreground">
                      {attempt.sandboxId}
                    </span>
                  )}
                </div>
                {attempt.error && (
                  <p className="mt-1 text-red-600 dark:text-red-400">
                    {attempt.error}
                  </p>
                )}
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Side Effects */}
      {Object.keys(sideEffects).length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Side Effects
          </summary>
          <div className="mt-2 space-y-1 text-sm">
            {Object.entries(sideEffects).map(([name, done]) => (
              <div key={name} className="flex items-center gap-2">
                <span>{done ? "\u2713" : "\u2717"}</span>
                <span className={done ? "" : "text-muted-foreground"}>
                  {name}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* Callbacks */}
      {callbacks.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm font-medium">
            Callbacks ({callbacks.length})
          </summary>
          <div className="mt-2 space-y-1 text-sm">
            {callbacks.map((cb) => (
              <div key={cb.id} className="flex items-center gap-3">
                <span className="w-20 shrink-0 text-right font-mono text-xs text-muted-foreground">
                  {new Date(cb.receivedAt).toLocaleTimeString()}
                </span>
                <span className="font-medium">{cb.callbackType}</span>
                <span
                  className={
                    cb.processed
                      ? "text-green-600 dark:text-green-400"
                      : "text-muted-foreground"
                  }
                >
                  {cb.processed ? "processed" : "pending"}
                </span>
                {cb.processError && (
                  <span className="text-red-600 dark:text-red-400">
                    {cb.processError}
                  </span>
                )}
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ── Sandbox Logs ──

type ProcessInfo = {
  id: string;
  command: string;
  args: string[];
  status: string;
  owner: string;
  pid: number | null;
  exitCode: number | null;
};

type LogEntry = {
  sequence: number;
  stream: string;
  timestampMs: number;
  data: string;
};

type SandboxLogsData = {
  processes: ProcessInfo[] | null;
  logs: Record<string, LogEntry[]>;
  error?: string;
};

function SandboxLogs({ sessionId, fallbackError }: { sessionId: string; fallbackError?: string }) {
  const [data, setData] = useState<SandboxLogsData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/logs`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.error ?? "Failed to reach sandbox");
        return;
      }
      setData(await res.json());
    } catch {
      setError("Failed to fetch logs");
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const hasLogs = data?.logs && Object.keys(data.logs).length > 0;

  return (
    <div>
      <details
        open={expanded}
        onToggle={(e) => {
          const open = (e.target as HTMLDetailsElement).open;
          setExpanded(open);
          if (open && data === null && !loading) {
            fetchLogs();
          }
        }}
      >
        <summary className="cursor-pointer text-lg font-medium">
          Sandbox Logs
        </summary>
        <div className="mt-3">
          {loading && (
            <p className="text-sm text-muted-foreground">
              Fetching sandbox logs...
            </p>
          )}
          {error && (
            <p className="text-sm text-muted-foreground">
              {fallbackError ?? error}
            </p>
          )}

          {/* Process list */}
          {data?.processes && data.processes.length > 0 && (
            <div className="mb-3 space-y-1 text-sm">
              {data.processes.map((proc) => (
                <div key={proc.id} className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">
                    {proc.id}
                  </span>
                  <span className="font-medium">
                    {proc.command} {proc.args.join(" ")}
                  </span>
                  <span
                    className={
                      proc.status === "running"
                        ? "text-green-600 dark:text-green-400"
                        : "text-muted-foreground"
                    }
                  >
                    {proc.status}
                  </span>
                  {proc.exitCode != null && (
                    <span className="text-xs text-muted-foreground">
                      exit {proc.exitCode}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Log output per process */}
          {hasLogs &&
            Object.entries(data!.logs).map(([procId, entries]) => {
              const proc = data!.processes?.find((p) => p.id === procId);
              const label = proc
                ? `${proc.command} ${proc.args.slice(0, 2).join(" ")}`
                : procId;
              return (
                <details key={procId} className="mb-3" open>
                  <summary className="cursor-pointer text-sm font-medium">
                    {label} ({entries.length} entries)
                  </summary>
                  <pre className="mt-1 max-h-96 overflow-auto rounded border bg-muted/30 p-3 font-mono text-xs">
                    {entries.map((e) => e.data).join("")}
                  </pre>
                </details>
              );
            })}

          {data && !hasLogs && data.processes && (
            <p className="text-sm text-muted-foreground">
              No log output captured for these processes.
            </p>
          )}
        </div>
      </details>
    </div>
  );
}
