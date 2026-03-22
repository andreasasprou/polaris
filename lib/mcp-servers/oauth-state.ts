import { z } from "zod";
import { signState, verifyState } from "@/lib/auth/hmac-state";

export const mcpOAuthStateSchema = z.object({
  orgId: z.string(),
  userId: z.string(),
  serverId: z.string(),
  nonce: z.string(),
  exp: z.number(),
});

export type McpOAuthStatePayload = z.infer<typeof mcpOAuthStateSchema>;

export const signMcpOAuthState = signState<McpOAuthStatePayload>;

export function verifyMcpOAuthState(
  state: string,
): McpOAuthStatePayload | null {
  return verifyState(state, mcpOAuthStateSchema);
}
