import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSessionWithOrgAdminBySlugMock,
  updateMcpServerOAuthMetadataMock,
  discoverOAuthConfigMock,
  findMcpServerByIdAndOrgMock,
  signMcpOAuthStateMock,
} = vi.hoisted(() => ({
  getSessionWithOrgAdminBySlugMock: vi.fn(),
  updateMcpServerOAuthMetadataMock: vi.fn(),
  discoverOAuthConfigMock: vi.fn(),
  findMcpServerByIdAndOrgMock: vi.fn(),
  signMcpOAuthStateMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionWithOrgAdminBySlug: getSessionWithOrgAdminBySlugMock,
}));

vi.mock("@/lib/mcp-servers/actions", () => ({
  updateMcpServerOAuthMetadata: updateMcpServerOAuthMetadataMock,
}));

vi.mock("@/lib/mcp-servers/discovery", () => ({
  discoverOAuthConfig: discoverOAuthConfigMock,
}));

vi.mock("@/lib/mcp-servers/queries", () => ({
  findMcpServerByIdAndOrg: findMcpServerByIdAndOrgMock,
}));

vi.mock("@/lib/mcp-servers/oauth-state", () => ({
  signMcpOAuthState: signMcpOAuthStateMock,
}));

vi.mock("@/lib/config/urls", () => ({
  getAppBaseUrl: () => "https://polaris.example.com",
}));

vi.mock("@/lib/evlog", () => ({
  withEvlog: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result,
  ) => handler,
}));

const { GET } = await import("@/app/api/mcp-servers/oauth/start/route");

describe("GET /api/mcp-servers/oauth/start", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getSessionWithOrgAdminBySlugMock.mockResolvedValue({
      orgId: "org-1",
      session: {
        user: { id: "user-1" },
      },
    });
  });

  it("rejects invalid auto-discovered metadata before persisting it", async () => {
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      serverUrl: "https://mcp.example.com/sse",
      authType: "oauth",
      oauthClientId: "client-123",
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
      oauthScopes: null,
    });
    discoverOAuthConfigMock.mockResolvedValue({
      authorizationEndpoint: "http://127.0.0.1/authorize",
      tokenEndpoint: "https://example.com/token",
      codeChallengeMethodsSupported: ["S256"],
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1&orgSlug=acme",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "oauthAuthorizationEndpoint must be a valid HTTPS URL (private/internal hosts blocked)",
    });
    expect(updateMcpServerOAuthMetadataMock).not.toHaveBeenCalled();
    expect(signMcpOAuthStateMock).not.toHaveBeenCalled();
  });

  it("rejects stale invalid stored OAuth endpoints before redirecting", async () => {
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      serverUrl: "https://mcp.example.com/sse",
      authType: "oauth",
      oauthClientId: "client-123",
      oauthAuthorizationEndpoint: "http://127.0.0.1/authorize",
      oauthTokenEndpoint: "https://oauth.example.com/token",
      oauthScopes: null,
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1&orgSlug=acme",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error:
        "oauthAuthorizationEndpoint must be a valid HTTPS URL (private/internal hosts blocked)",
    });
    expect(discoverOAuthConfigMock).not.toHaveBeenCalled();
    expect(signMcpOAuthStateMock).not.toHaveBeenCalled();
  });

  it("requires discovered OAuth metadata to advertise S256 PKCE support", async () => {
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      serverUrl: "https://mcp.example.com/sse",
      authType: "oauth",
      oauthClientId: "client-123",
      oauthAuthorizationEndpoint: null,
      oauthTokenEndpoint: null,
      oauthScopes: null,
    });
    discoverOAuthConfigMock.mockResolvedValue({
      authorizationEndpoint: "https://oauth.example.com/authorize",
      tokenEndpoint: "https://oauth.example.com/token",
      codeChallengeMethodsSupported: undefined,
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1&orgSlug=acme",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "OAuth provider does not support S256 PKCE",
    });
    expect(updateMcpServerOAuthMetadataMock).not.toHaveBeenCalled();
    expect(signMcpOAuthStateMock).not.toHaveBeenCalled();
  });

  it("reuses concurrently cached OAuth metadata instead of persisting again", async () => {
    findMcpServerByIdAndOrgMock
      .mockResolvedValueOnce({
        id: "server-1",
        serverUrl: "https://mcp.example.com/sse",
        authType: "oauth",
        oauthClientId: "client-123",
        oauthAuthorizationEndpoint: null,
        oauthTokenEndpoint: null,
        oauthScopes: "scope-a",
      })
      .mockResolvedValueOnce({
        id: "server-1",
        serverUrl: "https://mcp.example.com/sse",
        authType: "oauth",
        oauthClientId: "client-123",
        oauthAuthorizationEndpoint: "https://example.com/authorize",
        oauthTokenEndpoint: "https://example.com/token",
        oauthScopes: "scope-a",
      });
    discoverOAuthConfigMock.mockResolvedValue({
      authorizationEndpoint: "https://example.com/authorize",
      tokenEndpoint: "https://example.com/token",
      codeChallengeMethodsSupported: ["S256"],
    });
    signMcpOAuthStateMock.mockReturnValue("signed-state");

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1&orgSlug=acme",
      ),
    );

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://example.com/authorize",
    );
    expect(updateMcpServerOAuthMetadataMock).not.toHaveBeenCalled();
  });

  it("requires an explicit orgSlug", async () => {
    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1",
      ),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "orgSlug required",
    });
    expect(getSessionWithOrgAdminBySlugMock).not.toHaveBeenCalled();
  });
});
