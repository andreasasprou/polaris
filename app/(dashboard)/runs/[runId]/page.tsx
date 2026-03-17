"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionErrorAlert } from "@/components/sessions/session-error-alert";
import { StatusBadge } from "@/components/status-badge";
import { VerdictBadge } from "@/components/verdict-badge";
import { SessionChat } from "@/components/sessions/session-chat";
import { useSessionChat } from "@/hooks/use-session-chat";

const TERMINAL_SESSION_STATUSES = new Set(["stopped", "completed", "failed"]);

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
  // Repo info
  repoOwner: string | null;
  repoName: string | null;
};

function isReviewRun(run: Run): boolean {
  return run.verdict != null || run.reviewScope != null;
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/runs/${runId}`)
      .then((r) => r.json())
      .then((data) => {
        setRun(data.run ?? null);
        setLoading(false);
      });
  }, [runId]);

  if (loading) {
    return <p className="text-sm text-muted-foreground">Loading...</p>;
  }

  if (!run) {
    return <p className="text-sm text-muted-foreground">Run not found.</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href="/runs"
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

      {isReviewRun(run) ? (
        <ReviewMetadataCards run={run} />
      ) : (
        <CodingTaskMetadataCards run={run} />
      )}

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

      <div>
        <div className="mb-3 flex items-center gap-3">
          <h2 className="text-lg font-medium">Agent Session</h2>
          {run.interactiveSessionId && (
            <Link
              href={`/sessions/${run.interactiveSessionId}`}
              className="text-sm text-primary hover:underline"
            >
              View session &rarr;
            </Link>
          )}
        </div>
        {run.sdkSessionId ? (
          <RunSessionChat
            sdkSessionId={run.sdkSessionId}
            sessionStatus={run.sessionStatus}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            Session pending — no agent events yet.
          </p>
        )}
      </div>

      {run.jobId && <JobLifecycle jobId={run.jobId} />}
    </div>
  );
}

// ── Review metadata cards ──

function ReviewMetadataCards({ run }: { run: Run }) {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 sm:grid-cols-4">
        <MetadataCard label="Repository">
          <p className="font-mono text-sm">
            {run.repoOwner && run.repoName
              ? `${run.repoOwner}/${run.repoName}`
              : run.source}
          </p>
        </MetadataCard>
        <MetadataCard label="Verdict">
          {run.verdict ? (
            <VerdictBadge verdict={run.verdict} />
          ) : (
            <p className="text-muted-foreground">{"\u2014"}</p>
          )}
        </MetadataCard>
        <MetadataCard label="Review Scope">
          <p className="font-mono text-sm">{run.reviewScope ?? "\u2014"}</p>
        </MetadataCard>
        <MetadataCard label="Created">
          <p className="text-sm">
            {new Date(run.createdAt).toLocaleString()}
          </p>
        </MetadataCard>
      </div>
      {(run.severityCounts || run.reviewFromSha || run.reviewSequence) && (
        <div className="grid gap-4 sm:grid-cols-3">
          {run.severityCounts && (
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
          )}
          {run.reviewFromSha && run.reviewToSha && (
            <MetadataCard label="Commit Range">
              <p className="font-mono text-sm">
                {run.reviewFromSha.slice(0, 7)}..{run.reviewToSha.slice(0, 7)}
              </p>
            </MetadataCard>
          )}
          {run.reviewSequence != null && (
            <MetadataCard label="Review">
              <p className="text-sm">#{run.reviewSequence}</p>
            </MetadataCard>
          )}
        </div>
      )}
    </div>
  );
}

// ── Coding task metadata cards ──

function CodingTaskMetadataCards({ run }: { run: Run }) {
  return (
    <div className="grid gap-4 sm:grid-cols-4">
      <MetadataCard label="Source">
        <p className="font-medium">{run.source}</p>
      </MetadataCard>
      <MetadataCard label="Branch">
        <p className="font-mono text-sm">{run.branchName ?? "\u2014"}</p>
      </MetadataCard>
      <MetadataCard label="PR">
        {run.prUrl ? (
          <a
            href={run.prUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            View PR
          </a>
        ) : (
          <p className="text-muted-foreground">{"\u2014"}</p>
        )}
      </MetadataCard>
      <MetadataCard label="Created">
        <p className="text-sm">
          {new Date(run.createdAt).toLocaleString()}
        </p>
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

// ── Session chat ──

function RunSessionChat({
  sdkSessionId,
  sessionStatus,
}: {
  sdkSessionId: string;
  sessionStatus: string | null;
}) {
  const terminal = sessionStatus
    ? TERMINAL_SESSION_STATUSES.has(sessionStatus)
    : true;

  const chat = useSessionChat({
    sdkSessionId,
    sessionStatus,
    terminal,
  });

  return (
    <SessionChat
      items={chat.items}
      turnInProgress={chat.turnInProgress}
      loading={chat.loading}
      error={chat.error}
    />
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

  useEffect(() => {
    fetch(`/api/jobs/${jobId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [jobId]);

  if (loading) {
    return (
      <p className="text-sm text-muted-foreground">Loading job details...</p>
    );
  }
  if (!data) return null;

  const { job, events, attempts, callbacks } = data;
  const sideEffects = job.sideEffectsCompleted ?? {};

  return (
    <div>
      <h2 className="mb-3 text-lg font-medium">Job Lifecycle</h2>

      {/* Timeline */}
      {events.length > 0 && (
        <div className="mb-4 space-y-1">
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
        <details className="mb-4">
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
        <details className="mb-4">
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
