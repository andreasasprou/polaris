import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  unique,
} from "drizzle-orm/pg-core";

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
  (t) => [unique().on(t.organizationId, t.name)],
);
