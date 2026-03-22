"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrgPath } from "@/hooks/use-org-path";
import { Button } from "@/components/ui/button";
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
import { Spinner } from "@/components/ui/spinner";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyActions,
} from "@/components/ui/empty";
import { MessageSquareIcon } from "lucide-react";

type Session = {
  id: string;
  agentType: string;
  status: string;
  prompt: string;
  createdAt: string;
  endedAt: string | null;
};

export default function SessionsPage() {
  const op = useOrgPath();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/interactive-sessions")
      .then((r) => r.json())
      .then((data) => {
        setSessions(data.sessions ?? []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Interactive agent sessions.
          </p>
        </div>
        <Button asChild>
          <Link href={op("/sessions/new")}>New Session</Link>
        </Button>
      </div>

      {loading ? (
        <div className="flex flex-col items-center gap-3 py-16">
          <Spinner className="text-muted-foreground" />
          <p className="text-xs text-muted-foreground">Loading...</p>
        </div>
      ) : sessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="illustration">
              <MessageSquareIcon />
            </EmptyMedia>
            <EmptyTitle>No sessions yet</EmptyTitle>
            <EmptyDescription>
              Interactive agent sessions will appear here once created.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyActions>
            <Button asChild>
              <Link href={op("/sessions/new")}>Start your first session</Link>
            </Button>
          </EmptyActions>
        </Empty>
      ) : (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Agent</TableHead>
                <TableHead>Prompt</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell>
                    <Link
                      href={op(`/sessions/${s.id}`)}
                      className="font-medium hover:underline"
                    >
                      {s.agentType}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-xs truncate text-muted-foreground">
                    {s.prompt.slice(0, 80)}
                    {s.prompt.length > 80 ? "..." : ""}
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={s.status} />
                  </TableCell>
                  <TableCell>
                    <span className="text-[11px] tabular-nums text-muted-foreground/50">
                      {new Date(s.createdAt).toLocaleString()}
                    </span>
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
