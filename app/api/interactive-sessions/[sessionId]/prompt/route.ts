import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
import { getInteractiveSession } from "@/lib/sessions/actions";
import { interactiveSessions } from "@/lib/sessions/schema";
import { SandboxManager } from "@/lib/sandbox/SandboxManager";
import { sessionMessages } from "@/lib/trigger/streams";
import type { interactiveSessionTask } from "@/trigger/interactive-session";
import type { AgentType } from "@/lib/sandbox-agent/types";

const sandboxManager = new SandboxManager();

const RESUMABLE_STATUSES = ["idle", "stopped", "completed"];

/**
 * POST /api/interactive-sessions/:sessionId/prompt — send a message.
 *
 * Three-tier routing:
 * 1. Hot (task running): send via Trigger.dev input stream — instant.
 * 2. Warm (task ended, sandbox alive): reconnect to existing sandbox — ~2-3s.
 * 3. Cold (sandbox dead): create new sandbox with replay — ~15-20s.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { orgId } = await getSessionWithOrg();
  const { sessionId } = await params;

  const session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const body = await req.json();
  const { prompt } = body;

  if (!prompt?.trim()) {
    return NextResponse.json(
      { error: "prompt is required" },
      { status: 400 },
    );
  }

  // ── Tier 1: Hot — active session with running task ──
  if (session.status === "active" && session.triggerRunId) {
    await sessionMessages.send(session.triggerRunId, {
      action: "prompt",
      prompt,
    });

    return NextResponse.json({ ok: true });
  }

  // ── Tier 2/3: Resumable session — probe sandbox, then trigger task ──
  if (
    RESUMABLE_STATUSES.includes(session.status) &&
    session.sdkSessionId
  ) {
    // Optimistic lock: atomically transition to "creating" to prevent races
    const updated = await db
      .update(interactiveSessions)
      .set({ status: "creating", error: null, endedAt: null })
      .where(
        and(
          eq(interactiveSessions.id, sessionId),
          inArray(interactiveSessions.status, RESUMABLE_STATUSES),
        ),
      )
      .returning();

    if (updated.length === 0) {
      return NextResponse.json(
        { error: "Session is already resuming" },
        { status: 409 },
      );
    }

    // Resolve credentials for the new task run
    let agentApiKey: string | undefined;

    if (session.agentSecretId) {
      const { getDecryptedSecret } = await import("@/lib/secrets/queries");
      agentApiKey = await getDecryptedSecret(session.agentSecretId) ?? undefined;
    }

    if (!agentApiKey) {
      const agentType = session.agentType;
      agentApiKey =
        agentType === "codex"
          ? process.env.OPENAI_API_KEY
          : (process.env.ANTHROPIC_API_KEY ??
            process.env.CLAUDE_CODE_OAUTH_TOKEN);
    }

    if (!agentApiKey) {
      return NextResponse.json(
        { error: "No API key available to resume session" },
        { status: 400 },
      );
    }

    // Resolve repository details
    let repositoryOwner: string | undefined;
    let repositoryName: string | undefined;
    let defaultBranch: string | undefined;
    let githubInstallationId: number | undefined;

    if (session.repositoryId) {
      const { findRepositoryById, findGithubInstallationById } = await import(
        "@/lib/integrations/queries"
      );
      const repo = await findRepositoryById(session.repositoryId);
      if (repo) {
        repositoryOwner = repo.owner;
        repositoryName = repo.name;
        defaultBranch = repo.defaultBranch;
        const installation = await findGithubInstallationById(
          repo.githubInstallationId,
        );
        if (installation) {
          githubInstallationId = installation.installationId;
        }
      }
    }

    if (!repositoryOwner || !repositoryName || !githubInstallationId) {
      return NextResponse.json(
        { error: "Could not resolve repository for resume" },
        { status: 400 },
      );
    }

    // Probe sandbox: is it still alive? (warm vs cold)
    let warmResumeSandboxId: string | undefined;
    let warmResumeSandboxBaseUrl: string | undefined;

    if (session.sandboxId) {
      const alive = await sandboxManager.reconnect(session.sandboxId);
      if (alive) {
        warmResumeSandboxId = session.sandboxId;
        warmResumeSandboxBaseUrl = session.sandboxBaseUrl ?? undefined;
      }
    }

    // Trigger a new task with appropriate resume mode
    await tasks.trigger<typeof interactiveSessionTask>(
      "interactive-session",
      {
        sessionId,
        orgId,
        agentType: session.agentType as AgentType,
        agentApiKey,
        repositoryOwner,
        repositoryName,
        defaultBranch,
        githubInstallationId,
        prompt,
        resumeSdkSessionId: session.sdkSessionId,
        warmResumeSandboxId,
        warmResumeSandboxBaseUrl,
      },
      { tags: [`session:${sessionId}`] },
    );

    return NextResponse.json({
      ok: true,
      resumed: true,
      warm: !!warmResumeSandboxId,
    });
  }

  // ── Creating or failed: can't send ──
  if (session.status === "creating") {
    return NextResponse.json(
      { error: "Session is still starting up, please wait" },
      { status: 400 },
    );
  }

  return NextResponse.json(
    { error: `Session is ${session.status}, cannot send prompt` },
    { status: 400 },
  );
}
