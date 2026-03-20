/**
 * Credential reference — discriminated union for pointing at either
 * a single secret or a key pool. Used by forms, API routes, and actions
 * as the single source of truth for credential selection.
 */
export type CredentialRef =
  | { type: "secret"; secretId: string }
  | { type: "pool"; poolId: string };

/**
 * Build a CredentialRef from a database row that has both nullable columns.
 * Returns null if neither is set.
 */
export function credentialRefFromRow(row: {
  agentSecretId: string | null;
  keyPoolId: string | null;
}): CredentialRef | null {
  if (row.keyPoolId && row.agentSecretId) {
    throw new Error(
      "Invariant violation: both agentSecretId and keyPoolId are set. " +
      "The DB CHECK constraint should prevent this.",
    );
  }
  if (row.keyPoolId) return { type: "pool", poolId: row.keyPoolId };
  if (row.agentSecretId) return { type: "secret", secretId: row.agentSecretId };
  return null;
}

/**
 * Convert a CredentialRef back to database columns.
 * Always nulls the unused column to satisfy the CHECK constraint.
 */
export function credentialRefToColumns(ref: CredentialRef): {
  agentSecretId: string | null;
  keyPoolId: string | null;
} {
  switch (ref.type) {
    case "secret":
      return { agentSecretId: ref.secretId, keyPoolId: null };
    case "pool":
      return { agentSecretId: null, keyPoolId: ref.poolId };
  }
}
