"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { SessionChat } from "@/components/sessions/session-chat";

type Run = {
  id: string;
  automationId: string;
  automationName: string | null;
  status: string;
  source: string;
  agentSessionId: string | null;
  prUrl: string | null;
  branchName: string | null;
  summary: string | null;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    succeeded: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
    cancelled: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {status}
    </span>
  );
}

export default function RunDetailPage() {
  const { runId } = useParams<{ runId: string }>();
  const [run, setRun] = useState<Run | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/runs?limit=100`)
      .then((r) => r.json())
      .then((data) => {
        const found = data.runs.find((r: Run) => r.id === runId);
        setRun(found ?? null);
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
    <div className="space-y-6">
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

      {/* Run metadata */}
      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Source</p>
          <p className="mt-0.5 font-medium">{run.source}</p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Branch</p>
          <p className="mt-0.5 font-mono text-sm">
            {run.branchName ?? "\u2014"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">PR</p>
          {run.prUrl ? (
            <a
              href={run.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-0.5 block text-blue-600 hover:underline"
            >
              View PR
            </a>
          ) : (
            <p className="mt-0.5 text-muted-foreground">{"\u2014"}</p>
          )}
        </div>
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs text-muted-foreground">Created</p>
          <p className="mt-0.5 text-sm">
            {new Date(run.createdAt).toLocaleString()}
          </p>
        </div>
      </div>

      {/* Summary / Error */}
      {run.summary && (
        <div className="rounded-lg border border-border p-4">
          <p className="text-xs font-medium text-muted-foreground">Summary</p>
          <pre className="mt-1 whitespace-pre-wrap text-sm">{run.summary}</pre>
        </div>
      )}

      {run.error && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-4">
          <p className="text-xs font-medium text-red-700">Error</p>
          <pre className="mt-1 whitespace-pre-wrap text-sm text-red-800">
            {run.error}
          </pre>
        </div>
      )}

      {/* Agent Session Chat */}
      <div>
        <h2 className="mb-3 text-lg font-medium">Agent Session</h2>
        {run.agentSessionId ? (
          <SessionChat
            mode="history"
            sdkSessionId={run.agentSessionId}
          />
        ) : (
          <p className="text-sm text-muted-foreground">
            No agent session linked to this run.
          </p>
        )}
      </div>
    </div>
  );
}
