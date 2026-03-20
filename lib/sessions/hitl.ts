/**
 * HITL (Human-in-the-Loop) via REST
 *
 * Forwards permission replies and question answers to the sandbox proxy.
 * Forwards replies via REST to the sandbox proxy's HITL endpoints.
 */

import { getInteractiveSession } from "./actions";

/**
 * Reply to a permission request via the sandbox proxy.
 */
export async function replyPermission(
  sessionId: string,
  permissionId: string,
  reply: "allow" | "deny",
): Promise<void> {
  const proxyUrl = await getProxyUrl(sessionId);

  const response = await fetch(
    `${proxyUrl}/permissions/${encodeURIComponent(permissionId)}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reply }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Permission reply failed (${response.status}): ${body}`);
  }
}

/**
 * Reply to a question request via the sandbox proxy.
 */
export async function replyQuestion(
  sessionId: string,
  questionId: string,
  answers: Record<string, string>,
): Promise<void> {
  const proxyUrl = await getProxyUrl(sessionId);

  const response = await fetch(
    `${proxyUrl}/questions/${encodeURIComponent(questionId)}/reply`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Question reply failed (${response.status}): ${body}`);
  }
}

/**
 * Resolve the proxy URL for a session.
 */
async function getProxyUrl(sessionId: string): Promise<string> {
  const session = await getInteractiveSession(sessionId);
  if (!session) throw new Error(`Session not found: ${sessionId}`);

  if (!session.sandboxBaseUrl) {
    throw new Error(`Session ${sessionId} has no sandbox URL`);
  }

  // sandboxBaseUrl is already the proxy URL (stored by ensureSandboxReady)
  return session.sandboxBaseUrl;
}
