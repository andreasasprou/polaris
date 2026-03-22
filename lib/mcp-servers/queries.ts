import { eq, and, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { mcpServers } from "./schema";
import { decrypt } from "@/lib/credentials/encryption";
import { updateMcpServerAuth, clearMcpServerAuth, clearMcpServerAuthIfStale } from "./actions";
import type {
  StaticAuthConfig,
  OAuthAuthConfig,
  McpServerEntry,
} from "./types";

/** List all MCP servers for an org (metadata only, no decrypted secrets). */
export async function findMcpServersByOrg(organizationId: string) {
  return db
    .select({
      id: mcpServers.id,
      name: mcpServers.name,
      serverUrl: mcpServers.serverUrl,
      transport: mcpServers.transport,
      authType: mcpServers.authType,
      enabled: mcpServers.enabled,
      oauthClientId: mcpServers.oauthClientId,
      oauthAuthorizationEndpoint: mcpServers.oauthAuthorizationEndpoint,
      oauthTokenEndpoint: mcpServers.oauthTokenEndpoint,
      oauthScopes: mcpServers.oauthScopes,
      createdAt: mcpServers.createdAt,
      updatedAt: mcpServers.updatedAt,
      connected:
        sql<boolean>`${mcpServers.encryptedAuthConfig} IS NOT NULL`.as(
          "connected",
        ),
    })
    .from(mcpServers)
    .where(eq(mcpServers.organizationId, organizationId));
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
        ),
      );

    const results = await Promise.allSettled(
      rows.map((row) => resolveServer(row)),
    );

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

async function resolveServer(
  row: typeof mcpServers.$inferSelect,
): Promise<McpServerEntry | null> {
  if (!row.encryptedAuthConfig) return null;

  try {
    const configStr = decrypt(row.encryptedAuthConfig);
    const config = JSON.parse(configStr);

    if (row.authType === "static") {
      const staticConfig = config as StaticAuthConfig;
      return {
        name: row.name,
        url: row.serverUrl,
        transport: row.transport as McpServerEntry["transport"],
        headers: staticConfig.headers,
      };
    }

    if (row.authType === "oauth") {
      const oauthConfig = config as OAuthAuthConfig;
      let accessToken = oauthConfig.accessToken;

      // Preemptive refresh: if token expires within 5 minutes
      const now = Math.floor(Date.now() / 1000);
      if (oauthConfig.expiresAt < now + 300) {
        if (!oauthConfig.refreshToken || !row.oauthTokenEndpoint) {
          // No refresh token or endpoint — clear auth so UI shows "Not connected"
          await clearMcpServerAuth(row.id, row.organizationId);
          return null;
        }

        // Capture the encrypted blob we read — used for atomic compare-and-clear.
        // If a concurrent dispatch refreshes successfully and writes a new blob,
        // our clear will be a no-op because the WHERE won't match.
        const originalEncryptedBlob = row.encryptedAuthConfig!;

        // Validate token endpoint resolves to a public IP before fetching
        // (prevents SSRF via DNS rebinding on previously-valid domains)
        const { validateServerFetchUrl } = await import("./url-validation");
        const safeUrl = await validateServerFetchUrl(row.oauthTokenEndpoint);
        if (!safeUrl) {
          console.warn(`[mcp-servers] Token endpoint ${row.oauthTokenEndpoint} resolves to private address, skipping server ${row.id}`);
          return null;
        }

        try {
          const refreshRes = await fetch(safeUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: oauthConfig.refreshToken,
              client_id: row.oauthClientId ?? "",
            }),
            signal: AbortSignal.timeout(5_000),
          });

          if (!refreshRes.ok) {
            // Fatal: token revoked or invalid — but only clear if the stored
            // refresh token still matches the stale one we used. A concurrent
            // dispatch may have already refreshed successfully.
            if (refreshRes.status === 401 || refreshRes.status === 400) {
              await clearMcpServerAuthIfStale(row.id, row.organizationId, originalEncryptedBlob);
              return null;
            }
            // Non-fatal: use cached token if not yet expired
            if (oauthConfig.expiresAt > now) {
              return {
                name: row.name,
                url: row.serverUrl,
                transport: row.transport as McpServerEntry["transport"],
                headers: { Authorization: `Bearer ${accessToken}` },
              };
            }
            return null;
          }

          const tokens = await refreshRes.json();
          accessToken = tokens.access_token ?? accessToken;

          await updateMcpServerAuth(row.id, row.organizationId, {
            accessToken,
            refreshToken: tokens.refresh_token ?? oauthConfig.refreshToken,
            expiresAt: tokens.expires_in
              ? now + tokens.expires_in
              : now + 3600,
          });
        } catch {
          // Timeout or network error — use cached token if valid
          if (oauthConfig.expiresAt > now) {
            return {
              name: row.name,
              url: row.serverUrl,
              transport: row.transport as McpServerEntry["transport"],
              headers: { Authorization: `Bearer ${accessToken}` },
            };
          }
          return null;
        }
      }

      return {
        name: row.name,
        url: row.serverUrl,
        transport: row.transport as McpServerEntry["transport"],
        headers: { Authorization: `Bearer ${accessToken}` },
      };
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

