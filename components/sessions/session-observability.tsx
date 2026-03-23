"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertCircleIcon, ExternalLinkIcon, RefreshCcwIcon, RadioTowerIcon } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";

type RuntimeSummary = {
  id: string;
  sandboxId: string | null;
  sandboxBaseUrl: string | null;
  agentServerUrl: string | null;
  proxyCmdId: string | null;
  status: string;
  stopReason: string | null;
  usageSummary: Record<string, unknown>;
  teardownArtifacts: Record<string, unknown>;
  createdAt: string;
  endedAt: string | null;
};

type ObservabilitySettings = {
  sandboxRawLogs: {
    enabled: boolean;
    expiresAt: string | null;
    reason: string | null;
  };
};

type ProxyManagedProcess = {
  id: string;
  command: string;
  args: string[];
  status: string;
  owner: string;
  pid: number | null;
  exitCode: number | null;
  createdAtMs: number;
  tty: boolean;
};

type ProxyStatus = {
  state: string;
  observability: {
    rawLogDebugEnabled: boolean;
    rawLogDebugExpiresAt?: string;
  };
  agentHealth: {
    status: string;
    consecutiveFailures: number;
    lastSuccessAt?: string;
    lastFailureAt?: string;
    lastError?: string;
  };
  activity: {
    eventCount: number;
    lastEventAt?: string;
    lastCallbackAttemptAt?: string;
    lastCallbackDeliveredAt?: string;
    lastCallbackAttemptSucceeded?: boolean;
  };
  outbox: {
    pendingCount: number;
    failedCount: number;
    deliveredCount: number;
  };
  managedProcesses: ProxyManagedProcess[];
};

type ObservabilityData = {
  runtime: RuntimeSummary | null;
  settings: ObservabilitySettings;
  rawLogDebugActive: boolean;
  inspectorUrl: string | null;
  proxyStatus: ProxyStatus | null;
  proxyStatusError: string | null;
};

type ProcessInfo = {
  id: string;
  command: string;
  args: string[];
  status: string;
  owner: string;
  pid: number | null;
  exitCode: number | null;
  tty: boolean;
};

type LogEntry = {
  sequence: number;
  stream: string;
  timestampMs: number;
  data: string;
  encoding?: string;
};

type SandboxLogsData = {
  processes: ProcessInfo[] | null;
  logs: Record<string, LogEntry[]>;
  error?: string;
};

function formatTs(value?: string | null): string {
  if (!value) return "—";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString();
}

function formatJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function decodeLiveEntry(entry: LogEntry): string {
  if (entry.encoding === "base64") {
    try {
      return atob(entry.data);
    } catch {
      return entry.data;
    }
  }
  return entry.data;
}

