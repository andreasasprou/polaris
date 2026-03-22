import crypto from "node:crypto";
import { z } from "zod";

export const mcpOAuthStateSchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  serverId: z.string(),
  nonce: z.string(),
  exp: z.number(),
});

export type McpOAuthStatePayload = z.infer<typeof mcpOAuthStateSchema>;

export function signMcpOAuthState(payload: McpOAuthStatePayload): string {
  const stateData = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const hmac = crypto
    .createHmac("sha256", process.env.BETTER_AUTH_SECRET!)
    .update(stateData)
    .digest("base64url");
  return `${stateData}.${hmac}`;
}

export function verifyMcpOAuthState(
  state: string,
): McpOAuthStatePayload | null {
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
    const payload = mcpOAuthStateSchema.parse(raw);

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
