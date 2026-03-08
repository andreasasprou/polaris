import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
import { interactiveSessions } from "@/lib/sessions/schema";
import { createInteractiveSession } from "@/lib/sessions/actions";
import type { interactiveSessionTask } from "@/trigger/interactive-session";

/**
 * GET /api/interactive-sessions — list interactive sessions for the current org.
 */
export async function GET() {
  const { session, orgId } = await getSessionWithOrg();

  const sessions = await db
    .select()
    .from(interactiveSessions)
    .where(eq(interactiveSessions.organizationId, orgId))
    .orderBy(desc(interactiveSessions.createdAt))
    .limit(50);

  return NextResponse.json({ sessions });
}

/**
 * POST /api/interactive-sessions — create a new interactive session.
 */
export async function POST(req: NextRequest) {
  const { session, orgId } = await getSessionWithOrg();

  const body = await req.json();
  const { agentType, agentSecretId, repositoryId, prompt } = body;

  if (!prompt?.trim()) {
    return NextResponse.json(
      { error: "prompt is required" },
      { status: 400 },
    );
  }

  if (!repositoryId) {
    return NextResponse.json(
      { error: "repository is required" },
      { status: 400 },
    );
  }

  // Resolve credentials
  let agentApiKey: string | undefined;
  let repositoryOwner: string | undefined;
  let repositoryName: string | undefined;
  let defaultBranch: string | undefined;
  let githubInstallationId: number | undefined;

  if (agentSecretId) {
    const { getDecryptedSecret } = await import("@/lib/secrets/queries");
    const decrypted = await getDecryptedSecret(agentSecretId);
    if (decrypted) {
      agentApiKey = decrypted;
    }
  }

  // Fallback to env vars
  if (!agentApiKey) {
    agentApiKey =
      agentType === "codex"
        ? process.env.OPENAI_API_KEY
        : (process.env.ANTHROPIC_API_KEY ??
          process.env.CLAUDE_CODE_OAUTH_TOKEN);
  }

  if (!agentApiKey) {
    return NextResponse.json(
      { error: "No API key available for the selected agent" },
      { status: 400 },
    );
  }

  if (repositoryId) {
    const { findRepositoryById } = await import(
      "@/lib/integrations/queries"
    );
    const repo = await findRepositoryById(repositoryId);
    if (repo) {
      repositoryOwner = repo.owner;
      repositoryName = repo.name;
      defaultBranch = repo.defaultBranch;

      // Get numeric installation ID
      const { findGithubInstallationById } = await import(
        "@/lib/integrations/queries"
      );
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
      { error: "Could not resolve repository details" },
      { status: 400 },
    );
  }

  // Create DB record
  const interactiveSession = await createInteractiveSession({
    organizationId: orgId,
    createdBy: session.user.id,
    agentType: agentType ?? "claude",
    agentSecretId,
    repositoryId,
    prompt,
  });

  // Trigger the task
  const handle = await tasks.trigger<typeof interactiveSessionTask>(
    "interactive-session",
    {
      sessionId: interactiveSession.id,
      orgId,
      agentType: agentType ?? "claude",
      agentApiKey,
      repositoryOwner,
      repositoryName,
      defaultBranch,
      githubInstallationId,
      prompt,
    },
    { tags: [`session:${interactiveSession.id}`] },
  );

  return NextResponse.json({
    session: interactiveSession,
    triggerRunId: handle.id,
  });
}
