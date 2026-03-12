import { NextRequest, NextResponse } from "next/server";
import { tasks } from "@trigger.dev/sdk/v3";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
import { interactiveSessions } from "@/lib/sessions/schema";
import { createInteractiveSession } from "@/lib/sessions/actions";
import { resolveSessionCredentials } from "@/lib/sessions/prompt-dispatch";
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

  // Resolve credentials via shared helper
  let creds;
  try {
    creds = await resolveSessionCredentials({
      agentType: agentType ?? "claude",
      agentSecretId: agentSecretId ?? null,
      repositoryId,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Could not resolve credentials" },
      { status: 400 },
    );
  }

  // Resolve org-level sandbox env vars
  const { getDecryptedEnvVars } = await import("@/lib/sandbox-env/queries");
  const extraEnv = await getDecryptedEnvVars(orgId);

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
      agentApiKey: creds.agentApiKey,
      repositoryOwner: creds.repositoryOwner,
      repositoryName: creds.repositoryName,
      defaultBranch: creds.defaultBranch,
      githubInstallationId: creds.githubInstallationId,
      prompt,
      extraEnv: Object.keys(extraEnv).length > 0 ? extraEnv : undefined,
    },
    { tags: [`session:${interactiveSession.id}`] },
  );

  return NextResponse.json({
    session: interactiveSession,
    triggerRunId: handle.id,
  });
}
