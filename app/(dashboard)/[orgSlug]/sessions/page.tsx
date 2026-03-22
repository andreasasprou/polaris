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
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">No sessions yet.</p>
          <Link
            href={op("/sessions/new")}
            className="mt-2 inline-block text-sm text-primary hover:underline"
          >
            Start your first session
          </Link>
        </div>
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
                  <TableCell className="text-muted-foreground">
                    {new Date(s.createdAt).toLocaleString()}
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
