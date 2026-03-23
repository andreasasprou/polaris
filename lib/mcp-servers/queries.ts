import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { decrypt } from "@/lib/credentials/encryption";
import {
  getCatalogTemplate,
  getCatalogTemplateAvailability,
  MCP_CATALOG,
} from "./catalog";
import {
  clearMcpServerAuthIfStale,
  refreshMcpServerAuth,
} from "./actions";
import { mcpServers } from "./schema";
import { createMcpOAuthTokenParams } from "./oauth-resource";
import type {
  CatalogInstallationView,
  McpDiscoveredTool,
  McpInstallStatus,
  McpServerEntry,
  McpServerListItem,
  OAuthAuthConfig,
  StaticAuthConfig,
} from "./types";

type McpRow = typeof mcpServers.$inferSelect;
type McpServerListRow = {
  id: string;
  name: string;
  serverUrl: string;
  transport: string;
  authType: string;
  enabled: boolean;
  catalogSlug: string | null;
  oauthClientId: string | null;
  oauthAuthorizationEndpoint: string | null;
  oauthTokenEndpoint: string | null;
  oauthScopes: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastTestStatus: string | null;
  lastTestError: string | null;
  lastTestedAt: Date | null;
  lastDiscoveredTools: McpDiscoveredTool[] | null;
  connected: boolean;
};

function deriveServerStatus(row: {
  authType: string;
  connected: boolean;
  lastTestStatus: string | null;
}): McpServerListItem["status"] {
  if (!row.connected) {
    return row.authType === "oauth" ? "needs_auth" : "misconfigured";
  }
  if (row.lastTestStatus === "error") {
    return "misconfigured";
  }
  return "connected";
}

function normalizeDiscoveredTools(
  tools: McpDiscoveredTool[] | null | undefined,
): McpDiscoveredTool[] | null {
  return tools?.length ? tools : null;
}

function toServerListItem(row: McpServerListRow): McpServerListItem {
  return {
    id: row.id,
    name: row.name,
    serverUrl: row.serverUrl,
    transport: row.transport,
    authType: row.authType,
    enabled: row.enabled,
    catalogSlug: row.catalogSlug,
    oauthClientId: row.oauthClientId,
    oauthAuthorizationEndpoint: row.oauthAuthorizationEndpoint,
    oauthTokenEndpoint: row.oauthTokenEndpoint,
    oauthScopes: row.oauthScopes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastTestStatus:
      row.lastTestStatus === "ok" || row.lastTestStatus === "error"
        ? row.lastTestStatus
        : null,
    lastTestError: row.lastTestError,
    lastTestedAt: row.lastTestedAt,
    lastDiscoveredTools: normalizeDiscoveredTools(row.lastDiscoveredTools),
    connected: row.connected,
    status: deriveServerStatus(row),
  };
}

/** List all MCP servers for an org (metadata only, no decrypted secrets). */
export async function findMcpServersByOrg(
  organizationId: string,
): Promise<McpServerListItem[]> {
  const rows = await db
    .select({
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
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
      lastTestStatus: mcpServers.lastTestStatus,
      lastTestError: mcpServers.lastTestError,
      lastTestedAt: mcpServers.lastTestedAt,
      lastDiscoveredTools: mcpServers.lastDiscoveredTools,
      connected:
        sql<boolean>`${mcpServers.encryptedAuthConfig} IS NOT NULL`.as(
          "connected",
        ),
    })
    .from(mcpServers)
    .where(eq(mcpServers.organizationId, organizationId));

  return rows.map((row) => toServerListItem(row));
}

export async function findCustomMcpServersByOrg(
  organizationId: string,
): Promise<McpServerListItem[]> {
  const rows = await findMcpServersByOrg(organizationId);
  return rows.filter((row) => row.catalogSlug == null);
}

export async function findCatalogInstallationsByOrg(
  organizationId: string,
): Promise<CatalogInstallationView[]> {
  const rows = await findMcpServersByOrg(organizationId);
  const bySlug = new Map(
    rows
      .filter((row) => row.catalogSlug)
      .map((row) => [row.catalogSlug as string, row]),
  );

  return MCP_CATALOG.map((template) => {
    const server = bySlug.get(template.slug) ?? null;
    const status: McpInstallStatus = server ? server.status : "not_installed";
    const availability = getCatalogTemplateAvailability(template);
    return {
      template,
      available: availability.available,
      unavailableReason: availability.unavailableReason,
      server,
      status,
      toolCount: server?.lastDiscoveredTools?.length ?? 0,
      lastTestedAt: server?.lastTestedAt ?? null,
      lastTestError: server?.lastTestError ?? null,
      discoveredTools: server?.lastDiscoveredTools ?? null,
    };
  });
}

