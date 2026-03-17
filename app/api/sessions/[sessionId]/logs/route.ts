import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSessionForOrg,
  getActiveRuntime,
  getLatestRuntime,
} from "@/lib/sessions/actions";

type ProcessInfo = {
  id: string;
  command: string;
  args: string[];
  status: string;
  owner: string;
  pid: number | null;
  exitCode: number | null;
  createdAtMs: number;
};

type LogEntry = {
  sequence: number;
  stream: string;
  timestampMs: number;
  data: string;
  encoding: string;
};

/**
 * GET /api/sessions/[sessionId]/logs
 *
 * Fetches process list and logs from the sandbox-agent server via the REST proxy.
 * Uses sandbox-agent's provider-agnostic /v1/processes API.
 *
 * Query params:
 *   - processId: fetch logs for a specific process (skips discovery)
 *   - stream: stdout | stderr | combined (default: combined)
 *   - tail: number of log entries (default: 200)
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSessionForOrg(sessionId, orgId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const runtime =
    (await getActiveRuntime(sessionId)) ??
    (await getLatestRuntime(sessionId));

  if (!runtime?.sandboxBaseUrl) {
    return NextResponse.json(
      { error: "No sandbox available" },
      { status: 404 },
    );
  }

  const url = new URL(req.url);
  const processId = url.searchParams.get("processId");
  const stream = url.searchParams.get("stream") ?? "combined";
  const tail = url.searchParams.get("tail") ?? "200";
  const proxyBase = runtime.sandboxBaseUrl;

  try {
    // If a specific processId is requested, fetch its logs directly
    if (processId) {
      const logs = await fetchProcessLogs(proxyBase, processId, stream, tail);
      return NextResponse.json({ processes: null, logs });
    }

    // Otherwise: discover processes, then fetch logs for each
    const processRes = await fetch(`${proxyBase}/processes`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!processRes.ok) {
      return NextResponse.json(
        { error: "Failed to list processes", status: processRes.status },
        { status: 502 },
      );
    }

    const { processes } = (await processRes.json()) as {
      processes: ProcessInfo[];
    };

    // Fetch logs for each running process (limit to first 5 to avoid overload)
    const logsPerProcess: Record<string, LogEntry[]> = {};
    const toFetch = processes.slice(0, 5);

    await Promise.all(
      toFetch.map(async (proc) => {
        try {
          const logs = await fetchProcessLogs(
            proxyBase,
            proc.id,
            stream,
            tail,
          );
          if (logs.length > 0) {
            logsPerProcess[proc.id] = logs;
          }
        } catch {
          // Skip processes whose logs aren't available
        }
      }),
    );

    return NextResponse.json({
      processes,
      logs: logsPerProcess,
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "Sandbox unreachable",
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}

async function fetchProcessLogs(
  proxyBase: string,
  processId: string,
  stream: string,
  tail: string,
): Promise<LogEntry[]> {
  const logParams = new URLSearchParams({ stream, tail });
  const response = await fetch(
    `${proxyBase}/processes/${encodeURIComponent(processId)}/logs?${logParams}`,
    { signal: AbortSignal.timeout(15_000) },
  );

  if (!response.ok) return [];

  const data = (await response.json()) as { entries?: LogEntry[] };
  return data.entries ?? [];
}
