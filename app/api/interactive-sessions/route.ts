import { NextRequest, NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { getSessionWithOrg } from "@/lib/auth/session";
import { interactiveSessions } from "@/lib/sessions/schema";
import { createInteractiveSession } from "@/lib/sessions/actions";
import { resolveSessionCredentials } from "@/lib/sessions/prompt-dispatch";

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
 *
 * v2: Creates the session record. Sandbox provisioning + first prompt dispatch
 * happens when the user sends their first message via the prompt endpoint.
 *
 * TODO(v2-phase3): Implement sandbox creation + first prompt dispatch here
 * or defer to the prompt endpoint.
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

  if (prompt.length > 100_000) {
    return NextResponse.json(
      { error: "Prompt exceeds maximum length of 100,000 characters" },
      { status: 400 },
    );
  }

  if (!repositoryId) {
    return NextResponse.json(
      { error: "repository is required" },
      { status: 400 },
    );
  }

  // Validate credentials exist before creating the session
  try {
    await resolveSessionCredentials({
      organizationId: orgId,
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

  // Create DB record
  const interactiveSession = await createInteractiveSession({
    organizationId: orgId,
    createdBy: session.user.id,
    agentType: agentType ?? "claude",
    agentSecretId,
    repositoryId,
    prompt,
  });

  return NextResponse.json({ session: interactiveSession });
}
