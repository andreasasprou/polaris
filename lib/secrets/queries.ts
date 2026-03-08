import { eq, and, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { secrets } from "./schema";
import { decrypt } from "@/lib/credentials/encryption";

export async function findSecretsByOrg(organizationId: string) {
  return db
    .select({
      id: secrets.id,
      provider: secrets.provider,
      label: secrets.label,
      createdBy: secrets.createdBy,
      lastUsedAt: secrets.lastUsedAt,
      revokedAt: secrets.revokedAt,
      createdAt: secrets.createdAt,
    })
    .from(secrets)
    .where(
      and(
        eq(secrets.organizationId, organizationId),
        isNull(secrets.revokedAt),
      ),
    );
}

export async function findSecretById(id: string) {
  const [row] = await db
    .select()
    .from(secrets)
    .where(eq(secrets.id, id))
    .limit(1);
  return row ?? null;
}

export async function getDecryptedSecret(id: string): Promise<string | null> {
  const secret = await findSecretById(id);
  if (!secret || secret.revokedAt) return null;
  return decrypt(secret.encryptedValue);
}
