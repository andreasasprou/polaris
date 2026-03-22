import { z } from "zod";
import {
  signState as signHmacState,
  verifyState as verifyHmacState,
} from "@/lib/auth/hmac-state";

export const githubStateSchema = z.object({
  orgId: z.string().nullable(),
  userId: z.string(),
  nonce: z.string(),
  exp: z.number(),
});

export type GitHubStatePayload = z.infer<typeof githubStateSchema>;

export function signState(payload: GitHubStatePayload): string {
  return signHmacState(payload);
}

export function verifyState(state: string): GitHubStatePayload | null {
  return verifyHmacState(state, githubStateSchema);
}
