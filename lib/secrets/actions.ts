import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { secrets } from "./schema";
import { encrypt } from "@/lib/credentials/encryption";
import { validateSecretValue } from "./validation";
import { findSecretByIdAndOrg } from "./queries";

export async function createSecret(input: {
  organizationId: string;
  provider: string;
  label: string;
  value: string;
  createdBy: string;
}) {
  const result = validateSecretValue({
    provider: input.provider,
    value: input.value,
  });
  if (!result.valid) {
    throw new Error(result.error);
  }

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

export async function updateSecret(input: {
  id: string;
  organizationId: string;
  value: string;
}) {
  const secret = await findSecretByIdAndOrg(input.id, input.organizationId);
  if (!secret) {
    throw new Error("Secret not found");
  }
  if (secret.revokedAt) {
    throw new Error("Cannot update a revoked secret");
  }

  const result = validateSecretValue({
    provider: secret.provider,
    value: input.value,
  });
  if (!result.valid) {
    throw new Error(result.error);
  }

  const [row] = await db
    .update(secrets)
    .set({ encryptedValue: encrypt(input.value) })
    .where(
      and(
        eq(secrets.id, input.id),
        eq(secrets.organizationId, input.organizationId),
      ),
    )
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
