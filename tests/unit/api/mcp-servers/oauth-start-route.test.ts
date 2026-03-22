import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getSessionWithOrgAdminMock,
  updateMcpServerOAuthMetadataMock,
  discoverOAuthConfigMock,
  findMcpServerByIdAndOrgMock,
  signMcpOAuthStateMock,
} = vi.hoisted(() => ({
  getSessionWithOrgAdminMock: vi.fn(),
  updateMcpServerOAuthMetadataMock: vi.fn(),
  discoverOAuthConfigMock: vi.fn(),
  findMcpServerByIdAndOrgMock: vi.fn(),
  signMcpOAuthStateMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getSessionWithOrgAdmin: getSessionWithOrgAdminMock,
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

    getSessionWithOrgAdminMock.mockResolvedValue({
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
      tokenEndpoint: "https://oauth.example.com/token",
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1",
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
        "https://polaris.example.com/api/mcp-servers/oauth/start?serverId=server-1",
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
});
