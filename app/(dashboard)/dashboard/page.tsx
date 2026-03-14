"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { StatusBadge } from "@/components/status-badge";
import {
  GitPullRequestIcon,
  ZapIcon,
  MessageSquareIcon,
  ArrowRightIcon,
} from "lucide-react";

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

type Automation = {
  id: string;
  name: string;
  enabled: boolean;
  mode: string;
};

const INTENT_CARDS = {
  "pr-review": {
    icon: GitPullRequestIcon,
    title: "PR Review Bot",
    description: "Automatically review pull requests with AI-powered code analysis.",
  },
  "coding-tasks": {
    icon: ZapIcon,
    title: "Coding Task Automation",
    description: "Run coding agents on push events to automate implementation work.",
  },
  "chat": {
    icon: MessageSquareIcon,
    title: "Interactive Session",
    description: "Start a live coding session with an AI agent.",
  },
} as const;

export default function DashboardPage() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [recentRuns, setRecentRuns] = useState<Run[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);

  useEffect(() => {
    fetch("/api/dashboard/stats")
      .then((r) => r.json())
      .then(setStats)
      .catch(() => {});

    fetch("/api/runs?limit=10")
      .then((r) => r.json())
      .then((data) => setRecentRuns(data.runs ?? []))
      .catch(() => {});

    fetch("/api/automations")
      .then((r) => r.json())
      .then((data) => setAutomations(data.automations ?? []))
      .catch(() => {});
  }, []);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-medium">Dashboard</h1>
      </div>

      <div className="grid gap-4 sm:grid-cols-4">
        {[
          { label: "Active Automations", value: stats?.activeAutomations ?? "—" },
          { label: "Runs Today", value: stats?.runsToday ?? "—" },
          { label: "PRs Created Today", value: stats?.prsToday ?? "—" },
          { label: "Success Rate", value: stats ? `${stats.successRate}%` : "—" },
        ].map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">
                {stat.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold">{stat.value}</p>
            </CardContent>
          </Card>
        ))}
      </div>

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

        {recentRuns.length === 0 && automations.length > 0 ? (
          <div className="grid gap-4 sm:grid-cols-2">
            {automations.map((auto) => {
              const intentKey = auto.name === "PR Review Bot" ? "pr-review"
                : auto.name === "Coding Task Automation" ? "coding-tasks"
                : null;
              const card = intentKey ? INTENT_CARDS[intentKey] : null;
              if (!card) return null;
              return (
                <Link key={auto.id} href={`/automations/${auto.id}`}>
                  <Card className="transition-colors hover:bg-muted/50">
                    <CardHeader>
                      <div className="flex items-center gap-3">
                        <div className="flex size-10 items-center justify-center rounded-lg bg-primary/10">
                          <card.icon className="size-5 text-primary" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{card.title}</CardTitle>
                          <CardDescription>{card.description}</CardDescription>
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent>
                      <span className="flex items-center gap-1 text-sm text-primary">
                        Configure automation <ArrowRightIcon className="size-3" />
                      </span>
                    </CardContent>
                  </Card>
                </Link>
              );
            })}
          </div>
        ) : recentRuns.length === 0 ? (
          <p className="text-sm text-muted-foreground">No runs yet.</p>
        ) : (
          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Automation</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>PR</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentRuns.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell>
                      <Link
                        href={`/runs/${run.id}`}
                        className="font-medium hover:underline"
                      >
                        {run.automationName ?? "Unknown"}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>
                      {run.prUrl ? (
                        <a
                          href={run.prUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          PR
                        </a>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
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
    </div>
  );
}
