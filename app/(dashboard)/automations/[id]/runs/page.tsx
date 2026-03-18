"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
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
  summary: string | null;
  verdict: string | null;
  reviewScope: string | null;
  jobId: string | null;
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

export default function AutomationRunsPage() {
  const { id } = useParams<{ id: string }>();
  const [runs, setRuns] = useState<Run[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch(`/api/runs?automationId=${id}`)
      .then((r) => r.json())
      .then((data) => {
        setRuns(data.runs);
        setLoading(false);
      });
  }, [id]);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <Link
          href={`/automations/${id}`}
          className="text-sm text-muted-foreground hover:underline"
        >
          Automation
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-medium">Run History</h1>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No runs yet for this automation.
        </p>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Status</TableHead>
                <TableHead>Repository</TableHead>
                <TableHead>Duration</TableHead>
                <TableHead>Result</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runs.map((run) => (
                <TableRow key={run.id}>
                  <TableCell>
                    <Link href={`/runs/${run.id}`} className="hover:underline">
                      <StatusBadge status={run.status} />
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-sm text-muted-foreground">
                    {run.repoOwner && run.repoName
                      ? `${run.repoOwner}/${run.repoName}`
                      : run.source}
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
