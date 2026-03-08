"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Session = {
  id: string;
  agentType: string;
  status: string;
  prompt: string;
  createdAt: string;
  endedAt: string | null;
};

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    creating: "bg-yellow-100 text-yellow-800",
    active: "bg-green-100 text-green-800",
    completed: "bg-gray-100 text-gray-800",
    failed: "bg-red-100 text-red-800",
    stopped: "bg-gray-100 text-gray-800",
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status] ?? "bg-gray-100 text-gray-800"}`}
    >
      {status}
    </span>
  );
}

export default function SessionsPage() {
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
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-medium">Sessions</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Interactive agent sessions.
          </p>
        </div>
        <Link
          href="/sessions/new"
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          New Session
        </Link>
      </div>

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading...</p>
      ) : sessions.length === 0 ? (
        <div className="py-12 text-center">
          <p className="text-sm text-muted-foreground">No sessions yet.</p>
          <Link
            href="/sessions/new"
            className="mt-2 inline-block text-sm text-blue-600 hover:underline"
          >
            Start your first session
          </Link>
        </div>
      ) : (
        <div className="overflow-hidden rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead className="border-b border-border bg-muted/50">
              <tr>
                <th className="px-4 py-2 text-left font-medium">Agent</th>
                <th className="px-4 py-2 text-left font-medium">Prompt</th>
                <th className="px-4 py-2 text-left font-medium">Status</th>
                <th className="px-4 py-2 text-left font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {sessions.map((s) => (
                <tr key={s.id} className="hover:bg-muted/30">
                  <td className="px-4 py-2">
                    <Link
                      href={`/sessions/${s.id}`}
                      className="font-medium hover:underline"
                    >
                      {s.agentType}
                    </Link>
                  </td>
                  <td className="max-w-xs truncate px-4 py-2 text-muted-foreground">
                    {s.prompt.slice(0, 80)}
                    {s.prompt.length > 80 ? "..." : ""}
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={s.status} />
                  </td>
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(s.createdAt).toLocaleString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
