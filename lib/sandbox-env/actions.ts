import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { sandboxEnvVars } from "./schema";
import { encrypt } from "@/lib/credentials/encryption";

export async function upsertEnvVar(input: {
  organizationId: string;
  key: string;
  value: string;
  createdBy: string;
}) {
  const [row] = await db
    .insert(sandboxEnvVars)
    .values({
      organizationId: input.organizationId,
      key: input.key,
      encryptedValue: encrypt(input.value),
      createdBy: input.createdBy,
    })
    .onConflictDoUpdate({
      target: [sandboxEnvVars.organizationId, sandboxEnvVars.key],
      set: {
        encryptedValue: encrypt(input.value),
        updatedAt: new Date(),
      },
    })
    .returning({
      id: sandboxEnvVars.id,
      key: sandboxEnvVars.key,
      createdAt: sandboxEnvVars.createdAt,
      updatedAt: sandboxEnvVars.updatedAt,
    });

  return row;
}

export async function deleteEnvVar(id: string, organizationId: string) {
  await db
    .delete(sandboxEnvVars)
    .where(
      and(
        eq(sandboxEnvVars.id, id),
        eq(sandboxEnvVars.organizationId, organizationId),
      ),
    );
}
