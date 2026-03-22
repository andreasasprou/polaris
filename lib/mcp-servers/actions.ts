import { eq, and } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers } from "./schema";
import { encrypt } from "@/lib/credentials/encryption";
import type { AuthConfig, McpDiscoveredTool, McpTestStatus } from "./types";

export async function createMcpServer(input: {
  organizationId: string;
  name: string;
  serverUrl: string;
  transport?: string;
  authType: string;
  authConfig?: AuthConfig;
  catalogSlug?: string | null;
  oauthClientId?: string | null;
  oauthAuthorizationEndpoint?: string | null;
  oauthTokenEndpoint?: string | null;
  oauthScopes?: string | null;
  createdBy?: string;
}) {
  const [row] = await db
    .insert(mcpServers)
    .values({
      organizationId: input.organizationId,
      name: input.name,
      serverUrl: input.serverUrl,
      transport: input.transport ?? "streamable-http",
      authType: input.authType,
      encryptedAuthConfig: input.authConfig
        ? encrypt(JSON.stringify(input.authConfig))
        : null,
      catalogSlug: input.catalogSlug ?? null,
      oauthClientId: input.oauthClientId ?? null,
      oauthAuthorizationEndpoint: input.oauthAuthorizationEndpoint ?? null,
      oauthTokenEndpoint: input.oauthTokenEndpoint ?? null,
      oauthScopes: input.oauthScopes ?? null,
      createdBy: input.createdBy,
    })
    .returning({
      id: mcpServers.id,
      name: mcpServers.name,
      serverUrl: mcpServers.serverUrl,
      transport: mcpServers.transport,
      authType: mcpServers.authType,
      enabled: mcpServers.enabled,
      catalogSlug: mcpServers.catalogSlug,
      oauthClientId: mcpServers.oauthClientId,
      oauthAuthorizationEndpoint: mcpServers.oauthAuthorizationEndpoint,
      oauthTokenEndpoint: mcpServers.oauthTokenEndpoint,
      oauthScopes: mcpServers.oauthScopes,
      lastTestStatus: mcpServers.lastTestStatus,
      lastTestError: mcpServers.lastTestError,
      lastTestedAt: mcpServers.lastTestedAt,
      lastDiscoveredTools: mcpServers.lastDiscoveredTools,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
    });

  return row;
}

export async function updateMcpServerAuth(
  id: string,
  organizationId: string,
  authConfig: AuthConfig,
) {
  await db
    .update(mcpServers)
    .set({
      encryptedAuthConfig: encrypt(JSON.stringify(authConfig)),
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      lastDiscoveredTools: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

export async function clearMcpServerAuth(
  id: string,
  organizationId: string,
) {
  await db
    .update(mcpServers)
    .set({
      encryptedAuthConfig: null,
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      lastDiscoveredTools: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

/**
 * Atomically clear auth config only if the stored blob still matches
 * the expected value. Prevents a concurrent refresh that stored fresh
 * credentials from being wiped by a stale refresh failure.
 */
export async function clearMcpServerAuthIfStale(
  id: string,
  organizationId: string,
  expectedEncryptedBlob: string,
) {
  await db
    .update(mcpServers)
    .set({
      encryptedAuthConfig: null,
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      lastDiscoveredTools: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(mcpServers.id, id),
        eq(mcpServers.organizationId, organizationId),
        eq(mcpServers.encryptedAuthConfig, expectedEncryptedBlob),
      ),
    );
}

export async function deleteMcpServer(id: string, organizationId: string) {
  await db
    .delete(mcpServers)
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

export async function updateMcpServerEnabled(
  id: string,
  organizationId: string,
  enabled: boolean,
) {
  await db
    .update(mcpServers)
    .set({ enabled, updatedAt: new Date() })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

export async function updateMcpServerHeaders(
  id: string,
  organizationId: string,
  headers: Record<string, string>,
) {
  await db
    .update(mcpServers)
    .set({
      encryptedAuthConfig: encrypt(JSON.stringify({ headers })),
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      lastDiscoveredTools: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

export async function updateMcpServerOAuthMetadata(
  id: string,
  organizationId: string,
  metadata: {
    oauthClientId?: string | null;
    oauthAuthorizationEndpoint?: string | null;
    oauthTokenEndpoint?: string | null;
    oauthScopes?: string | null;
  },
) {
  await db
    .update(mcpServers)
    .set({
      oauthClientId: metadata.oauthClientId ?? null,
      oauthAuthorizationEndpoint: metadata.oauthAuthorizationEndpoint ?? null,
      oauthTokenEndpoint: metadata.oauthTokenEndpoint ?? null,
      oauthScopes: metadata.oauthScopes ?? null,
      lastTestStatus: null,
      lastTestError: null,
      lastTestedAt: null,
      lastDiscoveredTools: null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}

export async function updateMcpServerTestResult(
  id: string,
  organizationId: string,
  input: {
    status: McpTestStatus;
    error?: string | null;
    tools?: McpDiscoveredTool[] | null;
  },
) {
  await db
    .update(mcpServers)
    .set({
      lastTestStatus: input.status,
      lastTestError: input.error ?? null,
      lastTestedAt: new Date(),
      lastDiscoveredTools: input.tools ?? null,
      updatedAt: new Date(),
    })
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
}
