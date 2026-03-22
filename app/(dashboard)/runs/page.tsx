"use client";

import { useState } from "react";
import { useMountEffect } from "@/hooks/use-mount-effect";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import { VerdictBadge } from "@/components/verdict-badge";

type Run = {
  id: string;
  automationId: string;
  automationName: string | null;
  status: string;
  source: string;
  interactiveSessionId: string | null;
  prUrl: string | null;
  branchName: string | null;
  summary: string | null;
  error: string | null;
  verdict: string | null;
  reviewScope: string | null;
  jobId: string | null;
  prNumber: number | null;
  prTitle: string | null;
  repoOwner: string | null;
  repoName: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

function formatDuration(start: string | null, end: string | null): string {
  if (!start) return "\u2014";
  const s = new Date(start).getTime();
  const e = end ? new Date(end).getTime() : Date.now();
  const secs = Math.round((e - s) / 1000);
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function ResultCell({ run }: { run: Run }) {
  if (run.verdict) {
    return <VerdictBadge verdict={run.verdict} />;
  }
  if (run.prUrl) {
    return (
      <a
        href={run.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="text-primary hover:underline"
      >
        PR
      </a>
    );
  }
  return <span className="text-muted-foreground">{"\u2014"}</span>;
}

export default function RunsPage() {
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useMountEffect(() => {
    fetch("/api/runs")
      .then((r) => r.json())
      .then((data) => {
        setRuns(data.runs);
        setLoading(false);
      });
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Runs</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          All automation runs across your organization.
        </p>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Automation</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>PR</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link
                      href={`/runs/${run.id}`}
                      className="font-medium hover:underline"
                    >
                      {run.automationName ?? "Unknown"}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {run.repoOwner && run.repoName
                      ? `${run.repoOwner}/${run.repoName}`
                      : run.source}
                  </TableCell>
                  <TableCell>
                    {run.prNumber && run.repoOwner && run.repoName ? (
                      <a
                        href={`https://github.com/${run.repoOwner}/${run.repoName}/pull/${run.prNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                        title={run.prTitle ?? undefined}
                      >
                        #{run.prNumber}
                      </a>
                    ) : (
                      <span className="text-muted-foreground">{"\u2014"}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={run.status} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDuration(run.startedAt, run.completedAt)}
                  </TableCell>
                  <TableCell>
                    <ResultCell run={run} />
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(run.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}
