import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSessionForOrg,
  getActiveRuntime,
  getLatestRuntime,
} from "@/lib/sessions/actions";
import {
  getOrgObservabilitySettings,
  isSandboxRawLogDebugEnabled,
} from "@/lib/observability/org-settings";
import { withEvlog } from "@/lib/evlog";

export const GET = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSessionForOrg(sessionId, orgId);
  if (!session) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const runtime =
    (await getActiveRuntime(sessionId)) ??
    (await getLatestRuntime(sessionId));
  const settings = await getOrgObservabilitySettings(orgId);

  let proxyStatus: Record<string, unknown> | null = null;
  let proxyStatusError: string | null = null;

  if (runtime?.sandboxBaseUrl) {
    try {
      const response = await fetch(`${runtime.sandboxBaseUrl}/status`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        proxyStatus = await response.json() as Record<string, unknown>;
      } else {
        proxyStatusError = `Proxy returned ${response.status}`;
      }
    } catch (error) {
      proxyStatusError =
        error instanceof Error ? error.message : String(error);
    }
  }

  return NextResponse.json({
    runtime,
    settings,
    rawLogDebugActive: isSandboxRawLogDebugEnabled(settings),
    inspectorUrl: runtime?.agentServerUrl ? `${runtime.agentServerUrl}/ui/` : null,
    proxyStatus,
    proxyStatusError,
  });
});
