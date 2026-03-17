import { NextRequest, NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSessionForOrg,
  getActiveRuntime,
  getLatestRuntime,
} from "@/lib/sessions/actions";

/**
 * GET /api/sessions/[sessionId]/logs
 *
 * Proxies process log requests to the sandbox-agent server via the REST proxy.
 * Uses the sandbox-agent's /v1/processes/{id}/logs API (provider-agnostic).
 *
 * Query params forwarded to sandbox-agent:
 *   - processId: process ID to fetch logs for (optional — fetches all if omitted)
 *   - stream: stdout | stderr | combined (default: combined)
 *   - tail: number of entries to return from the end
 *   - since: sequence number for resumption
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  // Verify session belongs to org
  const session = await getInteractiveSessionForOrg(sessionId, orgId);
  if (!session) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  // Get the runtime with the proxy URL
  const runtime =
    (await getActiveRuntime(sessionId)) ??
    (await getLatestRuntime(sessionId));

  if (!runtime?.sandboxBaseUrl) {
    return NextResponse.json(
      { error: "No sandbox available", logs: null },
      { status: 404 },
    );
  }

  // Forward query params
  const url = new URL(req.url);
  const processId = url.searchParams.get("processId");
  const stream = url.searchParams.get("stream") ?? "combined";
  const tail = url.searchParams.get("tail") ?? "500";
  const since = url.searchParams.get("since");

  // Build the proxy URL
  const proxyBase = runtime.sandboxBaseUrl;

  if (processId) {
    // Fetch logs for a specific process
    const logParams = new URLSearchParams({ stream, tail });
    if (since) logParams.set("since", since);

    try {
      const response = await fetch(
        `${proxyBase}/processes/${encodeURIComponent(processId)}/logs?${logParams}`,
        { signal: AbortSignal.timeout(15_000) },
      );

      if (!response.ok) {
        return NextResponse.json(
          {
            error: "Failed to fetch process logs",
            status: response.status,
            detail: await response.text().catch(() => ""),
          },
          { status: response.status },
        );
      }

      const data = await response.json();
      return NextResponse.json(data);
    } catch (err) {
      return NextResponse.json(
        {
          error: "Sandbox unreachable",
          detail: err instanceof Error ? err.message : String(err),
          logs: null,
        },
        { status: 502 },
      );
    }
  }

  // No processId — fetch process info for the specific process
  // Try to get the process list by querying a well-known process
  try {
    const response = await fetch(`${proxyBase}/health`, {
      signal: AbortSignal.timeout(5_000),
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: "Sandbox unreachable", logs: null },
        { status: 502 },
      );
    }

    return NextResponse.json({
      sandboxId: runtime.sandboxId,
      proxyUrl: proxyBase,
      agentServerUrl: runtime.agentServerUrl,
      status: "available",
      hint: "Pass ?processId=<id> to fetch logs for a specific process. Use the sandbox-agent /v1/processes API to discover process IDs.",
    });
  } catch {
    return NextResponse.json(
      { error: "Sandbox unreachable", logs: null },
      { status: 502 },
    );
  }
}
