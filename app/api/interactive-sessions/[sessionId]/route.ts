import { NextResponse } from "next/server";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSession,
  casSessionStatus,
} from "@/lib/sessions/actions";
import { getStatusConfig } from "@/lib/sessions/status";
import { getActiveJobForSession } from "@/lib/jobs/actions";
import { withEvlog } from "@/lib/evlog";

/**
 * GET /api/interactive-sessions/:sessionId — get session details.
 *
 * v2: Reconciliation via job status.
 * If the session is in an active state but has no active job,
 * the DB is stale — heal before responding.
 */
export const GET = withEvlog(async (
  _req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  let session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // Job-based reconciliation: if active but no nonterminal job, heal to idle
  if (session.status === "active") {
    const activeJob = await getActiveJobForSession(sessionId);
    if (!activeJob) {
      const healed = await casSessionStatus(sessionId, ["active"], "idle");
      if (healed) {
        session = healed;
      }
    }
  }

  return NextResponse.json({ session });
});

/**
 * DELETE /api/interactive-sessions/:sessionId — stop an active session.
 *
 * Two modes:
 *   - Stop current turn (default): POST /stop to sandbox proxy
 *     → prompt_failed callback → session returns to idle
 *   - Terminate session (?terminate=true): CAS → stopped, destroy sandbox, cancel active job
 */
export const DELETE = withEvlog(async (
  req: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) => {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (!getStatusConfig(session.status).canStop) {
    return NextResponse.json(
      { error: `Session is ${session.status}, cannot stop` },
      { status: 400 },
    );
  }

  const url = new URL(req.url);
  const terminate = url.searchParams.get("terminate") === "true";

  if (terminate) {
    // Terminate: CAS → stopped, destroy sandbox, cancel active job
    const stopped = await casSessionStatus(
      sessionId,
      ["active", "idle", "creating"],
      "stopped",
      { endedAt: new Date() },
    );

    if (!stopped) {
      return NextResponse.json(
        { error: "Session already transitioned" },
        { status: 409 },
      );
    }

    // Cancel active job
    const activeJob = await getActiveJobForSession(sessionId);
    if (activeJob) {
      const { casJobStatus } = await import("@/lib/jobs/actions");
      await casJobStatus(
        activeJob.id,
        ["pending", "accepted", "running"],
        "cancelled",
      );
    }

    // Destroy sandbox (best-effort, async)
    if (session.sandboxBaseUrl) {
      // POST /stop to proxy (best-effort)
      const proxyUrl = session.sandboxBaseUrl.replace(/:2468\b/, ":2469");
      fetch(`https://${proxyUrl}/stop`, {
        method: "POST",
        signal: AbortSignal.timeout(5_000),
      }).catch(() => {});
    }

    const { destroySandbox } = await import("@/lib/orchestration/sandbox-lifecycle");
    await destroySandbox(sessionId);

    return NextResponse.json({ ok: true, terminated: true });
  }

  // Stop current turn: POST /stop to sandbox proxy
  // The proxy will emit a prompt_failed callback which transitions job to failed
  // and the session back to idle
  if (!session.sandboxBaseUrl) {
    // No sandbox — just CAS to idle
    await casSessionStatus(sessionId, ["active"], "idle");
    return NextResponse.json({ ok: true });
  }

  const proxyUrl = session.sandboxBaseUrl.replace(/:2468\b/, ":2469");
  try {
    const response = await fetch(`https://${proxyUrl}/stop`, {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // Proxy stop failed — fallback to CAS idle
      await casSessionStatus(sessionId, ["active"], "idle");
    }
  } catch {
    // Proxy unreachable — CAS to idle
    await casSessionStatus(sessionId, ["active"], "idle");
  }

  return NextResponse.json({ ok: true });
});
