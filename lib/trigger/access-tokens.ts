"use server";

/**
 * v2: Trigger.dev access tokens are no longer needed.
 * The sandbox proxy uses HMAC-signed callbacks instead.
 * These stubs exist to prevent import errors until Phase 3 cleanup.
 */

export async function createSessionAccessToken(
  _sessionId: string,
): Promise<string> {
  throw new Error(
    "Trigger.dev access tokens are removed in v2. Use job-based API.",
  );
}

export async function createRunAccessToken(
  _triggerRunId: string,
): Promise<string> {
  throw new Error(
    "Trigger.dev access tokens are removed in v2. Use job-based API.",
  );
}
