import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbSelectMock,
  decryptMock,
  refreshMcpServerAuthMock,
  clearMcpServerAuthIfStaleMock,
  safeFetchMock,
} = vi.hoisted(() => ({
  dbSelectMock: vi.fn(),
  decryptMock: vi.fn(),
  refreshMcpServerAuthMock: vi.fn(),
  clearMcpServerAuthIfStaleMock: vi.fn(),
  safeFetchMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock("@/lib/credentials/encryption", () => ({
  decrypt: decryptMock,
}));

vi.mock("@/lib/mcp-servers/actions", () => ({
  clearMcpServerAuthIfStale: clearMcpServerAuthIfStaleMock,
  refreshMcpServerAuth: refreshMcpServerAuthMock,
}));

vi.mock("@/lib/mcp-servers/url-validation", () => ({
  safeFetch: safeFetchMock,
}));

vi.mock("@/lib/mcp-servers/catalog", () => ({
  MCP_CATALOG: [],
  getCatalogTemplate: vi.fn(),
}));

const { getResolvedMcpServers } = await import("@/lib/mcp-servers/queries");

describe("getResolvedMcpServers", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    dbSelectMock.mockReturnValue({
      from: () => ({
        where: () => Promise.resolve([
          {
            id: "server-1",
            organizationId: "org-1",
            name: "Sentry",
            serverUrl: "https://mcp.example.com/sse",
            transport: "streamable-http",
            authType: "oauth",
            encryptedAuthConfig: "encrypted-auth",
            oauthClientId: "client-123",
            oauthTokenEndpoint: "https://oauth.example.com/token",
          },
        ]),
      }),
    });

    decryptMock.mockReturnValue(JSON.stringify({
      accessToken: "expired-access-token",
      refreshToken: "refresh-token-123",
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    }));

    safeFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "fresh-access-token",
          refresh_token: "fresh-refresh-token",
          expires_in: 3600,
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
  });

  it("includes the MCP resource when refreshing OAuth tokens", async () => {
    const servers = await getResolvedMcpServers("org-1");

    expect(servers).toEqual([
      {
        name: "Sentry",
        url: "https://mcp.example.com/sse",
        transport: "streamable-http",
        headers: { Authorization: "Bearer fresh-access-token" },
      },
    ]);
    expect(safeFetchMock).toHaveBeenCalledTimes(1);

    const [, init] = safeFetchMock.mock.calls[0];
    expect(init.body.toString()).toContain(
      "resource=https%3A%2F%2Fmcp.example.com%2Fsse",
    );
    expect(refreshMcpServerAuthMock).toHaveBeenCalledWith("server-1", "org-1", {
      accessToken: "fresh-access-token",
      refreshToken: "fresh-refresh-token",
      expiresAt: expect.any(Number),
    });
    expect(clearMcpServerAuthIfStaleMock).not.toHaveBeenCalled();
  });
});