export function SessionObservability({ sessionId }: { sessionId: string }) {
  const [observability, setObservability] = useState<ObservabilityData | null>(null);
  const [logsData, setLogsData] = useState<SandboxLogsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState("");
  const [liveError, setLiveError] = useState<string | null>(null);

  const fetchObservability = useCallback(async () => {
    const response = await fetch(`/api/interactive-sessions/${sessionId}/observability`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to fetch observability details");
    }
    return data as ObservabilityData;
  }, [sessionId]);

  const fetchLogs = useCallback(async () => {
    const response = await fetch(`/api/sessions/${sessionId}/logs`);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.error ?? "Failed to fetch sandbox logs");
    }
    return data as SandboxLogsData;
  }, [sessionId]);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [obs, logs] = await Promise.all([
        fetchObservability(),
        fetchLogs(),
      ]);
      setObservability(obs);
      setLogsData(logs);
      setSelectedProcessId((current) => current ?? logs.processes?.[0]?.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to fetch observability details");
    } finally {
      setLoading(false);
    }
  }, [fetchLogs, fetchObservability]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!observability?.rawLogDebugActive || !selectedProcessId) {
      setLiveLog("");
      setLiveError(null);
      return;
    }

    const source = new EventSource(
      `/api/sessions/${sessionId}/logs?processId=${encodeURIComponent(selectedProcessId)}&follow=true&tail=50`,
    );

    const onLog = (event: MessageEvent<string>) => {
      try {
        const entry = JSON.parse(event.data) as LogEntry;
        setLiveLog((current) => {
          const next = `${current}${decodeLiveEntry(entry)}`;
          return next.length > 25_000 ? next.slice(-25_000) : next;
        });
      } catch {
        // Ignore malformed chunks
      }
    };

    source.addEventListener("log", onLog as EventListener);
    source.onerror = () => {
      setLiveError("Live log stream disconnected");
      source.close();
    };

    return () => {
      source.removeEventListener("log", onLog as EventListener);
      source.close();
    };
  }, [observability?.rawLogDebugActive, selectedProcessId, sessionId]);

  const selectedBufferedLog = useMemo(() => {
    if (!selectedProcessId || !logsData?.logs[selectedProcessId]) return "";
    return logsData.logs[selectedProcessId].map((entry) => entry.data).join("");
  }, [logsData, selectedProcessId]);

  if (loading) {
    return (
      <div className="flex flex-col items-center gap-3 py-10">
        <Spinner className="text-muted-foreground" />
        <p className="text-xs text-muted-foreground">Loading observability details…</p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircleIcon />
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto pt-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">Runtime observability</h2>
          <p className="text-xs text-muted-foreground">
            Proxy status, sandbox-agent processes, buffered logs, and live follow when debug mode is active.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          <RefreshCcwIcon className="mr-2 size-3.5" />
          Refresh
        </Button>
      </div>

      {observability?.proxyStatusError && (
        <Alert>
          <AlertCircleIcon />
          <AlertDescription>{observability.proxyStatusError}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Runtime</CardTitle>
            <CardDescription>
              Current sandbox handles and stop summary.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p><span className="font-medium">Runtime:</span> {observability?.runtime?.id ?? "—"}</p>
            <p><span className="font-medium">Sandbox:</span> {observability?.runtime?.sandboxId ?? "—"}</p>
            <p><span className="font-medium">Proxy command:</span> {observability?.runtime?.proxyCmdId ?? "—"}</p>
            <p><span className="font-medium">Status:</span> {observability?.runtime?.status ?? "—"}</p>
            <p><span className="font-medium">Stop reason:</span> {observability?.runtime?.stopReason ?? "—"}</p>
            <p><span className="font-medium">Started:</span> {formatTs(observability?.runtime?.createdAt)}</p>
            <p><span className="font-medium">Ended:</span> {formatTs(observability?.runtime?.endedAt ?? null)}</p>
            {observability?.inspectorUrl && (
              <Link
                href={observability.inspectorUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
              >
                Open sandbox-agent Inspector
                <ExternalLinkIcon className="size-3.5" />
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <RadioTowerIcon className="size-4" />
              Raw log debug
            </CardTitle>
            <CardDescription>
              Org-scoped debug capture window for live process log follow.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={observability?.rawLogDebugActive ? "default" : "secondary"}>
                {observability?.rawLogDebugActive ? "Active" : "Inactive"}
              </Badge>
              {observability?.settings?.sandboxRawLogs.reason && (
                <Badge variant="outline">{observability.settings.sandboxRawLogs.reason}</Badge>
              )}
            </div>
            <p><span className="font-medium">Configured:</span> {observability?.settings?.sandboxRawLogs.enabled ? "Enabled" : "Disabled"}</p>
            <p><span className="font-medium">Expires:</span> {formatTs(observability?.settings?.sandboxRawLogs.expiresAt ?? null)}</p>
            <p className="text-xs text-muted-foreground">
              Live follow is only available while this window is active. Buffered logs and teardown artifacts remain available regardless.
            </p>
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Managed processes</CardTitle>
            <CardDescription>
              sandbox-agent process inventory from the proxy and logs API.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(observability?.proxyStatus?.managedProcesses ?? logsData?.processes ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No managed processes reported.</p>
            )}

            {(observability?.proxyStatus?.managedProcesses ?? logsData?.processes ?? []).map((process) => (
              <button
                key={process.id}
                type="button"
                onClick={() => {
                  setSelectedProcessId(process.id);
                  setLiveLog("");
                  setLiveError(null);
                }}
                className={`w-full rounded-lg border p-3 text-left transition-colors ${
                  selectedProcessId === process.id
                    ? "border-primary bg-primary/5"
                    : "hover:bg-muted/40"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <p className="text-sm font-medium">
                    {process.command} {process.args?.slice(0, 2).join(" ")}
                  </p>
                  <Badge variant={process.status === "running" ? "default" : "secondary"}>
                    {process.status}
                  </Badge>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {process.id} · pid {process.pid ?? "—"} · {process.tty ? "tty" : "non-tty"}
                </p>
              </button>
            ))}
          </CardContent>
        </Card>

        <div className="flex min-h-0 flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Proxy status</CardTitle>
              <CardDescription>
                Latest live proxy snapshot including callbacks and agent health.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded border bg-muted/30 p-3 text-xs">
                {formatJson(observability?.proxyStatus ?? { message: "No live proxy status available" })}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Buffered process logs</CardTitle>
              <CardDescription>
                Recent sandbox-agent log buffer for the selected process.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <pre className="max-h-72 overflow-auto rounded border bg-muted/30 p-3 text-xs">
                {selectedBufferedLog || "No buffered log output captured for the selected process."}
              </pre>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="text-sm">Live follow</CardTitle>
              <CardDescription>
                Streams new log chunks while org raw-log debug mode is active.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {liveError && (
                <Alert>
                  <AlertCircleIcon />
                  <AlertDescription>{liveError}</AlertDescription>
                </Alert>
              )}
              {!observability?.rawLogDebugActive && (
                <p className="text-sm text-muted-foreground">
                  Enable raw log debug in org settings to unlock live follow.
                </p>
              )}
              <pre className="max-h-72 overflow-auto rounded border bg-muted/30 p-3 text-xs">
                {observability?.rawLogDebugActive
                  ? liveLog || "Waiting for live log output…"
                  : "Live follow disabled."}
              </pre>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
