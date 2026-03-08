import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { secrets } from "./schema";
import { encrypt } from "@/lib/credentials/encryption";

export async function createSecret(input: {
  organizationId: string;
  provider: string;
  label: string;
  value: string;
  createdBy: string;
}) {
  const [row] = await db
    .insert(secrets)
    .values({
      organizationId: input.organizationId,
      provider: input.provider,
      label: input.label,
      encryptedValue: encrypt(input.value),
      createdBy: input.createdBy,
    })
    .returning({
      id: secrets.id,
      provider: secrets.provider,
      label: secrets.label,
      createdAt: secrets.createdAt,
    });

  return row;
}

export async function revokeSecret(id: string) {
  await db
    .update(secrets)
    .set({ revokedAt: new Date() })
    .where(eq(secrets.id, id));
}
