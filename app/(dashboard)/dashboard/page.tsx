"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type Stats = {
  activeAutomations: number;
  runsToday: number;
  prsToday: number;
  successRate: number;
  totalRuns: number;
};

type Run = {
  id: string;
  automationName: string | null;
  status: string;
  source: string;
  prUrl: string | null;
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

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});

    fetch("/api/runs?limit=10")
      .then((r) => r.json())
      .then((data) => setRecentRuns(data.runs ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-medium">Dashboard</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">Active Automations</p>
          <p className="mt-1 text-2xl font-semibold">
            {stats?.activeAutomations ?? "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">Runs Today</p>
          <p className="mt-1 text-2xl font-semibold">
            {stats?.runsToday ?? "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">PRs Created Today</p>
          <p className="mt-1 text-2xl font-semibold">
            {stats?.prsToday ?? "—"}
          </p>
        </div>
        <div className="rounded-lg border border-border p-4">
          <p className="text-sm text-muted-foreground">Success Rate</p>
          <p className="mt-1 text-2xl font-semibold">
            {stats ? `${stats.successRate}%` : "—"}
          </p>
        </div>
      </div>

      {/* Recent runs */}
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-lg font-medium">Recent Runs</h2>
          <Link
            href="/runs"
            className="text-sm text-muted-foreground hover:underline"
          >
            View all
          </Link>
        </div>

        {recentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-border">
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/50">
                <tr>
                  <th className="px-4 py-2 text-left font-medium">
                    Automation
                  </th>
                  <th className="px-4 py-2 text-left font-medium">Status</th>
                  <th className="px-4 py-2 text-left font-medium">PR</th>
                  <th className="px-4 py-2 text-left font-medium">Created</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {recentRuns.map((run) => (
                  <tr key={run.id} className="hover:bg-muted/30">
                    <td className="px-4 py-2">
                      <Link
                        href={`/runs/${run.id}`}
                        className="font-medium hover:underline"
                      >
                        {run.automationName ?? "Unknown"}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      <StatusBadge status={run.status} />
                    </td>
                    <td className="px-4 py-2">
                      {run.prUrl ? (
                        <a
                          href={run.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-blue-600 hover:underline"
                        >
                          PR
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2 text-muted-foreground">
                      {new Date(run.createdAt).toLocaleString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
