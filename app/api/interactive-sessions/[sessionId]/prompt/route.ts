import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { getSessionWithOrg } from "@/lib/auth/session";
import {
  getInteractiveSession,
  updateInteractiveSession,
} from "@/lib/sessions/actions";
import { sessionMessages } from "@/lib/trigger/streams";
import type { interactiveSessionTask } from "@/trigger/interactive-session";
import type { AgentType } from "@/lib/sandbox-agent/types";

/**
 * POST /api/interactive-sessions/:sessionId/prompt — send a message.
 *
 * If the session is active: completes the Trigger.dev wait token.
 * If the session is stopped/completed: triggers a new task to resume
 * with history replay, transparent to the user.
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

  // ── Active session: send via input stream ──
  if (session.status === "active" && session.triggerRunId) {
    await sessionMessages.send(session.triggerRunId, {
      action: "prompt",
      prompt,
    });

    return NextResponse.json({ ok: true });
  }

  // ── Stopped/completed session: auto-resume with history ──
  if (
    (session.status === "stopped" || session.status === "completed") &&
    session.sdkSessionId
  ) {
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

    // Mark as creating while the new task boots
    await updateInteractiveSession(sessionId, {
      status: "creating",
      error: null,
      endedAt: null,
    });

    // Trigger a new task with resume flag
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
      },
      { tags: [`session:${sessionId}`] },
    );

    return NextResponse.json({ ok: true, resumed: true });
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
