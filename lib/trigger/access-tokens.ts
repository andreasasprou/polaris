"use server";

import { auth } from "@trigger.dev/sdk/v3";
import { getSessionWithOrg } from "@/lib/auth/session";
import { getInteractiveSession } from "@/lib/sessions/actions";

/**
 * Create a scoped public token for an interactive session.
 * Grants read access to the run + write access to the input stream.
 */
export async function createSessionAccessToken(
  sessionId: string,
): Promise<string> {
  const { orgId } = await getSessionWithOrg();
  const session = await getInteractiveSession(sessionId);

  if (!session || session.organizationId !== orgId || !session.triggerRunId) {
    throw new Error("Session not found");
  }

  return auth.createPublicToken({
    scopes: {
      read: { runs: [session.triggerRunId] },
      write: { inputStreams: [session.triggerRunId] },
    },
    expirationTime: "2h",
  });
}

/**
 * Create a read-only public token for viewing an automation run.
 */
export async function createRunAccessToken(
  triggerRunId: string,
): Promise<string> {
  const { orgId } = await getSessionWithOrg();

  return auth.createPublicToken({
    scopes: { read: { runs: [triggerRunId] } },
    expirationTime: "2h",
  });
}
