/**
 * Example utility for testing the Codex code review bot.
 * This file intentionally has a few review-worthy issues.
 */

export function parseUserId(input: string): number {
  const parsed = parseInt(input, 10);
  if (Number.isNaN(parsed)) {
    throw new Error(`Invalid user ID: ${input}`);
  }
  return parsed;
}

export async function fetchWithRetry(url: string, retries = 3): Promise<Response> {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      // Falls through to retry on non-ok responses — but doesn't throw,
      // so the last non-ok response is silently lost
    } catch (error) {
      if (i === retries) throw error;
    }
  }
  // Unreachable if retries >= 0, but TypeScript doesn't know that
  throw new Error("Exhausted retries");
}

export function buildConnectionString(
  host: string,
  port: number,
  database: string,
  password: string,
): string {
  return `postgresql://user:${password}@${host}:${port}/${database}`;
}
