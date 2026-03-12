import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { sandboxEnvVars } from "./schema";
import { decrypt } from "@/lib/credentials/encryption";

/** List all env vars for an org (metadata only, no decrypted values). */
export async function findEnvVarsByOrg(organizationId: string) {
  return db
    .select({
      id: sandboxEnvVars.id,
      key: sandboxEnvVars.key,
      createdBy: sandboxEnvVars.createdBy,
      createdAt: sandboxEnvVars.createdAt,
      updatedAt: sandboxEnvVars.updatedAt,
    })
    .from(sandboxEnvVars)
    .where(eq(sandboxEnvVars.organizationId, organizationId));
}

/**
 * Decrypt all env vars for an org into a plain key/value map.
 * Used at session creation and resume to inject into sandbox.
 */
export async function getDecryptedEnvVars(
  organizationId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({
      key: sandboxEnvVars.key,
      encryptedValue: sandboxEnvVars.encryptedValue,
    })
    .from(sandboxEnvVars)
    .where(eq(sandboxEnvVars.organizationId, organizationId));

  const env: Record<string, string> = {};
  for (const row of rows) {
    env[row.key] = decrypt(row.encryptedValue);
  }
  return env;
}
