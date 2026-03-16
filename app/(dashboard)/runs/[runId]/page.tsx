"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SessionErrorAlert } from "@/components/sessions/session-error-alert";
import { StatusBadge } from "@/components/status-badge";
import { SessionChat } from "@/components/sessions/session-chat";
import { useSessionChat } from "@/hooks/use-session-chat";

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

      <div className="grid gap-4 sm:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Source</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-medium">{run.source}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Branch</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="font-mono text-sm">{run.branchName ?? "\u2014"}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">PR</CardTitle>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Created</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm">{new Date(run.createdAt).toLocaleString()}</p>
          </CardContent>
        </Card>
      </div>

      {run.summary && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs font-medium text-muted-foreground">Summary</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="whitespace-pre-wrap text-sm">{run.summary}</pre>
          </CardContent>
        </Card>
      )}

      {run.error && (
        <SessionErrorAlert error={run.error} />
      )}

      <div>
        <h2 className="mb-3 text-lg font-medium">Agent Session</h2>
        {run.agentSessionId ? (
          <RunSessionChat sdkSessionId={run.agentSessionId} />
        ) : (
          <p className="text-sm text-muted-foreground">
            No agent session linked to this run.
          </p>
        )}
      </div>
    </div>
  );
}

function RunSessionChat({ sdkSessionId }: { sdkSessionId: string }) {
  const chat = useSessionChat({
    sdkSessionId,
    sessionStatus: "completed",
    terminal: true, // Runs page only shows completed runs
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
