import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  headersMock,
  getSessionMock,
  hasOrganizationMembershipMock,
  getOrgSlugByIdMock,
  updateMcpServerAuthMock,
  verifyMcpOAuthStateMock,
  findMcpServerByIdAndOrgMock,
  dbSelectMock,
} = vi.hoisted(() => ({
  headersMock: vi.fn(),
  getSessionMock: vi.fn(),
  hasOrganizationMembershipMock: vi.fn(),
  getOrgSlugByIdMock: vi.fn(),
  updateMcpServerAuthMock: vi.fn(),
  verifyMcpOAuthStateMock: vi.fn(),
  findMcpServerByIdAndOrgMock: vi.fn(),
  dbSelectMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  headers: headersMock,
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: getSessionMock,
    },
  },
}));

vi.mock("@/lib/auth/session", () => ({
  hasOrganizationMembership: hasOrganizationMembershipMock,
  getOrgSlugById: getOrgSlugByIdMock,
}));

vi.mock("@/lib/mcp-servers/actions", () => ({
  updateMcpServerAuth: updateMcpServerAuthMock,
}));

vi.mock("@/lib/mcp-servers/oauth-state", () => ({
  verifyMcpOAuthState: verifyMcpOAuthStateMock,
}));

vi.mock("@/lib/mcp-servers/queries", () => ({
  findMcpServerByIdAndOrg: findMcpServerByIdAndOrgMock,
}));

vi.mock("@/lib/mcp-servers/url-validation", () => ({
  safeFetch: vi.fn(),
}));

vi.mock("@/lib/config/urls", () => ({
  getAppBaseUrl: () => "https://polaris.example.com",
  orgPath: (orgSlug: string, path: string) => `/${orgSlug}${path}`,
}));

vi.mock("@/lib/db", () => ({
  db: {
    select: dbSelectMock,
  },
}));

vi.mock("@/lib/db/auth-schema", () => ({
  member: {
    role: "role",
    userId: "user_id",
    organizationId: "organization_id",
  },
}));

vi.mock("@/lib/evlog", () => ({
  withEvlog: <Args extends unknown[], Result>(
    handler: (...args: Args) => Result,
  ) => handler,
}));

const { GET } = await import("@/app/api/mcp-servers/oauth/callback/route");

describe("GET /api/mcp-servers/oauth/callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    headersMock.mockResolvedValue(new Headers());
    getSessionMock.mockResolvedValue({
      user: { id: "user-1" },
      session: { activeOrganizationId: "org-2" },
    });
    getOrgSlugByIdMock.mockResolvedValue("acme");
    hasOrganizationMembershipMock.mockResolvedValue(true);
    dbSelectMock.mockReturnValue({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ role: "owner" }]),
        }),
      }),
    });
  });

  it("redirects provider errors back to the originating catalog page when state is trusted", async () => {
    verifyMcpOAuthStateMock.mockReturnValue({
      orgId: "org-1",
      userId: "user-1",
      serverId: "server-1",
      nonce: "nonce-1",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      catalogSlug: "sentry",
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/callback?error=access_denied&state=signed-state",
      ),
    );

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://polaris.example.com/acme/integrations/mcp/sentry?error=Access+was+denied+by+the+provider",
    );
    expect(updateMcpServerAuthMock).not.toHaveBeenCalled();
  });

  it("uses the signed state org even when the active org changed before callback", async () => {
    getOrgSlugByIdMock
      .mockResolvedValueOnce("beta")
      .mockResolvedValueOnce("acme");
    verifyMcpOAuthStateMock.mockReturnValue({
      orgId: "org-1",
      userId: "user-1",
      serverId: "server-1",
      nonce: "nonce-1",
      exp: Math.floor(Date.now() / 1000) + 300,
    });
    findMcpServerByIdAndOrgMock.mockResolvedValue({
      id: "server-1",
      catalogSlug: "sentry",
      oauthTokenEndpoint: null,
      oauthClientId: null,
    });

    const response = await GET(
      new Request(
        "https://polaris.example.com/api/mcp-servers/oauth/callback?code=code-123&state=signed-state",
      ),
    );

    expect(hasOrganizationMembershipMock).toHaveBeenCalledWith("user-1", "org-1");
    expect(findMcpServerByIdAndOrgMock).toHaveBeenCalledWith("server-1", "org-1");
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://polaris.example.com/acme/integrations/mcp/sentry?error=server+not+found",
    );
  });
});
