import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organization } from "@/lib/db/auth-schema";

export type SandboxRawLogDebugSettings = {
  enabled: boolean;
  expiresAt: string | null;
  reason: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
};

export type OrganizationObservabilitySettings = {
  sandboxRawLogs: SandboxRawLogDebugSettings;
};

export const DEFAULT_ORG_OBSERVABILITY_SETTINGS: OrganizationObservabilitySettings = {
  sandboxRawLogs: {
    enabled: false,
    expiresAt: null,
    reason: null,
    updatedAt: null,
    updatedBy: null,
  },
};

function parseMetadata(
  metadata: string | Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as Record<string, unknown>;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }
  return metadata;
}

export function normalizeOrgObservabilitySettings(
  metadata: string | Record<string, unknown> | null | undefined,
): OrganizationObservabilitySettings {
  const root = parseMetadata(metadata);
  const raw = (
    (root.observability as Record<string, unknown> | undefined)?.sandboxRawLogs as
      | Record<string, unknown>
      | undefined
  ) ?? {};

  const normalized: SandboxRawLogDebugSettings = {
    enabled: raw?.enabled === true,
    expiresAt: typeof raw?.expiresAt === "string" ? raw.expiresAt : null,
    reason: typeof raw?.reason === "string" && raw.reason.trim().length > 0
      ? raw.reason.trim()
      : null,
    updatedAt: typeof raw?.updatedAt === "string" ? raw.updatedAt : null,
    updatedBy: typeof raw?.updatedBy === "string" ? raw.updatedBy : null,
  };

  return { sandboxRawLogs: normalized };
}

export function isSandboxRawLogDebugEnabled(
  settings: OrganizationObservabilitySettings,
  now: Date = new Date(),
): boolean {
  if (!settings.sandboxRawLogs.enabled) return false;
  const expiresAt = settings.sandboxRawLogs.expiresAt;
  if (!expiresAt) return false;
  const expiresMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresMs)) return false;
  return expiresMs > now.getTime();
}

export async function getOrgObservabilitySettings(
  organizationId: string,
): Promise<OrganizationObservabilitySettings> {
  const [row] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, organizationId))
    .limit(1);

  return normalizeOrgObservabilitySettings(row?.metadata);
}

export async function updateOrgObservabilitySettings(input: {
  organizationId: string;
  enabled: boolean;
  expiresAt: string | null;
  reason?: string | null;
  updatedBy: string;
}): Promise<OrganizationObservabilitySettings> {
  const [row] = await db
    .select({ metadata: organization.metadata })
    .from(organization)
    .where(eq(organization.id, input.organizationId))
    .limit(1);

  const root = parseMetadata(row?.metadata);
  const observability =
    (root.observability as Record<string, unknown> | undefined) ?? {};

  observability.sandboxRawLogs = {
    enabled: input.enabled,
    expiresAt: input.enabled ? input.expiresAt : null,
    reason: input.enabled ? input.reason?.trim() || null : null,
    updatedAt: new Date().toISOString(),
    updatedBy: input.updatedBy,
  } satisfies SandboxRawLogDebugSettings;

  const nextMetadata = JSON.stringify({
    ...root,
    observability,
  });

  await db
    .update(organization)
    .set({ metadata: nextMetadata })
    .where(eq(organization.id, input.organizationId));

  return normalizeOrgObservabilitySettings(nextMetadata);
}
