import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  uniqueIndex,
  jsonb,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/**
 * Org-level MCP server configuration.
 * Each row represents a remote MCP server that all sessions in the org can access.
 * Auth credentials are encrypted at rest (AES-256-GCM).
 */
export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: text("organization_id").notNull(),
    name: text("name").notNull(),
    serverUrl: text("server_url").notNull(),
    transport: text("transport").notNull().default("streamable-http"),
    authType: text("auth_type").notNull(), // "static" | "oauth"
    encryptedAuthConfig: text("encrypted_auth_config"), // nullable — null for OAuth before authorization
    enabled: boolean("enabled").notNull().default(true),
    catalogSlug: text("catalog_slug"),
    lastTestStatus: text("last_test_status"), // "ok" | "error" | null
    lastTestError: text("last_test_error"),
    lastTestedAt: timestamp("last_tested_at", { withTimezone: true }),
    lastDiscoveredTools: jsonb("last_discovered_tools")
      .$type<
        Array<{
          name: string;
          description?: string | null;
          inputSchema?: Record<string, unknown> | null;
        }>
      >(),
    // OAuth setup metadata (plaintext — not secrets)
    oauthClientId: text("oauth_client_id"),
    oauthAuthorizationEndpoint: text("oauth_authorization_endpoint"),
    oauthTokenEndpoint: text("oauth_token_endpoint"),
    oauthScopes: text("oauth_scopes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex("idx_mcp_servers_custom_name")
      .on(t.organizationId, t.name)
      .where(sql`${t.catalogSlug} IS NULL`),
    uniqueIndex("idx_mcp_servers_catalog_slug")
      .on(t.organizationId, t.catalogSlug)
      .where(sql`${t.catalogSlug} IS NOT NULL`),
  ],
);
