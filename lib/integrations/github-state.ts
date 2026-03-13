import crypto from "node:crypto";
import { z } from "zod";

/**
 * Signed state payload exchanged between GitHub App install and callback routes.
 * Validated with Zod on both ends so the shape is guaranteed end-to-end.
 */
export const githubStateSchema = z.object({
  orgId: z.string().nullable(),
  userId: z.string(),
  nonce: z.string(),
  exp: z.number(),
});

export type GitHubStatePayload = z.infer<typeof githubStateSchema>;

export function signState(payload: GitHubStatePayload): string {
  const stateData = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(stateData)
    .digest("base64url");
  return `${stateData}.${hmac}`;
}

export function verifyState(state: string): GitHubStatePayload | null {
  try {
    const parts = state.split(".");
    if (parts.length !== 2) return null;

    const [stateData, hmac] = parts;
    const expectedHmac = crypto
      .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
      .update(stateData)
      .digest("base64url");

    if (!crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(expectedHmac))) {
      return null;
    }

    const raw = JSON.parse(Buffer.from(stateData, "base64url").toString());
    const payload = githubStateSchema.parse(raw);

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
