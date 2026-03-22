import crypto from "node:crypto";
import type { z } from "zod";

/**
 * Generic HMAC-SHA256 signed state for OAuth/redirect flows.
 * Used by both GitHub App install and MCP OAuth flows.
 *
 * Format: base64url(json).hmac
 * Includes expiry checking and timing-safe comparison.
 */

export function signState<T>(payload: T): string {
  const stateData = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(stateData)
    .digest("base64url");
  return `${stateData}.${hmac}`;
}

export function verifyState<T extends { exp: number }>(
  state: string,
  schema: z.ZodType<T>,
): T | null {
  try {
    const parts = state.split(".");
    if (parts.length !== 2) return null;

    const [stateData, hmac] = parts;
    const expectedHmac = crypto
      .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(stateData)
      .digest("base64url");

    if (
      !crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))
    ) {
      return null;
    }

    const raw = JSON.parse(Buffer.from(stateData, "base64url").toString());
    const payload = schema.parse(raw);

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
