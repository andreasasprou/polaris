/**
 * Integration test for MCP server CRUD and resolution.
 * Requires DATABASE_URL and ENCRYPTION_KEY env vars.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";

// Set env before importing db
process.env.DATABASE_URL ??=
  "postgresql://polaris:polaris@localhost:5432/polaris";
process.env.ENCRYPTION_KEY ??=
  "ab617a52f2eef2cc4a0e5af325e0fe6792c7467d6e474c1daebf6911a71dae99";

const TEST_ORG_ID = `test-org-mcp-${Date.now()}`;

describe("mcp-servers", async () => {
  const { db } = await import("@/lib/db");
  const { mcpServers } = await import("@/lib/mcp-servers/schema");
  const {
    createMcpServer,
    deleteMcpServer,
    updateMcpServerEnabled,
    updateMcpServerHeaders,
    updateMcpServerAuth,
    refreshMcpServerAuth,
    updateMcpServerTestResult,
    updateMcpServerOAuthMetadata,
    clearMcpServerAuth,
  } = await import("@/lib/mcp-servers/actions");
  const {
    findMcpServersByOrg,
    findMcpServerByIdAndOrg,
    getResolvedMcpServers,
  } = await import("@/lib/mcp-servers/queries");

  beforeAll(async () => {
    await db.execute(sql`
      ALTER TABLE mcp_servers
      ADD COLUMN IF NOT EXISTS catalog_slug text,
      ADD COLUMN IF NOT EXISTS last_test_status text,
      ADD COLUMN IF NOT EXISTS last_test_error text,
      ADD COLUMN IF NOT EXISTS last_tested_at timestamp with time zone,
      ADD COLUMN IF NOT EXISTS last_discovered_tools jsonb
    `);
    await db.execute(sql`
      ALTER TABLE mcp_servers
      DROP CONSTRAINT IF EXISTS mcp_servers_organization_id_name_unique
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_custom_name
      ON mcp_servers (organization_id, name)
      WHERE catalog_slug IS NULL
    `);
    await db.execute(sql`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_servers_catalog_slug
      ON mcp_servers (organization_id, catalog_slug)
      WHERE catalog_slug IS NOT NULL
    `);
  });

  afterAll(async () => {
    // Clean up test data
    await db
      .delete(mcpServers)
      .where(sql`${mcpServers.organizationId} = ${TEST_ORG_ID}`);
  });

  it("creates a static MCP server", async () => {
    const server = await createMcpServer({
      organizationId: TEST_ORG_ID,
      name: "Test Sentry",
      serverUrl: "https://mcp.sentry.dev/sse",
      transport: "sse",
      authType: "static",
      authConfig: { headers: { Authorization: "Bearer test-token-123" } },
      createdBy: "test-user",
    });

    expect(server).toBeDefined();
    expect(server.id).toBeDefined();
    expect(server.name).toBe("Test Sentry");
    expect(server.serverUrl).toBe("https://mcp.sentry.dev/sse");
    expect(server.transport).toBe("sse");
    expect(server.authType).toBe("static");
    expect(server.enabled).toBe(true);
  });

  it("creates an OAuth MCP server", async () => {
    const server = await createMcpServer({
      organizationId: TEST_ORG_ID,
      name: "Test OAuth",
      serverUrl: "https://mcp.oauth-provider.dev/sse",
      authType: "oauth",
      oauthClientId: "my-client-id",
      oauthAuthorizationEndpoint: "https://oauth-provider.dev/authorize",
      oauthTokenEndpoint: "https://oauth-provider.dev/token",
      oauthScopes: "openid profile",
    });

    expect(server).toBeDefined();
    expect(server.authType).toBe("oauth");
    expect(server.oauthClientId).toBe("my-client-id");
    expect(server.oauthAuthorizationEndpoint).toBe(
      "https://oauth-provider.dev/authorize",
    );
  });

  it("rejects duplicate names within the same org", async () => {
    await expect(
      createMcpServer({
        organizationId: TEST_ORG_ID,
        name: "Test Sentry",
        serverUrl: "https://other.example.com",
        authType: "static",
        authConfig: { headers: { Authorization: "Bearer x" } },
      }),
    ).rejects.toThrow();
  });

  it("allows a marketplace install to share a name with a custom server", async () => {
    const server = await createMcpServer({
      organizationId: TEST_ORG_ID,
      name: "Test Sentry",
      serverUrl: "https://mcp.sentry.io/sse",
      authType: "oauth",
      catalogSlug: "sentry",
      oauthClientId: "sentry-client-id",
      oauthAuthorizationEndpoint: "https://sentry.io/oauth/authorize",
      oauthTokenEndpoint: "https://sentry.io/oauth/token",
    });

    expect(server.name).toBe("Test Sentry");
    expect(server.catalogSlug).toBe("sentry");
  });

  it("lists servers for org with connected flag", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);

    expect(servers.length).toBe(3);

    const staticServer = servers.find(
      (s) => s.serverUrl === "https://mcp.sentry.dev/sse",
    );
    expect(staticServer).toBeDefined();
    expect(staticServer!.connected).toBe(true); // has encrypted auth config

    const oauthServer = servers.find((s) => s.name === "Test OAuth");
    expect(oauthServer).toBeDefined();
    expect(oauthServer!.connected).toBe(false); // no auth config yet
  });

  it("finds a single server by id and org", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const first = servers[0];

    const found = await findMcpServerByIdAndOrg(first.id, TEST_ORG_ID);
    expect(found).toBeDefined();
    expect(found!.id).toBe(first.id);

    // Wrong org should return null
    const notFound = await findMcpServerByIdAndOrg(first.id, "wrong-org");
    expect(notFound).toBeNull();
  });

  it("toggles enabled", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const server = servers[0];

    await updateMcpServerEnabled(server.id, TEST_ORG_ID, false);
    const updated = await findMcpServerByIdAndOrg(server.id, TEST_ORG_ID);
    expect(updated!.enabled).toBe(false);

    // Re-enable for subsequent tests
    await updateMcpServerEnabled(server.id, TEST_ORG_ID, true);
  });

  it("updates static headers", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const staticServer = servers.find((s) => s.authType === "static")!;

    await updateMcpServerHeaders(staticServer.id, TEST_ORG_ID, {
      Authorization: "Bearer new-token-456",
      "X-Custom": "value",
    });

    const updated = await findMcpServerByIdAndOrg(
      staticServer.id,
      TEST_ORG_ID,
    );
    expect(updated!.encryptedAuthConfig).toBeTruthy();
    // We can't easily decrypt here without importing decrypt, but the field is non-null
  });

  it("resolves enabled static servers to SDK format", async () => {
    const entries = await getResolvedMcpServers(TEST_ORG_ID);

    // Only the static server should resolve (OAuth has no auth config yet)
    expect(entries.length).toBe(1);
    expect(entries[0].name).toBe("Test Sentry");
    expect(entries[0].url).toBe("https://mcp.sentry.dev/sse");
    expect(entries[0].transport).toBe("sse");
    expect(entries[0].headers).toBeDefined();
    expect(entries[0].headers!["Authorization"]).toBe("Bearer new-token-456");
    expect(entries[0].headers!["X-Custom"]).toBe("value");
  });

  it("skips disabled servers in resolution", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const staticServer = servers.find((s) => s.authType === "static")!;

    await updateMcpServerEnabled(staticServer.id, TEST_ORG_ID, false);
    const entries = await getResolvedMcpServers(TEST_ORG_ID);
    expect(entries.length).toBe(0);

    // Re-enable
    await updateMcpServerEnabled(staticServer.id, TEST_ORG_ID, true);
  });

  it("skips OAuth servers without auth config", async () => {
    // OAuth server has no tokens yet — should be skipped
    const entries = await getResolvedMcpServers(TEST_ORG_ID);
    const oauthEntry = entries.find((e) =>
      e.url.includes("oauth-provider"),
    );
    expect(oauthEntry).toBeUndefined();
  });

  it("resolves OAuth server after auth config is set", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const oauthServer = servers.find((s) => s.name === "Test OAuth")!;

    // Simulate completing OAuth flow
    await updateMcpServerAuth(oauthServer.id, TEST_ORG_ID, {
      accessToken: "eyJ-test-access-token",
      refreshToken: "test-refresh-token",
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    });

    const entries = await getResolvedMcpServers(TEST_ORG_ID);
    expect(entries.length).toBe(2);

    const oauthEntry = entries.find((e) =>
      e.url.includes("oauth-provider"),
    );
    expect(oauthEntry).toBeDefined();
    expect(oauthEntry!.headers!["Authorization"]).toBe(
      "Bearer eyJ-test-access-token",
    );
  });

  it("preserves omitted OAuth metadata fields during partial updates", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const oauthServer = servers.find((s) => s.name === "Test OAuth")!;

    await updateMcpServerOAuthMetadata(oauthServer.id, TEST_ORG_ID, {
      oauthAuthorizationEndpoint: "https://oauth-provider.dev/new-authorize",
    });

    const updated = await findMcpServerByIdAndOrg(
      oauthServer.id,
      TEST_ORG_ID,
    );
    expect(updated!.oauthClientId).toBe("my-client-id");
    expect(updated!.oauthAuthorizationEndpoint).toBe(
      "https://oauth-provider.dev/new-authorize",
    );
    expect(updated!.oauthTokenEndpoint).toBe(
      "https://oauth-provider.dev/token",
    );
    expect(updated!.oauthScopes).toBe("openid profile");
  });

  it("preserves cached tool state during token refresh", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const oauthServer = servers.find((s) => s.name === "Test OAuth")!;

    await updateMcpServerTestResult(oauthServer.id, TEST_ORG_ID, {
      status: "ok",
      tools: [
        {
          name: "search_issues",
          description: "Search issues",
          inputSchema: null,
        },
      ],
    });

    await refreshMcpServerAuth(oauthServer.id, TEST_ORG_ID, {
      accessToken: "eyJ-refreshed-access-token",
      refreshToken: "test-refresh-token-2",
      expiresAt: Math.floor(Date.now() / 1000) + 7200,
    });

    const refreshed = await findMcpServerByIdAndOrg(
      oauthServer.id,
      TEST_ORG_ID,
    );
    expect(refreshed!.lastTestStatus).toBe("ok");
    expect(refreshed!.lastDiscoveredTools).toEqual([
      {
        name: "search_issues",
        description: "Search issues",
        inputSchema: null,
      },
    ]);
  });

  it("clears auth config on clearMcpServerAuth", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const oauthServer = servers.find((s) => s.name === "Test OAuth")!;

    await clearMcpServerAuth(oauthServer.id, TEST_ORG_ID);

    const updated = await findMcpServerByIdAndOrg(
      oauthServer.id,
      TEST_ORG_ID,
    );
    expect(updated!.encryptedAuthConfig).toBeNull();

    // Should no longer resolve
    const entries = await getResolvedMcpServers(TEST_ORG_ID);
    const oauthEntry = entries.find((e) =>
      e.url.includes("oauth-provider"),
    );
    expect(oauthEntry).toBeUndefined();
  });

  it("returns empty array for org with no servers", async () => {
    const entries = await getResolvedMcpServers("nonexistent-org-id");
    expect(entries).toEqual([]);
  });

  it("deletes a server", async () => {
    const servers = await findMcpServersByOrg(TEST_ORG_ID);
    const first = servers[0];

    await deleteMcpServer(first.id, TEST_ORG_ID);

    const remaining = await findMcpServersByOrg(TEST_ORG_ID);
    expect(remaining.length).toBe(servers.length - 1);
  });
});