export async function findCatalogInstallationBySlugAndOrg(
  slug: string,
  organizationId: string,
): Promise<CatalogInstallationView | null> {
  const template = getCatalogTemplate(slug);
  if (!template) return null;

  const installations = await findCatalogInstallationsByOrg(organizationId);
  return installations.find((entry) => entry.template.slug === slug) ?? null;
}

/** Load a single MCP server with all columns (including encrypted auth). */
export async function findMcpServerByIdAndOrg(
  id: string,
  organizationId: string,
) {
  const [row] = await db
    .select()
    .from(mcpServers)
    .where(
      and(eq(mcpServers.id, id), eq(mcpServers.organizationId, organizationId)),
    );
  return row ?? null;
}

export async function getResolvedMcpServerByIdAndOrg(
  id: string,
  organizationId: string,
): Promise<McpServerEntry | null> {
  const row = await findMcpServerByIdAndOrg(id, organizationId);
  if (!row) return null;
  return resolveServer(row);
}

/**
 * Resolve all enabled MCP servers for an org into SDK-ready format.
 * Fail-open: individual server failures are logged and skipped.
 * This function must never throw — it returns [] on unexpected errors.
 */
export async function getResolvedMcpServers(
  organizationId: string,
): Promise<McpServerEntry[]> {
  try {
    const rows = await db
      .select()
      .from(mcpServers)
      .where(
        and(
          eq(mcpServers.organizationId, organizationId),
          eq(mcpServers.enabled, true),
          isNotNull(mcpServers.encryptedAuthConfig),
        ),
      );

    const results = await Promise.allSettled(rows.map((row) => resolveServer(row)));

    const entries: McpServerEntry[] = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        entries.push(result.value);
      }
    }
    return entries;
  } catch (err) {
    console.error("[mcp-servers] Failed to resolve MCP servers:", err);
    return [];
  }
}

function buildEntry(
  row: McpRow,
  headers: Record<string, string>,
): McpServerEntry {
  return {
    name: row.name,
    url: row.serverUrl,
    transport: row.transport as McpServerEntry["transport"],
    headers,
  };
}

async function resolveServer(row: McpRow): Promise<McpServerEntry | null> {
  if (!row.encryptedAuthConfig) return null;

  try {
    const configStr = decrypt(row.encryptedAuthConfig);
    const config = JSON.parse(configStr);

    if (row.authType === "static") {
      return buildEntry(row, (config as StaticAuthConfig).headers);
    }

    if (row.authType === "oauth") {
      const oauthConfig = config as OAuthAuthConfig;
      let accessToken = oauthConfig.accessToken;
      const now = Math.floor(Date.now() / 1000);

      if (oauthConfig.expiresAt < now + 300) {
        const originalEncryptedBlob = row.encryptedAuthConfig;

        if (!oauthConfig.refreshToken || !row.oauthTokenEndpoint) {
          await clearMcpServerAuthIfStale(
            row.id,
            row.organizationId,
            originalEncryptedBlob,
          );
          return null;
        }

        try {
          const { safeFetch } = await import("./url-validation");
          const refreshRes = await safeFetch(row.oauthTokenEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: createMcpOAuthTokenParams(row.serverUrl, {
              grant_type: "refresh_token",
              refresh_token: oauthConfig.refreshToken,
              client_id: row.oauthClientId ?? "",
            }),
            signal: AbortSignal.timeout(5_000),
          });

          if (!refreshRes.ok) {
            if (refreshRes.status === 401 || refreshRes.status === 400) {
              await clearMcpServerAuthIfStale(
                row.id,
                row.organizationId,
                originalEncryptedBlob,
              );
              return null;
            }
            return oauthConfig.expiresAt > now
              ? buildEntry(row, { Authorization: `Bearer ${accessToken}` })
              : null;
          }

          const tokens = await refreshRes.json();
          accessToken = tokens.access_token ?? accessToken;

          await refreshMcpServerAuth(row.id, row.organizationId, {
            accessToken,
            refreshToken: tokens.refresh_token ?? oauthConfig.refreshToken,
            expiresAt: tokens.expires_in ? now + tokens.expires_in : now + 3600,
          });
        } catch {
          return oauthConfig.expiresAt > now
            ? buildEntry(row, { Authorization: `Bearer ${accessToken}` })
            : null;
        }
      }

      return buildEntry(row, { Authorization: `Bearer ${accessToken}` });
    }

    return null;
  } catch (err) {
    console.warn(
      `[mcp-servers] Failed to resolve server ${row.id} (${row.name}):`,
      err,
    );
    return null;
  }
}
